#!/usr/bin/env node
// agent-seq.js — run a timed sequence of agent-control steps as ONE shell
// command, so a game-driver agent spends its turns on decisions, not on
// plumbing.
//
//   node tools/agent-seq.js SESSION step [step...]
//
// Outputs (journals, frame pngs, zooms) land in $SEQ_DIR, default
// <repo>/tmp/agent-seq — NOT next to this script. $SEQ_HUB retargets the hub
// (default http://127.0.0.1:8080), same value ctl.js --hub takes.
//
// Generic steps (colon syntax, passed through to ctl; X/Y are PNG pixels
// read off your own screenshot):
//   click:X:Y  dblclick:X:Y  rclick:X:Y  mousemove:X:Y  wheel:X:Y:DELTA
//   keydown:VK  keyup:VK  keypress:CODE
//   drag:X1:Y1:X2:Y2       press at 1, glide in steps, release at 2 —
//                          RCT path laying, scrollbars, map panning
//   sleep:MS               local pause between steps
//   step:N[:MS]            frozen mode: run N guest slices (falls back to a
//                          local sleep on a live session)
//   png:PATH               screenshot to PATH (also implied at the end)
//   zoom:X:Y:W:H           after the closing screenshot, also write a 4x
//                          upscale of that region to <scratchpad>/seq-zoom.png
//                          — read THAT when the UI text is too small to trust
//
// Verdict steps (each prints a one-line verdict AND appends it to
// <scratchpad>/journal-SESSION.txt, so a respawned driver can read the
// journal and resume with full history):
//   act:X:Y[:N]            click + step N (default 400) + diff the frame:
//                          "act ... CHANGED box=..." or "act ... NO-CHANGE".
//                          On change, a 4x zoom of the changed region is
//                          written to seq-zoom-SESSION.png automatically.
//   settle[:CAP]           step in 200-slice chunks until two consecutive
//                          frames are identical (animation finished);
//                          CAP slices max, default 4000
//   until[:CAP]            step until the frame CHANGES from what it is now
//                          (waiting for a dialog / enemy turn); default 4000
//   grid                   with the closing screenshot, also write
//                          seq-grid-SESSION.png with coordinate lines every
//                          50px and labels every 100px — read coords off it
//
// FreeCell steps (MS FreeCell window at canvas top-left; targets are computed
// from the live frame, so no pixel estimating). Each behaves like act: —
// click + step + CHANGED/NO-CHANGE verdict:
//   fccol:N     click the EXPOSED (bottom) card of column N (1..8) — the y
//               is found by scanning the frame for the column's lowest card
//               pixels; on an empty column, clicks the empty slot (a drop)
//   fccard:N:K  click the card at depth K from the TOP of column N (its
//               index strip) — for starting a run mid-column
//   fccell:N    click free cell N (1..4, top-left row)
//   fcfound:N   click foundation N (1..4, top-right row)
//
// DX-Ball reflex layer (frozen sessions only — needs step:):
//   dxrally:N[:SLICE]  play up to N reflex cycles: screenshot, find the
//               moving ball by frame-diff, predict its paddle-line intercept
//               (reflected off the side walls), mousemove the paddle there,
//               advance SLICE frames (default 4 ≈ 64ms of game time), repeat.
//               Stops early after 5 motionless cycles (menu / ball lost /
//               ball glued to paddle) and says so. Pixels only — the same
//               feed a human gets, sampled every ~64ms instead of 300ms+.
//
// Premade Heroes II macros — fixed UI, no screenshot analysis needed. These
// are defined in GUEST screen coordinates (640x480) and converted through
// the canvas's current size (asked via snapshot), so they survive the canvas
// changing dimensions between window layouts:
//   move:X:Y     mousemove, 800ms, click, 1500ms, click — path + confirm walk
//                (X,Y are PNG pixels of the destination from your screenshot)
//   turn         end turn: hourglass, 1200ms, YES on the confirm
//   hero         select the hero: click the top portrait slot in the sidebar
//   auto         battle: hand the fight to the computer (AUTO, then YES)
//   skipb        battle: SKIP the current unit's action
//
// Every run finishes with a screenshot to <scratchpad>/seq-last-SESSION.png
// (zoom goes to seq-zoom-SESSION.png) unless a png: step already ran, so the
// caller always gets a fresh frame to Read. Outputs are per-session because
// parallel drivers sharing one filename read each other's games.

