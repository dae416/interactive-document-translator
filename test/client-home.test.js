// The home page as a phone sees it: books on the shelf, put away and back, bookmarks gone from it,
// and a book found by the AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window, Node } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document, window, Node, location: { hash: '' } });
Object.assign(window, { matchMedia: () => ({ matches: true }) });
globalThis.navigator ??= { language: 'en' };
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const server = { papers: [], marks: {}, places: {}, found: { books: [] }, calls: [] };
globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  server.calls.push({ url, method: opts.method, body });
  const reply = (data) => ({ ok: true, status: 200, json: async () => structuredClone(data) });
  if (url === '/api/papers') return reply({ papers: server.papers });
  if (url === '/api/books/find') return reply(server.found);
  if (url === '/api/books/import') return reply({ paper: { id: 'pdf-new' } });
  const notes = /^\/api\/papers\/([^/]+)\/annotations$/.exec(url);
  if (notes) {
    if (opts.method === 'PUT') server.marks[notes[1]] = body.items;
    return reply({ items: server.marks[notes[1]] || [] });
  }
  if (/\/places$/.test(url)) return reply({ places: Object.fromEntries(body.blocks.map((b) => [b, server.places[b] ?? null])) });
  const patch = /^\/api\/papers\/([^/]+)$/.exec(url);
  if (patch && opts.method === 'PATCH') return reply({ paper: {} });
  throw new Error(`unexpected ${opts.method} ${url}`);
};

const { renderHome } = await import('../public/assets/js/home.js');

const book = (id, title, extra = {}) => ({ id, title, kind: 'book', source: 'upload', authors: ['C. H. Spurgeon'], createdAt: '2026-11-01T00:00:00.000Z', book: { status: 'ready', chapters: 20 }, ...extra });
const mark = (id, quote) => ({ id, type: 'bookmark', quote, chapter: 'c1', start: { b: 'c1.0', o: 0 }, end: { b: 'c1.0', o: 1 }, color: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deleted: false });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function home() {
  document.body.replaceChildren();
  server.calls = [];
  const root = document.createElement('div');
  document.body.append(root);
  const view = await renderHome(root);
  await settle();
  const titles = (sel) => [...root.querySelectorAll(`${sel} .t`)].map((el) => el.textContent);
  return { root, view, titles };
}

test('books stand on the shelf, each in its own cloth, a long one thicker', async () => {
  server.papers = [book('pdf-a', 'Institutes', { book: { status: 'ready', chapters: 94 } }), book('pdf-b', 'Lectures'), book('arxiv-1', 'A paper', { kind: undefined, source: 'arxiv', sourceId: '2401.04088' })];
  const { root, view, titles } = await home();
  assert.deepEqual(titles('.stack:not(.away)'), ['Institutes', 'Lectures', 'A paper']);
  const [thick, thin, paper] = root.querySelectorAll('.spine');
  assert.ok(thick.style.getPropertyValue('--cloth'));
  assert.ok(parseFloat(thick.style.getPropertyValue('--thick')) > parseFloat(thin.style.getPropertyValue('--thick')));
  assert.ok(paper.classList.contains('leaflet'));
  assert.equal(root.querySelector('.section-title:not(summary) .count').textContent, '3 books');
  assert.ok(root.querySelector('.put-away').hidden, 'nothing put away, no such section');
  assert.ok(root.querySelector('.marks').hidden, 'no bookmarks, no list of them');
  root.querySelector('.spine').click();
  assert.equal(location.hash, '#/read/pdf-a');
  view.destroy();
});

test('a journal article has its journal and year under its title; a book has none', async () => {
  server.papers = [book('pdf-a', 'A Study of Examples', { venue: 'Journal of Examples', published: '2022' }), book('pdf-b', 'Lectures'), book('pdf-c', 'Proceedings', { venue: 'ACL 2023', published: '2023-07-01' })];
  const { root, view } = await home();
  assert.deepEqual(
    [...root.querySelectorAll('.spine')].map((s) => s.querySelector('.t + .v')?.textContent ?? null),
    ['Journal of Examples 2022', null, 'ACL 2023'],
  );
  view.destroy();
});

test('a book put away leaves the shelf with its bookmarks, and comes back', async () => {
  server.papers = [book('pdf-a', 'Institutes'), book('pdf-b', 'Lectures')];
  server.marks = { 'pdf-b': [mark('a_shelfmark00000b', 'in the book put away')] };
  const { root, view, titles } = await home();
  assert.deepEqual(titles('.home-marks'), ['in the book put away']);
  const menu = () => [...document.querySelectorAll('.menu button')];
  const pick = async (spine, label) => {
    spine.querySelector('.more').click();
    menu().find((b) => b.textContent === label).click();
    await settle();
  };
  await pick(root.querySelectorAll('.spine')[1], 'Finished reading');
  assert.deepEqual(titles('.stack:not(.away)'), ['Institutes']);
  assert.deepEqual(titles('.stack.away'), ['Lectures']);
  assert.equal(root.querySelector('.stack.away .shelf-tag').textContent, 'Finished');
  assert.ok(!root.querySelector('.put-away').hidden);
  assert.ok(root.querySelector('.marks').hidden, 'its bookmark is put away with it');
  assert.equal(root.querySelectorAll('.ribbon').length, 0);
  assert.deepEqual(server.calls.at(-1), { url: '/api/papers/pdf-b', method: 'PATCH', body: { shelf: 'read' } });
  await pick(root.querySelector('.stack.away .spine'), 'Take back out');
  assert.equal(server.calls.at(-1).body.shelf, null);
  assert.deepEqual(titles('.stack:not(.away)'), ['Institutes', 'Lectures']);
  assert.ok(!root.querySelector('.marks').hidden);
  view.destroy();
});

