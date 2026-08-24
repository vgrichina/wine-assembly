#!/usr/bin/env node
// Winamp visualization plug-in regression, headless.
//
// Two things have to work before a visualizer can draw anything, and they fail
// independently, so each gets its own case:
//
//   A. vis_w end-to-end. Preferences -> Plug-ins -> Visualization enumerates
//      C:\Plugins\*.DLL, LoadLibrary/GetProcAddress each candidate, and Start
//      hands the plug-in its own thread. wVis creates its window from that
//      worker and BitBlts frames into it. It paints only while Winamp is
//      actually playing, and only once Preferences is out of the way -- the
//      click order below is load-bearing: Start, Stop, Start, close prefs,
//      play. Starting playback first leaves the window black.
//
//   B. The second plug-in in the desktop config. LoadLibraryA resolves a guest
//      path against modules that are already loaded and never opens the VFS,
//      so a visualizer needs both an app-registry `dlls:` entry (or --dll-seed
//      on an ad-hoc run) and a c:\plugins mount. MilkDrop is the MMX one that
//      survives the enumeration walk; the case asserts its header is read from
//      the registry-loaded module AND that the walk continues to vis_w behind
//      it and still shows the page.
//
// Known gap, deliberately not asserted: vis_avs, vis_milk2 and vis_nsfs load
// and export winampVisGetHeader, but the enumerator never comes back from
// calling it, so the Visualization page is never shown. MilkDrop also refuses
// to render ("This plugin can't run without music") because its IsPlaying
// query is a cross-thread SendMessage from the plug-in's worker to the main
// window, which returns without running the target wndproc. Fixing either one
// turns into more cases here.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(ROOT, 'binaries', 'winamp.exe');
const MP3 = path.join(ROOT, 'binaries', 'demo.mp3');
const VIS_W = path.join(ROOT, 'binaries', 'plugins', 'candidates', 'vis_w.dll');
const VIS_MILK = path.join(ROOT, 'binaries', 'plugins', 'candidates', 'vis_milk.dll');
const OUT = path.join(ROOT, 'scratch');

for (const [p, what] of [[EXE, 'winamp.exe'], [MP3, 'demo.mp3'], [VIS_W, 'vis_w.dll'], [VIS_MILK, 'vis_milk.dll']]) {
  if (!fs.existsSync(p)) { console.log(`SKIP  ${what} missing`); process.exit(0); }
}
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
function check(ok, message) {
  if (ok) return true;
  failures.push(message);
  console.log(`  FAIL ${message}`);
  return false;
}

function run(args, timeoutMs) {
  console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));
  try {
    return execFileSync('node', args, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const out = (e.stdout || '').toString() + (e.stderr || '').toString();
    console.log(`(run.js exited non-zero status=${e.status ?? 'killed'} - output captured)`);
    return out;
  }
}

function assertNoCrash(out, label) {
  const bad = out.match(/UNIMPLEMENTED API:.*|RuntimeError:\s*unreachable|Thread \d+ crashed.*|FATAL:.*/);
  check(!bad, `${label}: run should not crash (${bad ? bad[0].trim() : ''})`);
}

// ---------------------------------------------------------------- case A

// Preferences opens at 0,0 and the player at 26,29, the same geometry the
// browser test drives. Plug-ins > Visualization (54,188) > the wWis row
// (170,73 -- MilkDrop sorts above it) > Start (184,323) > Stop (244,323) >
// Start > close Preferences (440,16) > play (66,129).
const shotA = path.join(OUT, 'winamp-vis-w.png');
try { fs.unlinkSync(shotA); } catch (_) {}

const outA = run([
  RUN,
  '--app=winamp',
  '--screen=756x480',
  '--max-batches=1850',
  '--batch-size=50000',
  '--trace-api=LoadLibraryA,GetProcAddress,CreateWindowExA,waveOutWrite',
  '--input=' + [
    '5:273:2',
    '80:post-cmd:40317',
    '360:click:54:188',
    '440:click:170:73',
    '520:click:184:323',
    '680:click:244:323',
    '840:click:184:323',
    '1000:click:440:16',
    '1080:click:66:129',
    `1800:png:${shotA}`,
  ].join(','),
], 240000);

