# Replay Branch

A study board for Pokémon Showdown replays. Watch a replay in Showdown's own replay viewer, take over at any turn, and play out
your own lines: you choose both players' moves and every random outcome (accuracy, crits, damage rolls, secondary effects, speed ties).
Lines branch like a chess study, and unknown sets are filled in from Smogon usage stats, all editable.

- **Viewer:** Pokémon Showdown's replay embed (`replay-embed.js`, MIT), loaded from play.pokemonshowdown.com like a downloaded replay.
- **Branch simulator:** [@pkmn/sim](https://github.com/pkmn/ps) (MIT), bundled in `engine.js`.
- **Usage stats:** Smogon's monthly stats via [pkmn.github.io/smogon](https://pkmn.github.io/smogon/data/stats/), compacted in `stats/`.

The source for the page and the engine bundle is in `source/` (build with `npm install`, then
`npx esbuild source/src/browser.mjs --bundle --minify --keep-names --format=esm --platform=browser --outfile=engine.js`).

Not affiliated with Pokémon Showdown, Smogon, Nintendo or Game Freak. Pokémon and its sprites are trademarks of their owners.
