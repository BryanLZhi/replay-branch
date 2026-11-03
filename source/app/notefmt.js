// Notes as readable text: a small Markdown subset (**bold**, *italic* / _italic_, `code`, "- " bullet lines, line breaks,
// http(s) links) and the names of Pokemon and moves shown as they are in the game (a Pokemon's icon, a move in its type's
// colour), each with a tooltip. Every piece of the note's text is escaped before it reaches the page, so a note can never
// put markup or script there; links are http(s) only, with rel="noopener noreferrer nofollow", and open in a new tab.
import {E, esc} from './state.js';

const icon = species => { try { return Dex.getPokemonIcon(species); } catch { return ''; } };
// a placeholder for HTML already built: NUL, a private-use character (its index), NUL - which no name, emphasis or escaping
// touches (a note's own NULs are dropped first)
const ph = k => '\u0000' + String.fromCharCode(0xe000 + k) + '\u0000';
const restore = (t, keep) => t.replace(/\u0000([-])\u0000/g, (_, c) => keep[c.charCodeAt(0) - 0xe000]);
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// name lookup: the longest run of up to 4 words that is a Pokemon or a move, typed with a capital first letter (so "rest",
// "surf" or "protect" in a sentence stay words)
let names = null;
function nameTable() {
  if (names) return names;
  const tab = new Map();
  try {
    for (const m of E.Dex.moves.all()) if (m.exists && !m.isNonstandard && m.num > 0) tab.set(norm(m.name), {kind: 'move', m});
    for (const s of E.Dex.species.all()) {
      if (!s.exists || s.isNonstandard === 'CAP' || s.num <= 0) continue;
      const k = norm(s.name);
      if (!tab.has(k) || tab.get(k).kind === 'move') tab.set(k, {kind: 'pokemon', s});
    }
  } catch { return new Map(); }   // (no engine yet: names stay plain; try again next time)
  return (names = tab);
}
function moveTitle(m) {
  const bits = [m.type, m.category];
  if (m.category !== 'Status' && m.basePower) bits.push(`${m.basePower} BP`);
  bits.push(m.accuracy === true ? 'never misses' : `${m.accuracy}% accuracy`);
  if (m.priority) bits.push(`priority ${m.priority > 0 ? '+' : ''}${m.priority}`);
  return `${m.name}: ${bits.join(', ')}${m.shortDesc ? '. ' + m.shortDesc : ''}`;
}
function monTitle(s) {
  const st = s.baseStats || {};
  return `${s.name}: ${s.types.join('/')}; ${Object.values(s.abilities || {}).join(' / ')}; ` +
    ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(k => st[k]).join('/');
}
// shown: the escaped text as typed
function entityHTML(shown, e) {
  if (e.kind === 'pokemon') {
    return `<span class="rb-ent rb-mon-ent" title="${esc(monTitle(e.s))}"><span class="picon" style="${esc(icon(e.s.name))}"></span>${shown}</span>`;
  }
  return `<span class="rb-ent rb-move-ent rb-t-${esc(norm(e.m.type))}" title="${esc(moveTitle(e.m))}">${shown}</span>`;
}

// RAW text -> the text with the names replaced by placeholders (their escaped HTML goes into `keep`)
function markNames(t, keep) {
  const tab = nameTable();
  if (!tab.size) return t;
  // words: letters/digits with inner hyphens, apostrophes or periods (Mr. Mime, Farfetch'd, U-turn, Will-O-Wisp)
  const re = /[A-Za-z0-9À-ɏ](?:[A-Za-z0-9À-ɏ'’.\-]*[A-Za-z0-9À-ɏ])?/g;
  const words = [];
  for (let m; (m = re.exec(t));) words.push({i: m.index, j: m.index + m[0].length, w: m[0]});
  let out = '', last = 0;
  for (let a = 0; a < words.length; a++) {
    if (!/^[A-Z0-9À-Þ]/.test(words[a].w)) continue;
    let hit = null;
    for (let b = Math.min(words.length - 1, a + 3); b >= a && !hit; b--) {
      let ok = true;     // only words a single space apart, or ". " (Mr. Mime) (a name never spans other punctuation or a line)
      for (let c = a; c < b; c++) if (!/^\.? $/.test(t.slice(words[c].j, words[c + 1].i))) { ok = false; break; }
      if (!ok) continue;
      const e = tab.get(norm(t.slice(words[a].i, words[b].j)));
      if (e) hit = {b, e};
    }
    if (!hit) continue;
    const i = words[a].i, j = words[hit.b].j;
    keep.push(entityHTML(esc(t.slice(i, j)), hit.e));
    out += t.slice(last, i) + ph(keep.length - 1);
    last = j;
    a = hit.b;
  }
  return out + t.slice(last);
}

// one line of RAW text -> HTML: code spans (nothing inside them is formatted), links and names are built (escaped) first and
// kept aside; the rest is escaped; then emphasis (* and _ are not touched by escaping)
function inline(t, keep) {
  t = t.replace(/\u0000/g, '');
  t = t.replace(/`([^`\n]+)`/g, (_, c) => { keep.push(`<code>${esc(c)}</code>`); return ph(keep.length - 1); });
  t = t.replace(/\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g, u => {
    keep.push(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(u)}</a>`);
    return ph(keep.length - 1);
  });
  t = esc(markNames(t, keep));
  t = t.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  return t;
}

// a note as HTML. flow: one running line (in a move-list token): bullets become "•", lines are joined with " · "
export function noteHTML(text, {flow = false} = {}) {
  const keep = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  if (flow) return restore(lines.map(l => l.replace(/^\s*[-*]\s+/, '• ')).filter(l => l.trim()).map(l => inline(l, keep)).join(' · '), keep);
  let html = '', list = false;
  for (const l of lines) {
    const b = /^\s*[-*]\s+(.*)$/.exec(l);
    if (b) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(b[1], keep)}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    html += l.trim() ? `<div>${inline(l, keep)}</div>` : '<div class="rb-gap"></div>';
  }
  if (list) html += '</ul>';
  return restore(html, keep);
}

// Ctrl+B / Ctrl+I (Cmd on a Mac) in a note box: wrap the selection (or the word at the caret) in ** or *; again: unwrap
export function noteKeys(box, onChange) {
  box.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    const mark = k === 'b' ? '**' : k === 'i' ? '*' : null;
    if (!mark) return;
    e.preventDefault();
    const v = box.value;
    let s = box.selectionStart, f = box.selectionEnd;
    if (s === f) {      // the word at the caret
      while (s > 0 && /\S/.test(v[s - 1])) s--;
      while (f < v.length && /\S/.test(v[f])) f++;
    }
    const n = mark.length, sel = v.slice(s, f);
    const wrapped = v.slice(Math.max(0, s - n), s) === mark && v.slice(f, f + n) === mark &&
      !(mark === '*' && (v[s - n - 1] === '*' || v[f + n] === '*'));
    if (wrapped) {
      box.value = v.slice(0, s - n) + sel + v.slice(f + n);
      box.setSelectionRange(s - n, f - n);
    } else {
      box.value = v.slice(0, s) + mark + sel + mark + v.slice(f);
      box.setSelectionRange(s + n, f + n);
    }
    onChange(box.value);
  });
}
