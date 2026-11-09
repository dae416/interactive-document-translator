// Highlights, underlines, bookmarks and notes in a book. The list lives in localStorage and on the
// server; each side merges the other's copy, so deletes are kept as tombstones. A note is what was
// missing to read on (background, a step of the argument), asked of the model and kept: it stands
// in blue after the passage it was made on.
import { api } from './api.js';
import { anchorToRanges, comparePoints, isTranslation, overlaps, relocate } from './anchors.js';
import { langs } from './langs.js';
import { tagFormulas } from './tex.js';
import { h, iconButton, uid } from './ui.js';
import { t } from './i18n.js';

export const COLORS = ['yellow', 'green', 'blue', 'pink'];
const PAINTS = [...COLORS.map((c) => `ann-${c}`), 'ann-underline', 'ann-note'];
// A mark on one language is made on the other too, under its id with "p" and a number, so two
// browsers pairing the same mark make the same item. (The app's own ids have 14 characters after
// "a_": none of them looks like a partner's.)
const PARTNER = /^(a_[a-z0-9]{14,})p\d+$/;
export const partnerOf = (id) => PARTNER.exec(id)?.[1] || null;
const SAVE_DELAY = 500;
// The longest note the server keeps (server/annotations.js); a longer one would stay in this
// browser only.
export const MAX_NOTE = 20000;

// Union by id; where both sides have an item, the later updatedAt wins (a tie keeps `mine`).
export function mergeAnnotations(mine = [], theirs = []) {
  const out = new Map(mine.map((a) => [a.id, a]));
  for (const b of theirs) {
    const a = out.get(b.id);
    if (!a || Date.parse(b.updatedAt) > Date.parse(a.updatedAt)) out.set(b.id, b);
  }
  return [...out.values()];
}

const storageKey = (paperId) => `ann:${paperId}`;

export function forgetAnnotations(paperId) {
  try {
    localStorage.removeItem(storageKey(paperId));
  } catch {
    // storage unavailable
  }
}

function readLocal(key) {
  try {
    const items = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(items) ? items.filter((a) => /^a_[a-z0-9]{6,32}$/.test(a?.id || '')) : [];
  } catch {
    return [];
  }
}

// A book's list as this browser keeps it (made here and not yet on the server, perhaps).
export const localAnnotations = (paperId) => readLocal(storageKey(paperId));

// A mark and those paired with it gone, from outside its book (the home page's bookmarks). What
// the server hasn't taken yet stays in this browser, to go at the next open; the failure is thrown.
export async function removeAnnotation(paperId, id) {
  let failure = null;
  const store = new AnnotationStore(paperId, {
    onError: (err) => {
      failure = err;
    },
  });
  await store.sync();
  const ids = store.withPartners([id]);
  if (ids.length) failure = null; // the list was to hand: only the last save counts now
  store.remove(ids);
  await store.push();
  if (failure) throw failure;
}

export class AnnotationStore {
  // onChange(): the list changed (here or from the server). onError(err): a sync failed; the
  // list stays in this browser and is sent again on the next change, on `online`, or on open.
  constructor(paperId, { onChange, onError } = {}) {
    Object.assign(this, { paperId, onChange, onError });
    this.key = storageKey(paperId);
    this.items = readLocal(this.key);
    this.timer = 0;
  }

  get live() {
    return this.items.filter((a) => !a.deleted).sort((a, b) => comparePoints(a.start, b.start));
  }

  // Highlights and underlines sharing text with `anchor`.
  marksIn(anchor) {
    return this.items.filter((a) => !a.deleted && (a.type === 'highlight' || a.type === 'underline') && overlaps(a, anchor)).map((a) => a.id);
  }

  // Changes the fields of one item (a note's text).
  update(id, fields) {
    const at = new Date().toISOString();
    this.change(this.items.map((a) => (a.id === id ? { ...a, ...fields, updatedAt: at } : a)));
  }

  bookmarkAt(blockId) {
    return this.items.find((a) => !a.deleted && a.type === 'bookmark' && a.start.b === blockId) || null;
  }

  // Each: type, color, chapter, start, end, quote, a note's text (and, for a mark paired with
  // another, its id and times). All in one change; returns the first.
  add(...list) {
    const at = new Date().toISOString();
    const items = list.map((fields) => ({ id: uid('a'), color: null, createdAt: at, updatedAt: at, ...fields, quote: String(fields.quote || '').slice(0, 2000), deleted: false }));
    this.change([...this.items, ...items]);
    return items[0];
  }

  // The mark a paired one was made with (removed or not), else its own id.
  groupOf(id) {
    const base = partnerOf(id);
    return base && this.items.some((a) => a.id === base) ? base : id;
  }

  // `ids` and the marks paired with them.
  withPartners(ids) {
    const groups = new Set(ids.map((id) => this.groupOf(id)));
    return this.items.filter((a) => groups.has(this.groupOf(a.id))).map((a) => a.id);
  }

  remove(ids) {
    const at = new Date().toISOString();
    this.change(this.items.map((a) => (ids.includes(a.id) && !a.deleted ? { ...a, deleted: true, updatedAt: at } : a)));
  }

