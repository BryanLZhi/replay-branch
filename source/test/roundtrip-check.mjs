// Round trip of take-over: random battles between fully known teams (built the way Showdown's ExhaustiveRunner builds them,
// cycling through every Pokemon, move, ability and item of the gen) are written out as a replay shows them; at the start of
// every turn the position taken over from that replay (with the true sets) is compared with the true battle's.
// Then the turn is played on from both, with the true dice and the true values of what a replay cannot show, and the logs
// compared: a difference there is hidden state the comparison does not look at.
// Differences are sorted into: real (take-over gets it wrong), unknowable from a replay (exact HP within the shown percent,
// random lengths, Pokemon never shown...) and harmless (state nothing in this battle reads). Each cause shows how many times
// it began, how many turn starts it showed in, the gens it showed in (d = doubles) and an example.
//   node source/test/roundtrip-check.mjs [battles per format] [seed] [format ...]
//   env: MAXTURNS (default 60), SHOW / SHOW_PLAY (examples per cause, default 1), SHOW_UNK=1 (examples of unknowables too),
//        ALL=1 (print every difference), FOCUS=<seed>:<turn> (print that turn played on), DUMP=dir (write the battles with
//        differences: log, sets and the true state at each turn)
import fs from 'fs';
import path from 'path';
import {Battle, Dex, PRNG, toID} from '@pkmn/sim';
import * as E from '../engine/browser.mjs';

const perFormat = +(process.argv[2] || 3);
const seed0 = +(process.argv[3] || 1);
const FORMATS = process.argv.length > 4 ? process.argv.slice(4) : ['gen1customgame', 'gen2customgame', 'gen3customgame', 'gen4customgame',
  'gen5customgame', 'gen6customgame', 'gen7customgame', 'gen8customgame', 'gen9customgame', 'gen9ou', 'gen9doublescustomgame', 'gen8doublescustomgame'];
const MAXTURNS = +(process.env.MAXTURNS || 60);
const SHOW = +(process.env.SHOW || 1), SHOW_PLAY = +(process.env.SHOW_PLAY || SHOW);
const prng = new PRNG([seed0, 7, 11, 13]);
const pick = list => list[prng.random(list.length)];

// ---------------------------------------------------------------- teams (as ExhaustiveRunner makes them)
// A pool hands out its entries in a shuffled cycle, so that every entry comes up before any comes up again.
class Pool {
  constructor(list) { this.list = list; this.q = []; this.used = new Set(); }
  next() {
    if (!this.q.length) { this.q = this.list.slice(); for (let i = this.q.length - 1; i > 0; i--) { const j = prng.random(i + 1); [this.q[i], this.q[j]] = [this.q[j], this.q[i]]; } }
    return this.q.pop();
  }
}
const valid = (gen, data, get, extra) => Object.keys(data).filter(k => { const v = get(k); return v.exists !== false && v.gen <= gen && !v.isNonstandard && (!extra || extra(k, v)); });
function poolsFor(dex) {
  const gen = dex.gen;
  const species = valid(gen, dex.data.Pokedex, s => dex.species.get(s), (_, s) => !s.battleOnly && !s.requiredMove && !s.requiredAbility &&
    s.name !== 'Pichu-Spiky-eared' && !s.name.startsWith('Pikachu-') && !['Greninja-Bond', 'Rockruff-Dusk', 'Zoroark', 'Zorua', 'Zoroark-Hisui', 'Zorua-Hisui'].includes(s.name));
  // (Illusion is left out: a Pokemon disguised as another is what a replay cannot tell apart, by design)
  const abilities = gen >= 3 ? valid(gen, dex.data.Abilities, a => dex.abilities.get(a), a => !['illusion', 'noability'].includes(a)) : [];
  const items = gen >= 2 ? valid(gen, dex.data.Items, i => dex.items.get(i)) : [];
  const moves = valid(gen, dex.data.Moves, m => dex.moves.get(m), m => !['struggle', 'revivalblessing'].includes(m) && (m === 'hiddenpower' || !m.startsWith('hiddenpower')) &&
    !dex.moves.get(m).isZ && !dex.moves.get(m).isMax);
  const signatures = new Map();   // Pokemon -> [{item, move}] (Mega Stones, Z-Crystals of their own...)
  for (const id of items) {
    const it = dex.items.get(id);
    const users = it.megaStone ? Object.keys(it.megaStone).map(toID) : (it.itemUser || []).map(toID);
    for (const u of users) { if (!signatures.has(u)) signatures.set(u, []); signatures.get(u).push({item: id, move: it.zMoveFrom ? toID(it.zMoveFrom) : ''}); }
  }
  return {species: new Pool(species), abilities: new Pool(abilities), items: new Pool(items), moves: new Pool(moves), signatures, sizes: {species: species.length, abilities: abilities.length, items: items.length, moves: moves.length}};
}
function makeTeam(dex, pools) {
  const team = [], bases = new Set();
  const natures = Object.keys(dex.data.Natures);
  while (team.length < 6) {
    const sp = dex.species.get(pools.species.next());
    if (bases.has(sp.baseSpecies)) continue;
    bases.add(sp.baseSpecies);
    let item = dex.gen >= 2 ? pools.items.next() : '';
    const moves = [];
    const combos = pools.signatures.get(sp.id);
    if (combos && prng.random(2)) { const c = pick(combos); item = c.item; if (c.move) moves.push(c.move); }
    if (sp.requiredItem) item = toID(sp.requiredItem); else if (sp.requiredItems) item = toID(pick(sp.requiredItems));
    while (moves.length < 4) { const m = pools.moves.next(); if (!moves.includes(m)) moves.push(m); }
    const r = n => () => prng.random(n);
    const ev = r(253), iv = r(32);
    // (a forme its item makes, Arceus-Fire or Silvally-Water, needs its own ability for that: Multitype, RKS System)
    const ability = dex.gen < 3 ? 'No Ability' : sp.requiredItem || sp.requiredItems ? sp.abilities[0] : pools.abilities.next();
    team.push({name: sp.baseSpecies, species: sp.name, item, ability, moves,
      evs: {hp: ev(), atk: ev(), def: ev(), spa: ev(), spd: ev(), spe: ev()}, ivs: {hp: iv(), atk: iv(), def: iv(), spa: iv(), spd: iv(), spe: iv()},
      nature: pick(natures), level: 50 + prng.random(51), gender: sp.gender || (prng.random(2) ? 'M' : 'F'),
      teraType: dex.gen >= 9 ? pick(dex.types.all().filter(t => !t.isNonstandard).map(t => t.name)) : undefined});
  }
  return team;
}

