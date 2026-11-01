// Build the site into the repository root from source/:
//   app.js              source/app/*.js bundled (engine.js stays a separate file, imported at start-up)
//   index.html          source/index.template.html + the sample replay (the viewer's first render) + the password hash
//   style.css           source/style.css
//   js/replay-embed.js  Showdown's replay embed with a few small changes (source/embed/make-embed.mjs)
//   engine.js           only with --engine: the simulator bundle (source/engine/build-engine.mjs)
// The password hash comes from RBV_PW_HASH or source/.pwhash (not committed); without one the page has no gate.
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import * as esbuild from 'esbuild';
import {makeEmbed} from './embed/make-embed.mjs';
import {buildEngine} from './engine/build-engine.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = p => path.join(root, p);
const read = p => fs.readFileSync(at(p), 'utf8');

if (process.argv.includes('--engine')) await buildEngine(at('engine.js'));

await esbuild.build({entryPoints: [at('source/app/main.js')], bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
  outfile: at('app.js'), external: ['./engine.js'], logLevel: 'warning'});

fs.mkdirSync(at('js'), {recursive: true});
fs.writeFileSync(at('js/replay-embed.js'), makeEmbed(read('source/embed/replay-embed.upstream.js')));
fs.copyFileSync(at('source/style.css'), at('style.css'));

const sample = JSON.parse(read('sample.json'));
const pwHash = (process.env.RBV_PW_HASH || (fs.existsSync(at('source/.pwhash')) ? read('source/.pwhash') : '')).trim();
const html = read('source/index.template.html')
  .replace('{{REPLAY_ID}}', () => sample.id)
  .replace('{{REPLAY_LOG}}', () => sample.log.replace(/\//g, '\\/'))   // the embed un-escapes \/ (so </script> cannot end the tag)
  .replace('{{PW_HASH}}', () => pwHash);
fs.writeFileSync(at('index.html'), html);
console.log('built', pwHash ? '(password gate on)' : '(no password gate)');
