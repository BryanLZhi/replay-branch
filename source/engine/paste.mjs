// Importing a team in Showdown's export format (as on PokéPaste), and checking it against what the replay shows:
// the Pokemon, revealed items/abilities/moves/Tera types/levels, what held items allow, and the damage of every hit.
import {Dex, Teams, toID} from '@pkmn/sim';
import {Battle as ClientBattle} from '@pkmn/client';
import {Protocol} from '@pkmn/protocol';
import {gens, clientAt, addLine, revealedTeams, itemName, hiddenPowerIVs} from './core.mjs';
import {calcField, calcPokemon, calcDamage, calcGen} from './calc.mjs';

// Sets in the same shape as suggestSet's.
export function parseTeam(text) {
  const team = Teams.import(String(text || '')) || [];
  return team.filter(s => Dex.species.get(s.species).exists).map(s => ({
    name: s.name || s.species, species: Dex.species.get(s.species).name, level: s.level || 100, gender: s.gender || '',
    moves: (s.moves || []).filter(Boolean).map(m => Dex.moves.get(m).exists ? Dex.moves.get(m).name : m),
    item: s.item ? itemName(s.item) : '', ability: s.ability ? Dex.abilities.get(s.ability).name : '',
    teraType: s.teraType || '', nature: s.nature || '',
    evs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(s.evs || {})},
    ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(s.ivs || {})},
  }));
}

// Put a pasted team in the order of side si's team in the replay. Returns {sets: per replay team member (null if not in the
// paste), problems: what the replay shows that these sets cannot be}. otherSets: the other side's current sets (those marked
// pasted are taken as known; for the rest a hit is only called impossible if no set of that Pokemon could explain it).
export function matchTeam(rep, si, pasted, otherSets) {
  const end = clientAt(rep, rep.lastTurn + 1);
  const team = end.sides[si].team;
  const base = s => Dex.species.get(s).baseSpecies;
  const free = pasted.slice();
  const take = test => { const i = free.findIndex(test); return i < 0 ? null : free.splice(i, 1)[0]; };
  // (a Pokemon still transformed at the end is what it was before)
  const species = p => p.volatiles?.transform ? (p.baseSpeciesForme || p.speciesForme) : p.speciesForme;
  const found = team.map(p => take(s => toID(s.species) === toID(species(p))));
  team.forEach((p, k) => { found[k] ||= take(s => base(s.species) === base(species(p))); });
  // (a paste without IV lines and a typed Hidden Power gets the IVs for that type, as Showdown's teambuilder sets them)
  const ivsFor = s => Object.values(s.ivs).every(v => v === 31) && hiddenPowerIVs(s.moves, rep.gen) || s.ivs;
  const sets = found.map((s, k) => s && {...s, ivs: ivsFor(s), name: team[k].name, pasted: true});

  const problems = [];
  const missing = team.filter((p, k) => !sets[k]).map(p => p.name);
  if (missing.length) problems.push(`Not in the paste: ${missing.join(', ')}`);
  if (free.length && team.length >= 6) problems.push(`Not on this team in the replay: ${free.map(s => s.species).join(', ')}`);
  const both = si === 0 ? [sets, otherSets] : [otherSets, sets];
  problems.push(...checkSets(rep, both).filter(p => p.sides.includes(si)).map(p => p.text));
  return {sets, problems};
}

// What the replay shows that the known sets (those marked pasted) cannot be: [{text, sides: the sides whose sets it is about}].
export function checkSets(rep, sets) {
  const disguised = illusions(rep);
  const problems = [];
  revealedTeams(rep).forEach((team, si) => team.forEach((known, k) => {
    const set = sets[si]?.[k];
    if (set?.pasted && !disguised.has(si + known.name)) problems.push(...revealedProblems(known, set, rep.gen).map(text => ({text, sides: [si]})));
  }));
  return problems.concat(logProblems(rep, sets, disguised));
}

