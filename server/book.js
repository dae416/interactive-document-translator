// Books: an uploaded PDF or text file, or a run of web pages, becomes chapters of plain text
// (book.json) and a paper.html in LaTeXML markup, which the HTML reader already understands.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { countWords } from '../public/assets/js/langs.js';
import { marksOf } from '../public/assets/js/sentences.js';
import { bookLangs } from './config.js';
import { placeFigure, readHocr } from './figures.js';
import { tr } from './i18n.js';
import { ocrLang } from './langs.js';
import { fetchPage } from './sources.js';
import { cleanBook, prepareBook } from './translate.js';
import { HttpError, attr, collapseWs, sleep, withLock, writeTextFile } from './util.js';
import {
  emptyBook,
  figureFile,
  getMeta,
  htmlFile,
  metaExists,
  pdfFile,
  peekBook,
  readBook,
  saveMeta,
  sourceFile,
  updateBook,
  updateMeta,
  writeBook,
} from './papers.js';

// Base URL for books that have no source page (htmlview.js needs a valid one).
const NO_BASE_URL = 'https://book.invalid/';

const now = () => new Date().toISOString();
// (a character of Chinese or Japanese is a word: countWords)
const wordCount = countWords;
const MAX_PAGES = 3000;
// Pages whose 300 dpi image would be longer than this are rendered at this size instead.
const MAX_IMAGE_SIDE = 4000;
// (PAPERGLOSS_PARSE_TIMEOUT_MS is for tests.)
const PARSE_TIMEOUT = Number(process.env.PAPERGLOSS_PARSE_TIMEOUT_MS) || 20_000;

// Runs a parse.js function in a worker thread, stopped after 20 s, so a hostile or huge page or
// book can't freeze the server.
function inWorker(fn, ...args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parse-worker.js', import.meta.url), {
      workerData: { fn, args },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new HttpError(422, 'book.parseTimeout'));
    }, PARSE_TIMEOUT);
    worker.once('message', (value) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new HttpError(500, 'book.failed'));
    });
  });
}

// ---- paper.html ---------------------------------------------------------------------------------

// A picture of a scanned page (book.figures). Without an id or a block id, reading positions and
// annotations pass it by; the reader gives it its src. One printed in a column of a journal's two
// (f.narrow) stays in its column there (book.layout 'paper').
const figureHtml = (f) => `<figure class="book-fig${f.narrow ? ' narrow' : ''}"><img data-fig="${attr(f.id)}.png" width="${attr(f.w)}" height="${attr(f.h)}" alt=""></figure>`;

// A book written in Markdown with LaTeX (book.math): each formula ($…$, $$…$$) goes in a <k-tex>,
// which public/assets/js/tex.js draws; **…** is bold and *…* italic (marksOf, shared with the
// reader). The marks stay in the text, hidden, so the block's textContent is its stored text.
const mark = (s) => `<span class="mk">${attr(s)}</span>`;

function richHtml(text) {
  const x = String(text ?? '');
  let out = '';
  let at = 0;
  let bold = false;
  for (const { index, text: m } of marksOf(x)) {
    out += attr(x.slice(at, index));
    at = index + m.length;
    if (m === '**') {
      out += bold ? `${mark('**')}</b>` : `<b>${mark('**')}`;
      bold = !bold;
    } else if (m[0] === '*') out += `<i>${mark('*')}${attr(m.slice(1, -1))}${mark('*')}</i>`;
    else out += `<k-tex${m.startsWith('$$') ? ' class="d"' : ''}>${attr(m)}</k-tex>`;
  }
  return `${out}${attr(x.slice(at))}${bold ? '</b>' : ''}`;
}

// A table of such a book (t 'tb'): its rows in `cells`, the header first. Its text is the rows
// joined by "\n" and their cells by " | ". Those separators are hidden marks in the cells.
const cellText = (cells) => cells.map((r) => r.join(' | ')).join('\n');
const tableHtml = (cells) =>
  `<table>${cells
    .map((r, i) => `<tr>${r.map((cell, j) => `<${i ? 'td' : 'th'}>${j ? mark(' | ') : i ? mark('\n') : ''}${richHtml(cell)}</${i ? 'td' : 'th'}>`).join('')}</tr>`)
    .join('')}</table>`;
