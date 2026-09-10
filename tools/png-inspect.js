#!/usr/bin/env node
'use strict';

// One implementation behind the repository's historical PNG inspection
// commands. The old filenames remain as tiny entry points so notes and shell
// snippets keep working, while decoding, bounds, pixel and crop semantics can
// no longer drift between seven separate tools.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const DESKTOP = Object.freeze([0, 128, 128]);
const NAMED = Object.freeze({
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
});

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    flags.set(arg.slice(2, eq < 0 ? undefined : eq), eq < 0 ? true : arg.slice(eq + 1));
  }
  return { flags, positional };
}

function numbers(value, separator = ',') {
  return String(value).split(separator).map(part => Number(part.trim()));
}

function loadPng(file) {
  if (!file || !fs.existsSync(file)) throw new UsageError(`no such file: ${file || ''}`);
  return PNG.sync.read(fs.readFileSync(file));
}

function writePng(file, image) {
  fs.writeFileSync(file, PNG.sync.write(image));
}

function pixel(image, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1],
    image.data[offset + 2], image.data[offset + 3]];
}

function rgbKey(image, x, y) {
  const value = pixel(image, x, y);
  return value ? ((value[0] << 16) | (value[1] << 8) | value[2]) >>> 0 : null;
}

function clampBounds(image, bounds) {
  const [x0, y0, x1, y1] = bounds;
  return [Math.max(0, x0), Math.max(0, y0),
    Math.min(image.width, x1), Math.min(image.height, y1)];
}

function histogram(image, bounds = [0, 0, image.width, image.height], options = {}) {
  const [x0, y0, x1, y1] = clampBounds(image, bounds);
  const counts = new Map();
  let transparent = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (options.exclude && x >= options.exclude[0] && x < options.exclude[2] &&
          y >= options.exclude[1] && y < options.exclude[3]) continue;
      const [r, g, b, a] = pixel(image, x, y);
      if (a === 0) transparent++;
      const key = options.alpha === false
        ? ((r << 16) | (g << 8) | b) >>> 0
        : (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
      counts.set(key, (counts.get(key) || 0) + 1);
      total++;
    }
  }
  return { bounds: [x0, y0, x1, y1], counts, total, transparent };
}

function matchingPixels(image, target, tolerance = 0,
    bounds = [0, 0, image.width, image.height], exclude = null) {
  const [x0, y0, x1, y1] = clampBounds(image, bounds);
  const points = [];
  let box = null;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (exclude && x >= exclude[0] && x < exclude[2] &&
          y >= exclude[1] && y < exclude[3]) continue;
      const value = pixel(image, x, y);
      if (Math.abs(value[0] - target[0]) > tolerance ||
          Math.abs(value[1] - target[1]) > tolerance ||
          Math.abs(value[2] - target[2]) > tolerance) continue;
      points.push([x, y]);
      box = box
        ? [Math.min(box[0], x), Math.min(box[1], y),
          Math.max(box[2], x), Math.max(box[3], y)]
        : [x, y, x, y];
    }
  }
  return { points, box };
}

function cropImage(image, x, y, width, height, scale = 1) {
  if (![x, y, width, height, scale].every(Number.isFinite) ||
      width <= 0 || height <= 0 || scale <= 0 || !Number.isInteger(scale)) {
    throw new UsageError('crop rectangle and scale must be positive integers');
  }
  const output = new PNG({ width: width * scale, height: height * scale });
  for (let dy = 0; dy < output.height; dy++) {
    for (let dx = 0; dx < output.width; dx++) {
      const sx = Math.min(image.width - 1, Math.max(0, x + Math.floor(dx / scale)));
      const sy = Math.min(image.height - 1, Math.max(0, y + Math.floor(dy / scale)));
      const from = (sy * image.width + sx) * 4;
      const to = (dy * output.width + dx) * 4;
      output.data[to] = image.data[from];
      output.data[to + 1] = image.data[from + 1];
      output.data[to + 2] = image.data[from + 2];
      output.data[to + 3] = 0xff;
    }
  }
  return output;
}

