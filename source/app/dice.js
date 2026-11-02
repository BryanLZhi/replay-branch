// The dice of a turn, every random outcome editable: the turn on the bar once both choices are in (set them, then Play
// turn; on the replay they start as the turn went), else in a line the step that led here (changing one replays it, as
// a new line if this one already continues).
// Outcomes moved off the most likely result are outlined, and the odds of the outcomes (this turn, and the whole line)
// are shown.
import {S, E, $id, esc, hash} from './state.js';
import {kids, addNode, deleteNode, compute, forget, save, pathTo, startOf, newSeed, isReplayPos, replayTurn} from './study.js';
import {renderPanels, go} from './navigation.js';
import {barTurn} from './picker.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const REAL_SEED = [5, 6, 7, 8];
const turnName = t => t ? 'Turn ' + t : 'Team preview';

// A line from `parent` with these choices and dice (and this seed, when given), if there is one.
export function sameStep(parent, choices, forced, seed) {
  return kids(parent).find(k => { const n = S.study.nodes[k]; return same(n.choices, choices) && same(n.forced, forced) && (!seed || same(n.seed, seed)); });
}

// The dice the replay's turn t rolled, as found from its log (engine realDice).
function realDice(t, turn) {
  const k = t + ':' + hash(JSON.stringify(turn.sets));
  if (!S.realDice.has(k)) {
    let forced = [];
    try { forced = E.realDice(startOf(turn.parent, turn.sets), turn.choices, REAL_SEED, E.turnLog(S.rep, t)).forced; } catch {}
    S.realDice.set(k, forced);
  }
  return S.realDice.get(k);
}

// The dice of the turn on the bar, before it is played (null when nothing is to be played). On the replay's own turn
// they start as it went (real: those dice); else as those of a line already played with these choices, if any.
export function upcomingDice(pos) {
  const turn = barTurn(pos);
  if (!turn) return null;
  const key = turn.parent + ' ' + JSON.stringify(turn.choices) + ' ' + (turn.sets ? hash(JSON.stringify(turn.sets)) : '') + (turn.replay ? ' real' : '');
  if (S.next?.key !== key) {
    if (turn.replay) {
      const real = realDice(pos.t, turn);
      S.next = {key, turn, real, forced: real, seed: REAL_SEED};
    } else {
      const played = kids(turn.parent).map(k => S.study.nodes[k]).find(n => same(n.choices, turn.choices));
      S.next = {key, turn, forced: played ? played.forced : [], seed: played ? played.seed : newSeed()};
    }
    S.next.base = S.next.seed;
  }
  const now = JSON.stringify(S.next.forced);
  if (S.next.for !== now) {
    try { S.next.rolls = E.step(startOf(turn.parent, turn.sets), turn.choices, S.next.forced, S.next.seed).rolls; }
    catch { S.next.rolls = []; }   // (Play turn says what is wrong)
    S.next.for = now;
  }
  return S.next;
}
function setUpcoming(forced) {
  const {turn} = S.next;
  const played = sameStep(turn.parent, turn.choices, forced);
  S.next.forced = forced;
  S.next.seed = played ? S.study.nodes[played].seed : S.next.base;
  renderPanels();
}

