// Facts read straight from the replay's protocol log.
import {S, E, pid, nameOf} from './state.js';

export const isDoubles = () => S.rep.lines.some(l => l === '|gametype|doubles' || l === '|gametype|triples');
export const startIndex = () => S.rep.lines.findIndex(l => l === '|start');
export const playerName = si => S.cbEnd[pid(si)].name || 'Player ' + (si + 1);
export const teamIndex = (si, name) => S.cbEnd[pid(si)].team.findIndex(p => p.name === name);

// Protocol lines of replay turn t (after its "|turn|t" line, up to the next turn).
export function turnLines(t) {
  const a = S.rep.turnIdx[t], b = S.rep.turnIdx[t + 1] ?? S.rep.lines.length;
  return S.rep.lines.slice(a + 1, b);
}
export const turnSummary = t => E.summarize(turnLines(t));

// What a player actually did: their lead at team preview (t = 0), else their first action of turn t.
export function playedChoice(t, si) {
  const p = pid(si);
  if (t === 0) { const lead = E.replayLeads(S.rep)[p]; return lead ? {kind: 'lead', name: lead} : null; }
  let first = null, tera = false;
  for (const line of turnLines(t)) {
    const [, kind, who = '', what] = line.split('|');
    if (!who.startsWith(p)) continue;
    if (kind === '-terastallize') tera = true;
    if (first) continue;
    if (kind === 'move' && !line.includes('[from]')) first = {kind: 'move', name: what};
    else if (kind === 'switch') first = {kind: 'switch', name: nameOf(who)};
    else if (kind === 'cant') first = {kind: 'cant'};
  }
  return first && {...first, tera};
}

// Does a pick ('move 2', 'switch 4', 'team 1') match what was played?
export function matchesPlayed(side, pick, tera, played) {
  if (!played || !pick) return false;
  const [kind, n] = pick.split(' ');
  const req = side.activeRequest;
  if (played.kind === 'lead') return nameOf(req.side.pokemon[n - 1].ident) === played.name;
  if (played.kind === 'cant') return kind === 'move';   // fully paralyzed, asleep...: any move matches
  if (kind !== played.kind) return false;
  if (kind === 'move') return E.toID(req.active[0].moves[n - 1].move) === E.toID(played.name) && !!tera === !!played.tera;
  return nameOf(req.side.pokemon[n - 1].ident) === played.name;
}
