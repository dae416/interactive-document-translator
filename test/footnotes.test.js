// A translation's footnotes placed in the English (server/footnotes.js), against an Anthropic stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anthropicStub, api, signIn, startServer, tempDir, waitFor, writeBookFixture } from './helpers.js';

const PW = 'test-password';
const h = (x) => ({ t: 'h', x });
const p = (x) => ({ t: 'p', x });
const chapter = (id, title, blocks) => ({ id, title, blocks, pages: null, url: null });

const EN1 =
  'It is of no more use to give advice to the idle than to pour water into a sieve; and as to improving them, one might as well try to fatten a greyhound. Yet, as The Old Book tells us to "cast our bread upon the waters," we will cast a hard crust or two upon these stagnant ponds.';
const KO1 =
  '게으른 사람에게 충고하는 것은 체에 물을 붓는 것만큼이나 소용없는 일이다. 그들을 고쳐 보겠다는 건 그레이하운드[^1]를 살찌우려는 것과 다를 바 없다. 그래도 옛 책[^2]이 우리에게 “빵을 물 위에 던지라”[^3]고 하니, 우리도 이 고여서 썩은 웅덩이들 위에 딱딱한 빵 껍질 한두 조각쯤은 던져 보련다.';
const EN2 = "An idle man is the devil's pillow, and the idle hand is his tool.";
const KO2 = '게으른 사람은 마귀의 베개[^4]요, 게으른[^5] 손은 그의 연장이다.';
const EN3 = 'Plough deep while sluggards sleep.';
const KO3 = '게으름뱅이[^6]가 잘 때 깊이 갈아라.';
const NOTES = ['몸이 날씬하고 빠른 사냥개.', '성경을 가리키는 말.', '전도서 11:1.', '편히 기대어 쉬는 곳.', 'idle: 일하지 않는.', '게으른 사람.'];

// What the stub answers for each note it is asked about: the English words, or ones that are not
// there ("grayhound"), or a third "idle" in a block with two.
const ANSWERS = {
  1: { phrase: 'grayhound', occurrence: 1 },
  2: { phrase: 'The Old Book', occurrence: 1 },
  3: { phrase: 'cast our bread upon the waters', occurrence: 1 },
  4: { phrase: "the devil's pillow", occurrence: 1 },
  5: { phrase: 'idle', occurrence: 2 },
  6: { phrase: 'sluggards', occurrence: 1 },
};
const asked = (body) => [...body.messages[0].content.matchAll(/<note n="(\d+)">/g)].map((m) => Number(m[1]));
const placer = (body) => ({ text: `Here you are:\n${JSON.stringify(Object.fromEntries(asked(body).map((n) => [n, ANSWERS[n]])))}`, delayMs: 150 });