// The kinds of box a block of such a book can sit in (a Markdown quote or callout).
const BOXES = new Set(['quote', 'note', 'tip', 'warning']);
// What a block of a journal article is on its page (b.r), for the look of a book laid out as one
// (book.layout 'paper': one chapter, the journal's line its title): the line over the title, the
// title, authors, abstract, a section's head, a caption, a reference and the notes at the end;
// in a textbook also a footnote, after the paragraph that calls it.
const ROLES = new Set(['kicker', 'title', 'authors', 'abstract', 'sec', 'cap', 'ref', 'end', 'fn']);

// Where a block of a book translated from a scan stands in the original (b.o: [{ page, box }],
// the box [x0, y0, x1, y1] in shares of the page), for the reader to show that part of the page,
// figures/o<page>.png: "21:0.08,0.1,0.92,0.3 22:…". Anything else gives nothing.
function origAttr(o) {
  if (!Array.isArray(o) || !o.length) return '';
  const round = (v) => Math.round(v * 10000) / 10000;
  // (each box as written out: rounded, and still some width and height)
  const parts = o.map((p) => (Number.isInteger(p?.page) && p.page > 0 && Array.isArray(p.box) && p.box.length === 4 && p.box.every((v) => typeof v === 'number' && v >= 0 && v <= 1) ? { page: p.page, box: p.box.map(round) } : null));
  const ok = parts.every((p) => p && p.box[0] < p.box[2] && p.box[1] < p.box[3]);
  return ok ? ` data-orig="${parts.map((p) => `${p.page}:${p.box.join(',')}`).join(' ')}"` : '';
}

// Block ids are "<chapter>.<index>"; a block's textContent is exactly its stored text, so
// annotation offsets match what the browser sees.
export function renderHtml(book) {
  const out = [`<article class="ltx_document book${book.layout === 'paper' ? ' paper' : ''}">`];
  const text = book.math ? richHtml : attr;
  for (const c of book.chapters) {
    const figures = (book.figures || []).filter((f) => f.chapter === c.id);
    out.push(`<section class="ltx_section" id="${c.id}" data-chapter="${c.id}">`, `<h2 class="ltx_title ltx_title_section">${attr(c.title)}</h2>`);
    c.blocks.forEach((b, i) => {
      const id = `${c.id}.${i}`;
      const role = ROLES.has(b.r) ? ` r-${b.r}` : '';
      const box = (book.math && BOXES.has(b.q) ? ` q-${b.q}` : '') + role;
      const orig = origAttr(b.o);
      // (every row a list of strings, none empty but the header: an empty row would draw no "\n")
      const table =
        book.math &&
        b.t === 'tb' &&
        Array.isArray(b.cells) &&
        b.cells.every((r, k) => Array.isArray(r) && (r.length || !k) && r.every((cell) => typeof cell === 'string')) &&
        cellText(b.cells) === b.x;
      out.push(
        ...figures.filter((f) => f.before === i).map(figureHtml),
        b.t === 'h'
          ? `<h3 class="ltx_title ltx_title_paragraph${role}" id="${id}" data-b="${id}"${orig}>${text(b.x)}</h3>`
          : table
            ? `<div class="ltx_para tbl${box}" id="${id}" data-b="${id}"${orig}>${tableHtml(b.cells)}</div>`
            : `<div class="ltx_para${box}" id="${id}" data-b="${id}"${orig}><p class="ltx_p">${text(b.x)}</p></div>`,
      );
    });
    out.push(...figures.filter((f) => f.before >= c.blocks.length).map(figureHtml), '</section>');
  }
  out.push('</article>');
  return `${out.join('\n')}\n`;
}

