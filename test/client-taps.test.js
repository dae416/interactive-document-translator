// A tap on a clause or a sentence of a book: its counterpart in the chapter's translation (marked
// side by side, or in the balloon in EN and KO), else the model's translation with the paragraph as
// context; a clause tapped again widens to its sentence; and every tap that must not do anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { parseHTML } from 'linkedom';

// instant.js renders answers with markdown.js, which imports marked, DOMPurify and KaTeX from the
// server's /vendor/ paths: here they come from node_modules.
const hooks = typeof module.register === 'function';
const nm = new URL('../node_modules/', import.meta.url).href;
const vendor = { '/vendor/marked/': 'marked/lib/', '/vendor/dompurify/': 'dompurify/dist/', '/vendor/katex/': 'katex/dist/' };
const resolve = `const nm = ${JSON.stringify(nm)}, map = ${JSON.stringify(vendor)};
export const resolve = (s, c, next) => { for (const [p, d] of Object.entries(map)) if (s.startsWith(p)) return next(nm + d + s.slice(p.length), c); return next(s, c); };`;
if (hooks) module.register(`data:text/javascript,${encodeURIComponent(resolve)}`);
const skip = !hooks && 'module.register needs Node 20.6 or later';

// A browser for the client modules, in English. What linkedom lacks: the caret under a point,
// ranges with boxes, the Highlight API, media queries, frames.
const { document, window, Node, Event } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document, window, Node, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(window, { innerWidth: 1280, innerHeight: 900, matchMedia: () => ({ matches: false }) });
const storage = new Map([['pr.lang', '"en"']]);
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
globalThis.Highlight = class {
  constructor(...ranges) {
    this.ranges = ranges;
  }
};
globalThis.CSS = window.CSS = { highlights: new Map(), escape: String };
let onText = true; // whether a tapped point is on the text (or in the blank after a line)
class Range {
  setStart(node, offset) {
    this.start = [node, offset];
  }
  setEnd(node, offset) {
    this.end = [node, offset];
  }
  get startContainer() {
    return this.start[0];
  }
  get startOffset() {
    return this.start[1];
  }
  get endContainer() {
    return this.end[0];
  }
  get endOffset() {
    return this.end[1];
  }
  get commonAncestorContainer() {
    const up = (n) => (n ? [n, ...up(n.parentNode)] : []);
    const starts = new Set(up(this.start[0]));
    return up(this.end[0]).find((n) => starts.has(n));
  }
  getClientRects() {
    return onText ? [{ left: 0, right: 600, top: 0, bottom: 900 }] : [{ left: 0, right: 50, top: 0, bottom: 20 }];
  }
  getBoundingClientRect() {
    return { left: 10, right: 300, top: 100, bottom: 120, width: 290, height: 20 };
  }
  // (whether any of the node's text is in the range: enough for the formulas tex.js marks)
  intersectsNode(node) {
    const at = (n, o) => offsetIn(document.body, n, o);
    const s = at(node, 0);
    return s < at(...this.end) && s + node.textContent.length > at(...this.start);
  }
}
document.createRange = () => new Range();
let caret = null;
document.caretPositionFromPoint = () => caret;
let selection = { isCollapsed: true, rangeCount: 0 };
document.getSelection = () => selection;
// The page's selection as a tap leaves it, nothing selected, with what is done to it.
function untouched() {
  const done = [];
  const methods = ['addRange', 'setBaseAndExtent', 'selectAllChildren', 'collapse', 'extend', 'modify', 'removeAllRanges'];
  selection = { isCollapsed: true, rangeCount: 0, ...Object.fromEntries(methods.map((m) => [m, () => done.push(m)])) };
  return done;
}

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined });
  if (url === '/api/settings') return { ok: true, status: 200, json: async () => ({ prefs: { targetLang: '한국어' }, llm: { protocol: 'anthropic', model: 'auto' } }) };
  const events = [{ t: 'start', model: 'claude-haiku-5-5' }, { t: 'delta', text: '그러므로 그는 추수 때에 구걸할 것이다.' }, { t: 'done', stopReason: 'end_turn' }];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
};
const chats = () => calls.filter((c) => c.url === '/api/llm/chat');

const { SentenceTaps } = hooks ? await import('../public/assets/js/taps.js') : {};
const { InstantTranslate } = hooks ? await import('../public/assets/js/instant.js') : {};
const { SelectionBar } = await import('../public/assets/js/selection.js');
const { bookSelection } = await import('../public/assets/js/translation.js');
const { isTranslation, locate, offsetIn } = await import('../public/assets/js/anchors.js');
const { tagFormulas } = hooks ? await import('../public/assets/js/tex.js') : {};
const { getSettings } = await import('../public/assets/js/api.js');

// A chapter as the reader has it: c1.0 is translated (one English sentence is three Korean ones,
// one of them with a note's marker), c1.1 is not.
const EN = 'Mr. Smith is idle all the day long. He sleeps till noon, and he begs at night; so he is poor and wretched all the year round. See <a href="#c1.1">the rest</a> of it.';
const KO = '스미스 씨는 하루 종일 게으르다. 그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다<sup class="fn" role="button" tabindex="0">1</sup>. 그래서 일 년 내내 가난하고 비참하다. 나머지도 보라.';
const PLAIN = 'The sluggard will not plough by reason of the cold. Therefore shall he beg in harvest.';
const PLAIN2 = 'In harvest the sluggard shall beg, and have nothing. So it is written.';
const CHAPTER = `<section class="ltx_section" id="c1" data-chapter="c1"><h2 class="ltx_title ltx_title_section">To the Idle</h2>
<div class="tr-bar"><button type="button">KO+EN</button></div>
<div class="ltx_para" id="c1.0" data-b="c1.0"><p class="ltx_p">${EN}</p></div><div class="tr-block" lang="ko" data-k="c1.0k">${KO}</div>
<div class="ltx_para" id="c1.1" data-b="c1.1"><p class="ltx_p">${PLAIN}</p></div>
<div class="ltx_para" id="c1.2" data-b="c1.2"><p class="ltx_p">${PLAIN2}</p></div>
</section>`;

