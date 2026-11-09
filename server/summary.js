// Chapter summaries and a brief of the book, the background every lookup in the book is answered
// with. Anthropic only; made once, saved chapter by chapter so a crash loses at most one.
import { bookLangs, effectiveLlm } from './config.js';
import { nameOf } from './langs.js';
import { effortFor, hasKey, makeClient } from './llm/anthropic.js';
import { logUsage } from './lookups.js';
import { getMeta, readBook, updateBook, updateMeta } from './papers.js';
import { attr } from './util.js';
import { countWords } from '../public/assets/js/langs.js';

const MODEL = process.env.SUMMARY_MODEL || 'claude-haiku-5-5';
// Haiku answers with thinking off. Other models think (they may not turn it off), at low effort
// and with room for the thinking in max_tokens.
const HAIKU = /^claude-haiku-/.test(MODEL);
const MIN_WORDS = 150;
// ponytail: a summary reads the first 300k characters of a chapter; upgrade: summarize long chapters in parts.
const SUMMARY_INPUT_LIMIT = 300_000;
// In the language the book is written in (`S`, its name).
const summaryPrompt = (S) => `Summarize this chapter in 3-5 ${S} sentences for use as background context: the argument or events, key names and terms.`;
const BRIEF_PROMPT =
  'Write a brief about this book for use as background context: author, date, genre, style, audience, recurring archaic terms and structure, in 200 words or fewer.';

const running = new Map(); // book id -> its job
const again = new Set();

const words = (c) => c.blocks.reduce((n, b) => n + countWords(b.x), 0);
const textOf = (c) => c.blocks.map((b) => b.x).join('\n\n');
const replyOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

// Starts the job for a book unless it already runs; a running one is asked to look again when it
// ends, so chapters appended meanwhile are not missed. Without an Anthropic key it does nothing
// (it is tried again at startup and whenever the book is opened).
export function ensureSummaries(id) {
  const llm = effectiveLlm();
  if (llm.protocol !== 'anthropic' || !hasKey(llm)) return;
  if (running.has(id)) {
    again.add(id);
    return;
  }
  running.set(
    id,
    summarize(id, llm)
      .catch((err) => console.error(`[summary] ${id}:`, err.key || err.message))
      .finally(() => {
        running.delete(id);
        if (again.delete(id)) ensureSummaries(id);
      }),
  );
}

// Resolves once no summary job runs for the book, including one started again as it ended.
export async function summariesDone(id) {
  while (running.has(id)) await running.get(id);
}

async function ask(client, content, maxTokens, log) {
  const params = { model: MODEL, max_tokens: HAIKU ? maxTokens : 8000, messages: [{ role: 'user', content }] };
  if (HAIKU) params.thinking = { type: 'disabled' };
  else if (effortFor(MODEL, 'low')) params.output_config = { effort: 'low' };
  const started = Date.now();
  const msg = await client.messages.create(params);
  logUsage({ ...log, model: msg.model, cached: false, usage: msg.usage, ms: Date.now() - started });
  return msg;
}

function addUsage(book, usage) {
  book.usage = {
    input_tokens: (book.usage?.input_tokens || 0) + (usage?.input_tokens || 0),
    output_tokens: (book.usage?.output_tokens || 0) + (usage?.output_tokens || 0),
  };
}

const setStep = (id, step) =>
  updateMeta(id, (m) => {
    if (m.book?.status === 'ready') m.book = { ...m.book, step };
  });

const unsummarized = (book, skip = new Set()) => book.chapters.find((c) => !book.summaries?.[c.id] && !skip.has(c.id) && words(c) >= MIN_WORDS);
const hasSummaries = (book) => Object.keys(book.summaries || {}).length > 0;

async function summarize(id, llm) {
  const meta = await getMeta(id);
  if (meta.kind !== 'book') return;
  let book = await readBook(id);
  if (!unsummarized(book) && (book.brief || !hasSummaries(book))) return;
  const client = makeClient(llm);
  await setStep(id, 'summaries');
  try {
    book = await summarizeChapters(id, client, book, nameOf(bookLangs(meta).src));
    if (!book.brief && hasSummaries(book)) await writeBrief(id, client, meta, book);
  } finally {
    await setStep(id, 'done');
  }
}

async function summarizeChapters(id, client, book, S) {
  const tried = new Set();
  let failures = 0;
  for (let chapter; (chapter = unsummarized(book, tried)); ) {
    tried.add(chapter.id);
    const content = `${summaryPrompt(S)}\n\n<chapter title="${attr(chapter.title)}">\n${textOf(chapter).slice(0, SUMMARY_INPUT_LIMIT)}\n</chapter>`;
    let msg;
    try {
      msg = await ask(client, content, 400, { paper: id, chapter: chapter.id, action: 'summary' });
      failures = 0;
    } catch (err) {
      // One 429 or 529 skips this chapter (until the next start or open); three in a row stop.
      console.error(`[summary] ${id} ${chapter.id}:`, err.message);
      if (++failures >= 3) throw err;
      continue;
    }
    const text = replyOf(msg);
    book = await updateBook(id, (b) => {
      if (text) b.summaries = { ...b.summaries, [chapter.id]: text };
      addUsage(b, msg.usage);
    });
    await updateMeta(id, (m) => {
      m.book = { ...m.book, summaries: Object.keys(book.summaries || {}).length };
    });
  }
  return book;
}

// From the title, author, the opening of the book and the chapter summaries.
async function writeBrief(id, client, meta, book) {
  const excerpt = book.chapters.map(textOf).join('\n\n').slice(0, 4000);
  const summaries = book.chapters
    .filter((c) => book.summaries[c.id])
    .map((c) => `<chapter title="${attr(c.title)}">${book.summaries[c.id]}</chapter>`)
    .join('\n');
  const authors = (meta.authors || []).join(', ');
  const content = `${BRIEF_PROMPT}\n\n<book title="${attr(meta.title)}" author="${attr(authors)}">\n<excerpt>\n${excerpt}\n</excerpt>\n${summaries}\n</book>`;
  const msg = await ask(client, content, 600, { paper: id, chapter: null, action: 'brief' });
  const text = replyOf(msg);
  await updateBook(id, (b) => {
    if (text) b.brief = text;
    addUsage(b, msg.usage);
  });
}
