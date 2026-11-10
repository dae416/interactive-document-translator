// Book-mode messages and the translate-on-select cache key.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// i18n.js sets the page language when it loads.
globalThis.document = { documentElement: {} };
const { bookMessage, bookMode, canAskOpus, instantKey, modelLabel, newThread, runTurn } = await import('../public/assets/js/ai.js');

test('the instant cache key changes with chapter, context, language and prompt', () => {
  const prefs = { targetLang: '한국어', prompts: { translate: '' } };
  const info = { text: 'quick', chapter: 'c3', context: 'The quick and the dead.' };
  assert.equal(instantKey(prefs, info), instantKey(prefs, { ...info }));
  assert.notEqual(instantKey(prefs, info), instantKey(prefs, { ...info, chapter: 'c4' }));
  assert.notEqual(instantKey(prefs, info), instantKey(prefs, { ...info, context: 'He was quick to anger.' }));
  assert.notEqual(instantKey(prefs, info), instantKey({ ...prefs, targetLang: 'English' }, info));
  assert.notEqual(instantKey(prefs, info), instantKey({ ...prefs, prompts: { translate: 'Be terse.' } }, info));
  assert.notEqual(instantKey(prefs, info), instantKey(prefs, { ...info, mode: 'sentence' }), 'a tapped sentence is asked as a sentence');
  assert.notEqual(instantKey(prefs, info), instantKey(prefs, { ...info, sentence: 'He was quick.' }), "a tapped clause, with its sentence");
  // Papers have no chapter and fetch their context later: the key is the text, as before.
  assert.equal(instantKey(prefs, { text: 'quick', getContext: async () => 'x' }), instantKey(prefs, { text: 'quick' }));
  assert.equal(instantKey(undefined, { text: 'quick' }), instantKey({}, { text: 'quick' }));
});

test('mode: word, sentence or paragraph', () => {
  assert.equal(bookMode('plough'), 'word');
  assert.equal(bookMode(' idle hands '), 'word');
  assert.equal(bookMode('He that will not plough must not expect to eat.'), 'sentence');
  assert.equal(bookMode('Read Hos. viii. 12 again, and you shall see it.'), 'sentence');
  assert.equal(bookMode('He went home. She stayed behind to sweep the floor.'), 'paragraph');
  assert.equal(bookMode('"Go!" he cried. "The time is short."'), 'paragraph');
});

test('book messages carry the block, the selection and the request', () => {
  const quote = { text: 'idle', context: 'Some men are as idle as a painted ship.' };
  assert.equal(
    bookMessage('translate', quote),
    '<paragraph>Some men are as idle as a painted ship.</paragraph>\n<selection>idle</selection>\nMode: word',
  );
  assert.equal(bookMessage('explain', quote), '<paragraph>Some men are as idle as a painted ship.</paragraph>\n<selection>idle</selection>\nTask: explain');
  assert.equal(bookMessage('ask', quote, 'Why a ship?').split('\n').at(-1), 'Question: Why a ship?');
  // The whole block selected: no separate paragraph.
  const whole = { text: 'Some men are idle.', context: ' Some men are idle. ' };
  assert.equal(bookMessage('translate', whole), '<selection>Some men are idle.</selection>\nMode: sentence');
  assert.equal(bookMessage('explain', { text: 'idle' }), '<selection>idle</selection>\nTask: explain');
  // A tapped sentence is a sentence, even one that looks like a word or a paragraph.
  assert.equal(bookMessage('translate', { text: 'The Creation', mode: 'sentence' }), '<selection>The Creation</selection>\nMode: sentence');
  assert.equal(bookMessage('translate', { text: 'Go to St. Paul’s.', mode: 'sentence' }), '<selection>Go to St. Paul’s.</selection>\nMode: sentence');
  // A tapped clause brings its sentence, unless that is the whole paragraph.
  const clause = { text: 'and have nothing.', context: 'He shall beg, and have nothing. So it is written.', sentence: 'He shall beg, and have nothing.', mode: 'sentence' };
  assert.equal(
    bookMessage('translate', clause),
    '<paragraph>He shall beg, and have nothing. So it is written.</paragraph>\n<sentence>He shall beg, and have nothing.</sentence>\n<selection>and have nothing.</selection>\nMode: sentence',
  );
  assert.equal(bookMessage('translate', { ...clause, context: clause.sentence }), '<paragraph>He shall beg, and have nothing.</paragraph>\n<selection>and have nothing.</selection>\nMode: sentence');
  // A selection in the Korean translation: marked, with the English of its blocks as the paragraph.
  const ko = { text: '악마의 작업장', context: 'Idle hands are the devil’s workshop.', inTranslation: true };
  assert.equal(bookMessage('explain', ko), '<paragraph>Idle hands are the devil’s workshop.</paragraph>\n<selection lang="ko">악마의 작업장</selection>\nTask: explain');
  assert.equal(bookMessage('ask', { text: ko.text, inTranslation: true }, '왜 작업장이야?'), '<selection lang="ko">악마의 작업장</selection>\nQuestion: 왜 작업장이야?');
});

