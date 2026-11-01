// Importing a team in Showdown's export format (as on PokéPaste), and checking it against what the replay shows:
// the Pokemon, revealed items/abilities/moves/Tera types/levels, what held items allow, and the damage of every hit.
import {Dex, Teams, toID} from '@pkmn/sim';
import {Battle as ClientBattle} from '@pkmn/client';
import {Protocol} from '@pkmn/protocol';
import {gens, clientAt, addLine, knownOf, itemName} from './core.mjs';
import {calcField, calcPokemon, calcDamage} from './calc.mjs';

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
// paste), problems: what the replay shows that these sets cannot be}. otherSets: the other side's sets, otherExact: whether
// they are known (else a hit is only called impossible if no set of the other Pokemon could explain it).
export function matchTeam(rep, si, pasted, otherSets, otherExact) {
  const end = clientAt(rep, rep.lastTurn + 1);
  const team = end.sides[si].team;
  const base = s => Dex.species.get(s).baseSpecies;
  const free = pasted.slice();
  const take = test => { const i = free.findIndex(test); return i < 0 ? null : free.splice(i, 1)[0]; };
  const found = team.map(p => take(s => toID(s.species) === toID(p.speciesForme)));
  team.forEach((p, k) => { found[k] ||= take(s => base(s.species) === base(p.speciesForme)); });
  const sets = found.map((s, k) => s && {...s, name: team[k].name});

  const problems = [];
  const missing = team.filter((p, k) => !sets[k]).map(p => p.name);
  if (missing.length) problems.push(`Not in the paste: ${missing.join(', ')}`);
  if (free.length && team.length >= 6) problems.push(`Not on this team in the replay: ${free.map(s => s.species).join(', ')}`);
  team.forEach((p, k) => { if (sets[k]) problems.push(...revealedProblems(knownOf(p), sets[k], rep.gen)); });
  const both = si === 0 ? [sets, otherSets] : [otherSets, sets];
  problems.push(...logProblems(rep, si, both, otherExact));
  return {sets, problems};
}

// Revealed facts the set contradicts.
function revealedProblems(known, set, gen) {
  const out = [], who = known.name;
  if (known.level && set.level !== known.level) out.push(`${who}: level ${set.level}, the replay shows level ${known.level}`);
  if (gen >= 3 && known.ability && toID(known.ability) !== toID(set.ability)) out.push(`${who}: ${set.ability || 'no ability'}, the replay shows ${known.ability}`);
  if (gen >= 9 && known.tera && toID(known.tera) !== toID(set.teraType)) out.push(`${who}: Tera ${set.teraType || '(none)'}, the replay shows Tera ${known.tera}`);
  const unlisted = known.moves.map(m => m.name).filter(m => !['struggle', 'recharge'].includes(toID(m)) && !set.moves.some(x => toID(x) === toID(m)));
  if (unlisted.length) out.push(`${who}: no ${unlisted.join(', ')}, which it used in the replay`);
  return out;
}

const CHOICE = ['choiceband', 'choicespecs', 'choicescarf'];
const CHANGED_HANDS = ['tricked', 'stolen', 'bestowed', 'harvested', 'found'];
// Moves whose damage depends on things a replay does not show (or that the calc models differently): not checked.
const UNCHECKED_MOVES = ['beatup', 'bodypress', 'fling', 'foulplay', 'hardpress', 'lastrespects', 'magnitude', 'naturalgift', 'present',
  'psywave', 'punishment', 'ragefist', 'storedpower', 'powertrip', 'crushgrip', 'wringout', 'eruption', 'waterspout', 'dragonenergy',
  'ficklebeam', 'counter', 'mirrorcoat', 'metalburst', 'comeuppance', 'bide', 'endeavor', 'finalgambit', 'superfang', 'ruination', 'naturesmadness'];
const UNCHECKED_VOLATILES = /^(ability:)?(protosynthesis|quarkdrive|flashfire|typechange|typeadd|transform|dynamax|substitute|charge|helpinghand|roost)/;

