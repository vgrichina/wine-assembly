#!/usr/bin/env node
// Which build of a game should the launcher ship?
//
//   node tools/wep32-compare.js [--batches=2500] [--only=solitaire,bricks]
//
// Three of the games exist here twice: a 16-bit original in
// test/binaries/win98-16bit and a 32-bit one in test/binaries/entertainment-pack
// (which, despite the name, is entirely PE -- the Windows 95 Entertainment
// Pack, not the Windows 3.1 one). A dozen more titles exist only as community
// 32-bit rewrites in test/binaries/wep32-community. Deciding what goes on the
// desktop means running them and looking, and doing that by hand invites the
// answer to drift the moment anything changes.
//
// WHAT IT IS NOT: a reason to leave a 16-bit bug alone. A working community
// port says which binary is the better thing to ship today; it says nothing
// about whether the NE path is right, and the NE path is the one every other
// 16-bit app depends on.
//
// Each app is launched, given some batches to settle, and photographed. The
// verdict is from the transcript and the picture together:
//
//   CRASH     it trapped, or asked for an API that is not implemented
//   NOWINDOW  it never created a window
//   BLANK     a window, but nothing drawn in it worth calling a screen
//   OK        a window with a real picture in it
//
// PNGs and transcripts land in test/output/wep32-compare/ for looking at.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const { readPE } = require(path.join(__dirname, '..', 'lib', 'pe.js'));
const dllRegistry = require(path.join(__dirname, '..', 'lib', 'dll-registry.js'));

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const OUT = path.join(ROOT, 'test', 'output', 'wep32-compare');
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
// Three million steps, in batches big enough that the harness is not the cost.
// A quarter of that showed CWordZap as a blank grey window -- it had simply not
// finished starting, and the test that drives it uses two million.
const BATCHES = Number(arg('batches', 150));
const BATCH_SIZE = Number(arg('batch-size', 20000));
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);

// The games that exist here in both builds. `dlls` are the ones the app cannot
// find for itself: CARDS.DLL ships beside each build and the two are not
// interchangeable -- a 16-bit app needs the NE one.
const PAIRS = [
  {
    title: 'FreeCell',
    sixteen: { exe: 'test/binaries/win98-16bit/FREECELL.EXE' },
    thirty2: { exe: 'test/binaries/entertainment-pack/freecell.exe',
               dlls: ['test/binaries/entertainment-pack/cards.dll'] },
  },
  {
    title: 'Solitaire',
    sixteen: { exe: 'test/binaries/win98-16bit/SOL.EXE' },
    thirty2: { exe: 'test/binaries/entertainment-pack/sol.exe',
               dlls: ['test/binaries/entertainment-pack/cards.dll'] },
  },
  {
    title: 'Minesweeper',
    sixteen: { exe: 'test/binaries/win98-16bit/WINMINE.EXE' },
    thirty2: { exe: 'test/binaries/entertainment-pack/winmine.exe' },
  },
  // Hearts has no 32-bit twin here at all, and is the one title whose
  // networking works, so it is listed to keep the picture honest.
  {
    title: 'Hearts',
    sixteen: { exe: 'test/binaries/win98-16bit/MSHEARTS.EXE' },
    thirty2: null,
  },
];

// What the launcher does with each of these today, read from the registry
// rather than restated here: an app can be fully wired in `apps` and still be
// missing from the desktop, which is exactly the state this sweep is meant to
// find. Returns exe path -> 'desktop' | 'listed' | undefined.
function launcherPlacement() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'apps.js'), 'utf8');
  const byKey = new Map();
  for (const m of src.matchAll(/(\w+):\s*\{[^}]*?exe:\s*'([^']+)'/gs)) {
    byKey.set(m[1], m[2].replace(/^binaries\//, 'test/binaries/'));
  }
  const desktop = new Set();
  // The desktop list has been called both things; match either rather than
  // silently reporting every app as merely "listed".
  const list = src.match(/(?:DESKTOP_APPS|DEFAULT_APPS)\s*=\s*\[([\s\S]*?)\n\s*\];/);
  if (list) for (const m of list[1].matchAll(/\['(\w+)'/g)) desktop.add(m[1]);
  const out = new Map();
  for (const [key, exe] of byKey) {
    out.set(exe, { key, placement: desktop.has(key) ? 'desktop' : 'listed' });
  }
  return out;
}

function communityApps() {
  const base = path.join(ROOT, 'test', 'binaries', 'wep32-community');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const dir of fs.readdirSync(base).sort()) {
    const full = path.join(base, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full).sort()) {
      if (!/\.exe$/i.test(f)) continue;
      out.push({ title: `${dir}/${path.basename(f, path.extname(f))}`,
                 exe: path.relative(ROOT, path.join(full, f)) });
    }
  }
  return out;
}

