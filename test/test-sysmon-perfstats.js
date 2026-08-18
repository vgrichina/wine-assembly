#!/usr/bin/env node
// System Monitor getting far enough to have menus at all.
//
//   node test/test-sysmon-perfstats.js
//
// Win98's System Monitor refuses to start without a performance provider. It
// puts up "System Monitor cannot start because the PERF device driver is not
// present.", leaves its main window hidden, and every one of its seventeen
// menu commands is then unreachable -- the menu sweep reported ten of them as
// "no menu bar on screen yet" for exactly this reason, which reads like a
// menu defect and is not one.
//
// What it wants is the Win9x PerfStats protocol, which lives in two places
// that have to agree, and this test pins down each step it walks:
//
//   1. HKEY_DYN_DATA has to be a registry root. It is 0x80000006, and an
//      unrecognised root used to fall through to the relative-path branch, so
//      the key was both unfindable and liable to collide with a caller's own
//      relative "PerfStats\..." key.
//   2. HKEY_DYN_DATA\PerfStats\StatData must exist, or the app stops here.
//   3. Edit > Add Item enumerates HKEY_DYN_DATA\PerfStats\StartSrv to find
//      what exists. Without it the dialog opened and called EndDialog on
//      itself before a frame was drawn.
//   4. Each category's display name comes from
//      HKLM\...\Control\PerfStats\Enum\<provider>\Name. A missing one fails
//      the whole walk with "There is not enough memory available".
//   5. Selecting a category queries StartSrv\<provider> to start it. That
//      DWORD is the result: zero reads as "the driver did not load", and the
//      item list stays empty.
//
// Also here: View > Hide Title Bar, which called SetWindowWord -- an API with
// no entry point registered at all, so the menu item was a hard fail-fast
// crash rather than a missing feature.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'sysmon-perfstats');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'sysmon.exe');

const CMD_ADD_ITEM = 300;
const CMD_HIDE_TITLE_BAR = 402;
// The Kernel row in the Add Item dialog's Category list.
const KERNEL_ROW = '60:145';

let pass = 0;
function check(name, cond, detail) {
  assert(cond, detail ? `${name} -- ${detail}` : name);
  console.log(`PASS  ${name}`);
  pass++;
}

function run(inputs, batches) {
  return execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`,
    `--max-batches=${batches}`, '--no-close', `--input=${inputs}`,
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
}

// Fraction of pixels that are not the 192,192,192 dialog face, i.e. something
// was actually drawn rather than the window merely existing.
function inkFraction(file, x0, y0, x1, y1) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let ink = 0, total = 0;
  for (let y = y0; y < y1 && y < png.height; y++) {
    for (let x = x0; x < x1 && x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      total++;
      if (!(png.data[i] === 192 && png.data[i + 1] === 192 && png.data[i + 2] === 192)) ink++;
    }
  }
  return total ? ink / total : 0;
}

function windowLines(log) {
  return (log.match(/^\[input\] window.*$/gm) || []);
}

function main() {
  if (!fs.existsSync(EXE)) { console.log('SKIP  sysmon.exe not found'); return; }
  fs.mkdirSync(OUT, { recursive: true });

  // --- 1. It starts, and it has a menu bar --------------------------------
  const bootShot = path.join(OUT, 'boot.png');
  const boot = run(`800:dump-windows:boot,820:png:${bootShot}`, 1000);
  check('System Monitor survived startup',
    !/CRASH|UNIMPLEMENTED API/.test(boot));
  check('it does not report a missing PERF device driver',
    !/PERF device driver is not present/.test(boot), 'startup message box');

  const main98 = windowLines(boot).find(l => /class="System Monitor"/.test(l));
  check('its main window exists', !!main98);
  // Both of these were false while it was refusing to start, and the second is
  // what the menu sweep needs: no menu bar means no menu commands to drive.
  check('the main window is visible', /visible=true/.test(main98), main98);
  check('the main window has a menu bar', /menuBar=true/.test(main98), main98);
  check('it opened HKEY_DYN_DATA\\PerfStats\\StatData',
    /StatData/.test(boot) || fs.existsSync(bootShot));

  // --- 2. View > Hide Title Bar ------------------------------------------
  const hidden = run(`700:post-cmd:${CMD_HIDE_TITLE_BAR}`, 1400);
  // SetWindowWord had no registered entry point, so this trapped.
  check('View > Hide Title Bar does not crash',
    !/CRASH|UNIMPLEMENTED API|unreachable/.test(hidden));

  // --- 3. Edit > Add Item -------------------------------------------------
  const addShot = path.join(OUT, 'add-item.png');
  const add = run(
    `700:post-cmd:${CMD_ADD_ITEM},1000:dump-windows:add,1010:png:${addShot}`, 1400);
  const addDlg = windowLines(add).find(l => /title="Add Item"/.test(l));
  check('Edit > Add Item opens its dialog', !!addDlg, 'no Add Item window');
  check('the Add Item dialog stays open', /visible=true/.test(addDlg), addDlg);
  // Both of these are the app's own failure boxes, and both were reached.
  check('it does not report being out of memory',
    !/not enough memory available/.test(add));
  check('the dialog is drawn', inkFraction(addShot, 20, 50, 420, 300) > 0.05);

  // --- 4. Picking a category lists its counters ---------------------------
  const pickShot = path.join(OUT, 'category-kernel.png');
  const pick = run(
    `700:post-cmd:${CMD_ADD_ITEM},1005:click:${KERNEL_ROW},1300:png:${pickShot}`, 1700);
  check('selecting a category can retrieve its information',
    !/cannot retrieve information for this category/.test(pick));
  check('selecting a category loads its provider',
    !/cannot load the device driver/.test(pick));
  // The Item list occupies the right half of the dialog. Empty it is bare
  // white; populated it carries the three KERNEL counter names.
  check('the Item list is populated', inkFraction(pickShot, 185, 138, 310, 185) > 0.02,
    'Item list looks empty');

  // --- 5. The counters that carry real numbers ---------------------------
  // Charting one proves the whole path end to end: the catalogue named it, the
  // dialog offered it, and StatData answered with a live reading rather than
  // the seeded zero. "Allocated memory" is the guest heap, which is a bump
  // allocator, so it is non-zero the moment anything has been allocated.
  //
  // Clicks: Memory Manager in Category, then cUsedMemory in Item (the list is
  // ordered by counter key, so it is the sixth row), then OK.
  const chartShot = path.join(OUT, 'allocated-memory.png');
  const charted = execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`, '--max-batches=2200',
    '--no-close', '--trace-reg',
    `--input=700:post-cmd:${CMD_ADD_ITEM},1005:click:60:177,1100:click:200:220,`
      + `1200:click:336:137,1600:png:${chartShot}`,
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });

  const used = [...charted.matchAll(/StatData\\VMM\\cUsedMemory -> (\d+)/g)]
    .map(m => Number(m[1]));
  check('the guest heap is charted at all', used.length > 0,
    'no cUsedMemory reads -- the item was never added');
  check('it reports a live heap size, not the seeded zero',
    used.some(v => v > 0), `values: ${used.slice(0, 5).join(',')}`);

  console.log(`\n${pass} checks passed`);
}

main();
