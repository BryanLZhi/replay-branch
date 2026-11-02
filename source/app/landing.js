// The landing page: open a replay by link, search Showdown's replays, and the replays opened before (with their lines).
import {S, E, $id, esc, stored, store, unstore} from './state.js';
import {replayIdFrom, visit, SAMPLE, startFresh, showPage} from './load.js';

export function renderLanding() {
  renderRecent();
  $id('openUrl').focus();
}

export function wireLanding() {
  $id('openForm').onsubmit = e => {
    e.preventDefault();
    const id = replayIdFrom($id('openUrl').value);
    $id('openErr').textContent = id ? '' : 'Not a replay link.';
    if (id) visit(id);
  };
  $id('btnPasteLog').onclick = () => $id('btnLoad').click();
  wireFormatMenu();
  $id('freshForm').onsubmit = async e => {
    e.preventDefault();
    $id('freshErr').textContent = '';
    try { await startFresh($id('freshFormat').value, [$id('freshTeam1').value, $id('freshTeam2').value]); }
    catch (err) { showPage('landing'); $id('freshErr').textContent = err.message || String(err); }
  };
  $id('searchForm').onsubmit = e => { e.preventDefault(); search(); };
  $id('btnMore').onclick = () => search(lastResult);
  fetch('stats/index.json').then(r => r.json()).then(formats => {
    const d = document.createElement('datalist'); d.id = 'dl-formats';
    d.innerHTML = Object.keys(formats).map(f => `<option value="${f}">`).join('');
    document.body.appendChild(d);
  }).catch(() => {});
}

// ---------------------------------------------------------------- the format of a new battle
// Showdown's format menu: sections (S/V Singles, National Dex, Past Gens OU...) that fold away and stay as you left them,
// and a search that shows every match.
function wireFormatMenu() {
  const button = $id('btnFormat'), menu = $id('formatMenu'), value = $id('freshFormat');
  let sections = null;
  const open = () => { try { return new Set(JSON.parse(stored('rb-format-open', '[]'))); } catch { return new Set(); } };
  const render = (query = '') => {
    const q = query.trim().toLowerCase(), shown = open();
    const current = sections.find(s => s.formats.some(f => f.id === value.value))?.section;
    menu.innerHTML = `<input class="textbox" id="formatSearch" placeholder="Search" aria-label="Search formats" value="${esc(query)}">` + sections.map(s => {
      const formats = q ? s.formats.filter(f => f.full.toLowerCase().includes(q) || f.id.includes(q.replace(/[^a-z0-9]/g, ''))) : s.formats;
      if (!formats.length) return '';
      const expanded = !!q || shown.has(s.section) || (!shown.size && s.section === current);
      return `<div class="rb-fsec"><button type="button" class="rb-fhead" data-sec="${esc(s.section)}" aria-expanded="${expanded}">` +
        `<i class="fa fa-caret-${expanded ? 'down' : 'right'}" aria-hidden="true"></i>${esc(s.section)}<small>${formats.length}</small></button>` +
        `<div class="rb-fitems" ${expanded ? '' : 'hidden'}>${formats.map(f => `<button type="button" class="rb-fitem ${f.id === value.value ? 'cur' : ''}" data-format="${esc(f.id)}" title="${esc(f.full)}">${esc(f.name)}</button>`).join('')}</div></div>`;
    }).join('');
    const search = $id('formatSearch');
    search.oninput = () => { render(search.value); const again = $id('formatSearch'); again.focus(); again.setSelectionRange(again.value.length, again.value.length); };
    for (const h of menu.querySelectorAll('[data-sec]')) h.onclick = () => {
      const now = open();
      if (!now.size && h.dataset.sec === current) now.add(current);
      if (now.has(h.dataset.sec)) now.delete(h.dataset.sec); else now.add(h.dataset.sec);
      store('rb-format-open', JSON.stringify([...now])); render(search.value);
    };
    for (const b of menu.querySelectorAll('[data-format]')) b.onclick = () => {
      value.value = b.dataset.format; $id('formatName').textContent = b.title; close();
    };
  };
  // (the open menu goes over the sections below it)
  const raise = up => button.closest('.rb-sheet')?.classList.toggle('rb-raised', up);
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); raise(false); };
  button.onclick = async e => {
    e.stopPropagation();
    if (!menu.hidden) { close(); return; }
    await S.ready;
    sections ||= E.freshFormats();
    render(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); raise(true);
    menu.querySelector('.rb-fitem.cur')?.scrollIntoView({block: 'nearest'});
  };
  menu.onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { if (!menu.hidden) close(); });
  menu.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); button.focus(); } });
}

