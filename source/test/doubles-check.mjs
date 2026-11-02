// Doubles (VGC, Doubles OU...): takes over every turn of recent replays and checks that the simulator takes what each
// Pokemon then did (move and target, switch, Tera...) as the players' choices; then plays random lines on from random turns,
// picking only what the move menu offers.
//   node source/test/doubles-check.mjs [replays per format] [format ...]
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import * as E from '../engine/browser.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const perFormat = +(process.argv[2] || 3);
const formats = process.argv.length > 3 ? process.argv.slice(3) : ['gen9vgc2026regi', 'gen9vgc2025regi', 'gen9vgc2025regj', 'gen9doublesou',
  'gen8vgc2022', 'gen7vgc2019ultraseries', 'gen6vgc2016', 'gen5doublesou', 'gen4doublesou'];
const index = JSON.parse(fs.readFileSync(path.join(root, 'stats', 'index.json'), 'utf8'));
const statsFor = id => { const k = E.statsFormat(id, index); return k ? JSON.parse(fs.readFileSync(path.join(root, 'stats', k + '.json'), 'utf8')) : null; };
let seed = 4242;
const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
const nameOf = ident => ident.replace(/^p\d[a-c]?: /, '');

// What the replay's Pokemon did, as each side's choice ('move 2 1 terastallize, switch 4').
function playedChoices(rep, t, battle) {
  const acts = E.playedActions(rep, t), out = {};
  for (const [si, p] of [[0, 'p1'], [1, 'p2']]) {
    const side = battle.sides[si], req = side.activeRequest;
    if (!req || req.wait) continue;
    const parts = [];
    for (const [place, act] of req.active.entries()) {
      const mon = side.active[place];
      if (!mon || mon.fainted || req.forceSwitch) continue;
      const a = acts[si][place] || {kind: 'cant'};   // (nothing shows: the battle ended first, or it fainted)
      if (a.kind === 'switch') {
        const n = req.side.pokemon.findIndex(x => nameOf(x.ident) === a.name) + 1;
        if (!n) return {problem: `${p}${'ab'[place]}: switch to ${a.name} not offered`};
        parts.push('switch ' + n);
        continue;
      }
      const i = a.kind === 'cant' ? act.moves.findIndex(m => !m.disabled) : act.moves.findIndex((_, i) => E.moveNames(act, i + 1).includes(E.toID(a.name)));
      if (i < 0) return {problem: `${p}${'ab'[place]}: ${a.name} not offered (${act.moves.map(m => m.move).join(', ')})`};
      let g = a.gimmick === 'mega' ? (act.canMegaEvo ? 'mega' : act.canMegaEvoX ? 'megax' : 'megay') : a.gimmick;
      const type = E.targetType(act, i, g);
      const target = E.targetLoc(type, a.target, si, place) ?? (E.needsTarget(type) ? E.targetsFor(type, battle, si, place)[0] : null);
      parts.push(['move', i + 1, target, g].filter(x => x !== null && x !== '' && x !== undefined).join(' '));
    }
    if (parts.length) out[p] = parts.join(', ');
  }
  return {choices: out};
}

// Random choices for each side, from what the menu offers each place.
function randomChoices(battle) {
  const out = {};
  for (const [si, p] of [[0, 'p1'], [1, 'p2']]) {
    const side = battle.sides[si], req = side.activeRequest;
    if (!req || req.wait) continue;
    if (req.teamPreview) { out[p] = 'team ' + (1 + rnd(req.side.pokemon.length)); continue; }
    const taken = new Set(), parts = [];
    const bench = () => req.side.pokemon.map((x, n) => n).filter(n => !req.side.pokemon[n].active && !/fnt/.test(req.side.pokemon[n].condition) && !taken.has(n));
    if (req.forceSwitch) {
      req.forceSwitch.forEach(f => {
        if (!f) return;
        const b = bench();
        if (!b.length) { parts.push('pass'); return; }
        const n = b[rnd(b.length)]; taken.add(n); parts.push('switch ' + (n + 1));
      });
    } else {
      req.active.forEach((act, place) => {
        const mon = side.active[place];
        if (!mon || mon.fainted) return;
        const moves = act.moves.map((m, i) => i).filter(i => !act.moves[i].disabled && act.moves[i].pp !== 0);
        const b = act.trapped || mon.trapped ? [] : bench();
        if (b.length && (!moves.length || rnd(5) === 0)) { const n = b[rnd(b.length)]; taken.add(n); parts.push('switch ' + (n + 1)); return; }
        const i = moves.length ? moves[rnd(moves.length)] : 0;
        const targets = E.targetsFor(E.targetType(act, i), battle, si, place);
        parts.push(['move', i + 1, targets.length ? targets[rnd(targets.length)] : null].filter(x => x !== null).join(' '));
      });
    }
    if (parts.length) out[p] = parts.join(', ');
  }
  return out;
}

