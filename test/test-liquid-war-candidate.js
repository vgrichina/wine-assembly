#!/usr/bin/env node

// End-to-end gate for the original Liquid War 5 Windows client. The corpus
// payload is local/gitignored, so the test reports an explicit SKIP when it
// has not been fetched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { compileSrcWasm } = require('./compile-src');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CANDIDATE_ROOT = path.join(__dirname, 'binaries', 'candidates', 'liquid-war', 'LW5');
const CLIENT = path.join(CANDIDATE_ROOT, 'lwwin.exe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  let nonBlack = 0;
  let red = 0;
  let yellow = 0;
  let blue = 0;
  let white = 0;
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const a = png.data[i + 3];
    if (a && (r || g || b)) nonBlack++;
    if (a) colors.add((r << 16) | (g << 8) | b);
    if (a && r > 180 && g < 80 && b < 80) red++;
    if (a && r > 180 && g > 180 && b < 80) yellow++;
    if (a && r < 80 && g > 40 && b > 100) blue++;
    if (a && r > 180 && g > 180 && b > 180) white++;
  }
  return { width: png.width, height: png.height, nonBlack, colors: colors.size, red, yellow, blue, white };
}

async function main() {
  if (!fs.existsSync(CLIENT)) {
    console.log('SKIP Liquid War candidate: fetch with node tools/fetch-candidate-corpus.js --id=liquid-war');
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-liquid-war-candidate-'));
  const wasmPath = path.join(temp, 'candidate.wasm');
  const framePath = path.join(temp, 'liquid-war-menu.png');
  const gameplayPath = path.join(temp, 'liquid-war-gameplay.png');
  const vfsRoot = path.join(temp, 'vfs');

  try {
    const wasm = compileSrcWasm();
    await WebAssembly.compile(wasm);
    fs.writeFileSync(wasmPath, wasm);

    const result = spawnSync('node', [
      RUN,
      `--exe=${CLIENT}`,
      `--wasm=${wasmPath}`,
      '--no-build',
      '--no-close',
      '--quiet-api',
      '--quiet-blocks',
      '--max-batches=92000',
      '--max-seconds=180',
      '--thread-slices=4',
      '--stuck-after=100000',
      '--input=20:wait-dlg-control:1:2000,21:dlg-click:1,60:wait-dlg-control:1:2000,61:dlg-click:1,' +
        `48000:png-pixels:${framePath},50000:keydown:13,50001:di-keyup:13,` +
        `65000:png-pixels:${gameplayPath},92000:stop`,
      `--save-vfs=${vfsRoot}`,
      `--png=${framePath}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error) throw result.error;
    assert(result.status === 0,
      `Liquid War CLI exited ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${output.slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
      `Liquid War hit a compatibility failure\n${output.slice(-8000)}`);
    assert(!/OLE32\.DLL can't be loaded|DCOM not found/i.test(output),
      `Liquid War displayed an obsolete OLE/DCOM warning\n${output.slice(-8000)}`);
    assert(fs.existsSync(framePath), 'Liquid War did not produce a menu frame');
    assert(fs.existsSync(gameplayPath), 'Liquid War did not produce a gameplay frame');

    const stats = imageStats(framePath);
    assert(stats.width === 640 && stats.height === 480,
      `Liquid War used an unexpected frame size: ${stats.width}x${stats.height}`);
    // Liquid War intentionally renders through an 8-bit paletted DirectDraw
    // surface, so a healthy textured menu has dozens rather than thousands of
    // distinct RGB values.
    assert(stats.nonBlack > 250000 && stats.colors > 40,
      `Liquid War menu stayed blank: ${JSON.stringify(stats)}`);
    const gameplay = imageStats(gameplayPath);
    assert(gameplay.width === 640 && gameplay.height === 480,
      `Liquid War gameplay used an unexpected frame size: ${gameplay.width}x${gameplay.height}`);
    assert(gameplay.colors > 100 && gameplay.red > 10000 && gameplay.yellow > 10000 &&
      gameplay.blue > 10000 && gameplay.white > 10000,
      `Liquid War gameplay frame does not look like a live arena: ${JSON.stringify(gameplay)}`);

    const logPath = path.join(vfsRoot, 'data', 'lwwin.log');
    assert(fs.existsSync(logPath), 'Liquid War did not write data/lwwin.log');
    const log = fs.readFileSync(logPath, 'utf8');
    for (const milestone of [
      'Loading data from "data\\lw.dat" - success!',
      'Loading custom textures from "custom\\texture" +++++ - success!',
      'Loading custom maps from "custom\\map" ++++ - success!',
      'Changing video mode to 640x480, fullscreen (driver="DirectDraw accel") - success!',
    ]) {
      assert(log.includes(milestone), `Liquid War missed startup milestone: ${milestone}`);
    }

    console.log(`PASS Liquid War menu: ${stats.width}x${stats.height}, ${stats.colors} colors`);
    console.log(`PASS Liquid War gameplay: ${gameplay.colors} colors, red=${gameplay.red}, yellow=${gameplay.yellow}`);
    console.log('PASS Liquid War assets: packed data, custom textures/maps, and DirectDraw mode loaded');
  } finally {
    if (process.env.KEEP_LIQUID_WAR_CANDIDATE_TMP === '1') {
      console.log(`kept candidate artifacts: ${temp}`);
    } else {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(`FAIL Liquid War candidate: ${error.stack || error.message}`);
  process.exit(1);
});
