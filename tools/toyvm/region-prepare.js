'use strict';

// The region JIT's PREPARATION half: pick a region out of a profile, audit it
// against the interpreter, and compile a module with it. region-live.js has the
// whole design; this file is the part that runs somewhere else.
//
// IT IS A SEPARATE FILE BECAUSE OF WHAT IT DRAGS IN. region-jit.js and
// trace-jit.js are close to 240KB of source between them, and the browser
// bundle inlines every module a root can reach (tools/toyvm/bundle-browser.js)
// -- so one `require('./region-jit')` reachable from live.js put all of it in
// the page's own script and grew it by 37%, for a feature that is off unless
// somebody asks for it. Split, the page carries the driver and the JIT worker
// fetches this half only when the JIT is switched on.
//
// Nothing here touches a live emulator object: the input is the plain profile
// bundle `LiveJit.makeBundle()` builds and the output is module bytes plus a
// verdict, which is exactly what can cross a postMessage.
//
// Every decision about WHICH loop and WHETHER it is safe is region-jit's,
// imported rather than reimplemented: pickRegion, buildRegion, guardBytes,
// regionSuccessors and the snapshot gate. A second copy of those rules would be
// a second policy, and each of them was bought with a bisect nobody would
// re-run on the copy.

const { rankSamples, benchTiers } = require('./trace-jit');
const {
  pickRegion, buildRegion, guardBytes, regionSuccessors, passSpec, isTransfer,
} = require('./region-jit');
const { buildModule } = require('./vm');

const now = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1000);

// `--region-dump=DIR`: the wasm body of every region this install builds, as
// text, one file per region. region-jit's own `--dump` covers the BENCH path
// and cannot see a live install at all, and "is the protocol I just changed
// actually in the module the guest is running" is not a question a frame hash
// can answer. Node only -- the worker has no filesystem and no argv.
function dumpDir() {
  if (typeof process === 'undefined' || !Array.isArray(process.argv)) return null;
  const hit = process.argv.find(a => a.startsWith('--region-dump='));
  return hit ? hit.slice('--region-dump='.length) : null;
}

