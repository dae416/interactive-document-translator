// Notes kept in a book's text, and the Korean of a book written with LaTeX, in a page (linkedom).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window, Node } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document, window, Node });
// linkedom has no Range to speak of: one that holds its ends is enough here (nothing is painted).
document.createRange = () => ({ setStart() {}, setEnd() {}, commonAncestorContainer: document.body, intersectsNode: () => false });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { translatedNodes } = await import('../public/assets/js/translation.js');
const { paintAnnotations } = await import('../public/assets/js/annotations.js');

test('the Korean of a book written with LaTeX draws formulas, bold and tables; its text is still the translation', () => {
  const text = '**결과.** 밀도 $\\rho$와 $$F=ma$$ 끝';
  const box = document.createElement('div');
  box.append(...translatedNodes(text, [], { rich: true }));
  assert.equal(box.textContent, text);
  assert.deepEqual([...box.querySelectorAll('k-tex')].map((k) => [k.textContent, k.classList.contains('d')]), [['$\\rho$', false], ['$$F=ma$$', true]]);
  assert.equal(box.querySelector('b').textContent, '**결과.**');
  const rows = '항목 | 값\n질량 | $m$';
  const table = document.createElement('div');
  table.append(...translatedNodes(rows, [], { rich: true, table: true }));
  assert.equal(table.textContent, rows);
  assert.deepEqual([...table.querySelectorAll('th, td')].map((c) => c.localName), ['th', 'th', 'td', 'td']);
  const plain = document.createElement('div');
  plain.append(...translatedNodes(text, []));
  assert.equal(plain.querySelectorAll('k-tex, b').length, 0, 'any other book: the text as it is');
});

test("a note stands after its block, or after that block's Korean, outside every block, once", () => {
  const root = document.createElement('article');
  root.innerHTML = '<section><div data-b="c1.0">One.</div><div data-k="c1.0k">하나.</div><div data-b="c1.1">Two.</div></section>';
  const note = (id, b, text) => ({ id, type: 'note', chapter: 'c1', start: { b, o: 0 }, end: { b, o: 3 }, quote: 'x', text, createdAt: '', updatedAt: '' });
  const render = (text) => {
    const el = document.createElement('div');
    el.textContent = text;
    return el;
  };
  const items = [note('a_n1', 'c1.0', '배경'), note('a_n2', 'c1.1', 'Second'), { ...note('a_n3', 'c1.1', 'gone'), deleted: true }];
  paintAnnotations(root, items, { render });
  paintAnnotations(root, items, { render });
  const order = [...root.querySelector('section').children].map((el) => el.dataset.b || el.dataset.k || el.dataset.note);
  assert.deepEqual(order, ['c1.0', 'c1.0k', 'a_n1', 'c1.1', 'a_n2']);
  assert.ok(root.querySelector('[data-note="a_n1"]').textContent.includes('배경'));
  assert.equal(root.querySelector('[data-b="c1.0"]').textContent, 'One.');
});
