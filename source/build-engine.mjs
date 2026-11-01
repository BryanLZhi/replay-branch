// Bundle the branch engine for the browser. Learnset data (~3.4 MB, only used by the team validator) is left out.
import * as esbuild from 'esbuild';
const out = process.argv[2] || '../rbv3/site/engine.js';
const noLearnsets = {
  name: 'no-learnsets',
  setup(b) {
    b.onLoad({filter: /[\\/]learnsets\.mjs$/}, () => ({contents: 'export const Learnsets = {};', loader: 'js'}));
    // legality tables are merged into the learnsets at load (validator-only data too)
    b.onLoad({filter: /[\\/]legality\.mjs$/}, () => ({contents: 'export const Legality = {};', loader: 'js'}));
  },
};
const r = await esbuild.build({entryPoints: ['src/browser.mjs'], bundle: true, minify: true, keepNames: true, format: 'esm', platform: 'browser',
  outfile: out, plugins: [noLearnsets], logLevel: 'warning', metafile: true});
const size = Object.values(r.metafile.outputs)[0].bytes;
console.log('engine.js', (size / 1e6).toFixed(2), 'MB ->', out);
