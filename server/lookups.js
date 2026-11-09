// Answers already given in a book (papers/<id>/lookups.jsonl), so an identical first question
// needs no model call; and data/usage.jsonl, one line per model call.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, PAPERS_DIR } from './config.js';
import { PROMPT_VERSION } from './context.js';
import { appendJsonLine, sha1 } from './util.js';
import { DEFAULT_LANGS } from '../public/assets/js/langs.js';

const maps = new Map(); // book id -> Promise<Map<key, entry>>, read lazily
const fileOf = (id) => path.join(PAPERS_DIR, id, 'lookups.jsonl');

// `langs`: the book's pair of languages, which its instructions name. The default pair (English →
// Korean, once the only one) adds nothing, so its stored replies keep their keys.
export function lookupKey({ model, effort, targetLang, action, chapter, content, langs }) {
  const pair = langs && (langs.src !== DEFAULT_LANGS.src || langs.tgt !== DEFAULT_LANGS.tgt) ? [langs.src, langs.tgt] : [];
  return sha1(JSON.stringify([model, effort, targetLang, PROMPT_VERSION, action, chapter, content, ...pair]));
}

function load(id) {
  if (!maps.has(id)) {
    maps.set(
      id,
      (async () => {
        const map = new Map();
        let text = '';
        try {
          text = await fsp.readFile(fileOf(id), 'utf8');
        } catch {
          // none yet, or unreadable: every lookup misses
        }
        for (const line of text.split('\n')) {
          try {
            const entry = JSON.parse(line);
            if (entry?.key && typeof entry.text === 'string') map.set(entry.key, entry);
          } catch {
            // blank or partial line
          }
        }
        return map;
      })(),
    );
  }
  return maps.get(id);
}

export async function findLookup(id, key) {
  return (await load(id)).get(key) || null;
}

export async function storeLookup(id, { key, text, model }) {
  const entry = { key, text, model, at: new Date().toISOString() };
  (await load(id)).set(key, entry);
  await appendJsonLine(fileOf(id), entry).catch((err) => console.error('[lookups]', err.message));
}

export function forgetLookups(id) {
  maps.delete(id);
}

// { paper, chapter, action, model, cached, usage, ms }; `cached` means answered from lookups.jsonl. A
// failed call (translate.js) has `attempt` and `error`, and `usage` null or what was counted.
export function logUsage(entry) {
  return appendJsonLine(path.join(DATA_DIR, 'usage.jsonl'), { at: new Date().toISOString(), ...entry }).catch((err) => {
    console.error('[usage]', err.message);
  });
}
