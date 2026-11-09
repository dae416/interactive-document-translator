// Long chapters in parts of at most $5: where they are cut, and each part as a unit of translation
// (its own job, state and file), against an Anthropic stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anthropicStub, api, signIn, sleep, startServer, tempDir, useStub, waitFor, waitForPaper, writeBookFixture } from './helpers.js';

const { PART_MAX, piecesOf, splitChapter } = await import('../server/translate.js');

const PW = 'test-password';
const EN = { 'X-UI-Lang': 'en' };
const p = (x) => ({ t: 'p', x });
const h = (x) => ({ t: 'h', x });
const chapter = (id, title, blocks) => ({ id, title, blocks, pages: null, url: null });
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
const blocksIn = (text) => [...text.matchAll(/<block n="(\d+)">([\s\S]*?)<\/block>/g)].map((m) => [Number(m[1]), m[2]]);

// Blocks shaped like a real chapter's, without its text: h heading, I "II." point, 1 "2." point,
// p paragraph; a comma after it: doesn't end a sentence; then the length.
function shaped(spec) {
  return spec.split(' ').map((s) => {
    const [, kind, comma, n] = /^([hI1p])(,?)(\d+)$/.exec(s);
    const lead = { h: '', I: 'II. ', 1: '2. ', p: '' }[kind];
    const x = `${lead}${'a'.repeat(Number(n) - lead.length - 1)}${comma ? ',' : '.'}`;
    return kind === 'h' ? h(x) : p(x);
  });
}
// Matthew Henry, Genesis I (60,816 characters) and John Ploughman, "Debt" (15,634).
const HENRY = shaped(
  'h,13 h8 p1491 p621 h27 p201 p78 I181 1,40 p2359 p1080 p876 p898 1938 I119 12392 11444 h27 p262 p6204 h27 p353 p3672 h27 p666 p,588 I2441 I2778 h27 p667 p,784 I2834 I28 11944 1793 h27 p546 p3581 h27 p335 p1208 h27 p609 p,175 I1052 I1566 I3486 I2641 I797 h27 p396 p,231 I1695 I917 h27 p127 p,212 I1081 I1706 I1432',
);
const PLOUGHMAN = shaped('h5 p77 p4767 p2550 p203 p73 p940 p2927 p1944 p1541 p607');
const size = (blocks, [a, b]) => blocks.slice(a, b).reduce((n, x) => n + x.x.length, 0);

test('a chapter over $5 is cut into the fewest parts of at most $5, even, where the text turns, the same way every time', () => {
  assert.equal(PART_MAX, 7692, '$5 at $0.65 per 1,000 characters');
  const henry = splitChapter(HENRY);
  assert.deepEqual(henry, [[0, 11], [11, 17], [17, 22], [22, 27], [27, 32], [32, 38], [38, 46], [46, 52], [52, 60]]);
  assert.deepEqual(splitChapter(PLOUGHMAN), [[0, 3], [3, 8], [8, 11]]);
  for (const [blocks, parts] of [[HENRY, henry], [PLOUGHMAN, splitChapter(PLOUGHMAN)]]) {
    assert.deepEqual(parts.flat(), [0, ...parts.slice(1).flatMap(([a]) => [a, a]), blocks.length], 'every block once, in order');
    assert.ok(parts.every((r) => size(blocks, r) <= PART_MAX));
    assert.ok(parts.every(([, b]) => blocks[b - 1].t !== 'h'), 'a heading never ends a part');
    assert.equal(parts.length, Math.ceil(size(blocks, [0, blocks.length]) / PART_MAX) + (blocks === HENRY ? 1 : 0), 'as few as the blocks allow');
    assert.deepEqual(splitChapter(blocks), parts, 'deterministic');
  }
  // Henry: of the 8 cuts, 2 before a heading and 4 before a point "II."
  assert.deepEqual(henry.slice(1).map(([a]) => (HENRY[a].t === 'h' ? 'h' : HENRY[a].x.startsWith('II.') ? 'I' : 'p')).join(''), 'phpIIhII');
  // A chapter of $5 or less is one; a block over $5 is a part of its own (with a heading before it).
  assert.equal(splitChapter(shaped('h10 p7000 p682')), null);
  assert.equal(splitChapter([p('x'.repeat(30_000))]), null);
  assert.deepEqual(splitChapter([h('ONE.'), p('a'.repeat(9000)), p(`${'b'.repeat(2999)}.`)]), [[0, 2], [2, 3]]);
  assert.deepEqual(splitChapter([p('a'.repeat(18_000)), p('b'.repeat(20_000))]), [[0, 1], [1, 2]]);
  assert.deepEqual(splitChapter([p(`${'a'.repeat(7691)}.`), h('TWO.'), p(`${'b'.repeat(7691)}.`)]), [[0, 1], [1, 3]], 'a heading over a block of $5 goes with it');
  assert.deepEqual(splitChapter([p(`${'a'.repeat(2999)}.`), h('TWO.'), p(`${'b'.repeat(4689)}.`), p(`${'c'.repeat(2999)}.`)]), [[0, 1], [1, 3], [3, 4]], 'not even to save a part');
  // 1,000 short blocks are cut quickly (each part only looks back as far as it may reach); more
  // blocks, or more than can be translated (300,000 characters), are not cut at all.
  const many = Array.from({ length: 1000 }, () => p(`${'a'.repeat(98)}.`));
  const started = Date.now();
  const cut = splitChapter(many);
  assert.ok(cut.length === 13 && cut.every((r) => size(many, r) <= PART_MAX) && Date.now() - started < 2000, `${Date.now() - started} ms`);
  assert.equal(splitChapter([...many, p('One more.')]), null);
  assert.equal(splitChapter(Array.from({ length: 101 }, () => p(`${'a'.repeat(2999)}.`))), null, '303,000 characters');
});

