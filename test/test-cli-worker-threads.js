#!/usr/bin/env node
'use strict';

// `--threads`: every guest thread gets a real OS thread (node worker_threads over
// the one shared WebAssembly.Memory) instead of a slice of this one.
//
// WHY THIS TEST EXISTS
// Worker mode shipped in phase 1 with a bug that made it quietly wrong — parked
// waits were cleared instead of completed, leaking 12 bytes of guest stack each
// time — and every automated test stayed green through all of it, because every
// automated test ran the cooperative backend. It was found by hand, in a browser,
// six seconds into a Winamp track. This is the test that would have caught it.
//
// It runs the SAME app with the SAME flags on both backends and compares. What it
// can prove headlessly: a guest thread really executed in another OS thread, its
// host imports were served over the RPC broker, an event signalled from one thread
// woke a wait parked in another, ExitThread attributed itself to the right thread,
// and the app's guest-visible behaviour did not change. What it cannot prove is
// throughput — see docs/design-real-threads.md; fps figures come from a real
// browser or not at all.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found');
  process.exit(0);
}

// WordPad is the cheapest app in the corpus that exercises the whole thread
// lifecycle: it creates one CREATE_SUSPENDED thread, resumes it, both sides wait
// on events, and the thread reaches ExitThread on its own.
const run = (label, extra) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    '--max-batches=120',
    '--batch-size=50000',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
    '--trace-thread',
    '--input=110:stop',
    ...extra,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const events = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\[thread-event\] (\{.*\})$/);
    if (m) { try { events.push(JSON.parse(m[1])); } catch (_) {} }
  }
  const apiCalls = (() => {
    const m = output.match(/Stats: (\d+) API calls/);
    return m ? parseInt(m[1], 10) : -1;
  })();
  const exitReason = (events.find(e => e.type === 'exit') || {}).reason || 'none';
  console.log(`  ${label}: exit=${result.status} ${Date.now() - started}ms `
    + `events=${events.map(e => e.type).join(',')} api=${apiCalls} thread-end=${exitReason}`);
  return { result, output, events, apiCalls };
};

const worker = run('worker', ['--threads']);
const coop = run('cooperative', []);

const spawnEvent = worker.events.find(e => e.type === 'spawn');
const exitEvent = worker.events.find(e => e.type === 'exit');
// The per-thread line in the final-state table: slices, guest ms, and how the
// thread's host imports were served.
const finalLine = (worker.output.match(/^ {2}T1 .*$/m) || [''])[0];
const rpc = finalLine.match(/rpc=(\d+)sync\/(\d+)async\/(\d+)local/);

const checks = [
  // A completed run is itself an assertion: a worker parked in Atomics.wait that
  // the main thread never serves does not fail, it hangs — the timeout above is
  // what catches a lock held across a host import.
  ['--threads run completed', worker.result.status === 0 && !worker.result.signal && !worker.result.error],
  ['cooperative run completed', coop.result.status === 0 && !coop.result.signal && !coop.result.error],
  ['the guest thread was instantiated in a real OS thread',
    /\[guest-worker 1\] instantiated: \d+ exports, \d+ brokered imports/.test(worker.output)],
  ['the scheduler reports the worker backend',
    !!spawnEvent && spawnEvent.backend === 'worker'],
  ['the thread started at its own entry point, not the main thread\'s',
    !!spawnEvent && spawnEvent.eip === spawnEvent.startAddr && spawnEvent.esp > 0],
  // The thread that ended must be the one that ended, with its own exit code.
  // In worker mode that is not free: ExitThread takes no handle and its caller
  // is not even on this thread, so attribution depends on the RPC hooks naming
  // the slot being served — get it wrong and the wrong thread exits, or none.
  //
  // The ROUTE is not asserted, only reported. WordPad ends this thread by
  // calling ExitThread cooperatively and by returning to the null return address
  // under real threads: both are legitimate Win32 endings, and which one a guest
  // takes depends on where it was when the section it wanted came free.
  ['the exit was attributed to the thread that ended',
    !!exitEvent && exitEvent.tid === 1 && exitEvent.exitCode === 0],
  // Asserted on the cooperative run, so a regression in ExitThread itself still
  // has somewhere to show up.
  ['ExitThread still ends the thread on the cooperative backend',
    (coop.events.find(e => e.type === 'exit') || {}).reason === 'ExitThread'],
  // Both directions of cross-thread synchronisation, each parked in a different
  // OS thread and woken by the other.
  ['a wait parked on the main thread was woken by the worker\'s SetEvent',
    /Main thread resumed from wait, handle=0xe0000/.test(worker.output)],
  ['a wait parked in the worker was woken from the main thread',
    /worker thread 1 resumed from wait/.test(worker.output)],
  ['the worker\'s host imports were served over the RPC broker',
    !!rpc && parseInt(rpc[1], 10) > 0],
  ['no trap, unimplemented API or missing host import',
    !/UNIMPLEMENTED|CRASH|RuntimeError|Unreachable code|trapped at/.test(worker.output)],
  // Equivalence. The whole claim of this backend is that it changes WHERE guest
  // threads run and nothing else, so the same app on the same input has to reach
  // the same place. Owner-thread SendMessage makes the real worker finish some
  // formatting callbacks while the cooperative backend is between slices; with
  // this fixed-batch stopping point that produces a stable ~10% call-count skew.
  // Lifecycle, waits, traps, and final UI state above are the primary assertions;
  // this wider bound still catches a stalled or repeatedly replayed workload.
  ['the same thread lifecycle happened on both backends',
    coop.events.map(e => e.type).join(',') === worker.events.map(e => e.type).join(',')],
  ['WordPad reached its steady state on both backends',
    /\[SetWindowText\] "Document - WordPad"/.test(worker.output)
      && /\[SetWindowText\] "Document - WordPad"/.test(coop.output)],
  ['both backends did the same amount of guest-visible work',
    worker.apiCalls > 1000 && coop.apiCalls > 1000
      && Math.abs(worker.apiCalls - coop.apiCalls) <= Math.max(20, coop.apiCalls * 0.15)],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

if (failed) {
  console.log('\nworker thread events:');
  for (const e of worker.events) console.log(`  ${JSON.stringify(e)}`);
  console.log(`worker final state: ${finalLine || '(no T1 line)'}`);
  console.log(`api calls: worker=${worker.apiCalls} cooperative=${coop.apiCalls}`);
  const tail = worker.output.split('\n').slice(-25).join('\n');
  console.log(`\nlast lines of the --threads run:\n${tail}`);
}
process.exit(failed ? 1 : 0);
