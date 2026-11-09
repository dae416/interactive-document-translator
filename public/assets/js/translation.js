// Chapter translations in a book: a bar under each chapter title (translate, with what it should
// cost and take; progress, with the time left and the cost so far, and Stop; resume; retry; the
// original, both side by side, or the translation: EN, KO+EN or KO for an English book read in
// Korean), a mark on each chapter's tab, the translation after each block, and footnotes that open
// in a small popup beside their marker. The translation comes from a model, so it only ever becomes
// text. The book's two languages are those of langs.js.
import { api } from './api.js';
import { blockOf, locate, rangeToAnchor } from './anchors.js';
import { langLabel, langName, langs, scriptCounts } from './langs.js';
import { marksOf } from './sentences.js';
import { richNodes } from './tex.js';
import { confirmDialog, h, iconEl, local, toast } from './ui.js';
import { getLang, t } from './i18n.js';

const POLL_MS = 5000;
// Between polls the bar of a unit on its way moves on its own, once a second (liveProgress).
const TICK_MS = 1000;
const BUSY = ['queued', 'working'];
// ponytail: flat rates for Opus at max effort plus the review, only for the estimates (measured
// 2026-10-24: $0.55-0.58 and 3.7-4 minutes per 1,000 characters; the cost errs high).
export const USD_PER_1K_CHARS = 0.65;
const MIN_PER_1K_CHARS = 4;
const MS_PER_CHAR = (MIN_PER_1K_CHARS * 60_000) / 1000;
// ponytail: of a segment's share of the progress, its translation takes the first 60% and its
// review the rest (a guess at their times).
const PHASES = { translate: { from: 0, share: 0.6, label: 'tr.translating' }, review: { from: 0.6, share: 0.4, label: 'tr.reviewing' } };
const PARTS = '.tr-block, .tr-bar, .tr-notes, .fn-pop';
// A chapter's blocks, and their translations: children of its section, or of the runs of text a
// journal article in two columns puts them in (columns.js).
const BLOCKS = ':scope > [data-b], :scope > .col-run > [data-b]';
const blockAt = (b) => `:scope > [data-b="${b}"], :scope > .col-run > [data-b="${b}"]`;
const TRANSLATED = ':scope > .tr-block, :scope > .col-run > .tr-block, :scope > .tr-notes';

// Whether a chapter's own text is in the reader's language already: of its letters outside formulas,
// a third or more in the target language's script (Hangul against Latin, for Korean and English). A
// pair of languages written alike can't be told apart so: no.
export function writtenInTarget(section) {
  const text = [...section.querySelectorAll(BLOCKS)].map((el) => el.textContent.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, ' ')).join(' ');
  const [tgt, src] = scriptCounts(text, langs.tgt, langs.src) || [0, 0];
  return tgt > 0 && tgt * 3 >= tgt + src;
}
// How a book's translated chapters read: the original only, side by side, or the translation only.
export const MODES = ['src', 'both', 'tgt'];

// The mode a book opens in: the one chosen for it, else its old side-by-side switch (on: both,
// off: the original), else both.
// (a book brought in with its own translation, meta.read 'tgt', opens in it)
export const pickMode = (saved, side, read) => (MODES.includes(saved) ? saved : MODES.includes(read) ? read : side === false ? 'src' : 'both');

// A mode's label in the view switch: in English the languages' codes (EN, KO+EN, KO for an English
// book read in Korean), in Chinese their names.
export const modeLabel = (mode, pair = langs) => {
  const ui = getLang();
  return t(`tr.${mode}`, { src: langLabel(pair.src), tgt: langLabel(pair.tgt), srcName: langName(pair.src, ui), tgtName: langName(pair.tgt, ui) });
};

// What translating `chars` characters of a chapter should cost (dollars) and take (minutes).
export const estimate = (chars) => ({
  cost: ((chars / 1000) * USD_PER_1K_CHARS).toFixed(2),
  min: Math.max(5, Math.round((chars / 1000) * MIN_PER_1K_CHARS)),
});