// What the reader's describe() makes of a selection of book text with only this range (a
// selection in the Korean is anchored there, with the English it translates as its context).
function describe(range) {
  const found = bookSelection({ getRangeAt: () => range }, document.querySelector('.html-article'));
  if (!found?.anchor) return null;
  const { anchor, source } = found;
  const inTranslation = isTranslation(anchor.start.b);
  return {
    text: anchor.text,
    context: inTranslation ? source : anchor.paragraph,
    chapter: anchor.chapter,
    ...(inTranslation && { inTranslation }),
    anchor,
    location: { kind: 'html', anchorId: anchor.start.b, section: '' },
    rect: range.getBoundingClientRect(),
    marks: [],
    bookmark: null,
  };
}

// unit: what a tap pairs (the setting). clauses(chapter): the server's pairing of its clauses.
function open({ mode = 'en', unit = 'sentence', clauses } = {}) {
  const article = document.createElement('div');
  article.className = 'html-article';
  article.innerHTML = CHAPTER;
  document.body.replaceChildren(article);
  const section = article.querySelector('section');
  if (mode === 'both') section.classList.add('bilingual');
  if (mode === 'ko') section.classList.add('tgt-only');
  const continued = [];
  // The selection bar and the balloon as the reader joins them (reader.js).
  const acted = [];
  const bar = new SelectionBar({
    describe: () => null,
    onAction: (act, info) => acted.push([act, info]),
    onAnnotate: (act, color, info) => acted.push([act, color, info]),
    onVisibility: (v) => v && !bar.tapped && instant.close(),
    onTapEnd: () => {
      taps.unpair();
      instant.close();
    },
  });
  const instant = new InstantTranslate({
    paper: { id: 'book-demo', kind: 'book' },
    onContinue: (thread) => continued.push(thread),
    onAnnotate: (act, color, info) => acted.push([act, color, info]),
    onVisibility: (v) => v || bar.showFor(null),
    avoid: () => (bar.tapped ? bar.el.getBoundingClientRect() : null),
  });
  const taps = new SentenceTaps({
    root: article,
    describe,
    show: (info) => instant.show(info),
    current: () => (instant.isOpen ? instant.info : null),
    on: () => storage.get('pr.tapTranslate') !== 'false',
    ai: () => storage.get('pr.tapAi') !== 'false',
    unit: () => unit,
    clausesOf: (chapter) => {
      asked.push(chapter);
      return clauses ? clauses(chapter) : Promise.reject(new Error('no pairing'));
    },
    menu: (info) => bar.showFor(info),
  });
  const asked = [];
  calls.length = 0;
  CSS.highlights.clear();
  return {
    article,
    en: article.querySelector('[data-b="c1.0"]'),
    ko: article.querySelector('.tr-block'),
    plain: article.querySelector('[data-b="c1.1"]'),
    plain2: article.querySelector('[data-b="c1.2"]'),
    instant,
    asked,
    continued,
    bar,
    acted,
    close() {
      taps.destroy();
      instant.destroy();
      bar.destroy();
    },
  };
}

// The text node holding `needle` in `el`, and the offset just inside it.
function textAt(el, needle) {
  const walk = (n) => (n.nodeType === 3 ? [n] : [...n.childNodes].flatMap(walk));
  for (const node of walk(el)) {
    const i = node.nodeValue.indexOf(needle);
    if (i >= 0) return { node, offset: i + 1 };
  }
  throw new Error(`no "${needle}"`);
}

