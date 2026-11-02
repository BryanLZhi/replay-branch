// Studies come from outside (share links, pasted exports) and from storage: rebuild them from what is expected, field by
// field, so nothing else in one ever reaches the page or the simulator.
import {GLYPHS} from './study.js';

const str = (v, max = 100) => typeof v === 'string' ? v.slice(0, max) : '';
const int = (v, lo, hi, fallback) => Number.isInteger(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const stats = (o, max, fallback) => Object.fromEntries(STATS.map(s => [s, int(o?.[s], 0, max, fallback)]));
const CHOICE = /^(move [1-4]( (mega|megax|megay|ultra|zmove|dynamax|terastallize))?|switch [1-6]|team [1-6]|pass)$/;

function cleanSet(set, fallback) {
  if (!set || typeof set !== 'object') return JSON.parse(JSON.stringify(fallback));
  const out = {
    name: str(set.name, 40) || fallback.name, species: str(set.species, 40) || fallback.species, item: str(set.item, 40),
    ability: str(set.ability, 40), nature: str(set.nature, 20), teraType: str(set.teraType, 20), gender: str(set.gender, 2),
    moves: (Array.isArray(set.moves) ? set.moves : []).slice(0, 4).map(m => str(m, 40)),
    evs: stats(set.evs, 255, 0), ivs: stats(set.ivs, 31, 31), level: int(set.level, 1, 100, 100),
    itemGone: !!set.itemGone, fixed: fallback.fixed,
  };
  if (set.pasted) out.pasted = true;
  return out;
}
// Sets for both sides, in the shape of `base` (the replay's teams); anything that does not fit is the suggestion.
export function cleanSets(sets, base) {
  return base.map((side, si) => side.map((b, k) => cleanSet(Array.isArray(sets?.[si]) ? sets[si][k] : null, b)));
}

function cleanForced(list) {
  const value = v => typeof v === 'boolean' || Number.isInteger(v) ? v
    : Array.isArray(v) && v.length <= 8 && v.every(Number.isInteger) ? v : undefined;
  return (Array.isArray(list) ? list : []).slice(0, 200).map(f => ({key: str(f?.key, 200), value: value(f?.value)}))
    .filter(f => f.key && f.value !== undefined);
}

export function cleanStudy(raw, base) {
  const study = {rbv: 1, sets: cleanSets(raw?.sets, base), nodes: {}, kids: {}, notes: {}, seq: 0};
  const nodes = raw?.nodes && typeof raw.nodes === 'object' ? raw.nodes : {};
  // lines: n<k> under r<turn> or under another kept line (parents first)
  const ids = Object.keys(nodes).filter(id => /^n\d{1,6}$/.test(id)).sort((a, b) => +a.slice(1) - +b.slice(1));
  for (const id of ids) {
    const n = nodes[id];
    if (!n || typeof n !== 'object') continue;
    const parent = str(n.parent, 12);
    if (!/^r\d{1,4}$/.test(parent) && !study.nodes[parent]) continue;
    const choices = {};
    for (const p of ['p1', 'p2']) if (typeof n.choices?.[p] === 'string' && CHOICE.test(n.choices[p])) choices[p] = n.choices[p];
    const seed = Array.isArray(n.seed) && n.seed.length === 4 && n.seed.every(x => Number.isInteger(x) && x >= 0 && x < 65536) ? n.seed : [1, 2, 3, 4];
    study.nodes[id] = {id, parent, choices, forced: cleanForced(n.forced), seed, comment: str(n.comment, 2000),
      glyph: GLYPHS.includes(n.glyph) ? n.glyph : '', ...(/^r/.test(parent) ? {sets: cleanSets(n.sets, base)} : {})};
    study.seq = Math.max(study.seq, +id.slice(1));
  }
  // the order of the lines under each position, as it was
  for (const id of Object.keys(study.nodes)) {
    const parent = study.nodes[id].parent;
    (study.kids[parent] ||= []).push(id);
  }
  for (const [parent, list] of Object.entries(study.kids)) {
    const order = Array.isArray(raw?.kids?.[parent]) ? raw.kids[parent] : [];
    list.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  }
  for (const [id, note] of Object.entries(raw?.notes && typeof raw.notes === 'object' ? raw.notes : {})) {
    if (/^r\d{1,4}$/.test(id)) study.notes[id] = {comment: str(note?.comment, 2000), glyph: GLYPHS.includes(note?.glyph) ? note.glyph : ''};
  }
  if (raw?.meta && typeof raw.meta === 'object') {   // (only ever this browser's own)
    study.meta = {format: str(raw.meta.format), players: (Array.isArray(raw.meta.players) ? raw.meta.players : []).slice(0, 2).map(p => str(p, 40)),
      ...(typeof raw.meta.log === 'string' ? {log: raw.meta.log} : {}),
      ...(/^[a-z0-9-]{1,120}$/.test(raw.meta.replayId || '') ? {replayId: raw.meta.replayId} : {}), ...(raw.meta.shared ? {shared: true} : {})};
  }
  if (Number.isFinite(raw?.opened)) study.opened = raw.opened;
  return study;
}
