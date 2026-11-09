// The system prompt of book threads: a brief of the book, a summary of every chapter and the
// full chapter being read. Same book, chapter and languages give the same bytes, so the prompt
// cache keeps hitting.
import { DEFAULT_LANGS } from '../public/assets/js/langs.js';
import { answerLang, bookLangs } from './config.js';
import { wordsFor } from './langs.js';
import { HttpError, attr } from './util.js';
import { checkId, getMeta, readBook } from './papers.js';

// Bump when the instructions change; stored lookups are keyed on it.
export const PROMPT_VERSION = 3;

// ponytail: the whole chapter up to 600k characters; upgrade: send a window around the selection.
const CHAPTER_LIMIT = 600_000;
// A chapter longer than this with section heads (b.r 'sec': a textbook's chapter of many sections in
// one tab) gives the model only the section of the block asked about, else its first.
const SECTION_AFTER = 60_000;

// For a reader of the target language working through a book in the source one, `pair` (English →
// Korean unless said), answering in `lang`.
export function instructions(lang, pair = DEFAULT_LANGS) {
  const w = wordsFor(pair);
  const template = `You are a reading companion for ${w.aT} reader working through ${w.aS} book. Below are a brief about the book, a summary of each chapter, and the full text of the chapter being read. Use them, with your general knowledge of history, theology, literature and older ${w.S}, to read the selection as it is meant at that spot. Answer in {lang}. Be brief; the reader is mid-page.

Mode word: **word** /IPA/ for ordinary words, its meaning here, then up to 3 common senses; flag archaic, dialect or proverbial use in one line with the modern equivalent.
Mode sentence: a faithful, natural translation; one short note only if an idiom, archaism, allusion or hard construction needs it.
Mode paragraph: a faithful translation in paragraphs, no commentary unless something would be misread.
Task explain: 3-6 short bullet points on what the selection means here and why it matters in the chapter; background (people, places, Scripture, customs, older words) only where it helps; no full translation.
Question: answer it directly and briefly from the chapter and your knowledge.
Selection lang="${pair.tgt}": part of the ${w.T} translation shown beside the book; the paragraph is its ${w.S} original. Explain or answer about the words of the original it renders, quoting only the few ${w.S} words that matter.

Keep names and Scripture references recognizable${w.example}. Never repeat the original text.`;
  return template.replace('{lang}', lang);
}

// Summaries join the block together with the brief, which is written last, so the cached block
// changes once after an import instead of with every summary.
export function bookBlock(meta, book) {
  const lines = [`<book title="${attr(meta.title)}" author="${attr((meta.authors || []).join(', '))}">`, `<brief>${book.brief || ''}</brief>`];
  for (const c of book.chapters) {
    const summary = book.brief && book.summaries?.[c.id];
    lines.push(summary ? `<chapter id="${c.id}" title="${attr(c.title)}">${summary}</chapter>` : `<chapter id="${c.id}" title="${attr(c.title)}"/>`);
  }
  lines.push('</book>');
  return lines.join('\n');
}

// at: the index of the block asked about in the chapter (-1: none). whole: all of it however long
// (a journal article, read as one).
export function chapterBlock(chapter, at = -1, whole = false) {
  let { blocks, title } = chapter;
  const heads = blocks.flatMap((b, i) => (b.r === 'sec' ? [i] : []));
  if (!whole && heads.length && blocks.reduce((n, b) => n + b.x.length, 0) > SECTION_AFTER) {
    const k = heads.filter((i) => i <= (at >= 0 ? at : heads[0])).length;
    // (before the first head: what opens the chapter, with the first section)
    const from = k ? heads[k - 1] : 0;
    const to = heads[k ? k : 1] ?? blocks.length;
    if (k) title = `${title} — ${blocks[from].x}`;
    blocks = blocks.slice(from, to);
  }
  const text = blocks.map((b) => b.x).join('\n\n').slice(0, CHAPTER_LIMIT);
  return `<current_chapter id="${chapter.id}" title="${attr(title)}">\n${text}\n</current_chapter>`;
}

export function buildSystem(meta, book, chapter, lang, at = -1, pair = DEFAULT_LANGS) {
  const cache = { type: 'ephemeral', ttl: '1h' };
  return [
    { type: 'text', text: instructions(lang, pair) },
    { type: 'text', text: bookBlock(meta, book), cache_control: cache },
    { type: 'text', text: chapterBlock(chapter, at, book.layout === 'paper'), cache_control: cache },
  ];
}

// Checks `book: { id, chapter, block? }` from a chat request (block: the one asked about, "c3.12"
// or its translation "c3.12k"); throws before anything is streamed. `lang`: the answer language,
// else the one set for answers (answerLang). Also gives the book's languages and that answer
// language, which its stored replies are keyed on.
export async function bookContext(ref, lang) {
  if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string' || typeof ref.chapter !== 'string') {
    throw new HttpError(400, 'book.badRef');
  }
  const id = checkId(ref.id);
  const meta = await getMeta(id);
  if (meta.kind !== 'book') throw new HttpError(400, 'book.notBook');
  const book = await readBook(id);
  const chapter = book.chapters.find((c) => c.id === ref.chapter);
  if (!chapter) throw new HttpError(400, 'book.badChapter');
  const block = typeof ref.block === 'string' ? /^(c\d+)\.(\d+)k?$/.exec(ref.block) : null;
  const at = block && block[1] === chapter.id ? Number(block[2]) : -1;
  // `line` names the book for the model router, which never sees the chapter.
  const line = `<book title="${attr(meta.title)}" author="${attr((meta.authors || []).join(', '))}"/>`;
  const langs = bookLangs(meta);
  const answer = lang ?? answerLang(langs.tgt);
  return { id, chapter: chapter.id, line, langs, answer, system: buildSystem(meta, book, chapter, answer, at, langs) };
}
