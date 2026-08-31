#!/usr/bin/env node
// Diablo Shareware: the three symptoms of the Storm-async/art defect, measured
// in pixels from one run.
//
// docs/re-notes/diablo-shareware.md establishes that these are believed to be
// one bug, and until now none of them had an automated check -- the only way to
// tell whether a fix worked was to look at a PNG. This test is that check.
//
// What it measures, in one 41500-batch run (~40s):
//
//   1. The main-menu logo animation. `ui_art\smlogo.pcx` is 15 frames of
//      390x154 and every one of them is a lit flaming DIABLO wordmark inside
//      spawn.mpq. This test was written while about 12 of the 15 compiled to
//      solid black; since 2026-08-25 all fifteen captures match the archive,
//      and the assertion below is what keeps them that way. The failure it
//      guards against is specific: the transparency key is palette index 250 =
//      pure green and black is a *different* index, so a black frame means the
//      pixel indices arrived zeroed, not that the palette was lost. See the
//      "FIXED (re-measured 2026-08-25)" section of
//      docs/re-notes/diablo-shareware.md. Fifteen captures at a 3-batch
//      stride cover the whole 45-batch animation period at --time-scale=30, so
//      a healthy run matches the archive on every sample.
//
//      The frames are scored against the archive itself, not against a
//      brightness threshold: `tools/mpq-extract.js --frame-height=154` writes
//      the 15 correct frames host-side and each capture is scored by mask IoU
//      against the best-matching one. That matters, because "not black" is not
//      the same as "right": with the loop-idiom lowering or a mis-timed capture
//      this rectangle can come back as full-bright colour noise, which any
//      lit-pixel count would score as a pass. Measured separation: correct art
//      0.74-0.82, colour noise 0.25, solid black 0.00.
//
//   2. The Choose Class screen. `ui_art\selhero.pcx` is a mostly-black 640x480
//      background whose only bright content is three panel outlines, so a
//      whole-frame brightness statistic cannot tell "art drawn" from "art
//      missing" here (the whole frame is 1.1% lit either way) -- the outline
//      segments can, and they are the assertion. diabloui's sprite-frame array
//      at runtime 0x702478 is entirely NULL on this screen, so nothing is drawn
//      at all and all nine segments score 0.00 against the archive's 1.00.
//
//   3. Storm's shared async worker (thread 1) surviving. It used to die with
//      EIP=0 shortly before the menu -- it no longer does, and this assertion
//      is what keeps it that way. `storm+0x150316c0` is the queue that
//      serves both DirectSound fills *and* MPQ sector reads, so its death is
//      why every async file read after the Single Player transition comes back
//      empty. --trace-thread prints the [thread-event] JSON this parses.
//
// The command line is pinned. Runs are deterministic for a fixed command line,
// but *changing the flags changes the execution* (see the re-notes), so the
// batch numbers below are only meaningful with exactly these flags. If a change
// to the emulator moves the menu, the samples say so with their own message
// ("the main menu was not on screen") instead of blaming the art.
//
// `node test/test-diablo-shareware-art.js <dir>` skips the run and re-scores an
// existing capture directory -- that is how the thresholds were separated from
// the ground truth.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const INSTALLED = path.join(ROOT, 'test/binaries/candidates/diablo-shareware/installed');
const MPQ = path.join(INSTALLED, 'spawn.mpq');
const OUTDIR = path.join(ROOT, 'build/diablo-shareware-art');
const GTDIR = path.join(OUTDIR, 'gt');
const LOG = path.join(ROOT, 'build/diablo-shareware-art.log');

const ANALYZE_ONLY = process.argv[2];
const DIR = ANALYZE_ONLY || OUTDIR;

if (!fs.existsSync(MPQ)) {
  console.log('SKIP  Diablo Shareware install missing');
  process.exit(0);
}

// ---------------------------------------------------------------- the one run