  change(items) {
    this.set(items);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), SAVE_DELAY);
  }

  set(items) {
    // Another tab of the same book may have written since this one read: keep its changes. A mark
    // removed elsewhere takes its partners with it here too (made here, maybe, before that came).
    const merged = mergeAnnotations(items, readLocal(this.key));
    const gone = new Set(merged.flatMap((a) => (a.deleted ? [a.id] : [])));
    const at = new Date().toISOString();
    this.items = merged.map((a) => (!a.deleted && gone.has(partnerOf(a.id)) ? { ...a, deleted: true, updatedAt: at } : a));
    try {
      localStorage.setItem(this.key, JSON.stringify(this.items));
    } catch {
      // storage full or unavailable: the server copy still works
    }
    this.onChange?.();
  }

  // Takes in what the server has, and sends back anything it is missing.
  async sync() {
    let theirs;
    try {
      theirs = (await api.getAnnotations(this.paperId)).items || [];
    } catch (err) {
      this.onError?.(err);
      return;
    }
    this.set(mergeAnnotations(this.items, theirs));
    const known = new Map(theirs.map((a) => [a.id, a.updatedAt]));
    if (this.items.some((a) => known.get(a.id) !== a.updatedAt)) await this.push();
  }

  // ponytail: every save sends the whole list, tombstones included; send only what changed
  // since the last successful save if lists ever get long.
  async push() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.pushing) {
      this.again = true;
      return;
    }
    this.pushing = true;
    try {
      const { items } = await api.putAnnotations(this.paperId, this.items);
      this.set(mergeAnnotations(this.items, items || []));
    } catch (err) {
      this.onError?.(err);
    } finally {
      this.pushing = false;
      if (this.again) {
        this.again = false;
        await this.push();
      }
    }
  }

  // A change still waiting for its save goes out now.
  destroy() {
    if (this.timer) this.push();
  }
}

// Paints the live items into the book view: one Custom Highlight per color plus one for
// underlines and one for the passages notes were made on, a margin mark on bookmarked blocks, and
// the notes themselves. Without the Highlight API the items are still saved and listed, they just
// aren't painted. Marks on a block's translation (data-k) are painted once it is in the page, where
// their quote is now. notes: { render(text) -> Node, edit(item), remove(item) }.
export function paintAnnotations(root, items, notes = {}) {
  root.querySelectorAll('.ann-bookmark').forEach((el) => el.classList.remove('ann-bookmark'));
  const blocks = new Map([...root.querySelectorAll('[data-b], [data-k]')].map((el) => [el.getAttribute('data-b') ?? el.getAttribute('data-k'), el]));
  const ranges = new Map(PAINTS.map((name) => [name, []]));
  for (const a of items) {
    if (a.deleted) continue;
    if (a.type === 'bookmark') {
      blocks.get(a.start.b)?.classList.add('ann-bookmark');
      continue;
    }
    const at = isTranslation(a.start.b) ? relocate(a, blocks) : a;
    const name = a.type === 'note' ? 'ann-note' : a.type === 'underline' ? 'ann-underline' : `ann-${COLORS.includes(a.color) ? a.color : 'yellow'}`;
    if (at) ranges.get(name).push(...anchorToRanges(at, blocks));
  }
  placeNotes(root, items, notes);
  for (const [name, list] of ranges) tagFormulas(root, name, list);
  if (!window.CSS?.highlights || typeof Highlight !== 'function') return;
  for (const [name, list] of ranges) CSS.highlights.set(name, new Highlight(...list));
}

// A note stands after the block it was made on, or after that block's translation, past the notes made
// on it before: outside every block, as a figure is, so no offset counts it. One that hasn't
// changed (its updatedAt) keeps its element: a sync draws no note again, and leaves a selection in
// one alone.
function placeNotes(root, items, { render, edit, remove } = {}) {
  const drawn = new Map([...root.querySelectorAll('.gap-note')].map((el) => [el.dataset.note, el]));
  const last = new Map();
  const notes = items.filter((a) => !a.deleted && a.type === 'note').sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt) || (x.id < y.id ? -1 : 1));
  for (const a of notes) {
    const id = a.end.b.replace(/k$/, '');
    const at = last.get(id) || root.querySelector(`[data-k="${id}k"]`) || root.querySelector(`[data-b="${id}"]`);
    if (!at) continue;
    let el = drawn.get(a.id);
    drawn.delete(a.id);
    if (el?.updatedAt !== a.updatedAt) {
      el?.remove();
      const tools = h(
        'div',
        { class: 'gap-note-tools' },
        edit ? iconButton('pencil', { title: t('note.edit'), onClick: () => edit(a) }) : null,
        remove ? iconButton('trash', { title: t('note.delete'), onClick: () => remove(a) }) : null,
      );
      // (a note that can't be drawn shows as its text, and the rest are still painted)
      let body;
      try {
        body = render ? render(a.text || '') : null;
      } catch {
        body = null;
      }
      body ||= h('div', { text: a.text || '' });
      el = h('aside', { class: 'gap-note', lang: langs.tgt, 'data-note': a.id }, body, tools);
      el.updatedAt = a.updatedAt;
    }
    if (at.nextElementSibling !== el) at.after(el);
    last.set(id, el);
  }
  for (const el of drawn.values()) el.remove();
}

export function clearAnnotationPaint() {
  for (const name of PAINTS) window.CSS?.highlights?.delete(name);
}
