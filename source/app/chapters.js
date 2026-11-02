// Studies of several replays, as lichess studies have chapters: each chapter is a replay's own study (rbv:<key>, as it is),
// with a title of its own when given one. A study is kept as rbs:<id>; the address ?c=<id>&r=<key> shows a chapter of it.
// Here: the chapter bar over the viewer and its chapter list, the Add to study menu, the Studies list on the landing
// page, and a link that shares a whole study.
import {S, E, $id, esc, hash, stored, store, unstore} from './state.js';
import {loadSaved} from './study.js';
import {isFresh} from './replay.js';
import {cleanCollection, cleanStudyLink, cleanChapterStudy, MAX_CHAPTERS, CHAPTER_KEY} from './clean.js';
import {route, fetchReplay, replayKey, sharedKey} from './load.js';
import {ago} from './landing.js';

const ID = /^[a-z0-9]{1,16}$/;
const newId = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);

export function loadCollection(id) {
  if (!ID.test(id || '')) return null;
  try { const raw = JSON.parse(stored('rbs:' + id, 'null')); return raw ? cleanCollection(raw) : null; } catch { return null; }
}
const saveCollection = (id, st) => store('rbs:' + id, JSON.stringify(st));

function allCollections() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const st = k.startsWith('rbs:') && loadCollection(k.slice(4));
      if (st) out.push({id: k.slice(4), ...st});
    }
  } catch {}
  return out.sort((a, b) => (b.opened || 0) - (a.opened || 0));
}

// The study in the address (?c=), if it is one kept here.
export function studyInAddress() {
  const id = new URLSearchParams(location.search).get('c');
  return ID.test(id || '') ? id : null;
}
const chapterUrl = (id, key) => `?c=${id}` + (key ? '&r=' + encodeURIComponent(key) : '');
function visitChapter(id, key) {
  closePops();
  history.pushState(null, '', chapterUrl(id, key));
  route();
}
// ?c=<id> alone: the chapter last opened (its key; the address then says it).
export function startOfStudy(id) {
  const st = loadCollection(id);
  if (!st?.chapters.length) throw new Error('Study not found.');
  const key = st.last || st.chapters[0].key;
  history.replaceState(null, '', chapterUrl(id, key));
  return key;
}

// What a study keeps of a chapter not on the replay site ({log, teams}), the study in the address first.
export function keptChapter(key) {
  const id = studyInAddress();
  for (const st of [id && loadCollection(id), ...allCollections()]) {
    const ch = st?.chapters.find(c => c.key === key && c.log);
    if (ch) return {log: ch.log, teams: ch.teams || null};
  }
  return null;
}
// This replay as a chapter: with its log when it is not on the replay site, and a new battle with its teams.
const thisChapter = () => S.study?.meta?.replayId || !S.study?.meta?.log ? {key: S.key}
  : {key: S.key, log: S.study.meta.log, ...(isFresh(S.rep) ? {teams: S.study.sets} : {})};

// A chapter goes by its own title, else the replay's study name, else format and players.
function chapterTitle(ch) {
  if (ch.title) return ch.title;
  const saved = loadSaved(ch.key), meta = saved?.meta || {};
  if (typeof saved?.name === 'string' && saved.name.trim()) return saved.name.trim().slice(0, 80);
  const players = (Array.isArray(meta.players) ? meta.players : []).filter(p => typeof p === 'string' && p).join(' vs. ');
  return [typeof meta.format === 'string' ? meta.format : '', players].filter(Boolean).join(' · ') || ch.key;
}

// ---------------------------------------------------------------- the chapter bar (viewer)
let menuOpen = false, editing = null, removeArmed = -1;   // editing: 'name' or a chapter's index