test('a bookmark sticks out of its book at its place there, and a tap on it opens the book there', async () => {
  server.papers = [book('pdf-a', 'Institutes'), book('pdf-b', 'Lectures')];
  server.marks = { 'pdf-b': [mark('a_ribbon0000000b1', 'early on'), { ...mark('a_ribbon0000000b2', 'near the end'), start: { b: 'c9.3', o: 0 } }, { ...mark('a_ribbon0000000b3', 'gone in a rechapter'), start: { b: 'c99.0', o: 0 } }] };
  server.places = { 'c1.0': 0, 'c9.3': 0.875 };
  const { root, view } = await home();
  const [none, marked] = root.querySelectorAll('.stack:not(.away) .spine');
  assert.equal(none.querySelectorAll('.ribbon').length, 0);
  const ribbons = [...marked.querySelectorAll('.ribbon')];
  assert.deepEqual(ribbons.map((r) => [r.getAttribute('title'), r.style.getPropertyValue('--at')]).sort(), [['early on', '0'], ['near the end', '0.875']]);
  assert.equal(root.querySelector('.marks .count').textContent, '3', 'the list still has the one with no place');
  location.hash = '';
  ribbons.find((r) => r.getAttribute('title') === 'near the end').click();
  assert.equal(location.hash, '#/read/pdf-b?at=c9.3');
  server.places = {};
  view.destroy();
});

test('a bookmark goes from the home page, and only that one', async () => {
  server.papers = [book('pdf-a', 'Institutes')];
  server.marks = { 'pdf-a': [mark('a_homemark00000a1', 'first'), mark('a_homemark00000a2', 'second')] };
  const { root, view, titles } = await home();
  location.hash = '';
  root.querySelector('.mark-card .more').click();
  await settle();
  assert.equal(titles('.home-marks').length, 1);
  assert.equal(root.querySelectorAll('.ribbon').length, 0, 'these have no place from the stub');
  assert.equal(server.marks['pdf-a'].filter((m) => m.deleted).length, 1);
  assert.equal(location.hash, '', 'the tap on the bin opened nothing');
  view.destroy();
});

test('words go to the AI, a link to the import; what it finds comes in with a tap', async () => {
  server.papers = [];
  server.marks = {};
  server.found = {
    books: [
      { title: 'Lectures to My Students', author: 'C. H. Spurgeon', year: '1875', url: 'https://archive.org/details/x', pdf: 'https://archive.org/download/x/x.pdf', host: 'archive.org', note: 'The first series.' },
      { title: 'Only a page', author: '', year: '', url: 'https://example.org/book', pdf: '', host: 'example.org', note: '' },
    ],
  };
  const { root, view } = await home();
  assert.match(root.querySelector('.empty').textContent, /shelf is empty/);
  const input = root.querySelector('.input-wrap input');
  const submit = async (value) => {
    input.value = value;
    input.dispatchEvent(new window.Event('input'));
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle();
  };
  await submit('Spurgeon on the ministry');
  assert.deepEqual(server.calls.at(-1), { url: '/api/books/find', method: 'POST', body: { query: 'Spurgeon on the ministry', image: null } });
  assert.ok(root.querySelector('.import-hint').hidden, 'the wait is over');
  assert.ok(root.querySelector('.follow-row').hidden, 'words have no next pages');
  const [card, pageOnly] = root.querySelectorAll('.found-card');
  assert.equal(card.querySelector('.t').textContent, 'Lectures to My Students');
  assert.ok(card.querySelector('.m').textContent.includes('archive.org'), 'it says where a tap fetches from');
  assert.equal(pageOnly.querySelector('button'), null, 'no PDF, nothing to add');
  assert.equal(pageOnly.querySelector('a').getAttribute('href'), 'https://example.org/book');
  assert.equal(card.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  card.querySelector('button').click();
  await settle();
  assert.deepEqual(server.calls.at(-1).body, { url: 'https://archive.org/download/x/x.pdf', title: 'Lectures to My Students', authors: ['C. H. Spurgeon'] });
  assert.equal(location.hash, '#/read/pdf-new');

  await submit('St.Augustine');
  assert.equal(server.calls.at(-1).url, '/api/books/find', 'a dot does not make a link');
  input.value = 'archive.org/details/x';
  input.dispatchEvent(new window.Event('input'));
  assert.ok(!root.querySelector('.follow-row').hidden, 'a link may have next pages');

  server.found = null; // the connection went during the search
  await submit('Spurgeon again');
  assert.match(root.querySelector('.import-error').textContent, /\S/);
  assert.ok(!root.querySelector('.import-error').hidden);
  view.destroy();
});
