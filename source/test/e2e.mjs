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
// One replay per kind of format: team preview + Tera, Mega Evolution + Z-Moves, Dynamax (random battles), no team preview,
// the oldest gens.
const FORMATS = ['gen9ou', 'gen7ou', 'gen8randombattle', 'gen9randombattle', 'gen4ou', 'gen3ou', 'gen2ou', 'gen1ou'];
const GIMMICK_FORMATS = ['gen7ou', 'gen8randombattle'];   // where a Mega Evolution / Z-Power / Dynamax box should turn up

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
// Branch this turn: player 1 picks something other than what was played, player 2 their first option (by its number key).
// (On a turn where player 1 could not move, the replay does not show their choice and any move follows it: use a later turn.)
async function branchTurn() {
  await pickerReady();
  for (let i = 0; i < 10 && !await page.$('#pickSec [data-pick].played'); i++) { await press('ArrowRight'); await pickerReady(); }
  const other = await page.$('#pickSec [data-pick]:not(.played):not(:disabled)');
  await other.click(); await sleep(150);
  if (await page.$('#rbTitle .rb-mode')) return settled();   // only one player had a choice
  await pickerReady();
  const first = await page.$$eval('#pickSec [data-pick]', b => b.findIndex(x => !x.disabled) + 1);
  await press(String(first));
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
  const bench = await page.$$eval('#pickSec .rb-sw', b => [b.length, b.filter(x => !x.disabled).length]);
  check(bench[0] === 5 && bench[1] === 5, 'every Pokemon on the bench can be switched in on turn 1', `${bench[1]} of ${bench[0]}`);
  const ranges = await page.$$eval('#pickSec .rb-dmg', d => d.map(x => x.textContent));
  check(ranges.length > 0 && ranges.every(r => /^[\d.]+ - [\d.]+%$/.test(r)), 'attacking moves show the damage calc range', ranges.join(', '));
  await page.hover('#pickSec .rb-mv[data-calc]');
  const tip = await text('#tooltipwrapper');
  check(/Accuracy/.test(tip), "hovering a move shows Showdown's move tooltip");
  check(/ vs\. .+: \d+-\d+ \(/.test(tip), "and the damage calc's result", tip.slice(tip.indexOf(' vs. ') - 40, tip.indexOf(' vs. ') + 60));
  await page.hover('#pickSec .rb-sw');
  check(/HP/.test(await text('#tooltipwrapper')), "hovering a Pokemon shows Showdown's Pokemon tooltip");

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
    await other.close();
  }
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
  // a set typed in, contradicting the replay: Talonflame was seen using Roost, and its U-turn did less than Choice Band would
  await page.click('[data-import="0"]'); await sleep(200);
  await page.$eval('#importText', el => {
    el.value = ['Talonflame @ Choice Band', 'Ability: Gale Wings', 'EVs: 252 Atk / 4 Def / 252 Spe', 'Adamant Nature',
      '- Brave Bird', '- Flare Blitz', '- U-turn', '- Swords Dance'].join('\n');
    el.dispatchEvent(new Event('input'));
  });
  await page.click('#btnImport');
  await until(() => !document.querySelector('#importProblems').hidden || document.querySelector('#importErr').textContent, null, 30000);
  const flagged = await page.$$eval('#importProblems li', l => l.map(x => x.textContent));
  check(flagged.some(p => /no Roost/.test(p)) && flagged.some(p => /Talonflame's .+ the sets allow/.test(p)), 'moves and damage the replay shows are checked', flagged.filter(p => /Talonflame/.test(p)).join(' | '));
  await page.click('#btnImport'); await sleep(300);
  const imported = await page.$$eval('#studySec .rb-mon', cards => {
    const card = cards.find(c => c.querySelector('.nm').textContent.includes('Talonflame'));
    return card && {item: card.querySelector('[data-field=item]').value, guesses: card.querySelectorAll('.guess').length};
  });
  check(!await visible('#importer') && imported?.item === 'Choice Band' && imported.guesses === 0, 'Import anyway uses the set (no longer shown as a guess)');
  // the Teams tab keeps listing the mismatches, and follows edits
  await until(() => !document.querySelector('#teamCheck').hidden, null, 30000);
  const live = await page.$$eval('#teamCheck li', l => l.map(x => x.textContent));
  check(live.some(p => /no Roost/.test(p)) && live.some(p => /Talonflame/.test(p) && / vs\. | the sets allow /.test(p)),
    'the Teams tab lists what the imported sets cannot be', live.join(' | '));
  await page.$$eval('#studySec .rb-mon', cards => {
    const card = cards.find(c => c.querySelector('.nm').textContent.includes('Talonflame'));
    const box = card.querySelector('[data-field=move3]');
    box.value = 'Roost'; box.dispatchEvent(new Event('change'));
  });
  await sleep(1500);
  const after = await page.$$eval('#teamCheck li', l => l.map(x => x.textContent));
  check(!after.some(p => /no Roost/.test(p)), 'fixing the set clears its line', after.join(' | '));
  // importing the other side too: hits between two known sets read like the damage calc, spreads included
  await page.click('[data-import="1"]'); await sleep(200);
  await page.$eval('#importText', el => {
    el.value = ['Donphan @ Leftovers', 'Ability: Sturdy', 'EVs: 252 HP / 4 Atk / 252 Def', 'Impish Nature',
      '- Earthquake', '- Ice Shard', '- Knock Off', '- Rapid Spin'].join('\n');
    el.dispatchEvent(new Event('input'));
  });
  await page.click('#btnImport');
  await until(() => !document.querySelector('#importProblems').hidden || document.querySelector('#importer').hidden, null, 30000);
  if (await visible('#importer')) await page.click('#btnImport');
  await sleep(1500);
  const both = await page.$$eval('#teamCheck li', l => l.map(x => x.textContent));
  check(both.some(p => /Talonflame U-turn vs\. 252 HP \/ 252\+ Def .*Donphan: .+, the replay shows 7%/.test(p)),
    'with both sides imported, a hit reads like the damage calc', both.filter(p => /Donphan/.test(p)).join(' | '));
  await page.click('[data-tab=study]'); await sleep(200);

  // ---------------------------------------------------------------- back to the landing page: recent studies, search
  await page.click('#home'); await sleep(300);
  const recent = await page.$$eval('#recent [data-visit]', r => r.map(x => x.textContent));
  check(await visible('#landing') && recent.some(r => /wssi vs\. wintminter/.test(r) && /\b\d+\b/.test(r)), 'Recent lists the study with its lines', recent[0]);
  await page.type('#searchFormat', 'gen9ou'); await page.click('#searchForm button[type=submit]');
  await until(() => document.querySelectorAll('#searchResults [data-visit]').length, null, 30000);
  const result = await page.$eval('#searchResults [data-visit]', r => r.dataset.visit);
  await page.click('#searchResults [data-visit]');
  await pickerReady().catch(() => {});
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
    if (GIMMICK_FORMATS.includes(format)) {
      // back on the replay, walk the turns to one where the player to move can Mega Evolve / use Z-Power / Dynamax
      await control('reset'); await sleep(400);
      const GIMMICK = '#pickSec [data-gimmick]:not([data-gimmick=terastallize])';
      for (let i = 0; i < 60 && !await page.$(GIMMICK); i++) {
        // player 2's choice too: pick player 1's first option, look, and take it back
        const first = await page.$('#pickSec .rb-mv:not(:disabled)');
        if (first && /what will/.test(await question())) {
          const q = await question();
          await first.click(); await sleep(150);
          if (await page.$(GIMMICK)) break;
          if (await page.$('#btnUndo') && await question() !== q) { await page.click('#btnUndo'); await sleep(150); }
          if (await page.$('#rbTitle .rb-mode')) { await settled(); await press('ArrowLeft'); await sleep(200); }
        }
        await press('ArrowRight'); await sleep(200);
      }
      const box = await page.$('#pickSec [data-gimmick]:not([data-gimmick=terastallize])');
      if (!box) { check(false, `${format}: a Mega Evolution / Z-Power / Dynamax choice turns up`); continue; }
      const kind = await box.evaluate(b => b.parentElement.textContent.trim());
      const before = await page.$$eval('#pickSec .rb-mv b', b => b.map(x => x.textContent).join('/'));
      await press('t');   // ticks it
      const after = await page.$$eval('#pickSec .rb-mv b', b => b.map(x => x.textContent).join('/'));
      check(await page.$eval('#pickSec [data-gimmick]:not([data-gimmick=terastallize])', b => b.checked), `${format}: ${kind} can be ticked`,
        before === after ? before : `${before} -> ${after}`);
      const move = await page.$('#pickSec .rb-mv:not(:disabled)');
      await move.click(); await sleep(150);
      if (!await page.$('#rbTitle .rb-mode')) { await pickerReady(); const n = await page.$$eval('#pickSec [data-pick]', b => b.findIndex(x => !x.disabled) + 1); await press(String(n)); }
      await until(() => document.querySelector('#rbTitle .rb-mode') || document.querySelector('#pickSec .rb-err') ||
        document.querySelector('.rb-mrow.cur'), null, 30000);
      await settled();
      check(!await text('#pickSec .rb-err'), `${format}: playing a turn with ${kind} works`, await text('#pickSec .rb-err'));
    }
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
