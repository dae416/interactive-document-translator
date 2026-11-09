// "Translate on select": selecting text in the paper opens a popup that streams its
// translation. Nothing is saved unless the user carries on in the AI panel. A tapped sentence of a
// book opens it too (taps.js): with its counterpart from the chapter's translation, or streamed.
import { cachedSettings, getSettings } from './api.js';
import { bookMessage, buildSystem, canAskOpus, instantKey, modelLabel, newThread, quoteMessage, runTurn } from './ai.js';
import { renderMarkdown } from './markdown.js';
import { canSwitchProvider, openProviderMenu } from './providers.js';
import { annotationTools } from './selection.js';
import { paint } from './taps.js';
import { copyText, h, iconButton, iconEl, isCoarse, toast } from './ui.js';
import { t } from './i18n.js';
import { langs } from './langs.js';

// Longer selections (e.g. select-all by accident) wait for a tap instead of starting a request.
const AUTO_LIMIT = 3000;
const CACHE_SIZE = 30;
const CONFIG_ERRORS = ['no_key', 'no_model', 'no_base_url'];
// The tapped sentence, marked while its balloon is open.
const TAPPED = 'tap-sentence';

export class InstantTranslate {
  // onAction(act, info): explain / ask in the AI panel. onContinue(thread): follow up there.
  // onAnnotate(act, color, info): highlight / underline / bookmark / unmark a book selection.
  // avoid(): the box of the menu shown with a tapped sentence (the selection bar), or null.
  constructor({ paper, onAction, onAnnotate, onContinue, onVisibility, openSettings, avoid }) {
    Object.assign(this, { paper, onAction, onAnnotate, onContinue, onVisibility, openSettings, avoid });
    this.cache = new Map();
    this.offset = 0;
    this.el = null;
  }

  get isOpen() {
    return !!this.el;
  }

  // info.ranges: a tapped sentence, marked while the popup is open. info.pair: { src, tgt }, the
  // original and the translation from a translated chapter, shown at once (info.shown: which of the
  // two).
  show(info) {
    // The same selection settling again (e.g. after a tap on the popup): nothing new to do.
    if (this.el && this.info && this.cacheKey(this.info) === this.cacheKey(info)) {
      this.info = info;
      paint(TAPPED, info.ranges);
      this.renderTools();
      this.position();
      return;
    }
    this.stop();
    this.info = info;
    this.open();
    paint(TAPPED, info.ranges);
    const cached = info.pair ? this.pairThread(info) : this.cache.get(this.cacheKey(info));
    this.thread = cached || null;
    this.renderTools();
    if (cached || info.text.length > AUTO_LIMIT) this.render();
    else this.run();
  }

  cacheKey(info) {
    return instantKey(cachedSettings()?.prefs, info);
  }

  remember(info, thread) {
    const key = this.cacheKey(info);
    this.cache.delete(key);
    this.cache.set(key, thread);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
  }

  // A sentence of a translated chapter and the chapter's translation of it, as a finished turn, so
  // "Follow up" carries on from the pair.
  pairThread(info) {
    const at = new Date().toISOString();
    const quote = { text: info.pair.src, context: info.context || '', location: info.location || null };
    const thread = newThread({ paper: this.paper, kind: 'quote', action: 'translate', quote, system: '', book: { id: this.paper.id, chapter: info.chapter, block: info.location?.anchorId } });
    thread.messages.push(
      { role: 'user', content: bookMessage('translate', { ...quote, mode: 'sentence' }), isAction: true, action: 'translate', at },
      { role: 'assistant', content: info.pair.tgt, at },
    );
    return thread;
  }

