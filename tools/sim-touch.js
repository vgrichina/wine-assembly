#!/usr/bin/env node
// Drive the booted iOS Simulator with real touches, in CSS pixels of the page.
//
// WHY THIS EXISTS: every phone bug in this project so far -- 100vh vs 100dvh,
// the swipe that will not retract Safari's toolbars, an app that cannot be
// relaunched after it quits -- is invisible to Chrome device emulation,
// because Chrome has no retractable toolbars and so vh and dvh are the same
// number there. The Simulator is the only thing on this machine that can show
// them, and it had no input: `simctl` has openurl and screenshot but no touch
// API whatsoever, and AppleScript's `click` cannot drag. So bugs got fixed by
// reading the code and reasoning, and shipped to a phone to find out.
//
//   node tools/sim-touch.js geometry
//   node tools/sim-touch.js open http://127.0.0.1:8080/index.html
//   node tools/sim-touch.js calibrate [--url=...]
//   node tools/sim-touch.js tap 195 300
//   node tools/sim-touch.js swipe 195 520 195 200 [--ms=400]
//   node tools/sim-touch.js shot out.png
//   node tools/sim-touch.js text 'hello'          (hardware keyboard)
//
// Coordinates are CSS pixels of the page, measured from the top-left of the
// VISUAL viewport -- what getBoundingClientRect() in the page would report.
// `calibrate` derives that mapping by photographing three markers of known
// spacing, so it needs no device dimensions and stays correct across window
// moves, window scale changes, and Safari chrome appearing or retracting.
//
// TWO SAFETY RULES, both learned the hard way. A synthetic click goes to
// whatever is frontmost, and an earlier attempt at this landed a click inside
// the terminal that launched it. So: nothing is ever posted unless Simulator
// is confirmed frontmost, and nothing is posted outside the Simulator
// window's own rectangle.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const BIN = path.join(BUILD, 'sim-touch');
const SRC = path.join(__dirname, 'sim-touch.swift');
const CAL = path.join(BUILD, 'sim-touch-cal.json');

function sh(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf-8', timeout: 120000, ...options });
}

function osa(script) {
  return sh('osascript', ['-e', script]).trim();
}

// ---------------------------------------------------------------- primitives

// Compiled once and cached. `swift file.swift` re-parses on every call, which
// is ~1.5s per event -- fatal for a swipe, which is one process per gesture.
function ensureBinary() {
  const fresh = fs.existsSync(BIN) &&
    fs.statSync(BIN).mtimeMs >= fs.statSync(SRC).mtimeMs;
  if (fresh) return BIN;
  fs.mkdirSync(BUILD, { recursive: true });
  sh('swiftc', ['-O', '-o', BIN, SRC]);
  return BIN;
}

function simulatorWindow() {
  const raw = osa('tell application "System Events" to tell process "Simulator" ' +
    'to return {position, size} of window 1');
  const numbers = raw.split(',').map(part => Number(part.trim()));
  if (numbers.length !== 4 || numbers.some(Number.isNaN)) {
    throw new Error(`could not read the Simulator window rect, got "${raw}"`);
  }
  const [x, y, width, height] = numbers;
  return { x, y, width, height };
}

// A synthetic event goes wherever the pointer is, into whatever is frontmost.
// Refuse rather than fire blind -- the failure mode is typing into someone
// else's window, which is both destructive and silent.
function requireFrontmost() {
  osa('tell application "Simulator" to activate');
  const deadline = Date.now() + 4000;
  for (;;) {
    const front = osa('tell application "System Events" to return name of first ' +
      'process whose frontmost is true');
    if (front === 'Simulator') return;
    if (Date.now() > deadline) {
      throw new Error(`Simulator did not come frontmost ("${front}" has focus) -- ` +
        'refusing to post events at another application');
    }
  }
}

function assertInsideWindow(points) {
  const w = simulatorWindow();
  for (const p of points) {
    if (p.x < w.x || p.y < w.y || p.x > w.x + w.width || p.y > w.y + w.height) {
      throw new Error(`point ${p.x},${p.y} is outside the Simulator window ` +
        `(${w.x},${w.y} ${w.width}x${w.height}) -- refusing to post it`);
    }
  }
}

function postEvent(args, points) {
  requireFrontmost();
  assertInsideWindow(points);
  sh(ensureBinary(), args.map(String));
}

// ---------------------------------------------------------------- calibration

// Screen points -> screenshot pixels is a Retina factor this reads off the
// image rather than assuming 2 (the Simulator window also carries its own
// scale, which the user can change from the Window menu at any time).
function captureWindow(outFile) {
  const w = simulatorWindow();
  sh('screencapture', ['-x', '-o', `-R${w.x},${w.y},${w.width},${w.height}`, outFile]);
  const png = PNG.sync.read(fs.readFileSync(outFile));
  return { png, rect: w, scale: png.width / w.width };
}

// Centroid of every pixel near a target colour. One blob per colour by
// construction, so a mean is enough and there is no need to segment.
function findMarker(png, target, tolerance = 60) {
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      if (Math.abs(png.data[i] - target[0]) <= tolerance &&
          Math.abs(png.data[i + 1] - target[1]) <= tolerance &&
          Math.abs(png.data[i + 2] - target[2]) <= tolerance) {
        sumX += x; sumY += y; count++;
      }
    }
  }
  if (count < 16) return null;
  return { x: sumX / count, y: sumY / count, count };
}

