#!/usr/bin/env node
// region-shake-smoke.js — run a real app on a SHAKEN memory map.
//
//   node tools/region-shake-smoke.js                       # gap, rotate, seed
//   node tools/region-shake-smoke.js --shake=gap --app=sol
//   node tools/region-shake-smoke.js --modes=gap,pad,reverse --batches=2000
//
// WHY THIS EXISTS
// §8 of docs/watx-region-safety-design.md asks for the map to be permuted and
// the emulator to still work, because that is the only evidence that nothing
// depends on a region's ADDRESS. Wave 3 made the permutation possible (167 of
// 175 regions are allocated), but running one is not a matter of setting an
// env var: the wasm is only half the map.
//
// The other half is lib/region-map.generated.js. Every host import reads guest
// memory through it — the DIB arena, the window records, the RPC blocks — so a
// shaken artifact paired with the canonical mirror does not fail loudly, it
// reads the wrong bytes and draws a plausible wrong picture. This tool builds
// the pair and keeps them together:
//
//   1. compile the tree with WINE_REGION_SHAKE=MODE to a scratch .wasm
//   2. render the matching mirror with gen-region-map.js --shake=MODE --out=…
//   3. run test/run.js --no-build --wasm=<scratch> with $WINE_REGION_MAP
//      pointing at that mirror
//   4. compare the PNG against the same app on the canonical build
//
// Nothing in the repository is written or moved: the artifacts live in a temp
// directory, which matters because this runs in a worktree other agents build
// in. A pass means the app drew the SAME PICTURE with every table at a
// different address.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};

const APP = arg('app', 'sol');
const BATCHES = String(arg('batches', 2000));
const MODES = String(arg('modes', arg('shake', 'gap,rotate,0x9E3779B9'))).split(',');
const KEEP = !!arg('keep', false);

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}

function capture(pngPath, wasm, mapFile) {
  const env = { ...process.env };
  if (mapFile) env.WINE_REGION_MAP = mapFile;
  const args = ['test/run.js', `--app=${APP}`, '--quiet-api', '--no-close',
    `--max-batches=${BATCHES}`, `--png=${pngPath}`];
  if (wasm) args.push('--no-build', `--wasm=${wasm}`);
  return run(process.execPath, args, { env });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'region-shake-'));
  let failed = 0;
  try {
    // The control. Built from the same tree by the same compiler, so a
    // difference downstream is the layout and nothing else.
    const canonicalWasm = path.join(tmp, 'canonical.wasm');
    run(process.execPath, ['tools/build-compile-wat.js', `--out=${canonicalWasm}`,
      `--compat-out=${path.join(tmp, 'canonical.compat.wasm')}`]);
    const canonicalPng = path.join(tmp, 'canonical.png');
    capture(canonicalPng, canonicalWasm, null);
    console.log(`region-shake-smoke: control captured (${APP}, ${BATCHES} batches)`);

    for (const mode of MODES) {
      const wasm = path.join(tmp, `shake-${mode}.wasm`);
      const map = path.join(tmp, `region-map-${mode}.js`);
      const png = path.join(tmp, `shake-${mode}.png`);
      const build = run(process.execPath, ['tools/build-compile-wat.js', `--out=${wasm}`,
        `--compat-out=${path.join(tmp, `shake-${mode}.compat.wasm`)}`],
        { env: { ...process.env, WINE_REGION_SHAKE: mode } });
      const banner = (build.match(/^Region layout:.*$/m) || ['(no banner)'])[0];
      run(process.execPath, ['tools/gen-region-map.js', `--shake=${mode}`, `--out=${map}`]);
      let verdict;
      try {
        capture(png, wasm, map);
        const diff = run(process.execPath, ['tools/png-diff.js', canonicalPng, png]);
        verdict = `IDENTICAL — ${diff.trim().split('\n')[0]}`;
      } catch (err) {
        const out = `${err.stdout || ''}${err.stderr || ''}`.trim().split('\n').slice(-2).join(' | ');
        verdict = `FAILED — ${out || err.message}`;
        failed++;
      }
      console.log(`  ${String(mode).padEnd(12)} ${banner.replace('Region layout: ', '')}`);
      console.log(`  ${' '.repeat(12)} ${verdict}`);
    }
  } finally {
    if (KEEP) console.log(`region-shake-smoke: artifacts kept in ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed
    ? `region-shake-smoke: ${failed} of ${MODES.length} shaken layout(s) did not reproduce the picture`
    : `region-shake-smoke: ${MODES.length} shaken layout(s) drew the same picture as the canonical map`);
  process.exit(failed ? 1 : 0);
}

main();
