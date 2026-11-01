// The move picker: "What will X do?" for one player at a time, under the replay controls.
// Picking what the replay's players did plays the replay's own turn; anything else starts (or continues) a line.
import {S, E, $id, esc, pid, nameOf, stored, store} from './state.js';
import {kids, pathTo, lineSets, addNode, deleteNode, compute, forget, save} from './study.js';
import {playedChoice, matchesPlayed, teamIndex} from './replay.js';
import {showPickerSetting, showPosition} from './viewer.js';
import {renderPanels, go} from './navigation.js';
import {movesDatalist} from './panels.js';
import {setTooltipRequest} from './tooltips.js';

export const pickerOn = () => stored('rb-picker', 'on') !== 'off';
export function setPicker(on) { store('rb-picker', on ? 'on' : 'off'); S.sel = {}; S.tera = {}; renderPanels(); }

const typeTag = t => t ? `<span class="rb-type t-${esc(t)}">${esc(t)}</span>` : '';
const icon = species => { try { return Dex.getPokemonIcon(species); } catch { return ''; } };

// Players with a decision to make, and the first of them still to pick.
function whoChooses(battle) {
  const need = battle.sides.map((side, si) => ({si, side, req: side.activeRequest})).filter(x => x.req && !x.req.wait);
  return {need, next: need.find(x => !S.sel[pid(x.si)])};
}

export function renderPicker(pos) {
  const el = $id('pickSec');
  const turn = pos.battle && !pos.battle.ended && pickerOn() && whoChooses(pos.battle);
  if (!turn || !turn.next) {
    setTooltipRequest(null);
    el.innerHTML = S.err ? `<p class="rb-err">${esc(S.err)}</p>` : '';
    el.hidden = !S.err;
    showPickerSetting();
    return;
  }
  const {need, next: {si, side, req}} = turn;
  setTooltipRequest(si, req);
  const played = pos.kind === 'line' ? null : playedChoice(pos.t, si);
  const forced = req.forceSwitch && req.forceSwitch[0];
  const active = nameOf((req.side.pokemon.find(p => p.active) || {ident: ''}).ident);
  const question = pos.kind === 'preview' ? `${esc(side.name)}: choose a lead`
    : forced ? `${esc(side.name)}: switch in a Pok&eacute;mon` : `${esc(side.name)}: what will ${esc(active)} do?`;
  const body = pos.kind === 'preview' ? leadButtons(req, played) : (forced ? '' : moveButtons(pos, si, req, active, played)) + switchButtons(req, forced, played);
  const undo = need.some(x => S.sel[pid(x.si)]) ? `<button class="button" id="btnUndo"><i class="fa fa-undo" aria-hidden="true"></i> Back</button>` : '';
  el.innerHTML = `<div class="rb-pside"><h3><span>${question}</span>${undo}</h3>${body}</div>${S.err ? `<p class="rb-err">${esc(S.err)}</p>` : ''}`;
  el.hidden = false;
  showPickerSetting();

  for (const b of el.querySelectorAll('[data-pick]')) b.onclick = () => {
    S.sel[pid(si)] = b.dataset.pick; S.err = '';
    if (whoChooses(pos.battle).next) renderPicker(pos); else playTurn(pos);
  };
  const tera = $id('teraBox'); if (tera) tera.onchange = () => { S.tera[pid(si)] = tera.checked; };
  if (undo) $id('btnUndo').onclick = () => {
    const last = need.filter(x => S.sel[pid(x.si)]).pop();
    delete S.sel[pid(last.si)]; delete S.tera[pid(last.si)];
    renderPicker(pos);
  };
  for (const b of el.querySelectorAll('[data-edit]')) b.onclick = () => editGuessedMove(pos, si, active, b);
}