// (key: the replay shown, or about to be)
export function renderChapterBar(key = S.key) {
  const bar = $id('chapBar');
  const id = studyInAddress(), st = id && loadCollection(id);
  const i = st && key ? st.chapters.findIndex(ch => ch.key === key) : -1;
  if (i < 0) { bar.hidden = true; bar.innerHTML = ''; menuOpen = false; return; }
  st.last = key; st.opened = Date.now(); saveCollection(id, st);
  const n = st.chapters.length;
  bar.hidden = false;
  bar.innerHTML = `<button type="button" class="button" id="chapPrev" title="Previous chapter" aria-label="Previous chapter" ${i ? '' : 'disabled'}><i class="fa fa-chevron-left" aria-hidden="true"></i></button>` +
    `<div class="rb-popwrap rb-chapwrap"><button type="button" class="button rb-chapbtn" id="chapMenuBtn" aria-haspopup="true" aria-expanded="${menuOpen}">` +
    `<i class="fa fa-book" aria-hidden="true"></i><strong>${esc(st.name)}</strong><span class="rb-chapno">Chapter ${i + 1} / ${n}</span>` +
    `<span class="rb-chaptitle">${esc(chapterTitle(st.chapters[i]))}</span><i class="fa fa-caret-down" aria-hidden="true"></i></button>` +
    `<div class="rb-pop" id="chapMenu" ${menuOpen ? '' : 'hidden'}></div></div>` +
    `<button type="button" class="button" id="chapNext" title="Next chapter" aria-label="Next chapter" ${i < n - 1 ? '' : 'disabled'}><i class="fa fa-chevron-right" aria-hidden="true"></i></button>`;
  $id('chapPrev').onclick = () => visitChapter(id, st.chapters[i - 1].key);
  $id('chapNext').onclick = () => visitChapter(id, st.chapters[i + 1].key);
  $id('chapMenuBtn').onclick = e => {
    e.stopPropagation();
    const open = !menuOpen;
    closePops(); menuOpen = open; renderChapterBar();
  };
  if (menuOpen) renderChapterMenu(id, st, i);
}

