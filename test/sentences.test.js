// Sentences and clauses of a book's blocks, and the pairing of a block with its Korean translation
// sentence by sentence and clause by clause (public/assets/js/sentences.js): pure, no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK, align, clauseUnits, clauses, pairClauses, sentenceAt, sentences } from '../public/assets/js/sentences.js';

const split = (text, lang) => sentences(text, lang).map(([s, e]) => text.slice(s, e));

test('English: titles, initials and the usual abbreviations do not end a sentence', () => {
  assert.deepEqual(split('Mr. Smith met Dr. Jones at St. Paul’s. Mrs. Brown came too.'), ['Mr. Smith met Dr. Jones at St. Paul’s.', 'Mrs. Brown came too.']);
  assert.deepEqual(split('Read the rest, i.e. The second part; see e.g. The ox, the ass, &c. And viz. The sheep. Done.'), [
    'Read the rest, i.e. The second part; see e.g. The ox, the ass, &c. And viz. The sheep.',
    'Done.',
  ]);
  assert.deepEqual(split('Try his “Pictures;” which is a second volume. C. H. SPURGEON.'), ['Try his “Pictures;” which is a second volume.', 'C. H. SPURGEON.']);
  assert.deepEqual(split('One of the “Mr. Talkative” kind. So said I. Then he went.'), ['One of the “Mr. Talkative” kind.', 'So said I.', 'Then he went.']);
});

test('English: Matthew Henry’s verse references and outline numbers stay with their sentence', () => {
  assert.deepEqual(
    split("We have three things in this chapter:—I. A general idea given us of the work of creation ver. 1, 2. II. A particular account of the several days' work. The creation of the light the first day, ver. 3-5; of the firmament the second day, ver. 6-8."),
    [
      'We have three things in this chapter:—I. A general idea given us of the work of creation ver. 1, 2.',
      "II. A particular account of the several days' work.",
      'The creation of the light the first day, ver. 3-5; of the firmament the second day, ver. 6-8.',
    ],
  );
  assert.deepEqual(split('The Creation. (b. c. 4004.)'), ['The Creation. (b. c. 4004.)']);
  assert.deepEqual(split('In answer to a good conscience, "Where is God my Maker?" (Job xxxv. 10). Concerning this the philosophers blundered.'), [
    'In answer to a good conscience, "Where is God my Maker?" (Job xxxv. 10).',
    'Concerning this the philosophers blundered.',
  ]);
  assert.deepEqual(split('(1.) The effect produced, Acts xvii. 24. The world is a great house. In it we observe, [1.] Great variety. [2.] Great beauty.'), [
    '(1.) The effect produced, Acts xvii. 24.',
    'The world is a great house.',
    'In it we observe, [1.] Great variety.',
    '[2.] Great beauty.',
  ]);
});

test('English: a speaker’s name heading a paragraph of dialogue goes with what he says', () => {
  assert.deepEqual(split('Chr. I seek an Inheritance. Read it so.'), ['Chr. I seek an Inheritance.', 'Read it so.']);
  assert.deepEqual(split('Good-will. Who is there?'), ['Good-will. Who is there?']);
  assert.deepEqual(split('He went on. Hope. Not so.'), ['He went on.', 'Hope.', 'Not so.'], 'only at the head');
  assert.deepEqual(split('Faith. 1. I say then, that the soul is all. 2. And the rest.'), ['Faith. 1. I say then, that the soul is all.', '2. And the rest.'], 'what it opens may begin with an outline number');
});

test('English: quotes, and a last sentence with no stop', () => {
  assert.deepEqual(split('He said, "Go home." Then she left. "Why?" asked he. It was late'), ['He said, "Go home."', 'Then she left.', '"Why?" asked he.', 'It was late']);
  assert.deepEqual(split('  Lone line without a stop  '), ['Lone line without a stop']);
  assert.deepEqual(split(''), []);
});

test('the sentence at a character: none on the white space between two', () => {
  const text = 'Hello world.  Next one here.';
  const spans = sentences(text);
  assert.deepEqual(spans, [
    [0, 12],
    [14, 28],
  ]);
  assert.deepEqual([0, 11, 12, 13, 14, 27, 28].map((i) => sentenceAt(spans, i)), [0, 0, -1, -1, 1, 1, -1]);
  assert.equal(sentenceAt(spans, -1), -1);
});