function leadButtons(req, played) {
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    const name = nameOf(p.ident); const was = played && played.name === name;
    return `<button type="button" class="button rb-sw has-tooltip ${was ? 'played' : ''}" data-pick="team ${n + 1}" data-tooltip="switchpokemon|${n}" ${was ? 'data-note="Lead in the replay"' : ''}><span class="rb-picon" style="${icon(p.details.split(',')[0])}"></span>${esc(name)}</button>`;
  }).join('')}</div>`;
}

function moveButtons(pos, si, req, active, played) {
  const act = req.active[0];
  const k = teamIndex(si, active);
  const known = k >= 0 ? S.base[si][k].fixed.moves.map(E.toID) : [];
  const moves = act.moves.map((m, i) => {
    const type = E.Dex.moves.get(m.id || m.move).type || 'Normal';
    const was = played && played.kind === 'move' && E.toID(played.name) === E.toID(m.move);
    const guessed = k >= 0 && !known.includes(E.toID(m.move)) && !['struggle', 'recharge'].includes(E.toID(m.move));
    const note = guessed ? 'Guessed' : was ? 'Used in the replay' : '';
    return `<div class="rb-mvwrap"><button type="button" class="rb-mv has-tooltip t-${esc(type)} ${was ? 'played' : ''} ${guessed ? 'guess' : ''}" data-pick="move ${i + 1}" ` +
      `data-tooltip="move|${i}" ${note ? `data-note="${note}"` : ''} ${m.disabled || m.pp === 0 ? 'disabled' : ''}>` +
      `<b>${esc(m.move)}</b><small><span>${esc(type)}</span><span>${m.maxpp ? `${m.pp}/${m.maxpp}` : ''}</span></small></button>` +
      (guessed ? `<button type="button" class="rb-edit" data-edit="${esc(m.move)}" title="Change this guessed move" aria-label="Change ${esc(m.move)}"><i class="fa fa-pencil" aria-hidden="true"></i></button>` : '') + `</div>`;
  });
  const tera = act.canTerastallize ? `<p class="rb-row" style="margin-top:6px"><label><input type="checkbox" id="teraBox" ${S.tera[pid(si)] ? 'checked' : ''}> Terastallize</label> ${typeTag(act.canTerastallize)}</p>` : '';
  return `<div class="rb-moves">${moves.join('')}</div>${tera}`;
}

function switchButtons(req, forced, played) {
  const trapped = !forced && req.active && req.active[0].trapped;
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    if (p.active && !forced) return '';
    const name = nameOf(p.ident); const fainted = /fnt/.test(p.condition);
    const [hp, max] = p.condition.split(' ')[0].split('/');
    const was = played && played.kind === 'switch' && played.name === name;
    return `<button type="button" class="button rb-sw has-tooltip ${was ? 'played' : ''}" data-pick="switch ${n + 1}" data-tooltip="switchpokemon|${n}" ` +
      `${was ? 'data-note="Used in the replay"' : ''} ${fainted || p.active || trapped ? 'disabled' : ''}>` +
      `<span class="rb-picon" style="${icon(p.details.split(',')[0])}"></span>${esc(name)} <small>${fainted ? 0 : Math.round(hp / max * 100)}%</small></button>`;
  }).join('')}</div>`;
}

// Turn a guessed move's button into a text box; the new move goes into the sets (and into this line, replayed).
function editGuessedMove(pos, si, active, button) {
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
  save(); S.err = ''; S.sel = {}; S.tera = {};
  if (pos.kind === 'line') showPosition(false);
  renderPanels();
}

// Both players have picked: follow the replay if that is what was played, else play the turn as a line.
export function playTurn(pos) {
  const choices = {};
  pos.battle.sides.forEach((side, si) => {
    if (!side.activeRequest || side.activeRequest.wait) return;
    let c = S.sel[pid(si)];
    if (c.startsWith('move') && S.tera[pid(si)]) c += ' terastallize';
    choices[pid(si)] = c;
  });
  const reset = () => { S.sel = {}; S.tera = {}; S.err = ''; };
  const onReplay = pos.kind === 'turn' || pos.kind === 'preview';
  if (onReplay && pos.battle.sides.every((side, si) => !side.activeRequest || side.activeRequest.wait ||
      matchesPlayed(side, S.sel[pid(si)], S.tera[pid(si)], playedChoice(pos.t, si)))) {
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
    try { compute(id); } catch (e) { deleteNode(id); save(); reset(); S.err = e.message || String(e); renderPicker(pos); return; }
  }
  reset();
  go(id, {animate: true});
}
