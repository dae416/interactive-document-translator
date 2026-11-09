// Chapter translation and the OCR clean-up before it, against an Anthropic stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ROOT, anthropicStub, api, signIn, sleep, startServer, tempDir, useStub, waitFor, waitForPaper, writeBookFixture } from './helpers.js';

const { autoChapters, curly, retryDelay } = await import('../server/translate.js');
const { chaptersFromPages, extractPage } = await import('../server/parse.js');

const PW = 'test-password';
const EN = { 'X-UI-Lang': 'en' };
const h = (x) => ({ t: 'h', x });
const p = (x) => ({ t: 'p', x });
const chapter = (id, title, blocks) => ({ id, title, blocks, pages: null, url: null });
const words = (n, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
const blocksIn = (text) => [...text.matchAll(/<block n="(\d+)">([\s\S]*?)<\/block>/g)].map((m) => [Number(m[1]), m[2]]);
const IDLE = 'T is of no more use to give advice to the idle than to pour water into a sieve.';

function usage(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  } catch {
    return [];
  }
}

// The stub as the saved provider, so jobs started at startup reach it.
function stubConfig(dir, stub) {
  const anthropic = { protocol: 'anthropic', baseUrl: stub.url, apiKey: 'sk-test', model: 'claude-opus-5-5' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ llm: { preset: 'anthropic', providers: { anthropic } } }));
}

// Translates every block it is sent as "번역 <n>"; its reviews change nothing.
function translator(body) {
  const user = body.messages[0].content;
  if (user.includes('<draft>')) return { text: '<none/>' };
  return { text: blocksIn(user).map(([n]) => `<block n="${n}">번역 ${n}</block>`).join('\n') };
}

test('OCR clean-up at startup: fixes are saved and the OCR text kept; rewrites, annotated chapters and other books are left alone', async () => {
  const preface = [
    h('PREFACE.'),
    p('I* “John Ploughman’s Talk” I have written for ploughmen and common people. Hence refined taste and dainty words have been discarded for strong proverbial expres- sions and homely phrases.'),
    p('A pickle jar has these words upon it: “ If you like our pickles, try our sauce,” and so I would add, if you like “ John Ploughman’s Talk,” try his “ Pictures;”'),
    p('S| ® ~ «'),
    p('I have aimed my blows at the vices of the many, and tried to inculcate those moral virtues without which men are degraded.'),
  ];
  const fixed = 'In “John Ploughman’s Talk” I have written for ploughmen and common people. Hence refined taste and dainty words have been discarded for strong proverbial expressions and homely phrases.';
  const replies = {
    [preface[1].x]: fixed,
    [preface[2].x]: 'Jars of pickles often carry slogans, and readers who enjoyed one book by this author should buy the other one too.',
    [preface[3].x]: '', // noise
    [preface[4].x]: '', // a real paragraph
  };
  const stub = await anthropicStub((body) => {
    const user = body.messages[0].content;
    if (!user.startsWith('This is text from a scanned book')) return {};
    return { text: blocksIn(user).map(([n, x]) => `<block n="${n}">${replies[x] ?? x}</block>`).join('\n') };
  });
  const dir = tempDir();
  stubConfig(dir, stub);
  const long = 'x'.repeat(4000);
  writeBookFixture(dir, 'pdf-scan', {
    ocr: true,
    chapters: [chapter('c1', 'Preface', preface), chapter('c2', 'To the Idle', [h('TO THE IDLE.'), p(IDLE)]), chapter('c3', 'Index', [p(long), p(`${long}y`)])],
  });
  writeBookFixture(dir, 'txt-plain', { chapters: [chapter('c1', 'To the Idle', [p(IDLE)])] });
  const at = new Date().toISOString();
  const highlight = { id: 'a_abcdef', type: 'highlight', color: 'yellow', chapter: 'c2', start: { b: 'c2.1', o: 0 }, end: { b: 'c2.1', o: 4 }, quote: 'T is', createdAt: at, updatedAt: at, deleted: false };
  fs.writeFileSync(path.join(dir, 'papers', 'pdf-scan', 'annotations.json'), JSON.stringify({ version: 1, items: [highlight] }));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const book = () => readJson(dir, 'papers', 'pdf-scan', 'book.json');
    await waitFor(() => {
      try {
        const { cleaned } = book();
        return cleaned?.c1 && cleaned.c3;
      } catch {
        return false; // being replaced
      }
    }, 10000);
    const [c1, c2, c3] = book().chapters;
    assert.deepEqual(c1.blocks, [h('PREFACE.'), p(fixed), preface[2], p(''), preface[4]]);
    assert.deepEqual(c2.blocks, [h('TO THE IDLE.'), p(IDLE)]);
    assert.deepEqual(c3.blocks, [p(long), p(`${long}y`)]);
    assert.deepEqual(book().cleaned, { c1: true, c3: true });
    assert.deepEqual(readJson(dir, 'papers', 'pdf-scan', 'raw.json'), { version: 1, chapters: { c1: preface.map((b) => b.x) } });
    const html = fs.readFileSync(path.join(dir, 'papers', 'pdf-scan', 'paper.html'), 'utf8');
    assert.ok(html.includes(`<div class="ltx_para" id="c1.1" data-b="c1.1"><p class="ltx_p">${fixed}</p></div>`));

    // c1 in one call; c3's blocks are too long to share one. Chapters are cleaned three at a
    // time, so the calls come in any order.
    const calls = stub.requests;
    assert.equal(calls.length, 3);
    assert.ok(calls.every((r) => r.model === 'claude-haiku-5-5' && r.thinking?.type === 'disabled' && !r.stream && !r.output_config));
    assert.deepEqual(calls.map((r) => blocksIn(r.messages[0].content).map(([n]) => n).join()).sort(), ['0', '0,1,2,3,4', '1']);
    assert.ok(!JSON.stringify(calls).includes('T is of no more use'), 'neither the annotated chapter nor the other book is sent');
    assert.equal(readJson(dir, 'papers', 'txt-plain', 'book.json').cleaned, undefined);
    await waitFor(() => usage(dir).length === 3);
    assert.deepEqual(usage(dir).map((u) => [u.action, u.paper, u.chapter, u.model].join(' ')).sort(), [
      'clean pdf-scan c1 claude-haiku-5-5',
      'clean pdf-scan c3 claude-haiku-5-5',
      'clean pdf-scan c3 claude-haiku-5-5',
    ]);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a scanned book is cleaned up during its import, three chapters at a time, before it is ready', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const stub = await anthropicStub(async (body) => {
    await gate;
    return { text: blocksIn(body.messages[0].content).map(([n, x]) => `<block n="${n}">${x.replace('T is', 'It is')}</block>`).join('\n') };
  });
  const dir = tempDir();
  stubConfig(dir, stub);
  // Stopped while it was being built, after its chapters were found: the start resumes it.
  const chapters = ['c1', 'c2', 'c3', 'c4'].map((id) => chapter(id, 'To the Idle', [p(IDLE)]));
  writeBookFixture(dir, 'pdf-scan', { chapters, meta: { book: { status: 'processing', step: 'chapters', progress: 1, error: '', ocr: true } } });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await waitFor(() => stub.requests.length === 3, 10000);
    const { book } = (await api(srv.url, 'GET', '/api/papers/pdf-scan', { cookie })).data.paper;
    assert.deepEqual([book.status, book.step, book.progress, stub.requests.length], ['processing', 'clean', 0, 3]);
    release();
    await waitForPaper(srv.url, cookie, 'pdf-scan', (m) => m.book.status === 'ready');
    const fixed = IDLE.replace('T is', 'It is');
    const saved = readJson(dir, 'papers', 'pdf-scan', 'book.json');
    assert.deepEqual(saved.chapters.map((c) => c.blocks[0].x), [fixed, fixed, fixed, fixed]);
    assert.deepEqual(saved.cleaned, { c1: true, c2: true, c3: true, c4: true });
    assert.ok(fs.readFileSync(path.join(dir, 'papers', 'pdf-scan', 'paper.html'), 'utf8').includes(`<div class="ltx_para" id="c4.0" data-b="c4.0"><p class="ltx_p">${fixed}</p></div>`));
    assert.equal(stub.requests.length, 4);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the automatic chapters are the introduction and chapter 1', () => {
  const pick = (chapters) => autoChapters(chapters.map((c, i) => ({ id: `c${i + 1}`, ...c }))).map((c) => `${c.id} ${c.title}`);
  const { pages } = readJson(ROOT, 'test', 'fixtures', 'ploughman-ocr-pages.json');
  assert.deepEqual(pick(chaptersFromPages(pages)), ['c2 Preface', 'c3 To the Idle']);
  const ccel = ['mhc1.Gen.i.html', 'mhc1.Gen.ii.html', 'mhc1.Gen.iii.html'].map((f) =>
    extractPage(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ccel', f), 'utf8'), `https://ccel.org/ccel/henry/mhc1/${f}`),
  );
  assert.deepEqual(pick(ccel), ['c1 Introduction', 'c2 Chapter I']);

  const ch = (title, n = 200) => ({ title, blocks: [p(words(n))] });
  assert.deepEqual(pick([ch('Contents'), ch('Chapter One'), ch('Chapter Two')]), ['c2 Chapter One']);
  assert.deepEqual(pick([ch('Foreword', 100), ch('Prologue'), ch('Book I')]), ['c2 Prologue', 'c3 Book I']);
  assert.deepEqual(pick([ch('Preface'), ch('Introduction'), ch('Chapter 1')]), ['c1 Preface', 'c3 Chapter 1']);
  assert.deepEqual(pick([ch('Chapter 1'), ch('Chapter 2'), ch('Introduction to Part II')]), ['c1 Chapter 1']);
  assert.deepEqual(pick([ch('Front matter'), ch('Index'), ch('Advertisements'), ch('Henry Altemus’ Publications')]), []);
});

