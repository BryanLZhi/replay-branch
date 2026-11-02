// The turn bar, under the replay controls: each Pokemon's choice for the turn on screen (one per player in singles, two
// in doubles), and Play turn. On the replay the choices start as what the players did (so Play turn follows the replay);
// click one to open Showdown's move menu for it and change it, which makes Play turn play your line. In a line they start
// empty. A slot is keyed by its player and place: 'p1a', 'p1b', 'p2a'...
import {S, E, $id, esc, pid, nameOf, stored, store, clearPicks} from './state.js';
import {kids, pathTo, lineSets, addNode, deleteNode, compute, forget, save} from './study.js';
import {playedChoice, matchesPlayed, moveNames, teamIndex, playerName, watchOnly, isFresh} from './replay.js';
import {showPickerSetting, showPosition, isPlaying} from './viewer.js';
import {renderPanels, go} from './navigation.js';
import {movesDatalist} from './teams.js';
import {setTooltipRequest} from './tooltips.js';
import {upcomingDice, sameStep, renderDice} from './dice.js';
import {canEdit, openEditor} from './editor.js';

export const pickerOn = () => stored('rb-picker', 'on') !== 'off';
export function setPicker(on) { store('rb-picker', on ? 'on' : 'off'); clearPicks(); renderPanels(); }

const typeTag = t => t ? `<span class="rb-type t-${esc(t)}">${esc(t)}</span>` : '';
const icon = species => { try { return Dex.getPokemonIcon(species); } catch { return ''; } };
const GIMMICK_NAMES = {terastallize: 'Tera', mega: 'Mega', megax: 'Mega X', megay: 'Mega Y', ultra: 'Ultra Burst', zmove: 'Z', dynamax: 'Dynamax'};
const family = g => g && g.startsWith('mega') ? 'mega' : g || '';
const keyOf = (si, place) => pid(si) + 'abc'[place];

// ---------------------------------------------------------------- what each Pokemon does this turn
const requestOf = (pos, si) => { const req = pos.battle?.sides[si].activeRequest; return req && !req.wait ? req : null; };
const doublesBattle = pos => pos.battle?.gameType === 'doubles';

// The places of side si that choose this turn: the leads at team preview, the Pokemon that must be replaced, or the ones
// on the field (a fainted one, or a Tatsugiri inside Dondozo, has nothing to choose).
function placesOf(pos, si, req) {
  if (req.teamPreview) return doublesBattle(pos) ? [0, 1] : [0];
  const side = pos.battle.sides[si];
  if (req.forceSwitch) return req.forceSwitch.map((f, place) => f ? place : -1).filter(p => p >= 0);
  return side.active.map((p, place) => p && !p.fainted && !p.volatiles.commanding ? place : -1).filter(p => p >= 0);
}
const benchFree = (req, taken) => req.side.pokemon.map((p, n) => n).filter(n => !req.side.pokemon[n].active && !/fnt/.test(req.side.pokemon[n].condition) && !taken.includes(n + 1));
const switchedIn = pick => pick && /^switch \d+$/.test(pick) ? +pick.split(' ')[1] : 0;

