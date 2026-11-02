// The position editor: change a position as on a board editor (each Pokemon's HP, status, and for those on the field their
// stat stages and held item; the weather, terrain and Trick Room; each side's hazards and screens), then play on from it.
// An edit holds only what changes:
//   {mons: [{s: side 0/1, k: index in the side's Pokemon, hp?: percent 0-100, status?: '' | 'brn'..., boosts?: {atk: -6..6...},
//     item?: '' | item id}], field: {weather?: '' | id, terrain?: '' | id, trickroom?: 0/1}, sides: [{stealthrock?: 0/1, spikes?: 0-3...}, {...}]}
// editPosition plays it on a saved battle with the simulator's own functions where it has them, and returns the battle and
// the protocol lines that show the change in Showdown's viewer (silent: the log says nothing, the field and statbars change).
import {restore, omniscient, gen1Stats, refreshLocks} from './core.mjs';

export const EDIT_STATUSES = ['brn', 'par', 'psn', 'tox', 'slp', 'frz'];
export const EDIT_BOOSTS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
// [name, first gen, last gen]
export const EDIT_WEATHERS = {raindance: ['Rain', 2], sunnyday: ['Sun', 2], sandstorm: ['Sandstorm', 2], hail: ['Hail', 3, 8], snowscape: ['Snow', 9]};
// (set by abilities only: shown while they hold, and can be cleared)
const STRONG_WEATHERS = {desolateland: 'Harsh sunshine', primordialsea: 'Heavy rain', deltastream: 'Strong winds'};
export const EDIT_TERRAINS = {electricterrain: ['Electric Terrain', 6], grassyterrain: ['Grassy Terrain', 6], mistyterrain: ['Misty Terrain', 6], psychicterrain: ['Psychic Terrain', 7]};
// [name, first gen, most layers]
export const EDIT_SIDE = {stealthrock: ['Stealth Rock', 4, 1], spikes: ['Spikes', 2, 3], toxicspikes: ['Toxic Spikes', 4, 2], stickyweb: ['Sticky Web', 6, 1],
  reflect: ['Reflect', 2, 1], lightscreen: ['Light Screen', 2, 1], auroraveil: ['Aurora Veil', 7, 1], tailwind: ['Tailwind', 4, 1]};
const inGen = ([, from, to = 99], gen) => gen >= from && gen <= to;
const layersMax = (id, gen) => id === 'spikes' && gen <= 2 ? 1 : EDIT_SIDE[id][2];

// What can be edited in a generation.
export function editOptions(gen) {
  return {
    statuses: EDIT_STATUSES,
    boosts: gen === 1 ? EDIT_BOOSTS.filter(b => b !== 'spd') : EDIT_BOOSTS,   // (gen 1: one Special stat, kept in spa)
    weathers: Object.entries(EDIT_WEATHERS).filter(([, w]) => inGen(w, gen)).map(([id, w]) => [id, w[0]]),
    terrains: Object.entries(EDIT_TERRAINS).filter(([, w]) => inGen(w, gen)).map(([id, w]) => [id, w[0]]),
    trickRoom: gen >= 4,
    side: Object.entries(EDIT_SIDE).filter(([, c]) => gen >= c[1]).map(([id, c]) => [id, c[0], layersMax(id, gen)]),
    items: gen >= 2,
  };
}
export const weatherName = id => EDIT_WEATHERS[id]?.[0] || STRONG_WEATHERS[id] || id;

// HP as Showdown shows it: a percent rounded up, under 100 until it is full.
const percent = p => p.fainted || !p.hp ? 0 : p.hp >= p.maxhp ? 100 : Math.min(99, Math.ceil(p.hp / p.maxhp * 100));
const onField = (side, p) => side.active.includes(p) && !p.fainted;

