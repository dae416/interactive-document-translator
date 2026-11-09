// Pictures of scanned books: what tesseract's hOCR says about a page, where each picture goes,
// paper.html and the route that serves them. Neither tesseract nor poppler is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { ROOT, signIn, startServer, tempDir, writeBookFixture } from './helpers.js';

const { placeFigure, readHocr } = await import('../server/figures.js');
const { chaptersFromPages } = await import('../server/parse.js');
const { renderHtml } = await import('../server/book.js');

const PW = 'test-password';
const fixture = (...p) => path.join(ROOT, 'test', 'fixtures', ...p);
const h = (x) => ({ t: 'h', x });
const p = (x) => ({ t: 'p', x });

test('hOCR: the page size, its pictures and its lines of text', () => {
  const page = readHocr(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
 <body>
  <div class='ocr_page' id='page_1' title='image "p9.png"; bbox 0 0 1000 1500; ppageno 0; scan_res 300 300'>
   <div class='ocr_carea' id='block_1_1' title="bbox 100 40 900 80">
    <p class='ocr_par' id='par_1_1' lang='eng' title="bbox 100 40 900 80">
     <span class='ocr_header' id='line_1_1' title="bbox 100 40 900 80; baseline 0 -8; x_size 40">
      <span class='ocrx_word' id='word_1_1' title='bbox 100 40 300 80; x_wconf 92'>JOHN</span>
      <span class='ocrx_word' id='word_1_2' title='bbox 320 40 900 80; x_wconf 79'>PLOUGHMAN&#39;S</span>
     </span>
    </p>
   </div>
   <div class='ocr_separator' id='block_1_2' title="bbox 140 110 860 118"></div>
   <div class='ocr_photo' id='block_1_3' title="bbox 150 120 850 700"></div>
   <div class='ocr_photo' id='block_1_4' title="bbox 0 221 0 597"></div>
   <div class='ocr_carea' id='block_1_5' title="bbox 100 720 900 820">
    <p class='ocr_par' id='par_1_2' lang='eng' title="bbox 100 720 900 820">
     <span class='ocr_caption' id='line_1_2' title="bbox 120 720 880 760; baseline 0 -9">
      <span class='ocrx_word' id='word_1_3' title='bbox 120 720 300 760; x_wconf 90'>&quot;Salt</span>
      <span class='ocrx_word' id='word_1_4' title='bbox 320 720 400 760; x_wconf 90'>&amp;</span>
      <span class='ocrx_word' id='word_1_5' title='bbox 420 720 880 760; x_wconf 90'><strong>&lt;pepper&gt;&quot;</strong></span>
     </span>
     <span class='ocr_line' id='line_1_3' title="bbox 100 780 900 820; baseline 0 -9">
      <span class='ocrx_word' id='word_1_6' title='bbox 100 780 900 820; x_wconf 90'>—Page 7.</span>
     </span>
    </p>
   </div>
  </div>
 </body>
</html>`);
  assert.deepEqual(page, {
    size: [1000, 1500],
    photos: [[150, 120, 850, 700]],
    lines: [
      { box: [100, 40, 900, 80], text: "JOHN PLOUGHMAN'S" },
      { box: [120, 720, 880, 760], text: '"Salt & <pepper>"' },
      { box: [100, 780, 900, 820], text: '—Page 7.' },
    ],
  });
});

test('hOCR: a picture is a fifth of the page wide and a tenth high at least, and not the whole scan', () => {
  const photos = (page, ...boxes) =>
    readHocr(`${page}${boxes.map((b) => `<div class='ocr_photo' id='b' title="bbox ${b.join(' ')}"></div>`).join('')}`).photos;
  const page = `<div class='ocr_page' id='page_1' title='bbox 0 0 1000 2000'>`;
  const kept = [
    [0, 0, 200, 200],
    [50, 50, 950, 1800], // 78.75% of the page
  ];
  const dropped = [
    [0, 0, 199, 1000],
    [0, 0, 1000, 199],
    [0, 0, 1000, 1601], // 80.05%, a cover or endpaper
    [400, 300, 400, 900],
  ];
  assert.deepEqual(photos(page, ...kept, ...dropped), kept);
  assert.deepEqual(photos('', ...kept), [], 'no page size, no pictures');
});

// A page as readHocr gives it: lines [top, bottom, text] across a 1000 x 1500 page.
const scanned = (...lines) => ({ size: [1000, 1500], photos: [], lines: lines.map(([y0, y1, text]) => ({ box: [100, y0, 900, y1], text })) });
const CHAPTERS = [
  {
    id: 'c1',
    title: 'Debt',
    pages: [10, 12],
    blocks: [
      h('DEBT.'),
      p('When a man is in debt he is like a bird with its wings clipped.'),
      p('Owe no man anything, but pay your way like an honest fellow.'),
      p('The borrower is servant to the lender, as the old book says.'),
    ],
  },
  { id: 'c2', title: 'Home', pages: [13, 14], blocks: [h('HOME.'), p('That word home always sounds like poetry to me.'), p('A house is not a home unless there is love in it.')] },
];
const PICTURE = [100, 300, 900, 1000];
const place = (n, pages) => placeFigure(CHAPTERS, Object.assign([], pages), n, PICTURE);

test('a picture goes before the block of the first line below it, past lines in it and lines of other text', () => {
  const p11 = scanned([40, 80, 'JOHN PLOUGHMAN’S TALK.'], [600, 640, 'The borrower is servant to the'], [1100, 1140, 'Weather and sunshine overhead today'], [1150, 1190, 'Owe no man anything, but pay your']);
  assert.deepEqual(place(11, { 10: p11 }), { chapter: 'c1', before: 2 });
});

test('with no line below it, the top of the next page, past its running head; then a line above it, after its block', () => {
  const head = [40, 80, 'THE BORROWER IS SERVANT TO THE LENDER.'];
  assert.deepEqual(place(11, { 10: scanned(), 11: scanned(head, [120, 160, 'When a man is in debt he is']) }), { chapter: 'c1', before: 1 });
  // The next page's first lines are not this chapter's.
  const above = [200, 240, 'like a bird with its wings clipped.'];
  assert.deepEqual(place(12, { 11: scanned(above), 12: scanned([120, 160, 'That word home always sounds']) }), { chapter: 'c1', before: 2 });
  // Then the foot of the page before (its folio has no words).
  const foot = scanned([1300, 1340, 'Owe no man anything, but pay your way'], [1400, 1440, '(7)']);
  assert.deepEqual(place(11, { 9: foot, 10: scanned(head) }), { chapter: 'c1', before: 3 });
});

test('a picture with no text to go by opens its chapter on its first page (after the heading) and ends it on any other', () => {
  assert.deepEqual(place(13, {}), { chapter: 'c2', before: 1 });
  assert.deepEqual(place(14, { 13: scanned([1200, 1240, 'Nothing like this is in the book anywhere']) }), { chapter: 'c2', before: 3 });
  assert.deepEqual(place(20, {}), { chapter: 'c2', before: 3 }, 'the nearest chapter');
});

test('Ploughman, page 16: the woodcut opens "To the Idle", after its heading', () => {
  const { pages } = JSON.parse(fs.readFileSync(fixture('ploughman-ocr-pages.json'), 'utf8'));
  const chapters = chaptersFromPages(pages).map((c, i) => ({ id: `c${i + 1}`, ...c }));
  // tesseract 5.4 at 300 dpi
  const p16 = readHocr(fs.readFileSync(fixture('ploughman-p16.hocr'), 'utf8'));
  assert.deepEqual(p16.size, [1238, 1851]);
  assert.deepEqual(p16.photos, [[202, 382, 1144, 1272]]);
  assert.equal(p16.lines[1].text, 'T is of no more use to give advice to the');
  const scan = [];
  scan[15] = p16;
  assert.deepEqual(placeFigure(chapters, scan, 16, p16.photos[0]), { chapter: 'c3', before: 1 });
  assert.equal(chapters[2].title, 'To the Idle');
});

test('paper.html: a picture goes before its block or at the end of its chapter, with no id, its attributes escaped', () => {
  const book = {
    chapters: [
      { id: 'c1', title: 'One', blocks: [h('ONE.'), p('First.'), p('Second.')] },
      { id: 'c2', title: 'Two', blocks: [p('Third.')] },
    ],
    figures: [
      { id: 'p3-1', chapter: 'c1', before: 1, page: 3, w: 480, h: 454 },
      { id: 'p3-2', chapter: 'c1', before: 1, page: 3, w: 10, h: 20 },
      { id: 'p9-1', chapter: 'c2', before: 1, page: 9, w: 300, h: 200 },
      { id: 'p"><script>x()</script>', chapter: 'c1', before: 3, page: 4, w: '1" onerror="x()', h: 1 },
    ],
  };
  const html = renderHtml(book);
  assert.ok(html.includes('<figure class="book-fig"><img data-fig="p3-1.png" width="480" height="454" alt=""></figure>\n<figure class="book-fig"><img data-fig="p3-2.png"'));
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const kids = (c) => [...document.getElementById(c).children].map((el) => el.dataset.b || el.querySelector('img')?.getAttribute('data-fig') || el.localName);
  assert.deepEqual(kids('c1'), ['h2', 'c1.0', 'p3-1.png', 'p3-2.png', 'c1.1', 'c1.2', 'p"><script>x()</script>.png']);
  assert.deepEqual(kids('c2'), ['h2', 'c2.0', 'p9-1.png']);
  assert.equal(document.querySelectorAll('script, [onerror]').length, 0);
  assert.equal(document.querySelectorAll('figure [id], figure[id], figure [data-b], figure[data-b]').length, 0);
  // The text of the blocks is as before.
  assert.equal(renderHtml({ chapters: book.chapters }).replace(/<figure.*<\/figure>\n/g, ''), html.replace(/<figure.*<\/figure>\n/g, ''));
});

test('a picture is served to a signed-in reader by its name, and nothing else is; an empty one is a placeholder, not a picture', async () => {
  const dir = tempDir();
  writeBookFixture(dir, 'pdf-scan', { chapters: [{ id: 'c1', title: 'One', blocks: [p('One.')], pages: [1, 1], url: null }] });
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  fs.mkdirSync(path.join(dir, 'papers', 'pdf-scan', 'figures'));
  fs.writeFileSync(path.join(dir, 'papers', 'pdf-scan', 'figures', 'p1-1.png'), png);
  fs.writeFileSync(path.join(dir, 'papers', 'pdf-scan', 'figures', 'p1-2.png'), '');
  const srv = await startServer({ dataDir: dir, env: { PAPERGLOSS_PASSWORD: PW } });
  try {
    const cookie = await signIn(srv.url, PW);
    const get = (name, headers = { Cookie: cookie }) => fetch(`${srv.url}/api/papers/pdf-scan/figures/${name}`, { headers });
    const res = await get('p1-1.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control'), /^private, max-age=\d+$/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    for (const name of ['..%2Fmeta.json', '..%2F..%2Fconfig.json', 'p1-1.svg', 'x.png', 'p1-1.png%00', 'p12345-1.png']) assert.equal((await get(name)).status, 400, name);
    assert.equal((await get('p2-1.png')).status, 404);
    const empty = await get('p1-2.png');
    assert.equal(empty.status, 503);
    assert.equal(empty.headers.get('cache-control'), 'no-store', 'not kept for a week');
    assert.equal((await get('p1-1.png', {})).status, 401);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
