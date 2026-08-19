#!/usr/bin/env node
'use strict';

// Print a rectangle of a PNG as text, so a pixel-level disagreement can be
// read instead of guessed at.
//
//   node tools/png-window.js FILE X Y W H [--mode=ink|hex|palette] [--ink=N]
//
//   ink      (default) '#' where the pixel is darker than --ink on every
//            channel and not transparent, '.' otherwise. This is the shape
//            a glyph/edge test is really asserting.
//   palette  one character per distinct color, with a legend. Use when the
//            question is "which colors, in what arrangement" -- button
//            frames, dithered fills.
//   hex      one 0xRRGGBB per pixel, row by row. Use for exact values.
//
// Written while comparing our caption close-button glyph against the
// screenshots/v86-reference/reviewed captures of real Win98.

const fs = require('fs');
const { PNG } = require('pngjs');

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node tools/png-window.js FILE X Y W H [--mode=ink|hex|palette] [--ink=N]');
  process.exit(2);
}

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = new Map(args.filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));

// --find=RRGGBB answers "where is that thing" before you can ask "what does it
// look like": prints the bounding box and pixel count of an exact color. The
// Win98 active caption (000080) locates a window's title bar in one call.
if (flags.get('find')) {
  const target = parseInt(String(flags.get('find')).replace(/^#/, ''), 16) >>> 0;
  const file0 = positional[0];
  if (!file0 || !fs.existsSync(file0)) usage(`no such file: ${file0}`);
  const img = PNG.sync.read(fs.readFileSync(file0));
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const c = ((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]) >>> 0;
      if (c !== target) continue;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!count) {
    console.log(`#${target.toString(16).padStart(6, '0')}: not present`);
  } else {
    console.log(`#${target.toString(16).padStart(6, '0')}: ${count} px, bbox ${minX},${minY} .. ${maxX},${maxY}`);
  }
  process.exit(0);
}

if (positional.length < 5) usage();
const [file, xs, ys, ws, hs] = positional;
const x0 = Number(xs) | 0, y0 = Number(ys) | 0;
const w = Number(ws) | 0, h = Number(hs) | 0;
const mode = flags.get('mode') || 'ink';
const inkLevel = Number(flags.get('ink') || 70);

if (!fs.existsSync(file)) usage(`no such file: ${file}`);
const png = PNG.sync.read(fs.readFileSync(file));
if (x0 < 0 || y0 < 0 || x0 + w > png.width || y0 + h > png.height) {
  usage(`window ${x0},${y0} ${w}x${h} is outside the ${png.width}x${png.height} image`);
}

const at = (x, y) => {
  const o = (y * png.width + x) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2], png.data[o + 3]];
};

console.log(`${file}  ${png.width}x${png.height}  window ${x0},${y0} ${w}x${h}  mode=${mode}`);

if (mode === 'hex') {
  for (let y = y0; y < y0 + h; y++) {
    const row = [];
    for (let x = x0; x < x0 + w; x++) {
      const [r, g, b] = at(x, y);
      row.push(((r << 16) | (g << 8) | b).toString(16).padStart(6, '0'));
    }
    console.log(`${String(y).padStart(4)}: ${row.join(' ')}`);
  }
} else if (mode === 'palette') {
  const glyphs = '.#*+oxO@%&=~';
  const seen = new Map();
  const rows = [];
  for (let y = y0; y < y0 + h; y++) {
    let row = '';
    for (let x = x0; x < x0 + w; x++) {
      const [r, g, b, a] = at(x, y);
      const key = ((r << 16) | (g << 8) | b) >>> 0;
      const label = a === 0 ? ' ' : key;
      if (label !== ' ' && !seen.has(label)) seen.set(label, glyphs[seen.size % glyphs.length]);
      row += label === ' ' ? ' ' : seen.get(label);
    }
    rows.push(`${String(y).padStart(4)}: ${row}`);
  }
  rows.forEach(r => console.log(r));
  console.log('legend:');
  for (const [key, ch] of seen) {
    console.log(`  ${ch} = #${key.toString(16).padStart(6, '0')}`);
  }
} else {
  for (let y = y0; y < y0 + h; y++) {
    let row = '';
    for (let x = x0; x < x0 + w; x++) {
      const [r, g, b, a] = at(x, y);
      row += (r < inkLevel && g < inkLevel && b < inkLevel && a !== 0) ? '#' : '.';
    }
    console.log(`${String(y).padStart(4)}: ${row}`);
  }
}