// The position as the editor shows it.
export function editState(battle) {
  const f = battle.field;
  return {
    gen: battle.gen, turn: battle.turn,
    field: {weather: f.weather || '', terrain: f.terrain || '', trickroom: f.pseudoWeather.trickroom ? 1 : 0},
    sides: battle.sides.map(side => ({
      name: side.name,
      conds: Object.fromEntries(Object.keys(EDIT_SIDE).map(id => {
        const st = side.sideConditions[id];
        return [id, st ? st.layers || 1 : 0];
      })),
      mons: side.pokemon.map((p, k) => ({
        k, name: p.name, species: p.species.name, active: onField(side, p), fainted: !!p.fainted || !p.hp, hp: percent(p),
        status: p.fainted || p.status === 'fnt' ? '' : p.status || '', boosts: {...p.boosts}, item: p.item || '', itemName: p.item ? battle.dex.items.get(p.item).name : '',
      })),
    })),
  };
}

// Apply an edit to a saved battle: {battle, lines}.
export function editPosition(json, edit) {
  const battle = restore(json);
  const start = battle.log.length;
  const gen = battle.gen;
  // the lines the edit itself writes say nothing in the log (what the field does about them, like Protosynthesis, does)
  const quiet = from => {
    for (let i = from; i < battle.log.length; i++) {
      if (/^\|(-status|-curestatus|-weather|-fieldstart|-fieldend|-sidestart|-sideend|-item|-enditem)\|/.test(battle.log[i]) && !/\|\[silent\]/.test(battle.log[i])) battle.log[i] += '|[silent]';
    }
  };
  // a Pokemon to start effects from (the simulator wants one): this side's on the field first
  const anyone = si => [battle.sides[si], battle.sides[1 - si]].flatMap(s => s.active).find(p => p && !p.fainted) || battle.sides[si].pokemon.find(p => p.hp) || battle.sides[si].pokemon[0];
  const fainting = [];

  for (const m of edit.mons || []) {
    const side = battle.sides[m.s], sp = side?.pokemon[m.k];
    if (!sp) continue;
    const active = side.active.includes(sp);
    if (sp.fainted || !sp.hp) {
      // brought back (one on the bench; one fainted on the field is waiting to be replaced)
      if (active || !(m.hp > 0)) continue;
      sp.fainted = false; sp.faintQueued = false; sp.status = ''; sp.statusState = battle.initEffectState({id: '', target: sp});
      sp.hp = hpOf(sp, m.hp);
      side.pokemonLeft++;
      battle.add('-heal', sp, sp.getHealth, '[from] move: Revival Blessing', '[silent]');
    }
    if (m.hp === 0) { fainting.push(sp); continue; }
    if (m.status !== undefined && m.status !== sp.status && (m.status === '' || EDIT_STATUSES.includes(m.status))) setStatus(battle, sp, m.status, active, quiet);
    if (m.hp !== undefined && hpOf(sp, m.hp) !== sp.hp) {
      sp.hp = hpOf(sp, m.hp);
      battle.add('-sethp', sp, sp.getHealth, '[silent]');
    }
    if (active && m.boosts) {
      for (const stat of EDIT_BOOSTS) {
        const v = m.boosts[stat];
        if (!Number.isInteger(v) || (gen === 1 && stat === 'spd')) continue;
        const to = Math.max(-6, Math.min(6, v));
        if (to === sp.boosts[stat]) continue;
        sp.setBoost({[stat]: to, ...(gen === 1 && stat === 'spa' ? {spd: to} : {})});
        battle.add('-setboost', sp, gen === 1 && stat === 'spa' ? 'spc' : stat, to, '[silent]');   // (the viewer keeps gen 1's Special as spc)
      }
    }
    if (active && m.item !== undefined && gen >= 2 && m.item !== sp.item) {
      const item = m.item ? battle.dex.items.get(m.item) : null;
      if (!m.item || item.exists) {
        const old = sp.item ? battle.dex.items.get(sp.item).name : '';
        const from = battle.log.length;
        sp.setItem(m.item || '');
        if (sp.item === (m.item || '')) {
          if (item) battle.add('-item', sp, item.name, '[silent]'); else if (old) battle.add('-enditem', sp, old, '[silent]');
        }
        quiet(from);
      }
    }
    if (gen === 1 && active) gen1Stats(sp);
  }
  for (const sp of fainting) faint(battle, sp);

  // the field
  const field = edit.field || {};
  const from = battle.log.length;
  if (field.weather !== undefined && field.weather !== battle.field.weather && (field.weather === '' || EDIT_WEATHERS[field.weather] && inGen(EDIT_WEATHERS[field.weather], gen))) {
    battle.field.clearWeather();
    if (field.weather && !battle.field.setWeather(field.weather, anyone(0))) {
      // (refused: set it as it is)
      battle.field.weather = field.weather; battle.field.weatherState = battle.initEffectState({id: field.weather, duration: 5});
      battle.add('-weather', battle.dex.conditions.get(field.weather).name);
    }
  }
  if (field.terrain !== undefined && field.terrain !== battle.field.terrain && (field.terrain === '' || EDIT_TERRAINS[field.terrain] && inGen(EDIT_TERRAINS[field.terrain], gen))) {
    battle.field.clearTerrain();
    if (field.terrain && !battle.field.setTerrain(field.terrain, anyone(0))) {
      battle.field.terrain = field.terrain; battle.field.terrainState = battle.initEffectState({id: field.terrain, duration: 5});
      battle.add('-fieldstart', battle.dex.conditions.get(field.terrain).name);
    }
  }
  if (field.trickroom !== undefined && gen >= 4 && !!field.trickroom !== !!battle.field.pseudoWeather.trickroom) {
    if (field.trickroom) battle.field.addPseudoWeather('trickroom', anyone(0));
    else battle.field.removePseudoWeather('trickroom');
  }
  // each side's hazards and screens (a layer at a time, as the moves lay them)
  (edit.sides || []).forEach((conds, si) => {
    const side = battle.sides[si];
    if (!side || !conds) return;
    for (const [id, c] of Object.entries(EDIT_SIDE)) {
      if (!Number.isInteger(conds[id]) || gen < c[1]) continue;
      const want = Math.max(0, Math.min(layersMax(id, gen), conds[id]));
      const st = side.sideConditions[id], now = st ? st.layers || 1 : 0;
      if (want === now) continue;
      if (want < now) {
        // (hazards end without a word in the simulator: only Rapid Spin and Defog name them)
        const before = battle.log.length;
        side.removeSideCondition(id);
        if (battle.log.length === before) battle.add('-sideend', side, id === 'stealthrock' ? 'move: Stealth Rock' : c[0]);
      }
      for (let n = want < now ? 0 : now; n < want; n++) side.addSideCondition(id, anyone(si));
    }
  });
  quiet(from);

  // what is asked next: the same choices (with what changed in them), or a replacement for a Pokemon that fainted
  if (!battle.ended) {
    battle.checkFainted();
    const replace = battle.sides.some(s => s.active.some(p => p && p.switchFlag));
    if (replace && battle.requestState !== 'switch') battle.midTurn = true;   // (the turn's end has passed: the replacement does not bring another)
    if (!replace && battle.requestState === 'move') refreshLocks(battle);   // (a new item can lock moves or free a trapped one)
    battle.makeRequest(replace ? 'switch' : battle.requestState || 'move');
  }
  return {battle, lines: omniscient(battle.log.slice(start)).filter(l => !l.startsWith('|t:|'))};
}

