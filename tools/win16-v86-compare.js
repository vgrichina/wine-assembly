#!/usr/bin/env node
'use strict';

// Capture every registered Win16 application twice: once in the pinned native
// Windows 98 v86 reference and once in wine-assembly.  This is deliberately a
// visual audit driver, not a pixel-equality test.  Native Win98 runs at 4-bit
// VGA and app RNG/timers differ, so the generated pairs and contact sheet must
// still be inspected by a person.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { APPS } = require('../lib/apps');
const { win16ModuleNames } = require('../lib/dll-loader');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, 'tools', 'v86-reference', 'win16-apps.json');
const CAPTURE = path.join(ROOT, 'tools', 'v86-reference', 'capture.js');
const RUN = path.join(ROOT, 'test', 'run.js');
const DEFAULT_OUT = path.join(ROOT, 'test', 'output', 'win16-v86-comparison');

function usage() {
  console.log(`Usage: node tools/win16-v86-compare.js [options]

Options:
  --only=id,id       Capture only selected app ids
  --out=PATH         Output directory (default: test/output/win16-v86-comparison)
  --native-only      Skip wine-assembly captures
  --local-only       Skip native v86 captures
  --reuse            Keep existing screenshots instead of recapturing them
  --report-only      Rebuild report/contact sheet without running either side
  --online           Allow the v86 harness to fetch its documented Win98 assets
  --headed           Show v86's Chromium window
  --list             List the 33 comparison profiles
  --help             Show this help`);
}

