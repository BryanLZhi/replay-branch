// The Teams tab: the sets your lines start with. Guesses are filled in from usage stats; a team can be imported from
// Showdown's export format or a PokéPaste link, after a check against what the replay shows. While any imported sets are
// in use, the tab lists what the replay shows that they cannot be (kept up to date as they are edited).
import {S, E, $id, esc, clone} from './state.js';
import {save} from './study.js';
import {playerName} from './replay.js';
import {position} from './navigation.js';
import {renderPicker} from './picker.js';

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_NAMES = {hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe'};
const typeTag = t => t ? `<span class="rb-type t-${esc(t === '???' ? 'Unknown' : t)}">${esc(t)}</span>` : '';
const icon = species => { try { return Dex.getPokemonIcon(species); } catch { return ''; } };

let staticLists = false;
function ensureStaticLists() {
  if (staticLists) return; staticLists = true;
  const natureLabel = n => n.plus ? `+${STAT_NAMES[n.plus]} −${STAT_NAMES[n.minus]}` : '';
  const d = document.createElement('div'); d.hidden = true;
  d.innerHTML = `<datalist id="dl-items">${E.Dex.items.all().filter(i => !i.isNonstandard || i.isNonstandard === 'Past').map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>` +
    `<datalist id="dl-natures">${E.Dex.natures.all().map(n => `<option value="${esc(n.name)}" label="${natureLabel(n)}">`).join('')}</datalist>`;
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

export function renderTeams(body) {
  ensureStaticLists();
  const types = E.Dex.types.all().map(t => t.name).filter(t => t !== '???' && (S.rep.gen >= 9 || t !== 'Stellar'));
  const side = si => `<div class="rb-teamhead"><b>${esc(playerName(si))}</b><span>` +
    `<button class="button" data-import="${si}">Import</button> <button class="button" data-reset-side="${si}">Reset to suggestions</button></span></div>
    <div class="rb-mons">${S.study.sets[si].map((set, k) => monCard(si, k, set, types)).join('')}</div>`;
  body.innerHTML = (S.stats ? '' : `<p class="rb-err">No usage stats for ${esc(S.rep.formatid)}.</p>`) +
    `<ul id="teamCheck" class="rb-problems" hidden></ul>` + side(0) + side(1);
  const rerender = () => renderTeams(body);
  showMismatches();

  for (const input of body.querySelectorAll('[data-field]')) input.onchange = () => {
    const set = S.study.sets[input.dataset.side][input.dataset.k]; const f = input.dataset.field; const v = input.value.trim();
    let changedNature = false;
    if (f.startsWith('move')) set.moves[+f.slice(4)] = v;
    else if (f.startsWith('ev_')) { changedNature = setEv(set, f.slice(3), v); input.value = Number(set.evs[f.slice(3)]) || 0; }   // ("252+" reads 252)
    else if (f === 'level') set.level = Math.max(1, Math.min(100, +v || 100));
    else { set[f] = v; changedNature = f === 'nature'; }
    save(); input.classList.remove('guess'); renderPicker(position());
    if (changedNature) rerender(); else showMismatches();
  };
  for (const b of body.querySelectorAll('[data-reset-mon]')) b.onclick = () => {
    const [si, k] = b.dataset.resetMon.split(',').map(Number); S.study.sets[si][k] = clone(S.base[si][k]); save(); rerender();
  };
  for (const b of body.querySelectorAll('[data-reset-side]')) b.onclick = () => {
    const si = +b.dataset.resetSide; S.study.sets[si] = clone(S.base[si]); save(); rerender();
  };
  for (const b of body.querySelectorAll('[data-import]')) b.onclick = () => openImport(+b.dataset.import, rerender);
}

// The imported sets against the replay (after the tab has drawn: the check walks the whole battle).
let pending = 0;
function showMismatches() {
  const ticket = ++pending;
  setTimeout(() => {
    const list = $id('teamCheck');
    if (ticket !== pending || !list) return;
    const problems = S.study.sets.some(side => side.some(s => s.pasted)) ? E.checkSets(S.rep, S.study.sets) : [];
    list.innerHTML = problems.map(p => `<li>${esc(p.text)}</li>`).join('');
    list.hidden = !problems.length;
  });
}

// An EV box takes "252", or "252+" / "252-" to also make the nature raise / lower that stat (as in Showdown's teambuilder).
// Returns whether the nature changed.
function setEv(set, stat, text) {
  const m = /^(\d*)\s*([+-])?$/.exec(text.replace('−', '-'));
  if (!m) return false;
  if (m[1] !== '') set.evs[stat] = Math.max(0, Math.min(252, +m[1]));
  if (!m[2] || stat === 'hp') return false;
  const cur = E.Dex.natures.get(set.nature || 'Serious');
  let plus = cur.plus, minus = cur.minus;
  if (m[2] === '+') { plus = stat; if (minus === stat || !minus) minus = stat === 'spa' ? 'atk' : 'spa'; }
  else { minus = stat; if (plus === stat || !plus) plus = stat === 'atk' ? 'spa' : 'atk'; }
  const nature = E.Dex.natures.all().find(n => n.plus === plus && n.minus === minus);
  if (!nature || nature.name === set.nature) return false;
  set.nature = nature.name;
  return true;
}

function monCard(si, k, set, types) {
  const base = S.base[si][k], seen = base.fixed;
  const sp = E.Dex.species.get(set.species);
  const usage = E.setOptions(set.species, S.stats, S.rep.gen);
  const pct = (list, v) => { const e = list.find(([n]) => E.toID(n) === E.toID(v)); return e ? ` (${Math.round(e[1] * 100)}% usage)` : ''; };
  // dashed: still the usage-stat guess (not seen in the replay, not imported, not edited)
  const guess = (known, value, suggested) => !set.pasted && !known && value === suggested ? 'guess' : '';
  const attrs = field => `data-side="${si}" data-k="${k}" data-field="${field}"`;
  const moves = [0, 1, 2, 3].map(i => {
    const v = set.moves[i] || ''; const known = seen.moves.some(m => E.toID(m) === E.toID(v));
    return `<input class="textbox ${known ? '' : guess(false, v, base.moves[i])}" ${attrs('move' + i)} list="${movesDatalist(set.species)}" value="${esc(v)}" title="${known ? 'Seen in the replay' : 'Guess' + pct(usage.moves, v)}" aria-label="Move ${i + 1}">`;
  }).join('');
  const nature = E.Dex.natures.get(set.nature || 'Serious');
  const mark = st => st === nature.plus ? '<b class="rb-plus">+</b>' : st === nature.minus ? '<b class="rb-minus">−</b>' : '';
  const evs = STATS.map(st => `<span>${STAT_NAMES[st]}${mark(st)}</span>`).join('') +
    STATS.map(st => `<input class="textbox" ${attrs('ev_' + st)} inputmode="numeric" value="${Number(set.evs[st]) || 0}" aria-label="${STAT_NAMES[st]} EVs">`).join('');
  const abilities = [...new Set([...Object.values(sp.abilities || {}), set.ability])].filter(Boolean);
  return `<div class="rb-mon">
    <div class="hd"><span class="rb-picon" style="${icon(set.species)}"></span><span class="nm">${esc(set.name)}${set.name !== set.species ? ` <span class="rb-note">(${esc(set.species)})</span>` : ''}</span> ${(sp.types || []).map(typeTag).join('')}</div>
    <label>Item<input class="textbox ${guess(seen.item, set.item, base.item)}" ${attrs('item')} list="dl-items" value="${esc(set.item)}" title="${seen.item ? 'Seen in the replay' : 'Guess' + pct(usage.items, set.item)}"></label>
    <label>Ability<select class="button ${guess(seen.ability, set.ability, base.ability)}" ${attrs('ability')}>${abilities.map(a => `<option ${a === set.ability ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
    ${S.rep.gen >= 9 ? `<label>Tera<select class="button ${guess(seen.tera, set.teraType, base.teraType)}" ${attrs('teraType')}>${types.map(t => `<option ${t === set.teraType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
    <div class="rb-mvgrid">${moves}</div>
    ${S.rep.gen >= 3 ? `<label>Nature<input class="textbox" ${attrs('nature')} list="dl-natures" value="${esc(set.nature)}"></label>
    <div class="rb-evs">${evs}</div>` : ''}
    <label>Level<input class="textbox" ${attrs('level')} type="number" min="1" max="100" value="${Number(set.level) || 100}"></label>
    <p style="margin:0;text-align:right"><button class="button" data-reset-mon="${si},${k}">Reset</button></p>
  </div>`;
}

// ---------------------------------------------------------------- import
async function pasteText(input) {
  const link = /^(?:https?:\/\/)?pokepast\.es\/([0-9a-f]+)/i.exec(input.trim());
  if (!link) return input;
  const r = await fetch(`https://pokepast.es/${link[1]}/json`);
  if (!r.ok) throw new Error(r.status === 404 ? 'PokéPaste not found.' : `Could not load the PokéPaste (${r.status}).`);
  return (await r.json()).paste;
}

function openImport(si, rerender) {
  const dialog = $id('importer'), text = $id('importText'), err = $id('importErr'), list = $id('importProblems'), ok = $id('btnImport');
  let checked = null;   // the matched sets once checked, so a second click imports them anyway
  const reset = () => { checked = null; err.textContent = ''; list.innerHTML = ''; list.hidden = true; ok.innerHTML = '<strong>Import</strong>'; };
  $id('importTitle').textContent = `Import ${playerName(si)}'s team`;
  text.value = ''; reset();
  dialog.hidden = false; text.focus();
  text.oninput = reset;
  $id('btnImportCancel').onclick = () => { dialog.hidden = true; };
  ok.onclick = async () => {
    if (checked) { apply(si, checked); dialog.hidden = true; rerender(); return; }
    err.textContent = '';
    try {
      const team = E.parseTeam(await pasteText(text.value));
      if (!team.length) { err.textContent = 'No Pokémon found.'; return; }
      const {sets, problems} = E.matchTeam(S.rep, si, team, S.study.sets[1 - si]);
      if (!problems.length) { apply(si, sets); dialog.hidden = true; rerender(); return; }
      list.innerHTML = problems.map(p => `<li>${esc(p)}</li>`).join(''); list.hidden = false;
      if (!sets.some(Boolean)) { err.textContent = 'None of these Pokémon are on this team.'; return; }
      checked = sets;
      ok.innerHTML = '<strong>Import anyway</strong>';
    } catch (e) { err.textContent = e.message || String(e); }
  };
}

function apply(si, sets) {
  sets.forEach((set, k) => {
    if (set) S.study.sets[si][k] = {...set, itemGone: S.base[si][k].itemGone};
  });
  save(); renderPicker(position());
}
