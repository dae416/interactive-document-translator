// A PDF book already imported, made into chapters again by its bookmarks: see rechapter() in
// server/book.js. Stop the server first, or a job of its own may write to the same book. The
// server makes the new summaries and brief when it starts. Poppler's pdftotext must come first on
// PATH (it does in PowerShell; in Git Bash xpdf's does).
//   node scripts/rechapter.mjs <book id>
import { rechapter } from '../server/book.js';

const [id] = process.argv.slice(2);
if (!id) {
  console.error('usage: node scripts/rechapter.mjs <book id>');
  process.exit(2);
}
const book = await rechapter(id);
for (const c of book.chapters) console.log(c.id, c.pages.join('-'), c.blocks.length, c.title);
process.exit(0);
