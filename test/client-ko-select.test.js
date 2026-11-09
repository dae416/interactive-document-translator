// Selecting in the Korean of a translated chapter: a selection keeps to the column it started in, a
// Korean one is anchored in the Korean blocks ("c1.1k") with the English they translate and gets
// the bar with "Original" in place of "Translate"; marks on the Korean round-trip, follow their
// quote when the Korean changes, and stay apart from marks on the book's own text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

// A phone (coarse pointer) for the client modules, in English, with the server's translation and
// annotation routes; the Highlight API records what is painted.
const { document, window, Node } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document, window, Node });
window.matchMedia = () => ({ matches: true });
const storage = new Map([['pr.lang', '"en"']]);
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const FILE = { chapter: 'c1', blocks: ['서문.', '게으른 손[^1]은 악마의 작업장이다.', '', '호세아 8:12[^2]을 읽어라.'], notes: ['일하지 않는 사람의 손.', '구약 성경의 한 책.'] };
globalThis.fetch = async (url) => {
  const data = url.endsWith('/translations/c1') ? { translation: FILE } : url.endsWith('/annotations') ? { items: [] } : null;
  return { ok: !!data, status: data ? 200 : 404, json: async () => data || { error: 'Not found' } };
};
const highlights = new Map();
window.CSS = globalThis.CSS = { highlights };
globalThis.Highlight = class {
  constructor(...ranges) {
    this.ranges = ranges;
  }
};
document.createRange = () => ({
  setStart(node, offset) {
    this.start = [node, offset];
  },
  setEnd(node, offset) {
    this.end = [node, offset];
  },
});
const { BookTranslations, bookSelection, translatedNodes } = await import('../public/assets/js/translation.js');
const { blockOf, comparePoints, isTranslation, overlaps, relocate } = await import('../public/assets/js/anchors.js');
const { AnnotationStore, paintAnnotations } = await import('../public/assets/js/annotations.js');
const { SelectionBar } = await import('../public/assets/js/selection.js');

const CHAPTERS = `<section class="ltx_section" id="c1" data-chapter="c1"><h2 class="ltx_title ltx_title_section">Preface</h2>
<h3 class="ltx_title ltx_title_paragraph" id="c1.0" data-b="c1.0">PREFACE.</h3>
<div class="ltx_para" id="c1.1" data-b="c1.1"><p class="ltx_p">Idle hands are the devil’s workshop.</p></div>
<div class="ltx_para" id="c1.2" data-b="c1.2"><p class="ltx_p">~ ~</p></div>
<div class="ltx_para" id="c1.3" data-b="c1.3"><p class="ltx_p">Read Hos. viii. 12.</p></div>
</section>`;

// The chapter translated, shown as BookTranslations shows it (KO+EN: each block, then its Korean).
async function open() {
  const article = document.createElement('div');
  article.className = 'html-article';
  article.innerHTML = CHAPTERS;
  document.body.replaceChildren(article);
  const paper = { id: 'book-ko', kind: 'book', book: { status: 'ready', translations: { c1: { status: 'ready' } } } };
  let shows = 0;
  const tr = new BookTranslations({ paper, view: { article, firstVisible: () => null, scrollToEl() {} }, onShow: () => shows++ });
  await new Promise((resolve) => setTimeout(resolve, 0));
  tr.destroy();
  const en = (b) => article.querySelector(`[data-b="${b}"]`);
  const ko = (b) => article.querySelector(`[data-k="${b}k"]`);
  return { article, en, ko, shows };
}

// A selection over linkedom nodes, which have no Range that compares positions: document order by
// a walk. `from` is where the selecting began (anchorNode): the start, or the end when dragged up.
function select(article, [sc, so], [ec, eo], from = sc) {
  const order = new Map();
  const walk = (n) => {
    order.set(n, order.size);
    for (const c of n.childNodes) walk(c);
  };
  walk(article);
  const last = (n) => (n.lastChild ? last(n.lastChild) : n);
  const up = (n) => (n ? [n, ...up(n.parentNode)] : []);
  const starts = new Set(up(sc));
  const range = {
    startContainer: sc,
    startOffset: so,
    endContainer: ec,
    endOffset: eo,
    commonAncestorContainer: up(ec).find((n) => starts.has(n)),
    intersectsNode: (n) => order.get(n) <= order.get(ec) && order.get(last(n)) >= order.get(sc),
  };
  return { anchorNode: from, focusNode: from === sc ? ec : sc, isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => 'x', removeAllRanges() {} };
}

// The text nodes of a block, in order.
const texts = (el) => {
  const out = [];
  const walk = (n) => (n.nodeType === 3 ? out.push(n) : n.childNodes.forEach(walk));
  walk(el);
  return out;
};

