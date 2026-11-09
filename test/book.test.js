// Books: chapters from scanned pages, text files and web pages; paper.html; imports and jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { ROOT, anthropicStub, api, signIn, sleep, startServer, tempDir, useStub, waitFor, waitForPaper, writeBookFixture } from './helpers.js';

const { chaptersFromPages, chaptersFromText, extractPage } = await import('../server/parse.js');
const { renderHtml } = await import('../server/book.js');

const PW = 'test-password';
const fixture = (...p) => path.join(ROOT, 'test', 'fixtures', ...p);
const textOf = (c) => c.blocks.map((b) => b.x).join('\n');

const PLOUGHMAN = [
  'To the Idle',
  'On Religious Grumblers',
  'On the Preacher’s Appearance',
  'On Good Nature and Firmness',
  'On Patience',
  'On Gossips',
  'On Seizing Opportunities',
  'On Keeping One’s Eyes Open',
  'Thoughts About Thought',
  'Faults',
  'Things Not Worth Trying',
  'Debt',
  'Home',
  'Men Who Are Down',
  'Hope',
  'Spending',
  'A Good Word for Wives',
  'Men with Two Faces',
  'Hints as to Thriving',
  'Tall Talk',
  'Things I Would Not Choose',
  'Try',
  'Monuments',
  'Very Ignorant People',
];