function calibrate(url) {
  sh('xcrun', ['simctl', 'openurl', 'booted', url]);
  execFileSync('/bin/sleep', ['3']);
  requireFrontmost();
  const shot = path.join(BUILD, 'sim-touch-cal.png');
  const { png, rect, scale } = captureWindow(shot);

  // Pure primaries, so nothing Safari draws can be mistaken for one. The
  // markers are 16px at CSS (0,0), (200,0) and (0,200); their centroids are
  // therefore (8,8), (208,8) and (8,208), so each delta is exactly 200.
  const origin = findMarker(png, [255, 0, 0]);
  const alongX = findMarker(png, [0, 255, 0]);
  const alongY = findMarker(png, [0, 0, 255]);
  if (!origin || !alongX || !alongY) {
    throw new Error('calibration markers not found in the Simulator window -- ' +
      `is ${url} actually open and fully loaded? (shot: ${shot})`);
  }

  const toScreen = point => ({
    x: rect.x + point.x / scale,
    y: rect.y + point.y / scale,
  });
  const o = toScreen(origin);
  const px = toScreen(alongX);
  const py = toScreen(alongY);
  const scaleX = (px.x - o.x) / 200;
  const scaleY = (py.y - o.y) / 200;
  if (!(scaleX > 0.05) || !(scaleY > 0.05)) {
    throw new Error(`implausible calibration: scale ${scaleX},${scaleY}`);
  }
  const cal = {
    // Screen point of CSS (0,0), backing the marker centroid out by its own
    // 8px offset.
    originX: o.x - 8 * scaleX,
    originY: o.y - 8 * scaleY,
    scaleX,
    scaleY,
    window: rect,
    capturedAt: new Date().toISOString(),
  };
  fs.mkdirSync(BUILD, { recursive: true });
  fs.writeFileSync(CAL, JSON.stringify(cal, null, 2));
  return cal;
}

function loadCalibration() {
  if (!fs.existsSync(CAL)) {
    throw new Error('no calibration yet -- run: node tools/sim-touch.js calibrate');
  }
  const cal = JSON.parse(fs.readFileSync(CAL, 'utf-8'));
  const now = simulatorWindow();
  if (now.x !== cal.window.x || now.y !== cal.window.y ||
      now.width !== cal.window.width || now.height !== cal.window.height) {
    throw new Error('the Simulator window moved or resized since calibration ' +
      `(was ${JSON.stringify(cal.window)}, now ${JSON.stringify(now)}) -- recalibrate`);
  }
  return cal;
}

const toScreenPoint = (cal, x, y) => ({
  x: cal.originX + Number(x) * cal.scaleX,
  y: cal.originY + Number(y) * cal.scaleY,
});

// ---------------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flag = (name, fallback) => {
    const hit = argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const positional = argv.slice(1).filter(a => !a.startsWith('--'));

  switch (command) {
    case 'geometry': {
      console.log(JSON.stringify(simulatorWindow()));
      break;
    }
    case 'open': {
      if (!positional[0]) throw new Error('usage: sim-touch open <url>');
      sh('xcrun', ['simctl', 'openurl', 'booted', positional[0]]);
      console.log('opened ' + positional[0]);
      break;
    }
    case 'calibrate': {
      const url = flag('url', 'http://127.0.0.1:8080/tools/sim-calibrate.html');
      const cal = calibrate(url);
      console.log(`origin ${cal.originX.toFixed(1)},${cal.originY.toFixed(1)} ` +
        `scale ${cal.scaleX.toFixed(4)},${cal.scaleY.toFixed(4)}`);
      break;
    }
    case 'tap': {
      const cal = loadCalibration();
      const p = toScreenPoint(cal, positional[0], positional[1]);
      postEvent(['tap', p.x.toFixed(1), p.y.toFixed(1)], [p]);
      console.log(`tapped css ${positional[0]},${positional[1]} ` +
        `-> screen ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
      break;
    }
    case 'swipe': {
      const cal = loadCalibration();
      const from = toScreenPoint(cal, positional[0], positional[1]);
      const to = toScreenPoint(cal, positional[2], positional[3]);
      const ms = Number(flag('ms', '400'));
      const steps = Number(flag('steps', '24'));
      postEvent(['swipe', from.x.toFixed(1), from.y.toFixed(1),
        to.x.toFixed(1), to.y.toFixed(1), ms, steps], [from, to]);
      console.log(`swiped css ${positional[0]},${positional[1]} -> ` +
        `${positional[2]},${positional[3]} over ${ms}ms`);
      break;
    }
    case 'text': {
      // The Simulator forwards the hardware keyboard when Connect Hardware
      // Keyboard is on, which is how a URL gets typed without a tap.
      requireFrontmost();
      const body = positional.join(' ').replace(/["\\]/g, '\\$&');
      osa(`tell application "System Events" to keystroke "${body}"`);
      break;
    }
    case 'shot': {
      const out = positional[0] || 'sim.png';
      sh('xcrun', ['simctl', 'io', 'booted', 'screenshot', '--type=png', out]);
      console.log('wrote ' + out);
      break;
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf-8')
        .split('\n').filter(l => l.startsWith('//')).join('\n'));
      process.exit(command ? 2 : 0);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message || error);
    process.exit(1);
  }
}

module.exports = { simulatorWindow, calibrate, loadCalibration, toScreenPoint };