// ---------------------------------------------------------------- random choices (from what each request offers)
const usedMoves = new Set();
function randomChoice(battle, si) {
  const side = battle.sides[si], req = side.activeRequest;
  if (!req || req.wait) return null;
  if (req.teamPreview) {
    const n = req.side.pokemon.map((_, k) => k + 1);
    for (let i = n.length - 1; i > 0; i--) { const j = prng.random(i + 1); [n[i], n[j]] = [n[j], n[i]]; }
    return {str: 'team ' + n.join(''), named: 'team ' + n.join('')};
  }
  const taken = new Set(), parts = [], named = [];
  const bench = () => req.side.pokemon.map((x, n) => n).filter(n => !req.side.pokemon[n].active && !/fnt/.test(req.side.pokemon[n].condition) && !taken.has(n));
  const nameAt = n => req.side.pokemon[n].ident.replace(/^p\d: /, '');
  const sw = n => { taken.add(n); parts.push('switch ' + (n + 1)); named.push('switch @' + nameAt(n)); };
  if (req.forceSwitch) {
    req.forceSwitch.forEach(f => {
      if (!f) { if (battle.gameType !== 'singles') { parts.push('pass'); named.push('pass'); } return; }
      const b = bench();
      if (!b.length) { parts.push('pass'); named.push('pass'); return; }
      sw(pick(b));
    });
  } else {
    let gimmickUsed = false;
    req.active.forEach((act, place) => {
      const mon = side.active[place];
      if (!mon || mon.fainted || act.commanding) { parts.push('pass'); named.push('pass'); return; }
      const moves = act.moves.map((m, i) => i).filter(i => !act.moves[i].disabled && act.moves[i].pp !== 0);
      const b = act.trapped || act.maybeTrapped ? [] : bench();
      if (b.length && (!moves.length || prng.random(6) === 0)) { sw(pick(b)); return; }
      // a move not used yet when there is one (as ExhaustiveRunner's AI does)
      const fresh = moves.filter(i => !usedMoves.has(act.moves[i].id));
      const i = fresh.length && prng.random(3) ? pick(fresh) : moves.length ? pick(moves) : 0;
      if (act.moves[i]) usedMoves.add(act.moves[i].id);
      let g = '';
      if (!gimmickUsed && prng.random(3) === 0) {
        g = act.canTerastallize ? 'terastallize' : act.canDynamax ? 'dynamax' : act.canMegaEvo ? 'mega' : act.canMegaEvoX ? 'megax' : act.canMegaEvoY ? 'megay'
          : act.canUltraBurst ? 'ultra' : act.canZMove && act.canZMove[i] ? 'zmove' : '';
        if (g) gimmickUsed = true;
      }
      const targets = E.targetsFor(E.targetType(act, i, g), battle, si, place);
      const s = ['move', i + 1, battle.gameType !== 'singles' && targets.length ? pick(targets) : null, g].filter(x => x !== null && x !== '').join(' ');
      parts.push(s); named.push(s);
    });
  }
  return {str: parts.join(', '), named: named.join(', ')};
}
// a recorded choice (switches by name) as a choice for this battle's request
function unname(battle, si, named) {
  const req = battle.sides[si].activeRequest;
  return named.replace(/switch @([^,]+)/g, (_, name) => {
    const n = req.side.pokemon.findIndex(p => p.ident.replace(/^p\d: /, '') === name);
    return 'switch ' + (n + 1);
  });
}

// ---------------------------------------------------------------- play a battle, keeping the true state at each turn
function play(format, teams, seed) {
  const gen = Dex.formats.get(format).gen || +format[3];
  // (the replay shows HP in percent, as every format on the server does)
  const battle = new Battle({formatid: format, seed});
  // the replay shows HP in percent, as every format on the server does (custom games, being debug formats, show it exact)
  battle.reportExactHP = false; battle.reportPercentages = true;
  battle.setPlayer('p1', {name: 'A', team: teams[0]});
  battle.setPlayer('p2', {name: 'B', team: teams[1]});
  const turns = [];   // turns[t] = {json, decisions: [{si, named}]}
  let cur = null;
  for (let n = 0; !battle.ended && n < 1000; n++) {
    if (battle.requestState === 'move' && battle.turn > (cur ? cur.t : 0)) {
      if (battle.turn > MAXTURNS) break;
      cur = {t: battle.turn, json: battle.toJSON(), decisions: []};
      turns[battle.turn] = cur;
    }
    let chose = false;
    const turn = battle.turn;
    for (const si of [0, 1]) {
      const side = battle.sides[si];
      if (!side.activeRequest || side.activeRequest.wait || side.isChoiceDone()) continue;
      let c = randomChoice(battle, si), ok = false;
      for (let tries = 0; c && tries < 5 && !(ok = battle.choose(side.id, c.str)); tries++) c = randomChoice(battle, si);
      if (!ok) { battle.choose(side.id, 'default'); c = {named: 'default'}; }
      if (cur) cur.decisions.push({si, named: c.named});
      chose = true;
      // (a new turn began: keep its state before anyone chooses in it)
      if (battle.ended || battle.turn !== turn) break;
    }
    if (!chose) break;
  }
  const out = [];
  for (let i = 0; i < battle.log.length; i++) {
    if (battle.log[i].startsWith('|split|')) { out.push(battle.log[i + 2]); i += 2; } else out.push(battle.log[i]);
  }
  return {battle, gen, log: out, turns};
}