function contentBox(image, background = DESKTOP) {
  let x0 = image.width, y0 = image.height, x1 = -1, y1 = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const value = pixel(image, x, y);
      if (value[0] === background[0] && value[1] === background[1] &&
          value[2] === background[2]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

function cropFile(file, { pad = 8, maxFill = 0.9, outDir = null, dryRun = false } = {}) {
  const image = loadPng(file);
  const box = contentBox(image);
  if (!box) return { file, action: 'skip', reason: 'all desktop colour' };
  const fill = ((box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1)) /
    (image.width * image.height);
  if (fill > maxFill) {
    return { file, action: 'keep', reason: `fills ${(fill * 100).toFixed(0)}%`, box };
  }
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(image.width - 1, box.x1 + pad);
  const y1 = Math.min(image.height - 1, box.y1 + pad);
  const output = new PNG({ width: x1 - x0 + 1, height: y1 - y0 + 1 });
  PNG.bitblt(image, output, x0, y0, output.width, output.height, 0, 0);
  const dest = outDir ? path.join(outDir, path.basename(file)) : file;
  if (!dryRun) writePng(dest, output);
  return { file, action: 'crop', box, from: `${image.width}x${image.height}`,
    to: `${output.width}x${output.height}`, dest };
}

function runPixel(argv) {
  const { flags, positional } = parseArgs(argv);
  const black = flags.has('black');
  const pointSpec = black ? null : positional.shift();
  if ((!black && !pointSpec) || !positional.length) {
    throw new UsageError('usage: png-pixel.js <x,y[;x,y...]> <file.png> [...]  |  --black <file.png>');
  }
  const points = black ? [] : String(pointSpec).split(';').map(pair => numbers(pair));
  for (const file of positional) {
    const image = loadPng(file);
    if (black) {
      const match = matchingPixels(image, [0, 0, 0]);
      const share = (100 * match.points.length / (image.width * image.height)).toFixed(2);
      console.log(`${path.basename(file)}  ${image.width}x${image.height}  black ${match.points.length} (${share}%)` +
        (match.box ? `  bbox ${match.box[0]},${match.box[1]}-${match.box[2]},${match.box[3]}` : ''));
      continue;
    }
    const parts = points.map(([x, y]) => {
      const value = pixel(image, x, y);
      return value
        ? `(${x},${y})=${value.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}`
        : `(${x},${y})=out-of-range`;
    });
    console.log(`${path.basename(file)}  ${image.width}x${image.height}  ${parts.join('  ')}`);
  }
}

function runStats(argv) {
  const { flags, positional } = parseArgs(argv);
  if (!positional[0]) throw new UsageError('Usage: node tools/png-stats.js <file.png> [--top=N] [--region=X,Y,W,H]');
  const file = positional[0], image = loadPng(file);
  const top = Number(flags.get('top') || 8);
  const region = flags.has('region') ? numbers(flags.get('region')) : [0, 0, image.width, image.height];
  const [rx, ry, rw, rh] = region;
  const result = histogram(image, [rx, ry, rx + rw, ry + rh]);
  const [x0, y0, x1, y1] = result.bounds;
  console.log(`${file}  ${image.width}x${image.height}  region ${x0},${y0} ${x1 - x0}x${y1 - y0}`);
  const transparentShare = result.total ? 100 * result.transparent / result.total : 0;
  console.log(`  distinct colours: ${result.counts.size}   fully transparent: ${result.transparent} (${transparentShare.toFixed(2)}%)`);
  for (const [key, count] of [...result.counts].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    const r = (key >>> 24) & 0xff, g = (key >>> 16) & 0xff;
    const b = (key >>> 8) & 0xff, a = key & 0xff;
    const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
    console.log(`  ${hex} a=${String(a).padStart(3)}  ${count} px  ${(100 * count / result.total).toFixed(2)}%`);
  }
}

function runWindow(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.has('find')) {
    if (!positional[0]) throw new UsageError(`no such file: ${positional[0]}`);
    const image = loadPng(positional[0]);
    const target = Number.parseInt(String(flags.get('find')).replace(/^#/, ''), 16) >>> 0;
    const rgb = [(target >>> 16) & 0xff, (target >>> 8) & 0xff, target & 0xff];
    const match = matchingPixels(image, rgb);
    const label = `#${target.toString(16).padStart(6, '0')}`;
    console.log(match.box
      ? `${label}: ${match.points.length} px, bbox ${match.box[0]},${match.box[1]} .. ${match.box[2]},${match.box[3]}`
      : `${label}: not present`);
    return;
  }
  if (positional.length < 5) {
    throw new UsageError('usage: node tools/png-window.js FILE X Y W H [--mode=ink|hex|palette] [--ink=N]');
  }
  const [file, xs, ys, ws, hs] = positional;
  const image = loadPng(file);
  const x0 = Number(xs) | 0, y0 = Number(ys) | 0;
  const width = Number(ws) | 0, height = Number(hs) | 0;
  const mode = flags.get('mode') || 'ink';
  const ink = Number(flags.get('ink') || 70);
  if (x0 < 0 || y0 < 0 || x0 + width > image.width || y0 + height > image.height) {
    throw new UsageError(`window ${x0},${y0} ${width}x${height} is outside the ${image.width}x${image.height} image`);
  }
  console.log(`${file}  ${image.width}x${image.height}  window ${x0},${y0} ${width}x${height}  mode=${mode}`);
  if (mode === 'hex') {
    for (let y = y0; y < y0 + height; y++) {
      const row = [];
      for (let x = x0; x < x0 + width; x++) row.push(rgbKey(image, x, y).toString(16).padStart(6, '0'));
      console.log(`${String(y).padStart(4)}: ${row.join(' ')}`);
    }
    return;
  }
  if (mode === 'palette') {
    const glyphs = '.#*+oxO@%&=~', seen = new Map(), rows = [];
    for (let y = y0; y < y0 + height; y++) {
      let row = '';
      for (let x = x0; x < x0 + width; x++) {
        const value = pixel(image, x, y), key = rgbKey(image, x, y);
        if (value[3] === 0) { row += ' '; continue; }
        if (!seen.has(key)) seen.set(key, glyphs[seen.size % glyphs.length]);
        row += seen.get(key);
      }
      rows.push(`${String(y).padStart(4)}: ${row}`);
    }
    rows.forEach(row => console.log(row));
    console.log('legend:');
    for (const [key, glyph] of seen) console.log(`  ${glyph} = #${key.toString(16).padStart(6, '0')}`);
    return;
  }
  for (let y = y0; y < y0 + height; y++) {
    let row = '';
    for (let x = x0; x < x0 + width; x++) {
      const [r, g, b, a] = pixel(image, x, y);
      row += r < ink && g < ink && b < ink && a !== 0 ? '#' : '.';
    }
    console.log(`${String(y).padStart(4)}: ${row}`);
  }
}

function runProbe(argv) {
  const { flags, positional } = parseArgs(argv);
  if (!positional[0]) {
    throw new UsageError('usage: node tools/png-probe.js <file.png> [--rect=x0,y0,x1,y1] [--color=NAME] [--map]');
  }
  const file = positional[0], image = loadPng(file);
  const bounds = flags.has('rect') ? numbers(flags.get('rect')) : [0, 0, image.width, image.height];
  const exclude = flags.has('exclude') ? numbers(flags.get('exclude')) : null;
  if (flags.has('at')) {
    console.log(`${path.basename(file)}  ${image.width}x${image.height}\n`);
    const coords = numbers(flags.get('at'));
    for (let i = 0; i + 1 < coords.length; i += 2) {
      const x = coords[i], y = coords[i + 1], value = pixel(image, x, y);
      if (!value) { console.log(`  (${x},${y})  outside the image`); continue; }
      const [r, g, b, a] = value;
      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
      console.log(`  (${x},${y})  rgba(${r},${g},${b},${a})  ${hex}` +
        (a === 0 ? '  TRANSPARENT' : a !== 255 ? `  alpha ${a}/255` : ''));
    }
    return;
  }
  const [x0, y0, x1, y1] = bounds;
  const result = histogram(image, bounds, { alpha: false, exclude });
  console.log(`${path.basename(file)}  ${image.width}x${image.height}`);
  console.log(`region x=${x0}..${x1} y=${y0}..${y1}` +
    (exclude ? `  excluding x=${exclude[0]}..${exclude[2]} y=${exclude[1]}..${exclude[3]}` : '') +
    `  (${result.total} px)`);
  if (flags.has('color')) {
    const colorName = String(flags.get('color'));
    const target = NAMED[colorName.toLowerCase()] || numbers(colorName);
    if (target.length !== 3 || target.some(Number.isNaN)) {
      throw new UsageError(`unknown colour: ${colorName} (try ${Object.keys(NAMED).join(', ')} or R,G,B)`);
    }
    const tolerance = Number(flags.get('tol') || 20);
    const match = matchingPixels(image, target, tolerance, bounds, exclude);
    console.log(`\ncolour ${target.join(',')} +/-${tolerance}: ${match.points.length} px`);
    if (match.box) {
      console.log(`bounding box x=${match.box[0]}..${match.box[2]} y=${match.box[1]}..${match.box[3]}`);
      const byRow = new Map();
      for (const [x, y] of match.points) {
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
    const top = Number(flags.get('top') || 8);
    for (const [key, count] of [...result.counts].sort((a, b) => b[1] - a[1]).slice(0, top)) {
      const label = `${(key >>> 16) & 0xff},${(key >>> 8) & 0xff},${key & 0xff}`;
      console.log(`  ${label.padEnd(14)} ${String(count).padStart(7)}  ${(100 * count / result.total).toFixed(1)}%`);
    }
  }
  if (!flags.has('map')) return;
  console.log('\nmap (. = button-face gray, # = black, o = white, ? = other):');
  for (let y = y0; y < y1; y++) {
    let row = '';
    for (let x = x0; x < x1; x++) {
      const value = pixel(image, x, y);
      if (!value || (exclude && x >= exclude[0] && x < exclude[2] &&
          y >= exclude[1] && y < exclude[3])) { row += ' '; continue; }
      const [r, g, b] = value;
      if (r < 20 && g < 20 && b < 20) row += '#';
      else if (Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2) row += '.';
      else if (r > 235 && g > 235 && b > 235) row += 'o';
      else row += '?';
    }
    console.log(`${String(y).padStart(4)} ${row}`);
  }
}

function runCrop(argv) {
  const { flags, positional } = parseArgs(argv);
  if (!positional[0]) throw new UsageError('need an input PNG');
  const file = positional[0], image = loadPng(file);
  if (flags.has('probe')) {
    const names = new Map([[0xffffff, '3DHILIGHT/white'], [0xc0c0c0, '3DFACE'],
      [0x808080, '3DSHADOW'], [0xdfdfdf, '3DLIGHT'], [0, '3DDKSHADOW/black'],
      [0x000080, 'ACTIVECAPTION'], [0x1084d0, 'GRADIENTACTIVECAPTION'],
      [0x008080, 'desktop teal']]);
    const [px, py, width, height] = numbers(flags.get('probe'));
    const glyphs = '#o+=-:*%&$@abcdefghijklmnpqrstuvwxyz', seen = new Map(), rows = [];
    for (let y = py; y < Math.min(py + height, image.height); y++) {
      let row = '';
      for (let x = px; x < Math.min(px + width, image.width); x++) {
        const key = rgbKey(image, x, y);
        if (!seen.has(key)) seen.set(key, seen.size < glyphs.length ? glyphs[seen.size] : '?');
        row += seen.get(key);
      }
      rows.push(`${String(y).padStart(4)} ${row}`);
    }
    console.log(`${path.basename(file)} ${image.width}x${image.height}  probe ${px},${py} ${width}x${height}`);
    for (const [key, glyph] of seen) {
      console.log(`  ${glyph} = #${key.toString(16).padStart(6, '0')}${names.has(key) ? `  ${names.get(key)}` : ''}`);
    }
    console.log(`     x${px} ->`);
    rows.forEach(row => console.log(row));
    return;
  }
  if (flags.has('boxes')) {
    const range = flags.get('boxes') === true ? [0, image.height - 1] : numbers(flags.get('boxes'));
    const minimum = Number(flags.get('min') || 8), found = [];
    for (let y = range[0]; y <= Math.min(range[1], image.height - 1); y++) {
      let x = 0;
      while (x < image.width) {
        if (rgbKey(image, x, y) !== 0xffffff) { x++; continue; }
        const start = x;
        while (x < image.width && rgbKey(image, x, y) === 0xffffff) x++;
        const width = x - start;
        if (width < minimum) continue;
        let height = 1;
        while (y + height < image.height && rgbKey(image, start, y + height) === 0xffffff) height++;
        if (height >= 4) found.push({ x: start, y, w: width, h: height });
      }
    }
    const kept = [];
    for (const box of found) {
      if (!kept.some(item => Math.abs(item.x - box.x) <= 2 && Math.abs(item.y - box.y) <= 2 &&
          Math.abs(item.w - box.w) <= 2)) kept.push(box);
    }
    console.log(`${path.basename(file)} ${image.width}x${image.height}`);
    kept.forEach(box => console.log(`  x=${box.x}\ty=${box.y}\tw=${box.w}\th=${box.h}`));
    return;
  }
  if (!flags.has('rect')) throw new UsageError('need --rect=X,Y,W,H or --boxes');
  const [x, y, width, height] = numbers(flags.get('rect'));
  const scale = Number(flags.get('scale') || 1);
  const out = flags.get('out') || file.replace(/\.png$/, '') + '-crop.png';
  writePng(out, cropImage(image, x, y, width, height, scale));
  console.log(`${width}x${height} at ${x},${y} scaled ${scale}x -> ${out}`);
}

function luminance(image, x, y) {
  const value = pixel(image, x, y);
  return 0.299 * value[0] + 0.587 * value[1] + 0.114 * value[2];
}

function runRows(argv) {
  const { flags, positional } = parseArgs(argv);
  if (!positional[0]) {
    throw new UsageError('Usage: node tools/png-rows.js <file.png> [--cols] [--rect=x0,y0,x1,y1] [--list] [--period=N] [--shift]');
  }
  const file = positional[0], image = loadPng(file);
  const bounds = flags.has('rect') ? numbers(flags.get('rect')) : [0, 0, image.width, image.height];
  const [x0, y0, x1, y1] = clampBounds(image, bounds);
  if (flags.has('px')) {
    for (const pair of String(flags.get('px')).split(';')) {
      const [x, y] = numbers(pair), value = pixel(image, x, y);
      if (!value) { console.log(`  ${x},${y}  out of bounds`); continue; }
      const hex = value.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
      console.log(`  ${x},${y}  #${hex} a=${value[3]}`);
    }
  }
  if (flags.has('hist')) {
    const top = flags.get('hist') === true ? 12 : Number(flags.get('hist'));
    const result = histogram(image, [x0, y0, x1, y1], { alpha: false });
    for (const [key, count] of [...result.counts].sort((a, b) => b[1] - a[1]).slice(0, top)) {
      console.log(`  #${key.toString(16).padStart(6, '0')}  ${count}`);
    }
  }
  if (flags.has('px') || flags.has('hist')) return;
  const columns = flags.has('cols');
  const count = columns ? x1 - x0 : y1 - y0;
  const across = columns ? y1 - y0 : x1 - x0;
  const lines = [];
  for (let k = 0; k < count; k++) {
    let sum = 0, lit = 0;
    for (let j = 0; j < across; j++) {
      const x = columns ? x0 + k : x0 + j;
      const y = columns ? y0 + j : y0 + k;
      const value = luminance(image, x, y);
      sum += value;
      if (value > 8) lit++;
    }
    lines.push({ mean: sum / across, lit });
  }
  const axis = columns ? 'col' : 'row';
  console.log(`${file}  ${image.width}x${image.height}  profiling ${count} ${axis}s of ${across}px`);
  if (flags.has('list')) lines.forEach((line, i) => console.log(
    `  ${axis} ${String((columns ? x0 : y0) + i).padStart(4)}  mean ${line.mean.toFixed(2).padStart(7)}  lit ${String(line.lit).padStart(5)}`));
  const phases = period => {
    const sums = new Array(period).fill(0), counts = new Array(period).fill(0);
    lines.forEach((line, i) => { sums[i % period] += line.mean; counts[i % period]++; });
    return sums.map((sum, i) => sum / (counts[i] || 1));
  };
  const spread = period => { const values = phases(period); return Math.max(...values) - Math.min(...values); };
  let best = { period: 1, spread: 0 };
  for (let period = 2; period <= Math.min(16, Math.floor(count / 4)); period++) {
    const value = spread(period);
    if (value > best.spread * 1.05) best = { period, spread: value };
  }
  const overall = lines.reduce((sum, line) => sum + line.mean, 0) / count;
  console.log(`  overall mean ${overall.toFixed(2)}`);
  if (best.spread > 1) {
    console.log(`  strongest period ${best.period} (phase spread ${best.spread.toFixed(2)}):`);
    phases(best.period).forEach((value, i) => console.log(`    phase ${i}: mean ${value.toFixed(2)}`));
  } else console.log('  no periodicity worth reporting');
  if (flags.has('period')) {
    const period = Number(flags.get('period'));
    console.log(`  requested period ${period} (phase spread ${spread(period).toFixed(2)}):`);
    phases(period).forEach((value, i) => console.log(`    phase ${i}: mean ${value.toFixed(2)}`));
  }
  if (!flags.has('shift')) return;
  const maxOffset = 8;
  const lineAt = k => {
    const out = new Float64Array(across);
    for (let j = 0; j < across; j++) {
      out[j] = luminance(image, columns ? x0 + k : x0 + j, columns ? y0 + j : y0 + k);
    }
    return out;
  };
  const correlation = (a, b, offset) => {
    const low = Math.max(0, -offset), high = Math.min(across, across - offset), n = high - low;
    if (n < 8) return null;
    let meanA = 0, meanB = 0;
    for (let j = low; j < high; j++) { meanA += a[j]; meanB += b[j + offset]; }
    meanA /= n; meanB /= n;
    let product = 0, normA = 0, normB = 0;
    for (let j = low; j < high; j++) {
      const da = a[j] - meanA, db = b[j + offset] - meanB;
      product += da * db; normA += da * da; normB += db * db;
    }
    return normA < 1e-6 * n || normB < 1e-6 * n ? null : product / Math.sqrt(normA * normB);
  };
  const shifts = new Map(); let flat = 0, weak = 0, previous = lineAt(0);
  for (let k = 1; k < count; k++) {
    const current = lineAt(k);
    let bestOffset = null, bestScore = -Infinity, second = -Infinity;
    for (let offset = -maxOffset; offset <= maxOffset; offset++) {
      const score = correlation(previous, current, offset);
      if (score === null) continue;
      if (score > bestScore) { second = bestScore; bestScore = score; bestOffset = offset; }
      else if (score > second) second = score;
    }
    previous = current;
    if (bestOffset === null) { flat++; continue; }
    if (bestScore < 0.5 || bestScore - second < 0.02) { weak++; continue; }
    shifts.set(bestOffset, (shifts.get(bestOffset) || 0) + 1);
  }
  console.log('  per-line shift histogram (offset: count):');
  [...shifts].sort((a, b) => b[1] - a[1]).forEach(([offset, n]) =>
    console.log(`    ${String(offset).padStart(3)}: ${n}`));
  console.log(`    (flat lines skipped: ${flat}, no confident match: ${weak})`);
}

function runCropDesktop(argv) {
  const { flags, positional } = parseArgs(argv);
  if (!positional.length) {
    throw new UsageError('usage: png-crop-desktop.js <png> [...] [--out=DIR] [--pad=N] [--max-fill=0.9] [--dry-run]');
  }
  const outDir = flags.get('out') || null;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const options = { pad: Number(flags.get('pad') || 8),
    maxFill: Number(flags.get('max-fill') || 0.9), outDir,
    dryRun: flags.has('dry-run') };
  for (const file of positional) {
    const result = cropFile(file, options);
    const tag = result.action === 'crop' ? `${result.from} -> ${result.to}` : result.reason;
    console.log(`${result.action.padEnd(5)} ${path.basename(file)}  ${tag}`);
  }
}

const RUNNERS = Object.freeze({
  'png-crop.js': runCrop,
  'png-probe.js': runProbe,
  'png-rows.js': runRows,
  'png-stats.js': runStats,
  'png-window.js': runWindow,
  'png-pixel.js': runPixel,
  'png-crop-desktop.js': runCropDesktop,
});

function runLegacy(filename, argv = process.argv.slice(2)) {
  const runner = RUNNERS[path.basename(filename)];
  if (!runner) throw new UsageError(`unknown PNG inspector: ${filename}`);
  return runner(argv);
}

function mainLegacy(filename, argv) {
  try {
    runLegacy(filename, argv);
  } catch (error) {
    console.error(error && error.message || String(error));
    process.exitCode = error && error.exitCode || 1;
  }
}

module.exports = {
  DESKTOP,
  clampBounds,
  contentBox,
  cropFile,
  cropImage,
  histogram,
  loadPng,
  mainLegacy,
  matchingPixels,
  pixel,
  rgbKey,
  runLegacy,
  writePng,
};

if (require.main === module) {
  const command = process.argv[2];
  const filename = `png-${command}.js`;
  if (!command || !RUNNERS[filename]) {
    console.error(`usage: png-inspect.js <${Object.keys(RUNNERS).map(name => name.replace(/^png-|\.js$/g, '')).join('|')}> ...`);
    process.exitCode = 2;
  } else {
    mainLegacy(filename, process.argv.slice(3));
  }
}