test('a scanned book: 24 chapters between the front matter and the publisher’s adverts', () => {
  const { pages } = JSON.parse(fs.readFileSync(fixture('ploughman-ocr-pages.json'), 'utf8'));
  const chapters = chaptersFromPages(pages);
  assert.deepEqual(
    chapters.map((c) => c.title),
    ['Front matter', 'Preface', ...PLOUGHMAN, 'Henry Altemus’ Publications'],
  );
  const byTitle = Object.fromEntries(chapters.map((c) => [c.title, c]));
  // Opening pages without a title line still open their chapter.
  assert.deepEqual(byTitle['To the Idle'].pages, [16, 30]);
  assert.deepEqual(byTitle['On Religious Grumblers'].pages, [31, 41]);
  assert.deepEqual(byTitle.Home.pages, [120, 131]);
  assert.deepEqual(byTitle['Very Ignorant People'].pages, [230, 243]);
  for (const title of PLOUGHMAN) assert.equal(byTitle[title].blocks[0].t, 'h', title);
  assert.deepEqual(byTitle['To the Idle'].blocks[0], { t: 'h', x: 'TO THE IDLE.' });
  assert.equal(byTitle['On the Preacher’s Appearance'].blocks[0].x, 'ON THE PREACHER’S APPEARANCE.');

  const all = chapters.map(textOf).join('\n');
  assert.ok(!/digitized by google/i.test(all));
  assert.ok(!all.includes('This is a digital copy of a book'));
  // (The adverts list the book itself.)
  assert.ok(!/JOHN PLOUGHMAN[’']S TALK/.test(PLOUGHMAN.map((t) => textOf(byTitle[t])).join('\n')), 'running heads are gone');
  assert.ok(!/^(\(\d+\)|3 \(33\))$/m.test(all), 'folios are gone');
  const idle = textOf(byTitle['To the Idle']);
  assert.ok(idle.includes('one might as well try to fatten a greyhound'), 'paragraphs run on across pages');
  assert.ok(idle.includes('a man doing mischief is a sparrow picking the corn'), 'hyphenated line ends are joined');
  assert.ok(textOf(byTitle['On Religious Grumblers']).includes('His ignorance is the mother of his impudence'));
  for (const c of chapters) for (const b of c.blocks) assert.equal(b.x, b.x.replace(/\s+/g, ' ').trim());
  // Windows line ends change nothing.
  assert.deepEqual(chaptersFromPages(pages.map((p) => p.replace(/\n/g, '\r\n'))), chapters);
});

test('a PDF with bookmarks: chapters by them, running heads, indents and footnotes as printed', () => {
  const margin = (s) => `${s}${' '.repeat(96 - s.length)}37`;
  const line = 'a line of the text long enough to tell where the margin of this page stands and so on,';
  const pages = [
    `   CHAPTER 1. - OF GOD, HIS POWER AND\n                 MERCY…\n\n       CHAPTER 1.\n   OF GOD, HIS POWER AND MERCY.\n     Sections.\n${margin(`     1. The first section begins here and it is long enough to reach the margin number,`)}\n${line}\nends here.\n     2. The second opens with an indent, though the first ended in a word and\n${line}\n\n\n21   A footnote, first line of it\nand its second line.\n\n     44\n`,
    `   CHAPTER 1. - OF GOD, HIS POWER AND\n                 MERCY…\n\n${line}\nthe last page of the chapter.\n`,
    `   BOOK SECOND.\n\n   BOOK SECOND.\n`,
    `   ARGUMENT.\n\n   ARGUMENT.\n${line}\nA second part follows on the same page.\n`,
    `   CHAPTER 1. - OF MAN.\n\n       CHAPTER 1.\n   OF MAN.\n     The second book’s first chapter is long enough to be seen at its indent here.\n${line}\nThe end.\n`,
    `TITLE PAGE TEXT\nmore of it\n\nThe Printed Title\n\n7\n`,
  ];
  const outline = [
    { title: 'BOOK FIRST. OF GOD', page: 1, depth: 0 },
    { title: 'CHAPTER 1. - OF GOD, HIS POWER AND MERCY.', page: 1, depth: 1 },
    { title: 'BOOK SECOND. OF MAN', page: 3, depth: 0 },
    { title: 'ARGUMENT.', page: 4, depth: 1 },
    { title: 'NO HEADING ON THIS PAGE', page: 4, depth: 1 },
    { title: 'CHAPTER 1. - OF MAN.', page: 5, depth: 1 },
    { title: 'The Printed Title', page: 6, depth: 0 },
  ];
  const chapters = chaptersFromPages(pages, outline);
  assert.deepEqual(
    chapters.map((c) => [c.title, c.pages]),
    [
      ['1.1 Of God, His Power and Mercy', [1, 2]],
      ['Argument', [3, 4]],
      ['2.1 Of Man', [5, 5]],
      ['The Printed Title', [6, 6]],
    ],
  );
  const [first, argument, , last] = chapters;
  assert.deepEqual(
    first.blocks.map((b) => [b.t, b.x.slice(0, 16)]),
    [
      ['h', 'BOOK FIRST. OF G'],
      ['p', 'Sections.'],
      ['p', '1. The first sec'],
      ['p', '2. The second op'],
      ['h', 'Notes'],
      ['p', '[21] A footnote,'],
    ],
  );
  assert.equal(first.blocks[5].x, '[21] A footnote, first line of it and its second line.');
  assert.ok(first.blocks[3].x.endsWith('the last page of the chapter.'), 'a paragraph runs over the page, past the head');
  assert.ok(!/37|MERCY|44/.test(textOf(first)), 'no margin number, running head or folio in the text');
  assert.deepEqual(argument.blocks.map((b) => b.t), ['h', 'p']);
  assert.match(last.blocks[0].x, /^TITLE PAGE TEXT/);
});

test('bookmarks that say nothing leave the headings to tell the chapters', () => {
  const pages = ['ONE\n\nONE\nfirst page text\n', 'TWO\n\nTWO\nsecond page text\n'];
  const outline = [{ title: 'Only one', page: 1, depth: 0 }];
  assert.deepEqual(chaptersFromPages(pages, outline), chaptersFromPages(pages));
});

test('chapters merged into one keep their text under their old titles, and the others keep theirs', () => {
  const dataDir = tempDir();
  const chapter = (n, ...x) => ({ id: `c${n}`, title: `Old ${n}`, blocks: x.map((s) => ({ t: 'p', x: s })), pages: [n, n], url: null });
  const translations = { c2: { ranges: [[0, 1]], parts: [] }, c4: { ranges: [[0, 1]], parts: [] } };
  const summaries = { c1: 'one', c2: 'two', c4: 'four' };
  writeBookFixture(dataDir, 'book-merge', { chapters: [chapter(1, 'a'), chapter(2, 'b', 'c'), chapter(3, 'd'), chapter(4, 'e')], summaries, brief: 'Brief.', meta: { book: { status: 'ready', chapters: 4, summaries: 3, translations } } });
  const merge = (...args) => spawnSync(process.execPath, ['scripts/merge-chapters.mjs', 'book-merge', ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
  assert.notEqual(merge('c3', 'c1', 'Backwards').status, 0);
  const done = merge('c1', 'c3', 'Front Matter');
  assert.equal(done.status, 0, done.stderr);
  const dir = path.join(dataDir, 'papers', 'book-merge');
  const book = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
  assert.deepEqual(book.chapters.map((c) => [c.id, c.title, c.pages]), [['c1', 'Front Matter', [1, 3]], ['c4', 'Old 4', [4, 4]]]);
  assert.deepEqual(book.chapters[0].blocks.map((b) => [b.t, b.x]), [['h', 'Old 1'], ['p', 'a'], ['h', 'Old 2'], ['p', 'b'], ['p', 'c'], ['h', 'Old 3'], ['p', 'd']]);
  assert.deepEqual(book.summaries, { c4: 'four' });
  assert.equal(book.brief, 'Brief.');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual([meta.book.chapters, meta.book.summaries, Object.keys(meta.book.translations)], [2, 1, ['c4']]);
  assert.match(fs.readFileSync(path.join(dir, 'paper.html'), 'utf8'), /id="c1\.5"[^>]*>Old 3</);
});

test('a book is put away and taken back out', async () => {
  const dataDir = tempDir();
  writeBookFixture(dataDir, 'book-shelf', { chapters: [{ id: 'c1', title: 'One', blocks: [{ t: 'p', x: 'text' }], pages: null, url: null }] });
  const srv = await startServer({ dataDir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const shelf = async (value) => (await api(srv.url, 'PATCH', '/api/papers/book-shelf', { cookie, body: { shelf: value } })).data.paper.shelf;
    assert.equal(await shelf('read'), 'read');
    assert.equal(await shelf('unneeded'), 'unneeded');
    assert.equal(await shelf('anything else'), 'unneeded', 'a value it does not know changes nothing');
    assert.equal((await api(srv.url, 'GET', '/api/papers', { cookie })).data.papers[0].shelf, 'unneeded');
    assert.equal(await shelf(null), undefined);
  } finally {
    await srv.stop();
  }
});

test('a block has its place in the book, the Korean of it too, and one that is gone has none', async () => {
  const dataDir = tempDir();
  const chapter = (id, ...x) => ({ id, title: id, blocks: x.map((s) => ({ t: 'p', x: s })), pages: null, url: null });
  writeBookFixture(dataDir, 'book-places', { chapters: [chapter('c1', 'aaaa', 'bbbb'), chapter('c2', 'cccccccc')] });
  const srv = await startServer({ dataDir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const res = await api(srv.url, 'POST', '/api/papers/book-places/places', { cookie, body: { blocks: ['c1.0', 'c1.1', 'c2.0k', 'c9.9'] } });
    assert.deepEqual(res.data.places, { 'c1.0': 0, 'c1.1': 0.25, 'c2.0k': 0.5, 'c9.9': null });
  } finally {
    await srv.stop();
  }
});

test('the AI finds a book: its search goes on past a pause, and what comes back is checked', async () => {
  const stub = await anthropicStub((body) => {
    if (body.messages.length === 1) return { stopReason: 'pause_turn', container: { id: 'container_1', expires_at: '2026-11-02T00:00:00Z' }, content: [{ type: 'text', text: 'Searching.' }] };
    const books = [
      { title: 'Lectures  to My Students', author: 'C. H. Spurgeon', year: 1875, url: 'https://archive.org/details/x', pdf: 'https://archive.org/download/x/x.pdf', note: 'The first series.' },
      { title: 'No link at all' },
      { title: 'A bad link', url: 'javascript:alert(1)' },
      { title: 'A site the search never saw', url: 'https://made-up.example/book.pdf' },
      { title: 'Only its page', url: 'https://archive.org/details/second-series' },
    ];
    const results = [{ type: 'web_search_result', title: 'x', url: 'https://www.archive.org/details/x', encrypted_content: 'e' }];
    return { content: [{ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: results }, { type: 'text', text: `The 1875 [first] series is best: ${JSON.stringify(books)}` }] };
  });
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const res = await api(srv.url, 'POST', '/api/books/find', { cookie, body: { query: 'Spurgeon to pastors', image: { mediaType: 'image/jpeg', data: 'AAAA' } } });
    const { books, error } = res.data;
    assert.equal(error, undefined);
    assert.deepEqual(books.map((b) => [b.title, b.year, b.pdf, b.host]), [
      ['Lectures to My Students', '1875', 'https://archive.org/download/x/x.pdf', 'archive.org'],
      ['Only its page', '', 'https://archive.org/download/second-series/second-series.pdf', 'archive.org'],
    ]);
    assert.equal(stub.requests.length, 2);
    const [first, second] = stub.requests;
    assert.deepEqual(first.tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
    assert.equal(first.messages[0].content[0].type, 'image');
    assert.equal(second.container, 'container_1', 'in the same container');
    assert.equal(second.messages[1].role, 'assistant', 'the paused turn goes back as it was');
    assert.equal(second.messages.length, 2, 'with nothing added');
    const empty = await api(srv.url, 'POST', '/api/books/find', { cookie, body: { query: '  ' } });
    assert.equal(empty.status, 400);
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('a failed search says why', async () => {
  const stub = await anthropicStub(() => ({ status: 500 }));
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const res = await api(srv.url, 'POST', '/api/books/find', { cookie, body: { query: 'a book' }, headers: { 'X-UI-Lang': 'en' } });
    assert.equal(res.status, 200);
    assert.match(res.data.error, /\S/);
    assert.notEqual(res.data.error, 'The search failed', 'the reason, not a shrug');
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('a reply that is cut off is a failure, not nothing found', async () => {
  const stub = await anthropicStub(() => ({ stopReason: 'max_tokens', text: '[{"title": "Lectures to' }));
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const res = await api(srv.url, 'POST', '/api/books/find', { cookie, body: { query: 'a book' }, headers: { 'X-UI-Lang': 'en' } });
    assert.equal(res.data.error, 'The search failed');
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('a page of unclosed meta tags takes no time to read', async () => {
  const { metaFromHtml } = await import('../server/sources.js');
  const started = Date.now();
  metaFromHtml('<meta '.repeat(400_000));
  assert.ok(Date.now() - started < 1000);
});

test('a link the AI found becomes a book, with the title it found; a second time, the same book', async () => {
  const pdf = Buffer.from('%PDF-1.4\n%found\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  const pages = http.createServer((req, res) => {
    if (req.url.endsWith('.pdf')) res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(pdf);
    else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><title>A page</title><p>No PDF here.</p></html>');
  });
  await new Promise((resolve) => pages.listen(0, '127.0.0.1', resolve));
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_ALLOW_PRIVATE_URLS: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    const url = `http://127.0.0.1:${pages.address().port}/a-scan.pdf`;
    const res = await api(srv.url, 'POST', '/api/books/import', { cookie, body: { url, title: 'The Found Title', authors: ['C. H. Spurgeon'] } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const { paper } = res.data;
    assert.equal(paper.kind, 'book');
    assert.match(paper.id, /^pdf-/);
    assert.equal(paper.title, 'The Found Title');
    assert.deepEqual(paper.authors, ['C. H. Spurgeon']);
    assert.equal(paper.absUrl, url);
    const again = await api(srv.url, 'POST', '/api/books/import', { cookie, body: { url } });
    assert.equal(again.data.paper.id, paper.id);
    assert.deepEqual(fs.readdirSync(path.join(srv.dataDir, 'tmp')), [], 'nothing left behind');
    const page = await api(srv.url, 'POST', '/api/books/import', { cookie, body: { url: `http://127.0.0.1:${pages.address().port}/about` }, headers: { 'X-UI-Lang': 'en' } });
    assert.equal(page.status, 422, 'a page is no book');
    const local = await api(srv.url, 'POST', '/api/books/import', { cookie, body: { url: 'file:///etc/passwd' } });
    assert.equal(local.status, 400);
  } finally {
    await srv.stop();
    pages.close();
  }
});

test('a scan from a link never reaches the OCR', { skip: spawnSync('pdftotext', ['-v']).error && 'no pdftotext here' }, async () => {
  const blank = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const site = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(blank));
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_ALLOW_PRIVATE_URLS: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    const res = await api(srv.url, 'POST', '/api/books/import', { cookie, body: { url: `http://127.0.0.1:${site.address().port}/scan.pdf` }, headers: { 'X-UI-Lang': 'en' } });
    const meta = await waitForPaper(srv.url, cookie, res.data.paper.id, (m) => m.book.status !== 'processing');
    assert.equal(meta.book.status, 'error');
    assert.match(meta.book.error, /scan with no text/);
    assert.equal(meta.book.ocr, false);
  } finally {
    await srv.stop();
    site.close();
  }
});

test('pages without headings fall back to 10-page chunks', () => {
  const pages = Array.from({ length: 23 }, (_, i) => `A line about ${'abcdefghijklmnopqrstuvwxyz'[i].repeat(4)}.\nAnd more text.`);
  assert.deepEqual(
    chaptersFromPages(pages).map((c) => [c.title, c.pages]),
    [
      ['pp. 1–10', [1, 10]],
      ['pp. 11–20', [11, 20]],
      ['pp. 21–23', [21, 23]],
    ],
  );
});

test('text files split at chapter lines, including "Chap. I"', () => {
  const text = [
    'THE BOOK OF THINGS',
    '',
    'Chap. I',
    '',
    'It was a dark',
    'and stormy night.',
    '',
    'Part of the trouble was',
    'the rain.',
    '',
    'CHAPTER II. THE SECOND',
    '',
    'Two.',
    '',
    'III.',
    '',
    'Three.',
  ].join('\r\n');
  const chapters = chaptersFromText(text);
  assert.deepEqual(
    chapters.map((c) => c.title),
    ['Front matter', 'Chap. I', 'Chapter II. The Second', 'III'],
  );
  assert.deepEqual(chapters[1].blocks, [
    { t: 'h', x: 'Chap. I' },
    { t: 'p', x: 'It was a dark and stormy night.' },
    { t: 'p', x: 'Part of the trouble was the rain.' },
  ]);
  const plain = chaptersFromText(Array.from({ length: 70 }, (_, i) => `Paragraph ${i} ${'word '.repeat(98)}`).join('\n\n'));
  assert.deepEqual(
    plain.map((c) => c.title),
    ['Part 1', 'Part 2', 'Part 3'],
  );
});

test('a list of contents joins the chapter after it; ".", "I" and "Mix" lines start no chapter', () => {
  const lines = ['A BOOK', '', 'CONTENTS', '', 'CHAPTER I.', '', 'CHAPTER II.', '', 'CHAPTER I.', '', 'First words.', '', '.', '', 'I', '', 'Mix', '', 'CHAPTER II.', '', 'Second words.'];
  const chapters = chaptersFromText(lines.join('\n'));
  assert.deepEqual(
    chapters.map((c) => c.title),
    ['Front matter', 'Chapter I', 'Chapter II'],
  );
  assert.deepEqual(
    chapters[1].blocks.map((b) => b.x),
    ['CHAPTER I.', 'CHAPTER II.', 'CHAPTER I.', 'First words.', '.', 'I', 'Mix'],
  );
});

test('scanned headings that differ only in their number are different chapters', () => {
  const pages = (heads) => heads.map((h, i) => `${h} ${i + 1}\n\n${['Words', 'of', 'chapter', 'text', 'here'][i % 5]} on page ${i + 1}.`);
  for (const [heads, titles] of [
    [['CHAPTER I.', 'CHAPTER I.', 'CHAPTER II.', 'CHAPTER II.'], ['Chapter I', 'Chapter II']],
    [['CHAPTER 1.', 'CHAPTER 1.', 'CHAPTER 2.', 'CHAPTER 2.', 'CHAPTER 3.'], ['Chapter 1', 'Chapter 2', 'Chapter 3']],
  ]) {
    assert.deepEqual(
      chaptersFromPages(pages(heads)).map((c) => c.title),
      titles,
    );
  }
});

test('CCEL pages: section titles, no navigation or page numbers, and the next page', () => {
  const pages = [
    ['mhc1.Gen.i.html', 'Introduction', 'mhc1.Gen.ii.html', 'We have now before us the holy Bible'],
    ['mhc1.Gen.ii.html', 'Chapter I', 'mhc1.Gen.iii.html', 'it is impossible it should be otherwise, for nothing is more injurious'],
    ['mhc1.Gen.iii.html', 'Chapter II', 'mhc1.Gen.iv.html', 'This chapter is an appendix to the history of the creation'],
  ];
  for (const [file, title, next, sample] of pages) {
    const base = 'https://ccel.org/ccel/henry/mhc1/';
    const ex = extractPage(fs.readFileSync(fixture('ccel', file), 'utf8'), base + file);
    assert.equal(ex.title, title);
    assert.equal(ex.next, base + next);
    assert.equal(ex.bookTitle, 'Commentary on the Whole Bible Volume I (Genesis to Deuteronomy)');
    assert.deepEqual(ex.authors, ['Matthew Henry']);
    const text = ex.blocks.map((b) => b.x).join('\n');
    assert.ok(text.includes(sample), `${file}: ${sample}`);
    assert.ok(!/Prev|Next »|Theme|Text Size/.test(text), `${file}: navigation removed`);
    assert.ok(!ex.blocks.some((b) => /^\d+$/.test(b.x)), `${file}: page numbers removed`);
  }
});

test('other pages: Readability, and only same-site next links', () => {
  const para = `<p>${'Plain words for plain people, set down at some length so the page has a body. '.repeat(8)}</p>`;
  const html = (head, foot) =>
    `<html><head><title>Talk One</title>${head}</head><body><article><h1>Talk One</h1>${para}${para}</article>${foot}</body></html>`;
  const url = 'https://example.org/talks/1.html';
  const a = extractPage(html('<link rel="next" href="https://elsewhere.example/2.html">', '<a href="/talks/2.html">Next page</a>'), url);
  assert.equal(a.next, 'https://example.org/talks/2.html');
  assert.equal(a.title, 'Talk One');
  assert.ok(a.blocks.some((b) => b.t === 'p' && b.x.startsWith('Plain words')));
  assert.equal(extractPage(html('', '<a href="https://elsewhere.example/2">다음 글</a>'), url).next, null);
  assert.equal(extractPage(html('', '<a href="/talks/2.html">다음 글</a>'), url).next, 'https://example.org/talks/2.html');
  assert.equal(extractPage(html('', '<a href="/talks/2.html">Nextcloud</a>'), url).next, null);
  assert.equal(extractPage(html('', '<a href="2.html#top">Older »</a>'), url).next, 'https://example.org/talks/2.html');
});

test('paper.html uses LaTeXML classes, block ids, and text that matches book.json', () => {
  const book = {
    chapters: [
      { id: 'c1', title: 'A & B', blocks: [{ t: 'h', x: 'A & B.' }, { t: 'p', x: 'x < y and "q" > z' }] },
      { id: 'c2', title: 'Two', blocks: [{ t: 'p', x: 'Second.' }] },
    ],
  };
  const { document } = parseHTML(`<html><body>${renderHtml(book)}</body></html>`);
  const article = document.querySelector('article.ltx_document.book');
  assert.ok(article);
  const sections = article.querySelectorAll('section.ltx_section');
  assert.deepEqual(
    [...sections].map((s) => [s.id, s.getAttribute('data-chapter'), s.querySelector('h2.ltx_title.ltx_title_section').textContent]),
    [
      ['c1', 'c1', 'A & B'],
      ['c2', 'c2', 'Two'],
    ],
  );
  const h3 = article.querySelector('h3.ltx_title.ltx_title_paragraph');
  assert.equal(h3.id, 'c1.0');
  assert.equal(h3.getAttribute('data-b'), 'c1.0');
  const para = article.querySelector('[data-b="c1.1"]');
  assert.ok(para.matches('div.ltx_para'));
  assert.ok(para.querySelector('p.ltx_p'));
  for (const el of article.querySelectorAll('[data-b]')) {
    const [cid, i] = el.getAttribute('data-b').split('.');
    assert.equal(el.id, el.getAttribute('data-b'));
    assert.equal(el.textContent, book.chapters.find((c) => c.id === cid).blocks[Number(i)].x);
  }
});

test('a book written with LaTeX: formulas in k-tex, bold, boxes and tables, its text still the stored text', () => {
  const cells = [
    ['기호', '뜻'],
    ['$\\theta$', '각도 | 회전'],
  ];
  const blocks = [
    { t: 'h', x: '5. 기울기 $\\nabla f$' },
    { t: 'p', x: '**그림.** 등고선 $a<b$ 와 $$\\frac{1}{2}$$ 끝' },
    { t: 'p', x: '**제목** 안의 **$x$ 굵게', q: 'tip' },
    { t: 'tb', x: cells.map((r) => r.join(' | ')).join('\n'), cells, q: 'note' },
    { t: 'tb', x: 'not the cells', cells },
    { t: 'p', x: '값 $5 와 **별', q: 'bad" onclick="x' },
  ];
  const book = { math: true, chapters: [{ id: 'c1', title: 'One', blocks }] };
  const { document } = parseHTML(`<html><body>${renderHtml(book)}</body></html>`);
  const at = (i) => document.querySelector(`[data-b="c1.${i}"]`);
  blocks.forEach((b, i) => assert.equal(at(i).textContent, b.x, `block ${i}`));
  assert.deepEqual(
    [...document.querySelectorAll('k-tex')].map((k) => [k.textContent, k.classList.contains('d')]),
    [
      ['$\\nabla f$', false],
      ['$a<b$', false],
      ['$$\\frac{1}{2}$$', true],
      ['$x$', false],
      ['$\\theta$', false],
    ],
  );
  assert.equal(at(1).querySelector('b').textContent, '**그림.**');
  assert.equal(at(2).querySelectorAll('b')[1].textContent, '**$x$ 굵게');
  assert.ok(at(2).matches('.ltx_para.q-tip'));
  assert.ok(at(3).matches('.ltx_para.tbl.q-note'));
  assert.deepEqual([...at(3).querySelectorAll('th, td')].map((c) => c.localName), ['th', 'th', 'td', 'td']);
  assert.ok(!at(4).querySelector('table'), 'cells that are not its text: a paragraph');
  assert.equal(at(5).getAttribute('class'), 'ltx_para', 'only known boxes');
  assert.ok(!at(5).querySelector('k-tex'));
  // Any other book: the same text, no markup.
  const plain = parseHTML(`<html><body>${renderHtml({ chapters: book.chapters })}</body></html>`).document;
  assert.equal(plain.querySelectorAll('k-tex, b, table, .mk, [class*=" q-"]').length, 0);
  blocks.forEach((b, i) => assert.equal(plain.querySelector(`[data-b="c1.${i}"]`).textContent, b.x));
});

// ---- through the server ----------------------------------------------------------------------

function upload(base, cookie, name, body, type = 'text/plain') {
  return fetch(`${base}/api/papers/upload`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': type, 'X-File-Name': encodeURIComponent(name), 'X-UI-Lang': 'en' },
    body,
  }).then(async (res) => ({ status: res.status, data: await res.json() }));
}

const words = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(' ');
const TXT = `My Book\n\nChapter 1\n\n${words(160, 'first')}\n\nChapter 2\n\n${words(160, 'second')}\n`;
const bookJson = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'papers', id, 'book.json'), 'utf8'));

test('an uploaded text file becomes a book that opens in HTML mode, and a re-import keeps its state', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const res = await upload(srv.url, cookie, 'My_Book.txt', TXT);
    assert.equal(res.status, 200);
    const { id } = res.data.paper;
    assert.match(id, /^txt-[0-9a-f]{12}$/);
    assert.equal(res.data.paper.kind, 'book');
    assert.equal(res.data.paper.source, 'txt');
    assert.equal(res.data.paper.title, 'My Book');
    assert.ok(['processing', 'ready'].includes(res.data.paper.book.status));
    const ready = await waitForPaper(srv.url, cookie, id, (m) => m.book.status === 'ready');
    assert.equal(ready.book.chapters, 3);
    assert.deepEqual(ready.html, { status: 'ok', baseUrl: 'https://book.invalid/' });

    const html = await api(srv.url, 'GET', `/api/papers/${id}/html`, { cookie });
    assert.equal(html.status, 200);
    assert.equal(html.data.baseUrl, 'https://book.invalid/');
    assert.match(html.data.html, /<section class="ltx_section" id="c2" data-chapter="c2">/);
    assert.equal((await api(srv.url, 'GET', `/api/papers/${id}/pdf`, { cookie })).status, 404);

    // Reading position and summaries survive importing the same file again.
    await api(srv.url, 'PATCH', `/api/papers/${id}`, { cookie, body: { progress: { anchorId: 'c2.1', offset: 0, ratio: 0.5 } } });
    const file = path.join(srv.dataDir, 'papers', id, 'book.json');
    const book = bookJson(srv.dataDir, id);
    fs.writeFileSync(file, JSON.stringify({ ...book, summaries: { c2: 'First.', c3: 'Second.' }, brief: 'A test book.' }));
    const again = await upload(srv.url, cookie, 'renamed.txt', TXT);
    assert.equal(again.data.paper.id, id);
    assert.equal(again.data.paper.book.status, 'ready');
    assert.equal(again.data.paper.progress.anchorId, 'c2.1');
    const after = bookJson(srv.dataDir, id);
    assert.deepEqual(after.chapters, book.chapters);
    assert.deepEqual(after.summaries, { c2: 'First.', c3: 'Second.' });

    const junk = await upload(srv.url, cookie, 'image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]), 'image/png');
    assert.equal(junk.status, 422);
    const latin1 = await upload(srv.url, cookie, 'old.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    assert.equal(latin1.status, 422, 'not UTF-8');
  } finally {
    await srv.stop();
  }
});

test('a book made from text takes more chapters (at the end or before one) and new titles; its ids stay', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const { id } = (await upload(srv.url, cookie, 'My_Book.txt', TXT)).data.paper;
    await waitForPaper(srv.url, cookie, id, (m) => m.book.status === 'ready');
    const before = bookJson(srv.dataDir, id).chapters;
    const add = [
      { title: '  Last  one ', blocks: [{ t: 'h', x: 'I. A HEAD' }, { t: 'p', x: 'Its words.' }] },
      { title: 'Early', blocks: [{ t: 'p', x: 'Before\r\nthe   second.\u0000' }], before: 'c2' },
    ];
    const res = await api(srv.url, 'POST', `/api/papers/${id}/chapters`, { cookie, body: { add, titles: { c1: 'Guide' } } });
    assert.equal(res.status, 200);
    assert.equal(res.data.paper.book.chapters, before.length + 2);
    const after = bookJson(srv.dataDir, id).chapters;
    const n = before.length;
    assert.deepEqual(after.map((c) => c.id), ['c1', `c${n + 2}`, ...before.slice(1).map((c) => c.id), `c${n + 1}`]);
    assert.deepEqual(after.map((c) => c.title).slice(0, 2), ['Guide', 'Early']);
    assert.equal(after[1].blocks[0].x, 'Before the second.', 'kept as the page shows it: no CR, NUL or runs of spaces');
    assert.equal(after.at(-1).title, 'Last one');
    assert.deepEqual(after.slice(2, -1).map((c) => c.blocks), before.slice(1).map((c) => c.blocks), 'the chapters there are untouched');
    const html = await api(srv.url, 'GET', `/api/papers/${id}/html`, { cookie });
    assert.match(html.data.html, new RegExp(`<section class="ltx_section" id="c${n + 1}" data-chapter="c${n + 1}">`));
    assert.match(html.data.html, /<h2 class="ltx_title ltx_title_section">Guide<\/h2>/);

    for (const body of [{}, { add: [{ title: 'x', blocks: [] }] }, { add: [{ title: 'x', blocks: [{ t: 'img', x: 'y' }] }] }, { titles: { c1: '' } }]) {
      assert.equal((await api(srv.url, 'POST', `/api/papers/${id}/chapters`, { cookie, body })).status, 400, JSON.stringify(body));
    }
    const unknown = await api(srv.url, 'POST', `/api/papers/${id}/chapters`, { cookie, body: { add, titles: { c99: 'No' } } });
    assert.equal(unknown.status, 400);
    assert.deepEqual(bookJson(srv.dataDir, id).chapters, after, 'nothing changes when a chapter named is not there');
  } finally {
    await srv.stop();
  }
});

test('a missing OCR/PDF tool marks the book as failed with a clear message', async () => {
  const emptyPath = tempDir();
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PATH: emptyPath } });
  try {
    const cookie = await signIn(srv.url, PW);
    const pdf = Buffer.from('%PDF-1.4\n%test\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const res = await upload(srv.url, cookie, 'scan.pdf', pdf, 'application/pdf');
    assert.equal(res.status, 200);
    assert.match(res.data.paper.id, /^pdf-/);
    const meta = await waitForPaper(srv.url, cookie, res.data.paper.id, (m) => m.book.status !== 'processing');
    assert.equal(meta.book.status, 'error');
    assert.match(meta.book.error, /pdfinfo is not installed/);
  } finally {
    await srv.stop();
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});

// A text book on disk, as the server left it.
function txtBook(dir, id, { source = TXT, status = 'processing', book = {}, extra = {} } = {}) {
  const folder = path.join(dir, 'papers', id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'source.txt'), source);
  const json = typeof book === 'string' ? book : JSON.stringify({ version: 1, chapters: [], brief: '', summaries: {}, usage: {}, next: null, ...book });
  fs.writeFileSync(path.join(folder, 'book.json'), json);
  fs.writeFileSync(
    path.join(folder, 'meta.json'),
    JSON.stringify({
      id,
      kind: 'book',
      source: 'txt',
      title: 'On disk',
      createdAt: new Date().toISOString(),
      book: { status, step: 'extract', progress: 0, error: '', chapters: 0, ocr: false, summaries: 0, ...extra },
      html: { status: 'none' },
    }),
  );
  return folder;
}

test('at startup, a book that was processing is built again, but only once', async () => {
  const dir = tempDir();
  txtBook(dir, 'txt-000000000001');
  txtBook(dir, 'txt-000000000002', { extra: { resumed: 1 } });
  txtBook(dir, 'txt-000000000003', { source: '' });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const built = await waitForPaper(srv.url, cookie, 'txt-000000000001', (m) => m.book.status === 'ready');
    assert.equal(built.book.chapters, 3);
    assert.equal(built.book.resumed, 1);
    const twice = await waitForPaper(srv.url, cookie, 'txt-000000000002', (m) => m.book.status !== 'processing');
    assert.equal(twice.book.status, 'error');
    assert.match(twice.book.error, /cut short twice/);
    const placeholder = await waitForPaper(srv.url, cookie, 'txt-000000000003', (m) => m.book.status !== 'processing');
    assert.equal(placeholder.book.status, 'error');
    assert.match(placeholder.book.error, /couldn't be read/);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importing a book again keeps the chapters it has, and never writes over an unreadable book.json', async () => {
  const dir = tempDir();
  const id = `txt-${crypto.createHash('sha1').update(TXT).digest('hex').slice(0, 12)}`;
  const kept = [{ id: 'c1', title: 'Kept', blocks: [{ t: 'p', x: 'Annotated text.' }], pages: null, url: null }];
  txtBook(dir, id, { status: 'error', book: { chapters: kept, summaries: { c1: 'S.' } } });
  const other = `${TXT}\nmore`;
  const otherId = `txt-${crypto.createHash('sha1').update(other).digest('hex').slice(0, 12)}`;
  const placeholder = path.join(txtBook(dir, otherId, { status: 'error', source: other, book: '' }), 'book.json');
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const again = await upload(srv.url, cookie, 'again.txt', TXT);
    assert.equal(again.data.paper.id, id);
    const meta = await waitForPaper(srv.url, cookie, id, (m) => m.book.status === 'ready');
    assert.equal(meta.book.chapters, 1);
    assert.deepEqual(bookJson(dir, id).chapters, kept);
    assert.deepEqual(bookJson(dir, id).summaries, { c1: 'S.' });

    const refused = await upload(srv.url, cookie, 'other.txt', other);
    assert.equal(refused.status, 503);
    assert.equal(fs.statSync(placeholder).size, 0);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a book whose text takes too long to read is stopped and marked as failed', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_PARSE_TIMEOUT_MS: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    const res = await upload(srv.url, cookie, 'slow.txt', TXT);
    const meta = await waitForPaper(srv.url, cookie, res.data.paper.id, (m) => m.book.status !== 'processing');
    assert.equal(meta.book.status, 'error');
    assert.match(meta.book.error, /took too long/);
  } finally {
    await srv.stop();
  }
});

// Stand-ins for poppler and tesseract that log their arguments (shell builtins only: PATH is
// just this folder). pdftoppm fails on page `fail`; tesseract's hOCR of every page is `hocr`.
function fakeTools(dir, pdfinfo, { hocr = '', fail = 0 } = {}) {
  const log = path.join(dir, 'calls.log');
  const tool = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const cat = (name) => `while IFS= read -r line; do printf '%s\\n' "$line"; done < '${path.join(dir, name)}'`;
  fs.writeFileSync(path.join(dir, 'pdfinfo.txt'), pdfinfo);
  fs.writeFileSync(path.join(dir, 'page.hocr'), hocr);
  tool('pdfinfo', cat('pdfinfo.txt'));
  tool('pdftotext', `printf '\\f\\f'`);
  tool('pdftoppm', `echo "pdftoppm $*" >> '${log}'; case " $* " in *" -f ${fail} "*) exit 1;; esac; for a; do last=$a; done; : > "$last.png"`);
  // "tesseract page.png base txt hocr" writes base.txt and base.hocr.
  tool('tesseract', `echo 'Some words read from the page.' > "$2.txt"; ${cat('page.hocr')} > "$2.hocr"`);
  return () => fs.readFileSync(log, 'utf8').trim().split('\n');
}

test('PDFs over 3000 pages are refused; oversized pages are rendered at 4000 px', { skip: process.platform === 'win32' && 'the stand-ins are sh scripts; Windows runs only .exe files without a shell' }, async () => {
  const bin = tempDir();
  const calls = fakeTools(bin, 'Pages:          2\nPage    1 size: 612 x 792 pts\nPage    2 size: 3000 x 4000 pts\n');
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PATH: bin } });
  try {
    const cookie = await signIn(srv.url, PW);
    const pdf = (n) => Buffer.from(`%PDF-1.4\n%${n}\n%%EOF\n`);
    const res = await upload(srv.url, cookie, 'scan.pdf', pdf(1), 'application/pdf');
    const meta = await waitForPaper(srv.url, cookie, res.data.paper.id, (m) => m.book.status !== 'processing');
    assert.equal(meta.book.status, 'ready', meta.book.error);
    const [one, two] = calls().sort();
    assert.match(one, /^pdftoppm -r 300 -gray -png -f 1 -l 1 /);
    assert.match(two, /^pdftoppm -scale-to 4000 -gray -png -f 2 -l 2 /);

    fs.writeFileSync(path.join(bin, 'pdfinfo.txt'), 'Pages:          3001\n');
    const big = await upload(srv.url, cookie, 'huge.pdf', pdf(2), 'application/pdf');
    const refused = await waitForPaper(srv.url, cookie, big.data.paper.id, (m) => m.book.status !== 'processing');
    assert.equal(refused.book.status, 'error');
    assert.match(refused.book.error, /too many pages \(at most 3000\)/);
  } finally {
    await srv.stop();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('the picture pass of a scanned book at startup: a page that fails has none, and the others are still placed', { skip: process.platform === 'win32' && 'the stand-ins are sh scripts; Windows runs only .exe files without a shell' }, async () => {
  const bin = tempDir();
  const hocr = `<div class='ocr_page' id='page_1' title='bbox 0 0 2550 3300'>\n<div class='ocr_photo' id='block_1_1' title="bbox 300 400 2200 1800"></div>\n</div>\n`;
  fakeTools(bin, 'Pages:          2\nPage    1 size: 612 x 792 pts\nPage    2 size: 612 x 792 pts\n', { hocr, fail: 1 });
  const dir = tempDir();
  writeBookFixture(dir, 'pdf-scan', { ocr: true, chapters: [{ id: 'c1', title: 'One', blocks: [{ t: 'p', x: 'One.' }], pages: [1, 2], url: null }] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, PATH: bin } });
  try {
    const book = () => {
      try {
        return bookJson(dir, 'pdf-scan');
      } catch {
        return {}; // being replaced
      }
    };
    assert.ok(await waitFor(() => book().figures, 10000));
    assert.deepEqual(book().figures, [{ id: 'p2-1', chapter: 'c1', before: 1, page: 2, w: 958, h: 708 }]);
    assert.equal(book().figureTries, 1);
    const log = fs.readFileSync(srv.logFile, 'utf8');
    assert.match(log, /\[ocr\] page 1: book\.toolFailed/);
    assert.match(log, /\[figures\] pdf-scan: no hOCR for 1 of 2 pages/);
    assert.ok(fs.readFileSync(path.join(dir, 'papers', 'pdf-scan', 'paper.html'), 'utf8').includes('<img data-fig="p2-1.png" width="958" height="708" alt="">'));
  } finally {
    await srv.stop();
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the pictures of a scanned book are looked for at startup twice at most, each try counted first; a resumed import gets its own pass', async () => {
  const dir = tempDir();
  const emptyPath = tempDir();
  const chapters = [{ id: 'c1', title: 'One', blocks: [{ t: 'p', x: 'One.' }], pages: [1, 1], url: null }];
  for (const [id, figureTries] of [
    ['pdf-new', undefined],
    ['pdf-once', 1],
    ['pdf-twice', 2],
  ]) {
    const book = writeBookFixture(dir, id, { ocr: true, chapters });
    fs.writeFileSync(path.join(dir, 'papers', id, 'book.json'), JSON.stringify({ ...book, figureTries }));
  }
  // Stopped while it was being built, after its chapters were read: the import resumes without its OCR.
  writeBookFixture(dir, 'pdf-resumed', { chapters, meta: { book: { status: 'processing', step: 'chapters', progress: 1, error: '', ocr: true } } });
  // No pdfinfo: each pass fails at once.
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, PATH: emptyPath } });
  try {
    const log = () => fs.readFileSync(srv.logFile, 'utf8');
    assert.ok(await waitFor(() => ['pdf-new', 'pdf-once', 'pdf-resumed'].every((id) => log().includes(`[figures] ${id}: book.toolMissing`)), 10000));
    await sleep(300);
    assert.deepEqual(['pdf-new', 'pdf-once', 'pdf-twice', 'pdf-resumed'].map((id) => bookJson(dir, id).figureTries), [1, 2, 2, 1]);
    assert.doesNotMatch(log(), /pdf-twice/, 'tried twice already: left alone');
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});

test('a second machine cannot start on the same data folder while the first is alive', async () => {
  const dir = tempDir();
  const lock = path.join(dir, 'server.lock');
  fs.writeFileSync(lock, JSON.stringify({ host: 'other-host.invalid', pid: 1, at: new Date().toISOString() }));
  await assert.rejects(startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } }), /Another server \(other-host\.invalid/);
  const forced = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, FORCE_START: '1' } });
  await forced.stop();
  fs.writeFileSync(lock, JSON.stringify({ host: 'other-host.invalid', pid: 1, at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  const stale = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    assert.notEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).host, 'other-host.invalid');
  } finally {
    await stale.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('on Windows the server stops, as with Ctrl+C, when the conhost that start.ps1 runs in is gone', { skip: process.platform !== 'win32' && 'the server watches its parent and console host on Windows only' }, async () => {
  const dir = tempDir();
  const conhost = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  conhost.unref(); // a server that fails to start must not keep the tests waiting for it
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_WATCH_PID: String(conhost.pid) } });
  try {
    assert.ok(fs.existsSync(path.join(dir, 'server.lock')));
    conhost.kill();
    // Checked every 5 s; a stop like Ctrl+C's takes its heartbeat away.
    assert.ok(await waitFor(() => !fs.existsSync(path.join(dir, 'server.lock')), 9000), 'stopped');
    assert.match(srv.output(), /parent gone; stopping/);
  } finally {
    conhost.kill();
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A small site of numbered pages, each linking to the next one.
async function site(count) {
  const server = http.createServer((req, res) => {
    const n = Number(/^\/p(\d+)\.html$/.exec(req.url)?.[1]);
    if (!(n >= 1 && n <= count)) return res.writeHead(404).end();
    const next = n < count ? `<footer><a href="/p${n + 1}.html">Next »</a></footer>` : '';
    const body = [1, 2, 3].map((k) => `<p>${words(60, `s${n}w${k}x`)}.</p>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Sermon ${n}</title></head><body><article><h1>Sermon ${n}</h1>${body}</article>${next}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

test('a web page without a PDF becomes a book that follows its next links', async () => {
  const pages = await site(4);
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_ALLOW_PRIVATE_URLS: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    const res = await api(srv.url, 'POST', '/api/papers/import', { cookie, body: { input: `${pages.url}/p1.html`, follow: 2 } });
    assert.equal(res.status, 200);
    const { id } = res.data.paper;
    assert.match(id, /^web-[0-9a-f]{12}$/);
    assert.equal(res.data.paper.source, 'web');
    const meta = await waitForPaper(srv.url, cookie, id, (m) => m.book.status === 'ready');
    assert.equal(meta.book.chapters, 3);
    let book = bookJson(srv.dataDir, id);
    assert.deepEqual(
      book.chapters.map((c) => [c.id, c.title, c.url]),
      [1, 2, 3].map((n) => [`c${n}`, `Sermon ${n}`, `${pages.url}/p${n}.html`]),
    );
    assert.equal(book.next, `${pages.url}/p4.html`);
    const html = await api(srv.url, 'GET', `/api/papers/${id}/html`, { cookie });
    assert.equal(html.status, 200);
    assert.equal(html.data.baseUrl, `${pages.url}/p1.html`);

    const more = await api(srv.url, 'POST', `/api/papers/${id}/chapters/next`, { cookie, body: { count: 5 } });
    assert.equal(more.status, 200);
    assert.equal(more.data.paper.book.chapters, 4);
    book = bookJson(srv.dataDir, id);
    assert.equal(book.chapters.at(-1).id, 'c4');
    assert.equal(book.next, null);
    assert.equal((await api(srv.url, 'POST', `/api/papers/${id}/chapters/next`, { cookie, body: { count: 1 } })).status, 422);
    assert.equal((await api(srv.url, 'POST', `/api/papers/${id}/chapters/next`, { cookie, body: { count: 21 } })).status, 400);
    // Importing the same link again returns the book as it is.
    const again = await api(srv.url, 'POST', '/api/papers/import', { cookie, body: { input: `${pages.url}/p1.html` } });
    assert.equal(again.data.paper.id, id);
    assert.equal(again.data.paper.book.chapters, 4);
  } finally {
    await srv.stop();
    await pages.close();
  }
});

test('web pages are read in their declared charset, and pages over 8 MB are refused', async () => {
  const body = (title) => `<html><head>${title}</head><body><article><h1>Caf\xe9</h1><p>${'Le caf\xe9 est pr\xeat, et la cr\xe8me aussi. '.repeat(30)}</p></article></body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/header.html') res.writeHead(200, { 'Content-Type': 'text/html; charset=windows-1252' }).end(Buffer.from(body('<title>A</title>'), 'latin1'));
    else if (req.url === '/meta.html') res.writeHead(200, { 'Content-Type': 'text/html' }).end(Buffer.from(body('<meta charset="iso-8859-1"><title>B</title>'), 'latin1'));
    else res.writeHead(200, { 'Content-Type': 'text/html' }).end(Buffer.alloc(9 * 1024 * 1024, 'a'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_ALLOW_PRIVATE_URLS: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    for (const page of ['header', 'meta']) {
      const res = await api(srv.url, 'POST', '/api/papers/import', { cookie, body: { input: `${base}/${page}.html` } });
      assert.equal(res.status, 200, page);
      assert.match(textOf(bookJson(srv.dataDir, res.data.paper.id).chapters[0]), /Le café est prêt, et la crème aussi\./, page);
    }
    const huge = await api(srv.url, 'POST', '/api/papers/import', { cookie, body: { input: `${base}/huge.html` }, headers: { 'X-UI-Lang': 'en' } });
    assert.equal(huge.status, 413);
    assert.match(huge.data.error, /over 8 MB/);
  } finally {
    await srv.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('appending chapters while summaries are being written loses nothing', async () => {
  const pages = await site(4);
  const stub = await anthropicStub(async (body) => ({
    delayMs: 600,
    text: body.max_tokens === 400 ? `Summary of ${/<chapter title="([^"]+)"/.exec(body.messages[0].content)?.[1]}.` : 'The brief.',
  }));
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_ALLOW_PRIVATE_URLS: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const res = await api(srv.url, 'POST', '/api/papers/import', { cookie, body: { input: `${pages.url}/p1.html` } });
    const { id } = res.data.paper;
    assert.equal(res.data.paper.book.status, 'ready');
    await waitFor(() => stub.requests.length > 0);
    const more = await api(srv.url, 'POST', `/api/papers/${id}/chapters/next`, { cookie, body: { count: 3 } });
    assert.equal(more.data.paper.book.chapters, 4);
    const meta = await waitForPaper(srv.url, cookie, id, (m) => m.book.summaries === 4 && m.book.step === 'done', 30000);
    assert.equal(meta.book.summaries, 4);
    await sleep(100);
    const book = bookJson(srv.dataDir, id);
    assert.deepEqual(
      book.chapters.map((c) => c.id),
      ['c1', 'c2', 'c3', 'c4'],
    );
    assert.deepEqual(book.summaries, { c1: 'Summary of Sermon 1.', c2: 'Summary of Sermon 2.', c3: 'Summary of Sermon 3.', c4: 'Summary of Sermon 4.' });
    assert.equal(book.brief, 'The brief.');
    const calls = stub.requests.filter((r) => !r.stream);
    assert.equal(calls.length, 5);
    assert.ok(calls.every((r) => r.model === 'claude-haiku-5-5' && r.thinking.type === 'disabled'));
    assert.deepEqual(book.usage, { input_tokens: 50, output_tokens: 25 });
  } finally {
    await srv.stop();
    await stub.close();
    await pages.close();
  }
});

test('a journal article: one chapter laid out as printed, each block with its part on the page', () => {
  const blocks = [
    { t: 'p', x: 'SECTION', r: 'kicker' },
    { t: 'h', x: 'A Study of Examples', r: 'title' },
    { t: 'h', x: 'Introduction', r: 'sec' },
    { t: 'p', x: 'A force $F$ on a body.' },
    { t: 'p', x: '**Fig. 1.** In a column.', r: 'cap' },
    { t: 'p', x: '**Fig. 2.** Across the page.', r: 'cap' },
    { t: 'p', x: 'No such part', r: 'x" onclick="y' },
  ];
  const figures = [
    { id: 'p2-1', chapter: 'c1', before: 4, w: 396, h: 217, narrow: true },
    { id: 'p3-1', chapter: 'c1', before: 5, w: 804, h: 250 },
  ];
  const book = { math: true, layout: 'paper', chapters: [{ id: 'c1', title: 'Journal of Examples | Research Article', blocks }], figures };
  const { document } = parseHTML(`<html><body>${renderHtml(book)}</body></html>`);
  const at = (i) => document.querySelector(`[data-b="c1.${i}"]`);
  blocks.forEach((b, i) => assert.equal(at(i).textContent, b.x, `block ${i}`));
  assert.ok(document.querySelector('article').matches('.ltx_document.book.paper'));
  assert.ok(at(0).matches('div.ltx_para.r-kicker'));
  assert.ok(at(1).matches('h3.ltx_title.r-title') && at(2).matches('h3.ltx_title.r-sec'));
  assert.ok(at(4).matches('.r-cap') && at(4).previousElementSibling.matches('figure.book-fig.narrow'));
  assert.ok(at(5).previousElementSibling.matches('figure.book-fig:not(.narrow)'));
  assert.equal(at(6).getAttribute('class'), 'ltx_para', 'only known parts');
  // A book without a layout, its blocks without parts: as before.
  const plain = parseHTML(`<html><body>${renderHtml({ chapters: [{ id: 'c1', title: 'One', blocks: blocks.map(({ r, ...b }) => b) }], figures })}</body></html>`).document;
  assert.equal(plain.querySelector('article').getAttribute('class'), 'ltx_document book');
  assert.equal(plain.querySelectorAll('[class*=" r-"]').length, 0);
});

test('a chapter translated from a scan: each block says where it stands in the original pages, its footnotes small after it', () => {
  const blocks = [
    { t: 'h', x: '2.1 연속과 극한', r: 'sec', o: [{ page: 20, box: [0.1, 0.4, 0.9, 0.45] }] },
    { t: 'p', x: '양쪽 극한값 사이에는$^{2}$ 다음 조건이 성립한다.', o: [{ page: 20, box: [0.1, 0.8, 0.9, 0.95] }, { page: 21, box: [0.1, 0.05, 0.9, 0.12345678] }] },
    { t: 'p', x: '달리 명시하지 않는 한 …', r: 'fn', o: [{ page: 20, box: [0.1, 0.95, 0.9, 1] }] },
    { t: 'p', x: 'no box', o: [{ page: 20, box: [0.5, 0.1, 0.4, 0.2] }] },
    { t: 'p', x: 'not a page', o: [{ page: '20" onclick="x', box: [0, 0, 1, 1] }] },
  ];
  const { document } = parseHTML(`<html><body>${renderHtml({ math: true, chapters: [{ id: 'c2', title: '함수의 극한', blocks }] })}</body></html>`);
  const at = (i) => document.querySelector(`[data-b="c2.${i}"]`);
  blocks.forEach((b, i) => assert.equal(at(i).textContent, b.x, `block ${i}`));
  assert.equal(at(0).getAttribute('data-orig'), '20:0.1,0.4,0.9,0.45');
  assert.equal(at(1).getAttribute('data-orig'), '20:0.1,0.8,0.9,0.95 21:0.1,0.05,0.9,0.1235');
  assert.ok(at(2).matches('.ltx_para.r-fn'));
  assert.equal(at(3).getAttribute('data-orig'), null, 'a box the wrong way round');
  assert.equal(at(4).getAttribute('data-orig'), null);
});

test('a book written with LaTeX: italic, money, an escaped dollar, and a table with an empty row', () => {
  const blocks = [
    { t: 'p', x: '*걸음 1, 기울기.* 다음 Doe1* 그리고 끝' },
    { t: 'p', x: 'It costs $5 and $10, or \\$3.' },
    { t: 'tb', x: 'a\n\nb', cells: [['a'], [], ['b']] },
  ];
  const { document } = parseHTML(`<html><body>${renderHtml({ math: true, chapters: [{ id: 'c1', title: 'One', blocks }] })}</body></html>`);
  blocks.forEach((b, i) => assert.equal(document.querySelector(`[data-b="c1.${i}"]`).textContent, b.x, `block ${i}`));
  assert.deepEqual([...document.querySelectorAll('[data-b="c1.0"] i')].map((el) => el.textContent), ['*걸음 1, 기울기.*']);
  assert.equal(document.querySelectorAll('k-tex').length, 0);
  assert.ok(!document.querySelector('[data-b="c1.2"] table'), 'an empty row: a paragraph');
});
