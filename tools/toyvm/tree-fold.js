'use strict';

// The decode-time expression-tree fold.
//
//   node tools/toyvm/run-dos.js DEMO.EXE --tree-fold
//
// WHAT IT IS. A basic block's straight-line interior is a dataflow expression:
// a run of full-width `mov`/`lea`/ALU/shift/widening ops that read and write
// registers and memory and nothing else. The interpreter pays one dispatch per
// op of it and moves every intermediate through the guest register file. This
// takes such a run, generates ONE wasm handler that is the whole run inlined --
// operands folded to constants, `$ea` folded to arithmetic, the register file
// folded to global accesses and then promoted into wasm locals -- and installs
// its index over the run's first arena word.
//
// It is the third fold in the VM and the first that is a TREE. The other two
// are fixed shapes: [superinstructions](../../docs/toyvm-superinstructions.md)
// joins exactly two ops, [spin loops](../../docs/toyvm-spin-loops.md) collapse a
// block that does nothing. This one collapses n ops of real arithmetic into one
// dispatch for any n, and what n is worth is measured in
// [docs/toyvm-tree-fold.md](../../docs/toyvm-tree-fold.md).
//
// NOTHING HERE IS A SECOND POLICY. Three things it would have been easy to
// write twice and does not:
//
//   * WHAT IS FOLDABLE is `expr-fold-census.js`'s `classify()`, imported. The
//     census measured the population this fold exists for, and a fold whose
//     eligibility rule had drifted from the census's would be answering a
//     different question from the one that justified it.
//   * WHAT AN OP TOUCHES is `handler-effects.js`, which resolves a register
//     index back through the arena word that produced it. A fold that guessed
//     a register is not a slow fold, it is a wrong one.
//   * HOW A RUN IS LOWERED is `trace-jit.js`'s `emitTier3` -- the region JIT's
//     own code generator. `foldOperands` -> `foldEa` -> `foldSeg` ->
//     `foldRegisterFile` -> `promoteRegs` is five passes that were each bought
//     with a bisect, and a second copy of them would be a second set of bugs.
//
// THE ARENA DOES NOT CHANGE SIZE, AND THAT IS THE WHOLE CORRECTNESS ARGUMENT.
// A fused pair splices a word out; this one does not. The run's first word is
// overwritten with the tree's handler index and every following word of the run
// is left where it is, counted as an operand the tree steps over. So a folded
// run and an unfolded one lay the arena out identically, byte for byte, and the
// arena-recycle boundary -- which is what moved CONTAGIO, AQUAPHOB, COUNTDWN and
// ZOKDTPLN under fusion -- cannot move. Combined with charging the removed
// dispatches' steps inline, a `--tree-fold` run and a plain one are required to
// be bit-identical, and the corpus sweep is the check.
//
// THE TERMINATOR IS NOT IN THE FOLD. The block's branch, and the `cmp`/`dec`
// that feeds it, stay exactly the ops they were. That is deliberate and it is
// what keeps the clock: a block transfer is where `$slice_exit` tests the
// budget, where a handback is taken, where an IRQ is injected and where the
// Sound Blaster's DMA is fetched. A fold that ran the loop in place would
// ABSORB those transfers, and region-live.js's DREAM row is what that costs --
// an identical picture and a different wav from the install on. Looping in
// place is the region JIT's job and it already has it.
//
// SELF-MODIFYING CODE needs nothing new here for the same reason. The block was
// decoded normally, so `covered` already names its bytes and the code bitmap
// already covers them; a store into any of them raises `$smc`, dos-loop.js
// drops the whole compiled program, and the fold goes with it. What DOES change
// is the fast operand repair: `repairProg` walks `prog.wordIp` per instruction
// and cannot recognise a tree word, so it declines and the store falls back to
// a drop and a recompile. That is a cost, not a hazard, and it is reported.

const isa = require('./isa');
const { HANDLERS, ARITY, prepareTables } = require('./emit');
const { table: effectsTable } = require('./handler-effects');
const { classify, decompTable, stemOf } = require('./expr-fold-census');
const { emitTier3, foldOperands } = require('./trace-jit');
const { makeVm } = require('./vm');
const { carryState } = require('./region-live');