// ---------------------------------------------------------------- what a position is made of
const SKIP = new Set(['id', 'target', 'effectOrder', 'sourceEffect', 'source', 'sourcePosition', 'name']);
function effectOf(st) {
  const o = {};
  for (const [k, v] of Object.entries(st || {})) {
    if (SKIP.has(k) || v === undefined || v === null || typeof v === 'function') continue;
    if (typeof v === 'object') o[k] = v.name || v.id || (Array.isArray(v) ? v.map(x => (x && (x.name || x.id)) || x).join(',') : JSON.stringify(v));
    else o[k] = v;
  }
  if (st && st.source && st.source.name) o.by = st.source.name;
  return o;
}
const pct = (hp, maxhp) => { if (!hp) return 0; let p = Math.ceil(100 * hp / maxhp); if (p === 100 && hp < maxhp) p = 99; return p; };
function monOf(p, active) {
  const m = {
    species: p.species.name, hp: p.hp, maxhp: p.maxhp, fainted: !!p.fainted || p.hp <= 0,
    status: p.status || '', statusState: p.status ? effectOf(p.statusState) : {},
    item: p.item || '', ability: p.ability || '', baseAbility: p.baseAbility || '',
    tera: p.terastallized || '', types: p.getTypes().join('/'),
    moves: Object.fromEntries(p.moveSlots.map(ms => [ms.id, {pp: ms.pp, maxpp: ms.maxpp}])),
    flags: {swordBoost: !!p.swordBoost, shieldBoost: !!p.shieldBoost, syrupTriggered: !!p.syrupTriggered, timesAttacked: p.timesAttacked || 0,
      transformed: !!p.transformed, stellar: [].concat(p.stellarBoostedTypes || []).join(',')},
    abilityState: effectOf(p.abilityState), itemState: effectOf(p.itemState),
  };
  if (active) {
    m.boosts = {...p.boosts};
    m.volatiles = Object.fromEntries(Object.entries(p.volatiles).map(([id, st]) => [id, effectOf(st)]));
    m.stats = {...p.storedStats};
    m.activeMoveActions = p.activeMoveActions; m.activeTurns = p.activeTurns; m.lastMove = p.lastMove ? p.lastMove.id : '';
    if (p.battle.gen === 2) m.lastMoveEncore = p.lastMoveEncore ? p.lastMoveEncore.id : '';   // (gen 2 Encore reads it)
    m.moveLastTurnResult = p.moveLastTurnResult === undefined ? '' : String(p.moveLastTurnResult);
    m.weighthg = p.weighthg;
    if (p.modifiedStats) m.modifiedStats = {...p.modifiedStats};   // (gen 1: burn and paralysis cut the stat itself)
  }
  return m;
}
function reqOf(side) {
  const r = side.activeRequest;
  if (!r) return null;
  return {
    wait: !!r.wait, force: r.forceSwitch ? r.forceSwitch.join() : '',
    active: (r.active || []).map(a => ({
      moves: a.moves.map(m => `${m.id}${m.pp !== undefined ? ':' + m.pp : ''}${m.disabled ? ':disabled' : ''}`).join(','),
      trapped: !!a.trapped, maybeTrapped: !!a.maybeTrapped, tera: a.canTerastallize || '', dynamax: !!a.canDynamax,
      mega: a.canMegaEvo ? 'mega' : a.canMegaEvoX ? 'x' : a.canMegaEvoY ? 'y' : '', ultra: !!a.canUltraBurst,
      zmove: a.canZMove ? a.canZMove.map(z => (z && z.move) || '').join(',') : '',
      maxMoves: a.maxMoves ? a.maxMoves.maxMoves.map(m => m.move).join(',') + (a.maxMoves.gigantamax ? ' gmax' : '') : '',
    })),
    bench: r.side.pokemon.filter(p => !p.active && !/fnt/.test(p.condition)).map(p => p.ident.replace(/^p\d: /, '')).sort().join(','),
  };
}
function snapshot(battle) {
  const f = battle.field;
  return {
    field: {weather: f.weather || '', weatherState: f.weather ? effectOf(f.weatherState) : {}, terrain: f.terrain || '', terrainState: f.terrain ? effectOf(f.terrainState) : {},
      pseudoWeather: Object.fromEntries(Object.entries(f.pseudoWeather).map(([id, st]) => [id, effectOf(st)])),
      lastMove: battle.lastMove ? battle.lastMove.id : '',   // (Copycat reads it)
      ...(battle.gen <= 3 ? {quickClawRoll: !!battle.quickClawRoll} : {})},
    sides: battle.sides.map(side => ({
      active: side.active.map(p => !p || p.fainted ? '(empty)' : p.name),
      conditions: Object.fromEntries(Object.entries(side.sideConditions).map(([id, st]) => [id, effectOf(st)])),
      slots: side.slotConditions.map(sc => Object.fromEntries(Object.entries(sc).map(([id, st]) => [id, effectOf(st)]))),
      pokemonLeft: side.pokemonLeft, totalFainted: side.totalFainted, zMoveUsed: !!side.zMoveUsed, dynamaxUsed: !!side.dynamaxUsed,
      faintedLastTurn: side.faintedLastTurn ? side.faintedLastTurn.name : '',
      // (gen 1: the cartridge's move selection, which Counter, a frozen or sleeping Pokemon's turn and recharging read)
      ...(battle.gen === 1 ? {gen1Selected: `${side.lastSelectedMove}/${side.lastSelectedMoveSlot}/${side.lastEnemySelectedMove}`} : {}),
      mons: Object.fromEntries(side.pokemon.map(p => [p.name, monOf(p, p.isActive && !p.fainted)])),
      req: reqOf(side),
    })),
  };
}

