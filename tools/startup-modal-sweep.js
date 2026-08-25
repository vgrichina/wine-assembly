#!/usr/bin/env node
// What is behind the message box an app puts up before you can use it?
//
// A surprising number of the ids in lib/apps.js greet you with a modal and
// nothing else: an About box (Four Stones, Funtris, Peaks), a welcome screen
// (Klotski), a question (HyperTerminal's "You need to install a modem"), a
// warning (Motocross Madness's video-memory test) or a real complaint that
// names a gap in the emulator (Imaging's "The Image Admin control cannot be
// found"). A launch check that only asks "did the app draw something" scores
// every one of those as a pass, and the picture in the contact sheet is a grey
// box on a teal desktop.
//
// This walks that one step further, per app: run it, collect every MessageBox
// it raised (run.js logs those unconditionally as `[MessageBox]`), then re-run
// it dismissing modals as they appear and photograph what is left. The verdict
// is about the *second* picture -- the app's own screen -- so "shows a box"
// and "shows a box and nothing else" stop looking alike.
//
// Why a tool and not a shell loop: the dismissal has to answer the right
// button (IDOK for an About box, IDYES/IDNO for a question), the dismiss has
// to be retried because nothing tells us which batch the box appears at, and
// the verdict needs the pixels, not the exit code. That is three things a
// `for id in ...; do node test/run.js; done` cannot do.
//
// Usage:
//   node tools/startup-modal-sweep.js --apps=hypertrm,mcm [--shots=DIR]
//   node tools/startup-modal-sweep.js --all [--json=out.json]
//   node tools/startup-modal-sweep.js --apps=funtris --answer=6   # force IDYES
//
// Options:
//   --seconds=N   wall-clock cap per run (default 20). Use a small one for
//                 screensavers, a large one for anything that loads assets.
//   --batches=N   batch cap per run (default 400000; --seconds usually wins)
//   --dismiss-every=N  send WM_COMMAND to the top dialog every N batches in
//                 pass 2. A dlg-cmd with no dialog on screen is a no-op, so
//                 over-sending is free and beats guessing. The default is
//                 derived from how far pass 1 actually got in --seconds, which
//                 matters more than it sounds: a 16-bit game runs ~60
//                 batches/s, so a fixed "dismiss at 2000, shoot at 4000" is a
//                 dismiss and a capture that never happen and an app that
//                 looks stuck when it is only slow.
//   --tick-ms-per-batch=N  passed to run.js. The headless clock advances 200ms
//                 per batch by default, which expires a game's own level timer
//                 in a few hundred batches (Chip's Challenge greets the sweep
//                 with "Ooops! Out of time!"). Use 5 for anything timed.
//   --answer=ID   force one command id instead of the per-type default
//   --no-build    reuse the existing build/wine-assembly.wasm
//
// Verdicts:
//   clean      no modal at startup
//   content    a modal, and real pixels behind it once dismissed
//   modal-only a modal, and the screen behind it is still empty
//   exits      the app answered its own box by quitting
//   stuck      the modal did not go away when its own button was pressed
//   crash      an unimplemented API or a WASM trap
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const { APPS } = require('../lib/apps');

const argv = process.argv.slice(2);
const flag = name => argv.includes('--' + name);
const opt = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const SECONDS = parseFloat(opt('seconds', '20')) || 20;
const BATCHES = parseInt(opt('batches', '400000'), 10);
const DISMISS_EVERY = opt('dismiss-every', null)
  ? Math.max(50, parseInt(opt('dismiss-every', '2000'), 10) || 2000) : null;
const TICK_MS = opt('tick-ms-per-batch', null);
const ANSWER = opt('answer', null) ? parseInt(opt('answer', '1'), 10) : null;
const SHOTS = opt('shots', path.join(os.tmpdir(), 'modal-sweep'));
const JSON_OUT = opt('json', null);
const NO_BUILD = flag('no-build');
const VERBOSE = flag('verbose');