const problems = [];
let turns = 0, lines = 0, steps = 0, fitted = 0, close = 0, exact = 0;
for (const format of formats) {
  const list = await fetch(`https://replay.pokemonshowdown.com/search.json?format=${format}`).then(r => r.json()).then(l => l.filter(x => !x.id.startsWith('dev-'))).catch(() => []);
  const before = problems.length;
  for (const {id} of list.slice(0, perFormat)) {
    let rep;
    try { rep = E.parseReplayInput(await fetch(`https://replay.pokemonshowdown.com/${id}.json`).then(r => r.text())); } catch { continue; }
    if (!rep.lines.includes('|gametype|doubles') || rep.lastTurn < 2) continue;
    const st = statsFor(rep.formatid);
    // (a side with a Zoroark can pass one Pokemon off as another, which taking over cannot know)
    const illusion = E.revealedTeams(rep).map(team => team.some(k => Object.values(E.Dex.species.get(k.species).abilities || {}).includes('Illusion')));
    const sets = E.revealedTeams(rep).map(team => team.map(k => E.suggestSet(k, st, rep.gen)));
    for (let t = 1; t <= rep.lastTurn; t++) {
      let battle;
      try { battle = E.takeover(rep, t, sets, [1, 2, 3, 4]).battle; } catch (e) { problems.push(`${id} turn ${t}: takeover: ${e.message}`); break; }
      turns++;
      const {choices, problem} = playedChoices(rep, t, battle);
      if (problem) { if (!illusion[problem.startsWith('p2') ? 1 : 0]) problems.push(`${id} turn ${t}: ${problem}`); continue; }
      try { E.step(E.serialize(battle), choices, [], [1, 2, 3, 4]); } catch (e) { problems.push(`${id} turn ${t}: ${JSON.stringify(choices)}: ${e.message}`); continue; }
      // the turn's own dice, found from the log
      try { const fit = E.realDice(E.serialize(battle), choices, [5, 6, 7, 8], E.turnLog(rep, t)); fitted++; if (fit.close) close++; if (fit.exact) exact++; }
      catch (e) { problems.push(`${id} turn ${t}: real dice: ${e.message}`); }
    }
    for (let n = 0; n < 2; n++) {
      const t = 1 + rnd(rep.lastTurn);
      let battle;
      try { battle = E.takeover(rep, t, sets, [1, 2, 3, 4]).battle; } catch { continue; }
      lines++;
      for (let k = 0; k < 20 && !battle.ended; k++) {
        const choices = randomChoices(battle);
        try { battle = E.step(E.serialize(battle), choices, [], [rnd(65536), rnd(65536), rnd(65536), rnd(65536)]).battle; steps++; }
        catch (e) { problems.push(`${id} from turn ${t}, step ${k}: ${JSON.stringify(choices)}: ${e.message}`); break; }
      }
    }
  }
  console.log(`${format}: ${problems.length - before} problems`);
}
console.log(problems.slice(0, 40).join('\n'));
console.log(`real dice: ${exact} of ${fitted} turns play out exactly as logged, ${close} (${(100 * close / fitted).toFixed(1)}%) but for HP`);
console.log(`${turns} turns taken over, ${lines} lines (${steps} steps) played; ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
