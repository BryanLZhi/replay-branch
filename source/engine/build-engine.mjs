// Bundle the simulator for the browser. Learnsets (~3.4 MB) and the legality tables merged into them are only used by
// the team validator, so they are left out. keepNames: @pkmn/sim's State serialisation relies on class names.
// global: Node's name for globalThis, used by some format rules (random battles' Pokemon of the Day).
import path from 'path';
import {fileURLToPath} from 'url';
import * as esbuild from 'esbuild';

const validatorOnly = {
  name: 'validator-only-data',
  setup(b) {
    b.onLoad({filter: /[\\/]learnsets\.mjs$/}, () => ({contents: 'export const Learnsets = {};', loader: 'js'}));
    b.onLoad({filter: /[\\/]legality\.mjs$/}, () => ({contents: 'export const Legality = {};', loader: 'js'}));
  },
};

export async function buildEngine(outfile) {
  const r = await esbuild.build({entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser.mjs')],
    bundle: true, minify: true, keepNames: true, format: 'esm', platform: 'browser', outfile, plugins: [validatorOnly],
    define: {global: 'globalThis'}, logLevel: 'warning', metafile: true});
  console.log('engine.js', (Object.values(r.metafile.outputs)[0].bytes / 1e6).toFixed(2), 'MB');
}
