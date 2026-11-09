// Reflowable reading view for arXiv's HTML rendering (LaTeXML output).
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import { isTranslation } from './anchors.js';
import { api } from './api.js';
import { columnPages } from './columns.js';
import { langs } from './langs.js';
import { h, local } from './ui.js';
import { normalizeText } from './selection.js';
import { t } from './i18n.js';
import { texBody } from './tex.js';

const DROP =
  'script, style, link, meta, iframe, frame, object, embed, form, input, button, textarea, select, noscript, template, ' +
  '.ltx_page_logo, .ltx_page_navbar, .ltx_page_footer, .ltx_TOC, .ltx_ERROR';
// A picture of a scanned book names its file (server/book.js); the same in server/papers.js.
// (o…: cut from the original of a translated chapter)
const FIGURE = /^(p\d{1,4}|o\d{1,4})-\d{1,2}\.png$/;

// Papers are author-supplied content. A separate DOMPurify instance, because the
// markdown renderer adds hooks to the shared one.
const purifier = DOMPurify(window);
const PURIFY = {
  IN_PLACE: true,
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  // TikZ pictures keep their labels (often with math) as HTML inside foreignObject. Allowing
  // that is safe here: the tree is cleaned in place and cloned, never serialized and parsed
  // again, which is where namespace tricks would bite.
  // k-tex: a formula of a book written with LaTeX, its text the LaTeX (tex.js draws it).
  ADD_TAGS: ['foreignObject', 'k-tex'],
  HTML_INTEGRATION_POINTS: { 'annotation-xml': true, foreignobject: true },
  // alttext holds each formula's LaTeX.
  ADD_ATTR: ['alttext'],
};

function nodeEl(node) {
  return node?.nodeType === 1 ? node : node?.parentElement || null;
}

// A copy of `range` that takes in whole a formula it starts or ends inside: what a selection is
// read as, and in a book anchored as (reader.js).
export function wholeFormulas(range) {
  const r = range.cloneRange();
  const startMath = nodeEl(r.startContainer)?.closest('math, k-tex');
  if (startMath) r.setStartBefore(startMath);
  const endMath = nodeEl(r.endContainer)?.closest('math, k-tex');
  if (endMath) r.setEndAfter(endMath);
  return r;
}

function texOf(mathEl) {
  return (
    mathEl.getAttribute('alttext') ||
    mathEl.querySelector('annotation[encoding="application/x-tex"]')?.textContent ||
    mathEl.textContent ||
    ''
  ).trim();
}

// Text of a node with MathML replaced by $LaTeX$, so the model sees real formulas.
export function textWithLatex(node, { keepBlocks = false } = {}) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll('math').forEach((m) => {
    const tex = texOf(m);
    const block = m.getAttribute('display') === 'block';
    m.replaceWith(document.createTextNode(block ? ` $$${tex}$$ ` : ` $${tex}$ `));
  });
  clone.querySelectorAll('.ltx_note_outer').forEach((e) => e.remove());
  if (keepBlocks) {
    clone
      .querySelectorAll('p, .ltx_para, h1, h2, h3, h4, h5, h6, li, figcaption, .ltx_caption, .ltx_equation, .ltx_equationgroup, tr, .ltx_bibitem')
      .forEach((e) => e.append(document.createTextNode('\n')));
    return clone.textContent
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return normalizeText(clone.textContent);
}

function sameDocument(abs, base) {
  const strip = (p) => p.replace(/\/$/, '').replace(/v\d+$/, '');
  return abs.origin === base.origin && strip(abs.pathname) === strip(base.pathname);
}