// The op count a run has to reach before it is worth a handler. Four is the
// census's own threshold -- `in >=4-fold blocks` is the column that varies 50x
// across the corpus and decides which programs this can pay on.
const MIN_OPS = 4;

// A handler that reads the dispatch clock cannot be folded: the interpreter
// would have charged one step per op before it, and a fold charges the whole
// run at once, so the value it reads differs. The foldable set contains none of
// these today; the check is here so that stays true rather than being believed.
// Same list region-jit.js flushes its pending step charge for.
const CLOCK_READERS = /\$steps|\$slice_budget|\$vga_status|\$port_in|\$port_out/;
// ...and one that leaves the handler early would leave `$ip` parked in the
// middle of the run's operand words. Same refusal genFusedBranches makes of a
// fused first half, for the same reason.
const ESCAPES = /\$halt|\$slice_exit|\$fault|\$jlook|\(return\)|global\.(get|set) \$ip\b/;

// --- eligibility -------------------------------------------------------------

// One arena op, as the classifier and the lowering both want it.
function opAt(words, p) {
  const fn = words[p];
  const h = HANDLERS[fn];
  if (!h) return null;
  const args = [];
  for (let i = 0; i < h.args; i++) args.push(words[p + 1 + i]);
  return { fn, name: h.name, args, at: p };
}

// A block's operand width, exactly as the census reads it: the arena carries it
// in the op names, and the widest op present is the block's. Taking the widest
// rather than a per-program flag keeps a 16-bit block inside a 32-bit program
// classified as what it is.
function blockWidth(ops, D = decompTable()) {
  for (const o of ops) {
    for (const b of D[o.fn]) if (stemOf(HANDLERS[b].name).width === 32) return 32;
  }
  return 16;
}

// Why one op is not in the fold set, bucketed the way the decline histogram in
// docs/toyvm-tree-fold.md reports it. The census's class names are finer than
// the five buckets the histogram wants, so this is the only mapping and it is
// one-way.
function bucketOf(cls, stem) {
  if (cls === 'partial-reg') return 'partial-reg';
  if (cls === 'cmp-test' || cls === 'flags' || cls === 'adc-sbb' || cls === 'shift-cl') {
    return 'flag consumer';
  }
  if (cls === 'branch' || cls === 'terminator') return 'terminator';
  // Everything else is named by its census class, and `other` -- the catch-all
  // -- carries the opcode stem with it. The histogram is a WORK LIST: "6225
  // unsupported ops" says nothing about what to implement next, and
  // "unsupported: xchg 2100, unsupported: cbw 900" says exactly what. The stem
  // set is bounded by the instruction set, so this cannot grow without limit.
  return cls === 'other' ? `unsupported: ${stem}` : cls;
}

