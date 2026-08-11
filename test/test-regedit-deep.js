#!/usr/bin/env node

// App-level RegEdit regression: expand a real nested registry path, select the
// Desktop key, verify its ListView values, and parse the MENUEX Registry menu.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'regedit.exe');
const OUT = path.join(ROOT, 'scratch', 'regedit-deep');
const deepPng = path.join(OUT, 'desktop-values.png');
const menuPng = path.join(OUT, 'registry-menu.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  regedit.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of [deepPng, menuPng]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  '0:wait-title:Registry_Editor:1200',
  '0:click:47:103',                  // expand HKEY_CURRENT_USER
  '3:click:63:119',                  // expand Control Panel
  '6:click:100:135',                 // select Desktop
  '9:dump-tree:deep',
  '9:dump-listview:desktop',
  `9:png:${deepPng}`,
  '12:wait-title-menu-open:Registry_Editor:100:82:registry',
  '12:menu-dump:registry',
  `13:png:${menuPng}`,
  '14:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=1320',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

async function countRightPaneInk(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let ink = 0;
  for (let y = 80; y < Math.min(165, image.height); y++) {
    for (let x = 245; x < Math.min(415, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) ink++;
    }
  }
  return ink;
}

(async () => {
  const screenshots = [deepPng, menuPng].every(file => fs.existsSync(file) && fs.statSync(file).size > 0);
  const paneInk = screenshots ? await countRightPaneInk(deepPng) : -1;
  const listDump = (output.match(/dump-listview:desktop:[^\n]*/) || [''])[0];
  const checks = [
    ['emulator run completed', !runFailed],
    ['nested TreeView contains HKCU, Control Panel, Desktop, and Mouse',
      /dump-tree:deep:[^\n]*HKEY_CURRENT_USER[^\n]*Control Panel[^\n]*Desktop[^\n]*Mouse/.test(output)],
    ['Desktop TreeView row is selected', /dump-tree:deep:[^\n]*state=0x22[^\n]*text="Desktop"/.test(output)],
    ['Desktop ListView has four rows and two columns', /dump-listview:desktop:[^\n]*count=4 columns=2/.test(output)],
    ['Desktop ListView exposes all expected names',
      ['(Default)', 'Wallpaper', 'TileWallpaper', 'ScreenSaveActive'].every(value => listDump.includes(value))],
    ['Desktop ListView exposes unset, empty, and zero values',
      listDump.includes('(value not set)') && listDump.includes('\\"\\"') && listDump.includes('\\"0\\"')],
    ['MENUEX Registry menu has nine direct items', /menu-dump:registry:[^\n]*count=9/.test(output)],
    ['Registry menu exposes Import, Export, Connect, Disconnect, Print, and Exit',
      ['Import', 'Export', 'Connect', 'Disconnect', 'Print', 'xit'].every(value => output.includes(value))],
    ['both screenshots were written', screenshots],
    [`value pane contains rendered text (${paneInk} dark px)`, paneInk >= 100],
    ['no unimplemented API or runtime crash', !/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
  ];

  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  if (runFailed) console.error(output.slice(-4000));
  console.log(`Screenshots: ${OUT}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
