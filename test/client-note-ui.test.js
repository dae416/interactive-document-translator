// Notes in a book's text: drawn once and kept while unchanged, in the order they were made; the
// dialog they are written in; and the passage a selection that ends inside a formula is made on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { parseHTML } from 'linkedom';

// htmlview.js imports DOMPurify from the server's /vendor/ path: here it comes from node_modules.
const hooks = typeof module.register === 'function';
const vendor = new URL('../node_modules/dompurify/dist/', import.meta.url).href;
const resolve = `export const resolve = (s, c, next) => next(s.startsWith('/vendor/dompurify/') ? ${JSON.stringify(vendor)} + s.slice(18) : s, c);`;
if (hooks) module.register(`data:text/javascript,${encodeURIComponent(resolve)}`);
const skip = !hooks && 'module.register needs Node 20.6 or later';

const { document, window, Node, Event } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document, window, Node });
const storage = new Map([['pr.lang', '"en"']]);
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
// linkedom has no Range to speak of: one that holds its ends is enough to paint (nothing shows).
document.createRange = () => ({ setStart() {}, setEnd() {} });
const { paintAnnotations } = await import('../public/assets/js/annotations.js');
const { textDialog } = await import('../public/assets/js/ui.js');
const { bookSelection } = await import('../public/assets/js/translation.js');
const { wholeFormulas } = hooks ? await import('../public/assets/js/htmlview.js') : {};

test('a note keeps its element while it is unchanged, stands after the notes made on its block before it, and goes when deleted', () => {
  const root = document.createElement('article');
  root.innerHTML = '<section><div data-b="c1.0">One.</div><div data-b="c1.1">Two.</div></section>';
  const note = (id, b, at, text) => ({ id, type: 'note', chapter: 'c1', start: { b, o: 0 }, end: { b, o: 3 }, quote: 'x', text, createdAt: at, updatedAt: at, deleted: false });
  let drawn = 0;
  const render = (text) => {
    drawn++;
    const el = document.createElement('div');
    el.textContent = text;
    return el;
  };
  const order = () => [...root.querySelector('section').children].map((el) => el.dataset.b || el.dataset.note);
  const later = note('a_later00001', 'c1.0', '2026-11-02T10:00:00.000Z', 'Later');
  const other = note('a_other00001', 'c1.1', '2026-11-02T08:00:00.000Z', 'Other');
  paintAnnotations(root, [later, other], { render });
  const kept = root.querySelector('[data-note="a_later00001"]');
  // One made earlier on the same block comes from another device, after it in the list.
  const earlier = note('a_early00001', 'c1.0', '2026-11-02T09:00:00.000Z', 'Earlier');
  paintAnnotations(root, [later, other, earlier], { render });
  assert.deepEqual(order(), ['c1.0', 'a_early00001', 'a_later00001', 'c1.1', 'a_other00001']);
  assert.equal(drawn, 3, 'only the new one is drawn');
  // A sync that changed nothing, in another order: nothing drawn again, nothing moved.
  paintAnnotations(root, [earlier, other, later], { render });
  assert.equal(drawn, 3);
  assert.equal(root.querySelector('[data-note="a_later00001"]'), kept);
  // An edit draws that one again; a delete takes it away.
  const edited = { ...earlier, text: 'Earlier, edited', updatedAt: '2026-11-02T11:00:00.000Z' };
  paintAnnotations(root, [later, other, edited], { render });
  assert.equal(drawn, 4);
  assert.equal(root.querySelector('[data-note="a_early00001"]').textContent, 'Earlier, edited');
  assert.deepEqual(order(), ['c1.0', 'a_early00001', 'a_later00001', 'c1.1', 'a_other00001']);
  paintAnnotations(root, [later, other, { ...edited, deleted: true }], { render });
  assert.deepEqual(order(), ['c1.0', 'a_later00001', 'c1.1', 'a_other00001']);
  assert.equal(root.querySelector('[data-note="a_later00001"]'), kept, 'never drawn again');
});