export const writeHtml = (id, book) => writeTextFile(htmlFile(id), renderHtml(book));

// ---- jobs -----------------------------------------------------------------------------------------

const jobs = new Map();

// One job per book at a time; a later one waits for the running one.
function runJob(id, fn) {
  const job = (jobs.get(id) || Promise.resolve()).then(fn);
  const tail = job
    .catch(() => {})
    .finally(() => {
      if (jobs.get(id) === tail) jobs.delete(id);
    });
  jobs.set(id, tail);
  return job;
}

const setBook = (id, patch) =>
  updateMeta(id, (m) => {
    m.book = { ...m.book, ...patch };
  });

function errorText(err, lang) {
  return err.key ? tr(lang, err.key, err.params) : tr(lang, 'book.failed');
}

// Builds (or resumes) a book whose meta.json says it is processing. Never rejects: a failure is
// recorded in meta.book.
export function startBook(id, lang = 'en') {
  if (jobs.has(id)) return jobs.get(id);
  return runJob(id, async () => {
    try {
      const meta = await getMeta(id);
      if (meta.source === 'web') {
        // Chapter 1 is already readable, so a failed page leaves the book ready with what it has.
        let error = '';
        try {
          await followPages(id, meta.book?.follow || 0);
        } catch (err) {
          console.error(`[book] ${id}:`, err.key || err);
          error = errorText(err, lang);
        }
        prepareBook(id, await setBook(id, { status: 'ready', step: 'done', progress: 1, follow: 0, error }));
        return;
      }
      // Chapters that exist are kept: annotations point into them, and summaries describe them.
      let book = await readBook(id);
      let scan = null; // what the OCR saw on each page, for the pictures
      if (!book.chapters.length) {
        const file = meta.source === 'txt' ? sourceFile(id) : pdfFile(id);
        if ((await fsp.stat(file)).size === 0) throw new HttpError(503, 'storage.unreadable');
        let chapters;
        if (meta.source === 'txt') chapters = await inWorker('chaptersFromText', await fsp.readFile(file, 'utf8'));
        else ({ chapters, scan } = await pdfChapters(id));
        if (!chapters.length) throw new HttpError(422, 'book.noText');
        if (!(await metaExists(id))) return; // deleted meanwhile
        book = await updateBook(id, (b) => {
          if (!b.chapters.length) b.chapters = chapters.map((c, i) => ({ id: `c${i + 1}`, ...c }));
        });
      }
      // A scanned book is cleaned up before it is ready, so no highlight is made on text that
      // changes after. A failure doesn't fail the import: the next start cleans what is left.
      if ((await getMeta(id)).book?.ocr) {
        await cleanBook(id, (progress) => setBook(id, { step: 'clean', progress })).catch((err) => console.error(`[clean] ${id}:`, err.key || err.message));
        book = await readBook(id);
        // Its pictures, from this OCR (a resumed import gets them once it is ready: addFigures).
        const figures = scan && (await cutFigures(id, scan, book.chapters).catch((err) => console.error(`[figures] ${id}:`, err.key || err.message)));
        if (figures) {
          book = await updateBook(id, (b) => {
            b.figures = figures;
          });
        }
      }
      await writeHtml(id, book);
      const ready = await updateMeta(id, (m) => {
        m.html = { status: 'ok', baseUrl: NO_BASE_URL };
        m.book = { ...m.book, status: 'ready', step: 'done', progress: 1, error: '', chapters: book.chapters.length };
      });
      prepareBook(id, ready);
      // A resumed import read no pages: its pictures need a pass of their own. One whose pictures
      // failed after its OCR waits for the next start, not a second pass now.
      if (ready.book?.ocr && !scan) addFigures(id);
    } catch (err) {
      console.error(`[book] ${id}:`, err.key ? `${err.key} ${JSON.stringify(err.params)}` : err);
      await setBook(id, { status: 'error', error: errorText(err, lang) }).catch(() => {});
    }
  });
}

