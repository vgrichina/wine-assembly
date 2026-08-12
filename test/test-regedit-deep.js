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
const statusVisiblePng = path.join(OUT, 'status-visible.png');
const statusHiddenPng = path.join(OUT, 'status-hidden.png');
const statusShownLatePng = path.join(OUT, 'status-shown-late.png');
const doubleClickPng = path.join(OUT, 'tree-double-click.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  regedit.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of [deepPng, menuPng, statusVisiblePng, statusHiddenPng, statusShownLatePng, doubleClickPng]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  '0:wait-title:Registry_Editor:1200',
  `0:png:${statusVisiblePng}`,
  '2:post-cmd:668',                  // View > Status Bar off
  '4:dump-windows:status-hidden',
  `4:png:${statusHiddenPng}`,
  '6:dblclick:92:113',               // update path while status bar is hidden
  '9:dump-tree:double-click',
  `9:png:${doubleClickPng}`,
  '11:post-cmd:668',                 // View > Status Bar on after path update
  '13:dump-windows:status-shown-late',
  `13:png:${statusShownLatePng}`,
  '14:click:47:103',                 // expand HKEY_CURRENT_USER
  '17:click:63:119',                 // expand Control Panel
  '20:click:100:135',                // select Desktop
  '23:dump-tree:deep',
  '23:dump-listview:desktop',
  `23:png:${deepPng}`,
  '26:wait-title-menu-open:Registry_Editor:100:82:registry',
  '26:menu-dump:registry',
  `27:png:${menuPng}`,
  '28:stop',
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

async function inspectScreenshot(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let ink = 0;
  let folderPixels = 0;
  for (let y = 80; y < Math.min(165, image.height); y++) {
    for (let x = 245; x < Math.min(415, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) ink++;
    }
  }
  for (let y = 62; y < Math.min(245, image.height); y++) {
    for (let x = 35; x < Math.min(95, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] < 80) folderPixels++;
    }
  }
  return { paneInk: ink, folderPixels };
}

async function countStatusInk(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let ink = 0;
  for (let y = 300; y < Math.min(315, image.height); y++) {
    for (let x = 24; x < Math.min(160, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) ink++;
    }
  }
  return ink;
}

(async () => {
  const screenshots = [deepPng, menuPng, statusVisiblePng, statusHiddenPng, statusShownLatePng, doubleClickPng]
    .every(file => fs.existsSync(file) && fs.statSync(file).size > 0);
  const visual = screenshots ? await inspectScreenshot(deepPng) : null;
  const statusVisibleInk = screenshots ? await countStatusInk(statusVisiblePng) : -1;
  const statusHiddenInk = screenshots ? await countStatusInk(statusHiddenPng) : -1;
  const statusShownLateInk = screenshots ? await countStatusInk(statusShownLatePng) : -1;
  const paneInk = visual ? visual.paneInk : -1;
  const listDump = (output.match(/dump-listview:desktop:[^\n]*/) || [''])[0];
  const checks = [
    ['emulator run completed', !runFailed],
    ['View Status Bar hides the status child',
      /window:status-hidden[^\n]*class="msctls_statusbar32"[^\n]*visible=false/.test(output)],
    [`visible status bar renders its path (${statusVisibleInk} vs ${statusHiddenInk} dark px)`,
      statusVisibleInk >= statusHiddenInk + 20],
    ['status path is copied while hidden and retained when shown later',
      /window:status-shown-late[^\n]*class="msctls_statusbar32"[^\n]*visible=true[^\n]*title="My Computer\\\\HKEY_LOCAL_MACHINE"/.test(output)],
    [`status bar shown later renders the updated path (${statusShownLateInk} dark px)`,
      statusShownLateInk >= statusHiddenInk + 80],
    ['TreeView double-click expands and selects HKEY_LOCAL_MACHINE',
      /dump-tree:double-click:[^\n]*visible=9[^\n]*state=0x40000022[^\n]*text="HKEY_LOCAL_MACHINE"[^\n]*text="SOFTWARE"/.test(output)],
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
    [`tree displays classic folder glyphs (${visual ? visual.folderPixels : -1} yellow px)`,
      !!visual && visual.folderPixels >= 250],
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
