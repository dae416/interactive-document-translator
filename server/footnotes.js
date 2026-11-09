// Where each footnote of a chapter's translation goes in the original: after the words it explains
// (a quick Haiku pass, checked against the text), else after the sentence of the original that its
// translated sentence translates (the reader's sentence aligner), else at the end of the
// paragraph. Kept beside the translation in translations/<chapter>.notes-src.json, per block and
// keyed by a hash of what it was worked out from, so notes a translation gains later (more of a
// chapter in parts, say, which numbers the notes after it on) are placed without redoing the rest.
// The translation (getTranslation: a chapter's, or the parts of one done so far) is only read.
import path from 'node:path';
import { PAPERS_DIR, bookLangs, effectiveLlm } from './config.js';
import { wordsFor } from './langs.js';
import { hasKey, makeClient } from './llm/anthropic.js';
import { checkId, getMeta, readBook } from './papers.js';
import { getTranslation, modelCall } from './translate.js';
import { HttpError, readJsonFile, sha1, withLock, writeJsonFile } from './util.js';
import { MASK, align, sentences } from '../public/assets/js/sentences.js';

const MODEL = 'claude-haiku-5-5';
// Part of every block's hash: bump it when the prompt changes, and every note is placed again.
// (2: a block's notes kept in the order of its markers, whatever their numbers)
const VERSION = 2;
// ponytail: characters of the original and the translation per call, so a chapter is usually one
// call (a Matthew Henry chapter of 60k characters, some 35k tokens, is two); a longer block goes
// alone.
const BATCH = 60_000;

// For a pair { src, tgt } of languages (wordsFor).
const prompt = (pair) => {
  const { S, T, aS } = wordsFor(pair);
  return `Each <block> holds a paragraph of ${aS} book, its ${T} translation with footnote markers [^n] right after the ${T} words each footnote explains, and the footnotes. For every footnote, find the words in the ${S} paragraph that those marked ${T} words translate.
Reply with JSON only: {"<n>": {"phrase": "<the ${S} words>", "occurrence": <1 if it is the first time those words appear in the paragraph, 2 the second, and so on>}}.
Copy the phrase character for character from the ${S} paragraph (spelling, capitals, quotation marks, punctuation), and keep it short: usually one to six words. If the ${S} has nothing that the note belongs to, give "phrase": "".`;
};

const dirOf = (id) => path.join(PAPERS_DIR, checkId(id), 'translations');
// (replyOf, usable and batches also serve clauses.js)
export const replyOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
// ponytail: after a placement call fails (after the tries modelCall makes), a chapter's notes go by
// the fallbacks, not kept, for 10 minutes before the model is asked again.
const COOLDOWN = 10 * 60_000;
const inflight = new Map(); // "<book>/<chapter>/<hash of its translation>" -> its placement under way
const failed = new Map(); // "<book>/<chapter>" -> when its last placement call failed
export const usable = () => {
  const llm = effectiveLlm();
  return llm.protocol === 'anthropic' && hasKey(llm);
};