// ---------------------------------------------------------------- comparing
// differences as {path: ['p1', 'mons', name, 'volatiles', id, key], t, r}
function diff(a, b, at, out) {
  if (a === b) return;
  const obj = x => x && typeof x === 'object';
  if (obj(a) && obj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push({path: [...at, k], t: undefined, r: b[k]});
      else if (!(k in b)) out.push({path: [...at, k], t: a[k], r: undefined});
      else diff(a[k], b[k], [...at, k], out);
    }
    return;
  }
  out.push({path: at, t: a, r: b});
}
const show = v => v === undefined ? '(none)' : typeof v === 'object' ? JSON.stringify(v) : String(v);

// The log from the start to the "|turn|t" line, and helpers that read it.
function linesTo(rep, t) { return rep.lines.slice(0, rep.turnIdx[t] + 1); }
const RANDOM_DUR = {   // gen -> volatiles whose length is random (it is not in the log how long they last)
  confusion: () => true, lockedmove: () => true, partiallytrapped: () => true, bide: g => g <= 1 || g >= 1, rage: g => g === 1,
  encore: g => g <= 4, taunt: g => g === 4, disable: g => g <= 4, uproar: g => g <= 4, mustrecharge: () => false, slp: () => true,
};

// Sorts a difference into a cause: {key, unknowable: reason | '', mechanic}.
function classify(d, ctx) {
  const {gen, T, R, rep, t} = ctx;
  const p = d.path, sideIdx = p[0] === 'field' ? -1 : +p[0].slice(1) - 1;
  const mon = p[1] === 'mons' ? p[2] : null;
  const generic = p.map((x, i) => (i === 2 && p[1] === 'mons') ? '*' : x).slice(p[0] === 'field' ? 0 : 1).join('.');
  const tMon = mon ? T.sides[sideIdx].mons[mon] : null, rMon = mon ? R.sides[sideIdx].mons[mon] : null;
  const log = linesTo(rep, t);
  const tag = `p${sideIdx + 1}`;
  // a Pokemon the replay never shows
  if (mon && !rMon) {
    const seen = rep.lines.some(l => /^\|(switch|drag|replace)\|/.test(l) && new RegExp(`^${tag}[a-c]?: ${esc(mon)}$`).test(l.split('|')[2]));
    return seen ? {key: 'mon revealed but missing from the take-over'} : {key: 'mon never revealed', unknowable: 'a Pokemon the replay never shows (no team preview)'};
  }
  if (p[1] === 'req' && p[2] === 'bench') {
    const missing = String(d.t).split(',').filter(n => !String(d.r).split(',').includes(n));
    const extra = String(d.r).split(',').filter(n => n && !String(d.t).split(',').includes(n));
    if (!extra.length && missing.every(n => !R.sides[sideIdx].mons[n])) return {key: 'req.bench (never revealed)', unknowable: 'a Pokemon the replay never shows (no team preview)'};
  }
  if (p[1] === 'pokemonLeft' && d.t > d.r && Object.keys(T.sides[sideIdx].mons).filter(n => !R.sides[sideIdx].mons[n]).length === d.t - d.r) {
    return {key: 'pokemonLeft (never revealed)', unknowable: 'a Pokemon the replay never shows (no team preview)'};
  }
  if (mon && (p[3] === 'hp')) {
    const sub = `${tMon.hp}/${tMon.maxhp} = ${pct(tMon.hp, tMon.maxhp)}% vs ${rMon.hp}/${rMon.maxhp} = ${pct(rMon.hp, rMon.maxhp)}%`;
    if (tMon && rMon && pct(tMon.hp, tMon.maxhp) === pct(rMon.hp, rMon.maxhp)) return {key: 'mon.hp (within the shown percent)', unknowable: 'exact HP: the log shows a percent', sub};
    if (tMon.maxhp !== rMon.maxhp) return {key: 'mon.hp (max HP differs, see mon.maxhp)', harmless: 'counted under mon.maxhp', sub};
    return {key: 'mon.hp (outside the shown percent: rounding)', sub};
  }
  const anyHas = ids => ctx.teamHas(0, ids) || ctx.teamHas(1, ids);
  if (p[0] === 'field' && p[1] === 'lastMove') return anyHas(['copycat']) ? {key: 'field.lastMove (read by Copycat)'} : {key: 'field.lastMove', harmless: 'only Copycat reads it, and no Pokemon here has it'};
  if (mon && p[3] === 'lastMoveEncore') return anyHas(['encore']) ? {key: 'mon.lastMoveEncore (gen 2 Encore reads it)'} : {key: 'mon.lastMoveEncore', harmless: 'only Encore reads it, and no Pokemon here has it'};
  if (p[0] === 'field' && p[1] === 'quickClawRoll') return {key: 'field.quickClawRoll', unknowable: 'gens 2-3 roll Quick Claw for the next turn at the end of this one (dice; the take-over leaves it off)'};
  // (only a primal weather reads who set it: it ends when that Pokemon leaves)
  if (p[0] === 'field' && ['by', 'sourceSlot'].includes(p[p.length - 1]) && !(p[1] === 'weatherState' && ['desolateland', 'primordialsea', 'deltastream'].includes(T.field.weather))) {
    return {key: `${p.slice(0, -1).join('.')}.${p[p.length - 1]}`.replace(/^field\.pseudoWeather\.\w+/, 'field.pseudoWeather.*'), harmless: 'which Pokemon set it is not read for this effect'};
  }
  if (p[1] === 'conditions' && ['by', 'sourceSlot'].includes(p[p.length - 1])) return {key: `conditions.*.${p[p.length - 1]}`, harmless: 'which Pokemon set it is not read for side conditions'};
  if (mon && p[3] === 'statusState' && tMon.status === 'slp' && ['time', 'startTime'].includes(p[4])) {
    const sleptT = tMon.statusState.startTime - tMon.statusState.time, sleptR = rMon.statusState.startTime - rMon.statusState.time;
    const rest = lastStatusLine(log, tag, mon)?.includes('[from] move: Rest');
    if (rest) return {key: 'sleep turns (from Rest, fixed length)'};
    if (sleptT !== sleptR && sleptT >= 0 && sleptR >= 0) return {key: `sleep: turns slept so far`, sub: `slept ${sleptT} vs ${sleptR}`};
    return {key: 'sleep turns left', unknowable: 'sleep length is random'};
  }
  // counters only some moves and abilities read: a difference matters only with one of them on the team
  const has = (si, ids) => ctx.teamHas(si, ids);
  const uses = {timesAttacked: ['ragefist'], totalFainted: ['lastrespects', 'supremeoverlord'], faintedLastTurn: ['retaliate'],
    moveLastTurnResult: ['stompingtantrum', 'temperflare']}[p[p.length - 1]];
  if (uses) return has(sideIdx, uses) ? {key: generic + ` (read by ${uses.join('/')})`} : {key: generic, harmless: `only ${uses.join(', ')} read it, and no Pokemon here has one`};
  if (mon && p[3] === 'activeMoveActions' && ((d.t > 0) === (d.r > 0) || !has(sideIdx, ['fakeout', 'firstimpression', 'matblock']))) return {key: 'mon.activeMoveActions', harmless: 'only "is it above 0" matters (Fake Out, First Impression... check it is at most 1 once this turn counts)'};
  if (mon && p[3] === 'activeTurns' && !d.t === !d.r) return {key: 'mon.activeTurns', harmless: 'only "is it 0" is read (Speed Boost, Moody...)'};
  if (mon && (p[3] === 'statusState' || p[3] === 'volatiles' && !['leechseed', 'partiallytrapped', 'attract', 'trapped', 'syrupbomb', 'octolock', 'imprison', 'skydrop'].includes(p[4]))
    && ['by', 'sourceSlot'].includes(p[p.length - 1])) return {key: `${p[3]}.${p[p.length - 1]}`, harmless: 'which Pokemon caused it is not read for this effect'};
  if (mon && p[3] === 'volatiles' && p.length >= 6) {
    const vid = p[4], key = p[5];
    if (['duration', 'time'].includes(key) && RANDOM_DUR[vid] && RANDOM_DUR[vid](gen)) {
      if (vid === 'partiallytrapped' && /gripclaw/.test(ctx.trueItemOf(tMon.volatiles[vid]?.by))) return {key: `volatile ${vid}.${key} (Grip Claw: fixed)`};
      return {key: `volatile ${vid}.${key}`, unknowable: `${vid} length is random (in this gen)`};
    }
    if (vid === 'substitute' && key === 'hp' && d.t < Math.floor(tMon.maxhp / 4)) return {key: 'volatile substitute.hp (after hits)', unknowable: 'damage to a substitute is not in the log'};
    if (vid === 'bide' && ['totalDamage', 'lastDamage'].includes(key)) return {key: `volatile bide.${key}`, unknowable: 'damage dealt is shown in percent'};
    if (vid === 'stall' && key === 'counter') return {key: 'volatile stall.counter'};
    if (vid === 'trapped' && ['linkedPokemon', 'linkedStatus', 'by', 'sourceSlot'].includes(key)) return {key: 'volatile trapped: no link to the trapper (it stays when the trapper leaves)'};
    return {key: `volatile ${vid}.${key}`};
  }
  if (mon && p[3] === 'volatiles' && p.length === 5) return {key: `volatile ${p[4]} ${d.t === undefined ? 'extra in take-over' : 'missing in take-over'}`};
  if (p[0] === 'field' && p.length >= 4 && ['duration'].includes(p[p.length - 1])) return {key: generic};
  if (p[1] === 'slots' && p.length === 4) return {key: `slot condition ${p[3]} ${d.t === undefined ? 'extra in take-over' : 'missing in take-over'}`};
  if (p[1] === 'conditions' && p.length === 3) return {key: `side condition ${p[2]} ${d.t === undefined ? 'extra in take-over' : 'missing in take-over'}`};
  if (p[0] === 'field' && p[1] === 'pseudoWeather' && p.length === 3) return {key: `pseudo-weather ${p[2]} ${d.t === undefined ? 'extra in take-over' : 'missing in take-over'}`};
  if (mon && p[3] === 'moves' && p[5] === 'pp') {
    const own = log.filter(l => l.startsWith(`|move|${tag}`) && l.split('|')[2].endsWith(': ' + mon));
    const revealed = own.some(l => toID(l.split('|')[3]) === p[4]);
    const mv = Dex.moves.get(p[4]);
    const foes = ctx.trueBattle.sides[1 - sideIdx].pokemon;
    let why = 'other';
    if (own.some(l => { const m = Dex.moves.get(l.split('|')[3]); return m.isMax || m.isZ; })) why = 'it used a Max Move or Z-Move (the log names that, not the move it came from)';
    else if (d.t > d.r && gen <= 2 && foes.some(f => Object.values(f.species.abilities).every(a => a === 'Pressure'))) why = 'Pressure charged in gen 1-2 (no abilities then)';
    else if (d.t > d.r && foes.some(f => f.baseAbility !== 'pressure' && Object.values(f.species.abilities).every(a => a === 'Pressure')))
      return {key: 'mon.moves.pp (Pressure assumed)', harmless: 'test artifact: the client charges 2 PP against a species whose only ability is Pressure, but this random set has another'};
    else if (foes.some(f => f.baseAbility === 'pressure' || f.ability === 'pressure')) why = 'a foe has Pressure';
    else if (mv.flags?.charge || ['skullbash', 'solarbeam', 'solarblade', 'razorwind', 'skyattack', 'meteorbeam', 'electroshot', 'geomancy', 'bide'].includes(p[4])) why = 'two-turn move';
    else if (['outrage', 'thrash', 'petaldance', 'ragingfury', 'rollout', 'iceball', 'uproar', 'rage'].includes(p[4])) why = 'locked-in move';
    else if (own.some(l => toID(l.split('|')[3]) === p[4] && /\[from\]/.test(l))) why = 'called by another move (Sleep Talk, Metronome...)';
    return {key: `mon.moves.pp: ${why}${revealed ? '' : ' (move never named in the log)'}`};
  }
  if (mon && p[3] === 'moves' && p.length === 5) return {key: `mon move slot ${d.t === undefined ? 'extra' : 'missing'} in take-over${tMon.flags.transformed ? ' (Transform)' : ''}`};
  if (mon && ['abilityState', 'itemState'].includes(p[3])) {
    const active = !!tMon.volatiles;
    if (!active) return {key: `${p[3]}.* (Pokemon not active)`, harmless: 'reset when it switches in'};
    if (!d.t === !d.r) return {key: `${p[3]}.* (false vs unset)`, harmless: 'the same to the simulator'};
    if (['unnerved', 'checkedBerserk', 'checkedAngerShell', 'started'].includes(p[4])) return {key: `${p[3]}.${p[4]}`, harmless: 'a message-once or per-hit flag'};
    return {key: `${p[3]}.${p[4]}`};
  }
  if (mon && p[3] === 'statusState') return {key: `statusState.${p[4]}`};
  if (p[1] === 'req' && p[2] === 'active') {
    // (a difference in what the menu offers that follows from one in the Pokemon itself)
    const who = T.sides[sideIdx].active[+p[3]];
    if (ctx.realMons.has(`${sideIdx}:${who}`)) return {key: `req.active.${p[4]} (follows from a difference above)`, harmless: 'counted above'};
    return {key: `req.active.${p[4]}`};
  }
  if (mon && p[3] === 'types') return {key: `mon.types${tMon.flags.transformed ? ' (Transform)' : ' (type change: Soak, Conversion, Protean, Color Change...)'}`};
  if (mon && (p[3] === 'stats' || p[3] === 'weighthg' || p[3] === 'species' || p[3] === 'maxhp') && tMon.flags.transformed) return {key: `mon.${p[3]} (Transform)`};
  if (mon && p[3] === 'lastMove') {
    if (['metronome', 'mirrormove', 'sleeptalk', 'assist', 'copycat', 'naturepower', 'mefirst'].includes(d.t)) return {key: 'mon.lastMove (the calling move vs the move it called)'};
    if (!d.t && gen <= 2) return {key: 'mon.lastMove (gen 1-2: cleared by sleep, freeze, ...)'};
    return {key: 'mon.lastMove'};
  }
  if (p[1] === 'mons') return {key: 'mon.' + p.slice(3).join('.')};
  return {key: generic};
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function lastStatusLine(log, tag, mon) {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].startsWith(`|-status|${tag}`) && log[i].split('|')[2].endsWith(': ' + mon) && log[i].includes('|slp')) return log[i];
  return null;
}

