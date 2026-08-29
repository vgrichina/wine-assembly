#!/usr/bin/env node
'use strict';
// Read individual pixels out of one or more PNGs.
//
// png-diff.js answers "did these two pictures change"; dump2png.js turns bytes
// into a picture. Neither answers "what colour is (x,y) here" -- the question
// every "is this pixel black because nothing drew it, or because something drew
// black" investigation ends up asking. Eyeballing a rendered image guesses at
// coordinates, and a guess is what makes an orientation bug look like a render
// bug.
//
// Usage: node tools/png-pixel.js <x,y[;x,y...]> <file.png> [file.png ...]
//        node tools/png-pixel.js --black <file.png>     # count/bbox of pure black
const fs = require('fs');
const path = require('path');
const { PNG } = require(path.join(__dirname, '..', 'node_modules', 'pngjs'));

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('usage: png-pixel.js <x,y[;x,y...]> <file.png> [...]  |  --black <file.png>');
  process.exit(2);
}

const blackMode = argv[0] === '--black';
const points = blackMode ? [] : argv[0].split(';').map(p => p.split(',').map(Number));
const files = argv.slice(1);

for (const file of files) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
  };
  if (blackMode) {
    let n = 0, x0 = png.width, y0 = png.height, x1 = -1, y1 = -1;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const p = at(x, y);
      if (!p[0] && !p[1] && !p[2]) {
        n++;
        if (x < x0) x0 = x; if (y < y0) y0 = y;
        if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
    }
    const share = (100 * n / (png.width * png.height)).toFixed(2);
    console.log(`${path.basename(file)}  ${png.width}x${png.height}  black ${n} (${share}%)` +
      (n ? `  bbox ${x0},${y0}-${x1},${y1}` : ''));
  } else {
    const parts = points.map(([x, y]) => {
      const p = at(x, y);
      return p ? `(${x},${y})=${p.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}`
               : `(${x},${y})=out-of-range`;
    });
    console.log(`${path.basename(file)}  ${png.width}x${png.height}  ${parts.join('  ')}`);
  }
}
