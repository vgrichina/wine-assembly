#!/usr/bin/env node
// Caesar III all the way into a running city, not just to a title screen.
//
// Everything interesting about this app — the 800x600x16 DirectDraw frame it
// software-renders itself, the cursor scaling, the sidebar UI — only happens
// once a mission is actually loaded, so a test that stops at the main menu
// measures none of it. This drives the real sequence: title -> main menu ->
// "Start new game" -> the name prompt -> the assignment briefing -> the city.
//
// Two things make that scriptable at all:
//   * The clicks must be a mousedown, a gap of batches, then a mouseup. The
//     game samples the button state once per frame out of its wndproc, so a
//     `click` (down and up in the same batch) is drained by a single
//     PeekMessage pass and the game never sees a pressed button.
//   * The host screen is set to 800x600 so cursor positions need no scaling;
//     the game builds its client rect from SM_CXSCREEN/SM_CYSCREEN.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(ROOT, 'test/binaries/candidates/caesar-3-demo/installed/c3.exe');
const OUT = path.join(ROOT, 'build/caesar3-gameplay.png');

// `node test/test-caesar3-gameplay.js some.png` skips the run and just reports
// the region statistics for an existing capture — that is how the thresholds
// below were separated from the main menu and the briefing screens.
const ANALYZE_ONLY = process.argv[2];

if (!ANALYZE_ONLY && !fs.existsSync(EXE)) { console.log('SKIP  Caesar III demo missing'); process.exit(0); }

// batch -> what the player does. The gaps are generous because each screen
// loads its own .555 graphics before it will accept the next click.
const INPUT = [
  '700:mousemove:400:300', '760:mousedown:400:300', '800:mouseup:400:300',      // dismiss the title
  '1000:mousemove:400:172', '1040:mousedown:400:172', '1080:mouseup:400:172',   // "Start new game"
  '1500:mousemove:548:320', '1540:mousedown:548:320', '1580:mouseup:548:320',   // name prompt "Continue"
  '2600:mousemove:613:502', '2640:mousedown:613:502', '2680:mouseup:613:502',   // briefing "To the city"
].join(',');

const cmd = ANALYZE_ONLY ? null : `node "${RUN}" --app=caesar3_demo --screen=800x600 --batch-size=50000`
  + ` --max-batches=3400 --repaint-every=50 --input='${INPUT}' --png="${OUT}"`;
if (cmd) {
  console.log('$', cmd);
  try {
    // Measures 9s -- the slowest of the gameplay drives, and still nowhere near
    // the 900s that used to sit here. A cap this far above the real cost cannot
    // tell a hang from a slow box, which is the only thing a cap is for.
    // maxBuffer, because the default is 1MB and this drive prints just over
    // it: 3400 batches of unfiltered [API] lines came to 1054671 bytes, so the
    // run was being killed at batch 3380 every time and reported as a hang.
    // The cap is on the log, not on the emulator, so it must not be able to
    // decide the test.
    execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT,
      maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = (e.stdout || '').toString() + (e.stderr || '').toString();
    console.error(out.split('\n').slice(-40).join('\n'));
    throw new Error('the Caesar III run did not finish');
  }
  assert.ok(fs.existsSync(OUT), 'the run wrote no PNG');
}

const png = PNG.sync.read(fs.readFileSync(ANALYZE_ONLY || OUT));
assert.strictEqual(png.width, 800, 'the presented frame must be the 800x600 display mode');
assert.strictEqual(png.height, 600);

// Region statistics, over the frame the game presented. `green` is terrain,
// `dark` is the stone chrome the city view puts along the top.
function stats(x0, y0, x1, y1) {
  let green = 0, dark = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (g > r + 8 && g > b + 8) green++;
      if (r < 90 && g < 90 && b < 90) dark++;
      total++;
    }
  }
  return { green: green / total, dark: dark / total };
}

const map = stats(0, 30, 590, 590);
const sidebar = stats(610, 60, 790, 470);
const topBar = stats(0, 2, 800, 16);
console.log(`map green ${(map.green * 100).toFixed(1)}%  `
  + `sidebar green ${(sidebar.green * 100).toFixed(1)}%  `
  + `top bar dark ${(topBar.dark * 100).toFixed(1)}%`);

// The terrain the mission starts on is grass and woodland: overwhelmingly
// green. Measured on the screens this run passes through, the map area is
// 57% green in the city and at most 10% anywhere else — the main menu is a
// photographed cityscape behind a slab of grey buttons (10.2%), the briefing
// is a beige panel (2.2%), the title is black (5.2%).
assert.ok(map.green > 0.35,
  `the city map area should be mostly green terrain, saw ${(map.green * 100).toFixed(1)}%`);
// The right-hand control panel is carved stone, so it is the one part of the
// city view that is NOT terrain. The gap between the two regions is what says
// "the city is up" rather than "some other green screen is up".
assert.ok(sidebar.green < 0.20,
  `the control panel should not be terrain, saw ${(sidebar.green * 100).toFixed(1)}% green`);
assert.ok(map.green - sidebar.green > 0.3,
  'the map and the control panel should not look like the same picture');

console.log('PASS  Caesar III reaches a playable city view');