function sanitize(root, baseUrl, paperId) {
  const base = new URL(baseUrl);
  root.querySelectorAll(DROP).forEach((e) => e.remove());
  // The LaTeX in <annotation> duplicates alttext, and DOMPurify would leave it behind as visible text.
  root.querySelectorAll('annotation, annotation-xml').forEach((e) => e.remove());
  purifier.sanitize(root, PURIFY);
  // What's left is safe; point links and images at the right places.
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'srcset' || name === 'formaction' || name === 'action' || name === 'ping') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'xlink:href') {
        if (value.startsWith('#')) continue;
        let abs;
        try {
          abs = new URL(value, base);
        } catch {
          el.removeAttribute(attr.name);
          continue;
        }
        if (abs.protocol !== 'https:' && abs.protocol !== 'http:') {
          el.removeAttribute(attr.name);
          continue;
        }
        if (el.localName === 'image') {
          el.setAttribute(attr.name, api.assetUrl(paperId, abs.href));
          continue;
        }
        if (abs.hash && sameDocument(abs, base)) {
          el.setAttribute(attr.name, abs.hash);
          continue;
        }
        el.setAttribute(attr.name, abs.href);
        if (el.localName === 'a') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      } else if (name === 'src') {
        let abs;
        try {
          abs = new URL(value, base);
        } catch {
          el.removeAttribute('src');
          continue;
        }
        if (abs.protocol === 'https:' || abs.protocol === 'http:') el.setAttribute('src', api.assetUrl(paperId, abs.href));
        else if (abs.protocol !== 'data:') el.removeAttribute('src');
      } else if (name === 'style' && /url\s*\(/i.test(value)) {
        el.removeAttribute('style');
      }
    }
    if (el.localName === 'img') {
      // A scanned book's picture gets its src only here: one in paper.html would have gone to the
      // arXiv asset proxy above.
      if (el.hasAttribute('data-fig')) {
        const name = el.getAttribute('data-fig');
        if (!FIGURE.test(name)) {
          el.remove();
          continue;
        }
        el.setAttribute('src', api.figureUrl(paperId, name));
      }
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
    }
  }
}

// Parses arXiv's HTML into nodes that are safe to put in the reader.
export function prepareArticle(html, baseUrl, paperId) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const holder = doc.createElement('div');
  holder.append(doc.querySelector('article.ltx_document') || doc.querySelector('.ltx_page_content') || doc.body);
  sanitize(holder, baseUrl, paperId);
  return [...holder.childNodes].map((node) => document.importNode(node, true));
}

// A heading of a book written with LaTeX, for lists: its title as text (hidden marks left out, a
// formula as its LaTeX), and, where it has formulas, a copy for the contents to draw them.
function plainTitle(el) {
  if (!el.querySelector('k-tex, .mk')) return normalizeText(el.textContent);
  const copy = el.cloneNode(true);
  copy.querySelectorAll('.mk').forEach((m) => m.remove());
  copy.querySelectorAll('k-tex').forEach((k) => k.replaceWith(texBody(k.textContent).tex));
  return normalizeText(copy.textContent);
}

function drawnTitle(el) {
  if (!el.querySelector('k-tex')) return undefined;
  const span = document.createElement('span');
  for (const n of el.childNodes) span.append(n.cloneNode(true));
  span.querySelectorAll('.mk').forEach((m) => m.remove());
  return span;
}

// A chapter's tab: its number and title, a long title cut short.
export function tabLabel(n, title, max = 24) {
  const s = normalizeText(title);
  const short = s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
  // (a title with its own number, "2.7 Limits", "11:6 Rest" or "2장 함수의 극한", needs no
  // other in front)
  return /^(\d+[.:]\d+|\d+\s*장)\s/.test(s) ? short : `${n} ${short}`.trim();
}

export class HtmlView {
  // onChapter(id): a book now shows another chapter.
  constructor({ paper, host, onScroll, onTap, onPeek, onJump, onImage, onChapter }) {
    Object.assign(this, { paper, host, onScroll, onTap, onPeek, onJump, onImage, onChapter });
    this.kind = 'html';
  }

  async open(saved) {
    const data = await api.getHtml(this.paper.id);
    this.source = data.source;
    this.scrollEl = h('div', { class: 'html-scroll' });
    // (a book in its own language; an arXiv paper in English)
    this.article = h('div', { class: 'html-article', lang: this.paper.kind === 'book' ? langs.src : 'en' });
    this.article.append(...prepareArticle(data.html, data.baseUrl, this.paper.id));
    // Author blocks are "Name<br>Affiliation<br>email": keep only the name in bold.
    this.article.querySelectorAll('.ltx_authors .ltx_personname').forEach((pn) => {
      const br = pn.querySelector('br');
      if (!br) return;
      const rest = h('span', { class: 'pr-affil' });
      while (br.nextSibling) rest.append(br.nextSibling);
      br.remove();
      pn.append(rest);
    });
    this.scrollEl.append(this.article);
    this.applyTypography();
    this.host.append(this.scrollEl);
    this.setupChapters(saved);
    // A journal article's two columns, read as pages (columns.js).
    if (this.article.querySelector('.paper')) {
      const keep = (fn) => {
        const at = this.firstVisible();
        fn();
        if (at) this.scrollToEl(at.el, at.offset);
      };
      // (its formulas are drawn at once, tex.js)
      this.columns = this.chapters.map((sec) => columnPages(sec, this.scrollEl, keep));
    }

    this.ac = new AbortController();
    const signal = this.ac.signal;
    let selAtDown = false;
    this.article.addEventListener(
      'pointerdown',
      () => {
        const sel = document.getSelection();
        selAtDown = !!sel && !sel.isCollapsed;
      },
      { signal },
    );
    this.article.addEventListener('click', (e) => this.onClick(e, selAtDown), { signal });
    this.scrollEl.addEventListener('scroll', () => this.onScroll?.(this.scrollEl.scrollTop), { passive: true, signal });
    // Native pinch would zoom the whole app; text size has its own control.
    this.scrollEl.addEventListener('gesturestart', (e) => e.preventDefault(), { signal });
    this.restore(saved);
    return this;
  }

