// Saved providers: one key per provider, each only sent to the server it was saved for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anthropicStub, api, chat, readConfig, recordingServer, signIn, startServer, tempDir } from './helpers.js';

const PW = 'test-password';
const models = (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[{"id":"m1"}]}');

test('each provider keeps its own key, and switching back restores it', async () => {
  const a = await recordingServer(models);
  const b = await recordingServer(models);
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const save = (body) => api(srv.url, 'PUT', '/api/settings', { cookie, body });
    const list = (llm) => api(srv.url, 'POST', '/api/llm/models', { cookie, body: llm ? { llm } : {} });

    await save({ llm: { preset: 'deepseek', protocol: 'openai', baseUrl: `${a.url}/v1`, apiKey: 'sk-key-for-a', model: 'model-a' } });
    const both = await save({ llm: { preset: 'openrouter', protocol: 'openai', baseUrl: `${b.url}/v1`, apiKey: 'sk-key-for-b', model: 'model-b' } });
    assert.equal(both.data.llm.preset, 'openrouter');
    assert.equal(both.data.providers.deepseek.hasKey, true);
    assert.equal(both.data.providers.openrouter.hasKey, true);
    assert.ok(!JSON.stringify(both.data).includes('sk-key-for'), 'keys must not reach the browser');

    // Switching needs only the provider's name; its model and key come back with it.
    const switched = await save({ llm: { preset: 'deepseek' } });
    assert.equal(switched.data.llm.model, 'model-a');
    assert.equal(switched.data.llm.hasKey, true);
    await list();
    assert.equal(a.requests.at(-1).headers.authorization, 'Bearer sk-key-for-a');

    // "Fetch list" in the settings form for the other saved provider uses that provider's key.
    await list({ preset: 'openrouter', protocol: 'openai', baseUrl: `${b.url}/v1` });
    assert.equal(b.requests.at(-1).headers.authorization, 'Bearer sk-key-for-b');
    // ...but never sends it to another provider's server.
    const before = a.requests.length;
    await list({ preset: 'openrouter', protocol: 'openai', baseUrl: `${a.url}/v1` });
    assert.equal(a.requests.length, before + 1);
    assert.equal(a.requests.at(-1).headers.authorization, undefined);
  } finally {
    await srv.stop();
    await a.close();
    await b.close();
  }
});

test('moving one provider to another server drops only its key; keys can be removed one by one', async () => {
  const a = await recordingServer(models);
  const b = await recordingServer(models);
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const save = (body) => api(srv.url, 'PUT', '/api/settings', { cookie, body });
    await save({ llm: { preset: 'deepseek', protocol: 'openai', baseUrl: `${a.url}/v1`, apiKey: 'sk-a', model: 'm' } });
    await save({ llm: { preset: 'custom', protocol: 'openai', baseUrl: `${b.url}/v1`, apiKey: 'sk-b', model: 'm' } });

    // Same server, other path: the key stays.
    let s = (await save({ llm: { preset: 'deepseek', baseUrl: `${a.url}/other/v1` } })).data;
    assert.equal(s.providers.deepseek.hasKey, true);
    // Another server without a new key: the key is dropped, the other provider keeps its own.
    s = (await save({ llm: { preset: 'deepseek', baseUrl: `${b.url}/v1` } })).data;
    assert.equal(s.providers.deepseek.hasKey, false);
    assert.equal(s.providers.custom.hasKey, true);

    s = (await save({ forgetKey: 'custom' })).data;
    assert.equal(s.providers.custom.hasKey, false);
    assert.equal(s.llm.preset, 'deepseek', 'removing a key does not switch providers');
    assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'config.json'), 'utf8').includes('sk-b'));
  } finally {
    await srv.stop();
    await a.close();
    await b.close();
  }
});

test('single-provider settings from earlier versions carry over', async () => {
  const a = await recordingServer(models);
  const dir = tempDir();
  const old = { protocol: 'openai', preset: 'deepseek', baseUrl: `${a.url}/v1`, apiKey: 'sk-old-key', model: 'deepseek-chat', effort: { translate: 'low' } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ secret: 'b'.repeat(64), llm: old }));
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const s = (await api(srv.url, 'GET', '/api/settings', { cookie })).data;
    assert.equal(s.llm.preset, 'deepseek');
    assert.equal(s.llm.model, 'deepseek-chat');
    assert.equal(s.llm.hasKey, true);
    const stored = readConfig(dir).llm;
    assert.equal(stored.providers.deepseek.apiKey, 'sk-old-key');
    assert.equal(stored.apiKey, undefined);
    await api(srv.url, 'POST', '/api/llm/models', { cookie, body: {} });
    assert.equal(a.requests.at(-1).headers.authorization, 'Bearer sk-old-key');
  } finally {
    await srv.stop();
    await a.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an Anthropic provider on another base URL never gets the environment key', async () => {
  const stub = await anthropicStub();
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, ANTHROPIC_API_KEY: 'sk-ant-env-secret' } });
  try {
    const cookie = await signIn(srv.url, PW);
    const llm = { preset: 'anthropic', protocol: 'anthropic', baseUrl: stub.url, model: 'claude-opus-5-5' };
    assert.equal((await api(srv.url, 'PUT', '/api/settings', { cookie, body: { llm } })).data.llm.hasKey, false);
    const check = await api(srv.url, 'POST', '/api/llm/test', { cookie, body: {} });
    assert.equal(check.data.code, 'no_key');
    await api(srv.url, 'POST', '/api/llm/models', { cookie, body: {} });
    const res = await chat(srv.url, cookie, { action: 'ask', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.events.at(-1).t, 'error');
    assert.equal(stub.headers.length, 0, 'nothing was sent without a key of its own');

    // A key saved for that server is the one it gets.
    await api(srv.url, 'PUT', '/api/settings', { cookie, body: { llm: { apiKey: 'sk-ant-saved-here' } } });
    assert.equal((await api(srv.url, 'POST', '/api/llm/test', { cookie, body: {} })).status, 200);
    assert.equal(stub.headers.at(-1)['x-api-key'], 'sk-ant-saved-here');
    assert.ok(!JSON.stringify(stub.headers).includes('sk-ant-env-secret'));
  } finally {
    await srv.stop();
    await stub.close();
  }
});
