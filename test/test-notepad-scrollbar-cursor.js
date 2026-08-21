#!/usr/bin/env node
// Hovering a WAT-native edit's scrollbars must show the arrow, not the I-beam.
//
// The bug: $defwndproc_do_nccalcsize deliberately does not carve the 16px
// scrollbar strips out of a WAT-native control's client rect -- the control
// measures and paints them itself -- so every pixel of both bars hit-tests as
// HTCLIENT. The edit's WM_SETCURSOR saw HTCLIENT and set IDC_IBEAM for the
// whole window, so notepad showed the text cursor while you were pointing at
// its scrollbar.
//
// The assertion reads the cursor handle the guest actually applied, traced off
// the host set_cursor import, rather than any pixel.
//
//   node test/test-notepad-scrollbar-cursor.js

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOTEPAD = path.join(ROOT, 'test', 'binaries', 'notepad.exe');
const RUN_JS = path.join(ROOT, 'test', 'run.js');

const IDC_ARROW = 0x67f00;
const IDC_IBEAM = 0x67f01;

// Notepad's default 640x480 window: the edit client fills it out to a vertical
// strip near x=408 and a horizontal strip near y=310.
const HOVERS = [
  { label: 'text area',        x: 200, y: 180, want: IDC_IBEAM },
  { label: 'vertical bar',     x: 408, y: 180, want: IDC_ARROW },
  { label: 'horizontal bar',   x: 200, y: 310, want: IDC_ARROW },
  { label: 'text area again',  x: 200, y: 180, want: IDC_IBEAM },
];

function main() {
  const input = HOVERS
    .map((h, i) => `${2000 + i * 100}:mousemove:${h.x}:${h.y}`)
    .join(',');

  const out = execFileSync('node', [
    RUN_JS, '--exe=' + NOTEPAD, '--max-batches=3000', '--quiet-api',
    '--trace-host=set_cursor',
    '--input=' + input,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

  // Walk the log in order: each mousemove marker, then the next set_cursor
  // after it is the cursor that hover produced. A hover that changes nothing
  // emits no call, so it inherits the previous cursor.
  const lines = out.split('\n');
  const got = [];
  let current = null;
  let pending = -1;
  for (const line of lines) {
    const mv = line.match(/\[input\] mousemove (\d+),(\d+)/);
    if (mv) {
      if (pending >= 0) got[pending] = current;
      pending = got.length;
      got.push(current);
      continue;
    }
    const sc = line.match(/\[host\] set_cursor\(0x([0-9a-f]+)\)/);
    if (sc) current = parseInt(sc[1], 16);
  }
  if (pending >= 0) got[pending] = current;

  const failures = [];
  if (got.length !== HOVERS.length) {
    failures.push(`expected ${HOVERS.length} hovers in the log, saw ${got.length} — ` +
      `did the input schedule change?`);
  }
  HOVERS.forEach((h, i) => {
    const cur = got[i];
    const name = c => (c === IDC_ARROW ? 'IDC_ARROW'
      : c === IDC_IBEAM ? 'IDC_IBEAM'
      : c == null ? 'none' : '0x' + c.toString(16));
    console.log(`hover ${h.label.padEnd(16)} (${h.x},${h.y})  cursor=${name(cur)}`);
    if (cur !== h.want) {
      failures.push(`hovering the ${h.label} gave ${name(cur)}, expected ${name(h.want)}`);
    }
  });

  if (failures.length) {
    for (const f of failures) console.log(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log('PASS  the scrollbar strips show the arrow and the text area shows the I-beam');
}

main();