  applyTypography() {
    const size = local.get('readSize', 17);
    this.article.style.setProperty('--read-size', `${size}px`);
    this.article.classList.toggle('sans', local.get('readFont', 'serif') === 'sans');
  }

  setFontSize(delta) {
    const anchor = this.firstVisible();
    const size = Math.max(13, Math.min(26, local.get('readSize', 17) + delta));
    local.set('readSize', size);
    this.applyTypography();
    if (anchor) this.scrollToEl(anchor.el, anchor.offset);
    return size;
  }

  toggleFont() {
    const next = local.get('readFont', 'serif') === 'serif' ? 'sans' : 'serif';
    local.set('readFont', next);
    this.applyTypography();
    return next;
  }

  // A book of two or more chapters is read one chapter at a time, picked from a strip of tabs. The
  // others stay in the DOM, hidden: annotations, anchors and translations work on them.
  setupChapters(saved) {
    this.chapters = [...this.article.querySelectorAll('section[data-chapter]')];
    if (this.chapters.length < 2) return;
    this.tabs = new Map(
      this.chapters.map((sec, i) => {
        const title = normalizeText(sec.querySelector(':scope > h2')?.textContent);
        const tab = h('button', { class: 'chapter-tab', type: 'button', role: 'tab', title, onClick: () => this.openChapter(sec.dataset.chapter) }, h('span', { text: tabLabel(i + 1, title) }), h('span', { class: 'tab-mark' }));
        return [sec.dataset.chapter, tab];
      }),
    );
    this.tabStrip = h('div', { class: 'chapter-tabs', role: 'tablist', 'aria-label': t('reader.chapters') }, [...this.tabs.values()]);
    // A tap here is not a tap on the text, which shows or hides the toolbar.
    this.chapterNav = h('div', { class: 'chapter-nav', onClick: (e) => e.stopPropagation() });
    this.scrollEl.prepend(this.tabStrip);
    this.article.append(this.chapterNav);
    const at = saved?.anchorId && this.article.querySelector(`[id="${CSS.escape(saved.anchorId)}"]`);
    this.showChapter((at?.closest('section[data-chapter]') || this.chapters[0]).dataset.chapter);
  }

  // Shows chapter `id` of a book and hides the others. Every move in the book comes through here:
  // the tabs, the buttons at the end of a chapter, and scrollToEl for everything else.
  showChapter(id) {
    if (!this.tabs?.has(id) || id === this.chapter) return;
    const moved = !!this.chapter;
    this.chapter = id;
    const i = this.chapters.findIndex((sec) => sec.dataset.chapter === id);
    this.chapters.forEach((sec, k) => (sec.hidden = k !== i));
    for (const [c, tab] of this.tabs) {
      tab.classList.toggle('on', c === id);
      tab.setAttribute('aria-selected', String(c === id));
    }
    // Its tab to the middle of the strip (scrollIntoView would move the text as well).
    const tab = this.tabs.get(id);
    this.tabStrip.scrollLeft = tab.offsetLeft - (this.tabStrip.clientWidth - tab.offsetWidth) / 2;
    const go = (k, cls, text) => this.chapters[k] && h('button', { class: `btn btn-secondary ${cls}`, type: 'button', text, onClick: () => this.openChapter(this.chapters[k].dataset.chapter) });
    this.chapterNav.replaceChildren(...[go(i - 1, 'prev', t('reader.prevChapter')), go(i + 1, 'next', t('reader.nextChapter'))].filter(Boolean));
    if (moved) this.onChapter?.(id);
  }

  // From its tab or the end of the chapter before or after: a chapter from its start.
  openChapter(id) {
    this.showChapter(id);
    this.scrollEl.scrollTop = 0;
  }

  topInset() {
    const bar = document.querySelector('.topbar');
    // and a book's chapter tabs, under the bar
    return (bar ? bar.getBoundingClientRect().height : 60) + (this.tabStrip?.offsetHeight || 0);
  }

