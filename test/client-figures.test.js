// The HTML view gives a scanned book's pictures their src, and drops one whose name is not one the
// server makes. A book of several chapters shows one at a time, whichever way the reader moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { parseHTML } from 'linkedom';

// htmlview.js imports DOMPurify from the server's /vendor/ path: here it comes from node_modules.
// (Under linkedom DOMPurify leaves the tree as it is; the view's own pass is what is tested.)
const hooks = typeof module.register === 'function';
const vendor = new URL('../node_modules/dompurify/dist/', import.meta.url).href;
const resolve = `export const resolve = (s, c, next) => next(s.startsWith('/vendor/dompurify/') ? ${JSON.stringify(vendor)} + s.slice(18) : s, c);`;
if (hooks) module.register(`data:text/javascript,${encodeURIComponent(resolve)}`);
const { document, window, Node, DOMParser, HTMLElement } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document, window, Node, DOMParser });
const storage = new Map([['pr.lang', '"en"']]);
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
const { HtmlView, prepareArticle, tabLabel } = hooks ? await import('../public/assets/js/htmlview.js') : {};

test('a picture of a scanned book gets the figures route as its src; one named otherwise is dropped', { skip: !hooks && 'module.register needs Node 20.6 or later' }, () => {
  const html = `<article class="ltx_document book"><section class="ltx_section" id="c1" data-chapter="c1"><h2 class="ltx_title ltx_title_section">One</h2>
<figure class="book-fig"><img data-fig="p16-1.png" width="480" height="454" alt=""></figure>
<figure class="book-fig"><img data-fig="../meta.json" alt=""></figure>
<figure class="book-fig"><img data-fig="p1-1.svg" src="https://evil.example/x.svg" alt=""></figure>
<div class="ltx_para" id="c1.0" data-b="c1.0"><p class="ltx_p">Text.</p></div>
<img src="plate.png" alt="">
</section></article>`;
  const box = document.createElement('div');
  box.append(...prepareArticle(html, 'https://book.invalid/', 'pdf-0123'));
  const imgs = [...box.querySelectorAll('img')];
  assert.deepEqual(
    imgs.map((img) => img.getAttribute('src')),
    ['/api/papers/pdf-0123/figures/p16-1.png', '/api/papers/pdf-0123/asset?u=https%3A%2F%2Fbook.invalid%2Fplate.png'],
  );
  assert.deepEqual([...box.querySelectorAll('figure.book-fig')].map((f) => f.children.length), [1, 0, 0]);
  assert.deepEqual(['width', 'height', 'alt', 'loading'].map((a) => imgs[0].getAttribute(a)), ['480', '454', '', 'lazy']);
});

