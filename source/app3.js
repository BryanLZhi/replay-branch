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
function until(test, ms = 30000) {
  return new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let ok = false; try { ok = test(); } catch {} if (ok) res(); else if (Date.now() - t0 > ms) rej(new Error('Showdown did not load (check your connection).')); else setTimeout(tick, 100); }; tick(); });
}
async function boot() {
  try {
    E = await loadEngine();
    await until(() => window.Replays && Replays.battle && window.Battle && window.Dex);
    const txt = await fetch('sample.json').then(r => r.text());
    S.psb = Replays.battle; S.psMode = 'main';
    Replays.battle.subscribe(st => { Replays.update(st); onPS(); });   // Battle keeps one listener: feed the embed's controls too
    await loadText(txt, true);
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
  const rep = E.parseReplayInput(payload ? payload.log : t);
  S.rep = rep;
  S.key = rep.meta.id || ('log-' + hash(rep.lines.slice(0, 40).join('\n') + rep.lines.length));
  S.node.clear(); S.takeCache.clear();
  S.stats = null;
  try { const r = await fetch('stats/' + rep.formatid + '.json'); if (r.ok) S.stats = await r.json(); } catch {}
  S.cbEnd = E.clientAt(rep, rep.lastTurn + 1).cb;
  S.base = [S.cbEnd.p1, S.cbEnd.p2].map(side => side.team.map(p => E.suggestSet(E.knownOf(p), S.stats, rep.gen)));
  S.study = (payload && payload.study) || loadStored(S.key) || {rbv: 1, sets: null, nodes: {}, kids: {}, notes: {}, seq: 0};
  if (!S.study.sets || S.study.sets.length !== 2 || S.study.sets.some((s, i) => s.length !== S.base[i].length)) S.study.sets = clone(S.base);
  if (payload) save();
  S.take = null; S.sel = {}; S.tera = {};
  if (!first) S.psMode = '';
  S.cur = '';
  go('r1');
}

// ------------------------------------------------------------------ study tree model
const isMain = id => id[0] === 'r';
const mainT = id => +id.slice(1);
function parentOf(id) { if (isMain(id)) { const t = mainT(id); return t > 1 ? 'r' + (t - 1) : null; } return S.study.nodes[id]?.parent || null; }
function kids(id) { return S.study.kids[id] || []; }
function childrenOf(id) { if (isMain(id)) { const t = mainT(id); const k = kids(id).slice(); if (t <= S.rep.lastTurn) k.unshift('r' + (t + 1)); return k; } return kids(id); }
function pathTo(id) { const p = []; let n = id; while (n && !isMain(n)) { p.unshift(n); n = S.study.nodes[n].parent; } return p; }
function takeoverFor(t, sets) {
  const k = t + ':' + hash(JSON.stringify(sets));
  if (!S.takeCache.has(k)) { const r = E.takeover(S.rep, t, sets, TAKE_SEED); S.takeCache.set(k, {json: E.serialize(r.battle), battle: r.battle, notes: r.notes}); }
  return S.takeCache.get(k);
}
function compute(id) {
  if (S.node.has(id)) return S.node.get(id);
  const n = S.study.nodes[id];
  const pj = isMain(n.parent) ? takeoverFor(mainT(n.parent), n.sets).json : compute(n.parent).json;
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
  if (S.psMode === 'main' && !S.take) {
    const b = S.psb;
    const t = b.ended ? S.rep.lastTurn + 1 : Math.max(1, Math.min(b.turn, S.rep.lastTurn + 1));
    const id = 'r' + t;
    if (id !== S.cur) { S.cur = id; S.sel = {}; S.tera = {}; renderPanels(); }
  }
}
function showPosition(animate) {
  S.lock = true;
  try {
    if (isMain(S.cur)) {
      if (S.psMode !== 'main') { newPS(S.rep.lines); S.psMode = 'main'; }
      const t = mainT(S.cur);
      if (t > S.rep.lastTurn) S.psb.seekTurn(Infinity); else S.psb.seekTurn(t);
    } else {
      const path = pathTo(S.cur);
      const t0 = mainT(S.study.nodes[path[0]].parent);
      const prefix = S.rep.lines.slice(0, S.rep.turnIdx[t0] + 1);
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
function posLabel() {
  if (isMain(S.cur)) {
    const t = mainT(S.cur);
    if (S.take && S.take.t === t) return `<b>Taking over</b> at the start of turn ${t}`;
    return t > S.rep.lastTurn ? 'Replay: end of the battle' : `Replay: start of turn ${t}`;
  }
  const r = compute(S.cur); const root = S.study.nodes[pathTo(S.cur)[0]];
  return `<b>Your line</b> from turn ${mainT(root.parent)}: now turn ${r.battle.turn}${r.battle.ended ? ', battle over' : ''}`;
}
function curBattle() {
  if (S.take && isMain(S.cur) && S.take.t === mainT(S.cur)) { const tk = takeoverFor(S.take.t, S.study.sets); return {kind: 'take', t: S.take.t, battle: tk.battle, notes: tk.notes}; }
  if (isMain(S.cur)) return {kind: 'main', t: mainT(S.cur)};
  const r = compute(S.cur); return {kind: 'branch', battle: r.battle, rolls: r.rolls};
}
function renderTake(pos) {
  const el = $id('takeSec');
  const navBtns = `<span style="float:right"><button class="button" id="tbPrev" title="Back along the study (←)"><i class="fa fa-chevron-left" aria-hidden="true"></i></button> <button class="button" id="tbNext" title="Forward along the study (→)"><i class="fa fa-chevron-right" aria-hidden="true"></i></button></span>`;
  if (pos.kind === 'main') {
    const t = pos.t;
    const doubles = S.rep.lines.some(l => l === '|gametype|doubles' || l === '|gametype|triples');
    const n = kids(S.cur).length;
    el.innerHTML = `${navBtns}<h2>${t > S.rep.lastTurn ? 'End of the replay' : `Turn ${t}`}</h2>
      ${t > S.rep.lastTurn ? '' : `
      <p class="rb-row"><button class="button" id="btnTake" ${doubles ? 'disabled' : ''}><strong>Take over at turn ${t}</strong></button>
      ${doubles ? '<span class="rb-note">Singles only for now.</span>' : ''}</p>`}`;
    const b = $id('btnTake'); if (b) b.onclick = () => { S.take = {t}; S.sel = {}; S.tera = {}; renderPanels(); renderControls(); };
  } else {
    const battle = pos.battle;
    if (battle.ended) {
      el.innerHTML = `${navBtns}<h2>${battle.winner ? esc(battle.winner) + ' won' : 'Tie'}</h2>`;
    } else {
      const sides = battle.sides.map((s, si) => ({si, s, req: s.activeRequest}));
      const need = sides.filter(x => x.req && !x.req.wait);
      const html = sides.map(({si, s, req}) => {
        const pid = 'p' + (si + 1);
        let body = '';
        if (!req || req.wait) body = '';
        else {
          const act = req.active && req.active[0];
          const forced = req.forceSwitch && req.forceSwitch[0];
          if (!forced && act) {
            body += `<div class="rb-moves">${act.moves.map((m, i) => {
              const mv = E.Dex.moves.get(m.id || m.move); const ch = `move ${i + 1}`;
              return `<button type="button" class="rb-mv t-${esc(mv.type || 'Normal')} ${S.sel[pid] === ch ? 'on' : ''}" data-p="${pid}" data-c="${ch}" ${m.disabled || m.pp === 0 ? 'disabled' : ''}
                title="${esc(`${mv.category}${mv.basePower ? ', ' + mv.basePower + ' BP' : ''}, ${mv.accuracy === true ? 'never misses' : mv.accuracy + '% accuracy'}${mv.shortDesc ? '\n' + mv.shortDesc : ''}`)}"><b>${esc(m.move)}</b><small><span>${esc(mv.type || '')}</span><span>${m.maxpp ? `${m.pp}/${m.maxpp}` : ''}</span></small></button>`;
            }).join('')}</div>`;
            if (act.canTerastallize) body += `<p class="rb-row" style="margin-top:6px"><label><input type="checkbox" data-tera="${pid}" ${S.tera[pid] ? 'checked' : ''}> Terastallize</label> ${typeTag(act.canTerastallize)}</p>`;
          }
          const trapped = act && act.trapped && !forced;
          body += `<div class="rb-switches">${req.side.pokemon.map((p, k) => {
            if (p.active && !forced) return '';
            const name = p.ident.replace(/^p\d: /, ''); const fnt = /fnt/.test(p.condition);
            const hp = p.condition.split(' ')[0].split('/'); const pct = fnt ? 0 : Math.round(+hp[0] / +hp[1] * 100);
            const ch = `switch ${k + 1}`;
            return `<button type="button" class="button rb-sw ${S.sel[pid] === ch ? 'on' : ''}" data-p="${pid}" data-c="${ch}" ${fnt || p.active || trapped ? 'disabled' : ''}><span class="rb-picon" style="${iconStyle(p.details.split(',')[0])}"></span>${esc(name)} <small>${pct}%</small></button>`;
          }).join('')}</div>`;
          
        }
        return `<div class="rb-pside"><h3><span>${esc(s.name)}</span><span class="rb-note">${esc(S.sel[pid] ? describeChoice(s, S.sel[pid]) : '')}</span></h3>${body}</div>`;
      }).join('');
      const ready = need.every(x => S.sel['p' + (x.si + 1)]);
      el.innerHTML = `${navBtns}<h2>Turn ${pos.battle.turn}</h2>
        <div class="rb-choose">${html}</div>
        <p class="rb-row"><button class="button" id="btnPlay" ${ready ? '' : 'disabled'}><strong>Play turn</strong></button>
        ${pos.kind === 'take' ? `<button class="button" id="btnBack">Back to the replay</button>` : ''}
        </p>
        ${S.err ? `<p class="rb-err">${esc(S.err)}</p>` : ''}`;
      for (const b of el.querySelectorAll('[data-c]')) b.onclick = () => { S.sel[b.dataset.p] = b.dataset.c; S.err = ''; renderTake(curBattle()); };
      for (const c of el.querySelectorAll('[data-tera]')) c.onchange = () => { S.tera[c.dataset.tera] = c.checked; };
      $id('btnPlay').onclick = () => playTurn(pos);
      const bb = $id('btnBack'); if (bb) bb.onclick = () => { S.take = null; renderPanels(); renderControls(); };
    }
  }
  $id('tbPrev').onclick = () => nav('prev'); $id('tbNext').onclick = () => nav('next');
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
  const parent = pos.kind === 'take' ? 'r' + pos.t : S.cur;
  let id = kids(parent).find(k => JSON.stringify(S.study.nodes[k].choices) === JSON.stringify(choices) && !(S.study.nodes[k].forced || []).length);
  const existed = !!id;
  try {
    if (!id) { id = addNode(parent, choices, [], newSeed(), pos.kind === 'take' ? clone(S.study.sets) : undefined); compute(id); }
  } catch (e) { if (id && !existed) { deleteNode(id); save(); } S.err = e.message || String(e); renderTake(pos); return; }
  S.take = null; S.sel = {}; S.tera = {}; S.err = '';
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
    <p class="rb-row"><button class="button" id="btnReroll"><i class="fa fa-random" aria-hidden="true"></i> Reroll everything</button>
    <button class="button" id="btnDefaults" ${node.forced && node.forced.length ? '' : 'disabled'}>Most likely outcomes</button></p>`;
  for (const c of el.querySelectorAll('[data-roll]')) {
    c[c.tagName === 'SELECT' ? 'onchange' : 'onclick'] = () => {
      const i = +c.dataset.roll; const r = rolls[i];
      const v = r.kind === 'chance' ? c.dataset.v === '1' : r.kind === 'order' ? JSON.parse(c.dataset.v || c.value) : +c.value;
      const forced = rolls.map(x => ({key: x.key, value: x.value})); forced[i] = {key: r.key, value: v};
      setForced(forced, node.seed);
    };
  }
  $id('btnReroll').onclick = () => setForced([], newSeed());
  $id('btnDefaults').onclick = () => setForced([], node.seed);
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
  rows.push(`<div class="rb-mrow start ${S.cur === 'r1' ? 'cur' : ''}" data-go="r1"><div class="no">0</div><div class="a">Start: leads sent out</div></div>`);
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
  if (isMain(id) && (mainT(id) < 1 || mainT(id) > S.rep.lastTurn + 1)) return;
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
    $('.replay-controls button[data-action=play]').click(); await wait(4000);
    out.push('play button: controls "' + $('.replay-controls').text().trim().slice(0, 12) + '" turn ' + S.psb.turn + ' paused ' + S.psb.paused + ' cur ' + S.cur);
    $('.replay-controls button[data-action=pause]').click(); await wait(300);
    out.push('pause button: controls "' + $('.replay-controls').text().trim().slice(0, 12) + '" paused ' + S.psb.paused);
    out.push('loaded: turn ' + S.psb.turn + ' cur ' + S.cur + ' sprite ' + ((document.querySelector('.battle img') || {}).src || 'none').slice(0, 70));
    go('r20', false); await wait(500);
    out.push('seek 20: ps turn ' + S.psb.turn + ' | ' + $('.battle-log').text().slice(-70));
    $id('btnTake').click();
    [...document.querySelectorAll('.rb-mv:not(:disabled)')].find(b => b.dataset.p === 'p1').click();
    [...document.querySelectorAll('.rb-mv:not(:disabled)')].find(b => b.dataset.p === 'p2').click();
    $id('btnPlay').click(); await wait(6000);
    out.push('after play: ' + S.cur + ' rolls ' + document.querySelectorAll('.rb-roll').length + ' err ' + S.err + ' | ' + $('.battle-log').text().slice(-160));
    out.push('sprites: ' + [...document.querySelectorAll('.battle img')].map(i => (i.src || '').split('/').slice(-2).join('/')).slice(0, 6).join(' , '));
    const seg = document.querySelector('.rb-roll .rb-seg .button:not(.on)');
    if (seg) { seg.click(); await wait(5000); out.push('flipped -> ' + $('.battle-log').text().slice(-120)); }
    out.push('controls: ' + $('.replay-controls').text().slice(0, 120));
  } catch (e) { out.push('ERROR ' + e.stack); }
  const pre = document.createElement('pre'); pre.id = 'selftest'; pre.textContent = out.join('\n'); document.body.appendChild(pre);
}
window.addEventListener('error', e => { const p = document.getElementById('errlog') || Object.assign(document.body.appendChild(document.createElement('pre')), {id: 'errlog', hidden: true}); p.textContent += (e.message || e) + '\n'; });
boot().then(() => { if (location.hash === '#selftest') selftest(); });
