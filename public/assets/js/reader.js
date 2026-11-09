import { api, getSettings } from './api.js';
import { AiPanel } from './aipanel.js';
import { chapterOf, comparePoints, isTranslation } from './anchors.js';
import { AnnotationStore, MAX_NOTE, clearAnnotationPaint, paintAnnotations, partnerOf } from './annotations.js';
import { startCapture } from './capture.js';
import { HtmlView, wholeFormulas } from './htmlview.js';
import { icon } from './icons.js';
import { InstantTranslate } from './instant.js';
import { langs, setLangs } from './langs.js';
import { PdfView } from './pdfview.js';
import { canSwitchProvider, openProviderMenu, usableProviders } from './providers.js';
import { SelectionBar } from './selection.js';
import { openSettings } from './settings.js';
import { SentenceTaps } from './taps.js';
import { BookTranslations, bookSelection, writtenInTarget } from './translation.js';
import { renderMarkdown } from './markdown.js';
import {
  applyTheme,
  closeMenus,
  confirmDialog,
  copyText,
  debounce,
  h,
  iconButton,
  iconEl,
  isCoarse,
  isDarkTheme,
  local,
  menuSwitch,
  openMenu,
  textDialog,
  timeAgo,
  toast,
  uid,
} from './ui.js';
import { t } from './i18n.js';

const THEMES = ['system', 'light', 'dark'];
const themeLabel = (name) => t(`theme.${name}`);

// Returns as soon as the shell is on screen; loading continues in the background so
// navigating away (e.g. back while a big PDF downloads) is never blocked.
// at: a block to open at instead of where the book was left (a bookmark on the home page); the
// address forgets it, so a reload opens where reading then stands. A mark on the translation
// (c3.12k) opens at its block of the original (c3.12), which has the id.
export async function openReader(root, paperId, { at = null } = {}) {
  const reader = new Reader(root, paperId);
  reader.openAt = /^(c\d+\.\d+)k?$/.exec(at || '')?.[1] || null;
  if (at) history.replaceState(null, '', `#/read/${encodeURIComponent(paperId)}`);
  reader.init().catch((err) => {
    if (!reader.destroyed) reader.showError(err.message || String(err));
  });
  return reader;
}

