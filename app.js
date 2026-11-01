// source/app/state.js
var S = {
  rep: null,
  // the parsed replay (engine.parseReplayInput)
  key: "",
  // storage key for this replay's study
  replayId: null,
  // replay.pokemonshowdown.com/<replayId>, when it came from there
  stats: null,
  // usage stats for the format, or null
  base: null,
  // suggested sets per side: what the replay revealed, filled in from usage stats
  cbEnd: null,
  // spectator view of the battle at the end of the replay (team order, names)
  study: null,
  // {rbv, sets, nodes, kids, notes, seq}, saved per replay
  cur: "",
  // current position: 'r<turn>' on the replay ('r0' = team preview), 'n<id>' in one of your lines
  sel: {},
  // picks made so far this turn, by player ('p1', 'p2')
  tera: {},
  // Terastallize ticked, by player
  err: "",
  // last error to show in the picker
  tab: "study",
  // 'study' or 'teams'
  deleteArmed: null,
  // line node that a second click on "Delete from here" will delete
  psb: null,
  // the Showdown Battle shown in the replay viewer
  psMode: "",
  // 'main' while showing the replay, 'line:<id>' while showing a line
  seeking: false,
  // true while we move the viewer ourselves (ignore its events)
  stopAt: null,
  // replay turn at which to pause (playing a single turn of the replay)
  wasPlaying: false,
  lines: /* @__PURE__ */ new Map(),
  // computed line positions by node id
  replayPos: /* @__PURE__ */ new Map()
  // simulator positions on the replay (team preview, start of a turn) by turn + sets
};
var E = null;
function setEngine(engine) {
  E = engine;
}
var $id = (id) => document.getElementById(id);
var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var clone = (o) => JSON.parse(JSON.stringify(o));
var pid = (si) => "p" + (si + 1);
var nameOf = (ident) => ident.replace(/^p\d[a-d]?: /, "");
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function stored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}

// source/app/study.js
var SEED = [11, 22, 33, 44];
var isReplayPos = (id) => id[0] === "r";
var replayTurn = (id) => +id.slice(1);
function newStudy() {
  return { rbv: 1, sets: null, nodes: {}, kids: {}, notes: {}, seq: 0 };
}
function save() {
  store("rbv:" + S.key, JSON.stringify(S.study));
}
function loadSaved(key) {
  try {
    return JSON.parse(stored("rbv:" + key, "null"));
  } catch {
    return null;
  }
}
var kids = (id) => S.study.kids[id] || [];
function parentOf(id) {
  if (isReplayPos(id)) {
    const t = replayTurn(id);
    return t > 0 ? "r" + (t - 1) : null;
  }
  return S.study.nodes[id]?.parent || null;
}
function childrenOf(id) {
  if (!isReplayPos(id)) return kids(id);
  const next = replayTurn(id) <= S.rep.lastTurn ? ["r" + (replayTurn(id) + 1)] : [];
  return next.concat(kids(id));
}
function siblings(id) {
  const p = parentOf(id);
  return p ? childrenOf(p) : [id];
}
function pathTo(id) {
  const path = [];
  for (let n = id; n && !isReplayPos(n); n = S.study.nodes[n].parent) path.unshift(n);
  return path;
}
var lineSets = (id) => S.study.nodes[pathTo(id)[0]].sets;
function noteOf(id, create) {
  var _a;
  if (!isReplayPos(id)) return S.study.nodes[id];
  if (create) (_a = S.study.notes)[id] || (_a[id] = {});
  return S.study.notes[id] || {};
}
function replayTurnPos(t, sets) {
  const k = t + ":" + hash(JSON.stringify(sets));
  if (!S.replayPos.has(k)) {
    const { battle } = E.takeover(S.rep, t, sets, SEED);
    S.replayPos.set(k, { json: E.serialize(battle), battle });
  }
  return S.replayPos.get(k);
}
function previewPos(sets) {
  const k = "preview:" + hash(JSON.stringify(sets));
  if (!S.replayPos.has(k)) {
    const battle = E.previewBattle(S.rep, sets, SEED);
    S.replayPos.set(k, battle && { json: E.serialize(battle), battle });
  }
  return S.replayPos.get(k);
}
function compute(id) {
  if (S.lines.has(id)) return S.lines.get(id);
  const n = S.study.nodes[id];
  const from = n.parent === "r0" ? previewPos(n.sets).json : isReplayPos(n.parent) ? replayTurnPos(replayTurn(n.parent), n.sets).json : compute(n.parent).json;
  const r = E.step(from, n.choices, n.forced, n.seed);
  const out = { json: E.serialize(r.battle), battle: r.battle, lines: r.lines, rolls: r.rolls };
  S.lines.set(id, out);
  return out;
}
function forget(id) {
  S.lines.delete(id);
  for (const k of kids(id)) forget(k);
}
var newSeed = () => [0, 0, 0, 0].map(() => Math.floor(Math.random() * 65536));
function addNode(parent, choices, forced, seed, sets) {
  var _a;
  const id = "n" + ++S.study.seq;
  S.study.nodes[id] = { id, parent, choices, forced: forced || [], seed: seed || newSeed(), sets: sets && clone(sets), comment: "", glyph: "" };
  ((_a = S.study.kids)[parent] || (_a[parent] = [])).push(id);
  save();
  return id;
}
function deleteNode(id) {
  for (const k of kids(id).slice()) deleteNode(k);
  const n = S.study.nodes[id];
  if (!n) return;
  const list = S.study.kids[n.parent] || [];
  if (list.includes(id)) list.splice(list.indexOf(id), 1);
  delete S.study.nodes[id];
  delete S.study.kids[id];
  S.lines.delete(id);
}
function promote(id) {
  const list = S.study.kids[S.study.nodes[id].parent];
  list.splice(list.indexOf(id), 1);
  list.unshift(id);
  save();
}

// source/app/replay.js
var isDoubles = () => S.rep.lines.some((l) => l === "|gametype|doubles" || l === "|gametype|triples");
var startIndex = () => S.rep.lines.findIndex((l) => l === "|start");
var playerName = (si) => S.cbEnd[pid(si)].name || "Player " + (si + 1);
var teamIndex = (si, name) => S.cbEnd[pid(si)].team.findIndex((p) => p.name === name);
function turnLines(t) {
  const a = S.rep.turnIdx[t], b = S.rep.turnIdx[t + 1] ?? S.rep.lines.length;
  return S.rep.lines.slice(a + 1, b);
}
var turnSummary = (t) => E.summarize(turnLines(t));
function playedChoice(t, si) {
  const p = pid(si);
  if (t === 0) {
    const lead = E.replayLeads(S.rep)[p];
    return lead ? { kind: "lead", name: lead } : null;
  }
  let first = null, tera = false;
  for (const line of turnLines(t)) {
    const [, kind, who = "", what] = line.split("|");
    if (!who.startsWith(p)) continue;
    if (kind === "-terastallize") tera = true;
    if (first) continue;
    if (kind === "move" && !line.includes("[from]")) first = { kind: "move", name: what };
    else if (kind === "switch") first = { kind: "switch", name: nameOf(who) };
    else if (kind === "cant") first = { kind: "cant" };
  }
  return first && { ...first, tera };
}
function matchesPlayed(side, pick, tera, played) {
  if (!played || !pick) return false;
  const [kind, n] = pick.split(" ");
  const req = side.activeRequest;
  if (played.kind === "lead") return nameOf(req.side.pokemon[n - 1].ident) === played.name;
  if (played.kind === "cant") return kind === "move";
  if (kind !== played.kind) return false;
  if (kind === "move") return E.toID(req.active[0].moves[n - 1].move) === E.toID(played.name) && !!tera === !!played.tera;
  return nameOf(req.side.pokemon[n - 1].ident) === played.name;
}