test('a selection in the Korean is anchored in it, with the English of its blocks, kept to its column', async () => {
  const { article, en, ko, shows } = await open();
  assert.equal(shows, 1, 'the reader is told when the Korean is in the page, to paint marks on it');
  // "악마의" inside the Korean of c1.1, after a note marker (its number is not text).
  assert.equal(ko('c1.1').textContent, '게으른 손은 악마의 작업장이다.');
  const [, after] = texts(ko('c1.1'));
  const one = bookSelection(select(article, [after, 2], [after, 5]), article);
  assert.deepEqual(one.anchor, {
    chapter: 'c1',
    start: { b: 'c1.1k', o: 7 },
    end: { b: 'c1.1k', o: 10 },
    text: '악마의',
    paragraph: '게으른 손은 악마의 작업장이다.',
  });
  assert.equal(one.source, 'Idle hands are the devil’s workshop.');

  // From the Korean of c1.0 down to that of c1.3 (KO: the English between is hidden but in the
  // page): the Korean blocks only (c1.2 has none), and the English from c1.0 to c1.3.
  const [hosea] = texts(ko('c1.3'));
  const down = bookSelection(select(article, [ko('c1.0').firstChild, 0], [hosea, 3]), article);
  assert.deepEqual([down.anchor.start, down.anchor.end, down.anchor.text], [{ b: 'c1.0k', o: 0 }, { b: 'c1.3k', o: 3 }, '서문.\n\n게으른 손은 악마의 작업장이다.\n\n호세아']);
  assert.equal(down.source, 'PREFACE.\n\nIdle hands are the devil’s workshop.\n\n~ ~\n\nRead Hos. viii. 12.');

  // KO+EN: begun in the Korean of c1.0 and dragged into the English of c1.1 in the other column.
  const idle = en('c1.1').querySelector('p').firstChild;
  const across = bookSelection(select(article, [ko('c1.0').firstChild, 1], [idle, 4]), article);
  assert.deepEqual([across.anchor.start, across.anchor.end, across.anchor.text, across.source], [{ b: 'c1.0k', o: 1 }, { b: 'c1.0k', o: 3 }, '문.', 'PREFACE.']);
  // Begun in the Korean of c1.3 and dragged up into the English of c1.1: still the Korean.
  const upward = bookSelection(select(article, [idle, 5], [hosea, 3], hosea), article);
  assert.deepEqual([upward.anchor.start, upward.anchor.end], [{ b: 'c1.1k', o: 0 }, { b: 'c1.3k', o: 3 }]);

  // The book's own text, as before: begun in English and dragged into the Korean beside it stops
  // at the end of its block; dragged up from English into the Korean above, the English part.
  const book = bookSelection(select(article, [idle, 5], [after, 3]), article);
  assert.deepEqual(book.anchor, { chapter: 'c1', start: { b: 'c1.1', o: 5 }, end: { b: 'c1.1', o: 36 }, text: 'hands are the devil’s workshop.', paragraph: 'Idle hands are the devil’s workshop.' });
  assert.equal(book.source, undefined);
  const hos = en('c1.3').querySelector('p').firstChild;
  assert.deepEqual(bookSelection(select(article, [hos, 5], [hos, 8]), article).anchor, { chapter: 'c1', start: { b: 'c1.3', o: 5 }, end: { b: 'c1.3', o: 8 }, text: 'Hos', paragraph: 'Read Hos. viii. 12.' });
  const up = bookSelection(select(article, [ko('c1.0').firstChild, 1], [idle, 4], idle), article);
  assert.deepEqual([up.anchor.start, up.anchor.end], [{ b: 'c1.1', o: 0 }, { b: 'c1.1', o: 4 }]);

  // Neither: the translation's notes (or its bar); a chapter title has text but no block. Begun on
  // the title, a selection keeps to the column it ends in.
  const note = article.querySelector('.tr-notes li').firstChild;
  assert.equal(bookSelection(select(article, [note, 0], [note, 4]), article), null);
  const title = article.querySelector('h2').firstChild;
  assert.deepEqual(bookSelection(select(article, [title, 0], [title, 3]), article), { anchor: null });
  const fromTitle = bookSelection(select(article, [title, 2], [after, 3]), article);
  assert.deepEqual([fromTitle.anchor.start, fromTitle.anchor.end, fromTitle.anchor.text], [{ b: 'c1.0k', o: 0 }, { b: 'c1.1k', o: 8 }, '서문.\n\n게으른 손은 악']);
  assert.equal(fromTitle.source, 'PREFACE.\n\nIdle hands are the devil’s workshop.');
});

