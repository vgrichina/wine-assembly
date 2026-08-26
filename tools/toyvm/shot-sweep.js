#!/usr/bin/env node

'use strict';

// One screenshot per DOS program, for the whole corpus.
//
//   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots
//   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots --json=/tmp/shots.json
//
// Graphics-mode programs are captured off the VGA planes; text-mode programs
// are captured off the console grid, drawn in the real CP437 strike. Both come
// from run-dos.js, which already picks the right one -- this only fans it out.
//
// The distinction is the point. Before the console model existed, a sweep of
// this corpus photographed A000 for every program, and the 159 text-mode ones
// all came back as the same black rectangle: indistinguishable from a program
// that had crashed on its first instruction. A blank tile here now means the
// program really put nothing on either surface.
//
// One child process per program, same as video-census.js and opcode-census.js:
// a program that traps, wedges or runs the arena dry must cost one row rather
// than the whole sweep.
//
// A whole-corpus sweep is also runnable as 199 independent commands, which is
// what to reach for on a loaded box:
//
//   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots --list > /tmp/list
//   xargs -P 6 -L 1 tools/toyvm/capture-one.sh < /tmp/list
//   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots \
//     --merge=/tmp/shots/rows --json=/tmp/shots.json
//
// Each line of --list is one program and the tile name it owns, so the workers
// need no shared state and the shell -- not this file -- owns the parallelism
// and the per-program timeout. --capture writes its row to --row and skips a
// program whose row file is already there, so a sweep that lost a handful of
// programs to a timeout is re-run by deleting those row files and running the
// same xargs line again.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

function findExes(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(exe|com)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Two programs in different subdirectories can share a basename (ZERO-BBS.COM
// appears three times in this corpus), so the tile name carries the directory
// when it has to.
function shotName(exe, dir, used) {
  const rel = path.relative(dir, exe);
  let base = path.basename(rel).replace(/\.(exe|com)$/i, '');
  if (used.has(base.toLowerCase())) {
    const parent = path.basename(path.dirname(rel));
    base = `${parent}-${base}`;
  }
  used.add(base.toLowerCase());
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}

// --- child: one program, one run --------------------------------------------
async function runOne(exe, png, o) {
  const { runDos } = require('./run-dos');
  // runDos writes the picture itself, and writes the FULLEST one rather than
  // the last: a demo that quits on the keypress the answerer supplied, or that
  // clears the screen on its way out, is otherwise photographed empty.
  const r = await runDos({
    exe, variant: 'tailcall', budget: o.budget, cpu: o.cpu, log: () => {},
    autoKey: o.autoKey, bestPng: png, guestArgs: o.guestArgs || '',
  });
  const text = r.bestSurface.text;
  return {
    name: path.basename(exe), exe, png, surface: text ? 'console' : 'vga',
    mode: r.video.mode, width: r.video.width, height: r.video.height,
    planar: !!r.video.planar, bpp: r.video.bpp,
    dispatched: r.dispatched,
    pixels: text ? 0 : r.bestScore, cells: text ? r.bestScore : r.text.cells,
    written: r.text.written, stuckAt: r.stuckAt || null, args: o.guestArgs || '',
    blockedOnKey: !!r.machine.blockedOnKey, autoKey: !!o.autoKey,
    // What the screen says, when it says anything. Worth recording alongside
    // the picture because a program that puts up two lines is usually telling
    // you exactly why it will not run -- "File Not Found", "Select an output
    // device", "Runtime error 100" -- and that is a different work list from
    // the one an opcode census produces.
    screen: (r.bestText || '').slice(0, 2000),
  };
}

// How much of a picture a run ended up with, for choosing between two runs of
// the same program. A drawn graphics frame always beats a text screen: a demo
// that prints "press a key" and then goes to mode 13h should be photographed
// running, not at its prompt.
const score = (row) => (row.failed ? -1 : (row.pixels > 0 ? 1e6 + row.pixels : row.cells));

// The command-line switch a screen tells you to use, or null. Anchored on the
// verb so that a stray slash in ANSI art is not mistaken for an option.
function switchNamed(screen) {
  const m = /\b(?:use|try|run|start)\b[^\n]{0,60}?\s([/-][A-Za-z][\w-]{1,15})/i.exec(screen || '');
  return m ? m[1].toLowerCase() : null;
}

// --- parent -----------------------------------------------------------------
function child(exe, png, o) {
  return new Promise((resolve) => {
    const args = [__filename, `--one=${exe}`, `--png=${png}`,
      `--dispatches=${o.budget}`, `--cpu=${o.cpu}`, ...(o.autoKey ? ['--auto-key'] : []),
      ...(o.guestArgs ? [`--args=${o.guestArgs}`] : [])];
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), o.timeout * 1000);
    p.on('close', (code, sig) => {
      clearTimeout(kill);
      const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
      if (line) { try { return resolve(JSON.parse(line)); } catch { /* fall through */ } }
      resolve({
        name: path.basename(exe), exe, png: null,
        failed: sig === 'SIGKILL' ? 'timeout' : (err.trim().split('\n').pop() || `exit ${code}`),
      });
    });
  });
}

