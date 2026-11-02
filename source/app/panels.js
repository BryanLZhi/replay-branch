// The study panel: the Study tab (the replay's turns with your lines under them, notes) and the Teams tab (teams.js).
import {S, E, $id, esc} from './state.js';
import {isReplayPos, replayTurn, kids, compute, noteOf, deleteNode, promote, save, GLYPHS, replayTurnPos} from './study.js';
import {turnSummary} from './replay.js';
import {go} from './navigation.js';
import {renderTeams} from './teams.js';
import {turnLabelOf} from './picker.js';


export function renderStudyPanel() {
  const el = $id('studySec');
  const any = noteList().length > 0;
  el.innerHTML = `<div class="rb-tabs"><button class="button ${S.tab === 'study' ? 'cur' : ''}" data-tab="study">Study</button>` +
    `<button class="button ${S.tab === 'teams' ? 'cur' : ''}" data-tab="teams">Teams</button>` +
    (S.tab === 'study' && any ? `<button class="button rb-copynotes" id="btnCopyNotes">Copy notes</button>` : '') + `</div><div id="tabBody"></div>`;
  for (const b of el.querySelectorAll('[data-tab]')) b.onclick = () => { S.tab = b.dataset.tab; renderStudyPanel(); };
  const copy = $id('btnCopyNotes');
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(notesText()); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
    setTimeout(() => { copy.textContent = 'Copy notes'; }, 1500);
  };
  if (S.tab === 'study') renderStudy(); else renderTeams($id('tabBody'));
}

// ---------------------------------------------------------------- the note card (beside the battle)
// The note of the position on screen: a mark and a comment, headed by the turn it is about (as the turn bar names it).
// Not redrawn while its box is being typed in, so nothing a render does takes the text away mid-sentence.
export function renderNote(pos) {
  const el = $id('noteSec');
  el.hidden = !S.rep;
  if (el.hidden) return;
  if (document.activeElement?.id === 'comment' && el.dataset.at === S.cur) return;
  el.dataset.at = S.cur;
  const note = noteOf(S.cur);
  el.innerHTML = `<div class="rb-notehd"><span class="rb-noteturn">${esc(turnLabelOf(pos))}</span><span class="rb-glyphs">` +
    GLYPHS.map(g => `<button class="button ${note.glyph === g ? 'on' : ''}" data-glyph="${g}" aria-pressed="${note.glyph === g}">${g}</button>`).join('') +
    `</span></div><textarea id="comment" class="textbox" rows="2" placeholder="Note" aria-label="Note on ${esc(turnLabelOf(pos))}">${esc(note.comment || '')}</textarea>`;
  for (const b of el.querySelectorAll('[data-glyph]')) b.onclick = () => {
    const n = noteOf(S.cur, true); n.glyph = n.glyph === b.dataset.glyph ? '' : b.dataset.glyph; save(); renderNote(pos); renderStudyPanel();
  };
  $id('comment').oninput = e => { noteOf(S.cur, true).comment = e.target.value; save(); };
  $id('comment').onchange = () => renderStudyPanel();
}

// Every note, in turn order: replay turns, then your lines under each ({id, turn, line: their moves or '', glyph, comment})
function noteList() {
  const out = [];
  if (!S.study) return out;
  for (const [id, n] of Object.entries(S.study.notes)) if (n?.comment || n?.glyph) out.push({id, turn: replayTurn(id), line: '', ...n});
  for (const [id, n] of Object.entries(S.study.nodes)) {
    if (!n.comment && !n.glyph) continue;
    let turn = 0, line = '';
    try {
      const c = compute(id);
      turn = c.battle.turn;
      if (n.edit) line = 'edited position';
      else { const s = E.summarize(c.lines); line = `${s.p1 || '…'} | ${s.p2 || '…'}`; }
    } catch { continue; }
    out.push({id, turn, line, comment: n.comment, glyph: n.glyph});
  }
  return out.sort((a, b) => a.turn - b.turn || (a.line ? 1 : 0) - (b.line ? 1 : 0));
}
// Copy notes: the study's name and replay link, then one line a note ("Turn 6 ?: ...", "Turn 8, line U-turn | Calm Mind: ...")
function notesText() {
  const title = S.study.name || (S.study.meta?.players || []).join(' vs. ');
  const link = S.replayId && !/pw$/.test(S.replayId) ? `https://replay.pokemonshowdown.com/${S.replayId}` : '';
  const at = t => (t <= 0 ? 'Team preview' : t > S.rep.lastTurn ? 'End' : `Turn ${t}`);
  return [title + (link ? ` - ${link}` : ''), ...noteList().map(n => `${at(n.turn)}${n.line ? `, line ${n.line}` : ''}${n.glyph ? ' ' + n.glyph : ''}${n.comment ? ': ' + n.comment : ''}`)]
    .filter(Boolean).join('\n') + '\n';
}