// At startup: a book that was processing when the server stopped is built once more. If that
// is cut short too (a book that brings the server down, say), it is marked as failed.
export async function resumeBook(id) {
  const meta = await updateMeta(id, (m) => {
    if (m.book?.resumed) m.book = { ...m.book, status: 'error', error: tr('en', 'book.interrupted') };
    else m.book = { ...m.book, resumed: 1 };
  });
  if (meta.book.status === 'processing') startBook(id);
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      // Windows builds of poppler and tesseract end lines with \r\n.
      if (!err) return resolve(stdout.replace(/\r\n?/g, '\n'));
      if (err.code === 'ENOENT') return reject(new HttpError(500, 'book.toolMissing', { tool: cmd }));
      const detail = err.killed ? 'timed out' : String(stderr || err.message).trim().split('\n')[0];
      reject(new HttpError(500, 'book.toolFailed', { tool: cmd, detail: detail.slice(0, 200) }));
    });
  });
}

// pdfinfo's page count of a PDF, and the long side of each page in points.
async function pdfInfo(file) {
  const info = await run('pdfinfo', ['-enc', 'UTF-8', '-f', '1', '-l', String(MAX_PAGES), file], 60_000);
  const sizes = new Map([...info.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm)].map((m) => [Number(m[1]), Math.max(Number(m[2]), Number(m[3]))]));
  return { info, count: Number(/^Pages:\s*(\d+)/m.exec(info)?.[1]), sizes };
}

// Chapters, and for a scanned book what the OCR saw on each page (see ocrPages).
async function pdfChapters(id) {
  const file = pdfFile(id);
  const { info, count, sizes } = await pdfInfo(file);
  if (!(count <= MAX_PAGES)) throw new HttpError(422, 'book.tooManyPages', { max: MAX_PAGES });
  // The PDF's own title and author beat a file name like "johnploughmanst00spurgoog".
  const title = /^Title:\s*(.+)$/m.exec(info)?.[1].trim();
  const author = /^Author:\s*(.+)$/m.exec(info)?.[1].trim();
  await updateMeta(id, (m) => {
    if (title && m.titleSource === 'filename') Object.assign(m, { title: title.slice(0, 500), titleSource: 'pdf' });
    if (author && !m.authors?.length) m.authors = [author.slice(0, 200)];
  });

  let pages = (await run('pdftotext', ['-enc', 'UTF-8', file, '-'], 300_000)).split('\f');
  if (pages.length > 1 && !pages.at(-1).trim()) pages.pop();
  if (pages.length > MAX_PAGES) throw new HttpError(422, 'book.tooManyPages', { max: MAX_PAGES });
  let scan = null;
  // Scanned books have no text layer (or a few stray words per page).
  if (pages.reduce((n, p) => n + wordCount(p), 0) < 30 * pages.length) {
    // OCR renders the file with pdftoppm, whose Splash renderer has had overflows a crafted PDF can
    // reach (CVE-2026-10118). A file a web page chose stops here; the reader's own upload goes on.
    if ((await getMeta(id)).absUrl) throw new HttpError(422, 'book.linkScan');
    await setBook(id, { step: 'ocr', ocr: true, progress: 0 });
    ({ pages, scan } = await ocrPages(id, file, pages.length, sizes));
  }
  await setBook(id, { step: 'chapters', progress: 1 });
  return { chapters: await inWorker('chaptersFromPages', pages), scan };
}

// What points at chapter ids or block numbers: a book with any of it is not rearranged.
async function refuseIfUsed(id) {
  const names = await fsp.readdir(path.dirname(pdfFile(id)));
  const used = names.filter((n) => ['annotations.json', 'lookups.jsonl', 'threads', 'translations'].includes(n));
  if (used.length) throw new Error(`has ${used.join(', ')}`);
}

