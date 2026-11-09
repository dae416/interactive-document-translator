// Watches the text selection inside the reading area and shows the action bar.
import { COLORS } from './annotations.js';
import { h, iconButton, isCoarse } from './ui.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

// Cleans text copied out of a PDF text layer or an HTML page.
export function normalizeText(text) {
  return String(text || '')
    .replace(/­/g, '')
    .replace(/\r/g, '')
    .replace(/([A-Za-z])-\n\s*([a-z])/g, '$1$2')
    .replace(/([　-〿㐀-鿿＀-￯])\s*\n\s*([　-〿㐀-鿿＀-￯])/g, '$1$2')
    .replace(/[ \t ]*\n[ \t ]*/g, ' ')
    .replace(/[ \t ]{2,}/g, ' ')
    .trim();
}

// Returns a window of `full` around `needle`, or null when it can't be located.
export function contextAround(full, needle, radius = 1200) {
  if (!full) return '';
  const squash = (s) => s.replace(/\s+/g, ' ');
  const hay = squash(full);
  const probe = squash(needle).slice(0, 60);
  let idx = probe.length >= 4 ? hay.indexOf(probe) : -1;
  if (idx < 0 && probe.length > 16) idx = hay.indexOf(probe.slice(0, 16));
  if (idx < 0) return hay.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(hay.length, idx + needle.length + radius);
  return `${start > 0 ? '…' : ''}${hay.slice(start, end)}${end < hay.length ? '…' : ''}`;
}

const ACTIONS = [
  { act: 'translate', icon: 'translate' },
  // in its place for a selection in the translation (info.inTranslation): the original it
  // translates; in a block translated from a scan (info.orig), that part of the original's page
  { act: 'source', icon: 'eye' },
  { act: 'explain', icon: 'bulb' },
  { act: 'ask', icon: 'message' },
  { act: 'copy', icon: 'copy' },
];

// Highlight colors, underline, bookmark (a toggle) and, when the selection overlaps marks,
// remove. info.marks: ids of overlapping marks; info.bookmark: the bookmark on its block.
export function annotationTools(info, onPick) {
  const row = h('div', { class: 'ann-tools', role: 'group', 'aria-label': t('ann.tools') });
  for (const color of COLORS) {
    const label = `${t('ann.highlight')}: ${t(`ann.color.${color}`)}`;
    row.append(h('button', { class: `swatch ${color}`, type: 'button', title: label, 'aria-label': label, onClick: () => onPick('highlight', color) }));
  }
  row.append(iconButton('underline', { title: t('ann.underline'), onClick: () => onPick('underline') }));
  const bookmark = iconButton('bookmark', {
    title: info.bookmark ? t('ann.unbookmark') : t('ann.bookmark'),
    className: info.bookmark ? 'on' : '',
    onClick: () => onPick('bookmark'),
  });
  bookmark.setAttribute('aria-pressed', String(!!info.bookmark));
  row.append(bookmark);
  if (info.marks?.length) row.append(iconButton('trash', { title: t('ann.remove'), onClick: () => onPick('unmark') }));
  return row;
}

