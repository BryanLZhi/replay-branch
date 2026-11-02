// The study tree. Replay positions are 'r<turn>' (start of that turn; 'r0' = team preview, r<last+1> = the end).
// Your lines are nodes 'n<k>' hanging off a replay position or another node; each stores only the choices, the dice
// it forced and a seed, so every position is recomputed from them on demand.
import {S, E, clone, hash, stored, store} from './state.js';

const SEED = [11, 22, 33, 44];   // fixed seed for setting up positions on the replay

export const GLYPHS = ['!!', '!', '!?', '?!', '?', '??'];

export const isReplayPos = id => id[0] === 'r';
export const replayTurn = id => +id.slice(1);

export function newStudy() { return {rbv: 1, sets: null, nodes: {}, kids: {}, notes: {}, seq: 0}; }
export function save() { store('rbv:' + S.key, JSON.stringify(S.study)); }
export function loadSaved(key) { try { return JSON.parse(stored('rbv:' + key, 'null')); } catch { return null; } }

export const kids = id => S.study.kids[id] || [];
export function parentOf(id) {
  if (isReplayPos(id)) { const t = replayTurn(id); return t > 0 ? 'r' + (t - 1) : null; }
  return S.study.nodes[id]?.parent || null;
}
export function childrenOf(id) {
  if (!isReplayPos(id)) return kids(id);
  const next = replayTurn(id) <= S.rep.lastTurn ? ['r' + (replayTurn(id) + 1)] : [];
  return next.concat(kids(id));
}
export function siblings(id) { const p = parentOf(id); return p ? childrenOf(p) : [id]; }
// The line nodes from the replay down to id (empty on the replay).
export function pathTo(id) {
  const path = [];
  for (let n = id; n && !isReplayPos(n); n = S.study.nodes[n].parent) path.unshift(n);
  return path;
}
// Sets a line was started with (the study's sets at the time).
export const lineSets = id => S.study.nodes[pathTo(id)[0]].sets;

// Note (glyph + comment) of a position; created on demand for replay positions.
export function noteOf(id, create) {
  if (!isReplayPos(id)) return S.study.nodes[id];
  if (create) S.study.notes[id] ||= {};
  return S.study.notes[id] || {};
}

// Simulator position at the start of replay turn t, with these sets.
export function replayTurnPos(t, sets) {
  const k = t + ':' + hash(JSON.stringify(sets));
  if (!S.replayPos.has(k)) { const {battle} = E.takeover(S.rep, t, sets, SEED); S.replayPos.set(k, {json: E.serialize(battle), battle}); }
  return S.replayPos.get(k);
}
// Simulator position at team preview (null when the format has none).
export function previewPos(sets) {
  const k = 'preview:' + hash(JSON.stringify(sets));
  if (!S.replayPos.has(k)) { const battle = E.previewBattle(S.rep, sets, SEED); S.replayPos.set(k, battle && {json: E.serialize(battle), battle}); }
  return S.replayPos.get(k);
}

// Play a line node from its parent position: {json, battle, lines (protocol), rolls (dice)}.
export function compute(id) {
  if (S.lines.has(id)) return S.lines.get(id);
  const n = S.study.nodes[id];
  const from = n.parent === 'r0' ? previewPos(n.sets).json
    : isReplayPos(n.parent) ? replayTurnPos(replayTurn(n.parent), n.sets).json
    : compute(n.parent).json;
  const r = E.step(from, n.choices, n.forced, n.seed);
  const out = {json: E.serialize(r.battle), battle: r.battle, lines: r.lines, rolls: r.rolls};
  S.lines.set(id, out);
  return out;
}
export function forget(id) { S.lines.delete(id); for (const k of kids(id)) forget(k); }

export const newSeed = () => [0, 0, 0, 0].map(() => Math.floor(Math.random() * 65536));
export function addNode(parent, choices, forced, seed, sets) {
  const id = 'n' + (++S.study.seq);
  S.study.nodes[id] = {id, parent, choices, forced: forced || [], seed: seed || newSeed(), sets: sets && clone(sets), comment: '', glyph: ''};
  (S.study.kids[parent] ||= []).push(id);
  save();
  return id;
}
export function deleteNode(id) {
  for (const k of kids(id).slice()) deleteNode(k);
  const n = S.study.nodes[id];
  if (!n) return;
  const list = S.study.kids[n.parent] || [];
  if (list.includes(id)) list.splice(list.indexOf(id), 1);
  delete S.study.nodes[id]; delete S.study.kids[id]; S.lines.delete(id);
}
export function promote(id) {
  const list = S.study.kids[S.study.nodes[id].parent];
  list.splice(list.indexOf(id), 1); list.unshift(id);
  save();
}
