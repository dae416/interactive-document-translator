// Passwords, sessions and the sign-in limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { api, lanAddress, readConfig, signIn, startServer, tempDir, waitFor } from './helpers.js';

const PW = 'test-password';

test('a generated password is shown once and stored only as a hash', async () => {
  const srv = await startServer();
  try {
    const m = await waitFor(() => /Generated access password: (\S+)/.exec(srv.output()));
    const password = m[1];
    assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'config.json'), 'utf8').includes(password));
    assert.match(readConfig(srv.dataDir).passwordHash, /^scrypt\$/);
    await signIn(srv.url, password);
    assert.equal((await api(srv.url, 'POST', '/api/login', { body: { password: 'wrong' } })).status, 401);
  } finally {
    await srv.stop();
  }
});

test('a plaintext password from an older version keeps working and is rewritten as a hash', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ secret: 'a'.repeat(64), password: 'old-plain-pw' }));
  const srv = await startServer({ dataDir: dir });
  try {
    const config = readConfig(dir);
    assert.equal(config.password, undefined);
    assert.match(config.passwordHash, /^scrypt\$/);
    await signIn(srv.url, 'old-plain-pw');
    assert.ok(!srv.output().includes('Generated access password'));
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PAPERGLOSS_PASSWORD is never written to disk, and sessions survive a restart', async () => {
  const dir = tempDir();
  const env = { PAPERGLOSS_PASSWORD: 'env-secret-pw' };
  let srv = await startServer({ dataDir: dir, env });
  let cookie;
  try {
    cookie = await signIn(srv.url, 'env-secret-pw');
    assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('env-secret-pw'));
    assert.equal(readConfig(dir).passwordHash, '');
  } finally {
    await srv.stop();
  }
  srv = await startServer({ dataDir: dir, env });
  try {
    assert.equal((await api(srv.url, 'GET', '/api/session', { cookie })).data.authed, true);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sessions expire after 180 days, are renewed after a week, and end when the password changes', async () => {
  const srv = await startServer();
  try {
    const { secret, passwordHash } = readConfig(srv.dataDir);
    const issuedDaysAgo = (days) => {
      const issued = Math.floor(Date.now() / 1000 - days * 86400).toString(36);
      const sig = crypto.createHmac('sha256', secret).update(`session:${issued}:${passwordHash}`).digest('hex');
      return `pr_session=${issued}.${sig}`;
    };
    const fresh = await api(srv.url, 'GET', '/api/session', { cookie: issuedDaysAgo(1) });
    assert.equal(fresh.data.authed, true);
    assert.equal(fresh.headers.get('set-cookie'), null);

    const weekOld = await api(srv.url, 'GET', '/api/session', { cookie: issuedDaysAgo(10) });
    assert.equal(weekOld.data.authed, true);
    assert.match(weekOld.headers.get('set-cookie') || '', /^pr_session=/);

    assert.equal((await api(srv.url, 'GET', '/api/session', { cookie: issuedDaysAgo(181) })).data.authed, false);
    assert.equal((await api(srv.url, 'GET', '/api/papers', { cookie: issuedDaysAgo(181) })).status, 401);

    const password = /Generated access password: (\S+)/.exec(srv.output())[1];
    const cookie = await signIn(srv.url, password);
    const changed = await api(srv.url, 'PUT', '/api/password', { cookie, body: { oldPassword: password, newPassword: 'brand-new-pw' } });
    assert.equal(changed.status, 200);
    assert.equal((await api(srv.url, 'GET', '/api/papers', { cookie })).status, 401);
    await signIn(srv.url, 'brand-new-pw');
  } finally {
    await srv.stop();
  }
});

test('malformed or duplicate cookies do not break the session check', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const junk = await api(srv.url, 'GET', '/api/session', { cookie: 'other=100%; x=%E0%A4%A' });
    assert.equal(junk.status, 200);
    assert.equal(junk.data.authed, false);
    // e.g. a cookie of the same name set by a parent domain, sent before ours
    const shadowed = await api(srv.url, 'GET', '/api/papers', { cookie: `pr_session=forged; other=100%; ${cookie}` });
    assert.equal(shadowed.status, 200);
  } finally {
    await srv.stop();
  }
});

test('behind a local proxy, the last X-Forwarded-For entry is the client', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const attempt = (xff) => api(srv.url, 'POST', '/api/login', { body: { password: 'nope' }, headers: { 'X-Forwarded-For': xff } });
    // The first entries are whatever the client sent; they don't buy extra attempts.
    for (let i = 0; i < 10; i++) assert.equal((await attempt(`198.51.100.${i}, 203.0.113.7`)).status, 401);
    assert.equal((await attempt('192.0.2.1, 203.0.113.7')).status, 429);
    assert.equal((await attempt('203.0.113.8')).status, 401);

    const ok = await api(srv.url, 'POST', '/api/login', {
      body: { password: PW },
      headers: { 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https' },
    });
    assert.match(ok.headers.get('set-cookie'), /; Secure/);
  } finally {
    await srv.stop();
  }
});