// Split one block's ops into maximal foldable runs.
//
// The rules are the census's, and the two that are not simply "is this op in
// the set" are:
//
//   MEMORY KEEPS ITS SOURCE ORDER. Every load and store stays a `$rd*`/`$wr*`
//   call in the emitted order, so a run may contain as many as it likes.
//   * ...but A STORE FOLLOWED BY A LOAD ENDS THE RUN. This proves nothing about
//     addresses, so every load after a store is assumed to alias. It is the
//     most expensive rule here -- ACCIDENT's hottest block has sixteen
//     consecutive foldable ops and yields a run of twelve because of it -- and
//     relaxing it is the first of the three extensions in the doc.
function eligibleRuns(ops, width, { minOps = MIN_OPS, why = null } = {}) {
  const D = decompTable();
  const T = effectsTable();
  const runs = [];
  let cur = [];
  let sawStore = false;
  const note = (b) => { if (why) why.set(b, (why.get(b) || 0) + 1); };
  const close = () => {
    if (cur.length >= minOps) runs.push(cur);
    else if (cur.length) note('too short');
    cur = [];
    sawStore = false;
  };
  for (const o of ops) {
    const dec = D[o.fn];
    // A fused, traced or spin-collapsed word is more than one guest op and its
    // second half is a branch. Never foldable, and never a decline worth
    // reporting either -- it is the block's terminator.
    if (!dec || dec.length !== 1) { close(); note(dec && dec.length > 1 ? 'terminator' : 'unsupported op'); continue; }
    const base = dec[0];
    const eff = T[base];
    const c = classify(HANDLERS[base].name, width, o.args, eff);
    if (!c.fold) { close(); note(bucketOf(c.cls, stemOf(HANDLERS[base].name).stem)); continue; }
    // The census stops here. The fold has two more questions, both about the
    // BODY rather than the opcode, and both of which can only be asked of the
    // handler that is actually in the arena (which may be the flagless twin).
    // Fold the operands FIRST and ask the two body questions of the RESULT.
    // Every handler reads `$ip` -- that is how it gets its operands -- so
    // testing the raw body for an `$ip` reference declines all of them, which
    // is exactly what it did: 2521 "escapes" against 0 folds on ACCIDENT. What
    // the check is really for is an `$ip` write that is NOT the operand
    // advance (a branch), and after folding, the advance is gone and any `$ip`
    // left is that.
    const folded = foldOperands(HANDLERS[o.fn].body, o.args);
    if (folded === null) { close(); note('operand shape'); continue; }
    if (CLOCK_READERS.test(folded)) { close(); note('clock reader'); continue; }
    if (ESCAPES.test(folded)) { close(); note('escapes'); continue; }
    const memRead = eff.memRead.length > 0;
    const memWrite = eff.memWrite.length > 0;
    if (sawStore && memRead) { close(); note('alias'); cur = [o]; sawStore = memWrite; continue; }
    cur.push(o);
    if (memWrite) sawStore = true;
  }
  close();
  return runs;
}

// --- lowering ----------------------------------------------------------------

// Two runs of the same ops with the same operands are the same handler. The
// arena recycles, and a demo that recompiles its hot loop eighty thousand times
// would otherwise generate eighty thousand identical handlers.
function treeKey(run) {
  return run.map(o => `${o.fn}:${o.args.join(',')}`).join('|');
}

// One run -> one `{ name, locals, body }`, the shape emit.js's `extraHandlers`
// takes. Returns `{ declined }` instead when the lowering will not stand up.
//
// THE BODY'S FOUR PARTS, and why each is where it is:
//
//   the step charge   `$next` charged ONE step to dispatch into this handler
//                     and the run it replaces retired n. So n-1 more are
//                     charged here, inline, and a folded run and an unfolded
//                     one leave `$steps` identical at every block boundary --
//                     which is what makes the corpus a regression test for the
//                     transformation rather than a retiming of it. Charged up
//                     front rather than at the end because nothing inside reads
//                     the clock (`CLOCK_READERS` above is what enforces that),
//                     so the two are the same and this way the read is next to
//                     the count it explains.
//   `pro`             the promoted registers, loaded out of their globals once.
//   the bodies        the run, straight-line, intermediates in wasm locals.
//   `epi`             the promoted registers, stored back once.
//   the `$ip` advance the run's remaining words are the tree's operands and
//                     nothing reads them, but `$ip` still has to step over
//                     them: the next op in the block is behind them.
function buildTree(run, name) {
  const ops = run.map(o => ({ fn: o.fn, name: HANDLERS[o.fn].name, args: o.args, at: o.at }));
  let t3;
  try {
    // `deadflags` OFF, on purpose and not as a default. `killDeadFlags` in
    // trace-jit.js is written for the EAGER flag scheme (it looks for
    // `(call $flags_*)`) and the shipped build is lazy, so it would find
    // nothing -- but more to the point the compiler's own dead-flag pass
    // (compile.js `walkBlock`) has ALREADY run over these words, across block
    // edges, with a real liveness fixpoint. Whatever flag write is still here
    // is one some successor may read.
    t3 = emitTier3(ops, {
      constprop: true, regfold: true, deadflags: false,
      ea: true, seg: true, inline: true, promote: true,
    });
  } catch (e) {
    return { declined: `lowering threw: ${e && e.message ? e.message : String(e)}` };
  }
  const joined = t3.bodies3.join('\n');
  if (CLOCK_READERS.test(joined)) return { declined: 'the lowered body reads the clock' };
  if (ESCAPES.test(joined)) return { declined: 'the lowered body can leave the handler' };
  // Balance, checked here rather than at module build: a fold that unbalanced a
  // body would take the whole module down with a parse error a long way from
  // the run that produced it.
  let depth = 0;
  for (const ch of joined) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return { declined: 'unbalanced body' }; }
  }
  if (depth !== 0) return { declined: 'unbalanced body' };

  const last = run[run.length - 1];
  const first = run[0].at;
  const endW = last.at + 1 + ARITY[last.fn];
  const arity = endW - first - 1;
  const n = run.length;
  const body = [
    `;; tree fold: ${n} ops, ${arity} operand words`
      + `${t3.promoted ? `, ${t3.promoted.length} regs in locals` : `, no promotion (${t3.declined})`}`,
    n > 1 ? `(global.set $steps (i32.sub (global.get $steps) (i32.const ${n - 1})))` : '',
    t3.pro,
    joined,
    t3.epi,
    arity ? `(global.set $ip (i32.add (global.get $ip) (i32.const ${arity * 4})))` : '',
  ].filter(Boolean).join('\n');
  return {
    tree: { name, locals: t3.locals || '', body },
    arity,
    ops: n,
    promoted: t3.promoted ? t3.promoted.length : 0,
    promoteDeclined: t3.declined || null,
    bytes: body.length,
  };
}

