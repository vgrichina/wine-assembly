#!/usr/bin/env node
// Winamp web visualization regression.
//
// Drives the browser build through Preferences -> Plug-ins -> Visualization,
// starts wVis, closes Preferences, starts playback, right-clicks the visualizer,
// opens its Rendering Options submenu, and verifies the visualizer owns a
// visible, non-black backing canvas plus its worker-owned configuration popup.
// This covers the browser worker path that loads the visualizer DLL and paints
// via GDI/BitBlt.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(ROOT, 'tools', 'profile-winamp-web.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WINAMP = path.join(ROOT, 'binaries', 'winamp.exe');
const MP3 = path.join(ROOT, 'binaries', 'demo.mp3');
const VIS = path.join(ROOT, 'binaries', 'plugins', 'candidates', 'vis_w.dll');
const OUTDIR = path.join(ROOT, 'scratch');
const SHOT = path.join(OUTDIR, 'winamp-vis-web.png');

if (!fs.existsSync(CHROME)) { console.log('SKIP  Google Chrome not found'); process.exit(0); }
if (!fs.existsSync(WINAMP)) { console.log('SKIP  winamp.exe not found'); process.exit(0); }
if (!fs.existsSync(MP3)) { console.log('SKIP  demo.mp3 not found'); process.exit(0); }
if (!fs.existsSync(VIS)) { console.log('SKIP  vis_w.dll candidate not found'); process.exit(0); }

fs.mkdirSync(OUTDIR, { recursive: true });
try { fs.unlinkSync(SHOT); } catch (_) {}

const args = [
  PROFILE,
  '--dump-console',
  '--trace-api=waveOutWrite,LoadLibraryA,GetProcAddress,CreateWindowExA,CreateDIBSection,CreatePalette,SelectPalette,RealizePalette,UpdateColors,BitBlt',
  '--post-cmd=40317',
  '--post-wait-ms=3000',
  '--post-clicks=54,188;170,59;184,346;440,16;66,129;150,205,right;230,137',
  '--post-click-wait-ms=1200',
  '--screenshot', SHOT,
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

const r = spawnSync(process.execPath, args, {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 75000,
  maxBuffer: 64 * 1024 * 1024,
});

const out = (r.stdout || '') + (r.stderr || '');
if (r.error && r.error.code === 'ETIMEDOUT') {
  throw new Error('profile-winamp-web timed out\n' + out.slice(-4000));
}
assert.strictEqual(r.status, 0, 'profile-winamp-web should exit cleanly\n' + out.slice(-4000));

const jsonStart = out.indexOf('{');
assert(jsonStart >= 0, 'profile output should include JSON\n' + out.slice(-4000));
const result = JSON.parse(out.slice(jsonStart));

const windows = result.visibleWindows || [];
const eq = windows.find(w => w.title === 'Winamp Equalizer');
assert(eq, 'Winamp equalizer window should be visible');
assert(eq.back, 'Winamp equalizer should have a backing canvas');
assert(eq.back.sampledColors > 8, `Winamp equalizer should paint its skin, got ${eq.back.sampledColors} colors`);
assert(eq.back.sampledInk > 300, `Winamp equalizer should paint non-background pixels, got ${eq.back.sampledInk}`);

const wvis = windows.find(w => w.title === 'wVis Plug-in 2');
assert(wvis, 'wVis plug-in window should be visible');
assert(wvis.back, 'wVis plug-in window should have a backing canvas');
assert(wvis.back.sampledColors > 8, `wVis should paint non-trivial color content, got ${wvis.back.sampledColors}`);
assert(wvis.back.sampledInk > 300, `wVis should paint non-background pixels, got ${wvis.back.sampledInk}`);

const menuStates = result.menuStates || [];
const wvisMenu = menuStates.find(s => s.openHwnd === wvis.hwnd);
assert(wvisMenu,
  'right-click should open the wVis worker-owned popup menu');
assert((wvisMenu.labels || []).includes('Rendering Options'),
  'wVis popup should expose Rendering Options');
assert((wvisMenu.subLabels || []).length > 0,
  'Rendering Options should expose a usable submenu');
assert(!(result.inputQueue || []).some(e => e.hwnd === wvis.hwnd),
  'right-click should not leave an unconsumed wVis mouse event queued');

const events = result.consoleEvents || [];
const logText = events.map(e => e.text || '').join('\n');
assert(!/UNIMPLEMENTED API:|RuntimeError:\s*unreachable|Thread \d+ crashed|FATAL:/i.test(logText),
  'visualizer start should not crash\n' + logText.slice(-4000));
assert(/\[API T1\] BitBlt/.test(logText), 'visualizer worker should present frames via BitBlt');
assert(/\[API T4\] waveOutWrite/.test(logText), 'Winamp audio thread should write playback buffers');
assert(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 1000, 'debug screenshot should be written');

console.log(`PASS  Winamp web visualizer started and painted (${wvis.back.sampledColors} colors, ${wvis.back.sampledInk} ink samples)`);
