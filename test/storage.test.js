// Atomic writes on Windows, where a sync client or a virus scanner can hold the target open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './helpers.js';

const { writeJsonFile } = await import('../server/util.js');

const failWith = (code) => Object.assign(new Error(code), { code });

test('a rename refused while the file is held open is retried; other errors are not', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'meta.json');
  const rename = fsp.rename;
  let calls = 0;
  try {
    // EPERM twice, then the rename goes through.
    fsp.rename = async (...args) => {
      calls += 1;
      if (calls <= 2) throw failWith('EPERM');
      return rename(...args);
    };
    await writeJsonFile(file, { title: 'first' });
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { title: 'first' });

    calls = 0;
    fsp.rename = async (...args) => {
      calls += 1;
      if (calls <= 2) throw failWith(['EBUSY', 'EACCES'][calls - 1]);
      return rename(...args);
    };
    await writeJsonFile(file, { title: 'kept' });
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { title: 'kept' });

    calls = 0;
    fsp.rename = async () => {
      calls += 1;
      throw failWith('EPERM');
    };
    await assert.rejects(writeJsonFile(file, { title: 'lost' }), { code: 'EPERM' });
    assert.equal(calls, 10, 'gives up after ten tries');

    calls = 0;
    fsp.rename = async () => {
      calls += 1;
      throw failWith('EXDEV');
    };
    await assert.rejects(writeJsonFile(file, { title: 'lost' }), { code: 'EXDEV' });
    assert.equal(calls, 1);

    assert.deepEqual(fs.readdirSync(dir), ['meta.json'], 'no temp files are left behind');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { title: 'kept' });
  } finally {
    fsp.rename = rename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