// ---------------------------------------------------------------- playing the turn on from both, with the true dice
// The true values of what a replay cannot show, put into the taken-over battle, so that a difference in the turn that
// follows is something else.
function patchUnknowable(rb, tb) {
  for (const [si, side] of rb.sides.entries()) {
    for (const p of side.pokemon) {
      const q = tb.sides[si].pokemon.find(x => x.name === p.name);
      if (!q) continue;
      if (!p.fainted && !q.fainted && pct(p.hp, p.maxhp) === pct(q.hp, q.maxhp) && p.maxhp === q.maxhp) p.hp = q.hp;
      if (p.status === 'slp' && q.status === 'slp') { p.statusState.time = q.statusState.time; p.statusState.startTime = q.statusState.startTime; }
      for (const vid of Object.keys(RANDOM_DUR)) {
        const a = p.volatiles[vid], b = q.volatiles[vid];
        if (a && b) { if (b.duration !== undefined) a.duration = b.duration; if (b.time !== undefined) a.time = b.time; if (vid === 'bide') { a.totalDamage = b.totalDamage; a.lastDamage = b.lastDamage; } }
      }
      if (p.volatiles.substitute && q.volatiles.substitute) p.volatiles.substitute.hp = q.volatiles.substitute.hp;
    }
  }
  // the order of the benched Pokemon (a random pick among them, Roar or Whirlwind, depends on it; the team order is not
  // all in the log, and with unknown dice it changes nothing)
  for (const [si, side] of rb.sides.entries()) {
    const n = side.active.length, order = tb.sides[si].pokemon.map(p => p.name);
    const bench = side.pokemon.slice(n).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    bench.forEach((p, k) => { side.pokemon[n + k] = p; p.position = n + k; });
  }
  rb.makeRequest('move');
  if (tb.gen <= 3) rb.quickClawRoll = tb.quickClawRoll;
  rb.prng = new PRNG(tb.prng.getSeed());
}
const norm = lines => E.omniscient(lines).filter(l => l && l !== '|' && !/^\|(t:|takeover|debug)\|/.test(l));
function playOn(rb, tb, decisions) {
  const ra = rb.log.length, ta = tb.log.length;
  rb.sentLogPos = ra; tb.sentLogPos = ta;   // (the simulator takes 1000 unsent lines for an endless loop)
  for (const {si, named} of decisions) {
    for (const [b, who] of [[tb, 'true'], [rb, 'take-over']]) {
      const side = b.sides[si];
      if (b.ended || !side.activeRequest || side.activeRequest.wait) continue;
      const c = named === 'default' ? 'default' : unname(b, si, named);
      if (!b.choose(side.id, c)) return {problem: `${who} battle refused p${si + 1} "${c}": ${side.choice.error || ''}`};
    }
  }
  const tl = norm(tb.log.slice(ta)), rl = norm(rb.log.slice(ra));
  for (let i = 0; i < Math.max(tl.length, rl.length); i++) if (tl[i] !== rl[i]) return {problem: `line ${i}: true "${tl[i] ?? '(end)'}" vs take-over "${rl[i] ?? '(end)'}"`, prev: tl[i - 1]};
  return {};
}