// source/app/teams.js
var STATS = ["hp", "atk", "def", "spa", "spd", "spe"];
var STAT_NAMES = { hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" };
var typeTag = (t) => t ? `<span class="rb-type t-${esc(t === "???" ? "Unknown" : t)}">${esc(t)}</span>` : "";
var icon = (species) => {
  try {
    return Dex.getPokemonIcon(species);
  } catch {
    return "";
  }
};
var staticLists = false;
function ensureStaticLists() {
  if (staticLists) return;
  staticLists = true;
  const natureLabel = (n) => n.plus ? `+${STAT_NAMES[n.plus]} \u2212${STAT_NAMES[n.minus]}` : "";
  const d = document.createElement("div");
  d.hidden = true;
  d.innerHTML = `<datalist id="dl-items">${E.Dex.items.all().filter((i) => !i.isNonstandard || i.isNonstandard === "Past").map((i) => `<option value="${esc(i.name)}">`).join("")}</datalist><datalist id="dl-natures">${E.Dex.natures.all().map((n) => `<option value="${esc(n.name)}" label="${natureLabel(n)}">`).join("")}</datalist>`;
  document.body.appendChild(d);
}
function movesDatalist(species) {
  const id = "dl-mv-" + E.toID(species);
  if ($id(id)) return id;
  const seen = /* @__PURE__ */ new Set(), options = [];
  for (const [m, p] of E.setOptions(species, S.stats, S.rep.gen).moves) if (!seen.has(m)) {
    seen.add(m);
    options.push(`<option value="${esc(m)}" label="${Math.round(p * 100)}% usage">`);
  }
  for (const m of E.Dex.moves.all().map((m2) => m2.name).sort()) if (!seen.has(m)) {
    seen.add(m);
    options.push(`<option value="${esc(m)}">`);
  }
  const d = document.createElement("datalist");
  d.id = id;
  d.innerHTML = options.join("");
  document.body.appendChild(d);
  return id;
}
function renderTeams(body) {
  ensureStaticLists();
  const types = E.Dex.types.all().map((t) => t.name).filter((t) => t !== "???" && (S.rep.gen >= 9 || t !== "Stellar"));
  const side = (si) => `<div class="rb-teamhead"><b>${esc(playerName(si))}</b><span><button class="button" data-import="${si}">Import</button> <button class="button" data-reset-side="${si}">Reset to suggestions</button></span></div>
    <div class="rb-mons">${S.study.sets[si].map((set, k) => monCard(si, k, set, types)).join("")}</div>`;
  body.innerHTML = (S.stats ? "" : `<p class="rb-err">No usage stats for ${esc(S.rep.formatid)}.</p>`) + side(0) + side(1);
  const rerender = () => renderTeams(body);
  for (const input of body.querySelectorAll("[data-field]")) input.onchange = () => {
    const set = S.study.sets[input.dataset.side][input.dataset.k];
    const f = input.dataset.field;
    const v = input.value.trim();
    let changedNature = false;
    if (f.startsWith("move")) set.moves[+f.slice(4)] = v;
    else if (f.startsWith("ev_")) changedNature = setEv(set, f.slice(3), v);
    else if (f === "level") set.level = Math.max(1, Math.min(100, +v || 100));
    else {
      set[f] = v;
      changedNature = f === "nature";
    }
    save();
    input.classList.remove("guess");
    renderPicker(position());
    if (changedNature) rerender();
  };
  for (const b of body.querySelectorAll("[data-reset-mon]")) b.onclick = () => {
    const [si, k] = b.dataset.resetMon.split(",").map(Number);
    S.study.sets[si][k] = clone(S.base[si][k]);
    save();
    rerender();
  };
  for (const b of body.querySelectorAll("[data-reset-side]")) b.onclick = () => {
    const si = +b.dataset.resetSide;
    S.study.sets[si] = clone(S.base[si]);
    save();
    rerender();
  };
  for (const b of body.querySelectorAll("[data-import]")) b.onclick = () => openImport(+b.dataset.import, rerender);
}
function setEv(set, stat, text) {
  const m = /^(\d*)\s*([+-])?$/.exec(text.replace("\u2212", "-"));
  if (!m) return false;
  if (m[1] !== "") set.evs[stat] = Math.max(0, Math.min(252, +m[1]));
  if (!m[2] || stat === "hp") return false;
  const cur = E.Dex.natures.get(set.nature || "Serious");
  let plus = cur.plus, minus = cur.minus;
  if (m[2] === "+") {
    plus = stat;
    if (minus === stat || !minus) minus = stat === "spa" ? "atk" : "spa";
  } else {
    minus = stat;
    if (plus === stat || !plus) plus = stat === "atk" ? "spa" : "atk";
  }
  const nature = E.Dex.natures.all().find((n) => n.plus === plus && n.minus === minus);
  if (!nature || nature.name === set.nature) return false;
  set.nature = nature.name;
  return true;
}
function monCard(si, k, set, types) {
  const base = S.base[si][k], seen = base.fixed;
  const sp = E.Dex.species.get(set.species);
  const usage = E.setOptions(set.species, S.stats, S.rep.gen);
  const pct = (list, v) => {
    const e = list.find(([n]) => E.toID(n) === E.toID(v));
    return e ? ` (${Math.round(e[1] * 100)}% usage)` : "";
  };
  const guess = (known, value, suggested) => !set.pasted && !known && value === suggested ? "guess" : "";
  const attrs = (field) => `data-side="${si}" data-k="${k}" data-field="${field}"`;
  const moves = [0, 1, 2, 3].map((i) => {
    const v = set.moves[i] || "";
    const known = seen.moves.some((m) => E.toID(m) === E.toID(v));
    return `<input class="textbox ${known ? "" : guess(false, v, base.moves[i])}" ${attrs("move" + i)} list="${movesDatalist(set.species)}" value="${esc(v)}" title="${known ? "Seen in the replay" : "Guess" + pct(usage.moves, v)}" aria-label="Move ${i + 1}">`;
  }).join("");
  const nature = E.Dex.natures.get(set.nature || "Serious");
  const mark = (st) => st === nature.plus ? '<b class="rb-plus">+</b>' : st === nature.minus ? '<b class="rb-minus">\u2212</b>' : "";
  const evs = STATS.map((st) => `<span>${STAT_NAMES[st]}${mark(st)}</span>`).join("") + STATS.map((st) => `<input class="textbox" ${attrs("ev_" + st)} inputmode="numeric" value="${set.evs[st] || 0}" aria-label="${STAT_NAMES[st]} EVs">`).join("");
  const abilities = [.../* @__PURE__ */ new Set([...Object.values(sp.abilities || {}), set.ability])].filter(Boolean);
  return `<div class="rb-mon">
    <div class="hd"><span class="rb-picon" style="${icon(set.species)}"></span><span class="nm">${esc(set.name)}${set.name !== set.species ? ` <span class="rb-note">(${esc(set.species)})</span>` : ""}</span> ${(sp.types || []).map(typeTag).join("")}</div>
    <label>Item<input class="textbox ${guess(seen.item, set.item, base.item)}" ${attrs("item")} list="dl-items" value="${esc(set.item)}" title="${seen.item ? "Seen in the replay" : "Guess" + pct(usage.items, set.item)}"></label>
    <label>Ability<select class="button ${guess(seen.ability, set.ability, base.ability)}" ${attrs("ability")}>${abilities.map((a) => `<option ${a === set.ability ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
    ${S.rep.gen >= 9 ? `<label>Tera<select class="button ${guess(seen.tera, set.teraType, base.teraType)}" ${attrs("teraType")}>${types.map((t) => `<option ${t === set.teraType ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>` : ""}
    <div class="rb-mvgrid">${moves}</div>
    ${S.rep.gen >= 3 ? `<label>Nature<input class="textbox" ${attrs("nature")} list="dl-natures" value="${esc(set.nature)}"></label>
    <div class="rb-evs">${evs}</div>` : ""}
    <label>Level<input class="textbox" ${attrs("level")} type="number" min="1" max="100" value="${set.level}"></label>
    <p style="margin:0;text-align:right"><button class="button" data-reset-mon="${si},${k}">Reset</button></p>
  </div>`;
}
async function pasteText(input) {
  const link = /^(?:https?:\/\/)?pokepast\.es\/([0-9a-f]+)/i.exec(input.trim());
  if (!link) return input;
  const r = await fetch(`https://pokepast.es/${link[1]}/json`);
  if (!r.ok) throw new Error(r.status === 404 ? "Pok\xE9Paste not found." : `Could not load the Pok\xE9Paste (${r.status}).`);
  return (await r.json()).paste;
}
function openImport(si, rerender) {
  const dialog = $id("importer"), text = $id("importText"), err = $id("importErr"), list = $id("importProblems"), ok = $id("btnImport");
  let checked = null;
  const reset = () => {
    checked = null;
    err.textContent = "";
    list.innerHTML = "";
    list.hidden = true;
    ok.innerHTML = "<strong>Import</strong>";
  };
  $id("importTitle").textContent = `Import ${playerName(si)}'s team`;
  text.value = "";
  reset();
  dialog.hidden = false;
  text.focus();
  text.oninput = reset;
  $id("btnImportCancel").onclick = () => {
    dialog.hidden = true;
  };
  ok.onclick = async () => {
    if (checked) {
      apply(si, checked);
      dialog.hidden = true;
      rerender();
      return;
    }
    err.textContent = "";
    try {
      const team = E.parseTeam(await pasteText(text.value));
      if (!team.length) {
        err.textContent = "No Pok\xE9mon found.";
        return;
      }
      const other = S.study.sets[1 - si];
      const { sets, problems } = E.matchTeam(S.rep, si, team, other, other.every((s) => s.pasted));
      if (!problems.length) {
        apply(si, sets);
        dialog.hidden = true;
        rerender();
        return;
      }
      list.innerHTML = problems.map((p) => `<li>${esc(p)}</li>`).join("");
      list.hidden = false;
      if (!sets.some(Boolean)) {
        err.textContent = "None of these Pok\xE9mon are on this team.";
        return;
      }
      checked = sets;
      ok.innerHTML = "<strong>Import anyway</strong>";
    } catch (e) {
      err.textContent = e.message || String(e);
    }
  };
}
function apply(si, sets) {
  sets.forEach((set, k) => {
    if (set) S.study.sets[si][k] = { ...set, name: S.base[si][k].name, itemGone: S.base[si][k].itemGone, pasted: true };
  });
  save();
  renderPicker(position());
}

// source/app/tooltips.js
var tips = null;
var request = null;
function listenForTooltips(el) {
  tips = new BattleTooltips(S.psb);
  tips.showTooltip = showTooltip;
  tips.listen(el);
}
function setTooltipRequest(si, req) {
  request = req ? { si, req } : null;
  BattleTooltips.hideTooltip();
}
function serverPokemon(p) {
  const out = { ...p };
  S.psb.parseDetails(p.ident.slice(4), p.ident, p.details, out);
  S.psb.parseHealth(p.condition, out);
  return out;
}
function showTooltip(elem) {
  if (!request) return false;
  const [type, n] = elem.dataset.tooltip.split("|");
  const { si, req } = request;
  tips.battle = S.psb;
  let html;
  try {
    if (type === "move") {
      const active = S.psb.sides[si].active[0];
      if (!active) return false;
      const move = req.active[0].moves[n];
      html = tips.showMoveTooltip(S.psb.dex.moves.get(move.id || move.move), "move", active, serverPokemon(req.side.pokemon.find((p) => p.active)));
    } else {
      html = tips.showPokemonTooltip(null, serverPokemon(req.side.pokemon[n]));
    }
  } catch (e) {
    console.error(e);
    return false;
  }
  if (elem.dataset.calc) html += `<p class="tooltip-section">${esc(elem.dataset.calc)}</p>`;
  if (elem.dataset.note) html += `<p class="tooltip-section">${esc(elem.dataset.note)}</p>`;
  tips.placeTooltip(html, elem, false, type === "move" ? "move" : "pokemon");
  return true;
}

// source/app/picker.js
var pickerOn = () => stored("rb-picker", "on") !== "off";
function setPicker(on) {
  store("rb-picker", on ? "on" : "off");
  S.sel = {};
  S.tera = {};
  renderPanels();
}
var typeTag2 = (t) => t ? `<span class="rb-type t-${esc(t)}">${esc(t)}</span>` : "";
var icon2 = (species) => {
  try {
    return Dex.getPokemonIcon(species);
  } catch {
    return "";
  }
};
function whoChooses(battle) {
  const need = battle.sides.map((side, si) => ({ si, side, req: side.activeRequest })).filter((x) => x.req && !x.req.wait);
  return { need, next: need.find((x) => !S.sel[pid(x.si)]) };
}
function renderPicker(pos) {
  const el = $id("pickSec");
  const turn = pos.battle && !pos.battle.ended && pickerOn() && whoChooses(pos.battle);
  if (!turn || !turn.next) {
    setTooltipRequest(null);
    el.innerHTML = S.err ? `<p class="rb-err">${esc(S.err)}</p>` : "";
    el.hidden = !S.err;
    showPickerSetting();
    return;
  }
  const { need, next: { si, side, req } } = turn;
  setTooltipRequest(si, req);
  const played = pos.kind === "line" ? null : playedChoice(pos.t, si);
  const forced = req.forceSwitch && req.forceSwitch[0];
  const active = nameOf((req.side.pokemon.find((p) => p.active) || { ident: "" }).ident);
  const question = pos.kind === "preview" ? `${esc(side.name)}: choose a lead` : forced ? `${esc(side.name)}: switch in a Pok&eacute;mon` : `${esc(side.name)}: what will ${esc(active)} do?`;
  const body = pos.kind === "preview" ? leadButtons(req, played) : (forced ? "" : moveButtons(pos, si, req, active, played)) + switchButtons(req, forced, played);
  const undo = need.some((x) => S.sel[pid(x.si)]) ? `<button class="button" id="btnUndo"><i class="fa fa-undo" aria-hidden="true"></i> Back</button>` : "";
  el.innerHTML = `<div class="rb-pside"><h3><span>${question}</span>${undo}</h3>${body}</div>${S.err ? `<p class="rb-err">${esc(S.err)}</p>` : ""}`;
  el.hidden = false;
  showPickerSetting();
  for (const b of el.querySelectorAll("[data-pick]")) b.onclick = () => {
    S.sel[pid(si)] = b.dataset.pick;
    S.err = "";
    if (whoChooses(pos.battle).next) renderPicker(pos);
    else playTurn(pos);
  };
  const tera = $id("teraBox");
  if (tera) tera.onchange = () => {
    S.tera[pid(si)] = tera.checked;
  };
  if (undo) $id("btnUndo").onclick = () => {
    const last = need.filter((x) => S.sel[pid(x.si)]).pop();
    delete S.sel[pid(last.si)];
    delete S.tera[pid(last.si)];
    renderPicker(pos);
  };
  for (const b of el.querySelectorAll("[data-edit]")) b.onclick = () => editGuessedMove(pos, si, active, b);
}
function leadButtons(req, played) {
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    const name = nameOf(p.ident);
    const was = played && played.name === name;
    return `<button type="button" class="button rb-sw has-tooltip ${was ? "played" : ""}" data-pick="team ${n + 1}" data-tooltip="switchpokemon|${n}" ${was ? 'data-note="Lead in the replay"' : ""}><span class="rb-picon" style="${icon2(p.details.split(",")[0])}"></span>${esc(name)}</button>`;
  }).join("")}</div>`;
}
function moveButtons(pos, si, req, active, played) {
  const act = req.active[0];
  const k = teamIndex(si, active);
  const known = k >= 0 ? S.base[si][k].fixed.moves.map(E.toID) : [];
  const pasted = k >= 0 && (pos.kind === "line" ? lineSets(S.cur) : S.study.sets)[si][k].pasted;
  const calcs = E.damageCalcs(pos.battle, si);
  const moves = act.moves.map((m, i) => {
    const type = E.Dex.moves.get(m.id || m.move).type || "Normal";
    const was = played && played.kind === "move" && E.toID(played.name) === E.toID(m.move);
    const guessed = k >= 0 && !pasted && !known.includes(E.toID(m.move)) && !["struggle", "recharge"].includes(E.toID(m.move));
    const note = guessed ? "Guessed" : was ? "Used in the replay" : "";
    return `<div class="rb-mvwrap"><button type="button" class="rb-mv has-tooltip t-${esc(type)} ${was ? "played" : ""} ${guessed ? "guess" : ""}" data-pick="move ${i + 1}" data-tooltip="move|${i}" ${note ? `data-note="${note}"` : ""} ${calcs[i] ? `data-calc="${esc(calcs[i].desc)}"` : ""} ${m.disabled || m.pp === 0 ? "disabled" : ""}><b>${esc(m.move)}</b><small><span>${esc(type)}</span>${calcs[i] ? `<span class="rb-dmg">${esc(calcs[i].range)}</span>` : ""}<span>${m.maxpp ? `${m.pp}/${m.maxpp}` : ""}</span></small></button>` + (guessed ? `<button type="button" class="rb-edit" data-edit="${esc(m.move)}" title="Change this guessed move" aria-label="Change ${esc(m.move)}"><i class="fa fa-pencil" aria-hidden="true"></i></button>` : "") + `</div>`;
  });
  const tera = act.canTerastallize ? `<p class="rb-row" style="margin-top:6px"><label><input type="checkbox" id="teraBox" ${S.tera[pid(si)] ? "checked" : ""}> Terastallize</label> ${typeTag2(act.canTerastallize)}</p>` : "";
  return `<div class="rb-moves">${moves.join("")}</div>${tera}`;
}
function switchButtons(req, forced, played) {
  const trapped = !forced && req.active && req.active[0].trapped;
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    if (p.active && !forced) return "";
    const name = nameOf(p.ident);
    const fainted = /fnt/.test(p.condition);
    const [hp, max] = p.condition.split(" ")[0].split("/");
    const was = played && played.kind === "switch" && played.name === name;
    return `<button type="button" class="button rb-sw has-tooltip ${was ? "played" : ""}" data-pick="switch ${n + 1}" data-tooltip="switchpokemon|${n}" ${was ? 'data-note="Used in the replay"' : ""} ${fainted || p.active || trapped ? "disabled" : ""}><span class="rb-picon" style="${icon2(p.details.split(",")[0])}"></span>${esc(name)} <small>${fainted ? 0 : Math.round(hp / max * 100)}%</small></button>`;
  }).join("")}</div>`;
}
function editGuessedMove(pos, si, active, button) {
  const old = button.dataset.edit;
  const k = teamIndex(si, active);
  const sets = pos.kind === "line" ? lineSets(S.cur) : S.study.sets;
  const wrap = button.parentElement;
  wrap.innerHTML = `<input class="textbox rb-mvinput" list="${movesDatalist(sets[si][k].species)}" value="${esc(old)}" aria-label="Move instead of ${esc(old)}">`;
  const input = wrap.querySelector("input");
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && E.toID(v) !== E.toID(old)) replaceMove(pos, si, k, old, v);
    else renderPicker(pos);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") {
      done = true;
      renderPicker(pos);
    }
  };
  input.onchange = commit;
  input.onblur = commit;
}
function replaceMove(pos, si, k, oldMove, newMove) {
  const mv = E.Dex.moves.get(newMove);
  if (!mv.exists) {
    S.err = `"${newMove}" is not a move.`;
    renderPicker(pos);
    return;
  }
  const swap = (sets) => {
    const moves = sets[si][k].moves;
    const j = moves.findIndex((m) => E.toID(m) === E.toID(oldMove));
    if (j >= 0) moves[j] = mv.name;
  };
  swap(S.study.sets);
  if (pos.kind === "line") {
    const root = pathTo(S.cur)[0];
    swap(S.study.nodes[root].sets);
    forget(root);
  }
  save();
  S.err = "";
  S.sel = {};
  S.tera = {};
  if (pos.kind === "line") showPosition(false);
  renderPanels();
}
function playTurn(pos) {
  const choices = {};
  pos.battle.sides.forEach((side, si) => {
    if (!side.activeRequest || side.activeRequest.wait) return;
    let c = S.sel[pid(si)];
    if (c.startsWith("move") && S.tera[pid(si)]) c += " terastallize";
    choices[pid(si)] = c;
  });
  const reset = () => {
    S.sel = {};
    S.tera = {};
    S.err = "";
  };
  const onReplay = pos.kind === "turn" || pos.kind === "preview";
  if (onReplay && pos.battle.sides.every((side, si) => !side.activeRequest || side.activeRequest.wait || matchesPlayed(side, S.sel[pid(si)], S.tera[pid(si)], playedChoice(pos.t, si)))) {
    reset();
    S.stopAt = pos.t + 1;
    if (pos.t === 0) S.psb.reset();
    else S.psb.seekTurn(pos.t);
    S.psb.play();
    renderPanels();
    return;
  }
  const parent = onReplay ? "r" + pos.t : S.cur;
  const same = (k) => JSON.stringify(S.study.nodes[k].choices) === JSON.stringify(choices) && !S.study.nodes[k].forced.length;
  let id = kids(parent).find(same);
  if (!id) {
    id = addNode(parent, choices, [], void 0, onReplay ? S.study.sets : void 0);
    try {
      compute(id);
    } catch (e) {
      deleteNode(id);
      save();
      reset();
      S.err = e.message || String(e);
      renderPicker(pos);
      return;
    }
  }
  reset();
  go(id, { animate: true });
}