// How much of the screen is the app's own drawing. Three things have to be
// discounted or every empty window scores as a picture: the desktop teal
// behind it, the 3D face grey a window starts as, and the caption gradient --
// which alone is a couple of hundred distinct blues, so counting colours
// without excluding it rated an empty Tetravex window as content-rich.
//
// The 3% line below is calibrated against looking at all twenty pictures:
// Minesweeper's small board is 4.6% and is the smallest real screen here,
// while an empty Winarc window is 1.9% and an empty Tetravex 0.7%.
function look(pngPath) {
  if (!fs.existsSync(pngPath)) return null;
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const seen = new Set();
  let content = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const key = (r << 16) | (g << 8) | b;
    if (key === 0x008080 || key === 0xc0c0c0) continue;   // desktop, window face
    if (b > g + 20 && b > r + 20) continue;               // caption gradient
    content++;
    seen.add(key);
  }
  return { colors: seen.size, content: content / (png.width * png.height),
           w: png.width, h: png.height };
}

// Which of an app's imported DLLs the emulator has no copy of. A PE that names
// a runtime nobody can supply does not fail because of anything in the guest
// code, and reporting that as a crash sends the next person reading this table
// off to debug the wrong thing entirely.
function missingRuntime(exeRel) {
  let pe;
  try { pe = readPE(path.join(ROOT, exeRel)); } catch (_) { return null; }
  const dir = path.dirname(path.join(ROOT, exeRel));
  const missing = [];
  for (const name of importedDlls(pe)) {
    const lower = name.toLowerCase();
    if (BUILTIN_DLLS.has(lower.replace(/\.dll$/, ''))) continue;
    if (dllRegistry.isLoadableDll && dllRegistry.isLoadableDll(lower)) continue;
    if (fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, lower))) continue;
    if (fs.existsSync(path.join(ROOT, 'test', 'binaries', 'dlls', lower))) continue;
    missing.push(name);
  }
  return missing.length ? missing : null;
}

// The ones the emulator implements itself rather than loading.
const BUILTIN_DLLS = new Set(['kernel32', 'user32', 'gdi32', 'advapi32', 'shell32',
  'comdlg32', 'winmm', 'ole32', 'oleaut32', 'version', 'wsock32', 'ws2_32',
  'winspool.drv', 'winspool', 'ddraw', 'dsound', 'dinput', 'rpcrt4', 'shlwapi',
  'comctl32', 'msvcrt', 'imm32', 'lz32', 'mpr', 'netapi32', 'secur32']);

function importedDlls(pe) {
  const names = [];
  // Data directory 1 is the import table: optional header at peOff+24, its
  // directories 96 bytes in for a PE32, eight bytes each.
  const peOff = pe.buf.readUInt32LE(0x3c);
  const magic = pe.buf.readUInt16LE(peOff + 24);
  const dirs = peOff + 24 + (magic === 0x20b ? 112 : 96);
  const rva = pe.buf.readUInt32LE(dirs + 8);
  if (!rva) return names;
  for (let i = 0; i < 64; i++) {
    const off = pe.va2off(pe.imageBase + rva + i * 20);
    if (off < 0) break;
    const nameRva = pe.buf.readUInt32LE(off + 12);
    if (!nameRva) break;
    const nameOff = pe.va2off(pe.imageBase + nameRva);
    if (nameOff < 0) break;
    let end = nameOff;
    while (end < pe.buf.length && pe.buf[end]) end++;
    names.push(pe.buf.slice(nameOff, end).toString('latin1'));
  }
  return names;
}

