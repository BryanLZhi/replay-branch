// The landing page: open a replay by link, search Showdown's replays, and the replays opened before (with their lines).
import {$id, esc, stored, unstore} from './state.js';
import {replayIdFrom, visit, SAMPLE} from './load.js';

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
  $id('searchForm').onsubmit = e => { e.preventDefault(); search(); };
  $id('btnMore').onclick = () => search(lastResult);
  fetch('stats/index.json').then(r => r.json()).then(formats => {
    const d = document.createElement('datalist'); d.id = 'dl-formats';
    d.innerHTML = Object.keys(formats).map(f => `<option value="${f}">`).join('');
    document.body.appendChild(d);
  }).catch(() => {});
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
        out.push({key: k.slice(4), meta: study.meta || {}, lines: Object.keys(study.nodes || {}).length, opened: study.opened || 0});
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
    return entry(s.key, `${esc(s.meta.format || s.key)}${lines}${s.opened ? ' · ' + ago(s.opened) : ''}`, players(s.meta.players),
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