// A born-digital PDF book made into chapters again by its bookmarks (scripts/rechapter.mjs), for a
// book whose headings misled the import. Chapter ids change, so a book with anything that points
// at them is refused; its summaries and brief are made anew.
// ponytail: asked for by hand, book by book. An import keeps to the headings: bookmarks and -layout
// would scramble two-column papers and take page-number heads for footnotes (readLaidOut).
export async function rechapter(id) {
  const meta = await getMeta(id);
  if (meta.kind !== 'book' || meta.source !== 'upload' || meta.book?.ocr || !(await fsp.stat(pdfFile(id)).catch(() => null))) throw new Error('not a born-digital PDF book');
  await refuseIfUsed(id);
  const file = pdfFile(id);
  const outline = await inWorker('pdfOutline', file);
  if (outline.filter((o) => o.depth <= 1).length < 3) throw new Error('too few bookmarks');
  const pages = (await run('pdftotext', ['-enc', 'UTF-8', '-layout', file, '-'], 300_000)).split('\f');
  if (!pages.at(-1).trim()) pages.pop();
  const chapters = await inWorker('chaptersFromPages', pages, outline);
  // (Git Bash finds xpdf's pdftotext first: its -layout keeps no indents, so nothing divides a chapter)
  if (chapters.some((c) => c.blocks.some((b) => b.x.length > 50_000))) throw new Error('a paragraph of over 50,000 characters: is this poppler\'s pdftotext?');
  const book = await updateBook(id, (b) => {
    b.chapters = chapters.map((c, i) => ({ id: `c${i + 1}`, ...c }));
    b.brief = '';
    b.summaries = {};
  });
  await writeHtml(id, book);
  await setBook(id, { step: 'done', progress: 1, chapters: chapters.length, summaries: 0, translations: {} });
  return book;
}

// The chapters from `first` to `last` made one, under `title` and keeping the id of `first`; each
// old title stays as a heading (scripts/merge-chapters.mjs). Other chapters keep their ids and
// summaries; the new one gets its summary at the next start, the brief stays.
export async function mergeChapters(id, first, last, title) {
  await refuseIfUsed(id);
  const merged = new Set();
  const book = await updateBook(id, (b) => {
    const from = b.chapters.findIndex((c) => c.id === first);
    const to = b.chapters.findIndex((c) => c.id === last);
    if (from < 0 || to <= from || b.figures?.length) throw new Error('no such run of chapters, or a book with pictures');
    const run = b.chapters.slice(from, to + 1);
    const pages = run[0].pages && [run[0].pages[0], run.at(-1).pages[1]];
    b.chapters.splice(from, run.length, { ...run[0], title, blocks: run.flatMap((c) => [{ t: 'h', x: c.title }, ...c.blocks]), pages });
    for (const c of run) {
      merged.add(c.id);
      delete b.summaries?.[c.id];
    }
  });
  await writeHtml(id, book);
  const plans = Object.entries((await getMeta(id)).book?.translations || {}).filter(([c]) => !merged.has(c));
  await setBook(id, { chapters: book.chapters.length, summaries: Object.keys(book.summaries || {}).length, translations: Object.fromEntries(plans) });
  return book;
}

// Renders pages 1 to `count` (300 dpi, or MAX_IMAGE_SIDE pixels for a long page) and has tesseract
// write its `outputs` ('txt', 'hocr') for each, which `onPage(n, base)` reads from base.txt and
// base.hocr; half the CPUs at a time. The first failure stops it, unless `skip`: then a page that
// fails is passed over (a missing tool still stops it). `ocr`: tesseract's language, else English.
async function readPages(file, count, sizes, outputs, onPage, skip = false, ocr = null) {
  // Scratch images stay out of the synced data folder.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'eng-reader-ocr-'));
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < count) {
      const n = ++next;
      const base = path.join(dir, `p${n}`);
      const scale = (sizes.get(n) ?? Infinity) * (300 / 72) > MAX_IMAGE_SIDE ? ['-scale-to', String(MAX_IMAGE_SIDE)] : ['-r', '300'];
      try {
        await run('pdftoppm', [...scale, '-gray', '-png', '-f', String(n), '-l', String(n), '-singlefile', file, base], 120_000);
        await run('tesseract', [`${base}.png`, base, ...(ocr ? ['-l', ocr] : []), ...outputs], 300_000);
        await onPage(n, base);
      } catch (err) {
        if (skip && err.key !== 'book.toolMissing') {
          console.error(`[ocr] page ${n}:`, err.key ? `${err.key} ${JSON.stringify(err.params)}` : err.message);
          continue;
        }
        failed = true;
        throw err;
      } finally {
        for (const ext of ['png', ...outputs]) await fsp.rm(`${base}.${ext}`, { force: true });
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.floor(os.cpus().length / 2)) }, worker));
  await fsp.rm(dir, { recursive: true, force: true });
  const bad = results.find((r) => r.status === 'rejected');
  if (bad) throw bad.reason;
}

