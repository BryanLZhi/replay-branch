// Studies come from outside (share links, pasted exports) and from storage: rebuild them from what is expected, field by
// field, so nothing else in one ever reaches the page or the simulator.
import {E} from './state.js';
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

// An edited position (engine edit.mjs): known Pokemon places, statuses, stats, items, weathers, terrains and side
// conditions, numbers in range; null when nothing in it holds.
const KEY = /^[a-z0-9]{1,40}$/;
const isKey = (v, table) => typeof v === 'string' && KEY.test(v) && Object.keys(table).includes(v);
export function cleanEdit(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {mons: [], field: {}, sides: [{}, {}]};
  for (const m of (Array.isArray(e.mons) ? e.mons : []).slice(0, 48)) {
    if (!m || typeof m !== 'object' || ![0, 1].includes(m.s) || !Number.isInteger(m.k) || m.k < 0 || m.k > 23) continue;
    if (out.mons.some(x => x.s === m.s && x.k === m.k)) continue;
    const c = {s: m.s, k: m.k};
    if (Number.isInteger(m.hp) && m.hp >= 0 && m.hp <= 100) c.hp = m.hp;
    if (m.status === '' || E.EDIT_STATUSES.includes(m.status)) c.status = m.status;
    if (m.boosts && typeof m.boosts === 'object') {
      const b = {};
      for (const stat of E.EDIT_BOOSTS) if (Number.isInteger(m.boosts[stat]) && m.boosts[stat] >= -6 && m.boosts[stat] <= 6) b[stat] = m.boosts[stat];
      if (Object.keys(b).length) c.boosts = b;
    }
    if (m.item === '' || (typeof m.item === 'string' && KEY.test(m.item) && E.Dex.items.get(m.item).exists && E.Dex.items.get(m.item).id === m.item)) c.item = m.item;
    if (Object.keys(c).length > 2) out.mons.push(c);
  }
  const f = e.field && typeof e.field === 'object' ? e.field : {};
  if (f.weather === '' || isKey(f.weather, E.EDIT_WEATHERS)) out.field.weather = f.weather;
  if (f.terrain === '' || isKey(f.terrain, E.EDIT_TERRAINS)) out.field.terrain = f.terrain;
  if (f.trickroom === 0 || f.trickroom === 1) out.field.trickroom = f.trickroom;
  for (const si of [0, 1]) {
    const conds = Array.isArray(e.sides) && e.sides[si] && typeof e.sides[si] === 'object' ? e.sides[si] : {};
    for (const [id, c] of Object.entries(E.EDIT_SIDE)) if (Number.isInteger(conds[id]) && conds[id] >= 0 && conds[id] <= c[2]) out.sides[si][id] = conds[id];
  }
  const empty = !out.mons.length && !Object.keys(out.field).length && out.sides.every(c => !Object.keys(c).length);
  return empty ? null : out;
}

