#!/usr/bin/env node
// Regression: Notepad Find Next not-found path shows a real MessageBox and
// the modal can be dismissed with Enter.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');
const PNG = path.join(ROOT, 'scratch', 'find_not_found_msgbox_test.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}

const input = [
  '50:0x111:3',
  '90:focus-find',
  '92:keypress:65',
  '100:mousedown:350:101',
  '120:mouseup:350:101',
  `150:png:${PNG}`,
  '155:dlg-dump:message',
  '160:keydown:13',
  '210:slot-count:after-enter',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${input}`,
  '--max-batches=240',
  '--quiet-api',
  '--no-close',
];

console.log('$ node', args.map(a => JSON.stringify(a)).join(' '));
const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
const out = (r.stdout || '') + (r.stderr || '');

for (const line of out.split('\n')) {
  if (/FindTextA|MessageBox|png|dlg-dump:message|slot-count after-enter|STUCK|CRASH|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

async function messageBoxLooksVisible() {
  if (!fs.existsSync(PNG)) return false;
  const img = await loadImage(PNG);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  let blue = 0, gray = 0, black = 0;
  for (let y = 100; y < 140; y++) {
    for (let x = 100; x < 320; x++) {
      const i = (y * img.width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (b > 90 && r < 40 && g < 90) blue++;
      if (Math.abs(r - 192) < 20 && Math.abs(g - 192) < 20 && Math.abs(b - 192) < 20) gray++;
      if (r < 40 && g < 40 && b < 40) black++;
    }
  }
  return blue > 400 && gray > 1000 && black > 20;
}

(async () => {
  const checks = [];
  const check = (name, pass) => checks.push([name, !!pass]);

  check('process exited', r.status === 0 && !r.signal && !r.error);
  check('Find dialog appeared', out.includes('[FindTextA]'));
  check('not-found MessageBox was requested', out.includes('Cannot find "A"'));
  check('MessageBox controls exist', /dlg-dump:message: dlg=0x[0-9a-f]+ .* id=1 cls=1/.test(out));
  check('MessageBox is visible in PNG', await messageBoxLooksVisible());
  check('Enter dismissed MessageBox and returned to Find dialog', /slot-count after-enter: used=11 dlg=0x10003/.test(out));
  check('no STUCK', !out.includes('STUCK'));
  check('no UNIMPLEMENTED', !out.includes('UNIMPLEMENTED'));
  check('no CRASH', !out.includes('CRASH'));

  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
