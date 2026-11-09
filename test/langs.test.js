// Any two languages: a book in one, read with help in another. The other tests read English books in
// Korean, the default; these read a Japanese book in English, an English book in Spanish or in
// Japanese: the prompts name those languages, settings and books choose them, and sentences and
// clauses of text written without spaces are cut where it reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anthropicStub, api, chat, signIn, startServer, tempDir, useStub, waitForPaper, writeBookFixture } from './helpers.js';

globalThis.document ??= { documentElement: {} }; // (i18n.js sets the page language when it loads)
const { autonym, baseLang, countWords, langLabel, langName, scriptCounts, setLangs, spaced } = await import('../public/assets/js/langs.js');
const { align, clauses, pairClauses, sentences } = await import('../public/assets/js/sentences.js');
const { bookMessage, bookMode } = await import('../public/assets/js/ai.js');
const { normLang, ocrLang, tagsOf, withArticle, wordsFor } = await import('../server/langs.js');
const { instructions } = await import('../server/context.js');
const { piecesOf } = await import('../server/translate.js');
const { lookupKey } = await import('../server/lookups.js');
const { routeTurn } = await import('../server/llm/router.js');

const PW = 'test-password';
const h = (x) => ({ t: 'h', x });
const p = (x) => ({ t: 'p', x });
const chapter = (id, title, blocks) => ({ id, title, blocks, pages: null, url: null });
const cut = (text, lang) => sentences(text, lang).map(([s, e]) => text.slice(s, e));
const pieces = (text) => clauses(text, [0, text.length]).map((c) => text.slice(...c));
// Natsume Sōseki, "I Am a Cat" (1905), its opening.
const NEKO = '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。';
const NEKO2 = 'この書生というのは時々我々を捕えて煮て食うという話である。しかしその当時は何という考もなかったから別段恐しいとも思わなかった。ただ彼の掌に載せられてスーと持ち上げられた時何だかフワフワした感じがあったばかりである。';
const CAT = 'I am a cat. As yet I have no name, and I have no idea where I was born.';

test('codes, names and labels of languages', () => {
  assert.deepEqual([normLang('KO'), normLang('zh-hant'), normLang('pt-br'), normLang('english'), normLang('xx'), normLang(''), normLang(3)], ['ko', 'zh-Hant', 'pt-BR', '', '', '', '']);
  assert.deepEqual([langName('ja'), langName('ko', 'zh'), langLabel('es'), langLabel('zh-Hant'), baseLang('zh-Hant')], ['Japanese', '韩语', 'ES', 'ZH-HANT', 'zh']);
  assert.deepEqual(['ko', 'es', 'ja', 'en', 'zh-Hans'].map(autonym), ['한국어', 'Español', '日本語', 'English', '简体中文']);
  assert.deepEqual(['English', 'Korean', 'Italian', 'Ukrainian', 'Urdu'].map((n) => withArticle(n)), ['an English', 'a Korean', 'an Italian', 'a Ukrainian', 'an Urdu']);
  assert.deepEqual([tagsOf({ src: 'en', tgt: 'ko' }), tagsOf({ src: 'nb', tgt: 'zh-Hans' }), tagsOf({ src: 'en', tgt: 'en-GB' })], [
    { s: 'english', t: 'korean' },
    { s: 'norwegian_bokmal', t: 'simplified_chinese' },
    { s: 'english', t: 'british_english' },
  ]);
  assert.deepEqual([spaced('ko'), spaced('en'), spaced('ja'), spaced('zh-Hant'), spaced('th')], [true, true, false, false, false]);
  assert.deepEqual([ocrLang('en'), ocrLang('fr'), ocrLang('de-AT'), ocrLang('zh-Hant'), ocrLang('zh'), ocrLang('tlh')], [null, 'fra', 'deu', 'chi_tra', 'chi_sim', null]);
  assert.deepEqual([countWords('hello, world'), countWords('吾輩は猫である'), countWords('나는 고양이로소이다')], [2, 7, 2]);
  assert.deepEqual(scriptCounts(`${NEKO} ${CAT}`, 'ja', 'en'), [117, 50]);
  assert.equal(scriptCounts('Hola, amigo. Hello, friend.', 'es', 'en'), null, 'one script: no telling');
  // Japanese and Chinese share Han: Japanese is told by its kana, Chinese not at all.
  const zh = '我们去了公园，看见了许多花，然后回家了。';
  assert.deepEqual([scriptCounts(zh, 'ja', 'zh'), scriptCounts(NEKO, 'ja', 'zh')], [[0, 0], [82, 0]]);
  assert.deepEqual([scriptCounts(NEKO, 'zh', 'ja'), scriptCounts(zh, 'zh-Hans', 'zh-Hant')], [null, null]);
});

