// Annotations (merge, tombstones, validation) and files that a sync client has made online-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, signIn, startServer, tempDir, writeBookFixture } from './helpers.js';

const { cleanItem, mergeItems } = await import('../server/annotations.js');

const PW = 'test-password';
const CHAPTERS = [{ id: 'c1', title: 'Hope', blocks: [{ t: 'h', x: 'HOPE.' }, { t: 'p', x: 'Eggs are eggs, but some are rotten.' }], pages: null, url: null }];

const item = (id, updatedAt, extra = {}) => ({
  id,
  type: 'highlight',
  color: 'yellow',
  chapter: 'c1',
  start: { b: 'c1.1', o: 0 },
  end: { b: 'c1.1', o: 4 },
  quote: 'Eggs',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt,
  deleted: false,
  ...extra,
});

test('merge keeps the later edit of each item and keeps tombstones', () => {
  const server = [item('a_aaaaaa', '2026-10-02T00:00:00.000Z'), item('a_bbbbbb', '2026-10-05T00:00:00.000Z', { color: 'green' })];
  const client = [
    item('a_aaaaaa', '2026-10-03T00:00:00.000Z', { deleted: true }),
    item('a_bbbbbb', '2026-10-04T00:00:00.000Z', { color: 'pink' }),
    item('a_cccccc', '2026-10-01T00:00:00.000Z', { type: 'bookmark', color: null, quote: '' }),
  ];
  const merged = Object.fromEntries(mergeItems(server, client).map((a) => [a.id, a]));
  assert.equal(merged.a_aaaaaa.deleted, true, 'a newer delete wins');
  assert.equal(merged.a_bbbbbb.color, 'green', 'an older edit loses');
  assert.equal(merged.a_cccccc.type, 'bookmark');
  assert.equal(Object.keys(merged).length, 3);
});

test('items that do not fit the format are refused', () => {
  const ok = item('a_k3j9x2m1', '2026-10-02T00:00:00.000Z');
  assert.deepEqual(cleanItem({ ...ok, extra: 'dropped' }), ok);
  for (const bad of [
    { id: 'k3j9x2m1' },
    { id: 'a_UPPER1' },
    { type: 'strike' },
    { color: 'red' },
    { chapter: '../c1' },
    { start: { b: 'c1.1', o: -1 } },
    { end: { b: 'c1', o: 0 } },
    { quote: 'x'.repeat(2001) },
    { updatedAt: 'yesterday' },
  ]) {
    assert.equal(cleanItem({ ...ok, ...bad }), null, JSON.stringify(bad));
  }
});

test('marks on the Korean translation of a block ("c1.1k") are kept as they are; malformed ones are refused', () => {
  const ko = item('a_k0rean001', '2026-10-24T00:00:00.000Z', { start: { b: 'c1.1k', o: 7 }, end: { b: 'c1.2k', o: 3 }, quote: '악마의 작업장' });
  assert.deepEqual(cleanItem(ko), ko);
  const bm = { ...ko, type: 'bookmark', color: null, start: { b: 'c1.1k', o: 0 }, end: { b: 'c1.1k', o: 0 } };
  assert.deepEqual(cleanItem(bm), bm);
  for (const bad of [
    { start: { b: 'c1.1kk', o: 0 } },
    { start: { b: 'c1.1K', o: 0 } },
    { start: { b: 'c1k.1', o: 0 } },
    { end: { b: 'c1.k', o: 0 } },
    { end: { b: 'c1.2', o: 3 } },
    { start: { b: 'c1.1', o: 0 } },
  ]) {
    assert.equal(cleanItem({ ...ko, ...bad }), null, JSON.stringify(bad));
  }
});

