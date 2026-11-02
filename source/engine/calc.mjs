// Damage numbers from Smogon's damage calculator (@smogon/calc), on simulator positions and on the replay's own hits.
import {Dex} from '@pkmn/sim';
import {Generations} from '@pkmn/data';
import {calculate, Pokemon as CalcPokemon, Move as CalcMove, Field as CalcField} from '@smogon/calc/dist/adaptable.js';
import {gens} from './core.mjs';

// The game data the calc works from: a generation's own, or for National Dex everything that ever existed (past moves,
// Mega Stones, Z-Crystals).
const everything = new Generations(Dex, d => !!d.exists);
export const calcGen = (genNum, formatid = '') => (/nationaldex/.test(formatid) ? everything : gens).get(genNum);

const WEATHER = {sunnyday: 'Sun', raindance: 'Rain', sandstorm: 'Sand', hail: 'Hail', snowscape: 'Snow', snow: 'Snow',
  desolateland: 'Harsh Sunshine', primordialsea: 'Heavy Rain', deltastream: 'Strong Winds'};
const TERRAIN = {electricterrain: 'Electric', grassyterrain: 'Grassy', psychicterrain: 'Psychic', mistyterrain: 'Misty'};
const STATUSES = ['brn', 'par', 'psn', 'tox', 'slp', 'frz'];

// A calc field from the calc's weather/terrain names ('Sun', 'Electric') and each side's condition ids. Hazards are left out:
// the calc takes a side with hazards to mean the Pokemon is switching in (no Multiscale, "after Stealth Rock"), and here it is in.
// ruin: the Ruin abilities of any Pokemon on the field (in doubles an ally's or the other foe's count too).
export function calcField({weather, terrain, pseudo = [], attacker = {}, defender = {}, doubles = false, ruin = []}) {
  const side = c => ({isReflect: !!c.reflect, isLightScreen: !!c.lightscreen, isAuroraVeil: !!c.auroraveil, isTailwind: !!c.tailwind});
  return new CalcField({gameType: doubles ? 'Doubles' : 'Singles', weather, terrain, isGravity: pseudo.includes('gravity'),
    isMagicRoom: pseudo.includes('magicroom'), isWonderRoom: pseudo.includes('wonderroom'), attackerSide: side(attacker), defenderSide: side(defender),
    isSwordOfRuin: ruin.includes('Sword of Ruin'), isBeadsOfRuin: ruin.includes('Beads of Ruin'), isTabletsOfRuin: ruin.includes('Tablets of Ruin'),
    isVesselOfRuin: ruin.includes('Vessel of Ruin')});
}
// Abilities whose boost the calc adds by itself (it assumes the Pokemon just came in); the boosts we pass already have it.
const SELF_BOOSTING = /^(Download|Intrepid Sword|Dauntless Shield|Wind Rider|Embody Aspect)/;

// A calc Pokemon. hpPercent: current HP as a share of its max (the calc wants HP points).
export function calcPokemon(gen, species, {hpPercent = 100, status, ...options}) {
  const opts = {...options, status: STATUSES.includes(status) ? status : ''};
  if (SELF_BOOSTING.test(opts.ability || '')) opts.ability = 'Pressure';   // (no effect on damage)
  if (gen.num <= 2) {   // one Special stat: the calc refuses differing Special Attack / Defense
    if (opts.evs) opts.evs = {...opts.evs, spd: opts.evs.spa ?? 252};
    if (opts.ivs) opts.ivs = {...opts.ivs, spd: opts.ivs.spa ?? 31};
  }
  const full = new CalcPokemon(gen, species, opts);
  return hpPercent >= 100 ? full : new CalcPokemon(gen, species, {...opts, curHP: Math.max(1, Math.round(full.maxHP() * hpPercent / 100))});
}
// Damage of one move as a share of the defender's max HP: [min %, max %], and the calc's description.
// (oneTarget: in doubles a spread move that hit only one Pokemon does full damage)
export function calcDamage(gen, attacker, defender, moveName, field, isCrit = false, oneTarget = false) {
  const r = calculate(gen, attacker, defender, new CalcMove(gen, moveName, {isCrit, ...(oneTarget ? {overrides: {target: 'normal'}} : {})}), field);
  const [lo, hi] = r.range();
  return {min: lo / defender.maxHP() * 100, max: hi / defender.maxHP() * 100, result: r};
}

function simConditions(side) {
  const out = {};
  for (const [id, c] of Object.entries(side.sideConditions)) out[id] = c.layers || true;
  return out;
}
function fromSim(gen, p) {
  return calcPokemon(gen, p.species.name, {
    level: p.level, ability: Dex.abilities.get(p.ability).name, item: p.item ? Dex.items.get(p.item).name : undefined,
    nature: p.set.nature || undefined, evs: p.set.evs, ivs: p.set.ivs, boosts: p.boosts, status: p.status,
    hpPercent: p.hp / p.maxhp * 100, teraType: p.terastallized || undefined, alliesFainted: p.side.pokemon.filter(x => x.fainted).length,
  });
}

// For each move of side si's active Pokemon (in place `place`), the calc's result against the foe (in place `foe`) as the
// calc words it ({range: '39.9 - 46.9%', desc: '252+ Atk ... -- guaranteed 3HKO'}), or null (status moves, nothing to hit).
// In doubles the calc takes spread moves' lower damage into account.
export function damageCalcs(battle, si, place = 0, foe = 0) {
  const attacker = battle.sides[si].active[place], defender = battle.sides[1 - si].active[foe];
  if (!attacker || !defender || attacker.fainted || defender.fainted) return [];
  const gen = calcGen(battle.gen, battle.format.id);
  let a, d;
  try { a = fromSim(gen, attacker); d = fromSim(gen, defender); } catch { return []; }
  const field = calcField({weather: WEATHER[battle.field.weather], terrain: TERRAIN[battle.field.terrain], pseudo: Object.keys(battle.field.pseudoWeather),
    attacker: simConditions(battle.sides[si]), defender: simConditions(battle.sides[1 - si]), doubles: battle.gameType === 'doubles',
    ruin: battle.gameType !== 'doubles' ? [] : battle.sides.flatMap(s => s.active).filter(p => p && !p.fainted).map(p => Dex.abilities.get(p.ability).name).filter(a => / of Ruin$/.test(a))});
  return attacker.moveSlots.map(slot => {
    const move = Dex.moves.get(slot.id);
    if (move.category === 'Status') return null;
    try {
      const {result} = calcDamage(gen, a, d, move.name, field);
      if (!result.range()[1]) return {range: '0 - 0%', desc: ''};   // (the calc logs a complaint when describing no damage)
      const range = /^[\d.]+ - [\d.]+%/.exec(result.moveDesc('%'));
      return range ? {range: range[0], desc: result.fullDesc('%', false)} : null;
    } catch { return null; }
  });
}