// --- the live driver ---------------------------------------------------------

// A fold cannot be installed by writing a word: the handler has to EXIST in the
// module's table, and a module is not editable after the fact. So the shape is
// region-live.js's, in miniature:
//
//   compile   a block wants a tree -> `want()` records it, the block compiles
//             UNFOLDED and runs. Nothing is stalled.
//   pump      between two slices, off the guest clock: build the module with
//             every tree wanted so far appended, instantiate it over the SAME
//             memory, carry the globals, and drop the blocks that wanted one so
//             the next compile of them folds.
//   compile   the same blocks come back with `treeAt` holding their key.
//
// AN INSTALL MUST NOT COST THE RUN A HANDBACK. That is region-live.js's hardest
// lesson and the whole reason the drop below is not a `cache.flush()`: a block
// the cache does not hold is a handback, a handback cuts its slice short, and
// the unspent remainder shifts every later slice boundary -- and therefore
// every IRQ, every audio render and every Sound Blaster DMA fetch -- for the
// rest of the program. Identical picture, different wav, from the install on.
// So the dropped heads are compiled BACK here, on the host's turn, and the
// shadow return stack is repaired rather than cut.
class TreeFolder {
  constructor({
    session, vm, machine, portIn, portOut, build = {}, repFast = true,
    maxTrees = 256, maxInstalls = 4, minOps = MIN_OPS, log = () => {},
    batchMin = 64, batchWait = 400,
  }) {
    Object.assign(this, {
      session, vm, machine, portIn, portOut, build, repFast,
      maxTrees, maxInstalls, minOps, log, batchMin, batchWait,
    });
    this.sinceWant = 0;
    this.trees = [];                  // the `{name, locals, body}` list, in table order
    this.treeOps = [];                // guest ops each of those stands for
    this.at = new Map();              // key -> ordinal
    this.arity = new Map();           // key -> operand words the handler steps over
    this.pendingSites = new Map();    // lin -> true, blocks to drop at the next install
    this.wantedKeys = new Map();      // key -> run, not yet built
    this.installs = 0;
    this.folds = 0;                   // runs folded, over the whole run
    this.foldedOps = 0;               // guest ops inside them
    this.why = new Map();             // decline histogram
    this.declinedTrees = new Map();   // lowering declines, by reason
    this.watBytes = 0;
    this.ms = { build: 0, instantiate: 0, swap: 0 };
    this.capped = false;
  }

  // Where this module's extra handlers start in the table. Read off the VM
  // rather than remembered, because `makeVm` computes it from the built
  // module's own handler count -- the same discipline region-jit keeps, for the
  // same reason: an ordinal is not a table index and only the module knows the
  // difference.
  get base() { return this.vm.regionBase || 0; }

