// The study panel: the Study tab (the replay's turns with your lines under them, notes) and the Teams tab (teams.js).
import {S, E, $id, esc} from './state.js';
import {isReplayPos, replayTurn, kids, compute, noteOf, deleteNode, promote, save, GLYPHS} from './study.js';
import {turnSummary} from './replay.js';
import {go} from './navigation.js';
import {renderTeams} from './teams.js';


export function renderStudyPanel() {
  const el = $id('studySec');
  el.innerHTML = `<div class="rb-tabs"><button class="button ${S.tab === 'study' ? 'cur' : ''}" data-tab="study">Study</button>` +
    `<button class="button ${S.tab === 'teams' ? 'cur' : ''}" data-tab="teams">Teams</button></div><div id="tabBody"></div>`;
  for (const b of el.querySelectorAll('[data-tab]')) b.onclick = () => { S.tab = b.dataset.tab; renderStudyPanel(); };
  if (S.tab === 'study') renderStudy(); else renderTeams($id('tabBody'));
}

// ---------------------------------------------------------------- Study tab
function lineToken(id) {
  let line;
  try { line = compute(id); } catch { return `<span class="rb-tok rb-err" data-go="${esc(id)}">(error)</span>`; }
  const n = S.study.nodes[id];
  const s = E.summarize(line.lines);
  const turn = isReplayPos(n.parent) ? replayTurn(n.parent) : compute(n.parent).battle.turn;
  return `<span class="rb-tok ${id === S.cur ? 'cur' : ''}" data-go="${esc(id)}"><span class="tn">${turn}.</span>${esc(s.p1 || '…')} <span class="tn">|</span> ${esc(s.p2 || '…')}` +
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
  const row = (id, no, cells, extra = '') => `<div class="rb-mrow ${extra} ${S.cur === id ? 'cur' : ''}" data-go="${esc(id)}"><div class="no">${no}</div>${cells}</div>`;
  const rows = [
    row('r0', '', `<div class="a">Team preview</div>`, 'start'), linesFrom('r0'),
    // (a new battle stopped at team preview has no leads yet)
    ...(leads.p1 || leads.p2 ? [row('r1', 0, ['p1', 'p2'].map(p => `<div class="a">→ ${esc([leads[p + 'a'], leads[p + 'b']].filter(Boolean).join(', ') || '?')}</div>`).join('')), linesFrom('r1')] : []),
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
