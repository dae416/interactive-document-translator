// Text to chapters: pages of a PDF (pdftotext or OCR), text files and web pages. Pure functions;
// book.js runs them in a worker thread (parse-worker.js) so a hostile input can't stall the server.
import { readFile } from 'node:fs/promises';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { collapseWs } from './util.js';
import { countWords } from '../public/assets/js/langs.js';

// (a character of Chinese or Japanese is a word)
const wordCount = countWords;

// Headings are compared as lower-case letters only.
const keyOf = (s) => s.toLowerCase().replace(/[^\p{L}]/gu, '');

function within2(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= 2;
}

// OCR misreads and truncates headings ("7O THE IDLE", "ON THE PREACHER'S APPEAR"); short ones must match exactly.
const sameKey = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a) || within2(a, b)));

const ROMAN = /^(?=[mdclxvi])m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanValue(s) {
  const digits = [...s.toLowerCase()].map((c) => ROMAN_VALUES[c]);
  return digits.reduce((n, d, i) => n + (d < (digits[i + 1] || 0) ? -d : d), 0);
}

// "CHAPTER I." and "CHAPTER II." look alike to OCR-tolerant matching but are different chapters.
const NUMBERED = /\b(chapter|chap|book|part|section|letter|lecture|sermon|canto)\.?\s+(\d+|[ivxlcdm]+)\b/i;
const numberOf = (s) => {
  const m = NUMBERED.exec(s);
  if (!m) return null;
  return /^\d+$/.test(m[2]) ? Number(m[2]) : ROMAN.test(m[2]) ? romanValue(m[2]) : null;
};

const sameHeading = (a, b) => sameKey(a.key, b.key) && (a.num == null || b.num == null || a.num === b.num);

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'the', 'to', 'with']);

function titleCase(s) {
  return s.replace(/[\p{L}'’]+/gu, (w, i) => {
    if (w.length > 1 && /^[IVXLCDM]+$/.test(w) && ROMAN.test(w)) return w;
    const lower = w.toLowerCase();
    const opens = i === 0 || /[.:;!?]\s*$/.test(s.slice(0, i));
    return !opens && SMALL_WORDS.has(lower) ? lower : lower[0].toUpperCase() + lower.slice(1);
  });
}

const isUpper = (s) => {
  const letters = s.match(/\p{L}/gu) || [];
  return letters.length > 0 && letters.filter((c) => /\p{Lu}/u.test(c)).length >= 0.7 * letters.length;
};

// The chapter title for a heading line: "TO THE IDLE." becomes "To the Idle".
const headingTitle = (s) => {
  const t = s.replace(/[\s.,:;]+$/, '');
  return isUpper(t) ? titleCase(t) : t;
};

// A part with no paragraphs (a heading alone, as in a list of contents) joins the part after it.
function mergeEmpty(chapters) {
  const out = [];
  let carry = null;
  for (const c of chapters) {
    const merged = carry ? { ...c, blocks: [...carry.blocks, ...c.blocks], pages: carry.pages && c.pages ? [carry.pages[0], c.pages[1]] : c.pages } : c;
    if (merged.blocks.some((b) => b.t === 'p')) {
      out.push(merged);
      carry = null;
    } else {
      carry = merged;
    }
  }
  if (carry && out.length) out.at(-1).blocks.push(...carry.blocks);
  else if (carry) out.push(carry);
  return out;
}

// ---- PDF pages -------------------------------------------------------------------------

const GOOGLE_NOTICE = 'this is a digital copy of a book that was preserved for generations on library shelves';
// The folio of a chapter's first page, printed at the foot: "(7)".
const DROP_FOLIO = /^[([]\d{1,4}[)\]]$/;

