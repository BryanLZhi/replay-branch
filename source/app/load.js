// Opening a replay (link, log, saved replay file or exported study) and exporting a study.
import {S, E, $id, clone, hash} from './state.js';
import {newStudy, loadSaved, save} from './study.js';
import {go} from './navigation.js';

// Load a replay or an exported study ({rbv, log, study}). shown: the viewer already shows this replay.
export async function loadText(text, {shown = false} = {}) {
  const t = String(text || '').trim();
  let exported = null;
  if (t.startsWith('{')) { try { const j = JSON.parse(t); if (j && j.rbv && j.log) exported = j; } catch {} }
  const rep = E.parseReplayInput(exported ? exported.log : t);

  S.rep = rep;
  S.key = rep.meta.id || 'log-' + hash(rep.lines.slice(0, 40).join('\n') + rep.lines.length);
  S.lines.clear(); S.replayPos.clear();
  S.stats = await fetchStats(rep.formatid);
  S.cbEnd = E.clientAt(rep, rep.lastTurn + 1).cb;
  S.base = [S.cbEnd.p1, S.cbEnd.p2].map(side => side.team.map(p => E.suggestSet(E.knownOf(p), S.stats, rep.gen)));
  S.study = exported?.study || loadSaved(S.key) || newStudy();
  const fits = S.study.sets?.length === 2 && S.study.sets.every((side, si) => side.length === S.base[si].length);
  if (!fits) S.study.sets = clone(S.base);
  if (exported) save();

  S.sel = {}; S.tera = {}; S.err = '';
  if (!shown) S.psMode = '';   // rebuild the viewer for this replay
  S.cur = '';
  go('r0');
}

// Usage stats for a format (null for formats without them, such as random battles).
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

export function wireDialogs() {
  const loader = $id('loader'), exporter = $id('exporter');
  $id('btnLoad').onclick = () => { loader.hidden = false; $id('loadErr').textContent = ''; $id('replayUrl').focus(); };
  $id('btnExport').onclick = () => {
    $id('exportBox').value = JSON.stringify({rbv: 1, log: S.rep.lines.join('\n'), study: S.study});
    $id('copyMsg').textContent = ''; exporter.hidden = false;
  };
  $id('fileIn').onchange = async () => { const f = $id('fileIn').files[0]; if (f) $id('pasteBox').value = await f.text(); };
  $id('btnDoLoad').onclick = () => loadFrom(async () => {
    const id = replayIdFrom($id('replayUrl').value) || replayIdFrom($id('pasteBox').value);
    return id ? fetchReplay(id) : $id('pasteBox').value;
  });
  $id('btnSample').onclick = () => loadFrom(() => fetch('sample.json').then(r => r.text()));
  $id('btnCancel').onclick = () => { loader.hidden = true; };
  $id('btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($id('exportBox').value); $id('copyMsg').textContent = 'Copied'; }
    catch { $id('exportBox').select(); $id('copyMsg').textContent = 'Press Ctrl+C to copy'; }
  };
  $id('btnCloseExport').onclick = () => { exporter.hidden = true; };
  for (const modal of [loader, exporter]) {
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });
  }
}

async function loadFrom(getText) {
  $id('loadErr').textContent = '';
  try {
    await loadText(await getText());
    $id('loader').hidden = true; $id('pasteBox').value = ''; $id('replayUrl').value = '';
  } catch (e) { $id('loadErr').textContent = e.message || String(e); }
}
