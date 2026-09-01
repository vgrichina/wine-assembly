#!/usr/bin/env node
// tools/pacing-census.js — how does a guest program pace its frames?
//
// tl;dr: runs `test/run.js --app=ID` for a fixed batch budget, STREAMS its
// stdout (never buffers it to a file), tallies every `[API] Name` line into a
// histogram, and reports the pacing-relevant rates per GUEST second. Also
// keeps the `[host-census] final:` block and the `Stats:` line from the tail.
//
// Why streaming and not `--quiet-api`: the per-API breakdown is only available
// in the `[API]` one-liners, and `--quiet-api` (rightly) suppresses them. The
// documented 3x wall-clock cost of leaving them on is a cost of BLOCKING on a
// terminal; a pipe drained promptly by this process does not pay it.
//
// The question it answers: is the guest's render loop driven by messages, by a
// timer, by a clock read, or by nothing at all (frame-locked)? Rates are per
// guest second, because the headless clock advances `--tick-ms-per-batch` per
// batch and batches are not a unit of work (see CLAUDE.md).
//
// Usage:
//   node tools/pacing-census.js --app=ID [--max-batches=N] [--tick-ms-per-batch=N]
//                               [--timeout=SEC] [--json] [--top=N] [-- extra run.js args]
//   node tools/pacing-census.js --app=ID --clock-sweep[=200,1] [--max-batches=N]
//        — the same batch budget at several guest clock rates, compared PER
//          BATCH. This is how a frame limiter that the default 200ms/batch
//          clock defeats becomes visible; see docs/frame-pacing-census.md.

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const passIdx = argv.indexOf('--');
const own = passIdx === -1 ? argv : argv.slice(0, passIdx);
const extra = passIdx === -1 ? [] : argv.slice(passIdx + 1);

function getArg(name, dflt) {
  const p = `--${name}=`;
  for (const a of own) if (a.startsWith(p)) return a.slice(p.length);
  return dflt;
}
function hasFlag(name) { return own.includes(`--${name}`); }

const APP = getArg('app', null);
const EXE = getArg('exe', null);
if (!APP && !EXE) {
  console.error('usage: node tools/pacing-census.js --app=ID [--max-batches=N] [--timeout=SEC] [--json]');
  process.exit(2);
}
const MAX_BATCHES = Number(getArg('max-batches', 4000));
const TICK_MS = Number(getArg('tick-ms-per-batch', 200));
const TIMEOUT_SEC = Number(getArg('timeout', 120));
const TOP = Number(getArg('top', 40));
const JSON_OUT = hasFlag('json');

// Pacing-relevant API groups. A name may appear in several groups on purpose
// (Unlock is both a DX surface op and a presentation boundary candidate).
const GROUPS = {
  clock: [
    'timeGetTime', 'GetTickCount', 'GetTickCount64',
    'QueryPerformanceCounter', 'QueryPerformanceFrequency',
    'GetSystemTime', 'GetSystemTimeAsFileTime', 'GetLocalTime',
    '_ftime', 'clock', 'time', 'ftime', '_time64',
  ],
  sleep: [
    'Sleep', 'SleepEx', 'WaitForSingleObject', 'WaitForSingleObjectEx',
    'WaitForMultipleObjects', 'MsgWaitForMultipleObjects', 'WaitMessage',
  ],
  timer: ['SetTimer', 'KillTimer', 'timeSetEvent', 'timeKillEvent', 'CreateWaitableTimer'],
  peek: ['PeekMessageA', 'PeekMessageW'],
  get: ['GetMessageA', 'GetMessageW'],
  dispatch: ['DispatchMessageA', 'DispatchMessageW'],
  present: [
    // DirectDraw / D3D / GL presentation boundaries
    'IDirectDrawSurface_Flip', 'Flip', 'IDirectDrawSurface_Blt', 'IDirectDrawSurface_BltFast',
    'IDirectDrawSurface_Unlock', 'IDirect3DDevice_EndScene', 'IDirect3DDevice7_EndScene',
    'IDirect3DDevice_Present', 'IDirect3DDevice9_Present', 'Present', 'EndScene',
    'wglSwapBuffers', 'SwapBuffers',
    // GDI presentation boundaries
    'BitBlt', 'StretchBlt', 'StretchDIBits', 'SetDIBitsToDevice',
    'InvalidateRect', 'UpdateWindow', 'BeginPaint', 'EndPaint',
  ],
};
const WATCH = new Set(Object.values(GROUPS).flat());