// The progress to show of a unit on its way at `now`, between the polls that bring what is saved
// (`progress`): as much more of the segment on its way (`segment.to`: the progress once it is
// saved) as the time since its phase began says, at the pace of the segments done (`pace`, ms per
// character of the unit's `chars`; before one is, the estimate's). Each phase stops at 90% of its
// share, so the bar never runs past the segment, nor back when the review starts or the segment is
// saved.
export function liveProgress({ progress = 0, segment, phase, phaseAt, pace, chars, now = Date.now() }) {
  const span = (segment?.to ?? 0) - progress;
  const at = PHASES[phase];
  if (!at || !(span > 0)) return progress;
  const t = Math.min(0.9, Math.max(0, now - Date.parse(phaseAt)) / (at.share * span * chars * (pace || MS_PER_CHAR)) || 0);
  return progress + span * (at.from + at.share * t);
}

// Minutes left of a unit on its way, at the same pace: the rest of its `chars` characters after
// `shown`; never below 1.
export const minutesLeft = ({ shown = 0, chars, pace }) => Math.max(1, Math.round(((1 - shown) * chars * (pace || MS_PER_CHAR)) / 60_000));
const percent = (share) => Math.floor(share * 100 + 1e-9);

// Whether a node is in a translation, its bar or notes, or a note popup: not the book's text.
export function inTranslation(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return !!el?.closest(PARTS);
}

// What a selection in a book's text anchors to. It keeps to the column it started in (where the
// selecting began: the book, or the translation beside it, which side by side alternates with it in
// the page; begun in neither, as on a chapter title, where it ended) and stops at that column's last
// block. One in the translation also brings the original of the blocks it covers, `source`. Null
// for the translation's bar and notes; an anchor of null for text in no block (a chapter title).
export function bookSelection(sel, article) {
  const range = sel.getRangeAt(0);
  const from = [sel.anchorNode, sel.focusNode].find((n) => n && (blockOf(n, 'data-k') || blockOf(n))) || range.startContainer;
  if (blockOf(from, 'data-k')) {
    const anchor = rangeToAnchor(range, article, 'data-k');
    if (!anchor) return null;
    // (the original's blocks by index: not by siblings, which end at a run of text of a journal
    // article in columns, columns.js)
    const orig = (k) => k.slice(0, -1);
    const at = (k) => Number(orig(k).slice(orig(k).lastIndexOf('.') + 1));
    const chapter = orig(anchor.start.b).slice(0, orig(anchor.start.b).lastIndexOf('.'));
    const source = [];
    for (let i = at(anchor.start.b); i <= at(anchor.end.b); i++) {
      const el = article.querySelector(`[data-b="${chapter}.${i}"]`);
      if (el) source.push(el.textContent);
    }
    return { anchor, source: source.join('\n\n') };
  }
  if (inTranslation(from)) return null;
  const anchor = rangeToAnchor(range, article);
  if (!anchor && inTranslation(range.endContainer)) return null;
  return { anchor };
}