function renderChapterMenu(id, st, i) {
  const menu = $id('chapMenu'), n = st.chapters.length;
  const tool = (attr, j, title, icon, off = false) =>
    `<button type="button" class="rb-linkbtn" ${attr}="${j}" title="${title}" aria-label="${title}" ${off ? 'disabled' : ''}>${icon}</button>`;
  menu.innerHTML = `<div class="rb-pophead">` + (editing === 'name'
    ? `<input class="textbox" id="studyRename" maxlength="80" value="${esc(st.name)}" aria-label="Study name">`
    : `<strong>${esc(st.name)}</strong>${tool('data-rename-study', 0, 'Rename study', '<i class="fa fa-pencil" aria-hidden="true"></i>')}`) +
    `<button type="button" class="button" id="btnShareStudy">Share</button></div>` +
    st.chapters.map((ch, j) => `<div class="rb-chap ${j === i ? 'cur' : ''}">` + (editing === j
      ? `<input class="textbox" id="chapRename" maxlength="80" value="${esc(ch.title || '')}" placeholder="${esc(chapterTitle({key: ch.key}))}" aria-label="Chapter title">`
      : `<button type="button" class="rb-fitem" data-chapter="${j}"><span class="rb-chapn">${j + 1}</span>${esc(chapterTitle(ch))}</button>`) +
      `<span class="rb-chaptools">${tool('data-up', j, 'Move up', '<i class="fa fa-caret-up" aria-hidden="true"></i>', !j)}` +
      tool('data-down', j, 'Move down', '<i class="fa fa-caret-down" aria-hidden="true"></i>', j === n - 1) +
      tool('data-retitle', j, 'Rename chapter', '<i class="fa fa-pencil" aria-hidden="true"></i>') +
      (n > 1 ? tool('data-remove', j, 'Remove chapter', removeArmed === j ? 'Remove?' : '<i class="fa fa-times" aria-hidden="true"></i>') : '') + `</span></div>`).join('');
  const redo = () => renderChapterBar();
  const change = f => { f(); saveCollection(id, st); redo(); };
  menu.onclick = e => e.stopPropagation();
  for (const b of menu.querySelectorAll('[data-chapter]')) b.onclick = () => visitChapter(id, st.chapters[+b.dataset.chapter].key);
  for (const b of menu.querySelectorAll('[data-up], [data-down]')) b.onclick = () => change(() => {
    const j = +(b.dataset.up ?? b.dataset.down), k = b.dataset.up !== undefined ? j - 1 : j + 1;
    [st.chapters[j], st.chapters[k]] = [st.chapters[k], st.chapters[j]];
    removeArmed = -1;
  });
  for (const b of menu.querySelectorAll('[data-retitle]')) b.onclick = () => { editing = +b.dataset.retitle; removeArmed = -1; redo(); };
  for (const b of menu.querySelectorAll('[data-rename-study]')) b.onclick = () => { editing = 'name'; removeArmed = -1; redo(); };
  for (const b of menu.querySelectorAll('[data-remove]')) b.onclick = () => {
    const j = +b.dataset.remove;
    if (removeArmed !== j) { removeArmed = j; redo(); return; }
    removeArmed = -1;
    const [gone] = st.chapters.splice(j, 1);   // (the replay's own study stays, in Recent)
    saveCollection(id, st);
    if (gone.key === S.key) visitChapter(id, st.chapters[Math.min(j, st.chapters.length - 1)].key); else redo();
  };
  const input = $id('studyRename') || $id('chapRename');
  if (input) {
    input.focus(); input.select();
    let done = false;
    const finish = keep => {
      if (done) return; done = true;
      const v = input.value.trim().slice(0, 80);
      if (keep && editing === 'name') { if (v) st.name = v; }
      else if (keep) { const ch = st.chapters[editing]; if (v) ch.title = v; else delete ch.title; }
      editing = null;
      if (keep) saveCollection(id, st);
      redo();
    };
    input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    input.onblur = () => finish(true);
  }
  $id('btnShareStudy').onclick = () => shareStudy(st);
}

// ---------------------------------------------------------------- Add to study (header)
function renderAddMenu() {
  const menu = $id('addMenu'), list = allCollections(), ok = CHAPTER_KEY.test(S.key || '');
  menu.innerHTML = list.map(s => {
    const has = s.chapters.some(ch => ch.key === S.key);
    return `<button type="button" class="rb-fitem rb-additem" data-add="${s.id}" ${ok && (has || s.chapters.length < MAX_CHAPTERS) ? '' : 'disabled'}>` +
      `<i class="fa fa-${has ? 'check' : 'plus'}" aria-hidden="true"></i><span class="rb-addname">${esc(s.name)}</span><small>${s.chapters.length}</small></button>`;
  }).join('') +
    `<form class="rb-popnew" id="newStudyForm"><input class="textbox" id="newStudyName" maxlength="80" placeholder="New study" aria-label="New study name">` +
    `<button type="submit" class="button" ${ok ? '' : 'disabled'}>Create</button></form>`;
  for (const b of menu.querySelectorAll('[data-add]')) b.onclick = () => {
    const id = b.dataset.add, st = loadCollection(id);
    if (!st) return;
    if (!st.chapters.some(ch => ch.key === S.key)) { st.chapters.push(thisChapter()); saveCollection(id, st); }
    visitChapter(id, S.key);
  };
  $id('newStudyForm').onsubmit = e => {
    e.preventDefault();
    const id = newId(), name = $id('newStudyName').value.trim().slice(0, 80) || `Study ${list.length + 1}`;
    saveCollection(id, {name, chapters: [thisChapter()], last: S.key, opened: Date.now()});
    visitChapter(id, S.key);
  };
}