// Translates every block it is sent as "번역 <n>", with a note on the even ones; its reviews change nothing.
function translator(body) {
  const user = body.messages[0].content;
  if (user.includes('<draft>')) return { text: '<none/>' };
  return { text: blocksIn(user).map(([n]) => `<block n="${n}">번역 ${n}${n % 2 ? '' : `[[주석 ${n}]]`}</block>`).join('\n') };
}

// A chapter of 16,009 characters: three parts. c1 is as long, but translated whole already.
const LONG = [h('ON DEBT.'), ...Array.from({ length: 8 }, (_, i) => p(`${`${i} ${'debt '.repeat(400)}`.slice(0, 1999)}.`))];
function book(dir, meta = {}) {
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Whole', LONG), chapter('c2', 'Debt', LONG), chapter('c3', 'Short', [p('Owe no man anything.')])], meta });
  const tr = path.join(dir, 'papers', 'txt-book', 'translations');
  fs.mkdirSync(tr);
  fs.writeFileSync(path.join(tr, 'c1.json'), JSON.stringify({ version: 1, chapter: 'c1', status: 'ready', model: 'claude-opus-5-5', effort: 'max', prompt: 1, source: 'x', blocks: LONG.map(() => '전체'), notes: [], usage: {}, at: '2026-10-24T00:00:00.000Z' }));
}

