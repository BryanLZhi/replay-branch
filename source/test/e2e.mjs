// End-to-end test that uses the page only as a visitor would: clicks, keys and what is on screen.
//   node source/test/e2e.mjs [site url]     (default: serve the built site from the repository root)
// RBV_PW: the site password, when the page has a gate. Needs Edge or Chrome (CHROME=path to pick one).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import http from 'http';
import zlib from 'zlib';
import path from 'path';
import {fileURLToPath} from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserPath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
// One replay per kind of format: team preview + Tera, Mega Evolution + Z-Moves, Dynamax (random battles), no team preview,
// the oldest gens.
const FORMATS = ['gen9ou', 'gen7ou', 'gen8randombattle', 'gen9randombattle', 'gen4ou', 'gen3ou', 'gen2ou', 'gen1ou'];
const GIMMICK_FORMATS = ['gen7ou', 'gen8randombattle'];   // where a Mega Evolution / Z-Power / Dynamax box should turn up
const DOUBLES_FORMATS = ['gen9vgc2025regi', 'gen9doublesou'];
// the sample replay the landing page offers (gen 6 Monotype, Normal vs. Psychic)
const SAMPLE = 'oumonotype-82345404', SAMPLE_PLAYERS = /kdarewolf vs\. Onox/;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
}

