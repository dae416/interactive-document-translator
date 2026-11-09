# Book mode: design

How book mode works, for anyone changing it. The code is the source of truth; this is the map.
PaperGloss's paper mode (arXiv, PDFs, the AI panel) is unchanged underneath and documented in its
own code.

## Principles

- **Base.** PaperGloss: Node ≥ 20, plain `node:http`, a vanilla-JS client with no build step.
  Paper-mode features keep working, and their tests pass.
- **Two languages per book.** A book is written in a *source* language and read with help in a
  *target* language, both BCP-47 codes. English → Korean is the default and the pair the prompts
  were written for; for that pair the prompts stay byte-identical to the English → Korean original.
- **Data safety.** An empty or unparsable JSON file is an error ("storage.unreadable"), never "no
  data" (cloud-synced folders leave 0-byte placeholders): nothing is written over a file that could
  not be read. Writes are atomic (`writeJsonFile`, with retries on Windows where a scanner may hold
  the target open). One server per data folder (`server.lock` heartbeat).
- **Byte-stable prompts.** System blocks hold no timestamps or per-request data, so prompt caching
  keeps hitting. Changing the book-thread instructions means bumping `PROMPT_VERSION`
  (`server/context.js`), since stored replies are keyed on it; the translation prompts have
  `TRANSLATION_PROMPT_VERSION`, footnote placement `VERSION`, clause pairing `CLAUSES_VERSION`.
- **No absolute paths** in code, data or tests: paths come from `import.meta.url` or the data folder.
- **Tests never call a model**: they run real server processes against throwaway data folders and
  an Anthropic stub (`test/helpers.js`).

## Languages

- `public/assets/js/langs.js` (shared by browser and server): codes, names (`Intl.DisplayNames`),
  labels (`EN`, `KO`), scripts (`Intl.Locale(...).maximize().script`), `NO_SPACE` (scripts written
  without spaces), `countWords`, `scriptCounts`. The browser keeps the open book's pair in `langs`;
  the server always passes a pair explicitly.
- A book's pair (`bookLangs(meta)` in `server/config.js`): `meta.langs`, else Settings
  (`prefs.langs`), else `BOOK_SOURCE_LANG` / `BOOK_TARGET_LANG`, else `en` → `ko`. `meta.langs` is
  written by the book's own menu (PATCH `/api/papers/:id` with `langs`) or fixed when a chapter is
  first translated, so later changes in Settings leave existing translations consistent; once a
  chapter is translated (or on its way) the target is refused a change, the source is not.
- The answer language (`prefs.targetLang`, a name such as "한국어") is the target's own name unless
  set; `answerLang()` resolves it.
- `server/langs.js` holds what prompts say of a pair: names, articles ("an English", "a Korean"),
  XML tags (`<english>`, `<korean>`), and `TARGETS`, a target language's own conventions beyond its
  name. Korean's entry carries the loanword-spelling rule (외래어 표기법), Protestant Bible names
  with the "Hos. viii. 12" → 호세아 8:12 example, word spacing (띄어쓰기) and its word for a note
  (`[[설명]]`); other targets get plain wording. Add a language's conventions there.
- Splitting text is language-aware where it has to be: `Intl.Segmenter` sentences, clause cuts at
  `,;:` and their CJK forms `，、；：`, CJK full stops `。！？` for pieces of long paragraphs, a CJK
  character counted as a word. English-specific rules (abbreviations, Scripture references, "For…"
  reasons) and Korean-specific ones (a quotation followed by 하고, a reason sentence ending in
  때문이다) are keyed by language and only apply to it.
- Equivalence for English → Korean is checked by running the original and the generalized server
  against the same recording stub and comparing every request body.

## Data

`meta.json` (books add):

```jsonc
{
  "kind": "book",
  "source": "upload" | "txt" | "web",
  "langs": { "src": "en", "tgt": "ko" },        // optional: the book's own pair
  "book": {
    "status": "processing" | "ready" | "error",
    "step": "extract" | "ocr" | "chapters" | "summaries" | "done",
    "progress": 0.0, "error": "", "chapters": 24, "ocr": true, "summaries": 24,
    "translations": { "c3": { "status": "ready", "progress": 1 }, "c7": { "ranges": [[0, 40], [40, 81]], "parts": [ … ] } }
  },
  "html": { "status": "ok", "baseUrl": "<page url, or https://book.invalid/>" }
}
```

`book.json` is the source of truth for a book's text:

```jsonc
{
  "version": 1,
  "chapters": [ { "id": "c1", "title": "To the Idle", "blocks": [ { "t": "h", "x": "TO THE IDLE." }, { "t": "p", "x": "…" } ], "pages": [16, 30], "url": null } ],
  "brief": "", "summaries": { "c1": "…" }, "usage": { … }, "next": null
}
```

- Chapter ids `c1…cN` are append-only; a block id is `<chapter>.<index>` (`c3.12`), and the block
  of its translation is the same with a `k` (`c3.12k`). Block text is whitespace-collapsed, so a
  block's DOM `textContent` equals the stored text and annotation offsets hold.
