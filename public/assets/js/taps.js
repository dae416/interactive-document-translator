// A tap on a book's text: on a clause of it (up to a comma or semicolon), or with the setting, on
// a sentence. Where its chapter is translated, the words of the translation that say it: both are
// marked side by side, or the other one is shown in the balloon (reading the original or the
// translation only), at once and without a model. A clause tapped again widens to its sentence, and
// the next tap closes it. Which words of the translation a clause is comes from the chapter's
// pairing on the server (server/clauses.js) once it has come, and until then is worked out here,
// where it can be. The book's two languages are those of langs.js. Elsewhere the model translates
// what was tapped, with the chapter and the paragraph in view, if that is allowed. With either, the
// selection bar shows for the words tapped, as for a selection of them, though none is made. The
// page's text is never rewritten (annotation anchors are offsets into it): the marks are Custom
// Highlights.
import { isTranslation, locate, offsetIn, relocate } from './anchors.js';
import { langs, scriptCounts } from './langs.js';
import { MASK, align, clauseUnits, pairClauses, sentenceAt, sentences } from './sentences.js';
import { tagFormulas } from './tex.js';

// More movement is a drag or a scroll; a longer touch is a long press, which selects. A mouse click
// waits this long for a second one: a double click selects a word.
const MOVE = 10;
const HOLD = 500;
const DOUBLE = 250;
// Not a tap on a sentence: links, buttons, note markers, pictures, a translation's bar and notes,
// a note kept in the text.
const SKIP = 'a, button, input, select, textarea, label, sup, mark, figure, img, svg, math, [role="button"], .ltx_note, .tr-bar, .tr-notes, .gap-note';
// Text that is a marker, not part of a sentence.
const MARKS = 'sup, .ltx_note';
const PAIR = 'tap-pair';
// A chapter's pairing is asked for again after this long where it lacks a translated block (a
// part done since) or the asking failed.
const AGAIN = 30_000;

// Marks `ranges` as the Custom Highlight `name`; none clears it. (Formulas take it as data-hl.)
export function paint(name, ranges) {
  if (typeof document !== 'undefined' && document.querySelectorAll) tagFormulas(document, name, ranges || []);
  if (typeof Highlight !== 'function' || !window.CSS?.highlights) return;
  if (ranges?.length) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}

const blank = (ch) => ch === undefined || ch === MASK || /\s/.test(ch);
const clean = (s) => s.replaceAll(MASK, '').replace(/\s+/g, ' ').trim();
// Words in the reader's language: of the letters outside formulas, more in its script than in the
// book's (Hangul against Latin, for Korean and English); never where the two share a script.
const inTarget = (s) => {
  const [tgt, src] = scriptCounts(s, langs.tgt, langs.src) || [0, 0];
  return tgt > src;
};

// A block's text as the segmenter should see it: note markers blanked out, every offset as it was.
function maskedText(el) {
  let text = el.textContent;
  for (const m of el.querySelectorAll(MARKS)) {
    const at = offsetIn(el, m, 0);
    const n = m.textContent.length;
    text = text.slice(0, at) + MASK.repeat(n) + text.slice(at + n);
  }
  return text;
}

// The character of `el` under (x, y), as an offset into its text; -1 if there is none.
function charAt(el, text, x, y) {
  const p = document.caretPositionFromPoint?.(x, y);
  const r = p ? null : document.caretRangeFromPoint?.(x, y);
  const node = p ? p.offsetNode : r?.startContainer;
  if (!node || !el.contains(node)) return -1;
  const o = offsetIn(el, node, p ? p.offset : r.startOffset);
  // The caret is between two characters: the one after it, unless that is a space.
  if (!blank(text[o])) return o;
  return blank(text[o - 1]) ? -1 : o - 1;
}

