// Test of the team checker (engine/paste.mjs): battles between known teams are simulated and logged as a replay would
// show them (HP in percent); the true sets must pass, and sets with a wrong item or spread must be caught.
//   node source/test/paste-check.mjs [battles] [seed] [format]   (format: one with usage stats, default gen9ou)
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {Battle, Dex, PRNG} from '@pkmn/sim';
import * as E from '../engine/browser.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const format = process.argv[4] || 'gen9ou';
const gen = +format[3];
const dex = Dex.forGen(gen);
const stats = JSON.parse(fs.readFileSync(path.join(root, `stats/${format}.json`), 'utf8'));
const battles = +(process.argv[2] || 20);
const prng = new PRNG([+(process.argv[3] || 1), 2, 3, 4]);
const pick = list => list[prng.random(list.length)];

// Items to hand out now and then instead of the most common one (those that exist in this gen).
const ITEMS = ['Choice Scarf', 'Life Orb', 'Assault Vest', 'Heavy-Duty Boots', 'Leftovers', 'Choice Band'].filter(i => gen >= 2 && dex.items.get(i).gen <= gen);

// A team of six from the usage stats, each with its most common set (or a random item now and then).
function team() {
  const species = Object.keys(stats).filter(s => dex.species.get(s).exists && !dex.species.get(s).battleOnly &&
    stats[s].m && stats[s].m.length >= 4 && stats[s].u > 0.02);
  const out = [];
  while (out.length < 6) {
    const s = pick(species);
    if (out.some(x => Dex.species.get(x.species).baseSpecies === Dex.species.get(s).baseSpecies)) continue;
    const set = E.suggestSet({name: s, species: s, level: 100, moves: [], item: '', ability: '', tera: ''}, stats, gen);
    const sp = dex.species.get(s);
    if (ITEMS.length && !sp.requiredItem && !sp.requiredItems && prng.random(3) === 0) set.item = pick(ITEMS);
    out.push({...set, name: Dex.species.get(s).baseSpecies});
  }
  return out;
}

// Random legal choices until the battle ends (or 60 turns); returns the spectators' log.
function play(teams) {
  const battle = new Battle({formatid: format, seed: [prng.random(65536), 1, 2, 3]});
  battle.setPlayer('p1', {name: 'A', team: teams[0]});
  battle.setPlayer('p2', {name: 'B', team: teams[1]});
  for (let n = 0; !battle.ended && battle.turn < 60 && n < 500; n++) {
    for (const side of battle.sides) {
      const req = side.activeRequest;
      if (!req || req.wait || side.isChoiceDone()) continue;
      const bench = req.side.pokemon.map((p, i) => ({p, i})).filter(({p}) => !p.active && !/fnt/.test(p.condition));
      let choice;
      if (req.teamPreview) choice = 'default';
      else if (req.forceSwitch) choice = bench.length ? `switch ${pick(bench).i + 1}` : 'pass';
      else {
        const moves = req.active[0].moves.map((m, i) => ({m, i})).filter(({m}) => !m.disabled && m.pp > 0);
        choice = bench.length && !req.active[0].trapped && prng.random(5) === 0 ? `switch ${pick(bench).i + 1}` : moves.length ? `move ${pick(moves).i + 1}` : 'move 1';
      }
      if (!battle.choose(side.id, choice)) battle.choose(side.id, 'default');
    }
  }
  const out = [];
  for (let i = 0; i < battle.log.length; i++) {
    if (battle.log[i].startsWith('|split|')) { out.push(battle.log[i + 2]); i += 2; } else out.push(battle.log[i]);
  }
  return out.join('\n');
}

const paste = sets => sets.map(s => [`${s.name} (${s.species})${s.item ? ' @ ' + s.item : ''}`, s.ability && `Ability: ${s.ability}`, `Level: ${s.level}`,
  gen >= 9 && `Tera Type: ${s.teraType}`, `EVs: ${Object.entries(s.evs).map(([k, v]) => `${v} ${k}`).join(' / ')}`, s.nature && `${s.nature} Nature`,
  ...s.moves.map(m => '- ' + m)].filter(Boolean).join('\n')).join('\n\n');

let falseAlarms = 0, caught = 0, wrongTried = 0, hits = 0, calcWorded = 0;
// the other side's sets as the page holds them: imported (known) or guesses
// in the replay's team order (without team preview: the order they appeared in), as the page holds them
const asKnown = (rep, si, sets, known) => E.revealedTeams(rep)[si].map(k => ({...sets.find(s => s.name === k.name), pasted: known}));
for (let b = 0; b < battles; b++) {
  const teams = [team(), team()];
  const rep = E.parseReplayInput(play(teams));
  for (const si of [0, 1]) {
    const right = E.matchTeam(rep, si, E.parseTeam(paste(teams[si])), asKnown(rep, 1 - si, teams[1 - si], b % 2 === 0));
    if (right.problems.length && process.env.DUMP) {   // the battle and the sets, to look into a false alarm
      fs.writeFileSync(path.join(process.env.DUMP, `battle${b}.log`), rep.lines.join('\n'));
      fs.writeFileSync(path.join(process.env.DUMP, `battle${b}.json`), JSON.stringify({teams, paste: paste(teams[si]), problems: right.problems}, null, 1));
    }
    if (right.problems.length) { falseAlarms++; console.log(`battle ${b} side ${si}: true sets flagged:\n  ` + right.problems.join('\n  ')); }
    // the same team with every Pokemon's spread flipped (offence to bulk) and items swapped around
    const wrong = teams[si].map((s, k) => ({...s, item: teams[si][(k + 1) % 6].item,
      evs: s.evs.atk + s.evs.spa > 300 ? {hp: 252, atk: 0, def: 252, spa: 0, spd: gen <= 2 ? 0 : 4, spe: 0} : {hp: 0, atk: 252, def: 0, spa: 252, spd: gen <= 2 ? 252 : 0, spe: 4}}));
    const r = E.matchTeam(rep, si, E.parseTeam(paste(wrong)), asKnown(rep, 1 - si, teams[1 - si], true));
    wrongTried++; if (r.problems.length) caught++;
    if (r.problems.some(p => / vs\. .+, the replay shows /.test(p))) calcWorded++;
    hits += rep.lines.filter(l => l.startsWith('|-damage|') && !l.includes('[from]')).length;
  }
}
console.log(`${battles} battles (${hits} hits): true sets flagged ${falseAlarms} times; wrong sets caught ${caught} of ${wrongTried} (${calcWorded} with calc-worded hits)`);
process.exit(falseAlarms ? 1 : 0);
