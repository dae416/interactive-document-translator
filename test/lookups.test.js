// Stored lookups: an identical first question in a chapter is answered without a model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anthropicStub, api, chat, recordingServer, signIn, sleep, startServer, tempDir, useStub, waitFor, writeBookFixture } from './helpers.js';

const { lookupKey } = await import('../server/lookups.js');

const PW = 'test-password';
const CHAPTERS = [{ id: 'c1', title: 'Debt', blocks: [{ t: 'h', x: 'DEBT.' }, { t: 'p', x: 'Owe no man anything.' }], pages: null, url: null }];
const ask = (content, extra = {}) => ({ action: 'translate', book: { id: 'txt-book', chapter: 'c1' }, messages: [{ role: 'user', content }], ...extra });

async function setup(reply) {
  const stub = await anthropicStub(reply);
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: CHAPTERS });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  const cookie = await signIn(srv.url, PW);
  await useStub(srv.url, cookie, stub);
  const done = async () => {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { stub, dir, srv, cookie, done };
}

test('the key covers model, effort, language, action, chapter and the question', () => {
  const base = { model: 'claude-opus-5-5', effort: 'low', targetLang: '한국어', action: 'translate', chapter: 'c1', content: 'q' };
  const key = lookupKey(base);
  assert.equal(lookupKey({ ...base }), key);
  for (const change of [{ model: 'm' }, { effort: 'medium' }, { targetLang: 'English' }, { action: 'explain' }, { chapter: 'c2' }, { content: 'q2' }]) {
    assert.notEqual(lookupKey({ ...base, ...change }), key, JSON.stringify(change));
  }
});

test('a repeat is served without a model call; fresh asks again; language and effort change the key', async () => {
  const { stub, srv, cookie, dir, done } = await setup((body) => ({ text: `answer ${body.messages[0].content.length}` }));
  try {
    const first = await chat(srv.url, cookie, ask('<selection>sieve</selection>'));
    assert.equal(first.events.at(-1).t, 'done');
    assert.equal(first.events.at(-1).cached, undefined);
    assert.equal(stub.chats().length, 1);

    const again = await chat(srv.url, cookie, ask('<selection>sieve</selection>'));
    assert.equal(stub.chats().length, 1, 'served from lookups');
    assert.deepEqual(
      again.events.map((e) => e.t),
      ['start', 'delta', 'done'],
    );
    assert.equal(again.events[1].text, first.events.find((e) => e.t === 'delta').text);
    assert.equal(again.events[2].cached, true);

    await chat(srv.url, cookie, ask('<selection>sieve</selection>', { fresh: true }));
    assert.equal(stub.chats().length, 2, 'fresh bypasses the store');

    // Follow-ups always go to the model.
    await chat(srv.url, cookie, {
      ...ask('x'),
      messages: [
        { role: 'user', content: '<selection>sieve</selection>' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'more?' },
      ],
    });
    assert.equal(stub.chats().length, 3);

    await api(srv.url, 'PUT', '/api/settings', { cookie, body: { prefs: { targetLang: 'English' } } });
    await chat(srv.url, cookie, ask('<selection>sieve</selection>'));
    assert.equal(stub.chats().length, 4, 'another answer language misses');

    await api(srv.url, 'PUT', '/api/settings', { cookie, body: { llm: { effort: { translate: 'medium' } } } });
    await chat(srv.url, cookie, ask('<selection>sieve</selection>'));
    assert.equal(stub.chats().length, 5, 'another effort misses');

    const lines = fs.readFileSync(path.join(dir, 'papers', 'txt-book', 'lookups.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 4);
    assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['key', 'text', 'model', 'at']);
    const usage = fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(usage.length, 6);
    assert.deepEqual(
      usage.map((u) => u.cached),
      [false, true, false, false, false, false],
    );
    assert.equal(usage[0].paper, 'txt-book');
    assert.equal(usage[0].chapter, 'c1');
    assert.equal(usage[0].usage.output_tokens, 5);
    assert.ok(usage.every((u) => Number.isInteger(u.ms)), 'every line says how long its call took');
  } finally {
    await done();
  }
});

test('stored answers survive a restart', async () => {
  const { stub, srv, cookie, dir, done } = await setup();
  try {
    await chat(srv.url, cookie, ask('<selection>debt</selection>'));
    await srv.stop();
    const again = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
    try {
      const res = await chat(again.url, cookie, ask('<selection>debt</selection>'));
      assert.equal(res.events.at(-1).cached, true);
      assert.equal(stub.chats().length, 1);
    } finally {
      await again.stop();
    }
  } finally {
    await done();
  }
});

test('answers that were cut off or aborted are not stored', async () => {
  const { stub, srv, cookie, done } = await setup((body) => {
    const q = body.messages[0].content;
    if (q.includes('long')) return { stopReason: 'max_tokens' };
    if (q.includes('slow') && stub.chats().length === 1) return { hang: true };
    return {};
  });
  try {
    await chat(srv.url, cookie, ask('<selection>slow</selection>'), { signal: AbortSignal.timeout(500) }).catch(() => {});
    assert.equal(await waitFor(() => stub.chats().length === 1), true);
    await sleep(100);
    const retry = await chat(srv.url, cookie, ask('<selection>slow</selection>'));
    assert.equal(retry.events.at(-1).t, 'done');
    assert.equal(retry.events.at(-1).cached, undefined);
    assert.equal(stub.chats().length, 2, 'the aborted answer was not stored');

    await chat(srv.url, cookie, ask('<selection>long</selection>'));
    const cut = await chat(srv.url, cookie, ask('<selection>long</selection>'));
    assert.equal(cut.events.at(-1).stopReason, 'max_tokens');
    assert.equal(stub.chats().length, 4, 'a max_tokens answer was not stored');
  } finally {
    await done();
  }
});

test('an OpenAI-compatible answer that stops without finish_reason is not stored', async () => {
  let finish = null;
  const openai = await recordingServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: 'half an answer' } }] })}\n\n`);
    if (finish) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: CHAPTERS });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    await api(srv.url, 'PUT', '/api/settings', { cookie, body: { llm: { preset: 'custom', protocol: 'openai', baseUrl: `${openai.url}/v1`, apiKey: 'sk-x', model: 'm' } } });
    const cut = await chat(srv.url, cookie, ask('<selection>debt</selection>'));
    assert.equal(cut.events.at(-1).stopReason, 'incomplete');
    finish = 'stop';
    const whole = await chat(srv.url, cookie, ask('<selection>debt</selection>'));
    assert.equal(whole.events.at(-1).stopReason, 'end_turn');
    assert.equal(openai.requests.length, 2, 'the cut-off answer was not stored');
    const stored = await chat(srv.url, cookie, ask('<selection>debt</selection>'));
    assert.equal(stored.events.at(-1).cached, true);
    assert.equal(openai.requests.length, 2);
  } finally {
    await srv.stop();
    await openai.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
