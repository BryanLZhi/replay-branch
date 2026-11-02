// The turn bar, under the replay controls: the two players' choices for the turn on screen, and Play turn.
// On the replay the choices start as what the players did (so Play turn follows the replay); click one to open Showdown's
// move menu for that player and change it, which makes Play turn play your line. In a line they start empty.
import {S, E, $id, esc, pid, nameOf, stored, store, clearPicks} from './state.js';
import {kids, pathTo, lineSets, addNode, deleteNode, compute, forget, save} from './study.js';
import {playedChoice, matchesPlayed, moveNames, teamIndex, playerName, isDoubles} from './replay.js';
import {showPickerSetting, showPosition, isPlaying} from './viewer.js';
import {renderPanels, go} from './navigation.js';
import {movesDatalist} from './teams.js';
import {setTooltipRequest} from './tooltips.js';

export const pickerOn = () => stored('rb-picker', 'on') !== 'off';
export function setPicker(on) { store('rb-picker', on ? 'on' : 'off'); clearPicks(); renderPanels(); }

const typeTag = t => t ? `<span class="rb-type t-${esc(t)}">${esc(t)}</span>` : '';
const icon = species => { try { return Dex.getPokemonIcon(species); } catch { return ''; } };
const GIMMICK_NAMES = {terastallize: 'Tera', mega: 'Mega', megax: 'Mega X', megay: 'Mega Y', ultra: 'Ultra Burst', zmove: 'Z', dynamax: 'Dynamax'};

// ---------------------------------------------------------------- what each player does this turn
const requestOf = (pos, si) => { const req = pos.battle?.sides[si].activeRequest; return req && !req.wait ? req : null; };

// What the replay's player did here, as a pick ('move 2', 'switch 4', 'team 1') and its gimmick (null in a line).
function playedPick(pos, si, req) {
  if (pos.kind === 'line') return null;
  const played = playedChoice(pos.t, si);
  if (!played) return null;
  const nth = name => req.side.pokemon.findIndex(p => nameOf(p.ident) === name) + 1;
  if (played.kind === 'lead') return nth(played.name) ? {pick: 'team ' + nth(played.name), gimmick: ''} : null;
  if (played.kind === 'switch') return nth(played.name) ? {pick: 'switch ' + nth(played.name), gimmick: ''} : null;
  const act = req.active?.[0];
  if (!act) return null;
  // (a Pokemon that could not move did not show its choice: any move follows the replay)
  const i = played.kind === 'cant' ? act.moves.findIndex(m => !m.disabled) : act.moves.findIndex((_, i) => moveNames(act, i + 1).includes(E.toID(played.name)));
  if (i < 0) return null;
  let gimmick = played.gimmick;
  if (gimmick === 'mega') gimmick = act.canMegaEvo ? 'mega' : act.canMegaEvoX ? 'megax' : act.canMegaEvoY ? 'megay' : 'mega';
  return {pick: 'move ' + (i + 1), gimmick: gimmick || ''};
}
// The pick and gimmick a slot holds now: changed by you, else what was played.
function slot(pos, si, req) {
  const def = playedPick(pos, si, req);
  const pick = S.sel[pid(si)] || def?.pick || null;
  const gimmick = S.gimmick[pid(si)] ?? def?.gimmick ?? '';
  const changed = !!def && (pick !== def.pick || gimmick !== def.gimmick) || !def && !!pick;
  return {pick, gimmick, changed, def};
}

// How a pick reads in its slot (move name, or the Pokemon switched in), with its type colour.
function pickLabel(req, pick, gimmick) {
  const [kind, n] = pick.split(' ');
  if (kind === 'move') {
    const act = req.active[0], m = act.moves[n - 1];
    const as = gimmick === 'zmove' ? act.canZMove?.[n - 1] : gimmick === 'dynamax' || (act.maxMoves && !act.canDynamax) ? act.maxMoves?.maxMoves?.[n - 1] : null;
    const shown = as && E.Dex.moves.get(as.move);
    const name = !as ? m.move : shown.exists ? shown.name : as.move;
    const type = (shown?.exists ? shown : E.Dex.moves.get(m.id || m.move)).type || 'Normal';
    const extra = gimmick && !['zmove', 'dynamax'].includes(gimmick) ? ` <small>+ ${GIMMICK_NAMES[gimmick]}</small>` : '';
    return {html: esc(name) + extra, type};
  }
  const p = req.side.pokemon[n - 1];
  return {html: `<span class="rb-picon" style="${icon(p.details.split(',')[0])}"></span>${kind === 'switch' ? '&rarr; ' : ''}${esc(nameOf(p.ident))}`, type: ''};
}