test('Korean: closing quotes, ?, !, a note marker after the stop, a quotation said with 하고', () => {
  assert.deepEqual(split('이렇게 말했다. “맛보세요.” 그래서 덧붙인다. 정말요? 네! 그렇다', 'ko'), ['이렇게 말했다.', '“맛보세요.”', '그래서 덧붙인다.', '정말요?', '네!', '그렇다']);
  // On the page a note's marker is a superscript number ("…다.1 우리는"), which the segmenter would
  // read as part of the sentence; masked, the offsets stay and the break is found.
  const marked = `뜻이기 때문이다.${MASK} 우리는 부른다.`;
  assert.deepEqual(sentences(marked, 'ko'), [
    [0, 9],
    [11, 19],
  ]);
  assert.deepEqual(split(`『존 플라우먼의 이야기』${MASK}에서 나는 썼다.`, 'ko'), [`『존 플라우먼의 이야기』${MASK}에서 나는 썼다.`]);
  assert.deepEqual(split('친구들이 "편히 지내게." 하고 말하는 것도 알기 때문이다.', 'ko'), ['친구들이 "편히 지내게." 하고 말하는 것도 알기 때문이다.']);
  assert.deepEqual(split('둘째 권이다. C. H. 스펄전', 'ko'), ['둘째 권이다.', 'C. H. 스펄전']);
});

test('alignment: a long English sentence often becomes several Korean ones', () => {
  const en = [
    'It is of no more use to give advice to the idle than to pour water into a sieve; and as to improving them, one might as well try to fatten a greyhound.',
    'Yet, as The Old Book tells us to "cast our bread upon the waters," we will cast a hard crust or two upon these stagnant ponds; for there will be this comfort about it, if lazy fellows grow no better, we shall be none the worse for having warned them; for when we sow good sense, the basket gets none the emptier.',
    "We have a stiff bit of soil to plough when we chide with sluggards, and the crop will be of the smallest; but if none but good land were farmed, ploughmen would be out of work; so we'll put the plough into the furrow.",
  ];
  const ko = [
    '게으른 사람에게 충고하는 것은 체에 물을 붓는 것만큼이나 소용없는 일이다.',
    '그들을 고쳐 보겠다는 건 그레이하운드를 살찌우려는 것과 다를 바 없다.',
    '그래도 옛 책이 우리에게 “빵을 물 위에 던지라”고 하니, 우리도 이 고여서 썩은 웅덩이들 위에 딱딱한 빵 껍질 한두 조각쯤은 던져 보련다.',
    '그러면 적어도 이런 위안은 있을 것이다.',
    '게으른 녀석들이 조금도 나아지지 않는다 해도, 그들에게 경고해 준 우리가 손해 볼 것은 없다.',
    '좋은 분별을 뿌린다고 해서 씨 바구니가 조금이라도 비지는 않으니까.',
    '게으름뱅이를 꾸짖는 일은 꽤나 딱딱한 땅을 가는 일이어서, 거둘 것도 아주 보잘것없을 것이다.',
    '하지만 좋은 땅에서만 농사를 짓는다면 쟁기꾼들은 일거리가 없을 테니, 자, 쟁기를 고랑에 대 보자.',
  ];
  assert.deepEqual(align(en, ko), [
    [0, 1, 0, 2],
    [1, 2, 2, 6],
    [2, 3, 6, 8],
  ]);
  assert.deepEqual(align(['One.', 'Two.'], ['하나.', '둘.']), [
    [0, 1, 0, 1],
    [1, 2, 1, 2],
  ]);
  assert.deepEqual(align([], []), []);
});