test('the prompts name the pair: an English book read in Spanish, a Japanese one in English; Korean keeps its own conventions', () => {
  const es = instructions('Español', { src: 'en', tgt: 'es' });
  assert.match(es, /^You are a reading companion for a Spanish reader working through an English book\./);
  assert.match(es, /older English, to read the selection/);
  assert.match(es, /Answer in Español\./);
  assert.match(es, /Selection lang="es": part of the Spanish translation shown beside the book; the paragraph is its English original\./);
  assert.match(es, /Keep names and Scripture references recognizable\. Never repeat/);
  const ja = instructions('English', { src: 'ja', tgt: 'en' });
  assert.match(ja, /^You are a reading companion for an English reader working through a Japanese book\./);
  assert.match(ja, /quoting only the few Japanese words that matter/);
  assert.doesNotMatch(`${es}${ja}`, /Korean|호세아/);
  assert.match(instructions('한국어'), /a Korean reader working through an English book[\s\S]*"Hos\. viii\. 12" → 호세아 8:12\)\./);
  const w = wordsFor({ src: 'en', tgt: 'ja' });
  assert.deepEqual([w.S, w.T, w.aT, w.AT, w.spaced, w.note], ['English', 'Japanese', 'a Japanese', 'A Japanese', false, 'note']);
  assert.match(w.names, /^Names in their usual Japanese form; Bible books and people by their usual Japanese names\.$/);
  assert.match(w.examples, /do the same for English and Japanese/);
  assert.equal(wordsFor({ src: 'en', tgt: 'ko' }).examples, 'Examples:');
  assert.match(wordsFor({ src: 'fr', tgt: 'ko' }).names, /외래어 표기법/);
});

test('sentences and clauses where words have no spaces between them, and a Spanish one', () => {
  assert.deepEqual(cut(NEKO, 'ja').slice(0, 3), ['吾輩は猫である。', '名前はまだ無い。', 'どこで生れたかとんと見当がつかぬ。']);
  assert.deepEqual(cut('他来了！你呢？我很好。', 'zh'), ['他来了！', '你呢？', '我很好。']);
  assert.deepEqual(pieces('我们去了公园，看见了许多花，然后回家了。'), ['我们去了公园，', '看见了许多花，', '然后回家了。']);
  assert.deepEqual(pieces('私は学校へ行って、友達に会い、それから家に帰りました。'), ['私は学校へ行って、', '友達に会い、', 'それから家に帰りました。']);
  // A piece of fewer than three words (characters, here) goes with the next.
  assert.deepEqual(pieces('然而，他终于来到了这里。'), ['然而，他终于来到了这里。']);
  assert.deepEqual(cut('¿Dónde está? No lo sé. Él vino ayer.', 'es'), ['¿Dónde está?', 'No lo sé.', 'Él vino ayer.']);
  // Korean words after a quotation keep it in their sentence in a book of any language (a chapter
  // written in Korean, say).
  for (const lang of ['ko', 'en']) assert.deepEqual(cut('"이리 오너라." 하고 그가 말했다. 나는 갔다.', lang), ['"이리 오너라." 하고 그가 말했다.', '나는 갔다.']);
  // A Japanese book read in English: each sentence of it with its translation.
  const en = 'I am a cat. As yet I have no name. I have no idea where I was born.';
  const ja = '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。';
  const js = sentences(ja, 'ja').map((s) => ja.slice(...s));
  const es = sentences(en, 'en').map((s) => en.slice(...s));
  assert.deepEqual(align(js, es, { from: 'ja', to: 'en' }), [
    [0, 1, 0, 1],
    [1, 2, 1, 2],
    [2, 3, 2, 3],
  ]);
  assert.deepEqual(
    pairClauses(ja, en, { from: 'ja', to: 'en' }).map((s) => s && en.slice(...s)),
    ['I am a cat.', 'As yet I have no name.', 'I have no idea where I was born.'],
  );
  // The Korean rule (a reason follows the sentence it gives the reason of) is Korean's alone.
  const reason = ['We call it the book.', 'It is the best book that ever was written, the book of books.'];
  const ko = ['우리는 이 책을 그 책이라고 부른다.', '지금까지 쓰인 책 가운데 가장 훌륭한 책이기 때문이다.'];
  assert.deepEqual(align(reason, ko, { from: 'en', to: 'ko' }), align(reason, ko));
  assert.deepEqual(align(reason, ko.map((k) => k.replace('때문이다', '것이다')), { from: 'en', to: 'es' }), [
    [0, 1, 0, 1],
    [1, 2, 1, 2],
  ]);
});

