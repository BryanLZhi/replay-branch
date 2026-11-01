// Replay Branch core: replay parsing, state at a turn, takeover into a live sim battle, and user-controlled RNG.
import {Battle as SimBattle, Dex, PRNG, toID} from '@pkmn/sim';
import {Battle as ClientBattle} from '@pkmn/client';
import {Generations} from '@pkmn/data';
import {Protocol} from '@pkmn/protocol';
import {LogFormatter} from '@pkmn/view';

export {Dex, toID};
export const gens = new Generations(Dex);

// ---------------------------------------------------------------- replay input
// Accepts a replay .json (from replay.pokemonshowdown.com/<id>.json), a raw battle log, or a saved replay .html page.
export function parseReplayInput(text) {
  text = String(text || '').trim();
  let log = text, meta = {};
  if (text.startsWith('{')) {
    const j = JSON.parse(text);
    log = j.log || j.inputlog || '';
    meta = {id: j.id, format: j.format, formatid: j.formatid, players: j.players, uploadtime: j.uploadtime};
  } else if (/<script[^>]*battle-log-data/.test(text)) {
    const m = text.match(/<script[^>]*class="battle-log-data"[^>]*>([\s\S]*?)<\/script>/);
    log = m ? m[1].replace(/\\\//g, '/') : '';
  }
  const lines = log.split('\n').map(l => l.replace(/\r$/, ''));
  if (!lines.some(l => l.startsWith('|start'))) throw new Error('No battle found: paste the replay log (it starts with lines like "|player|p1|...").');
  let tier = '', gen = 9;
  const turnIdx = [];          // turnIdx[t] = index of the "|turn|t" line
  let winIdx = -1;
  lines.forEach((l, i) => {
    if (l.startsWith('|tier|')) tier = l.slice(6);
    else if (l.startsWith('|gen|')) gen = +l.slice(5) || 9;
    else if (l.startsWith('|turn|')) turnIdx[+l.slice(6)] = i;
    else if (l.startsWith('|win|') || l.startsWith('|tie')) winIdx = i;
  });
  let formatid = meta.formatid || toID(tier.replace(/\[|\]/g, ''));
  if (!Dex.formats.get(formatid).exists) {
    const alt = toID(tier);
    formatid = Dex.formats.get(alt).exists ? alt : `gen${gen}customgame`;
  }
  const lastTurn = turnIdx.length - 1;
  return {lines, tier, gen, formatid, turnIdx, lastTurn, winIdx, meta};
}

// A client-side battle (what a spectator knows) after the replay's lines up to the start of turn t (t = lastTurn + 1 means the end).
export function clientAt(rep, t, withLog = false) {
  const cb = new ClientBattle(gens);
  const fmt = withLog ? new LogFormatter('p1', cb) : null;
  const html = [];
  const end = t > rep.lastTurn ? rep.lines.length - 1 : rep.turnIdx[t];
  for (let i = 0; i <= end; i++) {
    const line = rep.lines[i];
    if (!line || !line.startsWith('|')) continue;
    let parsed;
    try { parsed = Protocol.parseBattleLine(line); } catch { continue; }
    const {args, kwArgs} = parsed;
    if (fmt) { try { const h = fmt.formatHTML(args, kwArgs); if (h) html.push(h); } catch {} }
    try { cb.add(args, kwArgs); } catch {}
  }
  try { cb.upkeep && cb.upkeep(); } catch {}
  return {cb, html};
}

// ---------------------------------------------------------------- sets: what is known, plus usage-stat suggestions
const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export function parseSpread(s) {
  // "Jolly:0/252/0/0/4/252"
  const [nature, evs] = s.split(':');
  const v = (evs || '').split('/').map(Number);
  const o = {}; STATS.forEach((k, i) => (o[k] = v[i] || 0));
  return {nature, evs: o};
}
export function itemName(x) {
  if (!x) return '';
  let it = Dex.items.get(x);
  if (!it.exists && /^item/i.test(x)) it = Dex.items.get(x.slice(4));
  return it.exists ? it.name : x;
}
function statsEntry(stats, species) {
  if (!stats) return null;
  const sp = Dex.species.get(species);
  return stats[sp.name] || stats[sp.baseSpecies] || stats[species] || null;
}
export function knownOf(p) {
  const moves = p.moveSlots.filter(m => !m.virtual).map(m => ({name: m.name, ppUsed: Array.isArray(m.ppUsed) ? m.ppUsed[0] : (m.ppUsed || 0)}));
  const lostItem = ['knocked off', 'stolen', 'eaten', 'flung', 'consumed', 'incinerated', 'popped'].includes(p.lastItemEffect) || false;
  const curItem = p.item ? itemName(p.item) : '';
  const lastItemName = p.lastItem ? itemName(p.lastItem) : '';
  const abilityName = (p.baseAbility || p.ability) ? Dex.abilities.get(p.baseAbility || p.ability).name : '';
  return {
    name: p.name, species: p.speciesForme, baseSpecies: p.baseSpeciesForme, level: p.level, gender: p.gender,
    moves, item: curItem, lastItem: lastItemName, itemGone: lostItem && !p.item, ability: abilityName,
    tera: p.terastallized || (p.teraType && p.teraType !== '???' ? p.teraType : ''),
  };
}
// A full set for the sim, built from what is known, then usage stats, then safe defaults. `fixed` marks the revealed parts.
export function suggestSet(known, stats, gen) {
  const e = statsEntry(stats, known.species);
  const sp = Dex.species.get(known.species);
  const fixed = {moves: known.moves.map(m => m.name), item: !!(known.item || known.lastItem), ability: !!known.ability, tera: !!known.tera};
  const moves = known.moves.map(m => m.name);
  const learnable = null;
  for (const [mv] of (e && e.m) || []) {
    if (moves.length >= 4) break;
    if (!moves.some(x => toID(x) === toID(mv))) moves.push(mv);
  }
  let item = known.item || known.lastItem || (e && e.i && e.i[0] ? itemName(e.i[0][0]) : '');
  let ability = known.ability || (e && e.a && e.a[0] ? e.a[0][0] : (sp.abilities ? sp.abilities[0] : ''));
  let tera = known.tera || (e && e.t && e.t[0] ? e.t[0][0] : (sp.types ? sp.types[0] : ''));
  let nature = 'Serious', evs = {hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84};
  if (e && e.s && e.s[0]) ({nature, evs} = parseSpread(e.s[0][0]));
  if (gen <= 2) { nature = ''; }
  const ivs = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
  return {name: known.name, species: known.species, level: known.level || 100, gender: known.gender || '',
    moves, item, itemGone: !!known.itemGone, ability, teraType: tera, nature, evs, ivs, fixed};
}
// Options to offer in the set editor: the species' usage list first, then everything legal-ish.
export function setOptions(species, stats, gen) {
  const e = statsEntry(stats, species);
  const sp = Dex.species.get(species);
  return {
    moves: (e && e.m) || [], items: ((e && e.i) || []).map(([n, p]) => [itemName(n), p]), abilities: (e && e.a) || Object.values(sp.abilities || {}).map(a => [a, 0]),
    teras: (e && e.t) || [], spreads: (e && e.s) || [],
  };
}

// ---------------------------------------------------------------- RNG control
// Every random call during a turn is recorded with what it was for; the user can force any of them on a re-run.
export class RngControl {
  constructor(seed) { this.base = new PRNG(seed); this.ctx = []; this.log = []; this.forced = []; this.battle = null; }
  getSeed() { return this.base.getSeed(); }
  setSeed(s) { this.base.setSeed(s); }
  clone() { return new PRNG(this.base.getSeed()); }
  get seed() { return this.base.getSeed(); }
  top() { return this.ctx[this.ctx.length - 1]; }
  push(c) { this.ctx.push(c); }
  pop() { this.ctx.pop(); }
  effectLabel() {
    const b = this.battle; const eff = b && b.effect; const who = b && b.effectState && b.effectState.target;
    const name = eff && eff.name ? eff.name : '';
    const holder = who && who.name ? who.name : (b && b.event && b.event.target && b.event.target.name) || '';
    return {name, holder, id: eff && eff.id};
  }
  rec(entry, value) {
    const i = this.log.length; const f = this.forced[i];
    if (f !== undefined && f !== null) {
      if (f.key === entry.key) value = f.value;
      else this.forced.length = i; // the sequence changed: later picks no longer line up
    }
    entry.i = i; entry.value = value; this.log.push(entry);
    return value;
  }
  randomChance(num, den) {
    const r = this.base.randomChance(num, den);
    const c = this.top(); const p = num / den;
    if (c && c.kind === 'acc') {
      return this.rec({key: 'acc:' + c.move, kind: 'chance', label: `${c.move}: accuracy`, who: c.user, p, yes: 'Hits', no: 'Misses'}, p >= 0.5);
    }
    if (c && c.kind === 'dmg') {
      return this.rec({key: 'crit:' + c.move, kind: 'chance', label: `${c.move}: critical hit`, who: c.user, target: c.target, p, yes: 'Crit', no: 'No crit'}, false);
    }
    const e = this.effectLabel();
    const nice = {par: 'Full paralysis', confusion: 'Hurts itself in confusion', frz: 'Thaws out', quickclaw: 'Quick Claw activates', focusband: 'Focus Band holds', attract: 'Immobilized by love', brightpowder: 'Bright Powder'}[e.id];
    const label = nice ? `${nice}` : `${e.name || 'Chance'}`;
    return this.rec({key: 'ch:' + (e.id || ''), kind: 'chance', label, who: e.holder, p, yes: 'Yes', no: 'No'}, p >= 0.5);
  }
  random(from, to) {
    const r = this.base.random(from, to);
    if (from === undefined) return r; // floats are not offered
    let lo = 0, hi = from; if (to !== undefined) { lo = from; hi = to; }
    const c = this.top();
    if (c && c.kind === 'dmg' && lo === 0 && hi === 16) {
      return this.rec({key: 'roll:' + c.move, kind: 'roll', label: `${c.move}: damage roll`, who: c.user, target: c.target, lo, hi}, r);
    }
    if (c && c.kind === 'sec' && lo === 0 && hi === 100) {
      const s = c.list[c.n++] || {};
      const chance = s.chance;
      if (chance === undefined || chance >= 100) return 0;
      const what = s.status ? ({brn: 'burn', par: 'paralysis', psn: 'poison', tox: 'bad poison', slp: 'sleep', frz: 'freeze'}[s.status] || s.status)
        : s.volatileStatus ? s.volatileStatus : s.boosts ? 'stat change' : s.self ? 'self effect' : 'effect';
      const hit = this.rec({key: 'sec:' + c.move + ':' + (c.n - 1), kind: 'chance', label: `${c.move}: ${what} (${chance}%)`, who: c.user, p: chance / 100, yes: 'Happens', no: "Doesn't"}, chance >= 50);
      return hit ? 0 : 99;
    }
    const e = this.effectLabel();
    const label = e.name ? `${e.name}: number` : 'Random number';
    return this.rec({key: 'int:' + (e.id || '') + ':' + lo + '-' + hi, kind: 'int', label, who: e.holder, lo, hi}, r);
  }
  sample(items) {
    const r = this.base.sample(items);
    const e = this.effectLabel();
    const idx = this.rec({key: 'pick:' + (e.id || '') + ':' + items.length, kind: 'pick', label: e.name ? `${e.name}: pick` : 'Random pick', who: e.holder,
      options: items.map(x => (x && x.name) ? x.name : String(x))}, items.indexOf(r));
    return items[idx < 0 ? 0 : idx];
  }
  shuffle(items, start = 0, end = items.length) {
    const c = this.top();
    const seg = items.slice(start, end);
    const names = seg.map(x => {
      const o = x && (x.effectHolder || x.pokemon || x);
      return (o && o.name) ? o.name : (x && x.effect && x.effect.name) || '?';
    });
    // default order: the base PRNG's shuffle
    const copy = items.slice(); this.base.shuffle(copy, start, end);
    const defOrder = copy.slice(start, end).map(x => seg.indexOf(x));
    if (seg.length < 2) return;
    const label = c && c.kind === 'speed' ? `Speed tie: ${names.join(' vs ')}` : `Order: ${names.join(', ')}`;
    const order = this.rec({key: 'order:' + names.join('|'), kind: 'order', label, options: names}, defOrder);
    const out = order.map(k => seg[k]);
    for (let k = 0; k < out.length; k++) items[start + k] = out[k];
  }
}

function wrap(obj, name, mk) {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function (...a) { const ctl = this.battle ? this.battle.prng : this.prng; const c = mk(...a); if (c && ctl.push) ctl.push(c); try { return orig.apply(this, a); } finally { if (c && ctl.pop) ctl.pop(); } };
}
export function installRng(battle, ctl) {
  ctl.battle = battle; battle.prng = ctl;
  const A = battle.actions;
  wrap(A, 'hitStepAccuracy', (targets, pokemon, move) => ({kind: 'acc', move: move.name, user: pokemon.name}));
  wrap(A, 'getDamage', (source, target, move) => ({kind: 'dmg', move: (typeof move === 'object' ? move.name : Dex.moves.get(move).name), user: source.name, target: target.name}));
  wrap(A, 'secondaries', (targets, source, move, moveData) => ({kind: 'sec', move: move.name, user: source.name, list: (moveData && moveData.secondaries) || move.secondaries || [], n: 0}));
  const sp = battle.speedSort;
  battle.speedSort = function (...a) { ctl.push({kind: 'speed'}); try { return sp.apply(this, a); } finally { ctl.pop(); } };
  return ctl;
}

// ---------------------------------------------------------------- takeover: client state at turn t -> live sim battle
function effState(battle, o) { return battle.initEffectState ? battle.initEffectState(o) : o; }
const VOLATILES = ['substitute', 'confusion', 'leechseed', 'taunt', 'encore', 'yawn', 'perishsong', 'curse', 'saltcure', 'aquaring', 'ingrain', 'focusenergy',
  'magnetrise', 'charge', 'stockpile', 'protosynthesis', 'quarkdrive', 'torment', 'disable', 'throatchop', 'healblock', 'smackdown', 'partiallytrapped',
  'flashfire', 'unburden', 'slowstart', 'glaiverush', 'tarshot', 'trapped', 'nightmare', 'embargo', 'imprison', 'gastroacid', 'laserfocus', 'noretreat', 'octolock', 'syrupbomb'];

// sets[side][k] are full sets in the order of client side.team; returns {battle, ctl, notes}
export function takeover(rep, t, sets, seed) {
  const {cb} = clientAt(rep, t);
  const notes = [];
  const battle = new SimBattle(seed ? {formatid: rep.formatid, seed} : {formatid: rep.formatid});
  const sides = [cb.p1, cb.p2];
  const order = [];
  sides.forEach((cs, si) => {
    const team = cs.team;
    const act = cs.active[0];
    const idx = team.map((_, k) => k);
    const a = act ? team.indexOf(act) : -1;
    if (a > 0) { idx.splice(a, 1); idx.unshift(a); }
    order[si] = idx;
    const simSets = idx.map(k => {
      const s = sets[si][k];
      const gone = knownOf(team[k]).itemGone;   // item state at this turn (sets hold the original item)
      return {name: s.name, species: s.species, item: gone ? '' : (s.item || ''), ability: s.ability || '', moves: s.moves.filter(Boolean), nature: s.nature || 'Serious',
        evs: s.evs, ivs: s.ivs, level: s.level || 100, gender: s.gender || '', teraType: s.teraType || undefined, shiny: false};
    });
    battle.setPlayer(si ? 'p2' : 'p1', {name: cs.name || (si ? 'Player 2' : 'Player 1'), team: simSets});
  });
  if (battle.requestState === 'teampreview') {
    for (const s of ['p1', 'p2']) battle.choose(s, 'team ' + battle[s].pokemon.map((_, k) => k + 1).join(''));
  }
  // --- field
  const f = battle.field, cf = cb.field;
  f.weather = ''; f.weatherState = effState(battle, {id: ''}); f.terrain = ''; f.terrainState = effState(battle, {id: ''}); f.pseudoWeather = {};
  if (cf.weatherState && cf.weatherState.id) {
    const id = cf.weatherState.id;
    f.weather = id; f.weatherState = effState(battle, {id, duration: cf.weatherState.minDuration > 0 ? cf.weatherState.minDuration : undefined});
    if (!(cf.weatherState.minDuration > 0) && !['desolateland', 'primordialsea', 'deltastream'].includes(id)) { f.weatherState.duration = 5; notes.push('Weather turns left unknown: set to 5.'); }
  }
  if (cf.terrainState && cf.terrainState.id) {
    const id = cf.terrainState.id; f.terrain = id; f.terrainState = effState(battle, {id, duration: cf.terrainState.minDuration > 0 ? cf.terrainState.minDuration : 5});
  }
  for (const [id, st] of Object.entries(cf.pseudoWeather || {})) {
    f.pseudoWeather[id] = effState(battle, {id, duration: st.minDuration > 0 ? st.minDuration : 5});
  }
  // --- sides and Pokemon
  sides.forEach((cs, si) => {
    const ss = battle.sides[si];
    ss.sideConditions = {};
    for (const [id, c] of Object.entries(cs.sideConditions || {})) {
      const st = effState(battle, {id, target: ss});
      if (['spikes', 'toxicspikes'].includes(id)) st.layers = c.level || 1;
      if (c.minDuration > 0) st.duration = c.minDuration; else if (['reflect', 'lightscreen', 'auroraveil', 'tailwind', 'safeguard', 'mist', 'luckychant'].includes(id)) st.duration = Math.max(1, c.maxDuration || 5);
      ss.sideConditions[id] = st;
    }
    let left = 0;
    const teraUsed = cs.team.some(p => p.terastallized);
    order[si].forEach((k, pos) => {
      const cp = cs.team[k]; const sp = ss.pokemon[pos]; const set = sets[si][k];
      // forme changes that persist (Palafin-Hero, Mimikyu-Busted, ...)
      if (cp.speciesForme && toID(cp.speciesForme) !== toID(sp.species.name) && Dex.species.get(cp.speciesForme).exists) {
        try { sp.formeChange(cp.speciesForme, null, true); } catch (e) { notes.push(`${cp.name}: could not set forme ${cp.speciesForme}.`); }
      }
      sp.clearVolatile && sp.clearVolatile(false);
      sp.volatiles = {};
      sp.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0};
      if (cp.fainted || cp.hp <= 0) {
        sp.hp = 0; sp.fainted = true; sp.status = 'fnt'; sp.statusState = effState(battle, {id: 'fnt', target: sp}); sp.isActive = sp.isActive && false;
      } else {
        left++;
        const frac = cp.maxhp ? cp.hp / cp.maxhp : 1;
        sp.hp = Math.max(1, Math.min(sp.maxhp, Math.round(frac * sp.maxhp)));
        if (cp.status) {
          sp.status = cp.status; const st = effState(battle, {id: cp.status, target: sp});
          if (cp.status === 'slp') { st.startTime = 3; st.time = Math.max(1, 3 - (cp.statusState?.sleepTurns || 0)); }
          if (cp.status === 'tox') st.stage = cp.statusState?.toxicTurns || 0;
          sp.statusState = st;
        } else { sp.status = ''; sp.statusState = effState(battle, {id: '', target: sp}); }
      }
      // PP
      for (const ms of sp.moveSlots) {
        const km = cp.moveSlots.find(m => toID(m.name) === ms.id);
        if (km) { const used = Array.isArray(km.ppUsed) ? km.ppUsed[0] : (km.ppUsed || 0); ms.pp = Math.max(0, ms.maxpp - used); ms.used = used > 0; }
      }
      // Tera
      if (cp.terastallized) {
        sp.terastallized = cp.terastallized; sp.teraType = cp.terastallized; sp.apparentType = cp.terastallized; sp.knownType = true;
      }
      if (teraUsed) sp.canTerastallize = null;
      // active Pokemon details
      if (cs.active[0] === cp && !sp.fainted) {
        Object.assign(sp.boosts, cp.boosts || {});
        for (const [vid, v] of Object.entries(cp.volatiles || {})) {
          if (!VOLATILES.includes(vid)) { if (!['typechange', 'typeadd'].includes(vid)) notes.push(`${cp.name}: "${vid}" not carried over.`); continue; }
          const st = effState(battle, {id: vid, target: sp});
          if (vid === 'substitute') st.hp = Math.floor(sp.maxhp / 4);
          if (vid === 'confusion') st.time = 2;
          if (vid === 'taunt') st.duration = 3;
          if (vid === 'encore') { st.move = cp.lastMove; st.duration = 3; }
          if (vid === 'disable') { st.move = cp.lastMove; st.duration = 4; }
          if (vid === 'yawn') st.duration = 2;
          if (vid === 'perishsong') st.duration = (v.level || 3) + 1;
          if (vid === 'magnetrise') st.duration = 5;
          if (vid === 'stockpile') st.layers = v.level || 1;
          if (vid === 'protosynthesis' || vid === 'quarkdrive') st.bestStat = v.stat || sp.getBestStat?.(false, true) || 'spe';
          if (vid === 'leechseed') { const foe = battle.sides[1 - si].active[0]; if (foe) st.sourceSlot = foe.getSlot(); }
          if (vid === 'partiallytrapped') { const foe = battle.sides[1 - si].active[0]; st.source = foe; st.duration = 3; st.sourceEffect = Dex.moves.get(v.id || 'wrap'); }
          sp.volatiles[vid] = st;
        }
        // choice lock
        const it = Dex.items.get(sp.item);
        if (it.isChoice && cp.lastMove && cp.lastMove !== 'switch-in' && cp.movesUsedWhileActive && cp.movesUsedWhileActive.length) {
          sp.volatiles.choicelock = effState(battle, {id: 'choicelock', target: sp, move: cp.lastMove});
        }
        sp.activeMoveActions = cp.movesUsedWhileActive ? cp.movesUsedWhileActive.length : 1;
        sp.activeTurns = Math.max(1, sp.activeMoveActions);
        sp.lastMove = cp.lastMove && cp.lastMove !== 'switch-in' ? Dex.moves.get(cp.lastMove) : null;
      }
    });
    ss.pokemonLeft = left;
  });
  battle.turn = t;
  battle.makeRequest('move');
  battle.log.push(`|takeover|${t}`);
  return {battle, order, notes};
}

