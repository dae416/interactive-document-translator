// What every browser the reader is used in must be able to parse in the app's own client modules
// (public/assets/js; a vendored library tests for what it uses itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../public/assets/js/', import.meta.url));

test('no client module has a regex lookbehind: Safari before 16.4 cannot parse one, and then nothing that imports the module loads', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('sentences.js'));
  // (in a regex literal or a string for new RegExp alike)
  const found = files.flatMap((f) => fs.readFileSync(`${dir}${f}`, 'utf8').split('\n').flatMap((line, i) => (/\(\?<[=!]/.test(line) ? [`${f}:${i + 1}`] : [])));
  assert.deepEqual(found, [], 'a lookbehind, (?<= or (?<!');
});