// One program, all the way to a row: the run, the retries that decide whether
// it had really started, and the re-take of whichever frame won.
//
// It lives at module scope rather than inside the sweep loop because it is the
// unit of work either way -- the in-process sweep calls it per program, and so
// does a --capture invocation driven from xargs. A copy of this logic in a
// shell driver would be a second, quietly diverging sweep.
async function capture(exe, png, o) {
  let row = await child(exe, png, o);
  // A blocking key read now stops the run rather than being answered with a
  // phantom NUL, which is what makes a "press any key" title screen sit still
  // long enough to photograph. Some programs want that key to START, though,
  // so any run that ended waiting is tried a second time with autoKey and the
  // better of the two pictures is kept. A demo that treats any key as "quit"
  // comes back blank from the retry and keeps its first frame.
  //
  // A text screen counts as "not started" too, and that is not a nicety: a
  // program can be sitting on a menu without ever blocking, because it polls
  // for the key rather than waiting for one. BTW.EXE scores 99 cells of sound
  // menu, never blocks, and never gets the retry that answers it -- 46,912
  // pixels of demo behind a screen that looked like a result.
  if (!o.autoKey && (row.blockedOnKey || score(row) <= 0 || !row.pixels)) {
    const first = { ...row };
    const retry = await child(exe, png, { ...o, autoKey: true });
    if (score(retry) > score(first)) row = retry;
    else { row = first; await child(exe, png, o); }   // re-take the better frame
  }
  // A program that refuses to start will sometimes say how to make it start.
  // AMBIENT.EXE prints `MIDAS Error: NO GUS FOUND... USE "AMBIENT /NO_SND"
  // FOR SILENT MODE` and means every word of it -- with the switch it renders
  // its picture. Lower-cased on the way in, because the message shouts and
  // MIDAS's option parser is case sensitive.
  const sw = !row.pixels && switchNamed(row.screen);
  if (sw) {
    const first = { ...row };
    const retry = await child(exe, png, { ...o, autoKey: true, guestArgs: sw });
    if (score(retry) > score(first)) row = retry;
    else { row = first; await child(exe, png, { ...o, autoKey: o.autoKey }); }
  }
  if (row.png && !fs.existsSync(row.png)) { row.png = null; row.failed ||= 'no png'; }
  return row;
}

// The corpus in the order the tile names are allocated in. Both --list and the
// in-process sweep go through this, so a name means the same file either way.
function plan(dir, out) {
  const used = new Set();
  return findExes(dir).map(exe => ({ exe, png: path.join(out, `${shotName(exe, dir, used)}.png`) }));
}

