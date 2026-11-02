// Opening a replay (link, log, saved replay file or exported study), sharing a study (as a link or as text), and which page
// the address shows.
import {S, E, $id, hash, clearPicks, store} from './state.js';
import {newStudy, loadSaved, save} from './study.js';
import {cleanStudy} from './clean.js';
import {go} from './navigation.js';
import {renderLanding} from './landing.js';

export const SAMPLE = 'smogtours-gen9uu-987009';

// ---------------------------------------------------------------- pages
// The address says what to show: the landing page, ?r=<replay id, or the key of a saved study of a pasted log>, or
// #s=<a shared study>.
export async function route() {
  const key = new URLSearchParams(location.search).get('r');
  const shared = location.hash.startsWith('#s=');
  showPage(key || shared ? 'viewer' : 'landing');
  if (!key && !shared) { renderLanding(); return; }
  await S.ready;
  try {
    if (shared) await openSharedLink();
    else if (key !== S.key) await openKey(key);
  } catch (e) {
    history.replaceState(null, '', location.pathname);
    showPage('landing'); renderLanding();
    $id('openErr').textContent = e.message || String(e);
  }
}
// Show a replay (by id or saved key), with its own address.
export function visit(key) {
  history.pushState(null, '', '?r=' + encodeURIComponent(key));
  route();
}
export function showPage(page) {
  $id('landing').hidden = page !== 'landing';
  $id('viewer').hidden = $id('viewerBtns').hidden = page !== 'viewer';
  document.body.dataset.page = page;
  if (page === 'landing') document.title = 'Replay Branch';
}
async function openKey(key) {
  const log = loadSaved(key)?.meta?.log;   // (a pasted log is kept with its study)
  if (log) await loadText(log);
  else await loadText(await fetchReplay(key), {replayId: key});
}

// Load a replay or an exported study ({rbv, log, study}). shown: the viewer already shows this replay;
// replayId: it is replay.pokemonshowdown.com/<replayId> (share links use it); study: open this study of it.
export async function loadText(text, {shown = false, replayId = null, study = null} = {}) {
  const t = String(text || '').trim();
  let exported = null;
  if (t.startsWith('{')) { try { const j = JSON.parse(t); if (j && j.rbv && j.log) exported = j; } catch {} }
  const rep = E.parseReplayInput(exported ? exported.log : t);

  S.rep = rep;
  S.replayId = replayId;
  S.key = rep.meta.id || 'log-' + hash(rep.lines.slice(0, 40).join('\n') + rep.lines.length);
  S.lines.clear(); S.replayPos.clear();
  S.stats = await fetchStats(rep.formatid);
  S.cbEnd = E.clientAt(rep, rep.lastTurn + 1);
  S.base = E.revealedTeams(rep).map(team => team.map(known => E.suggestSet(known, S.stats, rep.gen)));
  S.study = cleanStudy(study || exported?.study || loadSaved(S.key) || newStudy(), S.base);
  // what the landing page lists (a log that is not on the replay site is kept, to open it again)
  S.study.meta = {format: rep.tier || rep.formatid, players: [S.cbEnd.p1.name, S.cbEnd.p2.name], ...(replayId ? {} : {log: rep.lines.join('\n')})};
  S.study.opened = Date.now();
  save();
  document.title = `${S.study.meta.players.join(' vs. ')} - Replay Branch`;

  clearPicks(); S.err = '';
  if (!shown) S.psMode = '';   // rebuild the viewer for this replay
  S.cur = '';
  go('r0');
}

// Usage stats for a format (null for formats without them).
let statsIndex = null;
async function fetchStats(formatid) {
  try {
    statsIndex ||= fetch('stats/index.json').then(r => r.json());
    if (!(formatid in await statsIndex)) return null;
    const r = await fetch('stats/' + formatid + '.json');
    return r.ok ? await r.json() : null;
  } catch { statsIndex = null; return null; }
}

