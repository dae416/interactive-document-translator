import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { reqLang, tr } from './i18n.js';

export const USER_AGENT = 'PaperGloss/0.1 (+https://github.com/shenyizg/papergloss)';

// `key` names a message in i18n.js; it's rendered in the caller's language when sent.
export class HttpError extends Error {
  constructor(status, key, params = {}, code) {
    super(key);
    this.status = status;
    this.key = key;
    this.params = params;
    this.code = code;
  }
}

export function randomId(len = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

// A missing file is "no data". An empty one is not: cloud-sync clients leave 0-byte placeholders for
// files that are online-only, and writing over one would destroy the real contents.
export async function readJsonFile(file, fallback = null) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  if (!text.length) throw new HttpError(503, 'storage.unreadable');
  return JSON.parse(text);
}

// Append-only logs (one JSON object per line). An empty existing file is a placeholder: skip it.
export async function appendJsonLine(file, data) {
  try {
    if ((await fs.stat(file)).size === 0) {
      console.warn(`[storage] ${file} is an online-only placeholder; not appending`);
      return;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  await fs.appendFile(file, `${JSON.stringify(data)}\n`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// On Windows, renaming onto a file that a sync client or a virus scanner holds open fails for a
// moment (EPERM, EBUSY, EACCES); try again a few times before giving up.
export async function renameFile(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await sleep(30 * attempt);
    }
  }
}

// Write to a temp file first so a crash never leaves a half-written file behind.
export async function writeTextFile(file, text, { mode } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomId(6)}`;
  await fs.writeFile(tmp, text, mode ? { mode } : undefined);
  try {
    await renameFile(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export function writeJsonFile(file, data, opts) {
  return writeTextFile(file, JSON.stringify(data, null, 2), opts);
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// A body that doesn't arrive within `timeoutMs` is dropped (uploads stream elsewhere, with the
// server's long request timeout).
export function readBody(req, limit, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      reject(new HttpError(408, 'common.timeout'));
      req.destroy();
    }, timeoutMs);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        clearTimeout(timer);
        reject(new HttpError(413, 'common.tooLarge'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function readJson(req, limit = 1024 * 1024) {
  // Other sites can only send a JSON content type after a CORS preflight, which this
  // server never grants, so plain form posts from elsewhere stop here.
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] != null;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
    throw new HttpError(415, 'common.needJson');
  }
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  let body;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'common.badJson');
  }
  // Routes read fields of it: null, a number or a string is no request either.
  if (body === null || typeof body !== 'object') throw new HttpError(400, 'common.badJson');
  return body;
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

export function sendJson(req, res, status, data, headers = {}) {
  let body = Buffer.from(JSON.stringify(data));
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  if (body.length > 2048 && acceptsGzip(req)) {
    body = zlib.gzipSync(body, { level: 6 });
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = body.length;
  res.writeHead(status, h);
  res.end(body);
}

// Streams a file (or a byte range of it) after the headers are written. pipeline() closes
// the file when the client goes away mid-download; pipe() would leave it open for good.
export function sendFile(req, res, file, range) {
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeline(createReadStream(file, range), res, () => {});
}

export function sendError(req, res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  if (res.headersSent) {
    res.end();
    return;
  }
  const lang = reqLang(req);
  // Only messages written for users go out; anything else may carry paths or internals.
  const message = err.key ? tr(lang, err.key, err.params) : tr(lang, 'common.internal');
  sendJson(req, res, status, { error: message, code: err.code });
}

// Every value sent for one cookie name. A parent domain can set a cookie with the same
// name, and a malformed value from another app must not break the request.
export function cookieValues(header, name) {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

const fromCodePoint = (n) => (n <= 0x10ffff ? String.fromCodePoint(n) : '\uFFFD');

export function decodeEntities(str = '') {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Escapes text for HTML, and for the double-quoted attributes of the prompt markup.
export const attr = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export function collapseWs(str = '') {
  return str.replace(/\s+/g, ' ').trim();
}

// Per-key promise chain so read-modify-write sequences on one file never interleave.
const locks = new Map();
export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}
