import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PAPERS_DIR, TMP_DIR, bookLangs, checkLangs } from './config.js';
import { HttpError, collapseWs, exists, randomId, readJsonFile, renameFile, sha1, withLock, writeJsonFile } from './util.js';
import { tr } from './i18n.js';
import { importWebPage, startBook } from './book.js';
import {
  downloadArxivPdf,
  downloadPdfFromUrl,
  fetchArxivHtml,
  fetchArxivMeta,
  fetchAsset,
  fetchOpenReviewMeta,
  parseInput,
} from './sources.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/i;
const THREAD_ID_RE = /^[a-z0-9_-]{6,48}$/i;
// A picture cut from a page (p<page>-<k>), or from a page of the original a translated chapter
// was made from (o<page>-<k>), or that page itself (o<page>, the blocks' data-orig: book.js). The
// reader's FIGURE (htmlview.js) takes the first two, which stand in the text; the page only here.
const FIGURE_RE = /^(p\d{1,4}-\d{1,2}|o\d{1,4}(-\d{1,2})?)\.png$/;
const MAX_UPLOAD = 150 * 1024 * 1024;

export function checkId(id) {
  if (!ID_RE.test(id) || id.includes('..')) throw new HttpError(400, 'paper.badId');
  return id;
}

const dirOf = (id) => path.join(PAPERS_DIR, checkId(id));
const metaFile = (id) => path.join(dirOf(id), 'meta.json');
export const pdfFile = (id) => path.join(dirOf(id), 'paper.pdf');
export const htmlFile = (id) => path.join(dirOf(id), 'paper.html');
// Text of an uploaded .txt book.
export const sourceFile = (id) => path.join(dirOf(id), 'source.txt');
const bookFile = (id) => path.join(dirOf(id), 'book.json');

// A picture of a scanned book (book.js), "p<page>-<k>.png"; any other name is refused.
export function figureFile(id, name) {
  if (!FIGURE_RE.test(name)) throw new HttpError(400, 'common.badUrl');
  return path.join(dirOf(id), 'figures', name);
}

export async function getMeta(id) {
  const meta = await readJsonFile(metaFile(id));
  if (!meta) throw new HttpError(404, 'paper.notFound');
  return meta;
}

export async function saveMeta(meta) {
  await writeJsonFile(metaFile(meta.id), meta);
  return meta;
}

export const metaExists = (id) => exists(metaFile(id));

// book.json holds a book's text, chapter summaries and brief.
export async function readBook(id) {
  const book = await readJsonFile(bookFile(id));
  if (!book) throw new HttpError(404, 'paper.notFound');
  return book;
}

export const writeBook = (id, book) => writeJsonFile(bookFile(id), book);

// Where blocks stand in a book, each a share of its text from 0 (its start) to 1: the ribbons of its
// bookmarks on the home page. The translation of a block stands where the block does; a block the
// book no longer has stands nowhere.
export async function placesOf(id, blocks) {
  const { chapters } = await readBook(id);
  const start = new Map();
  let total = 0;
  for (const c of chapters) {
    c.blocks.forEach((b, i) => {
      start.set(`${c.id}.${i}`, total);
      total += b.x.length;
    });
  }
  const place = (b) => {
    const at = start.get(b.replace(/k$/, ''));
    return at === undefined ? null : at / total;
  };
  return Object.fromEntries(blocks.map((b) => [b, place(b)]));
}

// null when there is no book.json yet; an unreadable one (a placeholder) throws.
export const peekBook = (id) => readJsonFile(bookFile(id));

export const emptyBook = () => ({ version: 1, chapters: [], brief: '', summaries: {}, usage: { input_tokens: 0, output_tokens: 0 }, next: null });

// Every read-modify-write of book.json re-reads it under this lock; model calls stay outside.
export function updateBook(id, fn) {
  return withLock(`book:${id}`, async () => {
    const book = await readBook(id);
    const next = (await fn(book)) || book;
    await writeBook(id, next);
    return next;
  });
}

export function updateMeta(id, fn) {
  return withLock(`meta:${id}`, async () => {
    const meta = await getMeta(id);
    const next = (await fn(meta)) || meta;
    return saveMeta(next);
  });
}

