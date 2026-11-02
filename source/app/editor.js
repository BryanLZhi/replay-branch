// The position editor, as a board editor: from the position on the turn bar (a replay turn, or a position in a line), change
// each Pokemon's HP and status, the stat stages and item of those on the field, the weather, terrain and Trick Room, and each
// side's hazards and screens. Applying it adds a step to the study that holds the edit (engine edit.mjs) in place of a turn;
// the same turn is then asked for from the edited position.
import {S, E, $id, esc} from './state.js';
import {kids, addEdit, compute, deleteNode, save} from './study.js';
import {cleanEdit} from './clean.js';
import {playerName, watchOnly} from './replay.js';
import {go} from './navigation.js';

const STATUS_NAMES = {'': '—', brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'TOX', slp: 'SLP', frz: 'FRZ'};
const icon = species => { try { return Dex.getPokemonIcon(species); } catch { return ''; } };
const hpColor = hp => hp > 50 ? 'g' : hp > 20 ? 'y' : 'r';   // (Showdown's HP bar)

let at = null;   // the position being edited: {parent, sets, state, options}

// Whether the position on the bar can be edited (a turn to choose, on the replay or in a line; not team preview).
export const canEdit = pos => !!pos.battle && !pos.battle.ended && (pos.kind === 'turn' || pos.kind === 'line') && !watchOnly() &&
  ['move', 'switch'].includes(pos.battle.requestState);

export function openEditor(pos) {
  if (!canEdit(pos)) return;
  const onReplay = pos.kind === 'turn';
  const state = E.editState(pos.battle);
  at = {parent: onReplay ? 'r' + pos.t : S.cur, sets: onReplay ? S.study.sets : undefined, state, options: E.editOptions(state.gen)};
  render();
}

function close() {
  at = null;
  const el = $id('editor');
  el.hidden = true; el.innerHTML = '';
}

function heldItems(gen) {
  const id = 'dl-held' + gen;
  if (!$id(id)) {
    const d = document.createElement('datalist'); d.id = id;
    d.innerHTML = E.Dex.items.all().filter(i => i.gen <= gen && (!i.isNonstandard || i.isNonstandard === 'Past')).map(i => `<option value="${esc(i.name)}">`).join('');
    document.body.appendChild(d);
  }
  return id;
}

const select = (attrs, options, value, cls = '') => `<select class="textbox ${cls}" ${attrs}>` +
  options.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('') + `</select>`;

