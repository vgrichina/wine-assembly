'use strict';

// The loop that drives the guest, with nothing around it.
//
// Running a DOS program is not `call run() and wait`. It is a cycle: compile a
// region, run a slice of it, notice why the slice ended, service whatever the
// guest asked for, advance the clock, maybe push an interrupt in front of the
// next instruction -- and every one of those steps has a reason that took a
// while to find. The comments here are those reasons, and they belong with the
// code rather than in whichever driver happens to be calling it.
//
// There are two drivers now. run-dos.js runs a program to completion and
// photographs it; the report page runs one in a browser tab, a chunk per frame,
// with a person at the keyboard. A second copy of this cycle would have started
// out subtly different and drifted from there, so both call this instead.
//
// Everything host-shaped stays out: no fs, no process, no console. What the
// caller wants to watch, it watches through `hooks`.

const isa = require('./isa');

// How many times a CS-override store has to hit nothing compiled before the
// decoder stops cutting the block at it.
//
// This is a COST threshold, not a correctness one, and the difference is the
// whole point. It is tempting to read a run of misses as proof that the store
// writes data rather than code -- that was the first version of this, at 48 --
// but the miss count cannot carry that meaning. A Turbo Pascal OVERLAY is code
// copied into a buffer at run time, so the copy stores into a code segment
// nothing has compiled YET and misses every single time, exactly like a table
// write does. MINTRO.EXE loads GoldPlay.ovl, and at 48 it lost its whole frame
// and exited with Turbo Pascal's error 200.
//
// So the only defensible reading is the narrow one: retire the cut once it has
// demonstrably become the dominant cost of the run, the way a JIT tiers up.
// The two populations are four orders of magnitude apart -- MINTRO's site fires
// 48 times in a 255-break run, DOPE.EXE's fires 134414 -- so this sits well
// above anything a program that merely loads an overlay will reach.
const PATCH_MISSES = 20000;
// How far ahead of the program counter a store still counts as patching the
// instruction stream. One block: the point is to cover the code the guest is
// about to run without exempting a data table that merely lives downwind.
const PATCH_AHEAD = 256;
// How many self-modify breaks a paragraph takes before the JIT gives up on
// it and compiles it fresh at every entry (CodeCache.noteSmc). A packed
// program writes each paragraph once, a multi-stage one a few times; a mixer
// patching its immediates passes this within its first few interrupts.
const VOLATILE_AFTER = 8;
// ...and how many uncached compiles in a row may find the bytes unchanged
// before the paragraph goes back to the cache (CodeCache.volatileEntry).
const VOLATILE_STALE = 256;

// The registers checkProgress folds into its "did anything move" hash. Hoisted
// out of the function because that function runs once per handback, and a
// program polling the BIOS keyboard from inside its frame loop hands back
// every seventeen instructions.
const PROGRESS_REGS = ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'ds', 'es'];
const { compileProgram } = require('./compile');
const { decodeOne, readOperand, OPERAND_SIZE } = require('./decode');
const { ARITY, NOFLAG, FUSE, TRACE, SPIN, PSPIN } = require('./emit');
const { STUB_SEG, STUB_OFF, STUB_BYTE } = require('./dos');

