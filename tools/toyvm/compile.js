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
const { ARITY, FUSE, NOFLAG, FLAG_EFFECTS, prepareTables } = require('./emit');

function compileProgram(readByte, cs, entryIp, opts = {}) {
  // ARITY, NOFLAG and FLAG_EFFECTS are filled on first use rather than at
  // require time (emit.js says why), and they are held here by reference.
  prepareTables();
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
  // The wasm decoder, when the caller has one. It decodes a RUN of instructions
  // per call and stops at the first opcode it does not implement, at which point
  // the loop below decodes that one instruction itself and offers wasm the next
  // run. So coverage buys time in proportion to itself and correctness never
  // depends on it: everything it declines is decoded exactly as before.
  //
  // See docs/toyvm-decoder-in-wasm.md, and tools/toyvm/decode-diff.js for the
  // differential test that the two decoders agree where they overlap.
  const wd = opts.wasmDecoder || null;
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

  // Superinstruction formation. Off with `fuse: false` (run-dos.js --no-fuse),
  // which is the A/B partner: fusing preserves $steps exactly (see
  // genFusedBranches), so an unfused and a fused run must agree frame for
  // frame, and any difference is a bug rather than a retiming.
  // Never under oneInsn: with TF set the CPU owes the guest an INT 1 after
  // EVERY instruction, and a fused pair is two of them. A one-instruction block
  // cannot contain a pair to begin with, so this changes nothing today -- it is
  // here so that stays true if a single instruction ever emits two ops.
  const fuse = opts.fuse !== false && !opts.oneInsn;
  // Dead flag writes. Same reasoning as `fuse` for oneInsn: with TF set the
  // guest gets an INT 1 after every instruction and the interrupt frame carries
  // the flags word, so nothing inside a one-instruction block is dead.
  const deadFlags = opts.deadFlags !== false && !opts.oneInsn;
  const traceDeadFlags = opts.traceDeadFlags || null;

  // Rewrite a finished block's last two ops into one, when a fused handler for
  // that pair exists. The fused body is the two bodies in sequence and each
  // reads its own operands off $ip, so the operand words are already in the
  // right order -- the whole edit is dropping the second op's opcode word.
  //
  // The walk is the only way to find where the second-to-last op starts: a
  // block is [fn][operands...] repeated, and nothing in the arena distinguishes
  // an opcode word from an operand without the arity table. If the walk does
  // not land exactly on the end, the arity table and the arena disagree about
  // something and fusing on that assumption would rewrite an operand as an
  // opcode, so it declines instead.
  const fuseTail = (start) => {
    let prevStart = -1, lastStart = -1, i = start;
    for (; i < words.length;) {
      prevStart = lastStart;
      lastStart = i;
      i += 1 + ARITY[words[i]];
    }
    if (i !== words.length || prevStart < 0) return;
    const fused = FUSE.get(words[prevStart] * 65536 + words[lastStart]);
    if (fused === undefined) return;
    words[prevStart] = fused;
    words.splice(lastStart, 1);
    // The branch's own fixups point at operand words that just moved down one.
    // They are the last fixups pushed and the only ones past `lastStart` --
    // every earlier block ended below `start` -- so the scan stops at the first
    // one that did not move.
    for (let k = fixups.length - 1; k >= 0 && fixups[k].wordIndex > lastStart; k--) {
      fixups[k].wordIndex--;
    }
  };

  // Swap every op whose flag write nothing reads for the copy of itself that
  // does not write them. Runs AFTER fuseTail, on the final word list: a fused
  // compare-and-branch reads the record its own half just made and then never
  // reads the flags it was entered with, which makes it the most common killer
  // in the corpus -- the very thing that lets the arithmetic in front of it go
  // flagless.
  //
  // Backwards from the end of the block, with the flags LIVE at the block end.
  // They have to be: the next block may read them, and a handback at a block
  // end is where an interrupt gets injected and pushes FLAGS onto the guest
  // stack.
  let deadFlagCount = 0;
  const dropDeadFlags = (start) => {
    // Same walk, and the same refusal, as fuseTail: if the arity table and the
    // arena disagree the positions are not op boundaries and rewriting one
    // would corrupt an operand.
    const at = [];
    let i = start;
    for (; i < words.length;) { at.push(i); i += 1 + ARITY[words[i]]; }
    if (i !== words.length) return;
    let live = true;
    for (let k = at.length - 1; k >= 0; k--) {
      const p = at[k];
      let e = FLAG_EFFECTS[words[p]];
      if (!e) return;
      if (e.kills && !live) {
        const nf = NOFLAG.get(words[p]);
        if (nf !== undefined) {
          // The whole block, not just the op: a wrong answer here is always a
          // later op wrongly believed to overwrite the flags, and the only way
          // to see which one is to read the sequence. `cmp_ri16 cmc ret` is
          // what found the folded-order bug in the analysis.
          if (traceDeadFlags) {
            const { HANDLERS } = require('./emit');
            traceDeadFlags(`[deadflag] ${HANDLERS[words[p]].name} in block `
              + at.map(q => HANDLERS[words[q]].name).join(' '));
          }
          words[p] = nf; deadFlagCount++; e = FLAG_EFFECTS[nf];
        }
      }
      // Liveness of the flags entering this op, computed from the handler that
      // is there NOW -- dropping the write also drops whatever read fed it.
      live = e.readsIn ? true : (e.kills ? false : live);
    }
  };

  // The block-head bitmap wasm stops on. Kept across the whole compile and
  // cleared bit by bit at the end rather than wiped per block: CONTAGIO compiles
  // 87,000 times in one run, and zeroing 8KB each time would cost more than the
  // decoding does.
  const heads = wd ? new Uint8Array(wd.mem.buffer, isa.DEC_HEADS, isa.DEC_HEADS_SIZE) : null;
  const markHead = (ip) => { if (heads) heads[(ip & 0xFFFF) >> 3] |= 1 << (ip & 7); };
  // Made once per compile, not once per block. CONTAGIO compiles 87,000 times
  // in one run and a fresh view per block would be the allocation this whole
  // change exists to avoid paying elsewhere. The VM's memory is a fixed
  // MEM_PAGES and never grows, so these cannot be detached under us.
  const scratchView = wd
    ? new Int32Array(wd.mem.buffer, isa.DEC_SCRATCH, isa.DEC_SCRATCH_WORDS) : null;
  const fixupView = wd
    ? new Int32Array(wd.mem.buffer, isa.DEC_FIXUPS,
        isa.DEC_FIXUPS_MAX * isa.DEC_FIXUP_WORDS) : null;

  while (pending.length) {
    const blockIp = pending.pop();
    if (blocks.has(blockIp)) continue;
    const blockStart = words.length;
    blocks.set(blockIp, arenaBase + words.length * 4);
    markHead(blockIp);

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
    let refusedAt = -1;
    for (;;) {
      if (words.length > maxWords) { words.push(H.end, cur); break; }

      // Reaching the head of a block we already emitted: jump to it rather than
      // emitting a second copy of an entire loop body.
      if (cur !== blockIp && blocks.has(cur)) {
        words.push(H.jmp, 0, cur);
        fixups.push({ wordIndex: words.length - 2, ip: cur });
        break;
      }

      // Hand the rest of the block to wasm. It stops at the first opcode it does
      // not implement, so the worst case is that it decodes nothing and this
      // costs one call; the best case is that it decodes the whole block.
      //
      // The mid-block "already emitted, jump to it" check above still applies
      // inside a wasm run: wasm reads the same block heads out of a bitmap the
      // loop maintains and stops when straight-line code falls into one. Without
      // that it emitted a second copy of the tail, which is not just wasteful --
      // the blocks around it end elsewhere, the guest takes its interrupts at
      // different instructions, and COMPOVRS.EXE rendered a different frame from
      // 4M dispatches on while both decoders agreed instruction for instruction.
      if (wd) {
        const room = Math.min(isa.DEC_SCRATCH_WORDS, maxWords - words.length);
        const n = room > 32
          ? wd.exports.compile_block(cur, codeBase, mask, d32 ? 1 : 0,
              isa.DEC_SCRATCH, room, 0, (wrote ? 1 : 0) | (bulkWrote ? 2 : 0))
          : 0;
        if (n > 0) {
          const base = words.length;
          for (let i = 0; i < n; i++) words.push(scratchView[i]);

          // Replay the host's decryptor rule over the run, per instruction and
          // unchanged: each fixup carries the ip of the instruction that emitted
          // it and whether anything up to and including that instruction stored.
          // A block-level summary cannot express this -- it would call a
          // decryptor's own back edge a forward one and queue the ciphertext
          // ahead of it.
          //
          // The rule is per INSTRUCTION and reads all of that instruction's
          // edges at once, which matters for a conditional jump: its two fixups
          // are the target and the fall-through, and a backward target makes the
          // FORWARD one suspect. Deciding each fixup on its own target would
          // find the fall-through forward, call it safe and queue exactly the
          // ciphertext the rule exists to refuse. One instruction's fixups are
          // consecutive, so a run of equal insnIp is that instruction's set.
          const nf = wd.exports.dc_fixups();
          const fx = fixupView;
          const W = isa.DEC_FIXUP_WORDS;
          for (let i = 0; i < nf;) {
            const insnIp = fx[i * W + 2], flags = fx[i * W + 3];
            let j = i;
            while (j < nf && fx[j * W + 2] === insnIp) j++;
            let backward = false;
            for (let k = i; k < j; k++) if (fx[k * W + 1] <= insnIp) backward = true;
            const loops = (flags & 2) !== 0 || ((flags & 1) !== 0 && backward);
            for (let k = i; k < j; k++) {
              const targetIp = fx[k * W + 1];
              fixups.push({ wordIndex: base + fx[k * W], ip: targetIp });
              if (!opts.oneInsn && (!loops || targetIp <= insnIp)) pending.push(targetIp);
            }
            i = j;
          }
          if (wd.exports.dc_wrote()) wrote = true;
          if (wd.exports.dc_bulk()) bulkWrote = true;
          cur = wd.exports.dc_stop_ip();
          if (wd.exports.dc_stopped() === 1) break;   // STOP.ENDED
          if (opts.oneInsn) { words.push(H.end, cur); break; }
          // Anything else -- an unimplemented opcode, a full arena, a block head
          // reached -- goes back to the top of the loop, which handles each of
          // them exactly as it does for a block it decoded itself.
          continue;
        }
      }

      const d = decodeOne(readByte, cs, cur, codeBase, mask, d32, benign);
      if (!d) {
        // An opcode we do not implement ends the trace and hands the guest IP
        // back, so the host can report exactly where coverage ran out instead
        // of executing something plausible-looking.
        unimplemented.add(cur);
        words.push(H.end, cur);
        refusedAt = cur;
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
    if (fuse) fuseTail(blockStart);
    if (deadFlags) dropDeadFlags(blockStart);
    // The block's extent. `cur` can have wrapped past 0xFFFF on a segment that
    // runs to the top, in which case the tail is simply not marked -- a missed
    // mark costs a stale block, never a wrong one.
    //
    // The refused byte is part of that extent. `cur` does not advance past an
    // instruction we would not decode, so a block whose FIRST instruction was
    // refused covers [blockIp, blockIp) -- nothing -- and marks no code bits at
    // all. The block is still cached and still published into the jump table,
    // so when a decryptor later writes the real opcode there, nothing notices
    // and the stale "hand back" block is re-entered forever. That is JULTRO.EXE:
    // it arrives at 5ab:6e while the byte is still ciphertext, we cache a refusal
    // for it, the decryptor writes the real `eb fa`, and the demo hands back at
    // that one address until the stuck detector gives up -- 6,189 dispatches into
    // a program that runs half a million with the block cache switched off.
    const extent = refusedAt >= 0 ? cur + 1 : cur;
    if (extent > blockIp) {
      covered.push([(codeBase + blockIp) & mask, (codeBase + extent) & mask]);
    }
  }

  // Hand the bitmap back the way it was found. Clearing the bits this compile
  // set, rather than the whole 8KB, because the next compile is usually a few
  // blocks and the wipe would dominate it.
  if (heads) for (const ip of blocks.keys()) heads[(ip & 0xFFFF) >> 3] = 0;

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
    deadFlags: deadFlagCount,
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