// ---------------------------------------------------------------- branch engine
// A node = a saved sim state at the start of a turn (or at a forced switch), its log, and the RNG picks that produced it.
export function serialize(battle) { return battle.toJSON(); }
export function restore(json) {
  const b = SimBattle.fromJSON(json);
  return b;
}

// Run one decision step from `json`: choices = {p1: 'move 1', p2: 'switch 3'}, forced = RNG picks by call index.
export function step(json, choices, forced, seed) {
  const battle = restore(json);
  const ctl = new RngControl(seed);
  ctl.forced = forced ? forced.slice() : [];
  installRng(battle, ctl);
  const start = battle.log.length;
  for (const s of ['p1', 'p2']) {
    const req = battle.sides[s === 'p1' ? 0 : 1].activeRequest;
    if (!req || req.wait) continue;
    const ok = battle.choose(s, choices[s] || 'default');
    if (!ok) throw new Error(`${s}: ${battle.sides[s === 'p1' ? 0 : 1].choice.error || 'invalid choice'}`);
  }
  const lines = omniscient(battle.log.slice(start)).filter(l => !l.startsWith('|t:|'));
  return {battle, lines, rolls: ctl.log, forced: ctl.forced};
}

// The sim's log has |split| sections (secret line then public line); keep the secret (exact HP) one.
export function omniscient(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('|split|')) { out.push(lines[i + 1]); i += 2; continue; }
    out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------- view models for drawing
