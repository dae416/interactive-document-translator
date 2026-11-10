// Local backups of the data folder's JSON, and the server's log file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT, sleep, startServer, tempDir, waitFor } from './helpers.js';

const { snapshot } = await import('../server/backup.js');

// Every file under `dir`, relative, with its size and mtime.
function tree(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...tree(dir, name));
    else out.push([name.split(path.sep).join('/'), fs.statSync(path.join(dir, name)).size, fs.statSync(path.join(dir, name)).mtimeMs]);
  }
  return out.sort();
}

test('a snapshot copies the JSON only (not config.json), leaves out empty placeholders and files gone meanwhile, is skipped when nothing changed, keeps the newest 48 and one a day for 30 days, and never writes in the data folder', async (t) => {
  const data = tempDir();
  const base = tempDir();
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
    fs.writeFileSync(path.join(data, rel), text);
  };
  put('config.json', '{"secret":"s","llm":{}}');
  put('usage.jsonl', '{"action":"translate-chapter"}\n');
  put('server.lock', '{"pid":1}');
  put('papers/b/meta.json', '{"id":"b"}');
  put('papers/b/annotations.json', '{"items":[{"id":"a_1"}]}');
  put('papers/b/translations/c1.json', '{"blocks":["번역"]}');
  put('papers/b/paper.pdf', '%PDF-1.7');
  put('papers/b/paper.html', '<article></article>');
  put('papers/b/figures/p1-1.png', 'png');
  put('papers/b/book.json', ''); // a cloud-sync placeholder
  put('papers/b/threads/gone.json', '{}'); // deleted while the folder is listed
  const before = tree(data);
  const warn = t.mock.method(console, 'warn', () => {});
  const stat = fsp.stat;
  const vanish = t.mock.method(fsp, 'stat', (file, ...rest) => (path.basename(String(file)) === 'gone.json' ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })) : stat(file, ...rest)));
  const at = (d, h) => new Date(2026, 9, d, h, 0, 0);

  const first = await snapshot(data, base, at(24, 12));
  vanish.mock.restore();
  assert.equal(first, path.join(base, 'auto', '20261024-120000'));
  assert.deepEqual(
    tree(first).map(([name]) => name),
    ['.signature', 'papers/b/annotations.json', 'papers/b/meta.json', 'papers/b/translations/c1.json', 'usage.jsonl'],
  );
  assert.equal(fs.readFileSync(path.join(first, 'papers', 'b', 'annotations.json'), 'utf8'), '{"items":[{"id":"a_1"}]}');
  assert.match(warn.mock.calls[0].arguments[0], /left out 1 empty file.*book\.json/);
  assert.deepEqual(tree(data), before, 'the data folder is only read');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(base, 'auto')).mode & 0o777, 0o700);
  fs.rmSync(path.join(data, 'papers', 'b', 'threads'), { recursive: true });

  assert.equal(await snapshot(data, base, at(24, 13)), null, 'nothing changed');
  put('config.json', '{"secret":"s","llm":{},"prefs":{}}');
  assert.equal(await snapshot(data, base, at(24, 13)), null, 'nor when only config.json did (every start rewrites it)');
  put('papers/b/annotations.json', '{"items":[{"id":"a_1"},{"id":"a_2"}]}');
  const second = await snapshot(data, base, at(24, 14));
  assert.equal(path.basename(second), '20261024-140000');
  assert.equal(fs.readFileSync(path.join(second, 'papers', 'b', 'annotations.json'), 'utf8'), '{"items":[{"id":"a_1"},{"id":"a_2"}]}');
  assert.equal(fs.readFileSync(path.join(first, 'papers', 'b', 'annotations.json'), 'utf8'), '{"items":[{"id":"a_1"}]}', 'the older one stays as it was');

  // 50 snapshots of October 20, three older ones, one cut short and a file that isn't ours.
  const auto = path.join(base, 'auto');
  for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(auto, `20261020-0000${String(i).padStart(2, '0')}`));
  for (const s of ['20260920-120000', '20261001-080000', '20261001-200000']) fs.mkdirSync(path.join(auto, s));
  fs.mkdirSync(path.join(auto, '.20261024-145959.tmp'));
  fs.writeFileSync(path.join(auto, 'notes.tmp'), 'mine');
  put('usage.jsonl', '{"action":"translate-chapter"}\n{"action":"review-chapter"}\n');
  const third = await snapshot(data, base, at(24, 15));
  assert.equal(path.basename(third), '20261024-150000');
  const kept = fs.readdirSync(auto).sort();
  assert.deepEqual(kept.filter((n) => !/^\d{8}-\d{6}$/.test(n)), ['notes.tmp'], 'the one cut short is gone');
  const stamps = kept.filter((n) => /^\d{8}-\d{6}$/.test(n));
  // The newest 48, and the newest of October 1 (within 30 days); not September 20.
  assert.equal(stamps.length, 49);
  assert.deepEqual(stamps.slice(0, 2), ['20261001-200000', '20261020-000005']);
  assert.deepEqual(stamps.slice(-3), ['20261024-120000', '20261024-140000', '20261024-150000']);

  await assert.rejects(snapshot(data, path.join(data, 'backups')), /inside the data folder/);
  assert.equal(fs.existsSync(path.join(data, 'backups')), false);
  // A link that leads into the data folder is refused too.
  const links = tempDir();
  fs.mkdirSync(path.join(data, 'sub'));
  fs.symlinkSync(path.join(data, 'sub'), path.join(links, 'backups'), 'junction');
  await assert.rejects(snapshot(data, path.join(links, 'backups')), /inside the data folder/);
  fs.rmSync(links, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(base, { recursive: true, force: true });
});

