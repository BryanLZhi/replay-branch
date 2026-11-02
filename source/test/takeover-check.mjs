// Takes over every turn of recent replays (from replay.pokemonshowdown.com) and checks that the position offers what the
// players then did: the move (or its Z-Move / Max Move) or the switch, and Mega Evolution, Ultra Burst, Z-Power, Dynamax or
// Terastallization when they used it (and no longer once their side has).
//   node source/test/takeover-check.mjs [replays per format] [format ...]
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import * as E from '../engine/browser.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const perFormat = +(process.argv[2] || 3);
const formats = process.argv.length > 3 ? process.argv.slice(3) : ['gen1ou', 'gen2ou', 'gen3ou', 'gen4ou', 'gen5ou', 'gen6ou', 'gen7ou',
  'gen8ou', 'gen9ou', 'gen9nationaldex', 'gen7randombattle', 'gen8randombattle', 'gen9randombattle'];
const GIMMICKS = {'-terastallize': 'terastallize', '-mega': 'mega', '-burst': 'ultra', '-zpower': 'zmove'};
const OFFERED = {terastallize: 'canTerastallize', mega: 'canMegaEvo', ultra: 'canUltraBurst', zmove: 'canZMove', dynamax: 'canDynamax'};

const stats = {};
function statsFor(formatid) {
  if (!(formatid in stats)) {
    const file = path.join(root, 'stats', formatid + '.json');
    stats[formatid] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }
  return stats[formatid];
}

// What each player did in turn t: {kind: 'move'|'switch'|'other', name, gimmick}.
function played(rep, t) {
  const out = [null, null];
  const a = rep.turnIdx[t], b = rep.turnIdx[t + 1] ?? rep.lines.length;
  const gimmick = ['', ''];
  for (const line of rep.lines.slice(a + 1, b)) {
    const [, kind, who = '', what = ''] = line.split('|');
    const si = who.startsWith('p1') ? 0 : who.startsWith('p2') ? 1 : -1;
    if (si < 0) continue;
    gimmick[si] ||= GIMMICKS[kind] || (kind === '-start' && what === 'Dynamax' ? 'dynamax' : '');
    if (out[si]) continue;
    if (kind === 'move') out[si] = line.includes('[from]') || what === 'Struggle' ? {kind: 'other'} : {kind: 'move', name: what};
    else if (kind === 'switch') out[si] = {kind: 'switch', name: who.replace(/^p\da: /, '')};
    else if (kind === 'cant') out[si] = {kind: 'other'};
  }
  return out.map((p, si) => p && {...p, gimmick: gimmick[si]});
}

let checked = 0;
const problems = [];
for (const format of formats) {
  const list = await fetch(`https://replay.pokemonshowdown.com/search.json?format=${format}`).then(r => r.json()).catch(() => []);
  for (const {id} of list.slice(0, perFormat)) {
    let rep;
    try { rep = E.parseReplayInput(await fetch(`https://replay.pokemonshowdown.com/${id}.json`).then(r => r.text())); } catch { continue; }   // (unfinished or broken)
    if (rep.lines.some(l => /^\|gametype\|(doubles|triples|freeforall)/.test(l))) continue;
    const sets = E.revealedTeams(rep).map(team => team.map(known => E.suggestSet(known, statsFor(rep.formatid), rep.gen)));
    const used = [new Set(), new Set()];
    for (let t = 1; t <= rep.lastTurn; t++) {
      let battle;
      try { battle = E.takeover(rep, t, sets, [1, 2, 3, 4]).battle; } catch (e) { problems.push(`${id} turn ${t}: takeover failed: ${e.message}`); break; }
      checked++;
      played(rep, t).forEach((p, si) => {
        const req = battle.sides[si].activeRequest;
        if (!p || p.kind === 'other' || !req || req.wait || req.forceSwitch) return;
        const act = req.active[0];
        if (p.kind === 'move') {
          const names = act.moves.flatMap((m, i) => [m.move, act.canZMove?.[i]?.move, act.maxMoves?.maxMoves?.[i]?.move]).filter(Boolean)
            .map(m => E.toID(m).replace(/^hiddenpower.+/, 'hiddenpower').replace(/^(return|frustration)\d+$/, '$1'));
          if (!names.includes(E.toID(p.name))) problems.push(`${id} turn ${t} p${si + 1}: ${p.name} not offered (${act.moves.map(m => m.move).join(', ')})`);
        } else if (!req.side.pokemon.some(x => !x.active && x.ident.endsWith(': ' + p.name) && !/fnt/.test(x.condition))) {
          problems.push(`${id} turn ${t} p${si + 1}: switch to ${p.name} not offered`);
        }
        for (const g of used[si]) if (act[OFFERED[g]] && g !== 'terastallize') problems.push(`${id} turn ${t} p${si + 1}: ${g} offered again`);
        if (p.gimmick) {
          if (p.kind === 'move' && !act[OFFERED[p.gimmick]] && !(p.gimmick === 'mega' && (act.canMegaEvoX || act.canMegaEvoY))) {
            problems.push(`${id} turn ${t} p${si + 1}: ${p.gimmick} used but not offered`);
          }
          used[si].add(p.gimmick);
        }
      });
    }
  }
  console.log(`${format}: done`);
}
console.log(problems.join('\n'));
console.log(`${checked} turns taken over; ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