// Downscales any image to PNG/JPEG base64 that vision models accept.
async function imageToBase64(src, maxSide = 1568) {
  const res = await fetch(src, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(t('reader.imageLoadFailed', { status: res.status }));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(t('reader.imageDecodeFailed')));
      img.src = url;
    });
    let w = img.naturalWidth || 1200;
    let hgt = img.naturalHeight || 800;
    const k = Math.min(1, maxSide / Math.max(w, hgt));
    w = Math.max(1, Math.round(w * k));
    hgt = Math.max(1, Math.round(hgt * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(img, 0, 0, w, hgt);
    let dataUrl = canvas.toDataURL('image/png');
    let mediaType = 'image/png';
    if (dataUrl.length > 1_800_000) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      mediaType = 'image/jpeg';
    }
    return { mediaType, data: dataUrl.slice(dataUrl.indexOf(',') + 1), width: w, height: hgt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A part of an original page ("21:x0,y0,x1,y1", shares of a letter-size page): the picture of the
// page (figures/o21.png), cut down to that part in a box of its shape.
function originalPart(paperId, part) {
  const [page, box] = part.split(':');
  const [x0, y0, x1, y1] = box.split(',').map(Number);
  const w = x1 - x0;
  const ht = y1 - y0;
  const img = h('img', { src: api.figureUrl(paperId, `o${page}.png`), alt: '', style: { width: `${100 / w}%`, left: `${(-x0 / w) * 100}%`, top: `${(-y0 / ht) * 100}%` } });
  return h('div', { class: 'orig-part', style: { aspectRatio: `${w * 612} / ${ht * 792}` } }, img);
}

class Reader {
  constructor(root, paperId) {
    this.host = root;
    this.paperId = paperId;
    this.view = null;
    this.mode = null;
    this.htmlAvailable = false;
    this.lastScrollTop = 0;
    this.quietScrollUntil = 0;
    this.saveProgress = debounce(() => this.persistProgress(false), 1500);
    this.listeners = [];
    // Per-device reading options.
    this.tocPinned = local.get('tocPinned', false);
    this.barPinned = local.get('barPinned', false);
    this.instantOn = local.get('instantTranslate', false);
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push(() => target.removeEventListener(type, fn, opts));
  }

  buildShell() {
    this.titleEl = h('div', { class: 'title' });
    this.seg = h('div', { class: 'seg', role: 'tablist', hidden: true });
    this.segPdf = h('button', { type: 'button', role: 'tab', text: t('reader.pdf') });
    this.segHtml = h('button', { type: 'button', role: 'tab', text: t('reader.html') });
    this.segPdf.addEventListener('click', () => this.mode !== 'pdf' && this.setMode('pdf'));
    this.segHtml.addEventListener('click', () => this.mode !== 'html' && this.setMode('html'));
    this.seg.append(this.segPdf, this.segHtml);
    this.captureBtn = iconButton('scan', { title: t('reader.capture'), onClick: () => this.toggleCapture() });
    this.captureBtn.hidden = true;
    this.bookmarkBtn = iconButton('bookmark', { title: t('reader.bookmarkHere'), onClick: () => this.bookmarkHere() });
    this.bookmarkBtn.hidden = true;
    this.tocBtn = iconButton('list', { title: t('reader.toc'), onClick: () => this.openToc() });
    this.moreBtn = iconButton('more', { title: t('common.more'), onClick: () => this.openMore() });
    this.topbar = h(
      'header',
      { class: 'topbar' },
      iconButton('back', { title: t('common.back'), onClick: () => (location.hash = '#/') }),
      this.titleEl,
      this.seg,
      this.captureBtn,
      this.bookmarkBtn,
      this.tocBtn,
      this.moreBtn,
    );
    this.viewHost = h('div', { class: 'view-host' });
    this.loading = h('div', { class: 'reader-loading', hidden: true });
    this.pill = h('div', { class: 'page-pill', 'aria-hidden': 'true' });
    this.badge = h('span', { class: 'badge', hidden: true });
    this.fab = h('button', { class: 'fab', type: 'button', 'aria-label': t('reader.ai'), html: icon('sparkles') }, this.badge);
    this.fab.addEventListener('click', () => this.panel?.toggle());
    this.stage = h('div', { class: 'reader-stage' }, this.viewHost, this.topbar, this.loading, this.pill, this.fab);
    this.root = h('div', { class: `reader${this.tocPinned ? ' toc-pinned' : ''}` }, this.stage);
    this.host.append(this.root);
    // The pinned contents frame is there from the start; it fills in once the paper opens.
    if (this.tocPinned) this.renderTocSide();
  }

  async init() {
    this.buildShell();
    this.showLoading(t('reader.opening'));
    try {
      this.paper = (await api.getPaper(this.paperId)).paper;
    } catch (err) {
      if (!this.destroyed) this.showError(err.message);
      return;
    }
    if (this.destroyed) return;
    this.isBook = this.paper.kind === 'book';
    if (this.isBook && !(await this.waitForBook())) return;
    if (this.isBook && this.paper.book?.status === 'error') {
      const msg = t('book.failed', { msg: this.paper.book.error || '' });
      // A PDF book still has its original pages (the mode logic below picks PDF).
      if (this.paper.source !== 'upload') {
        this.showError(msg);
        return;
      }
      toast(msg, { type: 'error', duration: 6000 });
    }
    api.patchPaper(this.paperId, { opened: true }).catch(() => {});
    this.settings = await getSettings().catch(() => ({ prefs: {} }));
    if (this.destroyed) return;
    // A book's two languages: its own, else those of Settings (langs.js).
    setLangs({ ...this.settings.langs, ...this.paper.langs });
    this.titleEl.textContent = this.paper.title;
    document.title = `${this.paper.title} · ${t('app.name')}`;

    this.panel = new AiPanel({
      paper: this.paper,
      host: this.root,
      getView: () => this.view,
      getChapter: () => this.readingChapter(),
      getBlock: () => this.firstBlock()?.dataset.b,
      onOpenChange: (open) => {
        this.root.classList.toggle('panel-open', open);
        if (open) this.setChrome(true);
      },
      onHeightChange: (px) => {
        this.selbar?.setOffset(px);
        this.instant?.setOffset(px);
      },
      openSettings: () => openSettings({ section: 'ai' }),
      jumpTo: (loc) => this.jumpToLocation(loc),
      onNote: this.isBook ? (quote, text) => this.addNote(quote, text) : null,
    });
    this.panel.onCountChange = (n) => this.updateBadge(n);
    this.instant = new InstantTranslate({
      paper: this.paper,
      onAction: (act, info) => this.panel.startQuote(act, info),
      onAnnotate: (act, color, info) => this.annotate(act, color, info),
      onContinue: (thread) => this.panel.adoptThread(thread),
      // (a tapped sentence's menu goes with its balloon)
      onVisibility: (v) => {
        if (!v) this.selbar?.showFor(null);
        this.root.classList.toggle('selecting', v);
      },
      avoid: () => (this.selbar?.tapped ? { ...this.selbar.el.getBoundingClientRect().toJSON(), mini: this.selbar.el.classList.contains('mini') } : null),
      openSettings: () => openSettings({ section: 'ai' }),
    });
    this.selbar = new SelectionBar({
      describe: (sel) => this.describe(sel),
      onAction: (act, info) => this.onSelectionAction(act, info),
      onAnnotate: (act, color, info) => this.annotate(act, color, info),
      // With Translate on select, only the translation gets the bar; a popup left open goes (not the
      // balloon a tapped sentence's menu comes with).
      onVisibility: (v) => {
        if (v && !this.selbar.tapped) this.instant?.close();
        this.root.classList.toggle('selecting', v);
      },
      instant: () => this.instantOn,
      onInstant: (info) => this.instant.show(info),
      // (the popup moves clear of the bar now open)
      onOpen: () => this.instant?.position(),
      onTapEnd: () => {
        this.taps?.unpair();
        this.instant?.close();
      },
    });
    // The same options can be changed in Settings while a paper is open.
    this.on(document, 'readerprefs', () => {
      this.setBarPinned(local.get('barPinned', false), { save: false });
      this.setInstant(local.get('instantTranslate', false), { save: false });
    });
    this.on(window, 'resize', () => this.scheduleTocCurrent());

    this.pdfInvert = local.get('pdfInvert', true);
    this.on(document, 'themechange', () => this.updateInvert());
    this.on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.persistProgress(true);
    });
    this.on(window, 'pagehide', () => this.persistProgress(true));
    this.on(document, 'keydown', (e) => this.onKey(e));
    // iOS: keep two-finger gestures from zooming the whole app.
    this.on(document, 'gesturestart', (e) => e.preventDefault());

    if (this.isBook) {
      // Kept in this browser and on the server; either side catches up with the other.
      this.annotations = new AnnotationStore(this.paperId, {
        onChange: () => this.onAnnotationsChange(),
        onError: (err) => this.annotationsFailed(err),
      });
      this.on(window, 'online', () => this.annotations.sync());
      this.annotations.sync();
      this.segPdf.textContent = t('reader.bookPages');
      this.segHtml.textContent = t('reader.bookText');
    }

    const isArxiv = this.paper.source === 'arxiv';
    // Books open as text, or in their pages if the reader left them there (a book of formulas reads
    // better as typeset pages). Only uploaded (PDF) books have original pages to switch to.
    this.hasPdf = !this.isBook || this.paper.source === 'upload';
    this.htmlAvailable = this.isBook ? this.paper.html?.status === 'ok' : isArxiv && this.paper.html?.status !== 'none';
    let mode = this.isBook ? (this.hasPdf && this.paper.progress?.mode === 'pdf' ? 'pdf' : 'html') : this.paper.progress?.mode;
    if (mode === 'html' && !this.htmlAvailable && this.hasPdf) mode = 'pdf';
    if (!mode) mode = this.htmlAvailable && this.settings.prefs?.preferHtml !== false ? 'html' : 'pdf';
    // (a bookmark's block, opened from the home page: in the text)
    if (this.openAt && this.htmlAvailable) mode = 'html';
    await this.setMode(mode, { initial: true });

    api
      .listThreads(this.paperId)
      .then(({ threads }) => {
        this.panel.threadCount = threads.length;
        this.updateBadge(threads.length);
      })
      .catch(() => {});
  }

  updateBadge(n) {
    this.badge.hidden = !n;
    this.badge.textContent = n > 99 ? '99+' : String(n);
  }

  // A book still being prepared: shows the step and its progress until it is done.
  async waitForBook() {
    if (this.paper.book?.status !== 'processing') return true;
    // Nothing to list or ask about yet.
    const idle = [this.tocBtn, this.moreBtn, this.fab];
    for (const el of idle) el.hidden = true;
    this.titleEl.textContent = this.paper.title;
    while (this.paper.book?.status === 'processing') {
      this.loadingText.textContent = t(`book.step.${this.paper.book.step || 'extract'}`);
      this.setLoadingProgress(this.paper.book.progress || 0);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (this.destroyed) return false;
      try {
        this.paper = (await api.getPaper(this.paperId)).paper;
      } catch (err) {
        // Offline for a moment: keep waiting.
        if (err.status) {
          this.showError(err.message);
          return false;
        }
      }
    }
    for (const el of idle) el.hidden = false;
    return !this.destroyed;
  }

  // ---- modes ----

  updateModeUi() {
    this.seg.hidden = !this.htmlAvailable || !this.hasPdf;
    this.segPdf.classList.toggle('on', this.mode === 'pdf');
    this.segHtml.classList.toggle('on', this.mode === 'html');
    this.segPdf.setAttribute('aria-selected', String(this.mode === 'pdf'));
    this.segHtml.setAttribute('aria-selected', String(this.mode === 'html'));
    this.captureBtn.hidden = this.mode !== 'pdf';
    this.bookmarkBtn.hidden = !this.isBook || this.mode !== 'html';
    this.updateInvert();
  }

  updateInvert() {
    this.root.classList.toggle('pdf-invert', this.mode === 'pdf' && this.pdfInvert && isDarkTheme());
  }

  async setMode(mode, { initial = false } = {}) {
    if (this.switching) return;
    this.switching = true;
    this.capture?.cancel();
    this.closePeek();
    this.instant?.close();
    this.backChip?.remove();
    this.tocItems = null;
    this.tocSide?.querySelector('.drawer-body')?.replaceChildren();
    clearTimeout(this.pillTimer);
    this.pill.classList.remove('show');
    this.persistProgress(false);
    const prev = this.view;
    this.view = null;
    this.translations?.destroy();
    this.translations = null;
    this.taps?.destroy();
    this.taps = null;
    prev?.destroy();
    clearAnnotationPaint();
    this.mode = mode;
    this.updateModeUi();
    this.lastScrollTop = 0;
    this.quietScrollUntil = Date.now() + 60_000;
    this.setChrome(true);
    this.showLoading(mode === 'pdf' ? t('reader.openingPdf') : t('reader.openingHtml'));
    const saved = initial && mode === 'html' && this.openAt ? { anchorId: this.openAt, offset: 0 } : this.paper.progress?.[mode];
    const common = {
      paper: this.paper,
      host: this.viewHost,
      onScroll: (top) => this.handleScroll(top),
      onTap: () => this.setChrome(this.root.classList.contains('chrome-hidden')),
      onJump: (back) => this.showBackChip(back),
    };
    let view;
    try {
      if (mode === 'pdf') {
        view = new PdfView({
          ...common,
          onPageChange: (n, total) => this.showPage(n, total),
          onViewChange: () => this.saveProgress(),
          onInternalLink: (dest) => this.previewDest(dest),
          onProgress: (f) => this.setLoadingProgress(f),
        });
      } else {
        view = new HtmlView({
          ...common,
          // A tap on a book's text is left for its sentences; the bar comes back on scrolling up.
          ...(this.isBook ? { onTap: null } : {}),
          onPeek: (info) => this.showPeek(info),
          onImage: (img, caption) => this.openLightbox(img, caption),
          // Another chapter of a book may not scroll at all: its place is saved all the same.
          onChapter: (id) => {
            this.scheduleTocCurrent();
            this.saveProgress();
            this.prefetchClauses(id);
          },
        });
      }
      await view.open(saved);
      if (this.destroyed) {
        view.destroy();
        return;
      }
      this.view = view;
      this.hideLoading();
      this.quietScrollUntil = Date.now() + 1200;
      this.paper.progress = { ...(this.paper.progress || {}), mode };
      if (this.tocPinned) this.renderTocSide();
      if (mode === 'pdf') this.afterPdfOpen(view);
      if (mode === 'html' && !initial) this.saveProgress();
      if (mode === 'html' && this.isBook) {
        this.chapterTitles = new Map(view.getOutline().flatMap((it) => (it.el.dataset.chapter ? [[it.el.dataset.chapter, it.title]] : [])));
        this.onAnnotationsChange();
        this.translations = new BookTranslations({
          paper: this.paper,
          view,
          onShift: () => (this.quietScrollUntil = Date.now() + 800),
          onShow: () => this.onAnnotationsChange(),
          // (a sentence and its translation marked side by side are no pair in another view)
          onMode: () => this.taps?.unpair(),
          onLoad: (id) => this.prefetchClauses(id),
        });
        // A tap on a clause or sentence: its counterpart in the translation, else the model's (per
        // device), and the selection bar for it.
        this.taps = new SentenceTaps({
          root: view.article,
          describe: (range) => this.describe({ getRangeAt: () => range }),
          show: (info) => this.instant.show(info),
          current: () => (this.instant.isOpen ? this.instant.info : null),
          on: () => local.get('tapTranslate', true),
          ai: () => local.get('tapAi', true),
          unit: () => local.get('tapUnit', 'clause'),
          clausesOf: (chapter) => api.getClauses(this.paper.id, chapter),
          menu: (info) => this.selbar.showFor(info),
          original: (block) => this.showOriginal(block),
          // (marks of the chapter waiting for its pairing get their other side now)
          onSettle: () => this.onAnnotationsChange(),
        });
      }
    } catch (err) {
      view?.destroy();
      this.switching = false;
      if (this.destroyed) return;
      // Books from text or the web have no PDF to fall back to.
      if (mode === 'html' && !this.hasPdf) {
        this.showError(t('reader.htmlFailed', { msg: err.message }), () => this.setMode('html', { initial }));
        return;
      }
      if (mode === 'html') {
        this.htmlAvailable = false;
        if (!initial) toast(err.status === 404 ? t('reader.noHtml') : t('reader.htmlFailed', { msg: err.message }));
        return this.setMode('pdf', { initial });
      }
      // A book left in its pages opens as text when the PDF can't load.
      if (initial && this.isBook && this.htmlAvailable) return this.setMode('html', { initial });
      this.showError(t('reader.pdfFailed', { msg: err.message || err }), () => this.setMode('pdf'));
      return;
    }
    this.switching = false;
  }

  async afterPdfOpen(view) {
    const pdfTip = !local.get('tip.pdf') && isCoarse();
    if (pdfTip) {
      local.set('tip.pdf', true);
      this.showTip(t('reader.tip'));
    }
    try {
      if (['filename', 'id'].includes(this.paper.titleSource)) {
        const title = await view.guessTitle();
        if (title && this.view === view) {
          this.paper.title = title;
          this.paper.titleSource = 'pdf';
          this.titleEl.textContent = title;
          document.title = `${title} · ${t('app.name')}`;
          api.patchPaper(this.paperId, { title, titleSource: 'pdf' }).catch(() => {});
        }
      }
      if (!this.paper.abstract) {
        const abstract = await view.guessAbstract();
        if (abstract) {
          this.paper.abstract = abstract;
          api.patchPaper(this.paperId, { abstract }).catch(() => {});
        }
      }
    } catch {
      // best effort only
    }
  }

  // ---- chrome, loading, progress ----

  setChrome(visible) {
    if (!visible && this.barPinned) return;
    this.root.classList.toggle('chrome-hidden', !visible);
  }

  setBarPinned(on, { save = true } = {}) {
    this.barPinned = on;
    if (save) local.set('barPinned', on);
    if (on) this.setChrome(true);
  }

  setInstant(on, { save = true } = {}) {
    if (on && save && !this.instantOn) toast(t('reader.instantOn'));
    this.instantOn = on;
    if (save) local.set('instantTranslate', on);
    if (!on) this.instant?.close();
  }

  handleScroll(top) {
    const d = top - this.lastScrollTop;
    this.lastScrollTop = top;
    // Programmatic scrolls (restoring the position, jumps) shouldn't hide the toolbar.
    if (!this.panel?.isOpen && Date.now() > this.quietScrollUntil) {
      if (top < 60) this.setChrome(true);
      else if (d > 10) this.setChrome(false);
      else if (d < -14) this.setChrome(true);
    }
    this.scheduleTocCurrent();
    this.saveProgress();
  }

  showPage(n, total) {
    this.scheduleTocCurrent();
    this.pill.textContent = `${n} / ${total}`;
    this.pill.classList.add('show');
    clearTimeout(this.pillTimer);
    this.pillTimer = setTimeout(() => this.pill.classList.remove('show'), 1400);
  }

  showLoading(text) {
    this.loading.hidden = false;
    this.loadingBar = h('div');
    this.loadingText = h('div', { text });
    this.loading.replaceChildren(
      h('div', { class: 'box' }, h('div', { class: 'spinner' }), this.loadingText, h('div', { class: 'bar' }, this.loadingBar)),
    );
  }

  setLoadingProgress(f) {
    if (this.loadingBar) this.loadingBar.style.width = `${Math.round(Math.min(1, f) * 100)}%`;
  }

  hideLoading() {
    this.loading.hidden = true;
  }

  showError(message, retry) {
    this.hideLoading();
    const box = h('div', { class: 'reader-error' }, h('div', {}, h('p', { text: message })));
    const actions = h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } });
    actions.append(h('button', { class: 'btn btn-secondary btn-sm', onClick: () => (location.hash = '#/') }, t('common.back')));
    if (retry) {
      actions.append(
        h('button', {
          class: 'btn btn-primary btn-sm',
          onClick: () => {
            box.remove();
            retry();
          },
        }, t('common.retry')),
      );
    }
    box.firstChild.append(actions);
    this.stage.append(box);
  }

  persistProgress(keepalive) {
    this.saveProgress.cancel?.();
    if (!this.view || !this.paper) return;
    const p = this.view.getProgress();
    if (!p) return;
    const progress = { mode: this.mode, [this.mode]: p };
    this.paper.progress = { ...(this.paper.progress || {}), ...progress };
    api.patchPaper(this.paperId, { progress }, { keepalive }).catch(() => {});
  }

  showTip(text) {
    const tip = h('div', { class: 'tip', text });
    this.stage.append(tip);
    const remove = () => tip.remove();
    setTimeout(remove, 6500);
    tip.addEventListener('click', remove);
  }

  // ---- selection & AI ----

  async onSelectionAction(act, info) {
    if (act === 'copy') {
      toast((await copyText(info.text)) ? t('common.copied') : t('common.copyFailed'));
      return;
    }
    // A selection in the translation: the original of its blocks; in a chapter translated from a scan,
    // those blocks' parts of the original pages.
    if (act === 'source') {
      this.showPeek({ title: t('action.source'), ...(info.orig ? { parts: info.orig } : { text: info.context }) });
      return;
    }
    this.panel.startQuote(act, info);
  }

  async jumpToLocation(loc) {
    if (!loc) return;
    if (loc.kind && loc.kind !== this.mode) {
      if (loc.kind === 'html' && !this.htmlAvailable) return;
      await this.setMode(loc.kind);
      // The new view restores its saved position on the next frame; jump after that.
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    // A spot in the translation (a mark on it, a question about it) is hidden while the book reads
    // in the original only: side by side, then.
    if (isTranslation(loc.anchorId) && this.translations?.mode === 'src') this.translations.setMode('both');
    this.view?.goToLocation(loc);
  }

  // ---- books ----

  // In a book a selection also carries its chapter; in the text view it gets an anchor for
  // annotations, and the block it sits in is the context sent to the model. One in the translation
  // beside the text (info.inTranslation) is anchored there and sent with the original its blocks
  // translate.
  describe(sel) {
    if (this.capture) return null;
    const info = this.view?.describeSelection(sel) || null;
    if (!info || !this.isBook) return info;
    // (anchored as the view reads it: a formula it starts or ends inside, whole)
    const whole = { anchorNode: sel.anchorNode, focusNode: sel.focusNode, getRangeAt: () => wholeFormulas(sel.getRangeAt(0)) };
    const found = this.view.kind === 'html' ? bookSelection(whole, this.view.article) : { anchor: null };
    if (!found) return null;
    const { anchor, source } = found;
    if (!anchor) {
      const start = sel.getRangeAt(0).startContainer;
      const section = (start.nodeType === 1 ? start : start.parentElement)?.closest('[data-chapter]');
      return { ...info, chapter: section?.dataset.chapter || this.readingChapter() };
    }
    const inTranslation = isTranslation(anchor.start.b);
    const orig = inTranslation ? null : this.originalParts(anchor);
    // (a chapter written in the reader's language: nothing to translate)
    const inTarget = !inTranslation && !orig && this.writtenInTarget(anchor.chapter);
    return {
      ...info,
      text: anchor.text,
      context: inTranslation ? source : anchor.paragraph,
      getContext: null,
      chapter: anchor.chapter,
      // Its place is its first block (or that block's translation), wherever the range itself began.
      location: { ...info.location, anchorId: anchor.start.b },
      ...(inTranslation && { inTranslation }),
      ...(orig && { orig }),
      ...(inTarget && { inTarget }),
      anchor,
      marks: this.annotations.marksIn(anchor),
      bookmark: this.annotations.bookmarkAt(anchor.start.b),
    };
  }

  // Whether a chapter of the open book is written in the reader's language (translation.js), once
  // per chapter.
  writtenInTarget(chapter) {
    this.targetChapters ||= new Map();
    if (!this.targetChapters.has(chapter)) {
      const section = this.view.article.querySelector(`section[data-chapter="${CSS.escape(chapter)}"]`);
      this.targetChapters.set(chapter, !!section && writtenInTarget(section));
    }
    return this.targetChapters.get(chapter);
  }

  // Where the blocks of a selection stand in the original, in a chapter translated from a scan
  // (data-orig, server/book.js): their parts of its pages, "page:x0,y0,x1,y1", each once.
  originalParts(anchor) {
    if (!this.view.article.querySelector('[data-orig]')) return null;
    const at = (b) => Number(b.slice(b.lastIndexOf('.') + 1));
    const chapter = chapterOf(anchor.start.b);
    const parts = [];
    for (let i = at(anchor.start.b); i <= at(anchor.end.b); i++) {
      const el = this.view.article.ownerDocument.getElementById(`${chapter}.${i}`);
      for (const p of (el?.dataset.orig || '').split(' ').filter(Boolean)) if (!parts.includes(p)) parts.push(p);
    }
    return parts.length ? parts : null;
  }

  // The first block of book text at the top of the screen. Read in the translation only, the blocks
  // are hidden, and the translation after each stands for it.
  firstBlock() {
    const view = this.view;
    if (view?.kind !== 'html') return null;
    const top = view.scrollEl.getBoundingClientRect().top + view.topInset();
    for (const el of view.article.querySelectorAll('[data-b], .tr-block')) {
      if (el.getBoundingClientRect().bottom > top + 4) return el.dataset.b ? el : el.previousElementSibling;
    }
    return null;
  }

  // A translated chapter on screen: the pairing of its clauses is asked for now (taps.js), not on
  // its first tap. Only the one on screen: each may be a long request, and the browser has six.
  prefetchClauses(id) {
    // (a book of one chapter has no tabs and reads that one; a journal article's translation may sit in
    // its runs of text, columns.js)
    const sec = `section[data-chapter="${CSS.escape(id)}"]`;
    if ((id === this.view?.chapter || !this.view?.tabs) && this.view?.article.querySelector(`${sec} > .tr-block, ${sec} > .col-run > .tr-block`)) this.taps?.prefetch(id);
  }

  // The chapter at the top of the screen; in PDF mode, where the text was last read.
  readingChapter() {
    const id = this.firstBlock()?.dataset.b || this.paper.progress?.html?.anchorId || '';
    return /^c\d+/.exec(id)?.[0] || 'c1';
  }

  annotate(act, color, info) {
    const store = this.annotations;
    const a = info.anchor;
    if (!store || !a) return;
    // A highlight or underline goes on the other language too (taps.js), and comes off with it.
    const others = act === 'bookmark' ? [] : this.taps?.counterpart(a) || [];
    if (act === 'unmark') store.remove(store.withPartners([...(info.marks || []), ...others.flatMap((o) => store.marksIn(o))]));
    else if (act === 'bookmark') this.toggleBookmark(a.start.b, a.paragraph);
    else {
      const id = uid('a');
      const fields = { type: act, color: act === 'highlight' ? color : null, chapter: a.chapter };
      store.add({ ...fields, id, start: a.start, end: a.end, quote: a.text }, ...others.map((o, k) => ({ ...fields, id: `${id}p${k}`, ...o })));
    }
    info.marks = store.marksIn(a);
    info.bookmark = store.bookmarkAt(a.start.b);
  }

  // An answer about a passage goes into the text after it, as a blue note, once looked over.
  async addNote(quote, text) {
    const store = this.annotations;
    const a = quote.anchor;
    if (!store || !a) return;
    const edited = await textDialog({ title: t('note.title'), text, max: MAX_NOTE });
    if (!edited) return;
    store.add({ type: 'note', chapter: a.chapter, start: a.start, end: a.end, quote: quote.text, text: edited });
    toast(t('note.added'));
  }

  async editNote(a) {
    const edited = await textDialog({ title: t('note.edit'), text: a.text || '', max: MAX_NOTE });
    if (edited && edited !== a.text) this.annotations.update(a.id, { text: edited });
  }

  async deleteNote(a) {
    if (await confirmDialog({ title: t('note.deleteConfirm'), message: (a.text || '').slice(0, 140), okText: t('common.delete'), danger: true })) {
      this.annotations.remove([a.id]);
    }
  }

  // Returns true when a bookmark was added, false when one was removed.
  toggleBookmark(blockId, text) {
    const store = this.annotations;
    const existing = store.bookmarkAt(blockId);
    if (existing) store.remove([existing.id]);
    else {
      // (a block drawn from LaTeX: its marks are noise in a list; elsewhere "$5" is a price)
      const latex = this.view?.article?.querySelector(`[data-b="${blockId}"], [data-k="${blockId}"]`)?.querySelector('.mk, k-tex');
      store.add({ type: 'bookmark', chapter: chapterOf(blockId), start: { b: blockId, o: 0 }, end: { b: blockId, o: 0 }, quote: (latex ? text.replace(/\*\*|\$/g, '') : text).slice(0, 200) });
    }
    return !existing;
  }

  bookmarkHere() {
    const el = this.firstBlock();
    if (!el || !this.annotations) return;
    toast(this.toggleBookmark(el.dataset.b, el.textContent) ? t('ann.bookmarked') : t('ann.bookmarkRemoved'));
  }

  onAnnotationsChange() {
    if (this.destroyed) return;
    if (this.view?.kind === 'html') {
      // (marks paired here change the list, which comes back here)
      try {
        if (this.pairMarks()) return;
      } catch (err) {
        console.warn('pairing marks failed', err);
      }
      paintAnnotations(this.view.article, this.annotations.items, {
        render: (text) => h('div', { class: 'md', html: renderMarkdown(text) }),
        edit: (a) => this.editNote(a),
        remove: (a) => this.deleteNote(a),
      });
    }
    if (this.annBody?.isConnected) this.fillAnnotations();
  }

  // Marks made before their other language was in the page (or before marks were paired: made
  // elsewhere, brought in) get their other side once both are here and the chapter's pairing has
  // come (taps.js settled; it is asked for where the chapter is read, not from here). None where
  // the other side already has a mark of its own. Partners take the mark's times, so a removal
  // made elsewhere meanwhile still wins. Returns whether any were added.
  // ponytail: a mark is paired once; blocks of it translated after that (a later part) stay unpaired.
  pairMarks() {
    const store = this.annotations;
    if (!this.taps || !store) return false;
    const paired = new Set(store.items.map((a) => partnerOf(a.id)).filter(Boolean));
    const add = [];
    for (const a of store.items) {
      if (a.deleted || a.type === 'bookmark' || a.type === 'note' || partnerOf(a.id) || paired.has(a.id) || !this.taps.settled(a.chapter)) continue;
      const others = this.taps.counterpart(a, false);
      if (!others.length || others.some((o) => store.marksIn(o).length)) continue;
      add.push(...others.map((o, k) => ({ type: a.type, color: a.color, chapter: a.chapter, id: `${a.id}p${k}`, ...o, createdAt: a.createdAt, updatedAt: a.updatedAt })));
    }
    if (add.length) store.add(...add);
    return add.length > 0;
  }

  // The server being down is expected (the list waits in this browser); anything else, such
  // as a data folder a sync client made online-only, is worth one message.
  annotationsFailed(err) {
    if (!err.status || this.annWarned) return;
    this.annWarned = true;
    toast(t('ann.syncFailed', { msg: err.message }), { type: 'error', duration: 6000 });
  }

  openAnnotations() {
    const scrim = h('div', { class: 'scrim' });
    const body = h('div', { class: 'drawer-body' });
    const drawer = h('nav', { class: 'drawer', 'aria-label': t('reader.annotations') });
    const close = () => {
      scrim.remove();
      drawer.remove();
    };
    scrim.addEventListener('click', close);
    drawer.append(h('div', { class: 'drawer-head' }, h('span', { class: 'title', text: t('reader.annotations') }), iconButton('close', { title: t('common.close'), onClick: close })), body);
    this.root.append(scrim, drawer);
    this.annBody = body;
    this.annClose = close;
    this.fillAnnotations();
  }

  fillAnnotations() {
    const body = this.annBody;
    // (a mark paired with another is listed once, as the one it was made with)
    // (in the book's order: a chapter put in later may stand before ones with lower numbers)
    const order = new Map([...(this.chapterTitles?.keys() || [])].map((c, i) => [c, i]));
    const items = this.annotations.live.filter((a) => this.annotations.groupOf(a.id) === a.id).sort((a, b) => (order.get(a.chapter) ?? 0) - (order.get(b.chapter) ?? 0) || comparePoints(a.start, b.start));
    body.replaceChildren();
    if (!items.length) {
      body.append(h('div', { class: 'toc-empty', text: t('ann.empty') }));
      return;
    }
    for (const a of items) {
      const kind = a.type === 'highlight' ? h('span', { class: `ann-dot ${a.color || 'yellow'}` }) : iconEl(a.type === 'note' ? 'pushpin' : a.type);
      const del = iconButton('trash', { title: t('common.delete') });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        // (a note is asked about first, as in the text)
        if (a.type === 'note') this.deleteNote(a);
        else this.annotations.remove(this.annotations.withPartners([a.id]));
      });
      const meta = [this.chapterTitles?.get(a.chapter), timeAgo(a.updatedAt)].filter(Boolean).join(' · ');
      // A note by the start of its own text, not by the passage it was made on.
      const note = a.type === 'note';
      const row = h(
        'div',
        { class: 'ann-item', role: 'button', tabindex: '0' },
        h('span', { class: 'ann-kind' }, kind),
        h(
          'div',
          { class: 'ann-main' },
          h('div', { class: `ann-quote ${a.type}`, lang: note || isTranslation(a.start.b) ? langs.tgt : null, text: note ? (a.text || '').slice(0, 300) : a.quote }),
          h('div', { class: 'ann-meta', text: meta }),
        ),
        del,
      );
      const go = () => {
        this.annClose();
        this.jumpToLocation({ kind: 'html', anchorId: a.start.b });
      };
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      body.append(row);
    }
  }

  // Web books: fetch the pages after the last one and reload the text in place.
  async fetchNext(count) {
    toast(t('reader.fetchingNext'));
    try {
      const { paper } = await api.nextChapters(this.paperId, count);
      if (this.destroyed) return;
      const before = this.paper.book?.chapters || 0;
      // Same object: the panel and the popup hold on to it.
      Object.assign(this.paper, paper, { progress: this.paper.progress });
      const added = (this.paper.book?.chapters || 0) - before;
      toast(added > 0 ? t('reader.fetchedNext', { n: added }) : t('reader.noNext'));
      if (added > 0 && this.mode === 'html') await this.setMode('html');
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  toggleCapture() {
    if (this.capture) {
      this.capture.cancel();
      return;
    }
    if (this.view?.kind !== 'pdf') return;
    document.getSelection()?.removeAllRanges();
    this.setChrome(true);
    this.captureBtn.classList.add('on');
    this.capture = startCapture(this.stage, {
      onDone: async (rect) => {
        this.capture = null;
        this.captureBtn.classList.remove('on');
        try {
          const shot = await this.view.captureRegion(rect);
          if (!shot) return;
          this.panel.startImage('pick', { ...shot, location: { kind: 'pdf', page: shot.page } });
        } catch (err) {
          toast(t('reader.captureFailed', { msg: err.message }), { type: 'error' });
        }
      },
      onCancel: () => {
        this.capture = null;
        this.captureBtn.classList.remove('on');
      },
    });
  }

  // ---- previews ----

  async previewDest(dest) {
    const view = this.view;
    if (view?.kind !== 'pdf') return;
    let info = null;
    try {
      info = await view.describeDest(dest);
    } catch {
      info = null;
    }
    if (!info || !info.text) {
      view.goToDest(dest);
      return;
    }
    this.showPeek({
      title: t('reader.page', { n: info.page }),
      text: info.text,
      go: () => view.goToDest(dest),
      location: { kind: 'pdf', page: info.page },
    });
  }

  showPeek(info) {
    this.closePeek();
    const body = h('div', { class: 'peek-body' });
    if (info.image) {
      body.append(
        h('img', {
          src: info.image,
          alt: '',
          style: { display: 'block', maxWidth: '100%', maxHeight: '180px', margin: '4px auto 10px', background: '#fff', borderRadius: '6px' },
        }),
      );
    }
    for (const part of info.parts || []) body.append(originalPart(this.paperId, part));
    if (!info.parts) body.append(h('div', { text: info.text || '' }));
    const actions = h('div', { class: 'peek-actions' });
    if (info.text) {
      actions.append(
        h('button', {
          class: 'btn btn-sm btn-secondary',
          html: `${icon('translate', 16)}<span>${t('action.translate')}</span>`,
          onClick: () => {
            this.closePeek();
            this.panel.startQuote('translate', { text: info.text, context: '', location: info.location || null });
          },
        }),
        h('button', {
          class: 'btn btn-sm btn-secondary',
          html: `${icon('copy', 16)}<span>${t('common.copy')}</span>`,
          onClick: async () => toast((await copyText(info.text)) ? t('common.copied') : t('common.copyFailed')),
        }),
      );
    }
    if (info.go) {
      actions.append(
        h('button', {
          class: 'btn btn-sm btn-primary',
          text: t('reader.jumpThere'),
          onClick: () => {
            this.closePeek();
            info.go();
          },
        }),
      );
    }
    this.peekOwner = info.owner || null;
    const peek = h(
      'div',
      { class: info.parts ? 'peek peek-orig' : 'peek', role: 'dialog', 'aria-label': info.title },
      h('div', { class: 'peek-head' }, h('span', { class: 'title', text: info.title }), iconButton('close', { title: t('common.close'), onClick: () => this.closePeek() })),
      body,
      actions,
    );
    this.root.append(peek);
    this.peekEl = peek;
    setTimeout(() => {
      // (a tap on the block it shows the original of closes it by itself: showOriginal)
      this.peekOutside = (e) => {
        if (this.peekEl && !this.peekEl.contains(e.target) && !this.peekOwner?.contains(e.target)) this.closePeek();
      };
      document.addEventListener('pointerdown', this.peekOutside, true);
    }, 0);
  }

  // The parts of the original a block translated from a scan stands for (a tap on it); the same
  // block tapped again closes them.
  showOriginal(block) {
    if (this.peekEl && this.peekOwner === block) return this.closePeek();
    this.showPeek({ title: t('action.source'), parts: block.dataset.orig.split(' ').filter(Boolean), owner: block });
  }

  closePeek() {
    this.peekEl?.remove();
    this.peekEl = null;
    this.peekOwner = null;
    if (this.peekOutside) document.removeEventListener('pointerdown', this.peekOutside, true);
    this.peekOutside = null;
  }

  showBackChip(back) {
    this.quietScrollUntil = Date.now() + 800;
    this.backChip?.remove();
    clearTimeout(this.backTimer);
    const chip = h('button', { class: 'back-chip', type: 'button', html: `${icon('undo')}<span>${t('reader.backToSpot')}</span>` });
    chip.addEventListener('click', () => {
      chip.remove();
      back();
    });
    this.root.append(chip);
    this.backChip = chip;
    this.backTimer = setTimeout(() => chip.remove(), 9000);
  }

  openLightbox(img, caption) {
    const src = img.currentSrc || img.src;
    const figure = img.closest('figure, .ltx_figure, .ltx_table');
    const location = { kind: 'html', anchorId: figure?.id || img.id || null, section: t('reader.figure') };
    const close = () => {
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    const wrap = h('div', { class: 'lightbox-img' }, h('img', { src, alt: caption || '' }));
    wrap.addEventListener('dblclick', () => wrap.classList.toggle('zoomed'));
    const ask = async (action) => {
      close();
      try {
        const data = await imageToBase64(src);
        this.panel.startImage(action, { ...data, caption, text: '', location });
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    };
    const box = h(
      'div',
      { class: 'lightbox', role: 'dialog', 'aria-label': t('reader.image') },
      h('div', { class: 'lightbox-bar' }, h('span', { class: 'title', text: t('reader.imageHint') }), iconButton('close', { title: t('common.close'), onClick: close })),
      wrap,
      h(
        'div',
        { class: 'lightbox-actions' },
        h('button', { class: 'btn btn-primary', html: `${icon('bulb', 17)}<span>${t('reader.explainImage')}</span>`, onClick: () => ask('explain') }),
        h('button', { class: 'btn btn-secondary', html: `${icon('message', 17)}<span>${t('reader.ask')}</span>`, onClick: () => ask('ask') }),
      ),
      caption ? h('div', { class: 'lightbox-cap', text: caption }) : null,
    );
    document.addEventListener('keydown', onKey);
    document.body.append(box);
  }

  // ---- table of contents ----

  // Pinned, the contents sit beside the text; that needs a window at least this wide.
  canPinToc() {
    return window.matchMedia('(min-width: 760px)').matches;
  }

  tocSideShown() {
    return this.tocPinned && this.canPinToc();
  }

  openToc() {
    // With the pinned list on screen, the toolbar button puts it away.
    if (this.tocSideShown()) {
      this.setTocPinned(false);
      return;
    }
    const view = this.view;
    if (!view) return;
    const scrim = h('div', { class: 'scrim' });
    const body = h('div', { class: 'drawer-body' });
    const drawer = h('nav', { class: 'drawer', 'aria-label': t('reader.toc') });
    const close = () => {
      scrim.remove();
      drawer.remove();
    };
    scrim.addEventListener('click', close);
    const pin = this.canPinToc()
      ? iconButton('pushpin', {
          title: t('reader.pinToc'),
          onClick: () => {
            close();
            this.setTocPinned(true);
          },
        })
      : null;
    drawer.append(h('div', { class: 'drawer-head' }, h('span', { class: 'title', text: t('reader.toc') }), pin, iconButton('close', { title: t('common.close'), onClick: close })), body);
    this.root.append(scrim, drawer);
    this.fillToc(body, view, close);
  }

  setTocPinned(on) {
    this.tocPinned = on;
    local.set('tocPinned', on);
    this.root.classList.toggle('toc-pinned', on);
    if (on) {
      this.renderTocSide();
    } else {
      this.tocSide?.remove();
      this.tocSide = null;
      this.tocItems = null;
    }
  }

  renderTocSide() {
    this.tocSide?.remove();
    const body = h('div', { class: 'drawer-body' });
    this.tocSide = h(
      'nav',
      { class: 'toc-side', 'aria-label': t('reader.toc') },
      h(
        'div',
        { class: 'drawer-head' },
        h('span', { class: 'title', text: t('reader.toc') }),
        iconButton('pushpin', { title: t('reader.unpinToc'), className: 'on', onClick: () => this.setTocPinned(false) }),
      ),
      body,
    );
    this.root.append(this.tocSide);
    const view = this.view;
    if (!view) return;
    this.fillToc(body, view, null).then((items) => {
      if (this.view !== view || !this.tocSide?.contains(body)) return;
      this.tocItems = items;
      this.tocCurrent = null;
      this.updateTocCurrent();
    });
  }

  // Fills a contents list. `done` runs after a jump (closes the drawer); the pinned list stays.
  async fillToc(body, view, done) {
    if (view.kind === 'pdf') {
      const input = h('input', {
        class: 'input',
        type: 'number',
        min: '1',
        max: String(view.numPages),
        value: String(view.currentPage),
        inputmode: 'numeric',
        'aria-label': t('reader.pageNo'),
      });
      const go = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('reader.jump') });
      const jump = () => {
        view.goToPage(Number(input.value) || 1);
        done?.();
      };
      go.addEventListener('click', jump);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && jump());
      body.append(h('div', { class: 'page-jump' }, h('span', { text: t('reader.pageWord') }), input, h('span', { text: t('reader.pageOf', { n: view.numPages }) }), go));
    }
    let items = [];
    try {
      items = await view.getOutline();
    } catch {
      items = [];
    }
    if (this.view !== view) return [];
    if (!items.length) {
      body.append(h('div', { class: 'toc-empty', text: view.kind === 'pdf' ? t('reader.noOutlinePdf') : t('reader.noOutlineHtml') }));
      return [];
    }
    const out = [];
    for (const it of items) {
      if (view.kind === 'pdf' && !it.dest) continue;
      const btn = h('button', { class: `toc-item l${it.level}`, type: 'button' }, it.page ? h('span', { class: 'pg', text: String(it.page) }) : null, it.label || it.title);
      btn.addEventListener('click', () => {
        done?.();
        if (view.kind === 'pdf') view.goToDestDirect(it.dest);
        else view.jumpTo(it.el);
      });
      body.append(btn);
      out.push({ ...it, btn });
    }
    return out;
  }

  scheduleTocCurrent() {
    if (!this.tocItems || this.tocFrame) return;
    this.tocFrame = requestAnimationFrame(() => {
      this.tocFrame = 0;
      this.updateTocCurrent();
    });
  }

  // Marks the section being read in the pinned list.
  updateTocCurrent() {
    const view = this.view;
    if (!this.tocItems?.length || !view || !this.tocSideShown()) return;
    let current = null;
    if (view.kind === 'pdf') {
      const page = view.currentPage;
      for (const it of this.tocItems) if (it.page && it.page <= page && (!current || it.page >= current.page)) current = it;
    } else {
      const line = view.scrollEl.getBoundingClientRect().top + view.topInset() + 24;
      // Entries come in document order; a book's other chapters are hidden.
      for (const it of this.tocItems) {
        // (a heading inside a hidden chapter has no box at all)
        if (it.el.hidden || !it.el.getClientRects().length) continue;
        if (it.el.getBoundingClientRect().top > line) break;
        current = it;
      }
    }
    if (current === this.tocCurrent) return;
    this.tocCurrent?.btn.classList.remove('current');
    current?.btn.classList.add('current');
    this.tocCurrent = current;
    current?.btn.scrollIntoView({ block: 'nearest' });
  }

  // ---- menu ----

  openMore() {
    const view = this.view;
    const items = [];
    if (view?.kind === 'pdf') {
      items.push({ icon: 'maximize', label: t('reader.fitWidth'), onClick: () => view.fitWidth() });
      items.push({ icon: 'scan', label: t('reader.capture'), onClick: () => this.toggleCapture() });
      if (isDarkTheme()) {
        items.push({
          icon: 'moon',
          label: this.pdfInvert ? t('reader.invertOff') : t('reader.invertOn'),
          onClick: () => {
            this.pdfInvert = !this.pdfInvert;
            local.set('pdfInvert', this.pdfInvert);
            this.updateInvert();
          },
        });
      }
    }
    if (view?.kind === 'html') {
      const size = h('span', { text: String(local.get('readSize', 17)), style: { minWidth: '24px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' } });
      const row = h(
        'div',
        { class: 'menu-row' },
        h('span', { class: 'label', html: `${icon('type')}<span>${t('reader.fontSize')}</span>` }),
        iconButton('minus', { title: t('reader.smaller'), onClick: () => (size.textContent = String(view.setFontSize(-1))) }),
        size,
        iconButton('plus', { title: t('reader.larger'), onClick: () => (size.textContent = String(view.setFontSize(1))) }),
      );
      items.push({ el: row });
      items.push({
        icon: 'book',
        label: local.get('readFont', 'serif') === 'serif' ? t('reader.useSans') : t('reader.useSerif'),
        onClick: () => view.toggleFont(),
      });
    }
    if (this.annotations) items.push({ icon: 'bookmark', label: t('reader.annotations'), onClick: () => this.openAnnotations() });
    if (this.isBook && this.paper.source === 'web') items.push({ el: this.nextPagesRow() });
    if (this.isBook) items.push({ el: this.langsRow() });
    const theme = local.get('theme', 'system');
    items.push({
      icon: isDarkTheme() ? 'moon' : 'sun',
      label: t('reader.theme', { name: themeLabel(theme) }),
      right: t('reader.switch'),
      onClick: () => {
        const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
        local.set('theme', next);
        applyTheme(next);
        toast(t('reader.theme', { name: themeLabel(next) }));
      },
    });
    items.push('sep');
    items.push({ el: menuSwitch({ icon: 'pushpin', label: t('reader.pinBar'), checked: this.barPinned, onChange: (on) => this.setBarPinned(on) }) });
    items.push({ el: menuSwitch({ icon: 'translate', label: t('reader.instant'), checked: this.instantOn, onChange: (on) => this.setInstant(on) }) });
    if (this.taps) items.push({ el: menuSwitch({ icon: 'translate', label: t('reader.tap'), checked: local.get('tapTranslate', true), onChange: (on) => local.set('tapTranslate', on) }) });
    if (canSwitchProvider()) {
      items.push({
        icon: 'repeat',
        label: t('reader.provider'),
        right: usableProviders().find((p) => p.active)?.label || '',
        onClick: () => openProviderMenu(this.moreBtn, { openSettings: () => openSettings({ section: 'ai' }) }),
      });
    }
    items.push('sep');
    items.push({ icon: 'sparkles', label: t(this.isBook ? 'reader.askBook' : 'reader.askPaper'), onClick: () => this.panel.startChat() });
    items.push({ icon: 'clock', label: t('reader.history'), onClick: () => this.panel.showHistory() });
    items.push('sep');
    if (this.paper?.absUrl) items.push({ icon: 'external', label: t('common.openSource'), onClick: () => window.open(this.paper.absUrl, '_blank', 'noopener') });
    if (this.hasPdf) items.push({ icon: 'download', label: t('common.downloadPdf'), onClick: () => window.open(api.pdfDownloadUrl(this.paperId), '_blank') });
    items.push({ icon: 'sliders', label: t('common.settings'), onClick: () => openSettings() });
    openMenu(this.moreBtn, items);
  }

  // "Languages [en] → [ko] [Set]" for a book: the language it is written in and the one it is
  // translated into, its own from now on (the page opens again with them). Once chapters of it are
  // translated the server keeps its target (and says so).
  langsRow() {
    const code = (value, label) => h('input', { class: 'input', value, 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
    const src = code(langs.src, t('settings.bookSource'));
    const tgt = code(langs.tgt, t('settings.bookTarget'));
    const go = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('reader.langsSet') });
    go.addEventListener('click', async () => {
      closeMenus();
      try {
        await api.patchPaper(this.paperId, { langs: { src: src.value.trim(), tgt: tgt.value.trim() } });
        toast(t('reader.langsSaved'));
        location.reload();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    });
    return h('div', { class: 'menu-row' }, h('span', { class: 'label', html: `${icon('translate')}<span>${t('reader.langs')}</span>` }), src, h('span', { text: '→' }), tgt, go);
  }

  // "Next pages [5] [Fetch]" for web books.
  nextPagesRow() {
    const count = h('input', {
      class: 'input',
      type: 'number',
      min: '1',
      max: '20',
      value: String(local.get('nextPages', 5)),
      inputmode: 'numeric',
      'aria-label': t('reader.nextCount'),
    });
    const go = h('button', { class: 'btn btn-sm btn-secondary', type: 'button', text: t('reader.fetch') });
    go.addEventListener('click', () => {
      const n = Math.max(1, Math.min(20, Math.round(Number(count.value)) || 1));
      local.set('nextPages', n);
      closeMenus();
      this.fetchNext(n);
    });
    return h('div', { class: 'menu-row' }, h('span', { class: 'label', html: `${icon('download')}<span>${t('reader.nextPages')}</span>` }), count, go);
  }

  onKey(e) {
    if (e.key === 'Escape') {
      if (this.peekEl) this.closePeek();
      else if (this.capture) this.capture.cancel();
      else if (this.panel?.isOpen && document.activeElement !== this.panel.input) this.panel.close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && this.view?.kind === 'pdf' && ['=', '+', '-', '0'].includes(e.key)) {
      e.preventDefault();
      if (e.key === '0') this.view.fitWidth();
      else this.view.zoomBy(e.key === '-' ? 1 / 1.15 : 1.15);
    }
  }

  destroy() {
    this.destroyed = true;
    this.persistProgress(true);
    this.capture?.cancel();
    this.closePeek();
    closeMenus();
    clearTimeout(this.pillTimer);
    clearTimeout(this.backTimer);
    cancelAnimationFrame(this.tocFrame);
    this.translations?.destroy();
    this.taps?.destroy();
    this.view?.destroy();
    this.annotations?.destroy();
    clearAnnotationPaint();
    this.instant?.destroy();
    this.panel?.destroy();
    this.selbar?.destroy();
    for (const off of this.listeners) off();
    this.root?.remove();
    document.querySelectorAll('.drawer, .scrim, .lightbox').forEach((e) => e.remove());
    document.title = t('app.name');
  }
}