export async function listPapers() {
  let names = [];
  try {
    names = await fsp.readdir(PAPERS_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const metas = [];
  for (const name of names) {
    if (!ID_RE.test(name)) continue;
    try {
      const meta = await readJsonFile(path.join(PAPERS_DIR, name, 'meta.json'));
      if (meta) metas.push(meta);
    } catch (err) {
      // One unreadable entry (e.g. a cloud-sync placeholder) must not hide the whole library.
      console.warn(`[library] skipped ${name}: ${err.key || err.message}`);
    }
  }
  metas.sort((a, b) => (b.lastOpenedAt || b.createdAt).localeCompare(a.lastOpenedAt || a.createdAt));
  return metas.map(summary);
}

function summary(meta) {
  const { abstract, progress, ...rest } = meta;
  return rest;
}

function newTmpPath() {
  return path.join(TMP_DIR, `${Date.now()}-${randomId(8)}.part`);
}

async function finalizePdf(id, tmp) {
  await fsp.mkdir(dirOf(id), { recursive: true });
  await renameFile(tmp, pdfFile(id));
}

function now() {
  return new Date().toISOString();
}

// ---- import --------------------------------------------------------------

const inflight = new Map();

export async function importFromInput(input, lang = 'zh', follow = 0) {
  const parsed = parseInput(input);
  const key = JSON.stringify(parsed);
  if (inflight.has(key)) return inflight.get(key);
  const job = doImport(parsed, lang, follow).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// A book exists once its meta.json and book.json are there (and paper.pdf for PDF books).
// One that is ready or still processing is reused as it is; one that failed is imported again.
async function reusable(id, meta) {
  if (!meta) return false;
  if (meta.kind !== 'book') return exists(pdfFile(id));
  if (meta.book?.status === 'error' || !(await exists(bookFile(id)))) return false;
  return meta.source !== 'upload' || exists(pdfFile(id));
}

const reopen = (id) =>
  updateMeta(id, (m) => {
    m.lastOpenedAt = now();
  });

async function existingOrNull(id) {
  return (await reusable(id, await readJsonFile(metaFile(id)))) ? reopen(id) : null;
}

async function doImport(parsed, lang, follow) {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  if (parsed.kind === 'arxiv') return importArxiv(parsed.id, parsed.version);
  if (parsed.kind === 'openreview') return importOpenReview(parsed.id);
  if (parsed.kind === 'doi') {
    return importUrl(`https://doi.org/${parsed.doi}`, { source: 'doi', sourceId: parsed.doi, idKey: `doi:${parsed.doi.toLowerCase()}`, lang, follow });
  }
  return importUrl(parsed.url, { source: parsed.source || 'url', sourceId: parsed.sourceId || '', lang, follow });
}

async function importArxiv(arxivId, version) {
  const id = `arxiv-${arxivId.replace('/', '_')}${version}`;
  const existing = await existingOrNull(id);
  if (existing) return existing;

  const tmp = newTmpPath();
  const [meta, pdf] = await Promise.all([fetchArxivMeta(arxivId, version), downloadArxivPdf(arxivId, version, tmp)]);
  await finalizePdf(id, tmp);
  const record = {
    id,
    source: 'arxiv',
    sourceId: arxivId,
    version: meta?.version || version || '',
    title: meta?.title || arxivId,
    titleSource: meta?.title ? 'source' : 'id',
    authors: meta?.authors || [],
    abstract: meta?.abstract || '',
    published: meta?.published || '',
    category: meta?.category || '',
    absUrl: `https://arxiv.org/abs/${arxivId}${version}`,
    pdfUrl: pdf.finalUrl,
    fileSize: pdf.size,
    createdAt: now(),
    lastOpenedAt: now(),
    html: { status: 'unknown' },
  };
  await saveMeta(record);
  // Prefetch the HTML rendering in the background; the reader asks for it later.
  ensureHtml(id).catch(() => {});
  return record;
}

async function importOpenReview(orId) {
  const id = `openreview-${orId}`.slice(0, 120);
  const existing = await existingOrNull(id);
  if (existing) return existing;
  const tmp = newTmpPath();
  const pdfUrl = `https://openreview.net/pdf?id=${encodeURIComponent(orId)}`;
  const [meta, pdf] = await Promise.all([fetchOpenReviewMeta(orId), downloadPdfFromUrl(pdfUrl, tmp)]);
  await finalizePdf(id, tmp);
  return saveMeta({
    id,
    source: 'openreview',
    sourceId: orId,
    title: meta?.title || `OpenReview ${orId}`,
    titleSource: meta?.title ? 'source' : 'id',
    authors: meta?.authors || [],
    abstract: meta?.abstract || '',
    published: '',
    absUrl: `https://openreview.net/forum?id=${encodeURIComponent(orId)}`,
    pdfUrl,
    fileSize: pdf.size,
    createdAt: now(),
    lastOpenedAt: now(),
    html: { status: 'none' },
  });
}

async function importUrl(url, { source, sourceId, idKey, lang, follow }) {
  const id = `${source === 'doi' ? 'doi' : 'url'}-${sha1(idKey || url).slice(0, 12)}`;
  const existing = await existingOrNull(id);
  if (existing) return existing;
  // A page without a PDF becomes a web book.
  const webId = `web-${sha1(url).slice(0, 12)}`;
  const web = await existingOrNull(webId);
  if (web) return web;
  const tmp = newTmpPath();
  let pdf;
  try {
    pdf = await downloadPdfFromUrl(url, tmp);
  } catch (err) {
    if (err.page) return importWebPage(webId, err.page, { url, follow, lang });
    throw err;
  }
  await finalizePdf(id, tmp);
  let fallbackTitle = new URL(pdf.finalUrl).pathname.split('/').pop() || '';
  try {
    fallbackTitle = decodeURIComponent(fallbackTitle);
  } catch {
    // keep it encoded
  }
  fallbackTitle = fallbackTitle.replace(/\.pdf$/i, '');
  return saveMeta({
    id,
    source,
    sourceId,
    title: pdf.meta.title || fallbackTitle || tr(lang, 'paper.untitled'),
    titleSource: pdf.meta.title ? 'source' : 'filename',
    authors: pdf.meta.authors || [],
    abstract: pdf.meta.abstract || '',
    published: pdf.meta.published || '',
    absUrl: url,
    pdfUrl: pdf.finalUrl,
    fileSize: pdf.size,
    createdAt: now(),
    lastOpenedAt: now(),
    html: { status: 'none' },
  });
}

export async function importUpload(req, lang = 'zh') {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'dl.tooLarge');
  let fileName = 'paper.pdf';
  try {
    fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'paper.pdf'));
  } catch {
    // keep the default
  }
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const tmp = newTmpPath();
  const hash = crypto.createHash('sha1');
  let size = 0;
  let head = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        out.destroy();
        reject(new HttpError(413, 'dl.tooLarge'));
        return;
      }
      if (head.length < 1024) head = Buffer.concat([head, chunk]).subarray(0, 1024);
      hash.update(chunk);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => out.end(resolve));
    req.on('close', () => {
      if (!req.complete) {
        out.destroy();
        reject(new HttpError(400, 'upload.interrupted'));
      }
    });
    req.on('error', reject);
    out.on('error', reject);
  }).catch(async (err) => {
    await fsp.rm(tmp, { force: true });
    throw err;
  });
  // Every upload becomes a book: a PDF, or a .txt / text/plain file that is valid UTF-8.
  const isPdf = head.includes('%PDF-');
  const textLike = /\.txt$/i.test(fileName) || /^text\/plain\b/i.test(String(req.headers['content-type'] || ''));
  if (!isPdf && !(textLike && (await isUtf8File(tmp)))) {
    await fsp.rm(tmp, { force: true });
    throw new HttpError(422, 'upload.notBook');
  }
  const id = `${isPdf ? 'pdf' : 'txt'}-${hash.digest('hex').slice(0, 12)}`;
  return addBook(tmp, id, { isPdf, fileName, size, lang });
}

