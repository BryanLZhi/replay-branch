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

// The once-per-battle mechanic a protocol line shows a player using, as the choice names it.
const GIMMICKS = {'-terastallize': 'terastallize', '-mega': 'mega', '-burst': 'ultra', '-zpower': 'zmove'};
const gimmickOf = (kind, what) => GIMMICKS[kind] || (kind === '-start' && what === 'Dynamax' ? 'dynamax' : '');
const family = g => g && g.startsWith('mega') ? 'mega' : g || '';   // Mega Evolution X / Y are both Mega Evolution

// What a player actually did: their lead at team preview (t = 0), else their first action of turn t
// ({kind, name, gimmick}; a Z-Move or Max Move is named as such).
export function playedChoice(t, si) {
  const p = pid(si);
  if (t === 0) { const lead = E.replayLeads(S.rep)[p]; return lead ? {kind: 'lead', name: lead} : null; }
  let first = null, gimmick = '';
  for (const line of turnLines(t)) {
    const [, kind, who = '', what] = line.split('|');
    if (!who.startsWith(p)) continue;
    gimmick ||= gimmickOf(kind, what);
    if (first) continue;
    if (kind === 'move' && !line.includes('[from]')) first = {kind: 'move', name: what};
    else if (kind === 'switch') first = {kind: 'switch', name: nameOf(who)};
    else if (kind === 'cant') first = {kind: 'cant'};
  }
  return first && {...first, gimmick};
}

// The names move n can show up under in the log: itself, its Z-Move, its Max Move.
// (The log calls every Hidden Power just that, and Return / Frustration without the power the request adds in old gens.)
export function moveNames(active, n) {
  return [active.moves[n - 1]?.move, active.canZMove?.[n - 1]?.move, active.maxMoves?.maxMoves?.[n - 1]?.move].filter(Boolean)
    .map(m => E.toID(m).replace(/^hiddenpower.+/, 'hiddenpower').replace(/^(return|frustration)\d+$/, '$1'));
}

// Does a pick ('move 2', 'switch 4', 'team 1', with its gimmick) match what was played?
export function matchesPlayed(side, pick, gimmick, played) {
  if (!played || !pick) return false;
  const [kind, n] = pick.split(' ');
  const req = side.activeRequest;
  if (played.kind === 'lead') return nameOf(req.side.pokemon[n - 1].ident) === played.name;
  if (played.kind === 'cant') return kind === 'move';   // fully paralyzed, asleep...: any move matches
  if (kind !== played.kind) return false;
  if (kind === 'move') return moveNames(req.active[0], n).includes(E.toID(played.name)) && family(gimmick) === family(played.gimmick);
  return nameOf(req.side.pokemon[n - 1].ident) === played.name;
}
