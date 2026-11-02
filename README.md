# Replay Branch

A study board for Pokémon Showdown replays. Watch a replay in Showdown's own replay viewer, take over at any turn, and play out
your own lines: you choose both players' moves and every random outcome (accuracy, crits, damage rolls, secondary effects, speed ties).
Lines branch like a chess study, and unknown sets are filled in from Smogon usage stats, all editable.

- **Viewer:** Pokémon Showdown's replay embed (`replay-embed.js`, MIT), with the battle scene loaded from play.pokemonshowdown.com.
- **Branch simulator:** [@pkmn/sim](https://github.com/pkmn/ps) (MIT), bundled in `engine.js`.
- **Damage calc:** [@smogon/calc](https://github.com/smogon/damage-calc) (MIT), bundled in `engine.js`.
- **Usage stats:** Smogon's monthly stats via [pkmn.github.io/smogon](https://pkmn.github.io/smogon/data/stats/), and random battle
  sets via [pkmn.github.io/randbats](https://pkmn.github.io/randbats/), compacted in `stats/`.

## Layout

The repository root is the site (GitHub Pages). Everything in it except `sample.json` and `stats/` is built from `source/`:

| Source | |
| --- | --- |
| `source/app/` | the page script, as ES modules bundled into `app.js` |
| &nbsp;&nbsp;`main.js` | start-up |
| &nbsp;&nbsp;`state.js` | shared state and small helpers |
| &nbsp;&nbsp;`study.js` | the study tree: replay positions `r<turn>`, your lines `n<id>`, computing positions |
| &nbsp;&nbsp;`replay.js` | facts read from the replay's log (who played what) |
| &nbsp;&nbsp;`viewer.js` | drives Showdown's replay viewer |
| &nbsp;&nbsp;`navigation.js` | the current position, going to another one, keyboard |
| &nbsp;&nbsp;`picker.js` | the move picker |
| &nbsp;&nbsp;`tooltips.js` | Showdown's hover tooltips on the picker's buttons |
| &nbsp;&nbsp;`dice.js` | the dice of a line's last step |
| &nbsp;&nbsp;`panels.js` | the study panel and its Study tab |
| &nbsp;&nbsp;`teams.js` | the Teams tab, and importing a team (checked against the replay) |
| &nbsp;&nbsp;`load.js` | loading replays and studies, share links |
| `source/engine/` | bundled into `engine.js`: `core.mjs` (replay parsing, sets, the simulator with controllable RNG), `calc.mjs` (Smogon's damage calc), `paste.mjs` (team import and its checks) |
| `source/embed/` | Showdown's `replay-embed.js` and the small changes made to it for `js/replay-embed.js` |
| `source/index.template.html`, `source/style.css` | the page |
| `source/stats/build_stats.py` | rebuilds `stats/` |
| `source/test/e2e.mjs` | end-to-end test that drives the page like a visitor |
| `source/test/paste-check.mjs` | simulates battles between known teams to test the import checks (true sets pass, wrong ones are caught) |
| `source/test/takeover-check.mjs` | takes over every turn of recent replays and checks the position offers what the players did (moves, switches, Mega Evolution, Z-Moves, Dynamax, Tera) |

## Development

```sh
npm install
npm run build:engine   # everything, including engine.js (only needed when source/engine changes)
npm run build          # everything else
RBV_PW=<password> npm test   # serves the built site and tests it in Edge/Chrome; or: node source/test/e2e.mjs <url>
npm run test:paste           # the import checks against simulated battles (node source/test/paste-check.mjs <battles> <seed> <format>)
npm run test:takeover        # taking over every turn of recent replays, gens 1-9
```

The password gate's hash is read from `RBV_PW_HASH` or `source/.pwhash` (SHA-256 of `rbv:<password>`, not committed). Without it the
page has no gate. It only keeps casual visitors out: the site is static, so nothing on it is secret.

Not affiliated with Pokémon Showdown, Smogon, Nintendo or Game Freak. Pokémon and its sprites are trademarks of their owners.
