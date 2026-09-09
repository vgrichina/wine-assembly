'use strict';

// The region JIT, inside a program that is already running.
//
//   headless:  node tools/toyvm/run-dos.js DEMO.EXE --region-jit
//   the page:  docs/dos-corpus/demos.html?jit=1   (or the JIT toggle)
//
// WHAT THIS IS, AND WHAT region-jit.js IS NOT. region-jit.js is a BENCH: it
// runs a program once to profile it, builds a region from that profile, and
// then runs the program AGAIN from the start with the region already in the
// module. Nothing it produces has ever been installed into a program that was
// mid-flight, and the two costs a live JIT pays -- profiling while the guest is
// on the clock, and swapping the module underneath it -- are outside that
// measurement by construction.
//
// This installs into the running program. Every decision about WHICH loop and
// WHETHER it is safe is region-jit's, imported rather than reimplemented:
// pickRegion, buildRegion, guardBytes, regionSuccessors and the snapshot gate.
// A second copy of those rules in here would be a second policy, and each of
// them was bought with a bisect nobody would re-run on the copy.
//
// THE SPLIT, AND WHY IT IS WHERE IT IS. The page's thread is the browser's, so
// the question for every stage is how many milliseconds it holds that thread.
// Measured on this box (docs/toyvm-region-live.md):
//
//   emit() the module          ~60ms      | these two are the whole install
//   compileWat() it            ~900ms     | cost, and neither fits in a frame
//   the snapshot audit       ~1300ms      | nor does this
//   rank + walk + build      6-160ms      | nor, on a big cache, does this
//   copy guest memory + the arena  ~10ms  | this does
//   instantiate + carry + flush    ~10ms  | and so does this
//
// So the line is drawn at DATA: everything above the memory copy runs on a
// serializable PROFILE BUNDLE -- the samples, the block cache as plain arrays,
// and a copy of guest memory -- and comes back as bytes plus a verdict. That
// half is region-prepare.js, it touches no live object at all, and that is what
// lets `workerBackend` run it somewhere else. What is left on this thread is
// one memcpy and one instantiate.
//
// `region-prepare.inlineBackend` calls it in-process and blocks; that is what
// the headless runner and the tests use, where a pause between two slices costs
// a batch run nothing. The page passes a worker-backed one, and where a worker
// cannot be built -- a file:// page cannot build one at all -- the JIT reports
// itself unavailable rather than stalling the demo it was meant to speed up.
//
// SWAPPING THE MODULE. A region is an extra entry at the end of the handler
// table, so installing one means a module built with it, and a module is not
// editable after the fact. The new instance is created over the SAME
// WebAssembly.Memory (vm.js `opts.memory`), which is where the guest's RAM, the
// arena of threaded code and the shadow return stack all live; only the wasm
// GLOBALS are per-instance, and `carryState` moves those -- STATE,
// MACHINE_STATE and the x87 file, which is why emit.js grew `fget_st`. Then the
// block cache is flushed so the head of the region is compiled again, this time
// with the region's index as its whole body.
//
// SELF-MODIFYING CODE. Three mechanisms, none of them new:
//   * `regionBytes` -- compile.js checks the region's guest bytes before it
//     installs the substitution, so a rewritten loop simply decodes normally.
//   * `regionCodeBits` -- those same bytes are marked as compiled code, so a
//     store into them raises a self-modify break and dos-loop.js drops the
//     programs covering them, which brings the check above around again.
//   * this file re-checks the guard on every pump. When it fails the region is
//     UNINSTALLED: the maps are cleared, the cache is flushed and the profiler
//     rearms. The first two make a stale region unreachable; this one makes it
//     gone, and it is what "a stale region is a wrong picture" asks for.

// The heavy half is NOT required here, on purpose: region-prepare.js pulls in
// region-jit and trace-jit, and this file is inside the page's own bundle.
// See that file's header for what a literal require of it costs.
const { makeVm } = require('./vm');
const { STATE, MACHINE_STATE, FPU_STATE } = require('./emit');

const now = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1000);