const fire = (target, type, props = {}) => target.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { clientX: 100, clientY: 100, button: 0, detail: 1, pointerType: 'touch', ...props }));
// A tap on `needle` in `el`: the caret lands in it, and the events come from the text's element.
function tap(el, needle, { type = 'touch', move = 0, on } = {}) {
  const { node, offset } = textAt(el, needle);
  caret = { offsetNode: node, offset };
  const target = on || node.parentNode;
  fire(target, 'pointerdown', { pointerType: type });
  fire(target, 'pointerup', { pointerType: type, clientX: 100 + move });
  fire(target, 'click', { pointerType: type, clientX: 100 + move });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const popup = () => document.querySelector('.instant-pop');
const shown = () => popup()?.querySelector('.instant-body .md')?.textContent.trim() ?? null;
// The text of a range in a block.
const textOf = (r) => {
  const block = r.start[0].parentNode.closest('[data-b], .tr-block');
  return block.textContent.slice(offsetIn(block, ...r.start), offsetIn(block, ...r.end));
};
// The text a highlight covers, block by block.
const marked = (name) => (CSS.highlights.get(name)?.ranges || []).map(textOf);

test('a journal article in columns: a mark from a head into a run of text pairs with the Korean of those blocks only, and Original brings their English only', { skip }, async () => {
  const article = document.createElement('div');
  article.className = 'html-article';
  article.innerHTML = `<section class="ltx_section" id="c1" data-chapter="c1"><h2 class="ltx_title ltx_title_section">Journal of Examples</h2>
<h3 class="ltx_title r-sec" id="c1.0" data-b="c1.0">Results</h3><div class="tr-block tr-h" lang="ko" data-k="c1.0k">결과</div>
<div class="col-run"><div class="ltx_para" id="c1.1" data-b="c1.1"><p class="ltx_p">${PLAIN}</p></div><div class="tr-block" lang="ko" data-k="c1.1k">게으른 자는 추워서 밭을 갈지 않는다. 그러므로 추수 때에 구걸할 것이다.</div>
<div class="ltx_para" id="c1.2" data-b="c1.2"><p class="ltx_p">${PLAIN2}</p></div><div class="tr-block" lang="ko" data-k="c1.2k">추수 때에 게으른 자는 구걸하나 얻지 못한다. 그렇게 쓰여 있다.</div></div>
<h3 class="ltx_title r-sec" id="c1.3" data-b="c1.3">Discussion</h3><div class="tr-block tr-h" lang="ko" data-k="c1.3k">논의</div>
</section>`;
  document.body.replaceChildren(article);
  const taps = new SentenceTaps({ root: article, describe, show() {}, current: () => null, on: () => true, ai: () => true, unit: () => 'sentence', clausesOf: async () => ({ version: 1, blocks: {} }) });
  const others = taps.counterpart({ chapter: 'c1', start: { b: 'c1.0', o: 0 }, end: { b: 'c1.1', o: 20 } }, false);
  assert.deepEqual([...new Set(others.map((o) => o.start.b))], ['c1.0k', 'c1.1k'], 'not the next head, nor past the run');
  // A selection in the Korean from the head into the run: the English of those blocks.
  const range = document.createRange();
  const at = (sel, needle) => textAt(article.querySelector(sel), needle);
  const a = at('[data-k="c1.0k"]', '결과');
  const z = at('[data-k="c1.1k"]', '구걸');
  range.setStart(a.node, 0);
  range.setEnd(z.node, z.offset);
  const found = bookSelection({ anchorNode: a.node, focusNode: z.node, getRangeAt: () => range }, article);
  assert.equal(found.source, `Results\n\n${PLAIN}`);
  taps.destroy();
});

test('a tap on a book’s own Korean asks no model: a block translated from a scan shows its original; another, the bar', { skip }, async () => {
  const article = document.createElement('div');
  article.className = 'html-article';
  article.innerHTML = `<section class="ltx_section" id="c2" data-chapter="c2"><h2 class="ltx_title ltx_title_section">2장 함수의 극한</h2>
<div class="ltx_para" id="c2.0" data-b="c2.0" data-orig="21:0.1,0.1,0.9,0.3"><p class="ltx_p">지금까지는 함수가 연속이라고 가정했다. 그러나 간격이 사라지는 극한을 생각하자.</p></div>
<div class="ltx_para" id="c2.1" data-b="c2.1"><p class="ltx_p">이 문단은 덧붙인 글이다. 원문은 따로 없다.</p></div>
</section>`;
  document.body.replaceChildren(article);
  const shown = [];
  const menus = [];
  const originals = [];
  const taps = new SentenceTaps({ root: article, describe, show: (info) => shown.push(info), current: () => null, on: () => true, ai: () => true, unit: () => 'sentence', clausesOf: async () => ({ version: 1, blocks: {} }), menu: (info) => menus.push(info), original: (block) => originals.push(block.id) });
  calls.length = 0;
  untouched();
  tap(article.querySelector('[data-b="c2.0"]'), '간격');
  await settle();
  assert.deepEqual(originals, ['c2.0']);
  tap(article.querySelector('[data-b="c2.1"]'), '덧붙인');
  await settle();
  assert.deepEqual(originals, ['c2.0'], 'no original of a block without one');
  assert.equal(shown.length, 0, 'no balloon');
  assert.equal(chats().length, 0, 'no model');
  // (the original covers the foot of a phone's screen, where the bar would be: the bar only for the other)
  assert.deepEqual(menus.filter(Boolean).map((m) => m.anchor.start.b), ['c2.1'], 'the bar for the words tapped without an original');
  taps.destroy();
});

test('EN: a tap on an English sentence shows its Korean from the chapter translation at once; Follow up carries the pair on', { skip }, async () => {
  await getSettings();
  const v = open();
  tap(v.en, 'sleeps');
  assert.equal(shown(), '그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다. 그래서 일 년 내내 가난하고 비참하다.');
  assert.equal(popup().querySelector('.instant-head').textContent, 'TranslateChapter translation');
  assert.deepEqual(marked('tap-sentence'), ['He sleeps till noon, and he begs at night; so he is poor and wretched all the year round.']);
  assert.equal(chats().length, 0, 'no model');
  assert.deepEqual(v.asked, [], 'by sentence, nothing is asked of the server');
  // "Follow up": the sentence, its paragraph and the chapter's Korean go on in the panel.
  [...popup().querySelectorAll('.instant-foot button')].find((b) => b.textContent === 'Follow up').click();
  const [thread] = v.continued;
  // (with the block asked about: of a long chapter of sections only that one is sent)
  assert.deepEqual(thread.book, { id: 'book-demo', chapter: 'c1', block: 'c1.0' });
  assert.equal(
    thread.messages[0].content,
    `<paragraph>${v.en.textContent}</paragraph>\n<selection>He sleeps till noon, and he begs at night; so he is poor and wretched all the year round.</selection>\nMode: sentence`,
  );
  assert.equal(thread.messages[1].content, '그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다. 그래서 일 년 내내 가난하고 비참하다.');
  assert.equal(popup(), null);
  assert.equal(CSS.highlights.has('tap-sentence'), false, 'the mark goes with the balloon');
  v.close();
});

test('EN: the balloon closes on a second tap on the sentence, Escape or a scroll of the text; another sentence replaces it', { skip }, async () => {
  const v = open();
  tap(v.en, 'Smith');
  assert.equal(shown(), '스미스 씨는 하루 종일 게으르다.');
  tap(v.en, 'sleeps');
  assert.equal(shown(), '그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다. 그래서 일 년 내내 가난하고 비참하다.');
  tap(v.en, 'poor');
  assert.equal(popup(), null, 'the same sentence again: closed');
  tap(v.en, 'idle');
  popup().querySelector('.instant-body').dispatchEvent(new Event('scroll', { bubbles: true }));
  assert.ok(popup(), 'a long answer scrolls in its balloon');
  v.article.dispatchEvent(new Event('scroll', { bubbles: true }));
  window.dispatchEvent(new Event('scroll'));
  assert.equal(popup(), null);
  tap(v.en, 'idle');
  document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(popup(), null);
  v.close();
});

test('KO+EN: a tap marks the sentence and its counterpart in the other column, from either side', { skip }, () => {
  const v = open({ mode: 'both' });
  tap(v.en, 'Smith');
  assert.equal(popup(), null, 'both are on screen: no balloon');
  assert.deepEqual(marked('tap-pair'), ['Mr. Smith is idle all the day long.', '스미스 씨는 하루 종일 게으르다.']);
  tap(v.ko, '구걸');
  assert.deepEqual(marked('tap-pair'), ['He sleeps till noon, and he begs at night; so he is poor and wretched all the year round.', '그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다1. 그래서 일 년 내내 가난하고 비참하다.']);
  tap(v.ko, '비참');
  assert.equal(CSS.highlights.has('tap-pair'), false, 'the same pair again: cleared');
  tap(v.ko, '나머지');
  assert.deepEqual(marked('tap-pair'), ['See the rest of it.', '나머지도 보라.']);
  document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(CSS.highlights.has('tap-pair'), false);
  assert.equal(chats().length, 0);
  v.close();
});

test('KO: a tap on a Korean sentence shows the English it translates', { skip }, () => {
  const v = open({ mode: 'ko' });
  tap(v.ko, '가난');
  assert.equal(shown(), 'He sleeps till noon, and he begs at night; so he is poor and wretched all the year round.');
  assert.equal(popup().querySelector('.instant-head').textContent, 'OriginalChapter translation');
  assert.deepEqual(marked('tap-sentence'), ['그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다1. 그래서 일 년 내내 가난하고 비참하다.']);
  assert.equal(popup().querySelector('.instant-tools').hidden, true, 'no highlight colors for English that is hidden');
  v.close();
  // Marked side by side, then read in Korean only: the same sentence opens its balloon (it is
  // not the marks' second tap).
  const w = open({ mode: 'both' });
  tap(w.ko, '가난');
  assert.equal(marked('tap-pair').length, 2);
  w.article.querySelector('section').classList.replace('bilingual', 'tgt-only');
  tap(w.ko, '가난');
  assert.equal(shown(), 'He sleeps till noon, and he begs at night; so he is poor and wretched all the year round.');
  assert.equal(CSS.highlights.has('tap-pair'), false);
  w.close();
});

test('no translation: the model translates the sentence, with the paragraph; a second tap is served from memory', { skip }, async () => {
  const v = open();
  tap(v.plain, 'Therefore');
  await settle();
  assert.equal(chats().length, 1);
  const { body } = chats()[0];
  assert.deepEqual(body.book, { id: 'book-demo', chapter: 'c1', block: 'c1.1' });
  assert.equal(body.action, 'translate');
  assert.deepEqual(body.messages, [{ role: 'user', content: `<paragraph>${PLAIN}</paragraph>\n<selection>Therefore shall he beg in harvest.</selection>\nMode: sentence` }]);
  assert.equal(shown(), '그러므로 그는 추수 때에 구걸할 것이다.');
  assert.equal(popup().querySelector('.model').textContent, 'Haiku 5.5');
  assert.deepEqual(marked('tap-sentence'), ['Therefore shall he beg in harvest.']);
  tap(v.plain, 'harvest');
  assert.equal(popup(), null);
  tap(v.plain, 'harvest');
  assert.equal(shown(), '그러므로 그는 추수 때에 구걸할 것이다.');
  assert.equal(chats().length, 1, 'the same sentence again: no new request');
  v.close();
});

test('nothing happens on a link, a note marker, a button, a selection, a drag, a long press, off the text, or with the setting off', { skip }, async (t) => {
  const v = open();
  tap(v.en, 'rest');
  tap(v.ko, '1', { on: v.ko.querySelector('sup') });
  // A note's marker in the English (no text of its own; translation.js)
  const mark = Object.assign(document.createElement('sup'), { className: 'fn-src' });
  mark.setAttribute('role', 'button');
  v.en.querySelector('p').append(mark);
  tap(v.en, 'Smith', { on: mark });
  tap(v.article, 'KO+EN', { on: v.article.querySelector('.tr-bar button') });
  selection = { isCollapsed: false, rangeCount: 1 };
  tap(v.en, 'Smith');
  selection = { isCollapsed: true, rangeCount: 0 };
  tap(v.en, 'Smith', { move: 30 });
  onText = false;
  tap(v.en, 'Smith');
  onText = true;
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { node, offset } = textAt(v.en, 'Smith');
  caret = { offsetNode: node, offset };
  fire(node.parentNode, 'pointerdown');
  t.mock.timers.tick(600);
  fire(node.parentNode, 'click');
  t.mock.timers.reset();
  assert.equal(popup(), null);
  assert.equal(CSS.highlights.size, 0);
  // The Korean side of a chapter read side by side: the same rules.
  v.close();
  const both = open({ mode: 'both' });
  selection = { isCollapsed: false, rangeCount: 1 };
  tap(both.ko, '구걸');
  selection = { isCollapsed: true, rangeCount: 0 };
  tap(both.ko, '구걸', { move: 30 });
  // A press that becomes a selection of the Korean (a long press selects its word before the finger
  // lifts, and the selection bar takes it): no sentence tap, however short.
  const word = textAt(both.ko, '구걸');
  caret = { offsetNode: word.node, offset: word.offset };
  fire(word.node.parentNode, 'pointerdown');
  selection = { isCollapsed: false, rangeCount: 1 };
  fire(word.node.parentNode, 'click');
  selection = { isCollapsed: true, rangeCount: 0 };
  assert.equal(CSS.highlights.size, 0);
  both.close();
  // Off on this device; or only the model's part off.
  storage.set('pr.tapTranslate', 'false');
  const off = open();
  tap(off.en, 'Smith');
  tap(off.plain, 'Therefore');
  assert.equal(popup(), null);
  off.close();
  storage.delete('pr.tapTranslate');
  storage.set('pr.tapAi', 'false');
  const noAi = open();
  tap(noAi.plain, 'Therefore');
  await settle();
  assert.equal(popup(), null);
  assert.equal(chats().length, 0);
  tap(noAi.en, 'Smith');
  assert.equal(shown(), '스미스 씨는 하루 종일 게으르다.', 'the translation still shows');
  noAi.close();
  storage.delete('pr.tapAi');
});

test('a mouse click waits to see that it is not a double click, which selects a word', { skip }, (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = open();
  tap(v.en, 'Smith', { type: 'mouse' });
  assert.equal(popup(), null);
  t.mock.timers.tick(250);
  assert.equal(shown(), '스미스 씨는 하루 종일 게으르다.');
  v.close();
  const w = open();
  tap(w.en, 'Smith', { type: 'mouse' });
  fire(textAt(w.en, 'Smith').node.parentNode, 'dblclick');
  t.mock.timers.tick(300);
  assert.equal(popup(), null);
  w.close();
});

// The Korean of the first block as the page has it, and where `piece` is in it.
const KO_TEXT = () => document.querySelector('.tr-block').textContent;
const span = (piece) => [KO_TEXT().indexOf(piece), KO_TEXT().indexOf(piece) + piece.length];
const SENTENCE = 'He sleeps till noon, and he begs at night; so he is poor and wretched all the year round.';
const SENTENCE_KO = '그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다. 그래서 일 년 내내 가난하고 비참하다.';
const PAIRING = () => ({
  version: 1,
  blocks: { 0: { n: KO_TEXT().length, clauses: [[span('스미스 씨는 하루 종일 게으르다.')], [span('낮까지 잠을')], [span('밤에는'), span('다닌다')], [], [span('나머지도 보라.')]] } },
});

test('by clause, EN: a tap shows the Korean of its clause; again, of its sentence; a third time, closed. A clause that is its whole sentence is the sentence', { skip }, () => {
  const v = open({ unit: 'clause' });
  tap(v.en, 'begs');
  assert.equal(shown(), '밤에는 구걸하러 다닌다.');
  assert.deepEqual(marked('tap-sentence'), ['and he begs at night;']);
  assert.deepEqual(v.asked, ['c1'], "the chapter's pairing is asked for; until it comes, the reader pairs by itself");
  tap(v.en, 'begs');
  assert.equal(shown(), SENTENCE_KO);
  assert.deepEqual(marked('tap-sentence'), [SENTENCE]);
  tap(v.en, 'poor');
  assert.equal(popup(), null, 'its sentence again: closed');
  tap(v.en, 'Smith');
  assert.equal(shown(), '스미스 씨는 하루 종일 게으르다.');
  tap(v.en, 'Smith');
  assert.equal(popup(), null);
  assert.equal(chats().length, 0, 'no model');
  assert.deepEqual(v.asked, ['c1'], 'once');
  v.close();
});

test('by clause, KO+EN: a clause and its Korean are marked, from either side; the same again widens to the sentence, then clears', { skip }, () => {
  const v = open({ mode: 'both', unit: 'clause' });
  tap(v.en, 'noon');
  assert.equal(popup(), null);
  assert.deepEqual(marked('tap-pair'), ['He sleeps till noon,', '그는 낮까지 잠을 잔다.']);
  tap(v.ko, '가난');
  assert.deepEqual(marked('tap-pair'), ['so he is poor and wretched all the year round.', '그래서 일 년 내내 가난하고 비참하다.']);
  tap(v.ko, '비참');
  assert.deepEqual(marked('tap-pair'), [SENTENCE, '그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다1. 그래서 일 년 내내 가난하고 비참하다.']);
  tap(v.en, 'begs');
  assert.equal(CSS.highlights.has('tap-pair'), false, 'in the sentence marked: cleared');
  v.close();
});

test('by clause, KO: a tap on the Korean shows the English clause it translates', { skip }, () => {
  const v = open({ mode: 'ko', unit: 'clause' });
  tap(v.ko, '구걸');
  assert.equal(shown(), 'and he begs at night;');
  assert.deepEqual(marked('tap-sentence'), ['밤에는 구걸하러 다닌다1.']);
  assert.equal(popup().querySelector('.instant-tools').hidden, true);
  v.close();
});

test("by clause, with the chapter's pairing from the server: its Korean once it has come, pieces apart too and from either side; a clause it leaves without has its sentence", { skip }, async () => {
  let answer;
  const v = open({ unit: 'clause', clauses: () => new Promise((resolve) => (answer = resolve)) });
  tap(v.en, 'noon');
  assert.equal(shown(), '그는 낮까지 잠을 잔다.', 'not come yet');
  answer(PAIRING());
  await settle();
  tap(v.en, 'begs');
  assert.equal(shown(), '밤에는 … 다닌다');
  assert.deepEqual(marked('tap-sentence'), ['and he begs at night;']);
  tap(v.en, 'noon');
  assert.equal(shown(), '낮까지 잠을');
  tap(v.en, 'poor');
  assert.equal(shown(), SENTENCE_KO, 'no Korean for it: the sentence');
  assert.deepEqual(v.asked, ['c1']);
  v.close();
  const both = open({ mode: 'both', unit: 'clause', clauses: async () => PAIRING() });
  tap(both.en, 'Smith');
  await settle();
  tap(both.ko, '다닌다');
  assert.deepEqual(marked('tap-pair'), ['and he begs at night;', '밤에는', '다닌다']);
  tap(both.ko, '구걸');
  assert.equal(marked('tap-pair').length, 2, 'between its pieces, no clause: the sentence');
  both.close();
});

test("a chapter's pairing that has a block from before its Korean changed, or lacks it, leaves the block to the reader; asked for again only after half a minute", { skip }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  for (const blocks of [{ 0: { n: 3, clauses: [[], [], [], [], []] } }, {}]) {
    const v = open({ unit: 'clause', clauses: async () => ({ version: 1, blocks }) });
    tap(v.en, 'noon');
    await settle();
    tap(v.en, 'begs');
    assert.equal(shown(), '밤에는 구걸하러 다닌다.');
    t.mock.timers.tick(20_000);
    tap(v.en, 'noon');
    assert.deepEqual(v.asked, ['c1'], 'not so soon');
    t.mock.timers.tick(11_000);
    tap(v.en, 'begs');
    assert.deepEqual(v.asked, ['c1', 'c1']);
    v.close();
  }
  t.mock.timers.reset();
});

