# Notes for contributors (and coding agents)

Interactive Document Translator: a self-hosted reader for books in one language with help in
another, built on PaperGloss (paper mode). `README.md` covers running it; `docs/DESIGN.md` covers
how book mode works.

- **Run** `npm ci`, then `npm start` (port 8787) or `npm test`. Tests use an Anthropic stub and
  never call a real API; keep it that way.
- **No build step.** Client modules in `public/assets/js` are plain ES modules; no regex lookbehind
  there (older Safari can't parse it; `test/client-syntax.test.js` checks).
- **Paths.** Never write an absolute path into code, data, tests or docs examples: resolve from
  `import.meta.url`, the script's own folder, or the data folder.
- **Data.** A file that can't be read is an error, not "no data"; never overwrite what you couldn't
  read. One server per data folder.
- **Prompts.** Keep system blocks byte-stable (no timestamps or per-request data). Bump
  `PROMPT_VERSION` in `server/context.js` when the book-thread instructions change (stored replies
  are keyed on it), and the version constants of translation, footnotes and clauses when theirs do.
- **Languages.** Never hard-code a language: take the book's pair (`bookLangs` on the server,
  `langs` in the browser). For English → Korean the prompts must stay byte-identical to what they
  were; a target language's own conventions go in `TARGETS` in `server/langs.js`.
- **Secrets** live in the environment or `~/.config/interactive-document-translator/env`, never in the repo or `data/`.
- **Style.** The smallest change that works; mark a deliberate limit with a `ponytail:` comment
  that says what the upgrade would be.
