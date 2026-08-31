#!/usr/bin/env node
'use strict';

// Exercise Globe's actual Render dropdown, not synthetic WM_COMMAND posts.
// The menu checks prove every option reached the app; the three captures prove
// FILLMODE also reaches the software rasterizer instead of stopping at state.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(__dirname, 'binaries', 'dx-sdk', 'bin', 'globe.exe');
const WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');

if (!fs.existsSync(EXE) || !fs.existsSync(WASM)) {
  console.log('SKIP: Globe binary or built WASM is unavailable');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3dim-globe-render-'));
const point = path.join(dir, 'point.png');
const wire = path.join(dir, 'wire.png');
const solid = path.join(dir, 'solid.png');

// Render dropdown rows: Flat, Gouraud, Phong, separator, Lighting,
// separator, Point, Wireframe, Solid, separator, Dithering, Anti-aliasing,
// separator, Point Filtering, Bi-Linear Filtering.
const actions = [
  `94:click:66:31,95:mousemove:90:52,96:menu-dump:hover,97:click:90:52`,
  `98:click:66:31,99:mousemove:90:72,100:menu-dump:hover,101:click:90:72`,
  `102:click:66:31,103:mousemove:90:92,104:menu-dump:hover,105:click:90:92`,
  `106:click:66:31,107:mousemove:90:132,108:menu-dump:hover,109:click:90:132`,
  `110:click:66:31,111:mousemove:90:172,112:menu-dump:hover,113:click:90:172,118:png:${point}`,
  `119:click:66:31,120:mousemove:90:192,121:menu-dump:hover,122:click:90:192,127:png:${wire}`,
  `128:click:66:31,129:mousemove:90:212,130:menu-dump:hover,131:click:90:212,136:png:${solid}`,
  `137:click:66:31,138:mousemove:90:252,139:menu-dump:hover,140:click:90:252`,
  `141:click:66:31,142:mousemove:90:272,143:menu-dump:hover,144:click:90:272`,
  `145:click:66:31,146:mousemove:90:312,147:menu-dump:hover,148:click:90:312`,
  `149:click:66:31,150:mousemove:90:332,151:menu-dump:hover,152:click:90:332`,
  '158:dump-windows:after,160:stop',
].join(',');

function litClientPixels(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let lit = 0;
  // Exclude caption/menu/chrome; Globe's client is black except for geometry.
  for (let y = 42; y < Math.min(477, png.height); y++) {
    for (let x = 4; x < Math.min(637, png.width); x++) {
      const off = (y * png.width + x) * 4;
      if (png.data[off] || png.data[off + 1] || png.data[off + 2]) lit++;
    }
  }
  return lit;
}

try {
  const out = execFileSync('node', [
    path.join(__dirname, 'run.js'),
    '--app=dx_globe',
    '--batch-size=100000',
    '--max-batches=162',
    '--quiet-api',
    '--no-build',
    `--input=${actions}`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

  const expected = [
    [0, 12, '&Flat'], [1, 13, '&Gouraud'], [2, 14, 'P&hong'],
    [4, 29, 'L&ighting'], [6, 20, '&Point'], [7, 21, '&Wireframe'],
    [8, 22, '&Solid'], [10, 24, '&Dithering'], [11, 26, '&Anti-aliasing'],
    [13, 17, 'P&oint Filtering'], [14, 18, 'Bi-&Linear Filtering'],
  ];
  for (const [hover, id, label] of expected) {
    const line = out.split('\n').find(s =>
      s.includes('menu-dump:hover:') && s.includes('top=1') &&
      s.includes(`hover=${hover}`) && s.includes(`#${hover} id=${id}`) &&
      s.includes(`"${label}"`));
    assert(line, `real pointer path did not reach Render -> ${label}`);
  }
  assert(/window:after .*title="Globe Direct3DRM Example"/.test(out),
    'Globe closed or crashed while exercising Render options');
  assert(!/RuntimeError|UNHANDLED EXCEPTION|\[Exit\]/.test(out),
    'a Render option trapped or exited the application');

  const pointLit = litClientPixels(point);
  const wireLit = litClientPixels(wire);
  const solidLit = litClientPixels(solid);
  assert(pointLit < wireLit * 0.65,
    `Point mode still resembles wireframe (${pointLit} vs ${wireLit} lit pixels)`);
  assert(wireLit < solidLit * 0.65,
    `Wireframe mode still resembles solid (${wireLit} vs ${solidLit} lit pixels)`);
  console.log(`PASS Globe Render menu: all 11 items survive; point/wire/solid = ${pointLit}/${wireLit}/${solidLit} lit pixels`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
