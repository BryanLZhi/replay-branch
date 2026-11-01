// Pack the gen5 front/back sprites into one sheet each (96x96 cells) + an index; copy sheets and backgrounds into site/.
import fs from 'fs';
import path from 'path';
import {PNG} from 'pngjs';
const C = 96, COLS = 32;
fs.mkdirSync('site/img', {recursive: true});
for (const dir of ['gen5', 'gen5-back']) {
  const files = fs.readdirSync('raw/' + dir).filter(f => f.endsWith('.png')).sort();
  const rows = Math.ceil(files.length / COLS);
  const out = new PNG({width: COLS * C, height: rows * C});
  out.data.fill(0);
  const index = {};
  let k = 0, bad = 0;
  for (const f of files) {
    let src;
    try { src = PNG.sync.read(fs.readFileSync(path.join('raw', dir, f))); } catch { bad++; continue; }
    const ox = (k % COLS) * C, oy = Math.floor(k / COLS) * C;
    const w = Math.min(C, src.width), h = Math.min(C, src.height);
    const dx = ox + Math.floor((C - w) / 2), dy = oy + (C - h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = ((y + (src.height - h)) * src.width + x) * 4, di = ((dy + y) * out.width + dx + x) * 4;
      out.data[di] = src.data[si]; out.data[di + 1] = src.data[si + 1]; out.data[di + 2] = src.data[si + 2]; out.data[di + 3] = src.data[si + 3];
    }
    index[f.replace(/\.png$/, '')] = k++;
  }
  const name = dir === 'gen5' ? 'front' : 'back';
  fs.writeFileSync(`site/img/${name}.png`, PNG.sync.write(out, {colorType: 6}));
  fs.writeFileSync(`site/img/${name}.json`, JSON.stringify({cell: C, cols: COLS, index}));
  console.log(name, k, 'sprites', bad, 'bad', fs.statSync(`site/img/${name}.png`).size, 'bytes');
}
for (const f of fs.readdirSync('raw/sheets')) fs.copyFileSync('raw/sheets/' + f, 'site/img/' + f);
for (const f of fs.readdirSync('raw/fx')) fs.copyFileSync('raw/fx/' + f, 'site/img/' + f);
console.log(fs.readdirSync('site/img').join(' '));
