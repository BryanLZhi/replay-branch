// Facts read straight from the replay's protocol log.
import {S, E, pid, nameOf} from './state.js';

export const isDoubles = () => S.rep.lines.includes('|gametype|doubles');
// (triples, free-for-all and multi battles can only be watched)
export const watchOnly = () => S.rep.lines.some(l => /^\|gametype\|(triples|freeforall|multi)/.test(l));
export const startIndex = () => S.rep.lines.findIndex(l => l === '|start');
export const playerName = si => S.cbEnd[pid(si)].name || 'Player ' + (si + 1);
export const teamIndex = (si, name) => S.cbEnd[pid(si)].team.findIndex(p => p.name === name);

// Protocol lines of replay turn t (after its "|turn|t" line, up to the next turn).
export function turnLines(t) {
  const a = S.rep.turnIdx[t], b = S.rep.turnIdx[t + 1] ?? S.rep.lines.length;
  return S.rep.lines.slice(a + 1, b);
}
export const turnSummary = t => E.summarize(turnLines(t));

const family = g => g && g.startsWith('mega') ? 'mega' : g || '';   // Mega Evolution X / Y are both Mega Evolution

// What a Pokemon actually did: the lead in its place at team preview (t = 0), else its first action of turn t
// ({kind, name, target, gimmick}; a Z-Move or Max Move is named as such; see engine playedActions). Nothing shown (the
// battle ended first) counts as any move.
const acted = new WeakMap();
export function playedChoice(t, si, place = 0) {
  const p = pid(si);
  if (t === 0) { const lead = E.replayLeads(S.rep)[p + 'abc'[place]]; return lead ? {kind: 'lead', name: lead} : null; }
  if (!acted.has(S.rep)) acted.set(S.rep, new Map());
  const turns = acted.get(S.rep);
  if (!turns.has(t)) turns.set(t, E.playedActions(S.rep, t));
  return turns.get(t)[si][place] || {kind: 'cant', gimmick: ''};
}

// The names move n can show up under in the log: itself, its Z-Move, its Max Move.
export const moveNames = (active, n) => E.moveNames(active, n);

// Does a pick ('move 2', 'move 2 1', 'switch 4', 'team 1', with its gimmick) of a Pokemon in this place match what it did?
// (def: the pick the replay's choice reads as; in doubles a move aimed elsewhere than the log shows does not match)
export function matchesPlayed(side, pick, gimmick, played, place = 0, def = null) {
  if (!played || !pick) return false;
  const [kind, n, target] = pick.split(' ');
  const req = side.activeRequest;
  if (played.kind === 'lead') return nameOf(req.side.pokemon[n - 1].ident) === played.name;
  if (played.kind === 'cant') return kind === 'move';   // fully paralyzed, asleep...: any move matches
  if (kind !== played.kind) return false;
  if (kind === 'move') {
    if (played.target && def && def.pick.split(' ')[2] !== target) return false;
    return moveNames(req.active[place], n).includes(E.toID(played.name)) && family(gimmick) === family(played.gimmick);
  }
  return nameOf(req.side.pokemon[n - 1].ident) === played.name;
}
