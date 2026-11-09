// What the prompts say of a book's two languages: the one it is written in (source) and the
// reader's (target), BCP-47 codes (public/assets/js/langs.js). A book's pair is bookLangs(meta)
// (config.js). The prompts were written for English → Korean, and say exactly what they said then
// for that pair; another pair gets the same prompts with its languages named in them.
import { DEFAULT_LANGS, autonym, baseLang, langName, spaced } from '../public/assets/js/langs.js';

export { autonym };

// A language code as given (env, Settings, a book) in its canonical form ("KO" -> "ko"), or '' when
// it names no language Intl knows.
export function normLang(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > 35) return '';
  try {
    const [code] = Intl.getCanonicalLocales(v.trim());
    return code && new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code) ? code : '';
  } catch {
    return '';
  }
}

// The pair of a book imported while Settings name none: BOOK_SOURCE_LANG / BOOK_TARGET_LANG, else
// English → Korean.
export const ENV_LANGS = Object.freeze({
  src: normLang(process.env.BOOK_SOURCE_LANG) || DEFAULT_LANGS.src,
  tgt: normLang(process.env.BOOK_TARGET_LANG) || DEFAULT_LANGS.tgt,
});
if (ENV_LANGS.src === ENV_LANGS.tgt) console.warn(`BOOK_SOURCE_LANG and BOOK_TARGET_LANG make both languages ${ENV_LANGS.src}: set the two (or choose them in Settings).`);

// A language's name in English, as the prompts use it: "Korean", "Simplified Chinese".
export const nameOf = (code) => langName(code, 'en');

// "a Korean", "an English" ("An English" at the start of a sentence).
export function withArticle(name, capital = false) {
  const an = /^[AEIOU]/.test(name) && !/^U(?:k|y|ni|ru)/.test(name);
  return `${capital ? 'A' : 'a'}${an ? 'n' : ''} ${name}`;
}

// A language as a tag of a request ("<english>", "<simplified_chinese>"): its English name in ASCII.
export const tagOf = (code) =>
  nameOf(code)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'text';

// The tags of a pair's two sides, never the same.
export function tagsOf({ src, tgt }) {
  const s = tagOf(src);
  const t = tagOf(tgt);
  return { s, t: t === s ? `${t}_translation` : t };
}

// What a prompt says of a target language beyond its name, by language; any other gets `general`.
// Korean has its loanword spelling, its Protestant names for the Bible, its word spacing, its own
// word for a note and an example of each; the clause pairing's examples are English → Korean.
const TARGETS = {
  ko: {
    names: 'Names in their usual Korean form (외래어 표기법); Bible books and people by their Korean Protestant names (e.g. "Hos. viii. 12" → 호세아 8:12).',
    example: ' (e.g. "Hos. viii. 12" → 호세아 8:12)',
    note: '설명',
    typos: 'Korean typos and spacing (띄어쓰기)',
    order: 'Korean often puts clauses in another order ("Y, because X" becomes "X 때문에 Y")',
  },
};
const general = (T) => ({
  names: `Names in their usual ${T} form; Bible books and people by their usual ${T} names.`,
  example: '',
  note: 'note',
  typos: `${T} typos and spacing`,
  order: `A translation often puts clauses in another order ("Y, because X" may become "X, so Y")`,
});

// The words of the prompts for a pair { src, tgt }: S and T, the two names; aS, aT ("an English",
// "a Korean"), AS, AT (the same opening a sentence); tags; and the target's own (TARGETS).
export function wordsFor({ src, tgt }) {
  const S = nameOf(src);
  const T = nameOf(tgt);
  return {
    S,
    T,
    aS: withArticle(S),
    aT: withArticle(T),
    AT: withArticle(T, true),
    spaced: spaced(tgt),
    tags: tagsOf({ src, tgt }),
    // (English → Korean is what the clause pairing's examples are)
    examples: baseLang(src) === 'en' && baseLang(tgt) === 'ko' ? 'Examples:' : `Examples, from an English book and its Korean translation (do the same for ${S} and ${T}):`,
    ...(TARGETS[baseLang(tgt)] || general(T)),
  };
}

// Tesseract's name for a language's trained data, for scanned books not in English (it reads
// English by default); null where it has none here.
const TESSERACT = {
  ar: 'ara', bg: 'bul', ca: 'cat', cs: 'ces', da: 'dan', de: 'deu', el: 'ell', es: 'spa', et: 'est', fa: 'fas', fi: 'fin', fr: 'fra',
  he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun', id: 'ind', it: 'ita', ja: 'jpn', ko: 'kor', la: 'lat', lt: 'lit', lv: 'lav', nb: 'nor',
  nl: 'nld', nn: 'nor', no: 'nor', pl: 'pol', pt: 'por', ro: 'ron', ru: 'rus', sk: 'slk', sl: 'slv', sr: 'srp', sv: 'swe', th: 'tha',
  tr: 'tur', uk: 'ukr', vi: 'vie',
};
export function ocrLang(code) {
  const base = baseLang(code);
  if (base === 'en') return null;
  if (base === 'zh') {
    let script = '';
    try {
      script = new Intl.Locale(code).maximize().script;
    } catch {
      // (Simplified)
    }
    return script === 'Hant' ? 'chi_tra' : 'chi_sim';
  }
  return TESSERACT[base] || null;
}
