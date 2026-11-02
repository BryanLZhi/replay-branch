// How well the real dice of replay turns are found: for every turn of recent replays, plays the turn with the players'
// choices and the dice found from the log, and counts the turns that then read exactly like the log.
//   node source/test/realdice-check.mjs [replays per format] [format ...]
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import * as E from '../engine/browser.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const perFormat = +(process.argv[2] || 3);
const formats = process.argv.length > 3 ? process.argv.slice(3) : ['gen9ou', 'gen9randombattle', 'gen8ou', 'gen7ou', 'gen6ou', 'gen5ou', 'gen4ou', 'gen3ou', 'gen2ou', 'gen1ou'];
const statsFor = id => { const f = path.join(root, 'stats', id + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const nameOf = ident => ident.replace(/^p\d[a-d]?: /, '');
const GIMMICKS = {'-terastallize': 'terastallize', '-mega': 'mega', '-burst': 'ultra', '-zpower': 'zmove'};

// The players' choices in turn t, as the move menu would make them (null if one cannot be told).
function played(rep, t, battle) {
  const lines = E.turnLog(rep, t), choices = {};
  for (const [si, p] of [[0, 'p1'], [1, 'p2']]) {
    const req = battle.sides[si].activeRequest;
    if (!req || req.wait) continue;
    let pick = null, gimmick = '';
    for (const l of lines) {
      const [, kind, who = '', what] = l.split('|');
      if (!who.startsWith(p)) continue;
      gimmick ||= GIMMICKS[kind] || (kind === '-start' && what === 'Dynamax' ? 'dynamax' : '');
      if (pick) continue;
      if (kind === 'faint') pick = 'move ' + (req.active[0].moves.findIndex(m => !m.disabled) + 1);
      else if (kind === 'move' && !l.includes('[from]')) {
        const i = req.active[0].moves.findIndex(m => E.toID(m.move).replace(/^hiddenpower.+/, 'hiddenpower') === E.toID(what).replace(/^hiddenpower.+/, 'hiddenpower'));
        if (i < 0) return null;
        pick = 'move ' + (i + 1);
      } else if (kind === 'switch') {
        const i = req.side.pokemon.findIndex(x => nameOf(x.ident) === nameOf(who));
        if (i < 0) return null;
        pick = 'switch ' + (i + 1);
      } else if (kind === 'cant') pick = 'move ' + (req.active[0].moves.findIndex(m => !m.disabled) + 1);
    }
    if (!pick) return null;
    if (gimmick === 'mega') gimmick = req.active[0].canMegaEvo ? 'mega' : req.active[0].canMegaEvoX ? 'megax' : 'megay';
    choices[p] = pick.startsWith('move') && gimmick ? pick + ' ' + gimmick : pick;
  }
  return choices;
}

// The outcomes dice decide that a log shows (misses, crits, can't-move, statuses, hit counts), by side.
const LUCK = /^\|(-miss|-crit|cant|-status|-hitcount)\|/;
const luck = lines => lines.filter(l => LUCK.test(l) && !/\[from\] ?(item|ability|psn|brn)/.test(l)).map(l => { const a = l.split('|'); return a[1] + '|' + a[2].slice(0, 2) + '|' + E.toID(a[3] || ''); });
let shownLuck = 0, foundLuck = 0, extraLuck = 0;
let turns = 0, exact = 0, close = 0, plain = 0, ms = 0, worst = 0, failed = 0;
const misses = [];
for (const format of formats) {
  const list = await fetch(`https://replay.pokemonshowdown.com/search.json?format=${format}`).then(r => r.json()).catch(() => []);
  let f0 = turns, e0 = exact, c0 = close;
  for (const {id} of list.slice(0, perFormat)) {
    let rep;
    try { rep = E.parseReplayInput(await fetch(`https://replay.pokemonshowdown.com/${id}.json`).then(r => r.text())); } catch { continue; }
    if (rep.lines.some(l => /^\|gametype\|(doubles|triples|freeforall)/.test(l))) continue;
    const sets = E.revealedTeams(rep).map(team => team.map(k => E.suggestSet(k, statsFor(rep.formatid), rep.gen)));
    for (let t = 1; t <= rep.lastTurn; t++) {
      let battle;
      try { battle = E.takeover(rep, t, sets, [11, 22, 33, 44]).battle; } catch { failed++; continue; }
      const choices = played(rep, t, battle);
      if (!choices) continue;
      const json = E.serialize(battle), log = E.turnLog(rep, t);
      const t0 = performance.now();
      let fit;
      try { fit = E.realDice(json, choices, [1, 2, 3, 4], log); } catch (e) { failed++; continue; }
      const dt = performance.now() - t0;
      ms += dt; worst = Math.max(worst, dt); turns++;
      if (fit.close) close++;
      {
        // (only as far as the step goes: it can stop at a switch-in mid-turn)
        let seen = []; try { seen = luck(E.step(json, choices, fit.forced, [1, 2, 3, 4]).lines); } catch {}
        const want = luck(log);
        for (const k of want) { const i = seen.indexOf(k); if (i >= 0) { foundLuck++; seen.splice(i, 1); } }
        shownLuck += want.length; extraLuck += seen.length;
      }
      if (fit.exact) exact++; if (!fit.close && misses.length < 12) misses.push(`${id} ${t} '${JSON.stringify(choices)}'`);
      try { if (E.step(json, choices, [], [1, 2, 3, 4]).rolls.every((r, i) => JSON.stringify(r.value) === JSON.stringify(fit.forced[i]?.value))) plain++; } catch {}
    }
  }
  console.log(`${format}: ${exact - e0}/${turns - f0} turns exact, ${close - c0} but for HP`);
}
console.log(misses.join('\n'));
console.log(`lucky or unlucky outcomes in the logs: ${shownLuck}, found ${foundLuck}; outcomes found that the log does not show: ${extraLuck}`);
console.log(`${turns} turns: ${exact} read exactly like the log (${(100 * exact / turns).toFixed(1)}%), ${close} but for HP (${(100 * close / turns).toFixed(1)}%); ${plain} needed no change from the most likely dice; ` +
  `${(ms / turns).toFixed(0)} ms a turn on average, ${worst.toFixed(0)} ms at worst; ${failed} failed`);