test('no translation, by clause: the model translates the tapped clause with its sentence and paragraph in view; again, the sentence', { skip }, async () => {
  const v = open({ unit: 'clause' });
  tap(v.plain2, 'nothing');
  await settle();
  assert.equal(chats().length, 1);
  assert.deepEqual(chats()[0].body.messages, [
    { role: 'user', content: `<paragraph>${PLAIN2}</paragraph>\n<sentence>In harvest the sluggard shall beg, and have nothing.</sentence>\n<selection>and have nothing.</selection>\nMode: sentence` },
  ]);
  assert.deepEqual(marked('tap-sentence'), ['and have nothing.']);
  tap(v.plain2, 'nothing');
  await settle();
  assert.equal(chats().length, 2);
  assert.deepEqual(chats()[1].body.messages, [{ role: 'user', content: `<paragraph>${PLAIN2}</paragraph>\n<selection>In harvest the sluggard shall beg, and have nothing.</selection>\nMode: sentence` }]);
  tap(v.plain2, 'harvest');
  assert.equal(popup(), null);
  assert.deepEqual(v.asked, [], 'an untranslated block asks the server nothing');
  v.close();
});

// One block and its Korean, read in `mode`, by clause, with the server's pairing `blocks`.
function single(en, ko, mode, blocks) {
  const article = document.createElement('div');
  article.className = 'html-article';
  article.innerHTML = `<section class="${mode}" data-chapter="c1"><div class="ltx_para" id="c1.0" data-b="c1.0"><p class="ltx_p">${en}</p></div><div class="tr-block" lang="ko">${ko}</div></section>`;
  document.body.replaceChildren(article);
  const instant = new InstantTranslate({ paper: { id: 'book-demo', kind: 'book' }, onContinue: () => {} });
  const taps = new SentenceTaps({ root: article, describe, show: (info) => instant.show(info), current: () => (instant.isOpen ? instant.info : null), on: () => true, ai: () => true, unit: () => 'clause', clausesOf: async () => ({ version: 1, blocks }) });
  calls.length = 0;
  CSS.highlights.clear();
  return {
    taps,
    en: article.querySelector('[data-b]'),
    ko: article.querySelector('.tr-block'),
    close() {
      taps.destroy();
      instant.destroy();
    },
  };
}

