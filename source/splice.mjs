// Build v3 app.js from the v2 app: swap the loader block and the view/controls block, drop sprite patching.
import fs from 'fs';
let s = fs.readFileSync('app.js', 'utf8');
const cut = (a, b, repl) => {
  const i = s.indexOf(a), j = s.indexOf(b);
  if (i < 0 || j < 0 || j < i) throw new Error('marker missing: ' + a + ' / ' + b);
  s = s.slice(0, i) + repl + s.slice(j);
};
cut('// ------------------------------------------------------------------ loading the Showdown client and the sim', 'function save()', fs.readFileSync('head.js', 'utf8'));
cut('// ------------------------------------------------------------------ the Showdown battle view', '// ------------------------------------------------------------------ take over + move picker', fs.readFileSync('view.js', 'utf8'));
// dark mode block is gone with the loader block? make sure no leftovers reference removed helpers
s = s.replace("const BUNDLED_AVATARS = new Set(['sprites/trainers/unknown.png', 'sprites/trainers-custom/uwcivbrazil.png', 'sprites/trainers-custom/scl6islanders2.png']);\n", '');
s = s.replace("const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';\n", '');
// icons come straight from Showdown now
s = s.replace("function iconStyle(species) { try { return Dex.getPokemonIcon(species).replace(/url\\([^)]*\\)/, 'url(sprites/pokemonicons-sheet.png)'); } catch { return ''; } }",
  "function iconStyle(species) { try { return Dex.getPokemonIcon(species); } catch { return ''; } }");
// loadText: refresh the embed's battle with the new log (the sample is already in it at start)
s = s.replace("  S.take = null; S.sel = {}; S.tera = {}; S.psMode = '';\n  go('r1');", "  S.take = null; S.sel = {}; S.tera = {};\n  if (!first) S.psMode = '';\n  S.cur = '';\n  go('r1');");
s = s.replace('async function loadText(text) {', 'async function loadText(text, first) {');
// keyboard: the embed has no keys of its own; keep ours, drop the v2 replay-key block
s = s.replace(/  \/\/ Showdown replay keys[\s\S]*?\n\}\);/, '});');
// selftest: adapt to the embed
s = s.replace(/async function selftest\(\) \{[\s\S]*?\n\}\nwindow\.addEventListener/, `async function selftest() {
  const out = []; const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
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
  const pre = document.createElement('pre'); pre.id = 'selftest'; pre.textContent = out.join('\\n'); document.body.appendChild(pre);
}
window.addEventListener`);
for (const gone of ['patchShowdown', 'mapSprite', 'applyDark', 'PS_SCRIPTS']) if (s.includes(gone + '(') || s.includes(gone + ' ')) console.log('leftover reference:', gone);
fs.writeFileSync('app3.js', s);
console.log('ok', s.length);