// The menu is live from ~batch 39400 at --time-scale=30. Fifteen samples at a
// 3-batch stride span the 45-batch animation period exactly once, so a working
// build shows a different one of the 15 sprites in each.
const LOGO_FIRST = 39800;
const LOGO_STRIDE = 3;
const LOGO_SAMPLES = 15;
// Enter on the live menu takes Single Player; the key must be held across
// several batches or the game never samples it. The Choose Class frame is
// stable from about batch 39800 through 43900 once it is up.
const ENTER_DOWN = 40000;
const ENTER_UP = 40060;
const CC_BATCH = 41400;
const MAX_BATCHES = 41500;

const logoPath = k => path.join(DIR, `logo${String(k).padStart(2, '0')}.png`);
const ccPath = path.join(DIR, 'cc.png');

if (!ANALYZE_ONLY) {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const input = [];
  for (let k = 0; k < LOGO_SAMPLES; k++) {
    input.push(`${LOGO_FIRST + k * LOGO_STRIDE}:png:${logoPath(k)}`);
  }
  input.push(`${ENTER_DOWN}:keydown:13`, `${ENTER_UP}:keyup:13`);
  input.push(`${CC_BATCH}:png:${ccPath}`);

  // --no-close is required for any PNG to be written at all, and
  // --repaint-every=200 is required for the Choose Class capture not to be a
  // stale frame. --trace-thread is what prints the [thread-event] lines.
  // --quiet-api drops only the unconditional per-call [API] one-liner, which
  // nothing here parses; it is worth roughly 3x wall clock on this app because
  // that log is blocking stdout I/O on the guest's own thread.
  const cmd = `node "${RUN}" --app=diablo_shareware --time-scale=30`
    + ` --max-batches=${MAX_BATCHES} --no-close --repaint-every=200 --trace-thread`
    + ` --quiet-api`
    + ` --input='${input.join(',')}' > "${LOG}" 2>&1`;
  console.log('$', cmd);
  try {
    // Measured ~140s on an idle box (41,500 batches of real interpretation --
    // the menu alone is ~39,400 in). This box routinely sits at load 20+ with
    // other agents sweeping, where the same run takes several times that, so
    // the cap is generous on purpose: a tight one turns a busy machine into a
    // "Diablo regressed" report, which is a much more alarming claim than the
    // truth. Only a genuine hang should reach it.
    execSync(cmd, { encoding: 'utf-8', timeout: 300000, cwd: ROOT });
  } catch (e) {
    const tail = fs.existsSync(LOG)
      ? fs.readFileSync(LOG, 'utf-8').split('\n').slice(-40).join('\n') : '';
    console.error(tail);
    // Say which of the two it was. A killed-by-timeout run and a crashed one
    // look identical from here otherwise, and they need opposite responses:
    // one is "the box is loaded, run it again", the other is a real defect.
    const timedOut = e.killed || e.signal === 'SIGTERM';
    const finished = /Stats: \d+ API calls/.test(tail);
    throw new Error(timedOut && !finished
      ? 'the Diablo Shareware run was killed by the harness timeout before it '
        + 'finished — check the box load (uptime) and re-run before reading '
        + 'this as a regression'
      : 'the Diablo Shareware run did not finish');
  }
}

// -------------------------------------------- ground truth out of the archive

// The archive is the oracle. Extracting takes about a second and pins the
// expected pixels to the shipped data rather than to a golden file that could
// be regenerated from a broken build.
fs.mkdirSync(GTDIR, { recursive: true });
const GT_STEM = path.join(GTDIR, 'smlogo.png');
execSync(`node "${path.join(ROOT, 'tools/mpq-extract.js')}" "${MPQ}"`
  + ` --name='ui_art\\smlogo.pcx' --png="${GT_STEM}" --frame-height=154`,
  { encoding: 'utf-8', timeout: 120000, cwd: ROOT });

// ------------------------------------------------------------------- scoring

const read = p => {
  assert.ok(fs.existsSync(p), `the run wrote no ${path.basename(p)} (was --no-close dropped?)`);
  return PNG.sync.read(fs.readFileSync(p));
};

// "Lit" is any pixel with a channel above 40/255. Diablo's menu is a dark
// picture, so this is deliberately low; the separation it has to make is
// between real art and an all-zero sprite payload, not between shades.
const LIT = 40;
function litFraction(png, x0, y0, x1, y1, thr) {
  let lit = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > thr) lit++;
      total++;
    }
  }
  return total ? lit / total : 0;
}