// The HP a percent stands for: the middle of the HP that show as it (as taking over a replay reads its percents).
function hpOf(sp, pct) {
  const M = sp.maxhp;
  if (pct >= 100) return M;
  const lo = Math.floor((pct - 1) * M / 100) + 1, hi = Math.min(Math.floor(pct * M / 100), M - 1);
  return Math.max(1, Math.min(M - 1, Math.round((lo + Math.max(lo, hi)) / 2)));
}

// Status: on the field through the simulator (its own message, and what reacts to it); on the bench set as it is.
function setStatus(battle, sp, status, active, quiet) {
  const from = battle.log.length;
  if (sp.status) {
    if (active) sp.cureStatus(true);
    else battle.add('-curestatus', sp, sp.status, '[silent]');
    sp.status = ''; sp.statusState = battle.initEffectState({id: '', target: sp});
  }
  if (status && !(active && sp.setStatus(status, sp, null, true) && sp.status === status)) {
    sp.status = status; sp.statusState = battle.initEffectState({id: status, target: sp});
    battle.add('-status', sp, status, '[silent]');
  }
  // sleep: the middle of its turns (gens 1-2: 1-7, later 1-3); bad poison from its first turn
  if (status === 'slp') sp.statusState.time = sp.statusState.startTime = battle.gen <= 2 ? 4 : 3;
  if (status === 'tox') sp.statusState.stage = 0;
  quiet(from);
}

