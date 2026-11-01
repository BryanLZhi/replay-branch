// ------------------------------------------------------------------ the Showdown replay embed + our sim
// replay-embed.js (Showdown, MIT) builds the replay viewer exactly like a downloaded replay; we drive Replays.battle.
async function loadEngine() {
  try { return await import('./engine.js'); }
  catch { const t = await fetch('engine.js').then(r => r.text()); return await import(URL.createObjectURL(new Blob([t], {type: 'text/javascript'}))); }
}
function until(test, ms = 30000) {
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = test(); } catch {} if (ok) res(); else if (Date.now() - t0 > ms) rej(new Error('Showdown did not load (check your connection).')); else setTimeout(tick, 100); }; tick(); });
}
async function boot() {
  try {
    E = await loadEngine();
    await until(() => window.Replays && Replays.battle && window.Battle && window.Dex);
    const txt = await fetch('sample.json').then(r => r.text());
    S.psb = Replays.battle; S.psMode = 'main';
    Replays.battle.subscribe(() => onPS());
    await loadText(txt, true);
  } catch (e) {
    $id('takeSec').innerHTML = `<p class="rb-err">Could not start: ${esc(e.message || e)}</p>`;
    console.error(e);
  }
}
