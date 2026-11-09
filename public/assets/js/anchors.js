// Annotation anchors in a book: a DOM Range <-> { chapter, start, end }. Points are { b, o }:
// a block's data-b id ("c3.12") and an offset into that block's textContent. A point in a block's
// translation (translation.js, data-k) has the block's id with a "k": "c3.12k".

const BLOCK_ID = /^c(\d+)\.(\d+)(k?)$/;

export const chapterOf = (blockId) => blockId.slice(0, blockId.lastIndexOf('.'));

export const isTranslation = (blockId) => /^c\d+\.\d+k$/.test(blockId);

// The block (element with `attr`: data-b, or data-k for the translation) that holds `node`, if any.
export function blockOf(node, attr = 'data-b') {
  for (let n = node; n; n = n.parentNode) if (n.nodeType === 1 && n.hasAttribute(attr)) return n;
  return null;
}

const textLength = (node) => (node.nodeType === 3 ? node.nodeValue.length : node.nodeType === 1 ? node.textContent.length : 0);

// Offset into block.textContent of the boundary point (container, offset) inside the block.
export function offsetIn(block, container, offset) {
  let o = 0;
  if (container.nodeType === 3) o = offset;
  else for (let i = 0; i < offset; i++) o += textLength(container.childNodes[i]);
  for (let n = container; n !== block; n = n.parentNode) {
    for (let s = n.previousSibling; s; s = s.previousSibling) o += textLength(s);
  }
  return o;
}

function* textNodes(node) {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) yield c;
    else if (c.nodeType === 1) yield* textNodes(c);
  }
}

// The text node and offset for character `o` of a block, clamped to the block's text.
export function locate(block, o) {
  let last = null;
  let rest = Math.max(0, o);
  for (const node of textNodes(block)) {
    if (rest <= node.nodeValue.length) return { node, offset: rest };
    rest -= node.nodeValue.length;
    last = node;
  }
  return last ? { node: last, offset: last.nodeValue.length } : { node: block, offset: 0 };
}

// The text from offset `so` of the first of `list` to `eo` of the last, one paragraph per block.
const spanText = (list, so, eo) =>
  list
    .map((el, i) => el.textContent.slice(i ? 0 : so, i === list.length - 1 ? eo : undefined).trim())
    .filter(Boolean)
    .join('\n\n');

// The anchor of `range`, given the blocks it intersects in document order. An endpoint outside
// every block (between blocks, in a chapter title, in the other column side by side) moves to the
// nearest block edge; a block the range only touches at an edge (a triple-click ends at offset 0
// of the next one) is dropped; a range running into the next chapter stops at the end of its own.
export function anchorFromBlocks(blocks, range, attr = 'data-b') {
  let first = 0;
  let last = blocks.length - 1;
  if (last < 0) return null;
  let so = blockOf(range.startContainer, attr) === blocks[first] ? offsetIn(blocks[first], range.startContainer, range.startOffset) : 0;
  let eo = blockOf(range.endContainer, attr) === blocks[last] ? offsetIn(blocks[last], range.endContainer, range.endOffset) : textLength(blocks[last]);
  if (first < last && so >= textLength(blocks[first])) {
    first += 1;
    so = 0;
  }
  if (first < last && eo === 0) {
    last -= 1;
    eo = textLength(blocks[last]);
  }
  const chapter = chapterOf(blocks[first].getAttribute(attr));
  for (let i = first + 1; i <= last; i++) {
    if (chapterOf(blocks[i].getAttribute(attr)) !== chapter) {
      last = i - 1;
      eo = textLength(blocks[last]);
      break;
    }
  }
  if (first === last && so >= eo) return null;
  return {
    chapter,
    start: { b: blocks[first].getAttribute(attr), o: so },
    end: { b: blocks[last].getAttribute(attr), o: eo },
    text: spanText(blocks.slice(first, last + 1), so, eo),
    paragraph: blocks[first].textContent,
  };
}

// Only blocks with `attr` count: the book's own (data-b), or the translation beside them (data-k).
export function rangeToAnchor(range, root, attr = 'data-b') {
  const ca = range.commonAncestorContainer;
  if (!root.contains(ca)) return null;
  const one = blockOf(ca, attr);
  const scope = one ? [one] : [...(ca.nodeType === 1 ? ca : ca.parentNode).querySelectorAll(`[${attr}]`)].filter((b) => range.intersectsNode(b));
  return anchorFromBlocks(scope, range, attr);
}

// The blocks of `anchor` in order. `blocks` maps ids to their elements; a block without its translation
// (an empty translation) is skipped.
function spanBlocks(anchor, blocks) {
  if (!blocks.get(anchor.start.b) || !blocks.get(anchor.end.b)) return [];
  const chapter = chapterOf(anchor.start.b);
  const k = isTranslation(anchor.start.b) ? 'k' : '';
  const index = (b) => parseInt(b.slice(b.lastIndexOf('.') + 1), 10);
  const first = index(anchor.start.b);
  const last = chapterOf(anchor.end.b) === chapter ? index(anchor.end.b) : first;
  const out = [];
  for (let i = first; i <= last; i++) {
    const block = blocks.get(`${chapter}.${i}${k}`);
    if (block) out.push(block);
  }
  return out;
}

// One range per block, so whatever sits between two blocks (a translation, side by side) is never
// painted with them.
export function anchorToRanges(anchor, blocks) {
  const list = spanBlocks(anchor, blocks);
  return list.map((block, i) => {
    const s = locate(block, i ? 0 : anchor.start.o);
    const e = locate(block, i === list.length - 1 ? anchor.end.o : Infinity);
    const range = document.createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  });
}

// Where a mark on the translation is now: translating a chapter again can change the text under it. Its
// offsets while they still hold its quote (the first 2000 characters of what was marked), else the
// copy of the quote in its block nearest to where it was, else null: listed, not painted.
// ponytail: a quote over several blocks is not searched for, and the store keeps the old offsets,
// which "remove" goes by: a selection there offers to remove the mark painted where it moved.
export function relocate(anchor, blocks) {
  const list = spanBlocks(anchor, blocks);
  if (!list.length) return null;
  const quote = anchor.quote || '';
  if (spanText(list, anchor.start.o, anchor.end.o).startsWith(quote)) return anchor;
  const text = list[0].textContent;
  let o = -1;
  for (let i = quote.includes('\n\n') ? -1 : text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
    if (o < 0 || Math.abs(i - anchor.start.o) < Math.abs(o - anchor.start.o)) o = i;
  }
  return o < 0 ? null : { ...anchor, start: { b: anchor.start.b, o }, end: { b: anchor.start.b, o: o + quote.length } };
}

// Book order, from the ids: chapter number, block index, the book before its translation, then offset.
export function comparePoints(p, q) {
  const a = BLOCK_ID.exec(p.b) || [0, 0, 0, ''];
  const b = BLOCK_ID.exec(q.b) || [0, 0, 0, ''];
  return a[1] - b[1] || a[2] - b[2] || a[3].length - b[3].length || p.o - q.o;
}

// Whether two anchors share at least one character (of the same text: the book's or the translation).
export function overlaps(x, y) {
  return isTranslation(x.start.b) === isTranslation(y.start.b) && comparePoints(x.start, y.end) < 0 && comparePoints(y.start, x.end) < 0;
}
