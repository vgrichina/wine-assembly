#!/usr/bin/env node
'use strict';

// Rodent2000 is the VB6 remake of Rodent's Revenge. Its startup pictures are
// decoded by Win9x OLEAUT32, which calls USER32 CreateIcon with BYTE arguments
// whose unused stack-slot bits are not zero. A launch-only window check misses
// that failure: VB6 catches CreateIcon's NULL result, shows "Unexpected error",
// and leaves a credits splash over a black playfield. Drive Game > New Game and
// require the unmistakable tiled board instead.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

function countColor(png, rgb, rect) {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] === rgb[0] && png.data[i + 1] === rgb[1] &&
          png.data[i + 2] === rgb[2]) count++;
    }
  }
  return count;
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodent2000-gameplay-'));
const framePath = path.join(outDir, 'new-game.png');
try {
  const args = [RUN];
  if (OPTIONAL_WASM) args.push('--no-build', `--wasm=${OPTIONAL_WASM}`);
  args.push(
    '--app=rodent2000', '--max-batches=4300', '--batch-size=2000',
    '--quiet-api', '--quiet-blocks', '--trace-fs',
    '--input=2500:mousedown:155:38,2501:mouseup:155:38,' +
      '2700:mousedown:165:58,2701:mouseup:165:58,' +
      `3000:dump-windows:rodent,4000:png:${framePath},4100:stop`,
  );

  let output;
  try {
    output = execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = `${error.stdout || ''}${error.stderr || ''}`;
    throw new Error(`Rodent2000 run failed\n${detail.slice(-8000)}`);
  }

  assert.doesNotMatch(output,
    /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError|Unexpected error/i,
    'Rodent2000 must clear VB6 startup without its caught OLE picture error');
  for (let level = 0; level < 5; level++) {
    const name = String(level).padStart(5, '0');
    assert.match(output, new RegExp(`CreateFile\\("C:\\\\levels\\\\${name}\\.rodent_level"`),
      `Rodent2000 must read bundled level ${name}`);
  }
  assert.match(output, /mousedown 165,58 at batch 2700/,
    'Game > New Game must travel through real menu input');
  assert.match(output,
    /window:rodent hwnd=65540 .* visible=true .*title="Rodent's Revenge 2000(?: - Level 1)?"/,
    'VB6 visible form must retain its DefWindowProc WM_SETTEXT caption');
  assert(fs.existsSync(framePath), 'Rodent2000 did not capture its New Game frame');

  const png = PNG.sync.read(fs.readFileSync(framePath));
  assert.strictEqual(`${png.width}x${png.height}`, '640x480');
  const board = { x: 130, y: 90, w: 380, h: 380 };
  const floor = countColor(png, [128, 128, 0], board);
  const tiles = countColor(png, [0, 128, 0], board);
  const tileInk = countColor(png, [0, 248, 0], board);
  const frame = countColor(png, [0, 248, 255], board);
  assert(floor > 40000 && tiles > 20000 && tileInk > 3000 && frame > 2000,
    `Rodent2000 must render its dealt board ` +
    `(floor=${floor}, tiles=${tiles}, tileInk=${tileInk}, frame=${frame})`);

  console.log(`PASS  Rodent2000 loads five levels and deals a board ` +
    `(${tiles} tile pixels, ${frame} frame pixels)`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
