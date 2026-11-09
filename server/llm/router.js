// With the Anthropic model set to "auto", a quick Haiku call picks the model for each turn
// from the book and the turn's message (never the chapter text).
import { makeClient } from './anthropic.js';
import { DEFAULT_LANGS } from '../../public/assets/js/langs.js';
import { nameOf, withArticle } from '../langs.js';

export const TIERS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const FALLBACK = 'sonnet';
// Enough to see that a passage is very long; keeps the router quick and cheap.
const INPUT_LIMIT = 20_000;

// Calibrated on the two QA books: without "judge the selection itself" and "choose the cheaper",
// plain words and sentences in an old devotional book all went to sonnet, and a plain list
// paragraph went to opus. `S`: the name of the language the book is written in; its own is no
// reason for opus in a book written in Latin, Greek or Hebrew.
const CLASSICAL = ['Latin', 'Greek', 'Hebrew'];
const classical = (S) => {
  const others = CLASSICAL.filter((n) => !S.endsWith(n));
  return others.length === 3 ? 'Latin, Greek or Hebrew' : others.join(' or ');
};
const routerPrompt = (S) => `You pick the cheapest model that will answer a reader of ${withArticle(S)} book well. The message shows the book and the reader's request: the paragraph, the selection and a mode, task or question. Judge the selection itself: the paragraph only shows how it is used, and an old or religious book does not make an ordinary selection hard. Reply with exactly one word: haiku, sonnet or opus.
haiku: a word or phrase used in its ordinary dictionary sense; a sentence in plain ${S} whose meaning is clear from its words.
sonnet: archaic, dialect or rare words, or a familiar word in an old or unusual sense; proverbs, idioms, wordplay; long or complex sentences; most paragraphs.
opus: ${classical(S)}; obscure allusions (classical, patristic, Scripture cross-references) that the answer must explain; explain or ask requests about the argument or doctrine; long, dense theological or philosophical passages.
If two fit, choose the cheaper one.`;

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');

// Returns { tier, model, usage, routerModel }; when the router fails or times out, Sonnet with
// usage null. Rejects only when `signal` aborts (the client went away). `lang`: the book's language.
export async function routeTurn(llm, { bookLine = '', message, signal, lang = DEFAULT_LANGS.src }) {
  try {
    const msg = await makeClient(llm).messages.create(
      {
        model: TIERS.haiku,
        max_tokens: 5,
        thinking: { type: 'disabled' },
        system: routerPrompt(nameOf(lang)),
        messages: [{ role: 'user', content: `${bookLine}\n${textOf(message.content).slice(0, INPUT_LIMIT)}`.trim() }],
      },
      { signal, timeout: 4000, maxRetries: 0 },
    );
    const reply = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .toLowerCase();
    const tier = /haiku|sonnet|opus/.exec(reply)?.[0];
    if (!tier) console.warn(`[router] unexpected reply ${JSON.stringify(reply)}; using ${FALLBACK}`);
    return { tier: tier || FALLBACK, model: TIERS[tier || FALLBACK], usage: msg.usage, routerModel: msg.model };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`[router] ${err.message}; using ${FALLBACK}`);
    return { tier: FALLBACK, model: TIERS[FALLBACK], usage: null, routerModel: TIERS.haiku };
  }
}
