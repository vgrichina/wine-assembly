#!/usr/bin/env node
// Regression for the Win98 Font Viewer startup/preview path. This fixture is
// optional because the stock Windows support files are intentionally ignored.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'fontview.exe');
const FONT = path.join(__dirname, 'binaries', 'win98-apps', 'vgasys.fon');
const CRT = path.join(__dirname, 'binaries', 'dlls', 'msvcrt20.dll');
const MFC = path.join(__dirname, 'binaries', 'dlls', 'mfc30.dll');
const PNG_PATH = path.join(ROOT, 'scratch', 'fontview.png');
const FONT_WAT_SOURCE = fs.readFileSync(path.join(ROOT, 'src', '10b-gdi-font.wat'), 'utf8');
const HOST_IMPORT_SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'host-imports.js'), 'utf8');

const missing = [EXE, FONT, CRT, MFC].filter(file => !fs.existsSync(file));
if (missing.length) {
  console.log(`SKIP  Font Viewer fixture missing: ${missing.map(path.basename).join(', ')}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(PNG_PATH), { recursive: true });
try { fs.unlinkSync(PNG_PATH); } catch (_) {}

const args = [
  RUN,
  `--exe=${EXE}`,
  '--args=vgasys.fon',
  `--input=12:dump-windows:fontview,13:png:${PNG_PATH},20:click:45:43`,
  '--max-batches=30',
  '--batch-size=5000',
  '--no-close',
  '--quiet-api',
  '--quiet-blocks',
  '--trace-api-counts',
  '--api-counts-top=200',
];
console.log('$ node', args.map(arg => arg.replace(ROOT, '.')).join(' '));

let output = '';
let exitCode = 0;
try {
  output = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  output = String(error.stdout || '') + String(error.stderr || '');
  exitCode = error.status ?? 1;
}

function apiCount(name) {
  const match = output.match(new RegExp(`^\\s+(\\d+)\\s+${name}$`, 'm'));
  return match ? Number(match[1]) : 0;
}

const mainLine = output.split('\n').find(line =>
  line.includes('[input] window:fontview hwnd=65537')) || '';
const childLine = output.split('\n').find(line =>
  line.includes('window:fontview') && line.includes('class="AfxWnd"')) || '';
const childSize = childLine.match(/size=(\d+)x(\d+)/);
const png = fs.existsSync(PNG_PATH) ? PNG.sync.read(fs.readFileSync(PNG_PATH)) : null;
let darkPixels = 0;
if (png) {
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] < 70 && png.data[i + 1] < 70 && png.data[i + 2] < 70) darkPixels++;
  }
}

const checks = [
  ['run.js exited cleanly', exitCode === 0],
  ['auto-loaded MSVCRT20 before MFC30',
    output.indexOf('DLL: msvcrt20.dll') >= 0 &&
      output.indexOf('DLL: msvcrt20.dll') < output.indexOf('DLL: mfc30.dll')],
  ['font resource was accepted', apiCount('AddFontResourceA') >= 1],
  ['FNT parsing and glyph rasterization are WAT-owned',
    FONT_WAT_SOURCE.includes('(func $gdi_bitmap_font_parse_file') &&
      FONT_WAT_SOURCE.includes('(func $gdi_bitmap_text_out') &&
      !/_parseFntStrike|_drawBitmapGlyph|bitmapFont/.test(HOST_IMPORT_SOURCE)],
  ['MFC attached both dialog and preview window procedures', apiCount('SetWindowLongA') >= 2],
  ['preview paints all sample rows', apiCount('TextOutA') >= 10],
  ['main window uses the font name as its title', mainLine.includes('title="System"')],
  ['preview child kept a nonzero layout', !!childSize && +childSize[1] > 300 && +childSize[2] > 250],
  ['rendered screenshot contains preview glyphs', !!png && darkPixels > 250],
  ['Done runs the application cleanup handler and exits',
    apiCount('RemoveFontResourceA') >= 1 && apiCount('PostQuitMessage') >= 1 &&
      /\[input\] click 45,43/.test(output) && /\[Exit\] code=0/.test(output)],
  ['no invalid-font dialog or emulator crash',
    !/not a valid font file|crash_unimplemented|fatal:/i.test(output)],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
console.log(`metrics: AddFontResourceA=${apiCount('AddFontResourceA')} ` +
  `SetWindowLongA=${apiCount('SetWindowLongA')} TextOutA=${apiCount('TextOutA')} ` +
  `darkPixels=${darkPixels}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