// ---------------------------------------------------------------- run
const causes = new Map();   // key -> {unknowable, n, examples}
const playCauses = new Map(), harmless = new Map();
let nBattles = 0, nTurns = 0, cleanTurns = 0, threw = 0, noteCount = new Map(), playedOn = 0, playedSame = 0;
const covered = {moves: new Set(), abilities: new Set(), items: new Set()};
// n = turns it shows in, starts = times it began (it was not there the turn before), where = the gens it shows in
function addCause(map, key, unknowable, ex, where = '', isNew = true) {
  const mk = key + '\u0000' + unknowable;   // (the same field can be unknowable in one gen and not in another)
  if (!map.has(mk)) map.set(mk, {key, unknowable, n: 0, starts: 0, where: new Set(), examples: []});
  const c = map.get(mk); c.n++; if (isNew) c.starts++; if (where) c.where.add(where);
  if (c.examples.length < (map === playCauses ? SHOW_PLAY : SHOW) && isNew) c.examples.push(ex);
}
const whereOf = c => [...c.where].sort().join(' ');
const started = Date.now();
for (const format of FORMATS) {
  const dex = Dex.forFormat(Dex.formats.get(format));
  const pools = poolsFor(dex);
  const fmtStart = Date.now();
  let fmtTurns = 0, fmtReal = 0;
  for (let b = 0; b < perFormat; b++) {
    const seed = [prng.random(65536), prng.random(65536), prng.random(65536), prng.random(65536)];
    const teams = [makeTeam(dex, pools), makeTeam(dex, pools)];
    let played;
    try { played = play(format, teams, seed); } catch (e) { console.log(`${format} battle ${seed.join(',')}: the simulator threw: ${e.message}`); continue; }
    nBattles++;
    const {log, turns, gen} = played;
    for (const l of log) {
      const [, kind, , what] = l.split('|');
      if (kind === 'move') covered.moves.add(format + toID(what));
      const ab = /\[from\] ability: ([^|]+)/.exec(l) || (kind === '-ability' && [0, l.split('|')[3]]);
      if (ab) covered.abilities.add(format + toID(ab[1]));
      const it = /\[from\] item: ([^|]+)/.exec(l) || ((kind === '-item' || kind === '-enditem') && [0, l.split('|')[3]]);
      if (it) covered.items.add(format + toID(it[1]));
    }
    const formatName = Dex.formats.get(format).name;
    const rep = E.parseReplayInput(JSON.stringify({id: `${format}-${seed.join('-')}`, format: formatName, formatid: format, log: log.join('\n')}));
    const revealed = E.revealedTeams(rep);
    const trueBattle = played.battle;
    // the true sets in the order the replay's teams come in (matched by name)
    const sets = revealed.map((team, si) => team.map(k => {
      const p = trueBattle.sides[si].pokemon.find(x => x.name === k.name) || trueBattle.sides[si].pokemon.find(x => x.species.baseSpecies === Dex.species.get(k.species).baseSpecies);
      const s = p.set;
      return {name: s.name, species: s.species, item: s.item ? dex.items.get(s.item).name : '', ability: p.baseAbility ? dex.abilities.get(p.baseAbility).name : '',
        moves: s.moves.map(m => dex.moves.get(m).name), nature: s.nature, evs: s.evs, ivs: s.ivs, level: p.level, gender: p.gender, teraType: p.teraType};
    }));
    const trueItemOf = name => { for (const side of trueBattle.sides) { const p = side.pokemon.find(x => x.name === name); if (p) return toID(p.set.item); } return ''; };
    const teamHas = (si, ids) => trueBattle.sides[si].pokemon.some(p => ids.includes(toID(p.set.ability)) || p.set.moves.some(m => ids.includes(toID(m))));
    let dumped = false, before = new Set();
    for (let t = 1; t <= rep.lastTurn && turns[t]; t++) {
      const tb = Battle.fromJSON(turns[t].json);
      let tk;
      try { tk = E.takeover(rep, t, sets, [1, 2, 3, 4]); } catch (e) {
        threw++; addCause(causes, 'take-over threw: ' + e.message.slice(0, 80), '', `${format} ${seed.join(',')} turn ${t}`); continue;
      }
      nTurns++; fmtTurns++;
      for (const n of tk.notes) { const k = n.replace(/^[^:]+: /, '* '); noteCount.set(k, (noteCount.get(k) || 0) + 1); }
      const T = snapshot(tb), R = snapshot(tk.battle);
      const ds = [];
      diff(T.field, R.field, ['field'], ds);
      T.sides.forEach((s, si) => diff(s, R.sides[si], ['p' + (si + 1)], ds));
      let real = 0;
      const ctx = {gen, T, R, rep, t, trueItemOf, teamHas, trueBattle, realMons: new Set()};
      const where = `gen${gen}${rep.lines.includes('|gametype|doubles') ? 'd' : ''}`;
      const now = new Set();
      ds.sort((a, b) => (a.path[1] === 'req') - (b.path[1] === 'req'));   // (the menu last: see classify)
      for (const d of ds) {
        // (a fainted Pokemon: only that it fainted counts)
        if (d.path[1] === 'mons' && d.path[3] !== 'fainted' && T.sides[+d.path[0][1] - 1].mons[d.path[2]]?.fainted) continue;
        const c = classify(d, ctx);
        if (!c.unknowable && !c.harmless) real++;
        if (!c.harmless && d.path[1] === 'mons') ctx.realMons.add(`${+d.path[0][1] - 1}:${d.path[2]}`);
        const id = d.path.join('.') + '=' + show(d.t) + '/' + show(d.r);
        now.add(id);
        if (process.env.ALL) console.log(`  ${seed.join("-")} t${t} ${d.path.join('.')}: ${show(d.t)} vs ${show(d.r)} -> ${c.unknowable ? 'UNKNOWABLE ' : c.harmless ? 'harmless ' : ''}${c.key}`);
        addCause(c.harmless ? harmless : causes, c.key, c.unknowable || c.harmless || '',
          `${format} seed ${seed.join(',')} turn ${t}: ${d.path.join('.')}: true ${show(d.t)} vs take-over ${show(d.r)}${c.sub ? ' (' + c.sub + ')' : ''}`, where, !before.has(id));
      }
      before = now;
      if (!real) cleanTurns++; else fmtReal++;
      if (real && process.env.DUMP && !dumped) {
        dumped = true; fs.mkdirSync(process.env.DUMP, {recursive: true});
        fs.writeFileSync(path.join(process.env.DUMP, `${format}-${seed.join('-')}.json`), JSON.stringify({format, seed, log: log.join('\n'), sets,
          turns: turns.map(x => x && {decisions: x.decisions, json: x.json})}));
      }
      // play the turn on from both
      try {
        patchUnknowable(tk.battle, tb);
        const focus = process.env.FOCUS === `${seed.join(',')}:${t}`;
        const r = playOn(tk.battle, tb, turns[t].decisions);
        if (focus) {
          console.log('FOCUS decisions', JSON.stringify(turns[t].decisions), r);
          console.log('--- replay log, turn', t - 1, 'to', t + 1, '\n' + rep.lines.slice(rep.turnIdx[t - 1] ?? 0, (rep.turnIdx[t + 1] ?? rep.lines.length) + 1).join('\n'));
          console.log('--- take-over log\n' + tk.battle.log.slice(-40).join('\n'));
          console.log('--- requests', JSON.stringify(tk.battle.sides.map(s => s.activeRequest && {wait: s.activeRequest.wait, force: s.activeRequest.forceSwitch, act: s.activeRequest.active?.map(a => a.moves.map(m => m.id))})));
        }
        playedOn++;
        if (!r.problem) playedSame++;
        else addCause(playCauses, real ? 'after a difference found above' : 'with no difference found above', '', `${format} seed ${seed.join(',')} turn ${t}: ${r.problem}${r.prev ? ' (after "' + r.prev + '")' : ''}`, where);
      } catch (e) { addCause(playCauses, 'playing on threw: ' + e.message.slice(0, 60), '', `${format} seed ${seed.join(',')} turn ${t}`, where); }
    }
  }
  console.log(`${format}: ${fmtTurns} turns, ${fmtReal} with a real difference (${((Date.now() - fmtStart) / 1000).toFixed(1)}s)`);
}