// Page-number junk around a running head: short tokens that are not upper-case words
// ("8", "a>", "igo" for 190, "2a" for 211).
const isJunk = (t) => t.length <= 4 && !/^\p{Lu}[\p{Lu}'’.,:;!?-]*$/u.test(t) && (t.length <= 3 || /[^\p{L}]/u.test(t));

function stripJunk(line) {
  const toks = line.split(/\s+/).filter(Boolean);
  // The number in "CHAPTER 12" is not junk.
  while (toks.length > 1 && isJunk(toks.at(-1)) && !NUMBERED.test(toks.slice(-2).join(' '))) toks.pop();
  while (toks.length > 1 && isJunk(toks[0])) toks.shift();
  return toks.join(' ');
}

// Up to 6 characters of numbers, roman numerals or punctuation: folios, signature marks, specks.
const isFolioLine = (l) => l.length <= 6 && l.split(/[^\p{L}\p{N}]+/u).every((t) => !t || /^\d+$/.test(t) || ROMAN.test(t));

function headingText(line) {
  const s = stripJunk(line);
  return s.length <= 60 && isUpper(s) ? s : null;
}

// The book-title running head: the most frequent first line, if it heads a fifth of the pages.
// ("CHAPTER 3" lines are headings, though their letters are all alike.)
function runningHead(pages) {
  const counts = new Map();
  for (const text of pages) {
    const first = stripJunk(text.split('\n').find((l) => l.trim())?.trim() || '');
    const key = NUMBERED.test(first) ? '' : keyOf(first);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [key, c] of counts) if (c > n) [best, n] = [key, c];
  return n >= Math.max(3, pages.length / 5) ? best : null;
}

function readPage(text, runKey) {
  if (collapseWs(text).toLowerCase().includes(GOOGLE_NOTICE)) return { lines: [], head: null, opener: false };
  let lines = text.split('\n').map((l) => l.trim()).filter((l) => !/^digitized by google$/i.test(l));
  const opener = DROP_FOLIO.test(lines.findLast(Boolean) || '');
  lines = lines.filter((l) => !l || !isFolioLine(l));
  const top = lines.flatMap((l, i) => (l ? [i] : [])).slice(0, 3);
  if (runKey) for (const i of top) if (within2(keyOf(stripJunk(lines[i])), runKey)) lines[i] = '';
  let head = null;
  for (const i of top) {
    const h = lines[i] && headingText(lines[i]);
    if (!h) continue;
    head = { text: h, at: [i] };
    // Two-line titles: "ON THE PREACHER'S APPEAR-" + "ANCE."
    const j = lines.findIndex((l, k) => k > i && l);
    const h2 = h.endsWith('-') && j > 0 ? headingText(lines[j]) : null;
    if (h2) head = { text: h.slice(0, -1) + h2, at: [i, j] };
    head.key = keyOf(head.text);
    head.num = numberOf(head.text);
    break;
  }
  return { lines, head, opener };
}

// In lines for ocrParagraphs: this paragraph ends here, whatever the text does.
const PARA = '\f';

// Lines to paragraphs. A blank line or a page break ends a paragraph unless the text plainly runs
// on: the next line starts in lower case, or the last one stops mid-sentence. (OCR puts blank lines
// between ordinary lines on some pages.) Hyphenated line ends are joined: "spar-" + "row".
function ocrParagraphs(lines) {
  const out = [];
  let cur = '';
  let gap = false;
  for (const line of lines) {
    if (line === PARA) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    if (!line) {
      gap = true;
      continue;
    }
    if (cur && gap && !/^\p{Ll}/u.test(line) && !/[\p{L},;\-—]$/u.test(cur)) {
      out.push(cur);
      cur = '';
    }
    if (!cur) cur = line;
    else if (/\p{L}-$/u.test(cur) && /^\p{Ll}/u.test(line)) cur = cur.slice(0, -1) + line;
    else cur += ` ${line}`;
    gap = false;
  }
  if (cur) out.push(cur);
  return out.map(collapseWs).filter(Boolean);
}

function commonest(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) || 0) + 1);
  let best = list[0];
  let n = 0;
  for (const [x, c] of counts) if (c > n) [best, n] = [x, c];
  return best;
}

// The PDF's bookmarks, in order: [{ title, page, depth }], depth 0 at the top. None if it has none.
export async function pdfOutline(file) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0 });
  const doc = await task.promise;
  const out = [];
  const walk = async (items, depth) => {
    for (const it of items || []) {
      const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest).catch(() => null) : it.dest;
      const page = dest?.[0] ? await doc.getPageIndex(dest[0]).catch(() => -1) : -1;
      if (page >= 0) out.push({ title: collapseWs(it.title), page: page + 1, depth });
      await walk(it.items, depth + 1);
    }
  };
  await walk(await doc.getOutline(), 0);
  await task.destroy();
  return out;
}