test('the bar shows for a selection in the Korean, with Original in place of Translate, Translate on select or not', async () => {
  const { article, en, ko } = await open();
  // What the reader makes of a selection (reader.js describe), minus the view's own parts.
  const describe = (sel) => {
    const found = bookSelection(sel, article);
    if (!found?.anchor) return null;
    const isKo = isTranslation(found.anchor.start.b);
    return { text: found.anchor.text, anchor: found.anchor, inTranslation: isKo, context: isKo ? found.source : found.anchor.paragraph, marks: [], bookmark: null };
  };
  let instantOn = false;
  const calls = [];
  const bar = new SelectionBar({
    describe,
    onAction: (act, info) => calls.push(['action', act, info.context]),
    onAnnotate: (act, color, info) => calls.push(['annotate', act, color, info.anchor.start.b]),
    instant: () => instantOn,
    onInstant: (info) => calls.push(['instant', info.text]),
  });
  const shown = () => (bar.el.classList.contains('show') ? [...bar.el.querySelectorAll('.selbar-main button')].filter((b) => !b.hidden).map((b) => b.textContent) : null);
  const [, after] = texts(ko('c1.1'));
  const korean = select(article, [after, 2], [after, 5]);
  const idle = en('c1.1').querySelector('p').firstChild;
  const english = select(article, [idle, 0], [idle, 4]);
  try {
    document.getSelection = () => korean;
    bar.update();
    assert.deepEqual(shown(), ['Original', 'Explain', 'Ask', 'Copy']);
    assert.ok(bar.el.querySelector('.ann-tools .swatch.yellow'), 'highlight, underline and bookmark too');
    bar.el.querySelector('.swatch.pink').click();
    assert.deepEqual(calls.pop(), ['annotate', 'highlight', 'pink', 'c1.1k']);
    bar.update();
    bar.el.querySelector('[data-act="source"]').click();
    assert.deepEqual(calls.pop(), ['action', 'source', 'Idle hands are the devil’s workshop.']);

    document.getSelection = () => english;
    bar.update();
    assert.deepEqual(shown(), ['Translate', 'Explain', 'Ask', 'Copy'], 'English as before');

    // Translate on select: the English goes to its popup, the Korean still gets the bar.
    instantOn = true;
    bar.hide();
    bar.update();
    assert.deepEqual([shown(), calls.pop()], [null, ['instant', 'Idle']]);
    document.getSelection = () => korean;
    bar.update();
    assert.deepEqual(shown(), ['Original', 'Explain', 'Ask', 'Copy']);
    assert.equal(calls.length, 0);
  } finally {
    bar.destroy();
    delete document.getSelection;
  }
});

test('a mark on the Korean round-trips: saved with its anchor, painted in the Korean, apart from marks on the book', async () => {
  storage.delete('ann:book-ko');
  const { article, en, ko } = await open();
  const [, after] = texts(ko('c1.1'));
  const { anchor } = bookSelection(select(article, [after, 2], [after, 5]), article);
  const store = new AnnotationStore('book-ko');
  const mark = store.add({ type: 'highlight', color: 'pink', chapter: anchor.chapter, start: anchor.start, end: anchor.end, quote: anchor.text });
  const bm = store.add({ type: 'bookmark', chapter: 'c1', start: { b: 'c1.3k', o: 0 }, end: { b: 'c1.3k', o: 0 }, quote: ko('c1.3').textContent });
  const book = store.add({ type: 'underline', chapter: 'c1', start: { b: 'c1.1', o: 0 }, end: { b: 'c1.1', o: 4 }, quote: 'Idle' });
  clearTimeout(store.timer);
  // In this browser as it was made, for the next visit.
  const again = new AnnotationStore('book-ko');
  assert.deepEqual(again.items.find((a) => a.id === mark.id), mark);
  assert.deepEqual(again.items.find((a) => a.id === mark.id).start, { b: 'c1.1k', o: 7 });

  paintAnnotations(article, again.items);
  const painted = (name) => highlights.get(name).ranges.map((r) => [blockOf(r.start[0], 'data-k') ? blockOf(r.start[0], 'data-k').getAttribute('data-k') : blockOf(r.start[0]).getAttribute('data-b'), r.start[0].nodeValue.slice(r.start[1], r.end[1])]);
  assert.deepEqual(painted('ann-pink'), [['c1.1k', '악마의']]);
  assert.deepEqual(painted('ann-underline'), [['c1.1', 'Idle']]);
  assert.ok(ko('c1.3').classList.contains('ann-bookmark') && !en('c1.3').classList.contains('ann-bookmark'));
  assert.equal(again.bookmarkAt('c1.3k').id, bm.id);
  assert.equal(again.bookmarkAt('c1.3'), null);

  // "Remove" under a selection sees only marks on the same text.
  const span = (b, o1, o2) => ({ start: { b, o: o1 }, end: { b, o: o2 } });
  assert.deepEqual(again.marksIn(span('c1.1k', 0, 8)), [mark.id]);
  assert.deepEqual(again.marksIn(span('c1.1', 0, 30)), [book.id]);
  assert.equal(overlaps(span('c1.0k', 0, 1), { start: { b: 'c1.0', o: 0 }, end: { b: 'c1.3', o: 2 } }), false);
  // Listed in book order, a block's English before its Korean.
  assert.deepEqual(again.live.map((a) => a.id), [book.id, mark.id, bm.id]);
  assert.ok(comparePoints({ b: 'c1.1', o: 40 }, { b: 'c1.1k', o: 0 }) < 0);
  assert.ok(comparePoints({ b: 'c1.1k', o: 40 }, { b: 'c1.2', o: 0 }) < 0);
  storage.delete('ann:book-ko');
});

