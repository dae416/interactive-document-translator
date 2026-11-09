// The system prompt of book threads, and what book requests send to the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { anthropicStub, api, chat, signIn, startServer, tempDir, useStub, writeBookFixture } from './helpers.js';

const { buildSystem, bookBlock } = await import('../server/context.js');

const PW = 'test-password';
const words = (n, w = 'word') => Array.from({ length: n }, () => w).join(' ');
const CHAPTERS = [
  { id: 'c1', title: 'Front matter', blocks: [{ t: 'p', x: 'Title page.' }], pages: null, url: null },
  { id: 'c2', title: 'To the Idle', blocks: [{ t: 'h', x: 'TO THE IDLE.' }, { t: 'p', x: words(200, 'idle') }], pages: null, url: null },
  { id: 'c3', title: 'On "Gossips"', blocks: [{ t: 'h', x: 'ON GOSSIPS.' }, { t: 'p', x: words(200, 'talk') }], pages: null, url: null },
];
const META = { title: 'John Ploughman’s Talk', authors: ['C. H. Spurgeon'] };

test('the system array is byte-identical across calls, with 1-hour cache breakpoints on blocks 2 and 3', () => {
  const book = { chapters: CHAPTERS, brief: 'A brief.', summaries: { c2: 'Idleness.' } };
  const a = buildSystem(META, book, CHAPTERS[1], '한국어');
  const b = buildSystem(structuredClone(META), structuredClone(book), structuredClone(CHAPTERS[1]), '한국어');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.length, 3);
  assert.equal(a[0].cache_control, undefined);
  assert.match(a[0].text, /Answer in 한국어\./);
  assert.match(a[0].text, /^Selection lang="ko": part of the Korean translation/m);
  for (const block of a.slice(1)) assert.deepEqual(block.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.match(a[2].text, /^<current_chapter id="c2" title="To the Idle">\nTO THE IDLE\.\n\nidle idle/);
  assert.notEqual(JSON.stringify(buildSystem(META, book, CHAPTERS[1], 'English')), JSON.stringify(a));
});

test('a long chapter of sections (a textbook’s, in one tab) sends only the section asked about; a short one, all of it', () => {
  const blocks = [
    { t: 'h', x: 'Math: Vectors', r: 'sec' },
    { t: 'p', x: words(7000, 'vector') },
    { t: 'h', x: 'Limits (1.1)', r: 'sec' },
    { t: 'p', x: words(7000, 'limit') },
    { t: 'p', x: 'the end of 1.1' },
    { t: 'h', x: 'Checks', r: 'sec' },
    { t: 'p', x: words(7000, 'check') },
  ];
  const long = { id: 'c1', title: '1장 해설', blocks, pages: null, url: null };
  const book = { chapters: [long], brief: '', summaries: {} };
  const sent = (at) => buildSystem(META, book, long, '한국어', at)[2].text;
  assert.match(sent(4), /^<current_chapter id="c1" title="1장 해설 — Limits \(1\.1\)">\nLimits \(1\.1\)\n\nlimit limit/);
  assert.ok(sent(4).includes('the end of 1.1') && !sent(4).includes('vector') && !sent(4).includes('check'));
  assert.match(sent(-1), /title="1장 해설 — Math: Vectors"/, 'none asked about: the first section');
  assert.match(sent(6), /title="1장 해설 — Checks"/);
  // A short chapter with heads, and a long one without: all of it.
  const short = { ...long, blocks: [blocks[0], { t: 'p', x: 'short' }, blocks[2], { t: 'p', x: 'also' }] };
  assert.match(buildSystem(META, book, short, '한국어', 3)[2].text, /title="1장 해설">\nMath: Vectors\n\nshort\n\nLimits \(1\.1\)\n\nalso/);
  const plain = { ...long, blocks: blocks.map(({ r, ...b }) => b) };
  assert.ok(buildSystem(META, book, plain, '한국어', 4)[2].text.includes('check check'));
  // What opens a chapter before its first head goes with the first section, under the chapter's
  // own title; a journal article is read whole.
  const opened = { ...long, blocks: [{ t: 'h', x: 'A title' }, { t: 'p', x: 'Authors' }, ...blocks] };
  const first = buildSystem(META, book, opened, '한국어', 1)[2].text;
  assert.match(first, /title="1장 해설">\nA title\n\nAuthors\n\nMath: Vectors\n\nvector/);
  assert.ok(!first.includes('limit'));
  assert.ok(buildSystem(META, { ...book, layout: 'paper' }, long, '한국어', 4)[2].text.includes('vector'), 'an article whole');
});

