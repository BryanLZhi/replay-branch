// Replay Study core: replay parsing, state at a turn, takeover into a live sim battle, and user-controlled RNG.
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
  if (!lines.some(l => l.startsWith('|start') || l.startsWith('|teampreview'))) throw new Error('No battle found: paste the replay log (it starts with lines like "|player|p1|...").');
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
  const lastTurn = Math.max(0, turnIdx.length - 1);   // (a battle that stops at team preview has turn 0 only)
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
  // (the log's |upkeep| lines already run the client's end of turn; at the end of a replay there may be none after the last)
  if (t > rep.lastTurn) try { cb.upkeep && cb.upkeep(); } catch {}
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
  const found = stats[sp.name] || stats[sp.baseSpecies] || stats[species];
  if (found) return found;
  // (some months list a Pokemon only as its Mega Evolution or Primal Reversion: Mawile-Mega)
  const formes = Object.keys(stats).filter(k => { const f = Dex.species.get(k); return f.baseSpecies === sp.baseSpecies && (f.isMega || f.isPrimal); });
  return formes.sort((a, b) => (stats[b].u || 0) - (stats[a].u || 0)).map(k => stats[k])[0] || null;
}
export function knownOf(p) {
  const moves = p.moveSlots.filter(m => !m.virtual).map(m => ({name: m.name.replace(/^move: /, ''), ppUsed: Array.isArray(m.ppUsed) ? m.ppUsed[0] : (m.ppUsed || 0)}));
  // (up to gen 4 a knocked off item stays held, unusable: the client marks the item itself)
  const lostItem = ['knocked off', 'stolen', 'eaten', 'flung', 'consumed', 'incinerated', 'popped'].includes(p.lastItemEffect) || p.itemEffect === 'knocked off' ||
    !!p.volatiles?.itemremoved || (!p.item && !!p.lastItem);
  const curItem = p.item ? itemName(p.item) : '';
  const lastItemName = p.lastItem ? itemName(p.lastItem) : '';
  // a set is for the forme it starts in (Alakazam, not Alakazam-Mega; Palafin, not Palafin-Hero), with that forme's ability;
  // a Pokemon still transformed is what it was before (a Mew, not the Landorus it copied)
  const forme = p.volatiles?.transform ? (p.baseSpeciesForme || p.speciesForme) : p.speciesForme;
  const battleOnly = Dex.species.get(forme).battleOnly;
  const startForme = Dex.species.get((Array.isArray(battleOnly) ? battleOnly[0] : battleOnly) || forme);
  let abilityName = (p.baseAbility || p.ability) ? Dex.abilities.get(p.baseAbility || p.ability).name : '';
  if ((battleOnly || p.volatiles?.transform) && !Object.values(startForme.abilities || {}).includes(abilityName)) abilityName = '';
  return {
    name: p.name, species: (Array.isArray(battleOnly) ? battleOnly[0] : battleOnly) || forme, baseSpecies: p.baseSpeciesForme,
    level: p.level, gender: p.gender,
    moves, item: curItem, lastItem: lastItemName, itemGone: lostItem && (!p.item || p.itemEffect === 'knocked off'), ability: abilityName,
    tera: p.terastallized || (p.teraType && p.teraType !== '???' ? p.teraType : ''),
  };
}
// Whose ability is whose where the log shows abilities changing hands (Skill Swap, Wandering Spirit, Role Play, Simple
// Beam, Trace, Mummy...): by side, name -> the one it had of its own (shown as the old one, before any change since it came
// in and before any lasting forme change), and the ones it was given.
function ownAbilities(rep) {
  const own = [new Map(), new Map()], got = [new Map(), new Map()], changed = [new Set(), new Set()], reformed = [new Set(), new Set()];
  const first = [new Map(), new Map()];   // (the forme it first came in as)
  const firstOwn = (w, ability) => Object.values(Dex.species.get(first[w[0]].get(w[1]) || '').abilities || {}).includes(ability);
  const who = ident => { const m = /^p([12])[a-c]?: (.+)$/.exec(ident || ''); return m ? [+m[1] - 1, m[2]] : null; };
  const had = (w, ability) => {
    if (ability && !changed[w[0]].has(w[1]) && !reformed[w[0]].has(w[1]) && !own[w[0]].has(w[1])) own[w[0]].set(w[1], Dex.abilities.get(ability).name);
    changed[w[0]].add(w[1]);
  };
  const gave = (w, ability) => { if (!got[w[0]].has(w[1])) got[w[0]].set(w[1], new Set()); got[w[0]].get(w[1]).add(toID(ability)); };
  for (const line of rep.lines) {
    const a = line.split('|');
    // (an ability it shows while holding another one, or in a forme it changed to, is not its own: one transformed, Mega
    // Charizard Y's Drought...)
    const from = /\|\[from\] ability: ([^|]+)/.exec(line), of = who((a.find(s => s.startsWith('[of] ')) || '').slice(5));
    const shown = a[1] === '-ability' ? !/\|\[from\]/.test(line) && [who(a[2]), a[3]] : a[1] === '-item' ? null :
      a[1] === '-activate' && /^ability: /.test(a[3]) ? [who(a[2]), a[3].slice(9)] : from ? [of || who(a[2]), from[1]] : null;
    const w = shown && shown[1] && shown[0];
    // (Palafin-Hero's Zero to Hero was Palafin's too)
    if (w && (changed[w[0]].has(w[1]) || (reformed[w[0]].has(w[1]) && !firstOwn(w, shown[1])))) gave(w, shown[1]);
    const x = who(a[2]);
    if (!x) continue;
    if (['switch', 'drag', 'replace'].includes(a[1])) {
      changed[x[0]].delete(x[1]);
      if (!first[x[0]].has(x[1])) first[x[0]].set(x[1], (a[3] || '').split(',')[0]);
    } else if (a[1] === 'detailschange') reformed[x[0]].add(x[1]);
    else if (a[1] === '-ability' && /\|\[from\]/.test(line) && !/\|\[fail\]/.test(line)) {
      // (the old one is named after the new one; without it, Trace and the like are its own)
      const by = /\|\[from\] ability: (Trace|Receiver|Power of Alchemy)(\||$)/.exec(line);
      const old = a[4] && !a[4].startsWith('[') ? a[4] : by ? by[1] : '';
      if (old && reformed[x[0]].has(x[1]) && !firstOwn(x, old)) gave(x, old);   // (Mega Alakazam's Trace)
      had(x, old); gave(x, a[3]);
    } else if (a[1] === '-activate' && /^(move: )?Skill Swap$/.test(a[3])) {
      const y = who((a.find(s => s.startsWith('[of] ')) || '').slice(5));
      if (!y) continue;
      had(x, a[5]); had(y, a[4]);
      if (a[4]) gave(x, a[4]);
      if (a[5]) gave(y, a[5]);
    } else if (a[1] === '-activate' && /^ability: (Mummy|Lingering Aroma)$/.test(a[3])) {
      const y = who(a[4]), old = (a.find(s => s.startsWith('[ability] ')) || '').slice(10);
      if (y) { had(y, old); gave(y, a[3].slice(9)); }
    } else if (a[1] === '-transform') changed[x[0]].add(x[1]);
  }
  return {own, got};
}
// What the replay reveals about each side's Pokemon (knownOf, in team order), including the Z-Crystal behind a Z-Move.
export function revealedTeams(rep) {
  const known = endOf(rep).sides.slice(0, 2).map(side => side.team.map(knownOf));
  // (the client can take an ability another Pokemon or a move gave for the Pokemon's own)
  const {own, got} = ownAbilities(rep);
  known.forEach((team, si) => team.forEach(mon => {
    const a = own[si].get(mon.name);
    if (a) mon.ability = a; else if (got[si].get(mon.name)?.has(toID(mon.ability))) mon.ability = '';
    // (the log names As One without its half: the Neigh it shows with it, or Calyrex's own)
    if (toID(mon.ability) === 'asone') {
      const neigh = rep.lines.find(l => l.startsWith(`|-ability|p${si + 1}`) && l.split('|')[2].replace(/^p\d[a-c]?: /, '') === mon.name && /\|(Grim|Chilling) Neigh/.test(l));
      mon.ability = (neigh ? /Grim Neigh/.test(neigh) : mon.species === 'Calyrex-Shadow') ? 'As One (Spectrier)' : 'As One (Glastrier)';
    }
  }));
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
  // a move Mimic copied is not one of its own (Mimic fails on a move it has), and a move Sketch copied was Sketch to begin with
  for (const line of rep.lines) {
    const m = /^\|(?:-start|-activate)\|(p[12])[a-c]?: ([^|]+)\|(?:move: )?(Mimic|Sketch)\|([^|]+)/.exec(line);
    const mon = m && known[m[1] === 'p2' ? 1 : 0].find(k => k.name === m[2]);
    if (!mon) continue;
    mon.moves = mon.moves.filter(x => toID(x.name) !== toID(m[4]));
    if (m[3] === 'Sketch' && !mon.moves.some(x => toID(x.name) === 'sketch')) mon.moves.push({name: 'Sketch', ppUsed: 1});
  }
  // a Pokemon seen using two different moves in one stay in battle holds no Choice item (unless items changed hands meanwhile)
  known.forEach((team, si) => team.forEach(mon => {
    let used = new Set();
    for (const line of rep.lines) {
      const a = line.split('|');
      if (!(a[2] || '').startsWith('p' + (si + 1)) || a[2].replace(/^p\d[a-c]?: /, '') !== mon.name) continue;
      if (['switch', 'drag', 'replace', '-item', '-enditem'].includes(a[1])) used = new Set();
      else if (a[1] === 'move' && !/\[from\]/.test(line)) {
        const m = Dex.moves.get(a[3]);
        if (m.exists && !m.isZ && !m.isMax && m.id !== 'struggle') used.add(m.id);
      }
      if (used.size > 1) { mon.notChoice = true; break; }
    }
  }));
  // a Pokemon the replay shows Gigantamaxed can Gigantamax (its set needs to say so for its G-Max Move)
  for (const line of rep.lines) {
    const m = /^\|(?:detailschange|-formechange|switch|drag|replace)\|(p[12])[a-c]?: ([^|]+)\|[^|,]*-Gmax/.exec(line) ||
      /^\|-start\|(p[12])[a-c]?: ([^|]+)\|Dynamax\|Gmax/.exec(line);
    const mon = m && known[m[1] === 'p2' ? 1 : 0].find(k => k.name === m[2]);
    if (mon) mon.gigantamax = true;
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
  // (not an Assault Vest on a Pokemon seen using a status move, nor a Choice item on one seen using two moves in a row)
  const usedStatus = known.moves.some(m => Dex.moves.get(m.name).category === 'Status');
  let item = known.item || known.lastItem || ((e && e.i) || []).map(([i]) => itemName(i))
    .find(i => !(usedStatus && toID(i) === 'assaultvest') && !(known.notChoice && Dex.items.get(i).isChoice)) || '';
  let ability = known.ability || (e && e.a && e.a[0] ? e.a[0][0] : (sp.abilities ? sp.abilities[0] : ''));
  // (stats listed under a Mega Evolution have its ability, Huge Power for Mawile: before it Mega Evolves it has its own)
  if (!known.ability && sp.abilities && gen >= 3 && !Object.values(sp.abilities).includes(ability)) ability = sp.abilities[1] || sp.abilities[0];
  let tera = known.tera || (e && e.t && e.t[0] ? e.t[0][0] : (sp.types ? sp.types[0] : ''));
  let nature = 'Serious', evs = {hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84};
  if (e && e.s && e.s[0]) ({nature, evs} = parseSpread(e.s[0][0]));
  if (gen <= 2) { nature = ''; evs = {hp: 252, atk: 252, def: 252, spa: 252, spd: 252, spe: 252}; }   // (Showdown's default: all maxed)
  const ivs = hiddenPowerIVs(moves, gen) || {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31};
  return {name: known.name, species: known.species, level: known.level || 100, gender: known.gender || '',
    moves, item, itemGone: !!known.itemGone, ability, teraType: tera, nature, evs, ivs, fixed, ...(known.gigantamax ? {gigantamax: true} : {})};
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
      const target = c.targets?.[c.n++];
      return this.rec({key: 'acc:' + c.move, kind: 'chance', label: `${c.move}: accuracy`, who: c.user, target, p, yes: 'Hits', no: 'Misses'}, p >= 0.5);
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
      const k = c.n++, s = c.list[k % Math.max(1, c.list.length)] || {};
      const chance = s.chance;
      if (chance === undefined || chance >= 100) return 0;
      const target = c.targets?.[Math.floor(k / Math.max(1, c.list.length))];
      const hit = this.rec({key: 'sec:' + c.move + ':' + (k % Math.max(1, c.list.length)), kind: 'chance', label: `${c.move}: ${effectName(s)} (${chance}%)`, who: c.user, target, p: chance / 100, yes: 'Happens', no: "Doesn't"}, chance >= 50);
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
    if (new Set(names).size < names.length) return;   // (two effects of the same Pokemon: as listed)
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
  wrap(A, 'hitStepAccuracy', (targets, pokemon, move) => ({kind: 'acc', move: move.name, user: pokemon.name, targets: (targets || []).map(t => t?.name), n: 0}));
  wrap(A, 'getDamage', (source, target, move) => ({kind: 'dmg', move: (typeof move === 'object' ? move.name : Dex.moves.get(move).name), user: source.name, target: target.name,
    src: source, tgt: target, mv: typeof move === 'object' ? move : battle.dex.getActiveMove(move)}));
  // gens 1-3 check accuracy in their own tryMoveHit, and gens 1-2 roll side effects in moveHit
  if (battle.gen <= 3) wrap(A, 'tryMoveHit', (target, pokemon, move) => ({kind: 'acc', once: true, move: move.name, user: pokemon.name}));
  if (battle.gen <= 2) wrap(A, 'moveHit', (target, pokemon, move, moveData, isSecondary, isSelf) => isSecondary || isSelf ? null
    : {kind: 'sec', old: true, move: move.name, user: pokemon.name, list: ((moveData || move).secondaries || []).filter(s => s.chance !== undefined), n: 0});
  wrap(A, 'secondaries', (targets, source, move, moveData) => ({kind: 'sec', move: move.name, user: source.name, list: (moveData && moveData.secondaries) || move.secondaries || [], n: 0,
    targets: (Array.isArray(targets) ? targets : [targets]).map(t => t?.name)}));
  if (battle.gen === 2 || battle.gen === 3) wrap(battle, 'endTurn', () => ({kind: 'endturn'}));
  wrap(battle, 'getRandomTarget', (pokemon, move) => { const m = Dex.moves.get(move); return {kind: 'aim', move: m.name, target: m.target, user: pokemon.name}; });
  const sp = battle.speedSort;
  battle.speedSort = function (...a) { ctl.push({kind: 'speed'}); try { return sp.apply(this, a); } finally { ctl.pop(); } };
  return ctl;
}

// ---------------------------------------------------------------- takeover: client state at turn t -> live sim battle
function effState(battle, o) { return battle.initEffectState ? battle.initEffectState(o) : o; }
// Effects the log shows starting in the turns before t that the client does not keep (or keeps differently), set up with the
// simulator's own functions and then wound on by the turn that passed: a two-turn move being charged (Fly, Dig, Solar Beam...),
// an Outrage-style lock, Protect's falling odds when used in a row, Rollout / Ice Ball, Future Sight / Doom Desire, Wish,
// Lock-On / Mind Reader, a trap tied to its maker (Mean Look, Block, Spider Web), the Metronome item's count, the last move
// used (Copycat) and the Pokemon that fainted last turn (Retaliate).
function fromRecentTurns(rep, t, battle, notes) {
  if (t < 2 || rep.turnIdx[t - 1] === undefined) return;
  const linesOf = u => rep.lines.slice(rep.turnIdx[u] + 1, rep.turnIdx[u + 1] ?? rep.lines.length);
  const parse = l => { const a = l.split('|'); return {kind: a[1], who: a[2] || '', what: a[3] || '', whom: a[4] || '', line: l}; };
  const monOf = ident => {
    const m = /^p([12])([a-c])?: (.+)$/.exec(ident || '');
    return m ? battle.sides[+m[1] - 1].pokemon.find(p => p.name === m[3]) || null : null;
  };
  const isActive = p => p && p.isActive && !p.fainted;
  const last = linesOf(t - 1).map(parse);
  // moves each Pokemon used in turn u (not ones another move called), in order
  const usesIn = (u, mon) => linesOf(u).map(parse).filter(x => x.kind === 'move' && monOf(x.who) === mon && !/\[from\]/.test(x.line));
  const settle = st => { if (st && st.duration > 1) st.duration--; };   // (the end of turn t - 1 has passed)

  for (const side of battle.sides) for (const mon of side.active) {
    if (!isActive(mon)) continue;
    const used = usesIn(t - 1, mon), lastUse = used[used.length - 1];
    // how its move went last turn (Stomping Tantrum reads it): true, false when it failed or missed, null when it was charging
    // or a protection stopped it; for one that could not move, false, or null when recharging (which gave it no choice)
    const act = last.filter(x => x.kind === 'move' && monOf(x.who) === mon && (!/\[from\]/.test(x.line) || /\[from\] ?lockedmove/.test(x.line))).pop();
    if (act) {
      const rest = last.slice(last.findIndex(x => x.line === act.line) + 1), next = rest.findIndex(x => x.kind === 'move');
      const own = next < 0 ? rest : rest.slice(0, next);
      if (/\[still\]/.test(act.line) && own.some(x => x.kind === '-prepare')) mon.moveLastTurnResult = null;
      else if (own.some(x => x.kind === '-activate' && /Protect|Detect|Shield|Bunker|Obstruct|Silk Trap|Bulwark|Max Guard/.test(x.what))) mon.moveLastTurnResult = null;
      else if (/\[(still|notarget|miss)\]/.test(act.line) || own.some(x => ['-fail', '-miss', '-immune'].includes(x.kind))) mon.moveLastTurnResult = false;
      else mon.moveLastTurnResult = true;
    } else {
      const cant = last.find(x => x.kind === 'cant' && monOf(x.who) === mon);
      const hurt = last.some(x => x.kind === '-damage' && monOf(x.who) === mon && /\[from\] confusion/.test(x.line));
      if (cant) mon.moveLastTurnResult = cant.what === 'recharge' ? null : false;
      else if (hurt) mon.moveLastTurnResult = false;
    }
    // a two-turn move charged last turn and not yet used
    const prep = last.filter(x => x.kind === '-prepare' && monOf(x.who) === mon).pop();
    // (a Power Herb used up right after it means the move went off at once, and so does its "-anim" line, as Solar Beam in sun)
    const fired = prep && last.slice(last.indexOf(prep) + 1).some(x => (['move', '-anim'].includes(x.kind) && monOf(x.who) === mon) ||
      (x.kind === '-enditem' && monOf(x.who) === mon && /Power Herb/.test(x.what)));
    if (prep && !fired) {
      const move = battle.dex.getActiveMove(prep.what), target = monOf(prep.whom) || mon.side.foe.active.find(isActive) || mon;
      if (battle.gen >= 3) mon.lastMoveTargetLoc = mon.getLocOf(move.target === 'self' ? mon : target);   // (the slot it is aimed at)
      mon.addVolatile('twoturnmove', target, move);
      settle(mon.volatiles.twoturnmove); settle(mon.volatiles[move.id]);
      if (battle.gen === 1 && ['dig', 'fly'].includes(move.id)) mon.addVolatile('invulnerability', target);
    }
    if (battle.gen === 1 && !prep) gen1Charge(rep, t, battle, mon, isActive);
    // Outrage, Thrash, Petal Dance...: locked in after its first use (unless it missed, gen 3 on) until it tires out (confused by
    // fatigue) or falls asleep (gen 2 on). Uses going on show "[from]lockedmove" (gen 1: "[from] <the move>", gen 2: nothing).
    const fromOf = x => toID((/\[from\] ?([^|]+)/.exec(x.line) || [])[1] || '');
    const ownUse = u => linesOf(u).map(parse).filter(x => x.kind === 'move' && monOf(x.who) === mon &&
      (!fromOf(x) || fromOf(x) === 'lockedmove' || fromOf(x) === toID(x.what))).pop();
    const tiredIn = u => linesOf(u).map(parse).some(x => x.kind === '-start' && monOf(x.who) === mon && x.what === 'confusion' && /\[(fatigue|silent)\]/.test(x.line));
    // (gen 1 keeps the lock through turns it could not move: trapped, flinching, asleep)
    let lockTurn = t - 1;
    const ended = u => linesOf(u).map(parse).some(x => monOf(x.who) === mon && (['switch', 'drag'].includes(x.kind) ||
      (x.kind === 'cant' && x.what === 'par') || (x.kind === '-damage' && /\[from\] confusion/.test(x.line))));
    if (battle.gen === 1) while (lockTurn > 1 && !ownUse(lockTurn) && !ended(lockTurn)) lockTurn--;
    const lockUse = ownUse(lockTurn), lockMove = lockUse && battle.dex.getActiveMove(lockUse.what);
    if (lockMove?.self?.volatileStatus === 'lockedmove' && !tiredIn(lockTurn) && !(battle.gen >= 2 && mon.status === 'slp')) {
      const lines = linesOf(lockTurn).map(parse);
      const rest = lines.slice(lines.findIndex(x => x.line === lockUse.line) + 1), next = rest.findIndex(x => x.kind === 'move');
      const own = next < 0 ? rest : rest.slice(0, next);
      const missed = /\[(miss|notarget|still)\]/.test(lockUse.line) || own.some(x => ['-fail', '-miss', '-immune'].includes(x.kind) ||
        (x.kind === '-activate' && /Protect|Detect|Shield|Bunker|Obstruct|Silk Trap|Bulwark|Max Guard/.test(x.what)));
      let k = 0;   // (its uses in a row so far)
      for (let u = lockTurn; u >= 1; u--) {
        const y = ownUse(u);
        if (!y || toID(y.what) !== lockMove.id || (u < lockTurn && tiredIn(u))) break;
        k++;
        if (battle.gen !== 2 && !fromOf(y)) break;
      }
      if (!(battle.gen >= 3 && missed)) {
        mon.addVolatile('lockedmove', mon, lockMove);
        const st = mon.volatiles.lockedmove;
        // (how long it lasts is random: 2 or 3 uses, gen 1 3 or 4; after 2 uses it is the last)
        if (st && battle.gen === 1) { st.time = k >= 2 ? 1 : 2; st.accuracy = gen1LockAccuracy(mon, k); }
        else if (st) { settle(st); if (k >= 2) st.duration = 1; if (battle.gen >= 3) st.trueDuration = k >= 2 ? 1 : 2; }
      }
    }
    // gen 1 Rage: locked in until it leaves
    if (battle.gen === 1 && lockMove?.id === 'rage') {
      let k = 0;
      for (let u = lockTurn; u >= 1 && toID(ownUse(u)?.what || '') === 'rage'; u--) k++;
      mon.addVolatile('rage');
      if (mon.volatiles.rage) mon.volatiles.rage.accuracy = gen1LockAccuracy(mon, k);
    }
    // Rollout / Ice Ball: the hits in a row so far (a miss ends it, and so does the fifth); Fury Cutter's power likewise
    // (it doubles with each hit in a row, up to 16 times, gen 5 8, gen 6 on 4)
    const lockHit = lockUse && lockTurn === t - 1 && (() => {
      const lines = linesOf(t - 1).map(parse), at = lines.findIndex(x => x.line === lockUse.line), next = lines.findIndex((x, i) => i > at && x.kind === 'move');
      return !/\[(miss|notarget|still)\]/.test(lockUse.line) && !lines.slice(at + 1, next < 0 ? undefined : next).some(x => ['-fail', '-miss', '-immune'].includes(x.kind) ||
        (x.kind === '-activate' && /Protect|Detect|Shield|Bunker|Obstruct|Silk Trap|Bulwark|Max Guard/.test(x.what)));
    })();
    if (lockHit && ['rollout', 'iceball', 'furycutter'].includes(lockMove.id)) {
      let n = 0;
      for (let u = t - 1; u >= 1; u--) {
        const y = ownUse(u);
        if (!y || toID(y.what) !== lockMove.id) break;
        n++;
        if (lockMove.id !== 'furycutter' && battle.gen >= 3 && !fromOf(y)) break;
      }
      if (lockMove.id === 'furycutter') {
        mon.addVolatile('furycutter');
        const most = battle.gen <= 4 ? 16 : battle.gen === 5 ? 8 : 4;   // (gen 2 doubles it on the first hit too)
        if (mon.volatiles.furycutter) Object.assign(mon.volatiles.furycutter, {multiplier: Math.min(most, 2 ** (battle.gen === 2 ? n : n - 1)), duration: 1});
      } else if (battle.gen === 2) n = (n - 1) % 5 + 1;   // (gen 2 does not mark the uses that go on: it starts again after 5)
      if (lockMove.id !== 'furycutter' && n < 5) {
        mon.addVolatile(lockMove.id);
        const st = mon.volatiles[lockMove.id];
        if (st) { st.hitCount = n; st.contactHitCount = n; st.duration = 1; }
      }
    }
    if (!lastUse) continue;
    const move = battle.dex.getActiveMove(lastUse.what);
    const after = last.slice(last.indexOf(lastUse) + 1);
    const failed = after.find(x => x.kind === 'move' || x.kind === 'turn') ? false : false;
    // Protect and the like, used successfully in a row up to last turn
    // (Wide Guard and Quick Guard count too from gen 6, though their own odds do not fall)
    const stalls = id => battle.dex.moves.get(id).stallingMove || (battle.gen >= 6 && ['wideguard', 'quickguard'].includes(toID(id)));
    if (stalls(move.id)) {
      let n = 0;
      for (let u = t - 1; u >= 1; u--) {
        const x = usesIn(u, mon).pop();
        if (!x || !stalls(x.what)) break;
        const rest = linesOf(u).map(parse); const i = rest.findIndex(y => y.line === x.line);
        if (rest.slice(i + 1, i + 3).some(y => y.kind === '-fail' && monOf(y.who) === mon)) break;
        n++;
      }
      for (let k = 0; k < n; k++) mon.addVolatile('stall');
      settle(mon.volatiles.stall);
    }
    // Lock-On / Mind Reader: sure to hit that Pokemon this turn
    if (['lockon', 'mindreader'].includes(move.id) && after.some(x => x.kind === '-activate' && monOf(x.who) === mon && /Lock-On|Mind Reader/.test(x.what))) {
      const target = monOf(lastUse.whom);
      if (isActive(target)) { mon.addVolatile('lockon', target); settle(mon.volatiles.lockon); }
    }
  }
  // gen 1 partial traps (Wrap, Bind, Clamp, Fire Spin): the user is locked into it and its target cannot move, 2 to 5 turns in all
  // (random: after one hit it always goes on, after two it likely does, after three or four it likely ended, after five it did);
  // ending short of five leaves both "fakepartiallytrapped" for a turn. Each hit after the first does the first one's damage.
  if (battle.gen === 1) for (const side of battle.sides) {
    const mon = side.active[0], foe = side.foe.active[0];
    if (!isActive(mon) || !isActive(foe)) continue;
    const ownLast = u => linesOf(u).map(parse).filter(x => x.kind === 'move' && monOf(x.who) === mon).pop();
    const x = ownLast(t - 1), id = toID(x?.what || '');
    if (!x || !TRAPPING.includes(id) || monOf(x.whom) !== foe) continue;
    const at = last.findIndex(y => y.line === x.line);
    if (/\[miss\]/.test(x.line) || last.slice(at + 1, at + 3).some(y => ['-miss', '-fail', '-immune'].includes(y.kind))) continue;
    const going = y => toID((/\[from\] ?([^|]+)/.exec(y.line) || [])[1] || '') === id;
    let k = 0;
    const hits = [];   // (the line of the damage each hit did)
    for (let u = t - 1; u >= 1; u--) {
      const y = ownLast(u);
      if (!y || toID(y.what) !== id) break;
      k++;
      const at = rep.lines.indexOf(y.line, rep.turnIdx[u]), hit = rep.lines.findIndex((l, i) => i > at && l.startsWith('|-damage|') && monOf(l.split('|')[2]) === foe);
      if (hit > 0 && hit < (rep.turnIdx[u + 1] ?? rep.lines.length)) hits.push(hit);
      if (!going(y)) break;
    }
    if (k <= 2) {
      const damage = trapDamage(rep, hits, foe);
      mon.volatiles.partialtrappinglock = effState(battle, {id: 'partialtrappinglock', target: mon, source: mon, sourceSlot: mon.getSlot(),
        duration: 3 - k, move: id, totalDuration: 3, damage, locked: foe});
      foe.volatiles.partiallytrapped = effState(battle, {id: 'partiallytrapped', target: foe, source: mon, sourceSlot: mon.getSlot(), duration: 1,
        sourceEffect: battle.dex.moves.get(id), ...(k >= 2 ? {maybeLocked: true} : {})});
    } else if (k < 5) {
      for (const [a, b] of [[mon, foe], [foe, mon]]) {
        a.volatiles.fakepartiallytrapped = effState(battle, {id: 'fakepartiallytrapped', target: a, source: foe, sourceSlot: foe.getSlot(), duration: 1, counterpart: b});
      }
    }
  }
  // Minimize and Defense Curl: used since it came in (the client does not keep them)
  for (const side of battle.sides) for (const mon of side.active) {
    if (!isActive(mon)) continue;
    const me = x => monOf(x.who) === mon && x.who.startsWith(side.id);
    const end = rep.turnIdx[t] ?? rep.lines.length, from = lastWhere(rep.lines, end, l => /^\|(switch|drag)\|/.test(l) && me(parse(l)));
    rep.lines.slice(Math.max(0, from), end).map(parse).forEach((x, i, all) => {
      const id = toID(x.what);
      if (x.kind !== 'move' || !me(x) || !['minimize', 'defensecurl'].includes(id) || all[i + 1]?.kind === '-fail') return;
      if (!mon.volatiles[id]) mon.volatiles[id] = effState(battle, {id, target: mon, source: mon, sourceSlot: mon.getSlot()});
    });
  }
  // traps tied to the Pokemon that made them (Mean Look, Block, Spider Web, Anchor Shot...: they end when it leaves), from the
  // "|-activate|<target>|trapped" lines since both came in
  const upto = rep.turnIdx[t] ?? rep.lines.length;
  const slotOf = p => p.side.id + 'abc'[p.position] + ':';
  for (let i = 0; i < upto; i++) {
    const x = parse(rep.lines[i]);
    if (x.kind !== '-activate' || x.what !== 'trapped') continue;
    const target = monOf(x.who), j = lastWhere(rep.lines, i, l => l.startsWith('|move|')), maker = j >= 0 ? monOf(rep.lines[j].split('|')[2]) : null;
    if (!isActive(maker) || !isActive(target) || maker.side === target.side || target.volatiles.trapped) continue;
    if (rep.lines.slice(i, upto).some(l => /^\|(switch|drag)\|/.test(l) && [maker, target].some(p => l.split('|')[2].startsWith(slotOf(p))))) continue;
    target.addVolatile('trapped', maker, battle.dex.getActiveMove(rep.lines[j].split('|')[3]), 'trapper');
  }
  // Future Sight / Doom Desire still to land: on the slot of the Pokemon it was aimed at
  for (let u = Math.max(1, t - 2); u <= t - 1; u++) for (const x of linesOf(u).map(parse)) {
    if (x.kind !== '-start' || !/^(move: )?(Future Sight|Doom Desire)$/.test(x.what)) continue;   // (gens 2-4 leave out "move: ")
    const source = monOf(x.who), id = toID(x.what.replace('move: ', ''));
    const use = linesOf(u).map(parse).find(y => y.kind === 'move' && monOf(y.who) === source && toID(y.what) === id);
    const target = monOf(use?.whom) || source?.side.foe.active[0];
    if (!source || !target || !target.isActive) continue;
    const landed = rep.lines.slice(rep.turnIdx[u] + 1, rep.turnIdx[t]).some(l => l.startsWith('|-end|') && l.includes(x.what.replace('move: ', '')));
    if (landed || !target.side.addSlotCondition(target, 'futuremove', source)) continue;
    const m = battle.dex.moves.get(id);
    // (gens 2-4 count it down; later ones wait for the turn it lands on)
    Object.assign(target.side.slotConditions[target.position].futuremove, {move: id, source, endingTurn: u + 1, ...(battle.gen <= 4 ? {duration: 3 - (t - u)} : {}),
      moveData: {id, name: m.name, accuracy: m.accuracy, basePower: m.basePower, category: m.category, priority: m.priority, flags: m.flags,
        ignoreImmunity: false, effectType: 'Move', type: m.type}});
  }
  // Wish made last turn, to heal at the end of this one
  for (const [i, x] of last.entries()) {
    if (x.kind !== 'move' || toID(x.what) !== 'wish') continue;
    const user = monOf(x.who);
    if (!user || !user.side.active.includes(user)) continue;
    if (/\[still\]/.test(x.line) || (last[i + 1]?.kind === '-fail' && monOf(last[i + 1].who) === user)) continue;   // (one already waiting)
    if (user.side.addSlotCondition(user, 'wish', user)) {
      const st = user.side.slotConditions[user.position].wish;
      settle(st);
      if (st.startingTurn !== undefined) st.startingTurn = battle.gen >= 8 ? (t - 2) % 256 : t - 2;   // (the turn it was made in, counted from 0)
    }
  }
  // the Metronome item: the move used and how many times in a row
  for (const side of battle.sides) for (const mon of side.active) {
    if (!isActive(mon) || mon.item !== 'metronome') continue;
    let lastId = '', n = 0;
    for (let u = t - 1; u >= 1; u--) {
      const x = usesIn(u, mon).pop();
      if (!x) break;
      if (!lastId) lastId = toID(x.what); else if (toID(x.what) !== lastId) break;
      n++;
    }
    mon.addVolatile('metronome');
    if (mon.volatiles.metronome) { mon.volatiles.metronome.lastMove = lastId; mon.volatiles.metronome.numConsecutive = Math.max(0, n - 1); }
  }
  // the last move used in the battle (Copycat), and each side's Pokemon that fainted last turn (Retaliate)
  const moves = rep.lines.slice(0, rep.turnIdx[t]).filter(l => l.startsWith('|move|'));
  if (moves.length) battle.lastMove = battle.dex.getActiveMove(moves[moves.length - 1].split('|')[3]);
  for (const x of last) if (x.kind === 'faint') { const mon = monOf(x.who); if (mon) mon.side.faintedLastTurn = mon; }
}

// Gen 1: a two-turn move charged before last turn and not used yet (the Pokemon flinched, slept or was trapped since; full
// paralysis or hurting itself in confusion ends the charge, but not Dig's or Fly's keeping it out of reach).
function gen1Charge(rep, t, battle, mon, isActive) {
  const me = who => (who || '').startsWith(mon.side.id) && who.replace(/^p\d[a-c]?: /, '') === mon.name;
  const end = rep.turnIdx[t] ?? rep.lines.length;
  let i = end - 1;
  for (; i >= 0; i--) {
    const a = rep.lines[i].split('|');
    if (((a[1] === 'switch' || a[1] === 'drag') && (a[2] || '').startsWith(mon.side.id)) || (a[1] === 'move' && me(a[2]))) return;
    if (a[1] === '-prepare' && me(a[2])) break;
  }
  if (i < 0) return;
  const broken = rep.lines.slice(i, end).some(l => { const a = l.split('|'); return me(a[2]) && ((a[1] === 'cant' && a[3] === 'par') || (a[1] === '-damage' && /\[from\] confusion/.test(l))); });
  const move = battle.dex.getActiveMove(rep.lines[i].split('|')[3]), target = mon.side.foe.active.find(isActive) || mon;
  if (!broken) mon.addVolatile('twoturnmove', target, move);
  if (['dig', 'fly'].includes(move.id)) mon.addVolatile('invulnerability', target);
}
// Gen 1 Thrash, Petal Dance and Rage keep their accuracy from use to use, cut each time by the user's accuracy and the target's
// evasion (a cartridge bug; taken with the stat stages as they are now) over k uses.
function gen1LockAccuracy(mon, k) {
  const mult = [25, 28, 33, 40, 50, 66, 100, 150, 200, 250, 300, 350, 400], foe = mon.side.foe.active[0];
  let acc = 255;
  for (let n = 0; n < k; n++) acc = Math.max(1, Math.min(255, Math.floor(Math.floor(acc * mult[mon.boosts.accuracy + 6] / 100) * mult[6 - (foe?.boosts.evasion || 0)] / 100)));
  return acc;
}
// The HP range [lo, hi] a Pokemon can have, from what the log last showed at or before line i (full when it never did).
function hpAt(rep, i, mon) {
  const M = mon.maxhp;
  for (let j = Math.min(i, rep.lines.length - 1); j >= 0; j--) {
    const a = rep.lines[j].split('|');
    if (!['-damage', '-heal', '-sethp', 'switch', 'drag'].includes(a[1]) || !(a[2] || '').startsWith(mon.side.id) || a[2].replace(/^p\d[a-c]?: /, '') !== mon.name) continue;
    const hp = (a[1] === 'switch' || a[1] === 'drag' ? a[4] : a[3]) || '', m = /^(\d+)\/(\d+)/.exec(hp);
    if (/^0( |$)/.test(hp)) return [0, 0];
    if (!m) continue;
    const p = +m[1], d = +m[2];
    if (d !== 100 || M === 100) return [Math.round(p * M / d), Math.round(p * M / d)];
    // (shown percent p = HP / max rounded up, and under 100% unless full)
    return p >= 100 ? [M, M] : [Math.floor((p - 1) * M / 100) + 1, Math.min(Math.floor(p * M / 100), M - 1)];
  }
  return [M, M];
}
// The index of the last of lines[0 .. end - 1] that f accepts, or -1.
function lastWhere(lines, end, f) {
  for (let i = Math.min(end, lines.length) - 1; i >= 0; i--) if (f(lines[i])) return i;
  return -1;
}
// The damage each hit of a gen 1 partial trap does (the first hit's, again each time): what fits the HP each hit left as the log
// shows it (in percent, a range that every hit narrows), its middle.
function trapDamage(rep, hits, foe) {
  let lo = 0, hi = Infinity;
  for (const i of hits) {
    const [b0, b1] = hpAt(rep, i - 1, foe), [a0, a1] = hpAt(rep, i, foe);
    if (a1 <= 0) continue;
    const l = Math.max(lo, b0 - a1), h = Math.min(hi, b1 - a0);
    if (l <= h) { lo = l; hi = h; }
  }
  return hi === Infinity ? 0 : Math.max(0, Math.round((lo + hi) / 2));
}
// Bide: the turns it has left and the damage it has stored (from the HP the log shows it losing to moves since it began, so
// near), and who hit it last. Gen 1 keeps "time" and "damage" instead (its length is random there, and 3 or 4 turns in gen 2).
// Gen 1 Counter (data/mods/gen1 moves.ts): twice the battle's last damage, when the foe's last used move was a damaging Normal
// or Fighting one. Both from the log, by the simulator's gen 1 rules: a move (not one of GEN1_KEEP_DAMAGE) sets the last damage
// to 0, then the damage it deals sets it (a Substitute's is not in the log: it stays 0), as do a drain move's heal, confusion,
// Jump Kick crash and partial-trap damage; poison, burn, Leech Seed and recoil damage leave it. In HP, from the shown percent.
const GEN1_KEEP_DAMAGE = new Set(['confuseray', 'conversion', 'counter', 'focusenergy', 'glare', 'haze', 'leechseed', 'lightscreen',
  'mimic', 'mist', 'poisongas', 'poisonpowder', 'recover', 'reflect', 'rest', 'softboiled', 'splash', 'stunspore', 'substitute',
  'supersonic', 'teleport', 'thunderwave', 'toxic', 'transform']);
const GEN1_COUNTED_FROM = new Set(['confusion', 'jumpkick', 'highjumpkick', 'wrap', 'bind', 'clamp', 'firespin', 'partiallytrapped']);
function gen1Counter(rep, t, battle) {
  const mid = r => (r[0] + r[1]) / 2;
  const monOf = who => { const m = /^p([12])[a-c]?: (.+)$/.exec(who || ''); return m ? battle.sides[+m[1] - 1].pokemon.find(p => p.name === m[2]) : null; };
  const last = [null, null];
  let damage = 0;
  for (let i = 0; i < (rep.turnIdx[t] ?? rep.lines.length); i++) {
    const line = rep.lines[i], a = line.split('|'), from = /\[from\] ?([^|]+)/.exec(line);
    if (a[1] === 'move') {
      const side = /^p([12])/.exec(a[2] || ''), id = toID(a[3]);
      if (side && Dex.moves.get(id).exists) last[+side[1] - 1] = id;
      if (!GEN1_KEEP_DAMAGE.has(id)) damage = 0;
    } else if (a[1] === '-damage' && (!from || GEN1_COUNTED_FROM.has(toID(from[1])))) {
      const mon = monOf(a[2]);
      if (mon) damage = Math.max(0, Math.round(mid(hpAt(rep, i - 1, mon)) - mid(hpAt(rep, i, mon))));
    } else if (a[1] === '-heal' && from && toID(from[1]) === 'drain') {
      const mon = monOf(a[2]);
      if (mon) damage = Math.max(0, Math.round(mid(hpAt(rep, i, mon)) - mid(hpAt(rep, i - 1, mon))));
    }
  }
  battle.lastDamage = damage;
  last.forEach((id, si) => { const move = id ? battle.dex.getActiveMove(id) : null; Object.assign(battle.sides[si], {lastMove: move, lastEnemyMove: move}); });
}
function bideFromLog(rep, t, battle, si, name, sp, st) {
  const s = lastStart(rep, t, si, name, 'bide');
  if (!s) return;
  const mid = r => (r[0] + r[1]) / 2;
  let damage = 0, by = null;
  for (let i = s.i + 1; i < (rep.turnIdx[t] ?? rep.lines.length); i++) {
    const a = rep.lines[i].split('|');
    if (a[1] !== '-damage' || /\[from\]/.test(rep.lines[i]) || !(a[2] || '').startsWith('p' + (si + 1)) || a[2].replace(/^p\d[a-c]?: /, '') !== name) continue;
    damage += Math.max(0, Math.round(mid(hpAt(rep, i - 1, sp)) - mid(hpAt(rep, i, sp))));
    by = battle.sides[1 - si].active.find(p => p && !p.fainted) || by;
  }
  if (battle.gen === 1) { st.damage = damage; st.time = Math.max(1, 3 - (t - s.turn)); return; }
  st.duration = Math.max(1, 3 - (t - s.turn));
  st.totalDamage = damage;
  if (by && damage) st.lastDamageSource = by;
}
// The last time an effect began on a Pokemon before turn t, from its "|-start|" line: {turn, i, line, acted, switchedIn}, where
// acted says the Pokemon had already moved (or could not move) that turn and switchedIn that it came in that turn.
function lastStart(rep, t, si, name, vid) {
  const isMe = who => who.startsWith('p' + (si + 1)) && who.replace(/^p\d[a-c]?: /, '') === name;
  for (let i = (rep.turnIdx[t] ?? rep.lines.length) - 1; i >= 0; i--) {
    const a = rep.lines[i].split('|');
    if (a[1] !== '-start' || !isMe(a[2] || '') || toID((a[3] || '').replace(/^move: /, '')) !== vid || a[4] === '[upkeep]') continue;
    let u = 0;
    while (rep.turnIdx[u + 1] !== undefined && rep.turnIdx[u + 1] < i) u++;
    let acted = false, switchedIn = false;
    for (let j = (rep.turnIdx[u] ?? 0) + 1; j < i; j++) {
      const b = rep.lines[j].split('|');
      if (!isMe(b[2] || '')) continue;
      if (b[1] === 'cant' || (b[1] === 'move' && !/\[from\] ?(ability|item):/.test(rep.lines[j]))) acted = true;
      if (b[1] === 'switch' || b[1] === 'drag') switchedIn = true;
    }
    return {turn: u, i, line: rep.lines[i], acted, switchedIn};
  }
  return null;
}
// Turns an effect has left at the start of turn t, counted from the turn the log shows it beginning (it counts down at the end
// of every turn, the first one too); undefined where its length is random in this gen or the log does not show it begin.
function effectLeft(rep, t, gen, si, name, vid) {
  const s = lastStart(rep, t, si, name, vid);
  if (!s) return undefined;
  const moveBefore = () => { for (let i = s.i - 1; i > (rep.turnIdx[s.turn] ?? 0); i--) if (rep.lines[i].startsWith('|move|')) return toID(rep.lines[i].split('|')[3]); return ''; };
  let base;
  // (Taunt and Encore last a turn longer on a Pokemon that has already moved that turn, gen 5 on; Disable a turn less on one
  // that has not, or on the Pokemon whose move set off Cursed Body)
  if (vid === 'taunt') base = gen === 3 ? 2 : gen >= 5 ? 3 + (s.acted && !s.switchedIn ? 1 : 0) : undefined;
  else if (vid === 'encore') base = gen >= 5 ? 3 + (s.acted || s.switchedIn ? 1 : 0) : undefined;
  else if (vid === 'disable') base = gen >= 5 ? 5 - (!(s.acted || s.switchedIn) || /\[from\] ability:/.test(s.line) ? 1 : 0) : undefined;
  else if (vid === 'healblock') {
    const persistent = rep.lines.slice(Math.max(0, s.i - 3), s.i).some(l => /^\|-activate\|.*\|ability: Persistent/.test(l));
    base = moveBefore() === 'psychicnoise' ? 2 : persistent ? 7 : 5;
  } else base = {yawn: 2, magnetrise: 5, embargo: 5, throatchop: 2, laserfocus: 2, syrupbomb: 4, uproar: 3, telekinesis: 3}[vid];   // (Uproar: 2 to 5, gens 3-4)
  return base === undefined ? undefined : Math.max(1, base - (t - s.turn));
}

// Gens 1-2: the last move of each Pokemon as the game keeps it at the start of turn t, by "side:name" ({move, encore}, '' for
// none; gen 2's Encore reads the second). Any Pokemon switching in clears it for every Pokemon in battle; in gen 1 so does a
// turn asleep or frozen, and the turn a two-turn move charges does not set it; in gen 2 only the move picked sets it (not one
// another move calls), and Metronome, Mimic, Mirror Move, Sketch, Sleep Talk and Transform clear it.
function oldLastMoves(rep, t) {
  const out = new Map();
  const of = k => out.get(k) || out.set(k, {move: '', encore: ''}).get(k);
  for (let i = 0; i < (rep.turnIdx[t] ?? rep.lines.length); i++) {
    const l = rep.lines[i], [, kind, who = '', what = ''] = l.split('|');
    const m = /^p([12])[a-c]?: (.+)$/.exec(who);
    if (!m) continue;
    const k = `${+m[1] - 1}:${m[2]}`, id = toID(what);
    if (kind === 'switch' || kind === 'drag') { for (const v of out.values()) v.move = ''; out.set(k, {move: '', encore: ''}); }
    else if (kind === 'move' && rep.gen === 1) { if (!/\[still\]/.test(l)) of(k).move = id; }
    else if (kind === 'move' && !/\[from\]/.test(l)) {
      of(k).move = of(k).encore = ['metronome', 'mimic', 'mirrormove', 'sketch', 'sleeptalk', 'transform'].includes(id) ? '' : id;
    } else if (rep.gen === 1 && ((kind === 'cant' && (what === 'slp' || what === 'frz')) || (kind === '-curestatus' && what === 'slp' && /\[msg\]/.test(l)))) of(k).move = '';
  }
  return out;
}

// Gen 1: each side's move selection as the cartridge keeps it (Counter, a turn asleep or frozen and recharging read it): the
// move picked, its slot, and the move the foe sees picked. Read off the log turn by turn: picking a move sets all three; a
// Pokemon locked into a move (Thrash, Wrap, Rage, Bide, a two-turn move, recharging), asleep or frozen keeps the pick (the foe
// sees the move in its slot); one partially trapped picks "cannotmove"; Metronome and Mirror Move pick the move they call;
// Haze makes a sleeping or frozen foe's pick "cannotmove"; a switch-in resets the slot.
// (a Pokemon that could not move for another reason, fully paralyzed or flinching, picked a move the log does not show)
function gen1Selection(rep, t, battle) {
  const sides = [0, 1].map(() => ({sel: 'nomove', slot: 0, enemy: 'nomove', name: '', moves: [], trapped: false, lock: '', used: ''}));
  const status = new Map();   // "side:name" -> its status
  const parse = l => { const a = l.split('|'), m = /^p([12])[a-c]?: (.+)$/.exec(a[2] || ''); return {kind: a[1], si: m ? +m[1] - 1 : -1, name: m ? m[2] : '', what: a[3] || '', whom: a[4] || '', line: l}; };
  const TRAPS = ['wrap', 'bind', 'clamp', 'firespin'];
  for (let u = 0; u < t && (u === 0 || rep.turnIdx[u] !== undefined); u++) {
    const L = rep.lines.slice(u ? rep.turnIdx[u] + 1 : 0, rep.turnIdx[u + 1] ?? rep.lines.length).map(parse);
    if (u >= 1) {   // the picks made at the start of the turn
      const firstAct = L.findIndex(x => x.kind === 'move' || x.kind === 'cant');
      for (const si of [0, 1]) {
        const s = sides[si], foe = sides[1 - si];
        if (!s.name) continue;
        const sw = L.findIndex(x => x.kind === 'switch' && x.si === si);
        if (sw >= 0 && (firstAct < 0 || sw < firstAct)) continue;   // (it switched)
        const mine = x => x.si === si && x.name === s.name;
        const first = L.find(x => mine(x) && (x.kind === 'move' || x.kind === 'cant' || (['-activate', '-end'].includes(x.kind) && x.what === 'Bide')));
        // (still trapped unless the trapper picked a new move: its last turn of Wrap was the one before)
        const foeFirst = L.find(x => x.si === 1 - si && x.name === foe.name && (x.kind === 'move' || x.kind === 'cant'));
        const trapped = s.trapped && !(foeFirst?.kind === 'move' && !/\[from\]/.test(foeFirst.line));
        // (a lock comes first, then sleep or freeze, then a partial trap)
        let pick = 'unknown';
        const slpfrz = ['slp', 'frz'].includes(status.get(`${si}:${s.name}`));
        if (first?.kind === 'move') {
          const id = toID(first.what), from = /\[from\] ?([^|]+)/.exec(first.line);
          pick = (from && toID(from[1]) === id) || slpfrz ? 'keep' : id === 'struggle' ? 'struggle' : 'move';   // (thawed out: the move kept)
          if (pick === 'move') { s.sel = s.enemy = s.used = id; s.slot = Math.max(0, s.moves.indexOf(id)); }
        } else if (first && (first.kind !== 'cant' || first.what === 'recharge')) pick = 'keep';   // (Bide going on, recharging)
        else if (s.lock || slpfrz) pick = 'keep';
        else if (trapped) pick = 'cannotmove';
        if (pick === 'keep') s.enemy = s.moves[s.slot] || s.enemy;
        else if (pick === 'cannotmove' || pick === 'struggle') s.sel = s.enemy = pick;
        else if (pick === 'unknown' && s.used) { s.sel = s.enemy = s.used; s.slot = Math.max(0, s.moves.indexOf(s.used)); }   // (a guess: the move it used last)
      }
    }
    for (const s of sides) s.trapped = false;
    L.forEach((x, i) => {   // what happens in the turn
      if (x.si < 0) return;
      const s = sides[x.si], k = `${x.si}:${x.name}`, id = toID(x.what);
      if (x.kind === 'switch' || x.kind === 'drag') {
        const p = battle.sides[x.si].pokemon.find(q => q.name === x.name);
        Object.assign(s, {name: x.name, slot: 0, moves: p ? p.baseMoveSlots.map(m => m.id) : [], trapped: false, lock: '', used: ''});
        const st = x.whom.split(' ')[1];
        if (st && st !== 'fnt') status.set(k, st); else status.delete(k);
      } else if (x.kind === '-status') status.set(k, x.what);
      else if (x.kind === '-curestatus') status.delete(k);
      else if (x.kind === '-start' && x.what === 'Mimic') s.moves[s.slot] = toID(x.whom);
      else if (x.kind === '-transform') s.moves = sides[1 - x.si].moves.slice();
      // the move it is locked into, if any (full paralysis and hurting itself in confusion end all but Rage)
      else if (x.kind === '-mustrecharge') s.lock = 'recharge';
      else if (x.kind === '-start' && x.what === 'Bide') s.lock = 'bide';
      else if ((x.kind === '-end' && x.what === 'Bide') || (x.kind === 'cant' && x.what === 'recharge')) s.lock = '';
      else if (x.kind === '-start' && x.what === 'confusion' && /\[silent\]/.test(x.line)) s.lock = '';   // (Thrash wore off)
      else if ((x.kind === 'cant' && x.what === 'par') || (x.kind === '-damage' && /\[from\] confusion/.test(x.line))) { if (s.lock !== 'rage') s.lock = ''; }
      else if (x.kind === 'move') {
        if (/\[from\] ?(Metronome|Mirror Move)/.test(x.line)) s.sel = s.enemy = id;
        if (id === 'haze') {
          const o = sides[1 - x.si];
          if (['slp', 'frz'].includes(status.get(`${1 - x.si}:${o.name}`))) o.sel = o.enemy = 'cannotmove';
        }
        const hit = !/\[miss\]/.test(x.line) && !L.slice(i + 1, i + 3).some(y => ['-miss', '-fail', '-immune'].includes(y.kind));
        const target = sides[1 - x.si];
        s.lock = /\[still\]/.test(x.line) ? 'twoturn' : ['thrash', 'petaldance', 'rage', 'bide'].includes(id) ? id : TRAPS.includes(id) && hit ? 'trap' : '';
        if (TRAPS.includes(id) && hit && !L.some(y => y.kind === 'faint' && y.si === 1 - x.si && y.name === target.name)) target.trapped = true;
      }
    });
  }
  return sides;
}

// The abilities the log shows changing before turn t (Skill Swap, Wandering Spirit, Role Play, Entrainment, Simple Beam,
// Worry Seed, Doodle, Trace, Receiver, Mummy, Transform...), for the Pokemon still holding a changed one: by side, name -> ability id.
// own(si, name) is a Pokemon's own ability (in gen 4 Skill Swap does not name the abilities it swaps). The client is not
// relied on here: it takes the last ability a Pokemon showed for its own (Unnerve for As One, the old one after Mega Evolution).
function abilitiesChanged(rep, t, own) {
  const now = [new Map(), new Map()];
  const who = ident => { const m = /^p([12])[a-c]?: (.+)$/.exec(ident || ''); return m ? [+m[1] - 1, m[2]] : null; };
  const get = w => now[w[0]].has(w[1]) ? now[w[0]].get(w[1]) : own(w[0], w[1]);
  const end = rep.turnIdx[t] ?? rep.lines.length;
  for (let i = 0; i < end; i++) {
    const a = rep.lines[i].split('|'), kind = a[1], x = who(a[2]);
    if (!x) continue;
    // (coming in, or a lasting forme change, brings back its own)
    if (['switch', 'drag', 'replace', 'detailschange'].includes(kind)) now[x[0]].delete(x[1]);
    else if (kind === '-ability' && /\|\[from\]/.test(rep.lines[i]) && !/\|\[fail\]/.test(rep.lines[i])) now[x[0]].set(x[1], toID(a[3]));
    else if (kind === '-activate' && /^(move: )?Skill Swap$/.test(a[3])) {
      const y = who((a.find(s => s.startsWith('[of] ')) || '').slice(5));
      if (!y) continue;
      const [ax, ay] = a[4] || a[5] ? [toID(a[4]), toID(a[5])] : [get(y), get(x)];
      now[x[0]].set(x[1], ax); now[y[0]].set(y[1], ay);
    } else if (kind === '-activate' && /^ability: (Mummy|Lingering Aroma)$/.test(a[3])) {
      const y = who(a[4]);
      if (y) now[y[0]].set(y[1], toID(a[3].slice(9)));
    } else if (kind === '-transform') {
      const y = who(a[3]);
      if (y) now[x[0]].set(x[1], get(y));
    }
  }
  return now;
}

// The stats (Attack to Speed, as the simulator stores them) the log shows changing before turn t: Power Split, Guard Split,
// Speed Swap, Power Trick and Power Shift (passed on by Baton Pass), Transform. For the Pokemon still holding changed ones:
// by side, name -> {stats, trick: 'powertrick' / 'powershift' / ''}. own(si, name) gives a copy of a Pokemon's own stats.
// (coming in or changing forme works them out again)
function statsChanged(rep, t, own) {
  const now = [new Map(), new Map()];
  const who = ident => { const m = /^p([12])[a-c]?: (.+)$/.exec(ident || ''); return m ? [+m[1] - 1, m[2]] : null; };
  const get = w => { if (!now[w[0]].has(w[1])) now[w[0]].set(w[1], {stats: own(w[0], w[1]), trick: ''}); return now[w[0]].get(w[1]); };
  const swap = (st, a, b) => { [st[a], st[b]] = [st[b], st[a]]; };
  const passing = [null, null];   // (the Pokemon using Baton Pass, until its replacement comes in)
  const end = rep.turnIdx[t] ?? rep.lines.length;
  for (let i = 0; i < end; i++) {
    const a = rep.lines[i].split('|'), kind = a[1], x = who(a[2]);
    if (!x) continue;
    const y = who((a.find(s => s.startsWith('[of] ')) || '').slice(5));
    if (kind === 'move' && toID(a[3]) === 'batonpass') { passing[x[0]] = x; continue; }
    if (['switch', 'drag', 'replace', 'detailschange', '-formechange'].includes(kind)) {
      const from = kind === 'switch' && passing[x[0]] && now[passing[x[0]][0]].get(passing[x[0]][1]);
      now[x[0]].delete(x[1]);
      if (kind === 'switch') passing[x[0]] = null;
      if (from && from.trick) { const m = get(x); m.trick = from.trick; swap(m.stats, 'atk', 'def'); }
    } else if (kind === '-activate' && y && ['move: Power Split', 'move: Guard Split'].includes(a[3])) {
      const sx = get(x).stats, sy = get(y).stats;
      for (const s of a[3] === 'move: Power Split' ? ['atk', 'spa'] : ['def', 'spd']) sx[s] = sy[s] = Math.floor((sx[s] + sy[s]) / 2);
    } else if (kind === '-activate' && y && a[3] === 'move: Speed Swap') {
      const sx = get(x).stats, sy = get(y).stats;
      [sx.spe, sy.spe] = [sy.spe, sx.spe];
    } else if (['-start', '-end'].includes(kind) && ['Power Trick', 'Power Shift'].includes(a[3])) {
      const m = get(x);
      swap(m.stats, 'atk', 'def'); m.trick = kind === '-start' ? toID(a[3]) : '';
    } else if (kind === '-transform') {
      const z = who(a[3]);
      if (z) now[x[0]].set(x[1], {stats: {...get(z).stats}, trick: ''});
    }
  }
  return now;
}

// What a Pokemon carries that the client does not keep, read from the log before turn t: once-a-battle flags (Intrepid
// Sword, Dauntless Shield, Supersweet Syrup), the types a Stellar Tera has boosted, and for one in battle what it built up
// since coming in (Stockpile's boosts, Gastro Acid, Slow Start's count, Supreme Overlord's fallen, Gorilla Tactics' lock,
// Protean / Libero used, Truant). lines: the log before turn t, split at "|".
function monState(lines, battle, sp, si) {
  const mine = ident => /^p[12]/.test(ident || '') && +ident[1] - 1 === si && ident.replace(/^p\d[a-c]?: /, '') === sp.name;
  // (once a battle from gen 9; gen 8 boosts at every switch-in)
  if (battle.gen >= 9) {
    const shown = name => lines.some(a => mine(a[2]) && ((a[1] === '-ability' && a[3] === name) || a.includes('[from] ability: ' + name)));
    if (shown('Intrepid Sword')) sp.swordBoost = true;
    if (shown('Dauntless Shield')) sp.shieldBoost = true;
    if (lines.some(a => a[1] === '-ability' && mine(a[2]) && a[3] === 'Supersweet Syrup')) sp.syrupTriggered = true;
  }
  // the types a Stellar Tera has boosted: one a damaging move of its did damage with (not fixed damage), listed once for
  // each hit of the move that first did (each target, each hit)
  const tera = lines.findIndex(a => a[1] === '-terastallize' && mine(a[2]) && a[3] === 'Stellar');
  if (tera >= 0 && sp.species.name !== 'Terapagos-Stellar') {
    const types = [];
    for (let i = tera + 1; i < lines.length; i++) {
      const a = lines[i];
      if (a[1] !== 'move' || !mine(a[2])) continue;
      const m = battle.dex.moves.get(a[3]);
      if (!m.exists || m.category === 'Status' || m.damage || m.damageCallback || m.ohko) continue;
      const type = m.id === 'terablast' ? 'Stellar' : m.type;
      let hits = 0;
      for (let j = i + 1; j < lines.length && !['move', 'switch', 'drag', 'turn', 'upkeep', ''].includes(lines[j][1]); j++) {
        const b = lines[j];
        if ((b[1] === '-damage' && !mine(b[2]) && !b.some(s => s.startsWith('[from]'))) || (b[1] === '-activate' && /Substitute/.test(b[3]) && b.includes('[damage]'))) hits++;
      }
      if (!types.includes(type)) for (let k = 0; k < hits; k++) types.push(type);
    }
    sp.stellarBoostedTypes = types;
  }
  if (!sp.isActive || sp.fainted) return;
  let from = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (['switch', 'drag', 'replace'].includes(lines[i][1]) && mine(lines[i][2])) { from = i; break; }
  const since = lines.slice(from + 1);
  // Stockpile: the Defense and Special Defense it gained (taken away again when it ends, from gen 7)
  const st = sp.volatiles.stockpile;
  if (st && battle.gen >= 7) {
    st.def = 0; st.spd = 0;
    since.forEach((a, i) => {
      if (a[1] !== '-start' || !mine(a[2]) || !/^stockpile\d$/.test(a[3])) return;
      for (let j = i + 1; j < since.length && ['-boost', '-unboost'].includes(since[j][1]) && mine(since[j][2]); j++) {
        if (['def', 'spd'].includes(since[j][3]) && +since[j][4] > 0) st[since[j][3]]--;
      }
    });
  }
  // Gastro Acid (the client only clears the ability it shows)
  if (since.some(a => a[1] === '-endability' && mine(a[2]))) sp.volatiles.gastroacid = effState(battle, {id: 'gastroacid', target: sp});
  const as = sp.abilityState;
  if (sp.ability === 'slowstart') {
    // (it counts down at the end of each turn it was in from the start of)
    const s = since.findLastIndex(a => a[1] === '-start' && mine(a[2]) && a[3] === 'ability: Slow Start');
    const turn = since.findIndex((a, i) => i > s && a[1] === 'turn');
    const ended = since.some((a, i) => i > s && a[1] === '-end' && mine(a[2]) && a[3] === 'Slow Start');
    const n = turn < 0 ? 0 : since.slice(turn).filter(a => a[1] === 'upkeep').length;
    if (s < 0 || ended || n >= 5) delete as.counter; else as.counter = 5 - n;
  }
  if (sp.ability === 'supremeoverlord') {
    const f = since.filter(a => a[1] === '-start' && mine(a[2]) && /^fallen\d$/.test(a[3])).pop();
    if (f) as.fallen = +f[3].slice(6); else delete as.fallen;
  }
  if (sp.ability === 'gorillatactics') {
    const m = since.find(a => a[1] === 'move' && mine(a[2]) && !a.some(s => s.startsWith('[from]')) && (() => {
      const mv = battle.dex.moves.get(a[3]); return mv.exists && !mv.isZ && !mv.isMax && mv.id !== 'struggle';
    })());
    as.choiceLock = m ? battle.dex.moves.get(m[3]).id : '';
  }
  if (sp.ability === 'truant') {
    // Truant: loafing this turn (from gen 5: it tried to move last turn, sleep, freezing and recharging aside; gen 4: every
    // other turn end after its first whole turn; gen 3: the same from coming in, loafing first unless it led)
    const ends = i => since.slice(i).filter(a => a[1] === 'upkeep').length;
    let on;
    if (battle.gen >= 5) {
      const last = since.slice(since.findLastIndex(a => a[1] === 'turn') + 1);
      on = last.some(a => mine(a[2]) && ((a[1] === 'move' && !a.some(s => s.startsWith('[from]') && s !== '[from]lockedmove')) ||
        (a[1] === 'cant' && !['slp', 'frz', 'recharge', 'ability: Truant'].includes(a[3]))));
    } else if (battle.gen === 4) {
      const turn = since.findIndex(a => a[1] === 'turn');
      on = turn >= 0 && ends(turn) % 2 === 1;
    } else on = lines.slice(0, from + 1).some(a => a[1] === 'turn') !== (ends(0) % 2 === 1);
    if (on) sp.volatiles.truant = effState(battle, {id: 'truant', target: sp}); else delete sp.volatiles.truant;
  }
  for (const id of battle.gen >= 9 ? ['protean', 'libero'] : []) {
    if (sp.ability === id && since.some(a => a[1] === '-start' && mine(a[2]) && a[3] === 'typechange' && a.includes('[from] ability: ' + (id === 'libero' ? 'Libero' : 'Protean')))) as[id] = true;
  }
}

// A move Mimic copied since the Pokemon came in takes Mimic's place, with PP of its own, until it leaves (gen 1: Mimic's PP;
// gens 2-4: up to 5, gen 5 on: all).
function mimicSlot(rep, t, battle, sp, si) {
  const end = rep.turnIdx[t] ?? rep.lines.length;
  const mine = ident => /^p[12]/.test(ident || '') && +ident[1] - 1 === si && ident.replace(/^p\d[a-c]?: /, '') === sp.name;
  let at = -1, name = '';
  for (let i = 0; i < end; i++) {
    const a = rep.lines[i].split('|');
    if (!mine(a[2])) continue;
    if (['switch', 'drag', 'replace'].includes(a[1])) at = -1;
    else if ((a[1] === '-start' && a[3] === 'Mimic') || (a[1] === '-activate' && a[3] === 'move: Mimic')) { at = i; name = a[4]; }
  }
  const k = sp.moveSlots.findIndex(ms => ms.id === 'mimic'), move = battle.dex.moves.get(name);
  if (at < 0 || k < 0 || !move.exists) return;
  const uses = rep.lines.slice(at + 1, end).filter(l => { const a = l.split('|'); return a[1] === 'move' && mine(a[2]) && toID(a[3]) === move.id && !/\[from\]/.test(l); }).length;
  const pp = battle.gen === 1 ? sp.moveSlots[k].pp : battle.gen <= 4 ? Math.min(5, move.pp) : move.pp;
  sp.moveSlots[k] = {move: move.name, id: move.id, pp: Math.max(0, pp - uses), maxpp: battle.gen <= 4 ? battle.calculatePP(move, sp.ppUps?.[k] || 0) : move.pp,
    target: move.target, disabled: false, used: uses > 0, virtual: true};
}

// A move Sketch copied takes Sketch's place for good (from gen 3), with all its PP less the uses since.
function sketchSlots(rep, t, battle, sp, si) {
  if (battle.gen < 3) return;
  const end = rep.turnIdx[t] ?? rep.lines.length;
  const mine = ident => /^p[12]/.test(ident || '') && +ident[1] - 1 === si && ident.replace(/^p\d[a-c]?: /, '') === sp.name;
  for (let i = 0; i < end; i++) {
    const a = rep.lines[i].split('|');
    if (a[1] !== '-activate' || a[3] !== 'move: Sketch' || !mine(a[2])) continue;
    const k = sp.moveSlots.findIndex(ms => ms.id === 'sketch'), move = battle.dex.moves.get(a[4]);
    if (k < 0 || !move.exists || sp.moveSlots.some(ms => ms.id === move.id)) continue;
    const uses = rep.lines.slice(i + 1, end).filter(l => { const b = l.split('|'); return b[1] === 'move' && mine(b[2]) && toID(b[3]) === move.id && !/\[from\]/.test(l); }).length;
    const maxpp = battle.gen <= 4 ? battle.calculatePP(move, sp.ppUps?.[k] || 0) : move.pp;
    const slot = {move: move.name, id: move.id, pp: Math.max(0, Math.min(maxpp, move.pp) - uses), maxpp, target: move.target, disabled: false, used: uses > 0};
    sp.moveSlots[k] = slot;
    const b = sp.baseMoveSlots.findIndex(ms => ms.id === 'sketch');
    if (b >= 0) sp.baseMoveSlots[b] = slot;
  }
}

// PP the log costs beyond what the client counts, by side and Pokemon name: extra[id] (Pressure from gen 3, a few moves the client
// misses, less what it counts in gens 1-2 that cost none) and the uses of Max Moves and Z-Moves, whose set move the log does not
// name (maxUses: the move used, the weather and terrain then, its Pressure).
// Pressure as the simulator takes it: one PP for each Pokemon with Pressure the move reaches (a foe from gen 5, any other one
// before; moves on a side reach no one, Spikes and Stealth Rock every foe), charged to the move that called it, if any.
// (Pressure as the sets have it, or as the log shows it; the client counts it only in gen 3, against a species that can have
// it, which is taken off here when the species has nothing else: a range is taken at its lower end)
function ppFromLog(rep, t, sets) {
  const extra = [{}, {}], maxUses = [{}, {}];
  if (rep.gen < 3) { lockedPP(rep, t, extra); return {extra, maxUses}; }
  const dex = Dex.forGen(rep.gen), cgen = gens.get(rep.gen);
  const shown = new Set(rep.lines.filter(l => /^\|-ability\|p[12][a-c]?: [^|]+\|Pressure/.test(l)).map(l => l.split('|')[2].replace(/^(p[12])[a-c]?: /, '$1 ')));
  const base = (side, name) => shown.has(`p${side + 1} ${name}`) ? 'pressure' : toID(sets[side]?.find(s => s?.name === name)?.ability);
  // (an ability can change in battle: Skill Swap, Mummy and the like, Gastro Acid, Transform; it is back on switching in)
  const changed = {};   // "p1 Name" -> ability id
  const key = ident => { const m = /^(p[12])[a-c]?: (.+)$/.exec(ident || ''); return m ? `${m[1]} ${m[2]}` : ''; };
  const abilityOf = k => k in changed ? changed[k] : base(+k[1] - 1, k.slice(3));
  const has = (side, name) => abilityOf(`p${side + 1} ${name}`) === 'pressure';
  const at = {}, down = new Set();   // position (p1a...) -> {side, name, species} as of the line; fainted ones ("p1 Name")
  const doubles = rep.lines.includes('|gametype|doubles');
  let weather = '', terrain = '';
  const end = rep.turnIdx[t] ?? rep.lines.length;
  for (let i = 0; i < end; i++) {
    const line = rep.lines[i], a = line.split('|');
    const pos = /^(p[12][a-c]?): (.+)$/.exec(a[2] || '');
    if (['switch', 'drag', 'replace'].includes(a[1]) && pos) {
      const p = pos[1].length > 2 ? pos[1] : pos[1] + 'a';
      at[p] = {side: +p[1] - 1, name: pos[2], species: (a[3] || '').split(',')[0]};
      down.delete(`${p.slice(0, 2)} ${pos[2]}`);
      delete changed[key(a[2])];
      continue;
    }
    if (a[1] === '-ability' && pos) { changed[key(a[2])] = toID(a[3]); continue; }
    if (a[1] === '-endability' && pos) { changed[key(a[2])] = ''; continue; }
    if (a[1] === '-transform' && pos) { changed[key(a[2])] = abilityOf(key(a[3])); continue; }
    if (a[1] === '-activate' && pos && /Skill Swap$/.test(a[3] || '')) {
      const s = key(a[2]), o = key((/\[of\] ([^|]+)/.exec(line) || [])[1]);
      if (o) { const was = abilityOf(s); changed[s] = a[4] ? toID(a[4]) : abilityOf(o); changed[o] = a[5] ? toID(a[5]) : was; }
      continue;
    }
    const passed = a[1] === '-activate' && /^ability: (Mummy|Lingering Aroma|Wandering Spirit)$/.exec(a[3] || '');
    if (passed && key(a[4])) {
      const theirs = /\[ability\] ([^|]+)/.exec(line);
      changed[key(a[4])] = toID(passed[1]);
      if (passed[1] === 'Wandering Spirit' && theirs) changed[key(a[2])] = toID(theirs[1]);
      continue;
    }
    if (a[1] === 'swap' && pos) {
      const from = Object.keys(at).find(k => k.startsWith(pos[1].slice(0, 2)) && at[k].name === pos[2]), to = pos[1].slice(0, 2) + 'abc'[+a[3] || 0];
      if (from && from !== to) [at[from], at[to]] = [at[to], at[from]];
      continue;
    }
    if (a[1] === 'detailschange' && pos) { for (const k in at) if (at[k]?.name === pos[2] && k.startsWith(pos[1].slice(0, 2))) at[k].species = (a[3] || '').split(',')[0]; continue; }
    if (a[1] === 'faint' && pos) { down.add(`${pos[1].slice(0, 2)} ${pos[2]}`); continue; }
    if (a[1] === '-weather') { if (!/\[upkeep\]/.test(line)) weather = a[2] === 'none' ? '' : toID(a[2]); continue; }
    if (a[1] === '-fieldstart' && /Terrain/.test(a[2])) { terrain = toID(a[2].replace(/^move: /, '')); continue; }
    if (a[1] === '-fieldend' && /Terrain/.test(a[2])) { terrain = ''; continue; }
    if (a[1] !== 'move' || !pos) continue;
    const si = +pos[1][1] - 1, name = pos[2];
    const from = /\|\[from\] ?([^|]*)/.exec(line);
    // (a move another one called: Pressure is charged to the caller; gen 3 names it without "move: ". Pursuit on a Pokemon
    // switching out names itself, and costs its PP, which the client leaves out from gen 4)
    const caller = from && (/^move: /.test(from[1]) ? dex.moves.get(from[1].slice(6))
      : rep.gen === 3 && (dex.moves.get(from[1]).callsMove || toID(from[1]) === 'pursuit') ? dex.moves.get(from[1]) : null);
    // (a move Quick Claw sped up names the item, and costs PP the client leaves out; Pressure takes none)
    if (from && /^item: /.test(from[1])) { const mine = extra[si][name] ||= {}, id = toID(a[3]); mine[id] = (mine[id] || 0) + 1; continue; }
    if (from && !caller?.exists) continue;
    const pursuit = caller?.id === 'pursuit' && toID(a[3]) === 'pursuit';
    if (pursuit && rep.gen >= 4) { const mine = extra[si][name] ||= {}; mine.pursuit = (mine.pursuit || 0) + 1; }
    let mv = dex.moves.get(a[3]);
    const zStatus = /^Z-/.test(a[3]) && !mv.exists;
    if (zStatus) mv = dex.moves.get(a[3].slice(2));
    if (!mv.exists) continue;
    // whom it reached (as the simulator's getMoveTargets; a move that shows no target hit the foe in singles)
    const self = Object.keys(at).find(k => k.startsWith('p' + (si + 1)) && at[k].name === name);
    const live = Object.keys(at).filter(k => at[k] && !down.has(`${k.slice(0, 2)} ${at[k].name}`) && k !== self);
    const foes = live.filter(k => at[k].side !== si), allies = live.filter(k => at[k].side === si);
    let reached = [];
    if (/\[notarget\]/.test(line)) reached = [];
    else if (mv.flags.mustpressure) reached = foes;
    else if (['all', 'allAdjacent'].includes(mv.target)) reached = live;
    else if (mv.target === 'allAdjacentFoes') reached = foes;
    else if (['allySide', 'allyTeam', 'allies'].includes(mv.target)) reached = allies;
    else if (mv.target === 'foeSide' || mv.target === 'self') reached = [];
    else {
      const on = /^(p[12][a-c]?): (.+)$/.exec(a[4] || '');
      const k = on && Object.keys(at).find(x => x.startsWith(on[1].slice(0, 2)) && at[x].name === on[2]);
      reached = k ? (live.includes(k) ? [k] : []) : !a[4] && !doubles ? foes : [];
    }
    let n = reached.filter(k => (rep.gen >= 5 ? at[k].side !== si : true) && has(at[k].side, at[k].name)).length;
    // what the client counted already: gen 3, a move not called by another, against a species whose only ability is Pressure
    if (rep.gen === 3 && (!from || pursuit) && mv.id !== 'stickyweb') {
      const cm = cgen.moves.get(mv.id), ct = cm?.target;
      const on = /^(p[12][a-c]?): (.+)$/.exec(a[4] || '');
      const tk = on && Object.keys(at).find(x => x.startsWith(on[1].slice(0, 2)) && at[x].name === on[2]);
      let seen = [];
      if (!on && !doubles && !['self', 'allies', 'allySide', 'adjacentAlly', 'adjacentAllyOrSelf', 'allyTeam'].includes(ct)) seen = Object.keys(at).filter(k => at[k].side !== si && k.endsWith('a'));
      else if (['all', 'allAdjacent', 'allAdjacentFoes', 'foeSide'].includes(ct)) seen = Object.keys(at).filter(k => k !== self);
      else if (tk && at[tk].side !== si) seen = [tk];
      n -= seen.filter(k => !down.has(`${k.slice(0, 2)} ${at[k].name}`)).filter(k => {
        const ab = Object.values(cgen.species.get(at[k].species)?.abilities || {});
        return ab.length === 1 && ab[0] === 'Pressure';
      }).length;
    }
    if ((mv.isMax || (mv.isZ && !dex.items.get(mv.isZ).zMoveFrom)) && !zStatus && !caller) {
      (maxUses[si][name] ||= []).push({move: mv, weather, terrain, extra: n});
      continue;
    }
    if (!n) continue;
    const id = caller ? caller.id : mv.isZ ? toID(dex.items.get(mv.isZ).zMoveFrom) : mv.id;
    const mine = extra[si][name] ||= {};
    mine[id] = (mine[id] || 0) + n;
  }
  return {extra, maxUses};
}
// Gens 1-2: PP the client counts on a move's turns that cost none (taken off extra[side][name][id]). A two-turn move costs its PP
// once: in gen 1 on its second turn (charged to the move that called it, if any), which the log names "[from]" it, so a charge
// it has not carried out yet cost nothing; in gen 2 on its first, and the log names the second as a new move. In gen 2 the
// turns Thrash, Outrage, Petal Dance (2-3) and Rollout, Ice Ball (up to 5, while they hit) lock their user into cost none.
function lockedPP(rep, t, extra) {
  const TWO_TURN = ['dig', 'fly', 'razorwind', 'skullbash', 'skyattack', 'solarbeam'];
  const LOCKS = {thrash: 3, petaldance: 3, outrage: 3, rollout: 5, iceball: 5};
  const key = ident => { const m = /^(p[12])[a-c]?: (.+)$/.exec(ident || ''); return m ? `${m[1]} ${m[2]}` : ''; };
  const refund = (k, id) => { const mine = extra[+k[1] - 1][k.slice(3)] ||= {}; mine[id] = (mine[id] || 0) - 1; };
  const charging = {}, last = {};   // "p1 Name" -> {id, holder}: a charge not carried out yet; -> {id, turn, n, missed, tired}
  const end = rep.turnIdx[t] ?? rep.lines.length;
  let turn = 0, mover = '';
  for (let i = 0; i < end; i++) {
    const line = rep.lines[i], a = line.split('|'), k = key(a[2]);
    if (a[1] === 'turn') { turn = +a[2]; continue; }
    if (!k) continue;
    if (['switch', 'drag', 'faint'].includes(a[1])) { delete last[k]; if (rep.gen === 2) delete charging[k]; continue; }
    if (/^-(miss|fail|immune|notarget)$/.test(a[1]) || (a[1] === '-activate' && /Protect|Detect/.test(a[3] || ''))) {
      if (last[mover]) last[mover].missed = true;
      continue;
    }
    if (a[1] === '-start' && a[3] === 'confusion' && last[k]) { last[k].tired = true; continue; }
    if (a[1] !== 'move') continue;
    mover = k;
    const id = toID(a[3]), from = /\|\[from\] ?([^|]*)/.exec(line);
    const prepares = rep.lines.slice(i + 1, i + 4).some(l => l.startsWith('|-prepare|') && key(l.split('|')[2]) === k);
    if (rep.gen === 1) {
      const c = charging[k];
      if (c && !(from && toID(from[1]) === c.id)) refund(k, c.holder);   // (the charge came to nothing)
      delete charging[k];
      if (TWO_TURN.includes(id) && prepares) charging[k] = {id, holder: from && ['metronome', 'mirrormove'].includes(toID(from[1])) ? toID(from[1]) : id};
      continue;
    }
    const prev = last[k];
    if (charging[k] && charging[k].id === id && !prepares) refund(k, id);
    delete charging[k];
    if (TWO_TURN.includes(id) && prepares) charging[k] = {id};
    const goes = prev && prev.id === id && prev.turn === turn - 1 && LOCKS[id] && prev.n < LOCKS[id] && !prev.tired &&
      !(['rollout', 'iceball'].includes(id) && prev.missed);
    if (goes && !from) refund(k, id);
    last[k] = {id, turn, n: goes ? prev.n + 1 : 1};
  }
  if (rep.gen === 1) for (const [k, c] of Object.entries(charging)) refund(k, c.holder);
}
// Leppa Berry (gen 2's Mystery Berry) giving a move back PP, which the client leaves out: by side and Pokemon name, in order,
// {id, i: the line, restore}.
function ppRestores(rep, t) {
  const out = [{}, {}];
  const end = rep.turnIdx[t] ?? rep.lines.length;
  for (let i = 0; i < end; i++) {
    const a = rep.lines[i].split('|');
    const berry = a[1] === '-activate' && /^item: (Leppa|Mystery) Berry$/.exec(a[3] || '');
    const who = berry && /^p([12])[a-c]?: (.+)$/.exec(a[2] || '');
    const move = berry && (a[4] && !a[4].startsWith('[') ? a[4] : (/\|\[move\] ([^|]+)/.exec(rep.lines[i]) || [])[1]);
    if (!who || !move) continue;
    (out[+who[1] - 1][who[2]] ||= []).push({id: toID(move), i, restore: berry[1] === 'Mystery' ? 5 : 10});
  }
  return out;
}
// What the client has counted of a Pokemon's move just before line i of the log and just after it.
function ppUsedAround(rep, i, side, name, id) {
  const cb = new ClientBattle(gens);
  const read = () => {
    const m = cb.sides[side]?.team.find(p => p.name === name)?.moveSlots.find(x => toID(x.name) === id);
    return !m ? 0 : Array.isArray(m.ppUsed) ? m.ppUsed[1] : (m.ppUsed || 0);
  };
  let before = 0;
  for (let j = 0; j <= i; j++) {
    if (j === i) before = read();
    const line = rep.lines[j];
    if (!line || !line.startsWith('|')) continue;
    let parsed;
    try { parsed = Protocol.parseBattleLine(line); } catch { continue; }
    addLine(cb, parsed.args, parsed.kwArgs);
  }
  return [before, read()];
}
// The type a set move's Max Move or Z-Move takes when used in this weather and terrain ('Status' for Max Guard), for a Pokemon
// with this ability and item: after the move's own type change (Weather Ball, Hidden Power...) and, for a Max Move, the
// ability's (Normalize, Pixilate...). A Z-Move keeps the move's own type (but Weather Ball's).
function maxTypeOf(id, sp, set, use) {
  const m = Dex.moves.get(id), isMax = use.move.isMax;
  if (m.category === 'Status') return 'Status';
  const item = Dex.items.get(set?.item || sp.item), ability = toID(set?.ability || sp.ability);
  let type = m.type;
  if (id === 'weatherball') {
    const w = use.weather, umbrella = item.id === 'utilityumbrella';
    type = ['sunnyday', 'desolateland'].includes(w) && !umbrella ? 'Fire' : ['raindance', 'primordialsea'].includes(w) && !umbrella ? 'Water'
      : w === 'sandstorm' ? 'Rock' : ['hail', 'snow', 'snowscape'].includes(w) ? 'Ice' : 'Normal';
  }
  if (!isMax) return type;
  if (id === 'hiddenpower') type = sp.hpType || type;
  if (id === 'terrainpulse' && !sp.species.types.includes('Flying') && ability !== 'levitate' && item.id !== 'airballoon') {
    type = {electricterrain: 'Electric', grassyterrain: 'Grass', mistyterrain: 'Fairy', psychicterrain: 'Psychic'}[use.terrain] || type;
  }
  if (id === 'judgment' && item.onPlate) type = item.onPlate;
  if (id === 'multiattack' && item.onMemory) type = item.onMemory;
  if (id === 'technoblast' && item.onDrive) type = item.onDrive;
  if (id === 'revelationdance') type = sp.species.types[0];
  if (ability === 'normalize') type = 'Normal';
  const ate = {aerilate: 'Flying', pixilate: 'Fairy', refrigerate: 'Ice', galvanize: 'Electric'}[ability];
  if (ate && type === 'Normal') type = ate;
  return type;
}

// Gen 1 stats as the game keeps them: stat stages applied (capped at 999), then burn halving Attack and paralysis quartering Speed.
export function gen1Stats(sp) {
  const mult = [25, 28, 33, 40, 50, 66, 100, 150, 200, 250, 300, 350, 400];
  for (const s of ['atk', 'def', 'spa', 'spd', 'spe']) {
    const stage = s === 'spd' ? sp.boosts.spa : sp.boosts[s];   // (one Special stat)
    sp.modifiedStats[s] = Math.max(1, Math.min(999, Math.floor(sp.storedStats[s] * mult[stage + 6] / 100)));
  }
  if (sp.status === 'brn') sp.modifiedStats.atk = Math.max(1, Math.floor(sp.modifiedStats.atk / 2));
  if (sp.status === 'par') sp.modifiedStats.spe = Math.max(1, Math.floor(sp.modifiedStats.spe / 4));
}
const TRAPPING = ['wrap', 'bind', 'firespin', 'whirlpool', 'sandtomb', 'clamp', 'infestation', 'magmastorm', 'snaptrap', 'thundercage'];
const VOLATILES = ['mist', 'mustrecharge', 'substitute', 'confusion', 'leechseed', 'taunt', 'encore', 'yawn', 'perishsong', 'curse', 'saltcure', 'aquaring', 'ingrain', 'focusenergy',
  'magnetrise', 'charge', 'stockpile', 'protosynthesis', 'quarkdrive', 'torment', 'disable', 'throatchop', 'healblock', 'smackdown', 'partiallytrapped',
  'flashfire', 'unburden', 'slowstart', 'glaiverush', 'tarshot', 'trapped', 'nightmare', 'embargo', 'imprison', 'gastroacid', 'laserfocus', 'noretreat', 'octolock', 'syrupbomb',
  'rage', 'bide', 'destinybond', 'uproar', 'foresight', 'reflect', 'lightscreen', 'mudsport', 'watersport',
  'grudge', 'miracleeye', 'telekinesis', 'attract'];

const WEATHER_IDS = {sun: 'sunnyday', rain: 'raindance', sand: 'sandstorm', hail: 'hail', snow: 'snowscape',
  harshsunshine: 'desolateland', heavyrain: 'primordialsea', strongwinds: 'deltastream'};
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
    else if (kind === '-terastallize') side.tera = true;
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
  const oldLast = battle.gen <= 2 ? oldLastMoves(rep, t) : null;
  const logPP = ppFromLog(rep, t, sets), restores = ppRestores(rep, t);
  const used0 = si => gimmicks[si];
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
      const now = team[k].item && team[k].item !== '(exists)' ? itemName(team[k].item) : '';   // (Trick, Switcheroo, Thief...)
      const gone = knownOf(team[k]).itemGone;   // item state at this turn (sets hold the original item)
      return {name: s.name, species: s.species, item: now || (gone ? '' : (s.item || '')), ability: s.ability || '', moves: s.moves.filter(Boolean), nature: s.nature || 'Serious',
        evs: s.evs, ivs: s.ivs, level: s.level || 100, gender: s.gender || '', teraType: s.teraType || undefined, shiny: false, gigantamax: !!s.gigantamax};
    });
    battle.setPlayer(si ? 'p2' : 'p1', {name: cs.name || (si ? 'Player 2' : 'Player 1'), team: simSets});
  });
  if (battle.requestState === 'teampreview') {
    for (const s of ['p1', 'p2']) battle.choose(s, 'team ' + battle[s].pokemon.map((_, k) => k + 1).join(''));
  }
  // --- field
  const f = battle.field, cf = cb.field;
  f.weather = ''; f.weatherState = effState(battle, {id: ''}); f.terrain = ''; f.terrainState = effState(battle, {id: ''}); f.pseudoWeather = {};
  // (turns left as the client counts them: at least minDuration, at most maxDuration when a Rock may extend it; neither
  // means it lasts, like ability weather in gens 3-5)
  const left = st => st.minDuration > 0 ? st.minDuration : st.maxDuration > 0 ? st.maxDuration : undefined;
  if (cf.weatherState && cf.weatherState.id) {
    const id = WEATHER_IDS[cf.weatherState.id] || cf.weatherState.id;   // (the client's ids: rain, sun, sand, snow...)
    f.weather = id; f.weatherState = effState(battle, {id, duration: left(cf.weatherState)});
  }
  if (cf.terrainState && cf.terrainState.id) {
    const id = /terrain$/.test(cf.terrainState.id) ? cf.terrainState.id : cf.terrainState.id + 'terrain';   // (electric -> electricterrain)
    f.terrain = id; f.terrainState = effState(battle, {id, duration: left(cf.terrainState) || 5});
  }
  for (const [id, st] of Object.entries(cf.pseudoWeather || {})) {
    f.pseudoWeather[id] = effState(battle, {id, duration: left(st) || 5});
  }
  // --- sides and Pokemon
  sides.forEach((cs, si) => {
    const ss = battle.sides[si];
    ss.sideConditions = {};
    for (const [id, c] of Object.entries(cs.sideConditions || {})) {
      if (id === 'futuresight' || id === 'doomdesire') continue;
      const st = effState(battle, {id, target: ss});
      if (['spikes', 'toxicspikes'].includes(id)) st.layers = c.level || 1;
      if (c.minDuration > 0) st.duration = c.minDuration; else if (['reflect', 'lightscreen', 'auroraveil', 'tailwind', 'safeguard', 'mist', 'luckychant'].includes(id)) st.duration = Math.max(1, c.maxDuration || 5);
      ss.sideConditions[id] = st;
    }
    let left = 0;
    const teraUsed = used0(si).tera || teams[si].some(p => p.terastallized);
    const used = gimmicks[si];
    if (used.zmove) ss.zMoveUsed = true;
    if (used.dynamax) ss.dynamaxUsed = true;
    order[si].forEach((k, pos) => {
      const cp = teams[si][k]; const sp = ss.pokemon[pos]; const set = sets[si][k];
      if (!sp) return;   // (not brought)
      // forme changes that persist (Palafin-Hero, Mimikyu-Busted, ...)
      if (!cp.volatiles?.transform && cp.speciesForme && toID(cp.speciesForme) !== toID(sp.species.name) && Dex.species.get(cp.speciesForme).exists) {
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
        if (cp.maxhp === 100 && sp.maxhp !== 100) {
          // (shown percent p = HP / max rounded up: HP is in ((p - 1) max / 100, p max / 100], and under 100% unless full)
          const p = cp.hp, M = sp.maxhp, lo = p >= 100 ? M : Math.floor((p - 1) * M / 100) + 1, hi = Math.min(Math.floor(p * M / 100), p < 100 ? M - 1 : M);
          sp.hp = Math.max(1, Math.min(M, Math.round((lo + Math.max(lo, hi)) / 2)));
        } else {
          const frac = cp.maxhp ? cp.hp / cp.maxhp : 1;
          sp.hp = Math.max(1, Math.min(sp.maxhp, Math.round(frac * sp.maxhp)));
        }
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
      // (where the client is unsure of Pressure it gives a range [with, without]: take the lower; ppFromLog adds Pressure)
      const ppOf = km => Array.isArray(km.ppUsed) ? km.ppUsed[1] : (km.ppUsed || 0);
      for (const ms of sp.moveSlots) {
        const km = cp.moveSlots.find(m => toID(m.name) === ms.id);
        if (km) { const used = ppOf(km); ms.pp = Math.max(0, ms.maxpp - used); ms.used = used > 0; }
        // (a berry that gave it PP back: its PP then, and what the client counted after)
        let pp = null, mark = 0;
        for (const r of (restores[si]?.[cp.name] || []).filter(r => r.id === ms.id)) {
          const [before, after] = ppUsedAround(rep, r.i, si, cp.name, ms.id);
          pp = Math.min(ms.maxpp, (pp === null ? Math.max(0, ms.maxpp - before) : Math.max(0, pp - (before - mark))) + r.restore);
          mark = after;
        }
        if (pp !== null) ms.pp = Math.max(0, pp - ((km ? ppOf(km) : 0) - mark));
      }
      for (const [id, n] of Object.entries(logPP.extra[si]?.[cp.name] || {})) {
        const ms = sp.moveSlots.find(m => m.id === id);
        if (ms) ms.pp = Math.max(0, Math.min(ms.maxpp, ms.pp - n));
      }
      // (the log names a Max Move or Z-Move, not the move it came from: charge the set move whose type it takes. Where several
      // fit (Max Guard comes from any status move) which one paid is unknown: n uses among k such moves charge each one the
      // number of uses it most likely paid for, taking every choice as likely, the lower one in a tie)
      const unsure = {};
      for (const use of logPP.maxUses[si]?.[cp.name] || []) {
        const z = use.move;
        const fits = sp.moveSlots.filter(ms => {
          const m = Dex.moves.get(ms.id);
          if (z.isZ) return m.category !== 'Status' && m.zMove?.basePower && maxTypeOf(ms.id, sp, set, use) === z.type;
          return z.category === 'Status' ? m.category === 'Status' : m.category !== 'Status' && maxTypeOf(ms.id, sp, set, use) === z.type;
        });
        if (fits.length === 1) { fits[0].pp = Math.max(0, fits[0].pp - 1 - use.extra); fits[0].used = true; }
        else if (fits.length) { const g = unsure[fits.map(ms => ms.id).join()] ||= {fits, n: 0, cost: 0}; g.n++; g.cost += 1 + use.extra; }
      }
      for (const {fits, n, cost} of Object.values(unsure)) {
        const each = Math.ceil((n + 1) / fits.length) - 1;
        for (const ms of fits) if (each) { ms.pp = Math.max(0, ms.pp - Math.round(each * cost / n)); ms.used = true; }
      }
      // Tera
      if (cp.terastallized) {
        sp.terastallized = cp.terastallized; sp.teraType = cp.terastallized; sp.apparentType = cp.terastallized; sp.knownType = true;
      }
      if (teraUsed) sp.canTerastallize = null;
      if (used.mega) { sp.canMegaEvo = false; sp.canMegaEvoX = false; sp.canMegaEvoY = false; }
      if (used.ultra) sp.canUltraBurst = null;
      sp.timesAttacked = cp.timesAttacked || 0;   // (Rage Fist: hits taken in the whole battle, as the client counts them)
      sketchSlots(rep, t, battle, sp, si);
      // active Pokemon details
      if (cs.active.includes(cp) && !sp.fainted) {
        // a forme change until it leaves (Aegislash-Blade, Minior-Meteor, Wishiwashi-School, Darmanitan-Zen...; the client keeps
        // it as a volatile; Dynamax makes the Gigantamax one, a Transform its own)
        const fc = cp.volatiles?.formechange?.speciesForme;
        if (fc && !cp.volatiles.transform && !/-Gmax$/.test(fc) && toID(fc) !== toID(sp.species.name) && Dex.species.get(fc).exists) {
          try { sp.formeChange(fc, null, false); } catch (e) { notes.push(`${cp.name}: could not set forme ${fc}.`); }
        }
        Object.assign(sp.boosts, cp.boosts || {});
        if (battle.gen === 1) sp.boosts.spd = sp.boosts.spa;   // (one Special: the client keeps it as spa only)
        for (const [vid, v] of Object.entries(cp.volatiles || {})) {
          if (vid === 'typechange' && !cp.volatiles.transform) {   // Soak, Conversion, Protean, Color Change...
            const types = String(v.apparentType || v.type || '').split('/').filter(Boolean);
            if (types.length) try { sp.setType(types); } catch {}
            continue;
          }
          if (vid === 'typeadd') { if (v.type) try { sp.addType(v.type); } catch {} continue; }
          if (TRAPPING.includes(vid)) {   // (the client keeps a partial trap under its move's id)
            const foe = battle.sides[1 - si].active.find(p => p && !p.fainted);
            const band = foe && toID(foe.item) === 'bindingband';
            sp.volatiles.partiallytrapped = effState(battle, {id: 'partiallytrapped', target: sp, source: foe, sourceSlot: foe?.getSlot(), duration: 3,
              sourceEffect: Dex.moves.get(vid), boundDivisor: battle.gen >= 6 ? (band ? 6 : 8) : (band ? 8 : 16)});
            continue;
          }
          if (vid === 'trapped') continue;   // (tied to the Pokemon that trapped it: fromRecentTurns)
          if (vid === 'powertrick' || vid === 'powershift') continue;   // (set with the stats it swapped: statsChanged)
          if (vid === 'mimic') continue;   // (the move it copied takes Mimic's place: mimicSlot)
          // (set above or below: the forme, Transform after every Pokemon is in place, the item lost, Dynamax)
          if (['formechange', 'transform', 'typechange', 'itemremoved', 'dynamax'].includes(vid)) continue;
          // (the client keeps these under the ability's name; Slow Start's count is the ability's own: monState)
          if (vid === 'ability:flashfire') { sp.volatiles.flashfire = effState(battle, {id: 'flashfire', target: sp}); continue; }
          if (vid === 'ability:slowstart') continue;
          if (vid === 'autotomize') {   // (1000 hg lighter each time: gen 5 keeps a count, later gens the weight itself)
            const n = v.level || 1;
            if (battle.gen <= 5) sp.volatiles.autotomize = effState(battle, {id: 'autotomize', target: sp, multiplier: n});
            else sp.weighthg = Math.max(1, sp.weighthg - 1000 * n);
            continue;
          }
          if (!VOLATILES.includes(vid)) { notes.push(`${cp.name}: "${vid}" not carried over.`); continue; }
          if ((vid === 'reflect' || vid === 'lightscreen') && battle.gen > 1) continue;   // (on the Pokemon only in gen 1)
          const st = effState(battle, {id: vid, target: sp});
          if (vid === 'substitute') st.hp = Math.floor(sp.maxhp / 4);
          if (vid === 'confusion') st.time = 2;
          const turnsLeft = effectLeft(rep, t, battle.gen, si, cp.name, vid);   // (undefined where it is random: a guess below)
          if (vid === 'taunt') st.duration = turnsLeft || 3;
          if (vid === 'encore') { st.move = cp.lastMove; st.duration = turnsLeft || 3; }
          if (vid === 'disable') {   // (the move "|-start|...|Disable|<move>" names)
            const named = lastStart(rep, t, si, cp.name, 'disable')?.line.split('|')[4];
            st.move = named && Dex.moves.get(named).exists ? toID(named) : cp.lastMove;
            if (battle.gen === 1) { st.slotIndex = Math.max(0, sp.moveSlots.findIndex(m => m.id === st.move)); st.time = 4; }   // (gen 1 counts it in time)
            else st.duration = turnsLeft || 4;
          }
          if (vid === 'yawn') st.duration = turnsLeft || 2;
          if (['healblock', 'embargo', 'throatchop', 'laserfocus', 'syrupbomb', 'uproar', 'telekinesis'].includes(vid) && turnsLeft) st.duration = turnsLeft;
          if (vid === 'attract') {   // (in love with the one named by "[of]", or that used the move; it ends when that one leaves)
            const s = lastStart(rep, t, si, cp.name, 'attract'), of = s && /\[of\] (p\d[a-c]?: [^|]+)/.exec(s.line);
            const j = s ? lastWhere(rep.lines, s.i, l => l.startsWith('|move|')) : -1;
            const name = (of ? of[1] : j >= 0 ? rep.lines[j].split('|')[2] : '').replace(/^p\d[a-c]?: /, '');
            const by = battle.sides[1 - si].active.find(p => p && p.name === name) || battle.sides[1 - si].active.find(p => p && !p.fainted);
            if (by) { st.source = by; st.sourceSlot = by.getSlot(); }
          }
          if (vid === 'syrupbomb') {   // (it ends when the Pokemon that used it leaves)
            const s = lastStart(rep, t, si, cp.name, 'syrupbomb');
            const use = s && rep.lines.slice(0, s.i).reverse().find(l => l.startsWith('|move|'));
            const user = use && battle.sides[1 - si].active.find(p => p && p.name === use.split('|')[2].replace(/^p\d[a-c]?: /, ''));
            if (user) { st.source = user; st.sourceSlot = user.getSlot(); }
          }
          if (vid === 'mustrecharge' && battle.gen > 1) st.duration = 1;   // (this turn; gen 1 keeps it until it has recharged)
          if (vid === 'imprison') st.source = sp;
          if (vid === 'perishsong') st.duration = v.duration || (v.level || 3) + 1;   // (the client counts it in duration)
          if (vid === 'magnetrise') st.duration = turnsLeft || 5;
          if (vid === 'stockpile') st.layers = v.level || 1;
          if (vid === 'rage' && battle.gen === 1) { st.move = 'rage'; st.accuracy = 255; }   // (fromRecentTurns works out its accuracy)
          if (vid === 'bide') bideFromLog(rep, t, battle, si, cp.name, sp, st);
          if (vid === 'protosynthesis' || vid === 'quarkdrive') st.bestStat = v.stat || sp.getBestStat?.(false, true) || 'spe';
          if (vid === 'leechseed') {   // (the one that seeded it, by the move before "|-start|...|Leech Seed")
            const foe = battle.sides[1 - si].active[0]; if (foe) st.sourceSlot = foe.getSlot();
            const s = lastStart(rep, t, si, cp.name, 'leechseed'), j = s ? lastWhere(rep.lines, s.i, l => l.startsWith('|move|')) : -1;
            const by = j >= 0 && battle.sides[1 - si].pokemon.find(p => p.name === rep.lines[j].split('|')[2].replace(/^p\d[a-c]?: /, ''));
            if (by) st.source = by;
          }
          if (vid === 'partiallytrapped') { const foe = battle.sides[1 - si].active[0]; st.source = foe; st.duration = 3; st.sourceEffect = Dex.moves.get(v.id || 'wrap'); }
          sp.volatiles[vid] = st;
        }
        if (cp.volatiles?.transform) transformed.push([sp, si, cp.speciesForme, cp]);
        else mimicSlot(rep, t, battle, sp, si);
        // gen 1 keeps stats with stat stages, burn and paralysis applied (modifiedStats), which the simulator only updates as they change
        if (battle.gen === 1 && sp.modifiedStats) gen1Stats(sp);
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
        // (the move it chose, as the log shows it - Metronome, Sleep Talk - rather than the one that called up)
        // (its own: going on with a locked move, or sped up by Quick Claw, or Pursuit on one switching out, count; Magic Coat,
        // Dancer and the like do not)
        const upto = rep.turnIdx[t] ?? rep.lines.length;
        const isMine = l => (l.split('|')[2] || '').replace(/^p\d[a-c]?: /, '') === cp.name && (l.split('|')[2] || '').startsWith('p' + (si + 1));
        const chosenAt = lastWhere(rep.lines, upto, l => l.startsWith('|move|') && (!/\[from\]/.test(l) || /\[from\] ?(lockedmove|item:|move: Pursuit)/.test(l)) && isMine(l));
        const chosen = rep.lines[chosenAt];
        if (battle.gen >= 3 && sp.lastMove && chosen && Dex.moves.get(chosen.split('|')[3]).exists) sp.lastMove = battle.dex.getActiveMove(chosen.split('|')[3]);
        // (none since it came in: in gen 4 one brought in by U-turn or Baton Pass takes the last move of the one it replaced,
        // and Healing Wish and Lunar Dance give it the last move used)
        const inAt = lastWhere(rep.lines, upto, l => /^\|(switch|drag)\|/.test(l) && isMine(l));
        if (battle.gen >= 3 && chosenAt < inAt) {
          sp.lastMove = null;
          const from = battle.gen === 4 && /\[from\] ?([^|]+)$/.exec(rep.lines[inAt]);
          if (from && Dex.moves.get(from[1]).exists) sp.lastMove = battle.dex.getActiveMove(from[1]);
          const wish = battle.gen !== 4 ? -1 : rep.lines.slice(inAt, upto).findIndex(l => l.startsWith('|-heal|') && isMine(l) && /\[from\] move: (Healing Wish|Lunar Dance)/.test(l));
          const used = wish >= 0 && rep.lines[lastWhere(rep.lines, inAt + wish, l => l.startsWith('|move|'))];
          if (used && Dex.moves.get(used.split('|')[3]).exists) sp.lastMove = battle.dex.getActiveMove(used.split('|')[3]);
        }
        if (battle.gen === 2 && sp.lastMove) sp.lastMoveEncore = sp.lastMove;
        const old = oldLast?.get(`${si}:${cp.name}`);   // (gens 1-2 clear it in ways the client does not follow)
        if (old) {
          sp.lastMove = old.move ? battle.dex.getActiveMove(old.move) : null;
          if (battle.gen === 2) sp.lastMoveEncore = old.encore ? battle.dex.getActiveMove(old.encore) : null;
        }
        if (used.dynamaxTurns > 0 && cp.volatiles?.dynamax) {   // still Dynamaxed: doubles its HP, as it was
          sp.addVolatile('dynamax');
          if (sp.volatiles.dynamax) { sp.volatiles.dynamax.turns = used.dynamaxTurns; delete sp.volatiles.dynamax.duration; }
        }
      }
    });
    ss.pokemonLeft = left;
    // (Last Respects, Supreme Overlord: every faint counts, revived or not)
    ss.totalFainted = Math.min(100, rep.lines.slice(0, rep.turnIdx[t] ?? rep.lines.length).filter(l => l.startsWith(`|faint|p${si + 1}`)).length);
  });
  // abilities changed since coming in (a Pokemon's own is its set's, in the forme it is in)
  const changed = abilitiesChanged(rep, t, (si, name) => battle.sides[si].pokemon.find(p => p.name === name)?.baseAbility || '');
  const setAbility = (sp, id) => {
    if (id === undefined || id === sp.ability || !Dex.abilities.get(id).exists) return;
    sp.ability = id; sp.abilityState = effState(battle, {id, target: sp});
  };
  // and stats (Power Split, Guard Split, Speed Swap, Power Trick...)
  const statsNow = statsChanged(rep, t, (si, name) => ({...battle.sides[si].pokemon.find(p => p.name === name)?.storedStats}));
  const setStats = (sp, si) => {
    const m = statsNow[si].get(sp.name);
    if (!m) return;
    Object.assign(sp.storedStats, m.stats);
    if (m.trick) sp.volatiles[m.trick] = effState(battle, {id: m.trick, target: sp});
  };
  for (const [si, ss] of battle.sides.entries()) for (const sp of ss.active) if (sp && !sp.fainted) { setAbility(sp, changed[si].get(sp.name)); setStats(sp, si); }
  // (after every Pokemon is in place: a Transform copies the one it transformed into, on the other side)
  for (const [sp, si, species, cp] of transformed) {
    // (the last "|-transform|<it>|<target>" before this turn names it, on either side: in doubles an ally can be the one)
    let named = '', namedSide = 1 - si;
    for (let i = 0; i <= (rep.turnIdx[t] ?? rep.lines.length - 1); i++) {
      const [, kind, who = '', whom = ''] = rep.lines[i].split('|');
      if (kind === '-transform' && who.startsWith('p' + (si + 1)) && who.replace(/^p\d[a-c]?: /, '') === sp.name) {
        named = whom.replace(/^p\d[a-c]?: /, ''); namedSide = whom.startsWith('p2') ? 1 : 0;
      }
    }
    const into = (named && battle.sides[namedSide].pokemon.find(p => p.name === named)) ||
      battle.sides[1 - si].active.find(p => p && toID(p.species.name) === toID(species)) || battle.sides[1 - si].active[0];
    // (the one it copied may have fainted, left or put up a Substitute since: the simulator refuses those, so they are
    // set aside while it copies)
    const held = into && {fainted: into.fainted, hp: into.hp, transformed: into.transformed, sub: into.volatiles.substitute};
    if (into) try {
      into.fainted = false; into.hp = into.hp || 1; into.transformed = false; delete into.volatiles.substitute;
      sp.transformInto(into, Dex.moves.get('transform'));
    } catch {} finally {
      Object.assign(into, {fainted: held.fainted, hp: held.hp, transformed: held.transformed});
      if (held.sub) into.volatiles.substitute = held.sub;
    }
    if (!sp.transformed) notes.push(`${sp.name}: could not carry its Transform over.`);
    // (its copies of the moves start at 5 PP: the client counts the uses of each since)
    for (const ms of sp.transformed ? sp.moveSlots : []) {
      const km = cp.moveSlots.find(m => m.virtual && toID(m.name) === ms.id);
      const n = km ? (Array.isArray(km.ppUsed) ? km.ppUsed[0] : km.ppUsed || 0) : 0;
      if (n) { ms.pp = Math.max(0, ms.pp - n); ms.used = true; }
    }
    // (it copied the stat stages when it transformed: the client has them as they are now)
    sp.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...(cp.boosts || {})};
    if (battle.gen === 1) sp.boosts.spd = sp.boosts.spa;
    sp.timesAttacked = cp.timesAttacked || 0;
    setAbility(sp, changed[si].get(sp.name));   // (the one it copied then, or got since)
    setStats(sp, si);
  }
  const split = rep.lines.slice(0, rep.turnIdx[t] ?? rep.lines.length).map(l => l.split('|'));
  for (const [si, ss] of battle.sides.entries()) for (const sp of ss.pokemon) monState(split, battle, sp, si);
  try { fromRecentTurns(rep, t, battle, notes); } catch (e) { notes.push('Effects of the turns before: ' + e.message); }
  refreshLocks(battle);
  if (battle.gen === 1) {
    gen1Selection(rep, t, battle).forEach((s, si) => Object.assign(battle.sides[si], {lastSelectedMove: s.sel, lastSelectedMoveSlot: s.slot, lastEnemySelectedMove: s.enemy}));
    gen1Counter(rep, t, battle);
  }
  battle.turn = t;
  battle.makeRequest('move');
  battle.log.push(`|takeover|${t}`);
  return {battle, order, notes};
}