// How far a line goes along a heading's letters (`key`, from `at`), and what is left of the line:
// pdftotext may run a running head into the text below it, and a long head ends in "...". Null if
// the line leaves the heading.
function followHeading(line, key, at) {
  const cut = line.search(/\.{3}|…/);
  const head = cut < 0 ? line : line.slice(0, cut);
  let j = at;
  for (const m of head.matchAll(/\p{L}/gu)) {
    for (const ch of m[0].toLowerCase()) {
      // (the heading ends between words: "PART I" is not the start of "PART Island")
      if (j === key.length) return /\p{L}/u.test(line[m.index - 1] || '') ? null : { at: j, rest: line.slice(m.index) };
      if (ch !== key[j]) return null;
      j += 1;
    }
  }
  return { at: j, rest: cut < 0 ? '' : line.slice(cut).replace(/^(\.{3}|…)\s*/, '') };
}

const longEnough = (at, key) => at >= Math.min(8, key.length);

// A heading starting at line i, over as many lines as it takes: where it ends and what is left of
// that line, or null. (A long running head wraps: "… AND MISERABLY" + "ENSLAVE…".)
function headingAt(lines, key, i) {
  let at = 0;
  let end = i;
  let rest = '';
  for (let j = i; j < lines.length && at < key.length; j++) {
    if (!lines[j]) continue;
    const m = followHeading(lines[j], key, at);
    if (!m || m.at === at) break;
    ({ at, rest } = m);
    end = j;
    if (/\.{3}|…/.test(lines[j])) break;
  }
  return longEnough(at, key) ? { end, rest } : null;
}

// Where a heading stands in a page's lines, from `from`: { start, end }, with the line it ends in
// cut down to what follows it. Null if it isn't there. (A title with text above it and nothing
// below is a running foot.)
function findHeading(lines, key, from) {
  for (let i = from; i < lines.length; i++) {
    const h = lines[i] && headingAt(lines, key, i);
    if (h && (h.rest || !lines.slice(from, i).some(Boolean) || lines.slice(h.end + 1).some(Boolean))) {
      lines[h.end] = h.rest;
      return { start: i, end: h.rest ? h.end : h.end + 1 };
    }
  }
  return null;
}

const leadTitle = (s) => headingTitle(isUpper(s) ? s.split(/\.\s/)[0] : s);

// The bookmarks that make chapters, each with its title. Chapters numbered afresh in each of
// several parts are told apart as "2.7 Title"; a title that says little alone ("ARGUMENT." four
// times, "BOOK 1" under the aphorisms) takes its parent's.
function outlineItems(outline, pageCount) {
  // ponytail: two levels make chapters, deeper bookmarks stay inside them; a book with parts,
  // chapters and sections would want them chosen by size instead.
  const items = outline.filter((o) => o.depth <= 1 && o.title && o.page <= pageCount).map((o) => ({ ...o, parent: null }));
  let parent = null;
  for (const it of items) {
    if (it.depth === 0) parent = it;
    else it.parent = parent;
  }
  const chapterNo = (it) => /^chapter\s+(\d+)\b[\s.:—–-]*/i.exec(it.title);
  const groups = [...new Set(items.filter((it) => it.parent && chapterNo(it)).map((it) => it.parent))];
  const said = new Map();
  for (const it of items) said.set(keyOf(it.title), (said.get(keyOf(it.title)) || 0) + 1);
  return items.map((it) => {
    const no = chapterNo(it);
    let title = headingTitle(no ? it.title.slice(no[0].length) : it.title) || headingTitle(it.title);
    if (no && groups.length > 1) title = `${groups.indexOf(it.parent) + 1}.${no[1]} ${title}`;
    else if (!no && it.parent && (said.get(keyOf(it.title)) > 1 || NUMBERED.test(it.title))) title = `${leadTitle(it.parent.title)}: ${title}`;
    return { title, heading: it.title, key: keyOf(it.title), page: it.page };
  });
}