// GET /api/papers/:id/translations/:chapter/notes-src: { notes: { [n]: { b, at, by } } }, the
// marker of note n after character `at` of the chapter's block b; `by`: phrase, sentence or
// block. Worked out on the first request; requests meanwhile for the same translation share it (a
// part done since, which numbers the notes after it on, gets its own), and a chapter's placements
// take turns, each finding what the one before it kept.
export async function getNotesSrc(id, c) {
  // (404 before any of it is translated)
  const tr = await getTranslation(id, c);
  const key = `${id}/${c}/${sha1(JSON.stringify([tr.blocks, tr.notes]))}`;
  if (!inflight.has(key)) inflight.set(key, withLock(`notes-src:${id}/${c}`, () => place(id, c, tr)).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function place(id, c, tr) {
  const chapter = (await readBook(id)).chapters.find((ch) => ch.id === c);
  if (!chapter) throw new HttpError(400, 'book.badChapter');
  const pair = bookLangs(await getMeta(id));
  const notes = Array.isArray(tr.notes) ? tr.notes : [];
  const file = path.join(dirOf(id), `${c}.notes-src.json`);
  const old = (await readJsonFile(file))?.blocks || {};
  const keep = {}; // block -> { hash, notes: where each of its markers' notes goes, in order }
  const out = {}; // note -> { b, at, by }, the answer
  const answer = (i, ns, placed) => ns.forEach((n, k) => (out[n] = { b: i, ...placed[k] }));
  // A block with notes is kept as it was if nothing it was worked out from has changed; the numbers
  // of its markers don't count, as a part translated before it numbers them on.
  const todo = [];
  chapter.blocks.forEach((b, i) => {
    const tgt = tr.blocks[i];
    const ns = typeof tgt === 'string' ? markers(tgt, notes.length) : [];
    if (!ns.length) return;
    const hash = sha1(JSON.stringify([VERSION, b.x, tgt.replace(/\[\^\d+\]/g, '[^]'), ns.map((n) => notes[n - 1])]));
    if (old[i]?.hash !== hash) todo.push({ i, src: b.x, tgt, ns, hash, pair });
    else {
      keep[i] = old[i];
      answer(i, ns, old[i].notes);
    }
  });
  // (no model while a failed call's cooldown lasts, nor for the rest of a placement after one)
  const key = `${id}/${c}`;
  let client = usable() && !(Date.now() - (failed.get(key) ?? -Infinity) < COOLDOWN) ? makeClient(effectiveLlm()) : null;
  for (const batch of batches(todo)) {
    // (a book deleted, or the key taken away, since the call before: no more calls)
    if (client) await getMeta(id);
    if (client && !usable()) client = null;
    const found = client ? await ask(client, id, c, batch, notes, pair) : null;
    if (found) failed.delete(key);
    else if (client) {
      failed.set(key, Date.now());
      client = null;
    }
    for (const t of batch) {
      const placed = t.ns.map((n) => placeNote(t, n, found?.[n]));
      answer(t.i, t.ns, placed);
      // Without the model (no key, or the call failed) the fallbacks serve this time and are not
      // kept: the next request asks again.
      if (found) keep[t.i] = { hash: t.hash, notes: placed };
    }
  }
  if (JSON.stringify(keep) !== JSON.stringify(old)) {
    // A book deleted meanwhile is not brought back by this file (getMeta throws).
    await getMeta(id);
    await writeJsonFile(file, { version: VERSION, blocks: keep });
  }
  return { notes: out };
}

// The note numbers a translated block marks, in order; markers of notes that don't exist are text.
function markers(tgt, count) {
  const ns = [...tgt.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= count);
  return [...new Set(ns)];
}

// Blocks in batches of at most `limit` characters of the original and the translation (one longer
// goes alone).
export function* batches(todo, limit = BATCH) {
  let batch = [];
  let size = 0;
  for (const t of todo) {
    const n = t.src.length + t.tgt.length;
    if (batch.length && size + n > limit) {
      yield batch;
      batch = [];
      size = 0;
    }
    batch.push(t);
    size += n;
  }
  if (batch.length) yield batch;
}

// { [n]: { phrase, occurrence } } from the model for a batch of blocks, or null when the call
// fails (after the tries modelCall makes).
async function ask(client, id, c, batch, notes, pair) {
  const tags = wordsFor(pair).tags;
  const content = batch
    .map((t) => [`<block>`, `<${tags.s}>${t.src}</${tags.s}>`, `<${tags.t}>${t.tgt}</${tags.t}>`, ...t.ns.map((n) => `<note n="${n}">${notes[n - 1]}</note>`), `</block>`].join('\n'))
    .join('\n\n');
  const count = batch.reduce((k, t) => k + t.ns.length, 0);
  const params = { model: MODEL, max_tokens: 100 + 50 * count, thinking: { type: 'disabled' }, system: prompt(pair), messages: [{ role: 'user', content }] };
  let text;
  try {
    // (check: a book deleted, or the key taken away, during a wait between tries ends it)
    const log = { paper: id, chapter: c, action: 'notes-src', model: MODEL };
    const check = async () => {
      await getMeta(id);
      if (!usable()) throw new HttpError(400, 'translate.noKey');
    };
    text = replyOf(await modelCall(() => client.messages.create(params, { maxRetries: 0, timeout: 120_000 }), { log, check }));
  } catch (err) {
    console.error(`[notes-src] ${id} ${c}:`, err.message);
    return null;
  }
  try {
    const found = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (found && typeof found === 'object') return found;
  } catch {
    // cut short (max_tokens) or not quite JSON: the entries that are whole
  }
  const found = {};
  for (const m of text.matchAll(/"(\d+)"\s*:\s*\{\s*"phrase"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"occurrence"\s*:\s*(\d+)\s*\}/g)) {
    found[m[1]] = { phrase: JSON.parse(m[2]), occurrence: Number(m[3]) };
  }
  return found;
}

// Where note n of block t goes: after the phrase the model named, if the original has it at that
// occurrence; else after the sentence of the original its translated sentence translates; else at
// the end.
function placeNote(t, n, hit) {
  const phrase = typeof hit?.phrase === 'string' ? hit.phrase.trim() : '';
  const occurrence = Number.isInteger(hit?.occurrence) && hit.occurrence > 0 ? hit.occurrence : 1;
  if (phrase) {
    let at = -1;
    for (let k = 0; k < occurrence; k++) {
      at = t.src.indexOf(phrase, at + 1);
      if (at < 0) break;
    }
    if (at >= 0) return { at: at + phrase.length, by: 'phrase' };
  }
  t.ends ??= sentenceEnds(t.src, t.tgt, t.pair);
  const end = t.ends(n);
  return end == null ? { at: t.src.trimEnd().length, by: 'block' } : { at: end, by: 'sentence' };
}

// For a block, (n) => the end of the sentence of the original (the last, where several are one
// translated sentence) that the translated sentence holding marker n translates, or null if there
// is none. Its sentences are found and aligned once, the markers masked, however many notes it has.
function sentenceEnds(src, tgt, pair) {
  const masked = tgt.replace(/\[\^\d+\]/g, (m) => MASK.repeat(m.length));
  const ss = sentences(src, pair.src);
  const ts = sentences(masked, pair.tgt);
  const beads = ss.length && ts.length ? align(ss.map((s) => src.slice(...s)), ts.map((s) => masked.slice(...s)), { from: pair.src, to: pair.tgt }) : [];
  return (n) => {
    const pos = tgt.indexOf(`[^${n}]`);
    const k = Math.max(0, ts.findLastIndex(([s]) => s <= pos));
    const bead = beads.find(([, , from, to]) => k >= from && k < to);
    return bead && bead[1] > bead[0] ? ss[bead[1] - 1][1] : null;
  };
}