export function cleanStudy(raw, base) {
  const study = {rbv: 1, sets: cleanSets(raw?.sets, base), nodes: {}, kids: {}, notes: {}, seq: 0};
  if (str(raw?.name, 80).trim()) study.name = str(raw.name, 80).trim();
  const nodes = raw?.nodes && typeof raw.nodes === 'object' ? raw.nodes : {};
  // lines: n<k> under r<turn> or under another kept line (parents first)
  const ids = Object.keys(nodes).filter(id => /^n\d{1,6}$/.test(id)).sort((a, b) => +a.slice(1) - +b.slice(1));
  for (const id of ids) {
    const n = nodes[id];
    if (!n || typeof n !== 'object') continue;
    const parent = str(n.parent, 12);
    if (!/^r\d{1,4}$/.test(parent) && !study.nodes[parent]) continue;
    // (an edited position holds its edit instead of a turn)
    const edit = 'edit' in n ? cleanEdit(n.edit) : null;
    if ('edit' in n && (!edit || parent === 'r0')) continue;   // (none at team preview)
    const choices = {};
    if (!edit) for (const p of ['p1', 'p2']) if (typeof n.choices?.[p] === 'string' && CHOICE.test(n.choices[p])) choices[p] = n.choices[p];
    const seed = Array.isArray(n.seed) && n.seed.length === 4 && n.seed.every(x => Number.isInteger(x) && x >= 0 && x < 65536) ? n.seed : [1, 2, 3, 4];
    study.nodes[id] = {id, parent, choices, forced: edit ? [] : cleanForced(n.forced), ...(edit ? {edit} : {seed}), comment: str(n.comment, 2000),
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

// ---------------------------------------------------------------- studies of several replays (chapters.js)
export const MAX_CHAPTERS = 64;
// a replay's study key: its replay id, "log-<hash>", or a shared copy's "<key>~<hash>"
export const CHAPTER_KEY = /^[\w-]{1,120}(~[a-z0-9]{1,13})?$/;
const REPLAY_ID = /^[a-z0-9-]{1,120}$/;
const MAX_LOG = 4e6;

// A study as kept here: its name and its chapters (a replay's study key, a title when it has its own), in order.
export function cleanCollection(raw) {
  const chapters = [], seen = new Set();
  for (const ch of (Array.isArray(raw?.chapters) ? raw.chapters : []).slice(0, MAX_CHAPTERS)) {
    const key = str(ch?.key, 140);
    if (!CHAPTER_KEY.test(key) || seen.has(key)) continue;
    seen.add(key);
    const title = str(ch.title, 80).trim();
    // (a replay that is not on the replay site keeps its log here too: the chapter opens even once its own study is removed)
    // (and a new battle its teams)
    const log = typeof ch.log === 'string' && ch.log.length <= MAX_LOG ? ch.log : null;
    chapters.push({key, ...(title ? {title} : {}), ...(log ? {log} : {}), ...(log && Array.isArray(ch.teams) ? {teams: looseSets(ch.teams)} : {})});
  }
  const out = {name: str(raw?.name, 80).trim() || 'Study', chapters};
  if (chapters.some(ch => ch.key === raw?.last)) out.last = raw.last;
  if (Number.isFinite(raw?.opened)) out.opened = raw.opened;
  if (raw?.shared) out.shared = true;
  return out;
}

// A study's link: its name, and each chapter's replay (by id, or its log), title and study (cleaned by cleanChapterStudy).
export function cleanStudyLink(raw) {
  const chapters = [];
  for (const ch of (Array.isArray(raw?.chapters) ? raw.chapters : []).slice(0, MAX_CHAPTERS)) {
    if (!ch || typeof ch !== 'object') continue;
    const id = typeof ch.id === 'string' && REPLAY_ID.test(ch.id) ? ch.id : null;
    const log = !id && typeof ch.log === 'string' && ch.log.length <= MAX_LOG ? ch.log : null;
    if (!id && !log) continue;
    chapters.push({...(id ? {id} : {log}), title: str(ch.title, 80).trim(), study: ch.study && typeof ch.study === 'object' && !Array.isArray(ch.study) ? ch.study : null});
  }
  return {name: str(raw?.name, 80).trim() || 'Study', chapters};
}

// A chapter's study from a link, to keep until it is opened (when cleanStudy goes over it again with the replay's teams):
// the sets are kept as given, each cleaned, and a missing one stays missing (it becomes the suggestion then).
const looseSets = s => [0, 1].map(si => (Array.isArray(s?.[si]) ? s[si] : []).slice(0, 24)
  .map(set => set && typeof set === 'object' ? cleanSet(set, {name: '', species: ''}) : null));
export function cleanChapterStudy(raw) {
  const sets = looseSets;
  const study = cleanStudy(raw, [[], []]);
  study.sets = sets(raw?.sets);
  for (const [id, n] of Object.entries(study.nodes)) if (n.sets) n.sets = sets(raw.nodes[id].sets);
  delete study.meta; delete study.opened;   // (only ever this browser's own)
  return study;
}
