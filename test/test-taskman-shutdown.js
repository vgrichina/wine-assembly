#!/usr/bin/env node
// Task Manager's File > Shutdown Windows... is the guest-side front door to
// shutting the machine down: SHELL32's ExitWindowsDialog opens the WAT-built
// "Shut Down Windows" dialog (src/09c3-controls.wat) and its OK hands the
// chosen option to the exit_windows host import. Headless, that import only
// logs, which is exactly what this asserts on -- the browser sequence behind
// it is test-web-shutdown.js's job.
//
// Two arms in two runs: the dialog as opened (Windows 98 preselects "Shut
// down", so a bare OK must report mode 1), and Restart chosen by clicking its
// radio before OK (mode 2). The first run also photographs the dialog and
// checks that three radio circles are actually painted where the layout puts
// them, so a dialog that opens but draws nothing cannot pass on the log line.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'taskman.exe');
const OUT = path.join(ROOT, 'test', 'output', 'taskman-shutdown');
const dialogPng = path.join(OUT, 'dialog.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  taskman.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });

const CMD_SHUTDOWN_WINDOWS = 403;   // taskman.exe File menu, "Sh&utdown Windows..."
const IDOK = 1;
// Screen position of the "Restart" radio's circle when Task Manager sits at
// its default place and the dialog is centred on it (test/run.js 640x480).
const RESTART_RADIO = { x: 116, y: 164 };
// The three radios' circle centres, top to bottom, on the same screen.
const RADIO_CENTRES = [125, 144, 164];

function runTaskman(input, label) {
  const logFile = path.join(OUT, `${label}.log`);
  let output = '';
  try {
    output = execFileSync(process.execPath, [
      RUN,
      `--exe=${EXE}`,
      `--input=${input}`,
      '--max-batches=110',
      '--batch-size=50000',
      '--no-close',
      '--quiet-api',
      '--quiet-blocks',
      ...(process.env.WINE_ASSEMBLY_WASM ? ['--no-build'] : []),
    ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    output = `${error.stdout || ''}${error.stderr || ''}`;
  }
  fs.writeFileSync(logFile, output);
  return output;
}

async function radioCircles(file) {
  // A radio's circle is a dark ring on the grey dialog: count columns with a
  // black pixel in each 12px row band around the three expected centres.
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const dark = (x, y) => {
    const i = (y * image.width + x) * 4;
    return pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80;
  };
  return RADIO_CENTRES.map(cy => {
    let hit = 0;
    for (let y = cy - 6; y <= cy + 6; y++) {
      for (let x = RESTART_RADIO.x - 7; x <= RESTART_RADIO.x + 7; x++) {
        if (dark(x, y)) hit++;
      }
    }
    return hit;
  });
}

async function main() {
  let failed = 0;
  const check = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failed++; };

  // Arm 1: open, photograph, OK.
  const first = runTaskman([
    `30:post-cmd:${CMD_SHUTDOWN_WINDOWS}`,
    `60:png:${dialogPng}`,
    `70:dlg-cmd:${IDOK}`,
    '90:stop',
  ].join(','), 'shutdown');
  check(/\[input\] dlg-cmd: cmd=1 hwnd=0x[0-9a-f]+ at batch 70/.test(first),
    'OK reached a live Shut Down Windows dialog');
  check(first.includes('[ExitWindows] mode=1 (shutdown)'),
    'a bare OK reports shut down (mode 1), the option the dialog opens on');
  check(!first.includes('[ExitWindows] mode=0'), 'stand by was not reported by mistake');
  if (fs.existsSync(dialogPng)) {
    const rings = await radioCircles(dialogPng);
    check(rings.every(n => n >= 12), `three radio circles painted (${rings.join(', ')} dark px)`);
  } else {
    check(false, 'dialog screenshot was written');
  }

  // Arm 2: choose Restart, then OK.
  const second = runTaskman([
    `30:post-cmd:${CMD_SHUTDOWN_WINDOWS}`,
    `55:click:${RESTART_RADIO.x}:${RESTART_RADIO.y}`,
    `70:dlg-cmd:${IDOK}`,
    '90:stop',
  ].join(','), 'restart');
  check(second.includes('[ExitWindows] mode=2 (restart)'),
    'OK after clicking Restart reports restart (mode 2)');
  check(!second.includes('[ExitWindows] mode=1'), 'restart run did not also report shut down');

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
