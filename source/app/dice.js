// The dice of the step that led to a line position: every random outcome, editable. Changing one replays the step
// (as a new line if this one already continues). Outcomes moved off the most likely result are outlined.
import {S, $id, esc} from './state.js';
import {kids, addNode, deleteNode, compute, forget, save} from './study.js';
import {renderPanels, go} from './navigation.js';

export function renderDice(pos) {
  const el = $id('diceSec');
  el.hidden = pos.kind !== 'line';
  if (el.hidden) return;
  const node = S.study.nodes[S.cur];
  const rolls = pos.rolls;
  el.innerHTML = `<div class="rb-dicehead"><h2>Dice</h2><span>` +
    `<button class="button" id="btnRandomize" title="Roll real dice for every outcome"><i class="fa fa-random" aria-hidden="true"></i> Randomize</button> ` +
    `<button class="button" id="btnLikely" title="Back to the most likely outcomes" ${node.forced.length ? '' : 'disabled'}>Most likely</button></span></div>` +
    (rolls.length ? `<div class="rb-dice">${groups(rolls).map(groupHTML).join('')}</div>` : '');

  const set = (i, value) => replay(rolls.map((r, j) => ({key: r.key, value: j === i ? value : r.value})), node.seed);
  for (const c of el.querySelectorAll('[data-roll]')) {
    const i = +c.dataset.roll, r = rolls[i];
    if (c.tagName === 'SELECT') c.onchange = () => set(i, r.kind === 'order' ? JSON.parse(c.value) : +c.value);
    else c.onclick = () => set(i, r.kind === 'order' ? JSON.parse(c.dataset.order) : !r.value);
  }
  $id('btnRandomize').onclick = () => replay(rolls.map(r => ({key: r.key, value: randomOutcome(r)})), node.seed);
  $id('btnLikely').onclick = () => replay([], node.seed);
}

// Play the current step again with these forced outcomes.
function replay(forced, seed) {
  const node = S.study.nodes[S.cur];
  if (kids(S.cur).length) {
    const id = addNode(node.parent, node.choices, forced, seed, node.sets);
    try { compute(id); } catch (e) { deleteNode(id); save(); S.err = e.message; renderPanels(); return; }
    go(id, {animate: true});
  } else {
    node.forced = forced; node.seed = seed;
    forget(S.cur); save();
    try { compute(S.cur); } catch (e) { S.err = e.message; }
    go(S.cur, {animate: true, force: true});
  }
}

// What the engine picks when nothing is forced (null where it is not known here).
function mostLikely(r) {
  if (r.kind === 'chance') return r.p >= 0.5;
  if (r.kind === 'roll') return 7;   // the median of the 85-100% damage rolls (93%)
  if (r.kind === 'int') return r.lo + Math.floor((r.hi - 1 - r.lo) / 2);
  if (r.kind === 'order') return r.options.map((_, k) => k);
  return null;
}
const changed = r => { const d = mostLikely(r); return d !== null && JSON.stringify(d) !== JSON.stringify(r.value); };

function randomOutcome(r) {
  const below = n => Math.floor(Math.random() * n);
  if (r.kind === 'chance') return Math.random() < r.p;
  if (r.kind === 'roll') return below(16);
  if (r.kind === 'int') return r.lo + below(r.hi - r.lo);
  if (r.kind === 'pick') return below(r.options.length);
  if (r.kind === 'order') { const o = r.options.map((_, k) => k); for (let k = o.length - 1; k > 0; k--) { const j = below(k + 1); [o[k], o[j]] = [o[j], o[k]]; } return o; }
  return r.value;
}

