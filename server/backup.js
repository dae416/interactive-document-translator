// Local snapshots of the data folder's JSON (annotations, threads, metadata, books, raw OCR text,
// translations, usage), so a sync conflict or a bad write can't take what was marked, asked or
// paid for: ~/interactive-document-translator-backups/auto/<YYYYMMDD-HHMMSS>/, at startup and every hour, only when
// something changed; the newest 48 are kept, and the newest of each day for 30 days. BACKUP_DIR
// moves the base; BACKUP_DIR=off turns it off. Another app (APP_ID, config.js) keeps its own in
// <base>/<APP_ID>/auto, so that one app never prunes the other's. PDFs, pages and pictures are
// originals that rarely change, so they are left out, and so is config.json: it holds the session
// secret and the API keys, and every start rewrites it. The
// data folder is only ever read.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APP_ID } from './config.js';

// ponytail: up to 48 + 30 full copies of the JSON (under 1 MB today); hard-link unchanged files if
// it grows.
const KEEP = 48;
const DAYS = 30;
const SIGNATURE = '.signature';
const STAMP = /^\d{8}-\d{6}$/;
const TMP = /^\.\d{8}-\d{6}\.tmp$/;

// A file or folder deleted while it is listed is passed over.
const gone = (err) => {
  if (err.code !== 'ENOENT') throw err;
  return null;
};

// Every .json/.jsonl file under `dir` but config.json: [relative path, size, mtime].
async function list(dir, rel = '') {
  const out = [];
  for (const entry of (await fsp.readdir(path.join(dir, rel), { withFileTypes: true }).catch(gone)) || []) {
    const name = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...(await list(dir, name)));
    else if (entry.isFile() && /\.jsonl?$/i.test(entry.name) && name !== 'config.json') {
      const st = await fsp.stat(path.join(dir, name)).catch(gone);
      if (st) out.push([name, st.size, Math.round(st.mtimeMs)]);
    }
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// A backup folder in the data folder would back itself up.
function outside(dataDir, dir, base) {
  const rel = path.relative(dataDir, dir);
  if (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel)) throw new Error(`the backup folder ${base} is inside the data folder`);
}

// Copies the JSON of `dataDir` to `<base>/auto/<stamp>` unless nothing changed (path, size and
// mtime of every file) since the newest snapshot there. Returns the new folder, or null.
export async function snapshot(dataDir, base, now = new Date()) {
  outside(path.resolve(dataDir), path.resolve(base), base);
  const root = path.join(base, 'auto');
  const files = (await list(dataDir)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signature = crypto.createHash('sha1').update(JSON.stringify(files)).digest('hex');
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  // A link may lead into the data folder all the same.
  outside(await fsp.realpath(dataDir), await fsp.realpath(root), base);
  const names = await fsp.readdir(root);
  // A snapshot cut short (the server stopped) is half a copy.
  for (const n of names.filter((x) => TMP.test(x))) await fsp.rm(path.join(root, n), { recursive: true, force: true });
  const kept = names.filter((n) => STAMP.test(n)).sort();
  if (kept.length && (await fsp.readFile(path.join(root, kept.at(-1), SIGNATURE), 'utf8').catch(() => '')) === signature) return null;
  const stamp = stampOf(now);
  if (kept.includes(stamp)) return null;
  const tmp = path.join(root, `.${stamp}.tmp`);
  const empty = [];
  for (const [name, size] of files) {
    // A cloud-sync placeholder, or a file being rewritten: no use copying it.
    if (!size) {
      empty.push(name);
      continue;
    }
    await fsp.mkdir(path.join(tmp, path.dirname(name)), { recursive: true });
    await fsp.copyFile(path.join(dataDir, name), path.join(tmp, name)).catch(gone);
  }
  if (empty.length) console.warn(`[backup] left out ${empty.length} empty file(s), sync placeholders?: ${empty.join(', ')}`);
  await fsp.mkdir(tmp, { recursive: true });
  await fsp.writeFile(path.join(tmp, SIGNATURE), signature);
  await fsp.rename(tmp, path.join(root, stamp));
  // The newest 48, and the newest of each of the last 30 days.
  const all = [...kept, stamp].sort();
  const since = stampOf(new Date(now - DAYS * 86_400_000)).slice(0, 8);
  const daily = new Map(all.filter((s) => s.slice(0, 8) >= since).map((s) => [s.slice(0, 8), s]));
  const keep = new Set([...all.slice(-KEEP), ...daily.values()]);
  for (const old of all) if (!keep.has(old)) await fsp.rm(path.join(root, old), { recursive: true, force: true });
  return path.join(root, stamp);
}

// At startup and then every hour; one at a time.
export function startBackups(dataDir) {
  const setting = process.env.BACKUP_DIR;
  if (setting === 'off') return;
  const base = path.resolve(setting || path.join(os.homedir(), 'interactive-document-translator-backups'), APP_ID);
  let busy = false;
  const take = async () => {
    if (busy) return;
    busy = true;
    try {
      const dir = await snapshot(dataDir, base);
      if (dir) console.log(`[backup] ${dir}`);
    } catch (err) {
      console.error('[backup]', err.message);
    } finally {
      busy = false;
    }
  };
  take();
  setInterval(take, 60 * 60_000).unref();
}
