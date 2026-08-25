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
//                 pass 2 (default 2000). A dlg-cmd with no dialog on screen is
//                 a no-op, so over-sending is free and beats guessing.
//   --answer=ID   force one command id instead of the per-type default
//   --no-build    reuse the existing build/wine-assembly.wasm
//
// Verdicts:
//   clean      no modal at startup
//   content    a modal, and real pixels behind it once dismissed
//   modal-only a modal, and the screen behind it is still empty
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
const DISMISS_EVERY = Math.max(200, parseInt(opt('dismiss-every', '2000'), 10) || 2000);
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
  const answer = ANSWER != null ? ANSWER : (DEFAULT_ANSWER[boxes[0].type & 0xF] ?? 1);
  const shot = path.join(SHOTS, `${id}.png`);
  const input = [];
  for (let b = DISMISS_EVERY; b < BATCHES; b += DISMISS_EVERY) {
    input.push(`${b}:dlg-cmd:${answer}`);
    if (b >= BATCHES - DISMISS_EVERY) break;
    if (input.length > 400) break;   // the tail of a long run is not worth the argv
  }
  const shotAt = Math.min(BATCHES - 1, DISMISS_EVERY * (input.length + 1));
  input.push(`${shotAt}:png:${shot}`);
  const after = runApp(id, input.join(','));
  const share = contentShare(shot);
  const stillModal = collectBoxes(after).length > 0 &&
    /\[input\] dlg-cmd: cmd=\d+ NO DIALOG/.test(after) === false;

  let verdict;
  if (/UNIMPLEMENTED API|CRASH|unreachable/.test(after)) verdict = 'crash';
  else if (share == null) verdict = 'stuck';
  else if (share > 0.02) verdict = 'content';
  else verdict = stillModal ? 'stuck' : 'modal-only';

  console.log(`${verdict}  (${boxes.length} box${boxes.length > 1 ? 'es' : ''}, ` +
    `answered ${answer}, ${share == null ? 'no shot' : (share * 100).toFixed(1) + '% painted'})`);
  for (const box of boxes) {
    console.log(`    "${box.caption}": ${JSON.stringify(box.text).slice(0, 160)}`);
  }
  if (VERBOSE) console.log(`    shot: ${shot}`);
  results.push({ id, verdict, answer, share, shot, boxes });
}

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

const bad = results.filter(r => r.verdict === 'crash' || r.verdict === 'stuck' || r.verdict === 'modal-only');
console.log(`\n${results.length} apps: ` +
  ['clean', 'content', 'modal-only', 'stuck', 'crash']
    .map(v => `${results.filter(r => r.verdict === v).length} ${v}`).join(', '));
process.exit(bad.length ? 1 : 0);