function serve(dir) {
  const types = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css'};
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server, url = process.argv[2];
if (!url) { server = await serve(root); url = `http://127.0.0.1:${server.address().port}/`; }
console.log('testing', url);

const browser = await puppeteer.launch({executablePath: browserPath, headless: 'new', args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required']});
const page = await browser.newPage();
await page.setViewport({width: 1280, height: 1000});
const pageErrors = [], failedRequests = [], blocked = [];
page.on('pageerror', e => pageErrors.push(e.message));
// anything the Content Security Policy blocks
async function watchPolicy(p) {
  await p.exposeFunction('reportBlocked', v => blocked.push(v));
  // (jQuery 1.11, which Showdown loads, tests for focusin support by setting an inline handler attribute: harmless)
  await p.evaluateOnNewDocument(() => document.addEventListener('securitypolicyviolation', e => {
    if (!(e.violatedDirective === 'script-src-attr' && /jquery-1\.11/.test(e.sourceFile))) window.reportBlocked(`${e.violatedDirective} ${e.blockedURI}`);
  }));
}
await watchPolicy(page);
page.on('requestfailed', r => { if (!/\.(mp3|wav|ogg)(\?|$)/.test(r.url()) && r.failure()?.errorText !== 'net::ERR_ABORTED') failedRequests.push(r.url() + ' ' + r.failure()?.errorText); });
page.on('response', r => { if (r.status() >= 400) failedRequests.push(r.url() + ' ' + r.status()); });

// ---------------------------------------------------------------- helpers (all through the page's UI)
const until = (fn, arg, timeout = 30000) => page.waitForFunction(fn, {timeout, polling: 100}, arg);
const text = sel => page.$eval(sel, el => el.textContent.trim()).catch(() => '');
const visible = sel => page.$eval(sel, el => !el.closest('[hidden]') && el.getClientRects().length > 0).catch(() => false);
const inLine = () => page.$('#rbTitle .rb-mode').then(Boolean);
const currentRow = () => text('.rb-mrow.cur .no');
const control = action => page.click(`.replay-controls button[data-action=${action}]`);
async function press(key) { await page.keyboard.press(key); await sleep(150); }
// Wait until the viewer has stopped animating.
const settled = () => until(() => !document.querySelector('.replay-controls button[data-action=pause]'), null, 60000);
// The turn bar: its turn, a player's slot, that player's move menu.
const turnLabel = () => text('#pickSec .rb-turn');
const slotText = si => text(`#pickSec [data-slot="${si}"]`);
const liveSlot = si => page.$(`#pickSec .rb-slot[data-slot="${si}"]:not(.quiet)`);
const barReady = () => until(() => !document.querySelector('#pickSec').hidden && document.querySelector('#pickSec .rb-slot:not(.quiet)'));
const question = () => text('#pickSec .rb-menu h3 span');
async function openSlot(si) {
  await page.click(`#pickSec [data-slot="${si}"]`);
  await until(() => document.querySelector('#pickSec .rb-menu'), null, 10000);
}
// Change a player's choice to something the replay's player did not do (or anything, in a line).
async function changeSlot(si) {
  await openSlot(si);
  const b = await page.$('#pickSec .rb-menu [data-pick]:not(.played):not(.chosen):not(:disabled)') || await page.$('#pickSec .rb-menu [data-pick]:not(:disabled)');
  await b.click(); await sleep(100);
}
// Branch this turn: change both players' choices, then Play turn.
async function branchTurn() {
  await barReady();
  for (const si of [0, 1]) if (await liveSlot(si)) await changeSlot(si);
  await page.click('#btnPlayTurn');
  await until(() => document.querySelector('#rbTitle .rb-mode'), null, 30000);
  await settled();
}

try {
  // ---------------------------------------------------------------- password gate
  await page.goto(url, {waitUntil: 'domcontentloaded'});
  await page.evaluate(() => localStorage.clear());
  await page.reload({waitUntil: 'domcontentloaded'});
  if (await visible('#gate')) {
    if (!process.env.RBV_PW) throw new Error('the page has a password gate: set RBV_PW');
    await page.type('#gatePw', 'not the password'); await page.keyboard.press('Enter'); await sleep(300);
    check(await text('#gateErr') === 'Wrong password.' && await visible('#gate'), 'gate rejects a wrong password');
    await page.$eval('#gatePw', el => { el.value = ''; });
    await page.type('#gatePw', process.env.RBV_PW); await page.keyboard.press('Enter'); await sleep(500);
    check(!await visible('#gate'), 'gate opens with the password');
  } else console.log('(no password gate)');

  // ---------------------------------------------------------------- landing page
  check(await visible('#landing') && !await visible('#viewer'), 'opens on the landing page');
  await page.click('#recent [data-visit]');   // the sample
  await until(() => !document.querySelector('#viewer').hidden, null, 10000);
  check(/\?r=/.test(page.url()), 'a replay gets its own address', page.url());

  // ---------------------------------------------------------------- team preview: leads
  await barReady();
  check(await turnLabel() === 'Team preview' && /\S/.test(await slotText(0)) && /\S/.test(await slotText(1)),
    "starts at team preview, the bar showing the replay's leads", `${await slotText(0)} | ${await slotText(1)}`);
  await openSlot(0);
  check(/choose a lead/.test(await question()), "a slot opens that player's menu", await question());
  await press('Escape');
  check(!await page.$('#pickSec .rb-menu'), 'Esc closes it');
  check(!await inLine() && await currentRow() === '', 'on the replay at team preview');
  await branchTurn();
  check(await inLine(), 'changing the leads and playing the turn starts a line');
  check(await page.$$eval('#studySec .rb-tok', t => t.length) === 1, 'the line is in the study');
  check(await visible('#diceSec'), 'dice are shown for the line');

  await control('reset'); await sleep(500);
  check(!await inLine() && await turnLabel() === 'Team preview', 'Reset goes back to team preview');

  // following the replay: Play turn with the bar as it is
  await barReady(); await page.click('#btnPlayTurn');
  await until(() => document.querySelector('.rb-mrow.cur .no')?.textContent === '0', null, 30000); await settled();
  check(!await inLine(), 'Play turn as the replay played it follows the replay');
  await barReady();
  check(await turnLabel() === 'Turn 1', 'and the bar moves on to turn 1', await turnLabel());
  // the replay's own turn: its dice as they went (found from the log), and changing one makes it your line
  await until(() => !document.querySelector('#diceSec').hidden, null, 10000).catch(() => {});
  if (await visible('#diceSec')) {
    check(await page.$eval('#btnReal', b => b.disabled), "the replay's own turn shows its dice as played");
  } else console.log('(no dice in turn 1)');
  await openSlot(0);
  check(/what will .+ do\?/.test(await question()), 'with the move menu', await question());
  const bench = await page.$$eval('#pickSec .rb-menu .rb-sw', b => [b.length, b.filter(x => !x.disabled).length]);
  check(bench[0] === 5 && bench[1] === 5, 'every Pokemon on the bench can be switched in on turn 1', `${bench[1]} of ${bench[0]}`);
  const ranges = await page.$$eval('#pickSec .rb-dmg', d => d.map(x => x.textContent));
  check(ranges.length > 0 && ranges.every(r => /^[\d.]+ - [\d.]+%$/.test(r)), 'attacking moves show the damage calc range', ranges.join(', '));
  await page.hover('#pickSec .rb-mv[data-calc]');
  const tip = await text('#tooltipwrapper');
  check(/Accuracy/.test(tip), "hovering a move shows Showdown's move tooltip");
  check(/ vs\. .+: \d+-\d+ \(/.test(tip), "and the damage calc's result", tip.slice(tip.indexOf(' vs. ') - 40, tip.indexOf(' vs. ') + 60));
  await page.hover('#pickSec .rb-menu .rb-sw');
  check(/HP/.test(await text('#tooltipwrapper')), "hovering a Pokemon shows Showdown's Pokemon tooltip");
  await page.click('#studySec'); await sleep(150);
  check(!await page.$('#pickSec .rb-menu'), 'a click elsewhere closes the menu');

  // ---------------------------------------------------------------- play / pause and the turn buttons
  await control('play'); await sleep(4000);
  const afterPlay = await currentRow();
  await control('pause'); await sleep(300);
  check(+afterPlay >= 1, 'Play plays the replay and the study follows', 'row ' + afterPlay);
  check(await visible('.replay-controls button[data-action=play]'), 'Pause pauses');
  await control('reset'); await sleep(400);
  for (let i = 0; i < 4; i++) { await control('ff'); await sleep(250); }
  check(await currentRow() === '3', 'Next turn x4 walks to turn 4', 'row ' + await currentRow());
  await control('rewind'); await sleep(250);
  check(await currentRow() === '2', 'Last turn steps back', 'row ' + await currentRow());
  await press('ArrowRight');
  check(await currentRow() === '3', 'Right arrow steps forward');

  // ---------------------------------------------------------------- hammering the controls
  await control('reset'); await sleep(300);
  for (let i = 0; i < 25; i++) await page.click('.replay-controls button[data-action=ff]');   // as fast as clicks go
  for (let i = 0; i < 10; i++) await page.click('.replay-controls button[data-action=rewind]');
  for (let i = 0; i < 6; i++) await control(i % 2 ? 'pause' : 'play').catch(() => {});
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await control('pause').catch(() => {}); await sleep(1500); await settled();
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
  await sleep(800);
  const row = await currentRow(), label = await turnLabel();
  check(label === `Turn ${+row + 1}`, 'after hammering the controls, the bar shows the turn on screen', `row ${row}, bar ${label}`);
  await openSlot(0);
  check(/what will .+ do\?/.test(await question()), 'and its menu still opens', await question());
  await press('Escape');

  // ---------------------------------------------------------------- move picker toggle, guessed moves
  await page.click('.pickerchooser button[value=off]'); await sleep(200);
  check(!await visible('#pickSec'), 'Move picker: Off hides the bar');
  await page.click('.pickerchooser button[value=on]'); await sleep(200);
  await barReady();
  check(await visible('#pickSec .rb-bar'), 'Move picker: On shows it again');
  // find a turn where player 1 has a guessed move (one not seen in the replay)
  let guessed = null;
  for (let i = 0; i < 40 && !guessed; i++) {
    if (await liveSlot(0)) { await openSlot(0); guessed = await page.$('#pickSec .rb-menu [data-edit]'); if (!guessed) await press('Escape'); }
    if (!guessed) { await press('ArrowRight'); await sleep(250); }
  }
  if (guessed) {
    const old = await page.$eval('#pickSec .rb-menu [data-edit]', b => b.dataset.edit);
    await guessed.click(); await sleep(100);
    await page.$eval('.rb-mvinput', el => { el.value = ''; });
    await page.type('.rb-mvinput', 'Protect'); await page.keyboard.press('Enter'); await sleep(300);
    const moves = await page.$$eval('#pickSec .rb-menu .rb-mv b', b => b.map(x => x.textContent));
    check(moves.includes('Protect') && !moves.includes(old), 'a guessed move can be edited inline', `${old} -> ${moves.join('/')}`);
    await press('Escape');
  } else check(false, 'a guessed move to edit');
  await control('reset'); await sleep(400);
  for (let i = 0; i < 3; i++) { await control('ff'); await sleep(250); }

  // ---------------------------------------------------------------- the replay's own dice (turn 3: a Knock Off)
  await barReady(); await settled();
  await until(() => document.querySelector('#diceSec button.rb-chip[title]'), null, 10000).catch(() => {});
  if (await page.$('#diceSec button.rb-chip[title]')) {
    await page.click('#diceSec button.rb-chip[title]'); await sleep(300);
    check(!await page.$eval('#btnReal', b => b.disabled) && !await inLine(), "an outcome of the replay's turn can be changed, and put back");
    await page.click('#btnReal'); await sleep(300);
    check(await page.$eval('#btnReal', b => b.disabled), 'As played puts it back');
  } else check(false, 'a yes/no outcome in the dice of this replay turn');
  await control('ff'); await sleep(250);

  // ---------------------------------------------------------------- a line, its dice
  await barReady();
  await openSlot(0);
  const nth = await page.$$eval('#pickSec .rb-menu [data-pick]', b => b.findIndex(x => !x.disabled && !x.classList.contains('played') && !x.classList.contains('chosen') && x.querySelector('.rb-dmg')) + 1);
  await press(String(nth));   // (number keys pick in the menu)
  check(await page.$('#pickSec [data-slot="0"].changed'), 'a number key picks in the menu, and the slot shows it changed');
  await openSlot(1);
  const attack = await page.$('#pickSec .rb-menu .rb-mv:not(:disabled):not(.played) .rb-dmg');
  if (attack) { await attack.click(); await sleep(100); } else { await press('Escape'); await changeSlot(1); }
  // the dice of the turn, set before playing it
  check(await visible('#diceSec') && /Turn \d/.test(await text('#diceSec .rb-dturn')) && !await inLine(),
    'with both choices in, the dice of the coming turn show before playing it', await text('#diceSec .rb-dturn'));
  let presetDice = null;
  const preChip = await page.$('#diceSec button.rb-chip[title]');
  if (preChip) {
    const was = await page.$eval('#diceSec button.rb-chip[title]', c => c.textContent);
    await preChip.click(); await sleep(300);
    presetDice = await page.$eval('#diceSec button.rb-chip[title]', c => c.textContent);
    check(presetDice !== was && !await inLine() && await page.$('#pickSec [data-slot="1"].changed'), 'a dice outcome can be changed before playing', `${was} -> ${presetDice}`);
  } else console.log('(no yes/no dice in the coming turn)');
  await press('Enter');   // (Enter plays the turn)
  await until(() => document.querySelector('#rbTitle .rb-mode'), null, 30000); await settled();
  check(await inLine(), 'Enter plays the changed turn as a line');
  if (presetDice) check(await text('#diceSec button.rb-chip[title]') === presetDice && await page.$('#diceSec .rb-chip.dev'),
    'and the line plays with the outcome set before', await text('#diceSec button.rb-chip[title]'));
  if (await page.$('.rb-odds')) check(/This turn \d/.test(await text('.rb-odds')), 'the dice show the odds of the outcomes', await text('.rb-odds'));
  else console.log('(no chance-based outcomes in this turn)');
  const logBefore = await text('.battle-log');
  const chip = await page.$('#diceSec button.rb-chip[title]');   // a yes/no outcome (speed-tie chips have no title)
  if (chip) {
    const before = await page.$eval('#diceSec button.rb-chip[title]', c => c.textContent);
    const wasDev = await page.$eval('#diceSec button.rb-chip[title]', c => c.classList.contains('dev'));
    await chip.click(); await sleep(300); await settled();
    const after = await page.$eval('#diceSec button.rb-chip[title]', c => c.textContent);
    const nowDev = await page.$eval('#diceSec button.rb-chip[title]', c => c.classList.contains('dev'));
    check(before !== after && nowDev !== wasDev, 'clicking a dice chip changes the outcome', `${before} -> ${after}`);
    check(await text('.battle-log') !== logBefore, 'the turn replays with the new outcome');
    await page.click('#btnLikely'); await sleep(300); await settled();
    check(!await page.$('#diceSec .dev'), 'Most likely puts every outcome back');
  } else console.log('(no yes/no dice in this turn)');
  await page.click('#btnRandomize'); await sleep(300); await settled();
  check(await inLine() && !(await text('#pickSec .rb-err')), 'Randomize replays the turn');

  // ---------------------------------------------------------------- arrows across lines, notes
  await press('ArrowLeft');
  check(!await inLine() && await currentRow() === '3', 'Left arrow goes back to the replay');
  await press('ArrowRight'); await press('ArrowDown'); await settled();
  check(await inLine(), 'Down arrow switches from the replay turn to the line');
  await page.click('#studySec [data-glyph="!?"]'); await sleep(100);
  await page.type('#comment', 'interesting try');
  await page.$eval('#comment', el => el.blur()); await sleep(200);

  // ---------------------------------------------------------------- the position editor
  await control('reset'); await sleep(400);
  for (let i = 0; i < 3; i++) { await control('ff'); await sleep(250); }   // (turn 3 of the replay)
  await barReady(); await settled();
  const editTurn = await turnLabel();
  await page.click('#btnEdit');
  await until(() => !document.querySelector('#editor').hidden, null, 10000);
  check(await page.$$eval('#editor .rb-edmon', m => m.length) === 12 && !!await page.$('#editor .rb-edmon.on [data-boost=atk]') && !!await page.$('#editor [data-cond=stealthrock]'),
    "Edit opens the position editor on a replay turn: both teams, the stat stages of those on the field, each side's hazards");
  await page.$eval('#editor .rb-edside[data-side="0"] .rb-edmon.on [data-f=hp]', el => { el.value = '40'; el.dispatchEvent(new Event('input')); });
  await page.click('#editor .rb-edside[data-side="1"] [data-cond=stealthrock]');
  await page.click('#btnEditApply');
  await until(() => document.querySelector('#editor').hidden && document.querySelector('#rbTitle .rb-mode'), null, 30000); await settled();
  const editedStep = await text('#studySec .rb-tok.rb-edited.cur');
  check(/✎/.test(editedStep) && /40%/.test(editedStep) && /Stealth Rock/.test(editedStep), 'applying an edit adds an edited step to the move list', editedStep);
  const hpShown = await page.$$eval('.statbar .hptext', t => t.map(x => x.textContent));
  check(await turnLabel() === editTurn && hpShown.includes('40%') && !await visible('#diceSec'), 'the viewer shows the edited position, and the same turn is asked next', `${await turnLabel()}, HP ${hpShown.join(' / ')}`);
  await branchTurn(); await sleep(500); await settled();
  const afterEdit = await page.$$eval('#studySec .rb-tok', t => { const i = t.findIndex(x => x.classList.contains('cur')); return i > 0 && t[i - 1].classList.contains('rb-edited'); });
  check(afterEdit && !await text('#pickSec .rb-err'), 'a turn plays on from the edited position', await text('#pickSec .rb-err'));
  // editing again, in the line: the hazard is still there; another step
  await barReady();
  await page.click('#btnEdit');
  await until(() => !document.querySelector('#editor').hidden, null, 10000);
  check(await page.$eval('#editor .rb-edside[data-side="1"] [data-cond=stealthrock]', b => b.checked), 'the editor opens on a position in a line, with the edit kept');
  await page.select('#editor .rb-edside[data-side="1"] .rb-edmon.on [data-f=status]', 'par');
  await page.click('#btnEditApply');
  await until(() => document.querySelector('#editor').hidden, null, 30000); await settled();
  check(await page.$$eval('#studySec .rb-tok.rb-edited', t => t.length) === 2 && /PAR/.test(await text('#studySec .rb-tok.rb-edited.cur')), 'editing again adds another edited step', await text('#studySec .rb-tok.rb-edited.cur'));
  const lineCount = await page.$$eval('#studySec .rb-tok', t => t.length);
  const tokens = await page.$$eval('#studySec .rb-tok', t => t.map(x => x.textContent));
  check(tokens.some(t => t.includes('!?') && t.includes('interesting try')), 'glyph and note show on the line');

  await page.reload({waitUntil: 'domcontentloaded'});
  await barReady();
  const reloaded = await page.$$eval('#studySec .rb-tok', t => t.map(x => x.textContent));
  check(reloaded.length === lineCount && reloaded.some(t => t.includes('!?') && t.includes('interesting try')), 'the study is kept across a reload', reloaded.length + ' lines');
  check(reloaded.filter(t => t.includes('✎')).length === 2, 'edited steps too');

  // ---------------------------------------------------------------- share (link and text), delete, load the text back
  await page.click('#btnShare'); await sleep(300);
  const exported = await page.$eval('#exportBox', el => el.value);
  const link = await page.$eval('#shareLink', el => el.value);
  check(exported.startsWith('{"rbv":1') && /#s=[\w-]+$/.test(link) && await visible('#sharer'), 'Share shows a link and the study', link.length + ' characters');
  await page.click('#btnCloseShare');
  {
    const other = await browser.createBrowserContext();   // a different visitor: no saved study, no password remembered
    const p2 = await other.newPage(); await p2.setViewport({width: 1280, height: 1000});
    p2.on('pageerror', e => pageErrors.push(e.message));
    await p2.goto(link, {waitUntil: 'domcontentloaded'});
    if (await p2.$eval('#gate', el => !el.hidden).catch(() => false)) { await p2.type('#gatePw', process.env.RBV_PW); await p2.keyboard.press('Enter'); }
    await p2.waitForFunction(n => document.querySelectorAll('#studySec .rb-tok').length === n, {timeout: 60000}, lineCount).catch(() => {});
    const shared = await p2.$$eval('#studySec .rb-tok', t => t.map(x => x.textContent));
    check(shared.length === lineCount && shared.some(t => t.includes('interesting try')) && !p2.url().includes('#s='),
      'the link opens the study for someone else', shared.length + ' lines');
    check(shared.filter(t => t.includes('✎') && !t.includes('error')).length === 2, 'with its edited steps');
    await other.close();
  }
  {
    // a crafted link: HTML in a line id, notes, a glyph, EVs and level must stay text (or be dropped), never run
    const xss = '<img src=x onerror="window.pwned=1">';
    const study = {
      nodes: {'n1" onmouseover="window.pwned=1': {parent: 'r1', choices: {p1: 'move 1', p2: 'move 1'}},
        n2: {parent: 'r1', choices: {p1: 'move 1', p2: 'move 1"><b>'}, forced: [{key: xss, value: xss}], seed: [1, 2, 3, 4], comment: xss, glyph: xss},
        // (edited positions: what holds is kept, the rest dropped)
        n3: {parent: 'r2', edit: {mons: [{s: 0, k: 0, hp: 50, status: xss, item: xss, boosts: {atk: xss, [xss]: 1}}, {s: xss, k: 1, hp: 10}], field: {weather: xss, terrain: 'electricterrain'}, sides: [{[xss]: 1, spikes: xss}, {stealthrock: 1}]}},
        n4: {parent: 'r2', edit: {mons: [{s: 0, k: 0, hp: xss}], field: {weather: xss}}, comment: xss}},
      kids: {r1: ['n1" onmouseover="window.pwned=1', 'n2'], r2: ['n3', 'n4']}, notes: {r2: {comment: xss, glyph: xss}},
      sets: [[{name: xss, species: 'Talonflame', evs: {hp: '"><img src=x onerror="window.pwned=1">'}, level: '"><img src=x onerror="window.pwned=1">', moves: [xss]}]],
    };
    const evil = url.replace(/[?#].*$/, '') + '#s=' + zlib.deflateRawSync(Buffer.from(JSON.stringify({rbv: 1, id: SAMPLE, study}))).toString('base64url');
    const other = await browser.createBrowserContext();
    const p3 = await other.newPage(); await p3.setViewport({width: 1280, height: 1000});
    p3.on('pageerror', e => pageErrors.push(e.message));
    await watchPolicy(p3);
    await p3.goto(evil, {waitUntil: 'domcontentloaded'});
    if (await p3.$eval('#gate', el => !el.hidden).catch(() => false)) { await p3.type('#gatePw', process.env.RBV_PW); await p3.keyboard.press('Enter'); }
    await p3.waitForSelector('#studySec .rb-movelist', {timeout: 60000}).catch(() => {});
    await p3.click('[data-tab=teams]').catch(() => {}); await new Promise(r => setTimeout(r, 1000));
    for (const el of await p3.$$('[data-go]')) await el.hover().catch(() => {});
    const result = await p3.evaluate(() => ({pwned: !!window.pwned, injected: document.querySelectorAll('img[src="x"]').length}));
    check(!result.pwned && !result.injected, 'a crafted share link cannot run anything', JSON.stringify(result));
    await other.close();
  }
  {
    // someone's study of the same replay, opened here: it goes beside yours, not over it
    const theirs = {nodes: {n1: {parent: 'r1', choices: {p1: 'move 1', p2: 'move 1'}, seed: [5, 6, 7, 8], comment: 'their idea'}}, kids: {r1: ['n1']}};
    const link2 = url.replace(/[?#].*$/, '') + '#s=' + zlib.deflateRawSync(Buffer.from(JSON.stringify({rbv: 1, id: SAMPLE, study: theirs}))).toString('base64url');
    const mineBefore = await page.$$eval('#studySec .rb-tok', t => t.length);
    await page.goto(link2, {waitUntil: 'domcontentloaded'});
    await page.waitForSelector('#studySec .rb-tok', {timeout: 60000});
    const opened = await page.$$eval('#studySec .rb-tok', t => t.map(x => x.textContent));
    await page.click('#home'); await sleep(400);
    const recentNow = await page.$$eval('#recent [data-visit]', r => r.map(x => x.textContent));
    check(opened.length === 1 && opened[0].includes('their idea') && recentNow.some(r => /shared with you/.test(r)) && recentNow.some(r => SAMPLE_PLAYERS.test(r) && !/shared/.test(r)),
      "a shared study of a replay you studied opens beside yours", recentNow.join(' | '));
    await page.click('#recent [data-visit]:not([data-visit*="~"])');
    await until(n => document.querySelectorAll('#studySec .rb-tok').length === n, mineBefore, 60000).catch(() => {});
    check(await page.$$eval('#studySec .rb-tok', t => t.length) === mineBefore, 'and yours is untouched', mineBefore + ' lines');
  }
  {
    // the browser's storage full: the page says changes are not being saved, and stops saying so once they are
    await page.evaluate(() => {
      const chunk = 'x'.repeat(1 << 20);
      try { for (let i = 0; i < 20; i++) localStorage.setItem('fill' + i, chunk); } catch {}
      try { for (let i = 0; i < 1024; i++) localStorage.setItem('fillk' + i, 'x'.repeat(1 << 10)); } catch {}
    });
    const note = v => page.$eval('#comment', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, v);
    await note('a long note '.repeat(400)); await sleep(300);   // (a few KB more than there is room for)
    const shownFull = await visible('#saveErr');
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fill')) localStorage.removeItem(k); });
    await note(''); await sleep(300);
    check(shownFull && !await visible('#saveErr'), 'a full storage is reported, and the report goes once saving works');
  }
  await page.click('#studySec .rb-tok'); await sleep(300); await settled();
  await page.click('#btnDelete'); await sleep(100);
  check(/again/.test(await text('#btnDelete')), 'Delete asks for a second click');
  await page.click('#btnDelete'); await sleep(300);
  check(await page.$$eval('#studySec .rb-tok', t => t.length) === lineCount - 1 && !await inLine(), 'Delete removes the line');
  await page.click('#studySec .rb-tok.rb-edited'); await sleep(300); await settled();
  await page.click('#btnDelete'); await sleep(100); await page.click('#btnDelete'); await sleep(300);
  check(!await page.$('#studySec .rb-tok.rb-edited') && !await inLine(), 'an edited step deletes with what follows it');
  await page.click('#btnLoad'); await sleep(200);
  await page.$eval('#pasteBox', (el, v) => { el.value = v; }, exported);
  await page.click('#btnDoLoad'); await sleep(1000);
  await barReady();
  check(!await visible('#loader') && await page.$$eval('#studySec .rb-tok', t => t.length) === lineCount, 'loading the export brings the lines back');

  // ---------------------------------------------------------------- teams tab
  await page.click('[data-tab=teams]'); await sleep(300);
  const cards = await page.$$('#studySec .rb-mon');
  check(cards.length >= 6, 'Teams shows both teams', cards.length + ' sets');
  const field = await page.$('#studySec input[data-field=item]');
  await field.evaluate(el => { el.focus(); el.select(); }); await field.type('Leftovers'); await page.keyboard.press('Tab'); await sleep(200);
  check(await page.$eval('#studySec input[data-field=item]', el => el.value) === 'Leftovers', 'a set can be edited');
  const atk = await page.$('#studySec input[data-field=ev_atk]');
  await atk.evaluate(el => { el.focus(); el.select(); }); await atk.type('252+'); await page.keyboard.press('Tab'); await sleep(300);
  const nature = await page.$eval('#studySec input[data-field=nature]', el => el.value);
  check(await page.$eval('#studySec .rb-evs', el => el.textContent.includes('Atk+')) && ['Lonely', 'Adamant', 'Naughty', 'Brave'].includes(nature) &&
    await page.$eval('#studySec input[data-field=ev_atk]', el => el.value) === '252', 'typing 252+ in an EV box sets the nature', nature);

  // importing: a team that is not this one is flagged
  await page.click('[data-import="0"]'); await sleep(200);
  await page.type('#importText', 'https://pokepast.es/57780b9afe26d51b');
  await page.click('#btnImport');
  await until(() => !document.querySelector('#importProblems').hidden || document.querySelector('#importErr').textContent, null, 30000);
  const problems = await page.$$eval('#importProblems li', l => l.map(x => x.textContent));
  check(problems.some(p => p.startsWith('Not in the paste')) && /None of these/.test(await text('#importErr')), 'a PokéPaste of another team is flagged', problems[0]);
  await page.click('#btnImportCancel');
  // sets typed in, contradicting the replay: Kecleon (May Day Parade) used Power-Up Punch, and Fake Out then Sucker Punch,
  // which a Choice Band would not allow; Chansey (Paramedic) without Eviolite or bulk takes more than it did
  const card = name => page.$$eval('#studySec .rb-mon', (cards, name) => {
    const c = cards.find(c => c.querySelector('.nm').textContent.includes(name));
    return c && {item: c.querySelector('[data-field=item]').value, guesses: c.querySelectorAll('.guess').length};
  }, name);
  await page.click('[data-import="0"]'); await sleep(200);
  await page.$eval('#importText', el => {
    el.value = ['May Day Parade (Kecleon) @ Choice Band', 'Ability: Protean', 'EVs: 252 Atk / 4 Def / 252 Spe', 'Adamant Nature',
      '- Fake Out', '- Sucker Punch', '- Shadow Sneak', '- Return', '',
      'Paramedic (Chansey) @ Leftovers', 'Ability: Natural Cure', 'EVs: 252 Atk / 252 Spe', 'Hasty Nature',
      '- Seismic Toss', '- Soft-Boiled', '- Toxic', '- Heal Bell'].join('\n');
    el.dispatchEvent(new Event('input'));
  });
  await page.click('#btnImport');
  await until(() => !document.querySelector('#importProblems').hidden || document.querySelector('#importErr').textContent, null, 30000);
  const flagged = await page.$$eval('#importProblems li', l => l.map(x => x.textContent));
  check(flagged.some(p => /no Power-Up Punch/.test(p)) && flagged.some(p => /without switching, which Choice Band does not allow/.test(p)) &&
    flagged.some(p => /Focus Blast did .+ to Paramedic, the sets allow/.test(p)), 'moves, items and damage the replay shows are checked', flagged.join(' | '));
  await page.click('#btnImport'); await sleep(300);
  const imported = await card('May Day Parade');
  check(!await visible('#importer') && imported?.item === 'Choice Band' && imported.guesses === 0, 'Import anyway uses the set (no longer shown as a guess)', JSON.stringify(imported));
  // the Teams tab keeps listing the mismatches, and follows edits
  await until(() => !document.querySelector('#teamCheck').hidden, null, 30000);
  const live = await page.$$eval('#teamCheck li', l => l.map(x => x.textContent));
  check(live.some(p => /no Power-Up Punch/.test(p)) && live.some(p => /Choice Band/.test(p)), 'the Teams tab lists what the imported sets cannot be', live.join(' | '));
  await page.$$eval('#studySec .rb-mon', cards => {
    const c = cards.find(c => c.querySelector('.nm').textContent.includes('May Day Parade'));
    const box = c.querySelector('[data-field=move3]');
    box.value = 'Power-Up Punch'; box.dispatchEvent(new Event('change'));
  });
  await sleep(1500);
  const after = await page.$$eval('#teamCheck li', l => l.map(x => x.textContent));
  check(!after.some(p => /no Power-Up Punch/.test(p)), 'fixing the set clears its line', after.join(' | '));
  // importing the other side too: hits between two known sets read like the damage calc, spreads included
  await page.click('[data-import="1"]'); await sleep(200);
  await page.$eval('#importText', el => {
    el.value = ['BrainCell (Reuniclus) @ Leftovers', 'Ability: Magic Guard', 'EVs: 252 HP / 252 Def / 4 SpD', 'Bold Nature',
      '- Calm Mind', '- Focus Blast', '- Recover', '- Psyshock'].join('\n');
    el.dispatchEvent(new Event('input'));
  });
  await page.click('#btnImport');
  await until(() => !document.querySelector('#importProblems').hidden || document.querySelector('#importer').hidden, null, 30000);
  if (await visible('#importer')) await page.click('#btnImport');
  await sleep(1500);
  const both = await page.$$eval('#teamCheck li', l => l.map(x => x.textContent));
  check(both.some(p => /\+1 0 SpA Reuniclus Focus Blast vs\. 0 HP \/ 0 SpD Chansey: .+, the replay shows 33\.8%/.test(p)),
    'with both sides imported, a hit reads like the damage calc', both.filter(p => /Chansey|Paramedic/.test(p)).join(' | '));
  await page.click('[data-tab=study]'); await sleep(200);

  // ---------------------------------------------------------------- back to the landing page: recent studies, search
  await page.click('#home'); await sleep(300);
  const recent = await page.$$eval('#recent [data-visit]', r => r.map(x => x.textContent));
  check(await visible('#landing') && recent.some(r => SAMPLE_PLAYERS.test(r) && /\b\d+\b/.test(r)), 'Recent lists the study with its lines', recent[0]);
  await page.type('#searchFormat', 'gen9ou'); await page.click('#searchForm button[type=submit]');
  await until(() => document.querySelectorAll('#searchResults [data-visit]').length, null, 30000);
  const result = await page.$eval('#searchResults [data-visit]', r => r.dataset.visit);
  await page.click('#searchResults [data-visit]');
  await barReady().catch(() => {});
  check(page.url().includes(result) && await visible('#viewer'), 'a search result opens', result);
  await page.goBack(); await sleep(400);
  check(await visible('#landing'), 'Back returns to the landing page');
  await page.goForward(); await sleep(1000);
  check(await visible('#viewer') && page.url().includes(result), 'Forward reopens it');

  // ---------------------------------------------------------------- other formats, loaded by link
  for (const format of FORMATS) {
    const found = await page.evaluate(async f => {
      const r = await fetch(`https://replay.pokemonshowdown.com/search.json?format=${f}`);
      return r.ok ? (await r.json()).map(x => x.id) : [];
    }, format);
    if (!found.length) { check(false, `${format}: find a replay`); continue; }
    const id = found[0], found_ = found;
    await page.click('#btnLoad'); await sleep(200);
    await page.type('#replayUrl', `https://replay.pokemonshowdown.com/${id}`);
    await page.click('#btnDoLoad');
    await until(() => document.querySelector('#loader').hidden, null, 30000); await sleep(800);
    const title = await text('#rbTitle');
    check(!await text('#loadErr'), `${format}: loads ${id}`, title.slice(0, 60));
    if (!await liveSlot(0)) { await control('ff'); await sleep(500); }   // no team preview: start at turn 1
    await branchTurn();
    const err = await text('#pickSec .rb-err');
    check(await inLine() && !err, `${format}: taking over a turn works`, err);
    if (GIMMICK_FORMATS.includes(format)) {
      // walk the turns to one where a player can Mega Evolve / use Z-Power / Dynamax (in this replay or the next ones: a
      // short game may never bring its Mega Evolver in)
      const GIMMICK = '#pickSec .rb-menu [data-gimmick]:not([data-gimmick=terastallize])';
      let found = false;
      for (const other of [id, ...found_.slice(1, 4)]) {
        if (other !== id) {
          await page.click('#btnLoad'); await sleep(200);
          await page.type('#replayUrl', `https://replay.pokemonshowdown.com/${other}`);
          await page.click('#btnDoLoad');
          await until(() => document.querySelector('#loader').hidden, null, 30000); await sleep(800);
        }
        await control('reset'); await sleep(400);
        for (let i = 0; i < 60 && !found; i++) {
          for (const si of [0, 1]) {
            if (found || !await liveSlot(si)) continue;
            await openSlot(si);
            if (await page.$(GIMMICK)) found = true; else await press('Escape');
          }
          if (!found) { await press('ArrowRight'); await sleep(200); }
        }
        if (found) break;
      }
      if (!found) { check(false, `${format}: a Mega Evolution / Z-Power / Dynamax choice turns up`); continue; }
      const kind = await page.$eval(GIMMICK, b => b.parentElement.textContent.trim());
      // (it starts ticked where the replay's player used it)
      const was = await page.$eval(GIMMICK, b => b.checked);
      const before = await page.$$eval('#pickSec .rb-menu .rb-mv b', b => b.map(x => x.textContent).join('/'));
      await press('t');   // toggles it
      const after = await page.$$eval('#pickSec .rb-menu .rb-mv b', b => b.map(x => x.textContent).join('/'));
      check(await page.$eval(GIMMICK, b => b.checked) !== was, `${format}: T toggles ${kind}${was ? ' (the replay used it)' : ''}`, before === after ? before : `${before} -> ${after}`);
      await page.click('#pickSec .rb-menu .rb-mv:not(:disabled)'); await sleep(150);
      for (const si of [0, 1]) if (await page.$(`#pickSec [data-slot="${si}"].empty`)) await changeSlot(si);
      await page.click('#btnPlayTurn');
      await until(() => document.querySelector('#rbTitle .rb-mode') || document.querySelector('#pickSec .rb-err') || document.querySelector('.rb-mrow.cur'), null, 30000);
      await settled();
      check(!await text('#pickSec .rb-err'), `${format}: playing a turn with ${kind} works`, await text('#pickSec .rb-err'));
    }
  }

  // ---------------------------------------------------------------- doubles (VGC, Doubles OU): two slots a player, targets
  for (const format of DOUBLES_FORMATS) {
    const found = await page.evaluate(async f => {
      const r = await fetch(`https://replay.pokemonshowdown.com/search.json?format=${f}`);
      return r.ok ? (await r.json()).map(x => x.id) : [];
    }, format);
    if (!found.length) { check(false, `${format}: find a replay`); continue; }
    await page.click('#btnLoad'); await sleep(200);
    await page.type('#replayUrl', `https://replay.pokemonshowdown.com/${found[0]}`);
    await page.click('#btnDoLoad');
    await until(() => document.querySelector('#loader').hidden, null, 30000); await sleep(800);
    check(!await text('#loadErr'), `${format}: loads ${found[0]}`);
    await barReady();
    const live = () => page.$$eval('#pickSec .rb-slot:not(.quiet)', s => s.length);
    check(await live() === 4, `${format}: team preview asks each player for two leads`, String(await live()));
    await control('ff'); await sleep(600); await barReady(); await settled();
    const slots = await page.$$eval('#pickSec .rb-slot:not(.quiet)', s => s.map(x => x.textContent.trim()));
    check(slots.length === 4 && slots.every(s => s !== 'Choose'), `${format}: turn 1 shows each Pokemon's choice from the replay`, slots.join(' | '));
    // change the first Pokemon's move: a move that takes a target asks for one
    await page.click('#pickSec [data-slot="0"][data-place="0"]');
    await until(() => document.querySelector('#pickSec .rb-menu'), null, 10000);
    const moves = await page.$$('#pickSec .rb-menu .rb-mv:not(:disabled):not(.played)');
    if (moves.length) {
      await moves[0].click(); await sleep(200);
      if (await page.$('#pickSec .rb-menu [data-target]')) {
        check(/choose a target/.test(await question()), `${format}: a move with a target asks for it`, await question());
        await page.click('#pickSec .rb-menu [data-target]:not(:disabled)'); await sleep(200);
      }
    } else await press('Escape');
    check(await page.$('#pickSec [data-slot="0"][data-place="0"].changed'), `${format}: the slot shows the changed choice`, await text('#pickSec [data-slot="0"][data-place="0"]'));
    await page.click('#btnPlayTurn');
    await until(() => document.querySelector('#rbTitle .rb-mode') || document.querySelector('#pickSec .rb-err'), null, 30000); await settled();
    const err = await text('#pickSec .rb-err');
    check(await inLine() && !err, `${format}: playing the changed turn starts a line`, err);
    await barReady();
    check(await live() >= 1 && !await text('#pickSec .rb-err'), `${format}: the line asks for the next turn`, String(await live()));
  }

  // ---------------------------------------------------------------- a new battle from two teams
  {
    const team = (...mons) => mons.join('\n\n');
    const t1 = team(['Garchomp @ Choice Scarf', 'Ability: Rough Skin', 'EVs: 252 Atk / 4 SpD / 252 Spe', 'Jolly Nature', '- Earthquake', '- Outrage', '- Stone Edge', '- Fire Fang'].join('\n'),
      ['Rotom-Wash @ Leftovers', 'Ability: Levitate', 'EVs: 252 HP / 252 Def / 4 SpD', 'Bold Nature', '- Hydro Pump', '- Volt Switch', '- Will-O-Wisp', '- Protect'].join('\n'));
    const t2 = team(['Great Tusk @ Booster Energy', 'Ability: Protosynthesis', 'EVs: 252 Atk / 4 Def / 252 Spe', 'Jolly Nature', '- Headlong Rush', '- Ice Spinner', '- Rapid Spin', '- Knock Off'].join('\n'),
      ['Kingambit @ Black Glasses', 'Ability: Supreme Overlord', 'EVs: 252 HP / 252 Atk / 4 SpD', 'Adamant Nature', '- Kowtow Cleave', '- Sucker Punch', '- Iron Head', '- Swords Dance'].join('\n'));
    await page.click('#home'); await sleep(300);
    // the format menu: sections that fold, as Showdown's
    await page.click('#btnFormat');
    await until(() => document.querySelector('#formatMenu:not([hidden]) .rb-fhead'), null, 60000);
    const folded = await page.$$eval('#formatMenu .rb-fhead', h => h.filter(x => x.getAttribute('aria-expanded') === 'false').length);
    await page.click('#formatMenu .rb-fhead[data-sec="S/V Doubles"]'); await sleep(150);
    await page.click('#formatMenu .rb-fitem[data-format="gen9doublesou"]'); await sleep(150);
    check(folded > 10 && await page.$eval('#freshFormat', el => el.value) === 'gen9doublesou' && /Doubles OU/.test(await text('#formatName')) && !await visible('#formatMenu'),
      'the format menu has sections that fold, and picks a format', `${folded} folded, ${await text('#formatName')}`);
    await page.$eval('#freshFormat', el => { el.value = 'gen9ou'; });
    await page.$eval('#freshTeam1', (el, v) => { el.value = v; }, t1);
    await page.$eval('#freshTeam2', (el, v) => { el.value = v; }, t2);
    await page.click('#freshForm button[type=submit]');
    await until(() => document.querySelector('#pickSec .rb-turn')?.textContent === 'Team preview' && document.querySelector('#rbTitle')?.textContent.includes('Player 1'), null, 60000);
    await barReady();
    const slotsNow = await page.$$eval('#pickSec .rb-slot:not(.quiet)', s => s.map(x => x.textContent.trim()));
    check(await turnLabel() === 'Team preview' && slotsNow.length === 2 && slotsNow.every(s => s === 'Choose'), 'a new battle from two teams opens at team preview, nothing chosen', slotsNow.join(' | '));
    for (const si of [0, 1]) { await openSlot(si); await page.click('#pickSec .rb-menu [data-pick]:not(:disabled)'); await sleep(150); }
    await page.click('#btnPlayTurn');
    await until(() => document.querySelector('#rbTitle .rb-mode'), null, 30000); await settled(); await barReady();
    await openSlot(0);
    const guesses = await page.$$eval('#pickSec .rb-menu .rb-mv.guess', g => g.length), moves = await page.$$eval('#pickSec .rb-menu .rb-mv b', b => b.map(x => x.textContent));
    check(await inLine() && await turnLabel() === 'Turn 1' && guesses === 0 && moves.includes('Earthquake'), "its leads play, and both teams' moves are known (no guesses)", moves.join('/'));
    await press('Escape');
    // naming the study: the name heads the title, and Recent lists it by name
    await page.click('#btnRename');
    await page.waitForSelector('#studyName');
    await page.type('#studyName', 'Chomp vs Tusk'); await page.keyboard.press('Enter'); await sleep(200);
    check(/Chomp vs Tusk/.test(await text('#rbTitle strong')) && /Player 1 vs\. Player 2/.test(await text('#rbTitle')), 'a study can be named', await text('#rbTitle'));
    await page.click('#home'); await sleep(300);
    check((await page.$$eval('#recent [data-visit]', r => r.map(x => x.textContent))).some(r => /Chomp vs Tusk/.test(r)), 'Recent lists it by its name');
    await page.$eval('#freshFormat', el => { el.value = 'gen9ou'; });
    await page.$eval('#freshTeam1', el => { el.value = 'not a team'; });
    await page.click('#freshForm button[type=submit]'); await sleep(500);
    check(/no Pokémon found/.test(await text('#freshErr')) && await visible('#landing'), 'a team that is not one says so', await text('#freshErr'));
    await page.click('#recent [data-visit]'); await barReady();   // (back to a battle for what follows)
  }

  // ---------------------------------------------------------------- studies of several replays (chapters)
  {
    const chapterNo = () => text('#chapBar .rb-chapno');
    const atChapter = (n, title) => until(([n, title]) => document.querySelector('#chapBar .rb-chapno')?.textContent === n &&
      document.querySelector('#rbTitle')?.textContent.includes(title) && document.querySelector('#studySec .rb-movelist'), [n, title], 60000);
    // the new battle, then the sample replay, into a new study
    await page.click('#btnAddStudy'); await page.waitForSelector('#addMenu:not([hidden])');
    await page.type('#newStudyName', 'Test study'); await page.keyboard.press('Enter');
    await until(() => !document.querySelector('#chapBar').hidden, null, 30000);
    check(/[?&]c=\w+/.test(page.url()) && await chapterNo() === 'Chapter 1 / 1' && /Test study/.test(await text('#chapBar')),
      'Add to study makes a new study of this replay', await text('#chapBar'));
    await page.click('#home'); await sleep(300);
    await page.click(`#recent [data-visit="${SAMPLE}"]`);
    await until(() => /kdarewolf/.test(document.querySelector('#rbTitle')?.textContent), null, 60000); await barReady();
    check(!await visible('#chapBar'), 'a replay opened by itself shows no chapter bar');
    const sampleLines = await page.$$eval('#studySec .rb-tok', t => t.length);
    await page.click('#btnAddStudy'); await page.waitForSelector('#addMenu [data-add]');
    await page.click('#addMenu [data-add]');
    await atChapter('Chapter 2 / 2', 'kdarewolf');
    check(page.url().includes('c=') && page.url().includes(SAMPLE), 'and another replay goes in as chapter 2', await text('#chapBar'));
    await page.click('#chapPrev');
    await atChapter('Chapter 1 / 2', 'Chomp vs Tusk').catch(() => {});
    check(await chapterNo() === 'Chapter 1 / 2' && /Chomp vs Tusk/.test(await text('#rbTitle')), 'the chapter bar goes to the previous chapter', await text('#chapBar'));
    await page.click('#chapNext');
    await atChapter('Chapter 2 / 2', 'kdarewolf').catch(() => {});
    await until(n => document.querySelectorAll('#studySec .rb-tok').length === n, sampleLines, 30000).catch(() => {});
    check(await page.$$eval('#studySec .rb-tok', t => t.length) === sampleLines, 'and to the next, with its lines', `${await chapterNo()}, ${sampleLines} lines`);
    // the chapter list: rename, move, jump
    await page.click('#chapMenuBtn'); await page.waitForSelector('#chapMenu:not([hidden])');
    await page.click('#chapMenu [data-retitle="1"]'); await page.waitForSelector('#chapRename');
    await page.type('#chapRename', 'Kecleon game'); await page.keyboard.press('Enter'); await sleep(200);
    check(await text('#chapBar .rb-chaptitle') === 'Kecleon game', 'a chapter can be renamed', await text('#chapBar .rb-chaptitle'));
    await page.click('#chapMenu [data-up="1"]'); await sleep(200);
    const order = await page.$$eval('#chapMenu [data-chapter]', b => b.map(x => x.textContent));
    check(await chapterNo() === 'Chapter 1 / 2' && /Kecleon game/.test(order[0]), 'and moved up', order.join(' | '));
    await page.click('#chapMenu [data-chapter="1"]');
    await atChapter('Chapter 2 / 2', 'Chomp vs Tusk').catch(() => {});
    check(await chapterNo() === 'Chapter 2 / 2' && /Chomp vs Tusk/.test(await text('#rbTitle')), 'the list jumps to a chapter', await text('#chapBar'));
    await page.reload({waitUntil: 'domcontentloaded'});
    await atChapter('Chapter 2 / 2', 'Chomp vs Tusk').catch(() => {});
    check(await chapterNo() === 'Chapter 2 / 2' && page.url().includes('c='), 'a reload stays in the study', page.url());
    // the landing page lists it; opening it goes to the chapter last opened
    await page.click('#home'); await sleep(300);
    const studies = await page.$$eval('#studies [data-study]', r => r.map(x => x.textContent));
    check(studies.some(s => /Test study/.test(s) && /2 chapters/.test(s)), 'Studies on the landing page lists it', studies.join(' | '));
    await page.click('#studies [data-study]');
    await atChapter('Chapter 2 / 2', 'Chomp vs Tusk').catch(() => {});
    check(await chapterNo() === 'Chapter 2 / 2', 'opening it goes to the chapter last opened', await text('#chapBar'));
    // one link for the whole study: someone else gets every chapter (the sample by its id, the new battle by its log)
    await page.click('#chapMenuBtn'); await page.click('#btnShareStudy');
    await page.waitForSelector('#studySharer:not([hidden])');
    const studyLink = await page.$eval('#studyLink', el => el.value);
    check(/#c=[\w-]+$/.test(studyLink), 'Share study gives one link', studyLink.length + ' characters');
    await page.click('#btnCloseStudyShare');
    {
      const other = await browser.createBrowserContext();
      const p2 = await other.newPage(); await p2.setViewport({width: 1280, height: 1000});
      p2.on('pageerror', e => pageErrors.push(e.message));
      await watchPolicy(p2);
      await p2.goto(studyLink, {waitUntil: 'domcontentloaded'});
      if (await p2.$eval('#gate', el => !el.hidden).catch(() => false)) { await p2.type('#gatePw', process.env.RBV_PW); await p2.keyboard.press('Enter'); }
      const p2Chapter = (n, title, lines) => p2.waitForFunction(([n, title, lines]) => document.querySelector('#chapBar .rb-chapno')?.textContent === n &&
        document.querySelector('#rbTitle')?.textContent.includes(title) && (lines < 0 || document.querySelectorAll('#studySec .rb-tok').length === lines),
        {timeout: 90000, polling: 100}, [n, title, lines]).catch(() => {});
      const p2text = sel => p2.$eval(sel, el => el.textContent.trim()).catch(() => '');
      await p2Chapter('Chapter 1 / 2', 'kdarewolf', sampleLines);
      check(await p2text('#chapBar .rb-chapno') === 'Chapter 1 / 2' && await p2text('#chapBar .rb-chaptitle') === 'Kecleon game' &&
        await p2.$$eval('#studySec .rb-tok', t => t.length) === sampleLines && !p2.url().includes('#c='), 'the study link opens it for someone else', await p2text('#chapBar'));
      await p2.click('#chapNext');
      await p2Chapter('Chapter 2 / 2', 'Chomp vs Tusk', -1);
      check(/Chomp vs Tusk/.test(await p2text('#rbTitle')), 'with every chapter', await p2text('#rbTitle'));
      await p2.click('#home'); await sleep(300);
      const theirs = await p2.$$eval('#studies [data-study]', r => r.map(x => x.textContent));
      check(theirs.some(s => /Test study/.test(s) && /2 chapters/.test(s) && /shared with you/.test(s)), 'and it is in their Studies', theirs.join(' | '));
      // a crafted study link: HTML in names stays text, chapters are capped
      const xss = '<img src=x onerror="window.pwned=1">';
      const evil = url.replace(/[?#].*$/, '') + '#c=' + zlib.deflateRawSync(Buffer.from(JSON.stringify({rbv: 1, name: xss,
        chapters: Array.from({length: 80}, () => ({id: SAMPLE, title: xss, study: {name: xss, notes: {r2: {comment: xss}}}}))}))).toString('base64url');
      await p2.goto(evil, {waitUntil: 'domcontentloaded'});
      await p2.waitForSelector('#chapBar:not([hidden])', {timeout: 60000}).catch(() => {});
      await p2.click('#chapMenuBtn').catch(() => {}); await sleep(300);
      const result = await p2.evaluate(() => ({pwned: !!window.pwned, injected: document.querySelectorAll('img[src="x"]').length, bar: document.querySelector('#chapBar').textContent}));
      check(!result.pwned && !result.injected && /Chapter 1 \/ 1/.test(result.bar) && result.bar.includes('<img'), 'a crafted study link cannot run anything', JSON.stringify(result).slice(0, 160));
      await other.close();
    }
    // removing a chapter keeps the replay's own study
    await page.click('#chapMenuBtn'); await page.waitForSelector('#chapMenu:not([hidden])');
    await page.click('#chapMenu [data-remove="0"]'); await sleep(100);
    await page.click('#chapMenu [data-remove="0"]'); await sleep(300);
    const left = await chapterNo(), battleKey = new URL(page.url()).searchParams.get('r');
    await page.click('#home'); await sleep(300);
    check(left === 'Chapter 1 / 1' && !!await page.$(`#recent [data-visit="${SAMPLE}"]`) && /1 chapter\b/.test(await text('#studies')),
      'a chapter can be removed, and its replay stays in Recent', left);
    // the new battle (no replay id) taken off Recent: its chapter still opens, empty, and still goes into the study's link
    await page.click(`#recent [data-visit="${battleKey}"] [data-remove]`); await sleep(100);
    await page.click(`#recent [data-visit="${battleKey}"] [data-remove]`); await sleep(300);
    const gone = /^log-/.test(battleKey) && !await page.$(`#recent [data-visit="${battleKey}"]`);
    await page.click('#studies [data-study]');
    await atChapter('Chapter 1 / 1', 'Player 1').catch(() => {}); await barReady();   // (the bar stays for what follows)
    await page.click('[data-tab=teams]'); await sleep(300);
    const guessed = await page.$$eval('#studySec .rb-mon .guess', g => g.length);
    await page.click('[data-tab=study]'); await sleep(200);
    check(gone && await chapterNo() === 'Chapter 1 / 1' && /Player 1 vs\. Player 2/.test(await text('#rbTitle')) && await page.$$eval('#studySec .rb-tok', t => t.length) === 0 && guessed === 0,
      'a chapter whose replay was taken off Recent still opens, with its teams', `${gone} ${await text('#rbTitle')}, ${guessed} guesses`);
    await page.click('#chapMenuBtn'); await page.click('#btnShareStudy');
    await page.waitForSelector('#studySharer:not([hidden])');
    const kept = JSON.parse(zlib.inflateRawSync(Buffer.from((await page.$eval('#studyLink', el => el.value)).split('#c=')[1], 'base64url')).toString());
    check(kept.chapters.length === 1 && /\|player\|p1\|Player 1/.test(kept.chapters[0].log || ''), "and goes into the study's link with its log", kept.chapters.length + ' chapters');
    await page.click('#btnCloseStudyShare');
  }

  // ---------------------------------------------------------------- dark mode, phone width
  await page.click('.colorchooser button[value=dark]'); await sleep(200);
  const bg = await page.$eval('#studySec', el => getComputedStyle(el).backgroundColor);
  check(await page.$eval('body', b => b.classList.contains('dark')) && bg === 'rgb(38, 41, 46)', 'dark mode recolours the panels', bg);
  await page.click('.colorchooser button[value=light]');
  await page.setViewport({width: 412, height: 900}); await sleep(800);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  check(width <= 412, 'phone width: nothing sticks out sideways', width + 'px');
  // the position editor on a phone, in dark mode (on the sample, which has lines by now)
  await page.goto(url.replace(/[?#].*$/, '') + '?r=' + SAMPLE, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('#studySec .rb-tok', {timeout: 60000});
  await page.click('.colorchooser button[value=dark]'); await sleep(200);
  await page.click('#studySec .rb-tok'); await sleep(300); await settled(); await barReady();
  await page.click('#btnEdit');
  await until(() => !document.querySelector('#editor').hidden, null, 10000);
  const phoneEditor = await page.evaluate(() => {
    const sec = document.querySelector('#editor .rb-section');
    return {page: document.documentElement.scrollWidth, inner: sec.scrollWidth - sec.clientWidth, bg: getComputedStyle(sec).backgroundColor};
  });
  check(phoneEditor.page <= 412 && phoneEditor.inner <= 0 && phoneEditor.bg === 'rgb(38, 41, 46)', 'the position editor fits a phone, in dark mode too', JSON.stringify(phoneEditor));
  await page.keyboard.press('Escape'); await sleep(200);
  check(!await visible('#editor'), 'Esc closes the editor');
  await page.click('.colorchooser button[value=light]');
  await page.setViewport({width: 1280, height: 1000});
} catch (e) {
  check(false, 'test run', e.stack || e.message);
  await page.screenshot({path: path.join(root, 'e2e-failure.png')}).catch(() => {});
}

check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '));
check(blocked.length === 0, 'nothing blocked by the Content Security Policy', [...new Set(blocked)].join(' | '));
check(failedRequests.length === 0, 'no failed requests', failedRequests.join(' | '));
await browser.close();
server?.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