test('KO+EN, a clause with Korean in a sentence without any: marked; again, its sentence by the model; again, closed', { skip }, async () => {
  const EN = 'He came home at last. And he slept, and he dreamed of the hills.';
  const KO = '그는 마침내 집에 왔고 잠이 들어 언덕 꿈을 꾸었다.';
  const sp = (p) => [KO.indexOf(p), KO.indexOf(p) + p.length];
  const v = single(EN, KO, 'bilingual', { 0: { n: KO.length, clauses: [[sp('그는 마침내 집에 왔고')], [sp('잠이 들어')], [sp('언덕 꿈을 꾸었다.')]] } });
  // (the sentences paired so that the second has no Korean of its own)
  v.taps.pairs = () => [
    [0, 1, 0, 1],
    [1, 2, 1, 1],
  ];
  v.taps.prefetch('c1');
  await settle();
  tap(v.en, 'slept');
  assert.deepEqual(marked('tap-pair'), ['And he slept,', '잠이 들어']);
  tap(v.en, 'slept');
  await settle();
  assert.equal(CSS.highlights.has('tap-pair'), false);
  assert.ok(popup(), 'its sentence has no Korean: the model’s');
  assert.equal(chats().length, 1);
  tap(v.en, 'slept');
  assert.equal(popup(), null, 'the same again: closed');
  v.close();
});