// source/app/dice.js
function renderDice(pos) {
  const el = $id("diceSec");
  el.hidden = pos.kind !== "line";
  if (el.hidden) return;
  const node = S.study.nodes[S.cur];
  const rolls = pos.rolls;
  el.innerHTML = `<div class="rb-dicehead"><h2>Dice</h2><span><button class="button" id="btnRandomize" title="Roll real dice for every outcome"><i class="fa fa-random" aria-hidden="true"></i> Randomize</button> <button class="button" id="btnLikely" title="Back to the most likely outcomes" ${node.forced.length ? "" : "disabled"}>Most likely</button></span></div>` + (rolls.length ? `<div class="rb-dice">${groups(rolls).map(groupHTML).join("")}</div>` : "");
  const set = (i, value) => replay(rolls.map((r, j) => ({ key: r.key, value: j === i ? value : r.value })), node.seed);
  for (const c of el.querySelectorAll("[data-roll]")) {
    const i = +c.dataset.roll, r = rolls[i];
    if (c.tagName === "SELECT") c.onchange = () => set(i, r.kind === "order" ? JSON.parse(c.value) : +c.value);
    else c.onclick = () => set(i, r.kind === "order" ? JSON.parse(c.dataset.order) : !r.value);
  }
  $id("btnRandomize").onclick = () => replay(rolls.map((r) => ({ key: r.key, value: randomOutcome(r) })), node.seed);
  $id("btnLikely").onclick = () => replay([], node.seed);
}
function replay(forced, seed) {
  const node = S.study.nodes[S.cur];
  if (kids(S.cur).length) {
    const id = addNode(node.parent, node.choices, forced, seed, node.sets);
    try {
      compute(id);
    } catch (e) {
      deleteNode(id);
      save();
      S.err = e.message;
      renderPanels();
      return;
    }
    go(id, { animate: true });
  } else {
    node.forced = forced;
    node.seed = seed;
    forget(S.cur);
    save();
    try {
      compute(S.cur);
    } catch (e) {
      S.err = e.message;
    }
    go(S.cur, { animate: true, force: true });
  }
}
function mostLikely(r) {
  if (r.kind === "chance") return r.p >= 0.5;
  if (r.kind === "roll") return 7;
  if (r.kind === "int") return r.lo + Math.floor((r.hi - 1 - r.lo) / 2);
  if (r.kind === "order") return r.options.map((_, k) => k);
  return null;
}
var changed = (r) => {
  const d = mostLikely(r);
  return d !== null && JSON.stringify(d) !== JSON.stringify(r.value);
};
function randomOutcome(r) {
  const below = (n) => Math.floor(Math.random() * n);
  if (r.kind === "chance") return Math.random() < r.p;
  if (r.kind === "roll") return below(16);
  if (r.kind === "int") return r.lo + below(r.hi - r.lo);
  if (r.kind === "pick") return below(r.options.length);
  if (r.kind === "order") {
    const o = r.options.map((_, k) => k);
    for (let k = o.length - 1; k > 0; k--) {
      const j = below(k + 1);
      [o[k], o[j]] = [o[j], o[k]];
    }
    return o;
  }
  return r.value;
}
function groups(rolls) {
  const out = [];
  for (const r of rolls) {
    const m = /^(.+?): (accuracy|critical hit|damage roll|.+ \(\d+%\))$/.exec(r.label);
    const key = m && r.who ? r.who + "|" + m[1] : null;
    const last = out[out.length - 1];
    if (key && last && last.key === key && !last.items.some((x) => x.part === m[2] && m[2] !== "damage roll")) {
      last.items.push({ r, part: m[2] });
      last.target || (last.target = r.target);
      continue;
    }
    out.push(key ? { key, who: r.who, move: m[1], target: r.target, items: [{ r, part: m[2] }] } : { key: null, items: [{ r, part: r.label }] });
  }
  return out;
}
function groupHTML(g) {
  const head = g.key ? `<span class="rb-dhead">${esc(g.who)}'s <b>${esc(g.move)}</b>${g.target ? ` <span class="rb-darrow">\u2192</span> ${esc(g.target)}` : ""}</span>` : "";
  return `<div class="rb-dgroup">${head}<span class="rb-dchips">${g.items.map(itemHTML).join("")}</span></div>`;
}
var chip = (r, text, title) => `<button type="button" class="rb-chip ${changed(r) ? "dev" : ""} ${r.kind === "chance" && r.value ? "yes" : ""}" data-roll="${r.i}" title="${esc(title)}">${esc(text)}</button>`;
var label = (text) => `<span class="rb-dlabel">${text}</span>`;
function select(r, options) {
  const current = r.kind === "order" ? JSON.stringify(r.value) : r.value;
  return `<select class="rb-chipsel ${changed(r) ? "dev" : ""}" data-roll="${r.i}">` + options.map(([v, text]) => `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(text)}</option>`).join("") + `</select>`;
}
var capital = (s) => s[0].toUpperCase() + s.slice(1);
function itemHTML({ r, part }) {
  const pct = r.p !== void 0 ? Math.round(r.p * 1e3) / 10 + "%" : "";
  switch (r.kind) {
    case "chance": {
      if (part === "accuracy") return chip(r, r.value ? "Hit" : "Miss", `${pct} to hit. Click to change.`);
      if (part === "critical hit") return chip(r, r.value ? "Crit" : "No crit", `${pct} to crit. Click to change.`);
      const effect = /^(.+) \((\d+)%\)$/.exec(part);
      if (effect) return chip(r, r.value ? capital(effect[1]) : "No " + effect[1], `${effect[2]}% chance. Click to change.`);
      return label(esc(r.label) + (r.who ? ` <small>${esc(r.who)}</small>` : "")) + chip(r, r.value ? "Yes" : "No", `${pct} chance. Click to change.`);
    }
    case "roll":
      return select(r, Array.from({ length: 16 }, (_, v) => [v, `${100 - v}% damage`]));
    case "int":
      return label(esc(r.label)) + (r.hi - r.lo <= 40 ? select(r, Array.from({ length: r.hi - r.lo }, (_, k) => [r.lo + k, String(r.lo + k)])) : `<span>${r.value}</span>`);
    case "pick":
      return label(esc(r.label)) + select(r, r.options.map((o, k) => [k, o]));
    case "order": {
      const orders = permutations(r.options.length).slice(0, 24);
      if (r.options.length === 2) return label("Speed tie") + orders.map((o) => `<button type="button" class="rb-chip ${JSON.stringify(o) === JSON.stringify(r.value) ? "yes" : ""}" data-roll="${r.i}" data-order="${esc(JSON.stringify(o))}">${esc(r.options[o[0]])} first</button>`).join("");
      return label(esc(r.label)) + select(r, orders.map((o) => [JSON.stringify(o), o.map((k) => r.options[k]).join(" > ")]));
    }
  }
  return "";
}
function permutations(n) {
  const out = [];
  const build = (prefix, rest) => {
    if (!rest.length) out.push(prefix);
    rest.forEach((x, i) => build([...prefix, x], rest.filter((_, j) => j !== i)));
  };
  build([], [...Array(n).keys()]);
  return out;
}

