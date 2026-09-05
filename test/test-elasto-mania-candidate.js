#!/usr/bin/env node
'use strict';

// End-to-end gate for the exact registered Elasto Mania 1.0 archive. The
// payload is proprietary and gitignored, so this test skips until the pinned
// candidate recipe has been fetched locally.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const GAME_ROOT = path.join(__dirname, 'binaries', 'candidates',
  'elasto-mania', 'Elma');
const EXE = path.join(GAME_ROOT, 'Elma.exe');
const RESOURCE = path.join(GAME_ROOT, 'Elma.res');

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function frameStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  const colors = new Set();
  let sky = 0;
  let foliage = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (b > 110 && b > r * 1.5 && b > g * 1.15) sky++;
    if (g > 70 && g > r * 1.25 && g > b * 1.1) foliage++;
  }
  return { width: png.width, height: png.height, colors: colors.size, sky, foliage };
}

function main() {
  if (!fs.existsSync(EXE) || !fs.existsSync(RESOURCE)) {
    console.log('SKIP Elasto Mania candidate: fetch elasto-mania from the pinned corpus recipe');
    return;
  }
  assert.strictEqual(sha256(EXE),
    '348d1f3480c001956493f67f159d815bbe5bc51d8a16f8805cc2052039c1c44d');
  assert.strictEqual(sha256(RESOURCE),
    '87a24b8f9e56066b418e78c80e30561235118dbf20344089e94bad1bfea50146');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-elasto-mania-'));
  const screenshot = process.env.ELASTO_MANIA_SCREENSHOT || path.join(temp, 'level.png');
  try {
    const input = [120, 260, 400, 540, 700]
      .flatMap(batch => [`${batch}:keydown:13`, `${batch + 1}:keyup:13`]);
    input.push(`1050:png:${screenshot}`);
    const run = spawnSync(process.execPath, [
      'test/run.js', '--app=elasto_mania',
      '--max-batches=1150', '--batch-size=200000', '--max-seconds=150',
      '--tick-ms-per-batch=16', '--copy-superops', '--quiet-api',
      '--quiet-blocks', '--no-close', `--input=${input.join(',')}`,
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    assert.strictEqual(run.status, 0, output.slice(-12000));
    assert(fs.existsSync(screenshot), `Elasto Mania did not capture a level frame\n${output.slice(-12000)}`);
    const stats = frameStats(screenshot);
    assert.deepStrictEqual([stats.width, stats.height], [640, 480]);
    assert(stats.colors > 100 && stats.sky > 90000 && stats.foliage > 1000,
      `expected the rendered motorbike level, got ${JSON.stringify(stats)}\n${output.slice(-12000)}`);
    assert(!/STUCK|CRASH|RuntimeError|LinkError|buffsize < 20/i.test(output),
      `Elasto Mania emitted a failure marker:\n${output.slice(-12000)}`);
    console.log(`PASS Elasto Mania 1.0 reaches playable motorbike level (${JSON.stringify(stats)})`);
    if (process.env.ELASTO_MANIA_SCREENSHOT) console.log(`  screenshot: ${screenshot}`);
  } finally {
    if (!process.env.ELASTO_MANIA_SCREENSHOT) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main();