// Pokemon whose actions may be a Zoroark's: the one it passed itself off as and the Zoroark (where the Illusion broke), or
// the whole side while a Pokemon that can have Illusion is on it and never showed itself.
function illusions(rep) {
  const out = new Set();
  const end = revealedTeams(rep);
  const broke = new Set();
  const cb = new ClientBattle(gens);
  for (const line of rep.lines) {
    let parsed; try { parsed = Protocol.parseBattleLine(line); } catch { continue; }
    const {args, kwArgs} = parsed;
    if (args[0] === 'replace') {
      const side = /^p2/.test(args[1]) ? 1 : 0;
      const shown = cb.sides[side].active[0];
      if (shown) out.add(side + shown.name);
      out.add(side + String(args[1]).replace(/^p\d[a-d]?: /, ''));
      broke.add(side);
    }
    addLine(cb, args, kwArgs);
  }
  end.forEach((team, side) => {
    const canHide = team.some(k => Object.values(Dex.species.get(k.species).abilities || {}).includes('Illusion'));
    if (canHide && !broke.has(side)) for (const k of team) out.add(side + k.name);
  });
  return out;
}

// The log names every Hidden Power just that (and Return / Frustration as such).
const plainMove = m => toID(m).replace(/^hiddenpower.+/, 'hiddenpower').replace(/^(return|frustration)\d+$/, '$1');
const sameMove = (a, b) => plainMove(a) === plainMove(b);
const plainAbility = a => toID(String(a).replace(/\s*\(.*\)$/, ''));   // As One (Glastrier) is logged as As One

// Revealed facts the set contradicts.
function revealedProblems(known, set, gen) {
  const out = [], who = known.name;
  if (known.level && set.level !== known.level) out.push(`${who}: level ${set.level}, the replay shows level ${known.level}`);
  // (an ability its species cannot have was given to it in battle: Mummy, Skill Swap, Trace...)
  const ownAbility = a => Object.values(Dex.species.get(set.species).abilities || {}).some(x => plainAbility(x) === plainAbility(a));
  if (gen >= 3 && known.ability && ownAbility(known.ability) && plainAbility(known.ability) !== plainAbility(set.ability)) {
    out.push(`${who}: ${set.ability || 'no ability'}, the replay shows ${known.ability}`);
  }
  if (gen >= 9 && known.tera && toID(known.tera) !== toID(set.teraType)) out.push(`${who}: Tera ${set.teraType || '(none)'}, the replay shows Tera ${known.tera}`);
  const unlisted = known.moves.map(m => m.name).filter(m => !['struggle', 'recharge'].includes(toID(m)) && !set.moves.some(x => sameMove(x, m)));
  if (unlisted.length) out.push(`${who}: no ${unlisted.join(', ')}, which it used in the replay`);
  return out;
}

const CHOICE = ['choiceband', 'choicespecs', 'choicescarf'];
// Moves whose damage depends on things a replay does not show (or that the calc models differently): not checked.
// (and those whose power depends on what happened before: who moved first, damage taken, earlier uses...)
const UNCHECKED_MOVES = ['reversal', 'flail', 'payback', 'revenge', 'avalanche', 'assurance', 'boltbeak', 'fishiousrend', 'stompingtantrum', 'temperflare',
  'lashout', 'retaliate', 'pursuit', 'echoedvoice', 'furycutter', 'rollout', 'iceball', 'round', 'spitup', 'trumpcard', 'acrobatics',
  'beatup', 'bodypress', 'fling', 'foulplay', 'hardpress', 'lastrespects', 'magnitude', 'naturalgift', 'present',
  'psywave', 'punishment', 'ragefist', 'storedpower', 'powertrip', 'crushgrip', 'wringout', 'eruption', 'waterspout', 'dragonenergy',
  'ficklebeam', 'gyroball', 'electroball', 'photongeyser', 'shellsidearm', 'terablast', 'lightthatburnsthesky', 'counter', 'mirrorcoat', 'metalburst', 'comeuppance', 'bide', 'endeavor', 'finalgambit', 'superfang', 'ruination', 'naturesmadness'];
