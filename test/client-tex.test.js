// A formula of a book written with LaTeX keeps its LaTeX as its text, which anchors and selection
// count, and KaTeX draws it in the element's shadow root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { parseHTML } from 'linkedom';

// tex.js imports KaTeX from the server's /vendor/ path: here it comes from node_modules.
const hooks = typeof module.register === 'function';
const vendor = new URL('../node_modules/katex/dist/', import.meta.url).href;
const resolve = `export const resolve = (s, c, next) => next(s.startsWith('/vendor/katex/') ? ${JSON.stringify(vendor)} + s.slice(14) : s, c);`;
if (hooks) module.register(`data:text/javascript,${encodeURIComponent(resolve)}`);
const skip = !hooks && 'module.register needs Node 20.6 or later';

// A browser for it: a page with custom elements and shadow roots (linkedom), a style sheet shadow
// roots can share, the server's katex.min.css (its fetch fails while `down`), and observers of
// what comes near the screen, which near(el) moves.
const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat' }); // (KaTeX warns of quirks mode)
Object.assign(globalThis, { document, HTMLElement: window.HTMLElement, customElements: window.customElements });
let sheet = null;
globalThis.CSSStyleSheet = class {
  constructor() {
    sheet = this;
  }
  replace(css) {
    this.css = css;
    return Promise.resolve(this);
  }
};
const fetched = [];
let down = false;
globalThis.fetch = async (url) => {
  fetched.push(url);
  return down ? { ok: false, status: 503 } : { ok: true, text: async () => '@font-face{font-family:KaTeX_Main;src:url(f.woff2)}.katex{font:normal 1.21em KaTeX_Main}' };
};
const observers = [];
globalThis.IntersectionObserver = class {
  constructor(fn) {
    Object.assign(this, { fn, watched: new Set() });
    observers.push(this);
  }
  observe(el) {
    this.watched.add(el);
  }
  unobserve(el) {
    this.watched.delete(el);
  }
};
const watched = (el) => observers.some((o) => o.watched.has(el));
const near = (el) => observers.filter((o) => o.watched.has(el)).forEach((o) => o.fn([{ target: el, isIntersecting: true }]));
const until = async (ok) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  return ok();
};

const { drawTex, richNodes, texBody } = hooks ? await import('../public/assets/js/tex.js') : {};
const { renderHtml } = await import('../server/book.js');

test('a formula between $$ is displayed, one between $ is inline', { skip }, () => {
  assert.deepEqual(texBody('$$a$$'), { display: true, tex: 'a' });
  assert.deepEqual(texBody('$x_1$'), { display: false, tex: 'x_1' });
  assert.deepEqual(texBody('$$'), { display: false, tex: '' });
});

test('the KaTeX rules are fetched when a formula is first drawn; one whose drawing failed is drawn when it next comes near', { skip }, async () => {
  assert.deepEqual(fetched, [], 'a page without formulas fetches nothing');
  const box = document.createElement('div');
  box.className = 'html-scroll';
  box.innerHTML = '<p>A force <k-tex>$F$</k-tex> acts.</p>';
  document.body.append(box);
  const k = box.querySelector('k-tex');
  assert.ok(k.shadowRoot && watched(k));
  // The rules can't be fetched: the LaTeX shows, and the formula is still watched.
  down = true;
  near(k);
  assert.ok(await until(() => k.shadowRoot.innerHTML === '<slot></slot>'));
  assert.deepEqual(fetched, ['/vendor/katex/katex.min.css']);
  assert.ok(!k.drawn && watched(k));
  // Near again: fetched again, drawn, and no longer watched.
  down = false;
  near(k);
  assert.ok(await until(() => k.drawn));
  assert.equal(fetched.length, 2);
  assert.match(k.shadowRoot.innerHTML, /class="katex"/);
  assert.ok(!watched(k));
  assert.ok(sheet.css.includes('.katex') && !sheet.css.includes('@font-face'), 'its fonts come from the page');
  assert.equal(k.textContent, '$F$');
  box.remove();
});

test('KaTeX draws the formula in the shadow root; the text stays the LaTeX', { skip }, async () => {
  const shown = { textContent: '$$\\frac{1}{2}$$', shadowRoot: { innerHTML: '' } };
  await drawTex(shown);
  assert.match(shown.shadowRoot.innerHTML, /class="katex-display"/);
  assert.equal(shown.textContent, '$$\\frac{1}{2}$$');
  assert.equal(shown.drawn, true);
  const inline = { textContent: '$\\omega$', shadowRoot: { innerHTML: '' } };
  await drawTex(inline);
  assert.match(inline.shadowRoot.innerHTML, /class="katex"/);
  assert.doesNotMatch(inline.shadowRoot.innerHTML, /katex-display/);
  assert.equal(fetched.length, 2, 'the rules once fetched are kept');
});

// What a block's marks are drawn as: formulas (".d" displayed), bold and italic with their marks.
const shape = (el) =>
  [...el.childNodes].map((n) => (n.nodeType === 3 ? n.nodeValue : n.className === 'mk' ? '' : `<${n.localName}${n.className ? `.${n.className}` : ''}>${shape(n)}</${n.localName}>`)).join('');

test('the server (paper.html) and the reader (the Korean) draw the marks of a block the same', { skip }, () => {
  const cases = [
    ['It costs $5 and $10, or \\$3.', 'It costs $5 and $10, or \\$3.'],
    ['$a$$b$', '<k-tex>$a$</k-tex>$b$'],
    ['**$x$ 굵게**', '<b><k-tex>$x$</k-tex> 굵게</b>'],
    ['*걸음 1, 기울기.* 다음 Doe1* 그리고 끝', '<i>걸음 1, 기울기.</i> 다음 Doe1* 그리고 끝'],
    ['We have $$F = ma.$$ Then we go.', 'We have <k-tex.d>$$F = ma.$$</k-tex> Then we go.'],
    ['밀도 $\\rho$와 압력$p$는 $$\\nabla p = \\rho\\mathbf{g}$$이다.', '밀도 <k-tex>$\\rho$</k-tex>와 압력<k-tex>$p$</k-tex>는 <k-tex.d>$$\\nabla p = \\rho\\mathbf{g}$$</k-tex>이다.'],
    ['\\$$x$$ 끝', '\\$$x$$ 끝'],
    ['$$y$$$z$ 끝', '<k-tex.d>$$y$$</k-tex>$z$ 끝'],
    ['**굵게** 와 *기울임* 과 2*3*4 그리고 **열린', '<b>굵게</b> 와 <i>기울임</i> 과 2*3*4 그리고 <b>열린</b>'],
  ];
  for (const [x, want] of cases) {
    const page = parseHTML(`<html><body>${renderHtml({ math: true, chapters: [{ id: 'c1', title: 'One', blocks: [{ t: 'p', x }] }] })}</body></html>`).document;
    const server = page.querySelector('[data-b="c1.0"] p');
    const reader = document.createElement('p');
    reader.append(...richNodes(x));
    assert.equal(server.textContent, x);
    assert.equal(reader.textContent, x);
    assert.equal(shape(server), want, x);
    assert.equal(reader.innerHTML, server.innerHTML, x);
  }
});
