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
const isa = require('./isa');

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

// INSTALL-SIDE BISECTORS. `--trap` (region-jit.js) separates "the compiled
// body" from "the install"; these separate the INSTALL into its parts, which is
// the split every divergence measured on this path has actually needed. Node
// only, and read the way region-jit.js reads its own switches -- the page
// passes none of them and `process` is not defined there.
//
//   --no-install-precompile   leave the dropped blocks for the guest to trip
//                             over instead of compiling them back here
//   --install-drop-rtop       empty the shadow return stack instead of keeping
//                             the prefix below the lowest stale frame
//   --no-install-repair-rtop  cut the shadow return stack at the lowest stale
//                             frame instead of re-pointing the stale frames at
//                             the blocks compiled back above
//   --no-install-invalidate   leave the dropped blocks in the cache
//   --no-region-code-bits     do not mark the region's bytes as compiled code
const liveFlag = (n) => (typeof process !== 'undefined' && Array.isArray(process.argv)
  && process.argv.includes(`--${n}`));

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
      // The emit options the running module was built with, so the install's
      // rebuild is the SAME module plus a region. Empty means "the defaults",
      // which is what a default run is.
      build = {},
      log = () => {},
    } = opts;
    Object.assign(this, {
      session, vm, machine, portIn, portOut, sampleAfter, profileFor, regions,
      minShare, minOps, gateAt, gateIters, backend, repFast, cpu, build, log,
    });
    this.phase = 'profiling';
    this.declined = null;
    this.installedAt = null;         // guest ips of the installed regions
    this.installs = 0;
    this.drops = 0;
    // Shadow-return-stack frames an install found stale: how many were
    // re-pointed at the block compiled back in their place, and how many the
    // stack still had to be cut at. Each one of the second kind is a `ret`
    // that will miss, and a miss is a handback the interpreter never took.
    this.rtopRepaired = 0;
    this.rtopCut = 0;
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
      variant: this.vm.variant, build: this.build,
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
    // `--install-audit`: every zero-argument `get_`/`mget_`/`fget_` export the
    // two instances share, compared after the carry. A global the carry does
    // not know about is not a crash, it is a WRONG NUMBER LATER -- `idtb` and
    // `attr_flip` were both found this way, by hand -- and the shape of the
    // bug is always "the list in carryState is not the list emit.js emits".
    // This asks the module instead of the list.
    if (liveFlag('install-audit')) {
      for (const k of Object.keys(next.exports)) {
        if (!/^(get|mget|fget)_/.test(k) || typeof old[k] !== 'function') continue;
        let a, b;
        try { a = old[k](); b = next.exports[k](); } catch (e) { continue; }
        if (a !== b) this.log(`[jit] install-audit: ${k} ${a} -> ${b}`);
      }
    }
    vm.rebind(next);
    // The machine caches the export table it pokes registers through, and the
    // VGA period is programmed once per change -- both have to be told.
    //
    // `setVmExports`, NOT `setMemory`: the latter is the boot-time reset (it
    // reinstalls the IVT, clears the text page and rewrites the BIOS data
    // area), and calling it here took the guest's own interrupt handlers away
    // at the install. That was the whole of the "stops making progress" class
    // -- ACCIDENT, BRW, CONTAGIO and DRAGON -- and none of those four ever
    // executed a single region op: with `--trap` (a region body of
    // `unreachable`) each reproduced its divergence exactly and never trapped.
    if (this.machine) this.machine.setVmExports(vm.exports);
    if (vm.exports.set_rep_fast) vm.exports.set_rep_fast(this.repFast ? 1 : 0);
    // THE CARD'S PROGRAMMING IS RE-APPLIED, NOT RE-DERIVED. `$vga_period`,
    // `$vga_vb`, `$vga_line`, `$vga_hb` and `$vga_phase0` are five globals with
    // no accessor pair, so `carryState` cannot reach them and the new instance
    // starts on the module's defaults (26000/2340/57/11/0). This used to be
    // handled by setting `session.vgaHz = 0`, which makes the next slice
    // program the card AGAIN -- and that is not the same thing: the session
    // only re-reads `vgaTiming()` when the refresh RATE changes, so a card
    // whose line count moved under an unchanged rate is running on a `lines`
    // the current call no longer reports, and the recompute would then hand
    // the new instance a retrace geometry the old instance was not running on.
    // No corpus program has been shown to depend on that difference -- on the
    // measured corpus `vgaTiming()` returns what it returned -- so this is a
    // narrowing, not a fix for a known divergence: it re-applies a number the
    // host already has instead of asking for it again.
    if (this.session.vgaPeriod && vm.exports.set_vga_period) {
      vm.exports.set_vga_period(this.session.vgaPeriod, this.session.vgaLines);
      if (old.get_vga_phase0 && vm.exports.set_vga_phase0) {
        vm.exports.set_vga_phase0(old.get_vga_phase0());
      }
    }

    const cache = this.session.cache;
    cache.regionAt = new Map(prepared.picks.map(p => [p.key, p.idx]));
    cache.regionSucc = new Map(prepared.picks.map(p => [p.key, p.succ]));
    cache.regionBytes = new Map(prepared.picks.map(p => [p.key, p.guard]));
    cache.regionCodeBits = !liveFlag('no-region-code-bits');
    // ONLY THE REGION'S OWN BYTES. This used to flush the whole cache, on the
    // argument that every block in the arena was compiled against the old
    // handler table. It was not: a region is an EXTRA entry appended to that
    // table, so every index already in the arena still names the same handler
    // in the new module, and the arena lives in the shared memory both
    // instances import. The only block that has to be compiled again is the
    // region's head, which has to come back as one word.
    //
    // Flushing was not merely wasteful, it was VISIBLE. Every live block then
    // had to be re-compiled, and a block is compiled through a host round trip
    // -- so the install added one handback per block in the working set, the
    // run loop's slice boundaries moved, and everything derived from them moved
    // with them: DRAGON.EXE came out with 6 more handbacks over 7244 and CYCLE
    // with 15 over 651,113, both with the frame, the pixel count, the interrupt
    // tally and the total dispatch count IDENTICAL and only the rendered audio
    // different. `invalidateRange` is the same narrow drop a self-modifying
    // store takes -- with two adjustments below, because an install is not a
    // guest store and must not cost the run a handback either.
    //
    // Every block head that is about to be dropped, recorded BEFORE the drop:
    // `invalidateRange` takes whole compiled PROGRAMS, not single blocks, so
    // the region's head takes its neighbours with it -- on CYCLE.EXE the head
    // at 682:cba shares a program with the block at 682:2bf, and it was 2bf
    // the guest re-entered first.
    const doomed = new Map();
    const doomedProgs = new Set();
    for (const g of this.guards0(prepared)) {
      for (let p = g.lin >>> 4; p <= (g.lin + g.bytes.length - 1) >>> 4; p++) {
        for (const prog of (cache.byPara.get(p) || [])) {
          if (!prog.live) continue;
          doomedProgs.add(prog);
          for (const [bip] of prog.blocks) doomed.set(`${prog.cs}:${bip}`, [prog.cs, bip]);
        }
      }
    }
    // AND THE SHADOW RETURN STACK IS NOT EMPTIED, IT IS CHECKED.
    // `invalidateRange` clears `$rtop` outright, which is right for a guest
    // store (the arena addresses under it may name code the guest has just
    // rewritten) and wrong here, because it costs the run a handback it would
    // not otherwise have taken: the next `ret` misses, the slice exits early,
    // and its unspent remainder shifts EVERY later slice boundary for the rest
    // of the program. On CYCLE.EXE that one miss put all 650,000 following
    // boundaries 33,909 dispatches early, and since the Sound Blaster's DMA is
    // fetched when a slice's audio is rendered, the card read the guest's
    // double buffer at a different instant of guest time from then on -- an
    // identical frame, identical pixels, identical interrupts and a different
    // wav. So look instead: an entry is stale only if its arena address falls
    // inside a program this install is dropping, and the stack keeps whatever
    // prefix is below the lowest such frame.
    const rtop0 = vm.raw('rtop');
    const stack = new Int32Array(vm.mem.buffer, isa.RSTACK_BASE, rtop0 * 3);
    let keep = rtop0;
    // The arena spans about to stop meaning anything, taken BEFORE the drop --
    // after it, `prog.words` still describes a range the next compile is free
    // to lay something else over.
    const doomedSpans = [...doomedProgs]
      .map(p => [p.arenaBase, p.arenaBase + p.words.length * 4]);
    const stale = (a) => doomedSpans.some(([lo, hi]) => a >= lo && a < hi);
    // ...but only when the drop really was narrow. `invalidateRange` falls back
    // to a whole-cache `flush()` for a wide range or under `--smc-flush`, and a
    // flush leaves no arena address anywhere valid.
    const narrow = !cache.smcFlush
      && this.guards0(prepared).every(g => ((g.lin + g.bytes.length - 1) >>> 4) - (g.lin >>> 4) <= 512);
    if (!liveFlag('no-install-invalidate')) {
      for (const g of this.guards0(prepared)) cache.invalidateRange(g.lin, g.lin + g.bytes.length - 1);
    }
    // ...AND COMPILE IT BACK HERE, NOT WHEN THE GUEST TRIPS OVER IT. A block
    // the cache does not hold is a HANDBACK: $jlook misses, the slice exits,
    // and the host compiles it before the next `run()`. So leaving the head
    // dropped costs the run one extra handback -- once -- and the slice it
    // interrupts is cut short, which moves EVERY LATER SLICE BOUNDARY by the
    // unspent remainder for the rest of the program. Measured on CYCLE.EXE:
    // the install's own handback landed 1856 dispatches into a 35,765-dispatch
    // quantum and every one of the following 650,000 boundaries sat 33,909
    // dispatches earlier than the interpreter's. Frame, pixels, interrupts and
    // the total dispatch count were all identical -- but the Sound Blaster's
    // DMA is fetched when the audio for a slice is rendered, so the card read
    // the guest's double buffer at a different instant of guest time and the
    // wav differed from sample 99,584 on. Compiling the head here is the same
    // work the handback would have done, done on the host's turn instead.
    const vmx = vm.exports;
    const resets0 = cache.arenaResets;
    const curCs = vm.get('cs') & 0xFFFF;
    const codeBase = vmx.get_csb(), linmask = vmx.get_linmask(), d32 = vmx.get_d32() !== 0;
    for (const [cs, bip] of (liveFlag('no-install-precompile') ? [] : doomed.values())) {
      // Only what this CS's base still describes: a block compiled under
      // another selector would be decoded here at the wrong linear address.
      if ((cs & 0xFFFF) !== curCs) continue;
      cache.entryFor(cs & 0xFFFF, bip, codeBase, linmask, d32);
    }
    // ...AND THE SAME ARGUMENT APPLIES TO THE FRAMES ABOVE THE LOWEST STALE
    // ONE. Truncating at the first frame whose arena address is inside a
    // dropped program keeps the stack SOUND, but it still costs the run
    // exactly the handback the paragraph above exists to avoid: the next `ret`
    // that would have popped a truncated frame misses instead, $rpop returns
    // 0, the slice exits early, and the unspent remainder shifts every later
    // boundary. That is BMGLP.EXE, whose frame, pixel count, interrupt tally
    // and dispatch total are identical on and off and whose wav is not: the
    // install truncated one frame, the run took one extra handback (13,206
    // against 13,207 by 4M dispatches), and every slice after it was cut at a
    // different guest instant.
    //
    // A stale frame is not unrecoverable, it is just UNRESOLVED. Frame i holds
    // the guest return offset it was pushed for (+0) and the selector it was
    // pushed under (+8); a block compiled at that offset now is the same code
    // the miss path would have compiled, so the frame can be re-pointed at it
    // instead of thrown away. Only a frame under another selector, or one
    // whose compile does not come back, still forces the cut.
    let repaired = 0, unrepaired = 0;
    if (narrow && !liveFlag('install-drop-rtop') && !liveFlag('no-install-repair-rtop')) {
      for (let i = 0; i < rtop0; i++) {
        if (!stale(stack[i * 3 + 1])) continue;
        let na = 0;
        if ((stack[i * 3 + 2] & 0xFFFF) === curCs) {
          na = cache.entryFor(curCs, stack[i * 3 + 0] >>> 0, codeBase, linmask, d32) || 0;
        }
        if (na) { stack[i * 3 + 1] = na; repaired++; } else { unrepaired++; keep = Math.min(keep, i); }
      }
      // A compile that RECYCLED the arena makes every address in the stack
      // meaningless, repaired ones included, so that one really does cut it
      // back to nothing. `$rtop` itself cannot be asked -- `invalidateRange`
      // has already zeroed it above and the `set` below is what puts it back
      // -- so the arena's own reset counter is what says whether the ground
      // moved under the repair.
      if (cache.arenaResets !== resets0) keep = 0;
    } else {
      for (let i = 0; i < rtop0; i++) if (stale(stack[i * 3 + 1])) keep = Math.min(keep, i);
    }
    vm.set('rtop', (narrow && !liveFlag('install-drop-rtop')) ? keep : 0);
    // Counted for `stats()`, so a test can assert that this path was EXERCISED
    // rather than merely that two arms agreed -- a program whose return stack
    // held no stale frame agrees either way and would grade a repair that
    // never ran.
    this.rtopRepaired += repaired;
    this.rtopCut += rtop0 - ((narrow && !liveFlag('install-drop-rtop')) ? keep : 0);
    // What the install actually cost the cache, under `--region-jit-verbose`:
    // the two numbers a "the wav moved" report always turns out to need.
    this.log(`[jit] install: ${doomedProgs.size} program(s) / ${doomed.size} block(s)`
      + ` dropped, return stack ${rtop0} -> ${(narrow && !liveFlag('install-drop-rtop')) ? keep : 0}`
      + ` (${repaired} frame(s) re-pointed, ${unrepaired} not)`
      + `${narrow ? '' : ' (wide drop)'}`);
    this.guards = this.guards0(prepared);
    this.installedAt = prepared.picks.map(p => p.headIp);
    this.ms.swap = now() - ts;
  }

  guards0(prepared) { return prepared.picks.flatMap(p => p.guard); }

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
      rtopRepaired: this.rtopRepaired, rtopCut: this.rtopCut,
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
  const machine = () => {
    for (const g of MACHINE_STATE) {
      if (from[`mget_${g}`] && to[`mset_${g}`]) to[`mset_${g}`](from[`mget_${g}`]());
    }
  };
  // THE ORDER IS THE WHOLE OF THIS FUNCTION, AND IT USED TO BE WRONG.
  //
  // A segment register is not stored, it is RESOLVED: `set_es` goes through
  // $sset, which calls $segbase, which reads $cr0, $vm86, $gdtb, $gdtl and
  // $ldtb -- every one of them in MACHINE_STATE. Carrying STATE first therefore
  // resolved each of the six selectors on an instance still holding its
  // DEFAULTS: cr0 without PE, an empty GDT. $segbase's out-of-limit rule then
  // reads the selector as a real-mode paragraph, so a protected-mode program
  // came out of the swap with all six shadow bases at `selector << 4` and every
  // segmented access landing somewhere it never asked for. That was CONTAGIO
  // (a DOS extender) and BRW, both of which stopped dead at the install --
  // and, like the IVT bug above them, neither ever executed a region op:
  // `--trap` reproduced both divergences without trapping.
  //
  // So: the machine first, so the descriptor tables are there to resolve
  // against; then the architectural state; then the machine AGAIN, because
  // $sset publishes two MACHINE_STATE globals of its own ($d32 from CS's D bit,
  // $spm from SS's B bit) and the V86 case needs the value the old instance
  // actually held rather than the one a descriptor walk re-derives.
  machine();
  for (const g of STATE) {
    if (from[`get_${g}`] && to[`set_${g}`]) to[`set_${g}`](from[`get_${g}`]());
  }
  machine();
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