const UNCHECKED_VOLATILES = /^((ability|move):)?(protosynthesis|quarkdrive|flashfire|typechange|typeadd|transform|dynamax|substitute|charge|helpinghand|roost)/;

// Walk the replay: what the held items allow, and whether each direct hit's damage fits the sets.
function logProblems(rep, sets, disguised = new Set()) {
  const problems = new Map();   // one line per kind of problem and Pokemon
  const add = (key, text, ...pokes) => { if (!problems.has(key)) problems.set(key, {text, sides: [...new Set(pokes.filter(known).map(sideOf))]}); };
  const cb = new ClientBattle(gens);
  const sideOf = poke => cb.sides.indexOf(poke.side);
  // (by name: the sets follow the team as it is at the end, and in doubles the client reorders a team as Pokemon change places)
  const setOf = poke => { const s = sets[sideOf(poke)]; if (!s) return null; const k = poke.side.team.indexOf(poke); return s.find(x => x && x.name === poke.name) || (k >= 0 ? s[k] : null); };
  const known = poke => !!(poke && setOf(poke)?.pasted && !disguised.has(sideOf(poke) + poke.name));
  // the item its known set gives it, while it still holds it
  const roosted = new Set();   // used Roost this turn: no Flying type (the client does not always record it)
  const helped = new Set();    // given a Helping Hand this turn (doubles)
  const swapped = new Set();   // used or was hit by Trick / Switcheroo: holding who knows what (back and forth...)
  const pastedItem = poke => known(poke) && !swapped.has(poke) && !poke.itemEffect && !poke.lastItemEffect ? toID(setOf(poke).item) : '';
  const lastMove = new Map();
  let hit = null;   // the move being resolved: {attacker, defender, move, crit, before, damaged, checked}

  // (a switch right after the hit, e.g. Red Card, can come before the recoil)
  const finishHit = boundary => {
    if (hit && hit.damaged && boundary !== 'switch' && boundary !== 'drag' && pastedItem(hit.attacker) === 'lifeorb' && !hit.recoil && !hit.attacker.fainted &&
        !['magicguard', 'sheerforce'].includes(toID(setOf(hit.attacker).ability))) {
      add('lo' + hit.attacker.name, `${hit.attacker.name} hit with ${hit.move.name} and took no Life Orb recoil`, hit.attacker);
    }
    hit = null;
  };

  for (const line of rep.lines) {
    if (!line || line[0] !== '|') continue;
    let parsed; try { parsed = Protocol.parseBattleLine(line); } catch { continue; }
    const {args, kwArgs} = parsed;
    const kind = args[0];
    const poke = typeof args[1] === 'string' && /^p\d[a-d]?: /.test(args[1]) ? cb.getPokemon(args[1]) : null;

    // an action ends at the next one, or at the blank line before end-of-turn effects (where Future Sight lands)
    if (['move', 'turn', 'switch', 'drag', 'upkeep', 'cant', 'done'].includes(kind)) finishHit(kind);   // (a blank line parses as "done")
    if ((kind === 'switch' || kind === 'drag') && poke) for (const p of poke.side.team) lastMove.delete(p);
    if (kind === 'turn') { roosted.clear(); helped.clear(); }
    if (kind === '-singleturn' && poke && /Roost/.test(args[2] || '')) roosted.add(poke);   // whoever was out left
    if (kind === '-singleturn' && poke && /Helping Hand/.test(args[2] || '')) helped.add(poke);
    if (kind === 'move' && poke && !kwArgs.from && toID(args[2]) !== 'struggle') {
      const move = Dex.moves.get(args[2]);
      const item = pastedItem(poke);
      if (item === 'assaultvest' && move.category === 'Status') add('av' + poke.name, `${poke.name} used ${move.name}, which Assault Vest does not allow`, poke);
      if (CHOICE.includes(item) && lastMove.has(poke) && lastMove.get(poke) !== move.id) {
        add('choice' + poke.name, `${poke.name} used ${Dex.moves.get(lastMove.get(poke)).name} then ${move.name} without switching, which ${Dex.items.get(item).name} does not allow`, poke);
      }
      lastMove.set(poke, move.id);
      const target = args[3] ? cb.getPokemon(args[3]) : null;
      if (['trick', 'switcheroo'].includes(move.id)) { swapped.add(poke); if (target) swapped.add(target); }
      // (in doubles a spread move does 75% when it aims at two or more Pokemon, even if one of them protects or is immune:
      // count those on the field, not the ones the log says it hit)
      const up = side => (side?.active || []).filter(p => p && p !== poke && !p.fainted && p.hp > 0).length;
      const hitCount = move.target === 'allAdjacentFoes' ? up(poke.side.foe) : move.target === 'allAdjacent' ? up(poke.side.foe) + up(poke.side) : 1;
      // (abilities on the field as the move is used: a spread move hits everyone at once, before any of them faints)
      const onField = [poke.side, poke.side.foe].flatMap(s => s?.active || []).filter(p => p && !p.fainted && p.hp > 0)
        .map(p => Dex.abilities.get((setOf(p)?.pasted ? setOf(p).ability : p.ability) || '').name);
      if (move.category !== 'Status' && target && target !== poke) hit = {attacker: poke, defender: target, move, crit: false, damaged: false, hitCount, helped: helped.has(poke), onField};
    }
    if (kind === '-crit' && hit && poke === hit.defender) hit.crit = true;
    if (['-immune', '-miss', '-fail'].includes(kind) && hit && poke === hit.defender) {
      if (kind !== '-miss') lastMove.delete(hit.attacker);   // (a move that had no effect does not lock a Choice item in)
      hit = null;
    }
    if (kind === '-activate' && hit && /Protect|Detect|King's Shield|Spiky Shield|Baneful Bunker|Silk Trap|Burning Bulwark|Obstruct|Max Guard/.test(args[2] || '')) hit = null;
    if (kind === '-activate' && hit && /Substitute|Disguise|Ice Face/.test(args[2] || '')) hit.skip = true;
    if (kind === '-enditem' && hit && poke === hit.defender && /Berry/.test(args[2] || '')) hit.skip = true;   // resist berries: checked without them
    if (kind === '-damage' && poke) {
      const from = String(kwArgs.from || '');
      if (/^(Stealth Rock|Spikes)$/.test(from) && pastedItem(poke) === 'heavydutyboots') add('boots' + poke.name, `${poke.name} took ${from} damage, which Heavy-Duty Boots prevents`, poke);
      if (hit && poke === hit.attacker && /Life Orb/.test(from)) hit.recoil = true;
      if (hit && !from && poke === hit.defender && !hit.damaged) {
        hit.damaged = true;
        // (Zoroark? Roost? items swapped around?)
        const unsure = [hit.attacker, hit.defender].some(p => disguised.has(sideOf(p) + p.name) || swapped.has(p)) || roosted.has(poke);
        if (!hit.skip && !unsure && (known(hit.attacker) || known(hit.defender))) {
          const [h, m] = String(args[2]).split(' ')[0].split('/').map(Number);
          const before = poke.maxhp ? poke.hp / poke.maxhp * 100 : 100;
          const after = m ? h / m * 100 : 0;
          const problem = checkHit(rep, cb, hit, before, after, setOf);
          if (problem) add('dmg' + hit.attacker.name + hit.defender.name + hit.move.id, `Turn ${cb.turn}: ${problem}`, hit.attacker, hit.defender);
        }
      }
    }
    addLine(cb, args, kwArgs);
  }
  finishHit();
  return [...problems.values()];
}

// Can the sets explain this hit? A Pokemon whose set is not known may have any spread, ability and item. When both sets are
// known the problem reads like the damage calc, spreads included.
function checkHit(rep, cb, hit, before, after, setOf) {
  const genNum = rep.gen;
  const {attacker, defender} = hit;
  let move = hit.move;
  if (move.id === 'hiddenpower') {   // its type is only known from a known set (and before gen 6 its power varies)
    const hp = genNum >= 6 && setOf(attacker)?.pasted && setOf(attacker).moves.find(m => /^hiddenpower./.test(toID(m)));
    if (!hp) return null;
    move = Dex.moves.get(hp);
  }
  if (UNCHECKED_MOVES.includes(move.id) || move.multihit || move.damage || move.ohko) return null;
  if (genNum <= 2 && hit.crit) return null;   // (gen 1-2 critical hits drop some stat changes; the calc and the simulator differ)
  if (genNum === 1 && move.critRatio > 1) return null;   // (the gen 1 calc takes Razor Leaf, Slash... to always be critical hits)
  // gens 1-2 wrap stats over 1023 (the calc and the simulator differ there): Thick Club and Light Ball reach that
  if (genNum <= 2 && ['thickclub', 'lightball'].includes(toID(setOf(attacker)?.item || attacker.item))) return null;
  if ([attacker, defender].some(p => Object.keys(p.volatiles).some(v => UNCHECKED_VOLATILES.test(v)))) return null;
  const gen = calcGen(genNum, rep.formatid);
  // doubles: an ally can change the damage in ways the log may not show (Helping Hand shows; Battery, Power Spot, Steely
  // Spirit, Flower Gift and Friend Guard may not): such hits are left out
  const doubles = rep.lines.includes('|gametype|doubles');
  if (doubles && (hit.helped || allyMay(attacker, ALLY_BOOSTS, setOf) || allyMay(defender, ['Friend Guard', 'Flower Gift'], setOf))) return null;
  if (hit.onField.includes('Neutralizing Gas')) return null;   // (no abilities at all, the calc's included)
  const field = calcField({weather: cb.field.weather, terrain: cb.field.terrain, pseudo: Object.keys(cb.field.pseudoWeather || {}),
    attacker: conditions(attacker.side, attacker), defender: conditions(defender.side, defender), doubles,
    ruin: doubles ? hit.onField.filter(a => / of Ruin$/.test(a)) : []});   // (in singles the calc reads them off the two Pokemon)
  let min = Infinity, max = -Infinity, only = null;
  try {
    // Analytic: the target already moved (or came in) this turn
    const moved = {analytic: !!defender.moveThisTurn || defender.newlySwitched};
    const atk = variants(gen, attacker, setOf(attacker), 'attack', move, before, moved);
    const def = variants(gen, defender, setOf(defender), 'defend', move, before);
    for (const a of atk) for (const d of def) {
      const r = calcDamage(gen, a, d, move.name, field, hit.crit, doubles && hit.hitCount < 2);
      min = Math.min(min, r.min); max = Math.max(max, r.max);
      if (atk.length === 1 && def.length === 1) only = r.result;
    }
  } catch { return null; }
  const dealt = before - after;
  if (dealt <= 0 && after > 0) return null;   // something took it (Disguise, Ice Face...)
  // a KO, or left at 1% (Focus Sash, Sturdy, Endure...): it did at least this much
  const atLeast = after <= 1;
  const TOLERANCE = genNum <= 2 ? 2.5 : 2;   // replays round HP to whole percents (gens 1-2 also round their damage more)
  const fmt = x => Math.round(x * 10) / 10;
  const shown = after <= 0 ? 'a KO from ' + fmt(before) + '%' : fmt(dealt) + '%';
  if (!(atLeast ? max + TOLERANCE < dealt : dealt < min - TOLERANCE || dealt > max + TOLERANCE)) return null;
  if (max <= 0) return null;   // (the calc does not know this move here)
  if (only) return `${only.fullDesc('%', false).split(' -- ')[0]}, the replay shows ${shown}`;
  return `${attacker.name}'s ${move.name} did ${shown} to ${defender.name}, the sets allow ${fmt(min)} - ${fmt(max)}%`;
}

// A side's conditions; in gen 1 Reflect and Light Screen are on the Pokemon instead.
const ALLY_BOOSTS = ['Battery', 'Power Spot', 'Steely Spirit', 'Flower Gift'];
// Could the Pokemon next to this one have one of these abilities (its known one, else any its species can have)?
function allyMay(poke, abilities, setOf) {
  return (poke.side.active || []).some(ally => {
    if (!ally || ally === poke || ally.fainted) return false;
    const known = setOf(ally)?.pasted ? setOf(ally).ability : ally.ability;
    const could = known ? [Dex.abilities.get(known).name] : Object.values(Dex.species.get(ally.speciesForme).abilities || {});
    return could.some(a => abilities.includes(a));
  });
}
function conditions(side, active) {
  const out = {};
  for (const [id, c] of Object.entries(side.sideConditions || {})) out[id] = c.level || true;
  for (const id of ['reflect', 'lightscreen']) if (active?.volatiles[id]) out[id] = true;
  return out;
}

// Calc Pokemon for one side of a hit: the set itself if known, else the extremes it could be.
function variants(gen, poke, set, role, move, hpPercent, {analytic = false} = {}) {
  const species = poke.speciesForme;
  const boosts = {...poke.boosts};
  if (gen.num === 1) boosts.spd = boosts.spa;   // one Special stat (the log library keeps its boosts as Special Attack)
  const common = {level: poke.level, boosts, status: poke.status, teraType: poke.terastallized || undefined,
    hpPercent: role === 'defend' ? hpPercent : (poke.maxhp ? poke.hp / poke.maxhp * 100 : 100),
    alliesFainted: poke.side.team.filter(p => p.fainted).length};
  const heldNow = poke.itemEffect === 'knocked off' ? '' : poke.item ? itemName(poke.item) : (poke.lastItemEffect ? '' : null);   // null: not known
  // its ability now, if it is not its own (Mummy, Skill Swap, a forme's own ability...)
  const own = Object.values(Dex.species.get(species).abilities || {}).map(toID);
  const abilityNow = poke.ability && (poke.ability !== poke.baseAbility || !own.includes(poke.ability)) ? Dex.abilities.get(poke.ability).name : null;
  if (set?.pasted) {
    const item = poke.itemEffect || poke.lastItemEffect ? heldNow || undefined : set.item || undefined;
    const ability = abilityNow || set.ability || undefined;
    return [calcPokemon(gen, species, {...common, ability, abilityOn: analytic && ability === 'Analytic', item, nature: set.nature || undefined, evs: set.evs, ivs: set.ivs})];
  }
  const sp = Dex.species.get(species);
  const abilities = poke.baseAbility || poke.ability ? [Dex.abilities.get(poke.baseAbility || poke.ability).name] : Object.values(sp.abilities || {});
  // before gen 4 a move's type made it physical or special
  const physical = gen.num <= 3 ? ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel'].includes(move.type)
    : move.category === 'Physical';
  let items;
  const required = sp.requiredItem || sp.requiredItems?.[0];   // Arceus and Silvally formes: their Plate / Memory
  if (heldNow !== null) items = [heldNow || undefined];
  else if (required) items = [required];
  else if (role === 'attack') items = [undefined, physical ? 'Choice Band' : 'Choice Specs'];
  else items = [undefined, physical ? null : 'Assault Vest', sp.nfe ? 'Eviolite' : null, move.id === 'knockoff' ? 'Leftovers' : null].filter(x => x !== null);
  // (Psyshock and Secret Sword hit Defense; Body Press uses it)
  const stat = role === 'attack' ? move.overrideOffensiveStat || (physical ? 'atk' : 'spa') : move.overrideDefensiveStat || (physical ? 'def' : 'spd');
  const low = {nature: {atk: 'Modest', spa: 'Adamant', def: 'Hasty', spd: 'Naive'}[stat], evs: {}, ivs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0}};
  const high = {nature: {atk: 'Adamant', spa: 'Modest', def: 'Impish', spd: 'Careful'}[stat], evs: {hp: 252, [stat]: 252}};
  const out = [];
  for (const ability of abilities.length ? abilities : [undefined]) {
    for (const item of items) for (const spread of [low, high]) {
      out.push(calcPokemon(gen, species, {...common, ability: abilityNow || ability, abilityOn: analytic && (abilityNow || ability) === 'Analytic', item, ...spread}));
    }
  }
  return out;
}
