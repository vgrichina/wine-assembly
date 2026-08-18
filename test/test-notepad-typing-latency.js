#!/usr/bin/env node
// What a keystroke costs in notepad, from the injected event to the blit.
//
// This exists because "typing lags" was true for months and nothing failed:
// every keystroke repainted the window chrome through a clip that the raster
// fast path refused (window minus client is four bands, not one rectangle),
// so each character cost a full-window per-pixel walk. The symptom is latency,
// but latency is the one thing this machine cannot measure reliably -- these
// runs share a box that sits anywhere between load 4 and load 40, and that
// noise is far larger than a keystroke. So the assertions are on the work,
// which is deterministic, and the clock is reported for a human to read:
//
//   1. every injected keystroke reaches a blit, within a bounded number of
//      message-loop turns (one batch here is one turn, and one browser step)
//   2. no span takes the per-pixel path -- that path is for surfaces and ROPs
//      the fast one does not model, not for ordinary bordered windows
//   3. a keystroke costs no more than a bounded number of rasterized pixels
//      over the idle baseline, which is what "full repaint per character"
//      would blow through
//
// Run standalone for the numbers:
//   node test/test-notepad-typing-latency.js

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOTEPAD = path.join(ROOT, 'test', 'binaries', 'notepad.exe');
const RUN_JS = path.join(ROOT, 'test', 'run.js');

const BATCHES = 130;
const FIRST_KEY_BATCH = 60;   // the edit control exists and has focus well before this
const KEY_STRIDE = 3;         // batches between keystrokes (~600ms of guest clock)
const KEY_COUNT = 20;

// Ceilings, not targets. Measured after the band-walk fix: 1 batch to blit,
// zero per-pixel spans, well under 100k pixels per keystroke. Each limit sits
// far enough above that to survive unrelated repaint changes, and far enough
// below the pre-fix behaviour (a full-window per-pixel repaint per character)
// to fail on a regression.
//
// The wall clock is deliberately not asserted on. In this harness a blit
// lands one batch after the event, and a batch is dominated by the headless
// software canvas, not by the emulator -- so the millisecond figure describes
// test/run.js, not what a browser would feel. Read the batch count and the
// pixel count; the milliseconds are there for a human comparing two runs on
// one machine.
const MAX_BLIT_BATCHES = 3;
const MAX_PIXELS_PER_KEY = 120000;  // measured: 60k after the fix, 160k before it

function run(withInput) {
  const args = [
    RUN_JS,
    '--exe=' + NOTEPAD,
    '--max-batches=' + BATCHES,
    '--quiet-api',
    '--gdi-stats',
    '--latency-stats',
  ];
  if (withInput) {
    const keys = [];
    for (let i = 0; i < KEY_COUNT; i++) {
      // 'A'..'T' — printable, so each one actually changes the edit's pixels.
      keys.push(`${FIRST_KEY_BATCH + i * KEY_STRIDE}:keypress:${65 + i}`);
    }
    args.push('--input=' + keys.join(','));
  }
  return execFileSync('node', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function parseRaster(out) {
  const m = out.match(/GDI raster: (\d+) fast spans \((\d+) px\), (\d+) slow spans \((\d+) px\)/);
  if (!m) throw new Error('no GDI raster line in output — is --gdi-stats still wired up?');
  return {
    fastPx: Number(m[2]),
    slowSpans: Number(m[3]),
    slowPx: Number(m[4]),
    totalPx: Number(m[2]) + Number(m[4]),
  };
}

function parseLatency(out) {
  const head = out.match(/Input->blit: (\d+) events( \(1 never blitted\))?/);
  if (!head) return null;
  const batches = out.match(/batches p50 (\d+), p95 (\d+), max (\d+)/);
  const ms = out.match(/ms\s+p50 ([\d.]+), p95 ([\d.]+), max ([\d.]+)/);
  return {
    events: Number(head[1]),
    unblitted: !!head[2],
    batchesP50: batches ? Number(batches[1]) : null,
    batchesMax: batches ? Number(batches[3]) : null,
    msP50: ms ? Number(ms[1]) : null,
    msMax: ms ? Number(ms[3]) : null,
  };
}

function main() {
  const idle = parseRaster(run(false));
  const typedOut = run(true);
  const typed = parseRaster(typedOut);
  const lat = parseLatency(typedOut);

  const pixelsPerKey = Math.round((typed.totalPx - idle.totalPx) / KEY_COUNT);
  const failures = [];

  if (!lat) {
    failures.push('no Input->blit summary — is --latency-stats still wired up?');
  } else {
    if (lat.events !== KEY_COUNT || lat.unblitted) {
      failures.push(`${lat.events}/${KEY_COUNT} keystrokes reached a blit` +
        (lat.unblitted ? ' (one never blitted at all)' : ''));
    }
    if (lat.batchesMax > MAX_BLIT_BATCHES) {
      failures.push(`slowest keystroke took ${lat.batchesMax} batches to reach pixels ` +
        `(limit ${MAX_BLIT_BATCHES})`);
    }
  }
  if (typed.slowSpans !== 0) {
    failures.push(`${typed.slowSpans} spans took the per-pixel path (${typed.slowPx} px) — ` +
      `ordinary window painting must stay on the fast path`);
  }
  if (pixelsPerKey > MAX_PIXELS_PER_KEY) {
    failures.push(`${pixelsPerKey} px rasterized per keystroke (limit ${MAX_PIXELS_PER_KEY})`);
  }

  console.log(`typing cost   ${pixelsPerKey} px/keystroke ` +
    `(idle ${Math.round(idle.totalPx / BATCHES)} px/batch, typing ${Math.round(typed.totalPx / BATCHES)} px/batch)`);
  console.log(`per-pixel     ${typed.slowSpans} spans (${typed.slowPx} px)`);
  if (lat) {
    console.log(`input->blit   ${lat.batchesP50} batches p50, ${lat.batchesMax} max` +
      (lat.msP50 !== null ? `  ·  ${lat.msP50.toFixed(2)}ms p50, ${lat.msMax.toFixed(2)}ms max ` +
        `(wall clock, informational — this box is shared)` : ''));
  }

  if (failures.length) {
    for (const f of failures) console.log(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log(`PASS  ${KEY_COUNT} keystrokes, each on the fast path and blitted within ` +
    `${MAX_BLIT_BATCHES} batches`);
}

main();
