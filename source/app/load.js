// Opening a replay (link, log, saved replay file or exported study), and sharing a study (as a link or as text).
import {S, E, $id, clone, hash, clearPicks} from './state.js';
import {newStudy, loadSaved, save} from './study.js';
import {go} from './navigation.js';

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
  S.study = study || exported?.study || loadSaved(S.key) || newStudy();
  const fits = S.study.sets?.length === 2 && S.study.sets.every((side, si) => side.length === S.base[si].length);
  if (!fits) S.study.sets = clone(S.base);
  if (study || exported) save();

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
// The link carries the study, deflated, after #s= (and the replay's id, or its whole log if it is not on the replay site).
async function shareLink() {
  const payload = {rbv: 1, study: S.study, ...(S.replayId ? {id: S.replayId} : {log: S.rep.lines.join('\n')})};
  const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const data = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return location.href.replace(/#.*$/, '') + '#s=' + data;
}

// Open the study in the page's link, if it has one (then drop it from the address, so a reload keeps local changes).
export async function openSharedLink() {
  const m = /^#s=([\w-]+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.href.replace(/#.*$/, ''));
  const binary = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const payload = JSON.parse(await new Response(stream).text());
  const text = payload.id ? await fetchReplay(payload.id) : payload.log;
  await loadText(text, {replayId: payload.id || null, study: payload.study});
}

// ---------------------------------------------------------------- dialogs
export function wireDialogs() {
  const loader = $id('loader'), sharer = $id('sharer');
  $id('btnLoad').onclick = () => { loader.hidden = false; $id('loadErr').textContent = ''; $id('replayUrl').focus(); };
  $id('btnShare').onclick = async () => {
    $id('exportBox').value = JSON.stringify({rbv: 1, log: S.rep.lines.join('\n'), study: S.study});
    $id('shareLink').value = await shareLink();
    $id('copyMsg').textContent = ''; sharer.hidden = false;
  };
  $id('fileIn').onchange = async () => { const f = $id('fileIn').files[0]; if (f) $id('pasteBox').value = await f.text(); };
  $id('btnDoLoad').onclick = () => loadFrom(async () => {
    const id = replayIdFrom($id('replayUrl').value) || replayIdFrom($id('pasteBox').value);
    return id ? {text: await fetchReplay(id), replayId: id} : {text: $id('pasteBox').value};
  });
  $id('btnSample').onclick = () => loadFrom(async () => {
    const text = await fetch('sample.json').then(r => r.text());
    return {text, replayId: JSON.parse(text).id};
  });
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
  try {
    const {text, replayId} = await get();
    await loadText(text, {replayId});
    $id('loader').hidden = true; $id('pasteBox').value = ''; $id('replayUrl').value = '';
  } catch (e) { $id('loadErr').textContent = e.message || String(e); }
}
