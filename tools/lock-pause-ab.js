#!/usr/bin/env node
// tools/lock-pause-ab.js — does presentation back-pressure change this game?
//
// tl;dr: runs one app twice at an identical batch budget, once with
// `--dx-lock-pause-ms=0` (off) and once with it on, screenshots BOTH arms at
// the SAME batch numbers, and diffs each pair with tools/png-diff.js.
//
// Why the same BATCH and not the same guest second: the pause adds guest time
// without adding guest work, so per batch the two arms have done exactly the
// same amount of x86 and differ only in what the clock says. That makes the
// picture at a fixed batch the discriminator we want:
//
//   picture DIFFERS (simulation further along in the paused arm)
//       -> the game read the clock and compensated  => CLOCK_PACED
//          (capping its frame rate will not change its speed)
//   picture IDENTICAL
//       -> nothing in the game noticed the time it lost => FRAME_LOCKED
//          (capping its frame rate WILL slow it down)
//
// It also reports presents/s and API calls/s per arm, so a game that responds
// to back-pressure by spinning harder shows up as a rising API rate.
//
// Usage:
//   node tools/lock-pause-ab.js --app=ID [--max-batches=N] [--pause-ms=16]
//        [--shots=B1,B2,...] [--batch-size=N] [--tick-ms-per-batch=N]
//        [--timeout=SEC] [--outdir=DIR] [--json]

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const p = `--${n}=`;
  for (const a of argv) if (a.startsWith(p)) return a.slice(p.length);
  return d;
};
const hasFlag = (n) => argv.includes(`--${n}`);

const APP = getArg('app', null);
if (!APP) { console.error('usage: node tools/lock-pause-ab.js --app=ID [--pause-ms=16] [--shots=B1,B2]'); process.exit(2); }
const MAX_BATCHES = Number(getArg('max-batches', 4000));
const PAUSE_MS = Number(getArg('pause-ms', 16));
const BATCH_SIZE = getArg('batch-size', null);
const TICK_MS = getArg('tick-ms-per-batch', null);
const TIMEOUT_SEC = Number(getArg('timeout', 400));
const JSON_OUT = hasFlag('json');
const SHOTS = (getArg('shots', null) || [
  Math.round(MAX_BATCHES * 0.6), Math.round(MAX_BATCHES * 0.85), MAX_BATCHES - 1,
].join(',')).split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const OUTDIR = getArg('outdir', path.join(os.tmpdir(), `lock-pause-${APP}`));
fs.mkdirSync(OUTDIR, { recursive: true });

// Anything that names a presentation boundary in the [API] stream.
const PRESENT = new Set([
  'IDirectDrawSurface_Flip', 'IDirectDrawSurface_Blt', 'IDirectDrawSurface_BltFast',
  'IDirectDrawSurface_Unlock', 'IDirect3DDevice_EndScene', 'IDirect3DDevice7_EndScene',
  'StretchDIBits', 'BitBlt', 'StretchBlt', 'SetDIBitsToDevice',
]);
const CLOCK = new Set(['timeGetTime', 'GetTickCount', 'QueryPerformanceCounter']);