// What the hOCR says about a page (figures.js), or null: a page whose pictures can't be read
// still has its text.
const hocrOf = (base) => fsp.readFile(`${base}.hocr`, 'utf8').then(readHocr).catch(() => null);

// The languages tesseract has data for, asked once ("eng" comes with it); asked again after a failure.
let tessdata = null;
const ocrLangs = () =>
  (tessdata ??= run('tesseract', ['--list-langs'], 30_000)
    .then((out) => new Set(out.split('\n').slice(1).map((s) => s.trim()).filter(Boolean)))
    .catch(() => {
      tessdata = null;
      return new Set();
    }));

// The text of each page, and what tesseract saw on it (its pictures and lines, see hocrOf), read in
// the book's language where tesseract has its data, else as English (and the log says so).
async function ocrPages(id, file, count, sizes) {
  const pages = new Array(count).fill('');
  const scan = new Array(count).fill(null);
  let done = 0;
  let reported = Date.now();
  const want = ocrLang(bookLangs(await getMeta(id)).src);
  const ocr = want && (await ocrLangs()).has(want) ? want : null;
  if (want && !ocr) console.warn(`[ocr] ${id}: tesseract has no data for '${want}' (install it to read this book's language); reading it as English`);
  await readPages(file, count, sizes, ['txt', 'hocr'], async (n, base) => {
    // Line ends as run() gives stdout, whatever the platform.
    pages[n - 1] = (await fsp.readFile(`${base}.txt`, 'utf8')).replace(/\r\n?/g, '\n');
    scan[n - 1] = await hocrOf(base);
    done += 1;
    if (Date.now() - reported > 2000) {
      reported = Date.now();
      setBook(id, { progress: Math.round((done / count) * 1000) / 1000 }).catch(() => {});
    }
  }, false, ocr);
  return { pages, scan };
}

// ---- pictures of scanned books ---------------------------------------------------------------------

// ponytail: only scanned books get pictures, found by tesseract; a born-digital PDF's could come
// from pdfimages.

// Cuts each picture `scan` holds out of the PDF into figures/p<page>-<k>.png, at half the scale of
// the OCR image its box is in (150 dpi) and a few pixels larger, and places it among the chapters'
// blocks (figures.js): [{ id, chapter, before, page, w, h }]. A picture that can't be cut is left out.
async function cutFigures(id, scan, chapters) {
  const unread = scan.filter((page) => !page).length;
  if (unread) console.error(`[figures] ${id}: no hOCR for ${unread} of ${scan.length} pages`);
  const figures = [];
  for (const [i, page] of scan.entries()) {
    for (const [k, box] of (page?.photos || []).entries()) {
      await getMeta(id); // the book deleted meanwhile: its folder is not made again
      const n = i + 1;
      const name = `p${n}-${k + 1}`;
      // The crop's long side is half the OCR image's (2000 pixels for a page read at 4000).
      const long = Math.max(...page.size);
      const side = Math.round(long / 2);
      const s = side / long;
      const [x, y] = [box[0], box[1]].map((v) => Math.max(0, Math.floor(v * s) - 4));
      const w = Math.min(Math.floor(page.size[0] * s), Math.ceil(box[2] * s) + 4) - x;
      const h = Math.min(Math.floor(page.size[1] * s), Math.ceil(box[3] * s) + 4) - y;
      try {
        const png = figureFile(id, `${name}.png`);
        await fsp.mkdir(path.dirname(png), { recursive: true });
        const crop = ['-x', x, '-y', y, '-W', w, '-H', h].map(String);
        await run('pdftoppm', ['-scale-to', String(side), '-gray', '-png', '-f', String(n), '-l', String(n), ...crop, '-singlefile', pdfFile(id), png.slice(0, -4)], 120_000);
        figures.push({ id: name, ...placeFigure(chapters, scan, n, box), page: n, w, h });
      } catch (err) {
        console.error(`[figures] ${id} ${name}:`, err.key || err.message);
      }
    }
  }
  return figures;
}