  firstVisible() {
    const top = this.scrollEl.getBoundingClientRect().top + this.topInset();
    // A book's translation (side by side, or in place of the text) stands for the block just before it.
    const blocks = this.article.querySelectorAll('[id].ltx_para, [id].ltx_title, section[id], figure[id], [id].ltx_equation, li[id], .tr-block');
    for (const el of blocks) {
      const r = el.getBoundingClientRect();
      // A section that began above the screen (a whole book chapter, say) would anchor the
      // position far away; something inside it keeps it across font sizes and screen widths.
      if (r.bottom > top + 4 && !(el.localName === 'section' && r.top < top)) return { el: el.matches('.tr-block') ? el.previousElementSibling : el, offset: r.top - top, height: r.height };
    }
    return null;
  }

  // Shows the chapter of `el` first. A block of a chapter read in the translation only is hidden: its translation,
  // just after it, is on screen in its place. Returns what it scrolled to.
  scrollToEl(el, offset = 0) {
    const chapter = el.closest('section[data-chapter]');
    if (chapter) this.showChapter(chapter.dataset.chapter);
    // (the next thing after it: out of a run of text of a journal article in columns at its end,
    // into one at its start, columns.js)
    const next = (n) => {
      const s = n.nextElementSibling || (n.parentElement?.matches('.col-run') ? n.parentElement.nextElementSibling : null);
      return s?.matches('.col-run') && s.firstElementChild ? s.firstElementChild : s;
    };
    let on = el;
    while (!on.getClientRects().length && next(on)) on = next(on);
    const elTop = on.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top + this.scrollEl.scrollTop;
    this.scrollEl.scrollTop = elTop - this.topInset() - offset;
    return on;
  }

  restore(saved) {
    requestAnimationFrame(() => {
      if (saved?.anchorId) {
        const el = this.article.querySelector(`[id="${CSS.escape(saved.anchorId)}"]`);
        if (el) {
          this.scrollToEl(el, saved.offset || 0);
          return;
        }
      }
      if (saved?.ratio) {
        this.scrollEl.scrollTop = saved.ratio * (this.scrollEl.scrollHeight - this.scrollEl.clientHeight);
      }
    });
  }

  getProgress() {
    const first = this.firstVisible();
    const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    return {
      anchorId: first?.el.id || null,
      offset: first ? Math.round(first.offset) : 0,
      ratio: max > 0 ? Math.round((this.scrollEl.scrollTop / max) * 10000) / 10000 : 0,
    };
  }

  jumpTo(el) {
    const back = this.scrollEl.scrollTop;
    const chapter = this.chapter;
    const shown = this.scrollToEl(el, 8);
    shown.classList.remove('flash');
    void shown.offsetWidth;
    shown.classList.add('flash');
    this.onJump?.(() => {
      this.showChapter(chapter);
      this.scrollEl.scrollTop = back;
    });
  }

  // In a book, also a block's translation ("c3.5k", translation.js), or the block while that isn't there.
  goToLocation(loc) {
    if (!loc?.anchorId) return;
    const at = (id) => this.article.querySelector(`[id="${CSS.escape(id)}"], [data-k="${CSS.escape(id)}"]`);
    const el = at(loc.anchorId) || (isTranslation(loc.anchorId) && at(loc.anchorId.slice(0, -1)));
    if (el) this.jumpTo(el);
  }

  captionFor(el) {
    const fig = el.closest('figure, .ltx_figure, .ltx_table');
    const cap = fig?.querySelector('figcaption, .ltx_caption');
    return cap ? textWithLatex(cap) : '';
  }

