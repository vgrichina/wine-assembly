#!/usr/bin/env node
// Per-row (or per-column) profile of a PNG — the tool for "this picture is
// striped / sheared / interlaced".
//
// Stride, pitch and interlace bugs all show up as *periodicity along one axis*:
// every other scanline dark, every Nth row shifted sideways, content repeating
// with a period that is not the width. A colour histogram cannot see any of
// that, and eyeballing a render only tells you something is wrong, not what
// the period is. This prints the mean luminance and lit-pixel count of each
// line, then reports the strongest period it finds, so "half the rows are
// blank" and "rows drift by 3px each line" become numbers.
//
// Usage:
//   node tools/png-rows.js <file.png> [--cols] [--rect=x0,y0,x1,y1]
//                          [--list] [--period=N] [--shift]
//
//   --cols      profile columns instead of rows
//   --rect      restrict to a region (x1/y1 exclusive)
//   --list      print every line's numbers, not just the summary
//   --period=N  also report the phase means for this exact period
//   --shift     per-row horizontal shear estimate: cross-correlate each row
//               against the previous one and print the best offset
const fs = require('fs');
const { PNG } = require('pngjs');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node tools/png-rows.js <file.png> [--cols] [--rect=x0,y0,x1,y1] [--list] [--period=N] [--shift]');
  process.exit(2);
}
const COLS = args.includes('--cols');
const LIST = args.includes('--list');
const SHIFT = args.includes('--shift');
const periodArg = args.find(a => a.startsWith('--period='));
const rectArg = args.find(a => a.startsWith('--rect='));

const pxArg = args.find(a => a.startsWith('--px='));
const histArg = args.find(a => a.startsWith('--hist'));

const png = PNG.sync.read(fs.readFileSync(file));

// --px=x,y[;x,y...] — exact RGBA at a point, and --hist=N — the N most common
// colours in --rect. A luminance profile answers "where", these answer "what
// colour": on an 8bpp guest the printed hex maps straight back to a palette
// entry, which is how "the picture is muddy" becomes "index 12 not index 11".
if (pxArg || histArg) {
  if (pxArg) {
    for (const p of pxArg.slice(5).split(';')) {
      const [x, y] = p.split(',').map(Number);
      if (!(x >= 0 && x < png.width && y >= 0 && y < png.height)) {
        console.log(`  ${x},${y}  out of bounds`);
        continue;
      }
      const i = (png.width * y + x) << 2;
      const hex = (v) => v.toString(16).padStart(2, '0');
      console.log(`  ${x},${y}  #${hex(png.data[i])}${hex(png.data[i + 1])}${hex(png.data[i + 2])}` +
        ` a=${png.data[i + 3]}`);
    }
  }
  if (histArg) {
    const n = histArg.includes('=') ? Number(histArg.split('=')[1]) : 12;
    const r = rectArg ? rectArg.slice(7).split(',').map(Number) : [0, 0, png.width, png.height];
    const counts = new Map();
    for (let y = Math.max(0, r[1]); y < Math.min(r[3], png.height); y++) {
      for (let x = Math.max(0, r[0]); x < Math.min(r[2], png.width); x++) {
        const i = (png.width * y + x) << 2;
        const k = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    for (const [k, c] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, n)) {
      console.log(`  #${k.toString(16).padStart(6, '0')}  ${c}`);
    }
  }
  process.exit(0);
}
let [x0, y0, x1, y1] = rectArg
  ? rectArg.slice(7).split(',').map(Number)
  : [0, 0, png.width, png.height];
x0 = Math.max(0, x0); y0 = Math.max(0, y0);
x1 = Math.min(x1, png.width); y1 = Math.min(y1, png.height);

const lum = (i) => 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];

// lines[k] = { mean, lit } for line k of the profiled axis
const nLines = COLS ? x1 - x0 : y1 - y0;
const nAcross = COLS ? y1 - y0 : x1 - x0;
const lines = [];
for (let k = 0; k < nLines; k++) {
  let sum = 0, lit = 0;
  for (let j = 0; j < nAcross; j++) {
    const x = COLS ? x0 + k : x0 + j;
    const y = COLS ? y0 + j : y0 + k;
    const v = lum((png.width * y + x) << 2);
    sum += v;
    if (v > 8) lit++;
  }
  lines.push({ mean: sum / nAcross, lit });
}

const axis = COLS ? 'col' : 'row';
console.log(`${file}  ${png.width}x${png.height}  profiling ${nLines} ${axis}s of ${nAcross}px`);

