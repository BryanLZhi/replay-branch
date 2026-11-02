// A fresh battle between two teams the user gives: the simulator starts it (up to team preview, or up to the first turn in
// formats without one) and writes the start as a replay shows it, so the page opens it like any replay. Every Pokemon of
// both teams is listed (|poke|), and each goes by its species, so the page knows them all from the start.
import {Battle as SimBattle, Dex, toID} from '@pkmn/sim';

// The formats a new battle can be: singles and doubles (not triples, free-for-all or multi battles), not random battles
// (they make their own teams), and only those Showdown lets players challenge each other in. In sections as Showdown's
// format menu has them: [{section: 'S/V Singles', formats: [{id, name}]}].
const GAMES = {9: 'S/V', 8: 'S/S', 7: 'US/UM', 6: 'OR/AS', 5: 'B2/W2', 4: 'DPP', 3: 'ADV', 2: 'GSC', 1: 'RBY'};
export function freshFormats() {
  const usable = Dex.formats.all().filter(f => f.exists && f.effectType === 'Format' && ['singles', 'doubles'].includes(f.gameType || 'singles') &&
    !f.team && f.challengeShow !== false);
  const sectionOf = f => {
    const gen = Dex.forFormat(f).gen, doubles = f.gameType === 'doubles';
    if (/nationaldex/.test(f.id)) return 'National Dex';
    if (gen < 9 && /^gen\d+ou$/.test(f.id)) return 'Past Gens OU';
    return `${GAMES[gen]} ${doubles ? 'Doubles' : 'Singles'}`;
  };
  const order = ['S/V Singles', 'S/V Doubles', 'National Dex', 'Past Gens OU',
    ...[8, 7, 6, 5, 4, 3, 2, 1].flatMap(g => [`${GAMES[g]} Singles`, `${GAMES[g]} Doubles`])];
  const sections = new Map(order.map(s => [s, []]));
  for (const f of usable) {
    const section = sectionOf(f);
    // (within a generation's own section the "[Gen N]" goes without saying)
    const name = /^(National Dex|Past Gens OU)$/.test(section) ? f.name : f.name.replace(/^\[Gen \d+\] /, '');
    sections.get(section)?.push({id: f.id, name, full: f.name});
  }
  return [...sections].filter(([, formats]) => formats.length).map(([section, formats]) => ({section, formats}));
}

// teams: two lists of sets (as parseTeam gives them); names: the two players. Returns the log, and the sets as the battle
// has them (named by species).
export function freshBattle(formatid, teams, names = ['Player 1', 'Player 2']) {
  const format = Dex.formats.get(formatid);
  if (!format.exists || format.effectType !== 'Format') throw new Error(`"${formatid}" is not a format.`);
  if (/triples|freeforall|multi/.test(format.gameType || '')) throw new Error('Triples and free-for-all battles can only be watched.');
  teams.forEach((team, si) => {
    if (!team.length) throw new Error(`Team ${si + 1} has no Pokémon.`);
    const species = team.map(s => toID(s.species));
    if (new Set(species).size < species.length) throw new Error(`Team ${si + 1} has the same Pokémon twice.`);
  });
  const sets = teams.map(team => team.slice(0, 6).map(s => ({...s, name: s.species})));
  const battle = new SimBattle({formatid: format.id, seed: [1, 2, 3, 4]});
  sets.forEach((team, si) => battle.setPlayer(si ? 'p2' : 'p1', {name: names[si] || `Player ${si + 1}`, team: team.map(s => ({
    name: s.name, species: s.species, item: s.item || '', ability: s.ability || '', moves: s.moves.filter(Boolean), nature: s.nature || 'Serious',
    evs: s.evs, ivs: s.ivs, level: s.level || 100, gender: s.gender || '', teraType: s.teraType || undefined, shiny: false}))}));
  // (the public half of each |split| pair, as spectators and replays see it)
  const out = [];
  for (let i = 0; i < battle.log.length; i++) {
    if (battle.log[i].startsWith('|split|')) { out.push(battle.log[i + 2]); i += 2; } else out.push(battle.log[i]);
  }
  if (!out.some(l => l.startsWith('|poke|'))) {
    const at = Math.max(0, out.indexOf('|start'));
    // (as the simulator made them: a gender the paste left out is picked at random)
    out.splice(at, 0, ...battle.sides.flatMap((side, si) => side.pokemon.map(p => `|poke|p${si + 1}|${p.details}|`)));
  }
  return {log: out.join('\n'), sets};
}