// -------------------------------------------- 1. the 15-frame logo animation

// Where the 390x154 smlogo frame lands in the 640x480 presented frame.
const LOGO = { x: 126, y: 0, w: 390, h: 154 };
// Correct art scores 0.74-0.82 against its own frame; colour noise scores 0.25
// and an all-black rectangle scores 0.00.
const LOGO_IOU_MIN = 0.55;
// The five menu items. Present on the menu, dark during the Blizzard North
// intro -- so a run whose timing has drifted off the menu says so directly.
const MENU_TEXT = { x0: 175, y0: 200, x1: 465, y1: 228 };
const MENU_TEXT_MIN = 0.05;

// Mask of the pixels the archive says are art: everything that is neither the
// pure-green colour key (index 250) nor too dark to show against black.
const gtMasks = [];
for (let k = 0; k < LOGO_SAMPLES; k++) {
  const g = PNG.sync.read(fs.readFileSync(path.join(GTDIR, `smlogo.${String(k).padStart(3, '0')}.png`)));
  assert.strictEqual(g.width, LOGO.w, 'smlogo.pcx frames must be 390 wide');
  assert.strictEqual(g.height, LOGO.h, 'smlogo.pcx frames must be 154 tall');
  const m = new Uint8Array(LOGO.w * LOGO.h);
  for (let i = 0; i < m.length; i++) {
    const r = g.data[i * 4], gg = g.data[i * 4 + 1], b = g.data[i * 4 + 2];
    const key = r < 40 && gg > 200 && b < 40;
    if (!key && Math.max(r, gg, b) > LIT) m[i] = 1;
  }
  gtMasks.push(m);
}

function scoreLogo(png) {
  const cap = new Uint8Array(LOGO.w * LOGO.h);
  for (let y = 0; y < LOGO.h; y++) {
    for (let x = 0; x < LOGO.w; x++) {
      const i = ((y + LOGO.y) * png.width + (x + LOGO.x)) * 4;
      if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > LIT) cap[y * LOGO.w + x] = 1;
    }
  }
  let best = 0, bestFrame = -1;
  for (let k = 0; k < gtMasks.length; k++) {
    let inter = 0, union = 0;
    for (let i = 0; i < cap.length; i++) {
      const a = cap[i], b = gtMasks[k][i];
      if (a | b) union++;
      if (a & b) inter++;
    }
    const iou = union ? inter / union : 0;
    if (iou > best) { best = iou; bestFrame = k; }
  }
  return { best, bestFrame };
}

const logoScores = [];
let menuMissing = 0;
for (let k = 0; k < LOGO_SAMPLES; k++) {
  const png = read(logoPath(k));
  assert.strictEqual(png.width, 640, 'the presented frame must be the 640x480 display mode');
  assert.strictEqual(png.height, 480);
  if (litFraction(png, MENU_TEXT.x0, MENU_TEXT.y0, MENU_TEXT.x1, MENU_TEXT.y1, LIT) < MENU_TEXT_MIN) {
    menuMissing++;
  }
  logoScores.push(scoreLogo(png));
}
const logoOk = logoScores.filter(s => s.best >= LOGO_IOU_MIN).length;
const matchedFrames = new Set(logoScores.filter(s => s.best >= LOGO_IOU_MIN).map(s => s.bestFrame));
console.log('logo frame IoU vs archive: ' + logoScores.map(s => s.best.toFixed(2)).join(' '));
console.log(`logo frames matching the archive: ${logoOk}/${LOGO_SAMPLES}`
  + `  (distinct sprites seen: ${[...matchedFrames].sort((a, b) => a - b).join(',') || 'none'})`);

// ---------------------------------------------- 2. the Choose Class panels