const ids = flag('all')
  ? Object.keys(APPS)
  : (opt('apps', '') || '').split(',').map(s => s.trim()).filter(Boolean);

if (!ids.length) {
  console.error('usage: node tools/startup-modal-sweep.js --apps=a,b,c | --all');
  console.error('       [--seconds=N] [--batches=N] [--answer=ID] [--shots=DIR] [--json=out.json]');
  process.exit(2);
}
for (const id of ids) {
  if (!APPS[id]) { console.error(`unknown app id: ${id}`); process.exit(2); }
}

fs.mkdirSync(SHOTS, { recursive: true });

// MB_* button sets live in the low nibble of uType. The id we press is the one
// a person would press to get on with it: OK for a notice, Yes for a question,
// Ignore for abort/retry/ignore. --answer overrides the lot.
const DEFAULT_ANSWER = {
  0: 1,  // MB_OK               -> IDOK
  1: 1,  // MB_OKCANCEL         -> IDOK
  2: 5,  // MB_ABORTRETRYIGNORE -> IDIGNORE
  3: 6,  // MB_YESNOCANCEL      -> IDYES
  4: 6,  // MB_YESNO            -> IDYES
  5: 4,  // MB_RETRYCANCEL      -> IDRETRY
  6: 10, // MB_CANCELTRYCONTINUE-> IDCONTINUE
};

function runApp(id, extraInput) {
  const args = [
    RUN, `--app=${id}`, '--no-close', '--stuck-after=1000000',
    `--max-batches=${BATCHES}`, `--max-seconds=${SECONDS}`,
  ];
  if (NO_BUILD) args.push('--no-build');
  if (TICK_MS != null) args.push(`--tick-ms-per-batch=${TICK_MS}`);
  if (extraInput) args.push(`--input=${extraInput}`);
  try {
    return execFileSync('node', args, {
      encoding: 'utf8', timeout: (SECONDS + 60) * 1000, maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '') + `\n[sweep] run failed: ${err.message}\n`;
  }
}

// `[MessageBox] "caption": "text..." type=0x...` -- the text can run over
// several lines, so anchor on the marker and keep the type off the tail.
function collectBoxes(log) {
  const boxes = [];
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('[MessageBox] ')) continue;
    let entry = lines[i];
    for (let j = i + 1; j < lines.length && !/type=0x[0-9a-f]+\s*$/i.test(entry); j++) {
      entry += ' ' + lines[j].trim();
    }
    const type = /type=0x([0-9a-f]+)/i.exec(entry);
    const caption = /^\[MessageBox\] "([^"]*)"/.exec(entry);
    boxes.push({
      caption: caption ? caption[1] : '',
      text: entry.replace(/^\[MessageBox\] "[^"]*": "?/, '').replace(/"?\s*type=0x[0-9a-f]+$/i, ''),
      type: type ? parseInt(type[1], 16) : 0,
    });
  }
  return boxes;
}

// run.js's exit line: `Stats: N API calls, B batches in Ts (R batches/s)`.
function reachedBatches(log) {
  let last = 0;
  for (const m of log.matchAll(/(\d+) batches in /g)) last = parseInt(m[1], 10);
  return last;
}

// The desktop is a flat COLOR_BACKGROUND teal and an untouched DirectDraw
// primary is flat black; anything else on screen is the app.
function contentShare(file) {
  if (!fs.existsSync(file)) return null;
  const png = PNG.sync.read(fs.readFileSync(file));
  let painted = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    const teal = r === 0x00 && g === 0x80 && b === 0x80;
    const black = r === 0 && g === 0 && b === 0;
    if (!teal && !black) painted++;
  }
  return painted / (png.width * png.height);
}