test('at startup long chapters are put in parts, an old held state giving way (still held from automatic runs); a chapter translated whole stays whole', async () => {
  const dir = tempDir();
  const translations = {
    c1: { status: 'ready', progress: 1, error: '', auto: false, tries: 1 },
    c2: { status: 'error', progress: 0, error: 'Not translated automatically: about $10.', auto: true, tries: 0 },
  };
  book(dir, { book: { status: 'ready', step: 'done', progress: 1, error: '', chapters: 3, ocr: false, summaries: 0, translations } });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const meta = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c2?.ranges);
    assert.deepEqual(meta.book.translations, { c1: translations.c1, c2: { ranges: [[0, 3], [3, 6], [6, 9]], parts: [], held: true } });
    const whole = await api(srv.url, 'GET', '/api/papers/txt-book/translations/c1', { cookie });
    assert.deepEqual(whole.data.translation.blocks, LONG.map(() => '전체'), 'its file as it was');
    assert.equal(fs.readdirSync(path.join(dir, 'papers', 'txt-book', 'translations')).join(), 'c1.json');
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parts of a chapter translate on their own, in parallel without overwriting each other; Stop and Resume a part; one GET merges them with notes numbered through', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const stub = await anthropicStub(async (body) => {
    if (!body.stream) return {}; // summaries
    if (!body.messages[0].content.includes('part 3 of 3')) await gate;
    return translator(body);
  });
  const dir = tempDir();
  book(dir);
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, TRANSLATE_PARALLEL: '2' } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (part, to = '') => api(srv.url, 'POST', `/api/papers/txt-book/translations/c2${to}`, { cookie, body: part ? { part } : {}, headers: EN });
    const states = async () => (await api(srv.url, 'GET', '/api/papers/txt-book', { cookie })).data.paper.book.translations.c2;
    assert.match((await post(0)).data.error, /in parts/, 'a chapter in parts is asked for by part');
    assert.match((await post(4)).data.error, /no such part/);
    for (const k of [1, 2]) assert.equal((await post(k)).status, 200);
    assert.ok(await waitFor(() => stub.open() === 2, 10000), 'two parts of one chapter at once');
    const busy = await post(3);
    assert.equal(busy.status, 429, 'two at once is the limit, parts included');
    assert.deepEqual((await states()).parts.map((s) => s?.status), ['working', 'working']);
    // Stop part 1: part 2 goes on.
    assert.equal((await post(1, '/cancel')).data.paper.book.translations.c2.parts[0].status, 'cancelled');
    release();
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c2.parts[1]?.status === 'ready');
    assert.equal((await states()).parts[0].status, 'cancelled');
    for (const k of [3, 1]) assert.equal((await post(k)).status, 200);
    const done = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c2.parts.every((s) => s?.status === 'ready') && m.book.translations.c2.parts.length === 3);
    assert.deepEqual(done.book.translations.c2.ranges, [[0, 3], [3, 6], [6, 9]], 'kept');
    const files = ['c2.p1.json', 'c2.p2.json', 'c2.p3.json'].map((f) => readJson(dir, 'papers', 'txt-book', 'translations', f));
    assert.deepEqual(files.map((f) => [f.part, f.from, f.to, f.status, f.blocks.length]), [[1, 0, 3, 'ready', 3], [2, 3, 6, 'ready', 3], [3, 6, 9, 'ready', 3]]);
    assert.deepEqual(files[1].blocks, ['번역 3', '번역 4[^1]', '번역 5'], "each part's notes from 1");

    const got = (await api(srv.url, 'GET', '/api/papers/txt-book/translations/c2', { cookie })).data.translation;
    assert.deepEqual(got.blocks, ['번역 0[^1]', '번역 1', '번역 2[^2]', '번역 3', '번역 4[^3]', '번역 5', '번역 6[^4]', '번역 7', '번역 8[^5]']);
    assert.deepEqual(got.notes, ['주석 0', '주석 2', '주석 4', '주석 6', '주석 8']);
    assert.deepEqual([got.done, got.stale], [[1, 2, 3], false]);

    // Part 3 (translated after part 2 and before part 1 was done) was told where it is, the Korean
    // just before it, and the notes of the others.
    const third = stub.chats().find((r) => r.messages[0].content.includes('part 3 of 3') && !r.messages[0].content.includes('<draft>')).messages[0].content;
    assert.match(third, /This chapter is translated in parts; this is part 3 of 3, blocks 6–8\.\nThe Korean of block 5, just before this part, for the same terms and tone:\n<previous>번역 5<\/previous>\n\nFootnotes given earlier in this chapter, not to repeat:\n- 주석 4\n\nTranslate blocks 6–7\.$/);
    assert.ok(third.startsWith('<block n="6">'));

    // A ready part is translated again only when asked with `again`, as a whole chapter is (its
    // file gone, say).
    fs.rmSync(path.join(dir, 'papers', 'txt-book', 'translations', 'c2.p2.json'));
    const asked = stub.chats().length;
    assert.equal((await post(2)).data.paper.book.translations.c2.parts[1].status, 'ready');
    await sleep(200);
    assert.equal(stub.chats().length, asked, 'nothing bought');
    const again = await api(srv.url, 'POST', '/api/papers/txt-book/translations/c2', { cookie, body: { part: 2, again: true }, headers: EN });
    assert.equal(again.data.paper.book.translations.c2.parts[1].status, 'queued');
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c2.parts[1].status === 'ready');
    assert.equal(readJson(dir, 'papers', 'txt-book', 'translations', 'c2.p2.json').status, 'ready');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('at startup a part cut short starts again and a stopped one stays stopped, and a whole chapter cut short stays whole; TRANSLATE_AUTO starts only part 1 of a chapter in parts, and none of one held', async () => {
  const stub = await anthropicStub((body) => (body.stream ? translator(body) : {}));
  const dir = tempDir();
  const anthropic = { protocol: 'anthropic', baseUrl: stub.url, apiKey: 'sk-test', model: 'claude-opus-5-5' };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ llm: { preset: 'anthropic', providers: { anthropic } } }));
  // (ranges other than the ones it would cut now: once a part has begun, they stay)
  const translations = { c2: { ranges: [[0, 4], [4, 7], [7, 9]], parts: [{ status: 'working', progress: 0, tries: 1 }, { status: 'cancelled', progress: 0, tries: 1 }] } };
  book(dir, { book: { status: 'ready', step: 'done', progress: 1, error: '', chapters: 3, ocr: false, summaries: 0, translations } });
  // A second book whose first chapter is long, for TRANSLATE_AUTO; a third whose long chapter was
  // held by an automatic run for its cost; a fourth whose long chapter was being translated whole
  // when the server stopped, nothing saved yet.
  writeBookFixture(dir, 'txt-auto', { chapters: [chapter('c1', 'Chapter One', LONG)] });
  const held = { c1: { status: 'error', progress: 0, error: 'Not translated automatically: about $10.', auto: true, tries: 0 } };
  writeBookFixture(dir, 'txt-held', { chapters: [chapter('c1', 'Chapter One', LONG)], meta: { book: { status: 'ready', step: 'done', progress: 1, error: '', chapters: 1, ocr: false, summaries: 0, translations: held } } });
  const whole = { c1: { status: 'working', progress: 0, auto: false, tries: 1 } };
  writeBookFixture(dir, 'txt-whole', { chapters: [chapter('c1', 'Debt', LONG)], meta: { book: { status: 'ready', step: 'done', progress: 1, error: '', chapters: 1, ocr: false, summaries: 0, translations: whole } } });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, TRANSLATE_AUTO: '1' } });
  try {
    const cookie = await signIn(srv.url, PW);
    const meta = await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c2.parts[0].status === 'ready');
    assert.deepEqual(meta.book.translations.c2.ranges, [[0, 4], [4, 7], [7, 9]]);
    assert.equal(meta.book.translations.c2.parts[1].status, 'cancelled');
    assert.equal(meta.book.translations.c2.parts[2], undefined);
    assert.deepEqual(readJson(dir, 'papers', 'txt-book', 'translations', 'c2.p1.json').blocks, ['번역 0[^1]', '번역 1', '번역 2[^2]', '번역 3']);
    const auto = await waitForPaper(srv.url, cookie, 'txt-auto', (m) => m.book.translations?.c1?.parts?.[0]?.status === 'ready');
    assert.deepEqual(auto.book.translations.c1.parts.map((s) => s?.auto), [true]);
    const done = (await waitForPaper(srv.url, cookie, 'txt-whole', (m) => m.book.translations.c1.status === 'ready')).book.translations.c1;
    assert.equal(done.ranges, undefined, 'resumed whole, not put in parts');
    assert.equal(readJson(dir, 'papers', 'txt-whole', 'translations', 'c1.json').blocks.length, LONG.length);
    const sent = stub.chats().filter((r) => r.messages[0].content.includes('Translate blocks'));
    const inParts = sent.filter((r) => /this is part/.test(r.messages[0].content));
    assert.ok(inParts.length >= 2 && sent.length > inParts.length);
    assert.deepEqual([...new Set(inParts.map((r) => /part (\d) of 3/.exec(r.messages[0].content)[1]))], ['1'], 'part 1 only, of both books in parts');
    assert.deepEqual((await api(srv.url, 'GET', '/api/papers/txt-held', { cookie })).data.paper.book.translations, { c1: { ranges: [[0, 3], [3, 6], [6, 9]], parts: [], held: true } }, 'held: nothing started');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Sentences that say their number, and a paragraph of them.
