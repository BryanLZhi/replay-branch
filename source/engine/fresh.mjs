// A fresh battle between two teams the user gives: the simulator starts it (up to team preview, or up to the first turn in
// formats without one) and writes the start as a replay shows it, so the page opens it like any replay. Every Pokemon of
// both teams is listed (|poke|), and each goes by its species, so the page knows them all from the start.
import {Battle as SimBattle, Dex, toID} from '@pkmn/sim';

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