  // Called from compile.js when a run is eligible and its handler does not
  // exist yet. `lin` is a byte inside the block, which is all the drop needs.
  want(key, run, lin) {
    if (this.at.has(key) || this.wantedKeys.has(key)) {
      if (lin !== undefined) this.pendingSites.set(lin, true);
      return;
    }
    if (this.trees.length + this.wantedKeys.size >= this.maxTrees
        || this.installs >= this.maxInstalls) {
      this.capped = true;
      return;
    }
    this.wantedKeys.set(key, run);
    this.sinceWant = 0;
    if (lin !== undefined) this.pendingSites.set(lin, true);
  }

  note(b, n = 1) { this.why.set(b, (this.why.get(b) || 0) + n); }

  // WHEN to stop and rebuild, which is the whole install policy and the one
  // thing here that is a tuning decision rather than a correctness one.
  //
  // A run discovers its foldable blocks a few at a time, over thousands of
  // slices, so "install as soon as something wants a tree" means a module build
  // per tree. Measured on ACCIDENT at 3M dispatches: 24 installs, 38 trees,
  // 5.7 SECONDS of building against 0.16s for the whole unfolded run. Batching
  // is not an optimization of that, it is what makes the fold usable at all.
  //
  // So a batch goes in when it is big enough to be worth a build, or when it
  // has stopped growing -- the second half matters because a program that only
  // ever finds three foldable blocks would otherwise never install any of them.
  tick() { if (this.wantedKeys.size) this.sinceWant++; }

  needsInstall() {
    if (!this.wantedKeys.size) return false;
    return this.wantedKeys.size >= this.batchMin || this.sinceWant >= this.batchWait;
  }

  // Everything compile.js needs to substitute. Handed over as plain maps so the
  // compiler never reaches into this object.
  maps() { return { treeAt: this.at, treeArity: this.arity, treeBase: this.vm.regionBase }; }

  async pump() {
    if (!this.needsInstall()) return false;
    const built = [];
    for (const [key, run] of this.wantedKeys) {
      const r = buildTree(run, `tree_${this.trees.length + built.length}`);
      if (r.declined) {
        this.declinedTrees.set(r.declined, (this.declinedTrees.get(r.declined) || 0) + 1);
        continue;
      }
      built.push({ key, ...r });
    }
    this.wantedKeys.clear();
    this.sinceWant = 0;
    if (!built.length) { this.pendingSites.clear(); return false; }
    for (const b of built) {
      // How many guest ops this handler stands for, kept in table order. It is
      // the only way to turn a dispatch census back into "dispatches removed":
      // `--handler-hist` counts how often each handler ran, and a tree that ran
      // N times removed N*(ops-1) trips through `$next`. Without it the fold's
      // headline number would have to be inferred from a timing.
      this.treeOps.push(b.ops);
      this.at.set(b.key, this.trees.length);
      this.arity.set(b.key, b.arity);
      this.trees.push(b.tree);
      this.watBytes += b.bytes;
    }
    await this.install();
    this.installs++;
    return true;
  }

  // Move the running program onto a module whose table has the trees in it.
  // The recipe is region-live.js `install()`, minus everything a REGION needs
  // that a tree does not: there is no guest-ip keyed substitution map to set, no
  // successor list to pre-compile (a tree replaces ops INSIDE a block, so the
  // block's own edges are untouched), and no byte guard to arm (the block was
  // decoded normally, so the code bitmap already covers it).
  async install() {
    const vm = this.vm;
    const old = vm.exports;
    const t0 = now();
    const next = await makeVm(vm.variant, {
      portIn: this.portIn, portOut: this.portOut, memory: vm.memory,
      ...this.build, regions: this.trees,
    });
    this.ms.instantiate += now() - t0;
    const t1 = now();
    carryState(old, next.exports);
    vm.rebind(next);
    // The machine caches the export table it pokes registers through, and the
    // VGA card's programming is five globals with no accessor pair, so neither
    // survives the swap on its own. `setVmExports`, never `setMemory` -- the
    // latter is the boot-time reset and takes the guest's own interrupt
    // handlers away (region-live.js "What was wrong", item 1).
    if (this.machine && this.machine.setVmExports) this.machine.setVmExports(vm.exports);
    if (vm.exports.set_rep_fast) vm.exports.set_rep_fast(this.repFast ? 1 : 0);
    if (this.session.vgaPeriod && vm.exports.set_vga_period) {
      vm.exports.set_vga_period(this.session.vgaPeriod, this.session.vgaLines);
      if (old.get_vga_phase0 && vm.exports.set_vga_phase0) {
        vm.exports.set_vga_phase0(old.get_vga_phase0());
      }
    }
    this.dropWanting();
    this.ms.swap += now() - t1;
    this.log(`[tree] install ${this.installs + 1}: ${this.trees.length} tree(s) in the table, `
      + `${(this.watBytes / 1024).toFixed(1)}KB of WAT`);
  }

