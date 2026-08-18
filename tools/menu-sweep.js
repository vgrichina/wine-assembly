#!/usr/bin/env node
// Exercise every item in an app's menus and report what each one did.
//
// "The app launches and draws its window" is where test-all-exes stops, and it
// is a long way from "the app works". Everything an app can actually do it
// does from its menus, and nothing was pulling those levers -- an app can sit
// at PASS with every one of its dialogs failing to open.
//
// The work list comes from the app's own resources, so there is nothing to
// keep in sync by hand: RT_MENU gives every command id and its label, and the
// labels give the expectations. Windows spells a command that opens a dialog
// with a trailing ellipsis -- "Open...", "Options...", "About..." -- so an
// item that ends in "..." and opens no window has not done its job, and that
// is a per-item verdict this tool can reach without anybody writing down what
// each menu of each app is supposed to do.
//
// Two passes. The first drives the whole menu in one process, which is fast
// but not trustworthy on its own: commands change what the app is, and an item
// that opened nothing may have been posted to an app sitting in print preview
// or behind a modal dialog that would not close. So every item the first pass
// accuses is re-run in a process of its own, against a freshly launched app,
// and only a verdict that survives that is reported.
//
// Usage:
//   node tools/menu-sweep.js <exe> [--json=out.json] [--settle=N] [--gap=N]
//   node tools/menu-sweep.js <exe> --verbose        # keep run.js output
//   node tools/menu-sweep.js <exe> --list           # just print the menu tree
//   node tools/menu-sweep.js <exe> --no-confirm     # first pass only, fast
//
// Verdicts per item:
//   CRASH    an unimplemented API, a WASM trap, or a stuck emulator followed
//   NODLG    label promises a dialog ("...") and no window appeared
//   ERRBOX   a window opened, but it is an error/warning box: the app refused
//   dialog   a new window appeared
//   ok       command accepted, nothing new on screen (Copy, Paste, a toggle)
//   skipped  Exit/Close and other ids that end the app or the sweep
//
// Exit code is nonzero when any item is CRASH, NODLG or ERRBOX.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');

const argv = process.argv.slice(2);
const flag = name => argv.includes('--' + name);
const opt = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const exe = argv.find(a => !a.startsWith('--'));

if (!exe) {
  console.error('usage: node tools/menu-sweep.js <exe> [--json=out.json] [--settle=N] [--gap=N] [--list] [--verbose] [--no-confirm]');
  process.exit(2);
}
if (!fs.existsSync(exe)) {
  console.error(`no such file: ${exe}`);
  process.exit(2);
}

let SETTLE = parseInt(opt('settle', '1200'), 10);
const GAP = parseInt(opt('gap', '800'), 10);
const VERBOSE = flag('verbose');
const CONFIRM = !flag('no-confirm');
const TIMEOUT = parseInt(opt('timeout', '300'), 10) * 1000;

// Command ids the sweep must not send. 0xF000+ is the system-command range
// (SC_CLOSE and friends); 57665 is the MFC/AppWizard id for File > Exit, which
// every Microsoft-toolchain app of this era uses. An app is free to give Exit
// any id it likes -- Notepad uses 28 -- so the label has to be read too.
// Sending either ends the app and every later item reports against a corpse.
const TERMINAL_IDS = new Set([57665]);
const TERMINAL_LABEL = /^(e&?xit|close|quit)\b/i;
const isTerminal = it => it.id >= 0xF000 || TERMINAL_IDS.has(it.id) ||
  TERMINAL_LABEL.test(it.label.trim());