async function main() {
  const one = arg('one');
  const o = {
    budget: count(arg('dispatches'), 30e6),
    cpu: Number(arg('cpu', 386)),
    timeout: Number(arg('timeout', 180)),
    jobs: Number(arg('jobs', 1)),
    autoKey: process.argv.slice(2).includes('--auto-key'),
    guestArgs: arg('args', ''),
    maxSeconds: Number(arg('max-seconds', 0)),
  };
  const deadline = o.maxSeconds ? Date.now() + o.maxSeconds * 1000 : 0;

  if (one) {
    process.stdout.write(JSON.stringify(await runOne(one, arg('png'), o)) + '\n');
    return;
  }

  // One program, driven from outside. The row goes to a file rather than to
  // stdout because the run it describes also writes progress there, and an
  // xargs worker's stdout is interleaved with five others'.
  const cap = arg('capture');
  if (cap) {
    const png = arg('png');
    const rowFile = arg('row');
    if (!png) { console.error('--capture needs --png'); process.exit(2); }
    if (rowFile && fs.existsSync(rowFile) && !process.argv.includes('--force')) {
      console.log(`already captured: ${path.basename(cap)}`);
      return;
    }
    fs.mkdirSync(path.dirname(png), { recursive: true });
    const row = await capture(cap, png, o);
    const text = JSON.stringify(row);
    if (rowFile) {
      fs.mkdirSync(path.dirname(rowFile), { recursive: true });
      fs.writeFileSync(rowFile, text);
    }
    console.log(`${row.failed ? 'FAILED' : 'ok'} ${row.name}`
      + `${row.failed ? ` ${row.failed}` : ` ${row.pixels ? `${row.pixels} px` : `${row.cells} cells`}`}`);
    if (!rowFile) process.stdout.write(`${text}\n`);
    return;
  }

  const dir = arg('dir');
  const out = arg('out');
  if (!dir || !out) {
    console.log('usage: node tools/toyvm/shot-sweep.js --dir=DIR --out=DIR '
      + '[--json=OUT] [--resume] [--dispatches=N] [--timeout=SECS] [--max-seconds=N] '
      + '[--jobs=N] [--auto-key] [--args=TAIL]\n'
      + '       ... --list                       one line per program: EXE PNG ROW\n'
      + '       ... --capture=EXE --png=P --row=R  one program, for xargs\n'
      + '       ... --merge=ROWDIR --json=OUT    assemble the rows into a sweep');
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });

  // The work list, for a driver that owns its own parallelism and timeouts.
  // Three fields, whitespace-separated, so `xargs -L 1 sh -c '...' _` gets them
  // as $1 $2 $3 -- no path in this corpus has a space in it, and one that did
  // would have to be quoted here rather than by every reader.
  if (process.argv.includes('--list')) {
    const rowDir = arg('rows', path.join(out, 'rows'));
    for (const { exe, png } of plan(dir, out)) {
      console.log(`${exe} ${png} ${path.join(rowDir, `${path.basename(png, '.png')}.json`)}`);
    }
    return;
  }

  // Rows written by those workers, back into one sweep. Corpus order, and a
  // program whose row never arrived is recorded as such rather than dropped --
  // a sweep that is quietly 12 programs short reads as a sweep where those 12
  // do not exist.
  const merge = arg('merge');
  if (merge) {
    const rows = plan(dir, out).map(({ exe, png }) => {
      const f = path.join(merge, `${path.basename(png, '.png')}.json`);
      if (!fs.existsSync(f)) {
        return { name: path.basename(exe), exe, png: null, failed: 'not run' };
      }
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
        return { name: path.basename(exe), exe, png: null, failed: `bad row: ${e.message}` };
      }
    });
    report(rows, dir, out, arg('json'));
    return;
  }

  const exes = findExes(dir);
  const used = new Set();
  console.log(`${exes.length} program(s) in ${dir}\n`);

  // Resume. A full corpus sweep is 199 child processes and this box regularly
  // sits at load 40-60 with other agents' sweeps running, which is long enough
  // for something to kill the run -- the first attempt died at 136 of 199. Rows
  // are appended to the JSON as they complete so a re-run picks up where it
  // stopped rather than starting over.
  const json = arg('json');
  const done = new Map();
  if (json && process.argv.slice(2).includes('--resume') && fs.existsSync(json)) {
    try {
      for (const r of JSON.parse(fs.readFileSync(json, 'utf8')).rows || []) {
        if (r.png && fs.existsSync(r.png)) done.set(r.exe, r);
      }
      console.log(`resuming: ${done.size} program(s) already captured\n`);
    } catch { /* a truncated file just means no resume */ }
  }

  // Tile names are allocated in corpus order, so they are worked out up front:
  // with several programs in flight the order they FINISH in is not the order
  // they started, and a name allocator driven by completion would rename half
  // the sheet on every run.
  const pngFor = new Map(exes.map(exe => [exe, path.join(out, `${shotName(exe, dir, used)}.png`)]));

  // One child per program is already the isolation model; `--jobs` just runs
  // several of them at once. Worth having: the retry above means a program can
  // cost three sequential runs, and a corpus sweep that took three hours takes
  // most of an afternoon to answer one question about a change.
  const rows = new Array(exes.length);
  let next = 0, finished = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= exes.length) return;
      // The whole-sweep deadline. Every CHILD has been capped since this file
      // existed, but the parent never was, and those are not the same bound:
      // one program can cost up to five sequential child runs now (the base
      // run, the auto-key retry, the re-take, and the named-switch pair), so
      // 199 programs at a 180-second cap is thirty hours of worst case with
      // nothing to stop it. Programs past the deadline are recorded as not run
      // rather than silently dropped -- a short sweep must not read as a sweep
      // where everything failed.
      if (deadline && Date.now() > deadline) {
        rows[i] = { name: path.basename(exes[i]), exe: exes[i], png: null, failed: 'deadline' };
        finished++;
        continue;
      }
      const exe = exes[i];
      rows[i] = done.has(exe) ? done.get(exe) : await capture(exe, pngFor.get(exe), o);
      finished++;
      // Rows land out of order, so the file is only useful once the holes in
      // front of the last completion are filled -- which is what --resume
      // reads. Writing the dense prefix keeps it a valid sweep at every moment.
      if (json) {
        const upto = rows.findIndex(r => r === undefined);
        const dense = upto === -1 ? rows : rows.slice(0, upto);
        fs.writeFileSync(json, JSON.stringify({ dir, out, rows: dense }, null, 1));
      }
      process.stderr.write(`\r${finished}/${exes.length} ${rows[i].name.padEnd(24)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.jobs) }, worker));
  process.stderr.write('\r' + ' '.repeat(44) + '\r');
  report(rows, dir, out, json);
}

// The table and the tallies. Shared, because a sweep assembled from separately
// captured rows has to be readable as the same thing as one run in a single
// process -- and has to be countable the same way, or the two drivers quietly
// disagree about how many programs draw.
function report(rows, dir, out, json) {
  const shots = rows.filter(r => r.png);
  const blank = shots.filter(r => !r.pixels && !r.cells);
  const console_ = shots.filter(r => r.surface === 'console');
  const failed = rows.filter(r => r.failed);

  console.log('| program | surface | mode | geometry | content |');
  console.log('|---|---|---|---|--:|');
  for (const r of rows) {
    if (r.failed) { console.log(`| ${r.name} | - | - | - | ${r.failed} |`); continue; }
    const con = r.surface === 'console';
    const content = con ? `${r.cells} cells` : `${(r.pixels || 0).toLocaleString()} px`;
    console.log(`| ${r.name} | ${r.surface} | ${r.mode.toString(16)}h`
      + `${r.planar ? ` planar ${r.bpp}bpp` : ''} `
      + `| ${con ? '80x25' : `${r.width}x${r.height}`} | ${content} |`);
  }

  console.log(`\n${rows.length} program(s): ${shots.length} captured `
    + `(${console_.length} console, ${shots.length - console_.length} VGA), `
    + `${blank.length} blank, ${failed.length} produced no picture.`);
  console.log(`shots in ${out}`);

  if (json) {
    fs.writeFileSync(json, JSON.stringify({ dir, out, rows }, null, 1));
    console.log(`wrote ${json}`);
  }
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
