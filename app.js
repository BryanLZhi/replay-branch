// source/app/state.js
var S = {
  rep: null,
  // the parsed replay (engine.parseReplayInput)
  key: "",
  // storage key for this replay's study
  replayId: null,
  // replay.pokemonshowdown.com/<replayId>, when it came from there
  ready: null,
  // resolves once the simulator and Showdown's viewer are loaded
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
  // picks changed this turn, by slot ('p1a', 'p1b', 'p2a'...); the rest are what the replay's players did
  menu: null,
  // the slot whose move menu is open ('p1a', 'p2b'...) or null
  aim: null,
  // in doubles, the move the open menu asks a target for: {n}
  gimmick: {},
  // by slot: 'terastallize', 'mega', 'megax', 'megay', 'ultra', 'zmove' or 'dynamax' ticked with the move
  next: null,
  // the dice of the turn on the bar, before it is played: {key, forced, seed, base, rolls, for}
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
  replayPos: /* @__PURE__ */ new Map(),
  // simulator positions on the replay (team preview, start of a turn) by turn + sets
  realDice: /* @__PURE__ */ new Map()
  // the dice each replay turn rolled, as found from its log, by turn + sets
};
var E = null;
function setEngine(engine) {
  E = engine;
}
function clearPicks() {
  S.sel = {};
  S.gimmick = {};
  S.menu = null;
  S.aim = null;
  S.next = null;
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
    return true;
  } catch {
    return false;
  }
}
function unstore(key) {
  try {
    localStorage.removeItem(key);
  } catch {
  }
}

