// The formulas of a book written with LaTeX. server/book.js puts each one, dollars included, in a
// <k-tex>. That text stays: a block's textContent is its stored text, so anchors, selection and
// translation read the LaTeX. KaTeX draws the formula in the element's shadow root, which is what
// shows. It draws when the formula comes near the screen, so a long tab opens at once.
import { marksOf } from './sentences.js';

// The KaTeX rules for the shadow roots, fetched when a formula is first drawn: a page without one
// fetches nothing. Its fonts come from katex.min.css in index.html: a font declared in a shadow root
// is not used.
const sheet = typeof CSSStyleSheet === 'function' ? new CSSStyleSheet() : null;
let rules = null;
// (a failed fetch is tried again by the next formula)
const loadRules = () =>
  (rules ||= fetch('/vendor/katex/katex.min.css')
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
    .then((css) => sheet.replace(css.replace(/@font-face\s*\{[^}]*\}/g, '')))
    .catch((err) => {
      rules = null;
      throw err;
    }));

let katex = null;
// (a failed import is tried again by the next formula)
const loadKatex = () =>
  (katex ||= import('/vendor/katex/katex.mjs').then(
    (m) => m.default,
    (err) => {
      katex = null;
      throw err;
    },
  ));

export function texBody(text) {
  const display = text.length > 3 && text.startsWith('$$') && text.endsWith('$$');
  return { display, tex: display ? text.slice(2, -2) : text.replace(/^\$|\$$/g, '') };
}

// Without KaTeX or its rules the LaTeX itself shows (the slot); a browser whose shadow roots can't
// share a style sheet (Safari before 16.4) has no rules. MathML goes along for screen readers.
export async function drawTex(el) {
  const { display, tex } = texBody(el.textContent);
  try {
    if (!sheet) throw new Error('no KaTeX rules');
    const [k] = await Promise.all([loadKatex(), loadRules()]);
    el.shadowRoot.innerHTML = k.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml', maxSize: 10, maxExpand: 1000 });
    el.drawn = true;
  } catch {
    el.shadowRoot.innerHTML = '<slot></slot>';
  }
}

// One observer per scrolling box: a root margin grows the root's own rectangle only, and the book
// scrolls inside .html-scroll, which would clip the margin of an observer of the viewport. A formula
// is watched until it is drawn: one whose drawing failed is tried again when it next comes near.
const observers = new WeakMap();
let viewport = null;
function observerFor(root) {
  if (typeof IntersectionObserver !== 'function') return null;
  const known = root ? observers.get(root) : viewport;
  if (known) return known;
  const o = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !e.target.drawn) drawTex(e.target).then(() => e.target.drawn && o.unobserve(e.target));
      }
    },
    { root, rootMargin: '1500px 0px' },
  );
  if (root) observers.set(root, o);
  else viewport = o;
  return o;
}

if (typeof customElements === 'object' && !customElements.get('k-tex')) {
  customElements.define(
    'k-tex',
    class extends HTMLElement {
      connectedCallback() {
        if (!this.shadowRoot) {
          const root = this.attachShadow({ mode: 'open' });
          if (sheet) root.adoptedStyleSheets = [sheet];
        }
        if (this.drawn) return;
        // (in a journal article, in its original and its translation, at once: drawn as each came near,
        // they would move the cuts of the runs of text in columns, and the text being read with
        // them, columns.js; an article has a hundred or two)
        if (this.closest('.paper')) {
          drawTex(this);
          return;
        }
        this.observer = observerFor(this.closest('.html-scroll'));
        if (this.observer) this.observer.observe(this);
        else drawTex(this);
      }

      disconnectedCallback() {
        this.observer?.unobserve(this);
      }
    },
  );
}

// A highlight paints text nodes, and a formula's text is never drawn: the formulas a range covers
// carry its name instead, in a list of names (data-hl) that app.css paints, so a tap's mark comes
// and goes over a highlight's. Takes the name off the other formulas first.
export function tagFormulas(root, name, ranges) {
  if (!root.querySelector('k-tex')) return;
  const others = (el) => (el.getAttribute('data-hl') || '').split(' ').filter((n) => n && n !== name);
  const set = (el, names) => (names.length ? el.setAttribute('data-hl', names.join(' ')) : el.removeAttribute('data-hl'));
  root.querySelectorAll(`k-tex[data-hl~="${name}"]`).forEach((el) => set(el, others(el)));
  for (const r of ranges) {
    const anc = r.commonAncestorContainer;
    if (!anc) continue;
    const box = anc.nodeType === 1 ? anc : anc.parentElement;
    const own = box?.closest('k-tex');
    for (const el of own ? [own] : box?.querySelectorAll('k-tex') || []) if (r.intersectsNode(el)) set(el, [...others(el), name]);
  }
}

// The marks of such a book (marksOf) as nodes, for its translation (translation.js): formulas in
// <k-tex>, bold and italic with their marks hidden, so the nodes' text is `text`.
export function richNodes(text) {
  const s = String(text ?? '');
  const out = [];
  let at = 0;
  let bold = null;
  const mk = (chars) => {
    const el = document.createElement('span');
    el.className = 'mk';
    el.textContent = chars;
    return el;
  };
  const add = (node) => (bold ? bold.append(node) : out.push(node));
  for (const { index, text: m } of marksOf(s)) {
    if (index > at) add(document.createTextNode(s.slice(at, index)));
    at = index + m.length;
    if (m === '**') {
      if (bold) {
        bold.append(mk('**'));
        bold = null;
      } else {
        bold = document.createElement('b');
        bold.append(mk('**'));
        out.push(bold);
      }
    } else if (m[0] === '*') {
      const i = document.createElement('i');
      i.append(mk('*'), m.slice(1, -1), mk('*'));
      add(i);
    } else {
      const k = document.createElement('k-tex');
      if (m.startsWith('$$')) k.className = 'd';
      k.textContent = m;
      add(k);
    }
  }
  if (at < s.length) add(document.createTextNode(s.slice(at)));
  return out;
}
