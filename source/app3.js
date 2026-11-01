let E;
const $id = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const TAKE_SEED = [11, 22, 33, 44];
const S = {rep: null, key: '', stats: null, base: null, study: null, cur: 'r1', take: null, node: new Map(), takeCache: new Map(), cbEnd: null,
  sel: {}, tera: {}, tab: 'study', err: '', delArm: null, psb: null, psMode: '', lock: false, p2view: false, speed: 'normal', turnBox: false, atlas: {}, spriteCache: new Map()};

// ------------------------------------------------------------------ the Showdown replay embed + our sim
// replay-embed.js (Showdown, MIT) builds the replay viewer exactly like a downloaded replay; we drive Replays.battle.
async function loadEngine() {
  try { return await import('./engine.js'); }
  catch { const t = await fetch('engine.js').then(r => r.text()); return await import(URL.createObjectURL(new Blob([t], {type: 'text/javascript'}))); }
}
function until(test, ms = 60000) {
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = test(); } catch {} if (ok) res(); else if (Date.now() - t0 > ms) rej(new Error('Showdown did not load (check your connection).')); else setTimeout(tick, 100); }; tick(); });
}
const MARKS = []; const MARK = l => { MARKS.push(l + ' ' + Math.round(performance.now())); if (location.hash === '#perf') { let p = document.getElementById('perflive'); if (!p) { p = document.createElement('pre'); p.id = 'perflive'; document.body.appendChild(p); } p.textContent = MARKS.join('\n'); } };
// battle-animations.js prefixes its effect images with Dex.fxPrefix only if Dex existed when it ran;
// with the embed's load order it may not have, leaving paths relative to this site (404s, missing move animations).
function fixEffectUrls() {
  try {
    if (!window.BattleEffects || !Dex.fxPrefix) return;
    for (const id in BattleEffects) { const e = BattleEffects[id]; if (e && e.url && !/^(https?:)?\/\//.test(e.url)) e.url = Dex.fxPrefix + e.url; }
  } catch {}
}
async function boot() {
  try {
    MARK('module start');
    E = await loadEngine(); MARK('engine loaded');
    await until(() => window.Replays && Replays.battle && window.Battle && window.Dex); MARK('showdown ready');
    fixEffectUrls();
    const txt = await fetch('sample.json').then(r => r.text()); MARK('sample fetched');
    S.psb = Replays.battle; S.psMode = 'main';
    Replays.battle.subscribe(st => { Replays.update(st); onPS(); });   // Battle keeps one listener: feed the embed's controls too
    await loadText(txt, true); MARK('first render done');
  } catch (e) {
    $id('takeSec').innerHTML = `<p class="rb-err">Could not start: ${esc(e.message || e)}</p>`;
    console.error(e);
  }
}
function save() { try { localStorage.setItem('rbv:' + S.key, JSON.stringify(S.study)); } catch {} }
function loadStored(key) { try { const s = localStorage.getItem('rbv:' + key); return s ? JSON.parse(s) : null; } catch { return null; } }
const clone = o => JSON.parse(JSON.stringify(o));
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

async function loadText(text, first) {
  let payload = null;
  const t = String(text || '').trim();
  if (t.startsWith('{')) { try { const j = JSON.parse(t); if (j && j.rbv && j.log) payload = j; } catch {} }
  MARK('loadText start'); const rep = E.parseReplayInput(payload ? payload.log : t); MARK('replay input parsed');
  S.rep = rep;
  S.key = rep.meta.id || ('log-' + hash(rep.lines.slice(0, 40).join('\n') + rep.lines.length));
  S.node.clear(); S.takeCache.clear();
  S.stats = null;
  try { const r = await fetch('stats/' + rep.formatid + '.json'); MARK('stats response'); if (r.ok) S.stats = await r.json(); } catch {}
  MARK('stats fetched'); S.cbEnd = E.clientAt(rep, rep.lastTurn + 1).cb; MARK('replay parsed');
  MARK('before sets'); S.base = [S.cbEnd.p1, S.cbEnd.p2].map(side => side.team.map(p => E.suggestSet(E.knownOf(p), S.stats, rep.gen)));
  S.study = (payload && payload.study) || loadStored(S.key) || {rbv: 1, sets: null, nodes: {}, kids: {}, notes: {}, seq: 0};
  if (!S.study.sets || S.study.sets.length !== 2 || S.study.sets.some((s, i) => s.length !== S.base[i].length)) S.study.sets = clone(S.base);
  if (payload) save();
  S.take = null; S.sel = {}; S.tera = {};
  if (!first) S.psMode = '';
  S.cur = '';
  MARK('before go'); go('r0'); MARK('after go');
}

// ------------------------------------------------------------------ study tree model
const isMain = id => id[0] === 'r';
const mainT = id => +id.slice(1);
function parentOf(id) { if (isMain(id)) { const t = mainT(id); return t > 0 ? 'r' + (t - 1) : null; } return S.study.nodes[id]?.parent || null; }
function kids(id) { return S.study.kids[id] || []; }
function childrenOf(id) { if (isMain(id)) { const t = mainT(id); const k = kids(id).slice(); if (t <= S.rep.lastTurn) k.unshift('r' + (t + 1)); return k; } return kids(id); }
function pathTo(id) { const p = []; let n = id; while (n && !isMain(n)) { p.unshift(n); n = S.study.nodes[n].parent; } return p; }
function takeoverFor(t, sets) {
  const k = t + ':' + hash(JSON.stringify(sets));
  if (!S.takeCache.has(k)) { const r = E.takeover(S.rep, t, sets, TAKE_SEED); S.takeCache.set(k, {json: E.serialize(r.battle), battle: r.battle, notes: r.notes}); }
  return S.takeCache.get(k);
}
function previewFor(sets) {
  const k = 'preview:' + hash(JSON.stringify(sets));
  if (!S.takeCache.has(k)) { const b = E.previewBattle(S.rep, sets, TAKE_SEED); S.takeCache.set(k, b ? {json: E.serialize(b), battle: b} : null); }
  return S.takeCache.get(k);
}
const startIdx = () => S.rep.lines.findIndex(l => l === '|start');
function compute(id) {
  if (S.node.has(id)) return S.node.get(id);
  const n = S.study.nodes[id];
  const pj = n.parent === 'r0' ? previewFor(n.sets).json : isMain(n.parent) ? takeoverFor(mainT(n.parent), n.sets).json : compute(n.parent).json;
  const r = E.step(pj, n.choices, n.forced, n.seed);
  const res = {json: E.serialize(r.battle), battle: r.battle, lines: r.lines, rolls: r.rolls};
  S.node.set(id, res);
  return res;
}
function invalidate(id) { S.node.delete(id); for (const k of kids(id)) invalidate(k); }
function newSeed() { return [0, 0, 0, 0].map(() => Math.floor(Math.random() * 65536)); }
function addNode(parent, choices, forced, seed, sets) {
  const id = 'n' + (++S.study.seq);
  S.study.nodes[id] = {id, parent, choices, forced: forced || [], seed: seed || newSeed(), sets: sets || undefined, comment: '', glyph: ''};
  (S.study.kids[parent] ||= []).push(id);
  save();
  return id;
}
function deleteNode(id) {
  for (const k of kids(id).slice()) deleteNode(k);
  const n = S.study.nodes[id]; if (!n) return;
  const arr = S.study.kids[n.parent] || []; const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1);
  delete S.study.nodes[id]; delete S.study.kids[id]; S.node.delete(id);
}

// ------------------------------------------------------------------ the Showdown battle view (swapped into the embed)
const FADE = {hyperfast: 40, fast: 50, normal: 300, slow: 500, reallyslow: 1000}, DELAY = {hyperfast: 1, fast: 1, normal: 1, slow: 1000, reallyslow: 3000};
function newPS(lines) {
  const old = Replays.battle;
  const view = old && old.viewpointSwitched;
  try { old.destroy(); } catch {}
  Replays.$('.battle').empty(); Replays.$('.battle-log').empty();
  const b = new Battle({id: S.key, $frame: Replays.$('.battle'), $logFrame: Replays.$('.battle-log'), log: lines, isReplay: true, paused: true, autoresize: true});
  const sp = Replays.$('.speedchooser button.sel').val() || 'normal';
  b.messageShownTime = DELAY[sp]; b.messageFadeTime = FADE[sp];
  try { b.scene.updateAcceleration(); } catch {}
  try { b.setMute(!!Replays.muted); } catch {}
  if (view) b.switchViewpoint();
  Replays.battle = b;
  b.subscribe(st => { Replays.update(st); onPS(); });
  Replays.update();
  S.psb = b;
  return b;
}
function onPS() {
  if (S.lock || !S.psb) return;
  const b = S.psb;
  if (S.psMode === 'main') {
    if (S.stopAt && b.turn >= S.stopAt) { S.stopAt = null; b.pause(); }
    const t = b.ended ? S.rep.lastTurn + 1 : Math.max(0, Math.min(b.turn, S.rep.lastTurn + 1));
    const id = 'r' + t;
    const playing = isPlaying();
    if (id !== S.cur) { S.cur = id; S.sel = {}; S.tera = {}; renderPanels(); }
    else if (playing !== S.wasPlaying) renderTake(curBattle());
    S.wasPlaying = playing;
  }
}
function showPosition(animate) {
  S.lock = true;
  try {
    if (isMain(S.cur)) {
      if (S.psMode !== 'main') { newPS(S.rep.lines); S.psMode = 'main'; }
      const t = mainT(S.cur);
      if (t === 0) S.psb.reset(); else if (t > S.rep.lastTurn) S.psb.seekTurn(Infinity); else S.psb.seekTurn(t);
    } else {
      const path = pathTo(S.cur);
      const t0 = mainT(S.study.nodes[path[0]].parent);
      const prefix = S.rep.lines.slice(0, t0 === 0 ? startIdx() : S.rep.turnIdx[t0] + 1);
      const before = path.slice(0, -1).flatMap(id => compute(id).lines);
      const last = compute(S.cur).lines;
      S.psMode = 'branch:' + S.cur;
      if (animate) { newPS(prefix.concat(before)); S.psb.seekTurn(Infinity); for (const l of last) S.psb.add(l); S.psb.play(); }
      else { newPS(prefix.concat(before, last)); S.psb.seekTurn(Infinity); }
    }
  } finally { S.lock = false; }
  setTitle();
}
function setTitle() {
  const m = S.rep.meta; const ps = m.players || [S.cbEnd.p1.name, S.cbEnd.p2.name];
  $id('rbTitle').innerHTML = `<strong>${esc(S.rep.tier || S.rep.formatid)}</strong><br>${esc(ps[0] || 'Player 1')} vs. ${esc(ps[1] || 'Player 2')}${!isMain(S.cur) ? ' <span class="rb-mode">Your line</span>' : S.take ? ' <span class="rb-mode">Taking over</span>' : ''}`;
}
function ctl(a) {
  if (a === 'load') { $id('loader').hidden = false; $id('loadErr').textContent = ''; $id('pasteBox').focus(); }
  else if (a === 'export') { $id('exportBox').value = JSON.stringify({rbv: 1, log: S.rep.lines.join('\n'), study: S.study}); $id('exporter').hidden = false; $id('copyMsg').textContent = ''; }
}
function renderControls() { setTitle(); }
// ------------------------------------------------------------------ take over + move picker
function iconStyle(species) { try { return Dex.getPokemonIcon(species); } catch { return ''; } }
function typeTag(t) { return t ? `<span class="rb-type t-${esc(t === '???' ? 'Unknown' : t)}">${esc(t)}</span>` : ''; }
function guessCount() {
  let n = 0;
  S.study.sets.forEach((side, si) => side.forEach((s, k) => { const f = S.base[si][k].fixed; n += Math.max(0, s.moves.filter(Boolean).length - f.moves.length) + (f.item ? 0 : 1) + (f.ability ? 0 : 1); }));
  return n;
}
function pickerOn() { try { return localStorage.getItem('rb-picker') !== 'off'; } catch { return true; } }
function setPicker(on) { try { localStorage.setItem('rb-picker', on ? 'on' : 'off'); } catch {} S.sel = {}; S.tera = {}; renderPanels(); }
const isDoubles = () => S.rep.lines.some(l => l === '|gametype|doubles' || l === '|gametype|triples');
const isPlaying = () => !!(S.psb && !S.psb.paused && !S.psb.atQueueEnd);
function curBattle() {
  if (isMain(S.cur)) {
    const t = mainT(S.cur);
    if (t === 0 && pickerOn() && !isDoubles() && !isPlaying() && S.psb && !S.psb.started) {
      const pv = previewFor(S.study.sets);
      if (pv) return {kind: 'preview', t: 0, battle: pv.battle};
      return {kind: 'main', t};
    }
    if (t >= 1 && pickerOn() && t <= S.rep.lastTurn && !isDoubles() && !isPlaying()) {
      const tk = takeoverFor(t, S.study.sets);
      return {kind: 'take', t, battle: tk.battle};
    }
    return {kind: 'main', t};
  }
  const r = compute(S.cur); return {kind: 'branch', battle: r.battle, rolls: r.rolls};
}
// What a player actually did on replay turn t: their first action that turn.
function replayChoice(t, si) {
  if (t === 0) { const l = E.replayLeads(S.rep)['p' + (si + 1)]; return l ? {kind: 'lead', name: l} : null; }
  const a = S.rep.turnIdx[t], b = S.rep.turnIdx[t + 1] ?? S.rep.lines.length;
  const p = 'p' + (si + 1); let tera = false; let first = null;
  for (const l of S.rep.lines.slice(a + 1, b)) {
    const x = l.split('|');
    if (!x[2] || !x[2].startsWith(p)) continue;
    if (x[1] === '-terastallize') tera = true;
    if (first) continue;
    if (x[1] === 'move' && !/\[from\]/.test(l)) first = {kind: 'move', name: x[3]};
    else if (x[1] === 'switch') first = {kind: 'switch', name: x[2].replace(/^p\d[a-d]?: /, '')};
    else if (x[1] === 'cant') first = {kind: 'cant'};
  }
  return first ? {...first, tera} : null;
}
function choiceMatches(side, sel, tera, played) {
  if (!played || !sel) return false;
  if (played.kind === 'lead') { const [, n] = sel.split(' '); return side.activeRequest.side.pokemon[+n - 1].ident.replace(/^p\d: /, '') === played.name; }
  const [kind, n] = sel.split(' '); const req = side.activeRequest;
  if (played.kind === 'cant') return kind === 'move';
  if (kind !== played.kind) return false;
  if (kind === 'move') return E.toID(req.active[0].moves[+n - 1].move) === E.toID(played.name) && !!tera === !!played.tera;
  return req.side.pokemon[+n - 1].ident.replace(/^p\d: /, '') === played.name;
}
// Sets in force at this position: the study's sets on the replay, the line's own sets inside a line.
function setsAt(pos) { return pos.kind === 'take' || pos.kind === 'preview' ? S.study.sets : S.study.nodes[pathTo(S.cur)[0]].sets; }
function teamIndex(si, name) { return S.cbEnd[si ? 'p2' : 'p1'].team.findIndex(p => p.name === name); }
function editMove(pos, si, k, oldMove, newMove) {
  const mv = E.Dex.moves.get(newMove);
  if (!mv.exists) { S.err = `"${newMove}" is not a move.`; renderTake(pos); return; }
  const fix = sets => { const s = sets[si][k]; const j = s.moves.findIndex(m => E.toID(m) === E.toID(oldMove)); if (j >= 0) s.moves[j] = mv.name; };
  fix(S.study.sets);
  if (pos.kind !== 'take') { const root = pathTo(S.cur)[0]; fix(S.study.nodes[root].sets); invalidate(root); }
  save(); S.err = ''; S.sel = {}; S.tera = {};
  if (pos.kind !== 'take') showPosition(false);
  renderPanels();
}
// Whose turn it is to choose: Player 1 first, then Player 2 (only players with a decision to make).
function chooser(battle) {
  const need = battle.sides.map((s, si) => ({si, s, req: s.activeRequest})).filter(x => x.req && !x.req.wait);
  return {need, cur: need.find(x => !S.sel['p' + (x.si + 1)])};
}
function renderTake(pos) {
  const el = $id('takeSec');
  const head = (title) => `<span style="float:right" class="rb-row" role="group"><label class="rb-toggle"><input type="checkbox" id="pickTog" ${pickerOn() ? 'checked' : ''}> Move picker</label>
    <button class="button" id="tbPrev" title="Back (←)" aria-label="Back"><i class="fa fa-chevron-left" aria-hidden="true"></i></button><button class="button" id="tbNext" title="Forward (→)" aria-label="Forward"><i class="fa fa-chevron-right" aria-hidden="true"></i></button></span><h2>${title}</h2>`;
  const wire = () => { $id('tbPrev').onclick = () => nav('prev'); $id('tbNext').onclick = () => nav('next'); $id('pickTog').onchange = e => setPicker(e.target.checked); };
  if (pos.kind === 'main') { el.innerHTML = head(pos.t > S.rep.lastTurn ? 'End of the replay' : pos.t === 0 ? 'Team preview' : `Turn ${pos.t}`); wire(); return; }
  if (pos.kind === 'preview') { renderPreview(pos, head, wire); return; }
  const battle = pos.battle;
  if (battle.ended) { el.innerHTML = head(battle.winner ? esc(battle.winner) + ' won' : 'Tie'); wire(); return; }
  if (!pickerOn()) { el.innerHTML = head(`Turn ${battle.turn}`); wire(); return; }
  const {need, cur} = chooser(battle);
  if (!cur) { el.innerHTML = head(`Turn ${battle.turn}`); wire(); return; }
  const {si, s, req} = cur; const pid = 'p' + (si + 1);
  const played = pos.kind === 'take' ? replayChoice(pos.t, si) : null;
  const act = req.active && req.active[0];
  const forced = req.forceSwitch && req.forceSwitch[0];
  const activeMon = req.side.pokemon.find(p => p.active);
  const activeName = activeMon ? activeMon.ident.replace(/^p\d: /, '') : '';
  const k = teamIndex(si, activeName);
  const sets = setsAt(pos);
  const known = k >= 0 ? S.base[si][k].fixed.moves.map(m => E.toID(m)) : [];
  const species = k >= 0 ? sets[si][k].species : '';
  let body = '';
  if (!forced && act) {
    body += `<div class="rb-moves">${act.moves.map((m, i) => {
      const mv = E.Dex.moves.get(m.id || m.move); const ch = `move ${i + 1}`;
      const was = played && played.kind === 'move' && E.toID(played.name) === E.toID(m.move);
      const guess = k >= 0 && !known.includes(E.toID(m.move)) && !['struggle', 'recharge'].includes(E.toID(m.move));
      return `<div class="rb-mvwrap"><button type="button" class="rb-mv t-${esc(mv.type || 'Normal')} ${was ? 'played' : ''} ${guess ? 'guess' : ''}" data-c="${ch}" ${m.disabled || m.pp === 0 ? 'disabled' : ''}
        title="${esc(`${mv.category}${mv.basePower ? ', ' + mv.basePower + ' BP' : ''}, ${mv.accuracy === true ? 'never misses' : mv.accuracy + '% accuracy'}${mv.shortDesc ? '\n' + mv.shortDesc : ''}${guess ? '\nGuessed from usage stats' : ''}${was ? '\nUsed in the replay' : ''}`)}"><b>${esc(m.move)}</b><small><span>${esc(mv.type || '')}</span><span>${m.maxpp ? `${m.pp}/${m.maxpp}` : ''}</span></small></button>${
        guess ? `<button type="button" class="rb-edit" data-edit="${esc(m.move)}" title="Change this guessed move" aria-label="Change ${esc(m.move)}"><i class="fa fa-pencil" aria-hidden="true"></i></button>` : ''}</div>`;
    }).join('')}</div>`;
    if (act.canTerastallize) body += `<p class="rb-row" style="margin-top:6px"><label><input type="checkbox" id="teraBox" ${S.tera[pid] ? 'checked' : ''}> Terastallize</label> ${typeTag(act.canTerastallize)}</p>`;
  }
  const trapped = act && act.trapped && !forced;
  body += `<div class="rb-switches">${req.side.pokemon.map((p, n) => {
    if (p.active && !forced) return '';
    const name = p.ident.replace(/^p\d: /, ''); const fnt = /fnt/.test(p.condition);
    const hp = p.condition.split(' ')[0].split('/'); const pct = fnt ? 0 : Math.round(+hp[0] / +hp[1] * 100);
    const was = played && played.kind === 'switch' && played.name === name;
    return `<button type="button" class="button rb-sw ${was ? 'played' : ''}" data-c="switch ${n + 1}" ${fnt || p.active || trapped ? 'disabled' : ''} ${was ? 'title="Used in the replay"' : ''}><span class="rb-picon" style="${iconStyle(p.details.split(',')[0])}"></span>${esc(name)} <small>${pct}%</small></button>`;
  }).join('')}</div>`;
  const prev = need.filter(x => S.sel['p' + (x.si + 1)]);
  const q = forced ? `${esc(s.name)}: switch in a Pok&eacute;mon` : `${esc(s.name)}: what will ${esc(activeName)} do?`;
  el.innerHTML = `${head(`Turn ${battle.turn}`)}<div class="rb-pside"><h3><span>${q}</span>${prev.length ? `<button class="button" id="btnUndo"><i class="fa fa-undo" aria-hidden="true"></i> Back</button>` : ''}</h3>${body}</div>
    ${S.err ? `<p class="rb-err">${esc(S.err)}</p>` : ''}`;
  wire();
  const tb = $id('teraBox'); if (tb) tb.onchange = () => { S.tera[pid] = tb.checked; };
  const bu = $id('btnUndo'); if (bu) bu.onclick = () => { const last = prev[prev.length - 1]; delete S.sel['p' + (last.si + 1)]; delete S.tera['p' + (last.si + 1)]; renderTake(pos); };
  for (const b of el.querySelectorAll('[data-c]')) b.onclick = () => {
    S.sel[pid] = b.dataset.c; S.err = '';
    if (chooser(battle).cur) renderTake(pos); else playTurn(pos);
  };
  for (const b of el.querySelectorAll('[data-edit]')) b.onclick = () => {
    const old = b.dataset.edit; const wrap = b.parentElement;
    wrap.innerHTML = `<input class="textbox rb-mvinput" list="${speciesMoves(species)}" value="${esc(old)}" aria-label="Move instead of ${esc(old)}">`;
    const inp = wrap.querySelector('input'); inp.focus(); inp.select();
    let done = false;
    const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v && E.toID(v) !== E.toID(old)) editMove(pos, si, k, old, v); else renderTake(pos); };
    inp.onkeydown = e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { done = true; renderTake(pos); } };
    inp.onchange = commit; inp.onblur = commit;
  };
}
function renderPreview(pos, head, wire) {
  const el = $id('takeSec');
  const {need, cur} = chooser(pos.battle);
  if (!cur) { el.innerHTML = head('Team preview'); wire(); return; }
  const {si, s, req} = cur; const pid = 'p' + (si + 1);
  const played = replayChoice(0, si);
  const prev = need.filter(x => S.sel['p' + (x.si + 1)]);
  const mons = req.side.pokemon.map((p, n) => {
    const name = p.ident.replace(/^p\d: /, ''); const was = played && played.name === name;
    return `<button type="button" class="button rb-sw ${was ? 'played' : ''}" data-c="team ${n + 1}" ${was ? 'title="Lead in the replay"' : ''}><span class="rb-picon" style="${iconStyle(p.details.split(',')[0])}"></span>${esc(name)}</button>`;
  }).join('');
  el.innerHTML = `${head('Team preview')}<div class="rb-pside"><h3><span>${esc(s.name)}: choose a lead</span>${prev.length ? '<button class="button" id="btnUndo"><i class="fa fa-undo" aria-hidden="true"></i> Back</button>' : ''}</h3><div class="rb-switches">${mons}</div></div>
    ${S.err ? `<p class="rb-err">${esc(S.err)}</p>` : ''}`;
  wire();
  const bu = $id('btnUndo'); if (bu) bu.onclick = () => { const last = prev[prev.length - 1]; delete S.sel['p' + (last.si + 1)]; renderPreview(pos, head, wire); };
  for (const b of el.querySelectorAll('[data-c]')) b.onclick = () => { S.sel[pid] = b.dataset.c; S.err = ''; if (chooser(pos.battle).cur) renderPreview(pos, head, wire); else playTurn(pos); };
}
function describeChoice(side, c) {
  const [kind, n] = c.split(' '); const req = side.activeRequest;
  if (kind === 'move') return req.active[0].moves[+n - 1].move;
  if (kind === 'switch') return '→ ' + req.side.pokemon[+n - 1].ident.replace(/^p\d: /, '');
  return c;
}
function playTurn(pos) {
  const choices = {};
  pos.battle.sides.forEach((s, si) => {
    const pid = 'p' + (si + 1);
    if (s.activeRequest && !s.activeRequest.wait) { let c = S.sel[pid]; if (c && c.startsWith('move') && S.tera[pid]) c += ' terastallize'; choices[pid] = c; }
  });
  // Same choices as the replay: play the replay's own turn.
  if ((pos.kind === 'take' || pos.kind === 'preview') && pos.battle.sides.every((s, si) => {
    const pid = 'p' + (si + 1);
    if (!s.activeRequest || s.activeRequest.wait) return true;
    return choiceMatches(s, S.sel[pid], S.tera[pid], replayChoice(pos.t, si));
  })) { S.sel = {}; S.tera = {}; S.err = ''; S.stopAt = pos.t + 1; if (pos.t === 0) S.psb.reset(); else S.psb.seekTurn(pos.t); S.psb.play(); renderPanels(); return; }
  const parent = pos.kind === 'take' || pos.kind === 'preview' ? 'r' + pos.t : S.cur;
  let id = kids(parent).find(k => JSON.stringify(S.study.nodes[k].choices) === JSON.stringify(choices) && !(S.study.nodes[k].forced || []).length);
  const existed = !!id;
  try {
    if (!id) { id = addNode(parent, choices, [], newSeed(), pos.kind === 'take' || pos.kind === 'preview' ? clone(S.study.sets) : undefined); compute(id); }
  } catch (e) { if (id && !existed) { deleteNode(id); save(); } S.sel = {}; S.tera = {}; S.err = e.message || String(e); renderTake(pos); return; }
  S.sel = {}; S.tera = {}; S.err = '';
  go(id, true);
}

