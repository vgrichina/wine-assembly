#!/usr/bin/env node
// Inspect pixels in a rendered PNG: colour histogram, per-colour bounding box,
// and an ASCII map of a region.
//
// Every render test in this repo asserts on pixel counts ("47 black, 782 gray",
// "0 yellow px", "1015 dark px"). When one of those fails the next question is
// always the same — WHERE are those pixels — and answering it used to mean
// writing a throwaway script. This is that question as a tool.
//
// Usage:
//   node tools/png-probe.js <file.png> [--rect=x0,y0,x1,y1] [--top=N]
//   node tools/png-probe.js <file.png> --rect=23,260,76,328 --color=black
//   node tools/png-probe.js <file.png> --rect=23,260,76,328 --map
//
//   --rect=x0,y0,x1,y1  region to inspect (default: whole image), x1/y1 exclusive
//   --top=N             show the N most common colours (default 8)
//   --color=NAME|R,G,B  restrict to one colour; prints count + bounding box +
//                       the individual pixels when there are few of them
//   --tol=N             match tolerance per channel for --color (default 20)
//   --map               ASCII map of the region, one char per pixel
//   --exclude=x0,y0,x1,y1  ignore this inner rect (for margin-band probes)
//   --at=x,y[,x,y...]   print RGBA at these exact pixels, alpha included
//
// Alpha is why --at exists. Everything above reads RGB, which is the right
// question for a screen render; a --dump-gdi surface is not one. A surface
// nothing ever drew into and a surface filled black are the same picture until
// you read the alpha, and "the bitmap came out black" is the usual way a
// missing draw is first reported.

const fs = require('fs');
const path = require('path');

const NAMED = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [192, 192, 192],
  buttonface: [192, 192, 192],
  darkgray: [128, 128, 128],
  yellow: [255, 255, 0],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
};

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}
function nums(s) {
  return String(s).split(',').map(v => parseInt(v.trim(), 10));
}

async function readPixels(file) {
  // Decoding a PNG needs a PNG decoder, not a canvas.
  const { PNG } = require('pngjs');
  const img = PNG.sync.read(require('fs').readFileSync(file));
  return { width: img.width, height: img.height, data: img.data };
}

(async () => {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('usage: node tools/png-probe.js <file.png> [--rect=x0,y0,x1,y1] [--color=NAME] [--map]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`no such file: ${file}`);
    process.exit(2);
  }
  const img = await readPixels(file);

  const rect = arg('rect') ? nums(arg('rect')) : [0, 0, img.width, img.height];
  const [x0, y0, x1, y1] = rect;
  const exclude = arg('exclude') ? nums(arg('exclude')) : null;
  const tol = parseInt(arg('tol', '20'), 10);
  const topN = parseInt(arg('top', '8'), 10);
  const wantMap = process.argv.includes('--map');
  const colorArg = arg('color');

  let target = null;
  if (colorArg) {
    const named = NAMED[colorArg.toLowerCase()];
    target = named || nums(colorArg);
    if (!target || target.length !== 3 || target.some(Number.isNaN)) {
      console.error(`unknown colour: ${colorArg} (try ${Object.keys(NAMED).join(', ')} or R,G,B)`);
      process.exit(2);
    }
  }

  const inExclude = (x, y) =>
    exclude && x >= exclude[0] && x < exclude[2] && y >= exclude[1] && y < exclude[3];

  const hist = new Map();
  const hits = [];
  let bbox = null;
  let total = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (inExclude(x, y)) continue;
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      total++;
      const key = `${r},${g},${b}`;
      hist.set(key, (hist.get(key) || 0) + 1);
      if (target &&
          Math.abs(r - target[0]) <= tol &&
          Math.abs(g - target[1]) <= tol &&
          Math.abs(b - target[2]) <= tol) {
        hits.push([x, y]);
        bbox = bbox
          ? [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)]
          : [x, y, x, y];
      }
    }
  }

  console.log(`${path.basename(file)}  ${img.width}x${img.height}`);

  if (arg('at')) {
    const at = nums(arg('at'));
    console.log('');
    for (let i = 0; i + 1 < at.length; i += 2) {
      const [x, y] = [at[i], at[i + 1]];
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) {
        console.log(`  (${x},${y})  outside the image`);
        continue;
      }
      const p = (y * img.width + x) * 4;
      const [r, g, b, a] = [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
      console.log(`  (${x},${y})  rgba(${r},${g},${b},${a})  ${hex}` +
        (a === 0 ? '  TRANSPARENT' : a !== 255 ? `  alpha ${a}/255` : ''));
    }
    return;
  }

  console.log(`region x=${x0}..${x1} y=${y0}..${y1}${exclude ? `  excluding x=${exclude[0]}..${exclude[2]} y=${exclude[1]}..${exclude[3]}` : ''}  (${total} px)`);

  if (target) {
    console.log(`\ncolour ${target.join(',')} +/-${tol}: ${hits.length} px`);
    if (bbox) {
      console.log(`bounding box x=${bbox[0]}..${bbox[2]} y=${bbox[1]}..${bbox[3]}`);
      const byRow = new Map();
      for (const [x, y] of hits) {
        if (!byRow.has(y)) byRow.set(y, []);
        byRow.get(y).push(x);
      }
      const rows = [...byRow.keys()].sort((a, b) => a - b);
      for (const y of rows.slice(0, 24)) {
        const xs = byRow.get(y).sort((a, b) => a - b);
        console.log(`  y=${y}: ${xs.length} px  x=${xs.slice(0, 20).join(',')}${xs.length > 20 ? ',...' : ''}`);
      }
      if (rows.length > 24) console.log(`  ... ${rows.length - 24} more rows`);
    }
  } else {
    console.log('\ntop colours:');
    const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
    for (const [key, count] of sorted) {
      const pct = ((count / total) * 100).toFixed(1);
      console.log(`  ${key.padEnd(14)} ${String(count).padStart(7)}  ${pct}%`);
    }
  }

  if (wantMap) {
    console.log('\nmap (. = button-face gray, # = black, o = white, ? = other):');
    for (let y = y0; y < y1; y++) {
      let line = '';
      for (let x = x0; x < x1; x++) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) { line += ' '; continue; }
        if (inExclude(x, y)) { line += ' '; continue; }
        const i = (y * img.width + x) * 4;
        const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
        if (r < 20 && g < 20 && b < 20) line += '#';
        else if (Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2) line += '.';
        else if (r > 235 && g > 235 && b > 235) line += 'o';
        else line += '?';
      }
      console.log(`${String(y).padStart(4)} ${line}`);
    }
  }
})();
