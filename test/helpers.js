// Test helpers: real server processes against throwaway data folders.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'papergloss-test-'));
}

export async function waitFor(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await sleep(50);
  }
}

// Starts server/index.js on a free port. Settings from the caller's environment that
// would change its behaviour (PAPERGLOSS_*, an Anthropic key that would make real model
// calls, SUMMARY_MODEL, FORCE_START, TRANSLATE_AUTO, TRANSLATE_PARALLEL) are left out. Its log
// file and backups go to a folder of its own (`logFile`, `backupDir`), never the real ones, and a
// failed model call is made again after 20 ms. The servers of one data folder run as one restart
// loop does (PAPERGLOSS_LOOP, scripts/start.ps1): each takes over the heartbeat the one before left
// there, which stop() leaves on Windows.
export async function startServer({ env = {}, dataDir } = {}) {
  const ownDir = !dataDir;
  dataDir ||= tempDir();
  const side = fs.mkdtempSync(path.join(os.tmpdir(), 'papergloss-side-'));
  // Windows names variables case-insensitively ("Path"), so `env` replaces them whatever their case.
  const replaced = new Set(Object.keys(env).map((k) => k.toLowerCase()));
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(PAPERGLOSS_|ANTHROPIC_|APP_)/.test(k) && !['SUMMARY_MODEL', 'FORCE_START', 'TRANSLATE_AUTO', 'TRANSLATE_PARALLEL'].includes(k) && !replaced.has(k.toLowerCase()),
    ),
  );
  const own = { LOG_FILE: path.join(side, 'server.log'), BACKUP_DIR: path.join(side, 'backups'), TRANSLATE_RETRY_DELAYS: '20,20,20,20' };
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...base, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, PAPERGLOSS_NO_PROXY: '1', PAPERGLOSS_LOOP: dataDir, ...own, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const port = await new Promise((resolve, reject) => {
    const check = () => {
      const m = output.match(/Local: http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => reject(new Error(`server exited with ${code}:\n${output}`)));
  }).catch((err) => {
    // It refused to start: nothing will call stop().
    if (ownDir) fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(side, { recursive: true, force: true });
    throw err;
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    pid: child.pid,
    // (another app's has its id in its name, log.js)
    logFile: (env.LOG_FILE || own.LOG_FILE).replace(/\.log$/, env.APP_ID ? `-${env.APP_ID}.log` : '.log'),
    backupDir: env.BACKUP_DIR || own.BACKUP_DIR,
    output: () => output,
    stop: async () => {
      // Windows has no SIGTERM: kill() ends the server at once, so only signalCode is set.
      if (child.exitCode == null && child.signalCode == null) {
        await new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill();
        });
      }
      if (ownDir) fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(side, { recursive: true, force: true });
    },
  };
}

export async function api(base, method, pathname, { body, headers = {}, cookie } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

// Signs in and returns the session cookie ("pr_session=…").
export async function signIn(base, password) {
  const res = await api(base, 'POST', '/api/login', { body: { password } });
  assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.data)}`);
  return res.headers.get('set-cookie').split(';')[0];
}

// A local HTTP server that records every request it gets.
export async function recordingServer(handler = (req, res) => res.writeHead(404).end('internal page')) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    req.on('end', () => handler(req, res));
  });
  // Proxies are asked with CONNECT.
  server.on('connect', (req, socket) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const TIER_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

// A stand-in for the Anthropic Messages API (and its model list): streams for `stream: true`,
// JSON otherwise.
// `reply(body)` may return { text, stopReason, usage, delayMs, hang, cut, status } for each request;
// `cut` drops the connection in the middle of the stream.
// open(): requests whose response has not ended (a client that aborts one ends it).
export async function anthropicStub(reply = () => ({})) {
  const requests = [];
  const headers = [];
  const live = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    live.add(res);
    res.on('close', () => live.delete(res));
    headers.push(req.headers);
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        const data = Object.values(TIER_MODELS).map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' }));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id }));
        return;
      }
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      const r = { text: 'stub answer', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, ...(await reply(body)) };
      if (r.delayMs) await sleep(r.delayMs);
      if (r.status) {
        res.writeHead(r.status, { 'Content-Type': 'application/json' }).end('{"type":"error","error":{"type":"api_error","message":"stub failure"}}');
        return;
      }
      const message = {
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: r.content || [{ type: 'text', text: r.text }],
        stop_reason: r.stopReason,
        stop_sequence: null,
        usage: r.usage,
        ...(r.container ? { container: r.container } : {}),
      };
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...r.usage, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: r.text } });
      if (r.cut) setTimeout(() => res.socket?.destroy(), 20);
      if (r.hang || r.cut) return;
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: r.stopReason, stop_sequence: null }, usage: { output_tokens: r.usage.output_tokens } });
      event('message_stop', {});
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    headers,
    open: () => live.size,
    chats: () => requests.filter((r) => r.stream),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Points the server at an Anthropic stub.
export function useStub(base, cookie, stub, extra = {}) {
  const llm = { preset: 'anthropic', protocol: 'anthropic', baseUrl: stub.url, apiKey: 'sk-test', model: 'claude-opus-5-5', ...extra };
  return api(base, 'PUT', '/api/settings', { cookie, body: { llm } });
}

// Writes a ready book straight into a data folder (meta.json, book.json, paper.html).
export function writeBookFixture(dataDir, id, { chapters, summaries = {}, brief = '', meta = {}, ocr = false }) {
  const dir = path.join(dataDir, 'papers', id);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      id,
      kind: 'book',
      source: 'txt',
      sourceId: `${id}.txt`,
      title: 'Test Book',
      titleSource: 'filename',
      authors: ['A. Writer'],
      createdAt: at,
      lastOpenedAt: at,
      book: { status: 'ready', step: 'done', progress: 1, error: '', chapters: chapters.length, ocr, summaries: Object.keys(summaries).length },
      html: { status: 'ok', baseUrl: 'https://book.invalid/' },
      ...meta,
    }),
  );
  const book = { version: 1, chapters, brief, summaries, usage: { input_tokens: 0, output_tokens: 0 }, next: null };
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(book));
  fs.writeFileSync(path.join(dir, 'paper.html'), '<article class="ltx_document book"></article>');
  return book;
}

// Polls a paper until `test(meta)` holds; returns the last meta.
export async function waitForPaper(base, cookie, id, test, timeoutMs = 20000) {
  let meta = null;
  await waitFor(async () => {
    meta = (await api(base, 'GET', `/api/papers/${id}`, { cookie })).data.paper;
    return meta && test(meta);
  }, timeoutMs);
  return meta;
}

// Reads a /api/llm/chat event stream into a list of events.
export async function chat(base, cookie, body, { signal } = {}) {
  const res = await fetch(`${base}/api/llm/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.headers.get('content-type')?.includes('event-stream')) return { status: res.status, data: await res.json(), events: [] };
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
  return { status: res.status, events };
}

export function readConfig(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
}

// An IPv4 address of this machine other than loopback, to connect from a "remote" peer.
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
