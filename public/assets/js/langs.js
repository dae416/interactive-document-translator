// The two languages of book mode, as BCP-47 codes: `src`, the language a book is written in, and
// `tgt`, the reader's, which its chapters are translated into. English → Korean unless Settings
// (BOOK_SOURCE_LANG / BOOK_TARGET_LANG on the server) or the book itself say otherwise. Pure, and
// shared with the server (sentences.js, server/langs.js): the browser keeps the open book's pair in
// `langs` (reader.js sets it); the server passes a book's pair along and never reads `langs`.

export const DEFAULT_LANGS = Object.freeze({ src: 'en', tgt: 'ko' });
export const langs = { ...DEFAULT_LANGS };

export function setLangs(next) {
  langs.src = next?.src || DEFAULT_LANGS.src;
  langs.tgt = next?.tgt || DEFAULT_LANGS.tgt;
  return langs;
}

// A language without its script or region: "zh-Hant" -> "zh".
export const baseLang = (code) => String(code || '').split('-')[0].toLowerCase();

// A language as the view switch shows it (EN, KO+EN, KO): its code in capitals.
export const langLabel = (code) => String(code || '').toUpperCase();

// A language's name in the language `ui` ("Korean", "韩语"), else its code.
export function langName(code, ui = 'en') {
  try {
    return new Intl.DisplayNames([ui], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

// A language's own name, as the answer language is set: "한국어", "Español", "日本語".
export function autonym(code) {
  const s = langName(code, code);
  return s.charAt(0).toLocaleUpperCase(code) + s.slice(1);
}

// Scripts written without spaces between words: there a character counts as a word, and text may
// be cut between any two of them.
export const NO_SPACE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
const WORDS = new RegExp(`${NO_SPACE.source}|[^\\s${NO_SPACE.source.slice(1, -1)}]+`, 'gu');

// The words of a text: what spaces part, and each character of a script written without them.
export const countWords = (s) => (String(s).match(WORDS) || []).length;

// The script a language is usually written in (Intl.Locale's likely script) and the Unicode scripts
// of its letters: Hangul for Korean, kana and Han for Japanese, Han for Chinese, Latin for English.
const SETS = { Kore: ['Hang'], Jpan: ['Hira', 'Kana', 'Hani'], Hans: ['Hani'], Hant: ['Hani'] };
const scripts = new Map();
function letters(code) {
  if (!scripts.has(code)) {
    let script = 'Latn';
    try {
      script = new Intl.Locale(code).maximize().script || script;
    } catch {
      // not a language tag: Latin
    }
    let sets = SETS[script] || [script];
    try {
      new RegExp(`\\p{sc=${sets[0]}}`, 'u');
    } catch {
      sets = ['Latn']; // (a script this browser doesn't know)
    }
    scripts.set(code, { script, sets });
  }
  return scripts.get(code);
}

// The script a language is usually written in, as ISO 15924 ("Latn", "Kore", "Jpan").
export const scriptOf = (code) => letters(code).script;

// Whether a language puts spaces between its words (not Chinese, Japanese, Thai…).
export const spaced = (code) => !['Hani', 'Hans', 'Hant', 'Jpan', 'Thai', 'Laoo', 'Khmr', 'Mymr'].includes(letters(code).script);

// How many letters of `text`, outside formulas, are in a script only `tgt` is written in, and how
// many in one only `src` is: Hangul against Latin for Korean and English, kana against nothing for
// Japanese and Chinese (Han is both's). Null when the target has no script of its own here (English
// and Spanish; Chinese against Japanese, or Simplified against Traditional): no telling them apart.
export function scriptCounts(text, tgt, src) {
  const t = letters(tgt).sets;
  const s = letters(src).sets;
  const mine = t.filter((x) => !s.includes(x));
  const theirs = s.filter((x) => !t.includes(x));
  if (!mine.length) return null;
  const words = String(text).replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, ' ');
  const count = (sets) => (sets.length ? (words.match(lettersOf(sets)) || []).length : 0);
  return [count(mine), count(theirs)];
}
const classes = new Map();
function lettersOf(sets) {
  const key = sets.join();
  if (!classes.has(key)) classes.set(key, new RegExp(`[${sets.map((x) => `\\p{sc=${x}}`).join('')}]`, 'gu'));
  return classes.get(key);
}
