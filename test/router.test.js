// Model "auto": a Haiku router picks the model for each turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anthropicStub, api, chat, signIn, startServer, tempDir, useStub, writeBookFixture } from './helpers.js';

const PW = 'test-password';
const CHAPTER_TEXT = 'He who goes a borrowing goes a sorrowing.';
const CHAPTERS = [{ id: 'c1', title: 'Debt', blocks: [{ t: 'h', x: 'DEBT.' }, { t: 'p', x: CHAPTER_TEXT }], pages: null, url: null }];
const ask = (content, extra = {}) => ({ action: 'translate', book: { id: 'txt-book', chapter: 'c1' }, messages: [{ role: 'user', content }], ...extra });
const isRouter = (r) => r.max_tokens === 5;

// `route(body)` answers router calls; everything else gets the stub's default reply.
async function setup(route) {
  const stub = await anthropicStub((body) => (isRouter(body) ? route(body) : {}));
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: CHAPTERS, meta: { title: 'John Ploughman’s Talk', authors: ['C. H. Spurgeon'] } });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  const cookie = await signIn(srv.url, PW);
  await useStub(srv.url, cookie, stub, { model: 'auto' });
  const routed = () => stub.requests.filter(isRouter);
  const answered = () => stub.chats().map((r) => r.model);
  const usage = () => fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const done = async () => {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { stub, srv, cookie, routed, answered, usage, done };
}

test('"auto" is the default model', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    assert.equal((await api(srv.url, 'GET', '/api/settings', { cookie })).data.llm.model, 'auto');
  } finally {
    await srv.stop();
  }
});

test('the router’s choice answers the turn; it sees the book and the message, not the chapter', async () => {
  const t = await setup(() => ({ text: 'opus' }));
  try {
    const res = await chat(t.srv.url, t.cookie, ask('<selection>sorrowing</selection>\nMode: word'));
    assert.equal(res.events[0].model, 'claude-opus-5-5');
    assert.deepEqual(t.answered(), ['claude-opus-5-5']);
    const [router] = t.routed();
    assert.equal(router.model, 'claude-haiku-5-5');
    assert.deepEqual(router.thinking, { type: 'disabled' });
    assert.equal(router.stream, undefined);
    assert.match(router.system, /haiku, sonnet or opus/);
    assert.equal(router.messages.length, 1);
    const input = router.messages[0].content;
    assert.match(input, /^<book title="John Ploughman’s Talk" author="C\. H\. Spurgeon"\/>\n<selection>sorrowing<\/selection>\nMode: word$/);
    assert.ok(!input.includes(CHAPTER_TEXT));

    // Follow-ups are routed again.
    await chat(t.srv.url, t.cookie, {
      ...ask('x'),
      messages: [
        { role: 'user', content: '<selection>sorrowing</selection>\nMode: word' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'Question: and borrowing?' },
      ],
    });
    assert.equal(t.routed().length, 2);
    assert.match(t.routed()[1].messages[0].content, /Question: and borrowing\?$/);

    const routerLines = t.usage().filter((u) => u.router);
    assert.equal(routerLines.length, 2);
    assert.equal(routerLines[0].choice, 'opus');
    assert.equal(routerLines[0].model, 'claude-haiku-5-5');
    assert.equal(routerLines[0].paper, 'txt-book');
  } finally {
    await t.done();
  }
});