// A PDF from a link (one the AI found) as a book.
export async function importBookUrl(url, { title = '', authors = [] } = {}, lang = 'en') {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const tmp = newTmpPath();
  const pdf = await downloadPdfFromUrl(url, tmp);
  const fileName = path.basename(new URL(pdf.finalUrl).pathname) || 'book.pdf';
  return addBook(tmp, `pdf-${pdf.sha1.slice(0, 12)}`, { isPdf: true, fileName, size: pdf.size, lang, title, authors, absUrl: url, pdfUrl: pdf.finalUrl });
}

// The file `tmp`, a PDF or a text, as the book `id`. `title`: one known already, else the file's name
// serves until the PDF's own is read.
async function addBook(tmp, id, { isPdf, fileName, size, lang, title = '', authors = [], absUrl = '', pdfUrl = '' }) {
  // A failed book, or the same PDF uploaded earlier as a paper, goes through the pipeline again;
  // chapters it already has are kept (and an unreadable book.json is an error, not overwritten).
  let prev;
  let current;
  try {
    prev = await readJsonFile(metaFile(id));
    current = await peekBook(id);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  if (prev?.kind === 'book' && (await reusable(id, prev))) {
    await fsp.rm(tmp, { force: true });
    return reopen(id);
  }
  await fsp.mkdir(dirOf(id), { recursive: true });
  await renameFile(tmp, isPdf ? pdfFile(id) : sourceFile(id));
  const named = collapseWs(fileName.replace(/\.(pdf|txt)$/i, '').replace(/[_]+/g, ' ')) || tr(lang, 'paper.untitled');
  if (!current) await writeBook(id, emptyBook());
  const meta = await saveMeta({
    id,
    kind: 'book',
    source: isPdf ? 'upload' : 'txt',
    sourceId: fileName,
    title: title || named,
    titleSource: title ? 'source' : 'filename',
    authors,
    abstract: '',
    published: '',
    absUrl,
    pdfUrl,
    fileSize: size,
    createdAt: prev?.createdAt || now(),
    lastOpenedAt: now(),
    ...(prev?.progress ? { progress: prev.progress } : {}),
    book: {
      status: 'processing',
      step: 'extract',
      progress: 0,
      error: '',
      chapters: current?.chapters?.length || 0,
      ocr: false,
      summaries: Object.keys(current?.summaries || {}).length,
    },
    html: { status: 'none' },
  });
  startBook(id, lang);
  return meta;
}

async function isUtf8File(file) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(await fsp.readFile(file));
    return true;
  } catch {
    return false;
  }
}

