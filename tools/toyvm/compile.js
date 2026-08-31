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
const { ARITY, FUSE, TRACE, SPIN, SPEC, applyExtract, NOFLAG, FLAG_EFFECTS,
  prepareTables } = require('./emit');

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
  const blockIps = [];           // emission order
  const blockStarts = [];        // word index each of those starts at
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
  // Carry that liveness ACROSS a block edge instead of giving up at the block
  // end. `--no-crossflags` is the A/B partner and restores the per-block walk.
  const crossFlags = deadFlags && opts.crossFlags !== false;
  // Compile THROUGH a conditional branch: the taken edge stays a side exit and
  // the not-taken edge is laid out inline behind it, so the common direction
  // pays no block transfer. `--no-trace-blocks` is the A/B partner.
  // Never under oneInsn, where a block is one instruction by definition.
  const traceBlocks = opts.traceBlocks !== false && !opts.oneInsn;
  // Collapse a block that is one pure branch back to its own head. Never under
  // oneInsn, where the trap flag owes the guest an INT 1 after every
  // instruction and the loop therefore does NOT run to the end of the slice.
  // `--no-spin` is the A/B partner.
  const spinLoops = opts.spinLoops !== false && !opts.oneInsn;
  // Swap each register-file access on a runtime index for the twin that has
  // the register as a literal. Safe under oneInsn too -- it changes no control
  // flow and no step accounting. OFF unless the twins were generated: opting
  // in is `--reg-spec`, and docs/toyvm-reg-specialization.md says why it is not
  // the default. `SPEC` is empty when they were not, so this is also self-
  // disabling rather than depending on the caller to agree with emit.js.
  const regSpec = opts.regSpec === true && SPEC.size > 0;
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

  // The op boundaries of one word range, or null when the arity table and the
  // arena disagree about where they are -- in which case nothing here may
  // rewrite a word, because the positions are not opcodes. Same refusal as
  // fuseTail, and for the same reason.
  const opsOf = (start, end) => {
    const at = [];
    let i = start;
    for (; i < end;) { at.push(i); i += 1 + ARITY[words[i]]; }
    return i === end ? at : null;
  };

  // Blocks whose successors include the block laid out immediately after them,
  // through a traced conditional's not-taken edge. That edge is the one control
  // edge with no fixup, so the flag-liveness pass would otherwise miss it.
  const fallEdge = new Set();

  // Extend a block THROUGH the conditional branch it just ended on: swap the
  // branch for the twin that has no fall-through arena operand, register the
  // fall-through address as a block head at the word after it, and keep
  // decoding. The not-taken edge then costs no block transfer at all -- it is
  // the next word.
  //
  // Returns the guest ip to carry on decoding at, or -1 to end the block.
  //
  // Three things it will not do:
  //  * extend past a block that wrote memory. That is the decryptor rule from
  //    the main loop, in its blunt form: what follows such a block is very
  //    often the bytes it just wrote, and decoding them now bakes the
  //    ciphertext into the trace.
  //  * extend into a block that already exists. Falling into a compiled block
  //    is exactly what the arena is for, and emitting a second copy of it here
  //    would end the same way COMPOVRS did -- two copies, blocks ending in
  //    different places, interrupts landing on different instructions.
  //  * extend without room. The tail of a full arena is a handback, and there
  //    is no point starting a trace that cannot finish an instruction.
  let tracedBlocks = 0;
  const extendThrough = (start, wroteMem) => {
    if (!traceBlocks || wroteMem) return -1;
    if (!opsOf(start, words.length)) return -1;
    // Fuse the pair FIRST. The compare and the branch are the same two
    // instructions both transformations want, and fusing after the swap would
    // leave fuseTail looking for a pair whose plain branch is no longer there.
    if (fuse) fuseTail(start);
    const at = opsOf(start, words.length);
    if (!at || !at.length) return -1;
    const q = at[at.length - 1];
    const t = TRACE.get(words[q]);
    if (t === undefined) return -1;
    // Branch operands are [arenaTaken][guestTaken][arenaFall][guestFall] and
    // they are always last, whatever the fused first half ate in front of them.
    const gFall = words[q + ARITY[words[q]]];
    const aFall = q + ARITY[words[q]] - 1;
    if (blocks.has(gFall)) return -1;
    if (words.length + 16 > maxWords) return -1;

    words[q] = t;
    words.splice(aFall, 1);
    // The fall-through's fixup goes with the operand it pointed at, and any
    // fixup past it moved down one. Both are at the end of the list: this
    // branch is the last thing that pushed one.
    for (let k = fixups.length - 1; k >= 0 && fixups[k].wordIndex >= aFall; k--) {
      if (fixups[k].wordIndex === aFall) fixups.splice(k, 1);
      else fixups[k].wordIndex--;
    }
    // The fall-through is a real block head from here on, so anything else that
    // jumps to it lands in the middle of this trace rather than compiling a
    // second copy -- and the wasm decoder stops there for the same reason.
    blocks.set(gFall, arenaBase + words.length * 4);
    markHead(gFall);
    fallEdge.add(blockStarts.length - 1);
    blockIps.push(gFall);
    blockStarts.push(words.length);
    tracedBlocks++;
    return gFall;
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
  //
  // With `crossFlags` the flags are live at the block end only if some
  // successor reads them before overwriting them, which is a fixpoint over the
  // whole region rather than a per-block walk -- see dropDeadFlagsRegion.
  let deadFlagCount = 0;
  // Walk one block backwards from `liveOut`, swapping in flagless handlers, and
  // return the liveness entering it. `edge` is true when the block's own
  // terminator resumes at a successor this compile emitted, which is what lets
  // its slice-exit handback stop counting as a flag read.
  // `rewrite` false answers the question without touching the arena, which is
  // what the fixpoint below needs.
  const walkBlock = (at, liveOut, edge, rewrite) => {
    let live = liveOut;
    for (let k = at.length - 1; k >= 0; k--) {
      const p = at[k];
      let e = FLAG_EFFECTS[words[p]];
      if (!e) return true;
      if (rewrite && e.kills && !live) {
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
      //
      // Only the LAST op gets the across-an-edge answer, and only when the
      // edge is known. A handback in the middle of a block resumes at that
      // instruction's own guest address, which starts a compile this one
      // cannot see; the terminator's resumes at a successor head, which is in
      // this region and has just been walked.
      const reads = (edge && k === at.length - 1) ? e.readsInX : e.readsIn;
      live = reads ? true : (e.kills ? false : live);
    }
    return live;
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
    // Emission order, for the flag-liveness pass at the end. Blocks are laid
    // out back to back, so block b spans [starts[b], starts[b+1]).
    blockIps.push(blockIp);
    blockStarts.push(blockStart);
    blocks.set(blockIp, arenaBase + words.length * 4);
    markHead(blockIp);

    // A JIT-compiled loop region replaces the whole block: one word, the
    // region handler's index, and nothing else. The region carries its own
    // control flow and publishes $gip/$ip on the way out, so from here it is
    // simply a block that happens to be one op long.
    //
    // Installed by GUEST ip, never by arena address. The region was built from
    // an earlier run whose arena layout this one does not reproduce -- blocks
    // are laid out in decode order and a self-modifying program recycles the
    // whole region -- so an arena constant baked into it would point at
    // whatever this run happened to compile there.
    // Keyed by `cs:ip`, not by ip. An offset is not an address: RUNDEMO.EXE has
    // a block at 0xbb in more than one code segment, and installing a region on
    // the bare offset put a loop from one segment in front of unrelated code in
    // another. The machine stopped at cs 0 having taken 1.93M handbacks -- so it
    // does not fail quietly, but it fails a long way from the cause.
    // The segment half of the key is the block cache's own program key --
    // linear code base, plus a `d` for a 32-bit descriptor -- and not `cs`.
    // Two selectors can name one base, one base can be reached through both a
    // 16-bit and a 32-bit descriptor, and the caller identifies the region by
    // whatever key it read out of the cache. Keying on `cs` here looked right
    // and matched nothing: the region silently never ran, and the only symptom
    // was a run that was neither faster nor different.
    const regionKey = `${d32 ? `${codeBase}d` : codeBase}:${blockIp}`;
    // A REGION IS ONLY VALID OVER THE BYTES IT WAS COMPILED FROM. It is keyed
    // by guest ip, and a program that rewrites the code at that ip would
    // otherwise get the old loop installed over the new instructions -- with
    // nothing to notice, because the region replaces the decode that would have
    // read them. Measured on ACCIDENT.EXE at 12M dispatches: one self-modify
    // break in the baseline, none with the region, a blank screen where the
    // baseline had drawn 18447 pixels, and a run 4x slower for it. So the
    // caller records the guest bytes each block covered, and a byte that has
    // moved declines the substitution and decodes normally.
    const guard = opts.regionBytes && opts.regionBytes.get(regionKey);
    const guardOk = !guard || guard.every(g =>
      g.bytes.every((b, i) => readByte((g.lin + i) & mask) === b));
    if (opts.regionAt && opts.regionAt.has(regionKey) && guardOk) {
      // The map holds an ORDINAL (which region), not a table index: only the
      // built module knows where its regions landed, and it says so through
      // `regionBase`.
      words.push((opts.regionBase || 0) + opts.regionAt.get(regionKey));
      // ...but the successors still have to be compiled. The decoder finds the
      // rest of a program by walking out of each block it decodes, and a region
      // replaces that walk with one word, so nothing downstream of the region
      // gets discovered: every exit from it then misses the block cache, hands
      // back to the host, and the region ends up costing more round trips than
      // it saves dispatches (DRAGON.EXE: 1493 handbacks against the
      // interpreter's 301). The region knows its own exit addresses, so it
      // supplies them.
      for (const ip of (opts.regionSucc && opts.regionSucc.get(regionKey)) || []) pending.push(ip);
      // ...and the bytes have to be marked as COMPILED, which is a separate
      // thing from having been checked. `covered` is what the host turns into
      // isa.CODE_BITMAP, and that bitmap is the entire self-modify detector:
      // $wr8 sets $smc only for a store into a byte somebody has compiled.
      // Substituting a region skips the decode that would have recorded these
      // ranges, so without this the region's own code is invisible to that
      // check -- a program that patches an instruction inside the region gets
      // no break, no invalidation, and the stale compiled body keeps running
      // over code that no longer exists. The install-time guard cannot cover
      // it: it is checked once, when the region is put in, and says nothing
      // about a write that happens afterwards. That is ACCIDENT.EXE, which
      // reports one self-modify break in the baseline and none with the region.
      // `regionCodeBits: false` (region-jit's --no-region-code-bits) turns it
      // off, so the two can be compared on one program.
      if (opts.regionCodeBits !== false) {
        for (const g of guard || []) covered.push([g.lin, g.lin + g.bytes.length]);
      }
      continue;
    }

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
    // The block head extendThrough() just opened inside this very block. The
    // "we already emitted this one, jump to it" test below has to skip it, or
    // the trace's first act would be to jump to itself.
    let justOpened = -1;
    for (;;) {
      if (words.length > maxWords) { words.push(H.end, cur); break; }

      // Reaching the head of a block we already emitted: jump to it rather than
      // emitting a second copy of an entire loop body.
      if (cur !== blockIp && cur !== justOpened && blocks.has(cur)) {
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
          if (wd.exports.dc_stopped() === 1) {        // STOP.ENDED
            // Whatever ended it, the same question applies: was that a
            // conditional we can carry on behind? The swap reads the emitted
            // words, so it does not care which decoder produced them.
            const nx = extendThrough(blockStart, wrote || bulkWrote);
            if (nx < 0) break;
            justOpened = nx; cur = nx; continue;
          }
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
      if (d.endsBlock) {
        const nx = extendThrough(blockStart, wrote || bulkWrote);
        if (nx < 0) break;
        justOpened = nx; cur = nx; continue;
      }
      // opts.oneInsn is the trap flag's compiler: with TF set the CPU owes the
      // guest an INT 1 after EVERY instruction, so the block has to be exactly
      // one long. A branch already ended it above and wrote $gip itself; this
      // is the straight-line case, where `end` carries the next address out.
      if (opts.oneInsn) { words.push(H.end, cur); break; }
    }
    if (fuse) fuseTail(blockStart);
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

  // Spin loops. A block that is ONE branch back to its own head runs forever
  // inside the slice: the branch changes nothing but the flags it just read,
  // and nothing else runs until the block boundary hands back. So swap the
  // branch for the twin that charges the steps and hands back immediately --
  // see jccSpinArm() in emit.js for why that is the same run, not a shorter one.
  //
  // "One branch" is the whole eligibility test, and it has to be. A second op
  // in front of the branch could store, could read a port, could move a
  // register the compare depends on -- and then the loop is a loop that ends.
  // Fusion is what makes the test worth having anyway: `cmp [si],al / jz $` is
  // two instructions and one fused op, which is exactly the shape the pair
  // census finds spinning.
  let spinBlocks = 0;
  if (spinLoops) {
    for (let b = 0; b < blockStarts.length; b++) {
      const start = blockStarts[b];
      const end = b + 1 < blockStarts.length ? blockStarts[b + 1] : words.length;
      if (start + 1 + ARITY[words[start]] !== end) continue;
      const s = SPIN.get(words[start]);
      if (s === undefined) continue;
      if (words[start + 1 + s.takenAt] !== blockIps[b]) continue;
      if (ARITY[s.twin] !== ARITY[words[start]]) {
        throw new Error(`spin twin of handler ${words[start]} has a different arity`);
      }
      words[start] = s.twin;
      spinBlocks++;
    }
  }

  // Flag liveness over the finished region. Per block this is the same
  // backward walk as before; what is new is where it starts from.
  //
  // A block used to be walked with the flags LIVE at its end, because the next
  // block might read them. It might -- but this compile emitted the next block
  // too, so it can look. `liveOut` is the OR of the successors' `liveIn`, and
  // the successors are exactly the control edges the block recorded as fixups:
  // one for a `jmp`, two for a conditional, none at all for a `ret`, an
  // indirect jump or a handback, which are the cases that stay conservative.
  //
  // Successor edges never leave the region: a fixup whose target this compile
  // did not emit resolves to 0, which the branch handlers read as "hand back".
  // That is also what makes the analysis survive self-modifying code -- the
  // host drops a compiled region whole (dos-loop.js invalidateRange), so a
  // guest that rewrites the successor throws away the predecessor that was
  // compiled against it.
  //
  // Least fixpoint from "nothing is live": liveness is a may-read property, so
  // starting at false and growing is the correct direction and terminates.
  if (deadFlags && blockStarts.length) {
    const nb = blockStarts.length;
    const ipIndex = new Map();
    for (let b = 0; b < nb; b++) ipIndex.set(blockIps[b], b);
    const ends = blockStarts.map((s, b) => (b + 1 < nb ? blockStarts[b + 1] : words.length));
    const opsAt = blockStarts.map((s, b) => opsOf(s, ends[b]));

    // Successors, from the fixups that fall inside each block's words.
    const succ = blockStarts.map(() => []);
    const known = blockStarts.map(() => false);
    if (crossFlags) {
      const owner = new Int32Array(words.length).fill(-1);
      for (let b = 0; b < nb; b++) for (let i = blockStarts[b]; i < ends[b]; i++) owner[i] = b;
      for (const f of fixups) {
        const b = owner[f.wordIndex];
        if (b < 0) continue;
        const t = ipIndex.get(f.ip);
        // An unresolved edge leaves the region; the guest resumes somewhere
        // this compile knows nothing about.
        if (t === undefined) { succ[b] = null; continue; }
        if (succ[b]) succ[b].push(t);
      }
      // The not-taken edge of a traced conditional. It is the one control edge
      // with no fixup -- it is "the next word" -- so it has to be added by
      // hand or the walk would think the block had only its taken successor.
      for (const b of fallEdge) if (succ[b] && b + 1 < nb) succ[b].push(b + 1);
      for (let b = 0; b < nb; b++) known[b] = !!(succ[b] && succ[b].length);
    }

    const liveIn = new Array(nb).fill(false);
    const liveOut = new Array(nb).fill(true);
    for (let pass = 0; pass < nb + 2; pass++) {
      let changed = false;
      for (let b = 0; b < nb; b++) {
        let out = true;
        if (known[b]) {
          out = false;
          for (const s of succ[b]) if (liveIn[s]) { out = true; break; }
        }
        liveOut[b] = out;
        const at = opsAt[b];
        const v = at ? walkBlock(at, out, known[b], false) : true;
        if (v !== liveIn[b]) { liveIn[b] = v; changed = true; }
      }
      if (!changed) break;
    }
    // Rewrite once the answers have settled. Substituting can only make a
    // block read less, so a predecessor that used the pre-rewrite answer was
    // being conservative, never wrong.
    for (let b = 0; b < nb; b++) {
      if (opsAt[b]) walkBlock(opsAt[b], liveOut[b], known[b], true);
    }
  }

  // Register specialization, LAST -- after fusion, tracing, spin collapse and
  // the flag pass, because each of those swaps a handler and this pins the one
  // that ends up there. Nothing looks a handler up after this point.
  //
  // The swap is the value the handler was going to compute anyway: read the
  // arena word the register index comes out of, run the same extraction the
  // body ran, and store the twin that has that register as a literal. Arity is
  // unchanged and the operand stays in the arena (the twin still steps over
  // it), so the arena, the dispatch sequence and $steps are all identical.
  let specOps = 0;
  if (regSpec) {
    for (let b = 0; b < blockStarts.length; b++) {
      const end = b + 1 < blockStarts.length ? blockStarts[b + 1] : words.length;
      const at = opsOf(blockStarts[b], end);
      if (!at) continue;                     // arity and arena disagree: touch nothing
      for (const p of at) {
        const s = SPEC.get(words[p]);
        if (s === undefined) continue;
        const reg = applyExtract(s, words[p + 1 + s.operand]);
        if (reg < 0 || reg > 7) continue;    // not a register index after all
        words[p] = s.twins[reg];
        specOps++;
      }
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
    tracedBlocks,
    spinBlocks,
    specOps,
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