// The pictures of a scanned book that has none recorded (imported before they were kept, or its
// import resumed after the OCR): its pages are read once more, for tesseract's hOCR only; a page
// that fails has none. Once done, `figures` is in book.json (empty if there are none) and this
// does nothing. One book at a time; a failure is logged, and the next start tries again.
// ponytail: two tries per book (book.json `figureTries`, counted before each), so a book that
// always fails doesn't have every page read at every start; delete `figureTries` for two more.
export function addFigures(id) {
  return withLock('figures', async () => {
    const book = await readBook(id);
    if (book.figures || book.figureTries >= 2) return;
    await updateBook(id, (b) => {
      b.figureTries = (b.figureTries || 0) + 1;
    });
    const file = pdfFile(id);
    const { count, sizes } = await pdfInfo(file);
    const scan = new Array(Math.min(count, MAX_PAGES)).fill(null);
    await readPages(file, scan.length, sizes, ['hocr'], async (n, base) => {
      scan[n - 1] = await hocrOf(base);
    }, true);
    const figures = await cutFigures(id, scan, (await readBook(id)).chapters);
    await updateBook(id, async (b) => {
      b.figures = figures;
      await writeHtml(id, b);
    });
  }).catch((err) => console.error(`[figures] ${id}:`, err.key || err.message));
}

// ---- web books ---------------------------------------------------------------------------------------

// Chapter 1 is the page itself; up to `follow` more come from its "next" links in the background.
// A book.json that already has chapters is kept as it is.
export async function importWebPage(id, page, { url, follow = 0, lang }) {
  const current = await peekBook(id);
  const ex = await inWorker('extractPage', page.html, page.url);
  let book = current;
  if (!current?.chapters?.length) {
    if (!ex.blocks.length) throw new HttpError(422, 'book.noText');
    book = { ...emptyBook(), chapters: [{ id: 'c1', title: ex.title || 'Chapter 1', blocks: ex.blocks, pages: null, url: page.url }], next: ex.next };
    await writeBook(id, book);
  }
  await writeHtml(id, book);
  const pending = book.next ? follow : 0;
  const meta = await saveMeta({
    id,
    kind: 'book',
    source: 'web',
    sourceId: url,
    title: (ex.bookTitle || ex.title || url).slice(0, 500),
    titleSource: 'source',
    authors: ex.authors,
    abstract: '',
    published: '',
    absUrl: url,
    pdfUrl: '',
    createdAt: now(),
    lastOpenedAt: now(),
    book: {
      status: pending ? 'processing' : 'ready',
      step: pending ? 'chapters' : 'done',
      progress: 0,
      error: '',
      chapters: book.chapters.length,
      ocr: false,
      summaries: Object.keys(book.summaries || {}).length,
      follow: pending,
    },
    html: { status: 'ok', baseUrl: page.url },
  });
  if (pending) startBook(id, lang);
  else prepareBook(id, meta);
  return meta;
}

