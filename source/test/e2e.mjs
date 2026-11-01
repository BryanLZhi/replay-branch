// End-to-end test that uses the page only as a visitor would: clicks, keys and what is on screen.
//   node source/test/e2e.mjs [site url]     (default: serve the built site from the repository root)
// RBV_PW: the site password, when the page has a gate. Needs Edge or Chrome (CHROME=path to pick one).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserPath = [process.env.CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
// One replay per kind of format: team preview + Tera, an old gen, no team preview (random battle), and gen 3.
const FORMATS = ['gen9ou', 'gen4ou', 'gen9randombattle', 'gen3ou'];

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
const pageErrors = [], failedRequests = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('requestfailed', r => { if (!/\.(mp3|wav|ogg)(\?|$)/.test(r.url())) failedRequests.push(r.url() + ' ' + r.failure()?.errorText); });
page.on('response', r => { if (r.status() >= 400) failedRequests.push(r.url() + ' ' + r.status()); });

// ---------------------------------------------------------------- helpers (all through the page's UI)
const until = (fn, arg, timeout = 30000) => page.waitForFunction(fn, {timeout, polling: 100}, arg);
const text = sel => page.$eval(sel, el => el.textContent.trim()).catch(() => '');
const visible = sel => page.$eval(sel, el => !el.closest('[hidden]') && el.getClientRects().length > 0).catch(() => false);
const inLine = () => page.$('#rbTitle .rb-mode').then(Boolean);
const currentRow = () => text('.rb-mrow.cur .no');
const question = () => text('#pickSec h3 span');
const control = action => page.click(`.replay-controls button[data-action=${action}]`);
const pickerReady = () => until(() => document.querySelector('#pickSec .rb-pside') && !document.querySelector('#pickSec').hidden);
async function press(key) { await page.keyboard.press(key); await sleep(150); }
// Wait until the viewer has stopped animating.
const settled = () => until(() => !document.querySelector('.replay-controls button[data-action=pause]'), null, 60000);
// Branch this turn: player 1 picks something other than what was played, player 2 their first option.
// (On a turn where player 1 could not move, the replay does not show their choice and any move follows it: use a later turn.)
async function branchTurn() {
  await pickerReady();
  for (let i = 0; i < 10 && !await page.$('#pickSec [data-pick].played'); i++) { await press('ArrowRight'); await pickerReady(); }
  const other = await page.$('#pickSec [data-pick]:not(.played):not(:disabled)');
  await other.click(); await sleep(150);
  await pickerReady();
  await press('1');
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

  // ---------------------------------------------------------------- team preview: leads
  await pickerReady();
  check(/choose a lead/.test(await question()), 'starts at team preview with the lead picker', await question());
  check(!await inLine() && await currentRow() === '', 'on the replay at team preview');
  await branchTurn();
  check(await inLine(), 'picking a different lead starts a line');
  check(await page.$$eval('#studySec .rb-tok', t => t.length) === 1, 'the line is in the study');
  check(await visible('#diceSec'), 'dice are shown for the line');

  await control('reset'); await sleep(500);
  check(!await inLine() && /choose a lead/.test(await question()), 'Reset goes back to team preview');

  // following the replay: both pick what was played
  for (let i = 0; i < 2; i++) { await pickerReady(); await page.click('#pickSec [data-pick].played'); await sleep(150); }
  await until(() => document.querySelector('.rb-mrow.cur .no')?.textContent === '0', null, 30000); await settled();
  check(!await inLine(), 'picking the played leads follows the replay');
  await pickerReady();
  check(/what will .+ do\?/.test(await question()), 'then asks for turn 1', await question());

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

  // ---------------------------------------------------------------- move picker toggle, guessed moves
  await page.click('.pickerchooser button[value=off]'); await sleep(200);
  check(!await visible('#pickSec'), 'Move picker: Off hides the picker');
  await page.click('.pickerchooser button[value=on]'); await sleep(200);
  await pickerReady();
  check(await visible('#pickSec .rb-moves'), 'Move picker: On shows it again');
  // find a turn where the player to move has a guessed move (one not seen in the replay)
  for (let i = 0; i < 40 && !await page.$('#pickSec [data-edit]'); i++) { await press('ArrowRight'); await sleep(250); }
  const guessed = await page.$('#pickSec [data-edit]');
  if (guessed) {
    const old = await page.$eval('#pickSec [data-edit]', b => b.dataset.edit);
    await guessed.click(); await sleep(100);
    await page.$eval('.rb-mvinput', el => { el.value = ''; });
    await page.type('.rb-mvinput', 'Protect'); await page.keyboard.press('Enter'); await sleep(300);
    const moves = await page.$$eval('#pickSec .rb-mv b', b => b.map(x => x.textContent));
    check(moves.includes('Protect') && !moves.includes(old), 'a guessed move can be edited inline', `${old} -> ${moves.join('/')}`);
  } else check(false, 'a guessed move to edit');
  await control('reset'); await sleep(400);
  for (let i = 0; i < 4; i++) { await control('ff'); await sleep(250); }

  // ---------------------------------------------------------------- a line, its dice
  await branchTurn();
  check(await inLine(), 'picking another move (keyboard for player 2) starts a line');
  const logBefore = await text('.battle-log');
  const chip = await page.$('#diceSec button.rb-chip[title]');   // a yes/no outcome (speed-tie chips have no title)
  if (chip) {
    const before = await page.$eval('#diceSec button.rb-chip[title]', c => c.textContent);
    await chip.click(); await sleep(300); await settled();
    const after = await page.$eval('#diceSec button.rb-chip[title]', c => c.textContent);
    check(before !== after && await page.$('#diceSec .rb-chip.dev') !== null, 'clicking a dice chip changes the outcome', `${before} -> ${after}`);
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
  const lineCount = await page.$$eval('#studySec .rb-tok', t => t.length);
  const tokens = await page.$$eval('#studySec .rb-tok', t => t.map(x => x.textContent));
  check(tokens.some(t => t.includes('!?') && t.includes('interesting try')), 'glyph and note show on the line');

  await page.reload({waitUntil: 'domcontentloaded'});
  await pickerReady();
  const reloaded = await page.$$eval('#studySec .rb-tok', t => t.map(x => x.textContent));
  check(reloaded.length === lineCount && reloaded.some(t => t.includes('!?') && t.includes('interesting try')), 'the study is kept across a reload', reloaded.length + ' lines');

  // ---------------------------------------------------------------- export, delete, import
  await page.click('#btnExport'); await sleep(200);
  const exported = await page.$eval('#exportBox', el => el.value);
  check(exported.startsWith('{"rbv":1') && await visible('#exporter'), 'Export shows the study');
  await page.click('#btnCloseExport');
  await page.click('#studySec .rb-tok'); await sleep(300); await settled();
  await page.click('#btnDelete'); await sleep(100);
  check(/again/.test(await text('#btnDelete')), 'Delete asks for a second click');
  await page.click('#btnDelete'); await sleep(300);
  check(await page.$$eval('#studySec .rb-tok', t => t.length) === lineCount - 1 && !await inLine(), 'Delete removes the line');
  await page.click('#btnLoad'); await sleep(200);
  await page.$eval('#pasteBox', (el, v) => { el.value = v; }, exported);
  await page.click('#btnDoLoad'); await sleep(1000);
  await pickerReady();
  check(!await visible('#loader') && await page.$$eval('#studySec .rb-tok', t => t.length) === lineCount, 'loading the export brings the lines back');

  // ---------------------------------------------------------------- teams tab
  await page.click('[data-tab=teams]'); await sleep(300);
  const cards = await page.$$('#studySec .rb-mon');
  check(cards.length >= 6, 'Teams shows both teams', cards.length + ' sets');
  const field = await page.$('#studySec input[data-field=item]');
  await field.evaluate(el => { el.focus(); el.select(); }); await field.type('Leftovers'); await page.keyboard.press('Tab'); await sleep(200);
  check(await page.$eval('#studySec input[data-field=item]', el => el.value) === 'Leftovers', 'a set can be edited');
  await page.click('[data-tab=study]'); await sleep(200);

  // ---------------------------------------------------------------- other formats, loaded by link
  for (const format of FORMATS) {
    const found = await page.evaluate(async f => {
      const r = await fetch(`https://replay.pokemonshowdown.com/search.json?format=${f}`);
      return r.ok ? (await r.json()).map(x => x.id) : [];
    }, format);
    if (!found.length) { check(false, `${format}: find a replay`); continue; }
    const id = found[0];
    await page.click('#btnLoad'); await sleep(200);
    await page.type('#replayUrl', `https://replay.pokemonshowdown.com/${id}`);
    await page.click('#btnDoLoad');
    await until(() => document.querySelector('#loader').hidden, null, 30000); await sleep(800);
    const title = await text('#rbTitle');
    check(!await text('#loadErr'), `${format}: loads ${id}`, title.slice(0, 60));
    if (!await visible('#pickSec .rb-pside')) { await control('ff'); await sleep(500); }   // no team preview: start at turn 1
    await branchTurn();
    const err = await text('#pickSec .rb-err');
    check(await inLine() && !err, `${format}: taking over a turn works`, err);
  }

  // ---------------------------------------------------------------- dark mode, phone width
  await page.click('.colorchooser button[value=dark]'); await sleep(200);
  const bg = await page.$eval('#studySec', el => getComputedStyle(el).backgroundColor);
  check(await page.$eval('body', b => b.classList.contains('dark')) && bg === 'rgb(38, 41, 46)', 'dark mode recolours the panels', bg);
  await page.click('.colorchooser button[value=light]');
  await page.setViewport({width: 412, height: 900}); await sleep(800);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  check(width <= 412, 'phone width: nothing sticks out sideways', width + 'px');
  await page.setViewport({width: 1280, height: 1000});
} catch (e) {
  check(false, 'test run', e.stack || e.message);
  await page.screenshot({path: path.join(root, 'e2e-failure.png')}).catch(() => {});
}

check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '));
check(failedRequests.length === 0, 'no failed requests', failedRequests.join(' | '));
await browser.close();
server?.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