function closePops() {
  $id('addMenu').hidden = true; $id('btnAddStudy').setAttribute('aria-expanded', 'false');
  if (menuOpen) { menuOpen = false; editing = null; removeArmed = -1; $id('chapMenu')?.setAttribute('hidden', ''); $id('chapMenuBtn')?.setAttribute('aria-expanded', 'false'); }
}

export function wireChapters() {
  $id('btnAddStudy').onclick = e => {
    e.stopPropagation();
    const open = $id('addMenu').hidden;
    closePops();
    if (!open || !S.rep) return;
    renderAddMenu(); $id('addMenu').hidden = false; $id('btnAddStudy').setAttribute('aria-expanded', 'true');
    $id('newStudyName').focus();
  };
  $id('addMenu').onclick = e => e.stopPropagation();
  document.addEventListener('click', e => { if (!e.target.closest('.rb-popwrap')) closePops(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // (the focus goes back to the button that opened the menu)
    const back = !$id('addMenu').hidden ? $id('btnAddStudy') : menuOpen ? $id('chapMenuBtn') : null;
    closePops(); back?.focus();
  });
  const modal = $id('studySharer');
  $id('btnCopyStudyLink').onclick = async () => {
    try { await navigator.clipboard.writeText($id('studyLink').value); $id('studyCopyMsg').textContent = 'Link copied'; }
    catch { $id('studyLink').select(); $id('studyCopyMsg').textContent = 'Press Ctrl+C to copy'; }
  };
  $id('btnCloseStudyShare').onclick = () => { modal.hidden = true; };
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.hidden = true; });
}