// Fetches up to `count` pages along the "next" links, 700 ms apart, appending a chapter each.
async function followPages(id, count) {
  for (let i = 0; i < count; i++) {
    const { next } = await readBook(id);
    if (!next) break;
    await sleep(700);
    const page = await fetchPage(next);
    const ex = await inWorker('extractPage', page.html, page.url);
    const book = await updateBook(id, (b) => {
      const n = Math.max(0, ...b.chapters.map((c) => Number(c.id.slice(1)))) + 1;
      if (ex.blocks.length) b.chapters.push({ id: `c${n}`, title: ex.title || `Chapter ${n}`, blocks: ex.blocks, pages: null, url: page.url });
      const seen = new Set([next, ...b.chapters.map((c) => c.url)]);
      b.next = ex.next && !seen.has(ex.next) ? ex.next : null;
    });
    await writeHtml(id, book);
    await setBook(id, { chapters: book.chapters.length, progress: (i + 1) / count, follow: count - i - 1 });
  }
}

// POST /api/papers/:id/chapters, of a book made from text: { add: [{ title, blocks: [{ t: 'p' |
// 'h', x }], before?: chapter id }], titles: { c3: 'New title' } }. New chapters get new ids
// (at the end, or before the one named), so those already there keep theirs: their marks,
// translations and summaries point at them. A collection grows this way (sermons, say).
export async function editChapters(id, { add = [], titles = {} } = {}) {
  const meta = await getMeta(id);
  if (meta.kind !== 'book' || meta.source !== 'txt') throw new HttpError(400, 'book.notText');
  if (meta.book?.status !== 'ready') throw new HttpError(409, 'book.notReady');
  // (as an import keeps it: one space for any run of spaces or control characters, so a block's
  // text is what the page shows, offsets and all)
  const text = (s) => (typeof s === 'string' ? collapseWs(s.replace(/[\u0000-\u001f\u007f]/g, ' ')) : '');
  const line = (s) => text(s).slice(0, 200);
  const ok =
    Array.isArray(add) &&
    add.length <= 100 &&
    add.every((c) => line(c?.title) && Array.isArray(c.blocks) && c.blocks.length && c.blocks.length <= 5000 && c.blocks.every((b) => (b?.t === 'p' || b?.t === 'h') && text(b.x) && b.x.length <= 50_000) && (c.before == null || /^c\d+$/.test(c.before))) &&
    titles &&
    typeof titles === 'object' &&
    Object.entries(titles).every(([k, v]) => /^c\d+$/.test(k) && line(v));
  if (!ok || (!add.length && !Object.keys(titles).length)) throw new HttpError(400, 'book.badChapters');
  await runJob(id, async () => {
    const book = await updateBook(id, (b) => {
      if (Object.keys(titles).some((k) => !b.chapters.some((c) => c.id === k)) || add.some((c) => c.before && !b.chapters.some((x) => x.id === c.before))) throw new HttpError(400, 'book.badChapter');
      for (const c of b.chapters) if (titles[c.id]) c.title = line(titles[c.id]);
      let n = Math.max(0, ...b.chapters.map((c) => Number(c.id.slice(1))));
      for (const c of add) {
        const chapter = { id: `c${++n}`, title: line(c.title), blocks: c.blocks.map((x) => ({ t: x.t, x: text(x.x) })), pages: null, url: null };
        const at = c.before ? b.chapters.findIndex((x) => x.id === c.before) : -1;
        if (at < 0) b.chapters.push(chapter);
        else b.chapters.splice(at, 0, chapter);
      }
    });
    await writeHtml(id, book);
    await setBook(id, { chapters: book.chapters.length });
  });
  const ready = await getMeta(id);
  prepareBook(id, ready);
  return ready;
}

// POST /api/papers/:id/chapters/next
export async function fetchNext(id, count) {
  const meta = await getMeta(id);
  if (meta.kind !== 'book' || meta.source !== 'web') throw new HttpError(400, 'book.notWeb');
  await runJob(id, async () => {
    if (!(await readBook(id)).next) throw new HttpError(422, 'book.noNext');
    try {
      await followPages(id, count);
    } finally {
      await setBook(id, { follow: 0 });
    }
  });
  const ready = await getMeta(id);
  prepareBook(id, ready);
  return ready;
}