const WARMUP = Number(getArg('warmup', 0));

function runOnce(maxBatches, tickMs = TICK_MS, extraArgs = extra) {
  return new Promise((resolve) => {
    const runArgs = [
      path.join(ROOT, 'test', 'run.js'),
      ...(APP ? [`--app=${APP}`] : []),
      ...(EXE ? [`--exe=${EXE}`] : []),
      `--max-batches=${maxBatches}`,
      `--tick-ms-per-batch=${tickMs}`,
      '--no-close',
      '--host-census',
      ...extraArgs,
    ];
    const apiCounts = new Map();
    const hostCensus = new Map();
    let totalApi = 0;
    let batchesDone = null;
    let inCensus = false;
    let stderrTail = '';
    const t0 = Date.now();
    const child = spawn(process.execPath, runArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, TIMEOUT_SEC * 1000);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.startsWith('[API] ')) {
        totalApi++;
        const sp = line.indexOf(' ', 6);
        const name = sp === -1 ? line.slice(6) : line.slice(6, sp);
        apiCounts.set(name, (apiCounts.get(name) || 0) + 1);
        return;
      }
      const m = /^Stats:\s+\d+ API calls,\s+(\d+) batches/.exec(line);
      if (m) batchesDone = Number(m[1]);
      if (line.startsWith('[host-census] final:')) { inCensus = true; return; }
      if (inCensus) {
        const c = /^\s+(\d+)\s+(\S+)\s*$/.exec(line);
        if (c) hostCensus.set(c[2], Number(c[1]));
        else if (line.trim()) inCensus = false;
      }
    });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        maxBatches, tickMs,
        exit: killed ? 'TIMEOUT_KILL' : code,
        wallSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
        batches: batchesDone != null ? batchesDone : maxBatches,
        totalApi, apiCounts, hostCensus, stderrTail,
      });
    });
  });
}

function summarize(label, batches, totalApi, apiCounts, hostCensus, extraFields) {
  const guestSec = (batches * TICK_MS) / 1000;
  const per = (n) => (guestSec > 0 ? n / guestSec : 0);
  const groups = {};
  for (const g of Object.keys(GROUPS)) {
    groups[g] = GROUPS[g].reduce((s, n) => s + (apiCounts.get(n) || 0), 0);
  }
  return Object.assign({
    phase: label,
    app: APP || EXE,
    batches,
    guestSec,
    totalApi,
    apiPerGuestSec: Number(per(totalApi).toFixed(1)),
    groups,
    ratesPerGuestSec: Object.fromEntries(
      Object.keys(GROUPS).map((g) => [g, Number(per(groups[g]).toFixed(2))])),
    hostRatesPerGuestSec: Object.fromEntries([...hostCensus.entries()]
      .map(([k, v]) => [k, Number(per(v).toFixed(2))])),
    topApis: [...apiCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP),
    watchedApis: Object.fromEntries([...apiCounts.entries()]
      .filter(([k]) => WATCH.has(k)).sort((a, b) => b[1] - a[1])),
  }, extraFields || {});
}