// ---- metadata edits --------------------------------------------------------

export async function patchPaper(id, patch = {}) {
  // A book's own languages, { src, tgt } (both codes), checked before anything is written; null: the
  // ones Settings name. Once chapters of it are translated (or on their way) its target stays, so a
  // chapter is never in two languages; its source may still change.
  const langs = patch.langs && typeof patch.langs === 'object' ? checkLangs({ src: patch.langs.src || null, tgt: patch.langs.tgt || null }) : null;
  if (langs && !(langs.src && langs.tgt)) throw new HttpError(400, 'langs.unknown', { code: '' });
  return updateMeta(id, (m) => {
    if ((langs || patch.langs === null) && m.kind === 'book') {
      const now = bookLangs(m).tgt;
      const begun = Object.values(m.book?.translations || {}).some((t) => [t, ...(t?.parts || [])].some((s) => s && (s.status === 'ready' || s.status === 'queued' || s.status === 'working' || s.progress > 0)));
      if (begun && (langs ? langs.tgt : bookLangs({}).tgt) !== now) throw new HttpError(409, 'langs.translated', { lang: now });
      if (langs) m.langs = langs;
      else delete m.langs;
    }
    if (typeof patch.title === 'string' && patch.title.trim()) {
      m.title = collapseWs(patch.title).slice(0, 500);
      m.titleSource = patch.titleSource === 'pdf' ? 'pdf' : 'user';
    }
    if (Array.isArray(patch.authors) && (!m.authors || !m.authors.length)) {
      m.authors = patch.authors.slice(0, 50).map((a) => String(a).slice(0, 200));
    }
    if (typeof patch.abstract === 'string' && !m.abstract) m.abstract = patch.abstract.slice(0, 5000);
    if (patch.progress && typeof patch.progress === 'object') {
      const raw = JSON.stringify(patch.progress);
      if (raw.length < 4000) m.progress = { ...(m.progress || {}), ...patch.progress };
    }
    if (patch.opened) m.lastOpenedAt = now();
    if (typeof patch.pages === 'number') m.pages = patch.pages;
    // Put away from the home page's list, and why; null takes it out again.
    if (patch.shelf === 'read' || patch.shelf === 'unneeded') m.shelf = patch.shelf;
    else if (patch.shelf === null) delete m.shelf;
  });
}

