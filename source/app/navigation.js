// Moving around the study: what the current position is, going to another one, arrow keys and pick shortcuts.
import {S, $id, clearPicks} from './state.js';
import {isReplayPos, replayTurn, parentOf, childrenOf, siblings, compute, replayTurnPos, previewPos} from './study.js';
import {isDoubles} from './replay.js';
import {isPlaying, showPosition} from './viewer.js';
import {pickerOn, renderPicker, closeMenu} from './picker.js';
import {renderDice} from './dice.js';
import {renderStudyPanel} from './panels.js';

// The current position: on the replay ('replay'; 'preview' or 'turn' when the move picker can take over there),
// or in a line ('line', with the dice of the step that led to it).
export function position() {
  if (!isReplayPos(S.cur)) { const r = compute(S.cur); return {kind: 'line', battle: r.battle, rolls: r.rolls}; }
  const t = replayTurn(S.cur);
  const canPick = pickerOn() && !isDoubles() && !isPlaying();
  if (canPick && t === 0 && S.psb && !S.psb.started) {
    const pv = previewPos(S.study.sets);
    if (pv) return {kind: 'preview', t, battle: pv.battle};
  }
  if (canPick && t >= 1 && t <= S.rep.lastTurn) return {kind: 'turn', t, battle: replayTurnPos(t, S.study.sets).battle};
  return {kind: 'replay', t};
}

// The panels follow at most once per burst of moves (holding Next turn, playing at Hyperfast...): positions can take a
// moment to set up, and only the one you stop on matters.
let pending = null;
export function renderPanels() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; renderNow(); }, 30);
}
function renderNow() {
  if (!S.rep) return;
  let pos;
  try { pos = position(); } catch (e) {
    console.error(e);
    S.err = e.message || String(e);
    pos = {kind: 'replay', t: isReplayPos(S.cur) ? replayTurn(S.cur) : 0};
  }
  renderPicker(pos); renderDice(pos); renderStudyPanel();
}

// Go to a position. animate: play a line's last step instead of jumping to its end; force: show it even if it is current.
export function go(id, {animate = false, force = false} = {}) {
  if (!id) return;
  if (isReplayPos(id) ? replayTurn(id) < 0 || replayTurn(id) > S.rep.lastTurn + 1 : !S.study.nodes[id]) return;
  const moved = S.cur !== id;
  if (moved) { clearPicks(); S.err = ''; }
  S.cur = id; S.deleteArmed = null;
  if (moved || force || !S.psMode) showPosition(animate);
  renderPanels();
}

export function step(dir) {
  if (dir === 'prev') go(parentOf(S.cur));
  else if (dir === 'next') { const next = childrenOf(S.cur)[0]; go(next, {animate: !!next && !isReplayPos(next)}); }
  else {
    const sib = siblings(S.cur), j = sib.indexOf(S.cur) + (dir === 'up' ? -1 : 1);
    if (j >= 0 && j < sib.length) go(sib[j]);
  }
}

// Arrows walk the study (left/right: back/forward, up/down: other lines here). In an open move menu 1-9 pick and T ticks
// Terastallize (or Mega Evolution, Z-Power, Dynamax); Esc closes it. Enter plays the turn.
export function onKey(e) {
  if (!S.rep || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select')) return;
  if (document.querySelector('.rb-modal:not([hidden]), #gate:not([hidden])')) return;
  const dir = {ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'up', ArrowDown: 'down'}[e.key];
  if (dir) { e.preventDefault(); step(dir); return; }
  const menu = $id('pickSec').querySelector('.rb-menu');
  if (e.key === 'Escape' && closeMenu()) { renderNow(); return; }
  if (e.key === 'Enter' && !menu && !e.target.closest('button, a')) {
    const play = $id('btnPlayTurn');
    if (play && !play.disabled) { e.preventDefault(); play.click(); }
    return;
  }
  if (!menu) return;
  if (/^[1-9]$/.test(e.key)) {
    const b = menu.querySelectorAll('[data-pick]')[+e.key - 1];
    if (b && !b.disabled) { e.preventDefault(); b.click(); }
  } else if (e.key === 't' || e.key === 'T') {
    const box = menu.querySelector('[data-gimmick]');
    if (box) box.click();
  }
}
// A click anywhere else closes the move menu.
export function onOutsideClick(e) {
  if (!e.target.closest('#pickSec') && closeMenu()) renderNow();
}