console.log('case A: vis_w start/stop/start, then playback');
assertNoCrash(outA, 'vis_w');
check(/LoadLibraryA\(name="C:\\Plugins\\vis_w\.dll"\)/i.test(outA),
  'vis_w: the enumerator should LoadLibrary the plug-in from C:\\Plugins');
check(/GetProcAddress\(mod=h:0x[0-9a-f]+, name="winampVisGetHeader"\)/.test(outA),
  'vis_w: the enumerator should read winampVisGetHeader');
const wvisCreate = outA.match(/\[API T\d+\] CreateWindowExA\(exStyle=\d+, class="wVis", title="([^"]*)"/);
check(wvisCreate, 'vis_w: the plug-in should create its window from its own worker thread');
if (wvisCreate) {
  check(/^wVis Plug-in/.test(wvisCreate[1]),
    `vis_w: worker window should be the visualizer, got "${wvisCreate[1]}"`);
}
check((outA.match(/waveOutWrite/g) || []).length > 4,
  'vis_w: playback should be feeding the output plug-in');

// The visualizer window sits directly under the player: a green scope band
// over a yellow one, both on black. Count only pixels that could be those two
// bands -- bright green with little blue in them. The desktop teal behind the
// window, the grey of an un-closed Preferences and a black window that never
// painted are all excluded by the blue term, so this counts wVis output and
// nothing that would be there in its place.
if (check(fs.existsSync(shotA) && fs.statSync(shotA).size > 1000, 'vis_w: screenshot should be written')) {
  const png = PNG.sync.read(fs.readFileSync(shotA));
  const colors = new Set();
  let ink = 0;
  for (let y = 150; y < 256; y++) {
    for (let x = 30; x < 296; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      colors.add((r << 16) | (g << 8) | b);
      if (g > 120 && b < 100) ink++;
    }
  }
  check(ink > 300, `vis_w: visualizer should paint scope pixels, got ${ink}`);
  check(colors.size > 4, `vis_w: visualizer should paint more than a flat fill, got ${colors.size} colors`);
  console.log(`  vis_w painted ${ink} lit pixels in ${colors.size} colors`);
}

// ---------------------------------------------------------------- case B

const outB = run([
  RUN,
  '--app=winamp',
  '--screen=756x480',
  '--max-batches=560',
  '--batch-size=50000',
  '--trace-api=LoadLibraryA,GetProcAddress,ShowWindow,CreateDialogParamA',
  '--input=' + ['5:273:2', '80:post-cmd:40317', '360:click:54:188'].join(','),
], 180000);

console.log('case B: the second plug-in in the desktop config enumerates');
assertNoCrash(outB, 'vis_milk');
const milkLoad = outB.match(/LoadLibraryA\(name="C:\\Plugins\\vis_milk\.dll"\)[^\n]*\n\s*=> h:0x([0-9a-f]+)/i);
check(milkLoad, 'vis_milk: LoadLibrary should resolve the registry-loaded module, not a junk handle');
if (milkLoad) {
  const mod = milkLoad[1];
  check(parseInt(mod, 16) >= 0x400000 && parseInt(mod, 16) < 0x1000000,
    `vis_milk: module handle should be a loaded image base, got 0x${mod}`);
  check(new RegExp(`GetProcAddress\\(mod=h:0x0*${mod}, name="winampVisGetHeader"\\)`).test(outB),
    'vis_milk: the enumerator should read MilkDrop\'s header');
}
check((outB.match(/name="winampVisGetHeader"/g) || []).length >= 2,
  'vis_milk: the walk should continue past MilkDrop to the other plug-ins');
// 0xe0 is the Plug-ins > Visualization page template; the page is created
// hidden, positioned, and only then shown, so both halves are asserted.
check(/CreateDialogParamA\(0x[0-9a-f]+, 0x000000e0,/.test(outB),
  'vis_milk: selecting the tree node should create the Visualization page');
check((outB.match(/ShowWindow\(hwnd=hwnd:0x[0-9a-f]+, cmd=SW_SHOWNA\)/g) || []).length >= 2,
  'vis_milk: the new page should be shown, not left hidden behind the old one');

// ----------------------------------------------------------------

if (failures.length) {
  console.log(`\nFAIL  ${failures.length} check(s) failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS  Winamp visualizers: vis_w renders, MilkDrop enumerates');