// ---------------------------------------------------------------- the bar
export function renderPicker(pos) {
  const el = $id('pickSec');
  showPickerSetting();
  el.hidden = !pickerOn();
  if (el.hidden) { setTooltipRequest(null); return; }
  const battle = pos.battle;
  const turnLabel = pos.kind === 'preview' ? 'Team preview' : battle ? `Turn ${battle.turn}` : pos.t > S.rep.lastTurn ? 'End' : pos.t ? `Turn ${pos.t}` : 'Start';
  let slots, playable = false;
  if (!battle || battle.ended) {
    // playing, at the end, or nothing to choose here: the same bar, quiet
    const why = battle?.ended ? 'The battle is over' : isDoubles() ? 'Doubles can only be watched' : pos.t > S.rep.lastTurn ? 'End of the replay' : '';
    const playing = isPlaying();
    slots = why ? [`<span class="rb-dim">${why}</span>`] : [0, 1].map(si => `<div class="rb-slotwrap"><span class="rb-who">${esc(playerName(si))}</span>` +
      `<button type="button" class="rb-slot quiet" ${playing ? `data-slot="${si}"` : 'disabled'}>&hellip;</button></div>`);
  } else {
    const need = [0, 1].map(si => requestOf(pos, si));
    playable = need.some(Boolean) && need.every((req, si) => !req || slot(pos, si, req).pick);
    slots = [0, 1].map(si => {
      const req = need[si];
      if (!req) return `<div class="rb-slotwrap"><span class="rb-who">${esc(playerName(si))}</span><button type="button" class="rb-slot quiet" disabled>waiting</button></div>`;
      const s = slot(pos, si, req);
      const label = s.pick ? pickLabel(req, s.pick, s.gimmick) : {html: 'Choose', type: ''};
      return `<div class="rb-slotwrap"><span class="rb-who">${esc(playerName(si))}</span>` +
        `<button type="button" class="rb-slot ${label.type ? 't-' + esc(label.type) : 'plain'} ${s.changed ? 'changed' : ''} ${s.pick ? '' : 'empty'} ${S.menu === si ? 'open' : ''}" ` +
        `data-slot="${si}" aria-haspopup="true" aria-expanded="${S.menu === si}">${label.html} <i class="fa fa-caret-down" aria-hidden="true"></i></button></div>`;
    });
  }
  el.innerHTML = `<div class="rb-bar"><span class="rb-turn">${turnLabel}</span><div class="rb-slots">${slots.join('')}</div>` +
    `<button type="button" class="button rb-play" id="btnPlayTurn" ${playable ? '' : 'disabled'}><i class="fa fa-play" aria-hidden="true"></i> Play turn</button></div>` +
    (S.err ? `<p class="rb-err">${esc(S.err)}</p>` : '') + menuHTML(pos);

  for (const b of el.querySelectorAll('[data-slot]')) b.onclick = e => { e.stopPropagation(); openMenu(pos, +b.dataset.slot); };
  $id('btnPlayTurn').onclick = () => { if (playable) playTurn(pos); };
  wireMenu(pos);
}

// A slot clicked while the replay plays: stop at the start of this turn, then open it.
function openMenu(pos, si) {
  if (isPlaying()) {
    S.psb.pause();
    S.menu = si;
    go(S.cur, {force: true});
    return;
  }
  S.menu = S.menu === si ? null : si;
  renderPicker(pos);
}
export function closeMenu() {
  if (S.menu == null) return false;
  S.menu = null; setTooltipRequest(null);
  return true;
}

// ---------------------------------------------------------------- the move menu (Showdown's "What will X do?")
function menuHTML(pos) {
  const si = S.menu;
  const req = si != null && pos.battle && !pos.battle.ended ? requestOf(pos, si) : null;
  if (!req) { setTooltipRequest(null); return ''; }
  setTooltipRequest(si, req);
  const s = slot(pos, si, req);
  const forced = req.forceSwitch && req.forceSwitch[0];
  const active = nameOf((req.side.pokemon.find(p => p.active) || {ident: ''}).ident);
  const who = esc(playerName(si));
  const question = pos.kind === 'preview' ? `${who}: choose a lead` : forced ? `${who}: switch in a Pok&eacute;mon` : `${who}: what will ${esc(active)} do?`;
  const body = pos.kind === 'preview' ? leadButtons(req, s) : (forced ? '' : moveButtons(pos, si, req, active, s)) + switchButtons(req, forced, s);
  return `<div class="rb-menu" role="dialog" aria-label="${who}'s choice"><h3><span>${question}</span>` +
    `<button type="button" class="rb-linkbtn" id="btnCloseMenu" aria-label="Close">&times;</button></h3>${body}</div>`;
}