test('when the router fails or answers nonsense, Sonnet answers', async () => {
  let failure = { status: 500 };
  const t = await setup(() => failure);
  try {
    await chat(t.srv.url, t.cookie, ask('<selection>one</selection>'));
    failure = { text: 'hmm' };
    await chat(t.srv.url, t.cookie, ask('<selection>two</selection>'));
    assert.equal(t.routed().length, 2);
    assert.deepEqual(t.answered(), ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  } finally {
    await t.done();
  }
});

test('a requested tier skips the router; a stored reply skips both', async () => {
  const t = await setup(() => ({ text: 'haiku' }));
  try {
    const first = await chat(t.srv.url, t.cookie, ask('<selection>sieve</selection>'));
    assert.deepEqual(t.answered(), ['claude-haiku-5-5']);
    assert.equal(t.routed().length, 1);

    // The same question again: neither the router nor a model is called.
    const again = await chat(t.srv.url, t.cookie, ask('<selection>sieve</selection>'));
    assert.equal(again.events.at(-1).cached, true);
    assert.equal(again.events[0].model, 'claude-haiku-5-5');
    assert.equal(t.routed().length, 1);
    assert.equal(t.answered().length, 1);
    assert.equal(again.events[1].text, first.events[1].text);

    // "Opus로 다시": a fresh answer from Opus, with no router call, replaces the stored one.
    const opus = await chat(t.srv.url, t.cookie, ask('<selection>sieve</selection>', { fresh: true, model: 'opus' }));
    assert.equal(opus.events[0].model, 'claude-opus-5-5');
    assert.equal(t.routed().length, 1);
    assert.deepEqual(t.answered(), ['claude-haiku-5-5', 'claude-opus-5-5']);
    const stored = await chat(t.srv.url, t.cookie, ask('<selection>sieve</selection>'));
    assert.equal(stored.events.at(-1).cached, true);
    assert.equal(stored.events[0].model, 'claude-opus-5-5');

    // A tier request is not answered from a reply another model wrote.
    await chat(t.srv.url, t.cookie, ask('<selection>sieve</selection>', { model: 'sonnet' }));
    assert.equal(t.answered().at(-1), 'claude-sonnet-5-5');
    assert.equal(t.routed().length, 1);
  } finally {
    await t.done();
  }
});

test('a fixed model is never routed, but a requested tier still applies', async () => {
  const t = await setup(() => ({ text: 'opus' }));
  try {
    await useStub(t.srv.url, t.cookie, t.stub, { model: 'claude-sonnet-5-5' });
    await chat(t.srv.url, t.cookie, ask('<selection>pay as you go</selection>'));
    const opus = await chat(t.srv.url, t.cookie, ask('<selection>pay as you go</selection>', { fresh: true, model: 'opus' }));
    assert.equal(opus.events[0].model, 'claude-opus-5-5');
    assert.equal(opus.events.at(-1).model, 'claude-opus-5-5');
    assert.equal(t.routed().length, 0);
    assert.deepEqual(t.answered(), ['claude-sonnet-5-5', 'claude-opus-5-5']);
  } finally {
    await t.done();
  }
});

test('a follow-up keeps its thread’s model; a requested tier still wins', async () => {
  const t = await setup(() => ({ text: 'haiku' }));
  try {
    const thread = (model, extra) =>
      ask('x', {
        ...extra,
        messages: [
          { role: 'user', content: '<selection>sieve</selection>' },
          { role: 'assistant', content: 'answer', raw: { provider: 'anthropic', model, content: [{ type: 'text', text: 'answer' }] } },
          { role: 'user', content: 'Question: why a sieve?' },
        ],
      });
    await chat(t.srv.url, t.cookie, thread('claude-opus-5-5'));
    assert.equal(t.routed().length, 0);
    await chat(t.srv.url, t.cookie, thread('claude-opus-5-5', { model: 'sonnet' }));
    // An answer from another model (a refusal fallback, say) leaves the choice to the router.
    await chat(t.srv.url, t.cookie, thread('claude-opus-5'));
    assert.equal(t.routed().length, 1);
    assert.deepEqual(t.answered(), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  } finally {
    await t.done();
  }
});

test('chats outside a book are not routed: "auto" means Opus there', async () => {
  const t = await setup(() => ({ text: 'haiku' }));
  try {
    await chat(t.srv.url, t.cookie, { action: 'chat', system: 'paper text', messages: [{ role: 'user', content: 'What is the main result?' }] });
    await chat(t.srv.url, t.cookie, { ...ask('<selection>sieve</selection>'), model: 'constructor' });
    assert.equal(t.routed().length, 1, 'only the book request, and "constructor" is no tier');
    assert.deepEqual(t.answered(), ['claude-opus-5-5', 'claude-haiku-5-5']);
  } finally {
    await t.done();
  }
});

test('"Test connection" and the model list work with "auto"', async () => {
  const t = await setup(() => ({ text: 'haiku' }));
  try {
    const models = await api(t.srv.url, 'POST', '/api/llm/models', { cookie: t.cookie, body: {} });
    assert.equal(models.status, 200);
    assert.ok(models.data.models.includes('claude-opus-5-5'));
    const check = await api(t.srv.url, 'POST', '/api/llm/test', { cookie: t.cookie, body: {} });
    assert.equal(check.status, 200);
    assert.equal(check.data.model, 'claude-haiku-5-5');
    assert.equal(t.routed().length, 0, 'the test talks to Haiku directly');
  } finally {
    await t.done();
  }
});

test('Opus reached by the router or a requested tier gets the 5-minute cache; a fixed Opus keeps one hour', async () => {
  const t = await setup(() => ({ text: 'opus' }));
  try {
    const ttls = (r) => r.system.filter((b) => b.cache_control).map((b) => b.cache_control.ttl || '5m');
    await chat(t.srv.url, t.cookie, ask('<selection>routed</selection>'));
    await chat(t.srv.url, t.cookie, ask('<selection>requested</selection>', { model: 'haiku' }));
    await useStub(t.srv.url, t.cookie, t.stub, { model: 'claude-opus-5-5' });
    await chat(t.srv.url, t.cookie, ask('<selection>fixed</selection>'));
    assert.deepEqual(t.stub.chats().map(ttls), [['5m', '5m'], ['1h', '1h'], ['1h', '1h']]);
  } finally {
    await t.done();
  }
});
