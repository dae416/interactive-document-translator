import { api, uploadPaper } from './api.js';
import { forgetAnnotations, localAnnotations, mergeAnnotations, removeAnnotation } from './annotations.js';
import { icon } from './icons.js';
import { openSettings } from './settings.js';
import { appLogo, confirmDialog, h, iconButton, local, openMenu, timeAgo, toast } from './ui.js';
import { t } from './i18n.js';

const SOURCE_LABEL = { arxiv: 'arXiv', openreview: 'OpenReview', acl: 'ACL', doi: 'DOI' };

function sourceLabel(source) {
  if (source === 'upload') return t('source.upload');
  return SOURCE_LABEL[source] || t('source.url');
}

// First author's family name: "Jiang, Albert Q." and "Albert Q. Jiang" both give "Jiang".
function authorsLine(authors = []) {
  if (!authors.length) return '';
  const a = authors[0].trim();
  const family = a.includes(',') ? a.split(',')[0].trim() : a.split(/\s+/).pop();
  return authors.length > 1 ? t('home.etAl', { name: family }) : a;
}

// A journal article's journal and year, as a citation gives them: "Journal of Examples 2022".
function venueLine(p) {
  if (!p.venue) return '';
  const year = /\b\d{4}\b/.exec(p.published || '')?.[0];
  return year && !p.venue.includes(year) ? `${p.venue} ${year}` : p.venue;
}

// A book's spine on the shelf: its cloth and how far it sticks out of the pile stay with it, and a
// long book is a thick one.
const CLOTHS = ['#2f4858', '#5b2c3a', '#2e5a4b', '#6b4e2e', '#3d3a6b', '#6a3b2a', '#37474f', '#4a5a2f'];
const INSETS = [0, 10, 4, 16, 7];
function dress(spine, p) {
  const n = [...p.id].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 7);
  spine.style.setProperty('--cloth', CLOTHS[n % CLOTHS.length]);
  spine.style.setProperty('--wide', `calc(100% - ${INSETS[(n >>> 4) % INSETS.length]}px)`);
  spine.style.setProperty('--thick', `${Math.min(86, 52 + (p.book?.chapters || 0) * 0.5)}px`);
}

// A link or an id goes to the import; anything else is a book for the AI to find.
const isLink = (s) => /^(https?:\/\/|doi\s*:|arxiv\s*:|\d{4}\.\d{4,5})/i.test(s) || (s.includes('/') && !/\s/.test(s));

// A picture small enough to send, and as much as the model looks at.
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  const canvas = h('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { mediaType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] };
}

