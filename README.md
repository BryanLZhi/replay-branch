# Replay Branch

A study board for Pokémon Showdown replays. Watch a replay in Showdown's own replay viewer, take over at any turn, and play out
your own lines: you choose both players' moves and every random outcome (accuracy, crits, damage rolls, secondary effects, speed ties).
Lines branch like a chess study, and unknown sets are filled in from Smogon usage stats, all editable. Singles and doubles
(VGC, Doubles OU: each Pokémon's move and target); triples and free-for-all can only be watched.
Or start a new battle from two teams (pasted or PokéPaste links), and study it the same way.

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
| &nbsp;&nbsp;`landing.js` | the landing page: open a replay, recent studies, search Showdown's replays |
| &nbsp;&nbsp;`chapters.js` | studies of several replays (chapters, as in lichess studies): the chapter bar, Add to study, the Studies list, a whole study's share link |
| &nbsp;&nbsp;`state.js` | shared state and small helpers |
| &nbsp;&nbsp;`clean.js` | rebuilds studies (and studies of several replays) from share links, exports and storage field by field (nothing else gets through) |
| &nbsp;&nbsp;`study.js` | the study tree: replay positions `r<turn>`, your lines `n<id>`, computing positions |
| &nbsp;&nbsp;`replay.js` | facts read from the replay's log (who played what) |
| &nbsp;&nbsp;`viewer.js` | drives Showdown's replay viewer |
| &nbsp;&nbsp;`navigation.js` | the current position, going to another one, keyboard |
| &nbsp;&nbsp;`picker.js` | the turn bar: both players' choices for the turn on screen (what the replay did, until you change one), their move menus, Play turn |
| &nbsp;&nbsp;`tooltips.js` | Showdown's hover tooltips on the picker's buttons |
| &nbsp;&nbsp;`dice.js` | the dice of the turn on the bar (set before playing it; on the replay, as the turn went), else of a line's last step; their odds |
| &nbsp;&nbsp;`panels.js` | the study panel and its Study tab |
| &nbsp;&nbsp;`editor.js` | the position editor (Edit on the turn bar): HP, status, stat stages and items, weather, terrain, Trick Room, hazards and screens, applied as a step of its own |
| &nbsp;&nbsp;`teams.js` | the Teams tab, and importing a team (checked against the replay) |
| &nbsp;&nbsp;`load.js` | loading replays and studies, share links, which page the address shows (`?r=<replay>`, `?c=<study>&r=<chapter>`) |
| `source/engine/` | bundled into `engine.js`: `core.mjs` (replay parsing, sets, the simulator with controllable RNG), `calc.mjs` (Smogon's damage calc), `paste.mjs` (team import and its checks), `realdice.mjs` (the dice a replay turn rolled, found from its log), `edit.mjs` (an edited position: the change made with the simulator's own functions, and the lines that show it in the viewer) |
| `source/engine/validator.mjs` | bundled into `validator.js`, loaded only when a new battle starts: Showdown's team validator (with the learnsets and legality data `engine.js` leaves out) |
| `source/embed/` | Showdown's `replay-embed.js` and the small changes made to it for `js/replay-embed.js` |
| `source/index.template.html`, `source/style.css` | the page |
| `source/stats/build_stats.py` | rebuilds `stats/` |
| `source/test/e2e.mjs` | end-to-end test that drives the page like a visitor |
| `source/test/paste-check.mjs` | simulates battles between known teams to test the import checks (true sets pass, wrong ones are caught) |
| `source/test/takeover-check.mjs` | takes over every turn of recent replays and checks the position offers what the players did (moves, switches, Mega Evolution, Z-Moves, Dynamax, Tera) |
| `source/test/realdice-check.mjs` | finds the dice of every turn of recent replays from their logs and counts the turns that then play out as logged, and the misses, crits and effects recovered |
| `source/test/doubles-check.mjs` | doubles (VGC, Doubles OU): takes over every turn of recent replays and checks the simulator takes what each Pokémon did (move, target, switch, Tera...), finds the turn's dice, and plays random lines on |
| `source/test/roundtrip-check.mjs` | round trip: plays random battles with known teams (every move, ability and item in turn, as Showdown's exhaustive runner does), writes them out as replays, takes over at every turn and compares the rebuilt position with the real one (HP, status, boosts, effects, field, PP...), keeping what a replay cannot show apart |

## Development

```sh
npm install
npm run build:engine   # everything, including engine.js and validator.js (only needed when source/engine changes)
npm run build          # everything else
RBV_PW=<password> npm test   # serves the built site and tests it in Edge/Chrome; or: node source/test/e2e.mjs <url>
npm run test:paste           # the import checks against simulated battles (node source/test/paste-check.mjs <battles> <seed> <format>)
npm run test:takeover        # taking over every turn of recent replays, gens 1-9
```

The password gate's hash is read from `RBV_PW_HASH` or `source/.pwhash` (SHA-256 of `rbv:<password>`, not committed). Without it the
page has no gate. It only keeps casual visitors out: the site is static, so nothing on it is secret.

Not affiliated with Pokémon Showdown, Smogon, Nintendo or Game Freak. Pokémon and its sprites are trademarks of their owners.