const sentence = (i) => `Debt number ${i} is a heavy load to carry about, and it never grows lighter with the years.`;
const para = (from, n) => Array.from({ length: n }, (_, i) => sentence(from + i)).join(' ');
const firstNumber = (x) => /\d+/.exec(x)?.[0] ?? '-';

test('a paragraph over 3,000 characters is cut into pieces of whole sentences, about even, never after the number of a point', () => {
  const text = para(0, 70);
  const pieces = piecesOf(text);
  const sizes = pieces.map(([a, z]) => z - a);
  assert.equal(pieces.length, 3);
  assert.equal(pieces.map(([a, z]) => text.slice(a, z)).join(''), text, 'together, the paragraph');
  assert.ok(sizes.every((n) => n <= 3000) && Math.max(...sizes) - Math.min(...sizes) < 200, sizes.join());
  for (const [, z] of pieces.slice(0, -1)) assert.match(text.slice(z), /^Debt number \d+ is/, 'cut between sentences');
  assert.deepEqual(piecesOf(text), pieces, 'deterministic');
  // Points "(2.)", "2." and "II.": a cut before one or between sentences, never right after its number.
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  for (const mark of [(i) => `(${i + 1}.)`, (i) => `${i + 1}.`, (i) => `${roman[i % 10]}.`]) {
    const points = Array.from({ length: 36 }, (_, i) => `${mark(i)} ${sentence(i)} ${sentence(i + 100)}`).join(' ');
    const cuts = piecesOf(points);
    assert.ok(cuts.length === 3 && cuts.every(([a, z]) => z - a <= 3000));
    for (const [a, z] of cuts.slice(0, -1)) assert.match(points.slice(a, z), /years\. $/, mark(1));
  }
  // No sentence ends: after a clause, else between words, else at the limit. Short: one piece.
  assert.ok(piecesOf('debt, '.repeat(1000)).every(([a, z], i, all) => i === all.length - 1 || 'debt, '.repeat(1000).slice(a, z).endsWith(', ')));
  assert.deepEqual(piecesOf('debt '.repeat(1200)).map(([a, z]) => z - a), [3000, 3000]);
  assert.deepEqual(piecesOf('x'.repeat(7000)), [[0, 3000], [3000, 6000], [6000, 7000]]);
  assert.deepEqual(piecesOf(para(0, 30)), [[0, para(0, 30).length]]);
});

