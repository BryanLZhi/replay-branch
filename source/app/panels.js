// The Study tab (the replay's turns with your lines under them, notes) and the Teams tab (the sets lines start with).
import {S, E, $id, esc, clone} from './state.js';
import {isReplayPos, replayTurn, kids, compute, noteOf, deleteNode, promote, save} from './study.js';
import {turnSummary, playerName} from './replay.js';
import {position, go} from './navigation.js';
import {renderPicker} from './picker.js';

const GLYPHS = ['!!', '!', '!?', '?!', '?', '??'];
const typeTag = t => t ? `<span class="rb-type t-${esc(t === '???' ? 'Unknown' : t)}">${esc(t)}</span>` : '';
const icon = species => { try { return Dex.getPokemonIcon(species); } catch { return ''; } };

export function renderStudyPanel() {
  const el = $id('studySec');
  el.innerHTML = `<div class="rb-tabs"><button class="button ${S.tab === 'study' ? 'cur' : ''}" data-tab="study">Study</button>` +
    `<button class="button ${S.tab === 'teams' ? 'cur' : ''}" data-tab="teams">Teams</button></div><div id="tabBody"></div>`;
  for (const b of el.querySelectorAll('[data-tab]')) b.onclick = () => { S.tab = b.dataset.tab; renderStudyPanel(); };
  if (S.tab === 'study') renderStudy(); else renderTeams();
}

// ---------------------------------------------------------------- Study tab
function lineToken(id) {
  let line;
  try { line = compute(id); } catch { return `<span class="rb-tok rb-err" data-go="${id}">(error)</span>`; }
  const n = S.study.nodes[id];
  const s = E.summarize(line.lines);
  const turn = isReplayPos(n.parent) ? replayTurn(n.parent) : compute(n.parent).battle.turn;
  return `<span class="rb-tok ${id === S.cur ? 'cur' : ''}" data-go="${id}"><span class="tn">${turn}.</span>${esc(s.p1 || '…')} <span class="tn">|</span> ${esc(s.p2 || '…')}` +
    (n.forced.length ? ' <i class="fa fa-cube" title="Dice set by you" aria-hidden="true"></i>' : '') +
    (n.glyph ? `<span class="rb-glyph">${esc(n.glyph)}</span>` : '') +
    (n.comment ? ` <i class="rb-cmt">${esc(n.comment.slice(0, 60))}</i>` : '') + `</span>`;
}
// A line written inline; where it branches, the other continuations are nested under it.
function lineHTML(first) {
  let html = '';
  for (let id = first; id; id = kids(id)[0]) {
    html += lineToken(id) + ' ';
    html += kids(id).slice(1).map(k => `<div class="rb-var">${lineHTML(k)}</div>`).join('');
  }
  return html;
}
const linesFrom = id => kids(id).length ? `<div class="rb-vars">${kids(id).map(k => `<div class="rb-var">${lineHTML(k)}</div>`).join('')}</div>` : '';