function run(name, app) {
  const png = path.join(OUT, `${name}.png`);
  const log = path.join(OUT, `${name}.log`);
  try { fs.unlinkSync(png); } catch (_) {}
  // Run what the desktop runs. Several of these need a DLL beside them or a
  // level file in the VFS, and lib/apps.js is where that is written down --
  // launching the bare exe measures the harness, not the app. Rodent2000 and
  // JigSawedME both trapped at their entry point until this used --app.
  const args = [RUN, '--no-close',
    `--batch-size=${BATCH_SIZE}`, `--max-batches=${BATCHES}`, `--png=${png}`,
    '--quiet-api', '--quiet-blocks', '--repaint-every=100'];
  if (app.key) args.push(`--app=${app.key}`);
  else {
    args.push(`--exe=${path.join(ROOT, app.exe)}`);
    if (app.dlls) args.push(`--dlls=${app.dlls.map(d => path.join(ROOT, d)).join(',')}`);
  }
  let out = '';
  let status = 0;
  try {
    out = execFileSync('node', args, { encoding: 'utf8', timeout: 300000,
      maxBuffer: 64 * 1024 * 1024, cwd: ROOT });
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''));
    status = e.status == null ? 'timeout' : e.status;
  }
  fs.writeFileSync(log, out);

  const crashed = /\*\*\* CRASH|UNIMPLEMENTED API/.test(out);
  const windows = (out.match(/^\[CreateWindow\]/gm) || []).length;
  const box = (out.match(/^\[MessageBox\] (.*)$/m) || [])[1];
  const shot = look(png);
  // The picture decides, not the window count: several of these open their
  // game window through a path that logs nothing, and an app sitting on its
  // own splash box has drawn a real screen -- it is just waiting to be told to
  // go on, which is what the launcher's startup-dialog dismissal is for.
  const absent = crashed ? missingRuntime(app.exe) : null;
  // An app that puts up its own error box has told us exactly what is wrong,
  // and that is a different answer from "it drew nothing": Pawn wants DirectX 9
  // and says so, on top of a window that would otherwise score as a screen.
  const errorBox = box && /error|requires|cannot|unable|failed|not found/i.test(box);
  let verdict = 'OK';
  if (absent) verdict = 'NORUNTIME';
  else if (crashed) verdict = 'CRASH';
  else if (errorBox) verdict = 'ERRORBOX';
  else if (!shot || shot.content < 0.03) {
    verdict = box ? 'SPLASH' : (windows ? 'BLANK' : 'NOWINDOW');
  } else if (box && !windows) verdict = 'SPLASH';
  const note = absent
    ? `needs ${absent.join(', ')}, which is not in the tree`
    : crashed
    ? (out.match(/UNIMPLEMENTED API: (\w+)/) || [, 'trapped'])[1]
    : (verdict === 'SPLASH' || verdict === 'ERRORBOX')
      ? (box || '').replace(/\s+/g, ' ').slice(0, 56)
      : `${windows} window(s), ${shot ? `${(shot.content * 100).toFixed(0)}% drawn` : 'no png'}`;
  return { verdict, note, status };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  const want = t => !ONLY.length || ONLY.some(o => t.toLowerCase().includes(o.toLowerCase()));

  for (const pair of PAIRS) {
    if (!want(pair.title)) continue;
    const row = { title: pair.title };
    for (const [key, app] of [['sixteen', pair.sixteen], ['thirty2', pair.thirty2]]) {
      if (!app || !fs.existsSync(path.join(ROOT, app.exe))) { row[key] = null; continue; }
      const name = `${pair.title.toLowerCase()}-${key === 'sixteen' ? '16' : '32'}`;
      process.stdout.write(`  running ${name} ...`);
      row[key] = run(name, app);
      console.log(` ${row[key].verdict}`);
    }
    rows.push(row);
  }

  const where = launcherPlacement();
  const community = [];
  for (const app of communityApps()) {
    if (!want(app.title)) continue;
    const name = app.title.replace(/[^\w.-]+/g, '-');
    const known = where.get(app.exe);
    process.stdout.write(`  running ${name}${known ? ` (--app=${known.key})` : ''} ...`);
    const r = run(name, { ...app, key: known && known.key });
    console.log(` ${r.verdict}`);
    community.push({ ...app, ...r });
  }

  console.log('\nBoth builds present:');
  console.log(`  ${'title'.padEnd(14)} ${'16-bit'.padEnd(10)} ${'32-bit'.padEnd(10)} note`);
  for (const r of rows) {
    const a = r.sixteen ? r.sixteen.verdict : '-';
    const b = r.thirty2 ? r.thirty2.verdict : 'none here';
    const advice = !r.thirty2 ? '16-bit is the only build'
      : a === 'OK' && b === 'OK' ? 'either runs; ship the 32-bit one and keep the NE path tested'
      : a === 'OK' ? 'only the 16-bit build works'
      : b === 'OK' ? 'ship the 32-bit build'
      : 'neither build works';
    console.log(`  ${r.title.padEnd(14)} ${a.padEnd(10)} ${b.padEnd(10)} ${advice}`);
  }

  if (community.length) {
    const placeOf = c => (where.get(c.exe) || {}).placement || 'NOT IN THE LAUNCHER';
    console.log('\nCommunity 32-bit ports:');
    for (const c of community) {
      console.log(`  ${c.verdict.padEnd(9)} ${c.title.padEnd(26)} ${placeOf(c).padEnd(20)} ${c.note}`);
    }
    const runs = community.filter(c => c.verdict === 'OK' || c.verdict === 'SPLASH');
    console.log(`\n  ${runs.length}/${community.length} reach a screen`);
    // The two lists worth acting on, and the only reason this prints a table
    // rather than a number.
    const missing = runs.filter(c => placeOf(c) !== 'desktop');
    const broken = community.filter(c => c.verdict !== 'OK' && c.verdict !== 'SPLASH'
      && placeOf(c) === 'desktop');
    if (missing.length) {
      console.log('\n  Reaches a screen but is not on the desktop:');
      for (const c of missing) console.log(`    ${c.title} (${placeOf(c)})`);
    }
    if (broken.length) {
      console.log('\n  On the desktop and not reaching a screen:');
      for (const c of broken) console.log(`    ${c.title} -- ${c.verdict}, ${c.note}`);
    }
  }
  console.log(`\nPictures and transcripts: ${path.relative(ROOT, OUT)}`);
}

main();