// Pick, build, guard, audit and compile, from nothing but plain data.
async function prepareRegions(bundle) {
  const t0 = now();
  const regions = new Map();
  for (const p of bundle.progs) {
    const prog = {
      arenaBase: p.arenaBase, words: p.words, covered: p.covered,
      blocks: new Map(p.blocks),
    };
    if (!regions.has(p.key)) regions.set(p.key, []);
    regions.get(p.key).push(prog);
  }
  // guardBytes and the successor list read guest bytes out of `rr.vm.mem`, and
  // the snapshot IS those bytes, taken at the instant the bundle was made.
  const rr = { vm: { mem: bundle.mem }, regions };
  const { ranked, total } = rankSamples({
    ipSamples: new Map(bundle.samples), ipSampleLog: bundle.sampleLog,
    dispatched: bundle.dispatched, regions,
  }, 0);
  if (!ranked.length) return { declined: 'no samples landed in a live block' };

  const state = { tried: new Set(), taken: new Set() };
  const picks = [];
  for (let attempt = 0; attempt < bundle.regions * 4 && picks.length < bundle.regions; attempt++) {
    const p = pickRegion(rr, ranked, bundle.minOps, 400, state);
    if (!p) break;
    p.share = 100 * p.samples / Math.max(1, total);
    if (p.share < bundle.minShare) continue;
    picks.push(p);
  }
  if (!picks.length) return { declined: 'no self-loop region found' };

  const out = [];
  for (const [idx, pick] of picks.entries()) {
    const region = buildRegion(pick.ops, pick.nexts, pick.headIp, `region_${idx}`,
      pick.closed !== false, pick.inner || [], pick.forwards || []);
    if (region.declined && !region.body) return { declined: `build: ${region.declined}` };
    // A REGION THAT COULD NOT LOWER ALL ITS TRANSFERS IS NOT SAFELY
    // INSTALLABLE: such a transfer keeps the interpreter's protocol inside the
    // region's loop, and CARRIE.EXE draws a different screen depending on which
    // successor happened to be compiled at install time -- a difference with no
    // guest semantics behind it at all.
    if (region.unlowered) return { declined: `${region.unlowered} transfer(s) could not be lowered` };
    const guarded = guardBytes(rr, pick);
    // An unguardable region is exactly the one a self-modifying program will
    // invalidate under, so declining IS the point.
    if (!guarded) return { declined: 'a block of this region has no covered span' };
    const succ = regionSuccessors(rr, pick, guarded);
    out.push({
      idx,
      key: `${pick.cs}:${pick.headIp}`,
      headIp: pick.headIp,
      share: pick.share,
      ops: pick.ops.length,
      blocks: pick.blocks,
      guard: guarded,
      succ: succ.succList.map(ip => succ.succBytes(ip)),
      region: { name: region.name, locals: region.locals, body: region.body },
    });
  }
  const tPick = now();

  // THE AUDIT. The same snapshot gate region-jit.js runs before it installs
  // anything: it seeds the ops from a state the program really reached, runs
  // the shipped interpreter over them and the compiled lowering over them, and
  // compares every register and every byte of guest memory afterwards.
  //
  // 4000 iterations is not a round number. Below roughly a thousand the arms
  // are still being tiered up by the host engine and the ratio measures the
  // wasm compiler rather than the lowering (docs/toyvm-trace-jit.md, "THE
  // ITERATION COUNT IS PART OF THE VERDICT").
  //
  // The verdict is stricter here than in the bench. A mismatch over an op list
  // that branches internally is INCONCLUSIVE -- the interpreter arm takes the
  // branch and the compiled arm was emitted as a straight line, so the two ran
  // different programs -- and the bench installs on it anyway, because it has a
  // second arm to compare frames against afterwards. A live install has no such
  // arm. An absent verdict is not a passing one, so it declines.
  const gatePick = picks[0];
  const branchy = gatePick.ops.slice(0, -1).some(isTransfer);
  const hot = {
    bip: gatePick.headIp, memSnapshot: bundle.mem,
    regSnapshot: bundle.regs, machineSnapshot: bundle.machine,
  };
  const g = await benchTiers('live', hot, gatePick.ops,
    { iters: bundle.gateIters, reps: 2, log: () => {}, passes: passSpec() });
  const tGate = now();
  if (!g.agree) {
    return {
      declined: branchy
        ? 'INCONCLUSIVE -- the arms disagree and the op list branches internally,'
          + ' so they did not run the same program'
        : 'the lowering DISAGREES with the interpreter over these ops',
      ms: { pick: tPick - t0, gate: tGate - tPick },
    };
  }
  const ratio = g.speedup.t03;
  if (ratio < bundle.gateAt) {
    return {
      declined: `${ratio.toFixed(2)}x is below the ${bundle.gateAt.toFixed(2)}x bar`,
      gate: { agree: true, ratio }, ms: { pick: tPick - t0, gate: tGate - tPick },
    };
  }

  const dir = dumpDir();
  if (dir) {
    const fs = require('fs'), path = require('path');
    fs.mkdirSync(dir, { recursive: true });
    for (const p of out) {
      const f = path.join(dir, `region-0x${p.headIp.toString(16)}.wat`);
      fs.writeFileSync(f, `(func $${p.region.name} ${p.region.locals}\n${p.region.body}\n)\n`);
    }
  }
  // THE SAME MODULE, PLUS A REGION. `bundle.build` carries the emit options
  // the running instance was made with; passing only `regions` rebuilt on the
  // defaults, which agrees with a default run and silently would not with
  // `--handler-hist` (the histogram changes nothing the arena holds, but the
  // option is part of what the module IS) or `--no-lazy`/`--no-fusecond`,
  // where the guest would be swapped onto handlers with different semantics.
  const built = await buildModule(bundle.variant,
    { ...(bundle.build || {}), regions: out.map(p => p.region) });
  return {
    picks: out, bytes: built.bytes, gate: { agree: true, ratio },
    ms: { pick: tPick - t0, gate: tGate - tPick, build: now() - tGate },
  };
}

// The work in this process, blocking. What the headless runner and the tests
// use: a one-second pause between two slices costs a batch run nothing. The
// page passes a worker-backed backend instead (region-live.js `workerBackend`),
// because there it would be a two-second freeze of the demo.
function inlineBackend() {
  return { name: 'inline', prepare: (bundle) => prepareRegions(bundle) };
}

module.exports = { prepareRegions, inlineBackend };