test('a book of two or more chapters shows one at a time; every way to the text of another opens it first', { skip: !hooks && 'module.register needs Node 20.6 or later' }, async () => {
  assert.equal(tabLabel(2, '  To the\n Idle '), '2 To the Idle');
  assert.equal(tabLabel(12, 'On Patience, and how the ploughman waits'), '12 On Patience, and how th…');
  assert.equal(tabLabel(3, ''), '3');
  assert.equal(tabLabel(24, '1.7 The Testimony of the Spirit'), '1.7 The Testimony of th…', 'its own number is enough');
  assert.equal(tabLabel(2, '11:6 Faith'), '11:6 Faith');
  assert.equal(tabLabel(2, '2장 함수의 극한'), '2장 함수의 극한', 'a chapter of a Korean book, numbered');
  assert.equal(tabLabel(2, '1984 and After'), '2 1984 and After', 'a year is no number of its own');

  const html = `<article class="ltx_document book">
<section class="ltx_section" id="c1" data-chapter="c1"><h2 class="ltx_title ltx_title_section">Preface</h2>
<div class="ltx_para" id="c1.0" data-b="c1.0"><p class="ltx_p">See <a href="#c3.0">the last chapter</a>.</p></div></section>
<section class="ltx_section" id="c2" data-chapter="c2"><h2 class="ltx_title ltx_title_section">To the Idle</h2>
<div class="ltx_para" id="c2.0" data-b="c2.0"><p class="ltx_p">Two.</p></div></section>
<section class="ltx_section" id="c3" data-chapter="c3"><h2 class="ltx_title ltx_title_section">Debt</h2>
<div class="ltx_para" id="c3.0" data-b="c3.0"><p class="ltx_p">Three.</p></div></section></article>`;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ html, baseUrl: 'https://book.invalid/', source: 'txt' }) });
  // What linkedom lacks; an element of a hidden chapter has no boxes.
  Object.assign(globalThis, { CSS: { escape: String }, requestAnimationFrame: (fn) => fn() });
  HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{}];
  };
  document.getSelection = () => null;
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const moves = [];
  let back = null;
  let taps = 0;
  const view = new HtmlView({ paper: { id: 'book-tabs' }, host, onJump: (fn) => (back = fn), onChapter: (c) => moves.push(c), onTap: () => taps++ });
  await view.open({ anchorId: 'c2.0', offset: 0 });
  const shown = () => [...host.querySelectorAll('section[data-chapter]')].filter((s) => !s.hidden).map((s) => s.id).join();
  const ends = () => [...host.querySelectorAll('.chapter-nav button')].map((b) => b.textContent).join(' | ');
  // The saved place opens its chapter.
  assert.equal(shown(), 'c2');
  assert.deepEqual(
    [...host.querySelectorAll('.chapter-tab')].map((b) => [b.textContent, b.getAttribute('aria-selected')]),
    [
      ['1 Preface', 'false'],
      ['2 To the Idle', 'true'],
      ['3 Debt', 'false'],
    ],
  );
  assert.equal(ends(), '← Previous chapter | Next chapter →');
  // The contents, a bookmark, a highlight, "Back to source" (all goToLocation or jumpTo), and
  // "Back to where you were".
  view.goToLocation({ kind: 'html', anchorId: 'c3.0' });
  assert.equal(shown(), 'c3');
  assert.equal(ends(), '← Previous chapter');
  back();
  assert.equal(shown(), 'c2');
  // A tab, a link in the book, a button at the end of a chapter.
  host.querySelector('.chapter-tab').click();
  assert.equal(shown(), 'c1');
  assert.equal(ends(), 'Next chapter →');
  host.querySelector('a[href="#c3.0"]').click();
  assert.equal(shown(), 'c3');
  host.querySelector('.chapter-nav .prev').click();
  assert.equal(shown(), 'c2');
  assert.deepEqual(moves, ['c3', 'c2', 'c1', 'c3', 'c2']);
  assert.equal(taps, 0, 'none of it is a tap on the text');
  assert.equal(host.querySelectorAll('[data-b]').length, 3, 'the other chapters stay in the DOM');
  // A spot in a block's Korean (a mark on it, a question about it), or the block while its Korean
  // isn't in the page.
  const korean = document.createElement('div');
  korean.setAttribute('data-k', 'c1.0k');
  host.querySelector('[data-b="c1.0"]').after(korean);
  view.goToLocation({ kind: 'html', anchorId: 'c1.0k' });
  assert.equal(shown(), 'c1');
  assert.ok(korean.classList.contains('flash'));
  view.goToLocation({ kind: 'html', anchorId: 'c3.0k' });
  assert.equal(shown(), 'c3');
  view.destroy();
});

test("the contents list a chapter's own headings, but the first where it only says the title again", { skip: !hooks && 'module.register needs Node 20.6 or later' }, async () => {
  const html = `<article class="ltx_document book">
<section class="ltx_section" id="c1" data-chapter="c1"><h2 class="ltx_title ltx_title_section">Preface</h2>
<h3 class="ltx_title ltx_title_paragraph" id="c1.0" data-b="c1.0">PREFACE.</h3>
<div class="ltx_para" id="c1.1" data-b="c1.1"><p class="ltx_p">One.</p></div>
<h3 class="ltx_title ltx_title_paragraph" id="c1.2" data-b="c1.2">I. A LATER HEAD</h3>
<h3 class="ltx_title ltx_title_paragraph" id="c1.3" data-b="c1.3">Notes</h3></section>
<section class="ltx_section" id="c2" data-chapter="c2"><h2 class="ltx_title ltx_title_section">11:6 Faith</h2>
<h3 class="ltx_title ltx_title_paragraph" id="c2.0" data-b="c2.0">I. Faith and works</h3>
<div class="ltx_para" id="c2.1" data-b="c2.1"><p class="ltx_p">Two.</p></div></section></article>`;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ html, baseUrl: 'https://book.invalid/', source: 'txt' }) });
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const view = new HtmlView({ paper: { id: 'book-heads' }, host });
  await view.open({ anchorId: 'c1.1', offset: 0 });
  assert.deepEqual(
    view.getOutline().map((it) => [it.level, it.title]),
    [
      [1, 'Preface'],
      [2, 'I. A LATER HEAD'],
      [1, '11:6 Faith'],
      [2, 'I. Faith and works'],
    ],
  );
  view.destroy();
});