// What the replay's Pokemon did here, as a pick ('move 2', 'move 2 1' with a target in doubles, 'switch 4', 'team 1') and
// its gimmick (null in a line).
function playedPick(pos, si, place, req) {
  if (pos.kind === 'line' || isFresh()) return null;
  const played = playedChoice(pos.t, si, place);
  if (!played) return null;
  const nth = name => req.side.pokemon.findIndex(p => nameOf(p.ident) === name) + 1;
  if (played.kind === 'lead') return nth(played.name) ? {pick: 'team ' + nth(played.name), gimmick: ''} : null;
  if (played.kind === 'switch') return nth(played.name) ? {pick: 'switch ' + nth(played.name), gimmick: ''} : null;
  const act = req.active?.[place];
  if (!act) return null;
  // (a Pokemon that could not move did not show its choice: any move follows the replay)
  const i = played.kind === 'cant' ? act.moves.findIndex(m => !m.disabled) : act.moves.findIndex((_, i) => moveNames(act, i + 1).includes(E.toID(played.name)));
  if (i < 0) return null;
  let gimmick = played.gimmick;
  if (gimmick === 'mega') gimmick = act.canMegaEvo ? 'mega' : act.canMegaEvoX ? 'megax' : act.canMegaEvoY ? 'megay' : 'mega';
  return {pick: withTarget(pos, si, place, act, i, gimmick || '', played.target), gimmick: gimmick || ''};
}
// 'move i', with its target in doubles: where the log says it went, else the first it could aim at.
function withTarget(pos, si, place, act, i, gimmick, ident) {
  if (!doublesBattle(pos)) return 'move ' + (i + 1);
  const type = E.targetType(act, i, gimmick);
  if (!E.needsTarget(type)) return 'move ' + (i + 1);
  const loc = E.targetLoc(type, ident, si, place) ?? E.targetsFor(type, pos.battle, si, place)[0];
  return `move ${i + 1} ${loc}`;
}
// The pick and gimmick a slot holds now: changed by you, else what was played. A Pokemon that must be replaced when there
// is no one left to send in passes.
function slot(pos, si, place, req) {
  const key = keyOf(si, place);
  if (req.forceSwitch && !S.sel[key]) {
    const others = placesOf(pos, si, req).filter(p => p !== place).map(p => switchedIn(S.sel[keyOf(si, p)]));
    if (!benchFree(req, others).length) return {pick: 'pass', gimmick: '', changed: false, def: {pick: 'pass', gimmick: ''}, fixed: true};
  }
  const def = playedPick(pos, si, place, req);
  const pick = S.sel[key] || def?.pick || null;
  const gimmick = S.gimmick[key] ?? def?.gimmick ?? '';
  const changed = !!def && (pick !== def.pick || gimmick !== def.gimmick) || !def && !!pick;
  return {pick, gimmick, changed, def};
}

// How a pick reads in its slot (move name and, in doubles, its target; or the Pokemon switched in), with its type colour.
function pickLabel(pos, si, place, req, pick, gimmick) {
  const [kind, n, target] = pick.split(' ');
  if (kind === 'pass') return {html: '&mdash;', type: ''};
  if (kind === 'move') {
    const act = req.active[place], m = act.moves[n - 1];
    const as = gimmick === 'zmove' ? act.canZMove?.[n - 1] : gimmick === 'dynamax' || (act.maxMoves && !act.canDynamax) ? act.maxMoves?.maxMoves?.[n - 1] : null;
    const shown = as && E.Dex.moves.get(as.move);
    const name = !as ? m.move : shown.exists ? shown.name : as.move;
    const type = (shown?.exists ? shown : E.Dex.moves.get(m.id || m.move)).type || 'Normal';
    const extra = gimmick && !['zmove', 'dynamax'].includes(gimmick) ? ` <small>+ ${GIMMICK_NAMES[gimmick]}</small>` : '';
    const aim = target ? ` <small>&rarr; ${esc(targetName(pos, si, +target))}</small>` : '';
    return {html: esc(name) + extra + aim, type};
  }
  const p = req.side.pokemon[n - 1];
  return {html: `<span class="rb-picon" style="${icon(p.details.split(',')[0])}"></span>${kind === 'switch' ? '&rarr; ' : ''}${esc(nameOf(p.ident))}`, type: ''};
}
// The Pokemon at a target place (1, 2: the foes'; -1, -2: your own).
function targetName(pos, si, loc) {
  const side = pos.battle.sides[loc > 0 ? 1 - si : si], p = side.active[Math.abs(loc) - 1];
  return p ? p.name : '?';
}

