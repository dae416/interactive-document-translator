// Annotations in the browser: the merge rule shared with the server, and a store that keeps
// working while the server is away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep } from './helpers.js';

// The browser bits the client modules touch: i18n.js sets the page language on import, and the
// store uses localStorage and fetch (through api.js).
globalThis.document = { documentElement: {} };
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const server = { items: [], down: false, calls: [] };
globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  server.calls.push({ url, method: opts.method, body });
  if (server.down) throw new TypeError('fetch failed');
  if (opts.method === 'PUT') server.items = mergeAnnotations(server.items, body.items);
  const items = structuredClone(server.items);
  return { ok: true, status: 200, json: async () => ({ items }) };
};
const { AnnotationStore, mergeAnnotations, partnerOf, removeAnnotation } = await import('../public/assets/js/annotations.js');

const item = (id, updatedAt, extra = {}) => ({
  id,
  type: 'highlight',
  color: 'yellow',
  chapter: 'c1',
  start: { b: 'c1.1', o: 0 },
  end: { b: 'c1.1', o: 5 },
  quote: 'Hello',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt,
  deleted: false,
  ...extra,
});
const ids = (list) => list.map((a) => a.id).sort();
const reset = () => {
  storage.clear();
  Object.assign(server, { items: [], down: false, calls: [] });
};

test('merge: union by id, the later updatedAt wins, a tie keeps our copy', () => {
  const mine = [item('a_mine00001', '2026-10-02T00:00:00.000Z'), item('a_both00001', '2026-10-05T00:00:00.000Z', { color: 'pink' })];
  const theirs = [item('a_their0001', '2026-10-03T00:00:00.000Z'), item('a_both00001', '2026-10-04T00:00:00.000Z', { color: 'blue' })];
  const merged = mergeAnnotations(mine, theirs);
  assert.deepEqual(ids(merged), ['a_both00001', 'a_mine00001', 'a_their0001']);
  assert.equal(merged.find((a) => a.id === 'a_both00001').color, 'pink');
  assert.equal(mergeAnnotations(theirs, mine).find((a) => a.id === 'a_both00001').color, 'pink');
  const tie = mergeAnnotations([item('a_tie000001', '2026-10-04T00:00:00.000Z', { color: 'green' })], [item('a_tie000001', '2026-10-04T00:00:00.000Z')]);
  assert.equal(tie[0].color, 'green');
  assert.equal(mine.length, 2, 'inputs are left alone');
});

test('merge: a newer tombstone removes the item on the other side, and stays', () => {
  const live = [item('a_gone00001', '2026-10-02T00:00:00.000Z')];
  const deleted = [item('a_gone00001', '2026-10-03T00:00:00.000Z', { deleted: true })];
  assert.equal(mergeAnnotations(live, deleted)[0].deleted, true);
  assert.equal(mergeAnnotations(deleted, live)[0].deleted, true);
});

test('a change is in localStorage at once and on the server shortly after', async () => {
  reset();
  const store = new AnnotationStore('book-demo');
  const a = store.add({ type: 'underline', chapter: 'c1', start: { b: 'c1.1', o: 2 }, end: { b: 'c1.2', o: 4 }, quote: 'x'.repeat(2500) });
  assert.match(a.id, /^a_[a-z0-9]{6,32}$/);
  assert.equal(a.color, null);
  assert.equal(a.quote.length, 2000);
  assert.deepEqual(ids(JSON.parse(storage.get('ann:book-demo'))), [a.id]);
  assert.equal(server.calls.length, 0, 'saves are debounced');
  await sleep(700);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].method, 'PUT');
  assert.equal(server.calls[0].url, '/api/papers/book-demo/annotations');
  assert.deepEqual(ids(server.calls[0].body.items), [a.id]);
});