function wireMenu(pos) {
  const menu = $id('pickSec').querySelector('.rb-menu');
  if (!menu) return;
  const si = S.menu;
  menu.onclick = e => e.stopPropagation();
  $id('btnCloseMenu').onclick = () => { closeMenu(); renderPicker(pos); };
  for (const b of menu.querySelectorAll('[data-pick]')) b.onclick = () => {
    S.sel[pid(si)] = b.dataset.pick; S.err = '';
    closeMenu(); renderPicker(pos);
  };
  for (const box of menu.querySelectorAll('[data-gimmick]')) box.onchange = () => {
    S.gimmick[pid(si)] = box.checked ? box.dataset.gimmick : ''; renderPicker(pos);   // (Z-Power and Dynamax rename the moves)
  };
  for (const b of menu.querySelectorAll('[data-edit]')) b.onclick = () => editGuessedMove(pos, si, b);
}

const pickedHere = (s, pick) => s.pick === pick ? 'chosen' : '';
const playedHere = (s, pick) => s.def?.pick === pick ? 'played' : '';

function leadButtons(req, s) {
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    const pick = 'team ' + (n + 1), was = playedHere(s, pick);
    return `<button type="button" class="button rb-sw has-tooltip ${was} ${pickedHere(s, pick)}" data-pick="${pick}" data-tooltip="switchpokemon|${n}" ` +
      `${was ? 'data-note="Lead in the replay"' : ''}><span class="rb-picon" style="${icon(p.details.split(',')[0])}"></span>${esc(nameOf(p.ident))}</button>`;
  }).join('')}</div>`;
}

// The once-per-battle mechanics this Pokemon can use with its move this turn, in Showdown's words.
function gimmicks(act) {
  return [
    act.canMegaEvo && ['mega', 'Mega Evolution'], act.canMegaEvoX && ['megax', 'Mega Evolution X'], act.canMegaEvoY && ['megay', 'Mega Evolution Y'],
    act.canUltraBurst && ['ultra', 'Ultra Burst'], act.canZMove && ['zmove', 'Z-Power'], act.canDynamax && ['dynamax', 'Dynamax'],
    act.canTerastallize && ['terastallize', 'Terastallize'],
  ].filter(Boolean);
}

function moveButtons(pos, si, req, active, s) {
  const act = req.active[0];
  // with Z-Power ticked the buttons are the Z-Moves; Dynamaxing (or Dynamaxed) the Max Moves
  const mode = s.gimmick === 'zmove' ? 'zmove' : s.gimmick === 'dynamax' || (act.maxMoves && !act.canDynamax) ? 'maxmove' : '';
  const k = teamIndex(si, active);
  const known = k >= 0 ? S.base[si][k].fixed.moves.map(E.toID) : [];
  const pasted = k >= 0 && (pos.kind === 'line' ? lineSets(S.cur) : S.study.sets)[si][k].pasted;
  const calcs = mode ? [] : E.damageCalcs(pos.battle, si);   // (the calc numbers are for the regular moves)
  const moves = act.moves.map((m, i) => {
    const pick = 'move ' + (i + 1);
    const as = mode === 'zmove' ? act.canZMove[i] : mode === 'maxmove' ? act.maxMoves.maxMoves[i] : null;
    const shown = as && E.Dex.moves.get(as.move);   // (a status Z-Move, "Z-Roost", is not a move of its own)
    const name = !as ? m.move : shown.exists ? shown.name : as.move;
    const type = (shown?.exists ? shown : E.Dex.moves.get(m.id || m.move)).type || 'Normal';
    const was = playedHere(s, pick);
    const guessed = k >= 0 && !pasted && !known.includes(E.toID(m.move)) && !['struggle', 'recharge'].includes(E.toID(m.move));
    const note = guessed ? 'Guessed' : was ? 'Used in the replay' : '';
    const disabled = m.disabled || m.pp === 0 || (mode === 'zmove' && !as);
    return `<div class="rb-mvwrap"><button type="button" class="rb-mv has-tooltip t-${esc(type)} ${was} ${pickedHere(s, pick)} ${guessed ? 'guess' : ''}" data-pick="${pick}" ` +
      `data-tooltip="move|${i}|${mode}" ${note ? `data-note="${note}"` : ''} ${calcs[i]?.desc ? `data-calc="${esc(calcs[i].desc)}"` : ''} ${disabled ? 'disabled' : ''}>` +
      `<b>${esc(name)}</b><small><span>${esc(type)}</span>${calcs[i] ? `<span class="rb-dmg">${esc(calcs[i].range)}</span>` : ''}` +
      `<span>${m.maxpp ? `${m.pp}/${m.maxpp}` : ''}</span></small></button>` +
      (guessed ? `<button type="button" class="rb-edit" data-edit="${esc(m.move)}" title="Change this guessed move" aria-label="Change ${esc(m.move)}"><i class="fa fa-pencil" aria-hidden="true"></i></button>` : '') + `</div>`;
  });
  const boxes = gimmicks(act).map(([value, label]) => `<label><input type="checkbox" data-gimmick="${value}" ${s.gimmick === value ? 'checked' : ''}> ${label}</label>` +
    (value === 'terastallize' ? ' ' + typeTag(act.canTerastallize) : '')).join(' ');
  return `<div class="rb-moves">${moves.join('')}</div>${boxes ? `<p class="rb-row" style="margin-top:6px">${boxes}</p>` : ''}`;
}

function switchButtons(req, forced, s) {
  const trapped = !forced && req.active && req.active[0].trapped;
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    if (p.active && !forced) return '';
    const pick = 'switch ' + (n + 1), was = playedHere(s, pick);
    const fainted = /fnt/.test(p.condition);
    const [hp, max] = p.condition.split(' ')[0].split('/');
    return `<button type="button" class="button rb-sw has-tooltip ${was} ${pickedHere(s, pick)}" data-pick="${pick}" data-tooltip="switchpokemon|${n}" ` +
      `${was ? 'data-note="Used in the replay"' : ''} ${fainted || p.active || trapped ? 'disabled' : ''}>` +
      `<span class="rb-picon" style="${icon(p.details.split(',')[0])}"></span>${esc(nameOf(p.ident))} <small>${fainted ? 0 : Math.round(hp / max * 100)}%</small></button>`;
  }).join('')}</div>`;
}

