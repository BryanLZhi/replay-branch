// Bundle the simulator for the browser. Learnsets (~3.4 MB) and the legality tables merged into them are only used by
// the team validator, so they are left out. keepNames: @pkmn/sim's State serialisation relies on class names.
// global: Node's name for globalThis, used by some format rules (random battles' Pokemon of the Day).
// The team validator goes in a file of its own (validator.js) with them, but without the descriptions of moves, items and
// abilities, which it never uses.
import path from 'path';
import {fileURLToPath} from 'url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

const validatorOnly = {
  name: 'validator-only-data',
  setup(b) {
    b.onLoad({filter: /[\\/]learnsets\.mjs$/}, () => ({contents: 'export const Learnsets = {};', loader: 'js'}));
    b.onLoad({filter: /[\\/]legality\.mjs$/}, () => ({contents: 'export const Legality = {};', loader: 'js'}));
  },
};
const noDescriptions = {
  name: 'no-descriptions',
  setup(b) {
    const names = {abilities: 'AbilitiesText', items: 'ItemsText', moves: 'MovesText', default: 'DefaultText'};
    b.onLoad({filter: /[\\/]data[\\/]text[\\/](abilities|items|moves|default)\.mjs$/},
      a => ({contents: `export const ${names[path.basename(a.path, '.mjs')]} = {};`, loader: 'js'}));
  },
};

const bundle = async (entry, outfile, plugins) => {
  const r = await esbuild.build({entryPoints: [path.join(here, entry)], bundle: true, minify: true, keepNames: true, format: 'esm',
    platform: 'browser', outfile, plugins, define: {global: 'globalThis'}, logLevel: 'warning', metafile: true});
  console.log(path.basename(outfile), (Object.values(r.metafile.outputs)[0].bytes / 1e6).toFixed(2), 'MB');
};
export const buildEngine = outfile => bundle('browser.mjs', outfile, [validatorOnly]);
export const buildValidator = outfile => bundle('validator.mjs', outfile, [noDescriptions]);
