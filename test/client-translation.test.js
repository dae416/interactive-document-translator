// Chapter translations in the book view: model text with note markers becomes nodes (never
// markup), the bar under each chapter and the mark on its tab, EN / KO+EN / KO, the estimates,
// note popups, and what selections and highlights must leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

// A browser for the client modules, in English, with the server's two translation routes.
const { document, window, Node, Event } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document, window, Node });
// What linkedom lacks and browsers have (without moving live ranges, which no test here needs).
Object.getPrototypeOf(document.createTextNode('')).splitText ??= function (offset) {
  const rest = document.createTextNode(this.nodeValue.slice(offset));
  this.nodeValue = this.nodeValue.slice(0, offset);
  this.parentNode.insertBefore(rest, this.nextSibling);
  return rest;
};
const storage = new Map([['pr.lang', '"en"']]);
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const server = { statuses: {}, files: {}, notesSrc: {}, calls: [], busy: false };
const meta = () => ({ id: 'book-demo', kind: 'book', book: { status: 'ready', translations: structuredClone(server.statuses) } });
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  server.calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : undefined });
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  const m = /^\/api\/papers\/book-demo(?:\/translations\/(c\d+)(\/cancel|\/notes-src)?)?$/.exec(url);
  if (!m) return reply(404, { error: 'Not found' });
  if (!m[1]) return reply(200, { paper: meta() });
  if (m[2] === '/notes-src') return server.notesSrc[m[1]] ? reply(200, { notes: server.notesSrc[m[1]] }) : reply(404, { error: 'No translation yet' });
  // A chapter's state, or that of its part `part`.
  const set = (part, patch) => {
    const t = server.statuses[m[1]];
    if (part) t.parts[part - 1] = { ...t.parts[part - 1], ...patch };
    else server.statuses[m[1]] = { ...(patch.status === 'queued' ? {} : t), ...patch };
  };
  const part = opts.body ? JSON.parse(opts.body).part : 0;
  if (m[2]) {
    set(part, { status: 'cancelled' });
    return reply(200, { paper: meta() });
  }
  if (method === 'POST') {
    if (server.busy) return reply(429, { error: 'Up to 3 chapters can be translated at once. Wait for one to finish, or stop one.' });
    set(part, { status: 'queued', progress: 0 });
    return reply(200, { paper: meta() });
  }
  // (`fail`: the server can't read it now, a cloud-sync placeholder, say)
  if (server.fail) return reply(503, { error: 'Storage unreadable', code: 'storage.unreadable' });
  const file = server.files[m[1]];
  return file ? reply(200, { translation: file }) : reply(404, { error: 'No translation yet', code: 'translate.none' });
};
const { BookTranslations, USD_PER_1K_CHARS, estimate, inTranslation, liveProgress, markSource, minutesLeft, modeLabel, pickMode, translatedNodes, writtenInTarget } = await import('../public/assets/js/translation.js');
const { setLangs } = await import('../public/assets/js/langs.js');
const { setLang } = await import('../public/assets/js/i18n.js');
const { anchorToRanges, blockOf, offsetIn } = await import('../public/assets/js/anchors.js');