function monHTML(si, m) {
  const {options, state} = at;
  const STAT = {atk: 'Atk', def: 'Def', spa: state.gen === 1 ? 'Spc' : 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva'};
  const levels = Array.from({length: 13}, (_, k) => [6 - k, (6 - k > 0 ? '+' : '') + (6 - k)]);
  // (one fainted on the field waits to be replaced: nothing to change)
  const stuck = m.fainted && m.active;
  const head = `<div class="rb-edhd"><span class="rb-picon" style="${icon(m.species)}"></span><b class="nm">${esc(m.name)}</b>` +
    `<span class="rb-hpbar" aria-hidden="true"><span class="hp-${hpColor(m.hp)}" style="width:${m.hp}%"></span></span>` +
    `<label class="rb-edhp"><input class="textbox" type="number" min="0" max="100" step="1" inputmode="numeric" data-f="hp" value="${m.hp}" ${stuck ? 'disabled' : ''} aria-label="${esc(m.name)} HP">%</label>` +
    select(`data-f="status" aria-label="${esc(m.name)} status" ${m.fainted ? 'disabled' : ''}`, ['', ...options.statuses].map(s => [s, STATUS_NAMES[s]]), m.status, 'rb-edst st-' + (m.status || 'none')) + `</div>`;
  const extra = m.active ? `<div class="rb-edboosts">${options.boosts.map(b => `<label><span>${STAT[b]}</span>` +
      select(`data-boost="${b}" aria-label="${esc(m.name)} ${STAT[b]}"`, levels, m.boosts[b] || 0, (m.boosts[b] || 0) > 0 ? 'up' : (m.boosts[b] || 0) < 0 ? 'down' : '') + `</label>`).join('')}</div>` +
    (options.items ? `<label class="rb-editem"><span>Item</span><input class="textbox" data-f="item" list="${heldItems(state.gen)}" value="${esc(m.itemName)}" autocomplete="off" aria-label="${esc(m.name)} item"></label>` : '') : '';
  return `<div class="rb-edmon ${m.active ? 'on' : ''} ${m.fainted ? 'fnt' : ''}" data-s="${si}" data-k="${m.k}">${head}${extra}</div>`;
}

function sideHTML(si) {
  const side = at.state.sides[si];
  const conds = at.options.side.map(([id, name, max]) => max > 1
    ? `<label class="rb-edcond">${esc(name)} ${select(`data-cond="${id}"`, Array.from({length: max + 1}, (_, n) => [n, n ? '×' + n : '—']), side.conds[id])}</label>`
    : `<label class="rb-edcond"><input type="checkbox" data-cond="${id}" ${side.conds[id] ? 'checked' : ''}> ${esc(name)}</label>`).join('');
  return `<div class="rb-edside" data-side="${si}"><h3>${esc(playerName(si))}</h3>` +
    `<div class="rb-edmons">${side.mons.map(m => monHTML(si, m)).join('')}</div>` +
    (conds ? `<div class="rb-edconds">${conds}</div>` : '') + `</div>`;
}

function render() {
  const el = $id('editor');
  const {state, options} = at;
  const f = state.field;
  // (a weather only an ability sets is listed while it holds, so it can be cleared)
  const weathers = [['', 'None'], ...options.weathers, ...(f.weather && !options.weathers.some(w => w[0] === f.weather) ? [[f.weather, E.weatherName(f.weather)]] : [])];
  const field = [
    options.weathers.length ? `<label>Weather ${select('data-field="weather"', weathers, f.weather)}</label>` : '',
    options.terrains.length ? `<label>Terrain ${select('data-field="terrain"', [['', 'None'], ...options.terrains], f.terrain)}</label>` : '',
    options.trickRoom ? `<label><input type="checkbox" data-field="trickroom" ${f.trickroom ? 'checked' : ''}> Trick Room</label>` : '',
  ].join('');
  el.innerHTML = `<section class="rb-section rb-editor" role="dialog" aria-labelledby="editTitle">
    <h2 id="editTitle"><span>Edit position <small class="rb-dturn">Turn ${state.turn}</small></span><button type="button" class="rb-linkbtn" id="btnEditClose" aria-label="Close">&times;</button></h2>
    ${field ? `<div class="rb-edfield">${field}</div>` : ''}
    <div class="rb-edsides">${sideHTML(0)}${sideHTML(1)}</div>
    <p class="rb-row rb-edfoot"><span class="rb-err" id="editErr"></span>
      <button type="button" class="button" id="btnEditCancel">Cancel</button><button type="button" class="button" id="btnEditApply"><strong>Apply</strong></button></p>
  </section>`;
  el.hidden = false;

  // the HP bar and the status and stat colours follow what is set
  for (const input of el.querySelectorAll('[data-f=hp]')) input.oninput = () => {
    const v = Math.max(0, Math.min(100, Math.round(+input.value) || 0));
    const bar = input.closest('.rb-edhd').querySelector('.rb-hpbar span');
    bar.style.width = v + '%'; bar.className = 'hp-' + hpColor(v);
  };
  for (const s of el.querySelectorAll('[data-f=status]')) s.onchange = () => { s.className = s.className.replace(/st-\w+/, 'st-' + (s.value || 'none')); };
  for (const s of el.querySelectorAll('[data-boost]')) s.onchange = () => { s.classList.toggle('up', +s.value > 0); s.classList.toggle('down', +s.value < 0); };
  $id('btnEditClose').onclick = $id('btnEditCancel').onclick = close;
  $id('btnEditApply').onclick = apply;
  el.onclick = e => { if (e.target === el) close(); };
  el.onkeydown = e => { if (e.key === 'Escape') close(); };
  el.querySelector('select, input').focus();
}

// What the dialog changes, as an edit (null if nothing), or a message for what cannot be.
function collect() {
  const el = $id('editor'), {state} = at;
  const edit = {mons: [], field: {}, sides: [{}, {}]};
  for (const row of el.querySelectorAll('.rb-edmon')) {
    const s = +row.dataset.s, k = +row.dataset.k, m = state.sides[s].mons.find(x => x.k === k);
    const c = {s, k};
    const hpBox = row.querySelector('[data-f=hp]');
    if (!hpBox.disabled) {
      const raw = hpBox.value.trim(), hp = Math.round(+raw);
      if (!/^\d+(\.\d*)?$/.test(raw) || hp > 100) return {error: `${m.name}: HP is 0 to 100%.`};
      if (hp !== m.hp) c.hp = hp;
    }
    const st = row.querySelector('[data-f=status]');
    if (!st.disabled && st.value !== m.status && c.hp !== 0) c.status = st.value;
    for (const b of row.querySelectorAll('[data-boost]')) {
      if (+b.value !== (m.boosts[b.dataset.boost] || 0)) (c.boosts ||= {})[b.dataset.boost] = +b.value;
    }
    const itemBox = row.querySelector('[data-f=item]');
    if (itemBox) {
      const name = itemBox.value.trim(), item = name ? E.Dex.items.get(name) : null;
      if (item && !item.exists) return {error: `"${name}" is not an item.`};
      const id = item ? item.id : '';
      if (id !== m.item) c.item = id;
    }
    if (Object.keys(c).length > 2) edit.mons.push(c);
  }
  for (const box of el.querySelectorAll('[data-field]')) {
    const id = box.dataset.field, v = box.type === 'checkbox' ? +box.checked : box.value;
    if (v !== state.field[id]) edit.field[id] = v;
  }
  for (const box of el.querySelectorAll('[data-cond]')) {
    const si = +box.closest('[data-side]').dataset.side, id = box.dataset.cond, v = box.type === 'checkbox' ? +box.checked : +box.value;
    if (v !== state.sides[si].conds[id]) edit.sides[si][id] = v;
  }
  return {edit: cleanEdit(edit)};
}

function apply() {
  const {edit, error} = collect();
  if (error) { $id('editErr').textContent = error; return; }
  if (!edit) { close(); return; }
  const {parent, sets} = at;
  // (the same edit here again is the step already made)
  let id = kids(parent).find(k => JSON.stringify(S.study.nodes[k].edit) === JSON.stringify(edit));
  if (!id) {
    id = addEdit(parent, edit, sets);
    try { compute(id); } catch (e) { deleteNode(id); save(); $id('editErr').textContent = e.message || String(e); return; }
  }
  close();
  go(id, {animate: true});
}