function setup(stub, blocks, notes) {
  const dir = tempDir();
  const anthropic = { protocol: 'anthropic', baseUrl: stub.url, apiKey: 'sk-test', model: 'claude-opus-5-5' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ llm: { preset: 'anthropic', providers: { anthropic } } }));
  writeBookFixture(dir, 'txt-notes', { chapters: [chapter('c1', 'To the Idle', [h('TO THE IDLE.'), p(EN1), p(EN2), p(EN3)])] });
  const file = path.join(dir, 'papers', 'txt-notes', 'translations', 'c1.json');
  const write = (b, n) => fs.writeFileSync(file, JSON.stringify({ version: 1, chapter: 'c1', status: 'ready', blocks: b, notes: n, model: 'claude-opus-5-5', at: new Date().toISOString() }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(blocks, notes);
  return { dir, file, write, sidecar: () => JSON.parse(fs.readFileSync(path.join(dir, 'papers', 'txt-notes', 'translations', 'c1.notes-src.json'), 'utf8')) };
}
const usage = (dir) => fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const after = (text, words, k = 1) => {
  let at = -1;
  for (let i = 0; i < k; i++) at = text.indexOf(words, at + 1);
  return at + words.length;
};

test('notes go after the words they explain; words that are not there fall back to the end of the aligned sentence; a repeated word is found by its occurrence', async () => {
  const stub = await anthropicStub(placer);
  const { dir, file, sidecar } = setup(stub, ['게으른 사람들에게', KO1, KO2, null], NOTES.slice(0, 5));
  const before = fs.readFileSync(file, 'utf8');
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const res = await api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.notes, {
      1: { b: 1, at: after(EN1, 'fatten a greyhound.'), by: 'sentence' },
      2: { b: 1, at: after(EN1, 'The Old Book'), by: 'phrase' },
      3: { b: 1, at: after(EN1, 'cast our bread upon the waters'), by: 'phrase' },
      4: { b: 2, at: after(EN2, "the devil's pillow"), by: 'phrase' },
      5: { b: 2, at: after(EN2, 'idle', 2), by: 'phrase' },
    });
    // One call, with only the blocks that have notes, made with Haiku without thinking.
    assert.equal(stub.requests.length, 1);
    const [body] = stub.requests;
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.ok(body.max_tokens <= 400, `max_tokens ${body.max_tokens}`);
    assert.deepEqual(asked(body), [1, 2, 3, 4, 5]);
    assert.ok(!body.messages[0].content.includes('TO THE IDLE'));
    // Logged like the other model calls; the translation itself untouched; the result kept.
    assert.deepEqual(
      usage(srv.dataDir).map((u) => [u.paper, u.chapter, u.action, u.model, u.attempt]),
      [['txt-notes', 'c1', 'notes-src', 'claude-haiku-5-5', 1]],
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(Object.keys(sidecar().blocks), ['1', '2']);
    const again = await api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    assert.deepEqual(again.data, res.data);
    assert.equal(stub.requests.length, 1, 'kept: no second call');
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('notes a translation gains later are placed alone; the ones placed before are kept', async () => {
  const stub = await anthropicStub(placer);
  const { dir, write, sidecar } = setup(stub, ['게으른 사람들에게', KO1, null, null], NOTES.slice(0, 3));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const first = await api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    assert.deepEqual(Object.keys(first.data.notes), ['1', '2', '3']);
    const kept = sidecar().blocks[1];
    // More of the chapter translated, with three more notes.
    write(['게으른 사람들에게', KO1, KO2, KO3], NOTES);
    const second = await api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(asked(stub.requests[1]), [4, 5, 6], 'only the new notes');
    assert.ok(!stub.requests[1].messages[0].content.includes(EN1));
    assert.deepEqual(second.data.notes[6], { b: 3, at: after(EN3, 'sluggards'), by: 'phrase' });
    assert.deepEqual(second.data.notes[1], first.data.notes[1]);
    assert.deepEqual(sidecar().blocks[1], kept);
    // A block whose Korean changed (a review, say) is placed again; the others stay.
    write(['게으른 사람들에게', KO1, KO2.replace('연장', '도구'), KO3], NOTES);
    await api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    assert.deepEqual(asked(stub.requests[2]), [4, 5]);
    // A block that has lost its notes is dropped.
    write(['게으른 사람들에게', KO1, KO2.replace(/\[\^\d\]/g, ''), KO3], [...NOTES.slice(0, 3), '', '', NOTES[5]]);
    const last = await api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    assert.equal(stub.requests.length, 3);
    assert.deepEqual(Object.keys(last.data.notes), ['1', '2', '3', '6']);
    assert.deepEqual(Object.keys(sidecar().blocks), ['1', '3']);
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('a reply cut short keeps its whole entries; the notes it lost go to their sentences', async () => {
  const stub = await anthropicStub(() => ({ text: '```json\n{"1": {"phrase": "greyhound", "occurrence": 1}, "2": {"phrase": "The Ol', stopReason: 'max_tokens' }));
  const { dir, sidecar } = setup(stub, ['게으른 사람들에게', KO1, null, null], NOTES.slice(0, 3));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const res = await api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    assert.deepEqual(res.data.notes, {
      1: { b: 1, at: after(EN1, 'greyhound'), by: 'phrase' },
      2: { b: 1, at: EN1.length, by: 'sentence' },
      3: { b: 1, at: EN1.length, by: 'sentence' },
    });
    assert.deepEqual(Object.keys(sidecar().blocks), ['1'], 'the model answered: kept');
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('a book deleted while its notes are being placed is not brought back', async () => {
  const stub = await anthropicStub((body) => ({ ...placer(body), delayMs: 1500 }));
  const { dir } = setup(stub, ['게으른 사람들에게', KO1, null, null], NOTES.slice(0, 3));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const placing = api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    await waitFor(() => stub.requests.length === 1);
    assert.equal((await api(srv.url, 'DELETE', '/api/papers/txt-notes', { cookie })).status, 200);
    assert.equal((await placing).status, 404);
    assert.equal(fs.existsSync(path.join(dir, 'papers', 'txt-notes')), false);
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('two first requests at once make one call and agree; without a key the fallbacks serve and nothing is kept', async () => {
  const stub = await anthropicStub(placer);
  const { dir, sidecar } = setup(stub, ['게으른 사람들에게', KO1, KO2, KO3], NOTES);
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const get = () => api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    const [a, b] = await Promise.all([get(), get()]);
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(a.data, b.data);
    assert.deepEqual(Object.keys(sidecar().blocks), ['1', '2', '3']);
    assert.equal(fs.readdirSync(path.join(dir, 'papers', 'txt-notes', 'translations')).filter((f) => f.includes('.tmp')).length, 0);
  } finally {
    await srv.stop();
    await stub.close();
  }
  const keyless = await anthropicStub(placer);
  const other = setup(keyless, ['게으른 사람들에게', KO1, null, null], NOTES.slice(0, 3));
  fs.writeFileSync(path.join(other.dir, 'config.json'), JSON.stringify({ llm: { preset: 'anthropic', providers: { anthropic: { protocol: 'anthropic', baseUrl: keyless.url, apiKey: '', model: 'auto' } } } }));
  const srv2 = await startServer({ dataDir: other.dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv2.url, PW);
    const res = await api(srv2.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    assert.deepEqual(res.data.notes[2], { b: 1, at: EN1.length, by: 'sentence' });
    assert.equal(keyless.requests.length, 0);
    assert.equal(fs.existsSync(path.join(other.dir, 'papers', 'txt-notes', 'translations', 'c1.notes-src.json')), false);
    const missing = await api(srv2.url, 'GET', '/api/papers/txt-notes/translations/c9/notes-src', { cookie });
    assert.equal(missing.status, 400);
  } finally {
    await srv2.stop();
    await keyless.close();
  }
});

test('in a chapter in parts, a part done later has its notes placed alone; the notes of the part after it keep their places under their new numbers', async () => {
  // The words each note explains, whatever number it has.
  const WORDS = { [NOTES[0]]: 'greyhound', [NOTES[1]]: 'The Old Book', [NOTES[2]]: 'cast our bread upon the waters', [NOTES[3]]: "the devil's pillow", [NOTES[4]]: 'idle', [NOTES[5]]: 'sluggards' };
  const stub = await anthropicStub((body) => {
    const found = [...body.messages[0].content.matchAll(/<note n="(\d+)">([^<]*)<\/note>/g)].map(([, n, text]) => [n, { phrase: WORDS[text], occurrence: text === NOTES[4] ? 2 : 1 }]);
    return { text: JSON.stringify(Object.fromEntries(found)) };
  });
  // Blocks 0-1 are part 1, blocks 2-3 part 2; part 2 is translated first, its notes numbered from 1.
  const { dir, file } = setup(stub, [], []);
  fs.rmSync(file);
  const book = path.join(dir, 'papers', 'txt-notes');
  const meta = JSON.parse(fs.readFileSync(path.join(book, 'meta.json'), 'utf8'));
  const plan = (parts) => fs.writeFileSync(path.join(book, 'meta.json'), JSON.stringify({ ...meta, book: { ...meta.book, translations: { c1: { ranges: [[0, 2], [2, 4]], parts } } } }));
  const part = (k, from, to, blocks, notes) => fs.writeFileSync(path.join(book, 'translations', `c1.p${k}.json`), JSON.stringify({ version: 1, chapter: 'c1', part: k, from, to, status: 'ready', blocks, notes, at: new Date().toISOString() }));
  plan([null, { status: 'ready', progress: 1 }]);
  part(2, 2, 4, [KO2.replace('[^4]', '[^1]').replace('[^5]', '[^2]'), KO3.replace('[^6]', '[^3]')], NOTES.slice(3));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const get = () => api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    const first = (await get()).data.notes;
    assert.deepEqual(first, {
      1: { b: 2, at: after(EN2, "the devil's pillow"), by: 'phrase' },
      2: { b: 2, at: after(EN2, 'idle', 2), by: 'phrase' },
      3: { b: 3, at: after(EN3, 'sluggards'), by: 'phrase' },
    });
    // Part 1 done: its notes come first, and part 2's are 4-6 now.
    part(1, 0, 2, ['게으른 사람들에게', KO1], NOTES.slice(0, 3));
    plan([{ status: 'ready', progress: 1 }, { status: 'ready', progress: 1 }]);
    const second = (await get()).data.notes;
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(asked(stub.requests[1]), [1, 2, 3], "only part 1's notes");
    assert.ok(stub.requests[1].messages[0].content.includes(EN1) && !stub.requests[1].messages[0].content.includes(EN2));
    assert.deepEqual(second[1], { b: 1, at: after(EN1, 'greyhound'), by: 'phrase' });
    assert.deepEqual([second[4], second[5], second[6]], [first[1], first[2], first[3]]);
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('a request from another site is refused; after a call that failed the fallbacks serve, and the model is not asked again for a while', async () => {
  const stub = await anthropicStub(() => ({ status: 500 }));
  const { dir, sidecar } = setup(stub, ['게으른 사람들에게', KO1, null, null], NOTES.slice(0, 3));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const get = (headers = {}) => api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie, headers });
    assert.equal((await get({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(stub.requests.length, 0);
    const first = await get();
    assert.equal(first.status, 200);
    assert.equal(stub.requests.length, 5, 'made again after each failure on its way, then given up');
    assert.deepEqual(first.data.notes[2], { b: 1, at: EN1.length, by: 'sentence' });
    const second = await get();
    assert.equal(stub.requests.length, 5, 'not asked again so soon');
    assert.deepEqual(second.data, first.data);
    assert.throws(sidecar, 'nothing kept');
  } finally {
    await srv.stop();
    await stub.close();
  }
});

test('a placement asked for while another is on its way answers for the translation as it is then: a part done meanwhile is placed after it, alone', async () => {
  const WORDS = { [NOTES[0]]: 'greyhound', [NOTES[1]]: 'The Old Book', [NOTES[2]]: 'cast our bread upon the waters', [NOTES[3]]: "the devil's pillow", [NOTES[4]]: 'idle', [NOTES[5]]: 'sluggards' };
  const stub = await anthropicStub((body) => {
    const found = [...body.messages[0].content.matchAll(/<note n="(\d+)">([^<]*)<\/note>/g)].map(([, n, text]) => [n, { phrase: WORDS[text], occurrence: text === NOTES[4] ? 2 : 1 }]);
    return { text: JSON.stringify(Object.fromEntries(found)), delayMs: 600 };
  });
  const { dir, file } = setup(stub, [], []);
  fs.rmSync(file);
  const book = path.join(dir, 'papers', 'txt-notes');
  const meta = JSON.parse(fs.readFileSync(path.join(book, 'meta.json'), 'utf8'));
  const plan = (parts) => fs.writeFileSync(path.join(book, 'meta.json'), JSON.stringify({ ...meta, book: { ...meta.book, translations: { c1: { ranges: [[0, 2], [2, 4]], parts } } } }));
  const part = (k, from, to, blocks, notes) => fs.writeFileSync(path.join(book, 'translations', `c1.p${k}.json`), JSON.stringify({ version: 1, chapter: 'c1', part: k, from, to, status: 'ready', blocks, notes, at: new Date().toISOString() }));
  plan([null, { status: 'ready', progress: 1 }]);
  part(2, 2, 4, [KO2.replace('[^4]', '[^1]').replace('[^5]', '[^2]'), KO3.replace('[^6]', '[^3]')], NOTES.slice(3));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const get = () => api(srv.url, 'GET', '/api/papers/txt-notes/translations/c1/notes-src', { cookie });
    const early = get();
    await waitFor(() => stub.requests.length === 1);
    // Part 1 done while part 2's notes are being placed.
    part(1, 0, 2, ['게으른 사람들에게', KO1], NOTES.slice(0, 3));
    plan([{ status: 'ready', progress: 1 }, { status: 'ready', progress: 1 }]);
    const [a, b] = await Promise.all([early, get()]);
    assert.deepEqual(Object.keys(a.data.notes), ['1', '2', '3']);
    assert.deepEqual(Object.keys(b.data.notes), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual([b.data.notes[4], b.data.notes[1]], [a.data.notes[1], { b: 1, at: after(EN1, 'greyhound'), by: 'phrase' }]);
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(asked(stub.requests[1]), [1, 2, 3], "after the first: only part 1's notes");
  } finally {
    await srv.stop();
    await stub.close();
  }
});
