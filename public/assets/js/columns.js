// A journal article in two columns (app.css, book.layout 'paper'), read as printed pages. What
// goes across the page stays a child of its section; each run of text between two such things is
// put, once, as the article opens, in a .col-run, which app.css sets in two columns where there is
// room and otherwise lays out as if it were not there. (Not one box in columns with column-span
// for the rest: Safari then paints those as selected whenever text in the columns is.) A run
// taller than the screen is cut, at a block, into runs that each stand within it (an empty
// .col-break across its columns), again whenever the article or the screen changes size.
import { h } from './ui.js';

const RUN = 'col-run';
const BREAK = 'col-break';

// Across the page: a figure as wide as it and its caption (not one printed in a column), a table,
// the journal's line, the title, the authors, the abstract and a section's head.
function across(el, prev) {
  if (el.matches('.book-fig')) return !el.matches('.narrow');
  if (el.matches('.r-cap')) return !prev?.matches('.book-fig.narrow');
  return el.matches('h2, .tbl, .r-kicker, .r-title, .r-authors, .r-abstract, .r-sec');
}

// Each run of a section's children between two things across the page, into a .col-run. Its
// translation and its notes, put in later just after a block, then go into the block's run.
export function wrapRuns(section) {
  let run = null;
  let prev = null;
  for (const el of [...section.children]) {
    if (el.classList.contains(RUN) || across(el, prev)) run = null;
    else {
      if (!run) el.before((run = h('div', { class: RUN })));
      run.append(el);
    }
    prev = el;
  }
}

// The children of a run before which it is cut: a run's height in one column (fragments and
// margins, which do not depend on where its columns break) up to `max`. A cut goes before a
// block, or before the original of a block read in the translation (hidden, its translation just
// after it), never between a block and its translation or its notes, nor between a figure and its caption after it. A
// block taller than `max` stands alone.
export function cutsOf(children, max) {
  const cuts = [];
  let run = []; // [element, height] of the run so far
  for (const el of children) {
    if (el.classList.contains(BREAK)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const height = [...el.getClientRects()].reduce((n, r) => n + r.height, 0) + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    let before = el.matches('[data-b]') ? el : el.matches('.tr-block') && el.previousElementSibling?.matches('[data-b]') ? el.previousElementSibling : null;
    if (before?.previousElementSibling?.matches('.book-fig')) before = before.previousElementSibling;
    const total = run.reduce((n, [, h]) => n + h, 0);
    if (total && before && total + height > max) {
      cuts.push(before);
      // (the next run starts at the cut: with the figure, where the cut went back to it)
      const k = run.findIndex(([x]) => x === before);
      run = k >= 0 ? run.slice(k) : [];
    }
    run.push([el, height]);
  }
  return cuts;
}

// Puts a section's runs in place and keeps their cuts up to date. keep(fn): runs fn, the text
// being read staying in place.
export function columnPages(section, scroller, keep = (fn) => fn()) {
  wrapRuns(section);
  if (typeof ResizeObserver === 'undefined') return { destroy() {} };
  let frame = 0;
  const update = () => {
    frame = 0;
    const runs = [...section.querySelectorAll(`:scope > .${RUN}`)];
    // (one column on a narrow screen, or side by side: no cuts)
    const two = runs.length > 0 && getComputedStyle(runs[0]).columnCount === '2';
    // ponytail: 80% of the screen for a column, whatever the bars over it take.
    const plan = runs.map((run) => (two ? cutsOf(run.children, 2 * 0.8 * scroller.clientHeight) : []));
    const now = runs.map((run) => [...run.querySelectorAll(`:scope > .${BREAK}`)]);
    if (plan.every((cuts, i) => cuts.length === now[i].length && now[i].every((b, k) => b.nextElementSibling === cuts[k]))) return;
    keep(() =>
      runs.forEach((run, i) => {
        now[i].forEach((b) => b.remove());
        for (const el of plan[i]) el.before(h('div', { class: BREAK, 'aria-hidden': 'true' }));
      }),
    );
  };
  const ro = new ResizeObserver(() => {
    if (!frame) frame = requestAnimationFrame(update);
  });
  ro.observe(section);
  ro.observe(scroller);
  return {
    destroy() {
      ro.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}