test('the book block lists every summary, and titles alone for chapters without one', () => {
  const text = bookBlock(META, { chapters: CHAPTERS, brief: 'Plain advice for plain people.', summaries: { c2: 'Against idleness.', c3: 'Against gossip.' } });
  assert.equal(
    text,
    [
      '<book title="John Ploughman’s Talk" author="C. H. Spurgeon">',
      '<brief>Plain advice for plain people.</brief>',
      '<chapter id="c1" title="Front matter"/>',
      '<chapter id="c2" title="To the Idle">Against idleness.</chapter>',
      '<chapter id="c3" title="On &quot;Gossips&quot;">Against gossip.</chapter>',
      '</book>',
    ].join('\n'),
  );
});

test('summaries join the book block only with the brief, so the block changes once', () => {
  const summaries = { c2: 'Against idleness.', c3: 'Against gossip.' };
  const during = bookBlock(META, { chapters: CHAPTERS, brief: '', summaries });
  assert.ok(!during.includes('Against'));
  assert.equal(during, bookBlock(META, { chapters: CHAPTERS, brief: '', summaries: {} }));
  assert.ok(bookBlock(META, { chapters: CHAPTERS, brief: 'Brief.', summaries }).includes('Against gossip.'));
  const odd = bookBlock({ title: 'A & B <c> "d"', authors: [] }, { chapters: [], brief: '', summaries: {} });
  assert.match(odd, /^<book title="A &amp; B &lt;c&gt; &quot;d&quot;" author="">/);
});

test('a book request is checked before streaming starts', async () => {
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: CHAPTERS });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const ask = (book) => chat(srv.url, cookie, { action: 'translate', book, messages: [{ role: 'user', content: 'x' }] });
    const unknown = await ask({ id: 'txt-book', chapter: 'c9' });
    assert.equal(unknown.status, 400);
    assert.ok(unknown.data.error);
    assert.equal((await ask({ id: 'no-such-book', chapter: 'c1' })).status, 404);
    assert.equal((await ask({ id: '../x', chapter: 'c1' })).status, 400);
    assert.equal((await ask('txt-book')).status, 400);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('book threads send the server-built context and replay earlier answers as text only', async () => {
  const stub = await anthropicStub();
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: CHAPTERS, brief: 'Brief.', summaries: { c2: 'S2.', c3: 'S3.' } });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    assert.equal((await useStub(srv.url, cookie, stub)).status, 200);
    const raw = {
      provider: 'anthropic',
      content: [
        { type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
        { type: 'text', text: 'first answer' },
      ],
    };
    const res = await chat(srv.url, cookie, {
      action: 'ask',
      system: 'ignored for books',
      book: { id: 'txt-book', chapter: 'c3' },
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer', raw },
        { role: 'user', content: 'follow-up' },
      ],
    });
    assert.equal(res.events.at(-1).t, 'done');
    const sent = stub.chats().at(-1);
    assert.deepEqual(sent.messages[1], { role: 'assistant', content: 'first answer' });
    assert.equal(sent.system.length, 3);
    assert.ok(!JSON.stringify(sent.system).includes('ignored for books'));
    assert.match(sent.system[2].text, /^<current_chapter id="c3"/);
    assert.deepEqual(sent.system[1].cache_control, { type: 'ephemeral', ttl: '1h' });

    // Paper threads still replay the API's own blocks, thinking included.
    await chat(srv.url, cookie, {
      action: 'ask',
      system: 'paper context',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'first answer', raw },
        { role: 'user', content: 'again' },
      ],
    });
    const paper = stub.chats().at(-1);
    assert.equal(paper.messages[1].content[0].type, 'thinking');
    assert.equal(paper.system[0].text, 'paper context');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default answer language is Korean', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    assert.equal((await api(srv.url, 'GET', '/api/settings', { cookie })).data.prefs.targetLang, '한국어');
  } finally {
    await srv.stop();
  }
});