export async function renderHome(root) {
  document.title = t('app.name');
  const input = h('input', {
    class: 'input',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    placeholder: t('home.inputPlaceholder'),
    'aria-label': t('home.inputPlaceholder'),
  });
  const openBtn = h('button', { class: 'btn btn-primary', type: 'submit', text: t('home.open') });
  const errorEl = h('div', { class: 'import-error', hidden: true });
  // A picture of the book, to go with the words to the AI: a tap again takes it off.
  let image = null;
  const imageInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const attach = iconButton('image', { title: t('home.attachImage'), className: 'attach' });
  const setImage = (value) => {
    image = value;
    attach.classList.toggle('on', !!value);
    imageInput.value = '';
  };
  attach.addEventListener('click', () => (image ? setImage(null) : imageInput.click()));
  imageInput.addEventListener('change', () => {
    const file = imageInput.files?.[0];
    if (file) shrinkImage(file).then(setImage, () => toast(t('home.imageFailed'), { type: 'error' }));
  });
  const form = h('form', { class: 'import-form' }, h('div', { class: 'input-wrap', html: icon('link') }, input, attach, imageInput), openBtn);
  const hintEl = h('div', { class: 'import-hint', hidden: true, text: t('home.finding') });
  const foundEl = h('div', { class: 'paper-list found-list', hidden: true });
  // A web page that isn't a paper becomes a book; this many "next" pages come with it.
  const followInput = h('input', {
    class: 'input',
    type: 'number',
    min: '0',
    max: '50',
    value: String(local.get('importFollow', 0)),
    inputmode: 'numeric',
  });
  const followRow = h('label', { class: 'follow-row', hidden: true }, h('span', { text: t('home.follow') }), followInput);
  input.addEventListener('input', () => {
    followRow.hidden = !isLink(input.value.trim());
  });

  const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf,text/plain,.txt', hidden: true });
  const progress = h('div', { class: 'progress' });
  const uploadLabel = h('span', { html: `${icon('upload')}<span>${t('home.upload')}</span>` });
  const uploadBtn = h('button', { class: 'upload-btn', type: 'button' }, progress, uploadLabel);
  uploadBtn.addEventListener('click', () => fileInput.click());

  const listEl = h('div', { class: 'paper-list stack' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  const countEl = h('span', { class: 'count' });
  // Books put away, read or not wanted, out of the list until asked for.
  const shelfCount = h('span', { class: 'count' });
  const shelfList = h('div', { class: 'paper-list stack away' });
  const shelfEl = h('details', { class: 'shelf put-away', hidden: true }, h('summary', { class: 'section-title' }, h('span', { text: t('home.shelved') }), shelfCount), shelfList);
  // Bookmarks stick out of the spines where they are in the book (ribbon); here, in words.
  const marksCount = h('span', { class: 'count' });
  const marksEl = h('div', { class: 'paper-list home-marks' });
  const marksBox = h('details', { class: 'shelf marks', hidden: true }, h('summary', { class: 'section-title' }, h('span', { text: t('home.bookmarks') }), marksCount), marksEl);
  const el = h(
    'main',
    { class: 'home' },
    h(
      'header',
      { class: 'home-header' },
      h('div', { class: 'brand' }, appLogo(), h('span', { text: t('app.name') })),
      iconButton('sliders', { title: t('common.settings'), onClick: () => openSettings() }),
    ),
    h('section', { class: 'add-book' }, form, followRow, hintEl, errorEl, foundEl, uploadBtn, fileInput),
    marksBox,
    h('div', { class: 'section-title' }, h('span', { text: t('home.recent') }), countEl),
    listEl,
    shelfEl,
  );
  root.append(el);

  const setBusy = (busy, text = t('home.open')) => {
    openBtn.disabled = busy;
    input.disabled = busy;
    followInput.disabled = busy;
    uploadBtn.disabled = busy;
    attach.disabled = busy;
    openBtn.replaceChildren(...(busy ? [h('span', { class: 'spinner' }), h('span', { text })] : [h('span', { text })]));
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value && !image) {
      input.focus();
      return;
    }
    errorEl.hidden = true;
    if (image || !isLink(value)) {
      findBook(value);
      return;
    }
    const follow = Math.max(0, Math.min(50, Math.round(Number(followInput.value)) || 0));
    local.set('importFollow', follow);
    setBusy(true, t('home.downloading'));
    try {
      const { paper } = await api.importPaper(value, follow);
      location.hash = `#/read/${encodeURIComponent(paper.id)}`;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      setBusy(false);
    }
  });

  // A find with no PDF to fetch only has its link: the page may be anything.
  const bookCard = (b) => {
    const add = b.pdf ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: t('home.addBook') }) : null;
    add?.addEventListener('click', async () => {
      add.disabled = true;
      add.textContent = t('home.downloading');
      try {
        const { paper } = await api.importBook({ url: b.pdf, title: b.title, authors: b.author ? [b.author] : [] });
        location.hash = `#/read/${encodeURIComponent(paper.id)}`;
      } catch (err) {
        toast(err.message, { type: 'error' });
        add.disabled = false;
        add.textContent = t('home.addBook');
      }
    });
    const meta = [b.author, b.year, b.host].filter(Boolean).map((text) => h('span', { text }));
    return h(
      'article',
      { class: 'paper-card found-card' },
      h(
        'div',
        {},
        h('div', { class: 't', text: b.title }),
        h('div', { class: 'm' }, meta),
        b.note ? h('p', { class: 'found-note', text: b.note }) : null,
        h('div', { class: 'found-actions' }, add, h('a', { class: 'btn btn-secondary btn-sm', href: b.url || b.pdf, target: '_blank', rel: 'noopener noreferrer', text: t('common.openSource') })),
      ),
    );
  };

  const findBook = async (query) => {
    setBusy(true);
    hintEl.hidden = false;
    foundEl.hidden = true;
    try {
      const found = await api.findBooks(query, image);
      if (!found) throw new Error(t('net.offline')); // cut off after the status went out
      if (found.error) throw new Error(found.error);
      const { books } = found;
      foundEl.replaceChildren(...(books.length ? books.map(bookCard) : [h('div', { class: 'empty', text: t('home.notFound') })]));
      foundEl.hidden = false;
      setImage(null);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
    hintEl.hidden = true;
    setBusy(false);
  };

  const handleFile = async (file) => {
    if (!file) return;
    if (!/\.(pdf|txt)$/i.test(file.name) && file.type !== 'application/pdf' && file.type !== 'text/plain') {
      toast(t('home.choosePdf'), { type: 'error' });
      return;
    }
    errorEl.hidden = true;
    setBusy(true);
    uploadLabel.innerHTML = `${icon('upload')}<span>${t('home.uploading', { n: 0 })}</span>`;
    try {
      const { paper } = await uploadPaper(file, (f) => {
        progress.style.width = `${Math.round(f * 100)}%`;
        uploadLabel.innerHTML = `${icon('upload')}<span>${t('home.uploading', { n: Math.round(f * 100) })}</span>`;
      });
      location.hash = `#/read/${encodeURIComponent(paper.id)}`;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      setBusy(false);
      progress.style.width = '0';
      uploadLabel.innerHTML = `${icon('upload')}<span>${t('home.upload')}</span>`;
    }
  };
  fileInput.addEventListener('change', () => handleFile(fileInput.files?.[0]));

  // Desktop: drop a PDF anywhere on the page.
  const onDragOver = (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      el.classList.add('dragging');
    }
  };
  const onDragLeave = (e) => {
    if (e.target === document.documentElement || !e.relatedTarget) el.classList.remove('dragging');
  };
  const onDrop = (e) => {
    e.preventDefault();
    el.classList.remove('dragging');
    handleFile(e.dataTransfer?.files?.[0]);
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  const shelve = async (p, shelf, papers) => {
    try {
      await api.patchPaper(p.id, { shelf });
      if (shelf) p.shelf = shelf;
      else delete p.shelf;
      renderList(papers);
      showMarks();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  };

  let current = [];
  let away = new Set(); // books put away: their bookmarks don't show either
  const renderList = (papers) => {
    current = papers;
    const shelved = papers.filter((p) => p.shelf);
    const out = papers.filter((p) => !p.shelf);
    away = new Set(shelved.map((p) => p.id));
    countEl.textContent = out.length ? t('home.count', { n: out.length }) : '';
    listEl.replaceChildren(...(out.length ? out.map((p) => paperCard(p, papers)) : [h('div', { class: 'empty', text: t('home.empty') })]));
    shelfEl.hidden = !shelved.length;
    shelfCount.textContent = String(shelved.length);
    shelfList.replaceChildren(...shelved.map((p) => paperCard(p, papers)));
  };

  const paperCard = (p, papers) => {
    const isBook = p.kind === 'book';
    const meta = h('div', { class: 'm' });
    if (!isBook) meta.append(h('span', { text: sourceLabel(p.source) }));
    if (p.source === 'arxiv') meta.append(h('span', { text: p.sourceId }));
    if (isBook && p.book?.status === 'processing') {
      const step = t(`book.step.${p.book.step || 'extract'}`);
      meta.append(h('span', { class: 'book-status', text: `${step} ${Math.round((p.book.progress || 0) * 100)}%` }));
    } else if (isBook && p.book?.status === 'error') {
      meta.append(h('span', { class: 'book-status error', text: t('home.bookError') }));
    }
    const authors = authorsLine(p.authors);
    if (authors) meta.append(h('span', { class: 'authors', text: authors }));
    if (p.shelf) meta.append(h('span', { class: 'shelf-tag', text: t(`home.shelf.${p.shelf}`) }));
    meta.append(h('span', { text: timeAgo(p.lastOpenedAt || p.createdAt) }));
    const more = iconButton('more', { title: t('home.moreActions'), className: 'more' });
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(more, [
        p.absUrl ? { icon: 'external', label: t('common.openSource'), onClick: () => window.open(p.absUrl, '_blank', 'noopener') } : null,
        // Books from text or the web have no PDF.
        !isBook || p.source === 'upload' ? { icon: 'download', label: t('common.downloadPdf'), onClick: () => window.open(api.pdfDownloadUrl(p.id), '_blank') } : null,
        ...(p.shelf
          ? [{ icon: 'undo', label: t('home.unshelve'), onClick: () => shelve(p, null, papers) }]
          : [
              { icon: 'check', label: t('home.shelfRead'), onClick: () => shelve(p, 'read', papers) },
              { icon: 'archive', label: t('home.shelfUnneeded'), onClick: () => shelve(p, 'unneeded', papers) },
            ]),
        'sep',
        {
          icon: 'trash',
          label: t('common.delete'),
          danger: true,
          onClick: async () => {
            const ok = await confirmDialog({ title: t('home.deleteTitle'), message: t('home.deleteMsg'), okText: t('common.delete'), danger: true });
            if (!ok) return;
            try {
              await api.deletePaper(p.id);
              forgetAnnotations(p.id);
              papers.splice(papers.indexOf(p), 1);
              renderList(papers);
              marks = marks.filter((m) => m.p.id !== p.id);
              showMarks();
            } catch (err) {
              toast(err.message, { type: 'error' });
            }
          },
        },
      ]);
    });
    const venue = venueLine(p);
    const card = h('article', { class: isBook ? 'spine' : 'spine leaflet', role: 'link', tabindex: '0' }, h('div', { class: 'spine-text' }, h('div', { class: 't', text: p.title }), venue ? h('div', { class: 'v', text: venue }) : null, meta), more);
    dress(card, p);
    if (!p.shelf) card.append(...marks.filter((m) => m.p.id === p.id && m.at != null).map(ribbon));
    const open = () => (location.hash = `#/read/${encodeURIComponent(p.id)}`);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => e.key === 'Enter' && e.target === card && open());
    return card;
  };

  // The bookmarks of every book (the server's, and this browser's not sent yet), newest first, each
  // with where it stands in its book (at).
  // ponytail: a request or two per book; a route with every book's bookmarks if a library grows large.
  let marks = [];
  const loadBookmarks = async (papers) => {
    const books = papers.filter((p) => p.kind === 'book' && p.book?.status === 'ready');
    const lists = await Promise.all(
      books.map(async (p) => {
        const theirs = await api.getAnnotations(p.id).then((r) => r?.items || [], () => []);
        const mine = mergeAnnotations(localAnnotations(p.id), theirs).filter((a) => a.type === 'bookmark' && !a.deleted);
        if (!mine.length) return [];
        const { places } = await api.getPlaces(p.id, mine.map((a) => a.start.b)).catch(() => ({ places: {} }));
        return mine.map((a) => ({ a, p, at: places[a.start.b] }));
      }),
    );
    if (gone) return;
    marks = lists.flat().sort((x, y) => Date.parse(y.a.createdAt) - Date.parse(x.a.createdAt));
    showMarks();
    renderList(current);
  };
  const openMark = ({ a, p }) => (location.hash = `#/read/${encodeURIComponent(p.id)}?at=${encodeURIComponent(a.start.b)}`);
  // A bookmark sticking out of the end of its book. The book lies on its back, so the top of the
  // spine is the front of the book and the bottom its end.
  // ponytail: ribbons within 12px or so share their tap area, and the older one gets the tap; the
  // list of bookmarks reaches each of them.
  const ribbon = (m) => {
    const el = h('button', { class: 'ribbon', type: 'button', title: m.a.quote, 'aria-label': m.a.quote });
    el.style.setProperty('--at', String(m.at));
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openMark(m);
    });
    return el;
  };
  const showMarks = () => {
    const shown = marks.filter((m) => !away.has(m.p.id));
    marksBox.hidden = !shown.length;
    marksCount.textContent = String(shown.length);
    marksEl.replaceChildren(
      ...shown.map(({ a, p }) => {
        const del = iconButton('trash', { title: t('home.removeBookmark'), className: 'more' });
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await removeAnnotation(p.id, a.id);
            marks = marks.filter((m) => m.a !== a);
            showMarks();
            renderList(current);
          } catch (err) {
            toast(err.message, { type: 'error' });
          }
        });
        const card = h('article', { class: 'paper-card mark-card', role: 'link', tabindex: '0' }, h('div', {}, h('div', { class: 't', text: a.quote }), h('div', { class: 'm' }, h('span', { class: 'mark-book', text: p.title }), h('span', { text: timeAgo(a.createdAt) }))), del);
        const open = () => openMark({ a, p });
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => e.key === 'Enter' && e.target === card && open());
        return card;
      }),
    );
  };

  // Books being prepared show their progress; the list refreshes until they are done.
  let pollTimer = 0;
  let gone = false;
  let marksAsked = false;
  const load = () =>
    api
      .listPapers()
      .then(({ papers }) => {
        if (gone) return;
        renderList(papers);
        if (!marksAsked) {
          marksAsked = true;
          loadBookmarks(papers);
        }
        if (papers.some((p) => p.book?.status === 'processing')) pollTimer = setTimeout(load, 2000);
      })
      .catch((err) => listEl.replaceChildren(h('div', { class: 'empty', text: t('common.loadFailed', { msg: err.message }) })));
  load();

  return {
    destroy() {
      gone = true;
      clearTimeout(pollTimer);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    },
  };
}