// parse-rsrc.js walks a PE resource tree, which a 16-bit NE does not have --
// its resources are a flat type/NAMEINFO list in the NE header. ne-dump.js
// reads that and decodes RT_MENU into the same shape, so the sweep itself does
// not care which kind of executable it was handed.
function readMenus(exePath) {
  const tmp = path.join(os.tmpdir(), `menu-sweep-${process.pid}.json`);
  const attempt = args => {
    try {
      execFileSync('node', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      return JSON.parse(fs.readFileSync(tmp, 'utf8')).menus || {};
    } catch (e) {
      return {};
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  };
  const pe = attempt([path.join(__dirname, 'parse-rsrc.js'), exePath, `--out=${tmp}`]);
  if (Object.keys(pe).length) return pe;
  return attempt([path.join(__dirname, 'ne-dump.js'), exePath, `--menus-json=${tmp}`]);
}

// Flatten to leaves, keeping the path so a report can say File > Page Setup...
function collect(items, trail, out) {
  for (const item of items || []) {
    if (!item || item.text == null) continue;            // separator
    // A label carries its accelerator after a tab -- "Select Game...\tF3" --
    // and the ellipsis that says "this opens a dialog" is on the label, not on
    // the whole string.
    const label = String(item.text).split('\t')[0].replace(/&/g, '').trim();
    const here = trail.concat(label);
    if (item.children && item.children.length) {
      collect(item.children, here, out);
    } else if (item.id != null) {
      out.push({ id: item.id | 0, label, path: here.join(' > ') });
    }
  }
  return out;
}

const menus = readMenus(exe);
const items = [];
const seen = new Set();
for (const key of Object.keys(menus)) {
  for (const leaf of collect(menus[key], [], [])) {
    // The same command often appears in a menu bar and in a context menu.
    // Exercising it twice tells you nothing new and doubles the run.
    if (seen.has(leaf.id)) continue;
    seen.add(leaf.id);
    items.push(leaf);
  }
}

if (flag('list')) {
  for (const it of items) console.log(`${String(it.id).padStart(6)}  ${it.path}`);
  process.exit(0);
}

const name = path.basename(exe);
if (!items.length) {
  console.log(`SKIP  ${name}: no menu resources`);
  if (opt('json', null)) {
    fs.writeFileSync(opt('json'), JSON.stringify({ exe, items: [], skipped: 'no menu resources' }, null, 2));
  }
  process.exit(0);
}

const live = items.filter(it => !isTerminal(it));
const skipped = items.filter(it => isTerminal(it));

const BAD = /UNIMPLEMENTED API|RuntimeError|LinkError|CRASH|STUCK|unreachable/i;
// [MessageBox] "caption": "text" type=0xNN -- see test/run.js h.message_box.
const ERRBOX = /^\[MessageBox\] "([^"]*)": "([^"]*)" type=0x([0-9a-f]+)/;

// Drive a list of menu commands through one freshly launched app and say what
// each one did. Each item gets: post the command, let it run, photograph the
// window list, then dismiss whatever it opened.
//
// Dismissing matters more than it sounds. A modal dialog left standing eats
// every command after it, so one dialog that will not close reads as a whole
// broken menu -- WordPad's first pass reported nine items as opening nothing
// while an Options dialog nobody had closed sat on top of them. IDCANCEL goes
// to the topmost dialog, then IDOK for a message box that has no Cancel, then
// Escape for anything that only listens for the key.
function drive(list) {
  const spec = [`${SETTLE}:dump-windows:baseline`];
  list.forEach((it, i) => {
    const at = SETTLE + GAP * (i + 1);
    spec.push(`${at}:post-cmd:${it.id}`);
    // Sample late. A dialog is not up the instant the command is posted -- the
    // app has to run to it, and a common dialog builds a window tree first.
    spec.push(`${at + Math.floor(GAP * 0.75)}:dump-windows:after-${it.id}`);
    spec.push(`${at + Math.floor(GAP * 0.8)}:dlg-cmd:2`);
    spec.push(`${at + Math.floor(GAP * 0.85)}:dlg-cmd:1`);
    spec.push(`${at + Math.floor(GAP * 0.9)}:dlg-cmd:2`);
    spec.push(`${at + Math.floor(GAP * 0.94)}:keydown:27`);
    spec.push(`${at + Math.floor(GAP * 0.97)}:keyup:27`);
  });
  const lastBatch = SETTLE + GAP * (list.length + 1);
  spec.push(`${lastBatch}:dump-windows:final`);
  spec.push(`${lastBatch + 50}:stop`);

  let out = '';
  let status = 0;
  try {
    out = execFileSync('node', [
      RUN, `--exe=${exe}`, '--no-close', `--input=${spec.join(',')}`,
      `--max-batches=${lastBatch + 100}`, '--batch-size=100',
      '--quiet-api', '--quiet-blocks',
    ], {
      cwd: ROOT, encoding: 'utf-8', timeout: TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
    status = e.status == null ? 'timeout' : e.status;
  }
  if (VERBOSE) console.log(out);

  // dump-windows prints one "[input] window:LABEL hwnd=N ... title=..." line
  // per window, so the snapshots come back keyed by the label we asked for.
  const lines = out.split('\n');
  const snapshots = new Map();   // label -> Map(hwnd -> title)
  const lineOfLabel = new Map(); // label -> first line index, for slicing
  const menuBarAt = new Set();   // labels where some visible window has a menu
  lines.forEach((line, i) => {
    const m = /\[input\] window:([a-z0-9-]+) hwnd=(\d+)\b/i.exec(line);
    if (!m) return;
    const [, label, hwnd] = m;
    if (!snapshots.has(label)) { snapshots.set(label, new Map()); lineOfLabel.set(label, i); }
    if (!/visible=true/.test(line)) return;
    if (/menuBar=true/.test(line)) menuBarAt.add(label);
    // Only windows a menu command could have put on screen: a dialog, or a
    // window owned by another (the palettes and tool boxes apps float over
    // themselves). The app's own main window and its child controls are
    // neither, which keeps a main window that becomes visible late -- after
    // the baseline was taken -- from reading as the first menu item opening a
    // dialog.
    const isDialog = /dialog=true/.test(line);
    const owned = !/owner=0x0\b/.test(line);
    if (!isDialog && !owned) return;
    const title = /title="([^"]*)"/.exec(line);
    snapshots.get(label).set(hwnd, title ? title[1] : '');
  });

  const baseline = snapshots.get('baseline') || new Map();
  // An app that is not showing a menu bar cannot be judged by its menu. Two
  // real cases, both of which this tool used to report as a wall of broken
  // dialogs:
  //
  //   The Organic Art screensavers carry the full editor's RT_MENU, but no
  //   .SCR mode ever creates a window that shows it -- /s makes a bare
  //   WindowsScreenSaverClass and /c makes a configuration dialog. The menu
  //   exists in the file and nowhere on screen.
  //
  //   viewer.exe puts up "Failed to load camera.x" and ExitProcesses the
  //   moment it is dismissed, so its main window is never shown at all.
  //
  // Either way the commands go to a window whose wndproc has never heard of
  // them, and "nothing opened" is the honest outcome, not a defect. Say so
  // instead of blaming the menu.
  const noMenuBar = menuBarAt.size === 0;
  const results = [];
  let prevLine = 0;
  // Compare each item against the snapshot before it, not against the
  // baseline: a dialog that would not close is still standing when the next
  // command runs, and diffing against the baseline would credit that window to
  // every item after it.
  let prevSnap = baseline;
  for (const it of list) {
    const label = `after-${it.id}`;
    const wantsDialog = /\.\.\.$/.test(it.label.trim());
    const snap = snapshots.get(label);
    if (!snap) {
      // No snapshot means the run never got this far -- the app died, or the
      // emulator stopped, at or before this command.
      const why = BAD.exec(lines.slice(prevLine).join('\n'));
      results.push({ ...it, verdict: 'CRASH',
        detail: why ? why[0] : 'run ended before this item' });
      continue;
    }
    const here = lineOfLabel.get(label);
    const slice = lines.slice(prevLine, here);
    const bad = BAD.exec(slice.join('\n'));
    // The last error/warning box this command put up, if any. run.js logs every
    // message_box with its uType; the icon bits are what separate a refusal
    // from an ordinary informational box (About, "3 mines left").
    let errbox = null;
    for (const line of slice) {
      const m = ERRBOX.exec(line);
      if (!m) continue;
      const icon = parseInt(m[3], 16) & 0xF0;
      if (icon === 0x10 || icon === 0x30) errbox = `${m[1]}: ${m[2]}`;
    }
    prevLine = here;
    const opened = [...snap.keys()].filter(h => !prevSnap.has(h));
    const openedTitles = opened.map(h => snap.get(h)).filter(Boolean);
    const leftover = [...prevSnap.keys()].filter(h => !baseline.has(h))
      .map(h => prevSnap.get(h)).filter(Boolean);
    prevSnap = snap;
    if (bad) {
      results.push({ ...it, verdict: 'CRASH', detail: bad[0] });
    } else if (!opened.length && leftover.length) {
      // A dialog left over from an earlier item is modal and swallows this
      // command, so "nothing happened" says nothing about this item.
      results.push({ ...it, verdict: 'blocked', detail: `${leftover.join(', ')} still open` });
    } else if (!menuBarAt.has(label)) {
      // The app was not showing a menu bar when this command was posted, so
      // its wndproc had no reason to know the command and "nothing opened"
      // says nothing about it. Pinball spends its first few thousand batches
      // on a splash and only then creates the window that carries the menu.
      results.push({ ...it, verdict: 'nomenu', detail: 'no menu bar on screen yet' });
    } else if (wantsDialog && !opened.length) {
      results.push({ ...it, verdict: 'NODLG', detail: 'label promises a dialog, no window appeared' });
    } else if (opened.length && errbox) {
      // A window did open, but it is the app saying no. Scoring that as a
      // working command is how kodakimg reported 97 of 98 commands as opening
      // a dialog while every one of them was the same "The Image Admin control
      // cannot be found" box -- a total failure that read as a clean app.
      results.push({ ...it, verdict: 'ERRBOX', detail: errbox });
    } else if (opened.length) {
      results.push({ ...it, verdict: 'dialog',
        detail: openedTitles.length ? openedTitles.join(', ') : `${opened.length} new window(s)` });
    } else {
      results.push({ ...it, verdict: 'ok', detail: '' });
    }
  }

  const finalSnap = snapshots.get('final') || new Map();
  const leaked = [...finalSnap.keys()].filter(h => !baseline.has(h))
    .map(h => finalSnap.get(h)).filter(Boolean);
  return { results, status, leaked, noMenuBar };
}

let pass1 = drive(live);

// Some apps are simply slow to get their menu up. Pinball spends the first
// couple of thousand batches on a splash and its sound engine, and only then
// creates the window that carries the menu bar -- so a short settle sees no
// menu, and every command posted before that goes to a window whose wndproc
// has never heard of it. Give it one longer run before concluding the app has
// no menu at all.
if (pass1.noMenuBar) {
  SETTLE = SETTLE * 3;
  pass1 = drive(live);
}

// Established before any verdict is trusted, because it invalidates all of
// them at once rather than item by item.
if (pass1.noMenuBar) {
  console.log(`SKIP  ${name}: no menu bar on screen (${items.length} commands in its resources)`);
  if (opt('json', null)) {
    fs.writeFileSync(opt('json'), JSON.stringify(
      { exe, items: items.length, skipped: 'no menu bar on screen' }, null, 2));
  }
  process.exit(0);
}

const byId = new Map(pass1.results.map(r => [r.id, r]));

// Anything the first pass accused, or could not judge, gets its own process
// and a freshly launched app. Paint's Edit Colors opens perfectly well and the
// first pass called it NODLG -- it had run Print Preview eleven items earlier,
// and the app was still in preview, where that command does nothing.
let confirmed = 0;
if (CONFIRM) {
  const unresolved = () => live.filter(it => {
    const v = byId.get(it.id).verdict;
    return v === 'CRASH' || v === 'NODLG' || v === 'ERRBOX' ||
           v === 'blocked' || v === 'nomenu';
  });
  const first = new Map(pass1.results.map(r => [r.id, r.verdict]));
  const note = (r) => {
    const was = first.get(r.id);
    return r.verdict === was ? r.detail : `${r.detail} (first pass said ${was})`;
  };
  // Retry the accused as a group first. Most of them are collateral -- one
  // dialog that would not close, or an app left in print preview, takes every
  // item after it down with it -- and a fresh app clears all of them in a
  // single run instead of one run each.
  for (let round = 0; round < 3; round++) {
    const suspects = unresolved();
    if (!suspects.length || suspects.length === live.length) break;
    confirmed += suspects.length;
    for (const r of drive(suspects).results) byId.set(r.id, { ...r, detail: note(r) });
  }
  // Whatever still stands accused gets a process to itself, where nothing that
  // ran before it can be the explanation.
  for (const it of unresolved()) {
    const solo = drive([it]).results[0];
    if (!solo) continue;
    confirmed++;
    byId.set(it.id, { ...solo, alone: true, detail: note(solo) });
  }
}

const results = live.map(it => byId.get(it.id))
  .concat(skipped.map(it => ({ ...it, verdict: 'skipped', detail: 'terminates the app' })));
const bad = results.filter(r => r.verdict === 'CRASH' || r.verdict === 'NODLG' ||
                               r.verdict === 'ERRBOX');
const tally = results.reduce((a, r) => (a[r.verdict] = (a[r.verdict] || 0) + 1, a), {});

console.log(`${name}  ${items.length} menu commands  ` +
  Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ') +
  (confirmed ? `  (${confirmed} re-checked)` : '') +
  (pass1.leaked.length ? `  left open: ${pass1.leaked.join(', ')}` : '') +
  (pass1.status ? `  (run.js status=${pass1.status})` : ''));
for (const r of results) {
  if (r.verdict === 'ok' || r.verdict === 'skipped') continue;
  console.log(`  ${r.verdict.padEnd(7)} ${String(r.id).padStart(6)}  ${r.path}${r.detail ? '  -- ' + r.detail : ''}`);
}

if (opt('json', null)) {
  fs.writeFileSync(opt('json'), JSON.stringify(
    { exe, status: pass1.status, leaked: pass1.leaked, tally, results }, null, 2));
}
process.exit(bad.length ? 1 : 0);