- `paper.html` is generated from book.json with the LaTeXML classes `htmlview.js` already reads.
- `annotations.json`: `{ id, type: highlight | underline | bookmark | note, color, chapter, start:
  { b, o }, end: { b, o }, quote, createdAt, updatedAt, deleted }`, merged by id, newest
  `updatedAt` wins, tombstones kept.
- `lookups.jsonl`: stored first answers, keyed on model, effort, answer language, `PROMPT_VERSION`,
  action, chapter, the user turn and (for pairs other than the default) the book's pair.
- `translations/<c>.json` (or `<c>.p<k>.json` per part): the translated blocks with inline footnote
  markers `[^n]`, the notes, the source hash and the prompt version; `<c>.notes-src.json` and
  `<c>.clauses.json` cache footnote placement and clause pairing per block, keyed by hashes.

## Requests to the model

- **Book threads** (`server/context.js`): three system blocks — the instructions for the pair and
  answer language; the book (brief and a summary per chapter); the current chapter (whole, up to
  600k characters, or the section asked about in a long textbook chapter) — the last two cached for
  an hour. The browser sends only `<paragraph>`, `<selection>` (with `lang="<target>"` when it is in
  the translation), an optional `<sentence>`, and `Mode: word | sentence | paragraph`, `Task:
  explain` or `Question: …`. Assistant turns replay as text only.
- **Router** (`server/llm/router.js`, model `auto`): Haiku, thinking off, 5 tokens, sees the book's
  title and the turn (never the chapter), answers `haiku | sonnet | opus`; Sonnet if it fails.
- **Summaries and brief** (`server/summary.js`): Haiku, once per chapter of 150 words or more,
  written in the book's language; the brief from the title, an excerpt and the summaries.
- **Translation** (`server/translate.js`): Opus at max effort with the book and chapter blocks
  cached; blocks go 4,000 characters at a time (a paragraph over 3,000 characters in pieces cut
  between sentences), each segment translated then reviewed. A chapter estimated over $5 is cut into
  parts of at most $5 at headings or new points (`splitChapter`); each part sees the end of the part
  before it and the notes given so far. Failed calls are retried with backoff; a stop aborts the call
  in flight; finished segments are saved and resumed.
- **OCR clean-up**: Haiku fixes OCR errors block by block before a scanned chapter is translated or
  at startup; a chapter with highlights keeps its text.
- **Footnote placement** (`server/footnotes.js`): Haiku names the words of the original each note
  belongs to; checked against the text, else the end of the aligned sentence, else the paragraph.
- **Clause pairing** (`server/clauses.js`): Haiku gives, for each clause of the original (cut by
  `sentences.js`), the smallest part of the translation that carries it, sentence pair by sentence
  pair; every piece is found in the text before it is kept; no two clauses keep the same words.
- **Find a book** (`server/find.js`): Opus with web search and fetch, public-domain or openly
  licensed copies only, links limited to sites it actually visited.

## Import

- **PDF**: `pdftotext`; fewer than 30 words a page means a scan → `pdftoppm` + `tesseract` (in the
  book's language if tesseract has its data) with half the CPUs, scratch images in the OS temp
  folder. Running heads, page numbers and digitizer notices are dropped, hyphenated line ends
  joined. Chapters from upper-case headings at the top of pages (or 10-page chunks; or the PDF's
  bookmarks via `scripts/rechapter.mjs`). Pictures on scanned pages are cut out from tesseract's
  layout and placed next to their paragraph.
- **Text**: chapters at heading lines ("Chapter I", "Chapitre 3", "第一章", "제1장", a Roman
  numeral), else about 3,000 words each.
- **Web**: CCEL pages by their structure, others by Readability; "next" links (same origin only)
  followed in the background.
- All external tools run through `execFile` with argument arrays and timeouts; fetching is
  SSRF-safe (`server/net.js`).

## Client

- `translation.js`: the bar under each chapter title (translate, progress, stop, resume, parts),
  the view switch (`src` / `both` / `tgt`, labelled from the codes), the translation after each
  block (`lang` = target), footnote popups.
- `taps.js`: a tap on a clause or sentence marks its counterpart (side by side) or shows it in the
  balloon, from the server's pairing or, until it comes, `pairClauses` (length-based alignment after
  Gale & Church); otherwise the model translates it. The page's text is never rewritten: marks are
  CSS Custom Highlights.
- `anchors.js` / `annotations.js`: Range ↔ `{ chapter, start, end }`, kept in localStorage and on
  the server; a mark on the translation relocates by its quote when the chapter is translated again.
- `settings.js`: Settings → Books (the two codes) and the answer language; the book's ⋯ menu →
  Languages for its own pair.

## Tests

`npm test` (node:test). Server tests start real processes on throwaway folders with the Anthropic
stub; client tests run the browser modules under linkedom. `test/langs.test.js` covers other pairs
(a Japanese book read in English, an English one in Japanese or Spanish) end to end.
