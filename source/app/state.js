// Shared page state and small helpers.

export const S = {
  rep: null,          // the parsed replay (engine.parseReplayInput)
  key: '',            // storage key for this replay's study
  stats: null,        // usage stats for the format, or null
  base: null,         // suggested sets per side: what the replay revealed, filled in from usage stats
  cbEnd: null,        // spectator view of the battle at the end of the replay (team order, names)
  study: null,        // {rbv, sets, nodes, kids, notes, seq}, saved per replay
  cur: '',            // current position: 'r<turn>' on the replay ('r0' = team preview), 'n<id>' in one of your lines
  sel: {},            // picks made so far this turn, by player ('p1', 'p2')
  tera: {},           // Terastallize ticked, by player
  err: '',            // last error to show in the picker
  tab: 'study',       // 'study' or 'teams'
  deleteArmed: null,  // line node that a second click on "Delete from here" will delete
  psb: null,          // the Showdown Battle shown in the replay viewer
  psMode: '',         // 'main' while showing the replay, 'line:<id>' while showing a line
  seeking: false,     // true while we move the viewer ourselves (ignore its events)
  stopAt: null,       // replay turn at which to pause (playing a single turn of the replay)
  wasPlaying: false,
  lines: new Map(),   // computed line positions by node id
  replayPos: new Map(), // simulator positions on the replay (team preview, start of a turn) by turn + sets
};

// The engine module (engine.js); set once at start-up.
export let E = null;
export function setEngine(engine) { E = engine; }

export const $id = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const clone = o => JSON.parse(JSON.stringify(o));
export const pid = si => 'p' + (si + 1);
export const nameOf = ident => ident.replace(/^p\d[a-d]?: /, '');

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function stored(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
}
export function store(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
