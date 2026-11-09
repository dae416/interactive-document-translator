import './log.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { APP_NAME, DATA_DIR, PAPERS_DIR, TMP_DIR, effectiveLlm, loadConfig, publicSettings, updateSettings } from './config.js';
import { changePassword, checkSession, forwardedHeader, login, logout, requireAuth } from './auth.js';
import { serveStatic } from './static.js';
import { HttpError, readJson, sendError, sendFile, sendJson, writeJsonFile } from './util.js';
import * as papers from './papers.js';
import { editChapters, fetchNext, resumeBook } from './book.js';
import { bookContext } from './context.js';
import { findBooks } from './find.js';
import { findLookup, forgetLookups, logUsage, lookupKey, storeLookup } from './lookups.js';
import { ensureSummaries } from './summary.js';
import { cancelTranslation, cleaning, getTranslation, prepareBook, requestTranslation, resumeTranslations, stopAll, stopBook } from './translate.js';
import { getAnnotations, putAnnotations } from './annotations.js';
import { startBackups } from './backup.js';
import { getNotesSrc } from './footnotes.js';
import { getClauses } from './clauses.js';
import { describeLlmError, listModels, streamChat } from './llm/index.js';
import { TIERS, routeTurn } from './llm/router.js';
import { proxyDescription } from './net.js';
import { reqLang, tr } from './i18n.js';

const PORT = Number(process.env.PORT || 8787);
// Local only unless HOST says otherwise; a reverse proxy or tunnel reaches it on this machine.
const HOST = process.env.HOST || '127.0.0.1';

const routes = [];
function route(method, pattern, handler, { auth = true } = {}) {
  const keys = [];
  const source = pattern.replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  routes.push({ method, re: new RegExp(`^${source}$`), keys, handler, auth });
}

// ---- session & settings ---------------------------------------------------------------

route('GET', '/api/session', (req, res) => sendJson(req, res, 200, { authed: checkSession(req, res) }), { auth: false });

route(
  'POST',
  '/api/login',
  async (req, res) => {
    const body = await readJson(req);
    await login(req, res, body.password);
    sendJson(req, res, 200, { ok: true });
  },
  { auth: false },
);

route(
  'POST',
  '/api/logout',
  (req, res) => {
    logout(req, res);
    sendJson(req, res, 200, { ok: true });
  },
  { auth: false },
);

route('PUT', '/api/password', async (req, res) => {
  const body = await readJson(req);
  await changePassword(req, res, body.oldPassword, body.newPassword);
  sendJson(req, res, 200, { ok: true });
});

route('GET', '/api/settings', (req, res) => sendJson(req, res, 200, publicSettings()));

route('PUT', '/api/settings', async (req, res) => {
  const body = await readJson(req);
  sendJson(req, res, 200, await updateSettings(body));
});

// ---- LLM ------------------------------------------------------------------------------------

const ACTIONS = new Set(['translate', 'explain', 'ask', 'chat']);

function sanitizeMessages(list) {
  if (!Array.isArray(list) || !list.length || list.length > 200) throw new HttpError(400, 'llm.badMessages');
  return list.map((m) => {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    let content;
    if (typeof m?.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m?.content)) {
      content = m.content
        .map((p) => {
          if (p?.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text };
          if (p?.type === 'image' && typeof p.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(p.mediaType || '')) {
            return { type: 'image', mediaType: p.mediaType, data: p.data };
          }
          return null;
        })
        .filter(Boolean);
    } else {
      throw new HttpError(400, 'llm.badMessages');
    }
    const out = { role, content };
    if (role === 'assistant' && m.raw && typeof m.raw === 'object') out.raw = m.raw;
    return out;
  });
}