// ---------------------------------------------------------------- the bar
export function renderPicker(pos) {
  const el = $id('pickSec');
  showPickerSetting();
  el.hidden = !pickerOn();
  if (el.hidden) { setTooltipRequest(null); return; }
  const battle = pos.battle;
  const turnLabel = pos.kind === 'preview' ? 'Team preview' : battle ? `Turn ${battle.turn}` : pos.t > S.rep.lastTurn ? 'End' : pos.t ? `Turn ${pos.t}` : 'Start';
  const doubles = doublesBattle(pos) || (!battle && S.rep.lines.includes('|gametype|doubles'));
  let groups, playable = false;
  if (!battle || battle.ended) {
    // playing, at the end, or nothing to choose here: the same bar, quiet
    const why = battle?.ended ? 'The battle is over' : watchOnly() ? 'This format can only be watched' : pos.t > S.rep.lastTurn ? 'End of the replay' : '';
    const playing = isPlaying();
    groups = why ? [`<span class="rb-dim">${why}</span>`] : [0, 1].map(si => `<div class="rb-slotwrap"><span class="rb-who">${esc(playerName(si))}</span>` +
      (doubles ? [0, 1] : [0]).map(place => `<button type="button" class="rb-slot quiet" ${playing ? `data-slot="${si}" data-place="${place}"` : 'disabled'}>&hellip;</button>`).join('') + `</div>`);
  } else {
    const need = [0, 1].map(si => requestOf(pos, si));
    const turn = barTurn(pos);
    playable = !!turn;
    groups = [0, 1].map(si => {
      const req = need[si];
      const head = `<div class="rb-slotwrap"><span class="rb-who">${esc(playerName(si))}</span>`;
      if (!req) return head + `<button type="button" class="rb-slot quiet" disabled>waiting</button></div>`;
      return head + placesOf(pos, si, req).map(place => {
        const s = slot(pos, si, place, req), key = keyOf(si, place);
        const label = s.pick ? pickLabel(pos, si, place, req, s.pick, s.gimmick) : {html: 'Choose', type: ''};
        const who = doubles && !req.teamPreview ? `<span class="rb-place">${esc(nameOf(req.side.pokemon[place].ident))}</span>` : '';
        return `<button type="button" class="rb-slot ${label.type ? 't-' + esc(label.type) : 'plain'} ${s.changed ? 'changed' : ''} ${s.pick ? '' : 'empty'} ${S.menu === key ? 'open' : ''}" ` +
          `data-slot="${si}" data-place="${place}" aria-haspopup="true" aria-expanded="${S.menu === key}" ${s.fixed ? 'disabled' : ''}>${who}${label.html} <i class="fa fa-caret-down" aria-hidden="true"></i></button>`;
      }).join('') + `</div>`;
    });
  }
  el.innerHTML = `<div class="rb-bar ${doubles ? 'doubles' : ''}"><span class="rb-turn">${turnLabel}</span><div class="rb-slots">${groups.join('')}</div>` +
    `<button type="button" class="button rb-editbtn" id="btnEdit" ${canEdit(pos) ? '' : 'disabled'}><i class="fa fa-pencil" aria-hidden="true"></i> Edit</button>` +
    `<button type="button" class="button rb-play" id="btnPlayTurn" ${playable ? '' : 'disabled'}><i class="fa fa-play" aria-hidden="true"></i> Play turn</button></div>` +
    (S.err ? `<p class="rb-err">${esc(S.err)}</p>` : '') + menuHTML(pos);

  for (const b of el.querySelectorAll('[data-slot]')) b.onclick = e => { e.stopPropagation(); openMenu(pos, +b.dataset.slot, +(b.dataset.place || 0)); };
  $id('btnPlayTurn').onclick = () => { if (playable) playTurn(pos); };
  $id('btnEdit').onclick = () => { closeMenu(); openEditor(pos); };
  wireMenu(pos);
}

// A slot clicked while the replay plays: stop at the start of this turn, then open it.
function openMenu(pos, si, place) {
  const key = keyOf(si, place);
  S.aim = null;
  if (isPlaying()) {
    S.psb.pause();
    S.menu = key;
    go(S.cur, {force: true});
    return;
  }
  S.menu = S.menu === key ? null : key;
  renderPicker(pos);
}
export function closeMenu() {
  if (S.menu == null) return false;
  S.menu = null; S.aim = null; setTooltipRequest(null);
  return true;
}
const menuSlot = () => S.menu ? {si: +S.menu[1] - 1, place: 'abc'.indexOf(S.menu[2])} : null;