// Is `h`, the op word a compiled program holds, what the compiler makes of
// the decoded handler `x`? The passes after decoding swap an op for a twin
// that reads the same operand words: the flagless copy (dead flags), the
// traced branch (no fall-through arena operand), the spin-collapsed branch.
// Each of those can also be flagless. repairOperands needs the question
// answered without re-running the passes.
function twinOf(h, x) {
  if (h === x) return true;
  for (const m of [NOFLAG, TRACE, SPIN, PSPIN]) {
    const t = m.get(x);
    if (t === undefined) continue;
    if (t === h || NOFLAG.get(t) === h) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The compiled-code arena.
//
// One compiled region per (cs, entry ip). compileProgram walks the whole
// reachable subgraph within that cs, so most entries hit an existing region's
// block map and cost nothing.
class CodeCache {
  constructor(vm, { noCache = false, smcFlush = false, watch = [],
                    wasmDecode = true, fuse = true, deadFlags = true, crossFlags = true,
                    traceBlocks = true, spinLoops = true, regSpec = false,
                    traceDeadFlags = null, regionAt = null, regionSucc = null,
                    regionBytes = null, regionCodeBits = true,
                    volatileCode = true } = {}) {
    // Code the guest rewrites too often to cache. See noteSmc: a paragraph
    // that keeps taking self-modify breaks is marked volatile, cached compiles
    // stop at its edges, and a block inside it is compiled fresh into the
    // arena's scratch headroom every time the host enters it -- the JIT is
    // switched off for exactly those bytes. `--no-volatile` is the A/B
    // partner and restores the drop-and-retrace on every store.
    this.volatileCode = volatileCode;
    this.volPara = new Uint8Array(isa.GUEST_RAM_SIZE >> 4);   // 1 = volatile
    this.volHits = new Uint8Array(isa.GUEST_RAM_SIZE >> 4);   // breaks so far
    this.volList = [];               // the volatile paragraphs, sorted
    // run head paragraph -> { hash of the run's bytes at the last uncached
    // compile, entries in a row that found them unchanged }
    this.volState = new Map();
    // volatile paragraph -> the cached programs holding an `end` stub into it
    this.stubProgs = new Map();
    this.volatileCompiles = 0;
    this.volatilePure = 0;       // ...of which ran with their code bits down
    this.volatileLinks = 0;      // exits resolved straight into cached blocks
    this.promotions = 0;
    this.demotions = 0;
    // Self-modify breaks answered by rewriting an operand word in the arena
    // instead of dropping the program (repairOperands).
    this.patched = 0;
    this.fastRepairs = 0;
    this.plans = new Map();      // see repairOperands
    this.repairWhy = new Map();   // decline reason -> count, for --smc-census
    // Watchpoints, as [lo, hi] linear byte ranges. They ride the CODE_BITMAP
    // rather than adding a range test to $wr8, because $wr8 is on the hot path
    // of every single store the guest makes and a watch that is off must cost
    // nothing at all. Marking a byte there makes the existing store path report
    // the write as a self-modify break, which --smc-census already reports as
    // "CS:IP wrote LO-HI" -- exactly the question a watch is asked. The only
    // side effect is that writing a watched byte drops any region compiled over
    // it, which is a cache miss and not a behaviour change.
    this.watch = watch;
    // --smc-flush restores the whole-cache flush this used to do on every
    // self-modifying store. Its A/B partner: the two differ only in how much of
    // the cache survives, so a program that behaves differently under it has a
    // stale-code bug and not a slow one.
    this.smcFlush = smcFlush;
    // Store sites the decoder should stop treating as self-patching, and how
    // many times each has been seen hitting nothing compiled. Learned about the
    // program rather than cached from it, so a flush does not clear them.
    this.benign = new Set();
    this.patchMisses = new Map();
    // Store site -> the [lo, hi] linear range its block last dirtied as a
    // kind-2 break. What benignPatch judges that site's kind-1 breaks by.
    this.siteRange = new Map();
    this.vm = vm;
    // The wasm decoder, if this build has one. `--no-wasm-decode` turns it off
    // for an A/B; what it decodes is byte-identical to what the JS decoder
    // would have produced (tools/toyvm/decode-diff.js), so the two arms differ
    // only in what the decoding cost.
    this.wasmDecoder = (wasmDecode && vm.exports.compile_block) ? vm : null;
    // Superinstruction formation in the compiler. `--no-fuse` is its A/B
    // partner, and the two arms are meant to be indistinguishable in output:
    // a fused pair charges the step its removed dispatch used to, so slice
    // boundaries and interrupt timing do not move.
    this.fuse = fuse;
    // Dead flag write elimination in the compiler. `--no-deadflags` is its A/B
    // partner, and like fusion the two arms must be indistinguishable: a write
    // is only dropped where the block proves nobody reads it, so the guest
    // cannot tell.
    this.deadFlags = deadFlags;
    // Whether that liveness crosses a block edge. `--no-crossflags` keeps the
    // elimination but stops the walk at the block end, which is the narrower
    // question the first version of this asked.
    this.crossFlags = crossFlags;
    // Compiling through a conditional branch. `--no-trace-blocks` is the A/B
    // partner: a traced run retires the same dispatches in the same order, so
    // the two arms differ only in arena footprint.
    this.traceBlocks = traceBlocks;
    this.tracedBlocks = 0;
    // Collapsing a one-branch loop back to its own head. `--no-spin` is the A/B
    // partner: the two arms retire the same STEPS and reach the same frame, and
    // differ only in how many dispatches it took.
    this.spinLoops = spinLoops;
    this.spinBlocks = 0;
    this.regSpec = regSpec;
    this.specOps = 0;
    this.traceDeadFlags = traceDeadFlags;
    // guest ip -> handler index of a JIT-compiled loop region installed there.
    // Keyed by guest ip so it survives arena recycling; see the note in
    // compile.js. Null on every ordinary run.
    this.regionAt = regionAt;
    // guest ip of a region -> the guest ips it can leave to, so the decoder
    // still discovers the code downstream of a block it never decodes.
    this.regionSucc = regionSucc;
    // The guest bytes each region was compiled from. compile.js refuses to
    // install one whose code has been rewritten underneath it.
    this.regionBytes = regionBytes;
    // Whether an installed region's guest bytes are marked as compiled code.
    // They must be, or a store into them is invisible to the self-modify check
    // -- see the note at the substitution in compile.js. False is the bisector.
    this.regionCodeBits = regionCodeBits;
    this.deadFlagsDropped = 0;
    this.noCache = noCache;
    this.regions = new Map();          // cs -> [prog]
    // cs -> (guest ip -> the first prog in that list holding a block at it).
    // entryFor and the volatile exit linker used to walk the whole list per
    // lookup, and on CYCLE's mixer -- 66k scratch compiles, each linking its
    // exits -- that walk was half of entryFor's own time.
    this.blockIndex = new Map();
    this.arenaNext = isa.THREAD_BASE;
    this.arenaEnd = isa.THREAD_BASE + isa.THREAD_SIZE - 4096;
    this.compiles = 0;
    this.compiledWords = 0;
    this.arenaResets = 0;
    this.unimplemented = new Map();
    this.jtab = new Int32Array(vm.mem.buffer, isa.JTAB_BASE, isa.JTAB_SIZE >> 2);
    this.codeBits = new Uint8Array(vm.mem.buffer, isa.CODE_BITMAP, isa.CODE_BITMAP_SIZE);
    this.codeBits.fill(0);
    this.armWatch();
    // paragraph -> the compiled programs that decoded a byte in it. This is the
    // reverse of codeBits: the bitmap answers "did anyone compile here", which
    // is what the guest's store path can afford to ask, and this answers "who",
    // which is what turns a self-modifying store into a few dropped regions
    // instead of an empty cache.
    this.byPara = new Map();
    // Arena addresses of entries whose FIRST instruction the decoder refused.
    // Running one of those moves the guest nowhere -- the compiled block is
    // `end, ip` -- so a run that keeps arriving at one is not executing the
    // program at all. See DosSession.checkProgress.
    //
    // Keyed by arena address rather than by cs:ip because step() asks on every
    // handback and already has the address in hand: a number in a Set costs a
    // hash, and building the pair into a string would put back the allocation
    // checkProgress was just relieved of. The arena is bump-allocated, so an
    // address is unique while it is live, and every path that recycles or drops
    // one empties this with it.
    this.refusedEntries = new Set();
  }

  // Everything compiled is now suspect, because the guest wrote into code that
  // had been compiled somewhere. The fallback, for a dirtied range too wide to
  // be worth walking.
  flush() {
    this.regions.clear();
    this.blockIndex.clear();
    this.byPara.clear();
    this.plans.clear();
    this.stubProgs.clear();
    this.refusedEntries.clear();
    this.vm.set('rtop', 0);
    this.jtab.fill(0);
    this.codeBits.fill(0);
    this.armWatch();
  }

  // Re-mark the watched bytes. Every path that clears the bitmap has to call
  // this, or a watch goes quiet the first time the guest unpacks itself --
  // which is precisely the moment worth watching.
  armWatch() {
    for (const [lo, hi] of this.watch) {
      for (let l = lo; l <= hi; l++) this.codeBits[l >>> 3] |= 1 << (l & 7);
    }
  }

  // The same answer, restricted to the linear bytes the slice actually wrote.
  //
  // The flush above used to be the only answer, on the argument that a program
  // unpacks itself once. That is true of a packed program and false of an
  // encrypted one: COMPCODE.EXE decrypts as it runs and took 1526 self-modify
  // breaks in its first 200k dispatches, so every hot loop in the program was
  // being thrown away and re-decoded 1526 times, and it drew nothing inside a
  // 300M-dispatch budget it should not have needed. Dropping only the regions
  // that covered the written paragraphs leaves the rest of the cache standing.
  //
  // Wide ranges still flush: past a few hundred paragraphs the walk costs more
  // than the recompile it saves, and a store that wide is a program moving its
  // whole image anyway.
  // A store landed on [lo, hi] and some cached program decoded those bytes.
  // Before that program is dropped: was anything but an operand written?
  //
  // Code that patches its own immediates is the common shape of self-modifying
  // code in this corpus, and it is not a program rewriting itself so much as a
  // program keeping a variable inside an instruction. CYCLE.EXE's mixer walks
  // a sample with `adc word [disp], 0` into the displacement of the `mov bl,
  // [bx+disp]` two instructions up, every timer interrupt; CYBOMAN2.EXE's
  // polygon filler stores the slope of each edge into the imm32 of the `add
  // esi, imm32` / `adc edi, imm32` pair in its scanline loop, once per span.
  // Dropping and re-tracing the program for each of those cost more than the
  // instruction it patched -- CYBOMAN2 spent 530ms of every guest second in
  // 42,000 compiles, CYCLE 17,700 per second through its whole run -- and the
  // volatile-paragraph fallback (noteSmc) only trades the re-trace for an
  // uncached compile per entry.
  //
  // So the instruction is decoded again from the bytes as they are now, and
  // if it is the same instruction with different operand values -- same
  // handler (or its flagless twin), same arity, every non-operand word equal,
  // and every written byte inside one of the operands the decoder claimed
  // (decode.js `operands`) -- the operand words are rewritten in the arena
  // and the program stands. Anything else, and the store falls through to
  // the drop it always got: a changed opcode, a changed ModRM, a written
  // branch displacement, a fused pair (its arity is the sum), a byte in an
  // instruction the decoder now refuses. Every program that covers the range
  // has to pass, or none is patched.
  //
  // The break itself still happens -- $wr8 cannot know what it hit -- so what
  // this saves is the compile, not the handback.
  repairOperands(lo, hi) {
    this.repairRange = `${lo.toString(16)}-${hi.toString(16)}`;
    // A slice's stores into code, as one range. Past this it is a program
    // moving its image, and invalidateRange's own width test takes it.
    if (hi - lo > 512) return this.decline('range too wide');
    // The same site writes the same range every time (CYCLE's mixer ISR:
    // 30879 breaks, one range), and the decode walk below costs more than
    // the compile it replaces -- 46us against 12.6us, decodeOne + repairProg
    // were 17% of a profile. So the first repair of a range leaves a plan:
    // which operand words it patched and what every OTHER decoded byte in
    // the range held. A later break on the same range whose non-operand
    // bytes still match is the same repair with new operand values, read
    // straight off memory. Any other case takes the full walk again.
    const key = lo * 4096 + (hi - lo);
    const plan = this.plans.get(key);
    if (plan) {
      const mem = this.vm.mem;
      let ok = true;
      for (const prog of plan.progs) if (!prog.live) { ok = false; break; }
      const { at, byte } = plan;
      for (let i = 0; ok && i < at.length; i++) if (mem[at[i]] !== byte[i]) ok = false;
      if (ok) {
        const arena = new Int32Array(mem.buffer);
        const rd = (l) => mem[l];
        for (const [prog, q, a, kind] of plan.ops) {
          const v = readOperand(rd, a, kind);
          prog.words[q] = v;
          arena[(prog.arenaBase >> 2) + q] = v;
        }
        this.patched++;
        this.fastRepairs++;
        return true;
      }
      this.plans.delete(key);
    }
    const progs = new Set();
    for (let p = lo >>> 4; p <= hi >>> 4; p++) {
      for (const prog of (this.byPara.get(p) || [])) progs.add(prog);
    }
    if (!progs.size) return this.decline('no cached program covers the range');
    const patches = [];
    for (const prog of progs) if (!this.repairProg(prog, lo, hi, patches)) return false;
    const mem = this.vm.mem;
    const arena = new Int32Array(mem.buffer);
    for (const [prog, q, v] of patches) {
      prog.words[q] = v;
      arena[(prog.arenaBase >> 2) + q] = v;
    }
    this.patched++;
    this.rememberPlan(key, lo, hi, progs, patches);
    return true;
  }

  // The plan is only kept when the operand value the walk produced IS what
  // readOperand reads back at the operand's bytes, for every operand -- so
  // the fast path cannot differ from the walk on this site. Bytes the walk
  // decoded but did not patch are snapshotted; bytes in the range no program
  // decoded (the ISR's own counters, sitting between its instructions) are
  // not, because the walk never looked at them either.
  rememberPlan(key, lo, hi, progs, patches) {
    const mem = this.vm.mem;
    const rd = (l) => mem[l];
    const isOperand = new Uint8Array(hi - lo + 1);
    const ops = [];
    for (const [prog, q, v, at, kind] of patches) {
      if (readOperand(rd, at, kind) !== v) return;
      const size = OPERAND_SIZE[kind];
      for (let b = at; b < at + size; b++) if (b >= lo && b <= hi) isOperand[b - lo] = 1;
      ops.push([prog, q, at, kind]);
    }
    const at = [], byte = [];
    for (const prog of progs) {
      for (const [from, to] of prog.covered) {
        for (let b = Math.max(lo, from); b <= Math.min(hi, to - 1); b++) {
          if (!isOperand[b - lo]) { at.push(b); byte.push(mem[b]); }
        }
      }
    }
    if (this.plans.size >= 256) this.plans.clear();
    this.plans.set(key, { progs: [...progs], ops, at, byte });
  }

  repairProg(prog, lo, hi, patches) {
    const mem = this.vm.mem;
    const rd = (l) => mem[l];
    const { codeBase, mask, d32, cs, words } = prog;
    const reached = new Uint8Array(hi - lo + 1);
    for (const [q, ip] of prog.wordIp) {
      const lin = (codeBase + ip) & mask;
      // An instruction is at most 15 bytes, so nothing starting further below
      // the store than that can reach it.
      if (lin > hi || lin + 15 < lo) continue;
      const d = decodeOne(rd, cs, ip, codeBase, mask, d32, this.benign);
      if (!d) return this.decline('decoder refused the instruction');
      if (lin + d.length <= lo) continue;
      const w = d.words;
      // The decoded words are whole ops laid out by arity, and the first of
      // them must be the op the arena holds at q: itself, one of its twins
      // (flagless, traced, spin-collapsed), or the op it was FUSED into with
      // the branch that follows it -- the fused body reads the same operand
      // words at the same offsets, and only the branch's opcode word is gone.
      // A refused byte or a cut the decode no longer makes fails here.
      const h = words[q];
      if (h === undefined) return this.decline('word past the program');
      let i = 0;
      while (i < w.length) i += 1 + ARITY[w[i]];
      if (i !== w.length) return this.decline('decoded words are not whole ops');
      let span = d.length;
      if (!twinOf(h, w[0])) {
        const d2 = w.length === 1 + ARITY[w[0]] && decodeOne(rd, cs, d.nextIp, codeBase, mask, d32, this.benign);
        const f = d2 ? FUSE.get(w[0] * 65536 + d2.words[0]) : undefined;
        if (f === undefined || !twinOf(h, f)) return this.decline('handler differs');
        // Only the first half's operand words are checked and patched; the
        // branch's are arena addresses. So the store must not reach the
        // branch: its bytes have no op of their own in wordIp any more.
        if (hi >= lin + d.length) return this.decline('store reaches the fused branch');
      } else if (ARITY[h] !== ARITY[w[0]]) return this.decline('arity differs');
      const ops = d.operands;
      for (let k = 1; k < w.length; k++) {
        if (ops.some((o) => o.word === k)) continue;
        if (words[q + k] !== w[k]) return this.decline('a non-operand word differs');
      }
      // The range is the union of every store the slice made into code, so
      // it can hold bytes nothing wrote -- the opcode between two patched
      // immediates (CYBOMAN2 stores both slopes in one slice). Which bytes
      // changed is not knowable here and does not matter: the op decoded
      // from the bytes as they are now IS the arena's op with these operand
      // values, so writing them makes the arena what a fresh compile would
      // be, whatever the store touched.
      for (let b = Math.max(lo, lin); b <= Math.min(hi, lin + span - 1); b++) reached[b - lo] = 1;
      // o.at is the operand's offset within the instruction.
      for (const o of ops) patches.push([prog, q + o.word, w[o.word], (lin + o.at) & mask, o.kind]);
    }
    // ...as long as every byte in the range this program decoded went
    // through that comparison. One none reached -- a trailing refused byte,
    // the second half of a fused pair, a wrap this walk does not model -- was
    // baked into something this walk cannot see, so it is not a repair.
    for (const [from, to] of prog.covered) {
      for (let b = Math.max(lo, from); b <= Math.min(hi, to - 1); b++) {
        if (!reached[b - lo]) return this.decline('a decoded byte no op reaches was written');
      }
    }
    return true;
  }

  // Keyed by reason AND the written range, capped: a storm is one range, and
  // the range is what names the instruction to look at.
  decline(why) {
    const key = this.repairWhy.size < 64 || this.repairWhy.has(`${why} at ${this.repairRange}`)
      ? `${why} at ${this.repairRange}` : why;
    this.repairWhy.set(key, (this.repairWhy.get(key) || 0) + 1);
    return false;
  }

  invalidateRange(lo, hi) {
    const from = lo >>> 4, to = hi >>> 4;
    if (this.smcFlush || to - from > 512) { this.flush(); return; }
    const doomed = new Set();
    for (let p = from; p <= to; p++) {
      for (const prog of (this.byPara.get(p) || [])) doomed.add(prog);
    }
    if (!doomed.size) return;
    // A refusal is a verdict on the BYTES, and these are the bytes that just
    // changed -- a decryptor writing the real opcode over the one we refused is
    // exactly the case. Forget every refusal rather than work out which ones
    // this store reached; the next compile puts back the ones still true.
    this.refusedEntries.clear();
    // The shadow return stack holds ARENA addresses, and $rpop validates them
    // against the guest ip and cs only -- it has no way to know the region they
    // point into has just been dropped. The arena is never overwritten in
    // place, so those bytes are still executable and still hold the pre-patch
    // compilation: a `ret` resumes there and re-runs code the guest has since
    // rewritten. ASSAULT.EXE is what this costs. Turbo Pascal's floating-point
    // emulator patches each `int 3Bh` call site into `fwait`+ESC as it is first
    // executed, and one `ret` came back through a stale frame into the copy
    // that still had the INT in it. The handler is idempotent-hostile: reaching
    // it a second time it reads the ALREADY-patched bytes, concludes there is
    // nothing to do, and IRETs to the unrewound return address -- two bytes
    // into `fild word [0xe8]`. The demo then ran 0.9M dispatches of nothing at
    // 10ab:ab09 and drew a black screen, which reads exactly like a decoder
    // gap and is not one. flush() has always cleared this; the narrow path
    // that replaced it for most stores did not.
    this.vm.set('rtop', 0);
    this.dropProgs(doomed);
  }

  // Take a set of compiled programs out of every structure that can reach
  // them. Idempotent: a program already gone is skipped at each step, which
  // is what lets demote() name programs that an earlier store may have
  // dropped since they were recorded.
  dropProgs(doomed) {
    for (const prog of doomed) {
      prog.live = false;
      const list = this.regions.get(prog.key);
      if (list) {
        const at = list.indexOf(prog);
        if (at >= 0) list.splice(at, 1);
      }
      const idx = this.blockIndex.get(prog.key);
      if (idx) for (const [bip] of prog.blocks) if (idx.get(bip) === prog) idx.delete(bip);
      // The indirect-jump cache is direct-mapped and holds arena addresses, so
      // any slot still naming one of this program's blocks has to go -- the key
      // check in $jlook cannot tell a stale address from a live one.
      for (const [bip] of prog.blocks) {
        const slot = isa.jhash(prog.cs, bip) * 4;
        if (this.jtab[slot] === bip && this.jtab[slot + 1] === (prog.cs & 0xFFFF)) {
          this.jtab[slot] = 0;
          this.jtab[slot + 1] = 0;
          this.jtab[slot + 2] = 0;
        }
      }
      for (const p of prog.paras) {
        const list2 = this.byPara.get(p);
        if (!list2) continue;
        const at2 = list2.indexOf(prog);
        if (at2 >= 0) list2.splice(at2, 1);
        // Nobody has compiled code here any more, so the guest may write to it
        // freely. Leaving the bits set would cost a spurious break on every
        // future store into what is now ordinary data.
        //
        // Clearing is per paragraph even though setting is per byte, and that
        // is the conservative direction: while any region still covers the
        // paragraph, this leaves the departing region's bytes marked, which
        // costs a recompile at worst. Clearing only the departing region's own
        // bytes would be wrong -- two regions can decode the same instruction.
        if (!list2.length) {
          this.byPara.delete(p);
          this.codeBits.fill(0, (p << 4) >> 3, ((p + 1) << 4) >> 3);
          this.armWatch();
        }
      }
    }
  }

  // One instruction, compiled nowhere the cache can find it again.
  //
  // The arena's last 4096 bytes are reserved headroom that nothing else ever
  // writes, which makes them the natural scratch: a single-step block is thrown
  // away the moment it has run, so caching it would only pollute the region
  // list with one-instruction traces that a later full-speed entry could find.
  stepOne(cs, ip, codeBase, mask, d32 = false) {
    const prog = compileProgram((lin) => this.vm.mem[lin], cs, ip, {
      arenaBase: this.arenaEnd,
      maxWords: 1000,
      codeBase, mask, d32, oneInsn: true,
    });
    new Int32Array(this.vm.mem.buffer, prog.arenaBase, prog.words.length).set(prog.words);
    this.compiles++;
    return prog.entryAddr;
  }

  // Drop one block: the guest patched the instruction it was about to run.
  //
  // Returns whether there was anything there to drop. The caller uses that to
  // tell a real self-patch from a store that merely went through CS: see
  // benignPatch in DosSession.
  invalidate(cs, ip, codeBase = (cs << 4)) {
    let hit = false;
    for (const r of (this.regions.get(codeBase) || [])) hit = r.blocks.delete(ip >>> 0) || hit;
    const idx = this.blockIndex.get(codeBase);
    if (idx) idx.delete(ip >>> 0);
    this.jtab[isa.jhash(cs, ip >>> 0) * 4 + 2] = 0;
    return hit;
  }

  // Volatile code: switching the JIT off where the guest keeps rewriting it.
  //
  // A self-modify break drops every region compiled over the written
  // paragraphs and the next entry re-traces them. That is the right answer
  // for a program that unpacks itself once, and the wrong one for a mixer
  // that patches its own immediates on every sample: CYCLE.EXE's GoldPlay
  // player keeps each channel's sample position IN the displacement of the
  // `mov bl, es:[imm]` that reads it and advances it with `adc [imm], step`
  // -- four stores into its own code per timer interrupt, 11,000 interrupts
  // a guest second. Measured at 60M dispatches: 66,023 breaks from that one
  // block, 68,641 traces, 28MB of arena through 37 recycles, 442,438
  // handbacks at 136 dispatches apiece, and 24% of the wall clock in wasm --
  // against 159 traces and 76% with the sound off. The page could not keep
  // that up at 10 MIPS.
  //
  // So a paragraph that takes VOLATILE_AFTER breaks is promoted: cached
  // compiles stop at its edges (compile.js `cut`), and a block inside it is
  // compiled into the arena's scratch headroom on every host entry and never
  // cached, so the store that rewrites it has nothing to invalidate. Its code
  // bits are still set, and that is deliberate: a store into it still ends
  // the block with $smc=2, which is what keeps a loop that patches its OWN
  // next iteration correct -- the host re-enters at the loop head and the
  // fresh compile reads the new bytes. Only the cache walk and the re-trace
  // of everything around it are gone.
  //
  // Promotion is by paragraph, the granularity the invalidation already uses,
  // and it is learned about the program rather than cached from it: a flush
  // or an arena recycle does not clear it. What does clear it is the ratio
  // test in volatileEntry -- a paragraph entered far more often than it is
  // written is paying a compile per entry for nothing, so it goes back to
  // being cached, and VOLATILE_AFTER more breaks promote it again.
  isVolatile(lin) {
    return this.volList.length > 0 && this.volPara[lin >>> 4] === 1;
  }

  // A self-modify break landed on [lo, hi]. Count it against every paragraph
  // written and promote the ones that have had enough. Returns whether any
  // code is volatile at all -- the caller clears the shadow return stack
  // then, because it may hold the arena address of a scratch block that this
  // store just made stale (a `ret` into it would run the old immediates).
  // An uncached compile follows straight-line code out of the volatile run,
  // so the store need not have landed in volatile bytes for that to be so.
  noteSmc(lo, hi) {
    const from = lo >>> 4, to = hi >>> 4;
    if (to - from <= 512) {   // wider is a program moving its image; see invalidateRange
      for (let p = from; p <= to; p++) {
        if (this.volPara[p] === 1) continue;
        if (!this.volatileCode || this.volHits[p] === 255) continue;
        if (++this.volHits[p] >= VOLATILE_AFTER) this.promote(p);
      }
    }
    return this.volList.length > 0;
  }

  promote(p) {
    this.volPara[p] = 1;
    this.volList.push(p);
    this.volList.sort((a, b) => a - b);
    this.promotions++;
  }

  // Volatile paragraphs come in runs, and a run is one piece of code: the
  // bytes that decide a demotion are hashed per run, keyed on its first
  // paragraph, or a prologue paragraph dragged in ahead of the patched bytes
  // would be entered every time and written never, and would demote on its
  // own every few dozen interrupts.
  runHead(p) {
    while (p > 0 && this.volPara[p - 1] === 1) p--;
    return p;
  }

  demote(head) {
    const doomed = new Set();
    for (let p = head; this.volPara[p] === 1; p++) {
      this.volPara[p] = 0;
      this.volHits[p] = 0;
      this.volList.splice(this.volList.indexOf(p), 1);
      // Cached programs holding an `end` stub at an ip in this paragraph --
      // the cut a straight line took at the edge. Now that entryFor will
      // look those ips up in the cache again, such a stub would hand back
      // to itself forever, so the programs compiled against the old
      // boundary go. Just those: the first version flushed the whole cache
      // here, and 919 demotions cost CYCLE 18MB of re-tracing.
      for (const prog of (this.stubProgs.get(p) || [])) doomed.add(prog);
      this.stubProgs.delete(p);
    }
    this.volState.delete(head);
    this.demotions++;
    if (doomed.size) { this.vm.set('rtop', 0); this.dropProgs(doomed); }
  }

  // The guest ips, in this segment, of the 16-byte windows on both sides of
  // every volatile run: the block heads compile.js marks so the wasm decoder
  // stops at the boundary. Empty when nothing is volatile, which is every
  // ordinary run, so this costs those runs one length test.
  volatileHeadsFor(codeBase, mask) {
    if (!this.volList.length) return null;
    const ips = [];
    const list = this.volList;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const runStart = i === 0 || list[i - 1] !== p - 1;
      const runEnd = i === list.length - 1 || list[i + 1] !== p + 1;
      if (runStart) for (let l = p << 4; l < (p << 4) + 16; l++) ips.push(((l & mask) - codeBase) >>> 0);
      if (runEnd) for (let l = (p + 1) << 4; l < ((p + 1) << 4) + 16; l++) ips.push(((l & mask) - codeBase) >>> 0);
    }
    return ips;
  }

  // Compile the volatile block at cs:ip into the scratch headroom, uncached.
  volatileEntry(cs, ip, codeBase, mask, d32) {
    const vm = this.vm;
    const head = this.runHead(((codeBase + ip) & mask) >>> 4);
    // Has the code changed since it was last compiled? The stores themselves
    // are invisible here by design (no code bits), so the bytes are hashed
    // instead -- a run is a few paragraphs, and the decode that follows reads
    // every one of them anyway. A run entered VOLATILE_STALE times in a row
    // with nothing changed is being compiled for nothing: the JIT was switched
    // off here for a program that patched it a few times and moved on, so it
    // goes back to the cache. VOLATILE_AFTER more breaks bring it back.
    //
    // Only the bytes an earlier compile of this run DECODED go into the hash.
    // A paragraph that holds code also holds that code's variables more often
    // than not -- CYCLE.EXE's mixer keeps its sample counter and its output
    // word beside the interrupt handler, and writes both every interrupt --
    // and hashing those bytes made the run look rewritten at every entry, so
    // it was compiled 17,700 times a second for the rest of the run and never
    // once demoted. A byte no compile has read yet cannot have been baked into
    // anything, so its changing is not a reason to keep compiling.
    let st = this.volState.get(head);
    const base = head << 4;
    let hash = 0x811c9dc5;
    for (let p = head, l = base; this.volPara[p] === 1; p++, l += 16) {
      for (let i = 0; i < 16; i++) {
        if (st && l + i - base < st.decoded.length && !st.decoded[l + i - base]) continue;
        hash = Math.imul(hash ^ vm.mem[l + i], 0x01000193);
      }
    }
    if (st && st.hash === hash) {
      if (++st.stale > VOLATILE_STALE) {
        this.demote(head);
        return this.entryFor(cs, ip, codeBase, mask, d32);
      }
    } else if (st) { st.hash = hash; st.stale = 0; } else {
      let n = 0;
      for (let p = head; this.volPara[p] === 1; p++) n += 16;
      this.volState.set(head, st = { hash, stale: 0, decoded: new Uint8Array(n) });
    }
    const key = d32 ? `${codeBase}d` : codeBase;
    const prog = compileProgram((lin) => vm.mem[lin], cs, ip, {
      arenaBase: this.arenaEnd,
      maxWords: 1000,
      codeBase, mask, d32, benign: this.benign, wasmDecoder: this.wasmDecoder,
      fuse: this.fuse, deadFlags: this.deadFlags, crossFlags: this.crossFlags,
      traceBlocks: this.traceBlocks, spinLoops: this.spinLoops,
      regSpec: this.regSpec,
      volatile: (gip) => this.volPara[((codeBase + gip) & mask) >>> 4] === 1,
      volatileOnly: true,
    });
    // What this compile read is what the next entry's hash covers.
    for (const [from, to] of prog.covered) {
      const hi = Math.min(to, base + st.decoded.length);
      for (let b = Math.max(from, base); b < hi; b++) st.decoded[b - base] = 1;
    }
    // Every exit that lands on a block the cache already holds goes straight
    // there instead of handing back. Safe because this compile runs once,
    // now: a cached block can only be dropped from the host, and a store that
    // will drop one sets $smc, which every transfer checks before it is taken
    // (emit.js CONT). So the link is either followed before anything changed
    // or not followed at all.
    if (!this.noCache) {
      for (const f of prog.fixups) {
        if (prog.words[f.wordIndex] !== 0) continue;
        const a = this.lookup(key, f.ip >>> 0);
        if (a !== undefined) { prog.words[f.wordIndex] = a; this.volatileLinks++; }
      }
    }
    new Int32Array(vm.mem.buffer, prog.arenaBase, prog.words.length).set(prog.words);
    // Nothing goes into regions, byPara or the jump table: this arena is
    // overwritten by the next uncached compile, and an address into it that
    // outlived that would resume in whatever came after. The shadow return
    // stack is the last place such an address can hide, so it is emptied.
    //
    // The code bits go up only when an instruction here could run twice
    // before the host compiles this again -- a loop, or a `call` whose `ret`
    // comes back through the shadow stack. Then a store into these bytes
    // must still end the block. A straight line that never comes back has
    // nothing to protect: its stores land behind the program counter, the
    // next entry reads the new bytes, and the interrupt handler CYCLE runs
    // 11,000 times a second finishes without a single break.
    if (prog.calls || prog.cyclic) {
      for (const [from, to] of prog.covered) {
        for (let b = from; b < to; b++) this.codeBits[b >> 3] |= 1 << (b & 7);
      }
    } else {
      // ...and bits an earlier, non-pure compile of the same bytes left up
      // come down, or the store would still break. Only in volatile
      // paragraphs no cached program covers: a dragged-in prologue paragraph
      // may still be held by the cached block that was cut there, and that
      // block needs its bits for as long as it stands.
      for (const [from, to] of prog.covered) {
        // Paragraph by paragraph: one volPara/byPara test per 16 bytes.
        for (let p = from >>> 4; p <= (to - 1) >>> 4; p++) {
          if (this.volPara[p] !== 1 || this.byPara.has(p)) continue;
          const lo = Math.max(from, p << 4), hi = Math.min(to, (p + 1) << 4);
          for (let b = lo; b < hi; b++) this.codeBits[b >> 3] &= ~(1 << (b & 7));
        }
      }
      this.armWatch();
      this.volatilePure++;
    }
    vm.set('rtop', 0);
    this.compiles++;
    this.volatileCompiles++;
    return prog.entryAddr;
  }

  // Regions are keyed by the code segment's LINEAR base, not by the selector.
  // In real mode those carry the same information -- base is selector<<4 -- but
  // in protected mode one selector value means whatever the descriptor says,
  // and PMODE/W reuses the numbers it was just using as real-mode segments. Key
  // on the selector there and a block compiled before the switch is handed back
  // for an address that is now somewhere else entirely.
  entryFor(cs, ip, codeBase = (cs << 4), mask = 0xFFFFF, d32 = false) {
    const vm = this.vm;
    // The D bit belongs in the key, not just in the compile: one linear base
    // can be reached through both a 16-bit and a 32-bit descriptor -- a flat
    // extender's code segment and the real-mode segment 0 underneath it are
    // the same bytes at the same address and decode to different programs.
    const key = d32 ? `${codeBase}d` : codeBase;
    // Before the cache lookup, not after: a cached program can hold an `end`
    // stub at a volatile ip (the cut a straight line took at the boundary),
    // and finding that first would hand back to this same entry forever.
    if (this.volList.length && this.volPara[((codeBase + ip) & mask) >>> 4] === 1) {
      return this.volatileEntry(cs, ip, codeBase, mask, d32);
    }
    if (!this.noCache) {
      const a = this.lookup(key, ip >>> 0);
      if (a !== undefined) return a;
    }
    // Recycling the arena invalidates every arena address the guest-visible
    // caches hold, so both are emptied here -- a stale entry would resume in
    // whatever got compiled over the block it named.
    //
    // The test is HEADROOM, not exhaustion, and the difference is a hang.
    // compileProgram truncates silently at maxWords: it emits `end, cur` and
    // stops. With a few hundred words left that cut lands on the entry block
    // itself, so the compiled program is "hand back at the address you were
    // asked to compile" -- and it gets cached under that address, so every
    // future entry there does the same thing. The guest makes no progress, no
    // decoder refuses anything, and the run reports `stuck at` an instruction
    // that is perfectly fine. CRYSTAL.COM reached 1020KB of a 1024KB arena
    // with 381 self-modify breaks and sat there for 1208 handbacks.
    //
    // A quarter of the arena is far more than any one program's reachable
    // subgraph has ever needed here, so recycling early costs a re-decode that
    // was coming anyway and buys the guarantee that a compile is worth caching.
    if (this.arenaEnd - this.arenaNext < isa.THREAD_SIZE >> 2) {
      this.regions.clear();
      this.blockIndex.clear();
      this.byPara.clear();
      this.stubProgs.clear();
      this.arenaNext = isa.THREAD_BASE;
      this.arenaResets++;
      // Addresses about to be handed out again to different code.
      this.refusedEntries.clear();
      vm.set('rtop', 0);
      this.jtab.fill(0);
      // Every program that owned a code bit is gone with the arena, so the bits
      // have to go with them or a store into what is now plain data breaks the
      // slice forever with nothing left to invalidate.
      this.codeBits.fill(0);
      this.armWatch();
    }
    const prog = compileProgram((lin) => vm.mem[lin], cs, ip, {
      arenaBase: this.arenaNext,
      maxWords: (this.arenaEnd - this.arenaNext) >> 2,
      codeBase, mask, d32, benign: this.benign, wasmDecoder: this.wasmDecoder,
      fuse: this.fuse, deadFlags: this.deadFlags, crossFlags: this.crossFlags,
      traceBlocks: this.traceBlocks, spinLoops: this.spinLoops,
      regSpec: this.regSpec,
      traceDeadFlags: this.traceDeadFlags,
      regionAt: this.regionAt,
      regionSucc: this.regionSucc,
      regionBytes: this.regionBytes,
      regionCodeBits: this.regionCodeBits,
      regionBase: vm.regionBase,
      volatile: this.volList.length
        ? (gip) => this.volPara[((codeBase + gip) & mask) >>> 4] === 1 : null,
      volatileHeads: this.volatileHeadsFor(codeBase, mask),
    });
    // Blocks whose straight line fell into volatile bytes are that code's
    // prologue: promote their paragraphs too, so the next entry there is one
    // uncached compile of the whole line instead of a cached stub, a handback
    // at the boundary and the compile. This program keeps its stub (its bits
    // and byPara entry still stand); entryFor checks volatility before the
    // cache, so the stub is only ever reached through an in-program edge.
    for (const c of prog.volatileCuts || []) {
      const p = ((codeBase + c.head) & mask) >>> 4;
      if (this.volPara[p] !== 1) this.promote(p);
      // ...and remember which program holds a stub into which volatile
      // paragraph, so a demotion can drop exactly those.
      const q = ((codeBase + c.at) & mask) >>> 4;
      let list = this.stubProgs.get(q);
      if (!list) this.stubProgs.set(q, list = []);
      list.push(prog);
    }
    // A decoder refusal AT THE ENTRY compiles to `end, ip`: running it retires
    // one dispatch and moves the guest nowhere. Remember the arena address so
    // checkProgress can tell that spin apart from a program in a real wait.
    if (prog.refusedAtEntry) this.refusedEntries.add(prog.entryAddr);
    this.deadFlagsDropped += prog.deadFlags || 0;
    this.tracedBlocks += prog.tracedBlocks || 0;
    this.spinBlocks += prog.spinBlocks || 0;
    this.specOps += prog.specOps || 0;
    new Int32Array(vm.mem.buffer, prog.arenaBase, prog.words.length).set(prog.words);
    this.arenaNext += prog.words.length * 4;
    this.compiles++;
    this.compiledWords += prog.words.length;
    for (const at of prog.unimplemented) {
      const key = `${cs.toString(16)}:${at.toString(16)}`;
      this.unimplemented.set(key, (this.unimplemented.get(key) || 0) + 1);
    }
    // Mark what was decoded, so a store into it is noticed. Two granularities
    // on purpose: the BITMAP is byte-exact, because that is the question $wr8
    // has to answer and rounding it up to a paragraph is what made B-STEEL.EXE
    // pay 302k recompiles for its code-segment variables (see isa.CODE_BITMAP).
    // byPara stays coarse, because it answers a different question -- "which
    // regions might this store have hit" -- and it is consulted only after the
    // bitmap has already said a real code byte was written. Over-reporting
    // there costs one extra region drop, not a storm.
    prog.key = key;
    prog.cs = cs;
    // What the decode was asked with, so repairOperands can decode one of
    // this program's instructions again the same way.
    prog.codeBase = codeBase;
    prog.live = true;            // cleared by dropProgs; a repair plan checks it
    prog.mask = mask;
    prog.d32 = d32;
    // A Set, because covered ranges can overlap each other within one program.
    // A paragraph listed twice would be removed once and leave a byPara entry
    // pointing at a dropped program, and its code bit would never come down.
    prog.paras = new Set();
    for (const [from, to] of prog.covered) {
      for (let b = from; b < to; b++) this.codeBits[b >> 3] |= 1 << (b & 7);
      for (let p = from >> 4; p <= (to - 1) >> 4; p++) {
        if (prog.paras.has(p)) continue;
        prog.paras.add(p);
        let list = this.byPara.get(p);
        if (!list) this.byPara.set(p, list = []);
        list.push(prog);
      }
    }
    // Publish every block head into the indirect-jump cache. Direct-mapped, so
    // a later block simply evicts an earlier one -- the key check in $jlook
    // turns that into a handback rather than a wrong jump.
    for (const [bip, addr] of prog.blocks) {
      const slot = isa.jhash(cs, bip) * 4;   // jtab is a view starting AT JTAB_BASE
      this.jtab[slot] = bip;
      this.jtab[slot + 1] = cs & 0xFFFF;
      this.jtab[slot + 2] = addr;
      // The linear base the block was decoded at. $jlook checks it against the
      // live one, so a selector that has been given a new descriptor since --
      // an extender reusing its real-mode segment numbers -- misses instead of
      // resuming in the other mode's code. Word 3 of the stride was spare.
      this.jtab[slot + 3] = codeBase | 0;
    }
    if (!this.regions.has(key)) this.regions.set(key, []);
    this.regions.get(key).push(prog);
    let idx = this.blockIndex.get(key);
    if (!idx) this.blockIndex.set(key, idx = new Map());
    for (const [bip] of prog.blocks) {
      // First live program wins, as the list walk it replaces did.
      const have = idx.get(bip);
      if (have === undefined || !have.blocks.has(bip)) idx.set(bip, prog);
    }
    return prog.entryAddr;
  }

  // The arena address of a cached block at `ip` in the segment keyed `key`,
  // or undefined. Goes through blockIndex; a block that `invalidate` deleted
  // from its program reads as a miss (and is recompiled) rather than being
  // hunted for in another program of the same list.
  lookup(key, ip) {
    const idx = this.blockIndex.get(key);
    if (!idx) return undefined;
    const prog = idx.get(ip);
    return prog === undefined ? undefined : prog.blocks.get(ip);
  }
}

// ---------------------------------------------------------------------------
// One guest, driven one step at a time.
//
// `step()` does exactly one of two things: service an interrupt the guest is
// sitting in, or compile-and-run one slice. It never loops, which is what lets
// a browser run a program across animation frames without the loop and the
// frame budget having to know about each other.
// One BIOS tick, in seconds: 65536 pulses of the 1.193182MHz PIT input.
const TICK_SECONDS = 65536 / 1193182;

// Guest seconds in `n` dispatches, on a clock described by
// { dispatchesPerTick, tickScale }. A free function rather than only a method
// because the budget a sweep hands a run has to be worked out BEFORE there is
// a session to ask -- see dispatchesForGuestSeconds below, which is this
// expression solved for n and must not drift from it.
function guestSeconds(n, { dispatchesPerTick = 550e3, tickScale = 1 } = {}) {
  return n / dispatchesPerTick * (tickScale || 1) * TICK_SECONDS;
}

// ...and the inverse: how many dispatches are worth `sec` guest seconds.
//
// This is the unit a corpus sweep should be budgeting in. A dispatch count is
// not a fixed amount of the guest's own time by itself -- it is one only while
// the clock derived from it stays put -- and every real-time cadence in the VM
// (the VGA frame period above all) is quoted against guestSeconds(). Budget in
// dispatches and a retiming of the emulated clock silently rephotographs the
// whole corpus at a different point in every show.
function dispatchesForGuestSeconds(sec, clock = {}) {
  const { dispatchesPerTick = 550e3, tickScale = 1 } = clock;
  return Math.round(sec * dispatchesPerTick / ((tickScale || 1) * TICK_SECONDS));
}

class DosSession {
  constructor(vm, machine, opts = {}) {
    const {
      slice = 2e6, noCache = false, smcFlush = false, mouse = [0, 0],
      wasmDecode = true, fuse = true, deadFlags = true, crossFlags = true,
      traceBlocks = true, spinLoops = true, regSpec = false, traceDeadFlags = null,
      // Stop caching code the guest keeps rewriting (CodeCache.noteSmc).
      // `--no-volatile` is the A/B partner.
      volatileCode = true,
      // One timer interrupt per this many dispatches. 100k is about 10ms of a
      // real 486, so it lands near the 18.2Hz the BIOS programs -- and a demo
      // that reprogrammed the PIT for music gets a slower clock than it asked
      // for, which costs it tempo and nothing else.
      irqEvery = 100e3, dispatchesPerTick = 550e3, tickScale = 1,
      // One clock instead of two. The defaults above put the timer interrupt
      // every 100k dispatches and the tick word every 550k, so a program's
      // INT 8 runs 5.5x faster than its 0040:006C -- a compromise the sweep was
      // photographed under. With `pitClock` the timer interrupt, the retrace
      // and the keyboard all derive from dispatchesPerTick and the PIT's own
      // channel-0 reload, which is what makes a paced run (live.js) run at the
      // speed the program expects: a demo that reprogrammed the PIT for a
      // 1kHz music player gets 1kHz of it.
      pitClock = false,
      // How many handbacks at one address with nothing new on screen before the
      // run is called hung. 0 turns the detector off, which is what to reach for
      // when the question is whether a loop is stuck or merely long.
      stuckLimit = 200,
      // ...and how much guest work has to pass with nothing observable
      // changing before that run of handbacks is believed. See the note at the
      // test itself. 20M is well inside the budget a sweep gives a program
      // (200M) so a real spin is still caught early, and well outside any
      // timed wait seen in this corpus.
      stuckWork = 20e6,
      // conCells(machine.con), passed in rather than imported: the console
      // scoring lives with the drivers that photograph a console.
      cells = null,
      // Record WHERE self-modifying code fires, not just how often. The total
      // on its own cannot tell a program that unpacks itself once from one
      // whose inner loop patches an immediate every few instructions, and those
      // want opposite responses -- DOPE.EXE takes 138414 breaks in two million
      // dispatches and spends essentially all of its time recompiling, which
      // reads as "the emulator is slow" and is nothing of the kind.
      smcCensus = false,
      // Linear [lo, hi] byte ranges to report every store to. See CodeCache.
      watch = [],
      // Anchor the slice grid and the audio render to the ABSOLUTE dispatch
      // count instead of to the last handback -- see step(). OFF by default,
      // because it changes what a plain interpreter run plays; the region-JIT
      // harnesses set it on BOTH arms, which is the only way the comparison
      // holds a clock still.
      latticeClock = false,
      hooks = {},
    } = opts;

    this.vm = vm;
    this.machine = machine;
    this.slice = slice;
    this.latticeClock = latticeClock;
    this.mouse = mouse;
    this.irqEvery = irqEvery;
    this.dispatchesPerTick = dispatchesPerTick;
    this.tickScale = tickScale;
    this.pitClock = pitClock;
    this.stuckLimit = stuckLimit;
    this.stuckWork = stuckWork;
    this.stuckSince = 0;
    this.cells = cells;
    this.hooks = hooks;
    this.cache = new CodeCache(vm,
      { noCache, smcFlush, watch, wasmDecode, fuse, deadFlags, crossFlags,
        traceBlocks, spinLoops, regSpec, traceDeadFlags,
        regionAt: opts.regionAt || null, regionSucc: opts.regionSucc || null,
        regionBytes: opts.regionBytes || null,
        regionCodeBits: opts.regionCodeBits !== false, volatileCode });

    this.dispatched = 0;
    this.handbacks = 0;
    this.ints = 0;
    this.irqs = 0;
    this.smcBreaks = 0;
    // key `cs:ip -> lo-hi` (the resume point of the block that stored, and the
    // paragraph range it dirtied) -> how many times. Null unless asked for,
    // because it costs a string build on every break and the storms are exactly
    // the runs where that would be millions of them.
    this.smcSites = smcCensus ? new Map() : null;
    this.icebps = 0;        // guest ICEBP (F1) bytes stepped over
    this.traps = 0;          // INT 1s delivered because the guest set TF
    this.stuck = 0;
    this.stuckAt = null;
    this.lastIrq = 0;
    // Dispatch count the audio was last rendered up to. See the render call in
    // step(): rendering happens at quantum crossings, not at every handback.
    this.audioAt = 0;
    this.lastKbIrq = 0;
    this.lastSbIrq = 0;
    // The VGA clock: frame rate last handed to the VM, its period in
    // dispatches, the frame index at the last handback, and whether a frame
    // edge is waiting to be delivered as IRQ2.
    this.vgaHz = 0;
    this.vgaPeriod = 0;
    this.vgaFrame = 0;
    this.retraceEdge = false;
    this.lastKey = -1;
    this.lastWritten = 0;
    this.lastRegs = 0;
  }

  // Is there any point calling step() again?
  get done() {
    return this.machine.exited || this.machine.blockedOnKey || this.machine.stopHit
      || this.stuckAt !== null
      || this.blockedOn32 !== undefined || this.badSelector !== undefined;
  }

  // Push an interrupt frame in front of the guest's next instruction, exactly
  // as the hardware would -- which means letting the CPU decide what "exactly"
  // is, rather than deciding here.
  //
  // This used to build the frame itself, and could only build one shape of it:
  // three words at ss<<4 + sp, with the handler read out of the IVT at linear
  // vec*4. That is real mode and nothing else, so it refused to deliver at all
  // to a protected-mode guest -- whose stack selector has whatever base its
  // descriptor says, and whose handlers are gate descriptors in an IDT that
  // LIDT pointed somewhere else entirely. Delivering the real-mode frame anyway
  // sends the guest to a segment made out of two bytes of IVT read as a
  // selector, which is how COLORS.EXE ended up executing the zeros at 9BF0:0
  // for 200M dispatches.
  //
  // The refusal was right about the frame and wrong about the machine: a
  // protected-mode demo paced off INT 8 got no beat and stood still. INTRO.EXE
  // reaches mode 13h, loads 246 palette entries, and then spins forever on a
  // tick counter that only its own IDT gate increments. $fault -- which the
  // guest's own INT instruction and every arithmetic fault already go through
  // -- knows all three cases: a 386 or 286 gate through the IDT, the V86
  // hand-off to the monitor, and the real-mode vector table when there is no
  // IDT. So ask for the vector and let it pick.
  raise(vec) {
    this.vm.exports.raise_irq(vec);
    this.irqs++;
  }

  // How many dispatches a Sound Blaster block is worth. The card decides this,
  // not us: a 4096-sample block at 8000Hz lasts half a guest second, and the
  // clock above says half a guest second is 18.2 * 550,000 / 2 dispatches. Fall
  // back to the generic interval before any transfer has named a length.
  //
  // The floor matters as much as the number. A driver that programs a very
  // short block still has to be let out of its own handler, and this rung sits
  // ahead of the timer's, so a block worth fewer dispatches than the generic
  // interval must not be allowed to take every one of them.
  // Dispatches between timer interrupts. Under the two-clock defaults that is
  // irqEvery; under pitClock it is what channel 0 of the PIT is counting --
  // 65536 pulses of 1.19MHz per BIOS tick, so the reload divided by 65536 of
  // dispatchesPerTick, floored so a driver that programmed a very fast timer
  // still leaves the guest some instructions between interrupts.
  timerInterval() {
    if (!this.pitClock) return this.irqEvery;
    const pit = this.machine.pit;
    const reload = pit && pit.latch ? pit.latch[0] : 0x10000;
    return Math.max(200, Math.round(this.dispatchesPerTick * reload / 65536));
  }

  // Dispatches per 18.2Hz tick as the INTERRUPT cadences count them: under the
  // two-clock defaults an IRQ is scheduled off irqEvery, and only under
  // pitClock is it scheduled off the same number guest wall time is measured
  // in. Anything that is a real-time interval rather than an IRQ cadence --
  // the VGA frame period is the one that got this wrong -- must go through
  // guestSeconds() instead, which is dispatchesPerTick either way.
  tickUnit() {
    return this.pitClock ? this.dispatchesPerTick : this.irqEvery;
  }

  // Guest seconds in `n` dispatches.
  guestSeconds(n) {
    return guestSeconds(n, this);
  }

  // The guest is inside the stub segment: a vector sent it to a byte the
  // decoder refuses, so control is here rather than in guest code.
  serviceInterrupt() {
    const { vm, machine } = this;
    const vec = vm.get('gip') & 0xFF;
    this.ints++;
    // The IRET frame the INT handler pushed. Servicing may want to change the
    // flags the guest gets back (CF for a DOS error, ZF for "no key"), so it is
    // edited in place on the stack rather than in the live register.
    const ss = vm.get('ss'), sp = vm.get('sp');
    const lin = (of) => ((ss << 4) + ((sp + of) & 0xFFFF)) & 0xFFFFF;
    const rd = (of) => vm.mem[lin(of)] | (vm.mem[lin(of + 1)] << 8);
    const wr = (of, v) => {
      vm.mem[lin(of)] = v & 0xFF;
      vm.mem[lin(of + 1)] = (v >> 8) & 0xFF;
    };
    const r = {
      get: (n) => vm.get(n),
      set: (n, v) => vm.set(n, v),
      setResultCf: (on) => wr(4, on ? (rd(4) | 1) : (rd(4) & ~1)),
      setResultZf: (on) => wr(4, on ? (rd(4) | 0x40) : (rd(4) & ~0x40)),
      // Where this INT returns to, and the SP it returns with. EXEC needs it:
      // the caller's own CS:IP at service time is the stub, and the address the
      // parent resumes at lives in the IRET frame.
      ret: { cs: rd(2), ip: rd(0), sp: (sp + 6) & 0xFFFF },
    };
    // The registers as they ARRIVED. Logging them after the call showed the
    // answer where the question belongs: an INT 16h AH=00 that returned 'a'
    // printed as `ax=1e61`, which reads exactly like a program calling a
    // function 1Eh that does not exist.
    const before = this.hooks.onInt ? ['ax', 'bx', 'cx', 'dx'].map(n => vm.get(n)) : null;
    // A watched byte written by the HOST's own INT service is invisible to the
    // store census: the census names the guest cs:ip, which for a serviced INT
    // is always the one-byte stub, so every such write reads as `f000:1NN`
    // and says nothing about which DOS/BIOS function did it. Diff the watched
    // bytes across the service call and name the vector and AX instead.
    const wax = vm.get('ax');
    const wsnap = (this.smcSites && this.cache.watch.length)
      ? this.cache.watch.map(([lo, hi]) => vm.mem.slice(lo, hi + 1)) : null;
    const ok = machine.service(vec, r);
    if (wsnap) {
      for (let i = 0; i < this.cache.watch.length; i++) {
        const [lo, hi] = this.cache.watch[i];
        for (let a = lo; a <= hi; a++) {
          if (vm.mem[a] === wsnap[i][a - lo]) continue;
          const hex = (n) => n.toString(16);
          const key = `int ${hex(vec)}h ax=${hex(wax)} (host) wrote ${hex(a)}`
            + ` ${hex(wsnap[i][a - lo])}->${hex(vm.mem[a])}`;
          this.smcSites.set(key, (this.smcSites.get(key) || 0) + 1);
        }
      }
    }
    if (this.hooks.onInt) {
      this.hooks.onInt({ vec, before, ok, retCs: rd(2), retIp: rd(0), ax: vm.get('ax') });
    }
    // IRET, performed here so the stub is one byte and never executes.
    vm.set('gip', rd(0));
    vm.set('cs', rd(2));
    vm.set('flags', rd(4));
    vm.set('sp', (sp + 6) & 0xFFFF);
    // A service that transfers control -- EXEC into a child program, or a
    // child's exit back into its parent -- says so here rather than editing the
    // registers behind the IRET's back, which would just be overwritten by the
    // three loads above.
    if (machine.transfer) {
      const t = machine.transfer;
      machine.transfer = null;
      for (const k of ['cs', 'ss', 'ds', 'es']) vm.set(k, t[k]);
      vm.set('gip', t.ip);
      vm.set('sp', t.sp);
      // The caller's register file, when the transfer is a terminate handing a
      // parent its own context back. DOS pops the nine words its INT 21h
      // prologue pushed on the way out, so a program resumed through INT 22h
      // finds DS, ES and the rest exactly as they were at the call that
      // launched the child. Applied after the segment loads above so a saved DS
      // wins over the exiting child's.
      if (t.regs) for (const k of Object.keys(t.regs)) vm.set(k, t.regs[k]);
      if (t.ax !== undefined) vm.set('ax', t.ax);
    }
  }

  // One turn of the cycle. Returns 'int' if it serviced one, 'ran' if it ran a
  // slice of guest code, 'done' if there was nothing to do.
  step() {
    const { vm, machine } = this;
    if (this.done) return 'done';

    const cs = vm.get('cs'), ip = vm.get('gip');
    if (cs === STUB_SEG) {
      this.serviceInterrupt();
      return 'int';
    }

    // Where a slice re-enters is the whole cost model of this harness: each one
    // is a JS round trip, and a hot loop whose back edge the compiler could not
    // resolve turns into hundreds of thousands of them.
    if (this.hooks.onEntry) this.hooks.onEntry(cs, ip, this.handbacks, this.dispatched);

    // CS's linear base and the address bus width, read fresh each slice: both
    // change under the guest's feet when it switches to protected mode or opens
    // A20, and both decide which bytes get decoded.
    const codeBase = vm.exports.get_csb();
    const mask = vm.exports.get_linmask();
    // A 32-bit code segment. The D bit changes the default operand and address
    // size of every instruction in the segment and widens EIP past 0xFFFF, so
    // it is part of the decode and part of the cache key -- two different
    // programs can live at one linear base, one reached through a 16-bit
    // descriptor and one through a 32-bit one.
    const d32 = vm.exports.get_d32() !== 0;
    // A CS that names no descriptor while PE is set. $segbase deliberately
    // reads such a selector as a real-mode paragraph, which is right for a DATA
    // segment in an extender running unreal -- but a real CPU cannot execute
    // through one at all, it faults, and here the fallback quietly hands the
    // decoder a plausible base pointing at whatever happens to be there.
    // COUNTDWN.EXE spent 60M dispatches and 700MB of arena walking the zeros
    // above 9BF00 that way, and the run looked slow rather than wrong. Stopping
    // is the honest report: something earlier loaded a selector we got wrong.
    // ...unless this is virtual-8086 mode, where a CS naming no descriptor is
    // not a mistake, it is the definition: PE is set and segmentation is back
    // to paragraphs. $segbase already reads it that way; the guard has to agree
    // or every V86 guest stops on its first instruction.
    if ((vm.exports.get_cr0() & 1) && !vm.exports.get_vm86() && (cs & 0xFFF8) !== 0
        && (cs & 0xFFF8) > (vm.exports.get_gdtl() & 0xFFFF)) {
      this.badSelector = `${cs.toString(16)}:${ip.toString(16)}`;
      return 'badselector';
    }
    // F1 is ICEBP, and it is also the byte every IVT stub is made of -- chosen
    // precisely because the decoder refuses it, which is what puts control back
    // here when a vector is taken. The catch is that the decoder refuses it
    // EVERYWHERE, and a guest is allowed to have one in its own code: on real
    // hardware ICEBP raises INT 1, and with no debugger loaded that vector is
    // an IRET, so the instruction is a slow no-op and execution carries on at
    // the next byte. Here it was a wall. STHINTRO.EXE's polymorphic decryptor
    // jumps into a run of bytes containing one and re-entered the same address
    // forever, which the report called "stuck at 364:1a4" -- a perfectly
    // ordinary instruction the guest was entitled to execute.
    //
    // So: step over it and take vector 1 the way the hardware would. In
    // protected mode `raise` declines (see its comment) and stepping over is
    // all that happens, which is still the right answer for an unhooked INT 1.
    if (cs !== STUB_SEG && vm.mem[(codeBase + ip) & mask] === STUB_BYTE) {
      vm.set('gip', (ip + 1) & 0xFFFF);
      this.icebps++;
      this.raise(1);
      return 'int';
    }
    // The trap flag. With TF set the CPU owes an INT 1 after every instruction,
    // and nothing here used to deliver it -- which is invisible until a program
    // relies on it, and DOS-era protectors rely on it constantly: hook INT 1,
    // set TF, and let the handler decrypt the next few bytes just before they
    // execute. JULTRO.EXE hooks INT 1, INT 3 and INT 21h, and without the trap
    // its own INT 21h handler was still ciphertext when DOS called it, so the
    // program jumped into the middle of a line-offset table and the report
    // called it "stuck at 5ab:8c" -- an address in the middle of its own data.
    //
    // Single-stepping costs one compile and one handback per instruction, which
    // is what the guest asked for; the compiled block is not cached, so nothing
    // about full-speed execution changes when TF comes back down.
    //
    // ...but only when someone is listening. TF with the INT 1 vector still on
    // the untouched BIOS stub owes a trap that pushes a frame and IRETs back
    // with nothing changed, so single-stepping it buys the guest exactly the
    // six stack bytes below SP and costs a compile and a handback per
    // instruction. BLINKY.EXE sets TF and never hooks INT 1: 180 seconds bought
    // it 7,067,597 traps, 44 dispatches per handback and 7% of the wall clock
    // in wasm, against 26M dispatches per second when it is not stepping. A
    // protector hooks INT 1 before it raises TF -- that is the whole point of
    // the technique -- so the vector is the honest test of whether the trap is
    // observable, and it is re-read every slice so a late hook still takes.
    const int1 = vm.mem[4] | (vm.mem[5] << 8);
    const int1seg = vm.mem[6] | (vm.mem[7] << 8);
    const int1Hooked = !(int1seg === STUB_SEG && int1 === STUB_OFF + 1);
    const stepping = int1Hooked && (vm.get('flags') & (1 << isa.F.TF)) !== 0;
    const entry = stepping
      ? this.cache.stepOne(cs, ip, codeBase, mask, d32)
      : this.cache.entryFor(cs, ip, codeBase, mask, d32);
    if (this.hooks.beforeSlice) this.hooks.beforeSlice();
    // Run to the next thing that wants to happen, not to the full slice.
    //
    // Every interrupt this harness injects goes in at a handback, because that
    // is the only point where the guest's cs:gip is a real instruction
    // boundary (see the timer comment in the service cycle below). The rates
    // are all quoted in dispatches -- a retrace every irqEvery/4, a tick every
    // irqEvery, a clock word every dispatchesPerTick -- and while a handback
    // arrived every few hundred dispatches those rates were met by accident:
    // there was always another boundary along before the next event was due.
    //
    // Linking far transfers took that away. DTM2 went from 267 dispatches per
    // handback to 249,413, which is a tenfold overshoot of the retrace interval
    // and a 2.5x overshoot of the tick -- so a program that had been getting 18
    // ticks a second started getting one or two, and ACCIDENT.EXE, which paces
    // its loader on them, stopped part-way with a black screen and half its
    // files unopened. The linking was right; relying on handback frequency to
    // pace time was the bug, and it was there all along waiting for the
    // handbacks to thin out.
    //
    // So cap the slice at the shortest of those intervals. A quantum and not a
    // due-date: the events are conditional -- the retrace only fires if the
    // program hooked it, the SB IRQ only between transfers -- and an interval
    // whose event declines to fire never advances its `last` mark, so a
    // time-to-next-event budget goes negative and pins every later slice at the
    // one-step floor. That is not a hypothetical; it is what the first version
    // of this did, and ACCIDENT.EXE ran 25,000 dispatches in 239 handbacks
    // before stopping. The quantum cannot drift because it does not remember
    // anything.
    // The VGA clock. Port 3DAh is answered inside the VM from where the
    // dispatch count sits in the current frame (emit.js, $vga_status), so hand
    // it the phase this slice starts at, and the period whenever the mode's
    // frame rate changed.
    //
    // The period is a REAL-TIME interval, so it is quoted against the same
    // clock everything else real-time here is quoted against: guestSeconds(),
    // which is dispatchesPerTick and tickScale and nothing else. It used to be
    // quoted against tickUnit(), which is dispatchesPerTick only under
    // --pit-clock and irqEvery (100e3) otherwise -- so on the default
    // two-clock path a "70Hz" frame was 26,000 dispatches while a guest
    // second was 10.0M of them, and the card ran at 385Hz. A retrace-paced
    // demo then played its whole show 5.5x too fast: ACME-SUX.EXE reached its
    // exit in 7.4M dispatches (0.74 guest seconds) for 285 frames of content
    // that a real VGA takes ~4 seconds to show. Under --pit-clock the two
    // expressions already agreed, which is why the fast arm looked correct
    // and hid this.
    if (vm.exports.set_vga_phase0) {
      const t = machine.vgaTiming ? machine.vgaTiming() : { hz: 70, lines: 449 };
      if (t.hz !== this.vgaHz) {
        this.vgaHz = t.hz;
        // Dispatches in one frame: the frame's length in guest seconds
        // divided by what one dispatch is worth.
        this.vgaPeriod = Math.max(100, Math.round(1 / (t.hz * this.guestSeconds(1))));
        vm.exports.set_vga_period(this.vgaPeriod, t.lines);
      }
      vm.exports.set_vga_phase0(this.dispatched % this.vgaPeriod);
    }
    // The quantum: a quarter of the shortest interval anything here fires at.
    // Under pitClock that is whichever of the timer and the frame is faster,
    // and the timer can be very fast once a music player has programmed it.
    // The Ultrasound's timer is a third clock, and the fastest: DOPE runs
    // it at 320us. Its period in dispatches, floored like the PIT's.
    const gp = machine.gusPeriod ? machine.gusPeriod() : 0;
    const gusInterval = gp ? Math.max(200, Math.round(gp / this.guestSeconds(1))) : Infinity;
    const shortest = Math.min(gusInterval, this.pitClock
      ? Math.min(this.timerInterval(), this.vgaPeriod || Infinity) : this.irqEvery);
    // The Sound Blaster's block end is an event, not a rate: the slice is cut
    // to land on it, so the block-done interrupt is raised at the sample the
    // block ran out on. A slice that overshoots it by a few milliseconds is a
    // hole of held sample between one single-cycle block and the next, and a
    // click every block (BRW.EXE). Whole, not quartered: the block's last
    // sample is where the slice should end, and the next slice is cut again.
    const sbLeft = machine.sbSecondsLeft ? machine.sbSecondsLeft() : 0;
    const sbInterval = sbLeft > 0 ? Math.max(200, Math.ceil(sbLeft / this.guestSeconds(1))) : Infinity;
    // THE QUANTUM IS ANCHORED TO THE ABSOLUTE DISPATCH COUNT, NOT TO THE LAST
    // HANDBACK. Everything a slice boundary decides -- when an armed IRQ is
    // delivered, which guest instant the Sound Blaster's DMA is read at, where
    // the audio for the slice is rendered from -- is decided at a handback, so
    // a run that takes ONE extra handback has every later boundary shifted by
    // that slice's unspent remainder, for the rest of the program. An extra
    // handback is not a hypothetical: it is exactly what the region JIT
    // removes (a self-loop whose back edge the compiler could not resolve
    // handed back once per iteration; the region does not) and exactly what
    // installing one costs (the head has to be compiled again). Measured on
    // DREAM.EXE: the interpreter took one early exit at 100:7f3 every ~190,000
    // dispatches and the region absorbed it, so from the install on the two
    // arms' boundaries never coincided again, the timer IRQ landed on a
    // different instruction and the frame diverged by 180 pixels with neither
    // arm computing anything wrong.
    //
    // Cutting the slice at the next multiple of the quantum instead makes the
    // boundaries a function of the dispatch clock alone: an extra handback
    // costs one short slice and the grid RE-SYNCS at the next lattice point.
    // The quantum itself is derived from the guest's own timer programming, so
    // it is the same number in both arms.
    //
    // AND IT IS OPT-IN, because it is not a free rewrite of the clock. Where
    // the interpreter hands back early is not rare, so anchoring the grid moves
    // the boundaries of a plain interpreter run too: measured over six demos at
    // 80M dispatches with the JIT off, all six rendered a different wav than
    // main did. That is a change to what the emulator plays, and it does not
    // belong in the shipped default for the sake of a flag that is off. So the
    // run loop keeps main's per-slice quantum unless `latticeClock` asks
    // otherwise, and the JIT harnesses turn it on for BOTH arms -- which is the
    // only configuration in which the comparison means anything, since an arm
    // that anchors its grid and an arm that does not have different clocks
    // before the JIT does anything at all.
    const quantum = Math.min(this.slice, Math.max(1, Math.floor(shortest / 4)));
    const budget = this.latticeClock
      ? Math.min(quantum - (this.dispatched % quantum), sbInterval)
      : Math.min(quantum, sbInterval);
    // So a port write inside the slice can say when it happened (audioNow).
    machine.sliceStart = this.dispatched;
    machine.sliceBudget = budget;
    vm.exports.run(entry, budget);
    // $left is -1 when the slice ran to exhaustion and holds the unspent budget
    // when a handler handed control back early. Billing the slice either way
    // makes a demo that bounces off an unresolved jump every few instructions
    // look like it burned the whole budget.
    // A slice the machine cut short (Machine.endSlice, to get an armed IRQ to
    // the guest promptly) reports $left as -1 like an exhausted one, so ask for
    // the count it saved on the way out rather than billing the whole budget.
    const cut = this.machine.takeSliceCut ? this.machine.takeSliceCut() : -1;
    // Bill the steps actually charged, overshoot included. $next charges a step
    // BEFORE it runs a handler and a block only tests the budget at its
    // transfer, so an exhausted slice ends with $steps a few below zero -- the
    // ops the guest ran past the quantum. Billing the quantum alone dropped
    // that overshoot, and it is a different size in a region (a chunk of ops
    // billed at once before a transfer, the whole body on a `--once` exit) than
    // under the interpreter (one block). The emulated clock is the dispatch
    // count, so two arms doing IDENTICAL guest work drifted apart by thousands
    // of dispatches (ADDY_II: -4356 at 4.7M with the same registers and
    // counters), the timer IRQ landed on a different instruction, and the
    // frame diverged with nothing wrong in either arm. $steps is read directly:
    // $left is the same value on every exit that writes it, and the sentinel
    // -1 it starts at cannot tell "exhausted" from "one op past".
    const left = cut >= 0 ? cut : vm.raw('steps');
    this.dispatched += budget - left;
    this.handbacks++;
    // The retrace IRQ is the rising edge of the bit the port reports, so it is
    // armed when the dispatch count crosses into a new frame -- the interrupt
    // and the status the guest polls come from ONE clock. It is delivered at
    // the next handback (interrupts only go in at instruction boundaries) and
    // stays armed until the rung below fires it or finds nobody listening.
    if (this.vgaPeriod) {
      const frame = Math.floor(this.dispatched / this.vgaPeriod);
      if (frame !== this.vgaFrame) { this.vgaFrame = frame; this.retraceEdge = true; }
    }
    if (vm.exports.get_vga_reads) {
      machine.clock.retrace += vm.exports.get_vga_reads();
      vm.exports.set_vga_reads(0);
    }
    if (this.hooks.afterSlice) this.hooks.afterSlice({ left, dispatched: this.dispatched, cs, ip });

    // A block that patched its own code hands back with $smc set. The block it
    // patched is the one it was about to fall into, so that is the cache entry
    // to drop -- a full flush would be correct too, and would re-decode the
    // whole program on every Turbo Pascal BIOS call.
    //
    // $smc = 2 is the other kind, and the broad one: some store landed in a
    // paragraph that had already been compiled. That is a packed program
    // unpacking itself, so everything compiled from before the unpack is stale
    // and goes.
    // ...and the debug exception it owes, delivered the way the hardware does:
    // AFTER the instruction, and only if that instruction left TF standing. An
    // `int n` clears TF as part of taking its own vector, and the single-step
    // trap is suppressed for exactly that reason -- otherwise every INT under a
    // debugger would trap twice.
    if (stepping && (vm.get('flags') & (1 << isa.F.TF))) {
      this.traps++;
      this.raise(1);
    }
    if (vm.raw('smc')) {
      const kind = vm.raw('smc');
      vm.set('smc', 0);
      const lo = vm.exports.get_smclo() >>> 0, hi = vm.exports.get_smchi() >>> 0;
      if (kind === 2) {
        // An operand rewritten in place leaves every cached program standing
        // and counts for nothing towards volatility; see repairOperands. The
        // shadow return stack is still emptied when anything is volatile: a
        // scratch block is never in byPara, so its copy of the operand is
        // stale, and a `ret` into it would run the old value.
        if (this.cache.repairOperands(lo, hi)) {
          if (this.cache.volList.length) vm.set('rtop', 0);
        } else {
          // A store into volatile code has nothing cached to drop, but the
          // shadow return stack may still point into the scratch block it
          // just rewrote; see CodeCache.noteSmc.
          if (this.cache.noteSmc(lo, hi)) vm.set('rtop', 0);
          this.cache.invalidateRange(lo, hi);
        }
        this.cache.siteRange.set(((vm.exports.get_csb() + vm.get('gip')) & 0xFFFFF) >>> 0, [lo, hi]);
      } else this.benignPatch(vm.get('cs'), vm.get('gip'), vm.exports.get_csb(), lo, hi);
      this.smcBreaks++;
      if (this.smcSites) {
        const hex = (n) => n.toString(16);
        const key = kind === 2
          // The cs:ip is where the slice STOPPED, which for a store followed by
          // an `int n` is the one-byte stub -- `f000:1NN` names the vector and
          // not the writer. The slice's own entry is the block that did it, so
          // both are printed when they differ.
          ? `${hex(vm.get('cs'))}:${hex(vm.get('gip'))} wrote ${hex(lo)}-${hex(hi)}`
            + ((vm.get('cs') !== cs || vm.get('gip') !== ip)
              ? ` (slice from ${hex(cs)}:${hex(ip)})` : '')
          // A kind-1 break carries no range of its own: what benignPatch
          // judged it against is the site's last kind-2 range, if it ever
          // had one, and that is worth seeing when a site refuses to retire.
          : `${hex(vm.get('cs'))}:${hex(vm.get('gip'))} patched its own next block`
            + ((r) => (r ? ` (judged against its ${hex(r[0])}-${hex(r[1])})` : ''))(
              this.cache.siteRange.get(((vm.exports.get_csb() + vm.get('gip')) & 0xFFFFF) >>> 0));
        this.smcSites.set(key, (this.smcSites.get(key) || 0) + 1);
      }
    }

    // Time moves with work, not with the wall clock: a demo that spins on the
    // BIOS tick has to see it advance, and a wall clock would make a headless
    // run's speed change what the guest computes.
    //
    // Note WHAT it moves with: guest WORK, not handbacks. A handback is not a
    // unit of anything -- this corpus ranges from 31 dispatches per handback to
    // 1.4M -- so a tick per handback runs the guest clock five orders of
    // magnitude apart between two programs. Turbo Pascal's CRT unit is what
    // makes that fatal rather than merely wrong: it times a calibration loop
    // against the tick word at 0040:006C and divides by what it counted, so a
    // clock that ticks every few hundred instructions makes the count zero and
    // the division by zero is runtime error 200. BIOLAN, BRIAN, CREATION and
    // DIGILAB all died there. 550,000 dispatches to a 55ms tick is a 10-MIPS
    // machine, which is a fast 486 -- the part these were written for.
    machine.setClock(this.dispatched / this.dispatchesPerTick * this.tickScale);
    // The sound card and the speaker move with the same clock: the samples a
    // running transfer consumed over this slice, rendered if a host is
    // listening. This is also what completes a block (see Machine.sbDue).
    // ...AND UNDER `latticeClock`, ON THE LATTICE, FOR THE SAME REASON THE
    // SLICE IS. Rendering is where the Sound Blaster's DMA is FETCHED, and it
    // reads whatever the guest's double buffer holds at that instant -- so a
    // run that hands back an extra time renders one chunk in two halves and
    // reads the buffer at a guest instant the other run never sampled. Pinning
    // the render to a quantum crossing makes both the chunk boundaries and the
    // fetch instants a function of the dispatch count alone, which is also what
    // makes the sample grid come out identical without any change to audio.js:
    // `advance` is fed the same `spent` at the same absolute counts in both
    // arms. DREAM.EXE is the case -- with the boundaries aligned its frame and
    // pixel count matched exactly and only the wav still differed, because the
    // interpreter's extra early exit at 100:842 split one render in two.
    //
    // THE SECOND TERM IS NOT OPTIONAL AND IS NOT `left`. `audioAdvance` is what
    // COMPLETES a transfer block (Machine.sbDue), so a render deferred past the
    // block's end holds its interrupt back with it. The first version of this
    // asked whether the SB deadline had CUT the slice (`sbCut && left < 0`),
    // which is a question about where the run loop happened to hand back --
    // exactly the dependency being removed -- and it silently dropped the
    // render whenever the slice ended early for any other reason. BLIQ.EXE then
    // completed half its blocks: 2906 interrupts fell to 1481, 180,353
    // handbacks to 70,856, and its picture went from 5808 non-black pixels to a
    // black screen. So ask the deadline itself instead: `sbInterval` is how
    // many dispatches the running block has left, measured from the last
    // render, so `dispatched - audioAt >= sbInterval` means the block's last
    // sample is behind us. That is a function of the transfer and the guest
    // clock, and of nothing about the cut.
    const sbDueNow = sbInterval !== Infinity && this.dispatched - this.audioAt >= sbInterval;
    if (machine.audioAdvance && (!this.latticeClock
        || Math.floor(this.dispatched / quantum) > Math.floor(this.audioAt / quantum)
        || sbDueNow)) {
      const spent = this.latticeClock ? this.dispatched - this.audioAt : budget - left;
      this.audioAt = this.dispatched;
      machine.audioAdvance(this.guestSeconds(spent), machine.sliceStart, spent);
    }
    machine.mouse.dx += this.mouse[0];
    machine.mouse.dy += this.mouse[1];

    // Deliver the timer interrupt, if the program asked to be called.
    //
    // Advancing the tick word is not the same service: a demo that hooks INT
    // 08h waits on a counter ITS handler increments, and with nothing ever
    // calling it the program spins on a value that can never change. This is
    // the one place in the cycle where the guest's cs:gip is a real instruction
    // boundary -- mid-trace it is not -- so it is the only place an interrupt
    // can be pushed in front of it.
    //
    // IF is the whole re-entrancy guard, and it is the same one the hardware
    // uses: the injected frame clears it exactly as `int` does, and the ISR's
    // own IRET puts it back.
    //
    // The rate is in guest WORK for the same reason the clock is. Once per
    // handback is not a rate at all: an ISR that ends in IRET ends its trace,
    // so the very next handback is the one it just returned on, and injecting
    // there again gives the interrupted program zero instructions between
    // interrupts. brainbug spent 30M dispatches that way -- 3.6M interrupts, 8
    // dispatches apiece, and the main loop never ran once.
    // IRQ7, the Sound Blaster. Ahead of the timer because a driver waiting on
    // it is usually spinning on a flag its own handler sets, with a timeout:
    // BLAND.EXE's MIDAS module hooks IRQ 2, 5 and 7, starts a block, and
    // unhooks all three and fails the card if none of them fires. This is a
    // block finishing, not a fixed rate, so there is no interval to respect --
    // the machine only says yes once per transfer.
    //
    // Paced, and for the same reason the timer is. An auto-init transfer
    // re-arms the moment it completes, so an unpaced block-done interrupt
    // fires on every single handback: ATTIC.EXE, once it found the card, spent
    // 100M dispatches on 539397 of them at 69 dispatches apiece and never got
    // back to its menu. A real card at 22kHz with a 4K block interrupts a few
    // times a second, which is far rarer than the timer, not more often.
    //
    // Since audio.js the block's end is an event the machine reports (sbDue:
    // the last sample went through the DMA channel at the card's own rate),
    // not an interval computed here. irqEvery stays as the floor between two
    // of them, which is what stops a driver's very short auto-init block from
    // taking every handback.
    const svec = (vm.get('flags') & 0x200)
      && (machine.sbForced() || ((machine.sbDue ? machine.sbDue() : true)
        && this.dispatched - this.lastSbIrq >= this.irqEvery))
      ? machine.sbIrq() : 0;
    // The Ultrasound: an event the card reports (a timer, a voice reaching
    // its end, a DMA upload done), not a cadence. Its timer is the beat of
    // every GUS module player here, so it is not rate-limited the way the
    // Sound Blaster's block is; the slice above is already cut to it.
    const gvec = (vm.get('flags') & 0x200) && machine.gusIrq ? machine.gusIrq() : 0;
    const tvec = machine.timerVector();
    // A frame, not a tick: the vertical retrace comes round about 70 times a
    // second against the timer's 18.2, so it is the fastest thing here. Asked
    // for the vector up front like the Sound Blaster's, so that a rung which
    // declines to fire cannot swallow the keyboard's turn below it.
    // Since the VGA clock (see the slice above) the cadence is the frame edge
    // the status port itself reports, not a fixed irqEvery/4. An edge nobody
    // hooked is consumed here, not saved: a program that hooks IRQ2 later
    // should get its first interrupt at the next edge, not at once.
    const rvec = this.retraceEdge && (vm.get('flags') & 0x200) ? machine.retraceIrq() : 0;
    if (this.retraceEdge && !machine.retraceIrq()) this.retraceEdge = false;
    if (gvec) {
      this.raise(gvec);
    } else if (svec) {
      this.lastSbIrq = this.dispatched;
      this.raise(svec);
    } else if (tvec && this.dispatched - this.lastIrq >= this.timerInterval() && (vm.get('flags') & 0x200)) {
      this.lastIrq = this.dispatched;
      this.raise(tvec);
    } else if (rvec) {
      this.retraceEdge = false;
      this.raise(rvec);
    // IRQ1. A program with its own INT 9 handler reads the keyboard as hardware
    // and never calls the BIOS, so answering INT 16h reaches it not at all --
    // BTW.EXE sits on a sound menu having made zero INT 16h calls in 11M
    // dispatches. The machine decides whether there is anything to send and
    // leaves the scancode where port 60h will find it; here we only deliver it,
    // and only between traces where cs:gip is a real instruction boundary.
    // Slower than the timer on purpose: this is a person typing.
    } else if (this.dispatched - this.lastKbIrq >= (this.pitClock ? this.tickUnit() / 4 : this.irqEvery * 4)
        && (vm.get('flags') & 0x200)) {
      const kvec = machine.keyboardIrq();
      if (kvec) { this.lastKbIrq = this.dispatched; this.raise(kvec); }
    }

    this.checkProgress(cs, ip, this.cache.refusedEntries.has(entry));
    return 'ran';
  }

  // "No progress" means the guest re-entered at the same address AND put
  // nothing new on the console AND came back with the registers it left with.
  //
  // Each of those three clauses is there because the other two were not enough.
  // The address alone: a program printing its screen one character at a time
  // hands back at the same INT 21h thunk every time, so README!.COM was cut off
  // after 201 of its characters and reported as hung while working perfectly.
  // "Nothing new on the console" has to mean the text PAGE rather than the
  // teletype counter, because a program storing straight into B800 never calls
  // INT 21h at all. A delivered timer interrupt counts as progress on its own,
  // since an IRQ-driven demo re-enters its wait loop at one fixed address
  // forever by design -- that is what waiting on a counter LOOKS like, and
  // brainbug.exe was cut off one handback after the first interrupt it was ever
  // sent. And the registers stop the last false positive: a loop that writes
  // into a paragraph some compiled region decoded hands control back on EVERY
  // iteration, at the same address, with nothing on the console --
  // indistinguishable from a spin by address alone. IHANMUU.EXE was cut off
  // after 0.5M of 30M dispatches inside a loop whose SI and BP were advancing
  // the whole time, and runs to a full mode 13h screen without this.
  // cs and ip are the pair the slice STARTED at, and both have to be passed in:
  // by the time this runs the slice has finished and an interrupt may have been
  // pushed in front of the guest, so vm.get('gip') is the stub's offset while cs
  // is still the guest's. That mix printed CAVEIRA.COM as "stuck at 1dcd:103" --
  // the guest's segment spliced onto STUB_OFF+3, a pair the program never had,
  // and a report naming an address that never existed is worse than no report.
  checkProgress(cs, ip, refusedEntry = false) {
    const { vm, machine } = this;
    // The pair as a number. This runs on every handback and the string was
    // three allocations of it -- two toString(16) and a template -- for a value
    // only ever printed when the detector actually fires, which is once per run
    // at most. `cs` is 16 bits and `ip` can be 32, so the two go in a float
    // rather than into an int32 the shift would truncate.
    const key = cs * 0x100000000 + (ip >>> 0);
    // Anything the guest has put anywhere an observer could see it. The video
    // terms are not decoration: outside mode 3 the console count never moves,
    // so without them a program drawing a picture is judged entirely on ten
    // registers -- and a palette fade or a planar fill can run for thousands of
    // iterations with every one of them identical.
    const wrote = machine.con.written + this.irqs + machine.bytesRead
      + machine.dacWrites + machine.vga.maskWrites
      + (machine.videoMode === 3 && this.cells ? this.cells(machine.con) : 0);
    let regs = 2166136261;
    for (let i = 0; i < PROGRESS_REGS.length; i++) {
      regs = (Math.imul(regs, 16777619) ^ vm.get(PROGRESS_REGS[i])) >>> 0;
    }
    const same = key === this.lastKey && wrote === this.lastWritten && regs === this.lastRegs;
    this.stuck = same ? this.stuck + 1 : 0;
    if (!same) this.stuckSince = this.dispatched;
    this.lastKey = key;
    this.lastWritten = wrote;
    this.lastRegs = regs;
    // A handback count alone is not a measure of how long the guest has been
    // getting nowhere, because a handback is not a fixed amount of guest work
    // -- and it stopped being anything like one when far transfers started
    // resolving in wasm. The count needs a run of IDENTICAL handbacks, so it
    // was previously being reset by noise: every far transfer inside a loop
    // body handed back at its own address and put the counter back to zero.
    // Take those away and a program sitting in a perfectly ordinary timed wait
    // -- ACCIDENT.EXE polls `int 15h ah=86h` for 10ms at a time while its
    // loader works -- produces exactly the pattern the detector was written to
    // catch, and the run was cut off at 7.8M dispatches with a black screen.
    // Given 200M it draws its picture and opens both its files.
    //
    // So require the run of handbacks AND a floor of guest work under it. The
    // floor is the honest unit: it asks "has this program done nothing for a
    // while", which is the actual question, and it does not change meaning when
    // the handback rate does. It can only ever turn a stuck verdict into a
    // pass, never the reverse, so no run that completes today starts failing.
    // ...with one exception, and it is not a heuristic: the work floor asks
    // "has this program done nothing for a while", and it is the right question
    // only for a program that is being RUN. A block whose first instruction the
    // decoder refused compiles to `end, ip` -- entering it moves the guest
    // nowhere by construction, and no amount of guest time can change that,
    // because no guest instruction is executing. The only thing that ever makes
    // one of those addresses live again is a write to its bytes, and that drops
    // the refusal (see CodeCache.invalidateRange) along with the run of
    // identical handbacks that got us here. STHINTRO.EXE is what this costs:
    // its protector derails into the interrupt vector table at 0:18c, whose
    // bytes are `63 01 00 f0` -- an ARPL the decoder will not emit in real mode
    // -- and the run then retires ONE dispatch per handback. The work floor is
    // counted in dispatches, so 20M of idleness needs 20M handbacks: 8,888,943
    // of them in a 10M-dispatch run, 90% of the wall clock, and the report says
    // "10.0M dispatches" as though the program had been running the whole time.
    const idle = this.dispatched - (this.stuckSince || 0);
    if (this.stuckLimit && this.stuck > this.stuckLimit
        && (refusedEntry || idle > this.stuckWork)) {
      this.stuckAt = `${cs.toString(16)}:${(ip >>> 0).toString(16)}`;
    }
  }

  // Run until the budget is spent or the program is finished. The headless
  // driver's whole loop; the browser one calls step() instead so it can hand
  // the thread back between chunks.
  runUntil(budget) {
    while (this.dispatched < budget && !this.done) this.step();
    return this;
  }

  // A block ended at a store through CS because the decoder took that for a
  // program editing its own instruction stream. Drop the block it landed in --
  // and notice whether there was one.
  //
  // Getting here at all means the store did NOT land in a paragraph anything
  // had compiled: $wr8 tests that itself and would have set $smc=2, which is a
  // different branch. That is NOT the same as "the store writes data" -- code
  // that has not been compiled yet is still code, which is what a Turbo Pascal
  // overlay is. See PATCH_MISSES: this counter measures cost, and the count
  // says nothing about which kind of store it is counting.
  //
  // Note also that this method destroys its own evidence. It invalidates as it
  // counts, so the next store at the same site is guaranteed to miss too. Do
  // not be tempted to read a long run of misses as increasing confidence; it
  // is the mechanism talking to itself.
  //
  // The safety net underneath is the broad one: $smc=2 still watches every
  // store against the paragraphs that HAVE been compiled, so a write that
  // reaches live code is still caught after a retirement. What is given up is
  // only the tighter cut for code compiled after the write.
  benignPatch(cs, ip, csb, lo, hi) {
    // A store into the bytes just AHEAD of the program counter is an
    // instruction-stream patch whatever the compiled-code bitmap says, so it
    // is never a candidate for retirement. $smc=1 only proves the target was
    // not compiled AT THIS MOMENT, and for a patch that runs the moment the
    // block is entered that is a race, not a verdict: Turbo Pascal's Intr
    // writes the operand byte of an INT 0x1F bytes further on and then falls
    // straight into it. Retiring that site leaves the INT carrying whatever
    // byte the previous call left, which is how BLIQ.EXE's subfiles ended up
    // executing INT 0 and printing "Runtime error 200".
    //
    // ...judged against the range THIS SITE's stores last dirtied, when it
    // last broke as kind 2. A kind-1 break records no range of its own --
    // $wr8 writes $smclo/$smchi only when it finds a code bit -- so the
    // globals hold whatever the last kind-2 store anywhere left there. That
    // used to be what this test read, and it worked for the Turbo Pascal
    // case by accident: Intr() alternates kind 2 (the INT was compiled, the
    // store dropped it) with kind 1 (not yet recompiled), so the stale range
    // was usually its own. It failed the moment another site's range sat
    // ahead of a program counter: CYCLE's mixer ends with a store through CS
    // into a variable at offset 0, and a range some other store left 0xcb
    // bytes ahead of it kept the site from ever retiring -- 66,010 handbacks
    // in 60M dispatches, one per interrupt.
    const pc = ((csb + ip) & 0xFFFFF) >>> 0;
    const own = this.cache.siteRange.get(pc);
    if (own && own[1] >= pc && own[0] < pc + PATCH_AHEAD) return;
    // No invalidate here, and the reason is the flag itself. $smc is 1 only
    // when $wr8 declined to make it 2, and $wr8 makes it 2 for any store
    // landing in a paragraph some compiled region decoded -- every width, since
    // $wr16 and $wr32 are built out of $wr8. So `1` is a proof, not a guess:
    // this store touched no compiled code. Dropping the block we are about to
    // fall into therefore cannot be dropping a block the store changed; it
    // recompiles it into the identical words, because the only input to the
    // decode that ever varies is `benign` membership, which changes on the
    // retirement path below and is invalidated there.
    //
    // That dead recompile was the whole storm. COMPCODE.EXE keeps a dword
    // variable in its code segment (`cs: mov [0x656], eax` at 110:12), which
    // cuts the block at every store and paid a full re-decode for each one:
    // 366344 breaks, 366712 traces and 170MB of arena before it retired 18
    // sites, and it never reached the picture it draws.
    //
    // The invalidate predates the 1/2 split, when a break could not say which
    // kind it was and dropping the block was the only safe answer. It can say
    // now.
    // Keyed by the linear address of the store, not by its offset: see the
    // benign note in decode.js for the Turbo Pascal case where four copies of
    // one runtime, loaded at four bases, shared a single verdict at offset
    // 0x46 and three of them then executed a stale INT operand byte.
    const site = ((csb + ip) & 0xFFFFF) >>> 0;
    const n = (this.cache.patchMisses.get(site) || 0) + 1;
    this.cache.patchMisses.set(site, n);
    if (n === PATCH_MISSES) {
      this.cache.benign.add(site);
      // The compiled copy still carries the cut, so drop it: the block the
      // store sits in has to be re-decoded for the suppression to take effect.
      this.cache.invalidate(cs, ip, csb);
      this.cache.flush();
    }
  }

  stats() {
    return {
      dispatched: this.dispatched, handbacks: this.handbacks, ints: this.ints,
      irqs: this.irqs, smcBreaks: this.smcBreaks, smcPatched: this.cache.patched, smcFastRepairs: this.cache.fastRepairs, stuckAt: this.stuckAt,
      smcSites: this.smcSites, retiredPatches: this.cache.benign.size,
      repairWhy: this.cache.repairWhy,
      traps: this.traps, icebps: this.icebps,
      blockedOn32: this.blockedOn32 === undefined ? null : this.blockedOn32,
      badSelector: this.badSelector === undefined ? null : this.badSelector,
      compiles: this.cache.compiles, compiledWords: this.cache.compiledWords,
      deadFlagsDropped: this.cache.deadFlagsDropped,
      tracedBlocks: this.cache.tracedBlocks,
      spinBlocks: this.cache.spinBlocks,
      specOps: this.cache.specOps,
      arenaResets: this.cache.arenaResets, unimplemented: this.cache.unimplemented,
      regions: this.cache.regions, jtab: this.cache.jtab,
      // Volatile code: [paragraphs volatile now, uncached compiles, promotions,
      // demotions, compiles that ran with their code bits down, exits linked
      // straight into cached blocks].
      volatile: [this.cache.volList.length, this.cache.volatileCompiles,
        this.cache.promotions, this.cache.demotions,
        this.cache.volatilePure, this.cache.volatileLinks],
      // The widened-REP census: [runs, bytes, declined by reason 0..6, declined bytes].
      rep: this.vm.exports.get_rep_stat
        ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => this.vm.exports.get_rep_stat(i) >>> 0)
        : null,
    };
  }
}

module.exports = {
  DosSession, CodeCache, TICK_SECONDS, guestSeconds, dispatchesForGuestSeconds,
};