// ---------------------------------------------------------------- Studies (landing page)
let landingEdit = null, landingRemove = null;
export function renderStudies() {
  const list = allCollections(), box = $id('studies');
  $id('studiesSec').hidden = !list.length;
  box.innerHTML = list.map(s => {
    const n = s.chapters.length;
    const details = `${n} chapter${n === 1 ? '' : 's'}${s.shared ? ' · shared with you' : ''}${s.opened ? ' · ' + ago(s.opened) : ''}`;
    if (landingEdit === s.id) return `<div class="blocklink"><span><small>${details}</small><br>` +
      `<input class="textbox" id="studyRenameHome" maxlength="80" value="${esc(s.name)}" aria-label="Study name"></span></div>`;
    return `<a class="blocklink" href="${chapterUrl(s.id, s.last || s.chapters[0]?.key)}" data-study="${s.id}"><span><small>${details}</small><br><strong>${esc(s.name)}</strong></span>` +
      `<span class="rb-acts"><button type="button" class="rb-linkbtn" data-rename-home="${s.id}">Rename</button>` +
      `<button type="button" class="rb-linkbtn" data-remove-home="${s.id}">${landingRemove === s.id ? 'Remove for good?' : 'Remove'}</button></span></a>`;
  }).join('');
  for (const a of box.querySelectorAll('[data-study]')) a.onclick = e => {
    if (e.target.closest('button') || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    const st = loadCollection(a.dataset.study);
    if (st?.chapters.length) visitChapter(a.dataset.study, st.last || st.chapters[0].key);
  };
  for (const b of box.querySelectorAll('[data-rename-home]')) b.onclick = e => { e.preventDefault(); landingEdit = b.dataset.renameHome; landingRemove = null; renderStudies(); };
  for (const b of box.querySelectorAll('[data-remove-home]')) b.onclick = e => {
    e.preventDefault();
    if (landingRemove === b.dataset.removeHome) { unstore('rbs:' + b.dataset.removeHome); landingRemove = null; } else landingRemove = b.dataset.removeHome;
    renderStudies();
  };
  const input = $id('studyRenameHome');
  if (input) {
    input.focus(); input.select();
    let done = false;
    const finish = keep => {
      if (done) return; done = true;
      const st = loadCollection(landingEdit), v = input.value.trim().slice(0, 80);
      if (keep && st && v) { st.name = v; saveCollection(landingEdit, st); }
      landingEdit = null; renderStudies();
    };
    input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
  }
}

// ---------------------------------------------------------------- a study's link (#c=)
// As a single study's link: JSON, deflated, base64url.
async function pack(payload) {
  const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function unpack(data) {
  const bytes = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const text = await new Response(stream).text();
  if (text.length > 64e6) throw new Error('This study link is too large.');
  return JSON.parse(text);
}

// Every chapter's study, with its replay's id, or its log when it has none on the replay site (a new battle, a pasted
// log, a private replay: its id holds its password).
async function shareStudy(st) {
  closePops();
  const chapters = [], left = [];
  for (const ch of st.chapters) {
    const saved = loadSaved(ch.key), meta = saved?.meta || {};
    const kept = typeof meta.log === 'string' ? meta.log : ch.log || null;
    let id = typeof meta.replayId === 'string' ? meta.replayId : !kept && !ch.key.startsWith('log-') ? ch.key.split('~')[0] : null;
    let log = id ? null : kept;
    if (id && /pw$/.test(id)) { try { log = E.parseReplayInput(await fetchReplay(id)).lines.join('\n'); } catch {} id = null; }
    if (!id && !log) { left.push(chapterTitle(ch)); continue; }
    const study = saved ? {...saved, meta: undefined, opened: undefined} : ch.teams ? {sets: ch.teams} : undefined;
    chapters.push({...(ch.title ? {title: ch.title} : {}), study, ...(id ? {id} : {log})});
  }
  $id('studyLink').value = location.origin + location.pathname + '#c=' + await pack({rbv: 1, name: st.name, chapters});
  $id('studyCopyMsg').textContent = left.length ? 'Not included: ' + left.join(', ') : '';
  $id('studySharer').hidden = false;
  $id('btnCopyStudyLink').focus();   // (so Esc closes it)
}

// Open a study's link: its chapters are kept beside your own work, as a single study's link keeps them (sharedKey), and
// the study is added to yours (the same link opens the same copy again). Returns the chapter to show.
export async function openSharedStudy() {
  const m = /^#c=([\w-]+)$/.exec(location.hash);
  if (!m) throw new Error('Not a study link.');
  const id = 's' + hash(m[1]);
  if (!loadCollection(id)) {
    const link = cleanStudyLink(await unpack(m[1]));
    const texts = new Map(), ids = [...new Set(link.chapters.map(ch => ch.id).filter(Boolean))];
    await Promise.all(Array.from({length: 6}, async () => {
      while (ids.length) { const rid = ids.shift(); try { texts.set(rid, await fetchReplay(rid)); } catch {} }
    }));
    const chapters = [];
    for (const ch of link.chapters) {
      const text = ch.id ? texts.get(ch.id) : ch.log;
      let rep;
      try { rep = E.parseReplayInput(text); } catch { continue; }
      const key = sharedKey(replayKey(rep), ch.study);
      if (!CHAPTER_KEY.test(key) || chapters.some(c => c.key === key)) continue;
      const players = [1, 2].map(p => (rep.lines.find(l => l.startsWith(`|player|p${p}|`)) || '').split('|')[3] || '');
      store('rbv:' + key, JSON.stringify({...cleanChapterStudy(ch.study),
        meta: {format: rep.tier || rep.formatid, players, ...(ch.id ? {replayId: ch.id} : {log: rep.lines.join('\n')}), shared: true}}));
      const kept = cleanChapterStudy(ch.study);
      chapters.push({key, ...(ch.title ? {title: ch.title} : {}), ...(ch.id ? {} : {log: rep.lines.join('\n'), ...(isFresh(rep) ? {teams: kept.sets} : {})})});
    }
    if (!chapters.length) throw new Error('Could not open the study (its replays may be private or deleted).');
    saveCollection(id, {name: link.name, chapters, last: chapters[0].key, opened: Date.now(), shared: true});
  }
  return startOfStudy(id);
}