const BOOSTS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
export function viewFromClient(cb) {
  const side = cs => ({
    name: cs.name, id: cs.id,
    active: cs.active[0] ? monFromClient(cs.active[0]) : null,
    team: cs.team.map(monFromClient),
    total: cs.totalPokemon || 6,
    conds: Object.entries(cs.sideConditions || {}).map(([id, c]) => ({id, name: c.name, layers: c.level || 1, turns: c.minDuration || 0})),
  });
  const f = cb.field;
  return {
    turn: cb.turn, exact: false,
    sides: [side(cb.p1), side(cb.p2)],
    weather: f.weatherState && f.weatherState.id ? {id: f.weatherState.id, turns: f.weatherState.minDuration || 0} : null,
    terrain: f.terrainState && f.terrainState.id ? {id: f.terrainState.id, turns: f.terrainState.minDuration || 0} : null,
    pseudo: Object.entries(f.pseudoWeather || {}).map(([id, s]) => ({id, turns: s.minDuration || 0})),
  };
}
function monFromClient(p) {
  const boosts = {}; for (const k of BOOSTS) if (p.boosts && p.boosts[k]) boosts[k] = p.boosts[k];
  return {name: p.name, species: p.speciesForme, level: p.level, gender: p.gender, hp: p.hp, maxhp: p.maxhp || 100, fainted: p.fainted || p.hp <= 0,
    status: p.status || '', boosts, volatiles: Object.keys(p.volatiles || {}), tera: p.terastallized || '',
    item: p.item ? itemName(p.item) : '', ability: (p.ability || p.baseAbility) ? Dex.abilities.get(p.ability || p.baseAbility).name : '',
    moves: p.moveSlots.filter(m => !m.virtual).map(m => ({name: m.name, pp: null, maxpp: null})), types: p.types};
}
export function viewFromSim(battle) {
  const side = ss => ({
    name: ss.name, id: ss.id,
    active: ss.active[0] ? monFromSim(ss.active[0]) : null,
    team: ss.pokemon.map(monFromSim),
    total: ss.pokemon.length,
    conds: Object.entries(ss.sideConditions || {}).map(([id, c]) => ({id, name: Dex.conditions.get(id).name || id, layers: c.layers || 1, turns: c.duration || 0})),
  });
  const f = battle.field;
  return {
    turn: battle.turn, exact: true, ended: battle.ended, winner: battle.winner,
    sides: [side(battle.sides[0]), side(battle.sides[1])],
    weather: f.weather ? {id: f.weather, turns: f.weatherState.duration || 0} : null,
    terrain: f.terrain ? {id: f.terrain, turns: f.terrainState.duration || 0} : null,
    pseudo: Object.entries(f.pseudoWeather || {}).map(([id, s]) => ({id, turns: s.duration || 0})),
  };
}
function monFromSim(p) {
  const boosts = {}; for (const k of BOOSTS) if (p.boosts && p.boosts[k]) boosts[k] = p.boosts[k];
  return {name: p.name, species: p.species.name, level: p.level, gender: p.gender, hp: p.hp, maxhp: p.maxhp, fainted: p.fainted || p.hp <= 0,
    status: p.status === 'fnt' ? '' : (p.status || ''), boosts, volatiles: Object.keys(p.volatiles || {}), tera: p.terastallized || '',
    teraType: p.teraType, item: p.item ? Dex.items.get(p.item).name : '', ability: p.ability ? Dex.abilities.get(p.ability).name : '',
    moves: p.moveSlots.map(m => ({name: m.move, pp: m.pp, maxpp: m.maxpp})), types: p.getTypes ? p.getTypes() : p.types,
    stats: p.storedStats ? {...p.storedStats} : null, nature: p.set && p.set.nature, evs: p.set && p.set.evs};
}

