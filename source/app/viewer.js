// The Showdown replay viewer (replay-embed.js builds it; we drive Replays.battle).
// Replay positions seek the replay's own battle; a line gets a fresh battle fed the replay up to where the line starts,
// then the line's protocol, so it plays exactly like a real replay.
import {S, $id, esc, clearPicks} from './state.js';
import {isReplayPos, replayTurn, pathTo, compute, save} from './study.js';
import {startIndex, playerName} from './replay.js';
import {renderPanels, go, step} from './navigation.js';
import {pickerOn, setPicker} from './picker.js';

const FADE = {hyperfast: 40, fast: 50, normal: 300, slow: 500, reallyslow: 1000};
const DELAY = {hyperfast: 1, fast: 1, normal: 1, slow: 1000, reallyslow: 3000};

export const isPlaying = () => !!(S.psb && !S.psb.paused && !S.psb.atQueueEnd);

// Called once the embed has built its viewer.
export function attachToEmbed() {
  fixEffectUrls();
  // Showdown's Last turn / Next turn / Reset walk the study (your lines included) rather than the raw log.
  Replays.rewind = () => step('prev');
  Replays.ff = () => step('next');
  Replays.reset = () => go('r0');
  const settings = Replays.$('.replay-controls-2');
  settings.append('<div class="chooser pickerchooser"> <em>Move&nbsp;picker:</em> <div><button value="on">On</button><button value="off">Off</button></div> </div>');
  settings.find('.pickerchooser button').on('click', e => { e.preventDefault(); e.stopPropagation(); setPicker(e.currentTarget.value === 'on'); });
  showPickerSetting();
  // (the embed follows the system's dark mode without showing it in its Color scheme setting)
  const dark = document.body.classList.contains('dark');
  Replays.$('.colorchooser button').each((_, b) => { b.classList.toggle('sel', (b.value === 'dark') === dark); });
  S.psb = Replays.battle; S.psMode = 'main';
  listen(S.psb);
}

// battle-animations.js only prefixes its effect images with Dex.fxPrefix if Dex existed when it ran, which the
// embed's load order does not guarantee; unprefixed paths 404 and moves animate without their effects.
function fixEffectUrls() {
  if (!window.BattleEffects || !Dex.fxPrefix) return;
  for (const e of Object.values(BattleEffects)) if (e && e.url && !/^(https?:)?\/\//.test(e.url)) e.url = Dex.fxPrefix + e.url;
}

export function showPickerSetting() {
  const on = pickerOn();
  Replays.$('.pickerchooser button').each((_, b) => { b.classList.toggle('sel', (b.value === 'on') === on); });
}

// A Battle keeps a single listener, so ours also forwards to the embed's controls.
function listen(battle) { battle.subscribe(state => { Replays.update(state); onBattleEvent(state); }); }

function newBattle(lines) {
  const old = Replays.battle;
  const switched = old && old.viewpointSwitched;
  try { old.destroy(); } catch {}
  Replays.$('.battle').empty(); Replays.$('.battle-log').empty();
  const b = new Battle({id: S.key, $frame: Replays.$('.battle'), $logFrame: Replays.$('.battle-log'), log: lines, isReplay: true, paused: true, autoresize: true});
  const speed = Replays.$('.speedchooser button.sel').val() || 'normal';
  b.messageShownTime = DELAY[speed]; b.messageFadeTime = FADE[speed];
  b.scene.updateAcceleration();
  b.setMute(!!Replays.muted);
  if (switched) b.switchViewpoint();
  Replays.battle = b; S.psb = b;
  listen(b);
  Replays.update();
}

// While the replay plays, keep the study in step with it. A line pauses once it has played out (a replay's battle
// would wait for more of the log), so the controls show Play again.
function onBattleEvent(state) {
  if (S.seeking) return;
  if (S.psMode !== 'main') { if (state === 'atqueueend' && !S.psb.paused) S.psb.pause(); return; }
  const b = S.psb;
  if (S.stopAt && b.turn >= S.stopAt) { S.stopAt = null; b.pause(); }
  const t = b.ended ? S.rep.lastTurn + 1 : Math.min(b.turn, S.rep.lastTurn + 1);
  const playing = isPlaying();
  if ('r' + t !== S.cur) { S.cur = 'r' + t; clearPicks(); renderPanels(); }
  else if (playing !== S.wasPlaying) renderPanels();
  S.wasPlaying = playing;
}

// Show S.cur in the viewer; with animate, a line's last step plays out instead of appearing at once.
export function showPosition(animate) {
  S.seeking = true;
  try {
    if (isReplayPos(S.cur)) {
      if (S.psMode !== 'main') { newBattle(S.rep.lines); S.psMode = 'main'; }
      const t = replayTurn(S.cur);
      if (t === 0) S.psb.reset(); else S.psb.seekTurn(t > S.rep.lastTurn ? Infinity : t);
    } else {
      const path = pathTo(S.cur);
      const from = replayTurn(S.study.nodes[path[0]].parent);
      const replayPart = S.rep.lines.slice(0, from === 0 ? startIndex() : S.rep.turnIdx[from] + 1);
      const earlier = path.slice(0, -1).flatMap(id => compute(id).lines);
      const last = compute(S.cur).lines;
      S.psMode = 'line:' + S.cur;
      newBattle(animate ? replayPart.concat(earlier) : replayPart.concat(earlier, last));
      S.psb.seekTurn(Infinity);
      if (animate) { for (const l of last) S.psb.add(l); S.psb.play(); }
    }
  } finally { S.seeking = false; }
  showTitle();
}

// The study's name (when it has one) over the format and players; the pencil renames it.
function showTitle() {
  const name = S.study?.name, who = `${esc(playerName(0))} vs. ${esc(playerName(1))}`, format = esc(S.rep.tier || S.rep.formatid);
  $id('rbTitle').innerHTML = (name ? `<strong>${esc(name)}</strong><br><small class="rb-sub">${format} · ${who}</small>` : `<strong>${format}</strong><br>${who}`) +
    (isReplayPos(S.cur) ? '' : ' <span class="rb-mode">Your line</span>') +
    ` <button type="button" class="rb-linkbtn rb-rename" id="btnRename" title="Name this study" aria-label="Name this study"><i class="fa fa-pencil" aria-hidden="true"></i></button>`;
  $id('btnRename').onclick = rename;
}
function rename() {
  const title = $id('rbTitle');
  title.innerHTML = `<input class="textbox rb-nameinput" id="studyName" maxlength="80" placeholder="${esc(S.rep.tier || S.rep.formatid)}" value="${esc(S.study.name || '')}" aria-label="Study name">`;
  const input = $id('studyName');
  input.focus(); input.select();
  let done = false;
  const finish = keep => {
    if (done) return; done = true;
    if (keep) {
      const v = input.value.trim().slice(0, 80);
      if (v) S.study.name = v; else delete S.study.name;
      save();
      document.title = `${v || S.study.meta?.players?.join(' vs. ') || 'Replay'} - Replay Branch`;
    }
    showTitle();
  };
  input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}