test('at startup the introduction and chapter 1 are translated after the summaries, by Opus at max effort, the chapter cached for an hour', async () => {
  const stub = await anthropicStub((body) => {
    if (body.stream) return translator(body);
    return { text: body.max_tokens === 400 ? `Summary of ${/<chapter title="([^"]+)"/.exec(body.messages[0].content)[1]}.` : 'The brief.' };
  });
  const dir = tempDir();
  stubConfig(dir, stub);
  writeBookFixture(dir, 'txt-book', {
    chapters: [
      chapter('c1', 'Front matter', [p(words(300, 'front'))]),
      chapter('c2', 'Preface', [h('PREFACE.'), p(words(200, 'preface'))]),
      chapter('c3', 'To the Idle', [h('TO THE IDLE.'), p(words(200, 'idle'))]),
      chapter('c4', 'On Gossips', [h('ON GOSSIPS.'), p(words(200, 'gossip'))]),
    ],
  });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, TRANSLATE_AUTO: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    const meta = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations?.c2?.status === 'ready' && m.book.translations?.c3?.status === 'ready');
    assert.deepEqual(Object.keys(meta.book.translations), ['c2', 'c3']);
    for (const { queuedAt, startedAt, ...rest } of Object.values(meta.book.translations)) {
      // (Four calls of the stub's few tokens cost under a cent.)
      assert.deepEqual(rest, { status: 'ready', progress: 1, error: '', auto: true, tries: 1, startProgress: 0, spent: 0 });
      assert.ok(Date.parse(queuedAt) <= Date.parse(startedAt), 'when it was queued and started, kept once ready');
    }
    const brief = stub.requests.findIndex((r) => r.max_tokens === 600);
    assert.ok(brief >= 0 && brief < stub.requests.findIndex((r) => r.stream), 'the summaries and the brief come first');

    // The two chapters are translated at the same time, each translated and then reviewed.
    const of = (c) => stub.chats().filter((r) => r.system[2].text.startsWith(`<current_chapter id="${c}"`));
    const chats = [...of('c2'), ...of('c3')];
    assert.equal(stub.chats().length, 4);
    for (const r of chats) {
      assert.equal(r.model, 'claude-opus-5-5');
      assert.equal(r.max_tokens, 128000);
      assert.deepEqual(r.output_config, { effort: 'max' });
      assert.equal(r.thinking, undefined, 'thinking is left to the model');
      assert.equal(r.fallbacks, undefined, 'no refusal fallback away from the official API');
      assert.equal(r.system.length, 3);
      assert.equal(r.system[0].cache_control, undefined);
      assert.deepEqual(r.system[1].cache_control, { type: 'ephemeral', ttl: '1h' });
      assert.deepEqual(r.system[2].cache_control, { type: 'ephemeral', ttl: '1h' });
      assert.match(r.system[1].text, /<brief>The brief\.<\/brief>/);
    }
    assert.equal(JSON.stringify(chats[1].system), JSON.stringify(chats[0].system), 'the review shares the cached prefix');
    assert.match(chats[0].messages[0].content, /^<block n="0">PREFACE\.<\/block>\n<block n="1">preface0 [^]*\n\nTranslate blocks 0–1\.$/);
    assert.match(chats[1].messages[0].content, /<source>\n<block n="0">PREFACE\.<\/block>[^]*<draft>\n<block n="0">번역 0<\/block>\n<block n="1">번역 1<\/block>\n<\/draft>$/);
    // The SDK reports the request timeout it was given (30 minutes).
    assert.deepEqual(
      stub.headers.filter((_, i) => stub.requests[i].stream).map((hd) => hd['x-stainless-timeout']),
      ['1800', '1800', '1800', '1800'],
    );

    const got = await api(srv.url, 'GET', '/api/papers/txt-book/translations/c2', { cookie });
    assert.equal(got.status, 200);
    const { at, ...rest } = got.data.translation;
    assert.ok(!Number.isNaN(Date.parse(at)));
    assert.deepEqual(rest, { chapter: 'c2', blocks: ['번역 0', '번역 1'], notes: [], model: 'claude-opus-5-5', effort: 'max', stale: false });
    assert.equal((await api(srv.url, 'GET', '/api/papers/txt-book/translations/c4', { cookie })).status, 404);
    const file = readJson(dir, 'papers', 'txt-book', 'translations', 'c3.json');
    assert.equal(file.status, 'ready');
    assert.equal(file.prompt, 1);
    assert.match(file.source, /^[0-9a-f]{40}$/);
    assert.deepEqual(file.usage, { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a long chapter goes in reviewed segments with notes numbered through it; a missing block fails after one retry, and Retry resumes', async () => {
  let drop = true;
  const stub = await anthropicStub((body) => {
    const user = body.messages[0].content;
    if (user.includes('<draft>')) return { text: user.includes('<block n="1">') ? '<block n="1">고친 번역 1[[주석 1]]</block>' : '<none/>' };
    const out = blocksIn(user)
      .filter(([n]) => !(drop && n === 3))
      .map(([n]) => `<block n="${n}">번역 ${n}${n % 2 ? `[[주석 ${n}]]` : ''}</block>`);
    return { text: out.join('\n') };
  });
  const dir = tempDir();
  const repeat = (w, n) => `${w} `.repeat(n).trim();
  // 4,000 characters per segment: blocks 0-1 and 2-3.
  const blocks = [h('DEBT.'), p(repeat('alpha', 350)), p(repeat('beta', 450)), p(repeat('gamma', 250))];
  writeBookFixture(dir, 'txt-long', { chapters: [chapter('c1', 'Debt', blocks)] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (body = {}) => api(srv.url, 'POST', '/api/papers/txt-long/translations/c1', { cookie, body, headers: EN });
    const first = await post();
    assert.equal(first.status, 200);
    assert.equal(first.data.paper.book.translations.c1.status, 'queued');
    const failed = await waitForPaper(srv.url, cookie, 'txt-long', (m) => m.book.translations?.c1?.status === 'error');
    assert.match(failed.book.translations.c1.error, /incomplete twice/);
    const sent = () => stub.chats().map((r) => r.messages[0].content);
    assert.equal(sent().length, 4);
    assert.match(sent()[0], /Translate blocks 0–1\.$/);
    assert.match(sent()[1], /<draft>/);
    assert.match(sent()[2], /^<block n="2">[^]*Translate blocks 2–3\.$/);
    assert.equal(sent()[3], sent()[2], 'the same segment, once more');
    const file = () => readJson(dir, 'papers', 'txt-long', 'translations', 'c1.json');
    assert.equal(file().status, 'partial');
    assert.deepEqual(file().blocks, ['번역 0', '고친 번역 1[[주석 1]]', null, null]);
    assert.equal((await api(srv.url, 'GET', '/api/papers/txt-long/translations/c1', { cookie })).status, 404);

    drop = false;
    assert.equal((await post()).data.paper.book.translations.c1.status, 'queued');
    await waitForPaper(srv.url, cookie, 'txt-long', (m) => m.book.translations?.c1?.status === 'ready');
    assert.equal(sent().length, 6, 'only the second segment again, translated and reviewed');
    assert.match(sent()[4], /^<block n="2">[^]*\n\nFootnotes given earlier in this chapter, not to repeat:\n- 주석 1\n\nTranslate blocks 2–3\.$/);
    assert.match(sent()[5], /<draft>/);
    const got = (await api(srv.url, 'GET', '/api/papers/txt-long/translations/c1', { cookie })).data.translation;
    assert.deepEqual(got.blocks, ['번역 0', '고친 번역 1[^1]', '번역 2', '번역 3[^2]']);
    assert.deepEqual(got.notes, ['주석 1', '주석 3']);
    assert.equal(got.stale, false);

    // Ready: without `again` nothing happens, and with it the saved translation of the same text
    // is kept.
    assert.equal((await post()).data.paper.book.translations.c1.status, 'ready');
    assert.equal((await post({ again: true })).data.paper.book.translations.c1.status, 'queued');
    await waitForPaper(srv.url, cookie, 'txt-long', (m) => m.book.translations?.c1?.status === 'ready');
    await sleep(200);
    assert.equal(sent().length, 6);
    // (Each job asks for the summaries first; this stub writes none.)
    const calls = () => usage(dir).filter((u) => u.action !== 'summary');
    await waitFor(() => calls().length === 6);
    assert.deepEqual(
      calls().map((u) => u.action),
      ['translate-chapter', 'review-chapter', 'translate-chapter', 'translate-chapter', 'translate-chapter', 'review-chapter'],
    );
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translating a chapter of a scanned book cleans it up first; a refusal fails the job with no retry; one cut off twice says a resume would likely fail again', async () => {
  const stub = await anthropicStub((body) => {
    const user = body.messages[0].content;
    if (user.startsWith('This is text from a scanned book')) {
      return { text: blocksIn(user).map(([n, x]) => `<block n="${n}">${x.replace('T is', 'It is')}</block>`).join('\n') };
    }
    if (body.system[2].text.startsWith('<current_chapter id="c2"')) return { text: '', stopReason: 'refusal' };
    if (body.system[2].text.startsWith('<current_chapter id="c3"')) return { text: '<block n="0">아무', stopReason: 'max_tokens' };
    return translator(body);
  });
  const dir = tempDir();
  writeBookFixture(dir, 'pdf-scan', {
    ocr: true,
    chapters: [chapter('c1', 'To the Idle', [h('TO THE IDLE.'), p(IDLE)]), chapter('c2', 'Debt', [p('Owe no man anything.')]), chapter('c3', 'Owing', [p('Owe no man any thing, but to love one another.')])],
  });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (c) => api(srv.url, 'POST', `/api/papers/pdf-scan/translations/${c}`, { cookie, body: {}, headers: EN });
    await post('c1');
    await waitForPaper(srv.url, cookie, 'pdf-scan', (m) => m.book.translations?.c1?.status === 'ready');
    assert.deepEqual(
      stub.requests.map((r) => r.model),
      ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'],
    );
    const fixed = IDLE.replace('T is', 'It is');
    assert.ok(stub.requests[1].system[2].text.includes(fixed));
    assert.match(stub.requests[1].messages[0].content, new RegExp(`<block n="1">${fixed}</block>`));
    assert.equal(readJson(dir, 'papers', 'pdf-scan', 'book.json').chapters[0].blocks[1].x, fixed);
    const got = await api(srv.url, 'GET', '/api/papers/pdf-scan/translations/c1', { cookie });
    assert.equal(got.data.translation.stale, false);

    await post('c2');
    const meta = await waitForPaper(srv.url, cookie, 'pdf-scan', (m) => m.book.translations?.c2?.status === 'error');
    assert.match(meta.book.translations.c2.error, /declined/);
    assert.equal(stub.chats().filter((r) => r.system[2].text.startsWith('<current_chapter id="c2"')).length, 1);

    await post('c3');
    const cut = await waitForPaper(srv.url, cookie, 'pdf-scan', (m) => m.book.translations?.c3?.status === 'error');
    assert.match(cut.book.translations.c3.error, /output limit twice.*resuming will likely fail at the same paragraph/);
    assert.equal(stub.chats().filter((r) => r.system[2].text.startsWith('<current_chapter id="c3"')).length, 2);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('at startup a job cut short starts again, but not one that reached the model twice, one the reader stopped, or one more than run at once', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const stub = await anthropicStub(async (body) => {
    await gate;
    return translator(body);
  });
  const dir = tempDir();
  stubConfig(dir, stub);
  const translations = {
    c2: { status: 'working', progress: 0.5, error: '', auto: true, tries: 2 },
    c3: { status: 'queued', progress: 0, error: '', auto: false, tries: 1 },
    // stopped right after its translation was saved
    c4: { status: 'working', progress: 0.9, error: '', auto: true, tries: 1 },
    c5: { status: 'cancelled', progress: 0.5, error: '', auto: false, tries: 1 },
    c6: { status: 'working', progress: 0.2, error: '', auto: false, tries: 1 },
  };
  const chapters = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((title, i) => chapter(`c${i + 1}`, title, [p(`${title}.`)]));
  writeBookFixture(dir, 'txt-book', {
    chapters,
    meta: { book: { status: 'ready', step: 'done', progress: 1, error: '', chapters: 6, ocr: false, summaries: 0, translations } },
  });
  const source = crypto.createHash('sha1').update(JSON.stringify(['Four.'])).digest('hex');
  const saved = { version: 1, chapter: 'c4', status: 'ready', model: 'claude-opus-5-5', effort: 'max', prompt: 1, source, blocks: ['넷.'], notes: [], usage: {}, at: new Date().toISOString() };
  fs.mkdirSync(path.join(dir, 'papers', 'txt-book', 'translations'));
  fs.writeFileSync(path.join(dir, 'papers', 'txt-book', 'translations', 'c4.json'), JSON.stringify(saved));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, TRANSLATE_PARALLEL: '2' } });
  try {
    const cookie = await signIn(srv.url, PW);
    // Two run at once: c3 and c4 start again (held by the stub), and c6 would be a third.
    const held = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c6.status === 'error');
    assert.equal(held.book.translations.c6.error, 'Up to 2 chapters can be translated at once. Wait for one to finish, or stop one.');
    release();
    const meta = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c3.status === 'ready' && m.book.translations.c4.status === 'ready');
    assert.equal(meta.book.translations.c2.status, 'error');
    assert.match(meta.book.translations.c2.error, /cut short twice/);
    assert.equal(meta.book.translations.c3.tries, 2);
    assert.equal(meta.book.translations.c3.auto, false);
    assert.deepEqual([meta.book.translations.c5.status, meta.book.translations.c5.progress], ['cancelled', 0.5], 'a stopped chapter stays stopped');
    const got = await api(srv.url, 'GET', '/api/papers/txt-book/translations/c4', { cookie });
    assert.deepEqual(got.data.translation.blocks, ['넷.']);
    assert.deepEqual(
      stub.chats().map((r) => /^<current_chapter id="(c\d+)"/.exec(r.system[2].text)[1]),
      ['c3', 'c3'],
    );
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('translations: 404 when there is none; POST refuses unknown chapters, other items and providers other than Claude', async () => {
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Debt', [p('Owe no man anything.')])] });
  const paperDir = path.join(dir, 'papers', 'arxiv-2401.00001v1');
  fs.mkdirSync(paperDir, { recursive: true });
  fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify({ id: 'arxiv-2401.00001v1', source: 'arxiv', title: 'A paper', createdAt: new Date().toISOString(), html: { status: 'none' } }));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const get = (c) => api(srv.url, 'GET', `/api/papers/txt-book/translations/${c}`, { cookie, headers: EN });
    const post = (id, c) => api(srv.url, 'POST', `/api/papers/${id}/translations/${c}`, { cookie, body: {}, headers: EN });
    const none = await get('c1');
    assert.equal(none.status, 404);
    assert.match(none.data.error, /no translation yet/);
    assert.equal((await get('c9')).status, 400);
    const noKey = await post('txt-book', 'c1');
    assert.equal(noKey.status, 400);
    assert.match(noKey.data.error, /needs Claude/);
    assert.match((await post('txt-book', 'c9')).data.error, /Unknown chapter/);
    assert.match((await post('arxiv-2401.00001v1', 'c1')).data.error, /not a book/);
    assert.equal((await post('no-such-book', 'c1')).status, 404);
    // Stop: an unknown chapter is refused; with nothing to stop, the book comes back as it is.
    assert.match((await post('txt-book', 'c9/cancel')).data.error, /Unknown chapter/);
    const idle = await post('txt-book', 'c1/cancel');
    assert.equal(idle.status, 200);
    assert.equal(idle.data.paper.book.translations, undefined);
    await api(srv.url, 'PUT', '/api/settings', { cookie, body: { llm: { preset: 'custom', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-x', model: 'm' } } });
    assert.equal((await post('txt-book', 'c1')).status, 400);
    assert.equal((await api(srv.url, 'GET', '/api/papers/txt-book', { cookie })).data.paper.book.translations, undefined);

    // Shown as queued or working with no job behind it (a state another machine left, say): Stop
    // marks it stopped, so its bar doesn't stick and no restart resumes it.
    const metaFile = path.join(dir, 'papers', 'txt-book', 'meta.json');
    for (const status of ['working', 'queued']) {
      const meta = readJson(metaFile);
      fs.writeFileSync(metaFile, JSON.stringify({ ...meta, book: { ...meta.book, translations: { c1: { status, progress: 0.4, tries: 1 } } } }));
      const { c1 } = (await post('txt-book', 'c1/cancel')).data.paper.book.translations;
      assert.deepEqual([c1.status, c1.progress], ['cancelled', 0.4], status);
    }
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a block of noise may come back empty or be left out; a review cut off or cut short keeps the draft', async () => {
  const stub = await anthropicStub((body) => {
    const user = body.messages[0].content;
    const c2 = body.system[2].text.startsWith('<current_chapter id="c2"');
    if (user.includes('<draft>')) return c2 ? { text: '<block n="0">아무', stopReason: 'max_tokens' } : { text: '<block n="0">빚</block>\n<block n="3">짧게.</block>' };
    if (c2) return { text: '<block n="0">아무에게도 빚지지 말라.</block>' };
    // Block 1 comes back empty, block 2 (two words) not at all.
    return { text: '<block n="0">빚.</block>\n<block n="1"/>\n<block n="3">아무에게도 아무 빚도 지지 말고, 서로 사랑하라.</block>' };
  });
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', {
    chapters: [
      chapter('c1', 'Debt', [h('DEBT.'), p('S| ® ~ «'), p('~ ~'), p('Owe no man any thing, but to love one another.')]),
      chapter('c2', 'Owing', [p('Owe no man anything.</block>')]),
    ],
  });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    for (const c of ['c1', 'c2']) await api(srv.url, 'POST', `/api/papers/txt-book/translations/${c}`, { cookie, body: {}, headers: EN });
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations?.c1?.status === 'ready' && m.book.translations?.c2?.status === 'ready');
    const blocks = async (c) => (await api(srv.url, 'GET', `/api/papers/txt-book/translations/${c}`, { cookie })).data.translation.blocks;
    // The review's block 0 is kept; its block 3, under half the draft's length, is not.
    assert.deepEqual(await blocks('c1'), ['빚', '', '', '아무에게도 아무 빚도 지지 말고, 서로 사랑하라.']);
    assert.deepEqual(await blocks('c2'), ['아무에게도 빚지지 말라.']);
    assert.equal(stub.chats().length, 4, 'each chapter translated and reviewed once');
    const c2 = stub.chats().find((r) => r.system[2].text.startsWith('<current_chapter id="c2"'));
    assert.match(c2.messages[0].content, /^<block n="0">Owe no man anything\.‹\/block><\/block>\n/, 'book text cannot close a block');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('three chapters translate at once and a fourth is refused; Stop on one leaves the others and frees its place; too long, or no key, stops a job', async () => {
  let srv;
  let cookie;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const stub = await anthropicStub(async (body) => {
    if (!body.stream) return {}; // summaries
    const c = /^<current_chapter id="(c\d+)"/.exec(body.system[2].text)[1];
    if (c !== 'c6') await gate;
    if (c === 'c6' && body.messages[0].content.includes('<draft>')) await api(srv.url, 'PUT', '/api/settings', { cookie, body: { forgetKey: 'anthropic' } });
    return translator(body);
  });
  const dir = tempDir();
  const chapters = ['One', 'Two', 'Three', 'Four', 'Five'].map((title, i) => chapter(`c${i + 1}`, title, [p(`${title}.`)]));
  // Two segments of one block each (and under $5, so not in parts); c7 is one block too long.
  chapters.push(chapter('c6', 'Six', [p('alpha '.repeat(500)), p('beta '.repeat(800))]), chapter('c7', 'Seven', [p('x'.repeat(300_001))]));
  writeBookFixture(dir, 'txt-book', { chapters });
  srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (c) => api(srv.url, 'POST', `/api/papers/txt-book/translations/${c}`, { cookie, body: {}, headers: EN });
    const states = async () => (await api(srv.url, 'GET', '/api/papers/txt-book', { cookie })).data.paper.book.translations;
    const calls = (c) => stub.chats().filter((r) => r.system[2].text.startsWith(`<current_chapter id="${c}"`)).length;
    const long = await post('c7');
    assert.equal(long.status, 400);
    assert.match(long.data.error, /too long to translate \(at most 300,000 characters\)/);
    for (const c of ['c1', 'c2', 'c3']) assert.equal((await post(c)).status, 200);
    // The three run together: the stub holds three calls at once.
    assert.ok(await waitFor(() => stub.chats().length === 3 && stub.open() === 3, 10000));
    const held = await states();
    for (const c of ['c1', 'c2', 'c3']) {
      assert.equal(held[c].status, 'working');
      assert.ok(Date.parse(held[c].queuedAt) <= Date.parse(held[c].startedAt), 'when it was queued and started');
    }
    const busy = await post('c4');
    assert.equal(busy.status, 429);
    assert.equal(busy.data.error, 'Up to 3 chapters can be translated at once. Wait for one to finish, or stop one.');
    assert.equal((await states()).c4, undefined);
    assert.equal((await post('c2')).data.paper.book.translations.c2.status, 'working', 'a chapter on its way is no new job');

    // Stop one: its call is aborted, the other two go on, and its place is free.
    const stopped = await post('c2/cancel');
    assert.equal(stopped.status, 200);
    assert.equal(stopped.data.paper.book.translations.c2.status, 'cancelled');
    assert.ok(await waitFor(() => stub.open() === 2), 'its call is aborted');
    assert.equal((await post('c4')).status, 200);
    assert.ok(await waitFor(() => calls('c4') === 1, 10000));
    release();
    const done = await waitForPaper(srv.url, cookie, 'txt-book', (m) => ['c1', 'c3', 'c4'].every((c) => m.book.translations[c].status === 'ready'));
    assert.equal(done.book.translations.c2.status, 'cancelled', 'a stopped chapter stays stopped');
    assert.deepEqual(['c1', 'c2', 'c3', 'c4'].map(calls), [2, 1, 2, 2], 'the stopped one was not reviewed');
    assert.deepEqual([done.book.translations.c1.queuedAt, done.book.translations.c1.startedAt], [held.c1.queuedAt, held.c1.startedAt], 'kept once ready');

    // One that finished frees its place too.
    await post('c6');
    const meta = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c6?.status === 'error');
    assert.match(meta.book.translations.c6.error, /needs Claude/);
    const six = stub.chats().filter((r) => r.system[2].text.startsWith('<current_chapter id="c6"'));
    assert.equal(six.length, 2, 'the first segment translated and reviewed, the second never sent');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop aborts the call on its way: the segments done stay, Resume does only the rest, and the cost so far follows the usage', async () => {
  let hang = true;
  // Each call: $0.004 input, $1 output, $0.016 cache writes, $0.002 cache reads.
  const usage = { input_tokens: 1000, output_tokens: 50_000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000 };
  const stub = await anthropicStub((body) => {
    if (!body.stream) return {}; // summaries
    return { ...translator(body), usage, hang: hang && body.messages[0].content.endsWith('Translate blocks 2–3.') };
  });
  const dir = tempDir();
  const repeat = (w, n) => `${w} `.repeat(n).trim();
  // 4,000 characters per segment: blocks 0-1 and 2-3.
  writeBookFixture(dir, 'txt-long', { chapters: [chapter('c1', 'Debt', [h('DEBT.'), p(repeat('alpha', 350)), p(repeat('beta', 450)), p(repeat('gamma', 250))])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (to = '') => api(srv.url, 'POST', `/api/papers/txt-long/translations/c1${to}`, { cookie, body: {}, headers: EN });
    const state = async () => (await api(srv.url, 'GET', '/api/papers/txt-long', { cookie })).data.paper.book.translations.c1;
    const pick = ({ status, progress, startProgress, spent }) => ({ status, progress, startProgress, spent });
    await post();
    // The first segment translated and reviewed (two calls, $2.044), the second on its way.
    assert.ok(await waitFor(async () => stub.chats().length === 3 && (await state()).progress > 0, 10000));
    assert.deepEqual(pick(await state()), { status: 'working', progress: 0.35, startProgress: 0, spent: 2.04 });
    assert.equal(stub.open(), 1);
    const stopped = await post('/cancel');
    assert.deepEqual(pick(stopped.data.paper.book.translations.c1), { status: 'cancelled', progress: 0.35, startProgress: 0, spent: 2.04 });
    assert.ok(await waitFor(() => stub.open() === 0), 'the call on its way is aborted');
    await sleep(300);
    assert.equal((await state()).status, 'cancelled', 'the aborted job writes nothing of its own');
    const file = readJson(dir, 'papers', 'txt-long', 'translations', 'c1.json');
    assert.deepEqual([file.status, file.blocks], ['partial', ['번역 0', '번역 1', null, null]]);
    assert.equal((await post('/cancel')).data.paper.book.translations.c1.status, 'cancelled', 'nothing left to stop');

    hang = false;
    assert.equal((await post()).data.paper.book.translations.c1.status, 'queued');
    const done = await waitForPaper(srv.url, cookie, 'txt-long', (m) => m.book.translations.c1.status === 'ready');
    // Four calls in all, the aborted one not counted: $4.088.
    assert.deepEqual(pick(done.book.translations.c1), { status: 'ready', progress: 1, startProgress: 0.35, spent: 4.09 });
    const sent = stub.chats().map((r) => r.messages[0].content);
    assert.equal(sent.length, 5, 'only the second segment again');
    assert.match(sent[3], /Translate blocks 2–3\.$/);
    assert.match(sent[4], /<draft>/);
    const got = await api(srv.url, 'GET', '/api/papers/txt-long/translations/c1', { cookie });
    assert.deepEqual(got.data.translation.blocks, ['번역 0', '번역 1', '번역 2', '번역 3']);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('while a job runs its state says which segment of how many, translated or reviewed since when, and the pace so far, at no call of its own', async () => {
  const gates = [];
  const stub = await anthropicStub(async (body) => {
    if (!body.stream) return {}; // summaries
    const user = body.messages[0].content;
    // Held: the review of the first segment, then the translation of the second.
    if (user.includes('<draft>') ? user.includes('<block n="0">') : user.endsWith('Translate blocks 2–3.')) await new Promise((resolve) => gates.push(resolve));
    return translator(body);
  });
  const dir = tempDir();
  const repeat = (w, n) => `${w} `.repeat(n).trim();
  writeBookFixture(dir, 'txt-long', { chapters: [chapter('c1', 'Debt', [h('DEBT.'), p(repeat('alpha', 350)), p(repeat('beta', 450)), p(repeat('gamma', 250))])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const state = async () => (await api(srv.url, 'GET', '/api/papers/txt-long', { cookie })).data.paper.book.translations.c1;
    const pick = ({ progress, segment, phase, pace }) => ({ progress, segment, phase, pace });
    await api(srv.url, 'POST', '/api/papers/txt-long/translations/c1', { cookie, body: {}, headers: EN });
    assert.ok(await waitFor(async () => gates.length === 1 && (await state()).phase === 'review', 10000));
    const reviewing = await state();
    assert.deepEqual(pick(reviewing), { progress: 0, segment: { k: 1, n: 2, to: 0.35 }, phase: 'review', pace: undefined });
    assert.ok(Date.parse(reviewing.phaseAt) >= Date.parse(reviewing.startedAt));
    gates.shift()();
    assert.ok(await waitFor(async () => gates.length === 1 && (await state()).segment?.k === 2, 10000));
    const second = await state();
    assert.deepEqual({ ...pick(second), pace: typeof second.pace }, { progress: 0.35, segment: { k: 2, n: 2, to: 1 }, phase: 'translate', pace: 'number' });
    assert.ok(Date.parse(second.phaseAt) >= Date.parse(reviewing.phaseAt));
    gates.shift()();
    const done = (await waitForPaper(srv.url, cookie, 'txt-long', (m) => m.book.translations.c1.status === 'ready')).book.translations.c1;
    assert.deepEqual(['segment', 'phase', 'phaseAt', 'pace'].filter((k) => k in done), [], 'gone once it is done');
    assert.equal(stub.chats().length, 4, 'two segments, each translated and reviewed: nothing more');
  } finally {
    gates.forEach((go) => go());
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one at a time (TRANSLATE_PARALLEL=1): a second chapter is refused; one stopped before it starts never calls the model, and frees its place', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const stub = await anthropicStub(async (body) => {
    if (body.stream) return translator(body);
    await gate; // the book's summaries, which a translation waits for
    return { text: 'Summary.' };
  });
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'One', [p(words(200, 'one'))]), chapter('c2', 'Two', [p(words(200, 'two'))])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, TRANSLATE_PARALLEL: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (to) => api(srv.url, 'POST', `/api/papers/txt-book/translations/${to}`, { cookie, body: {}, headers: EN });
    assert.equal((await post('c1')).data.paper.book.translations.c1.status, 'queued');
    const busy = await post('c2');
    assert.equal(busy.status, 429);
    assert.equal(busy.data.error, 'Up to 1 chapters can be translated at once. Wait for one to finish, or stop one.');
    assert.equal((await post('c1/cancel')).data.paper.book.translations.c1.status, 'cancelled');
    assert.equal((await post('c2')).status, 200, 'the stop freed its place');
    release();
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c2.status === 'ready');
    assert.equal((await api(srv.url, 'GET', '/api/papers/txt-book', { cookie })).data.paper.book.translations.c1.status, 'cancelled');
    // Resumed, it starts like any other.
    await post('c1');
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c1.status === 'ready');
    const chapters = stub.chats().map((r) => /^<current_chapter id="(c\d+)"/.exec(r.system[2].text)[1]);
    assert.deepEqual(chapters, ['c2', 'c2', 'c1', 'c1'], 'nothing from the stopped job');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed call is made again only after a failure on its way, waiting as long as the API asks', () => {
  const delays = [15000, 45000, 120000, 300000];
  const fail = (status, type, extra = {}) => Object.assign(new Error('x'), { status, type, ...extra });
  const after = (v) => ({ headers: { get: (k) => (k === 'retry-after' ? v : null) } });
  assert.equal(retryDelay(fail(529, 'overloaded_error'), 1, delays), 15000);
  assert.equal(retryDelay(fail(529), 4, delays), 300000);
  assert.equal(retryDelay(fail(529), 5, delays), null, 'five tries in all');
  for (const s of [408, 409, 429, 500, 502, 503, 504]) assert.equal(retryDelay(fail(s), 2, delays), 45000, String(s));
  for (const s of [400, 401, 403, 404, 413, 422]) assert.equal(retryDelay(fail(s), 1, delays), null, String(s));
  assert.equal(retryDelay(fail(undefined, 'overloaded_error'), 1, delays), 15000, 'an error event in the stream');
  assert.equal(retryDelay(fail(undefined, 'api_error'), 2, delays), 45000);
  assert.equal(retryDelay(fail(undefined, 'invalid_request_error'), 1, delays), null);
  // What the SDK throws when the connection drops in the middle of a stream.
  const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  assert.equal(retryDelay(Object.assign(new Error('terminated'), { cause: Object.assign(new TypeError('terminated'), { cause: socket }) }), 1, delays), 15000);
  assert.equal(retryDelay(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 3, delays), 120000);
  assert.equal(retryDelay(new Anthropic.APIConnectionTimeoutError(), 1, delays), 15000);
  assert.equal(retryDelay(fail(429, 'rate_limit_error', after('30')), 1, delays), 30000, 'retry-after');
  assert.equal(retryDelay(fail(529, 'overloaded_error', after('3600')), 1, delays), 600000, 'at most 10 minutes');
  assert.equal(retryDelay(new Anthropic.APIUserAbortError(), 1, delays), null, 'a stop');
  // After a try that failed late (over 5 minutes in, billed for its thinking), two more at most.
  assert.equal(retryDelay(fail(529), 1, delays, 1), 15000);
  assert.equal(retryDelay(fail(529), 2, delays, 1), 45000);
  assert.equal(retryDelay(fail(529), 3, delays, 1), null);
  assert.equal(retryDelay(fail(529), 3, delays, 2), 120000);
  assert.equal(retryDelay(fail(529), 4, delays, 2), null);
  assert.equal(retryDelay(Object.assign(new Error('translate.refused'), { status: 422, key: 'translate.refused' }), 1, delays), null, 'a refusal');
  assert.equal(retryDelay(Object.assign(new Error('translate.noKey'), { status: 400, key: 'translate.noKey' }), 1, delays), null);
});

test('a call overloaded once, or cut off mid-stream, is made again; every try is logged with its time, and the server log says why', async () => {
  const failed = new Set();
  const stub = await anthropicStub((body) => {
    if (!body.stream) return {}; // summaries
    const c = /^<current_chapter id="(c\d+)"/.exec(body.system[2].text)[1];
    if (body.messages[0].content.includes('<draft>') || failed.has(c)) return translator(body);
    failed.add(c);
    // The first translation of c1 is refused as overloaded; that of c2 drops its connection.
    return c === 'c1' ? { status: 529 } : { ...translator(body), cut: true, usage: { input_tokens: 1234, output_tokens: 0 } };
  });
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Debt', [p('Owe no man anything.')]), chapter('c2', 'Idle', [p(IDLE)])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    for (const c of ['c1', 'c2']) await api(srv.url, 'POST', `/api/papers/txt-book/translations/${c}`, { cookie, body: {}, headers: EN });
    const meta = await waitForPaper(srv.url, cookie, 'txt-book', (m) => ['c1', 'c2'].every((c) => m.book.translations[c]?.status === 'ready'));
    assert.deepEqual([meta.book.translations.c1.tries, meta.book.translations.c2.tries], [1, 1], 'one job each');
    assert.equal(stub.chats().length, 6, 'each: a failed try, then translated and reviewed');
    const lines = usage(dir).filter((u) => u.action.endsWith('-chapter'));
    assert.ok(lines.every((u) => Number.isInteger(u.ms) && u.attempt >= 1));
    const failures = lines.filter((u) => u.error).sort((a, b) => (a.chapter < b.chapter ? -1 : 1));
    assert.deepEqual(
      failures.map((u) => [u.chapter, u.action, u.model, u.attempt, u.error.status, u.error.type]),
      [
        ['c1', 'translate-chapter', 'claude-opus-5-5', 1, 529, 'api_error'],
        ['c2', 'translate-chapter', 'claude-opus-5-5', 1, null, 'UND_ERR_SOCKET'],
      ],
    );
    assert.equal(failures[0].usage, null);
    assert.deepEqual(failures[1].usage, { input_tokens: 1234, output_tokens: 0 }, 'what the stream had counted');
    assert.deepEqual(lines.filter((u) => !u.error && u.action === 'translate-chapter').map((u) => u.attempt).sort(), [2, 2]);
    const log = fs.readFileSync(srv.logFile, 'utf8');
    assert.match(log, /\[translate\] txt-book c1 translate-chapter: try 1 failed \(api_error 529 stub failure\); trying again in 0 s/);
    assert.match(log, /\[translate\] txt-book c2 translate-chapter: try 1 failed \(UND_ERR_SOCKET terminated\)/);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused call (400) is not made again: the job fails at once, keeps what it did, and resuming shows it from the start', async () => {
  let refuse = true;
  const stub = await anthropicStub((body) => {
    if (!body.stream) return {};
    if (refuse && body.messages[0].content.endsWith('Translate blocks 2–3.')) return { status: 400 };
    return translator(body);
  });
  const dir = tempDir();
  const repeat = (w, n) => `${w} `.repeat(n).trim();
  // 4,000 characters per segment: blocks 0-1 and 2-3.
  writeBookFixture(dir, 'txt-long', { chapters: [chapter('c1', 'Debt', [h('DEBT.'), p(repeat('alpha', 350)), p(repeat('beta', 450)), p(repeat('gamma', 250))])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = () => api(srv.url, 'POST', '/api/papers/txt-long/translations/c1', { cookie, body: {}, headers: EN });
    await post();
    const failed = (await waitForPaper(srv.url, cookie, 'txt-long', (m) => m.book.translations.c1.status === 'error')).book.translations.c1;
    assert.equal(stub.chats().length, 3, 'the first segment translated and reviewed, the second refused once');
    assert.equal(failed.progress, 0.35, 'what was done stays');
    assert.match(failed.error, /Request rejected \(400\)/);
    assert.equal(usage(dir).filter((u) => u.error).length, 1);
    refuse = false;
    const resumed = (await post()).data.paper.book.translations.c1;
    assert.deepEqual([resumed.status, resumed.progress, resumed.startProgress], ['queued', 0.35, 0.35], 'at once, not 0%');
    await waitForPaper(srv.url, cookie, 'txt-long', (m) => m.book.translations.c1.status === 'ready');
    assert.equal(stub.chats().length, 5, 'only the second segment again');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop during the wait before a call is made again: stopped at once, and no call after', async () => {
  const stub = await anthropicStub((body) => (body.stream ? { status: 529 } : {}));
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Debt', [p('Owe no man anything.')])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, TRANSLATE_RETRY_DELAYS: '1500,1500,1500,1500' } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    await api(srv.url, 'POST', '/api/papers/txt-book/translations/c1', { cookie, body: {}, headers: EN });
    // The first try failed and was logged: the job now waits 1.5 s.
    assert.ok(await waitFor(() => usage(dir).some((u) => u.error), 10000));
    const asked = Date.now();
    const stopped = await api(srv.url, 'POST', '/api/papers/txt-book/translations/c1/cancel', { cookie, body: {}, headers: EN });
    assert.equal(stopped.data.paper.book.translations.c1.status, 'cancelled');
    assert.ok(await waitFor(() => /txt-book c1: stopped/.test(fs.readFileSync(srv.logFile, 'utf8')), 700), 'the job ends at once, not after the wait');
    assert.ok(Date.now() - asked < 1000);
    await sleep(2500);
    assert.equal(stub.chats().length, 1, 'no call once the wait would have ended');
    assert.equal((await api(srv.url, 'GET', '/api/papers/txt-book', { cookie })).data.paper.book.translations.c1.status, 'cancelled');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop during the last review: the chapter stays partial with its paid draft and the stopped call is logged; Resume finishes it with no call', async () => {
  let hang = true;
  // Each call: $1.004 (1,000 input and 50,000 output tokens).
  const stub = await anthropicStub((body) => {
    if (!body.stream) return {}; // summaries
    return { ...translator(body), usage: { input_tokens: 1000, output_tokens: 50_000 }, hang: hang && body.messages[0].content.includes('<draft>') };
  });
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Debt', [p('Owe no man anything.')])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (to = '', body = {}) => api(srv.url, 'POST', `/api/papers/txt-book/translations/c1${to}`, { cookie, body, headers: EN });
    const state = async () => (await api(srv.url, 'GET', '/api/papers/txt-book', { cookie })).data.paper.book.translations.c1;
    const file = () => readJson(dir, 'papers', 'txt-book', 'translations', 'c1.json');
    await post();
    assert.ok(await waitFor(() => stub.chats().length === 2 && stub.open() === 1, 10000), 'the review on its way');
    assert.equal((await post('/cancel')).data.paper.book.translations.c1.status, 'cancelled');
    assert.ok(await waitFor(() => /txt-book c1: stopped/.test(fs.readFileSync(srv.logFile, 'utf8')), 5000));
    assert.ok(await waitFor(() => stub.open() === 0), 'the review is aborted');
    assert.deepEqual([file().status, file().blocks], ['partial', ['번역 0']], 'not done, but its draft is kept');
    const { status, progress, spent } = await state();
    assert.deepEqual({ status, progress, spent }, { status: 'cancelled', progress: 1, spent: 1 });
    // The stopped call has its line too, with what the stream had counted.
    const lines = () => usage(dir).filter((u) => u.action.endsWith('-chapter'));
    assert.ok(await waitFor(() => lines().length === 2));
    assert.deepEqual(
      lines().map((u) => [u.action, u.attempt, u.error?.type ?? null, u.usage?.input_tokens]),
      [
        ['translate-chapter', 1, null, 1000],
        ['review-chapter', 1, 'aborted', 1000],
      ],
    );

    hang = false;
    const resumed = (await post()).data.paper.book.translations.c1;
    assert.deepEqual([resumed.status, resumed.progress, resumed.spent], ['queued', 1, 1]);
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c1.status === 'ready');
    assert.equal(stub.chats().length, 2, 'no call: the draft is its translation');
    assert.deepEqual((await api(srv.url, 'GET', '/api/papers/txt-book/translations/c1', { cookie })).data.translation.blocks, ['번역 0']);
    // Asked for again once done: it starts at all of it, and at what it cost.
    const again = (await post('', { again: true })).data.paper.book.translations.c1;
    assert.deepEqual([again.status, again.progress, again.spent], ['queued', 1, 1]);
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c1.status === 'ready');
    assert.equal(stub.chats().length, 2);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a key removed meanwhile: no try after a wait, and no review after a translation, whose paid draft stays saved', async () => {
  let srv;
  let cookie;
  let overloaded = true;
  const stub = await anthropicStub(async (body) => {
    if (!body.stream) return {}; // summaries
    if (overloaded) return { status: 529 };
    if (!body.messages[0].content.includes('<draft>')) await api(srv.url, 'PUT', '/api/settings', { cookie, body: { forgetKey: 'anthropic' } });
    return translator(body);
  });
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Debt', [p('Owe no man anything.')]), chapter('c2', 'Idle', [p(IDLE)])] });
  srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, TRANSLATE_RETRY_DELAYS: '1000,1000,1000,1000' } });
  try {
    cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (c) => api(srv.url, 'POST', `/api/papers/txt-book/translations/${c}`, { cookie, body: {}, headers: EN });
    const calls = (c) => stub.chats().filter((r) => r.system[2].text.startsWith(`<current_chapter id="${c}"`)).length;
    await post('c1');
    // The first try failed: the job waits a second before the next.
    assert.ok(await waitFor(() => usage(dir).some((u) => u.error), 10000));
    await api(srv.url, 'PUT', '/api/settings', { cookie, body: { forgetKey: 'anthropic' } });
    const failed = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c1.status === 'error');
    assert.match(failed.book.translations.c1.error, /needs Claude/);
    assert.equal(calls('c1'), 1, 'no try after the wait');

    // The key goes while c2 is being translated: its review is never asked for.
    overloaded = false;
    await useStub(srv.url, cookie, stub);
    await post('c2');
    const meta = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c2?.status === 'error');
    assert.match(meta.book.translations.c2.error, /needs Claude/);
    assert.equal(meta.book.translations.c2.progress, 1);
    assert.equal(calls('c2'), 1, 'translated, not reviewed');
    const file = readJson(dir, 'papers', 'txt-book', 'translations', 'c2.json');
    assert.deepEqual([file.status, file.blocks], ['partial', ['번역 0']]);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a book stops its translations: the call on its way is aborted, and its folder is not made again', async () => {
  const stub = await anthropicStub((body) => (body.stream ? { ...translator(body), hang: true } : {}));
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Debt', [p('Owe no man anything.')])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    await api(srv.url, 'POST', '/api/papers/txt-book/translations/c1', { cookie, body: {}, headers: EN });
    assert.ok(await waitFor(() => stub.open() === 1, 10000));
    assert.equal((await api(srv.url, 'DELETE', '/api/papers/txt-book', { cookie })).status, 200);
    assert.ok(await waitFor(() => stub.open() === 0), 'its call is aborted');
    assert.ok(await waitFor(() => /txt-book c1: stopped/.test(fs.readFileSync(srv.logFile, 'utf8'))));
    await sleep(300);
    assert.equal(fs.existsSync(path.join(dir, 'papers', 'txt-book')), false);
    assert.equal(stub.chats().length, 1);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('at startup, jobs cut short get their places back before any automatic chapter is queued', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const stub = await anthropicStub(async (body) => {
    if (!body.stream) return { text: body.max_tokens === 400 ? 'Summary.' : 'The brief.' };
    await gate;
    return translator(body);
  });
  const dir = tempDir();
  stubConfig(dir, stub);
  // Listed first (opened last): its introduction and chapter 1 would be translated automatically.
  writeBookFixture(dir, 'txt-auto', {
    meta: { lastOpenedAt: new Date(Date.now() + 60_000).toISOString() },
    chapters: [chapter('c1', 'Preface', [p(words(200, 'preface'))]), chapter('c2', 'To the Idle', [p(words(200, 'idle'))])],
  });
  // c1 reached the model twice already (its failure is written first); c2 was cut short.
  const translations = { c1: { status: 'working', progress: 0, error: '', tries: 2 }, c2: { status: 'working', progress: 0.5, error: '', tries: 1 } };
  writeBookFixture(dir, 'txt-cut', {
    chapters: [chapter('c1', 'One', [p('One.')]), chapter('c2', 'Two', [p('Two.')])],
    meta: { book: { status: 'ready', step: 'done', progress: 1, error: '', chapters: 2, ocr: false, summaries: 0, translations } },
  });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, TRANSLATE_AUTO: '1', TRANSLATE_PARALLEL: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    // c2 holds the one place (the stub holds its call), so the automatic chapters find none.
    assert.ok(await waitFor(() => /\[translate\] txt-auto: translate\.busy/.test(fs.readFileSync(srv.logFile, 'utf8')), 10000));
    release();
    const meta = await waitForPaper(srv.url, cookie, 'txt-cut', (m) => m.book.translations.c2.status === 'ready');
    assert.match(meta.book.translations.c1.error, /cut short twice/);
    assert.equal((await api(srv.url, 'GET', '/api/papers/txt-auto', { cookie })).data.paper.book.translations, undefined);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A regex that searched to the end of the reply from every unclosed tag would take minutes here.
test('a reply full of unclosed tags and footnotes is read in linear time', { timeout: 20_000 }, async () => {
  const stub = await anthropicStub((body) => {
    if (body.messages[0].content.includes('<draft>')) return { text: '<none/>' };
    return { text: `<block n="0">${'[['.repeat(100_000)}</block>${'<block n="0">'.repeat(100_000)}` };
  });
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Debt', [p('Owe no man anything.')])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    await api(srv.url, 'POST', '/api/papers/txt-book/translations/c1', { cookie, body: {}, headers: EN });
    const meta = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations?.c1?.status === 'ready');
    assert.equal(meta.book.translations.c1.status, 'ready');
    const { blocks, notes } = (await api(srv.url, 'GET', '/api/papers/txt-book/translations/c1', { cookie })).data.translation;
    assert.deepEqual([blocks.length, blocks[0].length, notes], [1, 200_000, []]);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quotes straightened by the clean-up turn curly again', () => {
  assert.equal(curly(`"As vinegar to the teeth," says the sluggard's friend, 'Never stop.'`), '“As vinegar to the teeth,” says the sluggard’s friend, ‘Never stop.’');
  assert.equal(curly(`("Hold!")—"Wait"`), '(“Hold!”)—“Wait”');
  assert.equal(curly(`'Tis the season; 'twas said "she's here"`), '’Tis the season; ’twas said “she’s here”');
  assert.equal(curly(`'"Hello"'`), '‘“Hello”’');
});

test('the startup clean-up of a book cleaned already makes no calls and logs no error', async () => {
  const stub = await anthropicStub();
  const dir = tempDir();
  stubConfig(dir, stub);
  // Four chapters for three workers: the last one must not be taken twice.
  const book = writeBookFixture(dir, 'pdf-done', { ocr: true, chapters: ['c1', 'c2', 'c3', 'c4'].map((c) => chapter(c, c, [p(IDLE)])) });
  fs.writeFileSync(path.join(dir, 'papers', 'pdf-done', 'book.json'), JSON.stringify({ ...book, cleaned: { c1: true, c2: true, c3: true, c4: true } }));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    await sleep(1500);
    assert.doesNotMatch(srv.output(), /\[clean\]/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