// paper.html as server/book.js writes it: blocks are direct children of their chapter.
const CHAPTERS = `<section class="ltx_section" id="c1" data-chapter="c1"><h2 class="ltx_title ltx_title_section">Preface</h2>
<h3 class="ltx_title ltx_title_paragraph" id="c1.0" data-b="c1.0">PREFACE.</h3>
<div class="ltx_para" id="c1.1" data-b="c1.1"><p class="ltx_p">Idle hands are the devil’s workshop.</p></div>
<div class="ltx_para" id="c1.2" data-b="c1.2"><p class="ltx_p">~ ~</p></div>
<div class="ltx_para" id="c1.3" data-b="c1.3"><p class="ltx_p">Read Hos. viii. 12.</p></div>
</section>
<section class="ltx_section" id="c2" data-chapter="c2"><h2 class="ltx_title ltx_title_section">To the Idle</h2>
<div class="ltx_para" id="c2.0" data-b="c2.0"><p class="ltx_p">${'x'.repeat(2000)}</p></div>
</section>`;
const FILE = {
  chapter: 'c1',
  blocks: ['서문.', '게으른 손[^1]은 <b>악마</b>의 작업장이다.', '', '호세아 8:12[^2]을 읽어라.'],
  notes: ['일하지 않는 사람의 손.', '구약 성경의 한 책.'],
  model: 'claude-opus-5-5',
  effort: 'max',
  at: '2026-10-24T00:00:00.000Z',
  stale: false,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const key = (type, k) => Object.assign(new Event(type, { bubbles: true }), { key: k });
// A busy bar: its label (on a disabled button) and the buttons it offers.
const label = (bar) => bar.querySelector('button[disabled]')?.textContent;
const offers = (bar) => [...bar.querySelectorAll('button')].filter((b) => !b.hasAttribute('disabled')).map((b) => b.textContent);

function open({ statuses = {}, files = {}, id = 'book-demo' } = {}) {
  Object.assign(server, { statuses: structuredClone(statuses), files, calls: [] });
  const article = document.createElement('div');
  article.className = 'html-article';
  article.innerHTML = CHAPTERS;
  document.body.replaceChildren(article);
  // The chapter tabs as HtmlView makes them.
  const tabs = new Map(
    ['c1', 'c2'].map((c) => {
      const tab = document.createElement('button');
      tab.innerHTML = `<span>${c}</span><span class="tab-mark"></span>`;
      return [c, tab];
    }),
  );
  const view = { article, tabs, firstVisible: () => null, scrollToEl() {} };
  const paper = { id, kind: 'book', book: { status: 'ready', translations: structuredClone(statuses) } };
  return {
    article,
    tr: new BookTranslations({ paper, view }),
    bar: (c) => article.querySelector(`#${c} > .tr-bar`),
    mark: (c) => tabs.get(c).querySelector('.tab-mark'),
  };
}

test('a translated block becomes text and note markers, never markup', () => {
  const box = document.createElement('div');
  box.append(...translatedNodes('게으른 손[^1]은 <img src=x onerror=alert(1)> 작업장[^2]이다.[^3][^0]', ['하나', '둘']));
  assert.equal(box.querySelectorAll('img').length, 0);
  assert.match(box.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // Markers without a note (out of range, or zero) stay as written. A marker's number is drawn by
  // CSS from data-n: the text is the translation alone (marks on it count characters of it).
  assert.equal(box.textContent, '게으른 손은 <img src=x onerror=alert(1)> 작업장이다.[^3][^0]');
  assert.deepEqual(
    [...box.querySelectorAll('sup')].map((s) => [s.className, s.getAttribute('role'), s.getAttribute('tabindex'), s.dataset.n, s.textContent]),
    [
      ['fn', 'button', '0', '1', ''],
      ['fn', 'button', '0', '2', ''],
    ],
  );
  assert.deepEqual(translatedNodes('[^1][^1]', ['같은 주석']).map((n) => n.dataset.n), ['1', '1']);
  // Two at one place read 4,5, as on the English (markSource); each says which note it opens.
  const two = translatedNodes('손[^1][^2]은', ['하나', '둘']).filter((n) => n.nodeType === 1);
  assert.deepEqual(two.map((s) => [s.dataset.n, s.classList.contains('fn-then'), s.getAttribute('aria-label')]), [
    ['1', true, 'Note 1'],
    ['2', false, 'Note 2'],
  ]);
  assert.deepEqual(translatedNodes('주석 없음[^1]', undefined).map((n) => [n.nodeType, n.textContent]), [[3, '주석 없음[^1]']]);
  assert.deepEqual(translatedNodes('', ['x']), []);
  assert.deepEqual(translatedNodes(null, null), []);
});

test('the Korean of a table of a book written with LaTeX: note markers in its cells as in a paragraph, no cell cut inside a formula', () => {
  const text = '기호 | 뜻\n$P(A | B)$ | 조건부 확률[^1]\n$x$[^2][^1] | 끝[^9]';
  const box = document.createElement('div');
  box.append(...translatedNodes(text, ['하나', '둘'], { rich: true, table: true }));
  assert.deepEqual(
    [...box.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => [c.localName, c.textContent])),
    [
      [['th', '기호'], ['th', ' | 뜻']],
      [['td', '\n$P(A | B)$'], ['td', ' | 조건부 확률']],
      [['td', '\n$x$'], ['td', ' | 끝[^9]']],
    ],
  );
  assert.deepEqual([...box.querySelectorAll('k-tex')].map((k) => k.textContent), ['$P(A | B)$', '$x$']);
  assert.deepEqual([...box.querySelectorAll('sup.fn')].map((s) => [s.dataset.n, s.classList.contains('fn-then')]), [['1', false], ['2', true], ['1', false]]);
  // Its text, as for a paragraph, is the server's (server/clauses.js): the markers of notes out.
  assert.equal(box.textContent, text.replace(/\[\^([12])\]/g, ''));
});

test('a ready chapter shows its Korean after each block, as KO+EN, EN or KO: one setting per book', async () => {
  const { article, tr, bar, mark } = open({ statuses: { c1: { status: 'ready' } }, files: { c1: FILE } });
  tr.load('c1'); // asked again while on its way (a second Retry, say)
  await settle();
  await tr.load('c1');
  // Once, and where its notes go in the English.
  assert.deepEqual(server.calls.map((c) => [c.method, c.url]), [
    ['GET', '/api/papers/book-demo/translations/c1'],
    ['GET', '/api/papers/book-demo/translations/c1/notes-src'],
  ]);
  const c1 = article.querySelector('#c1');
  assert.ok(c1.classList.contains('bilingual'));
  // The empty translation of the noise block adds nothing; a heading's Korean is set as one.
  assert.deepEqual(
    [...c1.children].map((el) => el.dataset.b || el.className),
    ['ltx_title ltx_title_section', 'tr-bar', 'c1.0', 'tr-block tr-h', 'c1.1', 'tr-block', 'c1.2', 'c1.3', 'tr-block', 'tr-notes'],
  );
  const korean = article.querySelector('[data-b="c1.1"]').nextElementSibling;
  assert.equal(korean.getAttribute('lang'), 'ko');
  assert.equal(korean.getAttribute('data-k'), 'c1.1k', 'the id of marks on it');
  assert.equal(korean.textContent, '게으른 손은 <b>악마</b>의 작업장이다.');
  assert.equal(korean.querySelectorAll('b').length, 0);
  assert.deepEqual([...c1.querySelectorAll('.tr-notes li')].map((li) => li.textContent), FILE.notes);
  // The book's own blocks are untouched (annotation offsets), and nothing new has an id or a
  // block id (reading position, bookmarks and highlights look for those).
  assert.equal(article.querySelector('[data-b="c1.1"]').textContent, 'Idle hands are the devil’s workshop.');
  assert.equal(article.querySelectorAll('.tr-bar[id], .tr-block[id], .tr-notes[id], [data-b] .fn, .tr-block[data-b]').length, 0);
  // Chapter 1 is ready, with a check on its tab; chapter 2 has nothing yet.
  const modes = () => [...bar('c1').querySelectorAll('.seg button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]);
  assert.deepEqual(modes(), [
    ['EN', 'false'],
    ['KO+EN', 'true'],
    ['KO', 'false'],
  ]);
  assert.ok(mark('c1').querySelector('svg'));
  assert.equal(mark('c2').childNodes.length, 0);
  assert.equal(tr.timer, 0, 'nothing to poll');

  const shown = (c) => ['bilingual', 'tgt-only'].filter((k) => article.querySelector(`#${c}`).classList.contains(k));
  bar('c1').querySelectorAll('.seg button')[2].click();
  assert.deepEqual(shown('c1'), ['tgt-only']);
  assert.equal(modes()[2][1], 'true');
  assert.deepEqual(shown('c2'), [], 'a chapter without its Korean stays as it is');
  bar('c1').querySelectorAll('.seg button')[0].click();
  assert.deepEqual(shown('c1'), []);
  assert.equal(storage.get('pr.trView:book-demo'), '"src"');
  tr.destroy();
  // One setting per book.
  const again = open({ statuses: { c1: { status: 'ready' } }, files: { c1: FILE } });
  await settle();
  assert.deepEqual(shown('c1'), []);
  again.tr.destroy();
  const other = open({ id: 'book-other' });
  assert.equal(other.tr.mode, 'both');
  other.tr.destroy();
  storage.delete('pr.trView:book-demo');
  // The old side-by-side switch of a book becomes its mode.
  storage.set('pr.trSide:book-old', 'false');
  const old = open({ id: 'book-old' });
  assert.equal(old.tr.mode, 'src');
  old.tr.destroy();
  storage.delete('pr.trSide:book-old');
});

test('blocks in the runs of text of a journal article in columns (columns.js) get their Korean in their run, once each', async () => {
  const { article, tr } = open({ statuses: { c1: { status: 'ready' } }, files: { c1: FILE } });
  const run = document.createElement('div');
  run.className = 'col-run';
  article.querySelector('[data-b="c1.1"]').before(run);
  run.append(...article.querySelectorAll('[data-b="c1.1"], [data-b="c1.2"], [data-b="c1.3"]'));
  await settle();
  await tr.load('c1');
  const shape = () => [...run.children].map((el) => el.dataset.b || el.className);
  assert.deepEqual(shape(), ['c1.1', 'tr-block', 'c1.2', 'c1.3', 'tr-block']);
  // Shown again (a part done since, say): the same, not twice.
  tr.show(tr.chapters.get('c1'));
  assert.deepEqual(shape(), ['c1.1', 'tr-block', 'c1.2', 'c1.3', 'tr-block']);
  assert.ok(article.querySelector('[data-b="c1.0"]').nextElementSibling.matches('.tr-h'), 'a heading outside the runs as before');
});

test('a chapter written in Korean has nothing to translate: no bar; one in English has its bar', () => {
  const sec = (blocks) => {
    const el = document.createElement('section');
    el.innerHTML = blocks.map((x, i) => `<div data-b="c9.${i}">${x}</div>`).join('');
    return el;
  };
  assert.equal(writtenInTarget(sec(['기울기 $\\nabla f$는 가장 가파른 방향이다.', '$$\\nabla f = (f_x, f_y)$$'])), true);
  assert.equal(writtenInTarget(sec(['Idle hands are the devil’s workshop.', 'Read Hos. viii. 12.'])), false);
  assert.equal(writtenInTarget(sec(['$$x$$'])), false, 'nothing but formulas');
  const { article, bar } = open();
  assert.ok(bar('c1') && bar('c2'), 'the English chapters have theirs');
  assert.equal(article.querySelectorAll('.tr-bar').length, 2);
});

test('the mode a book opens in, and what a chapter should cost and take', () => {
  assert.equal(pickMode('tgt', true), 'tgt');
  assert.equal(pickMode('src', undefined), 'src');
  assert.equal(pickMode(null, true), 'both');
  assert.equal(pickMode(null, false), 'src');
  assert.equal(pickMode(null, null), 'both');
  assert.equal(pickMode('side', false), 'src', 'an unknown mode is not kept');
  assert.equal(pickMode(null, null, 'tgt'), 'tgt', 'a book brought in with its translation');

  assert.deepEqual(estimate(2000), { cost: '1.30', min: 8 });
  assert.deepEqual(estimate(15_515), { cost: '10.08', min: 62 });
  assert.deepEqual(estimate(300), { cost: '0.20', min: 5 }, 'five minutes at least');
});

test('between polls the bar moves on through the segment on its way: by phase, at the pace measured, never past it nor back, and on from what is saved', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const ago = (s) => new Date(now - s * 1000).toISOString();
  const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} ${actual} ≠ ${expected}`);
  // 10,000 characters, 40% saved; the segment on its way (3,000 characters) brings it to 70%. At
  // 0.2 s a character it takes 600 s: its translation the first 60% of it (360 s), its review the rest.
  const st = { progress: 0.4, segment: { k: 2, n: 3, to: 0.7 }, chars: 10_000, pace: 200 };
  const live = (phase, s, more = {}) => liveProgress({ ...st, phase, phaseAt: ago(s), now, ...more });
  close(live('translate', 0), 0.4);
  close(live('translate', 180), 0.4 + 0.3 * 0.3, 'half its translation');
  close(live('review', 0), 0.4 + 0.3 * 0.6, 'its review starts at 60% of it');
  close(live('review', 120), 0.4 + 0.3 * 0.8, 'half its review');
  // Each phase stops at 90% of its share: short of the review, short of the next segment.
  close(live('translate', 3600), 0.4 + 0.3 * 0.54);
  close(live('review', 3600), 0.4 + 0.3 * 0.96);
  // Never back: through its translation, into its review, and on from 70% once it is saved.
  const saved = liveProgress({ ...st, progress: 0.7, segment: { k: 3, n: 3, to: 1 }, phase: 'translate', phaseAt: ago(0), now });
  const seen = [...[0, 60, 200, 359, 400, 1e4].map((s) => live('translate', s)), ...[0, 100, 239, 1e4].map((s) => live('review', s)), saved];
  assert.ok(seen.every((x, i) => !i || x >= seen[i - 1]), seen.join());
  assert.ok(seen.slice(0, -1).every((x) => x < 0.7) && saved === 0.7);
  // Before a segment is done, the estimate's pace: 4 minutes per 1,000 characters (720 s here).
  close(live('translate', 216, { pace: undefined }), 0.4 + 0.3 * 0.3);
  // No segment on its way, or no phase yet: what is saved; a phase start ahead of this clock: now.
  assert.equal(liveProgress({ progress: 0.4, chars: 10_000, now }), 0.4);
  assert.equal(live(undefined, 10), 0.4);
  close(live('review', -30), 0.4 + 0.3 * 0.6);
  // The time left at the same pace, from where the bar is; never below a minute.
  assert.equal(minutesLeft({ shown: 0.64, chars: 10_000, pace: 200 }), 12);
  assert.equal(minutesLeft({ shown: 0.5, chars: 2000 }), 4);
  assert.equal(minutesLeft({ shown: 0.99, chars: 2000, pace: 200 }), 1);
});

test('a chapter on its way says which segment of how many, translated or reviewed, and moves between polls without rebuilding its bar', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse('2026-10-24T12:00:00.000Z') });
  // Chapter 2 (2,000 characters): the first of two segments, to 50%, translated since now; at a
  // pace of 5 ms a character it takes 5 s, the translation 3 s of it.
  const st = { status: 'working', progress: 0, startProgress: 0, spent: 0, segment: { k: 1, n: 2, to: 0.5 }, phase: 'translate', phaseAt: new Date().toISOString(), pace: 5 };
  const { tr, bar, mark } = open({ statuses: { c2: st } });
  const stop = [...bar('c2').querySelectorAll('button')].find((b) => b.textContent === 'Stop');
  assert.deepEqual([label(bar('c2')), mark('c2').textContent], ['Translating 1/2 · 0% · ≈ 1 min left · $0.00 so far', '0%']);
  t.mock.timers.tick(1000);
  assert.deepEqual([label(bar('c2')), mark('c2').textContent], ['Translating 1/2 · 10% · ≈ 1 min left · $0.00 so far', '10%'], 'a second later, without a poll');
  t.mock.timers.tick(3000);
  assert.equal(mark('c2').textContent, '27%', 'its translation stops at 90% of its share');
  assert.equal([...bar('c2').querySelectorAll('button')].find((b) => b.textContent === 'Stop'), stop, 'the same Stop button');
  // The review, then the segment saved: on from there, never back.
  server.statuses.c2 = { ...st, phase: 'review', phaseAt: new Date().toISOString() };
  await tr.poll();
  assert.equal(label(bar('c2')), 'Reviewing 1/2 · 30% · ≈ 1 min left · $0.00 so far');
  server.statuses.c2 = { ...st, progress: 0.5, spent: 0.81, segment: { k: 2, n: 2, to: 1 }, phaseAt: new Date().toISOString() };
  await tr.poll();
  assert.equal(label(bar('c2')), 'Translating 2/2 · 50% · ≈ 1 min left · $0.81 so far');
  tr.destroy();
});

test('Stop: one tap, then where it stopped and what it cost so far; Resume starts it again', async () => {
  const { tr, bar, mark } = open({ statuses: { c2: { status: 'working', progress: 0.4, startProgress: 0, spent: 0.52, startedAt: new Date().toISOString() } } });
  assert.deepEqual(offers(bar('c2')), ['Stop']);
  [...bar('c2').querySelectorAll('button')].find((b) => b.textContent === 'Stop').click();
  await settle();
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c2/cancel', body: {} });
  assert.equal(document.querySelector('.dialog'), null, 'no confirm dialog');
  assert.equal(bar('c2').querySelector('.tr-status').textContent, 'Stopped at 40% · $0.52 spent');
  assert.deepEqual(offers(bar('c2')), ['Resume']);
  assert.equal(mark('c2').childNodes.length, 0);
  assert.equal(tr.timer, 0, 'nothing to poll once stopped');
  bar('c2').querySelector('button').click();
  await settle();
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c2', body: { again: false } });
  assert.equal(label(bar('c2')), 'Waiting to start');
  tr.destroy();
});

test('a chapter that failed after part of it was done: where, that it is saved, why, and Resume', async () => {
  const error = 'Claude failed 5 times in a row (UND_ERR_SOCKET terminated). The parts done so far are saved.';
  const { tr, bar } = open({ statuses: { c2: { status: 'error', progress: 0.75, spent: 9.1, error } } });
  assert.equal(bar('c2').querySelector('.tr-error').textContent, 'Failed at 75% · saved');
  assert.equal(bar('c2').querySelector('.tr-status').textContent, error);
  assert.deepEqual(offers(bar('c2')), ['Resume']);
  bar('c2').querySelector('button').click();
  await settle();
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c2', body: { again: false } });
  tr.destroy();
});

test('a chapter more than the server translates at once: the refusal is shown to read, and the bar stays as it was', async (t) => {
  const { tr, bar } = open();
  const before = bar('c2').textContent;
  server.busy = true;
  // The message stays up for a while; its timer is not this test's to wait for.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  bar('c2').querySelector('button').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.calls.at(-1).method, 'POST');
  const toast = document.querySelector('.toast.error');
  assert.equal(toast?.textContent, 'Up to 3 chapters can be translated at once. Wait for one to finish, or stop one.');
  assert.equal(bar('c2').textContent, before, 'no "Waiting to start"');
  server.busy = false;
  tr.destroy();
});

test('translating a chapter: one tap on a button that says what it should cost and take, then progress with the time left, then the Korean', async () => {
  const { article, tr, bar, mark } = open();
  assert.equal(bar('c2').textContent, 'Translate · ≈ $1.30 · ≈ 8 min', '2,000 characters');
  bar('c2').querySelector('button').click();
  await settle();
  assert.equal(document.querySelector('.dialog'), null, 'no confirm dialog');
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c2', body: { again: false } });
  assert.deepEqual([label(bar('c2')), offers(bar('c2'))], ['Waiting to start', ['Stop']]);
  assert.ok(mark('c2').querySelector('.spinner'));
  assert.ok(tr.timer, 'polls while a chapter is queued');
  // Segment 2 of 3 (to 70%) reviewed for 30 s of its 48 s, at 0.2 s a character: 65%.
  const phaseAt = new Date(Date.now() - 30_000).toISOString();
  server.statuses.c2 = { status: 'working', progress: 0.4, startProgress: 0, spent: 0.52, startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), segment: { k: 2, n: 3, to: 0.7 }, phase: 'review', phaseAt, pace: 200 };
  await tr.poll();
  assert.deepEqual([label(bar('c2')), offers(bar('c2'))], ['Reviewing 2/3 · 65% · ≈ 2 min left · $0.52 so far', ['Stop']]);
  assert.equal(mark('c2').textContent, '65%');
  server.statuses.c2 = { status: 'ready', progress: 1 };
  server.files.c2 = { chapter: 'c2', blocks: ['엑스'], notes: [] };
  await tr.poll();
  await settle();
  assert.equal(server.calls.at(-1).url, '/api/papers/book-demo/translations/c2');
  assert.equal(article.querySelector('[data-b="c2.0"]').nextElementSibling.textContent, '엑스');
  assert.ok(bar('c2').querySelector('.seg'));
  assert.ok(mark('c2').querySelector('svg'));
  assert.equal(tr.timer, 0, 'polling stops when nothing is queued or working');
  tr.destroy();
});

test('a failed chapter says why, and Retry asks again; a ready chapter whose file is gone is looked for once more, then bought again only once confirmed', async () => {
  const { tr, bar, mark } = open({ statuses: { c1: { status: 'ready' }, c2: { status: 'error', error: 'The model declined.' } } });
  await settle();
  assert.match(bar('c2').textContent, /^The model declined\.Retry$/);
  bar('c2').querySelector('button').click();
  await settle();
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c2', body: { again: false } });
  assert.equal(label(bar('c2')), 'Waiting to start');
  assert.equal(bar('c1').textContent, 'Translate · ≈ $0.04 · ≈ 5 min');
  assert.equal(mark('c1').childNodes.length, 0, 'no check without the translation');
  const tap = async () => {
    bar('c1').querySelector('button').click();
    await settle();
    assert.deepEqual(server.calls.at(-1), { method: 'GET', url: '/api/papers/book-demo/translations/c1', body: undefined }, 'looked for once more');
    return document.querySelector('.dialog');
  };
  const dialog = await tap();
  assert.equal(dialog.querySelector('h3').textContent, 'Translate this chapter again?');
  assert.equal(dialog.querySelector('p').textContent, "Its saved translation can't be found on the server. Translating it again takes about 5 minutes and costs roughly $0.04.");
  dialog.querySelector('.btn-secondary').click();
  await settle();
  assert.equal(server.calls.at(-1).method, 'GET', 'Cancel buys nothing');
  (await tap()).querySelector('.btn-primary').click();
  await settle();
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c1', body: { again: true } });
  assert.equal(label(bar('c1')), 'Waiting to start');
  tr.destroy();

  // Found on the second look (still syncing before, say): shown, and nothing bought.
  const later = open({ statuses: { c1: { status: 'ready' } } });
  await settle();
  server.files.c1 = FILE;
  later.bar('c1').querySelector('button').click();
  await settle();
  assert.equal(document.querySelector('.dialog'), null);
  assert.ok(later.bar('c1').querySelector('.seg'));
  assert.ok(later.mark('c1').querySelector('svg'));
  // Two looks, then where its notes go in the English: reads only, nothing bought.
  assert.deepEqual(
    server.calls.map((c) => [c.method, c.url]),
    [
      ['GET', '/api/papers/book-demo/translations/c1'],
      ['GET', '/api/papers/book-demo/translations/c1'],
      ['GET', '/api/papers/book-demo/translations/c1/notes-src'],
    ],
  );
  later.tr.destroy();
});

test('a note opens beside its marker and closes on a second tap, Escape, a tap elsewhere or a scroll', async () => {
  const { article, tr, bar } = open({ statuses: { c1: { status: 'ready' } }, files: { c1: FILE } });
  await settle();
  let taps = 0;
  article.addEventListener('click', () => taps++); // what the view does with a tap on the text
  const note = () => document.querySelector('.fn-pop')?.textContent ?? null;
  const [one, two] = article.querySelectorAll('sup.fn');
  one.click();
  assert.equal(note(), FILE.notes[0]);
  assert.equal(document.querySelector('.fn-pop').getAttribute('lang'), 'ko');
  one.click();
  assert.equal(note(), null);
  two.click();
  assert.equal(note(), FILE.notes[1]);
  one.click();
  assert.equal(note(), FILE.notes[0], 'another marker swaps the note');
  document.dispatchEvent(key('keydown', 'Escape'));
  assert.equal(note(), null);
  one.dispatchEvent(key('keydown', 'Enter'));
  assert.equal(note(), FILE.notes[0]);
  article.querySelector('[data-b="c1.1"]').dispatchEvent(new Event('pointerdown', { bubbles: true }));
  assert.equal(note(), null);
  two.click();
  document.querySelector('.fn-pop').dispatchEvent(new Event('scroll', { bubbles: true }));
  assert.equal(note(), FILE.notes[1], 'a long note scrolls in its popup');
  window.dispatchEvent(new Event('scroll'));
  assert.equal(note(), null);
  // EN hides the notes too. Its button is replaced during the click, which still must not count
  // as a tap on the text; neither did any tap on a marker.
  two.click();
  bar('c1').querySelector('.seg button').click();
  assert.equal(article.querySelector('#c1').classList.contains('bilingual'), false);
  assert.equal(note(), null);
  assert.equal(taps, 0);
  one.parentElement.click();
  assert.equal(taps, 1, 'the Korean itself is text like the rest');
  bar('c1').querySelectorAll('.seg button')[2].click();
  two.click();
  assert.equal(note(), FILE.notes[1], 'KO keeps the notes');
  tr.destroy();
  assert.equal(note(), null, 'leaving the book closes it');
  storage.delete('pr.trView:book-demo');
});

test('a chapter in parts: a bar at each part, how many are done, n/m on its tab, KO only where translated; one tap translates or stops a part', async () => {
  // The server's rate is the client's, so a part the server cut at $5 is estimated at $5 or less.
  assert.equal((await import('../server/translate.js')).USD_PER_1K_CHARS, USD_PER_1K_CHARS);
  // Chapter 1 in two parts, blocks 0-1 translated; its merged translation has null for part 2.
  const statuses = { c1: { ranges: [[0, 2], [2, 4]], parts: [{ status: 'ready', progress: 1 }] } };
  const merged = { chapter: 'c1', blocks: ['서문.', '게으른 손[^1]은 악마의 작업장이다.', null, null], notes: ['일하지 않는 사람의 손.'], done: [1] };
  const { article, tr, bar, mark } = open({ statuses, files: { c1: merged } });
  await settle();
  const c1 = article.querySelector('#c1');
  const parts = () => [...c1.querySelectorAll(':scope > .tr-part')];
  assert.deepEqual(parts().map((el) => el.nextElementSibling.dataset.b), ['c1.0', 'c1.2'], "at each part's first block");
  assert.deepEqual(parts().map((el) => [el.hidden, el.textContent]), [[true, ''], [false, 'Part 2/2 · Translate · ≈ $0.01 · ≈ 5 min']]);
  assert.equal(bar('c1').querySelector('.tr-status').textContent, '2 parts · 1 translated');
  assert.ok(bar('c1').querySelector('.seg'), 'EN / KO+EN / KO once a part is done');
  assert.equal(mark('c1').textContent, '1/2');
  // Each translated block still has its Korean right after it; KO hides only those.
  assert.deepEqual([...c1.children].map((el) => el.dataset.b || el.className), ['ltx_title ltx_title_section', 'tr-bar', 'tr-bar tr-part', 'c1.0', 'tr-block tr-h', 'c1.1', 'tr-block', 'tr-bar tr-part', 'c1.2', 'c1.3', 'tr-notes']);
  assert.deepEqual([...c1.querySelectorAll('[data-b]')].map((el) => el.classList.contains('tr-done')), [true, true, false, false]);

  parts()[1].querySelector('button').click();
  await settle();
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c1', body: { again: false, part: 2 } });
  assert.deepEqual([label(parts()[1]), offers(parts()[1])], ['Part 2/2 · Waiting to start', ['Stop']]);
  assert.equal(mark('c1').querySelector('.spinner') && mark('c1').textContent, '1/2');
  server.statuses.c1.parts[1] = { status: 'working', progress: 0.5, startProgress: 0, spent: 0.3, startedAt: new Date(Date.now() - 2 * 60_000).toISOString(), segment: { k: 2, n: 2, to: 1 }, phase: 'translate', phaseAt: new Date().toISOString(), pace: 1000 };
  await tr.poll();
  assert.equal(label(parts()[1]), 'Part 2/2 · Translating 2/2 · 50% · ≈ 1 min left · $0.30 so far');
  [...parts()[1].querySelectorAll('button')].find((b) => b.textContent === 'Stop').click();
  await settle();
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c1/cancel', body: { part: 2 } });
  assert.equal(parts()[1].querySelector('.tr-status').textContent, 'Part 2/2 · Stopped at 50% · $0.30 spent');

  // Part 2 done: the merged translation is fetched again and shown whole.
  server.statuses.c1.parts[1] = { status: 'ready', progress: 1 };
  server.files.c1 = { ...merged, blocks: ['서문.', '게으른 손[^1]은 악마의 작업장이다.', '', '호세아 8:12[^2]을 읽어라.'], notes: ['일하지 않는 사람의 손.', '구약 성경의 한 책.'], done: [1, 2] };
  await tr.poll();
  await settle();
  assert.deepEqual(parts().map((el) => el.hidden), [true, true]);
  assert.equal(c1.querySelectorAll(':scope > .tr-block').length, 3);
  assert.deepEqual([...c1.querySelectorAll('[data-b]')].map((el) => el.classList.contains('tr-done')), [true, true, true, true]);
  assert.equal(c1.querySelector('.tr-notes').textContent, '일하지 않는 사람의 손.구약 성경의 한 책.');
  assert.equal(bar('c1').querySelector('.tr-status').textContent, '2 parts · 2 translated');
  assert.ok(mark('c1').querySelector('svg'));
  tr.destroy();
});

test("a chapter in parts whose Korean can't be loaded says why, with Retry; a ready part the server has no file of is offered again; a poll keeps the Stop of a part on its way", async () => {
  const statuses = { c1: { ranges: [[0, 2], [2, 4]], parts: [{ status: 'ready', progress: 1 }, { status: 'working', progress: 0.2, spent: 0.1 }] } };
  server.fail = true;
  const { article, tr, bar } = open({ statuses, files: { c1: { chapter: 'c1', blocks: ['서문.', '게으른 손은 악마의 작업장이다.', null, null], notes: [], done: [1] } } });
  await settle();
  const c1 = article.querySelector('#c1');
  const parts = () => [...c1.querySelectorAll(':scope > .tr-part')];
  assert.equal(bar('c1').textContent, "2 parts · 1 translatedCouldn't load the translation: Storage unreadableRetry");
  assert.equal(c1.querySelectorAll(':scope > .tr-block').length, 0);
  server.fail = false;
  bar('c1').querySelector('button').click();
  await settle();
  assert.equal(c1.querySelectorAll(':scope > .tr-block').length, 2, 'Retry: its Korean');
  assert.equal(bar('c1').querySelector('.tr-error'), null);
  assert.ok(bar('c1').querySelector('.seg'));
  // A poll while part 2 is on its way: the same Stop button, its label new.
  const stop = () => [...parts()[1].querySelectorAll('button')].find((b) => b.textContent === 'Stop');
  const before = stop();
  assert.equal(label(parts()[1]), 'Part 2/2 · Translating · 20% · ≈ 1 min left · $0.10 so far');
  server.statuses.c1.parts[1] = { status: 'working', progress: 0.6, spent: 0.4 };
  await tr.poll();
  assert.equal(label(parts()[1]), 'Part 2/2 · Translating · 60% · ≈ 1 min left · $0.40 so far');
  assert.equal(stop(), before, 'not rebuilt under a finger');
  tr.destroy();

  // The server has no file of a part shown as ready: its bar offers it again, after a look and a confirmation.
  const gone = open({ statuses: { c1: { ranges: [[0, 2], [2, 4]], parts: [{ status: 'ready', progress: 1 }] } } });
  await settle();
  const bars = [...gone.article.querySelectorAll('#c1 > .tr-part')];
  assert.deepEqual(bars.map((el) => [el.hidden, el.textContent]), [[false, 'Part 1/2 · Translate · ≈ $0.03 · ≈ 5 min'], [false, 'Part 2/2 · Translate · ≈ $0.01 · ≈ 5 min']]);
  bars[0].querySelector('button').click();
  await settle();
  const dialog = document.querySelector('.dialog');
  assert.equal(dialog?.querySelector('h3').textContent, 'Translate this chapter again?');
  dialog.querySelector('.btn-primary').click();
  await settle();
  assert.deepEqual(server.calls.at(-1), { method: 'POST', url: '/api/papers/book-demo/translations/c1', body: { again: true, part: 1 } });
  gone.tr.destroy();
});

test('a choice of EN, KO+EN or KO is told (onMode)', async () => {
  const { tr, bar } = open({ statuses: { c1: { status: 'ready' } }, files: { c1: FILE } });
  await settle();
  const modes = [];
  tr.onMode = (mode) => modes.push(mode);
  bar('c1').querySelectorAll('.seg button')[0].click();
  bar('c1').querySelectorAll('.seg button')[0].click();
  bar('c1').querySelectorAll('.seg button')[2].click();
  assert.deepEqual(modes, ['src', 'tgt'], 'once a change');
  tr.destroy();
  storage.delete('pr.trView:book-demo');
});

test('a part done before the one it follows: the notes are numbered on, the English markers of the later part are placed again, once each, and the marks on the Korean painted again', async () => {
  const statuses = { c1: { ranges: [[0, 2], [2, 4]], parts: [null, { status: 'ready', progress: 1 }] } };
  server.notesSrc = { c1: { 1: { b: 3, at: 18, by: 'sentence' } } };
  const { article, tr } = open({ statuses, files: { c1: { chapter: 'c1', blocks: [null, null, '', '호세아 8:12[^1]을 읽어라.'], notes: ['구약 성경의 한 책.'], done: [2] } } });
  let shows = 0;
  tr.onShow = () => shows++;
  await settle();
  await settle();
  const marks = () => [...article.querySelectorAll('#c1 .fn-src')].map((m) => [m.closest('[data-b]').dataset.b, m.dataset.n]);
  assert.deepEqual(marks(), [['c1.3', '1']]);
  // Part 1 done: its note is 1 now, and part 2's is 2.
  server.statuses.c1.parts[0] = { status: 'ready', progress: 1 };
  server.files.c1 = { chapter: 'c1', blocks: ['서문.', '게으른 손[^1]은 악마의 작업장이다.', '', '호세아 8:12[^2]을 읽어라.'], notes: ['일하지 않는 사람의 손.', '구약 성경의 한 책.'], done: [1, 2] };
  server.notesSrc = { c1: { 1: { b: 1, at: 10, by: 'phrase' }, 2: { b: 3, at: 18, by: 'sentence' } } };
  await tr.poll();
  await settle();
  await settle();
  assert.deepEqual(marks(), [['c1.1', '1'], ['c1.3', '2']]);
  assert.deepEqual([...article.querySelectorAll('#c1 > .tr-block')].map((el) => el.dataset.k), ['c1.0k', 'c1.1k', 'c1.3k']);
  assert.deepEqual([...article.querySelectorAll('#c1 > .tr-block .fn')].map((el) => el.dataset.n), ['1', '2']);
  article.querySelector('[data-b="c1.3"] .fn-src').click();
  assert.equal(document.querySelector('.fn-pop')?.textContent, '구약 성경의 한 책.');
  tr.closeNote();
  assert.equal(shows, 2);
  tr.destroy();
  server.notesSrc = {};
});

test('selections and highlights stay in the book’s own text', async () => {
  const { article, tr } = open({ statuses: { c1: { status: 'ready' } }, files: { c1: FILE } });
  await settle();
  const block = article.querySelector('[data-b="c1.1"]');
  assert.equal(inTranslation(block.querySelector('p').firstChild), false);
  assert.equal(inTranslation(article.querySelector('#c1 > h2').firstChild), false);
  assert.equal(inTranslation(block.nextElementSibling.firstChild), true);
  assert.equal(inTranslation(article.querySelector('.tr-bar button')), true);
  assert.equal(inTranslation(article.querySelector('.tr-notes li').firstChild), true);
  assert.equal(inTranslation(null), false);
  // A highlight over three blocks: one range per block, so the Korean between them is not painted.
  document.createRange = () => ({
    setStart(node, offset) {
      this.start = [node, offset];
    },
    setEnd(node, offset) {
      this.end = [node, offset];
    },
  });
  const blocks = new Map([...article.querySelectorAll('[data-b]')].map((el) => [el.dataset.b, el]));
  const ranges = anchorToRanges({ start: { b: 'c1.1', o: 5 }, end: { b: 'c1.3', o: 4 } }, blocks);
  assert.deepEqual(
    ranges.map((r) => [blockOf(r.start[0]).dataset.b, r.start[1], blockOf(r.end[0]).dataset.b, r.end[1]]),
    [
      ['c1.1', 5, 'c1.1', block.textContent.length],
      ['c1.2', 0, 'c1.2', 3],
      ['c1.3', 0, 'c1.3', 4],
    ],
  );
  assert.deepEqual(anchorToRanges({ start: { b: 'c9.1', o: 0 }, end: { b: 'c9.2', o: 1 } }, blocks), []);
  tr.destroy();
});

test('the notes on the English: a marker with no text where the server puts it, opening the same note; the text, its offsets and its taps are as before', async () => {
  server.notesSrc = { c1: { 1: { b: 1, at: 10, by: 'phrase' }, 2: { b: 3, at: 18, by: 'sentence' } } };
  const { article, tr } = open({ statuses: { c1: { status: 'ready' } }, files: { c1: FILE } });
  await settle();
  await settle();
  const block = article.querySelector('[data-b="c1.1"]');
  const [mark] = block.querySelectorAll('.fn-src');
  assert.deepEqual([mark.dataset.n, mark.getAttribute('role'), mark.getAttribute('tabindex'), mark.getAttribute('aria-label'), mark.textContent], ['1', 'button', '0', 'Note 1', '']);
  assert.equal(mark.previousSibling.nodeValue, 'Idle hands', 'after "Idle hands" (게으른 손)');
  assert.equal(block.textContent, 'Idle hands are the devil’s workshop.', 'the text is as it was');
  assert.equal(article.querySelector('[data-b="c1.3"] .fn-src').previousSibling.nodeValue, 'Read Hos. viii. 12');
  // The same popup as the Korean marker's, by a tap or the keyboard, and not a tap on the text.
  let taps = 0;
  article.addEventListener('click', () => taps++);
  mark.click();
  assert.equal(document.querySelector('.fn-pop')?.textContent, FILE.notes[0]);
  mark.dispatchEvent(key('keydown', 'Enter'));
  assert.equal(document.querySelector('.fn-pop'), null);
  mark.dispatchEvent(key('keydown', ' '));
  assert.equal(document.querySelector('.fn-pop')?.textContent, FILE.notes[0]);
  tr.closeNote();
  assert.equal(taps, 0);
  // A highlight after the marker covers the same words, and a selection there has the same offsets.
  document.createRange = () => ({
    setStart(node, offset) {
      this.start = [node, offset];
    },
    setEnd(node, offset) {
      this.end = [node, offset];
    },
  });
  const blocks = new Map([...article.querySelectorAll('[data-b]')].map((el) => [el.dataset.b, el]));
  const [r] = anchorToRanges({ start: { b: 'c1.1', o: 15 }, end: { b: 'c1.1', o: 35 } }, blocks);
  assert.equal(r.start[0], r.end[0]);
  assert.equal(r.start[0].nodeValue.slice(r.start[1], r.end[1]), 'the devil’s workshop');
  assert.equal(offsetIn(block, mark.nextSibling, 5), 15);
  assert.equal(offsetIn(block, mark, 0), 10);
  tr.destroy();
  server.notesSrc = {};
  // Two notes at one place (placed back to front) read 4,5, not 45.
  const p = document.createElement('p');
  p.textContent = 'as plain as the sun in the sky. If I hit hard';
  const five = markSource(p, 31, 5);
  const four = markSource(p, 31, 4);
  assert.deepEqual([...p.querySelectorAll('.fn-src')].map((m) => [m.dataset.n, m.classList.contains('fn-then')]), [
    ['4', true],
    ['5', false],
  ]);
  assert.equal(four.nextSibling, five);
  assert.equal(p.textContent, 'as plain as the sun in the sky. If I hit hard');
});

test('another pair of languages: the view switch names them, the translation and its notes carry the reader\'s language, and a chapter already in it has no bar', async () => {
  try {
    // An English book read in Spanish.
    setLangs({ src: 'en', tgt: 'es' });
    const { article, tr, bar } = open({ statuses: { c1: { status: 'ready' } }, files: { c1: { ...FILE, blocks: ['Prefacio.', 'Las manos ociosas[^1] son el taller del diablo.', '', 'Lee Oseas 8:12[^2].'], notes: ['Manos que no trabajan.', 'Un libro del Antiguo Testamento.'] } } });
    await settle();
    assert.deepEqual([...bar('c1').querySelectorAll('.seg button')].map((b) => b.textContent), ['EN', 'ES+EN', 'ES']);
    assert.deepEqual([...article.querySelectorAll('.tr-block, .tr-notes')].map((el) => el.getAttribute('lang')), ['es', 'es', 'es', 'es']);
    article.querySelector('sup.fn').click();
    assert.equal(document.querySelector('.fn-pop').getAttribute('lang'), 'es');
    tr.destroy();
    storage.delete('pr.trView:book-demo');
    // Labels in Chinese name the languages; a Japanese book read in English is EN+JA.
    assert.deepEqual(['src', 'both', 'tgt'].map((m) => modeLabel(m, { src: 'ja', tgt: 'en' })), ['JA', 'EN+JA', 'EN']);
    setLang('zh');
    assert.deepEqual(['src', 'both', 'tgt'].map((m) => modeLabel(m, { src: 'en', tgt: 'ko' })), ['英语', '韩语英语对照', '韩语']);
    setLang('en');
    // A chapter in the reader's language: told by its script where the two languages have their own.
    const sec = (blocks) => {
      const el = document.createElement('section');
      el.innerHTML = blocks.map((x, i) => `<div data-b="c9.${i}">${x}</div>`).join('');
      return el;
    };
    setLangs({ src: 'en', tgt: 'ja' });
    assert.equal(writtenInTarget(sec(['吾輩は猫である。名前はまだ無い。', 'The cat has no name.'])), true);
    assert.equal(writtenInTarget(sec(['Idle hands are the devil’s workshop.'])), false);
    setLangs({ src: 'en', tgt: 'es' });
    assert.equal(writtenInTarget(sec(['Las manos ociosas son el taller del diablo.'])), false, 'English and Spanish share a script: never taken for done');
  } finally {
    setLangs();
  }
});