// Fainting: one on the field faints as in battle (its message, the faint events, a win); one on the bench just is.
function faint(battle, sp) {
  const side = sp.side;
  if (side.active.includes(sp)) {
    sp.faint();
    battle.resolveFaints ? battle.resolveFaints() : battle.faintMessages();
    return;
  }
  sp.hp = 0; sp.fainted = true; sp.status = 'fnt'; sp.statusState = battle.initEffectState({id: 'fnt', target: sp});
  if (side.pokemonLeft) side.pokemonLeft--;
  if (side.totalFainted < 100) side.totalFainted++;
  // (the viewer's |faint| empties a place on the field: on the bench its HP goes to 0 instead)
  battle.add('-sethp', sp, '0 fnt', '[silent]');
  if (!side.pokemonLeft) battle.checkWin();
}

// A few words for the move list: {field: [...], p1: [...], p2: [...]} (battle: the position the edit starts from).
export function editSummary(battle, edit) {
  const out = {field: [], p1: [], p2: []};
  const STAT = {atk: 'Atk', def: 'Def', spa: battle.gen === 1 ? 'Spc' : 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva'};
  for (const m of edit.mons || []) {
    const sp = battle.sides[m.s]?.pokemon[m.k];
    if (!sp) continue;
    const bits = [];
    if (m.hp !== undefined) bits.push(m.hp ? m.hp + '%' : 'fainted');
    if (m.status !== undefined && m.hp !== 0) bits.push(m.status ? m.status.toUpperCase() : 'cured');
    for (const [stat, v] of Object.entries(m.boosts || {})) if (v !== sp.boosts[stat]) bits.push(`${v > 0 ? '+' : ''}${v} ${STAT[stat]}`);
    if (m.item !== undefined) bits.push(m.item ? '@ ' + battle.dex.items.get(m.item).name : 'no item');
    if (bits.length) out['p' + (m.s + 1)].push(`${sp.name} ${bits.join(' ')}`);
  }
  const f = edit.field || {};
  if (f.weather !== undefined) out.field.push(f.weather ? weatherName(f.weather) : 'No weather');
  if (f.terrain !== undefined) out.field.push(f.terrain ? EDIT_TERRAINS[f.terrain]?.[0] || f.terrain : 'No terrain');
  if (f.trickroom !== undefined) out.field.push(f.trickroom ? 'Trick Room' : 'No Trick Room');
  (edit.sides || []).forEach((conds, si) => {
    for (const [id, n] of Object.entries(conds || {})) {
      const name = EDIT_SIDE[id]?.[0];
      if (name) out['p' + (si + 1)].push(n ? name + (EDIT_SIDE[id][2] > 1 ? ' ×' + n : '') : 'No ' + name);
    }
  });
  return out;
}
