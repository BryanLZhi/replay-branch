// The dice a replay's turn actually rolled: the outcomes that make the simulator play the turn the way the log shows it
// (hits and misses, crits, damage rolls against the HP shown, side effects, speed ties...). Found one outcome at a time,
// in the order the turn rolls them, keeping whichever makes the simulated turn read most like the log.
import {step, toID} from './core.mjs';

// The log lines that random outcomes show in.
const KEPT = new Set(['move', '-miss', '-crit', '-damage', '-heal', '-sethp', '-status', '-curestatus', 'cant', '-boost', '-unboost',
  '-start', '-end', '-activate', '-hitcount', 'faint', '-fail', '-immune', '-enditem', '-item', '-ability', '-sidestart', '-fieldstart']);
const HP = new Set(['-damage', '-heal', '-sethp']);

function hp(s) {
  const m = /^(\d+)(?:\/(\d+))?/.exec(s || '');
  return m ? {n: +m[1], d: m[2] ? +m[2] : 100} : null;
}
// (Pokemon by side only: the simulator's names can differ from the log's nicknames, and this is singles)
function tokens(lines) {
  const out = [];
  for (const l of lines) {
    const a = l.split('|'), kind = a[1];
    if (!KEPT.has(kind)) continue;
    const who = (a[2] || '').slice(0, 2);
    const from = toID((/\[from\] ?([^|]*)/.exec(l) || [])[1] || '');
    if (HP.has(kind)) out.push({key: [kind, who, from].join('|'), hp: hp(a[3])});
    else out.push({key: [kind, who, toID(a[3] || ''), kind === '-boost' || kind === '-unboost' ? a[4] : '', from].join('|')});
  }
  return out;
}
// The HP the log would show for the simulator's exact HP, on the log's scale (percent, or pixels in old replays).
function shown(sim, scale) {
  if (!sim || !scale) return null;
  if (scale.d === sim.d) return sim.n;
  if (sim.n === 0) return 0;
  const v = Math.ceil(sim.n / sim.d * scale.d);
  return v === scale.d && sim.n < sim.d ? scale.d - 1 : v;
}

// How much the simulated turn reads like the log: each matching line scores, a matching HP more, an extra line costs.
function score(sim, log) {
  const w = (s, l) => {
    if (s.key !== l.key) return -1;
    if (!l.hp) return 3;
    const off = Math.abs(shown(s.hp, l.hp) - l.hp.n);
    return off === 0 ? 4 : off <= 1 ? 3.5 : 3;
  };
  let prev = new Array(log.length + 1).fill(0);
  for (let i = 1; i <= sim.length; i++) {
    const row = [0];
    for (let j = 1; j <= log.length; j++) {
      const m = w(sim[i - 1], log[j - 1]);
      row[j] = Math.max(prev[j], row[j - 1], m > 0 ? prev[j - 1] + m : -Infinity);
    }
    prev = row;
  }
  return prev[log.length] - sim.length;
}
const best = sim => sim.reduce((s, t) => s + (t.hp ? 3 : 2), 0);   // every line matched, every HP exact

function options(r) {
  if (r.kind === 'chance') return [r.value, !r.value];
  if (r.kind === 'roll') return [r.value, ...Array.from({length: r.hi - r.lo}, (_, k) => r.lo + k).filter(v => v !== r.value)];
  if (r.kind === 'int' && r.hi - r.lo <= 12) return [r.value, ...Array.from({length: r.hi - r.lo}, (_, k) => r.lo + k).filter(v => v !== r.value)];
  if (r.kind === 'pick' && r.options.length <= 12) return [r.value, ...r.options.map((_, k) => k).filter(v => v !== r.value)];
  if (r.kind === 'order' && r.options.length <= 3) {
    const perms = r.options.length === 2 ? [[0, 1], [1, 0]] : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    return [r.value, ...perms.filter(p => JSON.stringify(p) !== JSON.stringify(r.value))];
  }
  return [r.value];
}

// The turn's log lines: from |turn|t to the next |turn| (from the start of the battle for team preview, t = 0).
export function turnLog(rep, t) {
  const a = t ? rep.turnIdx[t] : rep.lines.findIndex(l => l.startsWith('|start'));
  const b = rep.turnIdx[t + 1] ?? rep.lines.length;
  return rep.lines.slice(a + 1, b);
}

// Forced outcomes (as step() takes them) for every random outcome of the step from `json` with these choices, as
// the log shows them; and whether the simulated turn then reads exactly like the log.
export function realDice(json, choices, seed, logLines) {
  const log = tokens(logLines);
  const run = forced => {
    const r = step(json, choices, forced, seed), sim = tokens(r.lines), s = score(sim, log);
    return {r, s, perfect: s === best(sim), close: s >= 2 * sim.length};
  };
  let cur = run([]), forced = [];
  for (let i = 0; i < cur.r.rolls.length && !cur.perfect; i++) {
    const roll = cur.r.rolls[i];
    let keep = cur, keepForced = forced.concat({key: roll.key, value: roll.value});
    for (const v of options(roll).slice(1)) {
      const f = forced.concat({key: roll.key, value: v});
      let out; try { out = run(f); } catch { continue; }   // (an outcome the simulator cannot play on from)
      if (out.s > keep.s) { keep = out; keepForced = f; if (out.perfect) break; }
    }
    cur = keep; forced = keepForced;
  }
  return {forced: cur.r.rolls.map(r => ({key: r.key, value: r.value})), exact: cur.perfect, close: cur.close, rolls: cur.r.rolls};
}