test('with the server down the list stays local and goes out with the next change', async () => {
  reset();
  const errors = [];
  const store = new AnnotationStore('book-demo', { onError: (err) => errors.push(err) });
  server.down = true;
  const a = store.add({ type: 'highlight', color: 'blue', chapter: 'c1', start: { b: 'c1.1', o: 0 }, end: { b: 'c1.1', o: 3 }, quote: 'Hel' });
  await store.push();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 0, 'a network error, not a server answer');
  assert.deepEqual(ids(server.items), []);
  // A reload while the server is still down finds the item in this browser.
  assert.deepEqual(ids(new AnnotationStore('book-demo').items), [a.id]);
  server.down = false;
  const b = store.add({ type: 'bookmark', chapter: 'c1', start: { b: 'c1.2', o: 0 }, end: { b: 'c1.2', o: 0 }, quote: 'Second' });
  store.remove([a.id]);
  await store.push();
  assert.deepEqual(ids(server.items), ids([a, b]));
  assert.equal(server.items.find((x) => x.id === a.id).deleted, true, 'the delete reaches the server as a tombstone');
  assert.deepEqual(store.live.map((x) => x.id), [b.id]);
});

test('opening merges the server copy and sends back only when the server lacks something', async () => {
  reset();
  storage.set('ann:book-demo', JSON.stringify([item('a_local0001', '2026-10-02T00:00:00.000Z'), item('a_shared001', '2026-10-02T00:00:00.000Z'), { id: 'junk' }]));
  server.items = [item('a_remote001', '2026-10-03T00:00:00.000Z'), item('a_shared001', '2026-10-06T00:00:00.000Z', { color: 'green' })];
  let changes = 0;
  const store = new AnnotationStore('book-demo', { onChange: () => changes++ });
  assert.deepEqual(ids(store.items), ['a_local0001', 'a_shared001'], 'unreadable entries are dropped');
  await store.sync();
  assert.ok(changes > 0);
  assert.deepEqual(ids(store.items), ['a_local0001', 'a_remote001', 'a_shared001']);
  assert.equal(store.items.find((a) => a.id === 'a_shared001').color, 'green');
  assert.deepEqual(server.calls.map((c) => c.method), ['GET', 'PUT']);
  assert.deepEqual(ids(server.items), ['a_local0001', 'a_remote001', 'a_shared001']);
  // In step now: opening again only reads.
  server.calls = [];
  await new AnnotationStore('book-demo').sync();
  assert.deepEqual(server.calls.map((c) => c.method), ['GET']);
});

test('marks and bookmarks under a selection', () => {
  reset();
  const store = new AnnotationStore('book-demo');
  const mark = store.add({ type: 'highlight', color: 'pink', chapter: 'c2', start: { b: 'c2.3', o: 10 }, end: { b: 'c2.4', o: 2 }, quote: 'q' });
  const bm = store.add({ type: 'bookmark', chapter: 'c2', start: { b: 'c2.3', o: 0 }, end: { b: 'c2.3', o: 0 }, quote: 'q' });
  const sel = (b1, o1, b2, o2) => ({ start: { b: b1, o: o1 }, end: { b: b2, o: o2 } });
  assert.deepEqual(store.marksIn(sel('c2.4', 0, 'c2.4', 1)), [mark.id]);
  assert.deepEqual(store.marksIn(sel('c2.3', 0, 'c2.3', 10)), [], 'bookmarks are not marks, and touching is not overlapping');
  assert.equal(store.bookmarkAt('c2.3').id, bm.id);
  store.remove([bm.id]);
  assert.equal(store.bookmarkAt('c2.3'), null);
  clearTimeout(store.timer);
});

