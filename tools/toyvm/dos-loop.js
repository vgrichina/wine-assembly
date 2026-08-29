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
const { compileProgram } = require('./compile');
const { STUB_SEG, STUB_OFF, STUB_BYTE } = require('./dos');

// ---------------------------------------------------------------------------
// The compiled-code arena.
//
// One compiled region per (cs, entry ip). compileProgram walks the whole
// reachable subgraph within that cs, so most entries hit an existing region's
// block map and cost nothing.
class CodeCache {
  constructor(vm, { noCache = false, smcFlush = false } = {}) {
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
    this.vm = vm;
    this.noCache = noCache;
    this.regions = new Map();          // cs -> [prog]
    this.arenaNext = isa.THREAD_BASE;
    this.arenaEnd = isa.THREAD_BASE + isa.THREAD_SIZE - 4096;
    this.compiles = 0;
    this.compiledWords = 0;
    this.arenaResets = 0;
    this.unimplemented = new Map();
    this.jtab = new Int32Array(vm.mem.buffer, isa.JTAB_BASE, isa.JTAB_SIZE >> 2);
    this.codeBits = new Uint8Array(vm.mem.buffer, isa.CODE_BITMAP, isa.CODE_BITMAP_SIZE);
    this.codeBits.fill(0);
    // paragraph -> the compiled programs that decoded a byte in it. This is the
    // reverse of codeBits: the bitmap answers "did anyone compile here", which
    // is what the guest's store path can afford to ask, and this answers "who",
    // which is what turns a self-modifying store into a few dropped regions
    // instead of an empty cache.
    this.byPara = new Map();
  }

  // Everything compiled is now suspect, because the guest wrote into code that
  // had been compiled somewhere. The fallback, for a dirtied range too wide to
  // be worth walking.
  flush() {
    this.regions.clear();
    this.byPara.clear();
    this.vm.set('rtop', 0);
    this.jtab.fill(0);
    this.codeBits.fill(0);
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
  invalidateRange(lo, hi) {
    const from = lo >>> 4, to = hi >>> 4;
    if (this.smcFlush || to - from > 512) { this.flush(); return; }
    const doomed = new Set();
    for (let p = from; p <= to; p++) {
      for (const prog of (this.byPara.get(p) || [])) doomed.add(prog);
    }
    if (!doomed.size) return;
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
    for (const prog of doomed) {
      const list = this.regions.get(prog.key);
      if (list) {
        const at = list.indexOf(prog);
        if (at >= 0) list.splice(at, 1);
      }
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
    this.jtab[isa.jhash(cs, ip >>> 0) * 4 + 2] = 0;
    return hit;
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
    if (!this.noCache) {
      for (const r of (this.regions.get(key) || [])) {
        const a = r.blocks.get(ip >>> 0);
        if (a !== undefined) return a;
      }
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
      this.byPara.clear();
      this.arenaNext = isa.THREAD_BASE;
      this.arenaResets++;
      vm.set('rtop', 0);
      this.jtab.fill(0);
      // Every program that owned a code bit is gone with the arena, so the bits
      // have to go with them or a store into what is now plain data breaks the
      // slice forever with nothing left to invalidate.
      this.codeBits.fill(0);
    }
    const prog = compileProgram((lin) => vm.mem[lin], cs, ip, {
      arenaBase: this.arenaNext,
      maxWords: (this.arenaEnd - this.arenaNext) >> 2,
      codeBase, mask, d32, benign: this.benign,
    });
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
    }
    if (!this.regions.has(key)) this.regions.set(key, []);
    this.regions.get(key).push(prog);
    return prog.entryAddr;
  }
}

// ---------------------------------------------------------------------------
// One guest, driven one step at a time.
//
// `step()` does exactly one of two things: service an interrupt the guest is
// sitting in, or compile-and-run one slice. It never loops, which is what lets
// a browser run a program across animation frames without the loop and the
// frame budget having to know about each other.
class DosSession {
  constructor(vm, machine, opts = {}) {
    const {
      slice = 2e6, noCache = false, smcFlush = false, mouse = [0, 0],
      // One timer interrupt per this many dispatches. 100k is about 10ms of a
      // real 486, so it lands near the 18.2Hz the BIOS programs -- and a demo
      // that reprogrammed the PIT for music gets a slower clock than it asked
      // for, which costs it tempo and nothing else.
      irqEvery = 100e3, dispatchesPerTick = 550e3, tickScale = 1,
      // How many handbacks at one address with nothing new on screen before the
      // run is called hung. 0 turns the detector off, which is what to reach for
      // when the question is whether a loop is stuck or merely long.
      stuckLimit = 200,
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
      hooks = {},
    } = opts;

    this.vm = vm;
    this.machine = machine;
    this.slice = slice;
    this.mouse = mouse;
    this.irqEvery = irqEvery;
    this.dispatchesPerTick = dispatchesPerTick;
    this.tickScale = tickScale;
    this.stuckLimit = stuckLimit;
    this.cells = cells;
    this.hooks = hooks;
    this.cache = new CodeCache(vm, { noCache, smcFlush });

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
    this.lastKbIrq = 0;
    this.lastSbIrq = 0;
    this.lastRetraceIrq = 0;
    this.lastKey = '';
    this.lastWritten = 0;
    this.lastRegs = 0;
  }

