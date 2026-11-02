// Build the site into the repository root from source/:
//   app.js              source/app/*.js bundled (engine.js stays a separate file, imported at start-up)
//   index.html          source/index.template.html + the sample replay (the viewer's first render) + the password hash
//   style.css           source/style.css
//   js/replay-embed.js  Showdown's replay embed with a few small changes (source/embed/make-embed.mjs)
//   engine.js           only with --engine: the simulator bundle (source/engine/build-engine.mjs)
//   validator.js        only with --engine: Showdown's team validator, imported when a new battle starts (source/engine/validator.mjs)
// The password hash comes from RBV_PW_HASH or source/.pwhash (not committed); without one the page has no gate.
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import {fileURLToPath} from 'url';
import * as esbuild from 'esbuild';
import {makeEmbed} from './embed/make-embed.mjs';
import {buildEngine, buildValidator} from './engine/build-engine.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = p => path.join(root, p);
const read = p => fs.readFileSync(at(p), 'utf8');

if (process.argv.includes('--engine')) { await buildEngine(at('engine.js')); await buildValidator(at('validator.js')); }

await esbuild.build({entryPoints: [at('source/app/main.js')], bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
  outfile: at('app.js'), external: ['./engine.js', './validator.js'], logLevel: 'warning'});

fs.mkdirSync(at('js'), {recursive: true});
fs.writeFileSync(at('js/replay-embed.js'), makeEmbed(read('source/embed/replay-embed.upstream.js')));
fs.copyFileSync(at('source/style.css'), at('style.css'));

const sample = JSON.parse(read('sample.json'));
const pwHash = (process.env.RBV_PW_HASH || (fs.existsSync(at('source/.pwhash')) ? read('source/.pwhash') : '')).trim();
let html = read('source/index.template.html')
  .replace('{{REPLAY_ID}}', () => sample.id)
  .replace('{{REPLAY_LOG}}', () => sample.log.replace(/\//g, '\\/'))   // the embed un-escapes \/ (so </script> cannot end the tag)
  .replace('{{PW_HASH}}', () => pwHash);
// Content Security Policy (hosts without a scheme: the page's own, as Showdown loads its files): scripts only from here and Showdown (plus the inline password gate, by its hash); data only to
// Showdown's replay server and PokéPaste; images, sounds and fonts from Showdown.
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
const csp = [
  `default-src 'self'`, `script-src 'self' play.pokemonshowdown.com ${inline.join(' ')}`,
  `style-src 'self' 'unsafe-inline' play.pokemonshowdown.com`, `img-src 'self' data: play.pokemonshowdown.com pokemonshowdown.com`,
  `font-src 'self' play.pokemonshowdown.com`, `media-src 'self' play.pokemonshowdown.com`,
  `connect-src 'self' replay.pokemonshowdown.com pokepast.es`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-src 'none'`,
].join('; ');
html = html.replace('{{CSP}}', () => csp);
fs.writeFileSync(at('index.html'), html);
console.log('built', pwHash ? '(password gate on)' : '(no password gate)');
