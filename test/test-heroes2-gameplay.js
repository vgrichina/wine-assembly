#!/usr/bin/env node
// Heroes of Might and Magic II all the way onto the adventure map.
//
// Everything this app exercises that nothing else does -- the 640x480x8
// DirectDraw primary it software-renders into, the palette cycling it runs
// every frame, and the Miles (MSS32) mixer that suspends the application
// thread from inside its own multimedia-timer callback -- only happens once a
// scenario is loaded. A test that stops at the main menu measures none of it,
// and the Miles self-suspend used to park the whole emulator ten batches past
// the menu, so this path was not reachable headlessly at all.
//
// The drive sequence is the real one a player performs:
//   NEW GAME -> STANDARD GAME -> OKAY on the scenario dialog (BROKENA.MP2).
//
// Plain `click` works here (unlike Caesar III): Heroes II takes the button
// down/up pair out of one PeekMessage pass.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(ROOT, 'test/binaries/candidates/heroes-2-demo/files/H2DEMOW.EXE');
const OUT = path.join(ROOT, 'build/heroes2-gameplay.png');

// `node test/test-heroes2-gameplay.js some.png` skips the run and only reports
// the region statistics for an existing capture -- that is how the thresholds
// below were separated from the menu screens.
const ANALYZE_ONLY = process.argv[2];

if (!ANALYZE_ONLY && !fs.existsSync(EXE)) { console.log('SKIP  Heroes II demo missing'); process.exit(0); }

const INPUT = [
  '400:click:535:225',   // NEW GAME on the main menu
  '700:click:528:68',    // STANDARD GAME
  '1200:click:283:373',  // OKAY on the scenario picker (Broken Alliance)
].join(',');

let stdout = '';
if (!ANALYZE_ONLY) {
  const cmd = `node "${RUN}" --app=heroes2_demo --batch-size=20000 --max-batches=2600`
    + ` --no-close --repaint-every=50 --quiet-api --trace-dx --input='${INPUT}' --png="${OUT}"`;
  console.log('$', cmd);
  try {
    stdout = execSync(cmd, { encoding: 'utf-8', timeout: 900000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = (e.stdout || '').toString() + (e.stderr || '').toString();
    console.error(out.split('\n').slice(-40).join('\n'));
    throw new Error('the Heroes II run did not finish');
  }
  assert.ok(fs.existsSync(OUT), 'the run wrote no PNG');
}

const png = PNG.sync.read(fs.readFileSync(ANALYZE_ONLY || OUT));
assert.strictEqual(png.width, 640, 'the presented frame must be the 640x480 display mode');
assert.strictEqual(png.height, 480);

function stats(x0, y0, x1, y1) {
  let green = 0, wood = 0, black = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (g > r + 12 && g > b + 12) green++;
      // The interface panels are carved wood: warm, and never green-dominant.
      if (r > 90 && r > g + 10 && g > b) wood++;
      if (r < 40 && g < 40 && b < 40) black++;
      total++;
    }
  }
  return { green: green / total, wood: wood / total, black: black / total };
}

// The adventure map view (left of the interface panel) and the panel itself.
const map = stats(24, 20, 440, 456);
const panel = stats(472, 180, 632, 456);
console.log(`map green ${(map.green * 100).toFixed(1)}%  black ${(map.black * 100).toFixed(1)}%  `
  + `panel wood ${(panel.wood * 100).toFixed(1)}%  green ${(panel.green * 100).toFixed(1)}%`);

// The starting position of Broken Alliance is grass and woodland inside an
// unexplored black shroud, so the map view is part terrain, part black. The
// menu screens this run passes through are a wood-framed castle painting and
// a beige dialog -- neither has a large green field next to a wooden panel.
assert.ok(map.green > 0.20,
  `the adventure map should show terrain, saw ${(map.green * 100).toFixed(1)}% green`);
assert.ok(map.black > 0.10,
  `the unexplored shroud should be black, saw ${(map.black * 100).toFixed(1)}%`);
assert.ok(panel.wood > 0.30,
  `the right-hand interface panel should be carved wood, saw ${(panel.wood * 100).toFixed(1)}%`);
assert.ok(map.green - panel.green > 0.15,
  'the map and the interface panel should not look like the same picture');

// The game presents a whole new 640x480 frame per animation tick, so a run
// that reaches the map keeps producing frames. Guarding the count catches a
// regression that leaves the last frame on screen while the game has stopped
// (the Miles self-suspend deadlock looked exactly like a correct still frame).
if (stdout) {
  const presents = (stdout.match(/\[dx\] Present/g) || []).length;
  console.log(`frames presented: ${presents}`);
  assert.ok(presents > 200, `the game should keep presenting frames, saw ${presents}`);
}

console.log('PASS  Heroes II reaches a playable adventure map');