// A page from pdftotext -layout: its lines, those that open a paragraph by an indent (none on a
// page without such indents, an OCR page say: then blank lines tell), and its footnotes, which
// stand below a blank line at the left margin, "21   Chrysost…", and would break into the text.
// ponytail: -layout runs the columns of a two-column PDF together.
function readLaidOut(text) {
  const indent = (l) => l.length - l.trimStart().length;
  const raw = text
    .split('\n')
    // (a number far out in the margin: the print edition's page)
    .map((l) => (l.length >= 80 ? l.replace(/\s{3,}\d{1,4}\s*$/, '') : l).trimEnd())
    .filter((l) => !l || !isFolioLine(l.trim()));
  const long = raw.filter((l) => l.length > 50).map(indent);
  const margin = long.length ? Math.min(...long) : 0;
  const isNote = (l) => /^\d{1,4}\s{2,}\S/.test(l.slice(margin));
  const foot = raw.findIndex((l, i) => i > 0 && isNote(l) && !raw[i - 1]);
  const notes = [];
  for (const l of foot < 0 ? [] : raw.slice(foot)) {
    if (!l.trim()) continue;
    if (isNote(l)) notes.push(l.trim().replace(/^(\d+)\s+/, '[$1] '));
    else notes[notes.length - 1] = `${notes.at(-1).replace(/-$/, '')}${notes.at(-1).endsWith('-') ? '' : ' '}${l.trim()}`;
  }
  const body = foot < 0 ? raw : raw.slice(0, foot);
  const opens = new Set(body.flatMap((l, i) => (l && indent(l) - margin >= 3 ? [i] : [])));
  return { lines: body.map((l) => l.trim()), opens: body.some((l) => l.length > 50 && indent(l) - margin >= 3) ? opens : new Set(), notes };
}

// Chapters from the PDF's bookmarks, each opening where its bookmark's heading stands on the page
// (at the top of the page if the heading can't be found). The running head goes, and a page's
// footnotes go to the end of its chapter.
function chaptersFromOutline(pages, outline) {
  const parts = outlineItems(outline, pages.length).map((it) => ({ ...it, last: it.page, lines: [], notes: [] }));
  if (parts[0].page > 1) parts.unshift({ title: 'Front matter', heading: 'Front matter', key: '', page: 1, last: 1, lines: [], notes: [] });
  let cur = null;
  pages.forEach((text, i) => {
    const page = i + 1;
    const { lines, opens, notes } = readLaidOut(text);
    // Lines from a to b, with their paragraph ends.
    const body = (a, b) => (opens.size ? lines.slice(a, b).flatMap((l, k) => (!l ? [] : opens.has(a + k) ? [PARA, l] : [l])) : lines.slice(a, b));
    const opening = parts.filter((c) => c.page === page);
    const first = lines.findIndex(Boolean);
    // (the head may be of any chapter opening here, or of the one that runs on)
    const head = first < 0 ? null : [...opening, cur].reduce((h, c) => h || (c?.key ? headingAt(lines, c.key, first) : null), null);
    if (head) {
      lines.fill('', first, head.end);
      lines[head.end] = head.rest;
    }
    let from = 0;
    for (const c of opening) {
      const at = c.key ? findHeading(lines, c.key, from) : null;
      // Sharing the page with no heading to say where: nothing of its own.
      if (!at && c !== opening[0]) {
        c.none = true;
        continue;
      }
      if (at && cur) cur.lines.push(...body(from, at.start), '');
      if (at) from = at.end;
      cur = c;
    }
    if (cur) {
      cur.lines.push(...body(from, lines.length), ...(opens.size ? [] : ['']));
      cur.notes.push(...notes);
      if (lines.slice(from).some(Boolean)) cur.last = page;
    }
  });
  return mergeEmpty(
    parts.filter((c) => !c.none).map((c) => {
      const blocks = ocrParagraphs(c.lines).map((x) => ({ t: 'p', x }));
      if (c.notes.length) blocks.push({ t: 'h', x: 'Notes' }, ...c.notes.map((x) => ({ t: 'p', x })));
      return { title: c.title, blocks: blocks.length ? blocks : [{ t: 'h', x: c.heading }], pages: [c.page, Math.max(c.page, c.last)], url: null };
    }),
  );
}