// Walk the replay: what the held items allow, and whether each direct hit's damage fits the sets.
function logProblems(rep, si, sets, otherExact) {
  const problems = new Map();   // one line per kind of problem and Pokemon
  const add = (key, text) => { if (!problems.has(key)) problems.set(key, text); };
  const cb = new ClientBattle(gens);
  const sideOf = poke => cb.sides.indexOf(poke.side);
  const setOf = poke => { const s = sets[sideOf(poke)]; const k = poke.side.team.indexOf(poke); return s && k >= 0 ? s[k] : null; };
  const ours = poke => poke && sideOf(poke) === si && setOf(poke);
  // the item the paste gives it, while it still holds it
  const pastedItem = poke => ours(poke) && !poke.itemEffect && !poke.lastItemEffect ? toID(setOf(poke).item) : '';
  const lastMove = new Map();
  let hit = null;   // the move being resolved: {attacker, defender, move, crit, before, damaged, checked}

  // (a switch right after the hit, e.g. Red Card, can come before the recoil)
  const finishHit = boundary => {
    if (hit && hit.damaged && boundary !== 'switch' && boundary !== 'drag' && pastedItem(hit.attacker) === 'lifeorb' && !hit.recoil && !hit.attacker.fainted &&
        !['magicguard', 'sheerforce'].includes(toID(setOf(hit.attacker).ability))) {
      add('lo' + hit.attacker.name, `${hit.attacker.name} hit with ${hit.move.name} and took no Life Orb recoil`);
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
    if (['move', 'turn', 'switch', 'drag', 'upkeep', 'cant', ''].includes(kind)) finishHit(kind);
    if ((kind === 'switch' || kind === 'drag') && poke) for (const p of poke.side.team) lastMove.delete(p);   // whoever was out left
    if (kind === 'move' && poke && !kwArgs.from && toID(args[2]) !== 'struggle') {
      const move = Dex.moves.get(args[2]);
      const item = pastedItem(poke);
      if (item === 'assaultvest' && move.category === 'Status') add('av' + poke.name, `${poke.name} used ${move.name}, which Assault Vest does not allow`);
      if (CHOICE.includes(item) && lastMove.has(poke) && lastMove.get(poke) !== move.id) {
        add('choice' + poke.name, `${poke.name} used ${Dex.moves.get(lastMove.get(poke)).name} then ${move.name} without switching, which ${Dex.items.get(item).name} does not allow`);
      }
      lastMove.set(poke, move.id);
      const target = args[3] ? cb.getPokemon(args[3]) : null;
      if (move.category !== 'Status' && target && target !== poke) hit = {attacker: poke, defender: target, move, crit: false, damaged: false};
    }
    if (kind === '-crit' && hit && poke === hit.defender) hit.crit = true;
    if (['-immune', '-miss', '-fail'].includes(kind) && hit && poke === hit.defender) hit = null;
    if (kind === '-activate' && hit && /Substitute|Protect|Detect|Disguise|Ice Face/.test(args[2] || '')) hit.skip = true;
    if (kind === '-enditem' && hit && poke === hit.defender && /Berry/.test(args[2] || '')) hit.skip = true;   // resist berries: checked without them
    if (kind === '-damage' && poke) {
      const from = String(kwArgs.from || '');
      if (/^(Stealth Rock|Spikes)$/.test(from) && pastedItem(poke) === 'heavydutyboots') add('boots' + poke.name, `${poke.name} took ${from} damage, which Heavy-Duty Boots prevents`);
      if (hit && poke === hit.attacker && /Life Orb/.test(from)) hit.recoil = true;
      if (hit && !from && poke === hit.defender && !hit.damaged) {
        hit.damaged = true;
        if (!hit.skip && (ours(hit.attacker) || ours(hit.defender))) {
          const [h, m] = String(args[2]).split(' ')[0].split('/').map(Number);
          const before = poke.maxhp ? poke.hp / poke.maxhp * 100 : 100;
          const after = m ? h / m * 100 : 0;
          const problem = checkHit(rep.gen, cb, hit, before, after, setOf, otherExact, si);
          if (problem) add('dmg' + hit.attacker.name + hit.defender.name + hit.move.id, `Turn ${cb.turn}: ${problem}`);
        }
      }
    }
    addLine(cb, args, kwArgs);
  }
  finishHit();
  return [...problems.values()];
}

// Can the sets explain this hit? The other side's Pokemon (if its set is not known) may have any spread, ability and item.
function checkHit(genNum, cb, hit, before, after, setOf, otherExact, si) {
  const {attacker, defender, move} = hit;
  if (UNCHECKED_MOVES.includes(move.id) || move.multihit || move.damage || move.ohko) return null;
  if ([attacker, defender].some(p => Object.keys(p.volatiles).some(v => UNCHECKED_VOLATILES.test(v)))) return null;
  const gen = gens.get(genNum);
  const field = calcField({weather: cb.field.weather, terrain: cb.field.terrain, pseudo: Object.keys(cb.field.pseudoWeather || {}),
    attacker: conditions(attacker.side), defender: conditions(defender.side)});
  const exact = p => cb.sides.indexOf(p.side) === si || otherExact;
  let min = Infinity, max = -Infinity;
  try {
    const atk = variants(gen, attacker, setOf(attacker), exact(attacker), 'attack', move, before);
    const def = variants(gen, defender, setOf(defender), exact(defender), 'defend', move, before);
    for (const a of atk) for (const d of def) {
      const r = calcDamage(gen, a, d, move.name, field, hit.crit);
      min = Math.min(min, r.min); max = Math.max(max, r.max);
    }
  } catch { return null; }
  const dealt = before - after;
  // a KO, or left at 1% (Focus Sash, Sturdy, Endure...): it did at least this much
  const atLeast = after <= 1;
  const TOLERANCE = 1.5;   // replays show HP in whole percent
  const fmt = x => Math.round(x * 10) / 10;
  if (atLeast ? max + TOLERANCE < dealt : dealt < min - TOLERANCE || dealt > max + TOLERANCE) {
    return `${attacker.name}'s ${move.name} did ${after <= 0 ? 'a KO from ' + fmt(before) + '%' : fmt(dealt) + '%'} to ${defender.name}, ` +
      `the sets allow ${fmt(min)} - ${fmt(max)}%`;
  }
  return null;
}

function conditions(side) {
  const out = {};
  for (const [id, c] of Object.entries(side.sideConditions || {})) out[id] = c.level || true;
  return out;
}

// Calc Pokemon for one side of a hit: the set itself if known, else the extremes it could be.
function variants(gen, poke, set, exact, role, move, hpPercent) {
  const species = poke.speciesForme;
  const common = {level: poke.level, boosts: {...poke.boosts}, status: poke.status, teraType: poke.terastallized || undefined,
    hpPercent: role === 'defend' ? hpPercent : (poke.maxhp ? poke.hp / poke.maxhp * 100 : 100),
    alliesFainted: poke.side.team.filter(p => p.fainted).length};
  const heldNow = poke.item ? itemName(poke.item) : (poke.lastItemEffect ? '' : null);   // null: not known
  const abilityNow = poke.ability && poke.ability !== poke.baseAbility ? Dex.abilities.get(poke.ability).name : null;
  if (exact && set) {
    const item = poke.itemEffect || poke.lastItemEffect ? heldNow || undefined : set.item || undefined;
    return [calcPokemon(gen, species, {...common, ability: abilityNow || set.ability || undefined, item, nature: set.nature || undefined, evs: set.evs, ivs: set.ivs})];
  }
  const sp = Dex.species.get(species);
  const abilities = poke.baseAbility || poke.ability ? [Dex.abilities.get(poke.baseAbility || poke.ability).name] : Object.values(sp.abilities || {});
  const physical = move.category === 'Physical';
  let items;
  if (heldNow !== null) items = [heldNow || undefined];
  else if (role === 'attack') items = [undefined, physical ? 'Choice Band' : 'Choice Specs'];
  else items = [undefined, physical ? null : 'Assault Vest', sp.nfe ? 'Eviolite' : null].filter(x => x !== null);
  const stat = role === 'attack' ? (physical ? 'atk' : 'spa') : (physical ? 'def' : 'spd');
  const low = {nature: {atk: 'Modest', spa: 'Adamant', def: 'Hasty', spd: 'Naive'}[stat], evs: {}, ivs: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0}};
  const high = {nature: {atk: 'Adamant', spa: 'Modest', def: 'Impish', spd: 'Careful'}[stat], evs: {hp: 252, [stat]: 252}};
  const out = [];
  for (const ability of abilities.length ? abilities : [undefined]) {
    for (const item of items) for (const spread of [low, high]) {
      out.push(calcPokemon(gen, species, {...common, ability: abilityNow || ability, item, ...spread}));
    }
  }
  return out;
}