// source/app/study.js
var SEED = [11, 22, 33, 44];
var GLYPHS = ["!!", "!", "!?", "?!", "?", "??"];
var isReplayPos = (id) => id[0] === "r";
var replayTurn = (id) => +id.slice(1);
function newStudy() {
  return { rbv: 1, sets: null, nodes: {}, kids: {}, notes: {}, seq: 0 };
}
function save() {
  const ok = store("rbv:" + S.key, JSON.stringify(S.study));
  const warning = document.getElementById("saveErr");
  if (warning) warning.hidden = ok;
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
var startOf = (parent, sets) => parent === "r0" ? previewPos(sets).json : isReplayPos(parent) ? replayTurnPos(replayTurn(parent), sets).json : compute(parent).json;
function compute(id) {
  if (S.lines.has(id)) return S.lines.get(id);
  const n = S.study.nodes[id];
  const r = n.edit ? { ...E.editPosition(startOf(n.parent, n.sets), n.edit), rolls: [] } : E.step(startOf(n.parent, n.sets), n.choices, n.forced, n.seed);
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
function addEdit(parent, edit, sets) {
  var _a;
  const id = "n" + ++S.study.seq;
  S.study.nodes[id] = { id, parent, choices: {}, forced: [], edit, sets: sets && clone(sets), comment: "", glyph: "" };
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
var watchOnly = () => S.rep.lines.some((l) => /^\|gametype\|(triples|freeforall|multi)/.test(l));
var isFresh = (rep = S.rep) => !rep.lines.some((l) => l.startsWith("|move|"));
var startIndex = () => S.rep.lines.findIndex((l) => l === "|start");
var playerName = (si) => S.cbEnd[pid(si)].name || "Player " + (si + 1);
var teamIndex = (si, name) => S.cbEnd[pid(si)].team.findIndex((p) => p.name === name);
function turnLines(t) {
  const a = S.rep.turnIdx[t], b = S.rep.turnIdx[t + 1] ?? S.rep.lines.length;
  return S.rep.lines.slice(a + 1, b);
}
var turnSummary = (t) => E.summarize(turnLines(t));
var family = (g) => g && g.startsWith("mega") ? "mega" : g || "";
var acted = /* @__PURE__ */ new WeakMap();
function playedChoice(t, si, place = 0) {
  const p = pid(si);
  if (t === 0) {
    const lead = E.replayLeads(S.rep)[p + "abc"[place]];
    return lead ? { kind: "lead", name: lead } : null;
  }
  if (!acted.has(S.rep)) acted.set(S.rep, /* @__PURE__ */ new Map());
  const turns = acted.get(S.rep);
  if (!turns.has(t)) turns.set(t, E.playedActions(S.rep, t));
  return turns.get(t)[si][place] || { kind: "cant", gimmick: "" };
}
var moveNames = (active, n) => E.moveNames(active, n);
function matchesPlayed(side, pick, gimmick, played, place = 0, def = null) {
  if (!played || !pick) return false;
  const [kind, n, target] = pick.split(" ");
  const req = side.activeRequest;
  if (played.kind === "lead") return nameOf(req.side.pokemon[n - 1].ident) === played.name;
  if (played.kind === "cant") return kind === "move";
  if (kind !== played.kind) return false;
  if (kind === "move") {
    if (played.target && def && def.pick.split(" ")[2] !== target) return false;
    return moveNames(req.active[place], n).includes(E.toID(played.name)) && family(gimmick) === family(played.gimmick);
  }
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
  body.innerHTML = (S.stats ? "" : `<p class="rb-err">No usage stats for ${esc(S.rep.formatid)}.</p>`) + `<ul id="teamCheck" class="rb-problems" hidden></ul>` + side(0) + side(1);
  const rerender = () => renderTeams(body);
  showMismatches();
  for (const input of body.querySelectorAll("[data-field]")) input.onchange = () => {
    const set = S.study.sets[input.dataset.side][input.dataset.k];
    const f = input.dataset.field;
    const v = input.value.trim();
    let changedNature = false;
    if (f.startsWith("move")) set.moves[+f.slice(4)] = v;
    else if (f.startsWith("ev_")) {
      changedNature = setEv(set, f.slice(3), v);
      input.value = Number(set.evs[f.slice(3)]) || 0;
    } else if (f === "level") set.level = Math.max(1, Math.min(100, +v || 100));
    else {
      set[f] = v;
      changedNature = f === "nature";
    }
    save();
    input.classList.remove("guess");
    renderPicker(position());
    if (changedNature) rerender();
    else showMismatches();
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
var pending = 0;
function showMismatches() {
  const ticket = ++pending;
  setTimeout(() => {
    const list = $id("teamCheck");
    if (ticket !== pending || !list) return;
    const problems = S.study.sets.some((side) => side.some((s) => s.pasted)) ? E.checkSets(S.rep, S.study.sets) : [];
    list.innerHTML = problems.map((p) => `<li>${esc(p.text)}</li>`).join("");
    list.hidden = !problems.length;
  });
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
  const evs = STATS.map((st) => `<span>${STAT_NAMES[st]}${mark(st)}</span>`).join("") + STATS.map((st) => `<input class="textbox" ${attrs("ev_" + st)} inputmode="numeric" value="${Number(set.evs[st]) || 0}" aria-label="${STAT_NAMES[st]} EVs">`).join("");
  const abilities = [.../* @__PURE__ */ new Set([...Object.values(sp.abilities || {}), set.ability])].filter(Boolean);
  return `<div class="rb-mon">
    <div class="hd"><span class="rb-picon" style="${icon(set.species)}"></span><span class="nm">${esc(set.name)}${set.name !== set.species ? ` <span class="rb-note">(${esc(set.species)})</span>` : ""}</span> ${(sp.types || []).map(typeTag).join("")}</div>
    <label>Item<input class="textbox ${guess(seen.item, set.item, base.item)}" ${attrs("item")} list="dl-items" value="${esc(set.item)}" title="${seen.item ? "Seen in the replay" : "Guess" + pct(usage.items, set.item)}"></label>
    <label>Ability<select class="button ${guess(seen.ability, set.ability, base.ability)}" ${attrs("ability")}>${abilities.map((a) => `<option ${a === set.ability ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
    ${S.rep.gen >= 9 ? `<label>Tera<select class="button ${guess(seen.tera, set.teraType, base.teraType)}" ${attrs("teraType")}>${types.map((t) => `<option ${t === set.teraType ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>` : ""}
    <div class="rb-mvgrid">${moves}</div>
    ${S.rep.gen >= 3 ? `<label>Nature<input class="textbox" ${attrs("nature")} list="dl-natures" value="${esc(set.nature)}"></label>
    <div class="rb-evs">${evs}</div>` : ""}
    <label>Level<input class="textbox" ${attrs("level")} type="number" min="1" max="100" value="${Number(set.level) || 100}"></label>
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
      const { sets, problems } = E.matchTeam(S.rep, si, team, S.study.sets[1 - si]);
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
    if (set) S.study.sets[si][k] = { ...set, itemGone: S.base[si][k].itemGone };
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
function setTooltipRequest(si, req, place = 0) {
  request = req ? { si, req, place } : null;
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
  const [type, n, as] = elem.dataset.tooltip.split("|");
  const { si, req, place } = request;
  tips.battle = S.psb;
  let html;
  try {
    if (type === "move") {
      const active = S.psb.sides[si].active[place];
      if (!active) return false;
      const move = req.active[place].moves[n];
      html = tips.showMoveTooltip(S.psb.dex.moves.get(move.id || move.move), as || "move", active, serverPokemon(req.side.pokemon[place]));
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

// source/app/dice.js
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var REAL_SEED = [5, 6, 7, 8];
var turnName = (t) => t ? "Turn " + t : "Team preview";
function sameStep(parent, choices, forced, seed) {
  return kids(parent).find((k) => {
    const n = S.study.nodes[k];
    return !n.edit && same(n.choices, choices) && same(n.forced, forced) && (!seed || same(n.seed, seed));
  });
}
function realDice(t, turn) {
  const k = t + ":" + hash(JSON.stringify(turn.sets));
  if (!S.realDice.has(k)) {
    let forced = [];
    try {
      forced = E.realDice(startOf(turn.parent, turn.sets), turn.choices, REAL_SEED, E.turnLog(S.rep, t)).forced;
    } catch {
    }
    S.realDice.set(k, forced);
  }
  return S.realDice.get(k);
}
function upcomingDice(pos) {
  const turn = barTurn(pos);
  if (!turn) return null;
  const key = turn.parent + " " + JSON.stringify(turn.choices) + " " + (turn.sets ? hash(JSON.stringify(turn.sets)) : "") + (turn.replay ? " real" : "");
  if (S.next?.key !== key) {
    if (turn.replay) {
      const real = realDice(pos.t, turn);
      S.next = { key, turn, real, forced: real, seed: REAL_SEED };
    } else {
      const played = kids(turn.parent).map((k) => S.study.nodes[k]).find((n) => !n.edit && same(n.choices, turn.choices));
      S.next = { key, turn, forced: played ? played.forced : [], seed: played ? played.seed : newSeed() };
    }
    S.next.base = S.next.seed;
  }
  const now = JSON.stringify(S.next.forced);
  if (S.next.for !== now) {
    try {
      S.next.rolls = E.step(startOf(turn.parent, turn.sets), turn.choices, S.next.forced, S.next.seed).rolls;
    } catch {
      S.next.rolls = [];
    }
    S.next.for = now;
  }
  return S.next;
}
function setUpcoming(forced) {
  const { turn } = S.next;
  const played = sameStep(turn.parent, turn.choices, forced);
  S.next.forced = forced;
  S.next.seed = played ? S.study.nodes[played].seed : S.next.base;
  renderPanels();
}
function renderDice(pos) {
  const el = $id("diceSec");
  const next = upcomingDice(pos);
  el.hidden = next ? !next.rolls.length : pos.kind !== "line" || !!S.study.nodes[S.cur].edit;
  if (el.hidden) {
    el.textContent = "";
    return;
  }
  let rolls, forced, before, when, apply3;
  if (next) {
    ({ rolls, forced } = next);
    before = pathTo(S.cur);
    when = turnName(pos.battle.turn);
    apply3 = setUpcoming;
  } else {
    const node = S.study.nodes[S.cur];
    rolls = pos.rolls;
    forced = node.forced;
    before = pathTo(S.cur).slice(0, -1);
    when = turnName(isReplayPos(node.parent) ? replayTurn(node.parent) : compute(node.parent).battle.turn);
    apply3 = (f) => replay(f, node.seed);
  }
  const turn = odds(rolls), line = before.reduce((p, id) => p * odds(compute(id).rolls), turn);
  const oddsHTML = rolls.some((r) => r.kind !== "roll" && !(r.kind === "int" && r.hi - r.lo > 10)) ? `<span class="rb-odds" title="Chance of these outcomes (damage rolls not counted)">This turn <b>${percent(turn)}</b>${before.length ? ` \xB7 Line <b>${percent(line)}</b>` : ""}</span>` : "";
  el.innerHTML = `<div class="rb-dicehead"><h2>Dice <small class="rb-dturn">${when}</small></h2>${oddsHTML}<span><button class="button" id="btnRandomize" title="Roll real dice for every outcome"><i class="fa fa-random" aria-hidden="true"></i> Randomize</button> <button class="button" id="btnLikely" title="Back to the most likely outcomes" ${forced.length ? "" : "disabled"}>Most likely</button>` + (next?.real ? ` <button class="button" id="btnReal" title="Back to how the turn went" ${same(forced, next.real) ? "disabled" : ""}>As played</button>` : "") + `</span></div>` + (rolls.length ? `<div class="rb-dice">${groups(rolls).map(groupHTML).join("")}</div>` : "");
  const set = (i, value) => apply3(rolls.map((r, j) => ({ key: r.key, value: j === i ? value : r.value })));
  for (const c of el.querySelectorAll("[data-roll]")) {
    const i = +c.dataset.roll, r = rolls[i];
    if (c.tagName === "SELECT") c.onchange = () => set(i, r.kind === "order" ? JSON.parse(c.value) : +c.value);
    else c.onclick = () => set(i, r.kind === "order" ? JSON.parse(c.dataset.order) : !r.value);
  }
  $id("btnRandomize").onclick = () => apply3(rolls.map((r) => ({ key: r.key, value: randomOutcome(r) })));
  $id("btnLikely").onclick = () => apply3([]);
  if (next?.real) $id("btnReal").onclick = () => apply3(next.real);
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
function odds(rolls) {
  let p = 1;
  for (const r of rolls) {
    if (r.kind === "chance") p *= r.value ? r.p : 1 - r.p;
    else if (r.kind === "int" && r.hi - r.lo <= 10) p /= Math.max(1, r.hi - r.lo);
    else if (r.kind === "pick") p /= Math.max(1, r.options.length);
    else if (r.kind === "order") p /= factorial(r.options.length);
  }
  return p;
}
var factorial = (n) => n <= 1 ? 1 : n * factorial(n - 1);
function percent(p) {
  if (p <= 0) return "0%";
  const x = p * 100;
  return (x >= 10 ? Math.round(x) : x >= 1 ? x.toFixed(1) : x >= 0.01 ? x.toPrecision(2) : "< 0.01") + "%";
}
function mostLikely(r) {
  if (r.kind === "chance") return r.p >= 0.5;
  if (r.kind === "roll") return r.lo + Math.floor((r.hi - 1 - r.lo) / 2);
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
  if (r.kind === "roll") return r.lo + below(r.hi - r.lo);
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
    if (!key) {
      out.push({ key: null, items: [{ r, part: r.label }] });
      continue;
    }
    let g = null;
    for (let j = out.length - 1; j >= 0; j--) {
      const x = out[j];
      if (x.key !== key) continue;
      if (x.target && r.target && x.target !== r.target) continue;
      if (!x.items.some((y) => y.part === m[2] && m[2] !== "damage roll")) g = x;
      break;
    }
    if (g) {
      g.items.push({ r, part: m[2] });
      g.target || (g.target = r.target);
    } else out.push({ key, who: r.who, move: m[1], target: r.target, items: [{ r, part: m[2] }] });
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
      return select(r, Array.from({ length: r.hi - r.lo }, (_, k) => r.lo + k).map((v) => [v, (r.lo ? (v / 2.55).toFixed(1) : 100 - v) + "% damage"]));
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

// source/app/clean.js
var str = (v, max = 100) => typeof v === "string" ? v.slice(0, max) : "";
var int = (v, lo, hi, fallback) => Number.isInteger(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
var STATS2 = ["hp", "atk", "def", "spa", "spd", "spe"];
var stats = (o, max, fallback) => Object.fromEntries(STATS2.map((s) => [s, int(o?.[s], 0, max, fallback)]));
var CHOICE = /^(move [1-4]( (mega|megax|megay|ultra|zmove|dynamax|terastallize))?|switch [1-6]|team [1-6]|pass)$/;
function cleanSet(set, fallback) {
  if (!set || typeof set !== "object") return JSON.parse(JSON.stringify(fallback));
  const out = {
    name: str(set.name, 40) || fallback.name,
    species: str(set.species, 40) || fallback.species,
    item: str(set.item, 40),
    ability: str(set.ability, 40),
    nature: str(set.nature, 20),
    teraType: str(set.teraType, 20),
    gender: str(set.gender, 2),
    moves: (Array.isArray(set.moves) ? set.moves : []).slice(0, 4).map((m) => str(m, 40)),
    evs: stats(set.evs, 255, 0),
    ivs: stats(set.ivs, 31, 31),
    level: int(set.level, 1, 100, 100),
    itemGone: !!set.itemGone,
    fixed: fallback.fixed
  };
  if (set.pasted) out.pasted = true;
  return out;
}
function cleanSets(sets, base) {
  return base.map((side, si) => side.map((b, k) => cleanSet(Array.isArray(sets?.[si]) ? sets[si][k] : null, b)));
}
function cleanForced(list) {
  const value = (v) => typeof v === "boolean" || Number.isInteger(v) ? v : Array.isArray(v) && v.length <= 8 && v.every(Number.isInteger) ? v : void 0;
  return (Array.isArray(list) ? list : []).slice(0, 200).map((f) => ({ key: str(f?.key, 200), value: value(f?.value) })).filter((f) => f.key && f.value !== void 0);
}
var KEY = /^[a-z0-9]{1,40}$/;
var isKey = (v, table) => typeof v === "string" && KEY.test(v) && Object.keys(table).includes(v);
function cleanEdit(e) {
  if (!e || typeof e !== "object") return null;
  const out = { mons: [], field: {}, sides: [{}, {}] };
  for (const m of (Array.isArray(e.mons) ? e.mons : []).slice(0, 48)) {
    if (!m || typeof m !== "object" || ![0, 1].includes(m.s) || !Number.isInteger(m.k) || m.k < 0 || m.k > 23) continue;
    if (out.mons.some((x) => x.s === m.s && x.k === m.k)) continue;
    const c = { s: m.s, k: m.k };
    if (Number.isInteger(m.hp) && m.hp >= 0 && m.hp <= 100) c.hp = m.hp;
    if (m.status === "" || E.EDIT_STATUSES.includes(m.status)) c.status = m.status;
    if (m.boosts && typeof m.boosts === "object") {
      const b = {};
      for (const stat of E.EDIT_BOOSTS) if (Number.isInteger(m.boosts[stat]) && m.boosts[stat] >= -6 && m.boosts[stat] <= 6) b[stat] = m.boosts[stat];
      if (Object.keys(b).length) c.boosts = b;
    }
    if (m.item === "" || typeof m.item === "string" && KEY.test(m.item) && E.Dex.items.get(m.item).exists && E.Dex.items.get(m.item).id === m.item) c.item = m.item;
    if (Object.keys(c).length > 2) out.mons.push(c);
  }
  const f = e.field && typeof e.field === "object" ? e.field : {};
  if (f.weather === "" || isKey(f.weather, E.EDIT_WEATHERS)) out.field.weather = f.weather;
  if (f.terrain === "" || isKey(f.terrain, E.EDIT_TERRAINS)) out.field.terrain = f.terrain;
  if (f.trickroom === 0 || f.trickroom === 1) out.field.trickroom = f.trickroom;
  for (const si of [0, 1]) {
    const conds = Array.isArray(e.sides) && e.sides[si] && typeof e.sides[si] === "object" ? e.sides[si] : {};
    for (const [id, c] of Object.entries(E.EDIT_SIDE)) if (Number.isInteger(conds[id]) && conds[id] >= 0 && conds[id] <= c[2]) out.sides[si][id] = conds[id];
  }
  const empty = !out.mons.length && !Object.keys(out.field).length && out.sides.every((c) => !Object.keys(c).length);
  return empty ? null : out;
}
function cleanStudy(raw, base) {
  var _a;
  const study = { rbv: 1, sets: cleanSets(raw?.sets, base), nodes: {}, kids: {}, notes: {}, seq: 0 };
  if (str(raw?.name, 80).trim()) study.name = str(raw.name, 80).trim();
  const nodes = raw?.nodes && typeof raw.nodes === "object" ? raw.nodes : {};
  const ids = Object.keys(nodes).filter((id) => /^n\d{1,6}$/.test(id)).sort((a, b) => +a.slice(1) - +b.slice(1));
  for (const id of ids) {
    const n = nodes[id];
    if (!n || typeof n !== "object") continue;
    const parent = str(n.parent, 12);
    if (!/^r\d{1,4}$/.test(parent) && !study.nodes[parent]) continue;
    const edit = "edit" in n ? cleanEdit(n.edit) : null;
    if ("edit" in n && (!edit || parent === "r0")) continue;
    const choices = {};
    if (!edit) {
      for (const p of ["p1", "p2"]) if (typeof n.choices?.[p] === "string" && CHOICE.test(n.choices[p])) choices[p] = n.choices[p];
    }
    const seed = Array.isArray(n.seed) && n.seed.length === 4 && n.seed.every((x) => Number.isInteger(x) && x >= 0 && x < 65536) ? n.seed : [1, 2, 3, 4];
    study.nodes[id] = {
      id,
      parent,
      choices,
      forced: edit ? [] : cleanForced(n.forced),
      ...edit ? { edit } : { seed },
      comment: str(n.comment, 2e3),
      glyph: GLYPHS.includes(n.glyph) ? n.glyph : "",
      .../^r/.test(parent) ? { sets: cleanSets(n.sets, base) } : {}
    };
    study.seq = Math.max(study.seq, +id.slice(1));
  }
  for (const id of Object.keys(study.nodes)) {
    const parent = study.nodes[id].parent;
    ((_a = study.kids)[parent] || (_a[parent] = [])).push(id);
  }
  for (const [parent, list] of Object.entries(study.kids)) {
    const order = Array.isArray(raw?.kids?.[parent]) ? raw.kids[parent] : [];
    list.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  }
  for (const [id, note] of Object.entries(raw?.notes && typeof raw.notes === "object" ? raw.notes : {})) {
    if (/^r\d{1,4}$/.test(id)) study.notes[id] = { comment: str(note?.comment, 2e3), glyph: GLYPHS.includes(note?.glyph) ? note.glyph : "" };
  }
  if (raw?.meta && typeof raw.meta === "object") {
    study.meta = {
      format: str(raw.meta.format),
      players: (Array.isArray(raw.meta.players) ? raw.meta.players : []).slice(0, 2).map((p) => str(p, 40)),
      ...typeof raw.meta.log === "string" ? { log: raw.meta.log } : {},
      .../^[a-z0-9-]{1,120}$/.test(raw.meta.replayId || "") ? { replayId: raw.meta.replayId } : {},
      ...raw.meta.shared ? { shared: true } : {}
    };
  }
  if (Number.isFinite(raw?.opened)) study.opened = raw.opened;
  return study;
}
var MAX_CHAPTERS = 64;
var CHAPTER_KEY = /^[\w-]{1,120}(~[a-z0-9]{1,13})?$/;
var REPLAY_ID = /^[a-z0-9-]{1,120}$/;
var MAX_LOG = 4e6;
function cleanCollection(raw) {
  const chapters = [], seen = /* @__PURE__ */ new Set();
  for (const ch of (Array.isArray(raw?.chapters) ? raw.chapters : []).slice(0, MAX_CHAPTERS)) {
    const key = str(ch?.key, 140);
    if (!CHAPTER_KEY.test(key) || seen.has(key)) continue;
    seen.add(key);
    const title = str(ch.title, 80).trim();
    const log = typeof ch.log === "string" && ch.log.length <= MAX_LOG ? ch.log : null;
    chapters.push({ key, ...title ? { title } : {}, ...log ? { log } : {}, ...log && Array.isArray(ch.teams) ? { teams: looseSets(ch.teams) } : {} });
  }
  const out = { name: str(raw?.name, 80).trim() || "Study", chapters };
  if (chapters.some((ch) => ch.key === raw?.last)) out.last = raw.last;
  if (Number.isFinite(raw?.opened)) out.opened = raw.opened;
  if (raw?.shared) out.shared = true;
  return out;
}
function cleanStudyLink(raw) {
  const chapters = [];
  for (const ch of (Array.isArray(raw?.chapters) ? raw.chapters : []).slice(0, MAX_CHAPTERS)) {
    if (!ch || typeof ch !== "object") continue;
    const id = typeof ch.id === "string" && REPLAY_ID.test(ch.id) ? ch.id : null;
    const log = !id && typeof ch.log === "string" && ch.log.length <= MAX_LOG ? ch.log : null;
    if (!id && !log) continue;
    chapters.push({ ...id ? { id } : { log }, title: str(ch.title, 80).trim(), study: ch.study && typeof ch.study === "object" && !Array.isArray(ch.study) ? ch.study : null });
  }
  return { name: str(raw?.name, 80).trim() || "Study", chapters };
}
var looseSets = (s) => [0, 1].map((si) => (Array.isArray(s?.[si]) ? s[si] : []).slice(0, 24).map((set) => set && typeof set === "object" ? cleanSet(set, { name: "", species: "" }) : null));
function cleanChapterStudy(raw) {
  const sets = looseSets;
  const study = cleanStudy(raw, [[], []]);
  study.sets = sets(raw?.sets);
  for (const [id, n] of Object.entries(study.nodes)) if (n.sets) n.sets = sets(raw.nodes[id].sets);
  delete study.meta;
  delete study.opened;
  return study;
}

// source/app/editor.js
var STATUS_NAMES = { "": "\u2014", brn: "BRN", par: "PAR", psn: "PSN", tox: "TOX", slp: "SLP", frz: "FRZ" };
var icon2 = (species) => {
  try {
    return Dex.getPokemonIcon(species);
  } catch {
    return "";
  }
};
var hpColor = (hp) => hp > 50 ? "g" : hp > 20 ? "y" : "r";
var at = null;
var canEdit = (pos) => !!pos.battle && !pos.battle.ended && (pos.kind === "turn" || pos.kind === "line") && !watchOnly() && ["move", "switch"].includes(pos.battle.requestState);
function openEditor(pos) {
  if (!canEdit(pos)) return;
  const onReplay = pos.kind === "turn";
  const state = E.editState(pos.battle);
  at = { parent: onReplay ? "r" + pos.t : S.cur, sets: onReplay ? S.study.sets : void 0, state, options: E.editOptions(state.gen) };
  render();
}
function close() {
  at = null;
  const el = $id("editor");
  el.hidden = true;
  el.innerHTML = "";
}
function heldItems(gen) {
  const id = "dl-held" + gen;
  if (!$id(id)) {
    const d = document.createElement("datalist");
    d.id = id;
    d.innerHTML = E.Dex.items.all().filter((i) => i.gen <= gen && (!i.isNonstandard || i.isNonstandard === "Past")).map((i) => `<option value="${esc(i.name)}">`).join("");
    document.body.appendChild(d);
  }
  return id;
}
var select2 = (attrs, options, value, cls = "") => `<select class="textbox ${cls}" ${attrs}>` + options.map(([v, label2]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(label2)}</option>`).join("") + `</select>`;
function monHTML(si, m) {
  const { options, state } = at;
  const STAT = { atk: "Atk", def: "Def", spa: state.gen === 1 ? "Spc" : "SpA", spd: "SpD", spe: "Spe", accuracy: "Acc", evasion: "Eva" };
  const levels = Array.from({ length: 13 }, (_, k) => [6 - k, (6 - k > 0 ? "+" : "") + (6 - k)]);
  const stuck = m.fainted && m.active;
  const head = `<div class="rb-edhd"><span class="rb-picon" style="${icon2(m.species)}"></span><b class="nm">${esc(m.name)}</b><span class="rb-hpbar" aria-hidden="true"><span class="hp-${hpColor(m.hp)}" style="width:${m.hp}%"></span></span><label class="rb-edhp"><input class="textbox" type="number" min="0" max="100" step="1" inputmode="numeric" data-f="hp" value="${m.hp}" ${stuck ? "disabled" : ""} aria-label="${esc(m.name)} HP">%</label>` + select2(`data-f="status" aria-label="${esc(m.name)} status" ${m.fainted ? "disabled" : ""}`, ["", ...options.statuses].map((s) => [s, STATUS_NAMES[s]]), m.status, "rb-edst st-" + (m.status || "none")) + `</div>`;
  const extra = m.active ? `<div class="rb-edboosts">${options.boosts.map((b) => `<label><span>${STAT[b]}</span>` + select2(`data-boost="${b}" aria-label="${esc(m.name)} ${STAT[b]}"`, levels, m.boosts[b] || 0, (m.boosts[b] || 0) > 0 ? "up" : (m.boosts[b] || 0) < 0 ? "down" : "") + `</label>`).join("")}</div>` + (options.items ? `<label class="rb-editem"><span>Item</span><input class="textbox" data-f="item" list="${heldItems(state.gen)}" value="${esc(m.itemName)}" autocomplete="off" aria-label="${esc(m.name)} item"></label>` : "") : "";
  return `<div class="rb-edmon ${m.active ? "on" : ""} ${m.fainted ? "fnt" : ""}" data-s="${si}" data-k="${m.k}">${head}${extra}</div>`;
}
function sideHTML(si) {
  const side = at.state.sides[si];
  const conds = at.options.side.map(([id, name, max]) => max > 1 ? `<label class="rb-edcond">${esc(name)} ${select2(`data-cond="${id}"`, Array.from({ length: max + 1 }, (_, n) => [n, n ? "\xD7" + n : "\u2014"]), side.conds[id])}</label>` : `<label class="rb-edcond"><input type="checkbox" data-cond="${id}" ${side.conds[id] ? "checked" : ""}> ${esc(name)}</label>`).join("");
  return `<div class="rb-edside" data-side="${si}"><h3>${esc(playerName(si))}</h3><div class="rb-edmons">${side.mons.map((m) => monHTML(si, m)).join("")}</div>` + (conds ? `<div class="rb-edconds">${conds}</div>` : "") + `</div>`;
}
function render() {
  const el = $id("editor");
  const { state, options } = at;
  const f = state.field;
  const weathers = [["", "None"], ...options.weathers, ...f.weather && !options.weathers.some((w) => w[0] === f.weather) ? [[f.weather, E.weatherName(f.weather)]] : []];
  const field = [
    options.weathers.length ? `<label>Weather ${select2('data-field="weather"', weathers, f.weather)}</label>` : "",
    options.terrains.length ? `<label>Terrain ${select2('data-field="terrain"', [["", "None"], ...options.terrains], f.terrain)}</label>` : "",
    options.trickRoom ? `<label><input type="checkbox" data-field="trickroom" ${f.trickroom ? "checked" : ""}> Trick Room</label>` : ""
  ].join("");
  el.innerHTML = `<section class="rb-section rb-editor" role="dialog" aria-labelledby="editTitle">
    <h2 id="editTitle"><span>Edit position <small class="rb-dturn">Turn ${state.turn}</small></span><button type="button" class="rb-linkbtn" id="btnEditClose" aria-label="Close">&times;</button></h2>
    ${field ? `<div class="rb-edfield">${field}</div>` : ""}
    <div class="rb-edsides">${sideHTML(0)}${sideHTML(1)}</div>
    <p class="rb-row rb-edfoot"><span class="rb-err" id="editErr"></span>
      <button type="button" class="button" id="btnEditCancel">Cancel</button><button type="button" class="button" id="btnEditApply"><strong>Apply</strong></button></p>
  </section>`;
  el.hidden = false;
  for (const input of el.querySelectorAll("[data-f=hp]")) input.oninput = () => {
    const v = Math.max(0, Math.min(100, Math.round(+input.value) || 0));
    const bar = input.closest(".rb-edhd").querySelector(".rb-hpbar span");
    bar.style.width = v + "%";
    bar.className = "hp-" + hpColor(v);
  };
  for (const s of el.querySelectorAll("[data-f=status]")) s.onchange = () => {
    s.className = s.className.replace(/st-\w+/, "st-" + (s.value || "none"));
  };
  for (const s of el.querySelectorAll("[data-boost]")) s.onchange = () => {
    s.classList.toggle("up", +s.value > 0);
    s.classList.toggle("down", +s.value < 0);
  };
  $id("btnEditClose").onclick = $id("btnEditCancel").onclick = close;
  $id("btnEditApply").onclick = apply2;
  el.onclick = (e) => {
    if (e.target === el) close();
  };
  el.onkeydown = (e) => {
    if (e.key === "Escape") close();
  };
  el.querySelector("select, input").focus();
}
function collect() {
  const el = $id("editor"), { state } = at;
  const edit = { mons: [], field: {}, sides: [{}, {}] };
  for (const row of el.querySelectorAll(".rb-edmon")) {
    const s = +row.dataset.s, k = +row.dataset.k, m = state.sides[s].mons.find((x) => x.k === k);
    const c = { s, k };
    const hpBox = row.querySelector("[data-f=hp]");
    if (!hpBox.disabled) {
      const raw = hpBox.value.trim(), hp = Math.round(+raw);
      if (!/^\d+(\.\d*)?$/.test(raw) || hp > 100) return { error: `${m.name}: HP is 0 to 100%.` };
      if (hp !== m.hp) c.hp = hp;
    }
    const st = row.querySelector("[data-f=status]");
    if (!st.disabled && st.value !== m.status && c.hp !== 0) c.status = st.value;
    for (const b of row.querySelectorAll("[data-boost]")) {
      if (+b.value !== (m.boosts[b.dataset.boost] || 0)) (c.boosts || (c.boosts = {}))[b.dataset.boost] = +b.value;
    }
    const itemBox = row.querySelector("[data-f=item]");
    if (itemBox) {
      const name = itemBox.value.trim(), item = name ? E.Dex.items.get(name) : null;
      if (item && !item.exists) return { error: `"${name}" is not an item.` };
      const id = item ? item.id : "";
      if (id !== m.item) c.item = id;
    }
    if (Object.keys(c).length > 2) edit.mons.push(c);
  }
  for (const box of el.querySelectorAll("[data-field]")) {
    const id = box.dataset.field, v = box.type === "checkbox" ? +box.checked : box.value;
    if (v !== state.field[id]) edit.field[id] = v;
  }
  for (const box of el.querySelectorAll("[data-cond]")) {
    const si = +box.closest("[data-side]").dataset.side, id = box.dataset.cond, v = box.type === "checkbox" ? +box.checked : +box.value;
    if (v !== state.sides[si].conds[id]) edit.sides[si][id] = v;
  }
  return { edit: cleanEdit(edit) };
}
function apply2() {
  const { edit, error } = collect();
  if (error) {
    $id("editErr").textContent = error;
    return;
  }
  if (!edit) {
    close();
    return;
  }
  const { parent, sets } = at;
  let id = kids(parent).find((k) => JSON.stringify(S.study.nodes[k].edit) === JSON.stringify(edit));
  if (!id) {
    id = addEdit(parent, edit, sets);
    try {
      compute(id);
    } catch (e) {
      deleteNode(id);
      save();
      $id("editErr").textContent = e.message || String(e);
      return;
    }
  }
  close();
  go(id, { animate: true });
}

// source/app/picker.js
var pickerOn = () => stored("rb-picker", "on") !== "off";
function setPicker(on) {
  store("rb-picker", on ? "on" : "off");
  clearPicks();
  renderPanels();
}
var typeTag2 = (t) => t ? `<span class="rb-type t-${esc(t)}">${esc(t)}</span>` : "";
var icon3 = (species) => {
  try {
    return Dex.getPokemonIcon(species);
  } catch {
    return "";
  }
};
var GIMMICK_NAMES = { terastallize: "Tera", mega: "Mega", megax: "Mega X", megay: "Mega Y", ultra: "Ultra Burst", zmove: "Z", dynamax: "Dynamax" };
var family2 = (g) => g && g.startsWith("mega") ? "mega" : g || "";
var keyOf = (si, place) => pid(si) + "abc"[place];
var requestOf = (pos, si) => {
  const req = pos.battle?.sides[si].activeRequest;
  return req && !req.wait ? req : null;
};
var doublesBattle = (pos) => pos.battle?.gameType === "doubles";
function placesOf(pos, si, req) {
  if (req.teamPreview) return doublesBattle(pos) ? [0, 1] : [0];
  const side = pos.battle.sides[si];
  if (req.forceSwitch) return req.forceSwitch.map((f, place) => f ? place : -1).filter((p) => p >= 0);
  return side.active.map((p, place) => p && !p.fainted && !p.volatiles.commanding ? place : -1).filter((p) => p >= 0);
}
var benchFree = (req, taken) => req.side.pokemon.map((p, n) => n).filter((n) => !req.side.pokemon[n].active && !/fnt/.test(req.side.pokemon[n].condition) && !taken.includes(n + 1));
var switchedIn = (pick) => pick && /^switch \d+$/.test(pick) ? +pick.split(" ")[1] : 0;
function playedPick(pos, si, place, req) {
  if (pos.kind === "line" || isFresh()) return null;
  const played = playedChoice(pos.t, si, place);
  if (!played) return null;
  const nth = (name) => req.side.pokemon.findIndex((p) => nameOf(p.ident) === name) + 1;
  if (played.kind === "lead") return nth(played.name) ? { pick: "team " + nth(played.name), gimmick: "" } : null;
  if (played.kind === "switch") return nth(played.name) ? { pick: "switch " + nth(played.name), gimmick: "" } : null;
  const act = req.active?.[place];
  if (!act) return null;
  const i = played.kind === "cant" ? act.moves.findIndex((m) => !m.disabled) : act.moves.findIndex((_, i2) => moveNames(act, i2 + 1).includes(E.toID(played.name)));
  if (i < 0) return null;
  let gimmick = played.gimmick;
  if (gimmick === "mega") gimmick = act.canMegaEvo ? "mega" : act.canMegaEvoX ? "megax" : act.canMegaEvoY ? "megay" : "mega";
  return { pick: withTarget(pos, si, place, act, i, gimmick || "", played.target), gimmick: gimmick || "" };
}
function withTarget(pos, si, place, act, i, gimmick, ident) {
  if (!doublesBattle(pos)) return "move " + (i + 1);
  const type = E.targetType(act, i, gimmick);
  if (!E.needsTarget(type)) return "move " + (i + 1);
  const loc = E.targetLoc(type, ident, si, place) ?? E.targetsFor(type, pos.battle, si, place)[0];
  return `move ${i + 1} ${loc}`;
}
function slot(pos, si, place, req) {
  const key = keyOf(si, place);
  if (req.forceSwitch && !S.sel[key]) {
    const others = placesOf(pos, si, req).filter((p) => p !== place).map((p) => switchedIn(S.sel[keyOf(si, p)]));
    if (!benchFree(req, others).length) return { pick: "pass", gimmick: "", changed: false, def: { pick: "pass", gimmick: "" }, fixed: true };
  }
  const def = playedPick(pos, si, place, req);
  const pick = S.sel[key] || def?.pick || null;
  const gimmick = S.gimmick[key] ?? def?.gimmick ?? "";
  const changed2 = !!def && (pick !== def.pick || gimmick !== def.gimmick) || !def && !!pick;
  return { pick, gimmick, changed: changed2, def };
}
function pickLabel(pos, si, place, req, pick, gimmick) {
  const [kind, n, target] = pick.split(" ");
  if (kind === "pass") return { html: "&mdash;", type: "" };
  if (kind === "move") {
    const act = req.active[place], m = act.moves[n - 1];
    const as = gimmick === "zmove" ? act.canZMove?.[n - 1] : gimmick === "dynamax" || act.maxMoves && !act.canDynamax ? act.maxMoves?.maxMoves?.[n - 1] : null;
    const shown = as && E.Dex.moves.get(as.move);
    const name = !as ? m.move : shown.exists ? shown.name : as.move;
    const type = (shown?.exists ? shown : E.Dex.moves.get(m.id || m.move)).type || "Normal";
    const extra = gimmick && !["zmove", "dynamax"].includes(gimmick) ? ` <small>+ ${GIMMICK_NAMES[gimmick]}</small>` : "";
    const aim = target ? ` <small>&rarr; ${esc(targetName(pos, si, +target))}</small>` : "";
    return { html: esc(name) + extra + aim, type };
  }
  const p = req.side.pokemon[n - 1];
  return { html: `<span class="rb-picon" style="${icon3(p.details.split(",")[0])}"></span>${kind === "switch" ? "&rarr; " : ""}${esc(nameOf(p.ident))}`, type: "" };
}
function targetName(pos, si, loc) {
  const side = pos.battle.sides[loc > 0 ? 1 - si : si], p = side.active[Math.abs(loc) - 1];
  return p ? p.name : "?";
}
var turnLabelOf = (pos) => pos.kind === "preview" ? "Team preview" : pos.battle ? `Turn ${pos.battle.turn}` : pos.t > S.rep.lastTurn ? "End" : pos.t ? `Turn ${pos.t}` : "Start";
function renderPicker(pos) {
  const el = $id("pickSec");
  showPickerSetting();
  el.hidden = !pickerOn();
  if (el.hidden) {
    setTooltipRequest(null);
    return;
  }
  const battle = pos.battle;
  const turnLabel = turnLabelOf(pos);
  const doubles = doublesBattle(pos) || !battle && S.rep.lines.includes("|gametype|doubles");
  let groups2, playable = false;
  if (!battle || battle.ended) {
    const why = battle?.ended ? "The battle is over" : watchOnly() ? "This format can only be watched" : pos.t > S.rep.lastTurn ? "End of the replay" : "";
    const playing = isPlaying();
    groups2 = why ? [`<span class="rb-dim">${why}</span>`] : [0, 1].map((si) => `<div class="rb-slotwrap"><span class="rb-who">${esc(playerName(si))}</span>` + (doubles ? [0, 1] : [0]).map((place) => `<button type="button" class="rb-slot quiet" ${playing ? `data-slot="${si}" data-place="${place}"` : "disabled"}>&hellip;</button>`).join("") + `</div>`);
  } else {
    const need = [0, 1].map((si) => requestOf(pos, si));
    const turn = barTurn(pos);
    playable = !!turn;
    groups2 = [0, 1].map((si) => {
      const req = need[si];
      const head = `<div class="rb-slotwrap"><span class="rb-who">${esc(playerName(si))}</span>`;
      if (!req) return head + `<button type="button" class="rb-slot quiet" disabled>waiting</button></div>`;
      return head + placesOf(pos, si, req).map((place) => {
        const s = slot(pos, si, place, req), key = keyOf(si, place);
        const label2 = s.pick ? pickLabel(pos, si, place, req, s.pick, s.gimmick) : { html: "Choose", type: "" };
        const who = doubles && !req.teamPreview ? `<span class="rb-place">${esc(nameOf(req.side.pokemon[place].ident))}</span>` : "";
        return `<button type="button" class="rb-slot ${label2.type ? "t-" + esc(label2.type) : "plain"} ${s.changed ? "changed" : ""} ${s.pick ? "" : "empty"} ${S.menu === key ? "open" : ""}" data-slot="${si}" data-place="${place}" aria-haspopup="true" aria-expanded="${S.menu === key}" ${s.fixed ? "disabled" : ""}>${who}${label2.html} <i class="fa fa-caret-down" aria-hidden="true"></i></button>`;
      }).join("") + `</div>`;
    });
  }
  const keep = focusKey(el);
  el.innerHTML = `<div class="rb-bar ${doubles ? "doubles" : ""}"><span class="rb-turn">${turnLabel}</span><div class="rb-slots">${groups2.join("")}</div><button type="button" class="button rb-editbtn" id="btnEdit" ${canEdit(pos) ? "" : "disabled"}><i class="fa fa-pencil" aria-hidden="true"></i> Edit</button><button type="button" class="button rb-play" id="btnPlayTurn" ${playable ? "" : "disabled"}><i class="fa fa-play" aria-hidden="true"></i> Play turn</button></div>` + (S.err ? `<p class="rb-err">${esc(S.err)}</p>` : "") + menuHTML(pos);
  restoreFocus(el, keep);
  for (const b of el.querySelectorAll("[data-slot]")) b.onclick = (e) => {
    e.stopPropagation();
    openMenu(pos, +b.dataset.slot, +(b.dataset.place || 0));
  };
  $id("btnPlayTurn").onclick = () => {
    if (playable) playTurn(pos);
  };
  $id("btnEdit").onclick = () => {
    closeMenu();
    openEditor(pos);
  };
  wireMenu(pos);
}
function focusKey(el) {
  const a = document.activeElement;
  if (!a || !el.contains(a)) return null;
  const attr = ["data-pick", "data-target", "data-gimmick"].find((n) => a.hasAttribute(n));
  return a.id ? "#" + a.id : a.dataset.slot !== void 0 ? `[data-slot="${a.dataset.slot}"][data-place="${a.dataset.place || 0}"]` : attr ? `.rb-menu [${attr}="${a.getAttribute(attr)}"]` : "";
}
function restoreFocus(el, keep) {
  if (keep === null) return;
  const menu = el.querySelector(".rb-menu"), same2 = keep && el.querySelector(keep);
  const to = menu ? same2 && menu.contains(same2) ? same2 : menu.querySelector("[data-pick]:not(:disabled), [data-target]:not(:disabled)") : same2 && !same2.closest(".rb-menu") ? same2 : null;
  to?.focus();
}
function openMenu(pos, si, place) {
  const key = keyOf(si, place);
  S.aim = null;
  if (isPlaying()) {
    S.psb.pause();
    S.menu = key;
    go(S.cur, { force: true });
    return;
  }
  S.menu = S.menu === key ? null : key;
  renderPicker(pos);
}
function closeMenu() {
  if (S.menu == null) return false;
  S.menu = null;
  S.aim = null;
  setTooltipRequest(null);
  return true;
}
var menuSlot = () => S.menu ? { si: +S.menu[1] - 1, place: "abc".indexOf(S.menu[2]) } : null;
function menuHTML(pos) {
  const at2 = menuSlot();
  const req = at2 && pos.battle && !pos.battle.ended ? requestOf(pos, at2.si) : null;
  if (!req || !placesOf(pos, at2.si, req).includes(at2.place)) {
    setTooltipRequest(null);
    return "";
  }
  const { si, place } = at2;
  setTooltipRequest(si, req, place);
  const s = slot(pos, si, place, req);
  const forced = !!req.forceSwitch;
  const active = nameOf((req.side.pokemon[place] || { ident: "" }).ident);
  const who = esc(playerName(si));
  const reviving = req.side.pokemon.some((p) => p.reviving);
  const question = req.teamPreview ? `${who}: choose ${doublesBattle(pos) ? place ? "the second lead" : "the first lead" : "a lead"}` : reviving ? `${who}: choose a Pok&eacute;mon to revive` : S.aim ? `${who}: choose a target for ${esc(req.active[place].moves[S.aim.n - 1].move)}` : forced ? `${who}: switch in a Pok&eacute;mon` : `${who}: what will ${esc(active)} do?`;
  const trapped = !forced && !req.teamPreview && !!(req.active?.[place]?.trapped || pos.battle.sides[si].active[place]?.trapped);
  const taken = placesOf(pos, si, req).filter((p) => p !== place).map((p) => slot(pos, si, p, req).pick);
  const body = req.teamPreview ? leadButtons(req, s, taken) : S.aim ? targetButtons(pos, si, place, req) : (forced ? "" : moveButtons(pos, si, place, req, active, s, taken)) + switchButtons(req, forced, s, trapped, taken);
  return `<div class="rb-menu" role="dialog" aria-label="${who}'s choice"><h3><span>${question}</span><button type="button" class="rb-linkbtn" id="btnCloseMenu" aria-label="Close">&times;</button></h3>${body}</div>`;
}
function wireMenu(pos) {
  const menu = $id("pickSec").querySelector(".rb-menu");
  if (!menu) return;
  const { si, place } = menuSlot(), key = S.menu;
  menu.onclick = (e) => e.stopPropagation();
  const done = () => {
    closeMenu();
    renderPicker(pos);
    renderDice(pos);
  };
  $id("btnCloseMenu").onclick = () => {
    closeMenu();
    renderPicker(pos);
  };
  for (const b of menu.querySelectorAll("[data-pick]")) b.onclick = () => {
    const pick = b.dataset.pick, [kind, n] = pick.split(" ");
    S.err = "";
    if (kind === "move" && doublesBattle(pos)) {
      const act = requestOf(pos, si).active[place];
      const type = E.targetType(act, n - 1, S.gimmick[key] ?? slot(pos, si, place, requestOf(pos, si)).gimmick);
      const targets = E.targetsFor(type, pos.battle, si, place);
      if (E.needsTarget(type) && targets.length > 1) {
        S.aim = { n: +n };
        renderPicker(pos);
        return;
      }
      S.sel[key] = E.needsTarget(type) ? `${pick} ${targets[0]}` : pick;
    } else S.sel[key] = pick;
    done();
  };
  for (const b of menu.querySelectorAll("[data-target]")) b.onclick = () => {
    S.sel[key] = `move ${S.aim.n} ${b.dataset.target}`;
    done();
  };
  const back = $id("btnAimBack");
  if (back) back.onclick = () => {
    S.aim = null;
    renderPicker(pos);
  };
  for (const box of menu.querySelectorAll("[data-gimmick]")) box.onchange = () => {
    S.gimmick[key] = box.checked ? box.dataset.gimmick : "";
    const sel = S.sel[key] || slot(pos, si, place, requestOf(pos, si)).pick;
    if (sel && sel.startsWith("move") && doublesBattle(pos)) {
      const act = requestOf(pos, si).active[place], n = +sel.split(" ")[1];
      S.sel[key] = withTarget(pos, si, place, act, n - 1, S.gimmick[key], null);
    }
    renderPicker(pos);
    renderDice(pos);
  };
  for (const b of menu.querySelectorAll("[data-edit]")) b.onclick = () => editGuessedMove(pos, si, place, b);
}
var pickedHere = (s, pick) => s.pick === pick || (s.pick || "").startsWith(pick + " ") ? "chosen" : "";
var playedHere = (s, pick) => s.def?.pick === pick || (s.def?.pick || "").startsWith(pick + " ") ? "played" : "";
function leadButtons(req, s, taken) {
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    const pick = "team " + (n + 1), was = playedHere(s, pick);
    return `<button type="button" class="button rb-sw has-tooltip ${was} ${pickedHere(s, pick)}" data-pick="${pick}" data-tooltip="switchpokemon|${n}" ${was ? 'data-note="Lead in the replay"' : ""} ${taken.includes(pick) ? "disabled" : ""}><span class="rb-picon" style="${icon3(p.details.split(",")[0])}"></span>${esc(nameOf(p.ident))}</button>`;
  }).join("")}</div>`;
}
function gimmicks(act, othersUse) {
  return [
    act.canMegaEvo && ["mega", "Mega Evolution"],
    act.canMegaEvoX && ["megax", "Mega Evolution X"],
    act.canMegaEvoY && ["megay", "Mega Evolution Y"],
    act.canUltraBurst && ["ultra", "Ultra Burst"],
    act.canZMove && ["zmove", "Z-Power"],
    act.canDynamax && ["dynamax", "Dynamax"],
    act.canTerastallize && ["terastallize", "Terastallize"]
  ].filter((g) => g && !othersUse.includes(family2(g[0])));
}
function moveButtons(pos, si, place, req, active, s, taken) {
  const act = req.active[place];
  const mode = s.gimmick === "zmove" ? "zmove" : s.gimmick === "dynamax" || act.maxMoves && !act.canDynamax ? "maxmove" : "";
  const k = teamIndex(si, active);
  const known = k >= 0 ? S.base[si][k].fixed.moves.map(E.toID) : [];
  const pasted = k >= 0 && (pos.kind === "line" ? lineSets(S.cur) : S.study.sets)[si][k].pasted;
  const foes = pos.battle.sides[1 - si].active.map((p, f) => p && !p.fainted ? f : -1).filter((f) => f >= 0);
  const calcs = mode ? [] : doublesBattle(pos) ? foes.map((f) => E.damageCalcs(pos.battle, si, place, f)) : [E.damageCalcs(pos.battle, si)];
  const transformed = pos.battle.sides[si].active[place]?.transformed;
  const moves = act.moves.map((m, i) => {
    const pick = "move " + (i + 1);
    const as = mode === "zmove" ? act.canZMove[i] : mode === "maxmove" ? act.maxMoves.maxMoves[i] : null;
    const shown = as && E.Dex.moves.get(as.move);
    const name = !as ? m.move : shown.exists ? shown.name : as.move;
    const type = (shown?.exists ? shown : E.Dex.moves.get(m.id || m.move)).type || "Normal";
    const was = playedHere(s, pick);
    const guessed = k >= 0 && !pasted && !transformed && !known.includes(E.toID(m.move)) && !["struggle", "recharge"].includes(E.toID(m.move));
    const note = guessed ? "Guessed" : was ? "Used in the replay" : "";
    const disabled = m.disabled || m.pp === 0 || mode === "zmove" && !as;
    const ranges = calcs.map((c, j) => c[i] && { ...c[i], foe: doublesBattle(pos) ? pos.battle.sides[1 - si].active[foes[j]] : null }).filter(Boolean);
    const desc = ranges.map((c) => c.desc).filter(Boolean).join("\n");
    return `<div class="rb-mvwrap"><button type="button" class="rb-mv has-tooltip t-${esc(type)} ${was} ${pickedHere(s, pick)} ${guessed ? "guess" : ""}" data-pick="${pick}" data-tooltip="move|${i}|${mode}" ${note ? `data-note="${note}"` : ""} ${desc ? `data-calc="${esc(desc)}"` : ""} ${disabled ? "disabled" : ""}><b>${esc(name)}</b><small><span>${esc(type)}</span>${ranges.map((c) => `<span class="rb-dmg">${c.foe ? `<span class="rb-picon mini" style="${icon3(c.foe.species.name)}"></span>` : ""}${esc(c.range)}</span>`).join("")}<span>${m.maxpp ? `${m.pp}/${m.maxpp}` : ""}</span></small></button>` + (guessed ? `<button type="button" class="rb-edit" data-edit="${esc(m.move)}" title="Change this guessed move" aria-label="Change ${esc(m.move)}"><i class="fa fa-pencil" aria-hidden="true"></i></button>` : "") + `</div>`;
  });
  const othersUse = placesOf(pos, si, req).filter((p) => p !== place).map((p) => family2(S.gimmick[keyOf(si, p)] ?? slot(pos, si, p, req).gimmick)).filter(Boolean);
  const boxes = gimmicks(act, othersUse).map(([value, label2]) => `<label><input type="checkbox" data-gimmick="${value}" ${s.gimmick === value ? "checked" : ""}> ${label2}</label>` + (value === "terastallize" ? " " + typeTag2(act.canTerastallize) : "")).join(" ");
  return `<div class="rb-moves">${moves.join("")}</div>${boxes ? `<p class="rb-row" style="margin-top:6px">${boxes}</p>` : ""}`;
}
function targetButtons(pos, si, place, req) {
  const act = req.active[place], n = S.aim.n;
  const type = E.targetType(act, n - 1, S.gimmick[keyOf(si, place)] ?? "");
  const ok = E.targetsFor(type, pos.battle, si, place);
  const button = (loc) => {
    const side = pos.battle.sides[loc > 0 ? 1 - si : si], p = side.active[Math.abs(loc) - 1];
    if (!p) return "";
    return `<button type="button" class="button rb-sw" data-target="${loc}" ${ok.includes(loc) ? "" : "disabled"}><span class="rb-picon" style="${icon3(p.species.name)}"></span>${esc(p.name)} <small>${p.fainted ? 0 : Math.round(p.hp / p.maxhp * 100)}%</small></button>`;
  };
  return `<div class="rb-switches">${button(2)}${button(1)}</div><div class="rb-switches">${button(-1)}${button(-2)}</div><p class="rb-row" style="margin-top:6px"><button type="button" class="rb-linkbtn" id="btnAimBack">&larr; Back</button></p>`;
}
function switchButtons(req, forced, s, trapped, taken) {
  const reviving = req.side.pokemon.some((p) => p.reviving);
  return `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    if (p.active && !forced) return "";
    const pick = "switch " + (n + 1), was = playedHere(s, pick);
    const fainted = /fnt/.test(p.condition);
    const unavailable = reviving ? !fainted : fainted || p.active || trapped || taken.includes(pick);
    const [hp, max] = p.condition.split(" ")[0].split("/");
    return `<button type="button" class="button rb-sw has-tooltip ${was} ${pickedHere(s, pick)}" data-pick="${pick}" data-tooltip="switchpokemon|${n}" ${was ? 'data-note="Used in the replay"' : ""} ${unavailable ? "disabled" : ""}><span class="rb-picon" style="${icon3(p.details.split(",")[0])}"></span>${esc(nameOf(p.ident))} <small>${fainted ? 0 : Math.round(hp / max * 100)}%</small></button>`;
  }).join("")}</div>`;
}
function editGuessedMove(pos, si, place, button) {
  const req = requestOf(pos, si);
  const active = nameOf((req.side.pokemon[place] || { ident: "" }).ident);
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
  const menu = S.menu;
  save();
  S.err = "";
  clearPicks();
  S.menu = menu;
  if (pos.kind === "line") showPosition(false);
  renderPanels();
}
function sideChoice(pos, si, req, picks) {
  if (req.teamPreview) {
    const leads = picks.map((p) => +p.pick.split(" ")[1]);
    if (!doublesBattle(pos)) return picks[0].pick;
    const team = S.cbEnd[pid(si)].team, all = req.side.pokemon.map((_, n) => n + 1).filter((n) => !leads.includes(n));
    const seen = (n) => {
      const k = teamIndex(si, nameOf(req.side.pokemon[n - 1].ident));
      return k >= 0 && team[k].maxhp > 0;
    };
    return "team " + leads.concat(all.filter(seen), all.filter((n) => !seen(n))).join(all.length + leads.length >= 10 ? "," : "");
  }
  return picks.map((p) => p.pick.startsWith("move") && p.gimmick ? p.pick + " " + p.gimmick : p.pick).join(", ");
}
function barTurn(pos) {
  const battle = pos.battle;
  if (!battle || battle.ended || watchOnly()) return null;
  const need = [0, 1].map((si) => requestOf(pos, si));
  if (!need.some(Boolean)) return null;
  const choices = {}, onReplay = pos.kind === "turn" || pos.kind === "preview";
  let replay2 = onReplay;
  for (const [si, req] of need.entries()) {
    if (!req) continue;
    const places = placesOf(pos, si, req);
    const picks = places.map((place) => slot(pos, si, place, req));
    if (picks.some((s) => !s.pick)) return null;
    if (picks.length) choices[pid(si)] = sideChoice(pos, si, req, picks);
    replay2 && (replay2 = picks.every((s) => s.fixed || !s.changed && matchesPlayed(battle.sides[si], s.pick, s.gimmick, playedChoice(pos.t, si, places[picks.indexOf(s)]), places[picks.indexOf(s)], s.def)));
  }
  return { choices, replay: replay2, parent: onReplay ? "r" + pos.t : S.cur, sets: onReplay ? S.study.sets : void 0 };
}
function playTurn(pos) {
  const turn = barTurn(pos);
  if (!turn) return;
  const reset = () => {
    clearPicks();
    S.err = "";
  };
  const dice = upcomingDice(pos);
  if (turn.replay && (!dice || JSON.stringify(dice.forced) === JSON.stringify(dice.real))) {
    reset();
    S.stopAt = pos.t + 1;
    if (pos.t === 0) S.psb.reset();
    else S.psb.seekTurn(pos.t);
    S.psb.play();
    renderPanels();
    return;
  }
  const { choices, parent, sets } = turn;
  const forced = dice ? dice.forced : [], seed = dice?.seed;
  let id = sameStep(parent, choices, forced, seed);
  if (!id) {
    id = addNode(parent, choices, forced, seed, sets);
    try {
      compute(id);
    } catch (e) {
      deleteNode(id);
      save();
      S.err = e.message || String(e);
      renderPicker(pos);
      return;
    }
  }
  reset();
  go(id, { animate: true });
}

// source/app/panels.js
function renderStudyPanel() {
  const el = $id("studySec");
  const any = noteList().length > 0;
  el.innerHTML = `<div class="rb-tabs"><button class="button ${S.tab === "study" ? "cur" : ""}" data-tab="study">Study</button><button class="button ${S.tab === "teams" ? "cur" : ""}" data-tab="teams">Teams</button>` + (S.tab === "study" && any ? `<button class="button rb-copynotes" id="btnCopyNotes">Copy notes</button>` : "") + `</div><div id="tabBody"></div>`;
  for (const b of el.querySelectorAll("[data-tab]")) b.onclick = () => {
    S.tab = b.dataset.tab;
    renderStudyPanel();
  };
  const copy = $id("btnCopyNotes");
  if (copy) copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(notesText());
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => {
      copy.textContent = "Copy notes";
    }, 1500);
  };
  if (S.tab === "study") renderStudy();
  else renderTeams($id("tabBody"));
}
function renderNote(pos) {
  const el = $id("noteSec");
  el.hidden = !S.rep;
  if (el.hidden) return;
  if (document.activeElement?.id === "comment" && el.dataset.at === S.cur) return;
  el.dataset.at = S.cur;
  const note = noteOf(S.cur);
  el.innerHTML = `<div class="rb-notehd"><span class="rb-noteturn">${esc(turnLabelOf(pos))}</span><span class="rb-glyphs">` + GLYPHS.map((g) => `<button class="button ${note.glyph === g ? "on" : ""}" data-glyph="${g}" aria-pressed="${note.glyph === g}">${g}</button>`).join("") + `</span></div><textarea id="comment" class="textbox" rows="2" placeholder="Note" aria-label="Note on ${esc(turnLabelOf(pos))}">${esc(note.comment || "")}</textarea>`;
  for (const b of el.querySelectorAll("[data-glyph]")) b.onclick = () => {
    const n = noteOf(S.cur, true);
    n.glyph = n.glyph === b.dataset.glyph ? "" : b.dataset.glyph;
    save();
    renderNote(pos);
    renderStudyPanel();
  };
  $id("comment").oninput = (e) => {
    noteOf(S.cur, true).comment = e.target.value;
    save();
  };
  $id("comment").onchange = () => renderStudyPanel();
}
function noteList() {
  const out = [];
  if (!S.study) return out;
  for (const [id, n] of Object.entries(S.study.notes)) if (n?.comment || n?.glyph) out.push({ id, turn: replayTurn(id), line: "", ...n });
  for (const [id, n] of Object.entries(S.study.nodes)) {
    if (!n.comment && !n.glyph) continue;
    let turn = 0, line = "";
    try {
      const c = compute(id);
      turn = c.battle.turn;
      if (n.edit) line = "edited position";
      else {
        const s = E.summarize(c.lines);
        line = `${s.p1 || "\u2026"} | ${s.p2 || "\u2026"}`;
      }
    } catch {
      continue;
    }
    out.push({ id, turn, line, comment: n.comment, glyph: n.glyph });
  }
  return out.sort((a, b) => a.turn - b.turn || (a.line ? 1 : 0) - (b.line ? 1 : 0));
}
function notesText() {
  const title = S.study.name || (S.study.meta?.players || []).join(" vs. ");
  const link = S.replayId && !/pw$/.test(S.replayId) ? `https://replay.pokemonshowdown.com/${S.replayId}` : "";
  const at2 = (t) => t <= 0 ? "Team preview" : t > S.rep.lastTurn ? "End" : `Turn ${t}`;
  return [title + (link ? ` - ${link}` : ""), ...noteList().map((n) => `${at2(n.turn)}${n.line ? `, line ${n.line}` : ""}${n.glyph ? " " + n.glyph : ""}${n.comment ? ": " + n.comment : ""}`)].filter(Boolean).join("\n") + "\n";
}
function lineToken(id) {
  let line;
  try {
    line = compute(id);
  } catch {
    return `<span class="rb-tok rb-err" data-go="${esc(id)}">(error)</span>`;
  }
  const n = S.study.nodes[id];
  const turn = isReplayPos(n.parent) ? replayTurn(n.parent) : compute(n.parent).battle.turn;
  let what;
  if (n.edit) {
    const s = E.editSummary(isReplayPos(n.parent) ? replayTurnPos(turn, n.sets).battle : compute(n.parent).battle, n.edit);
    const cut = (list) => {
      const t = list.join(", ");
      return t.length > 60 ? t.slice(0, 59) + "\u2026" : t;
    };
    const left = cut([...s.field, ...s.p1]), right = cut(s.p2);
    what = `<span class="rb-pencil" aria-label="Edited">\u270E</span> ${esc(right ? left || "\u2014" : left)}${right ? ` <span class="tn">|</span> ${esc(right)}` : ""}`;
  } else {
    const s = E.summarize(line.lines);
    what = `${esc(s.p1 || "\u2026")} <span class="tn">|</span> ${esc(s.p2 || "\u2026")}`;
  }
  return `<span class="rb-tok ${n.edit ? "rb-edited" : ""} ${id === S.cur ? "cur" : ""}" data-go="${esc(id)}"><span class="tn">${turn}.</span>${what}` + (n.forced.length ? ' <i class="fa fa-cube" title="Dice set by you" aria-hidden="true"></i>' : "") + (n.glyph ? `<span class="rb-glyph">${esc(n.glyph)}</span>` : "") + (n.comment ? ` <i class="rb-cmt">${esc(n.comment)}</i>` : "") + `</span>`;
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
  const row = (id, no, cells, extra = "") => `<div class="rb-mrow ${extra} ${S.cur === id ? "cur" : ""}" data-go="${esc(id)}"><div class="no">${no}</div>${cells}</div>`;
  const cmt = (id) => {
    const n = S.study.notes[id];
    return n?.comment || n?.glyph ? `<div class="rb-vars rb-plain" data-go="${esc(id)}">${n.glyph ? `<span class="rb-glyph">${esc(n.glyph)}</span> ` : ""}<span class="rb-cmt">${esc(n.comment || "")}</span></div>` : "";
  };
  const rows = [
    row("r0", "", `<div class="a">Team preview</div>`, "start"),
    cmt("r0"),
    linesFrom("r0"),
    // (a new battle stopped at team preview has no leads yet)
    ...leads.p1 || leads.p2 ? [row("r1", 0, ["p1", "p2"].map((p) => `<div class="a">\u2192 ${esc([leads[p + "a"], leads[p + "b"]].filter(Boolean).join(", ") || "?")}</div>`).join("")), cmt("r1"), linesFrom("r1")] : []
  ];
  for (let t = 1; t <= S.rep.lastTurn; t++) {
    const id = "r" + (t + 1);
    const s = turnSummary(t);
    rows.push(row(id, t, `<div class="a">${esc(s.p1 || "\u2014")}</div><div class="a">${esc(s.p2 || "\u2014")}</div>`), cmt(id), linesFrom(id));
  }
  const inLine = !isReplayPos(S.cur);
  const isFirst = inLine && kids(S.study.nodes[S.cur].parent)[0] === S.cur;
  body.innerHTML = `<div class="rb-movelist">${rows.join("")}</div>` + (inLine ? `<p class="rb-row rb-lineacts"><button class="button" id="btnPromote" ${isFirst ? "disabled" : ""}>Make this the first line</button>
        <button class="button" id="btnDelete">${S.deleteArmed === S.cur ? "Click again to delete" : "Delete from here"}</button></p>` : "");
  for (const el of body.querySelectorAll("[data-go]")) el.onclick = () => go(el.dataset.go);
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
  const canPick = pickerOn() && !watchOnly() && !isPlaying();
  if (canPick && t === 0 && S.psb && !S.psb.started) {
    const pv = previewPos(S.study.sets);
    if (pv) return { kind: "preview", t, battle: pv.battle };
  }
  if (canPick && t >= 1 && t <= S.rep.lastTurn) return { kind: "turn", t, battle: replayTurnPos(t, S.study.sets).battle };
  return { kind: "replay", t };
}
var pending2 = null;
function renderPanels() {
  if (pending2) return;
  pending2 = setTimeout(() => {
    pending2 = null;
    renderNow();
  }, 30);
}
function renderNow() {
  if (!S.rep) return;
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
  renderNote(pos);
  renderStudyPanel();
}
function go(id, { animate = false, force = false } = {}) {
  if (!id) return;
  if (isReplayPos(id) ? replayTurn(id) < 0 || replayTurn(id) > S.rep.lastTurn + 1 : !S.study.nodes[id]) return;
  const moved = S.cur !== id;
  if (moved) {
    clearPicks();
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
  const menu = $id("pickSec").querySelector(".rb-menu");
  if (e.key === "Escape" && closeMenu()) {
    renderNow();
    return;
  }
  if (e.key === "Enter" && !menu && !e.target.closest("button, a")) {
    const play = $id("btnPlayTurn");
    if (play && !play.disabled) {
      e.preventDefault();
      play.click();
    }
    return;
  }
  if (!menu) return;
  if (/^[1-9]$/.test(e.key)) {
    const b = menu.querySelectorAll("[data-pick]")[+e.key - 1];
    if (b && !b.disabled) {
      e.preventDefault();
      b.click();
    }
  } else if (e.key === "t" || e.key === "T") {
    const box = menu.querySelector("[data-gimmick]");
    if (box) box.click();
  }
}
function onOutsideClick(e) {
  if (!e.target.closest("#pickSec") && closeMenu()) renderNow();
}

// source/app/landing.js
function renderLanding() {
  renderStudies();
  renderRecent();
  $id("openUrl").focus();
}
function wireLanding() {
  $id("openForm").onsubmit = (e) => {
    e.preventDefault();
    const id = replayIdFrom($id("openUrl").value);
    $id("openErr").textContent = id ? "" : "Not a replay link.";
    if (id) visit(id);
  };
  $id("btnPasteLog").onclick = () => $id("btnLoad").click();
  wireFormatMenu();
  $id("freshForm").onsubmit = async (e) => {
    e.preventDefault();
    $id("freshErr").textContent = "";
    try {
      const rejected = await startFresh($id("freshFormat").value, [$id("freshTeam1").value, $id("freshTeam2").value]);
      if (rejected) showRejected(rejected);
    } catch (err) {
      showPage("landing");
      $id("freshErr").textContent = err.message || String(err);
    }
  };
  $id("btnRejectedOk").onclick = () => {
    $id("rejected").hidden = true;
  };
  $id("searchForm").onsubmit = (e) => {
    e.preventDefault();
    search();
  };
  $id("btnMore").onclick = () => search(lastResult);
  fetch("stats/index.json").then((r) => r.json()).then((formats) => {
    const d = document.createElement("datalist");
    d.id = "dl-formats";
    d.innerHTML = Object.keys(formats).map((f) => `<option value="${f}">`).join("");
    document.body.appendChild(d);
  }).catch(() => {
  });
}
function showRejected(rejected) {
  $id("rejectedText").innerHTML = rejected.map((r) => `<p><strong>${esc(r.team)}</strong><br>${esc(r.message)}</p>`).join("");
  $id("rejected").hidden = false;
  $id("btnRejectedOk").focus();
}
function wireFormatMenu() {
  const button = $id("btnFormat"), menu = $id("formatMenu"), value = $id("freshFormat");
  let sections = null;
  const open = () => {
    try {
      return new Set(JSON.parse(stored("rb-format-open", "[]")));
    } catch {
      return /* @__PURE__ */ new Set();
    }
  };
  const render2 = (query = "") => {
    const q = query.trim().toLowerCase(), shown = open();
    const current = sections.find((s) => s.formats.some((f) => f.id === value.value))?.section;
    menu.innerHTML = `<input class="textbox" id="formatSearch" placeholder="Search" aria-label="Search formats" value="${esc(query)}">` + sections.map((s) => {
      const formats = q ? s.formats.filter((f) => f.full.toLowerCase().includes(q) || f.id.includes(q.replace(/[^a-z0-9]/g, ""))) : s.formats;
      if (!formats.length) return "";
      const expanded = !!q || shown.has(s.section) || !shown.size && s.section === current;
      return `<div class="rb-fsec"><button type="button" class="rb-fhead" data-sec="${esc(s.section)}" aria-expanded="${expanded}"><i class="fa fa-caret-${expanded ? "down" : "right"}" aria-hidden="true"></i>${esc(s.section)}<small>${formats.length}</small></button><div class="rb-fitems" ${expanded ? "" : "hidden"}>${formats.map((f) => `<button type="button" class="rb-fitem ${f.id === value.value ? "cur" : ""}" data-format="${esc(f.id)}" title="${esc(f.full)}">${esc(f.name)}</button>`).join("")}</div></div>`;
    }).join("");
    const search2 = $id("formatSearch");
    search2.oninput = () => {
      render2(search2.value);
      const again = $id("formatSearch");
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    };
    for (const h of menu.querySelectorAll("[data-sec]")) h.onclick = () => {
      const now = open();
      if (!now.size && h.dataset.sec === current) now.add(current);
      if (now.has(h.dataset.sec)) now.delete(h.dataset.sec);
      else now.add(h.dataset.sec);
      store("rb-format-open", JSON.stringify([...now]));
      render2(search2.value);
    };
    for (const b of menu.querySelectorAll("[data-format]")) b.onclick = () => {
      value.value = b.dataset.format;
      $id("formatName").textContent = b.title;
      close2();
    };
  };
  const raise = (up) => button.closest(".rb-sheet")?.classList.toggle("rb-raised", up);
  const close2 = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    raise(false);
  };
  button.onclick = async (e) => {
    e.stopPropagation();
    if (!menu.hidden) {
      close2();
      return;
    }
    await S.ready;
    sections || (sections = E.freshFormats());
    render2();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    raise(true);
    menu.querySelector(".rb-fitem.cur")?.scrollIntoView({ block: "nearest" });
  };
  menu.onclick = (e) => e.stopPropagation();
  document.addEventListener("click", () => {
    if (!menu.hidden) close2();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      close2();
      button.focus();
    }
  });
}
var ago = (ms) => {
  const min = (Date.now() - ms) / 6e4;
  if (min < 1) return "just now";
  if (min < 60) return `${Math.floor(min)} min ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h ago`;
  return date(ms);
};
var date = (ms) => new Date(ms).toLocaleDateString(void 0, { year: "numeric", month: "short", day: "numeric" });
function savedStudies() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith("rbv:")) continue;
      try {
        const study = JSON.parse(localStorage.getItem(k));
        out.push({ key: k.slice(4), meta: study.meta || {}, name: typeof study.name === "string" ? study.name : "", lines: Object.keys(study.nodes || {}).length, opened: study.opened || 0 });
      } catch {
      }
    }
  } catch {
  }
  return out.sort((a, b) => b.opened - a.opened);
}
var players = (list) => (list || []).map((p) => `<strong>${esc(p)}</strong>`).join(" vs. ");
var entry = (key, details, who, end = "") => `<a class="blocklink" href="?r=${encodeURIComponent(key)}" data-visit="${esc(key)}"><span><small>${details}</small><br>${who}</span>${end}</a>`;
var opensHere = (e) => !(e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1);
var removeArmed = null;
function renderRecent() {
  const list = $id("recent");
  const studies = savedStudies();
  list.innerHTML = studies.length ? studies.map((s) => {
    const lines = s.lines ? ` \xB7 ${s.lines} line${s.lines > 1 ? "s" : ""}` : "";
    const details = `${esc(s.meta.format || s.key)}${s.name ? " \xB7 " + (s.meta.players || []).map(esc).join(" vs. ") : ""}`;
    return entry(
      s.key,
      `${details}${s.meta.shared ? " \xB7 shared with you" : ""}${lines}${s.opened ? " \xB7 " + ago(s.opened) : ""}`,
      s.name ? `<strong>${esc(s.name)}</strong>` : players(s.meta.players),
      `<button class="rb-linkbtn" data-remove="${esc(s.key)}">${removeArmed === s.key ? "Remove for good?" : "Remove"}</button>`
    );
  }).join("") : `<p class="rb-dim">Nothing yet. <a href="?r=${SAMPLE}" data-visit="${SAMPLE}">Open a sample replay</a></p>`;
  for (const link of list.querySelectorAll("[data-visit]")) link.onclick = (e) => {
    if (e.target.closest("[data-remove]") || !opensHere(e)) return;
    e.preventDefault();
    visit(link.dataset.visit);
  };
  for (const b of list.querySelectorAll("[data-remove]")) b.onclick = (e) => {
    e.preventDefault();
    if (removeArmed === b.dataset.remove) {
      unstore("rbv:" + b.dataset.remove);
      removeArmed = null;
      if (S.key === b.dataset.remove) S.key = "";
    } else removeArmed = b.dataset.remove;
    renderRecent();
  };
}
var lastResult = null;
async function search(after) {
  const user = $id("searchUser").value.trim(), format = $id("searchFormat").value.trim();
  const list = $id("searchResults"), err = $id("searchErr");
  err.textContent = "";
  if (!user && !format) {
    err.textContent = "Enter a username or a format.";
    return;
  }
  const q = new URLSearchParams();
  if (user) q.set("user", user);
  if (format) q.set("format", format);
  if (after) q.set("before", after.uploadtime);
  let found;
  try {
    const r = await fetch("https://replay.pokemonshowdown.com/search.json?" + q);
    if (!r.ok) throw new Error();
    found = await r.json();
  } catch {
    err.textContent = "Could not search replays.";
    return;
  }
  const more = found.length > 50;
  found = found.slice(0, 50);
  lastResult = found[found.length - 1];
  const entries = found.map((x) => entry(
    x.id,
    esc(x.format) + (x.rating ? ` \xB7 Rating: ${x.rating}` : ""),
    players(x.players),
    `<small>${date(x.uploadtime * 1e3)}</small>`
  )).join("");
  if (!after) list.innerHTML = "";
  list.insertAdjacentHTML("beforeend", entries || `<p class="rb-dim">No replays found.</p>`);
  list.hidden = false;
  $id("searchMore").hidden = !more;
  for (const link of list.querySelectorAll("[data-visit]")) link.onclick = (e) => {
    if (!opensHere(e)) return;
    e.preventDefault();
    visit(link.dataset.visit);
  };
}