  onClick(e, selAtDown) {
    const noteMark = e.target.closest('.ltx_note_mark');
    if (noteMark) {
      e.preventDefault();
      const content = noteMark.closest('.ltx_note')?.querySelector('.ltx_note_content');
      if (content) {
        const clone = content.cloneNode(true);
        clone.querySelectorAll('.ltx_note_mark, .ltx_tag_note').forEach((x) => x.remove());
        this.onPeek?.({ title: t('peek.footnote'), text: textWithLatex(clone) });
      }
      return;
    }
    const a = e.target.closest('a');
    if (a) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('#')) return;
      e.preventDefault();
      let id;
      try {
        id = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      const target = id && this.article.querySelector(`[id="${CSS.escape(id)}"]`);
      if (!target) return;
      if (id.startsWith('bib.')) {
        this.onPeek?.({ title: t('peek.reference'), text: textWithLatex(target), go: () => this.jumpTo(target) });
      } else if (target.matches('figure, .ltx_figure, .ltx_table')) {
        const img = target.querySelector('img');
        this.onPeek?.({
          title: target.classList.contains('ltx_table') ? t('peek.table') : t('peek.figure'),
          text: this.captionFor(target) || textWithLatex(target).slice(0, 600),
          image: img?.getAttribute('src') || null,
          go: () => this.jumpTo(target),
        });
      } else if (target.matches('.ltx_equation, .ltx_equationgroup, [id^="S"][id*=".E"]')) {
        const eq = target.closest('.ltx_equation, .ltx_equationgroup') || target;
        this.onPeek?.({ title: t('peek.equation'), text: textWithLatex(eq), go: () => this.jumpTo(eq) });
      } else {
        this.jumpTo(target);
      }
      return;
    }
    const img = e.target.closest('img');
    if (img && this.article.contains(img)) {
      this.onImage?.(img, this.captionFor(img));
      return;
    }
    if (!selAtDown) {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) this.onTap?.();
    }
  }

  describeSelection(sel) {
    const range = sel.getRangeAt(0);
    if (!this.article.contains(range.commonAncestorContainer)) return null;
    const r = wholeFormulas(range);
    const text = textWithLatex(r.cloneContents());
    if (!text) return null;
    const startEl = nodeEl(r.startContainer);
    const block = startEl?.closest('.ltx_para, .ltx_p, figcaption, .ltx_caption, li, .ltx_bibitem, .ltx_abstract, .ltx_equation, td, th');
    const sectionEl = startEl?.closest('section');
    const heading = sectionEl?.querySelector(':scope > .ltx_title');
    const anchor = startEl?.closest('[id]');
    let section = heading ? normalizeText(heading.textContent).slice(0, 48) : '';
    if (!section && startEl?.closest('.ltx_abstract')) section = 'Abstract';
    return {
      text,
      rect: range.getBoundingClientRect(),
      location: { kind: 'html', anchorId: anchor?.id || null, section },
      getContext: async () => this.contextFor(block),
    };
  }

  contextFor(block) {
    if (!block) return '';
    const para = block.closest('.ltx_para') || block;
    const parts = [];
    const prev = para.previousElementSibling;
    const next = para.nextElementSibling;
    const usable = (el) => el && el.matches('.ltx_para, .ltx_equation, .ltx_equationgroup, .ltx_p');
    if (usable(prev)) parts.push(textWithLatex(prev));
    parts.push(textWithLatex(para));
    if (usable(next)) parts.push(textWithLatex(next));
    const ctx = parts.join('\n\n');
    return ctx.length > 3200 ? `${ctx.slice(0, 3200)}…` : ctx;
  }

  async getFullText(limit) {
    const clone = this.article.cloneNode(true);
    const bib = clone.querySelector('.ltx_bibliography');
    bib?.remove();
    let text = textWithLatex(clone, { keepBlocks: true });
    if (bib) {
      const refs = textWithLatex(bib, { keepBlocks: true });
      if (text.length + refs.length + 20 <= limit) text += `\n\nReferences\n${refs}`;
    }
    const truncated = text.length > limit;
    return { text: truncated ? text.slice(0, limit) : text, truncated };
  }

  getOutline() {
    const items = [];
    const abs = this.article.querySelector('.ltx_abstract');
    if (abs) items.push({ title: 'Abstract', level: 1, el: abs });
    this.article
      .querySelectorAll('section.ltx_section, section.ltx_appendix, section.ltx_bibliography, section.ltx_subsection')
      .forEach((sec) => {
        const heading = sec.querySelector(':scope > .ltx_title');
        if (!heading) return;
        items.push({ title: normalizeText(heading.textContent), level: sec.classList.contains('ltx_subsection') ? 2 : 1, el: sec });
        // A book chapter's own headings below it (a sermon's heads, say), but the one it opens with
        // where that says its title again, and the Notes that end a chapter. (A journal article is
        // one chapter: its title and its sections' heads stand beside its journal's line.)
        if (!sec.dataset.chapter) return;
        const key = (s) => normalizeText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        // (a journal article in two columns has some in runs of text, columns.js)
        const first = sec.querySelector(':scope > [data-b], :scope > .col-run > [data-b]');
        for (const head of sec.querySelectorAll(':scope > h3[data-b], :scope > .col-run > h3[data-b]')) {
          if (key(head.textContent) === 'notes') continue;
          const level = head.matches('.r-title, .r-sec') ? 1 : 2;
          if (head !== first || key(head.textContent) !== key(heading.textContent)) items.push({ title: plainTitle(head), level, el: head, label: drawnTitle(head) });
        }
      });
    return items;
  }

  destroy() {
    this.ac?.abort();
    this.columns?.forEach((c) => c.destroy());
    this.scrollEl?.remove();
  }
}
