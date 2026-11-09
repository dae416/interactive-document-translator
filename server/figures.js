// Illustrations of scanned books: the pictures tesseract finds on a page (its hOCR output) and the
// block of the book each one goes before. Pure functions; book.js crops and saves them.
import { collapseWs, decodeEntities } from './util.js';

// Elements of the hOCR that have a box: the page, pictures, lines of text and words.
const TAG = /<\w+ class=['"]([\w-]+)['"][^>]*? title=(?:'([^']*)'|"([^"]*)")[^>]*>/g;
const LINE = /^ocr_(\w*line\w*|caption|header|textfloat)$/;
const BBOX = /\bbbox (\d+) (\d+) (\d+) (\d+)/;

// ponytail: a picture is at least a fifth of the page wide and a tenth high (smaller ones are
// ornaments, initials and specks) and at most 80% of its area (more is a cover or endpaper scan;
// Ploughman's full-page plates are at most 64%).
function isPicture([x0, y0, x1, y1], [w, h]) {
  const area = (x1 - x0) * (y1 - y0);
  return x1 - x0 >= 0.2 * w && y1 - y0 >= 0.1 * h && area > 0 && area <= 0.8 * w * h;
}

// A page as the hOCR describes it: its size in pixels, the pictures on it and its lines of text,
// each with a box [left, top, right, bottom].
export function readHocr(hocr) {
  const page = { size: [0, 0], photos: [], lines: [] };
  for (const m of hocr.matchAll(TAG)) {
    const box = BBOX.exec(m[2] ?? m[3])?.slice(1).map(Number);
    if (!box) continue;
    if (m[1] === 'ocr_page') page.size = box.slice(2);
    else if (m[1] === 'ocr_photo') page.photos.push(box);
    else if (LINE.test(m[1])) page.lines.push({ box, text: '' });
    else if (m[1] === 'ocrx_word' && page.lines.length) {
      const start = m.index + m[0].length;
      const end = hocr.indexOf('</span>', start);
      if (end > 0) page.lines.at(-1).text += ` ${decodeEntities(hocr.slice(start, end).replace(/<[^>]*>/g, ''))}`;
    }
  }
  page.photos = page.photos.filter((box) => isPicture(box, page.size));
  for (const line of page.lines) line.text = collapseWs(line.text);
  return page;
}

// Words that find a line again in a block: lower-case letters and digits, 3 or more.
const wordsOf = (s) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
// Running heads and titles.
const capitals = (s) => (s.match(/\p{Lu}/gu) || []).length >= 0.7 * (s.match(/\p{L}/gu) || []).length;

// Where the picture `box` of page n goes: { chapter, before } (before = the block count for the
// chapter's end). `pages` holds readHocr's view of each page. A line of text by the picture,
// tried in this order: below it, at the top of the next page, above it, at the foot of the page
// before, is looked for among the blocks of the chapter with page n (or the nearest one). The block
// with the largest share of the line's words, half at least, has the line, and the picture goes
// before that block, or after it for a line above. Lines in capitals are passed over. With no line
// found, the picture opens its chapter on the chapter's first page and ends it on any other.
export function placeFigure(chapters, pages, n, box) {
  const gap = (c) => Math.max(c.pages[0] - n, n - c.pages[1], 0);
  const near = Math.min(...chapters.map(gap));
  const own = chapters.filter((c) => gap(c) === near);
  const blocks = own.flatMap((c) => c.blocks.map((b, i) => ({ chapter: c.id, i, words: new Set(wordsOf(b.x)) })));
  const lines = (p) => (pages[p - 1]?.lines || []).toSorted((a, b) => a.box[1] - b.box[1]);
  const mid = (l) => (l.box[1] + l.box[3]) / 2;
  // [line, 0 for a line after the picture, 1 for one before it]
  const tries = [
    ...lines(n).filter((l) => mid(l) > box[3]).map((l) => [l, 0]),
    ...lines(n + 1).slice(0, 3).map((l) => [l, 0]),
    ...lines(n).filter((l) => mid(l) < box[1]).reverse().map((l) => [l, 1]),
    ...lines(n - 1).slice(-3).reverse().map((l) => [l, 1]),
  ];
  for (const [line, after] of tries) {
    const words = wordsOf(line.text).slice(0, 8);
    if (words.length < 3 || capitals(line.text)) continue;
    let best = null;
    let score = 0.5;
    for (const b of blocks) {
      const s = words.filter((w) => b.words.has(w)).length / words.length;
      if (s > score || (s === score && !best)) [best, score] = [b, s];
    }
    if (best) return { chapter: best.chapter, before: best.i + after };
  }
  const c = own[0];
  return { chapter: c.id, before: n > c.pages[0] ? c.blocks.length : c.blocks[0]?.t === 'h' ? 1 : 0 };
}