  // Drop exactly the programs holding a block that wanted a tree, compile them
  // back here, and repair the shadow return stack. Every line of this is
  // region-live.js's, and the two comments worth keeping are why the last two
  // steps exist at all: a dropped head is a handback the interpreter never
  // took, and a truncated return frame is another one.
  dropWanting() {
    const cache = this.session.cache;
    const vm = this.vm;
    const sites = [...this.pendingSites.keys()];
    this.pendingSites.clear();
    if (!sites.length) return;

    const doomed = new Map();
    const doomedProgs = new Set();
    for (const lin of sites) {
      for (const prog of (cache.byPara.get(lin >>> 4) || [])) {
        if (!prog.live) continue;
        doomedProgs.add(prog);
        for (const [bip] of prog.blocks) doomed.set(`${prog.cs}:${bip}`, [prog.cs, bip]);
      }
    }
    const rtop0 = vm.raw('rtop');
    const stack = new Int32Array(vm.mem.buffer, isa.RSTACK_BASE, rtop0 * 3);
    const doomedSpans = [...doomedProgs]
      .map(p => [p.arenaBase, p.arenaBase + p.words.length * 4]);
    const stale = (a) => doomedSpans.some(([lo, hi]) => a >= lo && a < hi);
    // `invalidateRange` falls back to a whole-cache flush for a wide range, and
    // a flush leaves no arena address anywhere valid -- so the repair below is
    // only sound when every drop really was narrow.
    const narrow = !cache.smcFlush;
    let keep = rtop0;
    for (const lin of sites) cache.invalidateRange(lin, lin);

    const vmx = vm.exports;
    const resets0 = cache.arenaResets;
    const curCs = vm.get('cs') & 0xFFFF;
    const codeBase = vmx.get_csb(), linmask = vmx.get_linmask(), d32 = vmx.get_d32() !== 0;
    for (const [cs, bip] of doomed.values()) {
      if ((cs & 0xFFFF) !== curCs) continue;
      cache.entryFor(cs & 0xFFFF, bip, codeBase, linmask, d32);
    }
    if (narrow) {
      for (let i = 0; i < rtop0; i++) {
        if (!stale(stack[i * 3 + 1])) continue;
        let na = 0;
        if ((stack[i * 3 + 2] & 0xFFFF) === curCs) {
          na = cache.entryFor(curCs, stack[i * 3 + 0] >>> 0, codeBase, linmask, d32) || 0;
        }
        if (na) stack[i * 3 + 1] = na; else keep = Math.min(keep, i);
      }
      if (cache.arenaResets !== resets0) keep = 0;
    } else {
      for (let i = 0; i < rtop0; i++) if (stale(stack[i * 3 + 1])) keep = Math.min(keep, i);
    }
    vm.set('rtop', narrow ? keep : 0);
  }

  stats() {
    return {
      installs: this.installs, trees: this.trees.length, folds: this.folds,
      base: this.base, treeOps: [...this.treeOps],
      foldedOps: this.foldedOps, watBytes: this.watBytes, capped: this.capped,
      why: this.why, declinedTrees: this.declinedTrees, ms: { ...this.ms },
    };
  }
}

const now = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1000);

module.exports = {
  TreeFolder, eligibleRuns, buildTree, treeKey, blockWidth, opAt, MIN_OPS,
  CLOCK_READERS, ESCAPES,
};
