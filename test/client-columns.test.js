// A journal article's two columns read as pages (columns.js): which children go into runs of text
// and which stay across the page, where a run taller than the screen is cut (in English and in
// Korean), and that a second look changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window, Node } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document, window, Node });
globalThis.navigator ??= { language: 'en' };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
// What a browser would say: an element not shown (hidden), and a run in two columns (data-cols).
globalThis.getComputedStyle = (el) => ({
  display: el.hidden ? 'none' : 'block',
  columnCount: el.dataset?.cols || 'auto',
  marginTop: '0px',
  marginBottom: '0px',
});
const { cutsOf, columnPages, wrapRuns } = await import('../public/assets/js/columns.js');

// Elements of [kind, height in one column, hidden]: p a block, k a block's Korean, note a blue note,
// fig a figure printed in a column. Each one's height comes in two fragments.
function kids(spec) {
  let n = 0;
  return spec.map(([kind, height = 0, hidden = false]) => {
    const el = document.createElement(kind === 'note' ? 'aside' : kind === 'fig' ? 'figure' : 'div');
    if (kind === 'p') el.dataset.b = `c1.${n++}`;
    if (kind === 'k') el.className = 'tr-block';
    if (kind === 'note') el.className = 'gap-note';
    if (kind === 'fig') el.className = 'book-fig narrow';
    el.hidden = hidden;
    el.getClientRects = () => (height ? [{ height: height / 2 }, { height: height / 2 }] : []);
    return el;
  });
}
const box = (els) => {
  const div = document.createElement('div');
  div.append(...els);
  return div;
};
const ids = (els) => els.map((el) => el.dataset.b);

test('what goes across the page stays a child of the section; each run of text between goes into a .col-run, a figure in a column with its caption', () => {
  const sec = document.createElement('section');
  sec.innerHTML = [
    '<h2>Journal of Examples</h2>',
    '<div data-b="c1.0" class="ltx_para r-kicker"></div>',
    '<h3 data-b="c1.1" class="r-title"></h3>',
    '<h3 data-b="c1.2" class="r-sec"></h3>',
    '<div data-b="c1.3" class="ltx_para"></div>',
    '<h3 data-b="c1.4"></h3>',
    '<figure class="book-fig narrow"></figure>',
    '<div data-b="c1.5" class="ltx_para r-cap"></div>',
    '<div data-b="c1.6" class="ltx_para"></div>',
    '<figure class="book-fig"></figure>',
    '<div data-b="c1.7" class="ltx_para r-cap"></div>',
    '<div data-b="c1.8" class="ltx_para tbl"></div>',
    '<div data-b="c1.9" class="ltx_para r-ref"></div>',
  ].join('');
  wrapRuns(sec);
  const shape = [...sec.children].map((el) => (el.matches('.col-run') ? [...el.children].map((k) => k.dataset.b || k.className) : el.dataset.b || el.localName));
  assert.deepEqual(shape, ['h2', 'c1.0', 'c1.1', 'c1.2', ['c1.3', 'c1.4', 'book-fig narrow', 'c1.5', 'c1.6'], 'figure', 'c1.7', 'c1.8', ['c1.9']]);
  wrapRuns(sec);
  assert.equal(sec.querySelectorAll('.col-run').length, 2, 'once only');
});

test('a run taller than two columns of the screen is cut before a block', () => {
  assert.deepEqual(ids(cutsOf(box(kids([['p', 300], ['p', 300], ['p', 300], ['p', 300], ['p', 300]])).children, 700)), ['c1.2', 'c1.4']);
  // A block taller than that stands alone.
  assert.deepEqual(ids(cutsOf(box(kids([['p', 2000], ['p', 100]])).children, 700)), ['c1.1']);
});

test('in Korean the cut goes before the English of a block, never between a block and its Korean or its note, nor between a figure and its caption', () => {
  const ko = box(kids([['p', 300, true], ['k', 300], ['p', 300, true], ['k', 300], ['note', 50], ['p', 300, true], ['k', 300]]));
  const cuts = cutsOf(ko.children, 700);
  assert.deepEqual(ids(cuts), ['c1.2']);
  assert.ok(cuts[0].hidden && cuts[0].nextElementSibling.matches('.tr-block'));
  const fig = box(kids([['p', 300], ['fig', 200], ['p', 300]]));
  assert.deepEqual(cutsOf(fig.children, 700), [fig.children[1]]);
  const both = box(kids([['p', 300, true], ['k', 300], ['fig', 200], ['p', 300, true], ['k', 300]]));
  assert.deepEqual(cutsOf(both.children, 700), [both.children[2]]);
  // The page that starts at the figure counts the figure (200 + 300), so the next block (250) no
  // longer fits on it.
  const carried = box(kids([['p', 300], ['fig', 200], ['p', 300], ['p', 250], ['p', 100]]));
  assert.deepEqual(cutsOf(carried.children, 700), [carried.children[1], carried.children[3]]);
});

test('the cuts go in as breaks across a run’s columns, the place read kept; a second look changes nothing, one column has none', () => {
  let seen;
  globalThis.ResizeObserver = class {
    constructor(fn) {
      seen = fn;
    }
    observe() {}
    disconnect() {}
  };
  // (a frame comes after the observer's call, as in a browser)
  let frames = [];
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  globalThis.cancelAnimationFrame = () => {};
  const resized = () => {
    seen();
    const now = frames;
    frames = [];
    now.forEach((fn) => fn());
  };
  const sec = document.createElement('section');
  const head = document.createElement('h2');
  sec.append(head, ...kids([['p', 300], ['p', 300], ['p', 300], ['p', 300], ['p', 300]]));
  let kept = 0;
  const pages = columnPages(sec, { clientHeight: 500 }, (fn) => (kept++, fn()));
  const run = sec.querySelector(':scope > .col-run');
  assert.equal(run.children.length, 5, 'the blocks in one run, the head across');
  run.dataset.cols = '2';
  resized();
  const breaks = () => [...run.children].filter((el) => el.matches('.col-break')).map((b) => b.nextElementSibling.dataset.b);
  assert.deepEqual(breaks(), ['c1.2', 'c1.4']);
  resized();
  assert.equal(kept, 1, 'nothing to change');
  run.dataset.cols = 'auto';
  resized();
  assert.deepEqual(breaks(), []);
  pages.destroy();
});