test('a long paragraph without spaces is cut after its sentences; a selection is a word, a sentence or a paragraph in its own script', () => {
  const text = `${NEKO}${NEKO2}`.repeat(3);
  const cuts = piecesOf(text, 200, 'ja');
  assert.ok(cuts.length > 1);
  for (const [, end] of cuts.slice(0, -1)) assert.equal(text[end - 1], '。', 'after a full stop');
  assert.deepEqual([bookMode('猫', 'ja'), bookMode('吾輩は猫である。', 'ja'), bookMode(NEKO, 'ja')], ['word', 'sentence', 'paragraph']);
  assert.deepEqual([bookMode('λόγος', 'el'), bookMode('Ἐν ἀρχῇ ἦν ὁ λόγος.', 'el')], ['word', 'sentence']);
  // In an English book a Greek word is what it always was.
  assert.equal(bookMode('Ἰησοῦς', 'en'), bookMode('Ἰησοῦς'));
  setLangs({ src: 'ja', tgt: 'en' });
  try {
    assert.equal(bookMessage('explain', { text: 'name', context: 'As yet I have no name.', inTranslation: true }), '<paragraph>As yet I have no name.</paragraph>\n<selection lang="en">name</selection>\nTask: explain');
  } finally {
    setLangs();
  }
  // Stored replies: the default pair keeps its keys, another has its own.
  const args = { model: 'auto', effort: 'low', targetLang: 'English', action: 'explain', chapter: 'c1', content: 'q' };
  assert.equal(lookupKey({ ...args, langs: { src: 'en', tgt: 'ko' } }), lookupKey(args));
  assert.notEqual(lookupKey({ ...args, langs: { src: 'ja', tgt: 'en' } }), lookupKey(args));
});

test('the router names the book\'s language; Latin, Greek or Hebrew is a reason for Opus only in a book of another', async () => {
  const stub = await anthropicStub(() => ({ text: 'sonnet' }));
  try {
    const llm = { protocol: 'anthropic', baseUrl: stub.url, apiKey: 'sk-test', model: 'auto' };
    for (const lang of ['en', 'la', 'grc', 'he', 'ja']) await routeTurn(llm, { bookLine: '<book title="T" author="A"/>', message: { role: 'user', content: 'Task: explain' }, lang });
    const opus = stub.requests.map((r) => /\nopus: (.*?); obscure allusions/.exec(r.system)[1]);
    assert.deepEqual(opus, ['Latin, Greek or Hebrew', 'Greek or Hebrew', 'Latin or Hebrew', 'Latin or Greek', 'Latin, Greek or Hebrew']);
    assert.match(stub.requests[1].system, /^You pick the cheapest model that will answer a reader of a Latin book well\.[\s\S]*a sentence in plain Latin whose/);
  } finally {
    await stub.close();
  }
});

test('an environment that names one language twice is warned of, and Settings can still be saved and set the pair', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, BOOK_TARGET_LANG: 'en' } });
  try {
    assert.match(srv.output(), /BOOK_SOURCE_LANG and BOOK_TARGET_LANG make both languages en/);
    const cookie = await signIn(srv.url, PW);
    const save = (langs) => api(srv.url, 'PUT', '/api/settings', { cookie, body: { prefs: { targetLang: '', langs } } });
    assert.equal((await save({ src: '', tgt: '' })).status, 200, 'nothing asked of the pair');
    assert.equal((await save({ src: 'en', tgt: '' })).status, 400);
    const set = await save({ src: 'ja', tgt: '' });
    assert.deepEqual([set.status, set.data.langs, set.data.prefs.targetLang], [200, { src: 'ja', tgt: 'en' }, 'English']);
  } finally {
    await srv.stop();
  }
});

