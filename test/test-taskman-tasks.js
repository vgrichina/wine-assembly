#!/usr/bin/env node

// End-to-end Win98 Task Manager regression with one renderer-owned foreign
// window. Exercises startup enumeration, listbox rendering, all three menus,
// Switch To activation, Minimize on Use, and End Task's cross-instance close.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'taskman.exe');
const OUT = path.join(ROOT, 'scratch', 'taskman-tasks');
const tasksPng = path.join(OUT, 'tasks.png');
const menuPng = path.join(OUT, 'options-menu.png');
const closedPng = path.join(OUT, 'task-closed.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  taskman.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of [tasksPng, menuPng, closedPng]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  '50:dump-listbox:tasks',
  `55:png:${tasksPng}`,
  '65:wait-title-menu-open:Tasks:100:70:file',
  '67:menu-dump:file',
  '70:keydown:27',
  '80:wait-title-menu-open:Tasks:100:87:windows',
  '82:menu-dump:windows',
  '85:keydown:27',
  '95:wait-title-menu-open:Tasks:100:79:options',
  '97:menu-dump:options',
  `99:png:${menuPng}`,
  '102:keydown:27',
  '110:click:40:58',
  '120:post-cmd:424',
  '130:post-cmd:425',
  '170:dump-listbox:closed',
  `175:png:${closedPng}`,
  '190:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    '--seed-window=Calculator',
    `--input=${input}`,
    '--max-batches=220',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

async function countDarkPixels(file, box) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let count = 0;
  for (let y = box.y0; y < Math.min(box.y1, image.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (pixels[i] < 120 && pixels[i + 1] < 120 && pixels[i + 2] < 120) count++;
    }
  }
  return count;
}

(async () => {
  const screenshots = [tasksPng, menuPng, closedPng].every(file =>
    fs.existsSync(file) && fs.statSync(file).size > 4000);
  const taskTextPixels = screenshots
    ? await countDarkPixels(tasksPng, { x0: 13, y0: 51, x1: 120, y1: 68 })
    : 0;
  const checks = [
    ['emulator run completed', !runFailed],
    ['foreign task populated native listbox', /dump-listbox:tasks:[^\n]*count=1[^\n]*#0 "Calculator"/.test(output)],
    ['task title rendered in pane', taskTextPixels >= 20],
    ['File menu exposes two commands', /menu-dump:file:[^\n]*count=2/.test(output) && output.includes('&Run Application...')],
    ['Windows menu exposes task commands', /menu-dump:windows:[^\n]*count=10/.test(output) && output.includes('&Switch To') && output.includes('&End Task')],
    ['Options menu exposes six toggles', /menu-dump:options:[^\n]*count=6/.test(output) && output.includes('Always &On Top') && output.includes('Status &Bar')],
    ['Switch To activated selected renderer task', /\[seed-window\] activate hwnd=0x00070001 result=1/.test(output)],
    ['Minimize on Use minimized Task Manager', /\[ShowWindow\] hwnd=0x10001 cmd=6/.test(output)],
    ['End Task routed WM_CLOSE to owning task', /\[seed-window\] post hwnd=0x00070001 msg=0x00000010/.test(output)],
    ['closed renderer task removed from host task set', /\[seed-window\] closed hwnd=0x00070001/.test(output)],
    ['Task Manager refreshed after task exit', /dump-listbox:closed:[^\n]*count=0/.test(output)],
    ['task and menu screenshots written', screenshots],
    ['no unimplemented API or runtime crash', !/UNIMPLEMENTED API:|RuntimeError|LinkError|\*\*\* CRASH/.test(output)],
  ];

  if (runFailed) {
    console.error(output.split('\n').filter(line =>
      /UNIMPLEMENTED|Runtime|CRASH|seed-window|dump-listbox|menu-dump/.test(line),
    ).slice(-50).join('\n'));
  }
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`Screenshots: ${OUT}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