// ---------------------------------------------------------------- recent
const ago = ms => {
  const min = (Date.now() - ms) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.floor(min)} min ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h ago`;
  return date(ms);
};
const date = ms => new Date(ms).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});

function savedStudies() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith('rbv:')) continue;
      try {
        const study = JSON.parse(localStorage.getItem(k));
        out.push({key: k.slice(4), meta: study.meta || {}, name: typeof study.name === 'string' ? study.name : '', lines: Object.keys(study.nodes || {}).length, opened: study.opened || 0});
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => b.opened - a.opened);
}

// A replay as Showdown lists them: details above, the players below.
const players = list => (list || []).map(p => `<strong>${esc(p)}</strong>`).join(' vs. ');
const entry = (key, details, who, end = '') =>
  `<a class="blocklink" href="?r=${encodeURIComponent(key)}" data-visit="${esc(key)}"><span><small>${details}</small><br>${who}</span>${end}</a>`;
// (a click opens it here; a middle click or Ctrl+click still opens a new tab)
const opensHere = e => !(e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1);

let removeArmed = null;
function renderRecent() {
  const list = $id('recent');
  const studies = savedStudies();
  list.innerHTML = studies.length ? studies.map(s => {
    const lines = s.lines ? ` · ${s.lines} line${s.lines > 1 ? 's' : ''}` : '';
    // (a named study goes by its name, the players beside the format)
    const details = `${esc(s.meta.format || s.key)}${s.name ? ' · ' + (s.meta.players || []).map(esc).join(' vs. ') : ''}`;
    return entry(s.key, `${details}${s.meta.shared ? ' · shared with you' : ''}${lines}${s.opened ? ' · ' + ago(s.opened) : ''}`, s.name ? `<strong>${esc(s.name)}</strong>` : players(s.meta.players),
      `<button class="rb-linkbtn" data-remove="${esc(s.key)}">${removeArmed === s.key ? 'Remove for good?' : 'Remove'}</button>`);
  }).join('') : `<p class="rb-dim">Nothing yet. <a href="?r=${SAMPLE}" data-visit="${SAMPLE}">Open a sample replay</a></p>`;
  for (const link of list.querySelectorAll('[data-visit]')) link.onclick = e => {
    if (e.target.closest('[data-remove]') || !opensHere(e)) return;
    e.preventDefault(); visit(link.dataset.visit);
  };
  for (const b of list.querySelectorAll('[data-remove]')) b.onclick = e => {
    e.preventDefault();
    if (removeArmed === b.dataset.remove) { unstore('rbv:' + b.dataset.remove); removeArmed = null; } else removeArmed = b.dataset.remove;
    renderRecent();
  };
}

// ---------------------------------------------------------------- search (replay.pokemonshowdown.com)
let lastResult = null;   // the last replay listed, to continue from
async function search(after) {
  const user = $id('searchUser').value.trim(), format = $id('searchFormat').value.trim();
  const list = $id('searchResults'), err = $id('searchErr');
  err.textContent = '';
  if (!user && !format) { err.textContent = 'Enter a username or a format.'; return; }
  const q = new URLSearchParams();
  if (user) q.set('user', user);
  if (format) q.set('format', format);
  if (after) q.set('before', after.uploadtime);
  let found;
  try {
    const r = await fetch('https://replay.pokemonshowdown.com/search.json?' + q);
    if (!r.ok) throw new Error();
    found = await r.json();
  } catch { err.textContent = 'Could not search replays.'; return; }
  const more = found.length > 50;   // (Showdown sends one more than a page when there are more)
  found = found.slice(0, 50);
  lastResult = found[found.length - 1];
  const entries = found.map(x => entry(x.id, esc(x.format) + (x.rating ? ` · Rating: ${x.rating}` : ''), players(x.players),
    `<small>${date(x.uploadtime * 1000)}</small>`)).join('');
  if (!after) list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', entries || `<p class="rb-dim">No replays found.</p>`);
  list.hidden = false;
  $id('searchMore').hidden = !more;
  for (const link of list.querySelectorAll('[data-visit]')) link.onclick = e => {
    if (!opensHere(e)) return;
    e.preventDefault(); visit(link.dataset.visit);
  };
}