test('KO, Korean that clauses apart from each other share: its whole sentence', { skip }, async () => {
  const EN = 'First we went out, then we sat down, and then we rose up, and at last we ran home.';
  const KO = '먼저 우리는 나갔고, 그다음 앉았고, 그다음 일어났고, 마침내 집으로 달려갔다.';
  const sp = (p) => [KO.indexOf(p), KO.indexOf(p) + p.length];
  const v = single(EN, KO, 'tgt-only', { 0: { n: KO.length, clauses: [[sp('먼저 우리는 나갔고')], [sp('그다음 앉았고')], [sp('먼저 우리는 나갔고')], [sp('마침내 집으로 달려갔다.')]] } });
  v.taps.prefetch('c1');
  await settle();
  tap(v.ko, '앉았고');
  assert.equal(shown(), 'then we sat down,');
  tap(v.ko, '나갔고');
  assert.equal(shown(), EN);
  v.close();
});

test('a chapter’s pairing is asked for when its Korean shows (prefetch): once, again only after half a minute; not by sentence, nor with taps off', { skip }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  for (const [unit, on, want] of [
    ['clause', true, 1],
    ['sentence', true, 0],
    ['clause', false, 0],
  ]) {
    const asked = [];
    const article = document.createElement('div');
    const s = new SentenceTaps({ root: article, describe, show: () => {}, current: () => null, on: () => on, ai: () => true, unit: () => unit, clausesOf: async (c) => (asked.push(c), { version: 1, blocks: {} }) });
    s.prefetch('c1');
    await settle();
    s.prefetch('c1');
    t.mock.timers.tick(20_000);
    s.prefetch('c1');
    assert.equal(asked.length, want, `${unit}, taps ${on ? 'on' : 'off'}`);
    t.mock.timers.tick(11_000);
    s.prefetch('c1');
    assert.equal(asked.length, want * 2, 'after half a minute (a part done since, say)');
    s.destroy();
  }
  t.mock.timers.reset();
});

