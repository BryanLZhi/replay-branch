// Replay Branch core: replay parsing, state at a turn, takeover into a live sim battle, and user-controlled RNG.
import {Battle as SimBattle, Dex, PRNG, toID} from '@pkmn/sim';
import {Battle as ClientBattle} from '@pkmn/client';
import {Generations} from '@pkmn/data';
import {Protocol} from '@pkmn/protocol';

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
    const renamed = formatid.replace(/^(gen\d+)ou(?=\w)/, '$1');   // (old ids: gen6oumonotype is gen6monotype now)
    formatid = Dex.formats.get(alt).exists ? alt : Dex.formats.get(renamed).exists ? renamed
      : nearestFormat(formatid, gen, lines.includes('|gametype|doubles') ? 'doubles' : 'singles');
  }
  const lastTurn = turnIdx.length - 1;
  return {lines, tier, gen, formatid, turnIdx, lastTurn, winIdx, meta};
}

// A format this simulator lacks (a newer regulation, another server's): the closest one it has, of the same game type -
// the latest whose id shares the longest start with it (gen9vgc2025regj -> gen9vgc2025regi) - else its custom game.
function nearestFormat(formatid, gen, gameType) {
  const all = Dex.formats.all().filter(f => f.exists && f.effectType === 'Format' && (f.gameType || 'singles') === gameType && f.id.startsWith('gen' + gen));
  for (let n = formatid.length - 1; n > ('gen' + gen).length + 2; n--) {
    const near = all.filter(f => f.id.startsWith(formatid.slice(0, n)));
    if (near.length) return near[near.length - 1].id;
  }
  return `gen${gen}${gameType === 'doubles' ? 'doubles' : ''}customgame`;
}