// source/app/panels.js
var GLYPHS = ["!!", "!", "!?", "?!", "?", "??"];
function renderStudyPanel() {
  const el = $id("studySec");
  el.innerHTML = `<div class="rb-tabs"><button class="button ${S.tab === "study" ? "cur" : ""}" data-tab="study">Study</button><button class="button ${S.tab === "teams" ? "cur" : ""}" data-tab="teams">Teams</button></div><div id="tabBody"></div>`;
  for (const b of el.querySelectorAll("[data-tab]")) b.onclick = () => {
    S.tab = b.dataset.tab;
    renderStudyPanel();
  };
  if (S.tab === "study") renderStudy();
  else renderTeams($id("tabBody"));
}
function lineToken(id) {
  let line;
  try {
    line = compute(id);
  } catch {
    return `<span class="rb-tok rb-err" data-go="${id}">(error)</span>`;
  }
  const n = S.study.nodes[id];
  const s = E.summarize(line.lines);
  const turn = isReplayPos(n.parent) ? replayTurn(n.parent) : compute(n.parent).battle.turn;
  return `<span class="rb-tok ${id === S.cur ? "cur" : ""}" data-go="${id}"><span class="tn">${turn}.</span>${esc(s.p1 || "\u2026")} <span class="tn">|</span> ${esc(s.p2 || "\u2026")}` + (n.forced.length ? ' <i class="fa fa-cube" title="Dice set by you" aria-hidden="true"></i>' : "") + (n.glyph ? `<span class="rb-glyph">${esc(n.glyph)}</span>` : "") + (n.comment ? ` <i class="rb-cmt">${esc(n.comment.slice(0, 60))}</i>` : "") + `</span>`;
}
function lineHTML(first) {
  let html = "";
  for (let id = first; id; id = kids(id)[0]) {
    html += lineToken(id) + " ";
    html += kids(id).slice(1).map((k) => `<div class="rb-var">${lineHTML(k)}</div>`).join("");
  }
  return html;
}
var linesFrom = (id) => kids(id).length ? `<div class="rb-vars">${kids(id).map((k) => `<div class="rb-var">${lineHTML(k)}</div>`).join("")}</div>` : "";
function renderStudy() {
  const body = $id("tabBody");
  const leads = E.replayLeads(S.rep);
  const row = (id, no, cells, extra = "") => `<div class="rb-mrow ${extra} ${S.cur === id ? "cur" : ""}" data-go="${id}"><div class="no">${no}</div>${cells}</div>`;
  const rows = [
    row("r0", "", `<div class="a">Team preview</div>`, "start"),
    linesFrom("r0"),
    row("r1", 0, `<div class="a">\u2192 ${esc(leads.p1 || "?")}</div><div class="a">\u2192 ${esc(leads.p2 || "?")}</div>`),
    linesFrom("r1")
  ];
  for (let t = 1; t <= S.rep.lastTurn; t++) {
    const id = "r" + (t + 1);
    const s = turnSummary(t);
    const note2 = S.study.notes[id] || {};
    rows.push(row(id, t, `<div class="a">${esc(s.p1 || "\u2014")}${note2.glyph ? `<span class="rb-glyph">${esc(note2.glyph)}</span>` : ""}</div><div class="a">${esc(s.p2 || "\u2014")}</div>`));
    if (note2.comment) rows.push(`<div class="rb-vars rb-plain"><span class="rb-cmt">${esc(note2.comment)}</span></div>`);
    rows.push(linesFrom(id));
  }
  const note = noteOf(S.cur);
  const inLine = !isReplayPos(S.cur);
  const isFirst = inLine && kids(S.study.nodes[S.cur].parent)[0] === S.cur;
  body.innerHTML = `<div class="rb-movelist">${rows.join("")}</div>
    <div class="rb-notes">
      <div class="rb-glyphs">${GLYPHS.map((g) => `<button class="button ${note.glyph === g ? "on" : ""}" data-glyph="${g}">${g}</button>`).join(" ")}</div>
      <textarea id="comment" class="textbox" rows="2" placeholder="Note on this position">${esc(note.comment || "")}</textarea>
      ${inLine ? `<p class="rb-row" style="margin:0"><button class="button" id="btnPromote" ${isFirst ? "disabled" : ""}>Make this the first line</button>
        <button class="button" id="btnDelete">${S.deleteArmed === S.cur ? "Click again to delete" : "Delete from here"}</button></p>` : ""}
    </div>`;
  for (const el of body.querySelectorAll("[data-go]")) el.onclick = () => go(el.dataset.go);
  for (const b of body.querySelectorAll("[data-glyph]")) b.onclick = () => {
    const n = noteOf(S.cur, true);
    n.glyph = n.glyph === b.dataset.glyph ? "" : b.dataset.glyph;
    save();
    renderStudy();
  };
  $id("comment").oninput = (e) => {
    noteOf(S.cur, true).comment = e.target.value;
    save();
  };
  $id("comment").onchange = renderStudy;
  if (inLine) {
    $id("btnPromote").onclick = () => {
      promote(S.cur);
      renderStudy();
    };
    $id("btnDelete").onclick = () => {
      if (S.deleteArmed !== S.cur) {
        S.deleteArmed = S.cur;
        renderStudy();
        return;
      }
      const parent = S.study.nodes[S.cur].parent;
      deleteNode(S.cur);
      S.deleteArmed = null;
      save();
      go(parent);
    };
  }
  const cur = body.querySelector(".cur");
  if (cur) {
    const list = body.querySelector(".rb-movelist");
    list.scrollTop = Math.max(0, cur.offsetTop - list.offsetTop - 60);
  }
}

