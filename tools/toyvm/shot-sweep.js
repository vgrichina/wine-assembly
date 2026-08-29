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
  const { runDos, runDosWithPre } = require('./run-dos');
  // runDos writes the picture itself, and writes the FULLEST one rather than
  // the last: a demo that quits on the keypress the answerer supplied, or that
  // clears the screen on its way out, is otherwise photographed empty.
  const r = await (o.pre ? runDosWithPre : runDos)({
    exe, variant: 'tailcall', budget: o.budget, cpu: o.cpu, log: () => {},
    seconds: o.seconds || 0,
    autoKey: o.autoKey, bestPng: png, guestArgs: o.guestArgs || '',
    ...(o.pre ? { pre: o.pre, preKeys: [] } : {}),
    ...(o.sound ? { sound: o.sound } : {}),
    ...(o.env ? { env: String(o.env).split(';').filter(Boolean) } : {}),
  });
  const text = r.bestSurface.text;
  return {
    name: path.basename(exe), exe, png, surface: text ? 'console' : 'vga',
    mode: r.video.mode, width: r.video.width, height: r.video.height,
    planar: !!r.video.planar, bpp: r.video.bpp,
    dispatched: r.dispatched,
    pixels: text ? 0 : r.bestScore, cells: text ? r.bestScore : r.text.cells,
    written: r.text.written, stuckAt: r.stuckAt || null, args: o.guestArgs || '',
    // The two honest stops. A blank tile means nothing on its own -- these say
    // whether the run walked off a cliff or hit a wall we know the shape of,
    // and that is the difference between a work item and a declared blocker.
    blockedOn32: r.blockedOn32 || null, badSelector: r.badSelector || null,
    // Which machine this frame came off, when it was not the default one, and
    // whether the program went looking for a card at all. The second is what
    // makes the no-card retry affordable: without it every text-mode demo in
    // the corpus qualifies (a console program has no pixels by definition) and
    // the sweep pays two extra runs apiece for a machine change none of them
    // can observe.
    sound: o.sound || null,
    soundProbed: !!(r.machine.sb.detects || r.machine.sb.commands
      || r.machine.adlibIndex !== undefined),
    // Not a failure. The picture is real and the program simply had more to do
    // than the budget allowed, which is worth telling apart from a run that
    // finished with nothing on screen.
    ranOutOfTime: !!r.ranOutOfTime,
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

// The program a screen tells you to run FIRST, or null. A demo that ships a
// configurator says so in as many words -- BYETRO.EXE prints "Please run
// SETUP.EXE to configure." and ANGEL.EXE "Please run setup.exe on your
// computer ! The demo can't run without this !".
//
// Anchored on `run` and a DOS 8.3 name, and it declines to name the program
// itself: a demo that says "run FOO.EXE" while being FOO.EXE is telling the
// user to start it differently, not to start it twice.
function preNamed(screen, self) {
  const m = /\brun\s+([A-Za-z0-9_$!#%&@^~()'-]{1,8}\.(?:exe|com))\b/i.exec(screen || '');
  if (!m) return null;
  return m[1].toLowerCase() === String(self).toLowerCase() ? null : m[1];
}

// --- parent -----------------------------------------------------------------
function child(exe, png, o) {
  return new Promise((resolve) => {
    // Two deadlines, and only the first one is meant to fire. The child gets a
    // wall-clock budget it stops itself on, which keeps the best frame and
    // writes the row; the SIGKILL below is what catches a child that cannot
    // reach even that -- one wedged outside the guest loop. When the kill was
    // the only deadline, TRIPLEX!.COM and DENTROCF.EXE came back as `no
    // picture`, which is a much stronger claim than the truth, that 30M
    // dispatches take them longer than we were prepared to wait.
    const grace = 10;
    const args = [__filename, `--one=${exe}`, `--png=${png}`,
      `--dispatches=${o.budget}`, `--cpu=${o.cpu}`,
      `--seconds=${Math.max(5, o.timeout - grace)}`,
      ...(o.autoKey ? ['--auto-key'] : []),
      ...(o.sound ? [`--sound=${o.sound}`] : []),
      ...(o.env ? [`--env=${o.env}`] : []),
      ...(o.pre ? [`--pre=${o.pre}`] : []),
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
  // A card that is present is not always better than no card. Most of this
  // corpus prints a refusal without one and runs with one -- but a driver that
  // finds a DSP next programs a DMA transfer, and there is no DMA controller
  // behind ours, so a few init forever instead. Measured: ATTIC.EXE draws
  // nothing without a card and 56556 pixels with one; CEN!FB.EXE is the exact
  // opposite, 64000 pixels without and a permanent "Initializing ." with.
  //
  // Neither is predictable from the outside, and the sweep already knows how
  // to decide this kind of question -- it does it for the start key and for a
  // silent-mode switch. So a program that still has no picture gets the
  // machine without a sound card, and keeps whichever frame is fuller.
  if (!row.pixels && !o.sound && row.soundProbed) {
    const first = { ...row };
    const retry = await child(exe, png, { ...o, autoKey: true, sound: 'none' });
    if (score(retry) > score(first)) { row = retry; row.sound = 'none'; }
    else { row = first; await child(exe, png, o); }
  }
  // A Gravis card, announced the only way a Gravis card ever was: the ULTRASND
  // variable. This is a retry rather than a line in the default environment
  // because the corpus priced both sides of it. AMANAMAN.EXE prints "Hey !
  // Where's your ULTRASND environment ?" and quits without it and draws all
  // 64000 pixels with it; CATWALK.EXE gets from nothing to "Gravis UltraSound
  // reported at address 240h using IRQ 11". But AUTUMN.EXE and CLASH.EXE both
  // LOSE their pictures to it -- MikMod reads the variable instead of probing,
  // goes looking for a GF1 that is not there, and quits at 1.1M dispatches
  // where it otherwise runs 3G and fills the screen. Set globally it is 184
  // -> 183; offered only to a program that has no picture and asked for it, it
  // is 184 -> 185, and the two that are better off without it never see it.
  //
  // rage.exe and CULT.EXE are unmoved either way. They probe the GF1 ports
  // rather than reading the variable, so "GUS not found!" is the true answer
  // and no environment string can make it false.
  // A demo that ships a configurator and says so. BYETRO.EXE prints "Please
  // run SETUP.EXE to configure." and stops; its SETUP.EXE is a two-item menu
  // whose "Save and Exit" writes SOUND.CFG, and with that file present BYETRO
  // loads its gfx and draws 40689 pixels. On a real machine you run the setup
  // once and the file stays -- here every program is photographed cold, so the
  // pair has to be run as a pair. See runDosWithPre: two machines, one
  // tempFiles map between them, and the corpus directory still never written.
  const pre = !row.pixels && !o.pre && preNamed(row.screen, path.basename(exe));
  if (pre) {
    const first = { ...row };
    const retry = await child(exe, png, { ...o, autoKey: true, pre });
    if (score(retry) > score(first)) { row = retry; row.pre = pre; }
    else { row = first; await child(exe, png, o); }
  }
  if (!row.pixels && !o.env && /ultrasnd|gravis|\bgus\b/i.test(row.screen || '')) {
    const first = { ...row };
    const retry = await child(exe, png,
      { ...o, autoKey: true, env: 'ULTRASND=240,1,1,11,7' });
    if (score(retry) > score(first)) { row = retry; row.env = 'gus'; }
    else { row = first; await child(exe, png, o); }
  }
  // Last: the program that is working and simply has further to go than we
  // waited. The signature is exact and it is not the same as "blank" -- the run
  // is in a GRAPHICS mode, drew nothing, was not stuck, did not exit, and spent
  // the whole dispatch budget. Everything about that says the budget was the
  // limit, and nothing about it says the program is broken.
  //
  // COMPCODE.EXE is the corpus's one example and it is not a near miss: it
  // needs 953M dispatches and draws its plasma at about 82% of the way through,
  // so at the sweep's 300M it photographs as an empty mode 13h. Raising the
  // budget for everyone is the wrong fix -- 117 of 199 programs reach the
  // ceiling and nearly all of them are already drawing, so it would multiply
  // the sweep's wall time to change one row.
  //
  // The wall timeout still bounds this, which is what keeps it affordable: the
  // extra budget is only reachable by a program fast enough to spend it, and a
  // slow one stops where it always did.
  //
  // `surface` is the wrong thing to ask, and AUTUMN.EXE is what it costs. That
  // field comes from the best-frame tracker, which keeps the surface with the
  // higher score -- and when a program starts in text mode and then draws
  // nothing, both surfaces score zero, so the text one it opened on wins the
  // tie and the row reads `console` on a machine sitting in mode 13h. The rung
  // then declines to fire on precisely the rows it exists for. `bpp` is the
  // final video state and says what the question means: is this machine in a
  // graphics mode. AUTUMN draws 44800 pixels at 4x the budget and fills all
  // 64000 at 10x, and photographed as a blank text screen for want of this.
  if (!row.pixels && (row.surface === 'vga' || row.bpp > 0)
      && !row.stuckAt && !row.ranOutOfTime && row.dispatched >= o.budget) {
    const first = { ...row };
    // 10x rather than 4x, and the extra is not padding. AUTUMN.EXE waits on a
    // counter its timer ISR advances, so how far it gets is set by how many
    // IRQ0s fit in the budget: at 4x it has faded 44800 pixels up from black
    // and the tile still looks like an empty screen, and at 10x it is the
    // green cloud field it means to be. A row that qualifies here has already
    // proved it can spend a budget, and only a couple in the corpus do.
    const retry = await child(exe, png, { ...o, autoKey: true, budget: o.budget * 10 });
    if (score(retry) > score(first)) row = retry;
    else { row = first; await child(exe, png, o); }   // re-take the better frame
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
    // Unset on the way in, which is what lets capture() tell "nobody has
    // chosen" from "run this one without a card". Only the retry sets it.
    sound: arg('sound', ''),
    // Same shape as `sound`: unset unless a retry chose it. See the GUS rung.
    env: arg('env', ''),
    pre: arg('pre', ''),
    guestArgs: arg('args', ''),
    maxSeconds: Number(arg('max-seconds', 0)),
    // The graceful deadline the child stops itself on. The parent sets it from
    // its own --timeout; a --one invocation by hand can set it directly.
    seconds: Number(arg('seconds', 0)),
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
