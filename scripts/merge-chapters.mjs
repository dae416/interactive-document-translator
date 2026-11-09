// Chapters of a book made one: see mergeChapters() in server/book.js. Stop the server first, or a
// job of its own may write to the same book. Undone by scripts/rechapter.mjs, which starts over.
//   node scripts/merge-chapters.mjs <book id> <first chapter> <last chapter> <title>
import { mergeChapters } from '../server/book.js';

const [id, first, last, title] = process.argv.slice(2);
if (!title) {
  console.error('usage: node scripts/merge-chapters.mjs <book id> <first chapter> <last chapter> <title>');
  process.exit(2);
}
const book = await mergeChapters(id, first, last, title);
for (const c of book.chapters.slice(0, 5)) console.log(c.id, c.pages?.join('-'), c.blocks.length, c.title);
process.exit(0);