test('after a new translation a mark on the Korean follows its quote, or stays listed unpainted', async () => {
  const { article, ko } = await open();
  const blocks = () => new Map([...article.querySelectorAll('[data-b], [data-k]')].map((el) => [el.getAttribute('data-b') ?? el.getAttribute('data-k'), el]));
  const mark = { id: 'a_komark01', type: 'highlight', color: 'green', chapter: 'c1', start: { b: 'c1.1k', o: 7 }, end: { b: 'c1.1k', o: 10 }, quote: '악마의', deleted: false };
  assert.equal(relocate(mark, blocks()), mark, 'the text there still reads the same');
  // Translated again: words before it, and the notes renumbered (their numbers are not text).
  ko('c1.1').replaceChildren(...translatedNodes('그러니 게으른 손[^2]은 악마의 작업장이다.', ['가', '나']));
  assert.deepEqual(relocate(mark, blocks()), { ...mark, start: { b: 'c1.1k', o: 11 }, end: { b: 'c1.1k', o: 14 } });
  paintAnnotations(article, [mark]);
  const [range] = highlights.get('ann-green').ranges;
  assert.equal(range.start[0].nodeValue.slice(range.start[1], range.end[1]), '악마의');
  // The words twice: the copy nearest to where the mark was, not the first.
  ko('c1.1').replaceChildren(...translatedNodes('악마의 말. 손은 악마의 작업장이다.', []));
  assert.deepEqual([relocate(mark, blocks()).start, relocate(mark, blocks()).end], [{ b: 'c1.1k', o: 10 }, { b: 'c1.1k', o: 13 }]);
  // Gone from the new Korean: not painted (the list still has it, the store never drops it).
  ko('c1.1').replaceChildren(...translatedNodes('게으른 손은 마귀의 일터다.', []));
  assert.equal(relocate(mark, blocks()), null);
  paintAnnotations(article, [mark]);
  assert.equal(highlights.get('ann-green').ranges.length, 0);
  // Over several blocks: checked, not searched for; a quote cut at 2000 characters still holds.
  const wide = { ...mark, start: { b: 'c1.0k', o: 0 }, end: { b: 'c1.3k', o: 3 }, quote: '서문.\n\n게으른 손은 악마의 작업장이다.\n\n호세아' };
  assert.equal(relocate(wide, blocks()), null);
  ko('c1.1').replaceChildren('가'.repeat(2500));
  const long = { ...mark, start: { b: 'c1.1k', o: 0 }, end: { b: 'c1.1k', o: 2500 }, quote: '가'.repeat(2000) };
  assert.equal(relocate(long, blocks()), long);
  // No Korean on the page (not loaded, or EN never loaded it): nothing to paint.
  ko('c1.1').remove();
  assert.equal(relocate(mark, blocks()), null);
});

test("a selection's bar on a phone keeps clear of Chrome's search bar at the foot of the screen", () => {
  const bar = new SelectionBar({ describe: () => null, onAction: () => {}, onAnnotate: () => {} });
  Object.defineProperty(bar.el, 'offsetHeight', { value: 110 });
  const place = () => ['top', 'lift'].filter((c) => bar.el.classList.contains(c));
  bar.info = { text: 'words', rect: { top: 400 } };
  bar.show();
  assert.deepEqual(place(), ['top']);
  bar.info.rect = { top: 60 };
  bar.show();
  assert.deepEqual(place(), ['lift'], 'not over the selection itself');
  bar.showFor({ text: 'words', rect: { top: 400 } });
  assert.deepEqual(place(), [], 'a tapped clause selects nothing, so no search bar comes');
  bar.more.click();
  assert.deepEqual(place(), [], 'not when its bar is opened either');
  bar.destroy();
});