export class SelectionBar {
  // describe(selection) -> info object or null when the selection is outside the reading area.
  // While instant() is true the bar stays hidden and onInstant(info) receives each selection.
  // onAnnotate(act, color, info) handles the annotation row, shown when info.anchor is set.
  // onTapEnd(): a tapped clause's bar (showFor) has gone with its tap; the rest of the tap (its
  // marks, its balloon) goes too.
  constructor({ describe, onAction, onAnnotate, onVisibility, instant, onInstant, onTapEnd, onOpen }) {
    this.describe = describe;
    this.onAction = onAction;
    this.onAnnotate = onAnnotate;
    this.onVisibility = onVisibility;
    this.instant = instant;
    this.onInstant = onInstant;
    this.onTapEnd = onTapEnd;
    this.onOpen = onOpen;
    this.info = null;
    this.visible = false;
    this.el = h('div', { class: 'selbar', role: 'toolbar', 'aria-label': t('sel.toolbar') });
    this.main = h('div', { class: 'selbar-main' });
    for (const a of ACTIONS) {
      const btn = h('button', { type: 'button', dataset: { act: a.act }, html: `${icon(a.icon)}<span>${t(`action.${a.act}`)}</span>` });
      btn.addEventListener('click', () => this.trigger(a.act));
      this.main.append(btn);
    }
    this.tools = h('div', { hidden: true });
    // A tapped clause's bar is first only this, small at the foot of the screen: a tap opens it.
    this.more = h('button', { type: 'button', class: 'selbar-more', title: t('sel.more'), 'aria-label': t('sel.more'), html: icon('more') });
    this.more.addEventListener('click', () => {
      this.show();
      this.onOpen?.();
    });
    this.el.append(this.more, this.main, this.tools);
    // Keep the selection alive when the bar is pressed.
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      clearTimeout(this.hideTimer);
    });
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(this.el);

    this.onSelChange = () => {
      clearTimeout(this.timer);
      // On touch screens a selection is adjusted by dragging its handles; give instant
      // translation a moment so it doesn't start on a half-made selection.
      const delay = isCoarse() ? (this.instant?.() ? 600 : 260) : 120;
      this.timer = setTimeout(() => this.update(), delay);
    };
    document.addEventListener('selectionchange', this.onSelChange);
    // A mouse selection is finished when the button comes up. A tapped clause's bar goes with a
    // plain tap elsewhere: not on it, its balloon, or a menu or dialog opened from them.
    this.onPointerDown = (e) => {
      if (e.pointerType === 'mouse' && e.button === 0) this.mouseDown = true;
      const keep = this.el.contains(e.target) || e.target.closest?.('.instant-pop, .menu, .menu-scrim, .dialog, .scrim, .modal');
      this.down = this.tapped && !keep ? { x: e.clientX, y: e.clientY, at: Date.now() } : null;
    };
    this.onPointerUp = (e) => {
      const d = this.down;
      this.down = null;
      if (d && e?.type === 'pointerup' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10 && Date.now() - d.at < 450) this.endTap();
      if (!this.mouseDown) return;
      this.mouseDown = false;
      this.onSelChange();
    };
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('blur', this.onPointerUp);
    // A tapped clause's bar goes when its text scrolls (not a balloon or a panel beside it).
    this.onScroll = (e) => {
      const t = e?.target;
      // (A clause whose block was rebuilt meanwhile, when a part finished, ends too.)
      if (this.tapped && (!t?.contains || !this.info.range.startContainer.isConnected || t.contains(this.info.range.startContainer))) this.endTap();
      else if (this.visible && this.el.classList.contains('floating')) this.position();
    };
    window.addEventListener('scroll', this.onScroll, true);
  }

  update() {
    if (this.mouseDown) return;
    const sel = document.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : '';
    // A tapped clause's bar stays while nothing is selected (a tap leaves a caret at most); a
    // selection made ends the tap.
    if (this.tapped && !text.trim()) return;
    this.endTap();
    let info = null;
    if (text.trim()) {
      try {
        info = this.describe(sel);
      } catch (err) {
        console.warn('describe selection failed', err);
        info = null;
      }
    }
    if (info && info.text) {
      this.info = info;
      // The translation has nothing to translate on select: it gets the bar.
      if (this.instant?.() && !info.inTranslation) {
        this.hide();
        this.onInstant?.(info);
        return;
      }
      this.show();
    } else {
      // Delay so a tap on the bar (which may clear the selection on iOS) still lands.
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.hide(), 320);
    }
  }

  // A tapped clause or sentence (taps.js): the bar for its words as for a selection of them, with
  // none made (on a phone one brings up the system's own menu too). info.range: those words, which
  // place the bar. Null: a tapped clause's bar goes (a selection's stays). It starts small, out
  // of the way of the text being read (its marks are what a tap is mostly for).
  showFor(info) {
    if (info) {
      this.tapped = true;
      this.info = info;
      this.show(true);
    } else if (this.tapped) this.hide();
  }

  endTap() {
    if (!this.tapped) return;
    this.hide();
    this.onTapEnd?.();
  }

  // mini: only the small button at the foot of the screen (a tapped clause's, until it is tapped).
  show(mini = false) {
    clearTimeout(this.hideTimer);
    if (!this.info) return;
    // (Translate for the book's own words, else Original; neither in a chapter written in the
    // reader's language)
    const hide = this.info.inTranslation || this.info.orig ? ['translate'] : this.info.inTarget ? ['translate', 'source'] : ['source'];
    for (const btn of this.main.children) btn.hidden = hide.includes(btn.dataset.act);
    const withTools = !!(this.info.anchor && this.onAnnotate);
    const tools = withTools ? annotationTools(this.info, (act, color) => this.annotate(act, color)) : h('div', { hidden: true });
    this.tools.replaceWith(tools);
    this.tools = tools;
    this.el.classList.toggle('mini', mini);
    const floating = !isCoarse() && !mini;
    this.el.classList.toggle('floating', floating);
    // A selection on a phone brings up Chrome's Touch to Search bar at the foot of the screen, over
    // anything docked there; a page can't turn it off short of making its text unselectable, and
    // can't see it. So the bar of a selection goes to the top, or just above that bar where the
    // selection itself is at the top. (A tapped clause selects nothing: no search bar.)
    // ponytail: chosen when the selection is made; scrolling can bring it under the bar.
    const selected = isCoarse() && !mini && !this.tapped;
    const high = selected && (this.info.rect?.top ?? Infinity) < this.el.offsetHeight + 72;
    this.el.classList.toggle('top', selected && !high);
    this.el.classList.toggle('lift', high);
    if (floating) this.position();
    else this.el.style.top = this.el.style.left = '';
    this.el.classList.add('show');
    if (!this.visible) {
      this.visible = true;
      this.onVisibility?.(true);
    }
  }

  position() {
    const rect = this.info?.rect;
    if (!rect) return;
    const sel = document.getSelection();
    const range = this.info.range || (sel && sel.rangeCount ? sel.getRangeAt(0) : null);
    const live = range ? range.getBoundingClientRect() : rect;
    const r = live.width || live.height ? live : rect;
    const bw = this.el.offsetWidth || 300;
    const bh = this.el.offsetHeight || 44;
    let top = r.top - bh - 10;
    if (top < 60) top = r.bottom + 10;
    const left = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }

  hide() {
    this.tapped = false;
    this.el.classList.remove('show');
    if (this.visible) {
      this.visible = false;
      this.onVisibility?.(false);
    }
  }

  trigger(act) {
    const info = this.info;
    if (!info) return;
    this.onAction(act, info);
    if (act !== 'copy') {
      document.getSelection()?.removeAllRanges();
      this.endTap();
      this.hide();
    }
  }

  // The new mark shows once the selection (or a tapped clause's marks) is gone.
  annotate(act, color) {
    const info = this.info;
    if (!info) return;
    this.onAnnotate(act, color, info);
    document.getSelection()?.removeAllRanges();
    this.endTap();
    this.hide();
  }

  setOffset(px) {
    this.el.style.setProperty('--sel-offset', `${px}px`);
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.hideTimer);
    document.removeEventListener('selectionchange', this.onSelChange);
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('blur', this.onPointerUp);
    window.removeEventListener('scroll', this.onScroll, true);
    this.el.remove();
  }
}