route('POST', '/api/llm/chat', async (req, res) => {
  const body = await readJson(req, 24 * 1024 * 1024);
  const action = ACTIONS.has(body.action) ? body.action : 'ask';
  const messages = sanitizeMessages(body.messages);
  if (messages[messages.length - 1].role !== 'user') throw new HttpError(400, 'llm.lastUser');
  const llm = effectiveLlm();
  // A model tier the client asks for ("Again with Opus") skips the router. Claude only.
  const tierModel = llm.protocol === 'anthropic' && Object.hasOwn(TIERS, body.model) ? TIERS[body.model] : undefined;
  // Book threads get their context from the server, in the book's languages. It is checked here,
  // since nothing but a stream can be sent once the headers are out.
  const book = body.book != null ? await bookContext(body.book) : null;
  const system = book ? book.system : typeof body.system === 'string' ? body.system : '';
  const key =
    book && messages.length === 1
      ? lookupKey({ model: llm.model, effort: llm.effort?.[action], targetLang: book.answer, langs: book.langs, action, chapter: book.chapter, content: messages[0].content })
      : null;
  let stored = key && !body.fresh ? await findLookup(book.id, key) : null;
  if (stored && tierModel && stored.model !== tierModel) stored = null;
  const log = { paper: book?.id || null, chapter: book?.chapter || null, action };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const lang = reqLang(req);
  const send = (evt) => {
    if (evt.key) {
      // Adapter notices carry a message key; render it in the caller's language.
      const { key, params, ...rest } = evt;
      evt = { ...rest, text: tr(lang, key, params) };
    }
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  if (stored) {
    // The same first question in the same chapter was answered before.
    send({ t: 'start', model: stored.model });
    send({ t: 'delta', text: stored.text });
    send({ t: 'done', stopReason: 'end_turn', model: stored.model, usage: null, raw: null, cached: true });
    logUsage({ ...log, model: stored.model, cached: true, usage: null, ms: 0 });
    res.end();
    return;
  }
  // Keeps proxies from closing the connection while the model is thinking.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  let text = '';
  let done = null;
  try {
    let model = tierModel || llm.model;
    if (!tierModel && llm.protocol === 'anthropic' && llm.model === 'auto') {
      // A follow-up stays with the model its thread has been using. Book requests are routed;
      // other chats (whole-paper questions) get Opus.
      const previous = messages.findLast((m) => m.role === 'assistant')?.raw?.model;
      if (Object.values(TIERS).includes(previous)) model = previous;
      else if (!book) model = TIERS.opus;
      else {
        const routing = Date.now();
        const routed = await routeTurn(llm, { bookLine: book.line, message: messages.at(-1), signal: ac.signal, lang: book.langs.src });
        if (routed.usage) logUsage({ ...log, model: routed.routerModel, cached: false, usage: routed.usage, router: true, choice: routed.tier, ms: Date.now() - routing });
        model = routed.model;
      }
    }
    // Opus reached through the router or "Again with Opus" serves a chapter once or twice, so the
    // one-hour cache write (2x) rarely pays off there; it gets the 5-minute cache (1.25x). A fixed
    // Opus setting keeps one hour.
    const chatSystem =
      book && model !== llm.model && /^claude-opus-/.test(model)
        ? system.map((b) => (b.cache_control ? { ...b, cache_control: { type: 'ephemeral' } } : b))
        : system;
    const asked = Date.now();
    await streamChat({ llm: { ...llm, model }, system: chatSystem, messages, action, signal: ac.signal, textOnlyReplay: !!book }, (evt) => {
      if (evt.t === 'delta') text += evt.text;
      else if (evt.t === 'done') done = evt;
      send(evt);
    });
    if (done) {
      logUsage({ ...log, model: done.model, cached: false, usage: done.usage, ms: Date.now() - asked });
      if (key && done.stopReason === 'end_turn' && !ac.signal.aborted) await storeLookup(book.id, { key, text, model: done.model });
    }
  } catch (err) {
    const info = describeLlmError(err, llm);
    if (info) {
      if (info.status >= 500 && info.status !== 502 && info.status !== 504) console.error('[llm]', err);
      send({ t: 'error', message: tr(lang, info.key, info.params), code: info.code, status: info.status });
    }
  } finally {
    clearInterval(ping);
    res.end();
  }
});

route('POST', '/api/llm/models', async (req, res) => {
  const body = await readJson(req);
  const llm = effectiveLlm(body.llm);
  try {
    sendJson(req, res, 200, { models: await listModels(llm) });
  } catch (err) {
    const info = describeLlmError(err, llm) || { status: 499, key: 'llm.cancelled', params: {} };
    throw new HttpError(info.status, info.key, info.params, info.code);
  }
});

route('POST', '/api/llm/test', async (req, res) => {
  const body = await readJson(req);
  const llm = effectiveLlm(body.llm);
  llm.effort = { ...llm.effort, test: 'low' };
  // With "auto", the connection test talks to Haiku, the router's model.
  if (llm.protocol === 'anthropic' && llm.model === 'auto') llm.model = TIERS.haiku;
  const started = Date.now();
  let reply = '';
  let model = llm.model;
  let failure = null;
  try {
    await streamChat(
      {
        llm,
        system: '',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        action: 'test',
        signal: AbortSignal.timeout(60000),
      },
      (evt) => {
        if (evt.t === 'delta') reply += evt.text;
        if (evt.t === 'done' || evt.t === 'start') model = evt.model || model;
        if (evt.t === 'refusal') failure = { status: 422, key: 'llm.testRefused', params: {} };
      },
    );
  } catch (err) {
    failure = describeLlmError(err, llm) || { status: 504, key: 'llm.testTimeout', params: {} };
  }
  if (failure) throw new HttpError(failure.status, failure.key, failure.params, failure.code);
  sendJson(req, res, 200, { ok: true, model, ms: Date.now() - started, reply: reply.trim().slice(0, 200) });
});

// ---- papers ----------------------------------------------------------------------------------

route('GET', '/api/papers', async (req, res) => sendJson(req, res, 200, { papers: await papers.listPapers() }));

route('POST', '/api/papers/import', async (req, res) => {
  const body = await readJson(req);
  // Web books: how many "next" pages to fetch after the first.
  const follow = Math.max(0, Math.min(50, Math.floor(Number(body.follow) || 0)));
  sendJson(req, res, 200, { paper: await papers.importFromInput(body.input, reqLang(req), follow) });
});

route('POST', '/api/papers/upload', async (req, res) => {
  sendJson(req, res, 200, { paper: await papers.importUpload(req, reqLang(req)) });
});

// The AI's search takes a minute or two: spaces go out meanwhile (JSON allows them) so no proxy
// closes the connection, and with the status sent, a failure comes as { error }.
// ponytail: a search costs about $0.35 and nothing limits how many run at once; the chat route
// spends more, behind the same password.
route('POST', '/api/books/find', async (req, res) => {
  const body = await readJson(req, 8 * 1024 * 1024);
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 2000) : '';
  const image = /^image\/(png|jpeg|webp|gif)$/.test(body.image?.mediaType || '') && typeof body.image.data === 'string' ? body.image : null;
  if (!query && !image) throw new HttpError(400, 'import.empty');
  const llm = effectiveLlm();
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const ping = setInterval(() => res.write(' '), 15000);
  let out;
  try {
    out = { books: await findBooks({ llm, query, image, signal: ac.signal }) };
  } catch (err) {
    const info = err instanceof HttpError ? err : describeLlmError(err, llm);
    if (!ac.signal.aborted && (!info || info.status >= 500)) console.error('[find]', err);
    out = { error: tr(reqLang(req), info?.key || 'find.failed', info?.params) };
  } finally {
    clearInterval(ping);
  }
  res.end(JSON.stringify(out));
});

