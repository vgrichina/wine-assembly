'use strict';

// Compile a whole reachable program into the thread arena, with branch targets
// resolved to arena addresses.
//
// This is what separates a benchmark from the gate. The gate runs one
// instruction per call into wasm, so host-call overhead dwarfs everything and
// no dispatch difference could possibly show. Here the entire loop lives in the
// arena and one call runs millions of dispatches -- which is also what the
// production interpreter does, so the shape being measured is the real one.
//
// Layout is a trace cache, not a basic-block graph: straight-line code is
// appended until a branch, and a branch into the middle of already-compiled
// code simply compiles that tail again. Duplication is cheap and keeps the
// fall-through path contiguous, which is exactly the property the dispatch
// variants are being compared on.

const isa = require('./isa');
const { decodeOne, H } = require('./decode');

function compileProgram(readByte, cs, entryIp, opts = {}) {
  const arenaBase = opts.arenaBase === undefined ? isa.THREAD_BASE : opts.arenaBase;
  const maxWords = opts.maxWords || (isa.THREAD_SIZE >> 2) - 16;
  // Where this code segment actually starts, and how far the address bus goes.
  // In real mode the first is cs<<4 and callers leave it alone; in protected
  // mode the selector says nothing about the address and the base comes from
  // the descriptor CS was loaded through.
  const codeBase = opts.codeBase === undefined ? (cs << 4) : opts.codeBase;
  const mask = opts.mask === undefined ? 0xFFFFF : opts.mask;
  // The D bit of the descriptor CS was loaded through: the default operand and
  // address size of every instruction in the segment, and a 32-bit EIP that no
  // longer wraps at 0xFFFF.
  const d32 = !!opts.d32;
  // Guest IPs (the address AFTER the store) where a CS-override store has been
  // watched hitting nothing compiled, over and over. See benignPatch in
  // dos-loop.js: the decoder's rule for self-patching code is a static guess,
  // and this is the host telling it the guess was wrong here.
  const benign = opts.benign || null;
  const entry = d32 ? (entryIp >>> 0) : (entryIp & 0xFFFF);

  const blocks = new Map();      // guest IP -> arena address
  const words = [];
  const fixups = [];             // { wordIndex, ip }
  const pending = [entry];
  const unimplemented = new Set();
  // Every byte this compile DECODED, as linear [from, to) ranges. The host
  // marks them in isa.CODE_BITMAP so a later store into any of them is seen for
  // what it is: a program rewriting code that has already been compiled.
  const covered = [];

  while (pending.length) {
    const blockIp = pending.pop();
    if (blocks.has(blockIp)) continue;
    blocks.set(blockIp, arenaBase + words.length * 4);

    let cur = blockIp;
    // Whether anything in this block stored to memory. A block that writes and
    // then branches BACKWARD is a copy, a fill or -- the case this exists for
    // -- a decryptor, and what follows it is very often the bytes it just
    // wrote. COROMER.EXE's entry is eleven instructions that XOR 861 bytes of
    // itself into existence and fall through into the result; compiling the
    // whole reachable subgraph from the entry decoded that result while it was
    // still ciphertext, and the demo jumped to 0000:003B inside the interrupt
    // vector table. So the forward exits of such a block are left unresolved:
    // the loop hands control back when it ends, and the code after it is
    // decoded from memory as it is by then.
    let wrote = false;
    let bulkWrote = false;
    for (;;) {
      if (words.length > maxWords) { words.push(H.end, cur); break; }

      // Reaching the head of a block we already emitted: jump to it rather than
      // emitting a second copy of an entire loop body.
      if (cur !== blockIp && blocks.has(cur)) {
        words.push(H.jmp, 0, cur);
        fixups.push({ wordIndex: words.length - 2, ip: cur });
        break;
      }

      const d = decodeOne(readByte, cs, cur, codeBase, mask, d32, benign);
      if (!d) {
        // An opcode we do not implement ends the trace and hands the guest IP
        // back, so the host can report exactly where coverage ran out instead
        // of executing something plausible-looking.
        unimplemented.add(cur);
        words.push(H.end, cur);
        break;
      }

      const base = words.length;
      words.push(...d.words);
      if (d.writesMem) wrote = true;
      // A backward edge out of a block that wrote memory makes every FORWARD
      // edge suspect -- that is the loop-then-fall-through shape of a
      // decryptor. The backward edge itself is still resolved, so the loop
      // stays in the arena and costs nothing per iteration.
      // "Backward" is measured from the branch itself, not from the block head:
      // a decryptor's loop body usually starts mid-block, after the setup that
      // computed its source pointer, so a test against the block head calls its
      // own back edge a forward one and compiles the ciphertext anyway.
      // A REP'd store has already written its whole range by the time the next
      // instruction runs, so it needs no branch to be a decryptor: AMORP.COM
      // moves 0x249 words over itself with one `rep movsw` and jumps FORWARD
      // into the result. Following that jump decoded 369KB of arena out of a
      // 1174-byte .COM -- the whole segment past the file, as `add [bx+si],al`
      // over a field of zeros -- and the program spun there forever.
      if (d.bulkWrite) bulkWrote = true;
      const loops = bulkWrote
        || (wrote && (d.fixups || []).some(f => f.ip <= cur));
      for (const f of (d.fixups || [])) {
        fixups.push({ wordIndex: base + f.index, ip: f.ip });
        if (!opts.oneInsn && (!loops || f.ip <= cur)) pending.push(f.ip);
      }

      cur = d.nextIp;
      if (d.endsBlock) break;
      // opts.oneInsn is the trap flag's compiler: with TF set the CPU owes the
      // guest an INT 1 after EVERY instruction, so the block has to be exactly
      // one long. A branch already ended it above and wrote $gip itself; this
      // is the straight-line case, where `end` carries the next address out.
      if (opts.oneInsn) { words.push(H.end, cur); break; }
    }
    // The block's extent. `cur` can have wrapped past 0xFFFF on a segment that
    // runs to the top, in which case the tail is simply not marked -- a missed
    // mark costs a stale block, never a wrong one.
    if (cur > blockIp) covered.push([(codeBase + blockIp) & mask, (codeBase + cur) & mask]);
  }

  // Resolve. A target that never got compiled keeps its 0, which the branch
  // handlers read as "stop and hand back", so an unreachable-in-practice edge
  // costs nothing and cannot jump into rubbish.
  let unresolved = 0;
  for (const f of fixups) {
    if (blocks.has(f.ip)) words[f.wordIndex] = blocks.get(f.ip);
    else unresolved++;
  }

  return {
    words, blocks, fixups, unresolved, covered,
    unimplemented: [...unimplemented],
    entryAddr: blocks.get(entry),
    arenaBase,
    byteLength: words.length * 4,
  };
}

// Write a compiled program into a VM's linear memory.
function install(vm, prog) {
  const view = new Int32Array(vm.mem.buffer, prog.arenaBase, prog.words.length);
  view.set(prog.words);
  return prog.entryAddr;
}

module.exports = { compileProgram, install };