// The same work in a Worker, which is the only version fit for the page. The
// driver is four lines because everything it needs is already a module: the JIT
// bundle (tools/toyvm/bundle-browser.js, JIT_ROOTS) is a script whose whole job
// is to make `prepareRegions` reachable from an `importScripts`.
//
// The bytes come back COPIED, not transferred. compileWat memoizes on its cache
// key and hands back the same Uint8Array to a later caller, so transferring its
// buffer would detach a module the worker still believes it has -- a second
// region on the same program would then compile from a zero-length array. A
// quarter-megabyte structured clone is not worth that.
//
// WHERE THIS IS NOT AVAILABLE. A file:// page cannot construct a Worker at all,
// and that is the case the corpus report is written for (bundle-browser.js's
// header). `create` returns null there, and the caller reports the JIT as
// unavailable rather than falling back to the inline backend -- inline on the
// page means a ~2s freeze of the demo, which is worse than no JIT.
function workerBackend(url) {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || !url) return null;
  const driver = `
    importScripts(${JSON.stringify(String(url))});
    var rl = self.ToyVM.require('tools/toyvm/region-prepare.js');
    self.onmessage = function (e) {
      rl.prepareRegions(e.data).then(function (out) { self.postMessage(out); },
        function (err) {
          self.postMessage({ declined: 'the worker threw: '
            + ((err && err.message) || String(err)) });
        });
    };`;
  let worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([driver], { type: 'text/javascript' })));
  } catch (e) {
    return null;
  }
  return {
    name: 'worker',
    stop() { try { worker.terminate(); } catch (e) { /* already gone */ } },
    prepare: (bundle) => new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      // A worker that throws while LOADING never answers, and a JIT that waits
      // forever for it is a JIT that also never profiles again. Report it the
      // way a decline is reported and let the run carry on interpreting.
      worker.onerror = (e) => resolve({
        declined: `the worker did not load: ${(e && e.message) || 'no message'}`,
      });
      worker.postMessage(bundle);
    }),
  };
}

// --- the live driver --------------------------------------------------------

class LiveJit {
  constructor(opts) {
    const {
      session, vm, machine,
      // Ports have to be re-imported by the new instance, so the caller hands
      // over the same two closures it gave makeVm. Getting this wrong is silent
      // -- the demo simply stops hearing its own hardware.
      portIn, portOut,
      // Guest dispatches to run before sampling starts, and how many to sample
      // over. The defaults mirror region-jit's `--dispatches=12m
      // --sample-from=0.5`: most of this corpus ships compressed, so a profile
      // from dispatch zero finds the DEPACKER, and 12M is the smallest budget a
      // pick has been stable at.
      sampleAfter = 6e6, profileFor = 6e6,
      // How many regions one install carries, the sample share below which a
      // pick is not worth a module rebuild, and the shortest loop worth one.
      regions = 1, minShare = 0, minOps = 4,
      // The gate: the in-isolation ratio the body has to clear, over how many
      // iterations.
      gateAt = 1, gateIters = 4000,
      // WHERE THE PREPARATION RUNS. No default: `region-prepare.inlineBackend()`
      // blocks this thread for a couple of seconds, which is right headless and
      // wrong in a page, and a default would make that choice silently.
      backend,
      // Re-applied to the new instance, because neither is wasm state the carry
      // can see: `repFast` is a switch the host sets, and `cpu` is the decoder's
      // level (its FLAGS half does ride in MACHINE_STATE).
      repFast = true, cpu = 386,
      log = () => {},
    } = opts;
    Object.assign(this, {
      session, vm, machine, portIn, portOut, sampleAfter, profileFor, regions,
      minShare, minOps, gateAt, gateIters, backend, repFast, cpu, log,
    });
    this.phase = 'profiling';
    this.declined = null;
    this.installedAt = null;         // guest ips of the installed regions
    this.installs = 0;
    this.drops = 0;
    this.ms = {};                    // per-stage cost, milliseconds
    this.samples = new Map();        // arena address -> hits
    this.sampleLog = [];             // flat [dispatched, arena address, ...]
    this.dispatched = 0;
    this.busy = false;               // a backend call is in flight
    this.pending = null;             // ...and the promise it is in flight on
    this.guards = null;              // the installed regions' byte guards
    this.share = 0;
    this.gateRatio = null;
  }

  // Chain this into DosSession's `afterSlice`. A budget-expiry return leaves
  // $ip pointing at the next arena word, so it is a genuine program-counter
  // sample -- unlike $gip, which only moves when a trace ENDS and is therefore
  // blind to exactly the hot loops that never end.
  sample({ left, dispatched }) {
    this.dispatched = dispatched;
    if (this.phase !== 'profiling') return;
    if (left >= 0 || dispatched < this.sampleAfter) return;
    const at = this.vm.raw('ip');
    this.samples.set(at, (this.samples.get(at) || 0) + 1);
    this.sampleLog.push(dispatched, at);
  }

  hook() { return (ev) => this.sample(ev); }