// Turn a guessed move's button into a text box; the new move goes into the sets (and into this line, replayed).
function editGuessedMove(pos, si, button) {
  const req = requestOf(pos, si);
  const active = nameOf((req.side.pokemon.find(p => p.active) || {ident: ''}).ident);
  const old = button.dataset.edit; const k = teamIndex(si, active);
  const sets = pos.kind === 'line' ? lineSets(S.cur) : S.study.sets;
  const wrap = button.parentElement;
  wrap.innerHTML = `<input class="textbox rb-mvinput" list="${movesDatalist(sets[si][k].species)}" value="${esc(old)}" aria-label="Move instead of ${esc(old)}">`;
  const input = wrap.querySelector('input'); input.focus(); input.select();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (v && E.toID(v) !== E.toID(old)) replaceMove(pos, si, k, old, v); else renderPicker(pos);
  };
  input.onkeydown = e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { done = true; renderPicker(pos); } };
  input.onchange = commit; input.onblur = commit;
}
function replaceMove(pos, si, k, oldMove, newMove) {
  const mv = E.Dex.moves.get(newMove);
  if (!mv.exists) { S.err = `"${newMove}" is not a move.`; renderPicker(pos); return; }
  const swap = sets => { const moves = sets[si][k].moves; const j = moves.findIndex(m => E.toID(m) === E.toID(oldMove)); if (j >= 0) moves[j] = mv.name; };
  swap(S.study.sets);
  if (pos.kind === 'line') { const root = pathTo(S.cur)[0]; swap(S.study.nodes[root].sets); forget(root); }
  const menu = S.menu;
  save(); S.err = ''; clearPicks(); S.menu = menu;   // (the menu stays open on the new move)
  if (pos.kind === 'line') showPosition(false);
  renderPanels();
}

// ---------------------------------------------------------------- playing the turn
// Play the turn as the bar shows it: the replay's own turn if nothing differs from it, else a line.
export function playTurn(pos) {
  const choices = {}, picks = {}, gimmicks = {};
  pos.battle.sides.forEach((side, si) => {
    const req = requestOf(pos, si);
    if (!req) return;
    const s = slot(pos, si, req);
    picks[si] = s.pick; gimmicks[si] = s.gimmick;
    choices[pid(si)] = s.pick.startsWith('move') && s.gimmick ? s.pick + ' ' + s.gimmick : s.pick;
  });
  const reset = () => { clearPicks(); S.err = ''; };
  const onReplay = pos.kind === 'turn' || pos.kind === 'preview';
  if (onReplay && pos.battle.sides.every((side, si) => !requestOf(pos, si) || matchesPlayed(side, picks[si], gimmicks[si], playedChoice(pos.t, si)))) {
    reset();
    S.stopAt = pos.t + 1;
    if (pos.t === 0) S.psb.reset(); else S.psb.seekTurn(pos.t);
    S.psb.play();
    renderPanels();
    return;
  }
  const parent = onReplay ? 'r' + pos.t : S.cur;
  const same = k => JSON.stringify(S.study.nodes[k].choices) === JSON.stringify(choices) && !S.study.nodes[k].forced.length;
  let id = kids(parent).find(same);
  if (!id) {
    id = addNode(parent, choices, [], undefined, onReplay ? S.study.sets : undefined);
    try { compute(id); } catch (e) { deleteNode(id); save(); S.err = e.message || String(e); renderPicker(pos); return; }
  }
  reset();
  go(id, {animate: true});
}