test('a Japanese book read in English (the environment\'s pair) and an English one read in Japanese (its own): every request names them', async () => {
  const blocksIn = (text) => [...text.matchAll(/<block n="(\d+)">([\s\S]*?)<\/block>/g)].map((m) => Number(m[1]));
  const stub = await anthropicStub((body) => {
    const user = body.messages.at(-1).content;
    const system = Array.isArray(body.system) ? body.system[0].text : body.system || '';
    if (/^You pick the cheapest/.test(system)) return { text: 'haiku' };
    if (typeof user !== 'string' || !/^You translate/.test(system)) return { text: '{}' };
    if (user.includes('<draft>')) return { text: '<none/>' };
    const into = /into English/.test(system) ? 'I am a cat, and I have no name.[[A note.]] Nobody knows where I was born.' : '吾輩は猫である、名前はまだ無い。[[注]]どこで生れたか見当がつかぬ。';
    return { text: blocksIn(user).map((n) => `<block n="${n}">${into}</block>`).join('\n') };
  });
  const dir = tempDir();
  writeBookFixture(dir, 'txt-neko', { chapters: [chapter('c1', '第一章', [h('一'), p(NEKO), p(NEKO2)])] });
  writeBookFixture(dir, 'txt-cat', { chapters: [chapter('c1', 'Chapter I', [h('CHAPTER I.'), p(`${CAT} ${'He sleeps all day, so he is poor. '.repeat(25)}`)])] });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, BOOK_SOURCE_LANG: 'ja', BOOK_TARGET_LANG: 'EN' } });
  try {
    const cookie = await signIn(srv.url, PW);
    await useStub(srv.url, cookie, stub, { model: 'auto' });
    // Settings: the environment's pair, answers in its target's own name; a bad pair is refused.
    const settings = (await api(srv.url, 'GET', '/api/settings', { cookie })).data;
    assert.deepEqual([settings.langs, settings.envLangs, settings.answerFollows, settings.prefs.targetLang], [{ src: 'ja', tgt: 'en' }, { src: 'ja', tgt: 'en' }, true, 'English']);
    for (const langs of [{ src: 'klingon-xx' }, { src: 'en' }, { src: 'ko', tgt: 'ko' }]) {
      assert.equal((await api(srv.url, 'PUT', '/api/settings', { cookie, body: { prefs: { langs } } })).status, 400, JSON.stringify(langs));
    }
    // The English book has its own pair, English → Japanese.
    assert.equal((await api(srv.url, 'PATCH', '/api/papers/txt-cat', { cookie, body: { langs: { src: 'en', tgt: 'xx' } } })).status, 400);
    assert.deepEqual((await api(srv.url, 'PATCH', '/api/papers/txt-cat', { cookie, body: { langs: { src: 'en', tgt: 'ja' } } })).data.paper.langs, { src: 'en', tgt: 'ja' });

    for (const id of ['txt-neko', 'txt-cat']) {
      assert.equal((await api(srv.url, 'POST', `/api/papers/${id}/translations/c1`, { cookie, body: {} })).status, 200);
      await waitForPaper(srv.url, cookie, id, (m) => m.book?.translations?.c1?.status === 'ready', 30000);
      assert.equal((await api(srv.url, 'GET', `/api/papers/${id}/translations/c1/notes-src`, { cookie })).status, 200);
      assert.equal((await api(srv.url, 'GET', `/api/papers/${id}/translations/c1/clauses`, { cookie })).status, 200);
    }
    // A book translated into Japanese stays in Japanese; its own language may still change.
    const relabel = await api(srv.url, 'PATCH', '/api/papers/txt-cat', { cookie, headers: { 'X-UI-Lang': 'en' }, body: { langs: { src: 'en', tgt: 'ko' } } });
    assert.deepEqual([relabel.status, relabel.data.error], [409, 'Chapters of this book are translated into ja already, so that stays its target language (its own language can still change)']);
    assert.equal((await api(srv.url, 'PATCH', '/api/papers/txt-cat', { cookie, body: { langs: null } })).status, 409, 'nor back to the environment\'s (en)');
    assert.deepEqual((await api(srv.url, 'PATCH', '/api/papers/txt-cat', { cookie, body: { langs: { src: 'fr', tgt: 'ja' } } })).data.paper.langs, { src: 'fr', tgt: 'ja' });
    // The Japanese book's pair is now its own: a change in Settings leaves it as it is.
    assert.equal((await api(srv.url, 'PUT', '/api/settings', { cookie, body: { prefs: { langs: { src: 'fr', tgt: 'ko' } } } })).status, 200);
    const after = (await api(srv.url, 'GET', '/api/settings', { cookie })).data;
    assert.deepEqual([after.langs, after.prefs.targetLang], [{ src: 'fr', tgt: 'ko' }, '한국어']);
    assert.deepEqual((await api(srv.url, 'GET', '/api/papers/txt-neko', { cookie })).data.paper.langs, { src: 'ja', tgt: 'en' });
    const res = await chat(srv.url, cookie, { action: 'explain', messages: [{ role: 'user', content: '<paragraph>I am a cat.</paragraph>\n<selection lang="en">cat</selection>\nTask: explain' }], book: { id: 'txt-neko', chapter: 'c1', block: 'c1.1k' } });
    assert.equal(res.events.at(-1).t, 'done');

    const sys = (r) => (Array.isArray(r.system) ? r.system[0].text : r.system || '');
    const user = (r) => r.messages.at(-1).content;
    const of = (pattern) => stub.requests.filter((r) => pattern.test(sys(r)) || (typeof user(r) === 'string' && pattern.test(user(r))));
    const [jaTranslate, enTranslate] = [of(/^You translate Japanese books into English/), of(/^You translate English books into Japanese/)];
    assert.ok(jaTranslate.length && enTranslate.length);
    assert.match(sys(jaTranslate[0]), /for an English middle-school student[\s\S]*as \[\[note\]\], in English, 1–3[\s\S]*Names in their usual English form; Bible books and people by their usual English names\. If a word/);
    assert.match(sys(enTranslate[0]), /natural Japanese allows[\s\S]*Older English becomes plain, natural modern Japanese/);
    assert.match(user(of(/^Check the draft/).find((r) => /into English/.test(sys(r)))), /as a careful English editor: mistranslations, omissions or additions, wrong nuance, English typos and spacing, unnatural/);
    assert.match(user(of(/^Summarize this chapter/).find((r) => /吾輩/.test(user(r)))), /^Summarize this chapter in 3-5 Japanese sentences/);
    const notes = of(/footnote markers \[\^n\]/).find((r) => /<japanese>/.test(user(r)));
    assert.match(sys(notes), /^Each <block> holds a paragraph of a Japanese book, its English translation with footnote markers[\s\S]*"<the Japanese words>"/);
    assert.match(user(notes), /<japanese>吾輩は猫である。[\s\S]*<\/japanese>\n<english>I am a cat/);
    const [clausesJa, clausesEn] = [/^Each <block> holds a paragraph of a Japanese book as <pair>s/, /^Each <block> holds a paragraph of an English book as <pair>s/].map((re) => stub.requests.find((r) => re.test(sys(r))));
    assert.match(sys(clausesJa), /cut it between words \(at spaces\) so that[\s\S]*Examples, from an English book and its Korean translation \(do the same for Japanese and English\):/);
    assert.match(user(clausesJa), /<japanese>\n\[1\.1\] [\s\S]*<\/japanese>\n<english>/);
    assert.match(sys(clausesEn), /A Japanese sentence that translates several clauses is shared out among them: cut it between words so that[\s\S]*\["<Japanese>", \.\.\.\]/);
    const router = of(/^You pick the cheapest model/);
    assert.ok(router.length && router.every((r) => /a reader of a Japanese book well[\s\S]*a sentence in plain Japanese/.test(sys(r))));
    const answer = stub.requests.find((r) => /^You are a reading companion/.test(sys(r)));
    assert.match(sys(answer), /^You are a reading companion for an English reader working through a Japanese book\.[\s\S]*Answer in English\.[\s\S]*Selection lang="en": part of the English translation/);
    assert.doesNotMatch(JSON.stringify(stub.requests.filter((r) => !/Examples/.test(sys(r)))), /Korean|한국어|외래어|띄어쓰기/, 'no Korean outside the clause examples');
  } finally {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
