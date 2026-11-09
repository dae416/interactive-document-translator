import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import katex from '/vendor/katex/katex.mjs';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Split out code so math delimiters inside code are left alone.
const CODE_RE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g;
// No lookbehind here: older iOS Safari can't parse it and the whole module would fail.
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(^|[^\\$\w])\$(?!\s)((?:\\\$|[^$\n])+?)\$(?![\w$])/g;

// (no rule or space a few em past what a formula needs: an answer or a note can't cover the page)
function renderMath(tex, display) {
  try {
    return katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml', maxSize: 10, maxExpand: 1000 });
  } catch {
    return `<code>${tex.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</code>`;
  }
}

// Some reasoning models put their scratchpad inline as <think>…</think>.
function stripThink(src) {
  return src.replace(/^\s*<think>[\s\S]*?(<\/think>|$)/i, '').trimStart();
}

export function renderMarkdown(src) {
  const text = stripThink(src || '');
  const maths = [];
  const protectedText = text
    .split(CODE_RE)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(MATH_RE, (m, d1, d2, i1, pre, i2) => {
        if (i2 != null && /\s$/.test(i2)) return m;
        const display = d1 != null || d2 != null;
        const tex = d1 ?? d2 ?? i1 ?? i2;
        maths.push({ tex, display });
        const token = display ? `MATHBLOCK${maths.length - 1}ENDMATH` : `MATHINLINE${maths.length - 1}ENDMATH`;
        return (pre || '') + token;
      });
    })
    .join('');
  // HTML written in an answer or a note keeps no id, name, style or data-* attribute: in a book's
  // text a note's data-b or id would take a block's highlights and jumps, and a style could cover
  // the page. KaTeX's output goes in after, and keeps the styles that place a formula.
  // (nor a <style>, which would restyle the whole app; KaTeX writes none)
  const profiles = { USE_PROFILES: { html: true, mathMl: true, svg: true }, FORBID_TAGS: ['style'] };
  const html = DOMPurify.sanitize(marked.parse(protectedText), { ...profiles, ALLOW_DATA_ATTR: false, FORBID_ATTR: ['id', 'name', 'style'] });
  return DOMPurify.sanitize(placeMath(html, maths), profiles);
}

const TOKEN = /MATH(BLOCK|INLINE)(\d+)ENDMATH/g;
const escapeText = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// KaTeX's output for each formula's token, in the text only; in an attribute's value (where
// KaTeX's quotes would end it) the formula's own TeX goes back, set as text. A token without a
// formula of its number stays as written. A displayed formula alone in its paragraph takes the
// paragraph's place.
function placeMath(html, maths) {
  if (!maths.length) return html;
  const box = document.createElement('template');
  box.innerHTML = html;
  const source = (m, kind, n) => (maths[n] ? (kind === 'BLOCK' || maths[n].display ? `$$${maths[n].tex}$$` : `$${maths[n].tex}$`) : m);
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        for (const a of [...child.attributes]) if (/MATH(?:BLOCK|INLINE)\d+ENDMATH/.test(a.value)) child.setAttribute(a.name, a.value.replace(TOKEN, source));
        walk(child);
      } else if (child.nodeType === 3 && /MATH(?:BLOCK|INLINE)\d+ENDMATH/.test(child.nodeValue)) {
        const into = document.createElement('span');
        into.innerHTML = escapeText(child.nodeValue).replace(TOKEN, (m, kind, n) => (maths[n] ? renderMath(maths[n].tex, kind === 'BLOCK' || maths[n].display) : m));
        const p = child.parentNode;
        const alone = p?.nodeName === 'P' && p.childNodes.length === 1 && /^\s*MATHBLOCK\d+ENDMATH\s*$/.test(child.nodeValue);
        (alone ? p : child).replaceWith(...into.childNodes);
      }
    }
  };
  walk(box.content || box);
  return box.innerHTML;
}