// ---------------------------------------------------------------- Study tab
function lineToken(id) {
  let line;
  try { line = compute(id); } catch { return `<span class="rb-tok rb-err" data-go="${esc(id)}">(error)</span>`; }
  const n = S.study.nodes[id];
  const turn = isReplayPos(n.parent) ? replayTurn(n.parent) : compute(n.parent).battle.turn;
  let what;
  if (n.edit) {
    // an edited position: what changed (the field, then each side's)
    const s = E.editSummary(isReplayPos(n.parent) ? replayTurnPos(turn, n.sets).battle : compute(n.parent).battle, n.edit);
    const cut = list => { const t = list.join(', '); return t.length > 60 ? t.slice(0, 59) + '…' : t; };
    const left = cut([...s.field, ...s.p1]), right = cut(s.p2);
    what = `<span class="rb-pencil" aria-label="Edited">✎</span> ${esc(right ? left || '—' : left)}${right ? ` <span class="tn">|</span> ${esc(right)}` : ''}`;
  } else {
    const s = E.summarize(line.lines);
    what = `${esc(s.p1 || '…')} <span class="tn">|</span> ${esc(s.p2 || '…')}`;
  }
  return `<span class="rb-tok ${n.edit ? 'rb-edited' : ''} ${id === S.cur ? 'cur' : ''}" data-go="${esc(id)}"><span class="tn">${turn}.</span>${what}` +
    (n.forced.length ? ' <i class="fa fa-cube" title="Dice set by you" aria-hidden="true"></i>' : '') +
    (n.glyph ? `<span class="rb-glyph">${esc(n.glyph)}</span>` : '') +
    (n.comment ? ` <i class="rb-cmt">${esc(n.comment)}</i>` : '') + `</span>`;
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
  const row = (id, no, cells, extra = '') => `<div class="rb-mrow ${extra} ${S.cur === id ? 'cur' : ''}" data-go="${esc(id)}"><div class="no">${no}</div>${cells}</div>`;
  // a replay position's note (mark, then comment) between the row that leads to the position and the next one: where its turn begins
  const cmt = id => {
    const n = S.study.notes[id];
    return n?.comment || n?.glyph ? `<div class="rb-vars rb-plain" data-go="${esc(id)}">${n.glyph ? `<span class="rb-glyph">${esc(n.glyph)}</span> ` : ''}` +
      `<span class="rb-cmt">${esc(n.comment || '')}</span></div>` : '';
  };
  const rows = [
    row('r0', '', `<div class="a">Team preview</div>`, 'start'), cmt('r0'), linesFrom('r0'),
    // (a new battle stopped at team preview has no leads yet)
    ...(leads.p1 || leads.p2 ? [row('r1', 0, ['p1', 'p2'].map(p => `<div class="a">→ ${esc([leads[p + 'a'], leads[p + 'b']].filter(Boolean).join(', ') || '?')}</div>`).join('')), cmt('r1'), linesFrom('r1')] : []),
  ];
  for (let t = 1; t <= S.rep.lastTurn; t++) {
    const id = 'r' + (t + 1); const s = turnSummary(t);
    rows.push(row(id, t, `<div class="a">${esc(s.p1 || '—')}</div><div class="a">${esc(s.p2 || '—')}</div>`), cmt(id), linesFrom(id));
  }
  const inLine = !isReplayPos(S.cur);
  const isFirst = inLine && kids(S.study.nodes[S.cur].parent)[0] === S.cur;
  body.innerHTML = `<div class="rb-movelist">${rows.join('')}</div>` +
    (inLine ? `<p class="rb-row rb-lineacts"><button class="button" id="btnPromote" ${isFirst ? 'disabled' : ''}>Make this the first line</button>
        <button class="button" id="btnDelete">${S.deleteArmed === S.cur ? 'Click again to delete' : 'Delete from here'}</button></p>` : '');

  for (const el of body.querySelectorAll('[data-go]')) el.onclick = () => go(el.dataset.go);
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
