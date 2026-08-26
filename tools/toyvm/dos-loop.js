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
const { compileProgram } = require('./compile');
const { STUB_SEG } = require('./dos');

// ---------------------------------------------------------------------------
// The compiled-code arena.
//
// One compiled region per (cs, entry ip). compileProgram walks the whole
// reachable subgraph within that cs, so most entries hit an existing region's
// block map and cost nothing.
class CodeCache {
  constructor(vm, { noCache = false } = {}) {
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
  }

  // Everything compiled is now suspect, because the guest wrote into code that
  // had been compiled. Cheaper answers exist (invalidate just the paragraph),
  // but this happens a handful of times in a run -- once when a packed program
  // unpacks itself -- and being obviously right matters more than being quick.
  flush() {
    this.regions.clear();
    this.vm.set('rtop', 0);
    this.jtab.fill(0);
    this.codeBits.fill(0);
  }

  // Drop one block: the guest patched the instruction it was about to run.
  invalidate(cs, ip, codeBase = (cs << 4)) {
    for (const r of (this.regions.get(codeBase) || [])) r.blocks.delete(ip & 0xFFFF);
    this.jtab[isa.jhash(cs, ip & 0xFFFF) * 2] = 0;
  }

  // Regions are keyed by the code segment's LINEAR base, not by the selector.
  // In real mode those carry the same information -- base is selector<<4 -- but
  // in protected mode one selector value means whatever the descriptor says,
  // and PMODE/W reuses the numbers it was just using as real-mode segments. Key
  // on the selector there and a block compiled before the switch is handed back
  // for an address that is now somewhere else entirely.
  entryFor(cs, ip, codeBase = (cs << 4), mask = 0xFFFFF) {
    const vm = this.vm;
    const key = codeBase;
    if (!this.noCache) {
      for (const r of (this.regions.get(key) || [])) {
        const a = r.blocks.get(ip & 0xFFFF);
        if (a !== undefined) return a;
      }
    }
    // Recycling the arena invalidates every arena address the guest-visible
    // caches hold, so both are emptied here -- a stale entry would resume in
    // whatever got compiled over the block it named.
    if (this.arenaNext >= this.arenaEnd) {
      this.regions.clear();
      this.arenaNext = isa.THREAD_BASE;
      this.arenaResets++;
      vm.set('rtop', 0);
      this.jtab.fill(0);
    }
    const prog = compileProgram((lin) => vm.mem[lin], cs, ip, {
      arenaBase: this.arenaNext,
      maxWords: (this.arenaEnd - this.arenaNext) >> 2,
      codeBase, mask,
    });
    new Int32Array(vm.mem.buffer, prog.arenaBase, prog.words.length).set(prog.words);
    this.arenaNext += prog.words.length * 4;
    this.compiles++;
    this.compiledWords += prog.words.length;
    for (const at of prog.unimplemented) {
      const key = `${cs.toString(16)}:${at.toString(16)}`;
      this.unimplemented.set(key, (this.unimplemented.get(key) || 0) + 1);
    }
    // Mark what was decoded, so a store into it is noticed. Paragraph
    // granularity, which is what $wr8 tests -- a store within 16 bytes of
    // compiled code counts as touching it, and over-reporting only costs a
    // recompile.
    for (const [from, to] of prog.covered) {
      for (let p = from >> 4; p <= (to - 1) >> 4; p++) {
        this.codeBits[p >> 3] |= 1 << (p & 7);
      }
    }
    // Publish every block head into the indirect-jump cache. Direct-mapped, so
    // a later block simply evicts an earlier one -- the key check in $jlook
    // turns that into a handback rather than a wrong jump.
    for (const [bip, addr] of prog.blocks) {
      const slot = isa.jhash(cs, bip) * 2;   // jtab is a view starting AT JTAB_BASE
      this.jtab[slot] = ((cs & 0xFFFF) << 16) | (bip & 0xFFFF);
      this.jtab[slot + 1] = addr;
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
      slice = 2e6, noCache = false, mouse = [0, 0],
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
    this.cache = new CodeCache(vm, { noCache });

    this.dispatched = 0;
    this.handbacks = 0;
    this.ints = 0;
    this.irqs = 0;
    this.smcBreaks = 0;
    this.stuck = 0;
    this.stuckAt = null;
    this.lastIrq = 0;
    this.lastKbIrq = 0;
    this.lastKey = '';
    this.lastWritten = 0;
    this.lastRegs = 0;
  }

  // Is there any point calling step() again?
  get done() {
    return this.machine.exited || this.machine.blockedOnKey || this.stuckAt !== null
      || this.blockedOn32 !== undefined;
  }

  // Push an interrupt frame in front of the guest's next instruction, exactly
  // as the hardware would.
  raise(vec) {
    const vm = this.vm;
    const push = (v) => {
      const sp = (vm.get('sp') - 2) & 0xFFFF;
      vm.set('sp', sp);
      const at = ((vm.get('ss') << 4) + sp) & 0xFFFFF;
      vm.mem[at] = v & 0xFF;
      vm.mem[at + 1] = (v >> 8) & 0xFF;
    };
    push(vm.get('flags'));
    push(vm.get('cs'));
    push(vm.get('gip'));
    vm.set('flags', vm.get('flags') & ~0x300);       // IF and TF, as `int` does
    const at = vec << 2;
    vm.set('gip', vm.mem[at] | (vm.mem[at + 1] << 8));
    vm.set('cs', vm.mem[at + 2] | (vm.mem[at + 3] << 8));
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
    // A 32-bit code segment is where this stops. Everything above is address
    // arithmetic, which protected mode changes and this now follows; a D bit
    // set changes the default operand and address size of every instruction in
    // the segment, which is a second decoder, a 32-bit EIP through the block
    // cache and the jump table, and is not here yet. Refusing is the same
    // choice LGDT used to make one instruction earlier: report it, rather than
    // decode 32-bit code as 16-bit and run something plausible-looking.
    if (vm.exports.get_d32()) {
      this.blockedOn32 = `${cs.toString(16)}:${ip.toString(16)}`;
      return 'blocked32';
    }
    const entry = this.cache.entryFor(cs, ip, codeBase, mask);
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
    if (vm.raw('smc')) {
      const kind = vm.raw('smc');
      vm.set('smc', 0);
      if (kind === 2) this.cache.flush();
      else this.cache.invalidate(vm.get('cs'), vm.get('gip'), vm.exports.get_csb());
      this.smcBreaks++;
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
    const tvec = machine.timerVector();
    if (tvec && this.dispatched - this.lastIrq >= this.irqEvery && (vm.get('flags') & 0x200)) {
      this.lastIrq = this.dispatched;
      this.raise(tvec);
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

    this.checkProgress(cs);
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
  checkProgress(cs) {
    const { vm, machine } = this;
    const key = `${cs.toString(16)}:${vm.get('gip').toString(16)}`;
    const wrote = machine.con.written + this.irqs
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

  stats() {
    return {
      dispatched: this.dispatched, handbacks: this.handbacks, ints: this.ints,
      irqs: this.irqs, smcBreaks: this.smcBreaks, stuckAt: this.stuckAt,
      blockedOn32: this.blockedOn32 === undefined ? null : this.blockedOn32,
      compiles: this.cache.compiles, compiledWords: this.cache.compiledWords,
      arenaResets: this.cache.arenaResets, unimplemented: this.cache.unimplemented,
      regions: this.cache.regions, jtab: this.cache.jtab,
    };
  }
}

module.exports = { DosSession, CodeCache };
