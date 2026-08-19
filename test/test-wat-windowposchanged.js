#!/usr/bin/env node

// SetWindowPos must tell the window it moved or resized.
//
// Win32 sends WM_WINDOWPOSCHANGED synchronously from inside SetWindowPos, and
// Delphi's VCL depends on exactly that. TWinControl.SetBounds does not cache
// the new size when the window has a handle -- it calls SetWindowPos and lets
// WM_WINDOWPOSCHANGED -> UpdateBounds -> GetWindowRect write FLeft/FTop/
// FWidth/FHeight back. Without the message those fields keep their creation
// values, so the next SetBounds passes a stale value for whichever dimension
// it is not changing and silently undoes the previous call.
//
// TetriNET's first-run message box is the cheapest place to see it. Delphi
// sizes it in two steps (width, then height) and then centres it, so the bug
// has a signature no pixel check can give you: the second call carries the
// creation width instead of the width the first call just set.
//
// The binary is a gitignored corpus fixture, so this reports SKIP when it has
// not been fetched.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'candidates', 'tetrinet', 'TETRINET.EXE');

// [API #8743] SetWindowPos(0x0001000c, 0x0, 0x0, 0x0, 0x18d, 0xf0, 0x14)
const SETWINDOWPOS = /SetWindowPos\(((?:0x[0-9a-f]+,\s*){6}0x[0-9a-f]+)\)/i;
const GETWINDOWRECT = /GetWindowRect\(hwnd=hwnd:(0x[0-9a-f]+)/i;

function parseCalls(output) {
  const calls = [];
  const rectReads = new Set();
  for (const line of output.split('\n')) {
    const rect = GETWINDOWRECT.exec(line);
    if (rect) rectReads.add(parseInt(rect[1], 16));
    const swp = SETWINDOWPOS.exec(line);
    if (!swp) continue;
    const [hwnd, , x, y, cx, cy, flags] = swp[1]
      .split(',').map(value => parseInt(value.trim(), 16));
    calls.push({ hwnd, x, y, cx, cy, flags });
  }
  return { calls, rectReads };
}

function main() {
  if (!fs.existsSync(EXE)) {
    console.log('SKIP WM_WINDOWPOSCHANGED: fetch with '
      + 'node tools/fetch-candidate-corpus.js --id=tetrinet');
    return;
  }

  const result = spawnSync('node', [RUN, `--exe=${EXE}`,
    '--max-batches=3000', '--batch-size=25000',
    '--trace-api=SetWindowPos,GetWindowRect'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.ok(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError/i.test(output),
    `TetriNET run failed\n${output.slice(-4000)}`);

  const { calls, rectReads } = parseCalls(output);
  assert.ok(calls.length > 0, 'no SetWindowPos calls were traced');

  // Group by window, in call order, and look for a window that was resized
  // more than once. That is the sequence the bug corrupts.
  const byWindow = new Map();
  for (const call of calls) {
    if (!byWindow.has(call.hwnd)) byWindow.set(call.hwnd, []);
    byWindow.get(call.hwnd).push(call);
  }

  const SWP_NOSIZE = 0x0001;
  let checked = 0;
  for (const [hwnd, sequence] of byWindow) {
    const sized = sequence.filter(call => !(call.flags & SWP_NOSIZE) && call.cx > 0);
    if (sized.length < 2) continue;
    // Delphi never shrinks a dialog back to its creation width mid-sequence.
    // Once a width is established, every later call in the run carries it
    // forward until the app deliberately changes it -- and it only changes it
    // upward here, as the text is measured.
    for (let i = 1; i < sized.length; i++) {
      assert.ok(sized[i].cx >= sized[i - 1].cx,
        `window ${hwnd.toString(16)} lost its width between SetWindowPos calls: `
        + `${sized[i - 1].cx} then ${sized[i].cx}. WM_WINDOWPOSCHANGED is not `
        + 'reaching the wndproc, so VCL is passing a stale cached width.');
    }
    assert.ok(rectReads.has(hwnd),
      `window ${hwnd.toString(16)} was resized ${sized.length} times but never `
      + 'read back with GetWindowRect; VCL UpdateBounds did not run, so the '
      + 'window was never told it changed');
    checked++;
  }

  assert.ok(checked > 0,
    'no window was resized twice; the fixture no longer exercises the bug');
  console.log(`PASS  WM_WINDOWPOSCHANGED reaches ${checked} resized window(s); `
    + 'widths survive consecutive SetWindowPos calls');
}

main();