// A client-side battle (what a spectator knows) after the replay's lines up to the start of turn t (t = lastTurn + 1 means the end).
export function clientAt(rep, t) {
  const cb = new ClientBattle(gens);
  const end = t > rep.lastTurn ? rep.lines.length - 1 : rep.turnIdx[t];
  for (let i = 0; i <= end; i++) {
    const line = rep.lines[i];
    if (!line || !line.startsWith('|')) continue;
    let parsed;
    try { parsed = Protocol.parseBattleLine(line); } catch { continue; }
    addLine(cb, parsed.args, parsed.kwArgs);
  }
  try { cb.upkeep && cb.upkeep(); } catch {}
  return cb;
}
// Feed one protocol line to a client battle. On a forme change (|detailschange|, which Terastallizing also sends) the client
// takes the new forme's first ability as known, and as its original one: keep what was known of the original ability, and
// take the new one only when the new forme has just one (Mega Evolutions, Terapagos-Terastal...).
// Mummy and Lingering Aroma also pass themselves on to the Pokemon that touched them (and Wandering Spirit swaps), which the
// client does not record: "|-activate|<holder>|ability: Mummy|<other>|[ability] <the other's ability until now>".
// A Pledge joining an ally's ("|move|<it>|Grass Pledge|...|[from] move: Water Pledge") is its own move, not the ally's.
export function addLine(cb, args, kwArgs) {
  if (args[0] === 'move' && /Pledge$/.test(args[2] || '') && /Pledge$/.test(kwArgs.from || '')) { kwArgs = {...kwArgs}; delete kwArgs.from; }
  const poke = args[0] === 'detailschange' ? cb.getPokemon(args[1]) : null;
  const before = poke && {ability: poke.ability, baseAbility: poke.baseAbility};
  try { cb.add(args, kwArgs); } catch {}
  if (poke) {
    const abilities = Object.values(Dex.species.get(String(args[2]).split(',')[0]).abilities || {});
    poke.baseAbility = before.baseAbility;
    if (abilities.length !== 1) poke.ability = before.ability;
  }
  const passed = args[0] === '-activate' && /^ability: (Mummy|Lingering Aroma|Wandering Spirit)$/.exec(args[2] || '');
  if (passed && args[3] && kwArgs.ability) {
    try {
      const holder = cb.getPokemon(args[1]), other = cb.getPokemon(args[3]);
      other.baseAbility ||= toID(kwArgs.ability);
      other.ability = toID(passed[1]);
      if (passed[1] === 'Wandering Spirit') holder.ability = toID(kwArgs.ability);
    } catch {}
  }
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
  const moves = p.moveSlots.filter(m => !m.virtual).map(m => ({name: m.name.replace(/^move: /, ''), ppUsed: Array.isArray(m.ppUsed) ? m.ppUsed[0] : (m.ppUsed || 0)}));
  // (up to gen 4 a knocked off item stays held, unusable: the client marks the item itself)
  const lostItem = ['knocked off', 'stolen', 'eaten', 'flung', 'consumed', 'incinerated', 'popped'].includes(p.lastItemEffect) || p.itemEffect === 'knocked off';
  const curItem = p.item ? itemName(p.item) : '';
  const lastItemName = p.lastItem ? itemName(p.lastItem) : '';
  // a set is for the forme it starts in (Alakazam, not Alakazam-Mega; Palafin, not Palafin-Hero), with that forme's ability
  const battleOnly = Dex.species.get(p.speciesForme).battleOnly;
  const startForme = Dex.species.get((Array.isArray(battleOnly) ? battleOnly[0] : battleOnly) || p.speciesForme);
  let abilityName = (p.baseAbility || p.ability) ? Dex.abilities.get(p.baseAbility || p.ability).name : '';
  if (battleOnly && !Object.values(startForme.abilities || {}).includes(abilityName)) abilityName = '';
  return {
    name: p.name, species: (Array.isArray(battleOnly) ? battleOnly[0] : battleOnly) || p.speciesForme, baseSpecies: p.baseSpeciesForme,
    level: p.level, gender: p.gender,
    moves, item: curItem, lastItem: lastItemName, itemGone: lostItem && (!p.item || p.itemEffect === 'knocked off'), ability: abilityName,
    tera: p.terastallized || (p.teraType && p.teraType !== '???' ? p.teraType : ''),
  };
}
// What the replay reveals about each side's Pokemon (knownOf, in team order), including the Z-Crystal behind a Z-Move.
export function revealedTeams(rep) {
  const known = endOf(rep).sides.slice(0, 2).map(side => side.team.map(knownOf));
  for (let i = 0; i < rep.lines.length - 1; i++) {
    const [, kind, who = ''] = rep.lines[i].split('|');
    if (kind !== '-zpower') continue;
    const next = rep.lines.slice(i + 1).find(l => l.startsWith('|move|' + who.slice(0, 3)));
    const zmove = next && Dex.moves.get(next.split('|')[3]);
    if (!zmove?.exists) continue;
    const crystal = zmove.isZ ? Dex.items.get(zmove.isZ) : null;   // (a status Z-Move is logged as the move itself)
    const mon = known[who.startsWith('p2') ? 1 : 0].find(k => k.name === who.replace(/^p\d[a-c]?: /, ''));
    if (crystal && mon && !mon.item && !mon.lastItem) mon.item = crystal.name;
  }
  // the log names a damaging Z-Move or Max Move, not the move it came from: keep only its type (suggestSet finds a move of
  // it; Max Guard came from some status move)
  for (const mon of known.flat()) {
    const z = mon.moves.filter(m => Dex.moves.get(m.name).isZ || Dex.moves.get(m.name).isMax);
    if (!z.length) continue;
    mon.moves = mon.moves.filter(m => !z.includes(m));
    mon.zTypes = z.filter(m => Dex.moves.get(m.name).category !== 'Status').map(m => Dex.moves.get(m.name).type);
    mon.statusMove = z.some(m => Dex.moves.get(m.name).category === 'Status');
  }
  return known;
}
// A full set for the sim, built from what is known, then usage stats, then safe defaults. `fixed` marks the revealed parts.
export function suggestSet(known, stats, gen) {
  const e = statsEntry(stats, known.species);
  const sp = Dex.species.get(known.species);
  const fixed = {moves: known.moves.map(m => m.name), item: !!(known.item || known.lastItem), ability: !!known.ability, tera: !!known.tera};
  // the log names Hidden Power without its type: take the type from the stats when they have one
  const hp = id => id.startsWith('hiddenpower') ? 'hiddenpower' : id;
  const typedHP = ((e && e.m) || []).map(([mv]) => mv).find(mv => /^hiddenpower./.test(toID(mv)));
  const moves = known.moves.map(m => toID(m.name) === 'hiddenpower' && typedHP ? typedHP : m.name);
  for (const [mv] of (e && e.m) || []) {
    if (moves.length >= 4) break;
    if (!moves.some(x => hp(toID(x)) === hp(toID(mv)))) moves.push(mv);
  }
  // it used a Z-Move of a type none of its moves has: give it one (from the stats if they have one)
  for (const type of known.zTypes || []) {
    if (moves.some(m => Dex.moves.get(m).type === type && Dex.moves.get(m).category !== 'Status')) continue;
    const mv = ((e && e.m) || []).map(([m]) => m).find(m => Dex.moves.get(m).type === type && Dex.moves.get(m).category !== 'Status') ||
      Dex.moves.all().find(m => m.type === type && m.category !== 'Status' && m.basePower >= 70 && !m.isZ && !m.isMax && !m.isNonstandard)?.name;
    if (mv) moves.splice(Math.min(moves.length, 3), moves.length >= 4 ? 1 : 0, mv);
  }
  // (Max Guard came from a status move: Protect, most likely)
  if (known.statusMove && !moves.some(m => Dex.moves.get(m).category === 'Status')) moves.splice(Math.min(moves.length, 3), moves.length >= 4 ? 1 : 0, 'Protect');
  if (!moves.length) moves.push('Tackle');   // never seen moving and no stats: a placeholder to edit (the sim needs a move)
  // (not an Assault Vest on a Pokemon seen using a status move)
  const usedStatus = known.moves.some(m => Dex.moves.get(m.name).category === 'Status');
  let item = known.item || known.lastItem || ((e && e.i) || []).map(([i]) => itemName(i)).find(i => !(usedStatus && toID(i) === 'assaultvest')) || '';
  let ability = known.ability || (e && e.a && e.a[0] ? e.a[0][0] : (sp.abilities ? sp.abilities[0] : ''));
  let tera = known.tera || (e && e.t && e.t[0] ? e.t[0][0] : (sp.types ? sp.types[0] : ''));
  let nature = 'Serious', evs = {hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84};
  if (e && e.s && e.s[0]) ({nature, evs} = parseSpread(e.s[0][0]));
  if (gen <= 2) { nature = ''; evs = {hp: 252, atk: 252, def: 252, spa: 252, spd: 252, spe: 252}; }   // (Showdown's default: all maxed)
  const ivs = hiddenPowerIVs(moves, gen) || {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
  return {name: known.name, species: known.species, level: known.level || 100, gender: known.gender || '',
    moves, item, itemGone: !!known.itemGone, ability, teraType: tera, nature, evs, ivs, fixed};
}
// In gens 2-7 Hidden Power's type comes from the IVs: the IVs that give the type of the set's Hidden Power (null if none).
export function hiddenPowerIVs(moves, gen) {
  const hp = moves.find(m => /^hiddenpower./.test(toID(m)));
  if (!hp || gen < 2 || gen > 7) return null;
  const type = Dex.forGen(gen).types.get(Dex.moves.get(hp).type);
  const ivs = {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
  if (gen === 2) {   // DVs (IV / 2); the HP DV is made from the others' lowest bits
    const dv = {atk: 15, def: 15, spe: 15, spa: 15, ...type.HPdvs};
    const hpDV = (dv.atk & 1) << 3 | (dv.def & 1) << 2 | (dv.spe & 1) << 1 | (dv.spa & 1);
    Object.assign(ivs, {hp: hpDV * 2, atk: dv.atk * 2, def: dv.def * 2, spe: dv.spe * 2, spa: dv.spa * 2, spd: dv.spa * 2});
  } else Object.assign(ivs, type.HPivs || {});
  return ivs;
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
    if (c && c.kind === 'acc' && !c.used) {
      if (c.once) c.used = true;
      return this.rec({key: 'acc:' + c.move, kind: 'chance', label: `${c.move}: accuracy`, who: c.user, p, yes: 'Hits', no: 'Misses'}, p >= 0.5);
    }
    if (c && c.kind === 'endturn') {
      // gens 2-3 roll Quick Claw for the next turn at the end of each one, held or not
      const held = this.battle.sides.some(side => side.active.some(p => p && !p.fainted && p.item === 'quickclaw'));
      if (!held) return r;
      return this.rec({key: 'quickclaw', kind: 'chance', label: 'Quick Claw (next turn)', p, yes: 'Activates', no: "Doesn't"}, p >= 0.5);
    }
    if (c && c.kind === 'sec' && c.old) {
      const s = c.list[c.n++] || {};
      return this.rec({key: 'sec:' + c.move + ':' + (c.n - 1), kind: 'chance', label: `${c.move}: ${effectName(s)} (${Math.round(p * 100)}%)`, who: c.user, p, yes: 'Happens', no: "Doesn't"}, p >= 0.5);
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
    if (c && c.kind === 'sec' && c.old && lo === 0 && hi === 100) return r;   // (gen 2 draws a number it does not use before self boosts)
    if (c && c.kind === 'dmg' && lo === 217 && hi === 256) {
      // gens 1-2: damage times 217-255 / 255; most likely = the middle (236)
      return this.rec({key: 'roll:' + c.move, kind: 'roll', label: `${c.move}: damage roll`, who: c.user, target: c.target, lo, hi}, 236);
    }
    if (c && c.kind === 'dmg' && lo === 0 && hi === 256 && this.battle && this.battle.gen === 2) {
      // gen 2 crits: a number below the crit rate's threshold
      const b = this.battle;
      const ratio = b.clampIntRange(b.runEvent('ModifyCritRatio', c.src, c.tgt, c.mv, c.mv.critRatio || 0), 0, 5);
      const threshold = [0, 17, 32, 64, 85, 128][ratio];
      const crit = this.rec({key: 'crit:' + c.move, kind: 'chance', label: `${c.move}: critical hit`, who: c.user, target: c.target, p: threshold / 256, yes: 'Crit', no: 'No crit'}, false);
      return crit ? 0 : 255;
    }
    if (c && c.kind === 'acc' && hi - lo <= 6 && lo >= 1) {
      // gens 1-4: the number of hits of a multi-hit move
      return this.rec({key: 'hits:' + c.move, kind: 'int', label: `${c.move}: number of hits`, who: c.user, lo, hi}, lo + Math.floor((hi - 1 - lo) / 2));
    }
    if (c && c.kind === 'dmg' && lo === 0 && hi === 16) {
      // most likely = the middle of the 85-100% range (every roll is equally likely; 93% is the median)
      return this.rec({key: 'roll:' + c.move, kind: 'roll', label: `${c.move}: damage roll`, who: c.user, target: c.target, lo, hi}, 7);
    }
    if (c && c.kind === 'sec' && lo === 0 && hi === 100) {
      const s = c.list[c.n++] || {};
      const chance = s.chance;
      if (chance === undefined || chance >= 100) return 0;
      const hit = this.rec({key: 'sec:' + c.move + ':' + (c.n - 1), kind: 'chance', label: `${c.move}: ${effectName(s)} (${chance}%)`, who: c.user, p: chance / 100, yes: 'Happens', no: "Doesn't"}, chance >= 50);
      return hit ? 0 : 99;
    }
    const e = this.effectLabel();
    const named = {slp: 'Sleep turns', confusion: 'Confusion turns', lockedmove: 'Rampage turns', partiallytrapped: 'Trapped turns'}[e.id];
    const label = named || (e.name ? `${e.name}: number` : 'Random number');
    return this.rec({key: 'int:' + (e.id || '') + ':' + lo + '-' + hi, kind: 'int', label, who: e.holder, lo, hi}, lo + Math.floor((hi - 1 - lo) / 2));
  }
  sample(items) {
    const r = this.base.sample(items);
    const c = this.top();
    if (c && c.kind === 'aim') {
      // doubles: a move without a chosen target gets one at random; only for a move that hits one target does it matter
      // (Outrage, a foe that fainted first...), not for spread moves, which the simulator still gives one
      if (!['normal', 'any', 'adjacentFoe', 'randomNormal', 'adjacentAlly'].includes(c.target)) return r;
      const idx = this.rec({key: 'aim:' + c.move, kind: 'pick', label: `${c.move}: target`, who: c.user, options: items.map(x => (x && x.name) || String(x))}, 0);
      return items[idx < 0 ? 0 : idx];
    }
    const e = this.effectLabel();
    // most likely = the most common entry (e.g. 2 or 3 hits from [2,2,3,3,4,5]); first one on a tie
    const counts = new Map(); items.forEach(x => counts.set(x, (counts.get(x) || 0) + 1));
    let best = 0; items.forEach((x, k) => { if (counts.get(x) > counts.get(items[best])) best = k; });
    const label = e.name ? `${e.name}: pick` : (items.every(x => typeof x === 'number') ? 'Number of hits' : 'Random pick');
    const idx = this.rec({key: 'pick:' + (e.id || '') + ':' + items.length, kind: 'pick', label, who: e.holder,
      options: items.map(x => (x && x.name) ? x.name : String(x))}, best);
    return items[idx < 0 ? 0 : idx];
  }
  shuffle(items, start = 0, end = items.length) {
    const c = this.top();
    const seg = items.slice(start, end);
    const names = seg.map(x => {
      const o = x && (x.effectHolder || x.pokemon || x);
      return (o && o.name) ? o.name : (x && x.effect && x.effect.name) || '?';
    });
    // default order: as listed (ties are 50/50, so no order is more likely); keep the base PRNG in step
    this.base.shuffle(items.slice(), start, end);
    const defOrder = seg.map((_, k) => k);
    if (seg.length < 2) return;
    const label = c && c.kind === 'speed' ? `Speed tie: ${names.join(' vs ')}` : `Order: ${names.join(', ')}`;
    const order = this.rec({key: 'order:' + names.join('|'), kind: 'order', label, options: names}, defOrder);
    const out = order.map(k => seg[k]);
    for (let k = 0; k < out.length; k++) items[start + k] = out[k];
  }
}

// What a secondary effect does, for its dice label.
const effectName = s => s.status ? ({brn: 'burn', par: 'paralysis', psn: 'poison', tox: 'bad poison', slp: 'sleep', frz: 'freeze'}[s.status] || s.status)
  : s.volatileStatus ? s.volatileStatus : s.boosts ? 'stat change' : s.self ? 'self effect' : 'effect';

function wrap(obj, name, mk) {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function (...a) { const ctl = this.battle ? this.battle.prng : this.prng; const c = mk(...a); if (c && ctl.push) ctl.push(c); try { return orig.apply(this, a); } finally { if (c && ctl.pop) ctl.pop(); } };
}
export function installRng(battle, ctl) {
  ctl.battle = battle; battle.prng = ctl;
  const A = battle.actions;
  wrap(A, 'hitStepAccuracy', (targets, pokemon, move) => ({kind: 'acc', move: move.name, user: pokemon.name}));
  wrap(A, 'getDamage', (source, target, move) => ({kind: 'dmg', move: (typeof move === 'object' ? move.name : Dex.moves.get(move).name), user: source.name, target: target.name,
    src: source, tgt: target, mv: typeof move === 'object' ? move : battle.dex.getActiveMove(move)}));
  // gens 1-3 check accuracy in their own tryMoveHit, and gens 1-2 roll side effects in moveHit
  if (battle.gen <= 3) wrap(A, 'tryMoveHit', (target, pokemon, move) => ({kind: 'acc', once: true, move: move.name, user: pokemon.name}));
  if (battle.gen <= 2) wrap(A, 'moveHit', (target, pokemon, move, moveData, isSecondary, isSelf) => isSecondary || isSelf ? null
    : {kind: 'sec', old: true, move: move.name, user: pokemon.name, list: ((moveData || move).secondaries || []).filter(s => s.chance !== undefined), n: 0});
  wrap(A, 'secondaries', (targets, source, move, moveData) => ({kind: 'sec', move: move.name, user: source.name, list: (moveData && moveData.secondaries) || move.secondaries || [], n: 0}));
  if (battle.gen === 2 || battle.gen === 3) wrap(battle, 'endTurn', () => ({kind: 'endturn'}));
  wrap(battle, 'getRandomTarget', (pokemon, move) => { const m = Dex.moves.get(move); return {kind: 'aim', move: m.name, target: m.target, user: pokemon.name}; });
  const sp = battle.speedSort;
  battle.speedSort = function (...a) { ctl.push({kind: 'speed'}); try { return sp.apply(this, a); } finally { ctl.pop(); } };
  return ctl;
}

// ---------------------------------------------------------------- takeover: client state at turn t -> live sim battle
function effState(battle, o) { return battle.initEffectState ? battle.initEffectState(o) : o; }
const VOLATILES = ['substitute', 'confusion', 'leechseed', 'taunt', 'encore', 'yawn', 'perishsong', 'curse', 'saltcure', 'aquaring', 'ingrain', 'focusenergy',
  'magnetrise', 'charge', 'stockpile', 'protosynthesis', 'quarkdrive', 'torment', 'disable', 'throatchop', 'healblock', 'smackdown', 'partiallytrapped',
  'flashfire', 'unburden', 'slowstart', 'glaiverush', 'tarshot', 'trapped', 'nightmare', 'embargo', 'imprison', 'gastroacid', 'laserfocus', 'noretreat', 'octolock', 'syrupbomb'];

// Once-per-battle mechanics each side has used before turn t, and the turns a Dynamax still has.
function gimmicksBefore(rep, t) {
  const used = [{}, {}];
  const last = t > rep.lastTurn ? rep.lines.length - 1 : rep.turnIdx[t];   // up to and including "|turn|t"
  for (let i = 0; i <= last; i++) {
    const [, kind, who = '', what = ''] = rep.lines[i].split('|');
    if (kind === 'turn') { for (const u of used) if (u.dynamaxTurns) u.dynamaxTurns--; continue; }   // (it lasts 3 turns)
    if (!/^p[12]/.test(who)) continue;
    const side = used[who.startsWith('p2') ? 1 : 0];
    if (kind === '-mega') side.mega = true;
    else if (kind === '-burst') side.ultra = true;
    else if (kind === '-zpower') side.zmove = true;
    else if (kind === '-start' && what === 'Dynamax') { side.dynamax = true; side.dynamaxTurns = 3; }
    else if (kind === '-end' && what === 'Dynamax') side.dynamaxTurns = 0;
  }
  return used;
}

// The client battle at the end of the replay (it knows every Pokemon the replay reveals), once per replay.
const ends = new WeakMap();
function endOf(rep) {
  if (!ends.has(rep)) ends.set(rep, clientAt(rep, rep.lastTurn + 1));
  return ends.get(rep);
}
// A side's team at some turn, plus the Pokemon the replay only reveals later (without team preview they are not known
// yet, but they are on the team): those are in the back, unhurt.
// (in the end's order, which the sets follow, matched by name: in doubles the client reorders a team as its Pokemon change places)
function withLaterReveals(teamNow, teamAtEnd) {
  const left = teamNow.slice();
  return teamAtEnd.map((p, k) => {
    const j = left.findIndex(x => x.name === p.name);
    if (j >= 0) return left.splice(j, 1)[0];
    return {name: p.name, speciesForme: p.baseSpeciesForme || p.speciesForme, level: p.level, gender: p.gender, hp: 0, maxhp: 0, fainted: false,
      status: '', boosts: {}, volatiles: {}, moveSlots: [], item: '', itemEffect: '', lastItem: '', lastItemEffect: '', ability: '', baseAbility: ''};
  });
}

// sets[side][k] are full sets in the order of the replay's team (as at its end); returns {battle, ctl, notes}
export function takeover(rep, t, sets, seed) {
  const cb = clientAt(rep, t);
  const gimmicks = gimmicksBefore(rep, t);
  const notes = [];
  const battle = new SimBattle(seed ? {formatid: rep.formatid, seed} : {formatid: rep.formatid});
  const sides = [cb.p1, cb.p2];
  const teams = sides.map((cs, si) => withLaterReveals(cs.team, endOf(rep).sides[si].team));
  const order = [], transformed = [];
  const seen = teams.map((team, si) => team.map((p, k) => { const e = endOf(rep).sides[si].team[k]; return !!(p.maxhp || e?.maxhp); }));
  sides.forEach((cs, si) => {
    const team = teams[si];
    // the active Pokemon in their places (an empty place: one that fainted stands in), then the rest, the ones seen in
    // battle first (a format that brings 4 of 6 brings the first 4)
    const front = cs.active.map(p => p ? team.indexOf(p) : -1);
    front.forEach((k, place) => {
      if (k >= 0) return;
      const fainted = team.findIndex((x, j) => !front.includes(j) && (x.fainted || (x.maxhp > 0 && x.hp <= 0)));
      front[place] = fainted >= 0 ? fainted : team.findIndex((_, j) => !front.includes(j));
    });
    const rest = team.map((_, k) => k).filter(k => !front.includes(k));
    const idx = front.filter(k => k >= 0).concat(rest.filter(k => seen[si][k]), rest.filter(k => !seen[si][k]));
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
    const id = cf.weatherState.id === 'snow' ? 'snowscape' : cf.weatherState.id;   // (the client's name for Snowscape)
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
    const teraUsed = teams[si].some(p => p.terastallized);
    const used = gimmicks[si];
    if (used.zmove) ss.zMoveUsed = true;
    if (used.dynamax) ss.dynamaxUsed = true;
    order[si].forEach((k, pos) => {
      const cp = teams[si][k]; const sp = ss.pokemon[pos]; const set = sets[si][k];
      if (!sp) return;   // (not brought)
      // forme changes that persist (Palafin-Hero, Mimikyu-Busted, ...)
      if (cp.speciesForme && toID(cp.speciesForme) !== toID(sp.species.name) && Dex.species.get(cp.speciesForme).exists) {
        try { sp.formeChange(cp.speciesForme, null, true); } catch (e) { notes.push(`${cp.name}: could not set forme ${cp.speciesForme}.`); }
      }
      sp.clearVolatile && sp.clearVolatile(false);
      sp.volatiles = {};
      sp.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0};
      // (a Pokemon not seen in battle yet has hp = maxhp = 0: it is at full HP, not fainted)
      if (cp.fainted || (cp.maxhp > 0 && cp.hp <= 0)) {
        sp.hp = 0; sp.fainted = true; sp.status = 'fnt'; sp.statusState = effState(battle, {id: 'fnt', target: sp}); sp.isActive = sp.isActive && false;
      } else {
        left++;
        const frac = cp.maxhp ? cp.hp / cp.maxhp : 1;
        sp.hp = Math.max(1, Math.min(sp.maxhp, Math.round(frac * sp.maxhp)));
        if (cp.status) {
          // (in gens 1-2 Toxic turns into regular poison once its Pokemon is out of battle)
          const status = battle.gen <= 2 && cp.status === 'tox' && !cs.active.includes(cp) ? 'psn' : cp.status;
          sp.status = status; const st = effState(battle, {id: status, target: sp});
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
      if (used.mega) { sp.canMegaEvo = false; sp.canMegaEvoX = false; sp.canMegaEvoY = false; }
      if (used.ultra) sp.canUltraBurst = null;
      // active Pokemon details
      if (cs.active.includes(cp) && !sp.fainted) {
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
          if (vid === 'imprison') st.source = sp;
          if (vid === 'perishsong') st.duration = (v.level || 3) + 1;
          if (vid === 'magnetrise') st.duration = 5;
          if (vid === 'stockpile') st.layers = v.level || 1;
          if (vid === 'protosynthesis' || vid === 'quarkdrive') st.bestStat = v.stat || sp.getBestStat?.(false, true) || 'spe';
          if (vid === 'leechseed') { const foe = battle.sides[1 - si].active[0]; if (foe) st.sourceSlot = foe.getSlot(); }
          if (vid === 'partiallytrapped') { const foe = battle.sides[1 - si].active[0]; st.source = foe; st.duration = 3; st.sourceEffect = Dex.moves.get(v.id || 'wrap'); }
          sp.volatiles[vid] = st;
        }
        if (cp.volatiles?.transform) transformed.push([sp, si, cp.speciesForme]);
        // gens 1-2 keep Toxic's count in a hidden effect of its own (gen 2 cannot do without it)
        if (battle.gen <= 2 && cp.status === 'tox') {
          sp.volatiles.residualdmg = effState(battle, {id: 'residualdmg', target: sp, counter: Math.max(1, cp.statusState?.toxicTurns || 1)});
        }
        // choice lock
        const it = Dex.items.get(sp.item);
        if (it.isChoice && cp.lastMove && cp.lastMove !== 'switch-in' && cp.movesUsedWhileActive && cp.movesUsedWhileActive.length) {
          sp.volatiles.choicelock = effState(battle, {id: 'choicelock', target: sp, move: cp.lastMove});
        }
        sp.activeMoveActions = cp.movesUsedWhileActive ? cp.movesUsedWhileActive.length : 1;
        sp.activeTurns = Math.max(1, sp.activeMoveActions);
        sp.lastMove = cp.lastMove && cp.lastMove !== 'switch-in' ? battle.dex.getActiveMove(cp.lastMove) : null;   // (an active move: a plain Move does not survive save and restore)
        if (used.dynamaxTurns > 0) {   // still Dynamaxed: doubles its HP, as it was
          sp.addVolatile('dynamax');
          if (sp.volatiles.dynamax) sp.volatiles.dynamax.duration = used.dynamaxTurns;
        }
      }
    });
    ss.pokemonLeft = left;
  });
  // (after every Pokemon is in place: a Transform copies the one it transformed into, on the other side)
  for (const [sp, si, species] of transformed) {
    const into = battle.sides[1 - si].active.find(p => p && toID(p.species.name) === toID(species)) || battle.sides[1 - si].active[0];
    if (into) try { sp.transformInto(into, Dex.moves.get('transform')); } catch (e) { notes.push(`${sp.name}: could not carry its Transform over.`); }
  }
  battle.turn = t;
  battle.makeRequest('move');
  battle.log.push(`|takeover|${t}`);
  return {battle, order, notes};
}

// Team preview: a fresh battle with both teams (in the replay's team order), waiting for each player's lead choice ("team N").
// Returns null when the format has no team preview.
export function previewBattle(rep, sets, seed) {
  const cb = clientAt(rep, rep.lastTurn + 1);
  const battle = new SimBattle(seed ? {formatid: rep.formatid, seed} : {formatid: rep.formatid});
  [cb.p1, cb.p2].forEach((cs, si) => {
    const team = sets[si].map(s => ({name: s.name, species: s.species, item: s.item || '', ability: s.ability || '', moves: s.moves.filter(Boolean),
      nature: s.nature || 'Serious', evs: s.evs, ivs: s.ivs, level: s.level || 100, gender: s.gender || '', teraType: s.teraType || undefined, shiny: false}));
    battle.setPlayer(si ? 'p2' : 'p1', {name: cs.name || (si ? 'Player 2' : 'Player 1'), team});
  });
  return battle.requestState === 'teampreview' ? battle : null;
}
// The leads the replay's players sent out: {p1: first lead, p1a, p1b (doubles), p2, ...}.
export function replayLeads(rep) {
  const start = rep.lines.findIndex(l => l === '|start');
  const leads = {};
  for (const l of rep.lines.slice(start + 1)) {
    const m = /^\|switch\|(p[12])([a-c]): ([^|]+)\|/.exec(l);
    if (m && !leads[m[1] + m[2]]) leads[m[1] + m[2]] = m[3];
    if (l.startsWith('|turn|')) break;
  }
  for (const p of ['p1', 'p2']) leads[p] = leads[p + 'a'];
  return leads;
}

// The usage stats to use for a format: its own, else those of its series (gen9vgc2026regi -> gen9vgc2026; Bo3 alike).
export function statsFormat(formatid, available) {
  for (const id of [formatid, formatid.replace(/bo3$/, ''), formatid.replace(/bo3$/, '').replace(/reg[a-z]+$/, '')]) if (id in available) return id;
  return null;
}

// The names move n of a request's Pokemon can show up under in the log: itself, its Z-Move, its Max Move.
// (The log calls every Hidden Power just that, and Return / Frustration without the power the request adds in old gens.)
export function moveNames(active, n) {
  return [active.moves[n - 1]?.move, active.canZMove?.[n - 1]?.move, active.maxMoves?.maxMoves?.[n - 1]?.move].filter(Boolean)
    .map(m => toID(m).replace(/^hiddenpower.+/, 'hiddenpower').replace(/^(return|frustration)\d+$/, '$1'));
}

// ---------------------------------------------------------------- doubles targets
// A move (from a request) that takes a target in doubles, and the targets the menu offers: 1, 2 the foes' places,
// -1, -2 your own (the simulator's numbers).
const TARGETED = {normal: 'foes ally', any: 'foes ally', adjacentFoe: 'foes', adjacentAlly: 'ally', adjacentAllyOrSelf: 'ally self'};
// The target kind of move i of a request's Pokemon used with this gimmick (as a Max Move or Z-Move it can differ); none
// for a move it is locked into, which the request lists without one.
export function targetType(act, i, gimmick = '') {
  if (gimmick === 'dynamax' || (act.maxMoves && !act.canDynamax)) return act.maxMoves?.maxMoves?.[i]?.target || '';
  if (gimmick === 'zmove' && act.canZMove?.[i]) return act.canZMove[i].target || '';
  return act.moves[i]?.target || '';
}
export const needsTarget = type => type in TARGETED;
export function targetsFor(type, battle, si, place) {
  const kinds = TARGETED[type];
  if (!kinds) return [];
  const up = p => p && !p.fainted;
  const foes = battle.sides[1 - si].active.map((p, k) => up(p) ? k + 1 : 0).filter(Boolean);
  const out = [];
  if (kinds.includes('foes')) out.push(...(foes.length ? foes : battle.sides[1 - si].active.map((_, k) => k + 1)));
  const other = battle.sides[si].active.findIndex((p, k) => k !== place && up(p));
  if (kinds.includes('ally') && other >= 0) out.push(-(other + 1));
  if (kinds.includes('self')) out.push(-(place + 1));
  if (!out.length && kinds.includes('ally')) out.push(-((place ^ 1) + 1));
  return out;
}
// Where the Pokemon a log line names ('p2b: Name') stands, as a target from side si's place (null if the move takes none
// or could not have aimed there).
export function targetLoc(type, ident, si, place) {
  const kinds = TARGETED[type], at = /^p([12])([a-c])/.exec(ident || '');
  if (!kinds || !at) return null;
  const k = 'abc'.indexOf(at[2]), loc = +at[1] - 1 === si ? -(k + 1) : k + 1;
  const ok = loc > 0 ? kinds.includes('foes') : k === place ? kinds.includes('self') : kinds.includes('ally');
  return ok ? loc : null;
}

const GIMMICKS = {'-terastallize': 'terastallize', '-mega': 'mega', '-burst': 'ultra', '-zpower': 'zmove'};
// What each Pokemon on the field did in turn t, by side and place (a, b): {kind: 'move', name, target (the ident it
// hit, if the log names one) | 'switch', name | 'cant'} and the once-per-battle mechanic it used ({gimmick}).
// A Pokemon that fainted before acting never showed its choice ('cant'), and the switch-in that follows is not it;
// a move it could not use (blocked by Taunt and the like) shows in its can't-move line.
export function playedActions(rep, t) {
  const out = [[], []], gimmick = [[], []];
  const a = rep.turnIdx[t], b = rep.turnIdx[t + 1] ?? rep.lines.length;
  for (const line of rep.lines.slice(a + 1, b)) {
    const parts = line.split('|'), [, kind, who = '', what = ''] = parts;
    const m = /^p([12])([a-c])?: /.exec(who);
    if (!m) continue;
    const si = +m[1] - 1, place = m[2] ? 'abc'.indexOf(m[2]) : 0;
    gimmick[si][place] ||= GIMMICKS[kind] || (kind === '-start' && what === 'Dynamax' ? 'dynamax' : '');
    if (out[si][place]) continue;
    if (kind === 'faint') out[si][place] = {kind: 'cant'};
    // (a Pledge another Pokemon's Pledge joined is still its own choice)
    else if (kind === 'move' && what === 'Struggle') out[si][place] = {kind: 'cant'};
    else if (kind === 'move' && (!line.includes('[from]') || /\[from\] ?move: \w+ Pledge/.test(line))) out[si][place] = {kind: 'move', name: what, target: /^p[12][a-c]: /.test(parts[4] || '') ? parts[4] : ''};
    else if (kind === 'switch') out[si][place] = {kind: 'switch', name: who.replace(/^p\d[a-c]?: /, '')};
    else if (kind === 'cant') out[si][place] = parts[4] ? {kind: 'move', name: parts[4], target: ''} : {kind: 'cant'};
  }
  return out.map((places, si) => places.map((p, place) => p && {...p, gimmick: gimmick[si][place] || ''}));
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
  battle.sentLogPos = start;   // (the simulator takes 1000 lines unsent for an endless loop; a long line's log is all unsent)
  // Only choices still owed, and none once the battle has moved on: a side can already be done choosing (its choice
  // made before the save), and then the first choice runs the turn and the next request is a different one.
  const asked = battle.requestState, turn = battle.turn;
  for (const [i, s] of [[0, 'p1'], [1, 'p2']]) {
    const side = battle.sides[i], req = side.activeRequest;
    if (battle.requestState !== asked || battle.turn !== turn || battle.ended) break;
    if (!req || req.wait || side.isChoiceDone()) continue;
    const ok = battle.choose(s, choices[s] || 'default');
    if (!ok) throw new Error(`${s}: ${side.choice.error || 'invalid choice'}`);
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

// ---------------------------------------------------------------- move list
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