// The selection bar a tap shows (null: none): its buttons, the words it acts on and where they are.
const menu = (v) => {
  if (!v.bar.el.classList.contains('show')) return null;
  const { text, anchor, range } = v.bar.info;
  const buttons = [...v.bar.el.querySelectorAll('.selbar-main button')].filter((b) => !b.hidden).map((b) => b.textContent);
  return { text, start: anchor.start, end: anchor.end, range: textOf(range), buttons };
};
// Where `piece` is in block `b` (the element `el`), as an anchor has it.
const where = (b, el, piece) => {
  const o = el.textContent.indexOf(piece);
  return { start: { b, o }, end: { b, o: o + piece.length } };
};
const EN_BAR = ['Translate', 'Explain', 'Ask', 'Copy'];
const KO_BAR = ['Original', 'Explain', 'Ask', 'Copy'];

test('the menu: a tap shows the selection bar for the words tapped, with nothing selected; again, for its sentence; a third time, it goes', { skip }, async () => {
  const done = untouched();
  const v = open({ unit: 'clause' });
  tap(v.en, 'begs');
  const clause = 'and he begs at night;';
  assert.deepEqual(menu(v), { text: clause, ...where('c1.0', v.en, clause), range: clause, buttons: EN_BAR });
  assert.ok(v.bar.el.querySelector('.ann-tools .swatch.yellow'), 'highlight, underline and bookmark');
  assert.equal(shown(), '밤에는 구걸하러 다닌다.', 'beside the balloon');
  assert.equal(popup().querySelector('.instant-tools').hidden, true, 'which has no highlight colors of its own then');
  tap(v.en, 'begs');
  assert.deepEqual(menu(v), { text: SENTENCE, ...where('c1.0', v.en, SENTENCE), range: SENTENCE, buttons: EN_BAR });
  assert.equal(shown(), SENTENCE_KO);
  tap(v.en, 'poor');
  assert.equal(menu(v), null);
  assert.equal(popup(), null);
  // Explain: the clause with its paragraph, as if it had been selected; the balloon goes.
  tap(v.en, 'noon');
  v.bar.el.querySelector('[data-act="explain"]').click();
  const [act, info] = v.acted.pop();
  assert.deepEqual([act, info.text, info.context, info.chapter], ['explain', 'He sleeps till noon,', v.en.textContent, 'c1']);
  assert.equal(menu(v), null);
  assert.equal(popup(), null);
  // The model's translation of a clause: the menu too.
  tap(v.plain2, 'nothing');
  await settle();
  assert.deepEqual(menu(v), { text: 'and have nothing.', ...where('c1.2', v.plain2, 'and have nothing.'), range: 'and have nothing.', buttons: EN_BAR });
  assert.ok(popup());
  assert.deepEqual(
    done.filter((m) => m !== 'removeAllRanges'),
    [],
    'no selection is made',
  );
  v.close();
});

test('the menu: a highlight from it marks just what was tapped, the English or the Korean (in its own layer, the English its context); the marks go as for a selection', { skip }, () => {
  const done = untouched();
  const v = open({ mode: 'both', unit: 'clause' });
  tap(v.en, 'noon');
  assert.deepEqual(marked('tap-pair'), ['He sleeps till noon,', '그는 낮까지 잠을 잔다.']);
  v.bar.el.querySelector('.swatch.yellow').click();
  let [act, color, info] = v.acted.pop();
  const noon = where('c1.0', v.en, 'He sleeps till noon,');
  assert.deepEqual([act, color, info.anchor.chapter, info.anchor.start, info.anchor.end, info.anchor.text], ['highlight', 'yellow', 'c1', noon.start, noon.end, 'He sleeps till noon,']);
  assert.equal(menu(v), null);
  assert.equal(CSS.highlights.has('tap-pair'), false);
  tap(v.ko, '가난');
  const piece = '그래서 일 년 내내 가난하고 비참하다.';
  assert.deepEqual(menu(v), { text: piece, ...where('c1.0k', v.ko, piece), range: piece, buttons: KO_BAR });
  // Again: its sentence.
  tap(v.ko, '비참');
  const whole = '그는 낮까지 잠을 잔다. 밤에는 구걸하러 다닌다1. 그래서 일 년 내내 가난하고 비참하다.';
  assert.deepEqual(menu(v), { text: whole, ...where('c1.0k', v.ko, whole), range: whole, buttons: KO_BAR });
  v.bar.el.querySelector('.swatch.pink').click();
  [act, color, info] = v.acted.pop();
  const at = where('c1.0k', v.ko, whole);
  assert.deepEqual([act, color, info.inTranslation, info.anchor.start, info.anchor.end, info.context], ['highlight', 'pink', true, at.start, at.end, v.en.textContent]);
  assert.equal(CSS.highlights.has('tap-pair'), false);
  v.close();
  // Read in Korean only: the Korean tapped, and Original shows its English.
  const k = open({ mode: 'ko', unit: 'clause' });
  tap(k.ko, '구걸');
  const ko = '밤에는 구걸하러 다닌다1.';
  assert.deepEqual(menu(k), { text: ko, ...where('c1.0k', k.ko, ko), range: ko, buttons: KO_BAR });
  assert.equal(shown(), 'and he begs at night;');
  k.bar.el.querySelector('[data-act="source"]').click();
  [act, info] = k.acted.pop();
  assert.deepEqual([act, info.context], ['source', k.en.textContent]);
  assert.equal(popup(), null);
  assert.deepEqual(
    done.filter((m) => m !== 'removeAllRanges'),
    [],
    'no selection is made',
  );
  k.close();
});