test('alignment: a Korean sentence giving a reason ("…때문이다.") goes with the sentence before it', () => {
  const en = [
    'We have now before us the holy Bible, or book, for so bible signifies.',
    'We call it the book, by way of eminency; for it is incomparably the best book that ever was written, the book of books, shining like the sun in the firmament of learning, other valuable and useful books, like the moon and stars, borrowing their light from it.',
  ];
  const ko = [
    "이제 우리 앞에는 거룩한 성경(바이블), 곧 거룩한 '책'이 놓여 있다.",
    "'바이블'이라는 말이 바로 '책'이라는 뜻이기 때문이다.",
    "우리는 으뜸이라는 뜻에서 이 책을 '바로 그 책'이라고 부른다.",
    '이 책은 지금까지 쓰인 책 가운데 비교할 수 없이 가장 훌륭한 책, 곧 책 중의 책이기 때문이다.',
    '이 책은 학문의 하늘에서 해처럼 빛나고, 다른 귀하고 유익한 책들은 달과 별처럼 이 책에서 빛을 빌려 온다.',
  ];
  assert.deepEqual(align(en, ko), [
    [0, 1, 0, 2],
    [1, 2, 2, 5],
  ]);
});

test('alignment: lengths are compared at the block’s own ratio, so a terse or a wordy translation pairs the same', () => {
  const en = ['a'.repeat(40), 'b'.repeat(120), 'c'.repeat(40)];
  // The middle sentence is split in two; the Korean is half as long, then half as long again.
  const ko = (k) => [40, 60, 60, 40].map((n) => '가'.repeat(Math.round(n * k)));
  for (const k of [0.5, 1.5]) {
    assert.deepEqual(align(en, ko(k)), [
      [0, 1, 0, 1],
      [1, 2, 1, 3],
      [2, 3, 3, 4],
    ]);
  }
});

const cut = (text) => clauses(text, [0, text.length]).map((c) => text.slice(...c));

test('clauses: cut after a comma, semicolon, colon or dash, but not in a number, brackets or a list of references', () => {
  assert.deepEqual(cut('He sleeps till noon, and he begs at night; so he is poor and wretched all the year round.'), ['He sleeps till noon,', 'and he begs at night;', 'so he is poor and wretched all the year round.']);
  assert.deepEqual(cut('He paid 1,000 pounds for the farm, and he lost it all.'), ['He paid 1,000 pounds for the farm,', 'and he lost it all.']);
  assert.deepEqual(cut('He came (as, indeed, he said he would) to the door, and he knocked twice.'), ['He came (as, indeed, he said he would) to the door,', 'and he knocked twice.']);
  assert.deepEqual(cut('See John i. 3, 10; Eph. iii. 9, and the rest of the places.'), ['See John i. 3, 10; Eph. iii. 9,', 'and the rest of the places.']);
  assert.deepEqual(cut('He would not work—not he—and so he starved.'), ['He would not work—not he—', 'and so he starved.']);
  // So does a dash of any kind, but not one between numbers, nor a hyphen inside a word.
  assert.deepEqual(cut('He would not work – not he – and so he starved.'), ['He would not work – not he –', 'and so he starved.']);
  assert.deepEqual(cut('He would not work -- not he -- and so he starved.'), ['He would not work -- not he --', 'and so he starved.']);
  assert.deepEqual(cut('He would not work - not he - and so he starved.'), ['He would not work - not he -', 'and so he starved.']);
  assert.deepEqual(cut('Read verses 3–5, and then 7 - 9 again, with a well-known man.'), ['Read verses 3–5, and then 7 - 9 again,', 'with a well-known man.']);
  // Verse: a line's end (" / ") opens no clause.
  assert.deepEqual(cut('Now was I in a straight; and did not see / Which was the best thing to be done by me: / At last I thought,'), [
    'Now was I in a straight;',
    'and did not see / Which was the best thing to be done by me:',
    'At last I thought,',
  ]);
});

test('clauses: a margin note stays with the clause before it, an outline number opens the one after; a short piece joins a neighbour', () => {
  assert.deepEqual(cut('I lighted on a certain place where was a Den [The Gaol.]: and I laid me down in that place to sleep;'), ['I lighted on a certain place where was a Den [The Gaol.]:', 'and I laid me down in that place to sleep;']);
  assert.deepEqual(cut('In it we observe, [1.] Great variety, and great beauty in all of it.'), ['In it we observe, [1.] Great variety,', 'and great beauty in all of it.']);
  // "said he," leans back on what it follows, "Yet," opens what follows; a reference goes back.
  assert.deepEqual(cut('Yet, as he ran, said he, the road grew long.'), ['Yet, as he ran, said he,', 'the road grew long.']);
  assert.deepEqual(cut('The creation of the light the first day, ver. 3-5; of the firmament the second day, ver. 6-8.'), ['The creation of the light the first day, ver. 3-5;', 'of the firmament the second day, ver. 6-8.']);
  // (past 1,000 pieces, none is joined: each join goes over them all again)
  assert.equal(cut(`${Array.from({ length: 1001 }, (_, i) => `w${i}`).join(', ')}.`).length, 1001);
});