test('a paragraph over 3,000 characters is translated a piece at a time and joined into its one block, its notes numbered through the chapter; Stop keeps the pieces done', async () => {
  let hold = true;
  const stub = await anthropicStub((body) => {
    if (!body.stream) return {}; // summaries
    const user = body.messages[0].content;
    if (user.includes('<draft>')) return { text: '<none/>' };
    if (hold && user.includes('below is piece 2 of 3')) return { hang: true };
    return { text: blocksIn(user).map(([n, x]) => `<block n="${n}">번역 ${n}: ${firstNumber(x)}[[주석 ${n}: ${firstNumber(x)}]]</block>`).join('\n') };
  });
  const dir = tempDir();
  // Part 1 has a paragraph of 3,500 characters (two pieces) between a heading and two more;
  // part 2 is a paragraph of 6,300 (three pieces) and a short line.
  const mid = para(200, 38);
  const big = para(0, 70);
  const blocks = [h('ON DEBT.'), p(mid), p(para(400, 2)), p(para(100, 22)), p(big), p('Owe no man anything.')];
  writeBookFixture(dir, 'txt-book', { chapters: [chapter('c1', 'Debt', blocks)] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub);
    const post = (part, to = '') => api(srv.url, 'POST', `/api/papers/txt-book/translations/c1${to}`, { cookie, body: { part }, headers: EN });
    const state = async () => (await api(srv.url, 'GET', '/api/papers/txt-book', { cookie })).data.paper.book.translations.c1;
    const file = () => readJson(dir, 'papers', 'txt-book', 'translations', 'c1.p2.json');
    const pieces = piecesOf(big);
    const keys = pieces.map((r) => r.join('-'));
    const starts = pieces.map(([a]) => firstNumber(big.slice(a)));
    const halves = piecesOf(mid).map(([a]) => firstNumber(mid.slice(a)));
    assert.equal(halves.length, 2);

    assert.equal((await post(2)).status, 200);
    assert.ok(await waitFor(async () => stub.open() === 1 && (await state()).parts[1].progress > 0, 10000), 'piece 1 done, piece 2 on its way');
    const part = big.length + blocks[5].x.length;
    assert.equal((await state()).ranges.join(' '), '0,4 4,6');
    assert.equal((await state()).parts[1].progress, Math.floor(((pieces[0][1] - pieces[0][0]) / part) * 100) / 100, 'a piece counts as done');
    assert.equal((await post(2, '/cancel')).data.paper.book.translations.c1.parts[1].status, 'cancelled');
    assert.deepEqual([file().status, file().blocks, file().pieces], ['partial', [null, null], { 0: { [keys[0]]: `번역 4: 0[[주석 4: 0]]` } }]);

    hold = false;
    assert.equal((await post(2)).status, 200);
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c1.parts[1]?.status === 'ready');
    assert.equal((await post(1)).status, 200);
    await waitForPaper(srv.url, cookie, 'txt-book', (m) => m.book.translations.c1.parts[0]?.status === 'ready');

    const sent = stub.chats().map((r) => r.messages[0].content).filter((u) => !u.includes('<draft>'));
    const piece = (k) => sent.filter((u) => u.includes(`below is piece ${k} of 3`));
    assert.deepEqual([1, 2, 3].map((k) => piece(k).length), [1, 2, 1], 'piece 1 not again after the stop');
    const texts = [1, 2, 3].map((k) => blocksIn(piece(k).at(-1)));
    assert.ok(texts.every((t) => t.length === 1 && t[0][0] === 4 && t[0][1].length <= 3000), 'block 4, a piece at a time');
    assert.equal(texts.map((t) => t[0][1]).join(' '), big);
    assert.match(
      piece(2).at(-1),
      /\n\nThis chapter is translated in parts; this is part 2 of 2, blocks 4–5\.\n\nBlock 4 is long, so it is translated in 3 pieces cut between sentences; below is piece 2 of 3\. Translate this piece only, as <block n="4">\.\nThe Korean of piece 1, which this one goes on from:\n<previous>번역 4: 0<\/previous>\n\nFootnotes given earlier in this chapter, not to repeat:\n- 주석 4: 0\n\nTranslate blocks 4–4\.$/,
    );
    assert.deepEqual([file().blocks, file().pieces], [[`번역 4: 0[^1] 번역 4: ${starts[1]}[^2] 번역 4: ${starts[2]}[^3]`, '번역 5: -[^4]'], {}]);
    const got = (await api(srv.url, 'GET', '/api/papers/txt-book/translations/c1', { cookie })).data.translation;
    assert.deepEqual(got.blocks, ['번역 0: -[^1]', `번역 1: 200[^2] 번역 1: ${halves[1]}[^3]`, '번역 2: 400[^4]', '번역 3: 100[^5]', `번역 4: 0[^6] 번역 4: ${starts[1]}[^7] 번역 4: ${starts[2]}[^8]`, '번역 5: -[^9]']);
    assert.deepEqual(got.notes, ['주석 0: -', '주석 1: 200', `주석 1: ${halves[1]}`, '주석 2: 400', '주석 3: 100', '주석 4: 0', `주석 4: ${starts[1]}`, `주석 4: ${starts[2]}`, '주석 5: -']);
    // Part 1: the heading alone, the paragraph of 3,500 in two pieces, the two after it together.
    assert.deepEqual(sent.filter((u) => u.includes('part 1 of 2')).map((u) => u.match(/below is piece \d of \d|Translate blocks [\d–]+\.$/g).join(' ')), [
      'Translate blocks 0–0.',
      'below is piece 1 of 2 Translate blocks 1–1.',
      'below is piece 2 of 2 Translate blocks 1–1.',
      'Translate blocks 2–3.',
    ]);
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