function renderStudy() {
  const body = $id('tabBody');
  const leads = E.replayLeads(S.rep);
  const row = (id, no, cells, extra = '') => `<div class="rb-mrow ${extra} ${S.cur === id ? 'cur' : ''}" data-go="${id}"><div class="no">${no}</div>${cells}</div>`;
  const rows = [
    row('r0', '', `<div class="a">Team preview</div>`, 'start'), linesFrom('r0'),
    row('r1', 0, `<div class="a">→ ${esc(leads.p1 || '?')}</div><div class="a">→ ${esc(leads.p2 || '?')}</div>`), linesFrom('r1'),
  ];
  for (let t = 1; t <= S.rep.lastTurn; t++) {
    const id = 'r' + (t + 1); const s = turnSummary(t); const note = S.study.notes[id] || {};
    rows.push(row(id, t, `<div class="a">${esc(s.p1 || '—')}${note.glyph ? `<span class="rb-glyph">${esc(note.glyph)}</span>` : ''}</div><div class="a">${esc(s.p2 || '—')}</div>`));
    if (note.comment) rows.push(`<div class="rb-vars rb-plain"><span class="rb-cmt">${esc(note.comment)}</span></div>`);
    rows.push(linesFrom(id));
  }
  const note = noteOf(S.cur);
  const inLine = !isReplayPos(S.cur);
  const isFirst = inLine && kids(S.study.nodes[S.cur].parent)[0] === S.cur;
  body.innerHTML = `<div class="rb-movelist">${rows.join('')}</div>
    <div class="rb-notes">
      <div class="rb-glyphs">${GLYPHS.map(g => `<button class="button ${note.glyph === g ? 'on' : ''}" data-glyph="${g}">${g}</button>`).join(' ')}</div>
      <textarea id="comment" class="textbox" rows="2" placeholder="Note on this position">${esc(note.comment || '')}</textarea>
      ${inLine ? `<p class="rb-row" style="margin:0"><button class="button" id="btnPromote" ${isFirst ? 'disabled' : ''}>Make this the first line</button>
        <button class="button" id="btnDelete">${S.deleteArmed === S.cur ? 'Click again to delete' : 'Delete from here'}</button></p>` : ''}
    </div>`;

  for (const el of body.querySelectorAll('[data-go]')) el.onclick = () => go(el.dataset.go);
  for (const b of body.querySelectorAll('[data-glyph]')) b.onclick = () => {
    const n = noteOf(S.cur, true); n.glyph = n.glyph === b.dataset.glyph ? '' : b.dataset.glyph; save(); renderStudy();
  };
  $id('comment').oninput = e => { noteOf(S.cur, true).comment = e.target.value; save(); };
  $id('comment').onchange = renderStudy;
  if (inLine) {
    $id('btnPromote').onclick = () => { promote(S.cur); renderStudy(); };
    $id('btnDelete').onclick = () => {
      if (S.deleteArmed !== S.cur) { S.deleteArmed = S.cur; renderStudy(); return; }
      const parent = S.study.nodes[S.cur].parent;
      deleteNode(S.cur); S.deleteArmed = null; save(); go(parent);
    };
  }
  const cur = body.querySelector('.cur');
  if (cur) { const list = body.querySelector('.rb-movelist'); list.scrollTop = Math.max(0, cur.offsetTop - list.offsetTop - 60); }
}

// ---------------------------------------------------------------- Teams tab
let staticLists = false;
function ensureStaticLists() {
  if (staticLists) return; staticLists = true;
  const d = document.createElement('div'); d.hidden = true;
  d.innerHTML = `<datalist id="dl-items">${E.Dex.items.all().filter(i => !i.isNonstandard || i.isNonstandard === 'Past').map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>` +
    `<datalist id="dl-natures">${E.Dex.natures.all().map(n => `<option value="${esc(n.name)}">`).join('')}</datalist>`;
  document.body.appendChild(d);
}
// Move suggestions for a species: its usage-stat moves first, then every move.
export function movesDatalist(species) {
  const id = 'dl-mv-' + E.toID(species);
  if ($id(id)) return id;
  const seen = new Set(), options = [];
  for (const [m, p] of E.setOptions(species, S.stats, S.rep.gen).moves) if (!seen.has(m)) { seen.add(m); options.push(`<option value="${esc(m)}" label="${Math.round(p * 100)}% usage">`); }
  for (const m of E.Dex.moves.all().map(m => m.name).sort()) if (!seen.has(m)) { seen.add(m); options.push(`<option value="${esc(m)}">`); }
  const d = document.createElement('datalist'); d.id = id; d.innerHTML = options.join(''); document.body.appendChild(d);
  return id;
}

