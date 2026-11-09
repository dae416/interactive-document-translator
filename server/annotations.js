// Highlights, underlines, bookmarks and notes of a book. Every browser keeps its own copy too; the
// two are merged by id, the later `updatedAt` winning, and deletions stay as tombstones so they
// sync. A note also has `text`: Markdown the reader shows in blue after its passage.
import path from 'node:path';
import { PAPERS_DIR } from './config.js';
import { HttpError, readJsonFile, withLock, writeJsonFile } from './util.js';
import { checkId, getMeta } from './papers.js';

const MAX_ITEMS = 10000;
const ID_RE = /^a_[a-z0-9]{6,32}$/;
const TYPES = new Set(['highlight', 'underline', 'bookmark', 'note']);
const COLORS = new Set(['yellow', 'green', 'blue', 'pink']);
const MAX_NOTE = 20000;

const fileOf = (id) => path.join(PAPERS_DIR, checkId(id), 'annotations.json');
const isDate = (s) => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));

// A block id ("c3.12"), or with a "k" its translation ("c3.12k"); an offset into its text.
function point(p) {
  if (!p || typeof p !== 'object' || typeof p.b !== 'string' || !/^c\d+\.\d+k?$/.test(p.b)) return null;
  return Number.isInteger(p.o) && p.o >= 0 ? { b: p.b, o: p.o } : null;
}

// A clean copy of one item, or null when it doesn't fit the format.
export function cleanItem(a) {
  if (!a || typeof a !== 'object' || !ID_RE.test(a.id) || !TYPES.has(a.type)) return null;
  const start = point(a.start);
  const end = point(a.end);
  if (!start || !end || start.b.endsWith('k') !== end.b.endsWith('k')) return null;
  if (typeof a.chapter !== 'string' || !/^c\d+$/.test(a.chapter)) return null;
  if (a.color != null && !COLORS.has(a.color)) return null;
  if (typeof a.quote !== 'string' || a.quote.length > 2000 || !isDate(a.createdAt) || !isDate(a.updatedAt)) return null;
  const note = a.type === 'note';
  // (a deleted note's tombstone is kept without its text too, or with one too long to keep)
  const text = note && typeof a.text === 'string' && a.text.trim() && a.text.length <= MAX_NOTE ? a.text : null;
  if (note && !text && a.deleted !== true) return null;
  return {
    id: a.id,
    type: a.type,
    color: a.color ?? null,
    chapter: a.chapter,
    start,
    end,
    quote: a.quote,
    ...(text && { text }),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    deleted: a.deleted === true,
  };
}

export function mergeItems(current, incoming) {
  const byId = new Map(current.map((a) => [a.id, a]));
  for (const a of incoming) {
    const old = byId.get(a.id);
    if (!old || Date.parse(a.updatedAt) > Date.parse(old.updatedAt)) byId.set(a.id, a);
  }
  return [...byId.values()];
}

export async function getAnnotations(id) {
  await getMeta(id);
  return (await readJsonFile(fileOf(id)))?.items || [];
}

// Items that don't fit the format are dropped; the merged list is returned.
export async function putAnnotations(id, items) {
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new HttpError(400, 'annotations.bad');
  await getMeta(id);
  const incoming = items.map(cleanItem).filter(Boolean);
  return withLock(`ann:${id}`, async () => {
    // An unreadable file (e.g. a cloud-sync placeholder) throws here, before anything is written.
    const current = (await readJsonFile(fileOf(id)))?.items || [];
    const merged = mergeItems(current, incoming);
    if (merged.length > MAX_ITEMS) throw new HttpError(400, 'annotations.bad');
    if (JSON.stringify(merged) !== JSON.stringify(current)) await writeJsonFile(fileOf(id), { version: 1, items: merged });
    return merged;
  });
}