// Text of each PDF page (pdftotext or OCR) to chapters: by the bookmarks if given some (with pages
// from -layout, see rechapter() in book.js), else from the headings at the top of pages. Returns [{ title, blocks, pages: [first, last], url: null }].
export function chaptersFromPages(pages, outline = []) {
  if (outline.filter((o) => o.depth <= 1).length >= 3) return chaptersFromOutline(pages, outline);
  const runKey = runningHead(pages);
  const info = pages.map((text) => readPage(text, runKey));

  // A heading counts only when it heads two pages or more (an opening page and a running head):
  // one-off upper-case lines on title pages, plates and adverts are text.
  const counts = new Map();
  for (const p of info) if (p.head) counts.set(p.head.key, (counts.get(p.head.key) || 0) + 1);
  const total = new Map([...counts.keys()].map((k) => [k, [...counts].reduce((n, [k2, c]) => n + (sameKey(k, k2) ? c : 0), 0)]));
  for (const p of info) {
    if (p.head && total.get(p.head.key) < 2) p.head = null;
    else if (p.head) for (const i of p.head.at) p.lines[i] = '';
  }
  // A chapter's first page often has no title line, only the folio at its foot; it opens the
  // chapter whose title comes next.
  for (let i = info.length - 1, next = null; i >= 0; i--) {
    if (info[i].head) next = info[i].head;
    else if (info[i].opener && next) info[i].head = { ...next, at: [] };
  }

  const parts = [];
  let cur = null;
  info.forEach((p, i) => {
    if (!cur || (p.head && !(cur.head && sameHeading(cur.head, p.head)))) {
      cur = { head: p.head, heads: [], pages: [i + 1, i + 1], lines: [] };
      parts.push(cur);
    }
    if (p.head) cur.heads.push(p.head.text);
    cur.pages[1] = i + 1;
    const first = p.lines.findIndex(Boolean);
    if (first >= 0) cur.lines.push(...p.lines.slice(first, p.lines.findLastIndex(Boolean) + 1), '');
  });

  if (parts.filter((c) => c.head).length < 2) {
    // No usable headings: 10-page chunks.
    const chunks = [];
    for (let a = 0; a < info.length; a += 10) {
      const lines = info.slice(a, a + 10).flatMap((p) => [...p.lines, '']);
      const b = Math.min(a + 10, info.length);
      chunks.push({ title: `pp. ${a + 1}–${b}`, blocks: ocrParagraphs(lines).map((x) => ({ t: 'p', x })), pages: [a + 1, b], url: null });
    }
    return chunks.filter((c) => c.blocks.length);
  }
  return mergeEmpty(
    parts
      .map((c) => {
        const heading = c.head ? commonest(c.heads) : null;
        const blocks = ocrParagraphs(c.lines).map((x) => ({ t: 'p', x }));
        return {
          title: heading ? headingTitle(heading) : 'Front matter',
          blocks: heading ? [{ t: 'h', x: heading }, ...blocks] : blocks,
          pages: c.pages,
          url: null,
        };
      })
      .filter((c) => c.blocks.length),
  );
}

// ---- text files -----------------------------------------------------------------------------

const TXT_HEADING = /^\s*(chapter|chap\.|book|part|section|chapitre|capítulo|capitulo|capitolo|kapitel|hoofdstuk|глава|часть)(?:\s+(\S+)|\s*$)/i;
const NUMBER_WORDS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'first', 'second', 'third', 'the']);
// The same in Chinese, Japanese and Korean, the number inside: "第一章", "第3回", "제1장".
const CJK_HEADING = /^\s*(?:第\s*[0-9０-９一二三四五六七八九十百千〇零两]+\s*[章回節节卷部篇]|제\s*\d+\s*[장편부권])/;

// "Chapter I", "CHAP. 2", "Book the First", "Part One", "IV." (or "Chapitre 3", "第一章") — but not
// "Part of the trouble", nor a line that is only "I" (the pronoun), "." or "Mix".
function txtHeading(s) {
  if (CJK_HEADING.test(s)) return true;
  const m = TXT_HEADING.exec(s);
  if (!m) {
    const numeral = s.replace(/\.$/, '');
    return /^[IVXLCDM]+$/.test(numeral) && ROMAN.test(numeral) && romanValue(numeral) <= 300 && (numeral.length > 1 || s.endsWith('.'));
  }
  const next = (m[2] || '').replace(/[.:,]$/, '');
  return !next || /^\d+$/.test(next) || ROMAN.test(next) || NUMBER_WORDS.has(next.toLowerCase());
}

function txtParagraphs(lines) {
  const out = [];
  let cur = [];
  for (const line of [...lines, '']) {
    if (line.trim()) cur.push(line);
    else if (cur.length) {
      out.push(collapseWs(cur.join(' ')));
      cur = [];
    }
  }
  return out;
}