// A translated block as nodes: its text, with a marker for each [^n] that has a note n. Other
// markers stay as they are written. A marker's number is drawn by CSS (data-n), so the text of the
// translation, which marks on it count in, is the translation alone and keeps when notes are
// renumbered. In a book written with LaTeX (rich) its formulas, bold and italic are drawn as in the
// original (tex.js), and the translation of a table, its rows on lines and cells between " | ", is a
// table.
export function translatedNodes(text, notes, { rich = false, table = false } = {}) {
  const s = String(text ?? '');
  if (rich && table) return [translatedTable(s, notes)];
  const piece = (x) => (rich ? richNodes(x) : [document.createTextNode(x)]);
  const count = Array.isArray(notes) ? notes.length : 0;
  const out = [];
  let at = 0;
  for (const m of s.matchAll(/\[\^(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > count) continue;
    if (m.index > at) out.push(...piece(s.slice(at, m.index)));
    // Two at one place read 4,5 rather than 45 (as in the original, markSource).
    else if (out.at(-1)?.classList?.contains('fn')) out.at(-1).classList.add('fn-then');
    const sup = document.createElement('sup');
    sup.className = 'fn';
    sup.setAttribute('role', 'button');
    sup.setAttribute('tabindex', '0');
    sup.setAttribute('aria-label', t('tr.note', { n }));
    sup.dataset.n = String(n);
    out.push(sup);
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push(...piece(s.slice(at)));
  return out;
}

// As server/book.js draws a table of the book: the separators stay, hidden, so its text is `s` (less
// its notes' markers, which are buttons in its cells as in a paragraph). A row ends at "\n" and a
// cell at " | ", but not inside a formula ("$P(A | B)$").
function translatedTable(s, notes) {
  const marks = [...marksOf(s)];
  const rows = [[]];
  let at = 0;
  for (const m of s.matchAll(/\n| \| /g)) {
    if (marks.some((k) => m.index > k.index && m.index < k.index + k.text.length)) continue;
    rows.at(-1).push(s.slice(at, m.index));
    if (m[0] === '\n') rows.push([]);
    at = m.index + m[0].length;
  }
  rows.at(-1).push(s.slice(at));
  const table = document.createElement('table');
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    table.append(tr);
    row.forEach((cell, j) => {
      const td = document.createElement(i ? 'td' : 'th');
      if (j || i) td.append(h('span', { class: 'mk', text: j ? ' | ' : '\n' }));
      td.append(...translatedNodes(cell, notes, { rich: true }));
      tr.append(td);
    });
  });
  return table;
}

// A note's marker in the original, after character `at` of a block: an element with no text of its
// own (CSS draws the number), so offsets into the text, sentences and selections stay as they were.
// Never inside a formula or a hidden mark, where it would not show: before or after it.
export function markSource(block, at, n) {
  const { node, offset } = locate(block, at);
  const mark = h('sup', { class: 'fn-src', role: 'button', tabindex: '0', 'data-n': String(n), 'aria-label': t('tr.note', { n }) });
  const hidden = (node.nodeType === 3 ? node.parentElement : node)?.closest('k-tex, .mk');
  if (hidden && block.contains(hidden)) {
    if (offset) hidden.after(mark);
    else hidden.before(mark);
  } else if (node.nodeType !== 3) node.append(mark);
  else node.parentNode.insertBefore(mark, offset < node.nodeValue.length ? node.splitText(offset) : node.nextSibling);
  // Two at one place read 4,5 rather than 45.
  if (mark.nextSibling?.classList?.contains('fn-src')) mark.classList.add('fn-then');
  return mark;
}

const button = (label, onClick, name) =>
  h('button', { class: 'btn btn-sm btn-secondary', type: 'button', onClick }, name ? iconEl(name, 16) : null, h('span', { text: label }));

export class BookTranslations {
  // view: the open HtmlView of the book. onShift(): the text is about to move to keep the reading
  // place, so the scroll that follows is not the reader's. onShow(): a chapter's translation is now
  // in the page (marks on it can be painted). onMode(mode): a view was chosen (MODES). onLoad(id):
  // chapter id's translation has come (again, as a part is done).
  constructor({ paper, view, onShift, onShow, onMode, onLoad }) {
    Object.assign(this, { paper, view, onShift, onShow, onMode, onLoad });
    this.modeKey = `trView:${paper.id}`;
    this.mode = pickMode(local.get(this.modeKey), local.get(`trSide:${paper.id}`), paper.read);
    this.chapters = new Map();
    // A bar showing a unit on its way: its status and the painter of its label (fillBar).
    this.bars = new WeakMap();
    // What moves between polls, by "chapter/part" (part 0: a whole chapter; "chapter/mark": its tab).
    this.live = new Map();
    this.ac = new AbortController();
    for (const section of view.article.querySelectorAll('section[data-chapter]')) {
      const title = section.querySelector(':scope > h2');
      // (a chapter written in the reader's language, or translated from a scan, has nothing to
      // translate: no bar)
      if (!title || writtenInTarget(section)) continue;
      // A tap on the bar is not a tap on the text, which shows or hides the toolbar. (Here, not
      // in onClick: a button may already be replaced when the click gets that far.)
      const bar = h('div', { class: 'tr-bar', onClick: (e) => e.stopPropagation() });
      title.after(bar);
      const chars = [...section.querySelectorAll(BLOCKS)].reduce((n, el) => n + el.textContent.length, 0);
      this.chapters.set(section.dataset.chapter, { section, bar, tr: null, chars });
      section.addEventListener('click', (e) => this.onClick(e), { signal: this.ac.signal });
      section.addEventListener('keydown', (e) => this.onKey(e), { signal: this.ac.signal });
    }
    this.update(paper.book?.translations || {});
  }

  // statuses: paper.book.translations, { [chapter]: { status, progress, error, … } }, or for a
  // chapter in parts { ranges: [[from, to], …], parts: [that state of each part] }.
  update(statuses) {
    this.statuses = statuses;
    if (this.paper.book) this.paper.book.translations = statuses;
    for (const [id, c] of this.chapters) {
      this.placeParts(id);
      const states = this.statesOf(id);
      // A new job: a translation that couldn't be loaded before is worth another try.
      if (states.some((s) => BUSY.includes(s?.status))) c.missing = c.loadError = null;
      const ready = states.filter((s) => s?.status === 'ready').length;
      if (ready && ready !== c.loaded && !c.loading && !c.missing && !c.loadError) this.load(id);
      this.renderBar(id);
    }
    this.schedule();
  }

  // The state of a chapter, or of each of its parts.
  statesOf(id) {
    const st = this.statuses[id];
    return st?.ranges ? st.ranges.map((_, i) => st.parts?.[i]) : [st];
  }

  // A chapter in parts has a bar at each part's first block: before it, so a translated block still
  // has its translation right after it.
  placeParts(id) {
    const c = this.chapters.get(id);
    const ranges = this.statuses[id]?.ranges || null;
    if (JSON.stringify(ranges) === JSON.stringify(c.parts?.map((p) => [p.from, p.to]) ?? null)) return;
    for (const p of c.parts || []) p.bar.remove();
    const blocks = [...c.section.querySelectorAll(BLOCKS)];
    c.parts = ranges?.map(([from, to]) => {
      const bar = h('div', { class: 'tr-bar tr-part', onClick: (e) => e.stopPropagation() });
      blocks[from]?.before(bar);
      return { bar, from, to, chars: blocks.slice(from, to).reduce((n, el) => n + el.textContent.length, 0) };
    });
  }

  // Polls while a chapter or a part is queued or working, and moves its bar on between polls.
  schedule() {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    const busy = !this.destroyed && Object.keys(this.statuses).some((id) => this.statesOf(id).some((s) => BUSY.includes(s?.status)));
    this.timer = busy ? setTimeout(() => this.poll(), POLL_MS) : 0;
    this.ticker = busy ? setInterval(() => this.live.forEach((paint) => paint()), TICK_MS) : 0;
  }

  async poll() {
    try {
      const { paper } = await api.getPaper(this.paper.id);
      if (!this.destroyed) this.update(paper.book?.translations || {});
    } catch {
      // offline for a moment: ask again later
      this.schedule();
    }
  }

  // Once for each part that is ready (a whole chapter is one): asked again while on its way (a
  // second Retry) or after, it does nothing.
  async load(id) {
    const c = this.chapters.get(id);
    const ready = this.statesOf(id).filter((s) => s?.status === 'ready').length;
    if (c.loading || (c.tr && c.loaded === ready)) return;
    c.loading = true;
    try {
      const { translation } = await api.getTranslation(this.paper.id, id);
      if (this.destroyed) return;
      c.tr = translation;
      c.loaded = ready;
      c.loadError = null;
      this.keepPlace(() => this.show(c));
      this.loadNotesSrc(id);
      this.onLoad?.(id);
    } catch (err) {
      if (err.status === 404) c.missing = true;
      else c.loadError = err.message;
    } finally {
      c.loading = false;
    }
    if (!this.destroyed) this.renderBar(id);
  }

  // The same notes on the original, where the server says each belongs (worked out once a chapter,
  // and once more for each part as it is done). Without them the translation keeps its markers.
  // Those of an earlier load go first: a part done since numbers the notes after it on.
  async loadNotesSrc(id) {
    const c = this.chapters.get(id);
    const seq = (c.notesSeq = (c.notesSeq || 0) + 1);
    c.section.querySelectorAll(BLOCKS).forEach((el) => el.querySelectorAll('.fn-src').forEach((m) => m.remove()));
    if (!c.tr.notes?.length) return;
    let notes;
    try {
      ({ notes } = await api.getNotesSrc(this.paper.id, id));
    } catch {
      return;
    }
    if (this.destroyed || seq !== c.notesSeq) return;
    // Back to front, so that markers at one place end up in order.
    const marks = Object.entries(notes || {}).map(([n, p]) => ({ ...p, n: Number(n) })).sort((x, y) => y.b - x.b || y.at - x.at || y.n - x.n);
    for (const { n, b, at } of marks) {
      const el = c.section.querySelector(blockAt(`${id}.${b}`));
      if (el && c.tr.notes[n - 1] != null) markSource(el, at, n);
    }
  }

  // The translation after each block (matched by the block's index), and the notes at the end;
  // again as more parts are done. Its id (data-k) is the block's with a "k", for the anchors of
  // marks on it (anchors.js).
  show(c) {
    this.closeNote();
    c.section.querySelectorAll(TRANSLATED).forEach((el) => el.remove());
    const notes = Array.isArray(c.tr.notes) ? c.tr.notes : [];
    // (a book written with LaTeX: its original has formulas or hidden marks)
    const rich = !!c.section.closest('article')?.querySelector('k-tex, .mk');
    for (const el of c.section.querySelectorAll(BLOCKS)) {
      const b = el.dataset.b;
      const text = c.tr.blocks?.[Number(b.slice(b.lastIndexOf('.') + 1))];
      // Read in the translation only, a block is hidden only where it is translated (as nothing,
      // too: noise); a part not done yet stays in the original.
      el.classList.toggle('tr-done', typeof text === 'string');
      if (typeof text !== 'string' || !text.trim()) continue;
      const table = rich && el.classList.contains('tbl');
      const kind = el.localName === 'h3' ? 'tr-block tr-h' : table ? 'tr-block tbl' : 'tr-block';
      el.after(h('div', { class: kind, lang: langs.tgt, 'data-k': `${b}k` }, translatedNodes(text, notes, { rich, table })));
    }
    if (notes.length) c.section.append(h('ol', { class: 'tr-notes', lang: langs.tgt }, notes.map((n) => h('li', { text: String(n) }))));
    this.applyMode(c);
    this.onShow?.();
  }

  // src: the original only. both: side by side. tgt: the translation in place of the original.
  applyMode(c) {
    c.section.classList.toggle('bilingual', this.mode === 'both');
    c.section.classList.toggle('tgt-only', this.mode === 'tgt');
  }

  // Changes the layout without moving the text being read: deep in a long paragraph whose height
  // changes (half a row side by side, the whole width in the translation), as far into it in a share
  // of it.
  keepPlace(fn) {
    const place = this.view.firstVisible();
    fn();
    if (!place) return;
    this.onShift?.();
    const height = this.view.scrollToEl(place.el, place.offset).getBoundingClientRect().height;
    if (place.offset < 0 && place.height && height) this.view.scrollEl.scrollTop += place.offset * (1 - height / place.height);
  }

  renderBar(id) {
    const c = this.chapters.get(id);
    const mark = this.view.tabs?.get(id)?.querySelector('.tab-mark');
    for (const key of this.live.keys()) if (key.startsWith(`${id}/`)) this.live.delete(key);
    const failed = () => [h('span', { class: 'tr-error', text: t('tr.loadFailed', { msg: c.loadError }) }), button(t('common.retry'), () => this.load(id))];
    if (c.parts) {
      // In parts: the chapter's bar says how many are done (with the view switch once one is, or
      // why their translation couldn't be loaded, and Retry), each part has its own, and the tab shows
      // n/m and a spinner while one is on its way. The chapter's bar changes only with what it
      // says, so a tap on it as a poll lands is not lost.
      const states = this.statesOf(id);
      const done = states.filter((s) => s?.status === 'ready').length;
      // The parts not on their way (nor done) can all be started from here at once (the server
      // runs a few together); the first one's own bar, just below, is then left out.
      const idle = c.parts.flatMap((p, i) => (states[i]?.status !== 'ready' && !BUSY.includes(states[i]?.status) ? [i] : []));
      const says = JSON.stringify([done, !!c.tr, this.mode, c.loadError, idle.map((i) => [i, states[i]?.status, states[i]?.progress])]);
      if (c.says !== says) {
        c.says = says;
        const starts = idle.flatMap((i) => this.unitKids(id, states[i], c.parts[i].chars, i + 1, c.parts.length));
        c.bar.replaceChildren(h('span', { class: 'tr-status', text: t('tr.parts', { n: c.parts.length, done }) }), ...(c.tr ? [this.modeToggle()] : []), ...starts, ...(c.loadError ? failed() : []));
      }
      c.bar.hidden = false;
      c.parts.forEach((p, i) => {
        // (a ready part missing from the translation loaded is offered again: rebuy)
        const shown = states[i]?.status === 'ready' && !c.missing && (!c.tr || c.loading || c.tr.done?.includes(i + 1));
        const onTop = i === 0 && idle.includes(0);
        if (shown || onTop) this.clearBar(p.bar, []);
        else this.fillBar(p.bar, id, states[i], p.chars, i + 1, c.parts.length);
        p.bar.hidden = shown || onTop;
      });
      const busy = states.some((s) => BUSY.includes(s?.status));
      mark?.replaceChildren(...(busy ? [h('span', { class: 'spinner' })] : []), ...(done === c.parts.length ? [iconEl('check', 14)] : done ? [`${done}/${c.parts.length}`] : []));
      return;
    }
    const st = this.statuses[id];
    if (c.tr) this.clearBar(c.bar, [this.modeToggle()]);
    else if (c.loadError) this.clearBar(c.bar, failed());
    // (nothing while a ready translation is on its way)
    else if (st?.status !== 'ready' || c.missing) this.fillBar(c.bar, id, st, c.chars);
    else this.clearBar(c.bar, []);
    c.bar.hidden = !c.bar.childNodes.length;
    // The chapter's tab: a check once it is translated, a spinner or how far while it is.
    if (st?.status === 'ready' && !c.missing) mark?.replaceChildren(iconEl('check', 14));
    else if (st?.status === 'working' && mark) this.paint(`${id}/mark`, () => (mark.textContent = `${percent(liveProgress({ ...st, chars: c.chars }))}%`));
    else mark?.replaceChildren(...(st?.status === 'queued' ? [h('span', { class: 'spinner' })] : []));
  }

  // Paints now, and again each tick while on its way (only text: a button under a finger stays).
  paint(key, fn) {
    fn();
    this.live.set(key, fn);
  }

  // A unit's bar (unitKids). One on its way keeps its bar while its status stays the same, only its
  // label painted again (each tick and poll), so a tap on Stop as a poll lands is not lost.
  fillBar(bar, id, st, chars, k = 0, parts = 0) {
    const key = `${id}/${k}`;
    const kept = this.bars.get(bar);
    if (kept && BUSY.includes(st?.status) && kept.status === st.status) return this.paint(key, kept.paint);
    bar.replaceChildren(...this.unitKids(id, st, chars, k, parts));
    this.bars.set(bar, { status: st?.status, paint: this.live.get(key) });
  }

  // A bar showing something else (no unit on its way).
  clearBar(bar, kids) {
    this.bars.delete(bar);
    bar.replaceChildren(...kids);
  }

  // The bar of a unit not translated (yet): a whole chapter's, or that of part `k` of `parts`.
  unitKids(id, st, chars, k = 0, parts = 0) {
    const pre = k ? `${t('tr.part', { k, n: parts })} · ` : '';
    const n = Math.round((st?.progress || 0) * 100);
    const spent = (st?.spent || 0).toFixed(2);
    if (BUSY.includes(st?.status)) {
      // Working: which segment of how many, translated or reviewed, how far and how long to go;
      // painted from the unit's state as last polled (its bar stays while its status does).
      const label = h('span', {});
      const now = () => (k ? this.statesOf(id)[k - 1] : this.statuses[id]) || st;
      this.paint(`${id}/${k}`, () => {
        const s = now();
        const phase = PHASES[s.phase];
        const shown = liveProgress({ ...s, chars });
        const at = { n: percent(shown), m: minutesLeft({ shown, chars, pace: s.pace }), spent: (s.spent || 0).toFixed(2) };
        label.textContent = pre + (s.status === 'queued' ? t('tr.queued') : phase && s.segment ? t(phase.label, { ...at, k: s.segment.k, of: s.segment.n }) : t('tr.working', at));
      });
      return [h('button', { class: 'btn btn-sm btn-secondary', type: 'button', disabled: true }, h('span', { class: 'spinner' }), label), button(t('tr.stop'), () => this.cancel(id, k))];
    }
    // Stopped, or failed after part of it was done: what was done is saved, and Resume goes on.
    if (st?.status === 'cancelled') return [h('span', { class: 'tr-status', text: pre + t('tr.stopped', { n, spent }) }), button(t('tr.resume'), () => this.request(id, false, k))];
    if (st?.status === 'error' && st.progress > 0) return [h('span', { class: 'tr-error', text: pre + t('tr.failedAt', { n }) }), button(t('tr.resume'), () => this.request(id, false, k)), h('span', { class: 'tr-status', text: st.error })];
    if (st?.status === 'error') return [h('span', { class: 'tr-error', text: pre + (st.error || t('tr.failed')) }), button(t('common.retry'), () => this.request(id, false, k))];
    // One tap starts it; the button says what it should cost and take. A ready one whose file is
    // gone needs `again`, and a confirmation (rebuy).
    return [button(pre + t('tr.translate', estimate(chars)), () => (st?.status === 'ready' ? this.rebuy(id, k) : this.request(id, false, k)), 'translate')];
  }

  modeToggle() {
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('tr.view') });
    for (const mode of MODES) {
      const pressed = this.mode === mode;
      seg.append(h('button', { type: 'button', class: pressed ? 'on' : '', 'aria-pressed': String(pressed), text: modeLabel(mode), onClick: () => this.setMode(mode) }));
    }
    return seg;
  }

  // One setting for the whole book, kept in this browser. The text being read stays where it is:
  // a block and its translation stand for each other (HtmlView.firstVisible and scrollToEl).
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    local.set(this.modeKey, mode);
    this.closeNote();
    this.onMode?.(mode);
    this.keepPlace(() => {
      for (const c of this.chapters.values()) if (c.tr) this.applyMode(c);
    });
    for (const id of this.chapters.keys()) this.renderBar(id);
  }

  // `part`: of a chapter in parts.
  request(id, again, part = 0) {
    return this.send(() => api.translateChapter(this.paper.id, id, { again, part }));
  }

  // A ready chapter or part whose translation couldn't be found (still syncing, say) is looked for
  // once more; still missing, it is bought again only once confirmed, with what that should cost.
  async rebuy(id, part = 0) {
    const c = this.chapters.get(id);
    c.missing = null;
    c.loaded = null; // (looked for again, even beside the parts shown)
    await this.load(id);
    const gone = c.missing || (part && !c.tr?.done?.includes(part));
    if (!gone || this.destroyed) return;
    const ok = await confirmDialog({ title: t('tr.rebuyTitle'), message: t('tr.rebuy', estimate(part ? c.parts[part - 1].chars : c.chars)), okText: t('action.translate') });
    if (ok && !this.destroyed) await this.request(id, true, part);
  }

  // One tap: a queued chapter or part never starts, a running one stops where it is.
  cancel(id, part = 0) {
    return this.send(() => api.cancelTranslation(this.paper.id, id, part));
  }

  // A refusal (one chapter more than the server translates at once, say) is said where it can be
  // read, and the bar stays as it was.
  async send(call) {
    try {
      const { paper } = await call();
      if (!this.destroyed) this.update(paper.book?.translations || {});
    } catch (err) {
      toast(err.message, { type: 'error', duration: 8000 });
    }
  }

  onClick(e) {
    const fn = e.target.closest?.('.fn, .fn-src');
    if (!fn) return;
    // Nor is a tap on a marker (in the original, also not one on a link around it).
    e.stopPropagation();
    e.preventDefault();
    this.toggleNote(fn);
  }

  onKey(e) {
    const fn = e.target.closest?.('.fn, .fn-src');
    if (!fn || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    this.toggleNote(fn);
  }

  // A second tap on the same marker closes its note.
  toggleNote(fn) {
    const same = this.noteFor === fn;
    this.closeNote();
    if (same) return;
    const n = Number(fn.dataset.n);
    const text = this.chapters.get(fn.closest('section[data-chapter]')?.dataset.chapter)?.tr?.notes?.[n - 1];
    if (text == null) return;
    const pop = h('div', { class: 'fn-pop', role: 'dialog', lang: langs.tgt, 'aria-label': t('tr.note', { n }) }, String(text));
    document.body.append(pop);
    const r = fn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const ht = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + ht > window.innerHeight - 10) top = Math.max(10, r.top - ht - 6);
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(10, Math.min(window.innerWidth - w - 10, r.left + r.width / 2 - w / 2))}px`;
    // Closes on a tap elsewhere (the marker itself toggles), Escape, or a scroll (but not of the
    // note's own text).
    const close = () => this.closeNote();
    const onDown = (e) => {
      if (!pop.contains(e.target) && !fn.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    const onScroll = (e) => {
      if (!pop.contains(e.target)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    this.note = pop;
    this.noteFor = fn;
    this.noteOff = () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }

  closeNote() {
    this.noteOff?.();
    this.note?.remove();
    this.note = this.noteFor = this.noteOff = null;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    this.ac.abort();
    this.closeNote();
  }
}