// ---------------------------------------------------------------- the move menu (Showdown's "What will X do?")
function menuHTML(pos) {
  const at = menuSlot();
  const req = at && pos.battle && !pos.battle.ended ? requestOf(pos, at.si) : null;
  if (!req || !placesOf(pos, at.si, req).includes(at.place)) { setTooltipRequest(null); return ''; }
  const {si, place} = at;
  setTooltipRequest(si, req, place);
  const s = slot(pos, si, place, req);
  const forced = !!req.forceSwitch;
  const active = nameOf((req.side.pokemon[place] || {ident: ''}).ident);
  const who = esc(playerName(si));
  const reviving = req.side.pokemon.some(p => p.reviving);
  const question = req.teamPreview ? `${who}: choose ${doublesBattle(pos) ? (place ? 'the second lead' : 'the first lead') : 'a lead'}` : reviving ? `${who}: choose a Pok&eacute;mon to revive`
    : S.aim ? `${who}: choose a target for ${esc(req.active[place].moves[S.aim.n - 1].move)}`
    : forced ? `${who}: switch in a Pok&eacute;mon` : `${who}: what will ${esc(active)} do?`;
  // (a trapping ability the player has not seen yet only makes the request say "maybe trapped"; we know the sets)
  const trapped = !forced && !req.teamPreview && !!(req.active?.[place]?.trapped || pos.battle.sides[si].active[place]?.trapped);
  const taken = placesOf(pos, si, req).filter(p => p !== place).map(p => slot(pos, si, p, req).pick);
  const body = req.teamPreview ? leadButtons(req, s, taken) : S.aim ? targetButtons(pos, si, place, req)
    : (forced ? '' : moveButtons(pos, si, place, req, active, s, taken)) + switchButtons(req, forced, s, trapped, taken);
  return `<div class="rb-menu" role="dialog" aria-label="${who}'s choice"><h3><span>${question}</span>` +
    `<button type="button" class="rb-linkbtn" id="btnCloseMenu" aria-label="Close">&times;</button></h3>${body}</div>`;
}

function wireMenu(pos) {
  const menu = $id('pickSec').querySelector('.rb-menu');
  if (!menu) return;
  const {si, place} = menuSlot(), key = S.menu;
  menu.onclick = e => e.stopPropagation();
  const done = () => { closeMenu(); renderPicker(pos); renderDice(pos); };
  $id('btnCloseMenu').onclick = () => { closeMenu(); renderPicker(pos); };
  for (const b of menu.querySelectorAll('[data-pick]')) b.onclick = () => {
    const pick = b.dataset.pick, [kind, n] = pick.split(' ');
    S.err = '';
    // in doubles a move that takes a target asks for it next
    if (kind === 'move' && doublesBattle(pos)) {
      const act = requestOf(pos, si).active[place];
      const type = E.targetType(act, n - 1, S.gimmick[key] ?? slot(pos, si, place, requestOf(pos, si)).gimmick);
      const targets = E.targetsFor(type, pos.battle, si, place);
      if (E.needsTarget(type) && targets.length > 1) { S.aim = {n: +n}; renderPicker(pos); return; }
      S.sel[key] = E.needsTarget(type) ? `${pick} ${targets[0]}` : pick;
    } else S.sel[key] = pick;
    done();
  };
  for (const b of menu.querySelectorAll('[data-target]')) b.onclick = () => { S.sel[key] = `move ${S.aim.n} ${b.dataset.target}`; done(); };
  const back = $id('btnAimBack');
  if (back) back.onclick = () => { S.aim = null; renderPicker(pos); };
  for (const box of menu.querySelectorAll('[data-gimmick]')) box.onchange = () => {
    S.gimmick[key] = box.checked ? box.dataset.gimmick : '';
    // (a target chosen for the plain move may not suit its Max Move or Z-Move)
    const sel = S.sel[key] || slot(pos, si, place, requestOf(pos, si)).pick;
    if (sel && sel.startsWith('move') && doublesBattle(pos)) {
      const act = requestOf(pos, si).active[place], n = +sel.split(' ')[1];
      S.sel[key] = withTarget(pos, si, place, act, n - 1, S.gimmick[key], null);
    }
    renderPicker(pos); renderDice(pos);   // (Z-Power and Dynamax rename the moves)
  };
  for (const b of menu.querySelectorAll('[data-edit]')) b.onclick = () => editGuessedMove(pos, si, place, b);
}