function rangeIn(el, [start, end]) {
  const s = locate(el, start);
  const e = locate(el, end);
  const range = document.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

// Whether (x, y) is on the range's text, give or take the gap between lines (not in the blank
// after a paragraph's last line).
const onText = (range, x, y) => [...range.getClientRects()].some((r) => x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 6 && y <= r.bottom + 6);

// Sentences [from, to) of `spans` as one span of the text, in a list; none for none.
const across = (spans, from, to) => (to > from ? [[spans[from][0], spans[to - 1][1]]] : []);
// Spans in order, those that overlap or touch as one.
function merge(spans) {
  const out = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (out.length && s <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], e);
    else out.push([s, e]);
  }
  return out;
}
const within = (o) => ([s, e]) => o >= s && o < e;

export class SentenceTaps {
  // root: the book's article. describe(range): what a selection of that text of the book is (the
  // reader's describe). show(info): opens the balloon. current(): what it shows, or null.
  // on(): taps do this at all. ai(): the model translates where there is no translation.
  // unit(): 'clause' or 'sentence'. clausesOf(chapter): the server's pairing of its clauses.
  // menu(info): the selection bar for the words tapped (info.range), null when it should go.
  // onSettle(chapter): a chapter's pairing has come from the server (or failed to).
  // original(block): shows the part of the original a block translated from a scan stands for.
  constructor({ root, describe, show, current, on, ai, unit, clausesOf, menu, onSettle, original }) {
    Object.assign(this, { root, describe, show, current, on, ai, unit, clausesOf, menu, onSettle, original });
    this.texts = new WeakMap(); // block -> { text, spans, units }
    this.beads = new WeakMap(); // a block's translation -> its sentences paired with the original's
    this.own = new WeakMap(); // a block's translation -> its clauses paired here
    this.fetched = new Map(); // chapter -> { data, at, busy }: its pairing from the server
    this.ac = new AbortController();
    const signal = this.ac.signal;
    root.addEventListener('pointerdown', (e) => this.down(e), { signal });
    root.addEventListener('pointercancel', () => (this.press = null), { signal });
    root.addEventListener('click', (e) => this.click(e), { signal });
    root.addEventListener('dblclick', () => clearTimeout(this.timer), { signal });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.unpair(), { signal });
  }

  down(e) {
    const sel = document.getSelection();
    // What this tap may be closing or widening (the balloon, or the marks side by side).
    this.press = { x: e.clientX, y: e.clientY, at: Date.now(), mouse: e.pointerType === 'mouse', selected: !!sel && !sel.isCollapsed, balloon: this.current()?.tap, pair: this.pairKey };
  }

  // Only a plain tap: no selection before or after it, no drag, scroll or long press, no double
  // click.
  click(e) {
    const p = this.press;
    this.press = null;
    clearTimeout(this.timer);
    if (!p || !this.on() || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const selected = () => {
      const sel = document.getSelection();
      return !!sel && !sel.isCollapsed;
    };
    if (p.selected || selected()) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE || (!p.mouse && Date.now() - p.at > HOLD)) return;
    const el = e.target.closest?.(SKIP) ? null : e.target.closest?.('[data-b], .tr-block');
    const go = () => this.tap(el, e.clientX, e.clientY, p);
    if (!p.mouse) go();
    else if (e.detail <= 1) this.timer = setTimeout(() => selected() || go(), DOUBLE);
  }

  // p: the press, with what was showing when it began.
  tap(el, x, y, p) {
    this.unpair();
    const hit = el && this.find(el, x, y);
    if (!hit) return;
    const { src, tgt, isTgt, sentence } = hit;
    const section = src.closest('section');
    const mode = section?.classList.contains('bilingual') ? 'both' : section?.classList.contains('tgt-only') ? 'tgt' : 'src';
    // The same again: a clause widens to its sentence; a sentence closes.
    const was = mode === 'both' ? p.pair || p.balloon : p.balloon;
    if (was === sentence.key) return;
    const pick = was === hit.clause.key ? sentence : hit.clause;
    const srcRanges = pick.src.map((s) => rangeIn(src, s));
    const tgtRanges = pick.tgt.map((s) => rangeIn(tgt, s));
    // The menu acts on the side tapped: the original, or the translation across its pieces. It is
    // shown before the balloon, which keeps clear of it, and has the highlight colors the balloon
    // has not.
    const words = isTgt ? pick.tgt : pick.src;
    const range = words.length ? rangeIn(isTgt ? tgt : src, [words[0][0], words.at(-1)[1]]) : null;
    const menu = () => {
      const got = this.menu && range && this.describe(range);
      if (got) this.menu({ ...got, range });
    };
    if (mode === 'both' && tgtRanges.length) {
      // Side by side: the two are marked, and the menu shows.
      this.pairKey = pick.key;
      paint(PAIR, [...srcRanges, ...tgtRanges]);
      menu();
      return;
    }
    const info = srcRanges.length && this.describe(srcRanges[0]);
    if (!tgtRanges.length && sentence.src[0] && inTarget(this.read(src, langs.src).text.slice(...sentence.src[0]))) {
      // The book's own text is in the reader's language (a chapter written so, or translated from a
      // scan): nothing for the model to translate. A block of a scan's translation shows its
      // original (which would cover the bar at the foot of a phone's screen); another, the bar.
      if (src.dataset.orig && this.original) this.original(src);
      else menu();
      return;
    }
    if (!tgtRanges.length) {
      // No translation of it: the model's, if allowed (a clause with its sentence in view).
      const whole = pick !== sentence && clean(this.read(src, langs.src).text.slice(...sentence.src[0]));
      if (!info || !this.ai()) return;
      menu();
      this.show({ ...info, anchor: null, tap: pick.key, ranges: srcRanges, mode: 'sentence', ...(whole && { sentence: whole }) });
      return;
    }
    if (!info) return;
    const text = this.read(tgt, langs.tgt).text;
    const pair = { src: info.text, tgt: pick.tgt.map((s) => clean(text.slice(...s))).join(' … ') };
    menu();
    // Read in the translation only, the original is hidden: the balloon goes by the translation.
    if (isTgt) this.show({ ...info, anchor: null, tap: pick.key, rect: tgtRanges[0].getBoundingClientRect(), ranges: tgtRanges, pair, shown: 'src' });
    else this.show({ ...info, anchor: null, tap: pick.key, ranges: srcRanges, pair, shown: 'tgt' });
  }

  // What is under (x, y) in a block or its translation: { src, tgt, isTgt, sentence, clause }, the
  // last two { key, src, tgt }, the spans to mark in the original and in the translation (none where
  // there is no translation). The clause is the sentence where it can't be paired on its own.
  find(el, x, y) {
    const isTgt = el.classList.contains('tr-block');
    const src = isTgt ? el.previousElementSibling : el;
    if (!src?.hasAttribute('data-b')) return null;
    const tgt = src.nextElementSibling?.classList.contains('tr-block') ? src.nextElementSibling : null;
    const side = this.read(el, isTgt ? langs.tgt : langs.src);
    const o = charAt(el, side.text, x, y);
    const k = sentenceAt(side.spans, o);
    if (k < 0 || !onText(rangeIn(el, side.spans[k]), x, y)) return null;
    let sentence = { key: `${src.dataset.b}:${k}`, src: [side.spans[k]], tgt: [] };
    if (tgt) {
      const beads = this.pairs(src, tgt);
      const n = beads.findIndex(([a, b, c, d]) => (isTgt ? k >= c && k < d : k >= a && k < b));
      const [a, b, c, d] = beads[n];
      sentence = { key: `${src.dataset.b}#${n}`, src: across(this.read(src, langs.src).spans, a, b), tgt: across(this.read(tgt, langs.tgt).spans, c, d) };
    }
    // (by sentence, the clauses are not worked out, nor asked of the server)
    const clause = this.unit?.() !== 'sentence' && this.clause(src, tgt, isTgt, o, sentence);
    return { src, tgt, isTgt, sentence, clause: clause || sentence };
  }

  // The clause under offset o of the tapped side, and its translation or (tapped in the
  // translation) the clauses it translates: { key, src, tgt }. Null where the sentence must do: no
  // pairing for it, or it is the whole sentence.
  clause(src, tgt, isTgt, o, sentence) {
    const units = this.units(src);
    const paired = tgt && this.paired(src, tgt);
    const us = isTgt ? units.flatMap((u, k) => (paired[k].some(within(o)) ? [k] : [])) : units.flatMap((u, k) => (within(o)(u.c) && (!tgt || paired[k].length) ? [k] : []));
    // (words of the translation that clauses apart from each other share: its sentence)
    if (!us.length || us.some((k, j) => j && k !== us[j - 1] + 1)) return null;
    const span = [units[us[0]].c[0], units[us.at(-1)].c[1]];
    const [whole] = sentence.src;
    if (whole && span[0] === whole[0] && span[1] === whole[1]) return null;
    return { key: `${src.dataset.b}~${us.join(',')}`, src: [span], tgt: tgt ? merge(us.flatMap((k) => paired[k])) : [] };
  }

  read(el, lang) {
    if (!this.texts.has(el)) {
      const text = maskedText(el);
      this.texts.set(el, { text, spans: sentences(text, lang) });
    }
    return this.texts.get(el);
  }

  // A block's clauses, as the server numbers them (sentences.js).
  units(src) {
    const e = this.read(src, langs.src);
    e.units ??= clauseUnits(e.text, e.spans);
    return e.units;
  }

  // Worked out on a block's first tap, then kept. A reloaded translation is a new element: its own.
  pairs(src, tgt) {
    if (!this.beads.has(tgt)) {
      const e = this.read(src, langs.src);
      const k = this.read(tgt, langs.tgt);
      this.beads.set(tgt, align(e.spans.map((s) => e.text.slice(...s)), k.spans.map((s) => k.text.slice(...s)), { from: langs.src, to: langs.tgt }));
    }
    return this.beads.get(tgt);
  }

  // Each clause's words in the block's translation, [[start, end], ...] (none: only its sentence
  // pairs it): the chapter's pairing from the server where it has this block as it is now, else
  // worked out here (pairClauses). ask: the server may be asked for it (else only what has come).
  paired(src, tgt, ask = true) {
    const b = src.dataset.b;
    const at = b.lastIndexOf('.');
    const units = this.units(src);
    const e = this.read(src, langs.src);
    const k = this.read(tgt, langs.tgt);
    const fits = (data) => {
      const got = data?.blocks?.[b.slice(at + 1)];
      return got && got.n === k.text.length && got.clauses?.length === units.length ? got : null;
    };
    const chapter = b.slice(0, at);
    const got = fits(ask ? this.pairing(chapter, fits) : this.fetched.get(chapter)?.data);
    if (got) return got.clauses;
    if (!this.own.has(tgt)) this.own.set(tgt, pairClauses(e.text, k.text, { from: langs.src, to: langs.tgt, units, ss: e.spans, ts: k.spans, beads: this.pairs(src, tgt) }).map((s) => (s ? [s] : [])));
    return this.own.get(tgt);
  }

  // The chapter's pairing from the server, once it has come (null until then). Asked for on the
  // chapter's first tap, and again a while after where what came doesn't fit (a block missing, or
  // from before its translation changed) or the asking failed.
  pairing(chapter, fits) {
    let got = this.fetched.get(chapter);
    if (!got || (!got.busy && Date.now() - got.at > AGAIN && !fits(got.data))) {
      const mine = { data: got?.data || null, at: Date.now(), busy: true };
      this.fetched.set(chapter, (got = mine));
      Promise.resolve(this.clausesOf?.(chapter))
        .then((data) => data?.blocks && (mine.data = data))
        .catch(() => {})
        .finally(() => {
          Object.assign(mine, { busy: false, at: Date.now() });
          this.onSettle?.(chapter);
        });
    }
    return got.data;
  }

  // Whether a chapter's pairing is as it will be: come from the server (or failed to), or not to
  // be asked for at all (taps off, or by sentence).
  settled(chapter) {
    if (!this.on() || this.unit?.() === 'sentence') return true;
    const got = this.fetched.get(chapter);
    return !!got && !got.busy;
  }

  // A translated chapter's pairing, asked for as soon as its translation is shown (not by sentence).
  prefetch(chapter) {
    if (this.on() && this.unit?.() !== 'sentence') this.pairing(chapter, () => false);
  }

  // A mark's other side (reader.js pairs highlights and underlines with it): in each block it
  // covers whose translation is in the page, the other language's words for its own, one piece per
  // stretch, as an annotation has them: [{ start, end, quote }]. ask: as for paired().
  counterpart(anchor, ask = true) {
    const onTgt = isTranslation(anchor.start.b);
    const srcOf = (b) => (onTgt ? b.slice(0, -1) : b);
    let src = this.root.ownerDocument.getElementById(srcOf(anchor.start.b));
    // (a mark on the translation goes by where its quote is now: translating again can move it)
    if (onTgt && src && anchor.start.b === anchor.end.b) {
      const tb = src.nextElementSibling;
      anchor = tb?.classList.contains('tr-block') ? relocate(anchor, new Map([[anchor.start.b, tb]])) : null;
      if (!anchor) return [];
    }
    const [first, last] = [srcOf(anchor.start.b), srcOf(anchor.end.b)];
    const at = (b) => Number(b.slice(b.lastIndexOf('.') + 1));
    const chapter = first.slice(0, first.lastIndexOf('.'));
    const out = [];
    // (block by block by index: not by siblings, which end at a run of text of a journal article
    // in columns, columns.js)
    for (let i = at(first); i <= at(last); i++) {
      src = this.root.ownerDocument.getElementById(`${chapter}.${i}`);
      const id = src && this.root.contains(src) ? src.dataset?.b : null;
      if (!id) continue;
      const tb = src.nextElementSibling;
      if (tb?.classList.contains('tr-block')) {
        const from = onTgt ? tb : src;
        const s = id === first ? anchor.start.o : 0;
        const e = id === last ? anchor.end.o : from.textContent.length;
        const into = onTgt ? src : tb;
        const b = onTgt ? id : tb.dataset.k;
        const text = into.textContent;
        // (clauses next to each other, only a space or a comma apart, are one stretch)
        const pieces = [];
        for (const [ps, pe] of merge(this.otherSide(src, tb, onTgt, s, e, ask))) {
          if (pieces.length && !/[\p{L}\p{N}]/u.test(text.slice(pieces.at(-1)[1], ps))) pieces.at(-1)[1] = pe;
          else if (pe > ps) pieces.push([ps, pe]);
        }
        for (const [ps, pe] of pieces) out.push({ start: { b, o: ps }, end: { b, o: pe }, quote: text.slice(ps, pe) });
      }
    }
    return out;
  }

  // Characters [s, e) of a block's original (or of its translation, fromTgt) on the other side: the
  // clauses they touch, or the sentences where one of those clauses has no translation of its own.
  otherSide(src, tb, fromTgt, s, e, ask = true) {
    const touches = ([a, b]) => a < e && s < b;
    const units = this.units(src);
    const paired = this.paired(src, tb, ask);
    const hit = units.flatMap((u, k) => ((fromTgt ? paired[k].some(touches) : touches(u.c)) ? [k] : []));
    if (hit.length && hit.every((k) => paired[k].length)) return fromTgt ? hit.map((k) => units[k].c) : hit.flatMap((k) => paired[k]);
    const ss = this.read(src, langs.src).spans;
    const ts = this.read(tb, langs.tgt).spans;
    const mine = (fromTgt ? ts : ss).flatMap((span, k) => (touches(span) ? [k] : []));
    const beads = this.pairs(src, tb).filter(([a, b, c, d]) => mine.some((k) => (fromTgt ? k >= c && k < d : k >= a && k < b)));
    return beads.flatMap(([a, b, c, d]) => (fromTgt ? across(ss, a, b) : across(ts, c, d)));
  }

  // The marks side by side and the menu go.
  unpair() {
    this.menu?.(null);
    if (!this.pairKey) return;
    this.pairKey = null;
    paint(PAIR);
  }

  destroy() {
    clearTimeout(this.timer);
    this.ac.abort();
    this.unpair();
  }
}