function printPhase(s, wallSec) {
  console.log(`--- ${s.phase}: ${s.batches} batches = ${s.guestSec}s guest`
    + (wallSec != null ? `  (${wallSec}s wall)` : ''));
  console.log(`  API calls ${s.totalApi} (${s.apiPerGuestSec}/guest-s)`);
  console.log('  per guest second: ' + Object.entries(s.ratesPerGuestSec)
    .map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('  watched: ' + (Object.keys(s.watchedApis).length
    ? Object.entries(s.watchedApis).map(([k, v]) => `${k}=${v}`).join('  ') : '(none)'));
  console.log('  host/guest-s: ' + Object.entries(s.hostRatesPerGuestSec).slice(0, 12)
    .map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('  top APIs: ' + s.topApis.slice(0, 16).map(([k, v]) => `${k}=${v}`).join('  '));
}

// --- clock sensitivity sweep -------------------------------------------------
//
// Run the SAME batch budget at two (or more) guest clock rates and compare
// counts PER BATCH. Batches are the controlled variable: at a fixed
// --max-batches (and --batch-size) the guest is offered the same number of
// block budgets whatever the clock says, so a counter that is a pure function
// of executed code has the same per-batch count at every rate and a ratio of
// 1.0. Anything that moves is the app reacting to the clock.
//
// Do NOT compare per-guest-second rates across rates: guest seconds differ by
// the ratio of the tick rates by construction (200x between 200 and 1), so
// every counter "changes" and nothing is learned. Per-batch ratios are the
// tick-rate-independent form of the same measurement, which is the same reason
// the census quotes presents-per-frame rather than presents-per-second.
//
// Naming: "lowTick" is --tick-ms-per-batch=1, where guest time crawls relative
// to the work the guest gets done -- the realistic regime, and the one where a
// 16-17ms frame limiter can actually engage. "highTick" is the default 200ms,
// where every millisecond deadline is already overdue on the first clock read.
// All ratios below are lowTick / highTick.
//
// What the ratios mean (lowTick / highTick, i.e. 1ms / 200ms):
//   frames ~1, clock ~1        the app does not care what time it is
//   frames << 1, clock >> 1    a FRAME LIMITER engaged that the 200ms clock
//                              defeats -- the app is spinning on the clock
//                              instead of producing frames (the dxball shape)
//   frames << 1, clock ~1      TIME STARVED: it is waiting for time to pass by
//                              some means other than polling (Sleep, a timer,
//                              a bounded wait) -- the Diablo-intro shape
//   frames ~1, clock/peek >> 1 spin amplified by the clock mismatch
const SWEEP_GROUPS = ['present', 'clock', 'sleep', 'peek', 'get', 'dispatch', 'timer'];

function ratio(fast, slow) {
  if (slow === 0 && fast === 0) return 1;
  if (slow === 0) return Infinity;
  return fast / slow;
}

function classifySweep(r, arms) {
  const notes = [];
  if (arms.some((a) => a.exit === 'TIMEOUT_KILL')) notes.push('an arm was KILLED by --timeout');
  const bs = arms.map((a) => a.batches);
  if (Math.min(...bs) < Math.max(...bs) * 0.9) {
    notes.push(`arms ended at different batch counts (${bs.join(' vs ')}), so per-batch`
      + ' ratios are still valid but the app exited on its own in at least one arm');
  }
  const fr = r.present, cl = r.clock, pk = r.peek;
  // CLOCK READS PER FRAME is the discriminator, not either counter alone. Both
  // a defeated limiter and a time-starved app produce fewer frames at the low
  // tick; they differ in what happens to the polling:
  //
  //   limiter defeated at 200ms  frames DOWN, clock reads UP    -> ratio explodes
  //   time-starved at 1ms        frames DOWN, clock reads DOWN  -> ratio ~1
  //
  // Measured: dxball 0.018 frames / 145 clock = 8000x reads per frame (limiter);
  // diablo_demo 0.006 / 0.006 = 1.0x (time-starved, it simply did 1/166th of the
  // work per batch because 166x less guest time passed).
  const cpf = ratio(cl, fr);
  let verdict;
  if (arms.every((a) => a.groups.present === 0)) {
    verdict = (cl > 1.5 || pk > 1.5) ? 'SPIN_AMPLIFIED (no frames in either arm)'
      : 'NO_FRAMES (nothing to say about pacing)';
  } else if (fr < 0.8 && cpf >= 3) {
    verdict = 'LIMITER_ENGAGED at the low tick (defeated at the default 200ms/batch)'
      + ` -- ${cpf.toFixed(1)}x the clock reads per frame`;
  } else if (fr < 0.8) {
    verdict = 'TIME_STARVED at the low tick (fewer frames because less guest time'
      + ` passed, not because of a limiter -- clock reads per frame ${cpf.toFixed(2)}x)`;
  } else if (fr > 1.25) {
    verdict = 'MORE_FRAMES at the low tick (investigate: something the high tick'
      + ' made it skip)';
  } else if (cpf >= 3 || pk >= 1.5) {
    verdict = `SPIN_AMPLIFIED (frames unchanged, ${cpf.toFixed(1)}x clock reads per frame)`;
  } else {
    verdict = 'CLOCK_INSENSITIVE (same behaviour at both clocks)';
  }
  return { verdict, notes, clockPerFrameRatio: Number(cpf.toFixed(3)) };
}

async function clockSweep(rates) {
  // The stuck detector (`run.js --stuck-after=N`, default 10) ends a run after
  // N batches at the same EIP. That is a HARNESS behaviour, not the guest's,
  // and it does not fire equally in both arms: a message-driven app parked in
  // GetMessage waits for a timer that, at 1ms of guest time per batch, is 200x
  // further away, so the low-tick arm trips it and the high-tick arm does not.
  // Solitaire ended at 39 batches against 3000 that way, which then read as
  // "77x more frames per batch at the low tick" -- an artifact of dividing by
  // 39. Disable it for both arms unless the caller asked for one.
  const sweepExtra = extra.some((a) => a.startsWith('--stuck-after'))
    ? extra : ['--stuck-after=100000000', ...extra];
  const arms = [];
  for (const tick of rates) {
    const r = await runOnce(MAX_BATCHES, tick, sweepExtra);
    const groups = {};
    for (const g of Object.keys(GROUPS)) {
      groups[g] = GROUPS[g].reduce((s, n) => s + (r.apiCounts.get(n) || 0), 0);
    }
    arms.push({
      tickMs: tick, exit: r.exit, wallSec: r.wallSec, batches: r.batches,
      guestSec: (r.batches * tick) / 1000,
      totalApi: r.totalApi, groups,
      perBatch: Object.fromEntries(Object.keys(groups)
        .map((g) => [g, Number((groups[g] / Math.max(1, r.batches)).toFixed(4))])),
      watchedApis: Object.fromEntries([...r.apiCounts.entries()]
        .filter(([k]) => WATCH.has(k)).sort((a, b) => b[1] - a[1])),
      topApis: [...r.apiCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      stderrTail: r.stderrTail,
    });
  }
  // Ratios are lowTick (smallest tick) over highTick (largest tick).
  const byTick = [...arms].sort((a, b) => b.tickMs - a.tickMs);
  const slow = byTick[0], fast = byTick[byTick.length - 1];
  const perBatchRatio = {};
  for (const g of Object.keys(GROUPS)) {
    perBatchRatio[g] = Number(ratio(fast.perBatch[g], slow.perBatch[g]).toFixed(3));
  }
  const { verdict, notes, clockPerFrameRatio } = classifySweep(perBatchRatio, arms);
  return {
    app: APP || EXE, mode: 'clock-sweep', rates, maxBatches: MAX_BATCHES,
    extraArgs: sweepExtra, arms, perBatchRatio, clockPerFrameRatio, verdict, notes,
    totalApiPerBatchRatio: Number(ratio(
      fast.totalApi / Math.max(1, fast.batches),
      slow.totalApi / Math.max(1, slow.batches)).toFixed(3)),
  };
}

function printSweep(s) {
  console.log(`=== ${s.app}  clock sweep  (${s.maxBatches} batches per arm)`);
  for (const a of s.arms) {
    console.log(`--- tick=${a.tickMs}ms/batch  exit=${a.exit}  ${a.batches} batches`
      + ` = ${a.guestSec}s guest  (${a.wallSec}s wall)  API ${a.totalApi}`);
    console.log('  per batch: ' + SWEEP_GROUPS
      .map((g) => `${g}=${a.perBatch[g]}`).join('  '));
    console.log('  watched: ' + (Object.keys(a.watchedApis).length
      ? Object.entries(a.watchedApis).slice(0, 10).map(([k, v]) => `${k}=${v}`).join('  ')
      : '(none)'));
  }
  console.log('--- per-batch ratio (lowTick / highTick), 1.0 = clock-insensitive');
  console.log('  ' + SWEEP_GROUPS.map((g) => `${g}=${s.perBatchRatio[g]}`).join('  ')
    + `  totalApi=${s.totalApiPerBatchRatio}`);
  console.log(`  clock reads per frame: ${s.clockPerFrameRatio}x`
    + '   (>=3 with frames down = a limiter the 200ms clock defeats;'
    + ' ~1 with frames down = time-starved)');
  console.log('VERDICT: ' + s.verdict);
  for (const n of s.notes) console.log('  note: ' + n);
}

(async () => {
  const sweepArg = getArg('clock-sweep', hasFlag('clock-sweep') ? '200,1' : null);
  if (sweepArg != null) {
    const rates = String(sweepArg).split(',').map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (rates.length < 2) {
      console.error('--clock-sweep needs at least two tick rates, e.g. --clock-sweep=200,1');
      process.exit(2);
    }
    const s = await clockSweep(rates);
    if (JSON_OUT) console.log(JSON.stringify(s, null, 2));
    else printSweep(s);
    return;
  }

  const full = await runOnce(MAX_BATCHES);
  const out = { app: APP || EXE, exit: full.exit, wallSec: full.wallSec };
  out.whole = summarize('whole run', full.batches, full.totalApi, full.apiCounts, full.hostCensus);

  if (WARMUP > 0) {
    // Steady state = (whole run) - (first WARMUP batches). Startup dominates
    // every histogram otherwise: a game spends its first thousands of batches
    // reading files, and those API calls are not pacing.
    const warm = await runOnce(WARMUP);
    const dApi = new Map();
    for (const [k, v] of full.apiCounts) {
      const d = v - (warm.apiCounts.get(k) || 0);
      if (d > 0) dApi.set(k, d);
    }
    const dHost = new Map();
    for (const [k, v] of full.hostCensus) {
      const d = v - (warm.hostCensus.get(k) || 0);
      if (d > 0) dHost.set(k, d);
    }
    const dBatches = full.batches - warm.batches;
    out.warmupExit = warm.exit;
    out.warmupBatches = warm.batches;
    out.wallSec = Number((full.wallSec + warm.wallSec).toFixed(1));
    // The steady window is (full - warmup), so it is only meaningful when the
    // full run actually got FURTHER than the warmup run. Two ways it does not:
    //
    //  - both runs ended at the same batch (the guest exited on its own, so
    //    --max-batches never bound and there is nothing to subtract);
    //  - the full run was killed by its timeout before it overtook the warmup
    //    run. A killed run reports `batches` as the REQUESTED max, not the
    //    batches it reached, so dBatches looks healthy while the API delta is
    //    negative. StarCraft at --batch-size=100000 printed a steady state of
    //    "-295083 API calls (-268.3/guest-s)" this way -- a number that reads
    //    like data and is an artifact of subtracting a longer run from a
    //    shorter one.
    const dApiTotal = full.totalApi - warm.totalApi;
    if (dBatches > 0 && dApiTotal >= 0 && full.exit !== 'TIMEOUT_KILL') {
      out.steady = summarize(`steady state (batches ${warm.batches}-${full.batches})`,
        dBatches, dApiTotal, dApi, dHost);
    } else {
      out.steady = null;
      out.steadyNote = dBatches <= 0
        ? 'no steady-state window: the two runs ended at the same batch'
        : (full.exit === 'TIMEOUT_KILL'
          ? `no steady-state window: the full run was KILLED by --timeout (its ${full.batches}`
            + ' batches is the requested max, not what it reached), so it may not have overtaken'
            + ` the ${warm.batches}-batch warmup run. Raise --timeout or lower --max-batches.`
          : `no steady-state window: the full run made FEWER API calls than the warmup run`
            + ` (delta ${dApiTotal}), so it did not get further. Treat this as "did not finish`
            + ' warmup", not as data.');
    }
  }

  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`=== ${out.app}  exit=${out.exit}  (${out.wallSec}s wall total)`);
  printPhase(out.whole, full.wallSec);
  if (out.steady) printPhase(out.steady);
  else if (out.steadyNote) console.log('--- ' + out.steadyNote);
  if (full.exit !== 0 && full.exit !== 'TIMEOUT_KILL') {
    console.log('stderr tail:\n' + full.stderrTail.slice(-1000));
  }
})();