function renderTeams() {
  ensureStaticLists();
  const body = $id('tabBody');
  const types = E.Dex.types.all().map(t => t.name).filter(t => t !== '???' && (S.rep.gen >= 9 || t !== 'Stellar'));
  const side = si => `<div class="rb-teamhead"><b>${esc(playerName(si))}</b><button class="button" data-reset-side="${si}">Reset to suggestions</button></div>
    <div class="rb-mons">${S.study.sets[si].map((set, k) => monCard(si, k, set, types)).join('')}</div>`;
  body.innerHTML = (S.stats ? '' : `<p class="rb-err">No usage stats for ${esc(S.rep.formatid)}.</p>`) + side(0) + side(1);

  for (const input of body.querySelectorAll('[data-field]')) input.onchange = () => {
    const set = S.study.sets[input.dataset.side][input.dataset.k]; const f = input.dataset.field; const v = input.value.trim();
    if (f.startsWith('move')) set.moves[+f.slice(4)] = v;
    else if (f.startsWith('ev_')) set.evs[f.slice(3)] = Math.max(0, Math.min(252, +v || 0));
    else if (f === 'level') set.level = Math.max(1, Math.min(100, +v || 100));
    else set[f] = v;
    save(); input.classList.remove('guess'); renderPicker(position());
  };
  for (const b of body.querySelectorAll('[data-reset-mon]')) b.onclick = () => {
    const [si, k] = b.dataset.resetMon.split(',').map(Number); S.study.sets[si][k] = clone(S.base[si][k]); save(); renderTeams();
  };
  for (const b of body.querySelectorAll('[data-reset-side]')) b.onclick = () => {
    const si = +b.dataset.resetSide; S.study.sets[si] = clone(S.base[si]); save(); renderTeams();
  };
}

function monCard(si, k, set, types) {
  const base = S.base[si][k], seen = base.fixed;
  const sp = E.Dex.species.get(set.species);
  const usage = E.setOptions(set.species, S.stats, S.rep.gen);
  const pct = (list, v) => { const e = list.find(([n]) => E.toID(n) === E.toID(v)); return e ? ` (${Math.round(e[1] * 100)}% usage)` : ''; };
  const guess = (known, value, suggested) => !known && value === suggested ? 'guess' : '';
  const attrs = field => `data-side="${si}" data-k="${k}" data-field="${field}"`;
  const moves = [0, 1, 2, 3].map(i => {
    const v = set.moves[i] || ''; const known = seen.moves.some(m => E.toID(m) === E.toID(v));
    return `<input class="textbox ${known ? '' : guess(false, v, base.moves[i])}" ${attrs('move' + i)} list="${movesDatalist(set.species)}" value="${esc(v)}" title="${known ? 'Seen in the replay' : 'Guess' + pct(usage.moves, v)}" aria-label="Move ${i + 1}">`;
  }).join('');
  const evs = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(st => `<input class="textbox" ${attrs('ev_' + st)} type="number" min="0" max="252" step="4" value="${set.evs[st] || 0}" aria-label="${st} EVs">`).join('');
  const abilities = [...new Set([...Object.values(sp.abilities || {}), set.ability])].filter(Boolean);
  return `<div class="rb-mon">
    <div class="hd"><span class="rb-picon" style="${icon(set.species)}"></span><span class="nm">${esc(set.name)}${set.name !== set.species ? ` <span class="rb-note">(${esc(set.species)})</span>` : ''}</span> ${(sp.types || []).map(typeTag).join('')}</div>
    <label>Item<input class="textbox ${guess(seen.item, set.item, base.item)}" ${attrs('item')} list="dl-items" value="${esc(set.item)}" title="${seen.item ? 'Seen in the replay' : 'Guess' + pct(usage.items, set.item)}"></label>
    <label>Ability<select class="button ${guess(seen.ability, set.ability, base.ability)}" ${attrs('ability')}>${abilities.map(a => `<option ${a === set.ability ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
    ${S.rep.gen >= 9 ? `<label>Tera<select class="button ${guess(seen.tera, set.teraType, base.teraType)}" ${attrs('teraType')}>${types.map(t => `<option ${t === set.teraType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
    <div class="rb-mvgrid">${moves}</div>
    ${S.rep.gen >= 3 ? `<label>Nature<input class="textbox" ${attrs('nature')} list="dl-natures" value="${esc(set.nature)}"></label>
    <div class="rb-evs">${['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'].map(x => `<span>${x}</span>`).join('')}${evs}</div>` : ''}
    <label>Level<input class="textbox" ${attrs('level')} type="number" min="1" max="100" value="${set.level}"></label>
    <p style="margin:0;text-align:right"><button class="button" data-reset-mon="${si},${k}">Reset</button></p>
  </div>`;
}
