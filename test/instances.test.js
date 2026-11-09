// Two apps from one copy of the code: each has an id and a data folder of its own, and a data folder
// has one server at a time, on one machine as across machines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, startServer, tempDir } from './helpers.js';

const PW = 'test-password';

test('an APP_ID with no letter or digit in it is refused, not taken for the first app', async () => {
  await assert.rejects(startServer({ env: { PAPERGLOSS_PASSWORD: PW, APP_ID: '밀' } }), /APP_ID "밀" has no letters a-z or digits/);
});

test("on one machine too: a heartbeat whose process still runs keeps a second server off its data folder; a stopped one's is taken over", async () => {
  const dir = tempDir();
  const lock = path.join(dir, 'server.lock');
  const write = (fields) => fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), at: new Date().toISOString(), ...fields }));
  const holder = () => JSON.parse(fs.readFileSync(lock, 'utf8')).pid;
  try {
    // This test's own process stands for a server of this machine that still runs.
    write({ pid: process.pid });
    await assert.rejects(startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } }), new RegExp(`pid ${process.pid}\\) is using`));
    assert.equal(holder(), process.pid, 'left as it was');
    const forced = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, FORCE_START: '1' } });
    assert.equal(holder(), forced.pid);
    await forced.stop();
    // Taken over: one whose process is gone, one over 3 minutes old, and one an earlier server of
    // the same restart loop left (start.ps1), whatever process has its pid now.
    const old = new Date(Date.now() - 4 * 60_000).toISOString();
    for (const fields of [{ pid: 2 ** 31 - 1 }, { pid: process.pid, at: old }, { pid: process.pid, loop: 'loop-a' }]) {
      write(fields);
      const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, PAPERGLOSS_LOOP: 'loop-a' } });
      assert.equal(holder(), srv.pid, JSON.stringify(fields));
      await srv.stop();
    }
    // Another app given this folder while the first one's server runs.
    fs.rmSync(lock, { force: true });
    const first = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
    try {
      await assert.rejects(startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW, APP_ID: 'mill', PAPERGLOSS_LOOP: 'its-own' } }), new RegExp(`pid ${first.pid}\\) is using`));
      assert.equal(holder(), first.pid, 'the first keeps it');
    } finally {
      await first.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The start scripts in a copy of the repo's layout: these instances/<name>.env files, the first
// app's data folder, a server that only says what it was given, and a home of its own whose env
// file is `shared` (never the real one).
function layout(instances, shared) {
  const dir = tempDir();
  for (const sub of ['scripts', 'instances', 'server', 'public', 'data', path.join('home', '.config', 'eng-reader')]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const name of ['start.sh', 'start.ps1']) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(dir, 'scripts', name));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), 'console.log(JSON.stringify([process.env.APP_ID ?? null, process.env.DATA_DIR ?? null]));\n');
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(dir, 'home', '.config', 'eng-reader', 'env'), shared);
  for (const [name, text] of Object.entries(instances)) fs.writeFileSync(path.join(dir, 'instances', `${name}.env`), text);
  return dir;
}

// The caller's environment without an app's settings, and with the layout's home.
function scriptEnv(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(APP_|PAPERGLOSS_|DATA_DIR$|LOG_FILE$|BACKUP_DIR$)/i.test(k)));
  return { ...env, HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home') };
}

const hasSh = spawnSync('sh', ['-c', 'command -v dirname find mkdir node'], { stdio: 'ignore' }).status === 0;
const SCRIPTS = [
  ['start.sh', !hasSh && 'no sh with dirname, find, mkdir and node here', (dir, name) => spawnSync('sh', ['scripts/start.sh', name], { cwd: dir, env: scriptEnv(dir), encoding: 'utf8', timeout: 20_000 })],
  [
    'start.ps1',
    process.platform !== 'win32' && 'Windows only',
    (dir, name) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'scripts', 'start.ps1'), name], { cwd: dir, env: scriptEnv(dir), encoding: 'utf8', timeout: 60_000 }),
  ],
];

for (const [script, skip, run] of SCRIPTS) {
  test(`${script}: another app's id is its name unless its file gives one, never the first app's; one without a data folder of its own is refused`, { skip }, (t) => {
    const dir = layout(
      {
        mill: 'APP_NAME="Sparrow\'s Mill"\nPORT=8788\nDATA_DIR=data-mill\n',
        grain: 'APP_ID=grain\nDATA_DIR=data-grain\n',
        nodata: 'APP_NAME=Nothing\n',
        same: 'DATA_DIR=./data/\n',
      },
      'APP_ID=nest\nDATA_DIR=data\nPORT=8787\n',
    );
    // What the server was given ([APP_ID, DATA_DIR]), or why it was not started.
    const said = (name) => {
      const r = run(dir, name);
      return r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').at(-1)) : `${r.status}: ${(r.stderr || '').trim()}`;
    };
    try {
      const mill = said('mill');
      if (/running scripts is disabled|cannot be loaded/i.test(String(mill))) return t.skip('scripts may not run here (execution policy)');
      assert.deepEqual(mill, ['mill', 'data-mill']);
      assert.deepEqual(said('grain'), ['grain', 'data-grain']);
      assert.deepEqual(said(''), ['nest', 'data'], 'the first app as before');
      assert.match(said('nodata'), /^1: The nodata app needs a data folder of its own: set DATA_DIR in instances.nodata\.env \(data is the first app's\)\.$/);
      assert.match(said('same'), /^1: The same app needs a data folder of its own/);
      assert.match(said('none'), /^1: No app named 'none'/);
      assert.match(said('../mill'), script === 'start.sh' ? /^1: '\.\.\/mill' is no app's name: a name is lowercase letters and digits/ : /^1: No app named '\.\.\/mill'/);
      assert.ok(fs.existsSync(path.join(dir, 'data-mill', 'tmp')), 'its own folder made ready');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