// Who is trapped this turn: worked out at the end of each turn (as the simulator's endTurn does), which taking over (or
// editing a position) skips.
export function refreshLocks(battle) {
  for (const side of battle.sides) for (const p of side.active) {
    if (!p || p.fainted) continue;
    // (and the moves it cannot choose: Choice lock, Gorilla Tactics, Taunt, Disable, Encore, Torment, Gigaton Hammer...; a
    // Choice item is not guessed for a Pokemon the log shows using two moves in a row)
    p.maybeDisabled = p.maybeLocked = false;
    for (const ms of p.moveSlots) { ms.disabled = false; ms.disabledSource = ''; }
    battle.runEvent('DisableMove', p);
    for (const ms of p.moveSlots) {
      const m = battle.dex.getActiveMove(ms.id);
      battle.singleEvent('DisableMove', m, null, p);
      if (m.flags['cantusetwice'] && p.lastMove?.id === ms.id) p.disableMove(ms.id);
    }
    p.trapped = p.maybeTrapped = false;
    battle.runEvent('TrapPokemon', p);
    if (!p.knownType || battle.dex.getImmunity('trapped', p)) battle.runEvent('MaybeTrapPokemon', p);
  }
}

// Team preview: a fresh battle with both teams (in the replay's team order), waiting for each player's lead choice ("team N").
// Returns null when the format has no team preview.
export function previewBattle(rep, sets, seed) {
  const cb = clientAt(rep, rep.lastTurn + 1);
  const battle = new SimBattle(seed ? {formatid: rep.formatid, seed} : {formatid: rep.formatid});
  [cb.p1, cb.p2].forEach((cs, si) => {
    const team = sets[si].map(s => ({name: s.name, species: s.species, item: s.item || '', ability: s.ability || '', moves: s.moves.filter(Boolean),
      nature: s.nature || 'Serious', evs: s.evs, ivs: s.ivs, level: s.level || 100, gender: s.gender || '', teraType: s.teraType || undefined, shiny: false,
      gigantamax: !!s.gigantamax}));
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