'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CTL = path.join(ROOT, 'tools', 'ctl.js');
const HERE = process.env.SEQ_DIR || path.join(ROOT, 'tmp', 'agent-seq');
fs.mkdirSync(HERE, { recursive: true });
const { diffPng, readPng } = require(path.join(ROOT, 'tools', 'png-diff.js'));
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));

const argv = process.argv.slice(2).filter(a => a !== '--dry');
const DRY = process.argv.includes('--dry'); // print expanded steps, touch nothing
const [session, ...steps] = argv;
if (!session || !steps.length) {
  console.error('usage: node seq.js [--dry] SESSION step [step...]   (see header for steps)');
  process.exit(2);
}

const HUB_ARGS = process.env.SEQ_HUB ? [`--hub=${process.env.SEQ_HUB}`] : [];
const ctl = (...args) => execFileSync('node', [CTL, '-s', session, ...HUB_ARGS, ...args],
  { encoding: 'utf-8', timeout: 30000, cwd: ROOT });

// One line per action into journal-SESSION.txt: a respawned driver reads
// this to inherit its predecessor's history instead of a hand-written recap.
const JOURNAL = path.join(HERE, `journal-${session}.txt`);
const log = (line) => {
  console.log(line);
  try { fs.appendFileSync(JOURNAL, `${new Date().toISOString()} ${line}\n`); } catch (_) {}
};

// Run N guest slices on a frozen session; a live session has no step verb,
// so degrade to letting wall time pass instead.
let liveFallback = false;
const stepGuest = (n, ms) => {
  if (!liveFallback) {
    try { ctl('cmd', ms ? `step:${n}:${ms}` : `step:${n}`); return; }
    catch (_) { liveFallback = true; }
  }
  const end = Date.now() + Math.min(n * (ms || 1) + 300, 4000);
  while (Date.now() < end) { /* live session: wall time is guest time */ }
};

const shot = (file) => { ctl('png', file); return file; };
const frameA = path.join(HERE, `seq-a-${session}.png`);
const frameB = path.join(HERE, `seq-b-${session}.png`);

const zoomTo = (src, out, x, y, w, h, scale) => {
  const img = readPng(src);
  const zx = Math.max(0, x | 0), zy = Math.max(0, y | 0);
  const zw = Math.min(img.width - zx, Math.max(1, w | 0));
  const zh = Math.min(img.height - zy, Math.max(1, h | 0));
  const s = scale || 4;
  const dst = new PNG({ width: zw * s, height: zh * s });
  for (let oy = 0; oy < zh * s; oy++) {
    for (let ox = 0; ox < zw * s; ox++) {
      const si = (((zy + (oy / s | 0)) * img.width) + zx + (ox / s | 0)) * 4;
      const di = (oy * zw * s + ox) * 4;
      dst.data[di] = img.data[si]; dst.data[di + 1] = img.data[si + 1];
      dst.data[di + 2] = img.data[si + 2]; dst.data[di + 3] = 255;
    }
  }
  fs.writeFileSync(out, PNG.sync.write(dst));
};