// source/app/navigation.js
function position() {
  if (!isReplayPos(S.cur)) {
    const r = compute(S.cur);
    return { kind: "line", battle: r.battle, rolls: r.rolls };
  }
  const t = replayTurn(S.cur);
  const canPick = pickerOn() && !isDoubles() && !isPlaying();
  if (canPick && t === 0 && S.psb && !S.psb.started) {
    const pv = previewPos(S.study.sets);
    if (pv) return { kind: "preview", t, battle: pv.battle };
  }
  if (canPick && t >= 1 && t <= S.rep.lastTurn) return { kind: "turn", t, battle: replayTurnPos(t, S.study.sets).battle };
  return { kind: "replay", t };
}
function renderPanels() {
  let pos;
  try {
    pos = position();
  } catch (e) {
    console.error(e);
    S.err = e.message || String(e);
    pos = { kind: "replay", t: isReplayPos(S.cur) ? replayTurn(S.cur) : 0 };
  }
  renderPicker(pos);
  renderDice(pos);
  renderStudyPanel();
}
function go(id, { animate = false, force = false } = {}) {
  if (!id) return;
  if (isReplayPos(id) ? replayTurn(id) < 0 || replayTurn(id) > S.rep.lastTurn + 1 : !S.study.nodes[id]) return;
  const moved = S.cur !== id;
  if (moved) {
    S.sel = {};
    S.tera = {};
    S.err = "";
  }
  S.cur = id;
  S.deleteArmed = null;
  if (moved || force || !S.psMode) showPosition(animate);
  renderPanels();
}
function step(dir) {
  if (dir === "prev") go(parentOf(S.cur));
  else if (dir === "next") {
    const next = childrenOf(S.cur)[0];
    go(next, { animate: !!next && !isReplayPos(next) });
  } else {
    const sib = siblings(S.cur), j = sib.indexOf(S.cur) + (dir === "up" ? -1 : 1);
    if (j >= 0 && j < sib.length) go(sib[j]);
  }
}
function onKey(e) {
  if (!S.rep || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, textarea, select")) return;
  if (document.querySelector(".rb-modal:not([hidden]), #gate:not([hidden])")) return;
  const dir = { ArrowLeft: "prev", ArrowRight: "next", ArrowUp: "up", ArrowDown: "down" }[e.key];
  if (dir) {
    e.preventDefault();
    step(dir);
    return;
  }
  const picker = $id("pickSec");
  if (picker.hidden) return;
  if (/^[1-9]$/.test(e.key)) {
    const b = picker.querySelectorAll("[data-pick]")[+e.key - 1];
    if (b && !b.disabled) {
      e.preventDefault();
      b.click();
    }
  } else if (e.key === "t" || e.key === "T") {
    const box = $id("teraBox");
    if (box) {
      box.checked = !box.checked;
      box.dispatchEvent(new Event("change"));
    }
  }
}

// source/app/viewer.js
var FADE = { hyperfast: 40, fast: 50, normal: 300, slow: 500, reallyslow: 1e3 };
var DELAY = { hyperfast: 1, fast: 1, normal: 1, slow: 1e3, reallyslow: 3e3 };
var isPlaying = () => !!(S.psb && !S.psb.paused && !S.psb.atQueueEnd);
function attachToEmbed() {
  fixEffectUrls();
  Replays.rewind = () => step("prev");
  Replays.ff = () => step("next");
  Replays.reset = () => go("r0");
  const settings = Replays.$(".replay-controls-2");
  settings.append('<div class="chooser pickerchooser"> <em>Move&nbsp;picker:</em> <div><button value="on">On</button><button value="off">Off</button></div> </div>');
  settings.find(".pickerchooser button").on("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setPicker(e.currentTarget.value === "on");
  });
  showPickerSetting();
  S.psb = Replays.battle;
  S.psMode = "main";
  listen(S.psb);
}
function fixEffectUrls() {
  if (!window.BattleEffects || !Dex.fxPrefix) return;
  for (const e of Object.values(BattleEffects)) if (e && e.url && !/^(https?:)?\/\//.test(e.url)) e.url = Dex.fxPrefix + e.url;
}
function showPickerSetting() {
  const on = pickerOn();
  Replays.$(".pickerchooser button").each((_, b) => {
    b.classList.toggle("sel", b.value === "on" === on);
  });
}
function listen(battle) {
  battle.subscribe((state) => {
    Replays.update(state);
    onBattleEvent(state);
  });
}
function newBattle(lines) {
  const old = Replays.battle;
  const switched = old && old.viewpointSwitched;
  try {
    old.destroy();
  } catch {
  }
  Replays.$(".battle").empty();
  Replays.$(".battle-log").empty();
  const b = new Battle({ id: S.key, $frame: Replays.$(".battle"), $logFrame: Replays.$(".battle-log"), log: lines, isReplay: true, paused: true, autoresize: true });
  const speed = Replays.$(".speedchooser button.sel").val() || "normal";
  b.messageShownTime = DELAY[speed];
  b.messageFadeTime = FADE[speed];
  b.scene.updateAcceleration();
  b.setMute(!!Replays.muted);
  if (switched) b.switchViewpoint();
  Replays.battle = b;
  S.psb = b;
  listen(b);
  Replays.update();
}
function onBattleEvent(state) {
  if (S.seeking) return;
  if (S.psMode !== "main") {
    if (state === "atqueueend" && !S.psb.paused) S.psb.pause();
    return;
  }
  const b = S.psb;
  if (S.stopAt && b.turn >= S.stopAt) {
    S.stopAt = null;
    b.pause();
  }
  const t = b.ended ? S.rep.lastTurn + 1 : Math.min(b.turn, S.rep.lastTurn + 1);
  const playing = isPlaying();
  if ("r" + t !== S.cur) {
    S.cur = "r" + t;
    S.sel = {};
    S.tera = {};
    renderPanels();
  } else if (playing !== S.wasPlaying) renderPicker(position());
  S.wasPlaying = playing;
}
function showPosition(animate) {
  S.seeking = true;
  try {
    if (isReplayPos(S.cur)) {
      if (S.psMode !== "main") {
        newBattle(S.rep.lines);
        S.psMode = "main";
      }
      const t = replayTurn(S.cur);
      if (t === 0) S.psb.reset();
      else S.psb.seekTurn(t > S.rep.lastTurn ? Infinity : t);
    } else {
      const path = pathTo(S.cur);
      const from = replayTurn(S.study.nodes[path[0]].parent);
      const replayPart = S.rep.lines.slice(0, from === 0 ? startIndex() : S.rep.turnIdx[from] + 1);
      const earlier = path.slice(0, -1).flatMap((id) => compute(id).lines);
      const last = compute(S.cur).lines;
      S.psMode = "line:" + S.cur;
      newBattle(animate ? replayPart.concat(earlier) : replayPart.concat(earlier, last));
      S.psb.seekTurn(Infinity);
      if (animate) {
        for (const l of last) S.psb.add(l);
        S.psb.play();
      }
    }
  } finally {
    S.seeking = false;
  }
  showTitle();
}
function showTitle() {
  $id("rbTitle").innerHTML = `<strong>${esc(S.rep.tier || S.rep.formatid)}</strong><br>${esc(playerName(0))} vs. ${esc(playerName(1))}` + (isReplayPos(S.cur) ? "" : ' <span class="rb-mode">Your line</span>');
}

// source/app/load.js
async function loadText(text, { shown = false, replayId = null, study = null } = {}) {
  const t = String(text || "").trim();
  let exported = null;
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      if (j && j.rbv && j.log) exported = j;
    } catch {
    }
  }
  const rep = E.parseReplayInput(exported ? exported.log : t);
  S.rep = rep;
  S.replayId = replayId;
  S.key = rep.meta.id || "log-" + hash(rep.lines.slice(0, 40).join("\n") + rep.lines.length);
  S.lines.clear();
  S.replayPos.clear();
  S.stats = await fetchStats(rep.formatid);
  S.cbEnd = E.clientAt(rep, rep.lastTurn + 1);
  S.base = [S.cbEnd.p1, S.cbEnd.p2].map((side) => side.team.map((p) => E.suggestSet(E.knownOf(p), S.stats, rep.gen)));
  S.study = study || exported?.study || loadSaved(S.key) || newStudy();
  const fits = S.study.sets?.length === 2 && S.study.sets.every((side, si) => side.length === S.base[si].length);
  if (!fits) S.study.sets = clone(S.base);
  if (study || exported) save();
  S.sel = {};
  S.tera = {};
  S.err = "";
  if (!shown) S.psMode = "";
  S.cur = "";
  go("r0");
}
var statsIndex = null;
async function fetchStats(formatid) {
  try {
    statsIndex || (statsIndex = fetch("stats/index.json").then((r2) => r2.json()));
    if (!(formatid in await statsIndex)) return null;
    const r = await fetch("stats/" + formatid + ".json");
    return r.ok ? await r.json() : null;
  } catch {
    statsIndex = null;
    return null;
  }
}
function replayIdFrom(s) {
  const m = String(s || "").trim().replace(/[?#].*$/, "").replace(/\.(json|log|html)$/, "").match(/^(?:https?:\/\/)?(?:replay\.pokemonshowdown\.com|psim\.us\/r)\/([a-z0-9-]+)$/i);
  return m ? m[1] : null;
}
async function fetchReplay(id) {
  const r = await fetch(`https://replay.pokemonshowdown.com/${id}.json`);
  if (!r.ok) throw new Error(r.status === 404 ? "Replay not found (it may be private or deleted)." : `Could not load the replay (${r.status}).`);
  return r.text();
}
async function shareLink() {
  const payload = { rbv: 1, study: S.study, ...S.replayId ? { id: S.replayId } : { log: S.rep.lines.join("\n") } };
  const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const data = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return location.href.replace(/#.*$/, "") + "#s=" + data;
}
async function openSharedLink() {
  const m = /^#s=([\w-]+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", location.href.replace(/#.*$/, ""));
  const binary = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const payload = JSON.parse(await new Response(stream).text());
  const text = payload.id ? await fetchReplay(payload.id) : payload.log;
  await loadText(text, { replayId: payload.id || null, study: payload.study });
}
function wireDialogs() {
  const loader = $id("loader"), sharer = $id("sharer");
  $id("btnLoad").onclick = () => {
    loader.hidden = false;
    $id("loadErr").textContent = "";
    $id("replayUrl").focus();
  };
  $id("btnShare").onclick = async () => {
    $id("exportBox").value = JSON.stringify({ rbv: 1, log: S.rep.lines.join("\n"), study: S.study });
    $id("shareLink").value = await shareLink();
    $id("copyMsg").textContent = "";
    sharer.hidden = false;
  };
  $id("fileIn").onchange = async () => {
    const f = $id("fileIn").files[0];
    if (f) $id("pasteBox").value = await f.text();
  };
  $id("btnDoLoad").onclick = () => loadFrom(async () => {
    const id = replayIdFrom($id("replayUrl").value) || replayIdFrom($id("pasteBox").value);
    return id ? { text: await fetchReplay(id), replayId: id } : { text: $id("pasteBox").value };
  });
  $id("btnSample").onclick = () => loadFrom(async () => {
    const text = await fetch("sample.json").then((r) => r.text());
    return { text, replayId: JSON.parse(text).id };
  });
  $id("btnCancel").onclick = () => {
    loader.hidden = true;
  };
  const copy = async (box, done) => {
    try {
      await navigator.clipboard.writeText(box.value);
      $id("copyMsg").textContent = done;
    } catch {
      box.select();
      $id("copyMsg").textContent = "Press Ctrl+C to copy";
    }
  };
  $id("btnCopyLink").onclick = () => copy($id("shareLink"), "Link copied");
  $id("btnCopy").onclick = () => copy($id("exportBox"), "Text copied");
  $id("btnCloseShare").onclick = () => {
    sharer.hidden = true;
  };
  for (const modal of [loader, sharer, $id("importer")]) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.hidden = true;
    });
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") modal.hidden = true;
    });
  }
}
async function loadFrom(get) {
  $id("loadErr").textContent = "";
  try {
    const { text, replayId } = await get();
    await loadText(text, { replayId });
    $id("loader").hidden = true;
    $id("pasteBox").value = "";
    $id("replayUrl").value = "";
  } catch (e) {
    $id("loadErr").textContent = e.message || String(e);
  }
}

// source/app/main.js
var TEAMBUILDER_TABLES = "https://play.pokemonshowdown.com/data/teambuilder-tables.js?a7";
async function boot() {
  try {
    setEngine(await import("./engine.js"));
    await until(() => window.Replays && Replays.battle && window.Battle && window.Dex);
    attachToEmbed();
    listenForTooltips($id("pickSec"));
    wireDialogs();
    document.addEventListener("keydown", onKey);
    const sample = await fetch("sample.json").then((r) => r.text());
    await loadText(sample, { shown: true, replayId: JSON.parse(sample).id });
    await openSharedLink();
    (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => {
      const s = document.createElement("script");
      s.src = TEAMBUILDER_TABLES;
      document.head.appendChild(s);
    });
  } catch (e) {
    console.error(e);
    const el = $id("pickSec");
    el.hidden = false;
    el.innerHTML = `<p class="rb-err">Could not start: ${esc(e.message || e)}</p>`;
  }
}
function until(test, ms = 6e4) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = test();
      } catch {
      }
      if (ok) resolve();
      else if (Date.now() - t0 > ms) reject(new Error("Showdown did not load (check your connection)."));
      else setTimeout(tick, 100);
    };
    tick();
  });
}
boot();