route('POST', '/api/books/import', async (req, res) => {
  const body = await readJson(req);
  const url = String(body.url || '');
  if (!/^https?:\/\//i.test(url) || url.length > 2048 || !URL.canParse(url)) throw new HttpError(400, 'import.httpOnly');
  // ponytail: nothing is sent during the download, a few minutes at worst: a proxy that gives up on
  // a silent response sooner shows an error while the book still arrives.
  const authors = Array.isArray(body.authors) ? body.authors.slice(0, 10).map((a) => String(a).slice(0, 200)) : [];
  sendJson(req, res, 200, { paper: await papers.importBookUrl(url, { title: String(body.title || '').slice(0, 500), authors }, reqLang(req)) });
});

route('GET', '/api/papers/:id', async (req, res, { params }) => {
  sendJson(req, res, 200, { paper: await papers.getMeta(papers.checkId(params.id)) });
});

route('PATCH', '/api/papers/:id', async (req, res, { params }) => {
  const body = await readJson(req);
  const meta = await papers.patchPaper(papers.checkId(params.id), body);
  sendJson(req, res, 200, { paper: meta });
});

route('DELETE', '/api/papers/:id', async (req, res, { params }) => {
  stopBook(papers.checkId(params.id)); // its translations, queued or running
  await papers.deletePaper(params.id);
  forgetLookups(params.id);
  sendJson(req, res, 200, { ok: true });
});

route('POST', '/api/papers/:id/chapters', async (req, res, { params }) => {
  const body = await readJson(req, 8 * 1024 * 1024);
  sendJson(req, res, 200, { paper: await editChapters(papers.checkId(params.id), body) });
});

route('POST', '/api/papers/:id/chapters/next', async (req, res, { params }) => {
  const body = await readJson(req);
  const count = Number(body.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new HttpError(400, 'book.badCount');
  sendJson(req, res, 200, { paper: await fetchNext(papers.checkId(params.id), count) });
});

route('POST', '/api/papers/:id/places', async (req, res, { params }) => {
  const body = await readJson(req);
  const blocks = Array.isArray(body.blocks) ? body.blocks.filter((b) => typeof b === 'string').slice(0, 1000) : [];
  sendJson(req, res, 200, { places: await papers.placesOf(papers.checkId(params.id), blocks) });
});

route('GET', '/api/papers/:id/annotations', async (req, res, { params }) => {
  sendJson(req, res, 200, { items: await getAnnotations(papers.checkId(params.id)) });
});

route('PUT', '/api/papers/:id/annotations', async (req, res, { params }) => {
  const body = await readJson(req, 8 * 1024 * 1024);
  sendJson(req, res, 200, { items: await putAnnotations(papers.checkId(params.id), body.items) });
});

route('GET', '/api/papers/:id/translations/:chapter', async (req, res, { params }) => {
  sendJson(req, res, 200, { translation: await getTranslation(papers.checkId(params.id), params.chapter) });
});

// `part`: which part of a chapter in parts (from 1).
const partOf = (body) => (Number.isInteger(body.part) && body.part > 0 ? body.part : 0);

route('POST', '/api/papers/:id/translations/:chapter', async (req, res, { params }) => {
  const body = await readJson(req);
  const paper = await requestTranslation(papers.checkId(params.id), params.chapter, { again: body.again === true, part: partOf(body), lang: reqLang(req) });
  sendJson(req, res, 200, { paper });
});

route('POST', '/api/papers/:id/translations/:chapter/cancel', async (req, res, { params }) => {
  const body = await readJson(req);
  sendJson(req, res, 200, { paper: await cancelTranslation(papers.checkId(params.id), params.chapter, partOf(body)) });
});

// Where the translation's footnotes go in the original (footnotes.js). A GET that may call the model
// and write a file, so another site can't make it (as the other routes that change things).
route('GET', '/api/papers/:id/translations/:chapter/notes-src', async (req, res, { params }) => {
  if (crossSite(req)) throw new HttpError(403, 'common.crossSite');
  sendJson(req, res, 200, await getNotesSrc(papers.checkId(params.id), params.chapter));
});

// Which words of the translation go with each clause of the original (clauses.js), for taps;
// like the notes, a GET that may call the model and write a file.
route('GET', '/api/papers/:id/translations/:chapter/clauses', async (req, res, { params }) => {
  if (crossSite(req)) throw new HttpError(403, 'common.crossSite');
  sendJson(req, res, 200, await getClauses(papers.checkId(params.id), params.chapter));
});

route('GET', '/api/papers/:id/pdf', async (req, res, { params, query }) => {
  const id = papers.checkId(params.id);
  const file = papers.pdfFile(id);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'paper.noPdf');
  }
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  if (query.get('download')) {
    const meta = await papers.getMeta(id);
    const name = `${(meta.title || id).replace(/[\\/:*?"<>|\n\r]+/g, ' ').slice(0, 120)}.pdf`;
    headers['Content-Disposition'] = `attachment; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start;
    let end;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    } else {
      start = Math.max(0, stat.size - Number(m[2]));
      end = stat.size - 1;
    }
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    sendFile(req, res, file, { start, end });
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  sendFile(req, res, file);
});

route('GET', '/api/papers/:id/html', async (req, res, { params }) => {
  const id = papers.checkId(params.id);
  const result = await papers.readHtml(id);
  if (!result) throw new HttpError(404, 'paper.noHtml', {}, 'no_html');
  // Opening a book retries summaries that were skipped for want of an API key (unless its
  // clean-up runs: summaries of the text before it would stay, and it starts them when it ends).
  if (!cleaning(id)) ensureSummaries(id);
  sendJson(req, res, 200, result);
});

route('GET', '/api/papers/:id/asset', async (req, res, { params, query }) => {
  const { type, file } = await papers.getAsset(papers.checkId(params.id), query.get('u') || '');
  const stat = await fsp.stat(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=604800',
    'X-Content-Type-Options': 'nosniff',
    // Proxied files (SVG in particular) must never run script in this origin.
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  });
  sendFile(req, res, file);
});

// A picture of a scanned book, cut from its page when it was read (book.js).
route('GET', '/api/papers/:id/figures/:name', async (req, res, { params }) => {
  const file = papers.figureFile(papers.checkId(params.id), params.name);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'common.notFound');
  }
  // An empty one is a cloud-sync placeholder, not a picture to keep for a week.
  if (!stat.isFile() || stat.size === 0) throw new HttpError(503, 'storage.unreadable');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
  sendFile(req, res, file);
});

route('GET', '/api/papers/:id/threads', async (req, res, { params }) => {
  sendJson(req, res, 200, { threads: await papers.listThreads(papers.checkId(params.id)) });
});

route('GET', '/api/papers/:id/threads/:tid', async (req, res, { params }) => {
  sendJson(req, res, 200, { thread: await papers.getThread(papers.checkId(params.id), params.tid) });
});

route('PUT', '/api/papers/:id/threads/:tid', async (req, res, { params }) => {
  const body = await readJson(req, 24 * 1024 * 1024);
  sendJson(req, res, 200, await papers.saveThread(papers.checkId(params.id), params.tid, body));
});

route('DELETE', '/api/papers/:id/threads/:tid', async (req, res, { params }) => {
  await papers.deleteThread(papers.checkId(params.id), params.tid);
  sendJson(req, res, 200, { ok: true });
});

// ---- server -----------------------------------------------------------------------------------

// Pages on other sites, including other subdomains of the same site, may not change anything
// here. Browsers label such requests with Sec-Fetch-Site; older ones still send Origin.
function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const { host } = new URL(origin);
    return host !== req.headers.host && host !== forwardedHeader(req, 'x-forwarded-host');
  } catch {
    return true;
  }
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    throw new HttpError(400, 'common.badUrl');
  }
  const pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && crossSite(req)) throw new HttpError(403, 'common.crossSite');
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.auth) requireAuth(req);
      let params;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch {
        throw new HttpError(400, 'common.badUrl');
      }
      await r.handler(req, res, { params, query: url.searchParams });
      return;
    }
    throw new HttpError(404, 'common.notFound');
  }
  if (await serveStatic(req, res, pathname)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

async function cleanTmp() {
  try {
    const now = Date.now();
    for (const name of await fsp.readdir(TMP_DIR)) {
      const file = path.join(TMP_DIR, name);
      const stat = await fsp.stat(file);
      if (now - stat.mtimeMs > 6 * 3600_000) await fsp.rm(file, { force: true });
    }
  } catch {
    // nothing to clean
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// Only one server may write a data folder: each running server refreshes a heartbeat. A start is
// refused while another machine's is under 3 minutes old, or one of this machine's whose process
// still runs (another app given this folder, a second copy of this one). One left by an earlier
// server of this same restart loop (PAPERGLOSS_LOOP, scripts/start.ps1) is taken over: that server
// has stopped, whatever process has its pid by now.
// ponytail: outside that loop (a start by hand, launchd), a stopped server's pid that another
// process has taken since keeps a start out until the heartbeat is 3 minutes old.
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
const LOOP = process.env.PAPERGLOSS_LOOP || undefined;

// Whether a process of this machine runs (EPERM: it does, but may not be signalled).
function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function claimDataDir() {
  let lock = null;
  try {
    lock = JSON.parse(await fsp.readFile(LOCK_FILE, 'utf8'));
  } catch {
    // no heartbeat, or an unreadable one
  }
  const age = Date.now() - Date.parse(lock?.at || 0);
  const other = lock?.host !== os.hostname() || (lock.pid !== process.pid && !(LOOP && lock.loop === LOOP) && running(lock.pid));
  if (lock && other && age < 3 * 60_000 && process.env.FORCE_START !== '1') {
    console.error(
      `Another server (${lock.host}, pid ${lock.pid}) is using ${DATA_DIR}: its heartbeat is ${Math.round(age / 1000)} s old. ` +
        'Stop it first, or set FORCE_START=1 if it is no longer running.',
    );
    process.exit(1);
  }
  const beat = () =>
    writeJsonFile(LOCK_FILE, { host: os.hostname(), pid: process.pid, loop: LOOP, at: new Date().toISOString() }).catch((err) => {
      console.error('[lock]', err.message);
    });
  await beat();
  // A machine that took the folder over since (FORCE_START, or two restart loops) keeps it.
  setInterval(async () => {
    try {
      const holder = JSON.parse(await fsp.readFile(LOCK_FILE, 'utf8'));
      if (holder.host !== os.hostname() && Date.now() - Date.parse(holder.at) < 3 * 60_000) {
        console.error(`[lock] ${holder.host} is using ${DATA_DIR}; stopping`);
        process.exit(1);
      }
    } catch {
      // no heartbeat, or an unreadable one
    }
    beat();
  }, 60_000).unref();
}

// Translations cut short resume first, so automatic ones can't take their places. Then books that
// were being built when the server stopped start again (once), and finished ones get any clean-up,
// pictures, summaries and automatic translations they are missing.
async function resumeBooks() {
  const books = (await papers.listPapers()).filter((p) => p.kind === 'book');
  for (const p of books) await resumeTranslations(p.id).catch((err) => console.error('[translate] resume:', err));
  for (const p of books) {
    if (p.book?.status === 'processing') await resumeBook(p.id).catch((err) => console.error('[book] resume:', err));
    else if (p.book?.status === 'ready') prepareBook(p.id, p, true);
  }
}

// The password guards a server that may face the internet.
if (process.env.PAPERGLOSS_PASSWORD && process.env.PAPERGLOSS_PASSWORD.length < 12) {
  console.error('PAPERGLOSS_PASSWORD is shorter than 12 characters. Set a longer one and start again.');
  process.exit(1);
}
await claimDataDir();
let loaded;
try {
  loaded = await loadConfig();
} catch (err) {
  if (err.key !== 'storage.unreadable') throw err;
  console.error(`${tr('en', 'storage.unreadable')} (${path.join(DATA_DIR, 'config.json')})`);
  process.exit(1);
}
const { generatedPassword } = loaded;
await fsp.mkdir(PAPERS_DIR, { recursive: true });
await fsp.mkdir(TMP_DIR, { recursive: true });
await cleanTmp();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => sendError(req, res, err));
});
// Large uploads over mobile networks can take a while.
server.requestTimeout = 30 * 60 * 1000;
server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`${APP_NAME} is running (data: ${DATA_DIR}; outbound: ${proxyDescription()})`);
  console.log(`  Local: http://127.0.0.1:${port}`);
  if (HOST === '0.0.0.0') for (const ip of lanAddresses()) console.log(`  LAN:   http://${ip}:${port}`);
  if (generatedPassword) {
    // To the console only, not the log file: only a hash of it is kept.
    process.stdout.write(`  Generated access password: ${generatedPassword} (shown only this once; change it in Settings)\n`);
  }
  resumeBooks().catch((err) => console.error('[book] resume:', err));
  startBackups(DATA_DIR);
});

// Translations stopped by a stop like this don't use up their tries (stopAll).
async function shutdown() {
  server.close();
  await stopAll();
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (lock.host === os.hostname() && lock.pid === process.pid) fs.rmSync(LOCK_FILE);
  } catch {
    // gone already, or not ours to remove
  }
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);

// Stopping the Windows task ends the process it launched, not the server: scripts\start.ps1, or the
// windowless conhost that start.ps1 runs in (PAPERGLOSS_WATCH_PID, set by start.ps1). Go with them.
// (EPERM means it runs but may not be signalled.)
if (process.platform === 'win32') {
  const watched = [process.ppid, Number(process.env.PAPERGLOSS_WATCH_PID)].filter(Boolean);
  setInterval(() => {
    for (const pid of watched) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err.code !== 'ESRCH') continue;
        console.log('[server] parent gone; stopping');
        shutdown();
        return;
      }
    }
  }, 5000).unref();
}