  // Is there any point calling step() again?
  get done() {
    return this.machine.exited || this.machine.blockedOnKey || this.stuckAt !== null
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
    const ok = machine.service(vec, r);
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
    if (this.hooks.onEntry) this.hooks.onEntry(cs, ip, this.handbacks);

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
    vm.exports.run(entry, this.slice);
    // $left is -1 when the slice ran to exhaustion and holds the unspent budget
    // when a handler handed control back early. Billing the slice either way
    // makes a demo that bounces off an unresolved jump every few instructions
    // look like it burned the whole budget.
    const left = vm.raw('left');
    this.dispatched += left < 0 ? this.slice : this.slice - left;
    this.handbacks++;
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
      if (kind === 2) this.cache.invalidateRange(lo, hi);
      else this.benignPatch(vm.get('cs'), vm.get('gip'), vm.exports.get_csb());
      this.smcBreaks++;
      if (this.smcSites) {
        const hex = (n) => n.toString(16);
        const key = kind === 2
          ? `${hex(vm.get('cs'))}:${hex(vm.get('gip'))} wrote ${hex(lo)}-${hex(hi)}`
          : `${hex(vm.get('cs'))}:${hex(vm.get('gip'))} patched its own next block`;
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
    const svec = (vm.get('flags') & 0x200)
      && this.dispatched - this.lastSbIrq >= this.irqEvery
      ? machine.sbIrq() : 0;
    const tvec = machine.timerVector();
    // A frame, not a tick: the vertical retrace comes round about 70 times a
    // second against the timer's 18.2, so it is the fastest thing here. Asked
    // for the vector up front like the Sound Blaster's, so that a rung which
    // declines to fire cannot swallow the keyboard's turn below it.
    const rvec = (vm.get('flags') & 0x200)
      && this.dispatched - this.lastRetraceIrq >= this.irqEvery / 4
      ? machine.retraceIrq() : 0;
    if (svec) {
      this.lastSbIrq = this.dispatched;
      this.raise(svec);
    } else if (tvec && this.dispatched - this.lastIrq >= this.irqEvery && (vm.get('flags') & 0x200)) {
      this.lastIrq = this.dispatched;
      this.raise(tvec);
    } else if (rvec) {
      this.lastRetraceIrq = this.dispatched;
      this.raise(rvec);
    // IRQ1. A program with its own INT 9 handler reads the keyboard as hardware
    // and never calls the BIOS, so answering INT 16h reaches it not at all --
    // BTW.EXE sits on a sound menu having made zero INT 16h calls in 11M
    // dispatches. The machine decides whether there is anything to send and
    // leaves the scancode where port 60h will find it; here we only deliver it,
    // and only between traces where cs:gip is a real instruction boundary.
    // Slower than the timer on purpose: this is a person typing.
    } else if (this.dispatched - this.lastKbIrq >= this.irqEvery * 4
        && (vm.get('flags') & 0x200)) {
      const kvec = machine.keyboardIrq();
      if (kvec) { this.lastKbIrq = this.dispatched; this.raise(kvec); }
    }

    this.checkProgress(cs, ip);
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
  checkProgress(cs, ip) {
    const { vm, machine } = this;
    const key = `${cs.toString(16)}:${ip.toString(16)}`;
    const wrote = machine.con.written + this.irqs + machine.bytesRead
      + (machine.videoMode === 3 && this.cells ? this.cells(machine.con) : 0);
    let regs = 2166136261;
    for (const n of ['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'ds', 'es']) {
      regs = (Math.imul(regs, 16777619) ^ vm.get(n)) >>> 0;
    }
    this.stuck = (key === this.lastKey && wrote === this.lastWritten && regs === this.lastRegs)
      ? this.stuck + 1 : 0;
    this.lastKey = key;
    this.lastWritten = wrote;
    this.lastRegs = regs;
    if (this.stuckLimit && this.stuck > this.stuckLimit) this.stuckAt = key;
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
  benignPatch(cs, ip, csb) {
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
    const n = (this.cache.patchMisses.get(ip) || 0) + 1;
    this.cache.patchMisses.set(ip, n);
    if (n === PATCH_MISSES) {
      this.cache.benign.add(ip);
      // The compiled copy still carries the cut, so drop it: the block the
      // store sits in has to be re-decoded for the suppression to take effect.
      this.cache.invalidate(cs, ip, csb);
      this.cache.flush();
    }
  }

  stats() {
    return {
      dispatched: this.dispatched, handbacks: this.handbacks, ints: this.ints,
      irqs: this.irqs, smcBreaks: this.smcBreaks, stuckAt: this.stuckAt,
      smcSites: this.smcSites, retiredPatches: this.cache.benign.size,
      traps: this.traps, icebps: this.icebps,
      blockedOn32: this.blockedOn32 === undefined ? null : this.blockedOn32,
      badSelector: this.badSelector === undefined ? null : this.badSelector,
      compiles: this.cache.compiles, compiledWords: this.cache.compiledWords,
      arenaResets: this.cache.arenaResets, unimplemented: this.cache.unimplemented,
      regions: this.cache.regions, jtab: this.cache.jtab,
    };
  }
}

module.exports = { DosSession, CodeCache };