// 3x5 digit font for grid labels — enough to read a coordinate off the image.
const DIGITS = {
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 7, 1, 7],
  4: [5, 5, 7, 1, 1], 5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2],
  8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7],
};
const drawNum = (img, num, x, y) => {
  let cx = x;
  for (const ch of String(num)) {
    const rows = DIGITS[ch]; if (!rows) { cx += 4; continue; }
    for (let ry = 0; ry < 5; ry++) for (let rx = 0; rx < 3; rx++) {
      if (!(rows[ry] & (4 >> rx))) continue;
      const px = cx + rx, py = y + ry;
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const i = (py * img.width + px) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 0; img.data[i + 3] = 255;
    }
    cx += 4;
  }
};
// MS FreeCell geometry (measured off the live tile): 8 column centers, card
// stack pitch, and the fixed top-row slots. The exposed card of a column is
// FOUND, not assumed: scan the column's x band bottom-up for the first row
// with enough non-felt pixels (cards are white faces or inverse-video blue
// when selected; the felt is saturated green).
const FC = {
  cols: [65, 141, 220, 299, 377, 456, 535, 611],
  topY: 170, dy: 18.5, feltBottom: 470, cardH: 97,
  cells: [[59, 108], [130, 108], [200, 108], [271, 108]],
  founds: [[405, 108], [476, 108], [547, 108], [618, 108]],
};
const isFelt = (d, i) => d[i] < 90 && d[i + 1] > 100 && d[i + 2] < 90;
const fcColTarget = (img, col) => {
  const xc = FC.cols[col - 1];
  for (let y = FC.feltBottom; y >= FC.topY; y--) {
    let hits = 0;
    for (let x = xc - 25; x <= xc + 25; x++) {
      if (!isFelt(img.data, (y * img.width + x) * 4)) hits++;
    }
    if (hits > 20) return [xc, Math.max(FC.topY, y - (FC.cardH >> 1) + 8)];
  }
  return [xc, FC.topY + 10]; // empty column: click the slot itself
};
const gridTo = (src, out) => {
  const img = readPng(src);
  const mark = (x, y, strong) => {
    const i = (y * img.width + x) * 4;
    if (strong) { img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 255; }
    else {
      img.data[i] = (img.data[i] + 255) >> 1; img.data[i + 1] >>= 1;
      img.data[i + 2] = (img.data[i + 2] + 255) >> 1;
    }
  };
  for (let x = 50; x < img.width; x += 50) {
    const strong = x % 100 === 0;
    for (let y = 0; y < img.height; y++) mark(x, y, strong && y % 2 === 0);
  }
  for (let y = 50; y < img.height; y += 50) {
    const strong = y % 100 === 0;
    for (let x = 0; x < img.width; x++) mark(x, y, strong && x % 2 === 0);
  }
  for (let x = 100; x < img.width; x += 100) drawNum(img, x, x + 2, 2);
  for (let y = 100; y < img.height; y += 100) drawNum(img, y, 2, y + 2);
  fs.writeFileSync(out, PNG.sync.write(img));
};
const writeGrid = gridTo;

const sleep = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* keep it one process; sequences are short */ }
};

// The canvas aspect-fits the 640x480 guest screen; macros are authored in
// guest coordinates and mapped through the canvas's size at run time.
let g2p = null;
const guest2png = (gx, gy) => {
  if (!g2p) {
    const snap = JSON.parse(ctl('snapshot'));
    const w = snap.screen && snap.screen.w || 640;
    const h = snap.screen && snap.screen.h || 480;
    const scale = Math.min(w / 640, h / 480);
    g2p = { scale, ox: (w - 640 * scale) / 2, oy: (h - 480 * scale) / 2 };
  }
  return [Math.round(g2p.ox + gx * g2p.scale), Math.round(g2p.oy + gy * g2p.scale)];
};

const expand = (step) => {
  const [kind, a, b] = step.split(':');
  if (kind === 'move') {
    return [`mousemove:${a}:${b}`, 'sleep:800', `click:${a}:${b}`, 'sleep:1500', `click:${a}:${b}`];
  }
  if (kind === 'turn') {
    const [hx, hy] = guest2png(499, 374);   // hourglass button
    const [yx, yy] = guest2png(258, 191);   // YES on the confirm dialog
    return [`click:${hx}:${hy}`, 'sleep:1200', `click:${yx}:${yy}`];
  }
  if (kind === 'hero') {
    const [px, py] = guest2png(508, 193);   // top portrait slot
    return [`click:${px}:${py}`];
  }
  if (kind === 'auto') {
    const [ax, ay] = guest2png(20, 447);    // AUTO button, battle bottom-left
    const [yx, yy] = guest2png(273, 291);   // YES on "give control to computer?"
    return [`click:${ax}:${ay}`, 'sleep:1000', `click:${yx}:${yy}`, 'sleep:4000'];
  }
  if (kind === 'skipb') {
    const [sx, sy] = guest2png(610, 462);   // SKIP button, battle bottom-right
    return [`click:${sx}:${sy}`, 'sleep:800'];
  }
  if (kind === 'drag') {
    const [, x1, y1, x2, y2] = step.split(':').map(Number);
    return dragSteps(x1, y1, x2, y2);
  }
  return [step];
};