  // Everything prepareRegions needs, as plain data. The two costs here are a
  // copy of guest memory and a copy of the arena words the block cache holds;
  // both are memcpys, and together they are the only main-thread work between
  // the profile filling up and the module coming back.
  makeBundle() {
    const progs = [];
    for (const [key, list] of this.session.cache.regions) {
      for (const p of list) {
        progs.push({
          key, arenaBase: p.arenaBase, words: p.words,
          covered: p.covered, blocks: [...p.blocks],
        });
      }
    }
    const regs = {}, machine = {};
    for (const g of STATE) if (this.vm.exports[`get_${g}`]) regs[g] = this.vm.raw(g);
    for (const g of MACHINE_STATE) {
      const get = this.vm.exports[`mget_${g}`];
      if (get) machine[g] = get();
    }
    return {
      variant: this.vm.variant,
      samples: [...this.samples], sampleLog: this.sampleLog,
      dispatched: this.dispatched, progs,
      // A copy, not a view: the guest keeps running while this is being
      // audited, and an audit seeded from memory that moves under it is not an
      // audit of anything.
      mem: this.vm.mem.slice(),
      regs, machine,
      regions: this.regions, minShare: this.minShare, minOps: this.minOps,
      gateAt: this.gateAt, gateIters: this.gateIters,
    };
  }

  // Has the guest rewritten any byte an installed region was compiled from?
  // compile.js checks this too, but only when it is asked to compile the head
  // again; a region that is never recompiled would keep running over code that
  // no longer exists, so the check also lives here, where it can UNINSTALL.
  guardsHold() {
    if (!this.guards) return true;
    const mem = this.vm.mem;
    for (const g of this.guards) {
      for (let i = 0; i < g.bytes.length; i++) if (mem[g.lin + i] !== g.bytes[i]) return false;
    }
    return true;
  }

  uninstall(why) {
    const cache = this.session.cache;
    cache.regionAt = null;
    cache.regionSucc = null;
    cache.regionBytes = null;
    cache.flush();
    this.guards = null;
    this.installedAt = null;
    this.drops++;
    this.phase = 'profiling';
    this.declined = null;
    this.samples = new Map();
    this.sampleLog = [];
    // The next window starts here, not at the run's start: the program has just
    // rewritten its own hot loop, and what it does NEXT is what a new profile
    // should be about.
    this.sampleAfter = this.dispatched;
    this.log(`[jit] uninstalled: ${why}`);
    return this;
  }

  // One step of the pipeline. Never blocks on the backend: a call in flight
  // leaves `busy` set and returns, so the caller's run loop keeps the guest
  // moving while the region is prepared. Call it between slices only -- an
  // install swaps the wasm instance.
  pump() {
    if (this.busy) return this.phase;
    if (this.phase === 'installed') {
      if (!this.guardsHold()) this.uninstall("the guest rewrote the region's own bytes");
      return this.phase;
    }
    if (this.phase !== 'profiling') return this.phase;
    if (this.dispatched < this.sampleAfter + this.profileFor) return this.phase;
    if (!this.samples.size) {
      // Nothing landed in a live block: a program can retire millions of
      // dispatches inside code the cache threw away underneath the samples.
      this.phase = 'declined';
      this.declined = 'no samples landed in a live block';
      return this.phase;
    }
    this.busy = true;
    // `pending` is the handle a caller that CAN wait uses -- run-dos.js awaits
    // it, since a pause between two headless slices costs nothing. The page
    // never waits on it.
    this.pending = this.run().catch((e) => {
      this.phase = 'declined';
      this.declined = `pipeline threw: ${e && e.message ? e.message : String(e)}`;
      this.log(`[jit] ${this.declined}`);
    }).then(() => { this.busy = false; this.pending = null; });
    return this.phase;
  }

  async run() {
    const t0 = now();
    const bundle = this.makeBundle();
    this.ms.bundle = now() - t0;
    const tPrep = now();
    const prepared = await this.backend.prepare(bundle);
    this.ms.prepare = now() - tPrep;
    Object.assign(this.ms, prepared.ms || {});
    if (prepared.gate) this.gateRatio = prepared.gate.ratio;
    if (prepared.declined) {
      this.phase = 'declined';
      this.declined = prepared.declined;
      this.log(`[jit] declined: ${prepared.declined}`);
      return;
    }
    this.share = prepared.picks.reduce((n, p) => n + p.share, 0);
    this.log(`[jit] region at guest ip 0x${prepared.picks[0].headIp.toString(16)}: `
      + `${prepared.picks[0].blocks} block(s), ${prepared.picks[0].ops} ops, `
      + `${prepared.picks[0].share.toFixed(1)}% of samples; gate `
      + `${prepared.gate.ratio.toFixed(2)}x over ${this.gateIters} snapshot iterations`);

    const tInstall = now();
    await this.install(prepared);
    this.ms.install = now() - tInstall;
    this.installs++;
    this.phase = 'installed';
    this.log(`[jit] installed ${prepared.picks.length} region(s) at `
      + `${prepared.picks.map(p => '0x' + p.headIp.toString(16)).join(' ')}`
      + `  (${this.share.toFixed(1)}% of samples; bundle ${this.ms.bundle.toFixed(1)}ms,`
      + ` prepare ${this.ms.prepare.toFixed(0)}ms, install ${this.ms.install.toFixed(1)}ms)`);
  }