test('behind a tunnel or reverse proxy on this machine, sessions are Secure and same-site requests pass', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    // What such a proxy sends: the public Host kept, X-Forwarded-Host/-Proto/-For added.
    const host = 'reader.example.net';
    const proxied = { Host: host, 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7', Origin: `https://${host}` };
    const login = await api(srv.url, 'POST', '/api/login', { body: { password: PW }, headers: proxied });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; HttpOnly; SameSite=Lax; .*; Secure$/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const save = await api(srv.url, 'PUT', '/api/settings', { cookie, body: { prefs: { targetLang: '한국어' } }, headers: proxied });
    assert.equal(save.status, 200);
    const other = await api(srv.url, 'PUT', '/api/settings', { cookie, body: {}, headers: { ...proxied, Origin: 'https://evil.example' } });
    assert.equal(other.status, 403);
  } finally {
    await srv.stop();
  }
});

test('a PAPERGLOSS_PASSWORD under 12 characters stops the server from starting', async () => {
  await assert.rejects(startServer({ env: { PAPERGLOSS_PASSWORD: 'short-pw' } }), /shorter than 12 characters/);
});

test('the sign-in limit counts an IPv6 /64 as one client', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const attempt = (ip) => api(srv.url, 'POST', '/api/login', { body: { password: 'nope' }, headers: { 'X-Forwarded-For': ip } });
    for (let i = 0; i < 10; i++) assert.equal((await attempt(`2001:db8:1:2::${i + 1}`)).status, 401);
    assert.equal((await attempt('2001:db8:1:2:ffff:ffff:ffff:ffff')).status, 429);
    assert.equal((await attempt('2001:db8:1:3::1')).status, 401, 'the next /64 is another client');
  } finally {
    await srv.stop();
  }
});

const lan = lanAddress();
test('X-Forwarded-* headers from other peers are ignored', { skip: !lan && 'no non-loopback address' }, async () => {
  const srv = await startServer({ env: { HOST: lan, PAPERGLOSS_PASSWORD: PW } });
  try {
    const url = `http://${lan}:${srv.port}`;
    const attempt = (i) => api(url, 'POST', '/api/login', { body: { password: 'nope' }, headers: { 'X-Forwarded-For': `198.51.100.${i}` } });
    for (let i = 0; i < 10; i++) assert.equal((await attempt(i)).status, 401);
    assert.equal((await attempt(99)).status, 429);
  } finally {
    await srv.stop();
  }
});

test('parallel guesses cannot get past the limit', async () => {
  const srv = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const guesses = Array.from({ length: 30 }, () => api(srv.url, 'POST', '/api/login', { body: { password: 'nope' } }));
    const statuses = (await Promise.all(guesses)).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 10);
    assert.equal(statuses.filter((s) => s === 429).length, 20);
  } finally {
    await srv.stop();
  }
});

test('another app of the same code has its own name, icons, sign-in cookie and backups; the first keeps its own', async () => {
  const work = await startServer({ env: { PAPERGLOSS_PASSWORD: PW, APP_ID: 'work', APP_NAME: 'Document Translator (work)' } });
  const first = await startServer({ env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    // (the first app's name is shortened under its icon; another app's is the name it was given)
    for (const [srv, name, short, icon, cookie, backups] of [
      [work, 'Document Translator (work)', 'Document Translator (work)', 'work', /^pr_session_work=/, ['work', 'auto']],
      [first, 'Interactive Document Translator', 'Doc Translator', 'app', /^pr_session=/, ['auto']],
    ]) {
      const page = await (await fetch(`${srv.url}/`)).text();
      assert.ok(page.includes(`<title>${name}</title>`) && page.includes(`<meta name="application-name" content="${name}" />`));
      assert.ok(page.includes(`<meta name="apple-mobile-web-app-title" content="${short}" />`));
      assert.ok(page.includes(`href="/icons/${icon}.svg"`) && page.includes(`href="/icons/${icon}-touch.png"`));
      assert.ok(!page.includes('{{'));
      const manifest = await (await fetch(`${srv.url}/manifest.webmanifest`)).json();
      assert.deepEqual([manifest.name, manifest.short_name], [name, short]);
      for (const { src } of manifest.icons) assert.equal((await fetch(`${srv.url}${src}`)).status, 200, src);
      assert.ok(manifest.icons.every(({ src }) => src.startsWith(`/icons/${icon}`)));
      assert.match(await signIn(srv.url, PW), cookie);
      assert.ok(await waitFor(() => fs.existsSync(path.join(srv.backupDir, ...backups)), 10000));
      assert.ok(srv.output().includes(`${name} is running`));
    }
  } finally {
    await work.stop();
    await first.stop();
  }
});
