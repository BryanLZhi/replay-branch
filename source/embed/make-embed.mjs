// Our copy of https://play.pokemonshowdown.com/js/replay-embed.js (Pokemon Showdown, MIT), changed to:
//  - run its scripts in order (added script tags are async, so jQuery could run after a script that needs it),
//  - not load teambuilder-tables.js (16 MB, only used by tooltips for older generations; the app loads it later), and
//  - prefix move-effect image paths with Dex.fxPrefix before the first battle is built (otherwise they 404).
export function makeEmbed(upstream) {
  let e = upstream;
  const change = (from, to) => {
    if (!e.includes(from)) throw new Error('replay-embed.js changed upstream: ' + from.slice(0, 60));
    e = e.replace(from, () => to);
  };
  change('scriptEl.src=url;', 'scriptEl.src=url;scriptEl.async=false;');
  change("requireScript('https://play.pokemonshowdown.com/data/teambuilder-tables.js?a7');\n", '');
  change('init:function(){var _this=this;', 'init:function(){var _this=this;\n' +
    'try{if(window.BattleEffects&&window.Dex&&Dex.fxPrefix){for(var fx in BattleEffects){var ef=BattleEffects[fx];' +
    'if(ef&&ef.url&&!/^(https?:)?\\/\\//.test(ef.url))ef.url=Dex.fxPrefix+ef.url;}}}catch(err){}');
  return '/* Copy of https://play.pokemonshowdown.com/js/replay-embed.js (Pokemon Showdown, MIT, Guangcong Luo).\n' +
    ' * Changes: runs its scripts in order; does not load teambuilder-tables.js; fixes move-effect image paths. */\n' + e;
}