const pickedHere = (s, pick) => s.pick === pick || (s.pick || '').startsWith(pick + ' ') ? 'chosen' : '';
const playedHere = (s, pick) => s.def?.pick === pick || (s.def?.pick || '').startsWith(pick + ' ') ? 'played' : '';

function leadButtons(req, s, taken) {
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    const pick = 'team ' + (n + 1), was = playedHere(s, pick);
    return `<button type="button" class="button rb-sw has-tooltip ${was} ${pickedHere(s, pick)}" data-pick="${pick}" data-tooltip="switchpokemon|${n}" ` +
      `${was ? 'data-note="Lead in the replay"' : ''} ${taken.includes(pick) ? 'disabled' : ''}><span class="rb-picon" style="${icon(p.details.split(',')[0])}"></span>${esc(nameOf(p.ident))}</button>`;
  }).join('')}</div>`;
}

// The once-per-battle mechanics this Pokemon can use with its move this turn, in Showdown's words (only one Pokemon of a
// side can use each in a turn).
function gimmicks(act, othersUse) {
  return [
    act.canMegaEvo && ['mega', 'Mega Evolution'], act.canMegaEvoX && ['megax', 'Mega Evolution X'], act.canMegaEvoY && ['megay', 'Mega Evolution Y'],
    act.canUltraBurst && ['ultra', 'Ultra Burst'], act.canZMove && ['zmove', 'Z-Power'], act.canDynamax && ['dynamax', 'Dynamax'],
    act.canTerastallize && ['terastallize', 'Terastallize'],
  ].filter(g => g && !othersUse.includes(family(g[0])));
}

function moveButtons(pos, si, place, req, active, s, taken) {
  const act = req.active[place];
  // with Z-Power ticked the buttons are the Z-Moves; Dynamaxing (or Dynamaxed) the Max Moves
  const mode = s.gimmick === 'zmove' ? 'zmove' : s.gimmick === 'dynamax' || (act.maxMoves && !act.canDynamax) ? 'maxmove' : '';
  const k = teamIndex(si, active);
  const known = k >= 0 ? S.base[si][k].fixed.moves.map(E.toID) : [];
  const pasted = k >= 0 && (pos.kind === 'line' ? lineSets(S.cur) : S.study.sets)[si][k].pasted;
  // the calc numbers are for the regular moves; in doubles, against each foe
  const foes = pos.battle.sides[1 - si].active.map((p, f) => p && !p.fainted ? f : -1).filter(f => f >= 0);
  const calcs = mode ? [] : doublesBattle(pos) ? foes.map(f => E.damageCalcs(pos.battle, si, place, f)) : [E.damageCalcs(pos.battle, si)];
  const transformed = pos.battle.sides[si].active[place]?.transformed;
  const moves = act.moves.map((m, i) => {
    const pick = 'move ' + (i + 1);
    const as = mode === 'zmove' ? act.canZMove[i] : mode === 'maxmove' ? act.maxMoves.maxMoves[i] : null;
    const shown = as && E.Dex.moves.get(as.move);   // (a status Z-Move, "Z-Roost", is not a move of its own)
    const name = !as ? m.move : shown.exists ? shown.name : as.move;
    const type = (shown?.exists ? shown : E.Dex.moves.get(m.id || m.move)).type || 'Normal';
    const was = playedHere(s, pick);
    // (a Pokemon that transformed has the other's moves: nothing about them is a guess)
    const guessed = k >= 0 && !pasted && !transformed && !known.includes(E.toID(m.move)) && !['struggle', 'recharge'].includes(E.toID(m.move));
    const note = guessed ? 'Guessed' : was ? 'Used in the replay' : '';
    const disabled = m.disabled || m.pp === 0 || (mode === 'zmove' && !as);
    // (in doubles each range is led by its foe's icon)
    const ranges = calcs.map((c, j) => c[i] && {...c[i], foe: doublesBattle(pos) ? pos.battle.sides[1 - si].active[foes[j]] : null}).filter(Boolean);
    const desc = ranges.map(c => c.desc).filter(Boolean).join('\n');
    return `<div class="rb-mvwrap"><button type="button" class="rb-mv has-tooltip t-${esc(type)} ${was} ${pickedHere(s, pick)} ${guessed ? 'guess' : ''}" data-pick="${pick}" ` +
      `data-tooltip="move|${i}|${mode}" ${note ? `data-note="${note}"` : ''} ${desc ? `data-calc="${esc(desc)}"` : ''} ${disabled ? 'disabled' : ''}>` +
      `<b>${esc(name)}</b><small><span>${esc(type)}</span>${ranges.map(c => `<span class="rb-dmg">${c.foe ? `<span class="rb-picon mini" style="${icon(c.foe.species.name)}"></span>` : ''}${esc(c.range)}</span>`).join('')}` +
      `<span>${m.maxpp ? `${m.pp}/${m.maxpp}` : ''}</span></small></button>` +
      (guessed ? `<button type="button" class="rb-edit" data-edit="${esc(m.move)}" title="Change this guessed move" aria-label="Change ${esc(m.move)}"><i class="fa fa-pencil" aria-hidden="true"></i></button>` : '') + `</div>`;
  });
  const othersUse = placesOf(pos, si, req).filter(p => p !== place).map(p => family(S.gimmick[keyOf(si, p)] ?? slot(pos, si, p, req).gimmick)).filter(Boolean);
  const boxes = gimmicks(act, othersUse).map(([value, label]) => `<label><input type="checkbox" data-gimmick="${value}" ${s.gimmick === value ? 'checked' : ''}> ${label}</label>` +
    (value === 'terastallize' ? ' ' + typeTag(act.canTerastallize) : '')).join(' ');
  return `<div class="rb-moves">${moves.join('')}</div>${boxes ? `<p class="rb-row" style="margin-top:6px">${boxes}</p>` : ''}`;
}

// Doubles: who the move goes at, laid out as on the field (the foes across, your side below).
function targetButtons(pos, si, place, req) {
  const act = req.active[place], n = S.aim.n;
  const type = E.targetType(act, n - 1, S.gimmick[keyOf(si, place)] ?? '');
  const ok = E.targetsFor(type, pos.battle, si, place);
  const button = loc => {
    const side = pos.battle.sides[loc > 0 ? 1 - si : si], p = side.active[Math.abs(loc) - 1];
    if (!p) return '';
    return `<button type="button" class="button rb-sw" data-target="${loc}" ${ok.includes(loc) ? '' : 'disabled'}>` +
      `<span class="rb-picon" style="${icon(p.species.name)}"></span>${esc(p.name)} <small>${p.fainted ? 0 : Math.round(p.hp / p.maxhp * 100)}%</small></button>`;
  };
  return `<div class="rb-switches">${button(2)}${button(1)}</div><div class="rb-switches">${button(-1)}${button(-2)}</div>` +
    `<p class="rb-row" style="margin-top:6px"><button type="button" class="rb-linkbtn" id="btnAimBack">&larr; Back</button></p>`;
}

// (after Revival Blessing the choice is which fainted Pokemon comes back; in doubles one the other place sends in is taken)
function switchButtons(req, forced, s, trapped, taken) {
  const reviving = req.side.pokemon.some(p => p.reviving);
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    if (p.active && !forced) return '';
    const pick = 'switch ' + (n + 1), was = playedHere(s, pick);
    const fainted = /fnt/.test(p.condition);
    const unavailable = reviving ? !fainted : fainted || p.active || trapped || taken.includes(pick);
    const [hp, max] = p.condition.split(' ')[0].split('/');
    return `<button type="button" class="button rb-sw has-tooltip ${was} ${pickedHere(s, pick)}" data-pick="${pick}" data-tooltip="switchpokemon|${n}" ` +
      `${was ? 'data-note="Used in the replay"' : ''} ${unavailable ? 'disabled' : ''}>` +
      `<span class="rb-picon" style="${icon(p.details.split(',')[0])}"></span>${esc(nameOf(p.ident))} <small>${fainted ? 0 : Math.round(hp / max * 100)}%</small></button>`;
  }).join('')}</div>`;
}

