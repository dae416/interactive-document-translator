// Chapter summaries and the brief, against an Anthropic stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anthropicStub, api, signIn, startServer, tempDir, useStub, waitFor, writeBookFixture } from './helpers.js';

const PW = 'test-password';
const chapter = (n) => ({ id: `c${n}`, title: `Sermon ${n}`, blocks: [{ t: 'p', x: Array.from({ length: 200 }, () => `word${n}`).join(' ') }], pages: null, url: null });

async function run(env, reply) {
  const stub = await anthropicStub(reply);
  const dir = tempDir();
  writeBookFixture(dir, 'txt-book', { chapters: [1, 2, 3].map(chapter) });
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, ...env } });
  const cookie = await signIn(srv.url, PW);
  await useStub(srv.url, cookie, stub);
  // Opening the book starts the summaries.
  await api(srv.url, 'GET', '/api/papers/txt-book/html', { cookie });
  const book = () => JSON.parse(fs.readFileSync(path.join(dir, 'papers', 'txt-book', 'book.json'), 'utf8'));
  await waitFor(() => book().brief, 15000);
  const done = async () => {
    await srv.stop();
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { stub, book, done };
}

test('Haiku summarizes with thinking off; a failed chapter does not stop the others or the brief', async () => {
  const t = await run({}, (body) => (body.messages[0].content.includes('Sermon 2') ? { status: 529 } : { text: 'Summary.' }));
  try {
    assert.deepEqual(Object.keys(t.book().summaries), ['c1', 'c3']);
    assert.equal(t.book().brief, 'Summary.');
    const calls = t.stub.requests.filter((r) => r.max_tokens);
    assert.ok(calls.every((r) => r.model === 'claude-haiku-5-5' && r.thinking?.type === 'disabled' && !r.output_config));
    assert.deepEqual([...new Set(calls.map((r) => r.max_tokens))].sort(), [400, 600]);
  } finally {
    await t.done();
  }
});

test('another SUMMARY_MODEL keeps its thinking, at low effort and with room for it', async () => {
  const t = await run({ SUMMARY_MODEL: 'claude-sonnet-5-5' }, () => ({ text: 'Summary.' }));
  try {
    assert.equal(Object.keys(t.book().summaries).length, 3);
    const calls = t.stub.requests.filter((r) => r.max_tokens);
    assert.ok(calls.every((r) => r.model === 'claude-sonnet-5-5' && !r.thinking && r.output_config?.effort === 'low' && r.max_tokens === 8000));
  } finally {
    await t.done();
  }
});
