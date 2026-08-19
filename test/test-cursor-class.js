#!/usr/bin/env node
// The pointer shape must follow what it is over, not what the app last set.
//
// mspaint is the clearest case in the corpus because all four answers are
// different and all four are wrong in a different way if the plumbing breaks:
//
//   drawing canvas   the app's own pencil   (app answers WM_SETCURSOR/HTCLIENT)
//   tool palette     IDC_ARROW              (its class registered one)
//   scrollbars       IDC_ARROW              (HTHSCROLL/HTVSCROLL, not HTCLIENT)
//
// Regression this guards: nchittest used to report every scrollbar as HTCLIENT
// and DefWindowProc used to leave HTCLIENT alone, so the pencil stayed on all
// the way out over the bars and the tool buttons.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');

const IDC_ARROW = '0x67f00';
const PENCIL = '0x6804b6'; // mspaint's LoadCursor(hInst, 0x4b6)

const checks = [];
function check(name, actual, expected) {
  const pass = actual === expected;
  checks.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${actual}${pass ? '' : ` (expected ${expected})`}`);
}

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not present');
  process.exit(0);
}

// Alternate back to the canvas between probes: each hop has to flip the cursor
// back, which catches a cursor that is merely stuck as well as one that is wrong.
const CANVAS = '180:200';
const PALETTE = '45:73';
const HSCROLL = '180:331';
const input = [
  `400:mousemove:${CANVAS}`,
  `450:mousemove:${PALETTE}`,
  `500:mousemove:${CANVAS}`,
  `550:mousemove:${HSCROLL}`,
  `600:mousemove:${CANVAS}`,
].join(',');

let out = '';
try {
  out = execSync(
    `node "${RUN}" --exe="${EXE}" --max-batches=700 --trace-host=set_cursor --input=${input}`,
    // Generous on purpose: this box runs several agent sweeps at once, and a
    // spawn budget tuned to an idle machine reports every check as a failure.
    { encoding: 'utf-8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
} catch (e) {
  console.log(`FAIL  emulator run did not complete: ${e.message}`);
  process.exit(1);
}

// The cursor in force at each probe point is the last set_cursor logged before
// the *next* input line. The canvas appears three times, so the scan has to
// walk forward rather than search from the start each time.
const order = [CANVAS, PALETTE, CANVAS, HSCROLL, CANVAS];
const seen = [];
{
  const lines = out.split('\n');
  let idx = -1;
  for (const point of order) {
    idx = lines.findIndex((l, i) => i > idx && l.includes(`[input] mousemove ${point.replace(':', ',')}`));
    let cur = null;
    for (let i = idx + 1; i < lines.length; i++) {
      if (lines[i].includes('[input] mousemove')) break;
      const m = lines[i].match(/\[host\] set_cursor\((0x[0-9a-f]+)\)/);
      if (m) cur = m[1];
    }
    seen.push(cur || 'none');
  }
}

check('drawing canvas gets the app tool cursor', seen[0], PENCIL);
check('tool palette gets the class cursor', seen[1], IDC_ARROW);
check('leaving the palette restores the tool cursor', seen[2], PENCIL);
check('horizontal scrollbar gets the arrow', seen[3], IDC_ARROW);
check('leaving the scrollbar restores the tool cursor', seen[4], PENCIL);
check('no unimplemented API on the cursor path',
  out.includes('UNIMPLEMENTED') || out.includes('CRASH'), false);

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