  // Move the running program onto an instance of the module that has the
  // region in its table. Ordering matters: state is read out of the OLD exports
  // and written into the NEW ones, so the vm is not rebound until the carry is
  // complete.
  async install(prepared) {
    const vm = this.vm;
    const old = vm.exports;
    // Timed apart from the swap because the two are paid on different threads.
    // `WebAssembly.compile` is asynchronous and browsers run it off the main
    // thread, so what the page loses here is the swap below; headless, where
    // nothing else is running, this line is the whole wait.
    const tc = now();
    const next = await makeVm(vm.variant, {
      portIn: this.portIn, portOut: this.portOut, memory: vm.memory,
      bytes: prepared.bytes,
    });
    this.ms.instantiate = now() - tc;
    const ts = now();
    carryState(old, next.exports);
    vm.rebind(next);
    // The machine caches the export table it pokes registers through, and the
    // VGA period is programmed once per change -- both have to be told.
    if (this.machine) this.machine.setMemory(vm.mem, vm.exports);
    if (vm.exports.set_rep_fast) vm.exports.set_rep_fast(this.repFast ? 1 : 0);
    this.session.vgaHz = 0;

    const cache = this.session.cache;
    cache.regionAt = new Map(prepared.picks.map(p => [p.key, p.idx]));
    cache.regionSucc = new Map(prepared.picks.map(p => [p.key, p.succ]));
    cache.regionBytes = new Map(prepared.picks.map(p => [p.key, p.guard]));
    cache.regionCodeBits = true;
    // Every block in the arena was compiled against the old table, and the head
    // of each region has to be compiled again to become one word. Flushing is
    // what a wide self-modify break already does, so the run loop is known to
    // survive it.
    cache.flush();
    this.guards = prepared.picks.flatMap(p => p.guard);
    this.installedAt = prepared.picks.map(p => p.headIp);
    this.ms.swap = now() - ts;
  }

  // Give the backend back. A worker outlives the page's run otherwise, and a
  // demo that is stopped mid-preparation would leave one compiling a module for
  // a program nobody is watching any more.
  stop() {
    if (this.backend && this.backend.stop) this.backend.stop();
    return this;
  }

  // For a status line: what the JIT is doing, and what it cost.
  stats() {
    return {
      phase: this.phase, declined: this.declined, installs: this.installs,
      drops: this.drops, share: this.share, gate: this.gateRatio,
      at: this.installedAt, ms: { ...this.ms }, backend: this.backend.name,
      samples: this.samples.size,
    };
  }
}

// Every wasm global that is guest state, from one instance to another.
//
// THREE LISTS, AND ALL THREE ARE LOAD-BEARING. STATE is architectural --
// registers, segments, flags, and the interpreter's own $ip/$steps/$smc.
// MACHINE_STATE is what the machine has been configured INTO and is invisible
// in a register dump: $linmask (an XMS handle opens it), $gdtb (entering
// protected mode fills it), $f_res (set_cpu lowers it). FPU_STATE plus the
// eight f64s is the x87 file, which nothing needed until a swap could happen
// mid-calculation.
//
// The flags word goes through get_flags/set_flags on purpose: those materialize
// a deferred lazy-flag rule and retire it, so the arithmetic bits survive the
// move. A raw copy of $flags would carry a word that had not been computed yet.
function carryState(from, to) {
  for (const g of STATE) {
    if (from[`get_${g}`] && to[`set_${g}`]) to[`set_${g}`](from[`get_${g}`]());
  }
  for (const g of MACHINE_STATE) {
    if (from[`mget_${g}`] && to[`mset_${g}`]) to[`mset_${g}`](from[`mget_${g}`]());
  }
  if (from.fget_st && to.fset_st) {
    for (let i = 0; i < 8; i++) to.fset_st(i, from.fget_st(i));
    for (const g of FPU_STATE) to[`fset_${g}`](from[`fget_${g}`]());
  }
  // The two VGA globals that are neither a register nor a setting, and so are
  // in none of the three lists above. Both are guest-visible:
  //
  //   attr_flip is the attribute controller's index/data flip-flop. Port 3C0h
  //   is one address that alternates between meaning "index" and "data", and
  //   reading 3DAh resets it to index. A swap that left it at zero would make
  //   the guest's next 3C0h write land in the wrong half of the pair -- a
  //   palette entry written as an index -- for the rest of that sequence.
  //
  //   vga_reads is the retrace-read accumulator dos-loop drains into
  //   machine.clock.retrace once per slice. Dropping a partial slice's worth
  //   moves the machine's clock, and every sound this emulator makes is timed
  //   off that clock, so it is heard before it is seen.
  for (const g of ['attr_flip', 'vga_reads']) {
    if (from[`get_${g}`] && to[`set_${g}`]) to[`set_${g}`](from[`get_${g}`]());
  }
}

module.exports = { LiveJit, workerBackend, carryState };
