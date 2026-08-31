#!/usr/bin/env node
'use strict';

// Exercise Globe's actual Render dropdown, not synthetic WM_COMMAND posts.
// The menu checks prove every option reached the app; the three captures prove
// FILLMODE also reaches the software rasterizer instead of stopping at state.
// Globe uses DDSCL_NORMAL: its 640x480 primary is the desktop and must not
// enlarge the app's requested 300x300 captioned window behind its viewport.

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
  `94:click:86:51,95:mousemove:110:72,96:menu-dump:hover,97:click:110:72`,
  `98:click:86:51,99:mousemove:110:92,100:menu-dump:hover,101:click:110:92`,
  `102:click:86:51,103:mousemove:110:112,104:menu-dump:hover,105:click:110:112`,
  `106:click:86:51,107:mousemove:110:152,108:menu-dump:hover,109:click:110:152`,
  `110:click:86:51,111:mousemove:110:192,112:menu-dump:hover,113:click:110:192,118:png:${point}`,
  `119:click:86:51,120:mousemove:110:212,121:menu-dump:hover,122:click:110:212,127:png:${wire}`,
  `128:click:86:51,129:mousemove:110:232,130:menu-dump:hover,131:click:110:232,136:png:${solid}`,
  `137:click:86:51,138:mousemove:110:272,139:menu-dump:hover,140:click:110:272`,
  `141:click:86:51,142:mousemove:110:292,143:menu-dump:hover,144:click:110:292`,
  `145:click:86:51,146:mousemove:110:332,147:menu-dump:hover,148:click:110:332`,
  `149:click:86:51,150:mousemove:110:352,151:menu-dump:hover,152:click:110:352`,
  '153:click:86:51,154:menu-dump:final,155:click:10:400',
  '158:dump-windows:after,160:stop',
].join(',');

function litClientPixels(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let lit = 0;
  // Exclude caption/menu/chrome; Globe's client is black except for geometry.
  for (let y = 62; y < Math.min(316, png.height); y++) {
    for (let x = 24; x < Math.min(316, png.width); x++) {
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
  const menuLines = out.split('\n').filter(s => s.includes('menu-dump:hover:'));
  const beforeHover = hover => menuLines.find(s => s.includes(`hover=${hover}`)) || '';
  const checked = (line, item) => new RegExp(`#${item} id=\\d+ flags=0x4(?: |$)`).test(line);
  const grayed = (line, item) => new RegExp(`#${item} id=\\d+ flags=0x2(?: |$)`).test(line);
  assert(checked(beforeHover(1), 0), 'Flat selection was not reflected by the menu checkmark');
  assert(checked(beforeHover(2), 1), 'Gouraud selection was not reflected by the menu checkmark');
  // Globe asks for Phong and Anti-aliasing to be grayed at startup — no real
  // D3D driver ever implemented D3DSHADE_PHONG, and our software device does
  // not anti-alias either. So clicking those rows must do nothing and the
  // checkmark must stay where it was (Gouraud from the click before).
  assert(grayed(beforeHover(4), 2), 'Globe grayed Phong but the menu did not honour it');
  assert(checked(beforeHover(4), 1), 'a click on the grayed Phong row moved the shade-mode checkmark');
  assert(!checked(beforeHover(6), 4), 'Lighting toggle did not clear its menu checkmark');
  assert(checked(beforeHover(7), 6), 'Point selection was not reflected by the menu checkmark');
  assert(checked(beforeHover(8), 7), 'Wireframe selection was not reflected by the menu checkmark');
  assert(checked(beforeHover(10), 8), 'Solid selection was not reflected by the menu checkmark');
  assert(checked(beforeHover(11), 10), 'Dithering toggle did not set its menu checkmark');
  assert(grayed(beforeHover(13), 11), 'Globe grayed Anti-aliasing but the menu did not honour it');
  assert(checked(beforeHover(14), 13), 'Point filtering selection was not reflected by the menu checkmark');
  const finalMenu = out.split('\n').find(s => s.includes('menu-dump:final:')) || '';
  assert(checked(finalMenu, 14), 'Bi-Linear filtering selection was not reflected by the menu checkmark');
  assert(/window:after .*title="Globe Direct3DRM Example"/.test(out),
    'Globe closed or crashed while exercising Render options');
  assert(/window:after .*size=300x300 .*title="Globe Direct3DRM Example"/.test(out),
    'DDSCL_NORMAL primary surface resized Globe instead of preserving its viewport-sized window');
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