// The panel outlines of ui_art\selhero.pcx: every one of these segments is 100%
// lit in the archive and 0% lit in the emulator today. Each is searched +/-4px
// across so a small placement difference is not scored as missing art.
const CC_SEGMENTS = [
  ['left box top', 30, 210, 210, 211],
  ['left box bottom', 30, 288, 210, 289],
  ['left box2 top', 30, 297, 210, 298],
  ['left box2 bottom', 30, 464, 210, 465],
  ['left box left edge', 29, 211, 30, 288],
  ['right box top', 240, 210, 609, 211],
  ['right box bottom', 240, 421, 609, 422],
  ['right box left edge', 239, 211, 240, 421],
  ['right box right edge', 609, 211, 610, 421],
];
const CC_SEG_LIT_MIN = 0.6;
const CC_SEGS_REQUIRED = 7;

const cc = read(ccPath);
assert.strictEqual(cc.width, 640, 'the Choose Class capture must be the 640x480 display mode');
assert.strictEqual(cc.height, 480);
const ccScores = CC_SEGMENTS.map(([name, x0, y0, x1, y1]) => {
  const horizontal = (y1 - y0) === 1;
  let best = 0;
  for (let d = -4; d <= 4; d++) {
    const f = horizontal
      ? litFraction(cc, x0, y0 + d, x1, y1 + d, 60)
      : litFraction(cc, x0 + d, y0, x1 + d, y1, 60);
    if (f > best) best = f;
  }
  return { name, best };
});
const ccOk = ccScores.filter(s => s.best >= CC_SEG_LIT_MIN).length;
console.log('choose class panel outlines: '
  + ccScores.map(s => `${s.name}=${s.best.toFixed(2)}`).join(' '));
console.log(`choose class panel segments drawn: ${ccOk}/${CC_SEGMENTS.length}`);

// ------------------------------------------------- 3. Storm's async worker

const threadEvents = [];
let sawSpawn = false;
if (fs.existsSync(LOG)) {
  let lastBatch = null;
  for (const line of fs.readFileSync(LOG, 'utf-8').split('\n')) {
    const b = /^\[(\d+)\] EIP=/.exec(line);
    if (b) lastBatch = Number(b[1]);
    const m = /^\[thread-event\] (\{.*\})$/.exec(line);
    if (!m) continue;
    let ev;
    try { ev = JSON.parse(m[1]); } catch (_) { continue; }
    ev.batch = lastBatch;
    threadEvents.push(ev);
    if (ev.type === 'spawn') sawSpawn = true;
  }
}
const crashes = threadEvents.filter(e => e.type === 'exit' && /eip=0/.test(String(e.reason || '')));

// ------------------------------------------------------------- the verdict

const failures = [];
if (menuMissing > 2) {
  failures.push(`the main menu was not on screen for ${menuMissing} of ${LOGO_SAMPLES} logo captures `
    + `-- the run's timing has moved, so the logo scores below measure the wrong screen. `
    + `Re-derive LOGO_FIRST before reading anything else here.`);
}
if (logoOk < 13) {
  failures.push(`only ${logoOk} of ${LOGO_SAMPLES} main-menu logo captures match a frame of `
    + `ui_art\\smlogo.pcx (all 15 sprites are lit art in spawn.mpq; the rest arrive as opaque `
    + `black, i.e. zeroed pixel indices, or as colour noise)`);
} else if (matchedFrames.size < 3) {
  failures.push(`the logo matched the archive but only ever showed sprite `
    + `${[...matchedFrames].join(',')} -- the animation is not advancing`);
}
if (ccOk < CC_SEGS_REQUIRED) {
  failures.push(`only ${ccOk} of ${CC_SEGMENTS.length} ui_art\\selhero.pcx panel outlines are drawn `
    + `on Choose Class (diabloui's sprite-frame array at 0x702478 is all zero there -- the screen `
    + `has no art at all)`);
}
if (!ANALYZE_ONLY) {
  assert.ok(sawSpawn, 'Storm never spawned its async worker, so this run measured nothing');
  if (crashes.length) {
    const c = crashes[0];
    failures.push(`Storm's shared async worker (thread ${c.tid}) died with EIP=0 at batch ${c.batch} `
      + `-- every async MPQ read after that returns zero bytes`);
  }
}

if (failures.length) {
  console.error('\nFAIL  Diablo Shareware art pipeline:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('PASS  Diablo Shareware renders its animated logo, its Choose Class art, '
  + "and keeps Storm's async worker alive");