function runArm(label, pauseMs) {
  return new Promise((resolve) => {
    const shots = SHOTS.map((b) => ({ batch: b, file: path.join(OUTDIR, `${label}-b${b}.png`) }));
    for (const s of shots) { try { fs.unlinkSync(s.file); } catch (_) {} }
    const args = [
      path.join(ROOT, 'test', 'run.js'),
      `--app=${APP}`,
      `--max-batches=${MAX_BATCHES}`,
      '--no-close',
      `--input=${shots.map((s) => `${s.batch}:png:${s.file}`).join(',')}`,
    ];
    if (BATCH_SIZE) args.push(`--batch-size=${BATCH_SIZE}`);
    if (TICK_MS) args.push(`--tick-ms-per-batch=${TICK_MS}`);
    if (pauseMs > 0) args.push(`--dx-lock-pause-ms=${pauseMs}`);

    const apiCounts = new Map();
    let totalApi = 0, batches = null, pauseLine = null;
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, TIMEOUT_SEC * 1000);
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (line.startsWith('[API] ')) {
        totalApi++;
        const sp = line.indexOf(' ', 6);
        const n = sp === -1 ? line.slice(6) : line.slice(6, sp);
        apiCounts.set(n, (apiCounts.get(n) || 0) + 1);
        return;
      }
      const m = /^Stats:\s+\d+ API calls,\s+(\d+) batches/.exec(line);
      if (m) batches = Number(m[1]);
      if (line.startsWith('[dx-lock-pause]')) pauseLine = line;
    });
    child.stderr.resume();
    child.on('close', (code) => {
      clearTimeout(timer);
      const sum = (set) => [...apiCounts.entries()]
        .filter(([k]) => set.has(k)).reduce((s, [, v]) => s + v, 0);
      const chargedMs = pauseLine ? Number(/-> (\d+)ms/.exec(pauseLine)?.[1] || 0) : 0;
      const tickMs = TICK_MS ? Number(TICK_MS) : 200;
      const b = batches != null ? batches : MAX_BATCHES;
      const guestSec = (b * tickMs + chargedMs) / 1000;
      resolve({
        label, pauseMs, exit: killed ? 'TIMEOUT_KILL' : code,
        wallSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
        batches: b, guestSec: Number(guestSec.toFixed(1)), chargedGuestMs: chargedMs,
        totalApi,
        presents: sum(PRESENT), clockReads: sum(CLOCK),
        presentsPerGuestSec: Number((sum(PRESENT) / Math.max(guestSec, 1e-9)).toFixed(2)),
        apiPerGuestSec: Number((totalApi / Math.max(guestSec, 1e-9)).toFixed(1)),
        pauseLine,
        shots: shots.map((s) => ({
          batch: s.batch, file: s.file,
          bytes: fs.existsSync(s.file) ? fs.statSync(s.file).size : 0,
        })),
        topPresent: [...apiCounts.entries()].filter(([k]) => PRESENT.has(k))
          .sort((a, b2) => b2[1] - a[1]),
      });
    });
  });
}

