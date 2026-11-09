// Annotation anchors in the book view: offsets into block text, clamping, and book order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFromBlocks, chapterOf, comparePoints, locate, offsetIn, overlaps } from '../public/assets/js/anchors.js';

// Just enough DOM for anchors.js: node types, parents, siblings, attributes and textContent.
class FakeNode {
  constructor(nodeType, nodeValue = null) {
    this.nodeType = nodeType;
    this.nodeValue = nodeValue;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get nextSibling() {
    const list = this.parentNode?.childNodes || [];
    return list[list.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    const list = this.parentNode?.childNodes || [];
    return list[list.indexOf(this) - 1] || null;
  }
  get textContent() {
    if (this.nodeType !== 1) return this.nodeValue;
    return this.childNodes.map((c) => (c.nodeType === 8 ? '' : c.textContent)).join('');
  }
  hasAttribute(name) {
    return name in this.attrs;
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
}

function el(attrs, ...children) {
  const node = new FakeNode(1);
  node.attrs = attrs;
  for (const c of children) {
    const child = typeof c === 'string' ? new FakeNode(3, c) : c;
    child.parentNode = node;
    node.childNodes.push(child);
  }
  return node;
}

// <section c1>
//   <h2>To the Idle</h2> <h3 c1.0>TO THE IDLE.</h3> <div c1.1><p>Hello <em>wide</em> world</p></div>
//   <div c1.2><p>Second para.</p></div>
// </section>
// <section c2> <div c2.0><p>Next chapter.</p></div> </section>
function book() {
  const em = el({}, 'wide');
  const p = el({}, 'Hello ', em, new FakeNode(8, 'a comment'), ' world');
  const b0 = el({ 'data-b': 'c1.0' }, 'TO THE IDLE.');
  const b1 = el({ 'data-b': 'c1.1' }, p);
  const b2 = el({ 'data-b': 'c1.2' }, el({}, 'Second para.'));
  const c2 = el({ 'data-b': 'c2.0' }, el({}, 'Next chapter.'));
  const h2 = el({}, 'To the Idle');
  const s1 = el({ 'data-chapter': 'c1' }, '\n  ', h2, '\n  ', b0, '\n  ', b1, '\n  ', b2, '\n');
  const s2 = el({ 'data-chapter': 'c2' }, '\n  ', c2, '\n');
  el({}, s1, s2);
  return { p, em, b0, b1, b2, c2, h2, s1, hello: p.childNodes[0], world: p.childNodes[3] };
}

const range = (startContainer, startOffset, endContainer, endOffset) => ({ startContainer, startOffset, endContainer, endOffset });

test('offsets count the text before a boundary, through inline markup and past comments', () => {
  const d = book();
  assert.equal(d.b1.textContent, 'Hello wide world');
  assert.equal(offsetIn(d.b1, d.em.firstChild, 2), 8);
  assert.equal(offsetIn(d.b1, d.world, 3), 13);
  // Boundaries between element children (what a triple-click or select-all gives).
  assert.equal(offsetIn(d.b1, d.p, 0), 0);
  assert.equal(offsetIn(d.b1, d.p, 2), 10);
  assert.equal(offsetIn(d.b1, d.p, 3), 10);
  assert.equal(offsetIn(d.b1, d.b1, 1), 16);
});

test('locating an offset finds the text node, clamped to the block', () => {
  const d = book();
  assert.deepEqual(locate(d.b1, 8), { node: d.em.firstChild, offset: 2 });
  assert.deepEqual(locate(d.b1, 13), { node: d.world, offset: 3 });
  assert.deepEqual(locate(d.b1, 999), { node: d.world, offset: 6 });
  assert.deepEqual(locate(d.b1, -4), { node: d.hello, offset: 0 });
  const empty = el({ 'data-b': 'c9.0' });
  assert.deepEqual(locate(empty, 3), { node: empty, offset: 0 });
  for (let o = 0; o <= 16; o++) {
    const { node, offset } = locate(d.b1, o);
    assert.equal(offsetIn(d.b1, node, offset), o, `offset ${o}`);
  }
});

test('a selection inside one block', () => {
  const d = book();
  assert.deepEqual(anchorFromBlocks([d.b1], range(d.hello, 2, d.world, 3)), {
    chapter: 'c1',
    start: { b: 'c1.1', o: 2 },
    end: { b: 'c1.1', o: 13 },
    text: 'llo wide wo',
    paragraph: 'Hello wide world',
  });
});

test('a triple-click that ends at the start of the next block stays in its own block', () => {
  const d = book();
  const a = anchorFromBlocks([d.b1, d.b2], range(d.hello, 0, d.b2, 0));
  assert.deepEqual([a.start, a.end, a.text], [{ b: 'c1.1', o: 0 }, { b: 'c1.1', o: 16 }, 'Hello wide world']);
});

test('a start at the very end of a block moves to the next block', () => {
  const d = book();
  const a = anchorFromBlocks([d.b1, d.b2], range(d.world, 6, d.b2.firstChild.firstChild, 6));
  assert.deepEqual([a.start, a.end, a.text], [{ b: 'c1.2', o: 0 }, { b: 'c1.2', o: 6 }, 'Second']);
});

test('endpoints outside any block clamp to the nearest block edge', () => {
  const d = book();
  // From inside the chapter title (no data-b) into the first paragraph.
  const a = anchorFromBlocks([d.b0, d.b1], range(d.h2.firstChild, 3, d.world, 6));
  assert.deepEqual([a.start, a.end], [{ b: 'c1.0', o: 0 }, { b: 'c1.1', o: 16 }]);
  assert.equal(a.text, 'TO THE IDLE.\n\nHello wide world');
  assert.equal(a.paragraph, 'TO THE IDLE.');
  // Ending between blocks, on the section itself or in the whitespace after the last block.
  const s1 = d.s1;
  const b = anchorFromBlocks([d.b1, d.b2], range(d.hello, 6, s1, s1.childNodes.indexOf(d.b2) + 1));
  assert.deepEqual([b.start, b.end], [{ b: 'c1.1', o: 6 }, { b: 'c1.2', o: 12 }]);
  const c = anchorFromBlocks([d.b1, d.b2], range(d.hello, 6, s1.childNodes.at(-1), 1));
  assert.deepEqual(c.end, { b: 'c1.2', o: 12 });
});

test('a selection running into the next chapter stops at the end of its own', () => {
  const d = book();
  const a = anchorFromBlocks([d.b2, d.c2], range(d.b2.firstChild.firstChild, 7, d.c2.firstChild.firstChild, 4));
  assert.deepEqual([a.chapter, a.start, a.end, a.text], ['c1', { b: 'c1.2', o: 7 }, { b: 'c1.2', o: 12 }, 'para.']);
});

test('nothing to anchor: no blocks, or an empty selection', () => {
  const d = book();
  assert.equal(anchorFromBlocks([], range(d.h2.firstChild, 0, d.h2.firstChild, 3)), null);
  assert.equal(anchorFromBlocks([d.b1], range(d.world, 2, d.world, 2)), null);
});

test('book order compares chapter and block numbers, then offsets', () => {
  assert.ok(comparePoints({ b: 'c2.10', o: 0 }, { b: 'c2.9', o: 50 }) > 0);
  assert.ok(comparePoints({ b: 'c10.0', o: 0 }, { b: 'c9.40', o: 0 }) > 0);
  assert.ok(comparePoints({ b: 'c3.1', o: 4 }, { b: 'c3.1', o: 9 }) < 0);
  assert.equal(comparePoints({ b: 'c3.1', o: 4 }, { b: 'c3.1', o: 4 }), 0);
  const span = (b1, o1, b2, o2) => ({ start: { b: b1, o: o1 }, end: { b: b2, o: o2 } });
  assert.equal(overlaps(span('c1.1', 2, 'c1.1', 5), span('c1.1', 5, 'c1.1', 9)), false, 'touching is not overlapping');
  assert.equal(overlaps(span('c1.1', 2, 'c1.2', 3), span('c1.1', 10, 'c1.1', 12)), true);
  assert.equal(overlaps(span('c1.1', 2, 'c1.1', 6), span('c1.2', 0, 'c1.2', 4)), false);
  assert.equal(chapterOf('c12.3'), 'c12');
});