// Turn a guessed move's button into a text box; the new move goes into the sets (and into this line, replayed).
function editGuessedMove(pos, si, place, button) {
  const req = requestOf(pos, si);
  const active = nameOf((req.side.pokemon[place] || {ident: ''}).ident);
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
// A side's choice from its slots: 'move 1 2 terastallize, switch 4' ('team 25' at team preview: the leads; a format
// that brings 4 brings the leads, then the others the replay showed, then the rest).
function sideChoice(pos, si, req, picks) {
  if (req.teamPreview) {
    const leads = picks.map(p => +p.pick.split(' ')[1]);
    if (!doublesBattle(pos)) return picks[0].pick;
    const team = S.cbEnd[pid(si)].team, all = req.side.pokemon.map((_, n) => n + 1).filter(n => !leads.includes(n));
    const seen = n => { const k = teamIndex(si, nameOf(req.side.pokemon[n - 1].ident)); return k >= 0 && team[k].maxhp > 0; };
    return 'team ' + leads.concat(all.filter(seen), all.filter(n => !seen(n))).join(all.length + leads.length >= 10 ? ',' : '');
  }
  return picks.map(p => p.pick.startsWith('move') && p.gimmick ? p.pick + ' ' + p.gimmick : p.pick).join(', ');
}

// The turn as the bar shows it, once every choice is in: {choices, parent, sets, replay (nothing differs from the
// replay's own turn)}, else null.
export function barTurn(pos) {
  const battle = pos.battle;
  if (!battle || battle.ended || watchOnly()) return null;
  const need = [0, 1].map(si => requestOf(pos, si));
  if (!need.some(Boolean)) return null;
  const choices = {}, onReplay = pos.kind === 'turn' || pos.kind === 'preview';
  let replay = onReplay;
  for (const [si, req] of need.entries()) {
    if (!req) continue;
    const places = placesOf(pos, si, req);
    const picks = places.map(place => slot(pos, si, place, req));
    if (picks.some(s => !s.pick)) return null;
    if (picks.length) choices[pid(si)] = sideChoice(pos, si, req, picks);
    // (a choice you changed makes it your line, even where the replay's was unknown, like a Pokemon that fainted first)
    replay &&= picks.every(s => s.fixed || (!s.changed && matchesPlayed(battle.sides[si], s.pick, s.gimmick, playedChoice(pos.t, si, places[picks.indexOf(s)]), places[picks.indexOf(s)], s.def)));
  }
  return {choices, replay, parent: onReplay ? 'r' + pos.t : S.cur, sets: onReplay ? S.study.sets : undefined};
}

// Play the turn as the bar shows it: the replay's own turn if nothing differs from it (choices or dice), else a line
// (with the dice as set before playing).
export function playTurn(pos) {
  const turn = barTurn(pos);
  if (!turn) return;
  const reset = () => { clearPicks(); S.err = ''; };
  const dice = upcomingDice(pos);
  if (turn.replay && (!dice || JSON.stringify(dice.forced) === JSON.stringify(dice.real))) {
    reset();
    S.stopAt = pos.t + 1;
    if (pos.t === 0) S.psb.reset(); else S.psb.seekTurn(pos.t);
    S.psb.play();
    renderPanels();
    return;
  }
  const {choices, parent, sets} = turn;
  const forced = dice ? dice.forced : [], seed = dice?.seed;
  let id = sameStep(parent, choices, forced, seed);
  if (!id) {
    id = addNode(parent, choices, forced, seed, sets);
    try { compute(id); } catch (e) { deleteNode(id); save(); S.err = e.message || String(e); renderPicker(pos); return; }
  }
  reset();
  go(id, {animate: true});
}