test('a block’s clauses are numbered in order, each with its sentence', () => {
  assert.deepEqual(clauseUnits('Mr. Smith is idle. He sleeps till noon, and he begs at night.'), [
    { c: [0, 18], s: 0 },
    { c: [19, 39], s: 1 },
    { c: [40, 61], s: 1 },
  ]);
});

test('clauses paired without the model: in order by length inside a pair of sentences; where the counts are far apart, none (the sentence must do); a clause alone has its sentence', () => {
  const en = 'He sleeps till noon, and he begs at night; so he is poor and wretched all the year round.';
  const ko = '그는 낮까지 잠을 자고, 밤에는 구걸하러 다닌다. 그래서 일 년 내내 가난하고 비참하다.';
  assert.deepEqual(
    pairClauses(en, ko).map((s) => ko.slice(...s)),
    ['그는 낮까지 잠을 자고,', '밤에는 구걸하러 다닌다.', '그래서 일 년 내내 가난하고 비참하다.'],
  );
  const five = 'Sometimes they would deride, sometimes they would chide, and sometimes they would neglect him, and he would weep, and he would pray.';
  assert.deepEqual(pairClauses(five, '그들이 그를 업신여기자 그는 울며 기도했다.'), [null, null, null, null, null]);
  const two = '게으름뱅이가 잘 때 깊이 갈아라. 그러면 먹을 것이 넉넉하리라.';
  assert.deepEqual(pairClauses('Plough deep while sluggards sleep.', two), [[0, two.length]]);
});

test('a book written with LaTeX: no sentence or clause ends inside a formula or a bold run', () => {
  const text = '**목표.** 1장은 바탕이다. 성분은 $\\mathbf{v}=v_x\\,\\mathbf{e}_x$처럼 단다, 그리고 이것이 마지막 구절이다.';
  const [first, second] = sentences(text, 'ko');
  assert.equal(text.slice(...first), '**목표.** 1장은 바탕이다.');
  assert.deepEqual(
    clauses(text, second).map(([s, e]) => text.slice(s, e)),
    ['성분은 $\\mathbf{v}=v_x\\,\\mathbf{e}_x$처럼 단다,', '그리고 이것이 마지막 구절이다.'],
  );
  // (dollars as money are no formula)
  assert.deepEqual(split('It costs $5 and $10. Fine.'), ['It costs $5 and $10.', 'Fine.']);
});

test('a book written with LaTeX: a formula that ends with a stop ends its sentence; a label in bold or italic heads its own', () => {
  assert.deepEqual(split('We have $$F = ma.$$ Then we go.'), ['We have $$F = ma.$$', 'Then we go.']);
  assert.deepEqual(split('Then $x = 1.$ And so on.'), ['Then $x = 1.$', 'And so on.']);
  assert.deepEqual(split('그래서 $$F = ma.$$ 다음으로 간다.', 'ko'), ['그래서 $$F = ma.$$', '다음으로 간다.']);
  assert.deepEqual(split('Let $$x. Y = 1.$$ Then.'), ['Let $$x. Y = 1.$$', 'Then.'], 'a break inside it before its stop');
  // What goes on from it stays, and so does what follows a formula without a stop at its end.
  assert.deepEqual(split('We have $$F = ma.$$ where m is the mass.'), ['We have $$F = ma.$$ where m is the mass.']);
  assert.deepEqual(split('$$a. B$$ Next one.'), ['$$a. B$$ Next one.']);
  assert.deepEqual(split('The end: $$x = 1.$$'), ['The end: $$x = 1.$$']);
  assert.deepEqual(split('**Fig. 1. Title.** Text. Next.'), ['**Fig. 1. Title.** Text.', 'Next.']);
  assert.deepEqual(split('*걸음 1, 기울기.* 다음 문장이다.', 'ko'), ['*걸음 1, 기울기.* 다음 문장이다.']);
});