test('the note dialog: Escape cancels, a tap beside it cancels only while the text is unchanged, and text over the limit stays with a message', async () => {
  const open = (opts = {}) => {
    const result = textDialog({ title: 'Note', text: 'Hello', ...opts });
    const box = document.querySelector('.dialog');
    return { result, box, area: box.querySelector('textarea'), scrim: document.querySelector('.scrim'), save: box.querySelectorAll('button')[1] };
  };
  let d = open();
  d.scrim.click();
  assert.equal(await d.result, null);
  assert.equal(document.querySelector('.dialog, .scrim'), null);

  d = open();
  d.area.value = 'Hello, world';
  d.scrim.click();
  assert.ok(d.box.isConnected, 'typed changes are not thrown away by a tap beside it');
  const esc = Object.assign(new Event('keydown', { bubbles: true }), { key: 'Escape' });
  d.area.dispatchEvent(esc);
  assert.equal(await d.result, null);
  assert.equal(esc.cancelBubble, true, "it goes no further (the reader's Escape would close the panel)");

  d = open({ max: 10 });
  assert.equal(d.area.getAttribute('maxlength'), '10');
  d.area.value = 'x'.repeat(11);
  d.save.click();
  assert.ok(d.box.isConnected);
  assert.equal(document.querySelector('.toast').textContent, 'Too long: 11 characters, 10 at most.');
  d.area.value = '  short  ';
  d.save.click();
  assert.equal(await d.result, 'short');
});

// Just enough of a Range: its ends, a copy, and an end moved past a node.
class FakeRange {
  constructor(sc, so, ec, eo) {
    Object.assign(this, { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo });
  }
  cloneRange() {
    return new FakeRange(this.startContainer, this.startOffset, this.endContainer, this.endOffset);
  }
  setStartBefore(node) {
    [this.startContainer, this.startOffset] = [node.parentNode, [...node.parentNode.childNodes].indexOf(node)];
  }
  setEndAfter(node) {
    [this.endContainer, this.endOffset] = [node.parentNode, [...node.parentNode.childNodes].indexOf(node) + 1];
  }
  get commonAncestorContainer() {
    const up = (n) => (n ? [n, ...up(n.parentNode)] : []);
    const starts = new Set(up(this.startContainer));
    return up(this.endContainer).find((n) => starts.has(n));
  }
}

test('a selection that starts or ends inside a formula is anchored with the whole formula, in the book and in its Korean', { skip }, () => {
  const article = document.createElement('div');
  article.innerHTML =
    '<section data-chapter="c1"><div data-b="c1.0"><p>Mass <k-tex>$m$</k-tex> and force <k-tex>$F=ma$</k-tex> here.</p></div>' +
    '<div class="tr-block" lang="ko" data-k="c1.0k">질량 <k-tex>$m$</k-tex>과 힘</div></section>';
  const [m, f, km] = [...article.querySelectorAll('k-tex')].map((k) => k.firstChild);
  const [mass, and] = [...article.querySelector('p').childNodes].filter((n) => n.nodeType === 3);
  // As reader.js describe() hands it over: the selection's own ends, the range widened.
  const anchor = (sc, so, ec, eo, widen = true) => {
    const range = new FakeRange(sc, so, ec, eo);
    return bookSelection({ anchorNode: sc, focusNode: ec, getRangeAt: () => (widen ? wholeFormulas(range) : range) }, article).anchor;
  };
  // From "Mass" to "$F=" inside the second formula: half its LaTeX, unless widened.
  assert.equal(anchor(mass, 0, f, 3, false).text, 'Mass $m$ and force $F=');
  const a = anchor(mass, 0, f, 3);
  assert.deepEqual([a.start, a.end, a.text], [{ b: 'c1.0', o: 0 }, { b: 'c1.0', o: 25 }, 'Mass $m$ and force $F=ma$']);
  // Begun inside the first formula: from its start.
  const b = anchor(m, 1, and, 4);
  assert.deepEqual([b.start, b.end, b.text], [{ b: 'c1.0', o: 5 }, { b: 'c1.0', o: 12 }, '$m$ and']);
  // In the Korean beside it, the same.
  const k = anchor(article.querySelector('[data-k]').firstChild, 0, km, 2);
  assert.deepEqual([k.start, k.end, k.text], [{ b: 'c1.0k', o: 0 }, { b: 'c1.0k', o: 6 }, '질량 $m$']);
});
