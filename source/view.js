// ------------------------------------------------------------------ the Showdown battle view (swapped into the embed)
const FADE = {hyperfast: 40, fast: 50, normal: 300, slow: 500, reallyslow: 1000}, DELAY = {hyperfast: 1, fast: 1, normal: 1, slow: 1000, reallyslow: 3000};
function newPS(lines) {
  const old = Replays.battle;
  const view = old && old.viewpointSwitched;
  try { old.destroy(); } catch {}
  Replays.$('.battle').empty(); Replays.$('.battle-log').empty();
  const b = new Battle({id: S.key, $frame: Replays.$('.battle'), $logFrame: Replays.$('.battle-log'), log: lines, isReplay: true, paused: true, autoresize: true});
  const sp = Replays.$('.speedchooser button.sel').val() || 'normal';
  b.messageShownTime = DELAY[sp]; b.messageFadeTime = FADE[sp];
  try { b.scene.updateAcceleration(); } catch {}
  try { b.setMute(!!Replays.muted); } catch {}
  if (view) b.switchViewpoint();
  Replays.battle = b;
  b.subscribe(st => { Replays.update(st); onPS(); });
  Replays.update();
  S.psb = b;
  return b;
}
function onPS() {
  if (S.lock || !S.psb) return;
  if (S.psMode === 'main' && !S.take) {
    const b = S.psb;
    const t = b.ended ? S.rep.lastTurn + 1 : Math.max(1, Math.min(b.turn, S.rep.lastTurn + 1));
    const id = 'r' + t;
    if (id !== S.cur) { S.cur = id; S.sel = {}; S.tera = {}; renderPanels(); }
  }
}
function showPosition(animate) {
  S.lock = true;
  try {
    if (isMain(S.cur)) {
      if (S.psMode !== 'main') { newPS(S.rep.lines); S.psMode = 'main'; }
      const t = mainT(S.cur);
      if (t > S.rep.lastTurn) S.psb.seekTurn(Infinity); else S.psb.seekTurn(t);
    } else {
      const path = pathTo(S.cur);
      const t0 = mainT(S.study.nodes[path[0]].parent);
      const prefix = S.rep.lines.slice(0, S.rep.turnIdx[t0] + 1);
      const before = path.slice(0, -1).flatMap(id => compute(id).lines);
      const last = compute(S.cur).lines;
      S.psMode = 'branch:' + S.cur;
      if (animate) { newPS(prefix.concat(before)); S.psb.seekTurn(Infinity); for (const l of last) S.psb.add(l); S.psb.play(); }
      else { newPS(prefix.concat(before, last)); S.psb.seekTurn(Infinity); }
    }
  } finally { S.lock = false; }
  setTitle();
}
function setTitle() {
  const m = S.rep.meta; const ps = m.players || [S.cbEnd.p1.name, S.cbEnd.p2.name];
  $id('rbTitle').innerHTML = `<strong>${esc(S.rep.tier || S.rep.formatid)}</strong><br>${esc(ps[0] || 'Player 1')} vs. ${esc(ps[1] || 'Player 2')}${!isMain(S.cur) ? ' <span class="rb-mode">Your line</span>' : S.take ? ' <span class="rb-mode">Taking over</span>' : ''}`;
}
function ctl(a) {
  if (a === 'load') { $id('loader').hidden = false; $id('loadErr').textContent = ''; $id('pasteBox').focus(); }
  else if (a === 'export') { $id('exportBox').value = JSON.stringify({rbv: 1, log: S.rep.lines.join('\n'), study: S.study}); $id('exporter').hidden = false; $id('copyMsg').textContent = ''; }
}
function renderControls() { setTitle(); }