test('a mark and its partners on the other language: one group, removed together', () => {
  reset();
  const store = new AnnotationStore('book-demo');
  const base = 'a_mvo3mwio60lp5n';
  const own = 'a_mvo3mwio60lp5'; // an id of the app's own that happens to end "p5": no partner
  store.add(item(base, '2026-10-02T00:00:00.000Z'), item(`${base}p0`, '2026-10-02T00:00:00.000Z', { start: { b: 'c1.1k', o: 0 }, end: { b: 'c1.1k', o: 3 } }), item(own, '2026-10-02T00:00:00.000Z'));
  assert.equal(partnerOf(`${base}p0`), base);
  assert.equal(partnerOf(own), null);
  assert.equal(store.groupOf(`${base}p0`), base);
  assert.deepEqual(store.withPartners([`${base}p0`]).sort(), [base, `${base}p0`]);
  assert.deepEqual(store.withPartners([own]), [own]);
  // the times given are kept (a partner takes its mark's)
  assert.equal(store.items.find((a) => a.id === `${base}p0`).updatedAt, '2026-10-02T00:00:00.000Z');
  clearTimeout(store.timer);
});

test('a mark removed elsewhere takes its partner made here along', async () => {
  reset();
  const base = 'a_mvo3mwio60lp5n';
  storage.set('ann:book-demo', JSON.stringify([item(base, '2026-10-02T00:00:00.000Z'), item(`${base}p0`, '2026-10-02T00:00:00.000Z')]));
  server.items = [item(base, '2026-10-05T00:00:00.000Z', { deleted: true })];
  const store = new AnnotationStore('book-demo');
  await store.sync();
  assert.ok(store.items.every((a) => a.deleted), 'the partner is removed with its mark');
  assert.ok(server.items.find((a) => a.id === `${base}p0`)?.deleted, 'and the removal goes to the server');
});

test('two tabs with the server down: a change in one keeps what the other wrote', async () => {
  reset();
  server.down = true;
  const mark = (b) => ({ type: 'highlight', color: 'yellow', chapter: 'c1', start: { b, o: 0 }, end: { b, o: 4 }, quote: 'q' });
  const tabA = new AnnotationStore('book-demo');
  const tabB = new AnnotationStore('book-demo');
  const x = tabA.add(mark('c1.1'));
  await sleep(5);
  const y = tabB.add(mark('c1.2'));
  assert.deepEqual(ids(JSON.parse(storage.get('ann:book-demo'))), ids([x, y]));
  assert.deepEqual(ids(tabB.items), ids([x, y]));
  // A delete in one tab survives the other tab's next change.
  await sleep(5);
  tabA.remove([x.id]);
  await sleep(5);
  const z = tabB.add(mark('c1.3'));
  const stored = JSON.parse(storage.get('ann:book-demo'));
  assert.deepEqual(ids(stored), ids([x, y, z]));
  assert.equal(stored.find((a) => a.id === x.id).deleted, true);
  clearTimeout(tabA.timer);
  clearTimeout(tabB.timer);
});

test('a bookmark goes from the home page, for a book this browser never opened too', async () => {
  storage.clear();
  server.down = false;
  server.items = [item('a_homemark00000a', '2026-01-01T00:00:00.000Z', { type: 'bookmark' })];
  await removeAnnotation('book-home', 'a_homemark00000a');
  assert.equal(server.items[0].deleted, true);
  // It stays gone at the next open, in a browser with nothing of its own either.
  storage.clear();
  const store = new AnnotationStore('book-home');
  await store.sync();
  assert.deepEqual(store.live, []);
});

test('a bookmark removed with the server away says so, and goes at the next open', async () => {
  storage.clear();
  server.items = [];
  const local = new AnnotationStore('book-away');
  local.add({ type: 'bookmark', chapter: 'c1', start: { b: 'c1.0', o: 0 }, end: { b: 'c1.0', o: 1 }, quote: 'q' });
  await local.push();
  const { id } = server.items[0];
  await sleep(5); // (a later time wins the merge: not the same millisecond)
  server.down = true;
  await assert.rejects(removeAnnotation('book-away', id));
  server.down = false;
  await new AnnotationStore('book-away').sync();
  assert.equal(server.items[0].deleted, true);
});