// One group per move use (accuracy, crit, damage, side effects); anything else stands alone.
function groups(rolls) {
  const out = [];
  for (const r of rolls) {
    const m = /^(.+?): (accuracy|critical hit|damage roll|.+ \(\d+%\))$/.exec(r.label);
    const key = m && r.who ? r.who + '|' + m[1] : null;
    const last = out[out.length - 1];
    // a second accuracy/crit/effect roll means a new use of the move (multi-hit damage rolls stay together)
    if (key && last && last.key === key && !last.items.some(x => x.part === m[2] && m[2] !== 'damage roll')) {
      last.items.push({r, part: m[2]}); last.target ||= r.target;
      continue;
    }
    out.push(key ? {key, who: r.who, move: m[1], target: r.target, items: [{r, part: m[2]}]} : {key: null, items: [{r, part: r.label}]});
  }
  return out;
}

function groupHTML(g) {
  const head = g.key ? `<span class="rb-dhead">${esc(g.who)}'s <b>${esc(g.move)}</b>${g.target ? ` <span class="rb-darrow">→</span> ${esc(g.target)}` : ''}</span>` : '';
  return `<div class="rb-dgroup">${head}<span class="rb-dchips">${g.items.map(itemHTML).join('')}</span></div>`;
}

const chip = (r, text, title) =>
  `<button type="button" class="rb-chip ${changed(r) ? 'dev' : ''} ${r.kind === 'chance' && r.value ? 'yes' : ''}" data-roll="${r.i}" title="${esc(title)}">${esc(text)}</button>`;
const label = text => `<span class="rb-dlabel">${text}</span>`;
function select(r, options) {
  const current = r.kind === 'order' ? JSON.stringify(r.value) : r.value;
  return `<select class="rb-chipsel ${changed(r) ? 'dev' : ''}" data-roll="${r.i}">` +
    options.map(([v, text]) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(text)}</option>`).join('') + `</select>`;
}
const capital = s => s[0].toUpperCase() + s.slice(1);

function itemHTML({r, part}) {
  const pct = r.p !== undefined ? Math.round(r.p * 1000) / 10 + '%' : '';
  switch (r.kind) {
  case 'chance': {
    if (part === 'accuracy') return chip(r, r.value ? 'Hit' : 'Miss', `${pct} to hit. Click to change.`);
    if (part === 'critical hit') return chip(r, r.value ? 'Crit' : 'No crit', `${pct} to crit. Click to change.`);
    const effect = /^(.+) \((\d+)%\)$/.exec(part);
    if (effect) return chip(r, r.value ? capital(effect[1]) : 'No ' + effect[1], `${effect[2]}% chance. Click to change.`);
    return label(esc(r.label) + (r.who ? ` <small>${esc(r.who)}</small>` : '')) + chip(r, r.value ? 'Yes' : 'No', `${pct} chance. Click to change.`);
  }
  case 'roll':
    return select(r, Array.from({length: 16}, (_, v) => [v, `${100 - v}% damage`]));
  case 'int':
    return label(esc(r.label)) + (r.hi - r.lo <= 40 ? select(r, Array.from({length: r.hi - r.lo}, (_, k) => [r.lo + k, String(r.lo + k)])) : `<span>${r.value}</span>`);
  case 'pick':
    return label(esc(r.label)) + select(r, r.options.map((o, k) => [k, o]));
  case 'order': {
    const orders = permutations(r.options.length).slice(0, 24);
    if (r.options.length === 2) return label('Speed tie') + orders.map(o =>
      `<button type="button" class="rb-chip ${JSON.stringify(o) === JSON.stringify(r.value) ? 'yes' : ''}" data-roll="${r.i}" data-order="${esc(JSON.stringify(o))}">${esc(r.options[o[0]])} first</button>`).join('');
    return label(esc(r.label)) + select(r, orders.map(o => [JSON.stringify(o), o.map(k => r.options[k]).join(' > ')]));
  }
  }
  return '';
}

function permutations(n) {
  const out = [];
  const build = (prefix, rest) => { if (!rest.length) out.push(prefix); rest.forEach((x, i) => build([...prefix, x], rest.filter((_, j) => j !== i))); };
  build([], [...Array(n).keys()]);
  return out;
}