// ---------------------------------------------------------------- report
const byCount = m => [...m.entries()].sort((a, b) => b[1].starts - a[1].starts || b[1].n - a[1].n);
const real = byCount(causes).filter(([, c]) => !c.unknowable), unk = byCount(causes).filter(([, c]) => c.unknowable);
const line = (k, c) => `${String(c.starts).padStart(5)} ${String(c.n).padStart(5)}  ${c.key}  [${whereOf(c)}]`;
console.log(`\n== Differences (real), by cause (times it began, turns it showed in, cause, gens; d = doubles): ${real.reduce((s, [, c]) => s + c.n, 0)}`);
for (const [k, c] of real) console.log(`${line(k, c)}\n${c.examples.map(e => '              e.g. ' + e).join('\n')}`);
console.log(`\n== Unknowable from a replay (not failures): ${unk.reduce((s, [, c]) => s + c.n, 0)}`);
for (const [k, c] of unk) console.log(`${line(k, c)}: ${c.unknowable}${process.env.SHOW_UNK ? '\n' + c.examples.map(e => '              e.g. ' + e).join('\n') : ''}`);
console.log(`\n== Harmless (nothing here reads it): ${[...harmless.values()].reduce((s, c) => s + c.n, 0)}`);
for (const [k, c] of byCount(harmless)) console.log(`${line(k, c)}: ${c.unknowable}`);
console.log(`\n== Playing the turn on (true dice, unknowables set to the true values): ${playedSame} of ${playedOn} turns play out the same`);
for (const [k, c] of byCount(playCauses)) console.log(`${line(k, c)}\n${c.examples.map(e => '              e.g. ' + e).join('\n')}`);
console.log(`\n== Take-over notes`);
for (const [k, n] of [...noteCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(n).padStart(5)}  ${k}`);
console.log(`\n${nBattles} battles, ${nTurns} turns taken over (${threw} threw), ${cleanTurns} with no real difference; moves used ${covered.moves.size}, abilities seen ${covered.abilities.size}, items seen ${covered.items.size} (summed over formats); ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(real.length ? 1 : 0);