// ------------------------------------------------------------------ dice
function renderDice(pos) {
  const el = $id('diceSec');
  if (pos.kind !== 'branch') { el.hidden = true; return; }
  el.hidden = false;
  const rolls = pos.rolls || []; const node = S.study.nodes[S.cur];
  const branchy = kids(S.cur).length > 0;
  el.innerHTML = `<h2>Dice</h2>
    ${rolls.length ? `<div class="rb-rolls">${rolls.map(rollRow).join('')}</div>` : ''}
    <p class="rb-row"><button class="button" id="btnReroll"><i class="fa fa-random" aria-hidden="true"></i> Randomize</button>
    <button class="button" id="btnDefaults" ${node.forced && node.forced.length ? '' : 'disabled'}>Most likely outcomes</button></p>`;
  for (const c of el.querySelectorAll('[data-roll]')) {
    c[c.tagName === 'SELECT' ? 'onchange' : 'onclick'] = () => {
      const i = +c.dataset.roll; const r = rolls[i];
      const v = r.kind === 'chance' ? c.dataset.v === '1' : r.kind === 'order' ? JSON.parse(c.dataset.v || c.value) : +c.value;
      const forced = rolls.map(x => ({key: x.key, value: x.value})); forced[i] = {key: r.key, value: v};
      setForced(forced, node.seed);
    };
  }
  $id('btnReroll').onclick = () => setForced(rolls.map(r => ({key: r.key, value: randomOutcome(r)})), node.seed);
  $id('btnDefaults').onclick = () => setForced([], node.seed);
}
function randomOutcome(r) {
  const ri = n => Math.floor(Math.random() * n);
  if (r.kind === 'chance') return Math.random() < r.p;
  if (r.kind === 'roll') return ri(16);
  if (r.kind === 'int') return r.lo + ri(r.hi - r.lo);
  if (r.kind === 'pick') return ri(r.options.length);
  if (r.kind === 'order') { const o = r.options.map((_, k) => k); for (let k = o.length - 1; k > 0; k--) { const j = ri(k + 1); [o[k], o[j]] = [o[j], o[k]]; } return o; }
  return r.value;
}
function rollRow(r) {
  const who = r.who ? `<small> · ${esc(r.who)}${r.target ? ' → ' + esc(r.target) : ''}</small>` : '';
  let ctl = '';
  if (r.kind === 'chance') {
    const p = Math.round(r.p * 1000) / 10;
    ctl = `<span class="rb-seg"><button type="button" class="button ${r.value ? 'on' : ''}" data-roll="${r.i}" data-v="1">${esc(r.yes)} ${p}%</button><button type="button" class="button ${!r.value ? 'on' : ''}" data-roll="${r.i}" data-v="0">${esc(r.no)}</button></span>`;
  } else if (r.kind === 'roll') {
    ctl = `<select class="button" data-roll="${r.i}" aria-label="Damage roll">${Array.from({length: 16}, (_, v) => `<option value="${v}" ${v === r.value ? 'selected' : ''}>${100 - v}%${v === 0 ? ' (max)' : v === 15 ? ' (min)' : ''}</option>`).join('')}</select>`;
  } else if (r.kind === 'int') {
    const n = r.hi - r.lo;
    ctl = n <= 40 ? `<select class="button" data-roll="${r.i}">${Array.from({length: n}, (_, k) => `<option value="${r.lo + k}" ${r.lo + k === r.value ? 'selected' : ''}>${r.lo + k}</option>`).join('')}</select>` : `<span class="rb-note">${r.value}</span>`;
  } else if (r.kind === 'pick') {
    ctl = `<select class="button" data-roll="${r.i}">${r.options.map((o, k) => `<option value="${k}" ${k === r.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (r.kind === 'order') {
    const perms = permutations(r.options.length).slice(0, 24);
    ctl = r.options.length === 2
      ? `<span class="rb-seg">${perms.map(pm => `<button type="button" class="button ${JSON.stringify(pm) === JSON.stringify(r.value) ? 'on' : ''}" data-roll="${r.i}" data-v="${esc(JSON.stringify(pm))}">${esc(r.options[pm[0]])} first</button>`).join('')}</span>`
      : `<select class="button" data-roll="${r.i}">${perms.map(pm => `<option value="${esc(JSON.stringify(pm))}" ${JSON.stringify(pm) === JSON.stringify(r.value) ? 'selected' : ''}>${esc(pm.map(k => r.options[k]).join(' > '))}</option>`).join('')}</select>`;
  }
  return `<div class="rb-roll"><div>${esc(r.label)}${who}</div><div>${ctl}</div></div>`;
}
function permutations(n) { const out = []; const rec = (a, rest) => { if (!rest.length) out.push(a); rest.forEach((x, i) => rec([...a, x], rest.filter((_, j) => j !== i))); }; rec([], [...Array(n).keys()]); return out; }
function setForced(forced, seed) {
  const node = S.study.nodes[S.cur];
  if (kids(S.cur).length) {
    const id = addNode(node.parent, clone(node.choices), forced, seed, node.sets ? clone(node.sets) : undefined);
    try { compute(id); } catch (e) { deleteNode(id); save(); S.err = e.message; renderPanels(); return; }
    go(id, true);
  } else {
    node.forced = forced; node.seed = seed; invalidate(S.cur); save();
    try { compute(S.cur); } catch (e) { S.err = e.message; }
    go(S.cur, true, true);
  }
}

// ------------------------------------------------------------------ study tree + teams
function mainSummary(t) { const a = S.rep.turnIdx[t], b = S.rep.turnIdx[t + 1] ?? S.rep.lines.length; return E.summarize(S.rep.lines.slice(a + 1, b)); }
function nodeNote(id) { return isMain(id) ? (S.study.notes[id] || {}) : S.study.nodes[id]; }
function tokenHTML(id) {
  let r; try { r = compute(id); } catch { return `<span class="rb-tok rb-err" data-go="${id}">(error)</span>`; }
  const s = E.summarize(r.lines); const n = S.study.nodes[id];
  const pt = isMain(n.parent) ? mainT(n.parent) : compute(n.parent).battle.turn;
  return `<span class="rb-tok ${id === S.cur ? 'cur' : ''}" data-go="${id}"><span class="tn">${pt}.</span>${esc(s.p1 || '…')} <span class="tn">|</span> ${esc(s.p2 || '…')}${(n.forced || []).length ? ' <i class="fa fa-cube" title="Dice set by you" aria-hidden="true"></i>' : ''}${n.glyph ? `<span class="rb-glyph">${esc(n.glyph)}</span>` : ''}${n.comment ? ` <i class="rb-cmt">${esc(n.comment.slice(0, 60))}</i>` : ''}</span>`;
}
function varHTML(first) {
  let html = ''; let id = first;
  while (id) { html += tokenHTML(id) + ' '; const k = kids(id); if (k.length > 1) html += k.slice(1).map(x => `<div class="rb-var">${varHTML(x)}</div>`).join(''); id = k[0]; }
  return html;
}
function renderStudySec() {
  const el = $id('studySec');
  el.innerHTML = `<div class="rb-tabs"><button class="button ${S.tab === 'study' ? 'cur' : ''}" id="tabStudy">Study</button><button class="button ${S.tab === 'teams' ? 'cur' : ''}" id="tabTeams">Teams</button></div><div id="tabBody"></div>`;
  $id('tabStudy').onclick = () => { S.tab = 'study'; renderStudySec(); };
  $id('tabTeams').onclick = () => { S.tab = 'teams'; renderStudySec(); };
  if (S.tab === 'study') renderStudy(); else renderTeams();
}
function renderStudy() {
  const body = $id('tabBody'); const rows = [];
  rows.push(`<div class="rb-mrow start ${S.cur === 'r0' ? 'cur' : ''}" data-go="r0"><div class="no"></div><div class="a">Team preview</div></div>`);
  if (kids('r0').length) rows.push(`<div class="rb-vars">${kids('r0').map(k => `<div class="rb-var">${varHTML(k)}</div>`).join('')}</div>`);
  { const L = E.replayLeads(S.rep); rows.push(`<div class="rb-mrow ${S.cur === 'r1' ? 'cur' : ''}" data-go="r1"><div class="no">0</div><div class="a">→ ${esc(L.p1 || '?')}</div><div class="a">→ ${esc(L.p2 || '?')}</div></div>`); }
  if (kids('r1').length) rows.push(`<div class="rb-vars">${kids('r1').map(k => `<div class="rb-var">${varHTML(k)}</div>`).join('')}</div>`);
  for (let t = 1; t <= S.rep.lastTurn; t++) {
    const s = mainSummary(t); const id = 'r' + (t + 1); const nn = S.study.notes[id];
    rows.push(`<div class="rb-mrow ${S.cur === id ? 'cur' : ''}" data-go="${id}"><div class="no">${t}</div><div class="a">${esc(s.p1 || '—')}${nn && nn.glyph ? `<span class="rb-glyph">${esc(nn.glyph)}</span>` : ''}</div><div class="a">${esc(s.p2 || '—')}</div></div>`);
    if (nn && nn.comment) rows.push(`<div class="rb-vars" style="background:transparent"><span class="rb-cmt">${esc(nn.comment)}</span></div>`);
    const k = kids(id); if (k.length) rows.push(`<div class="rb-vars">${k.map(x => `<div class="rb-var">${varHTML(x)}</div>`).join('')}</div>`);
  }
  const note = nodeNote(S.cur) || {}; const isBranch = !isMain(S.cur);
  body.innerHTML = `<div class="rb-movelist">${rows.join('')}</div>
    <div class="rb-notes"><div class="rb-glyphs">${['!!', '!', '!?', '?!', '?', '??'].map(g => `<button class="button ${note.glyph === g ? 'on' : ''}" data-glyph="${g}">${g}</button>`).join(' ')}</div>
      <textarea id="comment" class="textbox" rows="2" placeholder="Note on this position">${esc(note.comment || '')}</textarea>
      ${isBranch ? `<p class="rb-row" style="margin:0"><button class="button" id="btnPromote" ${kids(S.study.nodes[S.cur].parent)[0] === S.cur ? 'disabled' : ''}>Make this the first line</button>
        <button class="button" id="btnDelete">${S.delArm === S.cur ? 'Click again to delete' : 'Delete from here'}</button></p>` : ''}</div>`;
  for (const el of body.querySelectorAll('[data-go]')) el.onclick = () => go(el.dataset.go, false);
  for (const b of body.querySelectorAll('[data-glyph]')) b.onclick = () => { const n = isMain(S.cur) ? (S.study.notes[S.cur] ||= {}) : S.study.nodes[S.cur]; n.glyph = n.glyph === b.dataset.glyph ? '' : b.dataset.glyph; save(); renderStudy(); };
  $id('comment').oninput = e => { const n = isMain(S.cur) ? (S.study.notes[S.cur] ||= {}) : S.study.nodes[S.cur]; n.comment = e.target.value; save(); };
  $id('comment').onchange = () => renderStudy();
  const bpr = $id('btnPromote'); if (bpr) bpr.onclick = () => { const p = S.study.nodes[S.cur].parent; const a = S.study.kids[p]; a.splice(a.indexOf(S.cur), 1); a.unshift(S.cur); save(); renderStudy(); };
  const bdel = $id('btnDelete'); if (bdel) bdel.onclick = () => { if (S.delArm !== S.cur) { S.delArm = S.cur; renderStudy(); return; } const p = S.study.nodes[S.cur].parent; deleteNode(S.cur); S.delArm = null; save(); go(p, false); };
  const cur = body.querySelector('.cur'); if (cur) { const list = body.querySelector('.rb-movelist'); list.scrollTop = Math.max(0, cur.offsetTop - list.offsetTop - 60); }
}
let dl = false;
function datalists() {
  if (dl) return; dl = true;
  const d = document.createElement('div'); d.hidden = true;
  d.innerHTML = `<datalist id="dl-items">${E.Dex.items.all().filter(i => !i.isNonstandard || i.isNonstandard === 'Past').map(i => `<option value="${esc(i.name)}">`).join('')}</datalist>
    <datalist id="dl-natures">${E.Dex.natures.all().map(n => `<option value="${esc(n.name)}">`).join('')}</datalist>`;
  document.body.appendChild(d);
}
function speciesMoves(species) {
  const id = 'dl-mv-' + E.toID(species); if ($id(id)) return id;
  const opts = E.setOptions(species, S.stats, S.rep.gen); const seen = new Set(); const list = [];
  for (const [m, p] of opts.moves) if (!seen.has(m)) { seen.add(m); list.push(`<option value="${esc(m)}" label="${Math.round(p * 100)}% usage">`); }
  const learn = [];
  try { let sp = E.Dex.species.get(species); for (let g = 0; sp && sp.exists && g < 4; g++) { const ls = E.Dex.data.Learnsets[sp.id] || E.Dex.data.Learnsets[E.toID(sp.baseSpecies)]; if (ls && ls.learnset) learn.push(...Object.keys(ls.learnset)); sp = sp.prevo ? E.Dex.species.get(sp.prevo) : null; } } catch {}
  const names = (learn.length ? [...new Set(learn)].map(m => E.Dex.moves.get(m).name) : E.Dex.moves.all().map(m => m.name)).sort();
  for (const m of names) if (!seen.has(m)) { seen.add(m); list.push(`<option value="${esc(m)}">`); }
  const d = document.createElement('datalist'); d.id = id; d.innerHTML = list.join(''); document.body.appendChild(d);
  return id;
}
function renderTeams() {
  datalists();
  const body = $id('tabBody'); const gen = S.rep.gen;
  const types = E.Dex.types.all().map(t => t.name).filter(t => t !== '???' && (gen >= 9 || t !== 'Stellar'));
  const side = si => {
    const cs = S.cbEnd[si ? 'p2' : 'p1'];
    return `<div class="rb-teamhead"><b>${esc(cs.name || 'Player ' + (si + 1))}</b><button class="button" data-resetside="${si}">Reset to suggestions</button></div>
      <div class="rb-mons">${S.study.sets[si].map((s, k) => monCard(si, k, s, types)).join('')}</div>`;
  };
  body.innerHTML = `${S.stats ? '' : `<p class="rb-err">No usage stats for ${esc(S.rep.formatid)}.</p>`}
    ${side(0)}${side(1)}`;
  for (const inp of body.querySelectorAll('[data-f]')) inp.onchange = () => {
    const si = +inp.dataset.si, k = +inp.dataset.k, f = inp.dataset.f; const set = S.study.sets[si][k];
    if (f.startsWith('move')) set.moves[+f.slice(4)] = inp.value.trim();
    else if (f.startsWith('ev_')) set.evs[f.slice(3)] = Math.max(0, Math.min(252, +inp.value || 0));
    else if (f === 'level') set.level = Math.max(1, Math.min(100, +inp.value || 100));
    else set[f] = inp.value.trim();
    save(); inp.classList.remove('guess'); renderTake(curBattle());
  };
  for (const b of body.querySelectorAll('[data-resetmon]')) b.onclick = () => { const [si, k] = b.dataset.resetmon.split(',').map(Number); S.study.sets[si][k] = clone(S.base[si][k]); save(); renderTeams(); };
  for (const b of body.querySelectorAll('[data-resetside]')) b.onclick = () => { const si = +b.dataset.resetside; S.study.sets[si] = clone(S.base[si]); save(); renderTeams(); };
}
function monCard(si, k, s, types) {
  const f = S.base[si][k].fixed, base = S.base[si][k];
  const sp = E.Dex.species.get(s.species); const opts = E.setOptions(s.species, S.stats, S.rep.gen);
  const pct = (list, v) => { const e = list.find(([n]) => E.toID(n) === E.toID(v)); return e ? ` (${Math.round(e[1] * 100)}% usage)` : ''; };
  const g = (fx, cur, b) => (!fx && cur === b) ? 'guess' : '';
  const dlid = speciesMoves(s.species);
  const mv = [0, 1, 2, 3].map(i => { const v = s.moves[i] || ''; const seen = f.moves.some(m => E.toID(m) === E.toID(v));
    return `<input class="textbox ${seen ? '' : (v === base.moves[i] ? 'guess' : '')}" data-si="${si}" data-k="${k}" data-f="move${i}" list="${dlid}" value="${esc(v)}" title="${seen ? 'Seen in the replay' : 'Guess' + pct(opts.moves, v)}" aria-label="Move ${i + 1}">`; }).join('');
  const ev = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(st => `<input class="textbox" data-si="${si}" data-k="${k}" data-f="ev_${st}" type="number" min="0" max="252" step="4" value="${s.evs[st] || 0}" aria-label="${st} EVs">`).join('');
  return `<div class="rb-mon"><div class="hd"><span class="rb-picon" style="${iconStyle(s.species)}"></span><span class="nm">${esc(s.name)}${s.name !== s.species ? ` <span class="rb-note">(${esc(s.species)})</span>` : ''}</span> ${(sp.types || []).map(typeTag).join('')}</div>
    <label>Item<input class="textbox ${g(f.item, s.item, base.item)}" data-si="${si}" data-k="${k}" data-f="item" list="dl-items" value="${esc(s.item)}" title="${f.item ? 'Seen in the replay' : 'Guess' + pct(opts.items, s.item)}"></label>
    <label>Ability<select class="button ${g(f.ability, s.ability, base.ability)}" data-si="${si}" data-k="${k}" data-f="ability">${[...new Set([...Object.values(sp.abilities || {}), s.ability])].filter(Boolean).map(a => `<option ${a === s.ability ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
    ${S.rep.gen >= 9 ? `<label>Tera<select class="button ${g(f.tera, s.teraType, base.teraType)}" data-si="${si}" data-k="${k}" data-f="teraType">${types.map(t => `<option ${t === s.teraType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
    <div class="rb-mvgrid">${mv}</div>
    ${S.rep.gen >= 3 ? `<label>Nature<input class="textbox" data-si="${si}" data-k="${k}" data-f="nature" list="dl-natures" value="${esc(s.nature)}"></label>
    <div class="rb-evs">${['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'].map(x => `<span>${x}</span>`).join('')}${ev}</div>` : ''}
    <label>Level<input class="textbox" data-si="${si}" data-k="${k}" data-f="level" type="number" min="1" max="100" value="${s.level}"></label>
    <p style="margin:0;text-align:right"><button class="button" data-resetmon="${si},${k}">Reset</button></p></div>`;
}

// ------------------------------------------------------------------ navigation
function renderPanels() {
  let pos;
  try { pos = curBattle(); } catch (e) { S.err = e.message; console.error(e); S.take = null; pos = {kind: 'main', t: isMain(S.cur) ? mainT(S.cur) : 1}; }
  renderTake(pos); renderDice(pos); renderStudySec();
}
function go(id, animate, force) {
  if (!id) return;
  if (!isMain(id) && !S.study.nodes[id]) return;
  if (isMain(id) && (mainT(id) < 0 || mainT(id) > S.rep.lastTurn + 1)) return;
  const changed = S.cur !== id || force;
  if (S.cur !== id) { S.sel = {}; S.tera = {}; S.err = ''; }
  if (S.take && !(isMain(id) && mainT(id) === S.take.t)) S.take = null;
  S.cur = id; S.delArm = null;
  if (changed || !S.psMode) showPosition(animate);
  renderPanels();
}
function siblings(id) { const p = parentOf(id); return p ? childrenOf(p) : [id]; }
function nav(dir) {
  if (dir === 'prev') { if (S.take) { S.take = null; renderPanels(); renderControls(); return; } go(parentOf(S.cur), false); }
  else if (dir === 'next') go(childrenOf(S.cur)[0], !isMain(S.cur) || kids(S.cur).length && !isMain(childrenOf(S.cur)[0]));
  else if (dir === 'up' || dir === 'down') { const sib = siblings(S.cur); const i = sib.indexOf(S.cur); const j = i + (dir === 'up' ? -1 : 1); if (j >= 0 && j < sib.length) go(sib[j], false); }
}
document.addEventListener('keydown', e => {
  if (!S.rep || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select') || !$id('loader').hidden || !$id('exporter').hidden) return;
  const k = {ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'up', ArrowDown: 'down'}[e.key];
  if (k) { e.preventDefault(); nav(k); return; }
});

// ------------------------------------------------------------------ load / export dialogs
$id('btnCancel').onclick = () => { $id('loader').hidden = true; };
$id('replayUrl').oninput = () => {
  const u = $id('replayUrl').value.trim().replace(/[?#].*$/, '').replace(/\.(json|log)$/, '');
  const m = u.match(/^(?:https?:\/\/)?replay\.pokemonshowdown\.com\/(.+)$/);
  $id('logLink').textContent = m ? `Press Load to open ${m[1]}.` : '';
};
$id('fileIn').onchange = async () => { const f = $id('fileIn').files[0]; if (f) $id('pasteBox').value = await f.text(); };
function replayIdFrom(s) {
  const m = String(s || '').trim().replace(/[?#].*$/, '').replace(/\.(json|log|html)$/, '').match(/^(?:https?:\/\/)?(?:replay\.pokemonshowdown\.com|psim\.us\/r)\/([a-z0-9-]+)$/i);
  return m ? m[1] : null;
}
async function fetchReplay(id) {
  const r = await fetch(`https://replay.pokemonshowdown.com/${id}.json`);
  if (!r.ok) throw new Error(r.status === 404 ? 'Replay not found (it may be private or deleted).' : `Could not load the replay (${r.status}).`);
  return r.text();
}
$id('btnDoLoad').onclick = async () => {
  $id('loadErr').textContent = '';
  try {
    const id = replayIdFrom($id('replayUrl').value) || replayIdFrom($id('pasteBox').value);
    const text = id ? await fetchReplay(id) : $id('pasteBox').value;
    await loadText(text); $id('loader').hidden = true; $id('pasteBox').value = ''; $id('replayUrl').value = '';
  } catch (e) { $id('loadErr').textContent = e.message || String(e); }
};
$id('btnSample').onclick = async () => { try { await loadText(await fetch('sample.json').then(r => r.text())); $id('loader').hidden = true; } catch (e) { $id('loadErr').textContent = e.message; } };
$id('btnCopy').onclick = async () => { try { await navigator.clipboard.writeText($id('exportBox').value); $id('copyMsg').textContent = 'Copied'; } catch { $id('exportBox').select(); $id('copyMsg').textContent = 'Press Ctrl+C to copy'; } };
$id('btnCloseExport').onclick = () => { $id('exporter').hidden = true; };
for (const m of ['loader', 'exporter']) $id(m).addEventListener('click', e => { if (e.target === $id(m)) $id(m).hidden = true; });

async function selftest() {
  const out = []; const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    out.push('at load: cur ' + S.cur + ' started ' + S.psb.started + ' turn ' + S.psb.turn + ' | picker: ' + $('#takeSec h3 span').first().text() + ' | lead marks ' + [...document.querySelectorAll('#takeSec .played')].map(b => b.textContent.trim()).join(','));
    // branch the leads: player 1 leads with something else
    [...document.querySelectorAll('#takeSec [data-c]:not(.played)')][0].click(); await wait(100);
    out.push('p2 lead q: ' + $('#takeSec h3 span').first().text());
    document.querySelector('#takeSec .played').click(); await wait(6000);
    out.push('lead branch: cur ' + S.cur + ' turn ' + S.psb.turn + ' err ' + S.err + ' | ' + $('.battle-log').text().slice(-140));
    go('r0', false); await wait(500);
    $('.replay-controls button[data-action=play]').click(); await wait(4000);
    out.push('play button: controls "' + $('.replay-controls').text().trim().slice(0, 12) + '" turn ' + S.psb.turn + ' paused ' + S.psb.paused + ' cur ' + S.cur);
    $('.replay-controls button[data-action=pause]').click(); await wait(300);
    out.push('pause button: controls "' + $('.replay-controls').text().trim().slice(0, 12) + '" paused ' + S.psb.paused);
    out.push('loaded: turn ' + S.psb.turn + ' cur ' + S.cur + ' sprite ' + ((document.querySelector('.battle img') || {}).src || 'none').slice(0, 70));
    go('r20', false); await wait(500);
    out.push('seek 20: ps turn ' + S.psb.turn + ' | ' + $('.battle-log').text().slice(-70));
    out.push('picker at 20: buttons ' + document.querySelectorAll('.rb-mv').length + ' played marks ' + [...document.querySelectorAll('.played')].map(b => b.dataset.p + ':' + b.textContent.trim().slice(0, 14)).join(', '));
    // follow the replay: each player picks what was played, one at a time
    for (let i = 0; i < 2; i++) { const b = document.querySelector('#takeSec .played'); if (b) b.click(); }
    await wait(6000);
    out.push('followed replay: cur ' + S.cur + ' psMode ' + S.psMode + ' paused ' + S.psb.paused + ' nodes ' + Object.keys(S.study.nodes).length);
    go('r20', false); await wait(500);
    out.push('guessed moves at 20: ' + [...document.querySelectorAll('#takeSec .rb-mv.guess')].map(b => b.textContent.trim().slice(0, 14)).join(', ') + ' | q: ' + $('#takeSec h3 span').first().text());
    // inline edit of a guessed move
    const ed = document.querySelector('#takeSec [data-edit]');
    if (ed) { const old = ed.dataset.edit; ed.click(); const inp = document.querySelector('.rb-mvinput'); inp.value = 'Low Kick'; inp.dispatchEvent(new Event('change')); await wait(300);
      out.push('edited ' + old + ' -> ' + [...document.querySelectorAll('#takeSec .rb-mv')].map(b => b.querySelector('b').textContent).join('/') + ' err ' + S.err); }
    // branch: player 1 picks something not played, then player 2 anything
    [...document.querySelectorAll('#takeSec .rb-mv:not(:disabled):not(.played)')][0].click(); await wait(100);
    out.push('after p1 pick, q: ' + $('#takeSec h3 span').first().text());
    [...document.querySelectorAll('#takeSec .rb-mv:not(:disabled)')][0].click(); await wait(6000);
    out.push('after play: ' + S.cur + ' rolls ' + document.querySelectorAll('.rb-roll').length + ' err ' + S.err + ' | ' + $('.battle-log').text().slice(-160));
    out.push('sprites: ' + [...document.querySelectorAll('.battle img')].map(i => (i.src || '').split('/').slice(-2).join('/')).slice(0, 6).join(' , '));
    const seg = document.querySelector('.rb-roll .rb-seg .button:not(.on)');
    if (seg) { seg.click(); await wait(5000); out.push('flipped -> ' + $('.battle-log').text().slice(-120)); }
    out.push('controls: ' + $('.replay-controls').text().slice(0, 120));
    $id('pickTog').click(); await wait(200);
    out.push('toggle off: buttons ' + document.querySelectorAll('.rb-mv').length + ' header ' + $('#takeSec h2').text());
    $id('pickTog').click(); await wait(200);
    out.push('toggle on: buttons ' + document.querySelectorAll('.rb-mv').length);
  } catch (e) { out.push('ERROR ' + e.stack); }
  const pre = document.createElement('pre'); pre.id = 'selftest'; pre.textContent = out.join('\n'); document.body.appendChild(pre);
}
window.addEventListener('error', e => { const p = document.getElementById('errlog') || Object.assign(document.body.appendChild(document.createElement('pre')), {id: 'errlog', hidden: true}); p.textContent += (e.message || e) + '\n'; });
boot().then(() => {
  if (location.hash === '#selftest') selftest();
  if (location.hash === '#perf') { const pre = document.createElement('pre'); pre.id = 'perf';
    const res = performance.getEntriesByType('resource').filter(r => r.duration > 50).map(r => r.name.split('/').slice(-2).join('/') + ' start ' + Math.round(r.startTime) + ' end ' + Math.round(r.responseEnd));
    pre.textContent = MARKS.join('\n') + '\nload event ' + Math.round(performance.getEntriesByType('navigation')[0]?.loadEventStart || 0) + '\n' + res.join('\n'); document.body.appendChild(pre); }
});