// Splits at short heading lines that start a paragraph (see txtHeading); without at least two
// chapters that way, into chapters of about 3000 words.
export function chaptersFromText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const parts = [{ head: null, lines: [] }];
  lines.forEach((line, i) => {
    const s = line.trim();
    if (s && s.length <= 60 && (i === 0 || !lines[i - 1].trim()) && txtHeading(s)) parts.push({ head: collapseWs(s), lines: [] });
    else parts.at(-1).lines.push(line);
  });
  const chapters = mergeEmpty(
    parts
      .map((p) => {
        const blocks = txtParagraphs(p.lines).map((x) => ({ t: 'p', x }));
        return {
          title: p.head ? headingTitle(p.head) : 'Front matter',
          blocks: p.head ? [{ t: 'h', x: p.head }, ...blocks] : blocks,
          pages: null,
          url: null,
        };
      })
      .filter((c) => c.blocks.length),
  );
  if (chapters.filter((c) => c.blocks[0]?.t === 'h').length >= 2) return chapters;

  const out = [];
  let blocks = [];
  let words = 0;
  for (const x of txtParagraphs(lines)) {
    blocks.push({ t: 'p', x });
    words += wordCount(x);
    if (words >= 3000) {
      out.push({ title: `Part ${out.length + 1}`, blocks, pages: null, url: null });
      blocks = [];
      words = 0;
    }
  }
  if (blocks.length) out.push({ title: `Part ${out.length + 1}`, blocks, pages: null, url: null });
  return out;
}

// ---- web pages --------------------------------------------------------------------------------

// (A lookahead, not \b: \b never matches after a Hangul syllable.)
const NEXT_TEXT = /^\s*(next|다음)(?![a-z])|»\s*$/i;
const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, blockquote, li';

function sameOriginUrl(href, base) {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.origin === new URL(base).origin && u.href !== new URL(base).href ? u.href : null;
  } catch {
    return null;
  }
}

function nextLink(document, url) {
  return (
    sameOriginUrl(document.querySelector('link[rel~="next"]')?.getAttribute('href'), url) ||
    sameOriginUrl(document.querySelector('a[rel~="next"]')?.getAttribute('href'), url) ||
    [...document.querySelectorAll('a[href]')]
      .filter((a) => NEXT_TEXT.test(a.textContent))
      .map((a) => sameOriginUrl(a.getAttribute('href'), url))
      .find(Boolean) ||
    null
  );
}

// Innermost block elements only, so a blockquote of paragraphs isn't read twice.
function blocksOf(root) {
  const out = [];
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (el.querySelector(BLOCKS)) continue;
    const x = collapseWs(el.textContent);
    if (x) out.push({ t: /^h\d$/i.test(el.tagName) ? 'h' : 'p', x });
  }
  return out;
}

// One web page: its chapter (title and blocks), the book's title and authors as the page gives
// them, and the next page if there is one on the same site.
export function extractPage(html, url) {
  const { document } = parseHTML(html.replace(/\r\n?/g, '\n'));
  const next = nextLink(document, url);
  const pageTitle = collapseWs(document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title || '');
  const ccel = /(^|\.)ccel\.org$/i.test(new URL(url).hostname) ? document.querySelector('#theText') : null;
  if (ccel) {
    // CCEL titles read "Author: Work - Christian Classics Ethereal Library"; the navigation bar names the section.
    const title = collapseWs(ccel.querySelector('.book_navbar_title')?.textContent || '');
    ccel.querySelectorAll('.book_navbar, .pb, script, style').forEach((el) => el.remove());
    const work = pageTitle.replace(/\s+-\s+Christian Classics Ethereal Library$/i, '');
    const m = /^([^:]{2,80}):\s+(.+)$/.exec(work);
    return { title, bookTitle: m ? m[2] : work, authors: m ? [m[1]] : [], blocks: blocksOf(ccel), next };
  }
  const article = new Readability(document).parse();
  const root = parseHTML(`<!doctype html><html><body>${article?.content || ''}</body></html>`).document.body;
  const title = collapseWs(article?.title || pageTitle);
  const byline = collapseWs(article?.byline || '');
  return { title, bookTitle: title, authors: byline ? [byline.slice(0, 200)] : [], blocks: blocksOf(root), next };
}