if (LIST) {
  for (let k = 0; k < nLines; k++) {
    const l = lines[k];
    console.log(`  ${axis} ${String((COLS ? x0 : y0) + k).padStart(4)}  mean ${l.mean.toFixed(2).padStart(7)}  lit ${String(l.lit).padStart(5)}`);
  }
}

// Phase means for a given period: a real interlace shows one phase near zero.
function phases(p) {
  const acc = new Array(p).fill(0), cnt = new Array(p).fill(0);
  for (let k = 0; k < nLines; k++) { acc[k % p] += lines[k].mean; cnt[k % p]++; }
  return acc.map((a, i) => a / (cnt[i] || 1));
}
function spread(p) {
  const ph = phases(p);
  return Math.max(...ph) - Math.min(...ph);
}

// Strongest period: the one whose phase means are furthest apart, relative to
// the overall variation. Periods above nLines/4 have too few samples to trust.
const maxP = Math.min(16, Math.floor(nLines / 4));
let best = { p: 1, spread: 0 };
for (let p = 2; p <= maxP; p++) {
  const s = spread(p);
  if (s > best.spread * 1.05) best = { p, spread: s };
}
const overall = lines.reduce((a, l) => a + l.mean, 0) / nLines;
console.log(`  overall mean ${overall.toFixed(2)}`);
if (best.spread > 1) {
  console.log(`  strongest period ${best.p} (phase spread ${best.spread.toFixed(2)}):`);
  phases(best.p).forEach((m, i) => console.log(`    phase ${i}: mean ${m.toFixed(2)}`));
} else {
  console.log('  no periodicity worth reporting');
}
if (periodArg) {
  const p = parseInt(periodArg.slice(9), 10);
  console.log(`  requested period ${p} (phase spread ${spread(p).toFixed(2)}):`);
  phases(p).forEach((m, i) => console.log(`    phase ${i}: mean ${m.toFixed(2)}`));
}

if (SHIFT) {
  // Shear estimate: how far sideways does each line sit relative to the one
  // before it? A constant non-zero answer is a stride that is off by that
  // many pixels per line.
  const MAXD = 8;
  const rowAt = (k) => {
    const out = new Float64Array(nAcross);
    for (let j = 0; j < nAcross; j++) {
      const x = COLS ? x0 + k : x0 + j;
      const y = COLS ? y0 + j : y0 + k;
      out[j] = lum((png.width * y + x) << 2);
    }
    return out;
  };
  // Zero-mean NORMALIZED correlation, not a raw dot product. A raw sum of
  // products is maximized by whichever offset drags the brightest pixels into
  // the overlap, so a picture with a bright edge reports a constant shear that
  // is not there -- that false positive is the reason this is written out in
  // full. Dividing by both norms makes the score a similarity in [-1, 1] and
  // makes offsets comparable to each other.
  const corr = (a, b, d) => {
    const lo = Math.max(0, -d), hi = Math.min(nAcross, nAcross - d);
    const n = hi - lo;
    if (n < 8) return null;             // too little overlap to mean anything
    let ma = 0, mb = 0;
    for (let j = lo; j < hi; j++) { ma += a[j]; mb += b[j + d]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let j = lo; j < hi; j++) {
      const da = a[j] - ma, db = b[j + d] - mb;
      sab += da * db; saa += da * da; sbb += db * db;
    }
    // A line with no contrast correlates with everything equally well. Saying
    // "offset 0" for it would be an invented answer, so it is counted apart.
    if (saa < 1e-6 * n || sbb < 1e-6 * n) return null;
    return sab / Math.sqrt(saa * sbb);
  };
  const hist = new Map();
  let flat = 0, weak = 0;
  let prev = rowAt(0);
  for (let k = 1; k < nLines; k++) {
    const cur = rowAt(k);
    let bestD = null, bestScore = -Infinity, nextScore = -Infinity;
    for (let d = -MAXD; d <= MAXD; d++) {
      const score = corr(prev, cur, d);
      if (score === null) continue;
      if (score > bestScore) { nextScore = bestScore; bestScore = score; bestD = d; }
      else if (score > nextScore) { nextScore = score; }
    }
    prev = cur;
    if (bestD === null) { flat++; continue; }
    // A winner that barely beats the runner-up is noise, and a best match that
    // is not actually a match says the two lines hold different content.
    if (bestScore < 0.5 || bestScore - nextScore < 0.02) { weak++; continue; }
    hist.set(bestD, (hist.get(bestD) || 0) + 1);
  }
  console.log('  per-line shift histogram (offset: count):');
  [...hist.entries()].sort((a, b) => b[1] - a[1]).forEach(([d, c]) => console.log(`    ${String(d).padStart(3)}: ${c}`));
  console.log(`    (flat lines skipped: ${flat}, no confident match: ${weak})`);
}
