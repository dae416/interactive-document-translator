// Sentences in a block of a book, and which sentences of its translation say what each sentence of
// the original says. Pure: strings in, offsets and pairs out; the reader maps them to the page.
// Languages are BCP-47 codes (langs.js): the original's defaults to English and the translation's
// to Korean, whose own habits a few rules below are for.
import { DEFAULT_LANGS, NO_SPACE, baseLang } from './langs.js';

// Stands in for each character of a note marker: the segmenter skips it (a format character), so
// "…다.¹ 그" still ends a sentence, and every offset stays what it is on the page.
export const MASK = '\u2060';

const segmenters = new Map();
function segment(text, lang) {
  if (!segmenters.has(lang)) segmenters.set(lang, new Intl.Segmenter(lang, { granularity: 'sentence' }));
  return segmenters.get(lang).segment(text);
}

// ponytail: the false breaks of the books at hand (Spurgeon; Matthew Henry, with his outline numbers
// and Scripture references), all in English; elsewhere they seldom match. Another book may need more.
const ABBREV = /(?:^|[\s(\[“"‘'—–-])(?:Mr|Mrs|Dr|St|v|vv|ver|ch|chap|viz|i\.e|e\.g|&c)\.$/;
const INITIAL = /(?:^|[\s(“"‘'])[A-HJ-Z]\.$/; // "C. H. Spurgeon"
const REF = /(?:^|[\s(\[])(?:[ivxlc]+|b)\.$/; // before a number: "Job xxxv. 10", "(b. c. 4004.)"
// What numbers the text after it: "chapter:—I.", "II.", "(1.)", "[2.]".
const MARKER = /(?:^|[:;—–]\s*)(?:[IVXL]+|\d{1,3})\.$|(?:^|\s)[(\[](?:[IVXLivxl]+|\d{1,3}|[a-z])\.?[)\]]$/;
// A speaker's name, as Bunyan opens a paragraph of dialogue ("Chr. I seek…", "By-ends. Sir…"): a
// translation puts it in the speech's own sentence (in Korean, "크리스천: …").
const SPEAKER = /^[A-Z][a-z]+(?:-[a-z]+)*\.$/;
const count = (s, ch) => s.split(ch).length - 1;

// What the text of a book written with LaTeX marks (server/book.js and tex.js draw them): a
// formula, $$…$$ or $…$ (dollars as pandoc reads them: no space just inside, no digit right after,
// no backslash before), bold **…** and italic *…* (not inside a word, so "Doe1*" is no mark).
const MARK = /\$\$[\s\S]+?\$\$|\$(?![\s$])[^$\n]*?[^\s\\$]\$(?!\d)|\*\*|\*(?![\s*])[^*$\n]*?[^\s*\\]\*(?![\p{L}\p{N}*])/gu;
// The same with a bold run whole: no sentence or clause ends inside any of these.
const ATOM = /\$\$[\s\S]+?\$\$|\$(?![\s$])[^$\n]*?[^\s\\$]\$(?!\d)|\*\*[^*\n]+?\*\*|\*(?![\s*])[^*$\n]*?[^\s*\\]\*(?![\p{L}\p{N}*])/gu;

// The marks of `text` in order, { index, text } each; with `whole`, a bold run is one (ATOM). The
// regexes have no lookbehind (Safari before 16.4 can't parse one, and then no module that imports
// this one loads): what stands before a mark is checked here. None comes after a backslash, an
// inline formula after a dollar ("$a$$b$"), an italic after a letter, digit or star; past such a
// one, the search goes on at its next character.
export function* marksOf(text, whole = false) {
  const re = new RegExp(whole ? ATOM : MARK);
  for (let m; (m = re.exec(text)); ) {
    const [a, b] = m[0];
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    if (a === '$' ? /\\$/.test(before) || (b !== '$' && before.endsWith('$')) : b !== '*' && /[\p{L}\p{N}*\\]$/u.test(before)) re.lastIndex = m.index + 1;
    else yield { index: m.index, text: m[0] };
  }
}
const atomsOf = (text) => (/[$*]/.test(text) ? [...marksOf(text, true)].map((m) => [m.index, m.index + m.text.length]) : []);
const within = (atoms, i) => atoms.some(([s, e]) => i > s && i < e);

// What goes on after a quotation in Korean, so that the quotation ends no sentence ("…지내게." 하고
// 말하는). The words are Korean's alone, so the rule needs no language: a chapter written in Korean
// can sit in a book of another.
const AFTER_QUOTE = /^(?:하고|하며|하면서|하자|하는|라고|라며|라는|이라고)/;

// Whether the segmenter's break between `a` (the sentence so far) and `b` (the next piece) is false.
function joins(a, b) {
  return (
    ABBREV.test(a) ||
    INITIAL.test(a) ||
    MARKER.test(a) ||
    count(a, '(') > count(a, ')') ||
    count(a, '[') > count(a, ']') ||
    /^[a-z]/.test(b) || // "Why?" asked he.
    (/^\d/.test(b) && REF.test(a)) ||
    (/^[([]/.test(b) && !MARKER.test(b)) || // a reference after the sentence: "… my Maker?" (Job xxxv. 10).
    (/["”’']$/.test(a) && AFTER_QUOTE.test(b))
  );
}

const blank = (ch) => ch === MASK || /\s/.test(ch);
// A formula whose LaTeX ends with a stop ("$$F = ma.$$"): the sentence ends with it.
const STOPPED = /^\$[\s\S]*[.?!]\s*\$+$/;

// The sentences of `text`, in language `lang`, as [start, end) offsets, without the spaces around
// them.
export function sentences(text, lang = DEFAULT_LANGS.src) {
  const out = [];
  const atoms = atomsOf(text);
  for (const { index, segment: piece } of segment(text, lang)) {
    let start = index;
    let end = index + piece.length;
    // A break inside a formula, bold or italic joins the piece to the sentence before; after a
    // formula that ends with a stop, what follows it is a piece of its own ("…ma.$$ Then we go.").
    // A bold label keeps its sentence: "**목표.** 1장은 바탕이다."
    const stop = out.length ? atoms.find(([s, e]) => index > s && index < e && e < end && STOPPED.test(text.slice(s, e))) : null;
    if (stop) out.at(-1)[1] = start = stop[1];
    while (start < end && blank(text[start])) start++;
    while (end > start && blank(text[end - 1])) end--;
    if (start === end) continue;
    const prev = out.at(-1);
    if (prev && ((!stop && within(atoms, index)) || joins(text.slice(prev[0], prev[1]), text.slice(start, end)))) prev[1] = end;
    else out.push([start, end]);
  }
  // (after the rest: what the name opens may begin with an outline number, "Faith. 1. I say…")
  if (out.length > 1 && SPEAKER.test(text.slice(...out[0]))) out.splice(0, 2, [out[0][0], out[1][1]]);
  return out;
}

// The sentence holding the character at `i`, as an index into `spans`; -1 between sentences.
export const sentenceAt = (spans, i) => spans.findIndex(([s, e]) => i >= s && i < e);

// How long a sentence is, for the alignment: its characters, not counting spaces or note markers.
const weight = (s) => s.replace(/[\s\u2060]/g, '').length;

// Bead shapes (sentences of the original, sentences of the translation) and what each costs over
// 1:1, -log of its odds (after Gale & Church 1993). The chapter translations make two to six
// sentences of a long one far more often than Gale & Church's translators did, so those are cheap.
// ponytail: 1:6 is the longest split seen (Spurgeon, Matthew Henry, into Korean); a longer one is
// paired as 1:6 and its last translated sentences go to the original sentence after it.
const BEADS = [
  [1, 1, 0],
  [1, 2, 1],
  [1, 3, 2],
  [1, 4, 3],
  [1, 5, 4],
  [1, 6, 5],
  [2, 1, 2.3],
  [3, 1, 4.6],
  [2, 2, 4.4],
  [1, 0, 4.5],
  [0, 1, 4.5],
];
// A translated sentence that gives the reason for the one before it, or ends it, seldom begins the
// translation of a sentence of the original, unless that one opens with a reason. By language: in
// Korean "…때문이다.", "…테니까.", "…텐데 말이다."; in English "For…", "If I hit hard, it is because…".
const FOLLOWS = { ko: /(?:때문이다|때문입니다|니까|니까요|거든|거든요|말이다|말입니다)\.?["”’'」』)]*$/ };
const REASON = { en: /^["“‘']?(?:For|Because|Since)\b|^[^;:—]*\bbecause\b/ };
const FOLLOWS_COST = 3;
// The variance of a translation's length per character (Gale & Church's figure).
const S2 = 6.8;

// -log of the chance that sentences of l1 and l2 characters (l2 in characters of the original) are
// each other's translation: a two-sided normal tail.
function cost(l1, l2) {
  if (!l1 && !l2) return 0;
  const z = Math.abs(l1 - l2) / Math.sqrt((S2 * (l1 + l2)) / 2);
  const t = 1 / (1 + 0.2316419 * z);
  const tail = 0.3989423 * Math.exp((-z * z) / 2) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return -Math.log(Math.max(2 * tail, 1e-300));
}

// Pairs the sentences of a block (`src`, strings in language `from`) with those of its translation
// (`tgt`, in `to`), in order, mostly by length. The translation is measured against the original at
// this block's own ratio, so it fits any book and any two languages. Returns beads
// [srcFrom, srcTo, tgtFrom, tgtTo] covering both lists.
export function align(src, tgt, { from = DEFAULT_LANGS.src, to = DEFAULT_LANGS.tgt } = {}) {
  const sum = (list) => list.reduce((n, l) => n + l, 0);
  const ratio = sum(tgt.map(weight)) / sum(src.map(weight)) || 1;
  const follows = FOLLOWS[baseLang(to)];
  const reason = REASON[baseLang(from)];
  const x = [0];
  for (const s of src) x.push(x.at(-1) + weight(s));
  const y = [0];
  for (const s of tgt) y.push(y.at(-1) + weight(s) / ratio);
  const best = x.map(() => y.map(() => Infinity));
  const step = x.map(() => y.map(() => null));
  best[0][0] = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < y.length; j++) {
      for (const [di, dj, penalty] of BEADS) {
        if (i < di || j < dj || best[i - di][j - dj] === Infinity) continue;
        const after = di && dj && follows?.test(tgt[j - dj]) && !reason?.test(src[i - di]) ? FOLLOWS_COST : 0;
        const c = best[i - di][j - dj] + penalty + after + cost(x[i] - x[i - di], y[j] - y[j - dj]);
        if (c < best[i][j]) {
          best[i][j] = c;
          step[i][j] = [di, dj];
        }
      }
    }
  }
  const beads = [];
  for (let i = src.length, j = tgt.length; i || j; ) {
    const [di, dj] = step[i][j];
    beads.unshift([i - di, i, j - dj, j]);
    i -= di;
    j -= dj;
  }
  return beads;
}

// ---- clauses ------------------------------------------------------------------------------------

// A block's clauses in order, each with the index of its sentence: { c: [start, end), s }. The
// server numbers clauses so, and the reader the same (server/clauses.js, taps.js).
export const clauseUnits = (text, spans = sentences(text)) => spans.flatMap((span, s) => clauses(text, span).map((c) => ({ c, s })));

// Without the model's pairing: inside each pair of sentences (align), the clauses of the original and
// those of the translation, cut the same way, paired in order by length. For each of the block's
// clauses, the span of its translation in `tgt`, or null where the pairing can't be trusted and the
// whole sentence must do: where a pair's clause counts differ by more than one, or a clause is left
// without a translation. `from`, `to`: the two languages; units, sentences (ss, ts) and their pairs
// (beads) are worked out unless given.
// ponytail: order and length only, so a clause the translation moves ("Y because X" → "X 때문에 Y")
// pairs wrong; the model's pairing (server/clauses.js) is what corrects that. (By hand, on three
// books into Korean: 1 clause in 20 wrong so, and half left to the sentence; with counts up to twice
// apart, 1 in 8.)
export function pairClauses(src, tgt, { from = DEFAULT_LANGS.src, to = DEFAULT_LANGS.tgt, units, ss, ts, beads } = {}) {
  ss ??= sentences(src, from);
  units ??= clauseUnits(src, ss);
  ts ??= sentences(tgt, to);
  beads ??= align(ss.map((s) => src.slice(...s)), ts.map((s) => tgt.slice(...s)), { from, to });
  const out = units.map(() => null);
  for (const [a, b, c, d] of beads) {
    const mine = units.map((u, k) => k).filter((k) => units[k].s >= a && units[k].s < b);
    const pieces = ts.slice(c, d).flatMap((span) => clauses(tgt, span));
    const trusted = mine.length && pieces.length && (mine.length === 1 || Math.abs(mine.length - pieces.length) <= 1);
    const inner = !trusted ? [] : mine.length === 1 ? [[0, 1, 0, pieces.length]] : align(mine.map((k) => src.slice(...units[k].c)), pieces.map((p) => tgt.slice(...p)), { from, to });
    for (const [ea, eb, kc, kd] of inner) {
      for (let x = ea; x < eb && kd > kc; x++) out[mine[x]] = [pieces[kc][0], pieces[kd - 1][1]];
    }
  }
  return out;
}

// The punctuation a clause ends at: comma, semicolon and colon, also as Chinese and Japanese write
// them; and what closes with it, and so goes with it.
const CUTS = ',;:，、；：';
const CLOSERS = '"”’\')]」』）】》〉—–';
// A reference that goes on after its comma or semicolon: "John i. 3, 10; Eph. iii. 9; 2 Pet. i. 19".
const MORE_REF = /^\s*(?:[1-3]\s?)?[A-Z][a-z]{1,5}\.\s*(?:[ivxlc]+\.|\d)/;
// Words: runs of letters, but a letter of a script written without spaces (Chinese, Japanese) is one.
const WORD = new RegExp(`${NO_SPACE.source}|[^\\P{L}${NO_SPACE.source.slice(1, -1)}]+`, 'gu');
const wordsIn = (s) => (s.match(WORD) || []).length;
// A short piece that belongs to the one before it: a reference ("ver. 3-5;", "Hos. viii. 12."), or
// words that go on from it ("said he,", "and behold,").
const REF_BACK = /^(?:\d|[([]|(?:ver|vv?|ch|chap)\.|[A-Z][a-z]{1,5}\.\s*(?:[ivxlc]+\.|\d))/;
const LEANS_BACK = /^\p{Ll}/u;
// An outline number in brackets ("[1.]") opens what follows; it is no margin note.
const OUTLINE = /^\[(?:\d{1,3}|[ivxlIVXL]+)\.?\]/;

// The clauses of the sentence [start, end) of `text`, as [start, end) offsets. A clause ends after
// a comma, semicolon, colon (CUTS) or dash ("—", "–", "--", or "-" with a space on each side), with the
// quotes and brackets that close there, but not inside brackets or parentheses, between numbers
// ("1,000", "v. 1, 2", "3–5"), or in a list of references; a margin note right after it ("a Den
// [The Goal.]:") stays with it. A piece of fewer than three words joins a neighbour: the one before
// if it leans back on it ("said he,", "ver. 3-5;"), else the next ("Yet,", "therefore,").
// ponytail: the punctuation of the books at hand (Bunyan, Spurgeon, Matthew Henry).
export function clauses(text, [start, end]) {
  const cuts = [];
  const atoms = atomsOf(text);
  let depth = 0;
  for (let i = start; i < end; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '（') depth++;
    else if ((ch === ')' || ch === ']' || ch === '）') && depth > 0) depth--;
    const dash = ch === '—' || ch === '–' || (ch === '-' && (text[i + 1] === '-' || (text[i - 1] === ' ' && text[i + 1] === ' ')));
    if (depth || !(dash || CUTS.includes(ch)) || within(atoms, i)) continue;
    const before = text.slice(start, i).trimEnd();
    const after = text.slice(i + 1, end);
    if (ch !== '—' && /\d$/.test(before) && /^\s?\d/.test(after)) continue;
    if ((ch === ',' || ch === ';') && /(?:\d|\b[ivxlc]+\.)$/.test(before) && MORE_REF.test(after)) continue;
    let j = i + 1;
    while (j < end && (CLOSERS.includes(text[j]) || (ch === '-' && text[j] === '-'))) j++;
    // A margin note just after the cut belongs to the clause before it.
    let k = j;
    while (k < end && /\s/.test(text[k])) k++;
    const close = text[k] === '[' && !OUTLINE.test(text.slice(k, end)) ? text.indexOf(']', k) : -1;
    if (close >= 0 && close < end) {
      j = close + 1;
      while (j < end && (CLOSERS.includes(text[j]) || CUTS.includes(text[j]))) j++;
    }
    if (j < end) cuts.push(j);
    i = j - 1;
  }
  const pieces = [];
  let s = start;
  for (const c of [...cuts, end]) {
    let a = s;
    let b = c;
    // (no clause opens with the " / " that ends a line of verse)
    while (a < b && (blank(text[a]) || text[a] === '/')) a++;
    while (b > a && blank(text[b - 1])) b--;
    if (b > a) pieces.push([a, b]);
    s = c;
  }
  // ponytail: a sentence of over 1,000 pieces (none in a real book) keeps them unjoined, as each
  // join goes over them again.
  if (pieces.length > 1000) return pieces;
  for (let i = pieces.length - 1; pieces.length > 1 && i >= 0; i--) {
    const piece = text.slice(...pieces[i]);
    const n = wordsIn(piece);
    if (n >= 3) continue;
    // (one word, "therefore,", opens what follows)
    const back = i > 0 && (i === pieces.length - 1 || REF_BACK.test(piece) || (n > 1 && LEANS_BACK.test(piece)));
    if (back) pieces.splice(i - 1, 2, [pieces[i - 1][0], pieces[i][1]]);
    else if (i < pieces.length - 1) pieces.splice(i, 2, [pieces[i][0], pieces[i + 1][1]]);
    // (the merged piece may still be short: look at it again)
    i = Math.min(i + 1, pieces.length);
  }
  return pieces;
}