// replay.pokemonshowdown.com/<id> (or psim.us/r/<id>), with or without .json/.log, to <id>.
export function replayIdFrom(s) {
  const m = String(s || '').trim().replace(/[?#].*$/, '').replace(/\.(json|log|html)$/, '')
    .match(/^(?:https?:\/\/)?(?:replay\.pokemonshowdown\.com|psim\.us\/r)\/([a-z0-9-]+)$/i);
  return m ? m[1] : null;
}
async function fetchReplay(id) {
  const r = await fetch(`https://replay.pokemonshowdown.com/${id}.json`);
  if (!r.ok) throw new Error(r.status === 404 ? 'Replay not found (it may be private or deleted).' : `Could not load the replay (${r.status}).`);
  return r.text();
}

// ---------------------------------------------------------------- share links
// The study without what only this browser needs (the log goes along once, and when it was opened here).
const shareable = () => ({...S.study, meta: undefined, opened: undefined});

// The link carries the study, deflated, after #s= (and the replay's id, or its whole log if it is not on the replay site).
async function shareLink() {
  // (a private replay's id holds its password: send the battle itself, not a way into the replay)
  const byId = S.replayId && !/pw$/.test(S.replayId);
  const payload = {rbv: 1, study: shareable(), ...(byId ? {id: S.replayId} : {log: S.rep.lines.join('\n')})};
  const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const data = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return location.origin + location.pathname + '#s=' + data;
}

// Open the study in the page's link (then the address becomes the replay's, so a reload keeps local changes).
export async function openSharedLink() {
  const m = /^#s=([\w-]+)$/.exec(location.hash);
  if (!m) return;
  const binary = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const payload = JSON.parse(await new Response(stream).text());
  const text = payload.id ? await fetchReplay(payload.id) : payload.log;
  await loadText(text, {replayId: payload.id || null, study: payload.study});
  history.replaceState(null, '', '?r=' + encodeURIComponent(S.key));
}

// ---------------------------------------------------------------- dialogs
export function wireDialogs() {
  const loader = $id('loader'), sharer = $id('sharer');
  $id('btnLoad').onclick = () => { loader.hidden = false; $id('loadErr').textContent = ''; $id('replayUrl').focus(); };
  $id('btnShare').onclick = async () => {
    $id('exportBox').value = JSON.stringify({rbv: 1, log: S.rep.lines.join('\n'), study: shareable()});
    $id('shareLink').value = await shareLink();
    $id('copyMsg').textContent = ''; sharer.hidden = false;
  };
  $id('fileIn').onchange = async () => { const f = $id('fileIn').files[0]; if (f) $id('pasteBox').value = await f.text(); };
  $id('btnDoLoad').onclick = () => loadFrom(async () => {
    const id = replayIdFrom($id('replayUrl').value) || replayIdFrom($id('pasteBox').value);
    return id ? {text: await fetchReplay(id), replayId: id} : {text: $id('pasteBox').value};
  });
  $id('btnSample').onclick = () => { $id('loader').hidden = true; visit(SAMPLE); };
  $id('btnCancel').onclick = () => { loader.hidden = true; };
  const copy = async (box, done) => {
    try { await navigator.clipboard.writeText(box.value); $id('copyMsg').textContent = done; }
    catch { box.select(); $id('copyMsg').textContent = 'Press Ctrl+C to copy'; }
  };
  $id('btnCopyLink').onclick = () => copy($id('shareLink'), 'Link copied');
  $id('btnCopy').onclick = () => copy($id('exportBox'), 'Text copied');
  $id('btnCloseShare').onclick = () => { sharer.hidden = true; };
  for (const modal of [loader, sharer, $id('importer')]) {
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });
  }
}

async function loadFrom(get) {
  $id('loadErr').textContent = '';
  const wasLanding = !$id('landing').hidden;
  try {
    const {text, replayId} = await get();
    await S.ready;
    E.parseReplayInput(text.trim().startsWith('{') ? JSON.parse(text).log || text : text);   // (fails here on a bad paste, before the page changes)
    showPage('viewer');
    await loadText(text, {replayId});
    history.pushState(null, '', '?r=' + encodeURIComponent(S.key));
    $id('loader').hidden = true; $id('pasteBox').value = ''; $id('replayUrl').value = '';
  } catch (e) {
    if (wasLanding) showPage('landing');
    $id('loadErr').textContent = e.message || String(e);
  }
}
