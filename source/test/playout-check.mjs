// Plays lines out from recent replays: takes over at random turns and plays up to 25 turns of random choices, offering
// only what the move menu offers (so a request it cannot answer, like Revival Blessing's, shows up), with random dice.
//   node source/test/playout-check.mjs [replays per format] [format ...]
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import * as E from '../engine/browser.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const perFormat = +(process.argv[2] || 4);
const formats = process.argv.length > 3 ? process.argv.slice(3) : ['gen9ou', 'gen9ubers', 'gen9randombattle', 'gen8randombattle', 'gen7ou',
  'gen6ou', 'gen5ou', 'gen4ou', 'gen3ou', 'gen2ou', 'gen1ou', 'gen9nationaldex'];
let seed = 12345;
const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
const statsFor = id => { const f = path.join(root, 'stats', id + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };

// What the menu lets a player pick for this request (the same rules as source/app/picker.js).
function options(req, active) {
  const out = [];
  const reviving = req.side.pokemon.some(p => p.reviving);
  const forced = req.forceSwitch && req.forceSwitch[0];
  if (req.teamPreview) return req.side.pokemon.map((_, n) => 'team ' + (n + 1));
  if (!forced) req.active[0].moves.forEach((m, i) => { if (!m.disabled && m.pp !== 0) out.push('move ' + (i + 1)); });
  const trapped = !forced && !!(req.active?.[0].trapped || active?.trapped);
  req.side.pokemon.forEach((p, n) => {
    if (p.active && !forced) return;
    const fainted = /fnt/.test(p.condition);
    if (reviving ? fainted : !(fainted || p.active || trapped)) out.push('switch ' + (n + 1));
  });
  return out;
}

const problems = [];
let turns = 0, lines = 0;
for (const format of formats) {
  const list = await fetch(`https://replay.pokemonshowdown.com/search.json?format=${format}`).then(r => r.json()).catch(() => []);
  for (const {id} of list.slice(0, perFormat)) {
    let rep;
    try { rep = E.parseReplayInput(await fetch(`https://replay.pokemonshowdown.com/${id}.json`).then(r => r.text())); } catch { continue; }
    if (rep.lines.some(l => /^\|gametype\|(doubles|triples|freeforall)/.test(l)) || rep.lastTurn < 2) continue;
    const sets = E.revealedTeams(rep).map(team => team.map(k => E.suggestSet(k, statsFor(rep.formatid), rep.gen)));
    for (let n = 0; n < 3; n++) {
      const t = 1 + rnd(rep.lastTurn);
      let battle;
      try { battle = E.takeover(rep, t, sets, [1, 2, 3, 4]).battle; } catch (e) { problems.push(`${id} turn ${t}: takeover: ${e.message}`); continue; }
      lines++;
      for (let k = 0; k < 25 && !battle.ended; k++) {
        const choices = {};
        for (const [si, p] of [[0, 'p1'], [1, 'p2']]) {
          const req = battle.sides[si].activeRequest;
          if (!req || req.wait) continue;
          const opts = options(req, battle.sides[si].active[0]);
          if (!opts.length) { problems.push(`${id} from turn ${t}, step ${k}: nothing to pick for ${p} (${JSON.stringify({forceSwitch: req.forceSwitch, reviving: req.side.pokemon.some(x => x.reviving)})})`); k = 99; break; }
          choices[p] = opts[rnd(opts.length)];
        }
        if (k >= 99) break;
        try {
          // random dice: decide every chance at random by forcing nothing but a random seed
          battle = E.step(E.serialize(battle), choices, [], [rnd(65536), rnd(65536), rnd(65536), rnd(65536)]).battle;
          turns++;
        } catch (e) { problems.push(`${id} from turn ${t}, step ${k}: ${JSON.stringify(choices)}: ${e.message}`); break; }
      }
    }
  }
  console.log(`${format}: done`);
}
console.log(problems.join('\n'));
console.log(`${lines} lines, ${turns} steps played; ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