test('model tags, and when an answer can be asked again of Opus', () => {
  assert.equal(modelLabel('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(modelLabel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(modelLabel('claude-opus-5-5-20261001'), 'Opus 5.5');
  assert.equal(modelLabel('qwen-max'), 'qwen-max');
  assert.equal(modelLabel(undefined), '');
  // The interface language here follows the machine's locale.
  assert.ok(['Auto', '自动'].includes(modelLabel('auto')), modelLabel('auto'));
  const claude = { protocol: 'anthropic', model: 'auto' };
  const done = { content: '가시덤불', model: 'claude-haiku-5-5' };
  assert.equal(canAskOpus(done, claude), true);
  assert.equal(canAskOpus({ ...done, model: 'claude-opus-5-5' }, claude), false);
  assert.equal(canAskOpus({ ...done, pending: true }, claude), false);
  assert.equal(canAskOpus({ ...done, error: 'failed' }, claude), false);
  assert.equal(canAskOpus({ ...done, model: undefined }, claude), false);
  assert.equal(canAskOpus(done, { protocol: 'openai', model: 'gpt-x' }), false);
  assert.equal(canAskOpus(done, undefined), false);
});

test('a turn sends book, fresh and the model override, and keeps the model that answered', async () => {
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    const events = [{ t: 'start', model: 'claude-opus-5-5' }, { t: 'delta', text: '호세아 8:12' }, { t: 'done', stopReason: 'end_turn' }];
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  };
  const thread = newThread({ paper: { id: 'book-demo' }, kind: 'quote', action: 'translate', system: '', book: { id: 'book-demo', chapter: 'c3' } });
  const user = { role: 'user', content: '<selection>Hos. viii. 12</selection>\nMode: sentence' };
  const reply = { role: 'assistant', content: '', pending: true };
  thread.messages.push(user, reply);
  await runTurn(thread, reply, { action: 'translate', fresh: true, model: 'opus' });
  assert.equal(sent.url, '/api/llm/chat');
  assert.deepEqual(sent.body, {
    action: 'translate',
    system: '',
    messages: [{ role: 'user', content: user.content }],
    book: { id: 'book-demo', chapter: 'c3' },
    fresh: true,
    model: 'opus',
  });
  assert.equal(reply.model, 'claude-opus-5-5');
  assert.equal(reply.content, '호세아 8:12');
  // Without the extras, nothing extra goes over the wire.
  await runTurn(newThread({ paper: { id: 'p' }, kind: 'chat', action: 'chat', system: 'S' }), { role: 'assistant' }, { action: 'chat' }).catch(() => {});
  assert.deepEqual(Object.keys(sent.body).sort(), ['action', 'messages', 'system']);
});

test('a book thread keeps its book and chapter; a paper thread has none', () => {
  const paper = { id: 'book-demo' };
  const t = newThread({ paper, kind: 'quote', action: 'translate', system: '', book: { id: 'book-demo', chapter: 'c2' } });
  assert.deepEqual(t.book, { id: 'book-demo', chapter: 'c2' });
  assert.equal(t.system, '');
  assert.equal('book' in newThread({ paper, kind: 'chat', action: 'chat', system: '' }), false);
});