export function renderDice(pos) {
  const el = $id('diceSec');
  const next = upcomingDice(pos);
  el.hidden = next ? !next.rolls.length : pos.kind !== 'line';
  if (el.hidden) { el.textContent = ''; return; }
  let rolls, forced, before, when, apply;
  if (next) {
    ({rolls, forced} = next);
    before = pathTo(S.cur);
    when = turnName(pos.battle.turn);
    apply = setUpcoming;
  } else {
    const node = S.study.nodes[S.cur];
    rolls = pos.rolls; forced = node.forced;
    before = pathTo(S.cur).slice(0, -1);
    when = turnName(isReplayPos(node.parent) ? replayTurn(node.parent) : compute(node.parent).battle.turn);
    apply = f => replay(f, node.seed);
  }
  const turn = odds(rolls), line = before.reduce((p, id) => p * odds(compute(id).rolls), turn);
  const oddsHTML = rolls.some(r => r.kind !== 'roll' && !(r.kind === 'int' && r.hi - r.lo > 10)) ? `<span class="rb-odds" title="Chance of these outcomes (damage rolls not counted)">` +
    `This turn <b>${percent(turn)}</b>${before.length ? ` · Line <b>${percent(line)}</b>` : ''}</span>` : '';
  el.innerHTML = `<div class="rb-dicehead"><h2>Dice <small class="rb-dturn">${when}</small></h2>${oddsHTML}<span>` +
    `<button class="button" id="btnRandomize" title="Roll real dice for every outcome"><i class="fa fa-random" aria-hidden="true"></i> Randomize</button> ` +
    `<button class="button" id="btnLikely" title="Back to the most likely outcomes" ${forced.length ? '' : 'disabled'}>Most likely</button>` +
    (next?.real ? ` <button class="button" id="btnReal" title="Back to how the turn went" ${same(forced, next.real) ? 'disabled' : ''}>As played</button>` : '') +
    `</span></div>` +
    (rolls.length ? `<div class="rb-dice">${groups(rolls).map(groupHTML).join('')}</div>` : '');

  const set = (i, value) => apply(rolls.map((r, j) => ({key: r.key, value: j === i ? value : r.value})));
  for (const c of el.querySelectorAll('[data-roll]')) {
    const i = +c.dataset.roll, r = rolls[i];
    if (c.tagName === 'SELECT') c.onchange = () => set(i, r.kind === 'order' ? JSON.parse(c.value) : +c.value);
    else c.onclick = () => set(i, r.kind === 'order' ? JSON.parse(c.dataset.order) : !r.value);
  }
  $id('btnRandomize').onclick = () => apply(rolls.map(r => ({key: r.key, value: randomOutcome(r)})));
  $id('btnLikely').onclick = () => apply([]);
  if (next?.real) $id('btnReal').onclick = () => apply(next.real);
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

// The chance of the outcomes as they are. Damage rolls are left out (each exact roll is 1 in 16, which says little), and so
// are wide random numbers (0-99 and the like, which effects compare against a threshold rather than use as such).
function odds(rolls) {
  let p = 1;
  for (const r of rolls) {
    if (r.kind === 'chance') p *= r.value ? r.p : 1 - r.p;
    else if (r.kind === 'int' && r.hi - r.lo <= 10) p /= Math.max(1, r.hi - r.lo);
    else if (r.kind === 'pick') p /= Math.max(1, r.options.length);
    else if (r.kind === 'order') p /= factorial(r.options.length);
  }
  return p;
}
const factorial = n => n <= 1 ? 1 : n * factorial(n - 1);
function percent(p) {
  if (p <= 0) return '0%';   // (an outcome that cannot happen, like a sure hit missing)
  const x = p * 100;
  return (x >= 10 ? Math.round(x) : x >= 1 ? x.toFixed(1) : x >= 0.01 ? x.toPrecision(2) : '< 0.01') + '%';
}

// What the engine picks when nothing is forced (null where it is not known here).
function mostLikely(r) {
  if (r.kind === 'chance') return r.p >= 0.5;
  if (r.kind === 'roll') return r.lo + Math.floor((r.hi - 1 - r.lo) / 2);   // the median damage roll (93%)
  if (r.kind === 'int') return r.lo + Math.floor((r.hi - 1 - r.lo) / 2);
  if (r.kind === 'order') return r.options.map((_, k) => k);
  return null;
}
const changed = r => { const d = mostLikely(r); return d !== null && JSON.stringify(d) !== JSON.stringify(r.value); };

function randomOutcome(r) {
  const below = n => Math.floor(Math.random() * n);
  if (r.kind === 'chance') return Math.random() < r.p;
  if (r.kind === 'roll') return r.lo + below(r.hi - r.lo);
  if (r.kind === 'int') return r.lo + below(r.hi - r.lo);
  if (r.kind === 'pick') return below(r.options.length);
  if (r.kind === 'order') { const o = r.options.map((_, k) => k); for (let k = o.length - 1; k > 0; k--) { const j = below(k + 1); [o[k], o[j]] = [o[j], o[k]]; } return o; }
  return r.value;
}

// One group per move use and target (accuracy, crit, damage, side effects); anything else stands alone. A spread move rolls
// accuracy for each target first, then crit and damage for each: each roll joins its target's group.
function groups(rolls) {
  const out = [];
  for (const r of rolls) {
    const m = /^(.+?): (accuracy|critical hit|damage roll|.+ \(\d+%\))$/.exec(r.label);
    const key = m && r.who ? r.who + '|' + m[1] : null;
    if (!key) { out.push({key: null, items: [{r, part: r.label}]}); continue; }
    // the latest group of this move at this target, if it has no such roll yet (a second accuracy/crit/effect roll means a new
    // use of the move; multi-hit damage rolls stay together)
    let g = null;
    for (let j = out.length - 1; j >= 0; j--) {
      const x = out[j];
      if (x.key !== key) continue;
      if (x.target && r.target && x.target !== r.target) continue;
      if (!x.items.some(y => y.part === m[2] && m[2] !== 'damage roll')) g = x;
      break;
    }
    if (g) { g.items.push({r, part: m[2]}); g.target ||= r.target; }
    else out.push({key, who: r.who, move: m[1], target: r.target, items: [{r, part: m[2]}]});
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
    // (gens 1-2 multiply by 217-255 / 255, later gens take off 0-15%)
    return select(r, Array.from({length: r.hi - r.lo}, (_, k) => r.lo + k).map(v => [v, (r.lo ? (v / 2.55).toFixed(1) : 100 - v) + '% damage']));
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