test("the menu for Korean in pieces (the server's pairing): the pieces and what is between them, as one selection", { skip }, async () => {
  untouched();
  const v = open({ mode: 'both', unit: 'clause', clauses: async () => PAIRING() });
  tap(v.en, 'Smith');
  await settle();
  tap(v.ko, '다닌다');
  assert.deepEqual(marked('tap-pair'), ['and he begs at night;', '밤에는', '다닌다']);
  const across = '밤에는 구걸하러 다닌다';
  assert.deepEqual(menu(v), { text: across, ...where('c1.0k', v.ko, across), range: across, buttons: KO_BAR });
  v.close();
});

test('the menu goes with its tap: a tap elsewhere (off the book too; not on it or its balloon), the text scrolling (not the balloon), Escape, its balloon closed, a selection made; with taps off, none', { skip }, () => {
  untouched();
  const v = open({ mode: 'both', unit: 'clause' });
  const away = document.createElement('div');
  document.body.append(away);
  tap(v.en, 'noon');
  fire(v.bar.el, 'pointerdown');
  fire(v.bar.el, 'pointerup');
  assert.ok(menu(v), 'a press on the bar');
  fire(away, 'pointerdown');
  fire(away, 'pointerup');
  assert.equal(menu(v), null, 'a tap off the book');
  assert.equal(CSS.highlights.has('tap-pair'), false, 'its marks go too');
  tap(v.en, 'noon');
  v.article.dispatchEvent(new Event('scroll', { bubbles: true }));
  assert.equal(menu(v), null, 'the text scrolled');
  assert.equal(CSS.highlights.has('tap-pair'), false);
  tap(v.en, 'noon');
  document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(menu(v), null);
  assert.equal(CSS.highlights.has('tap-pair'), false);
  // A selection made takes the bar; the tap's marks go.
  tap(v.en, 'noon');
  selection = { isCollapsed: false, rangeCount: 1, toString: () => 'noon' };
  v.bar.update();
  assert.equal(v.bar.tapped, false);
  assert.equal(CSS.highlights.has('tap-pair'), false);
  untouched();
  v.close();
  const w = open({ unit: 'clause' });
  tap(w.en, 'noon');
  popup().querySelector('.instant-body').dispatchEvent(new Event('scroll', { bubbles: true }));
  fire(popup(), 'pointerdown');
  fire(popup(), 'pointerup');
  assert.ok(menu(w) && popup(), 'a long answer scrolls in its balloon; a press in it');
  popup().querySelector('.instant-head .icon-btn').click();
  assert.equal(popup(), null);
  assert.equal(menu(w), null, 'closed with its balloon');
  w.close();
  storage.set('pr.tapTranslate', 'false');
  const off = open({ mode: 'both', unit: 'clause' });
  tap(off.en, 'noon');
  tap(off.plain, 'Therefore');
  assert.equal(menu(off), null);
  off.close();
  storage.delete('pr.tapTranslate');
  away.remove();
});

test('the menu on a phone: docked at the bottom as for a selection, its balloon docked above it', { skip }, () => {
  window.matchMedia = () => ({ matches: true });
  try {
    untouched();
    const v = open({ unit: 'clause' });
    v.bar.el.getBoundingClientRect = () => ({ left: 10, right: 402, top: 780, bottom: 890, width: 392, height: 110 });
    tap(v.en, 'noon');
    assert.equal(v.bar.el.classList.contains('floating'), false);
    assert.ok(popup().classList.contains('docked'));
    assert.equal(popup().classList.contains('lift'), false, 'a tap selects nothing: no search bar to clear');
    assert.equal(popup().style.getPropertyValue('--sel-offset'), '122px', 'its height and the gap above it');
    v.instant.setOffset(300);
    assert.equal(popup().style.getPropertyValue('--sel-offset'), '422px', 'with the AI panel open below both');
    v.close();
  } finally {
    window.matchMedia = () => ({ matches: false });
  }
});

test('a highlighted formula keeps its highlight through a tap on its sentence: the tap’s mark comes and goes beside it', { skip }, () => {
  // A translated block of a book written with LaTeX, a formula in its first sentence and in that
  // sentence's Korean (tex.js draws them; here their text is the LaTeX), and a highlight over the
  // English one (annotations.js).
  const withFormula = (v) => {
    v.article.querySelector('section').insertAdjacentHTML(
      'beforeend',
      '<div class="ltx_para" id="c1.3" data-b="c1.3"><p class="ltx_p">A force <k-tex>$F$</k-tex> acts on it. It moves.</p></div><div class="tr-block" lang="ko" data-k="c1.3k">힘 <k-tex>$F$</k-tex>가 그것에 작용한다. 그것은 움직인다.</div>',
    );
    const en = v.article.querySelector('[data-b="c1.3"]');
    const r = document.createRange();
    const [s, e] = [locate(en, 2), locate(en, 16)];
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    tagFormulas(v.article, 'ann-yellow', [r]);
    return { en, k: en.querySelector('k-tex'), kk: v.article.querySelector('[data-k="c1.3k"] k-tex') };
  };
  const v = open();
  const { en, k } = withFormula(v);
  assert.equal(k.getAttribute('data-hl'), 'ann-yellow');
  tap(en, 'force');
  assert.equal(shown(), '힘 $F$가 그것에 작용한다.');
  assert.equal(k.getAttribute('data-hl'), 'ann-yellow tap-sentence', 'both: the tap’s shows over it (app.css)');
  document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(popup(), null);
  assert.equal(k.getAttribute('data-hl'), 'ann-yellow', 'the balloon closed: the highlight stays');
  v.close();
  // Side by side: the pair marked and cleared, the highlight still there.
  const w = open({ mode: 'both' });
  const both = withFormula(w);
  tap(both.en, 'force');
  assert.deepEqual([both.k.getAttribute('data-hl'), both.kk.getAttribute('data-hl')], ['ann-yellow tap-pair', 'tap-pair']);
  document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.deepEqual([both.k.getAttribute('data-hl'), both.kk.hasAttribute('data-hl')], ['ann-yellow', false]);
  w.close();
});