export async function deletePaper(id) {
  const dir = dirOf(id);
  if (!(await exists(dir))) throw new HttpError(404, 'paper.notFound');
  // Retries cover Windows, where a sync client or a virus scanner may hold a file open for a moment.
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---- HTML rendering ----------------------------------------------------------

const htmlJobs = new Map();

export function ensureHtml(id) {
  if (htmlJobs.has(id)) return htmlJobs.get(id);
  const job = (async () => {
    const meta = await getMeta(id);
    if (meta.source !== 'arxiv') return meta.html;
    if (meta.html?.status === 'ok' && (await exists(htmlFile(id)))) return meta.html;
    // Don't hammer arXiv for papers that have no HTML; retry after a day.
    if (meta.html?.status === 'none' && Date.now() - Date.parse(meta.html.checkedAt || 0) < 24 * 3600_000) return meta.html;
    const res = await fetchArxivHtml(meta.sourceId, meta.version && meta.id.endsWith(meta.version) ? meta.version : '');
    let html;
    if (res) {
      await fsp.writeFile(htmlFile(id), res.html);
      html = { status: 'ok', baseUrl: res.baseUrl, source: res.source, checkedAt: now() };
    } else {
      html = { status: 'none', checkedAt: now() };
    }
    await updateMeta(id, (m) => {
      m.html = html;
    });
    return html;
  })().finally(() => htmlJobs.delete(id));
  htmlJobs.set(id, job);
  return job;
}

export async function readHtml(id) {
  const info = await ensureHtml(id);
  if (info?.status !== 'ok') return null;
  const html = await fsp.readFile(htmlFile(id), 'utf8');
  if (!html) throw new HttpError(503, 'storage.unreadable');
  return { html, baseUrl: info.baseUrl, source: info.source };
}

const ASSET_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'ar5iv.labs.arxiv.org', 'ar5iv.org', 'static.arxiv.org']);

export async function getAsset(id, url) {
  const meta = await getMeta(id);
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'asset.badUrl');
  }
  if (u.protocol !== 'https:' || !ASSET_HOSTS.has(u.hostname) || meta.html?.status !== 'ok') {
    throw new HttpError(403, 'asset.forbidden');
  }
  const dir = path.join(dirOf(id), 'assets');
  const key = sha1(u.toString());
  const file = path.join(dir, key);
  const cached = await readJsonFile(`${file}.json`);
  if (cached && (await exists(file))) return { type: cached.type, file };
  const { type, buf } = await fetchAsset(u.toString());
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, buf);
  await writeJsonFile(`${file}.json`, { type, url: u.toString() });
  return { type, file };
}

// ---- AI threads ------------------------------------------------------------------

const threadsDir = (id) => path.join(dirOf(id), 'threads');

function checkThreadId(tid) {
  if (!THREAD_ID_RE.test(tid)) throw new HttpError(400, 'thread.badId');
  return tid;
}

export async function listThreads(id) {
  let names = [];
  try {
    names = await fsp.readdir(threadsDir(id));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const t = await readJsonFile(path.join(threadsDir(id), name));
    if (!t) continue;
    const firstAnswer = t.messages?.find((m) => m.role === 'assistant' && !m.error)?.content || '';
    out.push({
      id: t.id,
      kind: t.kind,
      action: t.action,
      title: t.title || '',
      quote: (t.quote?.text || '').slice(0, 300),
      hasImage: !!t.quote?.image,
      location: t.quote?.location || null,
      preview: String(firstAnswer).slice(0, 200),
      turns: (t.messages || []).filter((m) => m.role === 'user').length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

export async function getThread(id, tid) {
  const t = await readJsonFile(path.join(threadsDir(id), `${checkThreadId(tid)}.json`));
  if (!t) throw new HttpError(404, 'thread.notFound');
  return t;
}

export async function saveThread(id, tid, thread) {
  await getMeta(id);
  if (!thread || typeof thread !== 'object' || !Array.isArray(thread.messages)) throw new HttpError(400, 'thread.bad');
  thread.id = checkThreadId(tid);
  thread.updatedAt = now();
  thread.createdAt ||= thread.updatedAt;
  await writeJsonFile(path.join(threadsDir(id), `${tid}.json`), thread);
  return { id: tid, updatedAt: thread.updatedAt };
}

export async function deleteThread(id, tid) {
  await fsp.rm(path.join(threadsDir(id), `${checkThreadId(tid)}.json`), { force: true });
}