// drag:X1:Y1:X2:Y2 — a real press-glide-release, interpolated so apps that
// sample the cursor per frame (RCT's path tool) see a continuous stroke.
const dragSteps = (x1, y1, x2, y2) => {
  const out = [`mousemove:${x1}:${y1}`, 'sleep:150', `mousedown:${x1}:${y1}`];
  const n = 6;
  for (let i = 1; i <= n; i++) {
    const x = Math.round(x1 + ((x2 - x1) * i) / n);
    const y = Math.round(y1 + ((y2 - y1) * i) / n);
    out.push(`mousemove:${x}:${y}`, 'sleep:80');
  }
  out.push(`mouseup:${x2}:${y2}`, 'sleep:300');
  return out;
};

// Heroes II scrolls the map continuously while the cursor sits in the outer
// few pixels of the screen, and synthetic input leaves the cursor parked at
// the last click — so a move near the viewport edge sets the map drifting
// until the next command. Park the cursor at screen center after every
// sequence, like a resting hand, before the closing screenshot.
const park = () => { ctl('cmd', 'mousemove:240:240'); };

if (DRY) {
  for (const step of steps.flatMap(expand)) console.log(step);
  process.exit(0);
}

// Per-session output files: two drivers run in parallel, and a shared
// seq-last.png let one driver read the OTHER game's frame (a Heroes agent
// reported seeing "a theme park constructor").
let tookPng = false;
let lastPng = path.join(HERE, `seq-last-${session}.png`);
let zoomRegion = null;
let wantGrid = false;
const zoomOut = path.join(HERE, `seq-zoom-${session}.png`);
for (const step of steps.flatMap(expand)) {
  const [kind, a] = step.split(':');
  if (kind === 'sleep') { sleep(parseInt(a, 10) || 0); continue; }
  if (kind === 'step') {
    const [, n, ms] = step.split(':').map(Number);
    stepGuest(n || 400, ms);
    log(`did ${step}`);
    continue;
  }
  if (kind === 'zoom') {
    const [, zx, zy, zw, zh] = step.split(':').map(Number);
    zoomRegion = [zx, zy, zw, zh];
    continue;
  }
  if (kind === 'grid') { wantGrid = true; continue; }
  const doAct = (x, y, n, label) => {
    shot(frameA);
    ctl('click', `${x},${y}`);
    stepGuest(n || 400);
    park();
    shot(frameB);
    fs.copyFileSync(frameB, lastPng);
    tookPng = true;
    const d = diffPng(frameA, frameB, { tolerance: 4 });
    if (d.sizeMismatch || !d.box) {
      log(`${label} NO-CHANGE (click+${n || 400} steps moved no pixels — wrong spot, or needs more steps)`);
    } else {
      zoomTo(frameB, zoomOut, d.box.x - 8, d.box.y - 8, d.box.w + 16, d.box.h + 16,
        d.box.w > 300 ? 2 : 4);
      log(`${label} CHANGED box=${d.box.x},${d.box.y} ${d.box.w}x${d.box.h}`
        + ` share=${(d.share * 100).toFixed(1)}% — changed region zoomed to ${zoomOut}`);
    }
  };
  if (kind === 'act') {
    const [, x, y, n] = step.split(':').map(Number);
    doAct(x, y, n, `act:${x}:${y}`);
    continue;
  }
  if (kind === 'fccol' || kind === 'fccard' || kind === 'fccell' || kind === 'fcfound') {
    const [, a1, a2] = step.split(':').map(Number);
    let x, y;
    if (kind === 'fccol') {
      [x, y] = fcColTarget(readPng(shot(frameA)), a1);
    } else if (kind === 'fccard') {
      x = FC.cols[a1 - 1]; y = Math.round(FC.topY + (a2 - 1) * FC.dy + 8);
    } else if (kind === 'fccell') {
      [x, y] = FC.cells[a1 - 1];
    } else {
      [x, y] = FC.founds[a1 - 1];
    }
    doAct(x, y, 400, `${step} -> (${x},${y})`);
    continue;
  }
  if (kind === 'dxrally') {
    // Reflex loop for frozen breakout: the strategic driver was stepping
    // 10-21 frames blind between looks (160-336ms of ball flight — a whole
    // screen crossing), losing rallies to sampling, not judgment. This
    // samples every SLICE frames and does only the reflex part.
    const [, nArg, sliceArg] = step.split(':').map(Number);
    const cycles = Math.max(1, nArg || 200);
    const slice = Math.max(1, sliceArg || 4);
    const PADDLE_Y = 437;          // where the paddle rides (mouse y)
    // Scan from y=24 so a ball skimming the top wall stays visible (a driver
    // lost rallies to "no motion" with the old TOP=36); the HUD corners
    // (score left, lives right) are skipped in the loop instead.
    const TOP = 24, BOT = 418;     // play area scanned for the ball
    const L = 4, R = 636;          // side walls for reflection
    // Changed-pixel clusters between two frames, bucketed into 8px cells and
    // merged. At slice=4 the ball travels ~16px, so its old- and new-position
    // blobs usually merge into ONE component — the position that matters is
    // the centroid of the pixels that are BRIGHT AND GREY in the current
    // frame (the ball is a white/grey sphere on black; its old-position half
    // of the diff shows dark background, so this picks the new spot whether
    // or not the blobs merged). Bricks/pills are saturated colors and fail
    // the greyness test; a vanishing brick is bright in prev, not cur.
    const findBall = (a, b, near) => {
      const W = b.width, CS = 8;
      const cw = Math.ceil(W / CS), cells = new Map();
      for (let y = TOP; y < BOT; y++) {
        for (let x = L; x < R; x++) {
          if (y < 36 && (x < 120 || x > 520)) continue; // HUD corners animate
          const i = (y * W + x) * 4;
          const d = Math.abs(a.data[i] - b.data[i])
            + Math.abs(a.data[i + 1] - b.data[i + 1])
            + Math.abs(a.data[i + 2] - b.data[i + 2]);
          if (d < 90) continue;
          const r = b.data[i], g = b.data[i + 1], bl = b.data[i + 2];
          const grey = Math.max(Math.abs(r - g), Math.abs(g - bl)) < 60
            && (r + g + bl) > 300;
          const key = (y / CS | 0) * cw + (x / CS | 0);
          const c = cells.get(key)
            || { n: 0, bn: 0, bsx: 0, bsy: 0, x0: x, y0: y, x1: x, y1: y };
          c.n++;
          if (grey) { c.bn++; c.bsx += x; c.bsy += y; }
          if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
          if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
          cells.set(key, c);
        }
      }
      if (!cells.size) return null;
      // merge 8-adjacent occupied cells into components
      const seen = new Set(), comps = [];
      for (const key of cells.keys()) {
        if (seen.has(key)) continue;
        const comp = { n: 0, bn: 0, bsx: 0, bsy: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
        const stack = [key];
        while (stack.length) {
          const k = stack.pop();
          if (seen.has(k) || !cells.has(k)) continue;
          seen.add(k);
          const c = cells.get(k);
          comp.n += c.n; comp.bn += c.bn; comp.bsx += c.bsx; comp.bsy += c.bsy;
          comp.x0 = Math.min(comp.x0, c.x0); comp.y0 = Math.min(comp.y0, c.y0);
          comp.x1 = Math.max(comp.x1, c.x1); comp.y1 = Math.max(comp.y1, c.y1);
          const cx = k % cw, cy = (k / cw) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (dx || dy) stack.push((cy + dy) * cw + cx + dx);
          }
        }
        comps.push(comp);
      }
      // bbox cap 40: ball (~10px) plus up to a slice of travel, merged.
      // A destroyed brick row or a repaint sweep is far wider and drops out.
      // bn >= 8: sparkle debris from a brick hit is ~4px of bright grey, the
      // ball is ~60. But a SLOW ball barely clears its own footprint in one
      // slice — only a thin crescent changes — so near the last known
      // position a small mass still counts. Without a previous position take
      // the LOWEST candidate — debris up in the field can't cost a life.
      const balls = comps
        .filter(c => (c.x1 - c.x0) <= 40 && (c.y1 - c.y0) <= 40 && c.bn >= 3
          && (c.bn >= 8 || (near
            && Math.hypot(c.bsx / c.bn - near.x, c.bsy / c.bn - near.y) <= 40)))
        .map(c => ({ x: c.bsx / c.bn, y: c.bsy / c.bn, n: c.bn }));
      if (!balls.length) return null;
      if (near) balls.sort((p, q) =>
        Math.hypot(p.x - near.x, p.y - near.y) - Math.hypot(q.x - near.x, q.y - near.y));
      else balls.sort((p, q) => q.y - p.y);
      return balls[0];
    };
    const reflect = (x) => {
      const span = (R - 12) - (L + 12);
      let t = (x - (L + 12)) % (2 * span);
      if (t < 0) t += 2 * span;
      return (L + 12) + (t <= span ? t : 2 * span - t);
    };
    let prev = readPng(shot(frameA));
    let ball = null, moves = 0, i = 0, still = 0, verdict = '';
    for (; i < cycles; i++) {
      stepGuest(slice, 16);
      const cur = readPng(shot(frameB));
      const found = findBall(prev, cur, ball);
      if (!found) {
        if (++still >= 5) { verdict = `no motion for ${still} cycles — menu, ball on paddle, or life lost`; i++; break; }
      } else {
        still = 0;
        let target = found.x;
        if (ball) {
          const vx = (found.x - ball.x) / slice, vy = (found.y - ball.y) / slice;
          if (vy > 0.4 && vy < 20 && Math.abs(vx) < 20) {
            const raw = found.x + vx * ((PADDLE_Y - 8 - found.y) / vy);
            // More than one wall's worth of travel means the prediction is
            // extrapolating noise (a driver saw ball=564 -> paddle 48);
            // shadow the ball instead of trusting a multi-bounce guess.
            target = Math.abs(raw - found.x) > (R - L) ? found.x : reflect(raw);
          }
        }
        ctl('cmd', `mousemove:${Math.round(target)}:${PADDLE_Y}`);
        moves++;
        ball = found;
        if (i % 25 === 24) log(`dxrally c=${i + 1} ball=${found.x | 0},${found.y | 0} -> paddle ${Math.round(target)}`);
      }
      prev = cur;
      fs.copyFileSync(frameB, frameA); // keep the on-disk pair in sync for post-mortems
    }
    fs.copyFileSync(frameB, lastPng);
    tookPng = true;
    log(`dxrally DONE ${i} cycles (${i * slice} frames ≈ ${(i * slice * 16 / 1000).toFixed(1)}s game time), `
      + `${moves} paddle moves${ball ? `, last ball ${ball.x | 0},${ball.y | 0}` : ''}`
      + (verdict ? ` — ${verdict}` : ' — cycle budget spent, rally may continue'));
    continue;
  }
  if (kind === 'settle' || kind === 'until') {
    const cap = parseInt(a, 10) || 4000;
    const chunk = 200;
    shot(frameA);
    let ran = 0, verdict = `${kind} CAP ${cap} reached`;
    while (ran < cap) {
      stepGuest(chunk); ran += chunk;
      shot(frameB);
      const d = diffPng(frameA, frameB, { tolerance: 4 });
      const same = !d.sizeMismatch && !d.box;
      if (kind === 'settle' && same) { verdict = `settle STABLE after ${ran} steps`; break; }
      if (kind === 'until' && !same) {
        verdict = `until CHANGED after ${ran} steps (box=${d.box.x},${d.box.y} ${d.box.w}x${d.box.h})`;
        break;
      }
      if (kind === 'settle') fs.copyFileSync(frameB, frameA);
    }
    fs.copyFileSync(frameB, lastPng);
    tookPng = true;
    log(verdict);
    continue;
  }
  if (kind === 'png') {
    park();
    lastPng = a || path.join(HERE, `seq-last-${session}.png`);
    ctl('png', lastPng);
    tookPng = true;
    log(`png ${lastPng}`);
    continue;
  }
  if (kind === 'park') { park(); log('did park'); continue; }
  if (kind === 'click' || kind === 'dblclick' || kind === 'rclick') {
    const [, x, y] = step.split(':');
    ctl(kind, `${x},${y}`);
  } else {
    ctl('cmd', step);
  }
  log(`did ${step}`);
}
if (!tookPng) {
  park();
  if (liveFallback) sleep(3000); else stepGuest(200); // let the last action land
  ctl('png', lastPng);
  log(`png ${lastPng}`);
}
if (zoomRegion) {
  zoomTo(lastPng, zoomOut, ...zoomRegion);
  log(`zoom ${zoomOut} (region ${zoomRegion.join(',')} at 4x)`);
}
if (wantGrid) {
  const gridOut = path.join(HERE, `seq-grid-${session}.png`);
  writeGrid(lastPng, gridOut);
  log(`grid ${gridOut} (lines every 50px, labels every 100px)`);
}
