// Local copy of Showdown's replay-embed.js (MIT): skip teambuilder-tables.js (15.8 MB, unused by replays) and
// fix the move-effect image paths before the first battle is built.
import fs from 'fs';
let e = fs.readFileSync('replay-embed.orig.js', 'utf8');
const rep = (a, b) => { if (!e.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); e = e.replace(a, () => b); };
rep("requireScript('https://play.pokemonshowdown.com/data/teambuilder-tables.js?a7');\n", '');
rep('init:function(){var _this=this;', `init:function(){var _this=this;
try{if(window.BattleEffects&&window.Dex&&Dex.fxPrefix){for(var fx in BattleEffects){var ef=BattleEffects[fx];if(ef&&ef.url&&!/^(https?:)?\\/\\//.test(ef.url))ef.url=Dex.fxPrefix+ef.url;}}}catch(err){}`);
e = `/* Copy of https://play.pokemonshowdown.com/js/replay-embed.js (Pokemon Showdown, MIT, Guangcong Luo).
 * Changes for Replay Branch: does not load teambuilder-tables.js; fixes move-effect image paths before the first battle. */
` + e;
fs.mkdirSync('site/js', {recursive: true});
fs.writeFileSync('site/js/replay-embed.js', e);
let t = fs.readFileSync('template.html', 'utf8');
t = t.replace('<script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>', '<script src="js/replay-embed.js"></script>');
fs.writeFileSync('template.html', t);
console.log('embed', e.length, 'template uses local', t.includes('src="js/replay-embed.js"'));