// ---------------------------------------------------------------- battle log text (Showdown wording)
// Formats replay lines [0..end] and then any extra (branch) lines; returns an array of HTML strings.
export function formatLog(rep, end, extra = []) {
  const cb = new ClientBattle(gens);
  const fmt = new LogFormatter('p1', cb);
  const html = [];
  const feed = (line, mark) => {
    if (!line || line[0] !== '|') return;
    let parsed; try { parsed = Protocol.parseBattleLine(line); } catch { return; }
    const {args, kwArgs} = parsed;
    if (args[0] === 'c' || args[0] === 'inactive' || args[0] === 'inactiveoff' || args[0] === 'j' || args[0] === 'l' || args[0] === 'raw' && false) { try { cb.add(args, kwArgs); } catch {} return; }
    try { const h = fmt.formatHTML(args, kwArgs); if (h) html.push(mark ? `<div class="branchline">${h}</div>` : h); } catch {}
    try { cb.add(args, kwArgs); } catch {}
  };
  for (let i = 0; i <= end && i < rep.lines.length; i++) feed(rep.lines[i], false);
  if (extra.length) html.push('<div class="branchmark">Your line starts here</div>');
  for (const l of extra) feed(l, true);
  return html;
}

// Short per-side action summary of a run of protocol lines (for the move list).
export function summarize(lines) {
  const out = {p1: [], p2: []};
  let sawMove = {p1: false, p2: false};
  for (const l of lines) {
    if (!l || l[0] !== '|') continue;
    const a = l.split('|');
    const kind = a[1];
    const who = (a[2] || '').slice(0, 2);
    if (who !== 'p1' && who !== 'p2') continue;
    const name = (a[2] || '').replace(/^p\d[a-d]?: /, '');
    if (kind === 'move') { if (/\[from\]/.test(l) && !/lockedmove/.test(l)) continue; out[who].push(a[3]); sawMove[who] = true; }
    else if (kind === 'switch' || kind === 'drag') out[who].push('→ ' + name);
    else if (kind === '-terastallize') out[who].push('Tera ' + a[3]);
    else if (kind === 'cant') out[who].push(`can't move`);
    else if (kind === 'faint') out[who].push(name + ' fainted');
  }
  return {p1: out.p1.join(', '), p2: out.p2.join(', ')};
}

// What a player can do right now, for the move / switch buttons.
export function requestFor(battle, si) {
  const side = battle.sides[si]; const req = side.activeRequest;
  if (!req) return null;
  return req;
}