function parseArgs(argv) {
  const options = { only: [], out: DEFAULT_OUT };
  for (const arg of argv) {
    if (arg.startsWith('--only=')) options.only = arg.slice(7).split(',').filter(Boolean);
    else if (arg.startsWith('--out=')) options.out = path.resolve(arg.slice(6));
    else if (arg === '--native-only') options.nativeOnly = true;
    else if (arg === '--local-only') options.localOnly = true;
    else if (arg === '--reuse') options.reuse = true;
    else if (arg === '--report-only') options.reportOnly = true;
    else if (arg === '--online') options.online = true;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.nativeOnly && options.localOnly) throw new Error('--native-only and --local-only conflict');
  return options;
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function resolveSibling(directory, requested) {
  const names = fs.readdirSync(directory);
  const normalized = String(requested).replace(/\.(dll|exe|drv|vbx|iw)$/i, '');
  const candidates = [requested, `${requested}.DLL`, `${requested}.EXE`,
    `${requested}.DRV`, `${requested}.VBX`, `${requested}.IW`];
  for (const candidate of candidates) {
    const match = names.find(name => name.toLowerCase() === candidate.toLowerCase());
    if (match && fs.statSync(path.join(directory, match)).isFile()) return path.join(directory, match);
  }
  const byStem = names.find(name => path.basename(name, path.extname(name)).toLowerCase() === normalized.toLowerCase());
  return byStem && fs.statSync(path.join(directory, byStem)).isFile()
    ? path.join(directory, byStem) : null;
}

function nativePayload(app, payloadDir) {
  const files = new Set([path.join(payloadDir, app.exe)]);
  const registry = APPS[app.id];
  if (!registry) throw new Error(`${app.id}: not present in lib/apps.js`);

  for (const value of registry.files || []) {
    const source = typeof value === 'string' ? value : value.url;
    if (!source) continue;
    const filename = path.resolve(ROOT, source.replace(/^binaries\//, 'test/binaries/'));
    if (fs.existsSync(filename)) files.add(filename);
  }
  for (const name of [...(registry.win16Modules || []), ...(app.extraFiles || [])]) {
    const filename = resolveSibling(payloadDir, name);
    if (filename) files.add(filename);
  }
  for (const extension of app.includeExtensions || []) {
    for (const name of fs.readdirSync(payloadDir)) {
      if (path.extname(name).toLowerCase() === extension.toLowerCase()) files.add(path.join(payloadDir, name));
    }
  }

  // Include recursively imported application DLLs. System modules such as
  // KERNEL/USER/GDI have no sibling file and are supplied by native Win98.
  const scanned = new Set();
  for (;;) {
    const next = [...files].find(filename => !scanned.has(filename));
    if (!next) break;
    scanned.add(next);
    const bytes = fs.readFileSync(next);
    for (const moduleName of win16ModuleNames(bytes)) {
      const dependency = resolveSibling(payloadDir, moduleName);
      if (dependency) files.add(dependency);
    }
  }
  return [...files].sort().map(filename => path.relative(ROOT, filename));
}

function nativeManifestEntry(app) {
  const payloadDir = path.resolve(ROOT, app.payloadDir);
  if (!fs.existsSync(path.join(payloadDir, app.exe))) {
    throw new Error(`${app.id}: executable is missing from ${app.payloadDir}: ${app.exe}`);
  }
  return {
    title: app.title,
    launch: `D:\\${app.exe}`,
    waitMs: app.nativeWaitMs || 8000,
    ...(app.nativePostLaunch ? { postLaunch: app.nativePostLaunch } : {}),
    files: nativePayload(app, payloadDir),
  };
}

function createNativeManifest(app, outDir) {
  const manifest = {
    schemaVersion: 1,
    apps: { [app.id]: nativeManifestEntry(app) },
  };
  const filename = path.join(outDir, 'manifests', `${app.id}.json`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  return filename;
}

function createNativeBatchManifest(apps, outDir, sequence) {
  const manifest = { schemaVersion: 1, apps: {} };
  for (const app of apps) manifest.apps[app.id] = nativeManifestEntry(app);
  const filename = path.join(outDir, 'manifests', `batch-${sequence}.json`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  return filename;
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  console.log(`\n$ ${printable}`);
  const result = childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout || 300000,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error && !options.allowFailure) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(`${printable} exited ${result.status}${detail}`);
  }
  return result;
}

function captureNative(app, outDir, options) {
  const screenshot = path.join(outDir, app.id, 'native.png');
  const metadata = path.join(outDir, app.id, 'native.json');
  if (options.reuse && fs.existsSync(screenshot)) return;
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  const manifest = createNativeManifest(app, outDir);
  const args = [CAPTURE, '--app', app.id, '--manifest', manifest,
    '--output', screenshot, '--metadata', metadata,
    '--wait-ms', String(app.nativeWaitMs || 8000)];
  if (options.online) args.push('--online');
  if (options.headed) args.push('--headed');
  run(process.execPath, args, { timeout: 360000 });
}

function captureNativeBatches(apps, outDir, options) {
  const pending = apps.filter(app => !(options.reuse &&
    fs.existsSync(path.join(outDir, app.id, 'native.png'))));
  const errors = new Map();
  const chunkSize = 8;
  for (let offset = 0; offset < pending.length; offset += chunkSize) {
    const chunk = pending.slice(offset, offset + chunkSize);
    if (chunk.length === 1) {
      try { captureNative(chunk[0], outDir, options); }
      catch (error) { errors.set(chunk[0].id, error.stack || String(error)); }
      continue;
    }
    const sequence = Math.floor(offset / chunkSize) + 1;
    const manifest = createNativeBatchManifest(chunk, outDir, sequence);
    const args = [CAPTURE, '--apps', chunk.map(app => app.id).join(','),
      '--manifest', manifest, '--output-dir', outDir];
    if (options.online) args.push('--online');
    if (options.headed) args.push('--headed');
    try { run(process.execPath, args, { timeout: 900000 }); }
    catch (error) {
      const detail = error.stack || String(error);
      for (const app of chunk) {
        if (!fs.existsSync(path.join(outDir, app.id, 'native.png'))) errors.set(app.id, detail);
      }
    }
  }
  return errors;
}

function captureLocal(app, outDir, options) {
  const screenshot = path.join(outDir, app.id, 'wine-assembly.png');
  const log = path.join(outDir, app.id, 'wine-assembly.log');
  if (options.reuse && fs.existsSync(screenshot) && fs.existsSync(log)) return;
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  const batches = app.localBatches || 240;
  const args = [RUN, `--app=${app.id}`, '--no-close', '--batch-size=20000',
    `--max-batches=${batches}`, '--quiet-api', '--quiet-blocks',
    '--repaint-every=100'];
  if (app.localInput) {
    args.push(`--input=${app.localInput},${batches - 30}:png:${screenshot},${batches - 20}:stop`);
  } else {
    args.push(`--png=${screenshot}`);
  }
  const result = run(process.execPath, args, {
    capture: true,
    allowFailure: true,
    timeout: app.localTimeoutMs || 300000,
  });
  fs.writeFileSync(log, `${result.stdout || ''}${result.stderr || ''}`);
  if (result.error) throw result.error;
  if (!fs.existsSync(screenshot)) throw new Error(`${app.id}: local run produced no screenshot`);
}

function imageSummary(filename) {
  if (!fs.existsSync(filename)) return null;
  const png = PNG.sync.read(fs.readFileSync(filename));
  const colors = new Set();
  let teal = 0;
  let gray = 0;
  let nonBackground = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (r === 0 && g === 128 && b === 128) teal++;
    if (r === 192 && g === 192 && b === 192) gray++;
    if (!(r === 0 && g === 128 && b === 128)) nonBackground++;
  }
  return {
    width: png.width,
    height: png.height,
    colors: colors.size,
    tealPixels: teal,
    faceGrayPixels: gray,
    nonBackgroundPixels: nonBackground,
    sha256: sha256File(filename),
  };
}

function logSummary(filename) {
  if (!fs.existsSync(filename)) return null;
  const text = fs.readFileSync(filename, 'utf8');
  const crash = text.match(/\*\*\* CRASH[^\n]*|UNIMPLEMENTED API[^\n]*|RuntimeError[^\n]*|Unreachable code[^\n]*/i);
  return {
    crashed: !!crash,
    crash: crash ? crash[0] : null,
    windows: (text.match(/^\[CreateWindowEx/gm) || []).length,
    dialogs: (text.match(/^\[CreateDialog/gm) || []).length,
  };
}

function makePair(app, outDir) {
  const native = path.join(outDir, app.id, 'native.png');
  const local = path.join(outDir, app.id, 'wine-assembly.png');
  const pair = path.join(outDir, app.id, 'side-by-side.png');
  if (!fs.existsSync(native) || !fs.existsSync(local)) return null;
  const magick = childProcess.spawnSync('which', ['magick'], { encoding: 'utf8' });
  if (magick.status !== 0) return null;
  run(magick.stdout.trim(), [native, local, '+append', pair]);
  return pair;
}

function makeContactSheet(apps, outDir) {
  const pairs = apps.map(app => {
    const current = path.join(outDir, app.id, 'side-by-side.png');
    const lastKnown = path.join(outDir, app.id, 'last-known-side-by-side.png');
    return fs.existsSync(current) ? current : lastKnown;
  }).filter(filename => fs.existsSync(filename));
  if (!pairs.length) return null;
  const magick = childProcess.spawnSync('which', ['magick'], { encoding: 'utf8' });
  if (magick.status !== 0) return null;
  const output = path.join(outDir, 'contact-sheet.png');
  run(magick.stdout.trim(), ['montage', ...pairs, '-thumbnail', '640x240',
    '-set', 'label', '%d', '-tile', '2x', '-geometry', '+8+24',
    '-background', '#202020', '-fill', 'white', output]);
  return output;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const profile = JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
  let apps = profile.apps;
  if (options.list) {
    for (const app of apps) console.log(`${app.id.padEnd(20)} ${app.title}`);
    return;
  }
  if (options.only.length) {
    const wanted = new Set(options.only);
    apps = apps.filter(app => wanted.has(app.id));
    const missing = options.only.filter(id => !apps.some(app => app.id === id));
    if (missing.length) throw new Error(`unknown app ids: ${missing.join(', ')}`);
  }
  fs.mkdirSync(options.out, { recursive: true });

  const nativeErrors = options.localOnly || options.reportOnly ? new Map()
    : captureNativeBatches(apps, options.out, options);

  const rows = [];
  for (const app of apps) {
    console.log(`\n=== ${app.id}: ${app.title} ===`);
    let nativeError = nativeErrors.get(app.id) || null;
    let localError = null;
    if (!options.nativeOnly && !options.reportOnly) {
      try { captureLocal(app, options.out, options); }
      catch (error) { localError = error.stack || String(error); console.error(localError); }
    }
    const native = path.join(options.out, app.id, 'native.png');
    const local = path.join(options.out, app.id, 'wine-assembly.png');
    if (!nativeError && !fs.existsSync(native)) {
      nativeError = `${app.id}: no current native screenshot`;
    }
    if (!localError && !options.nativeOnly && !fs.existsSync(local)) {
      localError = `${app.id}: no current wine-assembly screenshot`;
    }
    rows.push({
      id: app.id,
      title: app.title,
      nativeError,
      localError,
      native: imageSummary(native),
      local: imageSummary(local),
      localRun: logSummary(path.join(options.out, app.id, 'wine-assembly.log')),
      pair: makePair(app, options.out),
      lastKnownPair: fs.existsSync(path.join(options.out, app.id, 'last-known-side-by-side.png'))
        ? path.join(options.out, app.id, 'last-known-side-by-side.png') : null,
    });
  }
  const contactSheet = makeContactSheet(apps, options.out);
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    note: 'Pixel equality is not expected: native Win98 uses 4-bit VGA and games use independent RNG/timers. Review each side-by-side image.',
    profile: path.relative(ROOT, PROFILE),
    contactSheet: contactSheet && path.relative(ROOT, contactSheet),
    apps: rows,
  };
  const reportPath = path.join(options.out, 'report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${reportPath}`);
  if (contactSheet) console.log(`Contact sheet: ${contactSheet}`);
  if (rows.some(row => row.nativeError || row.localError || row.localRun?.crashed)) process.exitCode = 1;
}

main();