test('annotations round-trip and merge on the server', async () => {
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: CHAPTERS });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const url = '/api/papers/txt-book/annotations';
    assert.deepEqual((await api(srv.url, 'GET', url, { cookie })).data, { items: [] });
    const a = item('a_aaaaaa', '2026-10-02T00:00:00.000Z');
    const put1 = await api(srv.url, 'PUT', url, { cookie, body: { items: [a, { id: 'junk' }] } });
    assert.equal(put1.status, 200);
    assert.deepEqual(put1.data.items, [a]);
    // Another browser deletes it later and adds a bookmark.
    const gone = { ...a, deleted: true, updatedAt: '2026-10-03T00:00:00.000Z' };
    const mark = item('a_bbbbbb', '2026-10-03T00:00:00.000Z', { type: 'bookmark', color: null, quote: '', start: { b: 'c1.0', o: 0 }, end: { b: 'c1.0', o: 0 } });
    await api(srv.url, 'PUT', url, { cookie, body: { items: [gone, mark] } });
    // The first browser comes back with its stale copy.
    const stale = await api(srv.url, 'PUT', url, { cookie, body: { items: [a] } });
    assert.deepEqual(stale.data.items, [gone, mark]);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'papers', 'txt-book', 'annotations.json'), 'utf8'));
    assert.deepEqual(stored, { version: 1, items: [gone, mark] });
    // A mark on the Korean joins them; the ones before stay exactly as they were.
    const ko = item('a_k0rean001', '2026-10-04T00:00:00.000Z', { color: 'pink', start: { b: 'c1.1k', o: 2 }, end: { b: 'c1.1k', o: 5 }, quote: '악마의' });
    assert.deepEqual((await api(srv.url, 'PUT', url, { cookie, body: { items: [ko] } })).data.items, [gone, mark, ko]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'papers', 'txt-book', 'annotations.json'), 'utf8')), { version: 1, items: [gone, mark, ko] });
    assert.equal((await api(srv.url, 'PUT', url, { cookie, body: { items: 'nope' } })).status, 400);
    assert.equal((await api(srv.url, 'GET', '/api/papers/missing/annotations', { cookie })).status, 404);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an online-only (0-byte) file is an error: nothing is written, and the library still lists the rest', async () => {
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: CHAPTERS });
  writeBookFixture(dir, 'txt-other', { chapters: CHAPTERS, meta: { title: 'Other' } });
  const annFile = path.join(dir, 'papers', 'txt-book', 'annotations.json');
  fs.writeFileSync(annFile, '');
  fs.writeFileSync(path.join(dir, 'papers', 'txt-other', 'meta.json'), '');
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const put = await api(srv.url, 'PUT', '/api/papers/txt-book/annotations', {
      cookie,
      body: { items: [item('a_aaaaaa', '2026-10-02T00:00:00.000Z')] },
      headers: { 'X-UI-Lang': 'en' },
    });
    assert.equal(put.status, 503);
    assert.match(put.data.error, /available offline/);
    assert.equal(fs.statSync(annFile).size, 0, 'the placeholder is left alone');
    assert.equal((await api(srv.url, 'GET', '/api/papers/txt-book/annotations', { cookie })).status, 503);

    const list = await api(srv.url, 'GET', '/api/papers', { cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.data.papers.map((p) => p.id),
      ['txt-book'],
    );
    const patch = await api(srv.url, 'PATCH', '/api/papers/txt-other', { cookie, body: { opened: true } });
    assert.equal(patch.status, 503);
    assert.equal(fs.statSync(path.join(dir, 'papers', 'txt-other', 'meta.json')).size, 0);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a note keeps its text; one without text, or with too much, is dropped; other kinds get none', () => {
  const note = item('a_note00001', '2026-11-02T00:00:00.000Z', { type: 'note', color: null, text: '배경: 예시 메모다.' });
  assert.equal(cleanItem(note).text, '배경: 예시 메모다.');
  assert.equal(cleanItem({ ...note, text: '  ' }), null);
  assert.equal(cleanItem({ ...note, text: 'x'.repeat(20001) }), null);
  assert.equal('text' in cleanItem(item('a_high00001', '2026-11-02T00:00:00.000Z', { text: 'stray' })), false);
});

test("a deleted note's tombstone is kept with its text, or without one, so the delete syncs", () => {
  const note = item('a_note00002', '2026-11-03T00:00:00.000Z', { type: 'note', color: null, text: '배경', deleted: true });
  assert.deepEqual(cleanItem(note), note);
  const bare = { ...note };
  delete bare.text;
  assert.deepEqual(cleanItem(bare), bare, 'one sent without its text');
  // One the server never took (its text over the limit) can still be deleted.
  assert.deepEqual(cleanItem({ ...note, text: 'x'.repeat(20001) }), bare);
  assert.deepEqual(cleanItem({ ...note, text: 42 }), bare);
  assert.equal(cleanItem({ ...bare, deleted: false }), null, 'a live note still needs its text');
});