  // fresh: a new answer, not a stored one. model: 'opus' etc. instead of the automatic choice.
  async run({ fresh = false, model } = {}) {
    this.stop();
    const info = this.info;
    if (!info) return;
    const controller = new AbortController();
    this.controller = controller;
    const prefs = (await getSettings()).prefs;
    const context = info.getContext ? await info.getContext().catch(() => '') : info.context || '';
    if (controller.signal.aborted || this.info !== info) return;
    const quote = { text: info.text, context, location: info.location || null };
    const book = this.paper.kind === 'book' ? { id: this.paper.id, chapter: info.chapter, block: info.location?.anchorId } : null;
    const thread = newThread({ paper: this.paper, kind: 'quote', action: 'translate', quote, system: book ? '' : buildSystem(this.paper, prefs), book });
    const content = book ? bookMessage('translate', { ...quote, mode: info.mode, sentence: info.sentence }) : quoteMessage('translate', quote, prefs);
    const user = { role: 'user', content, isAction: true, action: 'translate', at: new Date().toISOString() };
    const reply = { role: 'assistant', content: '', pending: true };
    thread.messages.push(user, reply);
    this.thread = thread;
    this.render();
    let frame = 0;
    await runTurn(thread, reply, {
      action: 'translate',
      signal: controller.signal,
      fresh,
      model,
      onUpdate: () => {
        if (this.thread !== thread) return;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => this.render());
      },
    });
    cancelAnimationFrame(frame);
    if (this.controller === controller) this.controller = null;
    if (reply.error) user.failed = true;
    else this.remember(info, thread);
    if (this.thread === thread) this.render();
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
  }

  // ---- popup ----

  open() {
    if (this.el) return;
    this.titleEl = h('span', { text: t('action.translate') });
    this.modelEl = h('span', { class: 'model' });
    this.body = h('div', { class: 'instant-body' });
    this.tools = h('div', { class: 'instant-tools', hidden: true });
    this.foot = h('div', { class: 'instant-foot' });
    this.el = h(
      'div',
      { class: 'instant-pop', role: 'dialog', 'aria-label': t('action.translate') },
      h(
        'div',
        { class: 'instant-head' },
        h('span', { class: 'title' }, iconEl('translate'), this.titleEl, this.modelEl),
        iconButton('close', { title: t('common.close'), onClick: () => this.close() }),
      ),
      this.body,
      this.tools,
      this.foot,
    );
    // Keep the source text selected while the popup's buttons are used (mouse).
    this.el.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.instant-body')) e.preventDefault();
    });
    // A plain tap elsewhere closes the popup; scrolling, a new selection, or menus and dialogs
    // opened from the popup (e.g. "switch provider") don't.
    this.onDown = (e) => {
      // (the selection bar too: its small button opens it, the popup staying)
      const inside = this.el?.contains(e.target) || e.target.closest?.('.menu, .menu-scrim, .dialog, .scrim, .modal, .selbar');
      this.down = inside ? null : { x: e.clientX, y: e.clientY, at: Date.now() };
    };
    this.onUp = (e) => {
      const d = this.down;
      this.down = null;
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10 && Date.now() - d.at < 450) this.close();
    };
    this.onKey = (e) => {
      if (e.key === 'Escape') this.close();
    };
    // A tapped sentence's popup closes when the text scrolls (not its own); a selection's follows it.
    this.onScroll = (e) => {
      if (this.info?.tap && e?.type === 'scroll' && !this.el.contains(e.target)) this.close();
      else this.position();
    };
    document.addEventListener('pointerdown', this.onDown, true);
    document.addEventListener('pointerup', this.onUp, true);
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onScroll);
    document.body.append(this.el);
    this.onVisibility?.(true);
  }

  close() {
    this.stop();
    if (!this.el) return;
    document.removeEventListener('pointerdown', this.onDown, true);
    document.removeEventListener('pointerup', this.onUp, true);
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    this.el.remove();
    paint(TAPPED);
    this.el = null;
    this.info = null;
    this.thread = null;
    this.onVisibility?.(false);
  }

  setOffset(px) {
    this.offset = px;
    this.position();
  }

  // Phones: a card above the bottom edge. Larger screens: next to the selection. Clear of a tapped
  // sentence's menu (avoid): docked, above it (it is docked 4px higher; 8px between); else past it
  // as past the text (ponytail: a window too short for it on either side lets it cover the menu).
  position() {
    const el = this.el;
    if (!el) return;
    const docked = isCoarse() || window.innerWidth < 640;
    const box = this.avoid?.();
    el.classList.toggle('docked', docked);
    // (over Chrome's search bar, which comes up with a selection on a phone: see selection.js)
    el.classList.toggle('lift', docked && isCoarse() && !this.info?.tap);
    el.style.setProperty('--sel-offset', `${this.offset + (docked && box ? box.height + 12 : 0)}px`);
    if (docked) {
      el.style.top = '';
      el.style.left = '';
      return;
    }
    let r = this.info?.rect;
    const sel = document.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const live = sel.getRangeAt(0).getBoundingClientRect();
      if (live.width || live.height) r = live;
    }
    if (!r) return;
    // (not the bar's small button: it is at the foot of the screen, not by the text)
    if (box && !box.mini) r = { left: r.left, width: r.width, top: Math.min(r.top, box.top), bottom: Math.max(r.bottom, box.bottom) };
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    // A tapped sentence's popup goes above it, over what has been read: the next sentence stays
    // free to tap.
    const above = r.top - ht - 10;
    let top = this.info?.tap && above >= 10 ? above : r.bottom + 10;
    if (top + ht > window.innerHeight - 10) top = above;
    top = Math.max(10, Math.min(top, window.innerHeight - ht - 10));
    const left = Math.max(10, Math.min(window.innerWidth - w - 10, r.left + r.width / 2 - w / 2));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  render() {
    if (!this.el) return;
    const reply = this.thread?.messages[this.thread.messages.length - 1];
    const pair = this.info?.pair;
    this.titleEl.textContent = this.info?.shown === 'src' ? t('tap.original') : t('action.translate');
    this.modelEl.textContent = pair ? t('tap.chapter') : modelLabel(reply?.model);
    this.body.replaceChildren();
    if (pair) {
      this.body.append(h('div', { class: 'md', lang: langs[this.info.shown], text: pair[this.info.shown] }));
      this.renderFoot(reply);
      this.position();
      return;
    }
    if (!this.thread) {
      this.body.append(
        h('div', { class: 'instant-long', text: t('instant.long', { n: this.info.text.length }) }),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', text: t('action.translate'), onClick: () => this.run() }),
      );
    } else if (reply.pending && !reply.content) {
      this.body.append(
        h('div', { class: 'thinking' }, h('span', { class: 'dots', html: '<i></i><i></i><i></i>' }), h('span', { text: reply.status === 'thinking' ? t('ai.thinking') : t('ai.waiting') })),
      );
    }
    if (reply?.content) this.body.append(h('div', { class: `md${reply.pending ? ' streaming' : ''}`, html: renderMarkdown(reply.content) }));
    if (reply && canAskOpus(reply, cachedSettings()?.llm)) {
      this.body.append(h('button', { class: 'link-btn', type: 'button', text: t('ai.askOpus'), onClick: () => this.run({ fresh: true, model: 'opus' }) }));
    }
    if (reply?.error) this.body.append(this.renderError(reply));
    this.renderFoot(reply);
    this.position();
  }

  renderError(reply) {
    const box = h('div', { class: 'msg-error', text: reply.error });
    const actions = h('div', { class: 'msg-error-actions' });
    if (CONFIG_ERRORS.includes(reply.errorCode)) {
      actions.append(h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('ai.openSettings'), onClick: () => this.openSettings?.() }));
    } else if (!reply.stopped) {
      actions.append(h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('common.retry'), onClick: () => this.run({ fresh: true }) }));
      if (canSwitchProvider()) {
        const btn = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('ai.switchProvider') });
        btn.addEventListener('click', () => openProviderMenu(btn, { onSwitched: () => this.run({ fresh: true }), openSettings: this.openSettings }));
        actions.append(btn);
      }
    }
    if (actions.childNodes.length) box.append(actions);
    return box;
  }

  renderFoot(reply) {
    const done = !!reply && !reply.pending && !reply.error && !!reply.content;
    const action = (name, label, onClick, enabled = true) => {
      const btn = h('button', { type: 'button' }, iconEl(name), h('span', { text: label }));
      btn.disabled = !enabled;
      btn.addEventListener('click', onClick);
      return btn;
    };
    this.foot.replaceChildren(
      action('bulb', t('action.explain'), () => this.handOff('explain')),
      action('message', t('action.ask'), () => this.handOff('ask')),
      action('copy', t('common.copy'), async () => toast((await copyText(this.info?.pair?.[this.info.shown] ?? reply.content)) ? t('common.copied') : t('common.copyFailed')), done),
      h('span', { class: 'grow' }),
      action('sparkles', t('instant.continue'), () => this.continueInPanel(), done),
    );
  }

  // A book selection gets the highlight / underline / bookmark row; the popup stays open.
  renderTools() {
    const info = this.info;
    this.tools.hidden = !info?.anchor || !this.onAnnotate;
    if (this.tools.hidden) return;
    this.tools.replaceChildren(
      annotationTools(info, (act, color) => {
        this.onAnnotate(act, color, info);
        this.renderTools();
      }),
    );
  }

  handOff(act) {
    const info = this.info;
    this.close();
    if (info) this.onAction?.(act, info);
  }

  // The panel gets its own copy: follow-ups there must not change the cached translation.
  continueInPanel() {
    const thread = structuredClone(this.thread);
    this.close();
    this.onContinue?.(thread);
  }

  destroy() {
    this.close();
  }
}