// source/app/load.js
var SAMPLE = "oumonotype-82345404";
async function route() {
  let key = new URLSearchParams(location.search).get("r");
  const shared = location.hash.startsWith("#s="), sharedChapters = location.hash.startsWith("#c="), inStudy = studyInAddress();
  showPage(key || shared || sharedChapters || inStudy ? "viewer" : "landing");
  if (!key && !shared && !sharedChapters && !inStudy) {
    renderLanding();
    return;
  }
  await S.ready;
  try {
    if (sharedChapters) key = await openSharedStudy();
    else if (!key && !shared) key = startOfStudy(inStudy);
    renderChapterBar(shared ? null : key);
    if (shared) await openSharedLink();
    else if (key !== S.key) await openKey(key);
    renderChapterBar();
  } catch (e) {
    history.replaceState(null, "", location.pathname);
    showPage("landing");
    renderLanding();
    $id("openErr").textContent = e.message || String(e);
  }
}
function visit(key) {
  history.pushState(null, "", "?r=" + encodeURIComponent(key));
  route();
}
function showPage(page) {
  $id("landing").hidden = page !== "landing";
  $id("viewer").hidden = $id("viewerBtns").hidden = page !== "viewer";
  document.body.dataset.page = page;
  if (page === "landing") document.title = "Replay Study";
}
async function openKey(key) {
  const saved = loadSaved(key), meta = saved?.meta || {}, kept = !saved && keptChapter(key);
  if (meta.log) await loadText(meta.log, { key });
  else if (kept) await loadText(kept.log, { key, known: kept.teams });
  else {
    const id = meta.replayId || key.split("~")[0];
    await loadText(await fetchReplay(id), { replayId: id, key });
  }
}
async function loadText(text, { shown = false, replayId = null, study = null, key = null, shared = false, known = null } = {}) {
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
  S.key = key || replayKey(rep);
  S.lines.clear();
  S.replayPos.clear();
  S.realDice.clear();
  S.stats = await fetchStats(rep.formatid);
  S.cbEnd = E.clientAt(rep, rep.lastTurn + 1);
  S.base = E.revealedTeams(rep).map((team) => team.map((k) => E.suggestSet(k, S.stats, rep.gen)));
  const raw = study || exported?.study || loadSaved(S.key);
  const full = known || isFresh(rep) && raw?.sets;
  if (full) S.base = S.base.map((side, si) => side.map((b) => {
    const s = (full[si] || []).find((x) => x && x.name === b.name);
    return s ? { ...b, ...s, pasted: true, fixed: { moves: s.moves.filter(Boolean), item: true, ability: true, tera: true } } : b;
  }));
  S.study = cleanStudy(raw || newStudy(), S.base);
  const was = S.study.meta || {};
  S.study.meta = {
    format: rep.tier || rep.formatid,
    players: [S.cbEnd.p1.name, S.cbEnd.p2.name],
    ...replayId ? { replayId } : { log: rep.lines.join("\n") },
    ...shared || was.shared ? { shared: true } : {}
  };
  S.study.opened = Date.now();
  save();
  document.title = `${S.study.name || S.study.meta.players.join(" vs. ")} - Replay Study`;
  clearPicks();
  S.err = "";
  if (!shown) S.psMode = "";
  S.cur = "";
  go(full && rep.lastTurn >= 1 ? "r1" : "r0");
}
async function startFresh(format, teamTexts) {
  const validator = import("./validator.js");
  validator.catch(() => {
  });
  await S.ready;
  const texts = await Promise.all(teamTexts.map((t) => pasteText(t)));
  const teams = texts.map((t, si) => {
    const sets2 = E.parseTeam(t);
    if (!sets2.length) throw new Error(`Team ${si + 1}: no Pok\xE9mon found.`);
    return sets2;
  });
  const formatid = String(format || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "gen9ou";
  const rejected = (await validator).rejections(formatid, texts).map((message, si) => message && { team: `Team ${si + 1}`, message }).filter(Boolean);
  if (rejected.length) return rejected;
  const { log, sets } = E.freshBattle(formatid, teams);
  showPage("viewer");
  await loadText(log, { known: sets });
  history.pushState(null, "", "?r=" + encodeURIComponent(S.key));
  renderChapterBar();
}
var replayKey = (rep) => rep.meta.id || "log-" + hash(rep.lines.slice(0, 40).join("\n") + rep.lines.length);
var statsIndex = null;
async function fetchStats(formatid) {
  try {
    statsIndex || (statsIndex = fetch("stats/index.json").then((r2) => r2.json()));
    const id = E.statsFormat(formatid, await statsIndex);
    if (!id) return null;
    const r = await fetch("stats/" + id + ".json");
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
var shareable = () => ({ ...S.study, meta: void 0, opened: void 0 });
async function shareLink() {
  const byId = S.replayId && !/pw$/.test(S.replayId);
  const payload = { rbv: 1, study: shareable(), ...byId ? { id: S.replayId } : { log: S.rep.lines.join("\n") } };
  const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const data = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return location.origin + location.pathname + "#s=" + data;
}
async function openSharedLink() {
  const m = /^#s=([\w-]+)$/.exec(location.hash);
  if (!m) return;
  const binary = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const payload = JSON.parse(await new Response(stream).text());
  const text = payload.id ? await fetchReplay(payload.id) : payload.log;
  const key = sharedKey(replayKey(E.parseReplayInput(text)), payload.study);
  await loadText(text, { replayId: payload.id || null, study: payload.study, key, shared: true });
  history.replaceState(null, "", "?r=" + encodeURIComponent(S.key));
}
function sharedKey(own, study) {
  const mine = loadSaved(own);
  const hasWork = (s) => s && (Object.keys(s.nodes || {}).length || Object.values(s.notes || {}).some((n) => n?.comment || n?.glyph));
  return hasWork(mine) && JSON.stringify(mine.nodes) !== JSON.stringify(study?.nodes) ? own + "~" + hash(JSON.stringify(study || {})) : own;
}
function wireDialogs() {
  const loader = $id("loader"), sharer = $id("sharer");
  $id("btnLoad").onclick = () => {
    loader.hidden = false;
    $id("loadErr").textContent = "";
    $id("replayUrl").focus();
  };
  $id("btnShare").onclick = async () => {
    $id("exportBox").value = JSON.stringify({ rbv: 1, log: S.rep.lines.join("\n"), study: shareable() });
    $id("shareLink").value = await shareLink();
    $id("copyMsg").textContent = "";
    sharer.hidden = false;
    $id("btnCopyLink").focus();
  };
  $id("fileIn").onchange = async () => {
    const f = $id("fileIn").files[0];
    if (f) $id("pasteBox").value = await f.text();
  };
  $id("btnDoLoad").onclick = () => loadFrom(async () => {
    const id = replayIdFrom($id("replayUrl").value) || replayIdFrom($id("pasteBox").value);
    return id ? { text: await fetchReplay(id), replayId: id } : { text: $id("pasteBox").value };
  });
  $id("replayUrl").onkeydown = (e) => {
    if (e.key === "Enter") $id("btnDoLoad").click();
  };
  $id("btnSample").onclick = () => {
    $id("loader").hidden = true;
    visit(SAMPLE);
  };
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
  for (const modal of [loader, sharer, $id("importer"), $id("rejected")]) {
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
  const wasLanding = !$id("landing").hidden;
  try {
    const { text, replayId } = await get();
    await S.ready;
    E.parseReplayInput(text.trim().startsWith("{") ? JSON.parse(text).log || text : text);
    showPage("viewer");
    await loadText(text, { replayId });
    history.pushState(null, "", "?r=" + encodeURIComponent(S.key));
    renderChapterBar();
    $id("loader").hidden = true;
    $id("pasteBox").value = "";
    $id("replayUrl").value = "";
  } catch (e) {
    if (wasLanding) showPage("landing");
    $id("loadErr").textContent = e.message || String(e);
  }
}

// source/app/chapters.js
var ID = /^[a-z0-9]{1,16}$/;
var newId = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);
function loadCollection(id) {
  if (!ID.test(id || "")) return null;
  try {
    const raw = JSON.parse(stored("rbs:" + id, "null"));
    return raw ? cleanCollection(raw) : null;
  } catch {
    return null;
  }
}
var saveCollection = (id, st) => store("rbs:" + id, JSON.stringify(st));
function allCollections() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const st = k.startsWith("rbs:") && loadCollection(k.slice(4));
      if (st) out.push({ id: k.slice(4), ...st });
    }
  } catch {
  }
  return out.sort((a, b) => (b.opened || 0) - (a.opened || 0));
}
function studyInAddress() {
  const id = new URLSearchParams(location.search).get("c");
  return ID.test(id || "") ? id : null;
}
var chapterUrl = (id, key) => `?c=${id}` + (key ? "&r=" + encodeURIComponent(key) : "");
function visitChapter(id, key) {
  closePops();
  history.pushState(null, "", chapterUrl(id, key));
  route();
}
function startOfStudy(id) {
  const st = loadCollection(id);
  if (!st?.chapters.length) throw new Error("Study not found.");
  const key = st.last || st.chapters[0].key;
  history.replaceState(null, "", chapterUrl(id, key));
  return key;
}
function keptChapter(key) {
  const id = studyInAddress();
  for (const st of [id && loadCollection(id), ...allCollections()]) {
    const ch = st?.chapters.find((c) => c.key === key && c.log);
    if (ch) return { log: ch.log, teams: ch.teams || null };
  }
  return null;
}
var thisChapter = () => S.study?.meta?.replayId || !S.study?.meta?.log ? { key: S.key } : { key: S.key, log: S.study.meta.log, ...isFresh(S.rep) ? { teams: S.study.sets } : {} };
function chapterTitle(ch) {
  if (ch.title) return ch.title;
  const saved = loadSaved(ch.key), meta = saved?.meta || {};
  if (typeof saved?.name === "string" && saved.name.trim()) return saved.name.trim().slice(0, 80);
  const players2 = (Array.isArray(meta.players) ? meta.players : []).filter((p) => typeof p === "string" && p).join(" vs. ");
  return [typeof meta.format === "string" ? meta.format : "", players2].filter(Boolean).join(" \xB7 ") || ch.key;
}
var menuOpen = false;
var editing = null;
var removeArmed2 = -1;
function renderChapterBar(key = S.key) {
  const bar = $id("chapBar");
  const id = studyInAddress(), st = id && loadCollection(id);
  const i = st && key ? st.chapters.findIndex((ch) => ch.key === key) : -1;
  if (i < 0) {
    bar.hidden = true;
    bar.innerHTML = "";
    menuOpen = false;
    return;
  }
  st.last = key;
  st.opened = Date.now();
  saveCollection(id, st);
  const n = st.chapters.length;
  bar.hidden = false;
  bar.innerHTML = `<button type="button" class="button" id="chapPrev" title="Previous chapter" aria-label="Previous chapter" ${i ? "" : "disabled"}><i class="fa fa-chevron-left" aria-hidden="true"></i></button><div class="rb-popwrap rb-chapwrap"><button type="button" class="button rb-chapbtn" id="chapMenuBtn" aria-haspopup="true" aria-expanded="${menuOpen}"><i class="fa fa-book" aria-hidden="true"></i><strong>${esc(st.name)}</strong><span class="rb-chapno">Chapter ${i + 1} / ${n}</span><span class="rb-chaptitle">${esc(chapterTitle(st.chapters[i]))}</span><i class="fa fa-caret-down" aria-hidden="true"></i></button><div class="rb-pop" id="chapMenu" ${menuOpen ? "" : "hidden"}></div></div><button type="button" class="button" id="chapNext" title="Next chapter" aria-label="Next chapter" ${i < n - 1 ? "" : "disabled"}><i class="fa fa-chevron-right" aria-hidden="true"></i></button>`;
  $id("chapPrev").onclick = () => visitChapter(id, st.chapters[i - 1].key);
  $id("chapNext").onclick = () => visitChapter(id, st.chapters[i + 1].key);
  $id("chapMenuBtn").onclick = (e) => {
    e.stopPropagation();
    const open = !menuOpen;
    closePops();
    menuOpen = open;
    renderChapterBar();
  };
  if (menuOpen) renderChapterMenu(id, st, i);
}
function renderChapterMenu(id, st, i) {
  const menu = $id("chapMenu"), n = st.chapters.length;
  const tool = (attr, j, title, icon4, off = false) => `<button type="button" class="rb-linkbtn" ${attr}="${j}" title="${title}" aria-label="${title}" ${off ? "disabled" : ""}>${icon4}</button>`;
  menu.innerHTML = `<div class="rb-pophead">` + (editing === "name" ? `<input class="textbox" id="studyRename" maxlength="80" value="${esc(st.name)}" aria-label="Study name">` : `<strong>${esc(st.name)}</strong>${tool("data-rename-study", 0, "Rename study", '<i class="fa fa-pencil" aria-hidden="true"></i>')}`) + `<button type="button" class="button" id="btnShareStudy">Share</button></div>` + st.chapters.map((ch, j) => `<div class="rb-chap ${j === i ? "cur" : ""}">` + (editing === j ? `<input class="textbox" id="chapRename" maxlength="80" value="${esc(ch.title || "")}" placeholder="${esc(chapterTitle({ key: ch.key }))}" aria-label="Chapter title">` : `<button type="button" class="rb-fitem" data-chapter="${j}"><span class="rb-chapn">${j + 1}</span>${esc(chapterTitle(ch))}</button>`) + `<span class="rb-chaptools">${tool("data-up", j, "Move up", '<i class="fa fa-caret-up" aria-hidden="true"></i>', !j)}` + tool("data-down", j, "Move down", '<i class="fa fa-caret-down" aria-hidden="true"></i>', j === n - 1) + tool("data-retitle", j, "Rename chapter", '<i class="fa fa-pencil" aria-hidden="true"></i>') + (n > 1 ? tool("data-remove", j, "Remove chapter", removeArmed2 === j ? "Remove?" : '<i class="fa fa-times" aria-hidden="true"></i>') : "") + `</span></div>`).join("");
  const redo = () => renderChapterBar();
  const change = (f) => {
    f();
    saveCollection(id, st);
    redo();
  };
  menu.onclick = (e) => e.stopPropagation();
  for (const b of menu.querySelectorAll("[data-chapter]")) b.onclick = () => visitChapter(id, st.chapters[+b.dataset.chapter].key);
  for (const b of menu.querySelectorAll("[data-up], [data-down]")) b.onclick = () => change(() => {
    const j = +(b.dataset.up ?? b.dataset.down), k = b.dataset.up !== void 0 ? j - 1 : j + 1;
    [st.chapters[j], st.chapters[k]] = [st.chapters[k], st.chapters[j]];
    removeArmed2 = -1;
  });
  for (const b of menu.querySelectorAll("[data-retitle]")) b.onclick = () => {
    editing = +b.dataset.retitle;
    removeArmed2 = -1;
    redo();
  };
  for (const b of menu.querySelectorAll("[data-rename-study]")) b.onclick = () => {
    editing = "name";
    removeArmed2 = -1;
    redo();
  };
  for (const b of menu.querySelectorAll("[data-remove]")) b.onclick = () => {
    const j = +b.dataset.remove;
    if (removeArmed2 !== j) {
      removeArmed2 = j;
      redo();
      return;
    }
    removeArmed2 = -1;
    const [gone] = st.chapters.splice(j, 1);
    saveCollection(id, st);
    if (gone.key === S.key) visitChapter(id, st.chapters[Math.min(j, st.chapters.length - 1)].key);
    else redo();
  };
  const input = $id("studyRename") || $id("chapRename");
  if (input) {
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = input.value.trim().slice(0, 80);
      if (keep && editing === "name") {
        if (v) st.name = v;
      } else if (keep) {
        const ch = st.chapters[editing];
        if (v) ch.title = v;
        else delete ch.title;
      }
      editing = null;
      if (keep) saveCollection(id, st);
      redo();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") {
        e.stopPropagation();
        finish(false);
      }
    };
    input.onblur = () => finish(true);
  }
  $id("btnShareStudy").onclick = () => shareStudy(st);
}
function renderAddMenu() {
  const menu = $id("addMenu"), list = allCollections(), ok = CHAPTER_KEY.test(S.key || "");
  menu.innerHTML = list.map((s) => {
    const has = s.chapters.some((ch) => ch.key === S.key);
    return `<button type="button" class="rb-fitem rb-additem" data-add="${s.id}" ${ok && (has || s.chapters.length < MAX_CHAPTERS) ? "" : "disabled"}><i class="fa fa-${has ? "check" : "plus"}" aria-hidden="true"></i><span class="rb-addname">${esc(s.name)}</span><small>${s.chapters.length}</small></button>`;
  }).join("") + `<form class="rb-popnew" id="newStudyForm"><input class="textbox" id="newStudyName" maxlength="80" placeholder="New study" aria-label="New study name"><button type="submit" class="button" ${ok ? "" : "disabled"}>Create</button></form>`;
  for (const b of menu.querySelectorAll("[data-add]")) b.onclick = () => {
    const id = b.dataset.add, st = loadCollection(id);
    if (!st) return;
    if (!st.chapters.some((ch) => ch.key === S.key)) {
      st.chapters.push(thisChapter());
      saveCollection(id, st);
    }
    visitChapter(id, S.key);
  };
  $id("newStudyForm").onsubmit = (e) => {
    e.preventDefault();
    const id = newId(), name = $id("newStudyName").value.trim().slice(0, 80) || `Study ${list.length + 1}`;
    saveCollection(id, { name, chapters: [thisChapter()], last: S.key, opened: Date.now() });
    visitChapter(id, S.key);
  };
}
function closePops() {
  $id("addMenu").hidden = true;
  $id("btnAddStudy").setAttribute("aria-expanded", "false");
  if (menuOpen) {
    menuOpen = false;
    editing = null;
    removeArmed2 = -1;
    $id("chapMenu")?.setAttribute("hidden", "");
    $id("chapMenuBtn")?.setAttribute("aria-expanded", "false");
  }
}
function wireChapters() {
  $id("btnAddStudy").onclick = (e) => {
    e.stopPropagation();
    const open = $id("addMenu").hidden;
    closePops();
    if (!open || !S.rep) return;
    renderAddMenu();
    $id("addMenu").hidden = false;
    $id("btnAddStudy").setAttribute("aria-expanded", "true");
    $id("newStudyName").focus();
  };
  $id("addMenu").onclick = (e) => e.stopPropagation();
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".rb-popwrap")) closePops();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const back = !$id("addMenu").hidden ? $id("btnAddStudy") : menuOpen ? $id("chapMenuBtn") : null;
    closePops();
    back?.focus();
  });
  const modal = $id("studySharer");
  $id("btnCopyStudyLink").onclick = async () => {
    try {
      await navigator.clipboard.writeText($id("studyLink").value);
      $id("studyCopyMsg").textContent = "Link copied";
    } catch {
      $id("studyLink").select();
      $id("studyCopyMsg").textContent = "Press Ctrl+C to copy";
    }
  };
  $id("btnCloseStudyShare").onclick = () => {
    modal.hidden = true;
  };
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") modal.hidden = true;
  });
}
var landingEdit = null;
var landingRemove = null;
function renderStudies() {
  const list = allCollections(), box = $id("studies");
  $id("studiesSec").hidden = !list.length;
  box.innerHTML = list.map((s) => {
    const n = s.chapters.length;
    const details = `${n} chapter${n === 1 ? "" : "s"}${s.shared ? " \xB7 shared with you" : ""}${s.opened ? " \xB7 " + ago(s.opened) : ""}`;
    if (landingEdit === s.id) return `<div class="blocklink"><span><small>${details}</small><br><input class="textbox" id="studyRenameHome" maxlength="80" value="${esc(s.name)}" aria-label="Study name"></span></div>`;
    return `<a class="blocklink" href="${chapterUrl(s.id, s.last || s.chapters[0]?.key)}" data-study="${s.id}"><span><small>${details}</small><br><strong>${esc(s.name)}</strong></span><span class="rb-acts"><button type="button" class="rb-linkbtn" data-rename-home="${s.id}">Rename</button><button type="button" class="rb-linkbtn" data-remove-home="${s.id}">${landingRemove === s.id ? "Remove for good?" : "Remove"}</button></span></a>`;
  }).join("");
  for (const a of box.querySelectorAll("[data-study]")) a.onclick = (e) => {
    if (e.target.closest("button") || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    const st = loadCollection(a.dataset.study);
    if (st?.chapters.length) visitChapter(a.dataset.study, st.last || st.chapters[0].key);
  };
  for (const b of box.querySelectorAll("[data-rename-home]")) b.onclick = (e) => {
    e.preventDefault();
    landingEdit = b.dataset.renameHome;
    landingRemove = null;
    renderStudies();
  };
  for (const b of box.querySelectorAll("[data-remove-home]")) b.onclick = (e) => {
    e.preventDefault();
    if (landingRemove === b.dataset.removeHome) {
      unstore("rbs:" + b.dataset.removeHome);
      landingRemove = null;
    } else landingRemove = b.dataset.removeHome;
    renderStudies();
  };
  const input = $id("studyRenameHome");
  if (input) {
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const st = loadCollection(landingEdit), v = input.value.trim().slice(0, 80);
      if (keep && st && v) {
        st.name = v;
        saveCollection(landingEdit, st);
      }
      landingEdit = null;
      renderStudies();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    };
    input.onblur = () => finish(true);
  }
}
async function pack(payload) {
  const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function unpack(data) {
  const bytes = Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const text = await new Response(stream).text();
  if (text.length > 64e6) throw new Error("This study link is too large.");
  return JSON.parse(text);
}
async function shareStudy(st) {
  closePops();
  const chapters = [], left = [];
  for (const ch of st.chapters) {
    const saved = loadSaved(ch.key), meta = saved?.meta || {};
    const kept = typeof meta.log === "string" ? meta.log : ch.log || null;
    let id = typeof meta.replayId === "string" ? meta.replayId : !kept && !ch.key.startsWith("log-") ? ch.key.split("~")[0] : null;
    let log = id ? null : kept;
    if (id && /pw$/.test(id)) {
      try {
        log = E.parseReplayInput(await fetchReplay(id)).lines.join("\n");
      } catch {
      }
      id = null;
    }
    if (!id && !log) {
      left.push(chapterTitle(ch));
      continue;
    }
    const study = saved ? { ...saved, meta: void 0, opened: void 0 } : ch.teams ? { sets: ch.teams } : void 0;
    chapters.push({ ...ch.title ? { title: ch.title } : {}, study, ...id ? { id } : { log } });
  }
  $id("studyLink").value = location.origin + location.pathname + "#c=" + await pack({ rbv: 1, name: st.name, chapters });
  $id("studyCopyMsg").textContent = left.length ? "Not included: " + left.join(", ") : "";
  $id("studySharer").hidden = false;
  $id("btnCopyStudyLink").focus();
}
async function openSharedStudy() {
  const m = /^#c=([\w-]+)$/.exec(location.hash);
  if (!m) throw new Error("Not a study link.");
  const id = "s" + hash(m[1]);
  if (!loadCollection(id)) {
    const link = cleanStudyLink(await unpack(m[1]));
    const texts = /* @__PURE__ */ new Map(), ids = [...new Set(link.chapters.map((ch) => ch.id).filter(Boolean))];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (ids.length) {
        const rid = ids.shift();
        try {
          texts.set(rid, await fetchReplay(rid));
        } catch {
        }
      }
    }));
    const chapters = [];
    for (const ch of link.chapters) {
      const text = ch.id ? texts.get(ch.id) : ch.log;
      let rep;
      try {
        rep = E.parseReplayInput(text);
      } catch {
        continue;
      }
      const key = sharedKey(replayKey(rep), ch.study);
      if (!CHAPTER_KEY.test(key) || chapters.some((c) => c.key === key)) continue;
      const players2 = [1, 2].map((p) => (rep.lines.find((l) => l.startsWith(`|player|p${p}|`)) || "").split("|")[3] || "");
      store("rbv:" + key, JSON.stringify({
        ...cleanChapterStudy(ch.study),
        meta: { format: rep.tier || rep.formatid, players: players2, ...ch.id ? { replayId: ch.id } : { log: rep.lines.join("\n") }, shared: true }
      }));
      const kept = cleanChapterStudy(ch.study);
      chapters.push({ key, ...ch.title ? { title: ch.title } : {}, ...ch.id ? {} : { log: rep.lines.join("\n"), ...isFresh(rep) ? { teams: kept.sets } : {} } });
    }
    if (!chapters.length) throw new Error("Could not open the study (its replays may be private or deleted).");
    saveCollection(id, { name: link.name, chapters, last: chapters[0].key, opened: Date.now(), shared: true });
  }
  return startOfStudy(id);
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
  const dark = document.body.classList.contains("dark");
  Replays.$(".colorchooser button").each((_, b) => {
    b.classList.toggle("sel", b.value === "dark" === dark);
  });
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
    clearPicks();
    renderPanels();
  } else if (playing !== S.wasPlaying) renderPanels();
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
  const name = S.study?.name, who = `${esc(playerName(0))} vs. ${esc(playerName(1))}`, format = esc(S.rep.tier || S.rep.formatid);
  $id("rbTitle").innerHTML = (name ? `<strong>${esc(name)}</strong><br><small class="rb-sub">${format} \xB7 ${who}</small>` : `<strong>${format}</strong><br>${who}`) + (isReplayPos(S.cur) ? "" : ' <span class="rb-mode">Your line</span>') + ` <button type="button" class="rb-linkbtn rb-rename" id="btnRename" title="Name this study" aria-label="Name this study"><i class="fa fa-pencil" aria-hidden="true"></i></button>`;
  $id("btnRename").onclick = rename;
}
function rename() {
  const title = $id("rbTitle");
  title.innerHTML = `<input class="textbox rb-nameinput" id="studyName" maxlength="80" placeholder="${esc(S.rep.tier || S.rep.formatid)}" value="${esc(S.study.name || "")}" aria-label="Study name">`;
  const input = $id("studyName");
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) {
      const v = input.value.trim().slice(0, 80);
      if (v) S.study.name = v;
      else delete S.study.name;
      save();
      document.title = `${v || S.study.meta?.players?.join(" vs. ") || "Replay"} - Replay Study`;
      renderChapterBar();
    }
    showTitle();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

// source/app/main.js
var TEAMBUILDER_TABLES = "https://play.pokemonshowdown.com/data/teambuilder-tables.js?a7";
async function loadViewer() {
  setEngine(await import("./engine.js"));
  await until(() => window.Replays && Replays.battle && window.Battle && window.Dex);
  attachToEmbed();
  listenForTooltips($id("pickSec"));
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onOutsideClick);
  (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => {
    const s = document.createElement("script");
    s.src = TEAMBUILDER_TABLES;
    document.head.appendChild(s);
  });
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
S.ready = loadViewer();
S.ready.catch((e) => {
  console.error(e);
  $id("openErr").textContent = `Could not start: ${e.message || e}`;
});
wireDialogs();
wireLanding();
wireChapters();
$id("home").onclick = (e) => {
  e.preventDefault();
  history.pushState(null, "", location.pathname);
  route();
};
window.addEventListener("popstate", route);
route();
