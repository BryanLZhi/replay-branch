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

let removeArmed = null;
function renderRecent() {
  const list = $id('recent');
  const studies = savedStudies();
  if (!studies.length) {
    list.innerHTML = `<tr><td class="rb-dim">Nothing yet. <a href="?r=${SAMPLE}" data-visit="${SAMPLE}">Open a sample replay</a></td></tr>`;
  } else {
    list.innerHTML = `<tr><th>Format</th><th>Players</th><th>Lines</th><th>Opened</th><th></th></tr>` + studies.map(s =>
      `<tr data-visit="${esc(s.key)}"><td>${esc(s.meta.format || s.key)}</td><td>${esc((s.meta.players || []).join(' vs. '))}</td>` +
      `<td>${s.lines || ''}</td><td>${s.opened ? ago(s.opened) : ''}</td>` +
      `<td class="rb-end"><button class="rb-linkbtn" data-remove="${esc(s.key)}">${removeArmed === s.key ? 'Remove for good?' : 'Remove'}</button></td></tr>`).join('');
  }
  for (const row of list.querySelectorAll('[data-visit]')) row.onclick = e => {
    if (e.target.closest('[data-remove]')) return;
    e.preventDefault(); visit(row.dataset.visit);
  };
  for (const b of list.querySelectorAll('[data-remove]')) b.onclick = () => {
    if (removeArmed === b.dataset.remove) { unstore('rbv:' + b.dataset.remove); removeArmed = null; } else removeArmed = b.dataset.remove;
    renderRecent();
  };
}

// ---------------------------------------------------------------- search (replay.pokemonshowdown.com)
let lastResult = null;   // the last replay listed, to continue from
async function search(after) {
  const user = $id('searchUser').value.trim(), format = $id('searchFormat').value.trim();
  const table = $id('searchResults'), err = $id('searchErr');
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
  const rows = found.map(x => `<tr data-visit="${esc(x.id)}"><td>${esc(x.format)}</td><td>${esc(x.players.join(' vs. '))}</td>` +
    `<td>${x.rating || ''}</td><td>${date(x.uploadtime * 1000)}</td></tr>`).join('');
  if (!after) table.innerHTML = `<tr><th>Format</th><th>Players</th><th>Rating</th><th>Uploaded</th></tr>`;
  table.insertAdjacentHTML('beforeend', rows || `<tr><td class="rb-dim">No replays found.</td></tr>`);
  table.hidden = false;
  $id('searchMore').hidden = !more;
  for (const row of table.querySelectorAll('[data-visit]')) row.onclick = () => visit(row.dataset.visit);
}