(async () => {
  const off = await runArm('off', 0);
  const on = await runArm('on', PAUSE_MS);

  const diffs = [];
  for (let i = 0; i < SHOTS.length; i++) {
    const a = off.shots[i], b = on.shots[i];
    if (!a.bytes || !b.bytes) { diffs.push({ batch: SHOTS[i], verdict: 'MISSING_CAPTURE' }); continue; }
    let out = '';
    try {
      out = execFileSync(process.execPath,
        [path.join(ROOT, 'tools', 'png-diff.js'), a.file, b.file], { encoding: 'utf8' });
    } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    const m = /([\d.]+)%/.exec(out);
    diffs.push({
      batch: SHOTS[i],
      changedPct: m ? Number(m[1]) : null,
      verdict: m ? (Number(m[1]) === 0 ? 'IDENTICAL' : 'DIFFERS') : 'UNPARSED',
      raw: out.trim().split('\n').slice(0, 4).join(' | '),
    });
  }

  // Positive control: does the picture change WITHIN the unpaused arm at all?
  // "Identical across arms" on a static screen (a title card, a load screen, a
  // modal) is a fact about a still picture and says nothing about pacing. Only
  // a run whose own consecutive captures differ can support a FRAME_LOCKED
  // verdict, so the control gates that verdict rather than merely annotating
  // it.
  const control = [];
  for (let i = 1; i < off.shots.length; i++) {
    const a = off.shots[i - 1], b = off.shots[i];
    if (!a.bytes || !b.bytes) continue;
    let out = '';
    try {
      out = execFileSync(process.execPath,
        [path.join(ROOT, 'tools', 'png-diff.js'), a.file, b.file], { encoding: 'utf8' });
    } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    const m = /([\d.]+)%/.exec(out);
    control.push({ from: a.batch, to: b.batch, changedPct: m ? Number(m[1]) : null });
  }
  const movesOnItsOwn = control.some((c) => (c.changedPct || 0) > 0);

  const anyDiff = diffs.some((d) => d.verdict === 'DIFFERS');
  const allSame = diffs.length > 0 && diffs.every((d) => d.verdict === 'IDENTICAL');
  // How much back-pressure did the paused arm actually feel? A game that
  // presents rarely in a headless run -- StarCraft's title screen managed 82
  // primary Locks in 1200 guest seconds -- is charged a rounding error, and
  // "pixel-identical" then says nothing at all about how it paces. Only a
  // DIFFERS is informative at any dose; an IDENTICAL is only informative once
  // the dose was big enough that a clock-reading game would have had to move.
  const chargedShare = on.guestSec > 0 ? (on.chargedGuestMs / 1000) / on.guestSec : 0;
  const DOSE_FLOOR = 0.02;
  const verdict = anyDiff
    ? 'RESPONDS TO BACK-PRESSURE (clock-paced): the paused arm is at a different point in the simulation at the same batch'
    : (allSame
      ? (chargedShare < DOSE_FLOOR
        ? `INCONCLUSIVE (dose too small: the pause added only ${(chargedShare * 100).toFixed(2)}% of guest time`
          + ` -- ${on.chargedGuestMs}ms over ${on.guestSec}s -- so pixel-identical is expected either way.`
          + ' Raise --pause-ms, or reach a state that presents more often.)'
        : (!movesOnItsOwn
          ? 'INCONCLUSIVE (static screen: the unpaused arm is pixel-identical to ITSELF between'
            + ' sampled batches, so nothing was animating and "identical across arms" is a fact'
            + ' about a still picture. Reach a state that moves, or sample further apart.)'
          : `DOES NOT RESPOND (frame-locked suspect): pixel-identical at every sampled batch, with the pause`
            + ` adding ${(chargedShare * 100).toFixed(1)}% of guest time`
            + `, while the unpaused arm moves ${Math.max(...control.map((c) => c.changedPct || 0)).toFixed(1)}%`
            + ` between its own captures`))
      : 'INCONCLUSIVE (captures missing or unparsed)');

  const result = { app: APP, pauseMs: PAUSE_MS, maxBatches: MAX_BATCHES, shots: SHOTS, off, on, diffs, control, movesOnItsOwn, verdict, outdir: OUTDIR };
  if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`=== ${APP}  --dx-lock-pause-ms=${PAUSE_MS}  ${MAX_BATCHES} batches`
    + (BATCH_SIZE ? `  --batch-size=${BATCH_SIZE}` : '') + (TICK_MS ? `  --tick-ms-per-batch=${TICK_MS}` : ''));
  for (const arm of [off, on]) {
    console.log(`  ${arm.label.padEnd(3)} exit=${arm.exit} ${arm.wallSec}s wall | batches=${arm.batches}`
      + ` guest=${arm.guestSec}s | presents=${arm.presents} (${arm.presentsPerGuestSec}/guest-s)`
      + ` clockReads=${arm.clockReads} | API=${arm.totalApi} (${arm.apiPerGuestSec}/guest-s)`);
    if (arm.pauseLine) console.log(`      ${arm.pauseLine}`);
    if (arm.topPresent.length) console.log('      present ops: '
      + arm.topPresent.map(([k, v]) => `${k}=${v}`).join('  '));
  }
  for (const d of diffs) console.log(`  batch ${d.batch}: ${d.verdict}${d.changedPct != null ? ` (${d.changedPct}% px changed)` : ''}  ${d.raw || ''}`);
  if (control.length) console.log('  control (off arm vs ITSELF, i.e. is anything animating?): '
    + control.map((c) => `b${c.from}->b${c.to} ${c.changedPct == null ? '?' : c.changedPct + '%'}`).join('  ')
    + (movesOnItsOwn ? '  => moving' : '  => STATIC SCREEN'));
  console.log(`  VERDICT: ${verdict}`);
  console.log(`  captures in ${OUTDIR}`);
})();