const results = [];
for (const id of ids) {
  process.stdout.write(`${id} ... `);
  const probe = runApp(id, null);
  const boxes = collectBoxes(probe);
  const crashed = /UNIMPLEMENTED API|CRASH|unreachable/.test(probe);

  if (!boxes.length) {
    const verdict = crashed ? 'crash' : 'clean';
    console.log(verdict);
    results.push({ id, verdict, boxes: [] });
    continue;
  }

  // Pass 2: same run, but keep pressing the button the first box asks for.
  // Every `--input` batch number past what pass 1 reached is an event that
  // never fires, so the schedule is built from the run we just watched rather
  // than from a constant: dismiss through the first four fifths of the reach,
  // photograph just inside it.
  const answer = ANSWER != null ? ANSWER : (DEFAULT_ANSWER[boxes[0].type & 0xF] ?? 1);
  const reach = reachedBatches(probe) || BATCHES;
  // Pass 1 is a bad predictor of pass 2's reach, and wrong in the direction
  // that hurts: an app sitting behind its own modal is idle and burns through
  // batches, while the same app with the modal answered is *running* and gets
  // a fraction as far in the same wall clock (Klotski: 400000 vs 19722). So
  // don't schedule one capture at a computed batch -- ladder them to the same
  // path all the way up. Whichever one the run reaches last overwrites the
  // others, and the file is a picture of the furthest point it got to.
  // Capped at 500 for the same reason: a heavy app answers its box and then
  // slows to ~100 batches/s (Motocross Madness runs a video-memory test), so
  // an interval scaled off the idle pass would put the first dismiss past the
  // end of the run. Sending into no dialog costs nothing.
  const every = DISMISS_EVERY || Math.min(500, Math.max(50, Math.floor(reach / 200)));
  const shot = path.join(SHOTS, `${id}.png`);
  const input = [];
  for (let b = every, n = 0; b < reach && input.length < 380; b += every, n++) {
    input.push(`${b}:dlg-cmd:${answer}`);
    if (n % 4 === 3) input.push(`${b + (every >> 1)}:png:${shot}`);
  }
  if (!input.some(e => e.includes(':png:'))) input.push(`${every + 1}:png:${shot}`);
  const after = runApp(id, input.join(','));
  const share = contentShare(shot);
  const stillModal = collectBoxes(after).length > 0 &&
    /\[input\] dlg-cmd: cmd=\d+ NO DIALOG/.test(after) === false;

  let verdict;
  if (/UNIMPLEMENTED API|CRASH|unreachable/.test(after)) verdict = 'crash';
  // Answering the box and quitting is its own answer, and a common one: the
  // box named something the app cannot run without (Imaging's missing Image
  // Admin control) and ExitProcess follows within a few batches.
  else if (share == null && /\[Exit\] code=/.test(after)) verdict = 'exits';
  else if (share == null) verdict = 'stuck';
  else if (share > 0.02) verdict = 'content';
  else verdict = stillModal ? 'stuck' : 'modal-only';

  console.log(`${verdict}  (${boxes.length} box${boxes.length > 1 ? 'es' : ''}, ` +
    `answered ${answer}, ${share == null ? 'no shot' : (share * 100).toFixed(1) + '% painted'})`);
  for (const box of boxes) {
    console.log(`    "${box.caption}": ${JSON.stringify(box.text).slice(0, 160)}`);
  }
  if (VERBOSE) {
    console.log(`    pass 1 reached ${reach} batches; dismissed every ${every}, ` +
      `${input.filter(e => e.includes(':png:')).length} captures ` +
      `(pass 2 reached ${reachedBatches(after)})`);
    console.log(`    shot: ${shot}`);
  }
  results.push({ id, verdict, answer, share, shot, boxes });
}

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

const bad = results.filter(r => ['crash', 'stuck', 'exits', 'modal-only'].includes(r.verdict));
console.log(`\n${results.length} apps: ` +
  ['clean', 'content', 'modal-only', 'exits', 'stuck', 'crash']
    .map(v => `${results.filter(r => r.verdict === v).length} ${v}`).join(', '));
process.exit(bad.length ? 1 : 0);