test('the server backs up its data at startup, but not config.json, so a restart that changed nothing adds no snapshot; it keeps its output in a log file, but not a generated password', async () => {
  const dir = tempDir();
  const backups = tempDir();
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), '{"action":"translate"}\n');
  const auto = path.join(backups, 'auto');
  // No PAPERGLOSS_PASSWORD: the server makes one up and shows it once.
  const srv = await startServer({ dataDir: dir, env: { BACKUP_DIR: backups } });
  try {
    assert.ok(await waitFor(() => fs.existsSync(auto) && fs.readdirSync(auto).length === 1, 10000));
    const [stamp] = fs.readdirSync(auto);
    assert.deepEqual(fs.readdirSync(path.join(auto, stamp)).sort(), ['.signature', 'usage.jsonl']);
    const log = fs.readFileSync(srv.logFile, 'utf8');
    assert.match(log, /Interactive Document Translator is running/);
    assert.match(log, /\[backup\] /);
    const password = /Generated access password: (\S+)/.exec(srv.output())?.[1];
    assert.ok(password);
    assert.ok(!log.includes(password));
  } finally {
    await srv.stop();
  }
  const again = await startServer({ dataDir: dir, env: { BACKUP_DIR: backups } });
  try {
    await sleep(1500);
    assert.equal(fs.readdirSync(auto).length, 1, 'config.json was written again, and nothing else changed');
  } finally {
    await again.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(backups, { recursive: true, force: true });
  }
});

test('the log file is kept to about 2 MB, the one before it beside it, or started over while held open; owner-only; LOG_FILE=off writes none', () => {
  const dir = tempDir();
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, `${'x'.repeat(2 * 1024 * 1024)}\n`);
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/log.js'); console.error('[translate] after');"], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  run({ LOG_FILE: file });
  assert.equal(fs.statSync(`${file}.1`).size, 2 * 1024 * 1024 + 1);
  assert.match(fs.readFileSync(file, 'utf8'), /^\S+Z error \[translate\] after\n$/);
  // One that can't be moved aside (a viewer holds it open on Windows; here a folder is in the way)
  // starts over, and the new line is kept.
  const held = path.join(dir, 'held.log');
  fs.writeFileSync(held, `${'x'.repeat(2 * 1024 * 1024)}\n`);
  fs.mkdirSync(`${held}.1`);
  run({ LOG_FILE: held });
  assert.match(fs.readFileSync(held, 'utf8'), /^\S+Z error \[translate\] after\n$/);
  if (process.platform !== 'win32') {
    const fresh = path.join(dir, 'new', 'server.log');
    run({ LOG_FILE: fresh });
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(fresh)).mode & 0o777, 0o700);
  }
  const off = path.join(dir, 'off.log');
  run({ LOG_FILE: 'off', HOME: dir, USERPROFILE: dir });
  assert.equal(fs.existsSync(off), false);
  assert.equal(fs.existsSync(path.join(dir, '.config')), false, 'not the default place either');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("another app's log has its id in its name, in the default place and where LOG_FILE puts it", () => {
  const dir = tempDir();
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/log.js'); console.log('[server] up');"], { cwd: ROOT, env: { ...process.env, LOG_FILE: '', ...env }, encoding: 'utf8' });
  run({ LOG_FILE: path.join(dir, 'eng.log'), APP_ID: 'work' });
  run({ LOG_FILE: path.join(dir, 'eng.log'), APP_ID: '' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['eng-work.log', 'eng.log'], 'two apps never share one');
  assert.match(fs.readFileSync(path.join(dir, 'eng-work.log'), 'utf8'), /\[server\] up\n$/);
  run({ HOME: dir, USERPROFILE: dir, APP_ID: 'work' });
  assert.deepEqual(fs.readdirSync(path.join(dir, '.config', 'interactive-document-translator')), ['server-work.log']);
  fs.rmSync(dir, { recursive: true, force: true });
});
