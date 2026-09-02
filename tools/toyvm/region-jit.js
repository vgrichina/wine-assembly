#!/usr/bin/env node

'use strict';

// Compile one hot loop into a wasm function, install it, and run the whole
// demo with it.
//
//   node tools/toyvm/region-jit.js /tmp/demos/1994-d-dragon/DRAGON.EXE
//   node tools/toyvm/region-jit.js <exe> --dispatches=12m --reps=3 --verbose
//
// WHAT THIS IS, AND WHAT trace-jit.js IS NOT. trace-jit.js prices the tiers on
// a memory SNAPSHOT: it lifts one block into a standalone module, seeds the
// registers as they were, and times `spin(N)`. Nothing it reports has ever run
// inside a program. So its 3.2x is an upper bound on a fragment, and the two
// costs a real JIT pays -- leaving the region, and being wrong -- are both
// outside the measurement by construction.
//
// This runs the actual demo twice: once as shipped, once with the hot loop
// replaced by a compiled region, and compares the frame, the dispatch count and
// the wall clock. A frame that differs is a bug in the region, not a result.
//
// HOW A REGION IS INSTALLED. It is one more entry at the END of the handler
// table (emit.js `opts.regions`), and the compiler writes its index as the
// whole body of the block at that guest ip (compile.js `opts.regionAt`). So the
// arena still holds threaded code, the region is still reached by an ordinary
// dispatch, and everything downstream -- self-modify invalidation, the shadow
// stack, slice accounting -- keeps working without knowing it exists.
//
// KEYED BY GUEST IP, NEVER BY ARENA ADDRESS. The region is built from a
// profiling run and installed in a second run whose arena layout is different:
// blocks are laid out in decode order, and a self-modifying program recycles
// the whole arena. Every constant baked into the region body is therefore a
// GUEST ip, and the exit tests read `$gip`.
//
// WHAT THE BODY LOOKS LIKE. The ops are lowered by trace-jit.js's tier-3
// pipeline (operands folded, `$ea` folded to arithmetic, register file folded
// to globals and then promoted into wasm locals for the length of the loop),
// and this file supplies the control flow the pipeline cannot: a `loop` around
// the body, a `$steps` charge that keeps slice accounting exact, and an exit
// test after every op that can transfer.
//
//   pro                                   ;; registers -> locals
//   (block $out (loop $again
//     ...op bodies...
//     (global.set $steps ...)             ;; charged before each branch op,
//     ...branch body...                   ;;   which is where it is READ
//     (br_if $out (i32.ne (global.get $gip) (i32.const <fall-through ip>)))
//     ...
//     (br_if $again (i32.eq (global.get $gip) (i32.const <head ip>)))))
//   epi                                   ;; locals -> registers
//
// The exit test is deliberately blind to WHY a branch left: taken edge, an
// uncompiled fall-through, a slice that expired, a self-modify break. Anything
// that is not "we are back at the loop head" leaves the region with `$gip` and
// `$ip` already published by the handler body itself, so the interpreter picks
// up exactly where it would have.
//
// DEAD-FLAG ELIMINATION IS OFF IN HERE, and that is not a tuning choice.
// killDeadFlags assumes the flags are dead at the end of the trace, which is
// true of a straight line and false of a loop: the back edge feeds them
// straight back into the top. Turning it on without a fixpoint over the region
// would produce a region that is right for one iteration.

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { runDos } = require('./run-dos');
const { makeVm } = require('./vm');
const { findHotTrace, readTrace, emitTier3, benchTiers, memHash } = require('./trace-jit');
const { HANDLERS, TAKEN_AT, prepareTables, sexpAt } = require('./emit');
const isa = require('./isa');

function arg(name, d) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? d : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

// --- picking the loop -------------------------------------------------------

// A region candidate: the hottest sampled block whose own trace ends by
// branching back to its own head. That is the shape tier 3 can already lower
// end to end -- a straight line of ops plus a back edge -- and it is the one
// the exit-count census said is worth building for
// (docs/toyvm-trace-jit.md, "Loop regions").
//
// `call` and `int` disqualify a candidate here. Not because they could not be
// handled -- a call publishes $gip like anything else and would simply exit the
// region -- but because exiting on every call makes the region worth nothing,
// and inlining them is the next stage, not this one.
// Walk the loop from a candidate head, one block at a time, until the walk
// comes back to the head. A demo's inner loop is very often TWO blocks that
// jump to each other -- CYCLE.EXE's is 0x455c <-> 0x45b4 -- and a rule that
// only accepted a single self-looping block found nothing in most of the corpus
// while reporting "no self-loop region found", which reads as "this program has
// no hot loop" and is not what it means.
//
// Every block's terminator becomes an ordinary edge test in the body: the walk
// records, per op, the guest ip control must be at for the region to keep
// going. Whether that ip is the branch's taken edge or its fall-through does
// not matter here and is not asked -- anything else exits.
// THE WALK FOLLOWS EITHER EDGE, AND BACKTRACKS. It used to follow only the
// TAKEN one, and that single line was the corpus's biggest coverage limit: a
// loop whose body bails out on a condition -- which is nearly all of them --
// got walked down the BAIL-OUT, where it immediately met a `ret`, a `retf`, or
// a block that "ends bad-handler, not jmp", and the candidate was thrown away
// while the loop closed on the fall-through nobody tried. Measured with
// tools/toyvm/region-why.js over the 87 programs that got no region at all:
// `ret with no inlined call to return to` blocked 45 of them, `ends
// bad-handler, not jmp` 25, `ends call_far` 14, `ends retf` 9 -- all of them
// symptoms of having walked into code the loop never enters.
//
// Following the fall-through is sound for exactly the reason following the
// taken edge is: `nexts[i]` records the guest ip control MUST be at for the
// region to keep going, the emitted test exits on anything else, and it does
// not care which edge produced that ip. `fallArena`/`fallThroughIp` already
// name the fall-through's arena address and guest ip.
//
// A dead end is now a dead end for that PATH rather than for the candidate, so
// every rule below returns to the search instead of failing it. `--no-backtrack`
// restores the old single-path walk for the A/B.
function chainFrom(head, headByAddr, traceAt, maxOps, why, maxDepth = 3, maxVisits = 3000) {
  const ops = [], nexts = [], spans = [], heads = [];
  const seen = new Set();
  let visits = 0;
  // The reason the LAST path died, reported only if the whole search does. One
  // line per candidate, as before -- a backtracking search rejects many paths
  // and printing each would bury the histogram region-why.js builds.
  // ...and it is the reason from the path that came CLOSEST TO CLOSING, not the
  // one that happened to be tried last. Once the walk backtracks, "last" is an
  // artifact of edge ordering: a two-op stub tried after a forty-op path that
  // nearly made it names the stub, and the corpus histogram then counts a rule
  // that was never the obstacle. Ops accumulated at the moment of failure is
  // the proxy for how far the path got.
  let lastWhy = null, lastDepth = -1;
  const no = (s) => {
    if (ops.length > lastDepth) { lastDepth = ops.length; lastWhy = s; }
    return null;
  };

  // `retStack` is the inlined call frames still open, innermost last. Only the
  // return ADDRESS is tracked -- the guest's own frame is built and torn down
  // by the ops. It is copied on the call edge rather than mutated, so a
  // backtrack out of a callee cannot leave a frame behind.
  const walk = (cur, retStack) => {
    if (++visits > maxVisits) return no(`search gave up after ${maxVisits} blocks`);
    // A block may legitimately appear twice once calls are inlined (one helper
    // called from two places in the loop), so the revisit test is on the block
    // AND the call depth, not the block alone.
    const key = `${cur}@${retStack.length}`;
    // A revisit is a cycle, and a cycle is a loop -- just not the one being
    // walked. The trace is linear, so it cannot go around an inner loop and
    // still close on the outer head; the path dies here. Offering that block as
    // its own candidate root was tried and removed; see the negative result in
    // docs/toyvm-trace-jit.md.
    if (seen.has(key)) return no(`walk revisited 0x${cur.toString(16)}`);
    const blk = headByAddr.get(cur);
    if (!blk) return no(`0x${cur.toString(16)} is not a block head`);
    const t = traceAt(blk);
    // `int` still ends the walk: it hands the machine to the host by design and
    // there is nothing to inline.
    const bad = t.ops.find(o => /^(int|into)/.test(o.name));
    if (bad) return no(`0x${cur.toString(16)} contains ${bad.name}`);
    // See fallArena: cut the block at the first branch whose fall-through lives
    // somewhere other than the words behind it. Everything past that point is
    // another block's code that readTrace ran into.
    let cut = t.ops.length;
    for (let i = 0; i < t.ops.length - 1; i++) {
      const fa = fallArena(t.ops[i]);
      if (fa === null) continue;
      if (fa !== blk.prog.arenaBase + (t.ops[i + 1].at << 2)) { cut = i + 1; break; }
    }
    const tops = t.ops.slice(0, cut);
    const truncated = cut < t.ops.length;
    const endWord = truncated ? t.ops[cut].at : t.nextWord;

    const mark = { ops: ops.length, spans: spans.length, heads: heads.length };
    const undo = () => {
      ops.length = mark.ops; nexts.length = mark.ops;
      spans.length = mark.spans; heads.length = mark.heads;
      seen.delete(key);
    };
    seen.add(key);
    heads.push(blk);
    for (const op of tops) { ops.push(op); nexts.push(fallThroughIp(op)); }
    spans.push([cur, cur + ((endWord - ((cur - blk.prog.arenaBase) >> 2)) << 2)]);
    const last = tops[tops.length - 1];
    // Follow one edge: rewrite the terminator's required-gip, recurse, and undo
    // everything this block added if the path behind it dies.
    const follow = (arena, ip, stack) => {
      if (ops.length > maxOps) return no(`over ${maxOps} ops without closing`);
      if (arena === head && !stack.length) return { ops, nexts, spans, heads, headIp: ip };
      if (!headByAddr.has(arena)) return no(`edge to 0x${(arena >>> 0).toString(16)} is not a block head`);
      nexts[nexts.length - 1] = ip;
      return walk(arena, stack);
    };

    // A DIRECT CALL IS AN EDGE LIKE ANY OTHER, and inlining it is the whole
    // reason to bother: the exit census found that call-free hot regions cover
    // 64-100% of their program while the call-bearing ones are where the rest of
    // the corpus lives, and a region's whole-program win is capped by its share
    // (Amdahl). CYCLE's region body is 1.63x on its own and buys 0% end to end
    // at a 17.6% share; nothing about the body will fix that, only covering more
    // of the program will.
    //
    // Nothing about the call is elided. `call_rel` still pushes the return
    // address and still records it on the shadow stack, and the matching `ret`
    // still pops both -- so the guest stack is byte-identical to the
    // interpreter's at every point, and a callee that reads its own return
    // address, or rearranges the stack, or never returns, is not a special
    // case. What inlining removes is the two block transfers, not the frame.
    // Operands are [arenaTarget][guestTarget][retIp][arenaRet].
    if (/^call_rel(32)?$/.test(last.name)) {
      if (retStack.length >= maxDepth) { undo(); return no(`calls nested deeper than ${maxDepth}`); }
      const r = follow(last.args[0], last.args[1],
        [...retStack, { ip: last.args[2], arena: last.args[3] }]);
      if (!r) undo();
      return r;
    }
    // ...and the matching return is the same edge run backwards. `ret` reads
    // its target off the guest stack, so unlike a branch it has no operand to
    // read it from -- the walk supplies it, and the exit test that follows is
    // exactly the guard that makes that safe: a callee that returned somewhere
    // else leaves the region instead of being believed.
    if (/^ret(32)?$/.test(last.name)) {
      if (!retStack.length) { undo(); return no(`${last.name} with no inlined call to return to`); }
      const stack = retStack.slice();
      const frame = stack.pop();
      const r = follow(frame.arena, frame.ip, stack);
      if (!r) undo();
      return r;
    }
    // A truncated block ends at the branch the cut found, which IS a
    // terminator; `t.end` describes the op readTrace ran on to and no longer
    // applies.
    if (!truncated && t.end !== 'jmp') { undo(); return no(`0x${cur.toString(16)} ends ${t.end}, not jmp`); }
    const at = TAKEN_AT.get(last.fn);
    if (at === undefined) { undo(); return no(`terminator ${last.name} has no edge tail`); }
    // The terminator's arena target sits one slot in front of its guest ip.
    // Taken first, then the fall-through -- the taken edge is the back edge of
    // a `loop` or a bottom-tested loop, so trying it first keeps the common
    // case at its old cost.
    const edges = [[last.args[at - 1], last.args[at]]];
    const fa = fallArena(last), fi = fallThroughIp(last);
    if (!flag('no-backtrack') && fa !== null && fi !== null && fa !== last.args[at - 1]) {
      edges.push([fa, fi]);
    }
    for (const [arena, ip] of edges) {
      const r = follow(arena, ip, retStack);
      if (r) return r;
    }
    undo();
    return null;
  };

  const r = walk(head, []);
  // The depth is printed because it is what makes the corpus histogram
  // meaningful: a program rejects many candidates, and a census that unions
  // their rules reports "a rule this program met", not "the rule blocking this
  // program". tools/toyvm/region-why.js keeps the deepest line per program.
  if (!r && lastWhy) why(`0x${head.toString(16)}: ${lastWhy} [depth ${Math.max(lastDepth, 0)}]`);
  return r;
}

function pickRegion(rr, ranked, minOps, maxOps = 400) {
  // The hottest BLOCK is usually not the loop's head. A traced conditional
  // stitches its fall-through in behind it, so the profiler's samples pile up
  // on whichever sub-block the ip happened to be in -- DRAGON's 64.6% lands on
  // a two-op tail whose `jmp` goes BACK to the real head, twenty ops earlier.
  // So follow the back edge to the head and judge the loop there.
  const headByAddr = new Map();
  // The key of `regions` is the code segment, and it has to be carried: a
  // region is installed at cs:ip, never at a bare offset.
  for (const [cs, progs] of rr.regions) {
    // `ip` rides along because the guard needs it: the region is only valid
    // over the guest bytes it was compiled from, and those are found through
    // each block's own guest ip, not through its arena address.
    for (const p of progs) for (const [ip, addr] of p.blocks) headByAddr.set(addr, { addr, ip, prog: p, cs });
  }
  const traceAt = (blk) => readTrace(blk.prog.words, (blk.addr - blk.prog.arenaBase) >> 2);
  // Every candidate head that was rejected, and by which rule. `--why` prints
  // it: "no self-loop region found" on its own says nothing about whether the
  // shape is absent or the walk never reached it.
  const why = (s) => { if (flag('why')) console.log(`  reject ${s}`); };

  const tried = new Set();
  for (const b of ranked) {
    const t = traceAt(b);
    // Candidate heads: this block itself, plus anything at or before it that a
    // branch in it targets. Operand-holds-a-known-block-head is the structural
    // test for a branch target; a name test misses every fused pair.
    const cands = [b.addr];
    for (const op of t.ops) {
      // No `a < b.addr` filter: the arena is laid out in DECODE order, so a
      // loop's head can sit at a HIGHER arena address than its back edge.
      for (const a of op.args) if (headByAddr.has(a)) cands.push(a);
    }
    // NOT tried: the call sites that reach this block, and the blocks the walk
    // discovers a cycle on. Both were built and measured -- see the negative
    // result in docs/toyvm-trace-jit.md -- and both are removed.
    for (const h of cands) {
      if (tried.has(h)) continue;
      tried.add(h);
      const blk = headByAddr.get(h);
      if (!blk) { why(`0x${h.toString(16)}: not a block head`); continue; }
      // `--head=0xIP` pins the region to one guest ip. The pick is otherwise a
      // function of the profiling BUDGET, so sweeping the budget to find where
      // a region first goes wrong silently changes which region is being
      // measured -- which is how ACCIDENT's 34-op region looked benign at 2.2M
      // and catastrophic at 12M when the two runs had picked different loops.
      if (arg('head') !== undefined && blk.ip !== Number(arg('head'))) continue;
      // `cands` is appended to during this loop -- a for..of over an array sees
      // pushes, and `tried` keeps it from cycling. Both extra roots are strictly
      // fallbacks, appended only after their own candidate has already failed.
      const chain = chainFrom(h, headByAddr, traceAt, maxOps, why);
      if (!chain) continue;
      if (chain.ops.length < minOps) {
        why(`0x${h.toString(16)}: ${chain.ops.length} ops < ${minOps}`);
        continue;
      }
      // The region's share is every sample inside the GUEST bytes it was
      // compiled from, in its code segment -- not the arena extents of the
      // blocks the walk happened to go through. A region is installed by guest
      // ip and so absorbs every arena copy of that code, and the interpreter
      // routinely holds more than one: COMPOVRS's loop is one straight line
      // from 0x338 in the region, but the interpreter enters it at 0x338 AND
      // at 0x353 (a jump target inside it), and 0x353 is its own block with
      // its own arena words. The samples pile up in THAT block, the arena-span
      // test never saw them, and the census reported the region at 0.0% share
      // while it removed 184 handbacks and ran +71%. And a head test is not
      // enough either: the profiler charges a sample to its block's HEAD, and
      // the block holding COMPOVRS's samples is the one traced from 0x329 --
      // an entry fifteen bytes above the loop head that runs straight through
      // the loop body -- so its head is outside the region while nearly every
      // word in it is inside. The test is therefore whether the sampled
      // block's guest EXTENT overlaps the region's, which over-credits the few
      // words of such a block that precede the head and is the right side to
      // err on: those words are a run-in the region absorbs on entry. The
      // arena test stays as a fallback for a block whose guest ips the trace
      // cannot publish.
      const glo = Math.min(...chain.heads.map(b => b.ip));
      const ghi = Math.max(glo + 1, ...chain.nexts.filter(ip => ip !== null && ip !== undefined));
      // Only a branch publishes a guest ip, so a block's extent is known
      // through its branches alone: the fall-through ips give how far it
      // reaches, and the TAKEN ips say where it goes. COMPOVRS's sampled
      // block is fifteen bytes of run-in ending in `jmp 0x338` -- no
      // fall-through anywhere, so its extent reads as one byte -- and the
      // jump into the region is the whole of the evidence that it lives there.
      const guestExtent = (x) => {
        const t = traceAt(x);
        let hi = x.bip + 1;
        const targets = [];
        for (let i = 0; i < t.ops.length; i++) {
          const op = t.ops[i];
          const at = TAKEN_AT.get(op.fn);
          if (at !== undefined && op.args[at] !== undefined) targets.push(op.args[at]);
          const ip = fallThroughIp(op);
          if (ip !== null && ip !== undefined && ip > hi) hi = ip;
          // Same cut as chainFrom: past a branch whose fall-through is not the
          // next word, readTrace is reading some other block's code.
          const fa = i < t.ops.length - 1 ? fallArena(op) : null;
          if (fa !== null && fa !== x.prog.arenaBase + (t.ops[i + 1].at << 2)) break;
        }
        return [x.bip, hi, targets];
      };
      // Per region block, not one hull from `glo` to `ghi`: a chain's farthest
      // fall-through can be a call's return point or an exit a long way off
      // (B-STEEL's 13-op region hulled to 0x8c-0x5a1 and credited 96% of the
      // program), and a hull that wide overlaps everything.
      const ranges = chain.heads.map(b => guestExtent({ ...b, bip: b.ip }));
      const inRegion = (ip) => ranges.some(([lo, hi]) => ip >= lo && ip < hi);
      const samples = ranked.filter(x => {
        if (chain.spans.some(([a, e]) => x.addr >= a && x.addr < e)) return true;
        if (x.cs !== blk.cs) return false;
        const [lo, hi, targets] = guestExtent(x);
        return ranges.some(([rlo, rhi]) => lo < rhi && hi > rlo) || targets.some(inRegion);
      }).reduce((n, x) => n + x.samples, 0);
      why(`share: region guest ${blk.cs.toString(16)}:${glo.toString(16)}-${ghi.toString(16)}; `
        + `top sampled blocks ${ranked.slice(0, 6).map(x => {
          const [lo, hi] = guestExtent(x);
          return `${x.cs.toString(16)}:${lo.toString(16)}-${hi.toString(16)} x${x.samples}`;
        }).join(', ')}`);
      return { block: blk, cs: blk.cs, ops: chain.ops, nexts: chain.nexts,
        blocks: chain.spans.length, heads: chain.heads, headIp: chain.headIp, samples };
    }
  }
  return null;
}

// --- building the body ------------------------------------------------------

// Where control is after each op, expressed as a guest ip, for every op that
// can publish one. A branch's operand tail is
// `arenaTaken guestTaken [arenaFall] guestFall` -- four words for a plain
// conditional, three for a traced twin whose fall-through is stitched in behind
// it -- so the fall-through guest ip is the LAST operand either way.
function fallThroughIp(op) {
  const at = TAKEN_AT.get(op.fn);
  if (at === undefined) return null;
  const tail = op.args.length - (at - 1);
  if (tail !== 3 && tail !== 4) return null;
  return op.args[op.args.length - 1];
}

// WHERE A BRANCH'S FALL-THROUGH ACTUALLY LIVES, as an ARENA address, or null
// when the operand tail does not name one.
//
// This is the difference between a block that ends at a branch and one that
// carries its fall-through inline, and it is not a question a name test can
// answer. `readTrace` stops on a handler whose NAME starts with jmp/jcc/call/
// ret/int, and `loop`, `loop32` and every fused pair -- `dec_r8_jnz`, the
// traced twins -- match none of those. So a "block" it hands back can run
// straight past its own terminator and keep reading whatever arena words
// happen to sit behind it, which are the NEXT BLOCK THE COMPILER DECODED and
// not the branch's fall-through at all.
//
// Nothing noticed, because the region left at the unlowered branch and never
// executed the tail. Lowering runs it inline, which is why lowering "broke"
// eleven of the fifteen wrong frames in the corpus census while every
// optimization switch was individually exonerated: the ops after the branch
// were the wrong ops all along.
//
// A three-word tail is stitched-in by construction and needs no check. A
// four-word tail names its fall-through block explicitly, so the words behind
// the branch are its fall-through only if they start exactly there.
function fallArena(op) {
  const at = TAKEN_AT.get(op.fn);
  if (at === undefined) return null;
  if (op.args.length - (at - 1) !== 4) return null;
  return op.args[at + 1];
}

// Both guest edges of every branch in the region: the taken ip and, when the
// operand tail carries one, the fall-through ip.
// Anything that can publish a new $gip, which after call inlining is more than
// TAKEN_AT knows about: `ret` reads its target off the guest stack and so has no
// operand tail at all, and `call_rel` has one in a different shape.
// EVERY ARENA ADDRESS IN AN OP'S OPERANDS IS A LIE ONCE THE REGION IS
// INSTALLED. The operands come from the profiling run, where the compiler had
// laid the successor blocks out at particular arena addresses; the run that
// executes the region compiles its own blocks in its own order, and the same
// number now names unrelated code. The rule is old -- nothing baked into a
// region may be an arena address, only a guest ip -- and the branch lowering
// already honours it. Two places did not.
//
// `$rpush(ret_guest, ret_arena)` is the one that cost a corpus program. A
// `call` inside a region pushed the PROFILING run's arena address for its
// return point onto the shadow return stack; the callee's `ret` then popped it,
// matched on the (correct) guest ip, and set $ip to code that had nothing to do
// with the return site. CMA_SHRT goes blank on exactly this. $rpush treats a
// zero arena as "no entry" and returns early, so zeroing the operand degrades
// the return to a block-cache resolve -- one handback per return out of a
// region, which is the correct answer at the right price.
//
// `GO(target_arena, target_guest)` is the same thing for the call's own
// transfer. It is usually dead (the callee's block follows in the region, so
// splitJump replaces the transfer with a fall-through), but "usually" is not a
// property to rely on: CONT(0) is 0, so a zeroed arena hands back and the host
// resolves the guest ip.
//
// The slots are derived from the handler body rather than listed here, because
// a list would drift the first time an operand is added: the arena is $rpush's
// second argument and the one CONT selects on, and both are written by emit.js
// in one shape each.
// Both are matched globally: a Jcc body carries a GO per arm, and a call
// carries a GO and an $rpush, so the first match is never the whole story.
// A `$t7` inside CONT is a scratch local rather than an operand (`ret32` reads
// its target off the guest stack) -- the arity check in stripArenaOperands is
// what tells those apart.
const ARENA_IN_RPUSH = /\(call \$rpush \(local\.get \$t\d\) \(local\.get \$t(\d)\)\)/g;
const ARENA_IN_GO = /\(select \(i32\.const 0\) \(local\.get \$t(\d)\)/g;

// ...and only $rpush's. Zeroing GO's arena as well is CORRECT in isolation --
// CONT(0) is 0, so the transfer hands back and the host resolves the guest ip
// it just published -- and it broke DRAGON and ADDY_II, which had been
// frame-identical. The reason is in this file, not in GO: an unlowered transfer
// sits INSIDE the region's loop, so when its CONT fails the body calls
// $slice_exit and then keeps executing the ops after it. While the baked arena
// resolved, that path was rare enough not to show; forcing it on every such
// transfer made the region run code past its own exit. The real fix is to lower
// those transfers (`br $out`) rather than to zero their operand, and until
// then, a stale GO arena is a smaller wrong than a guaranteed one.
function arenaSlots(fn) {
  const out = new Set();
  for (const m of HANDLERS[fn].body.matchAll(ARENA_IN_RPUSH)) out.add(Number(m[1]));
  return out;
}

// A TRANSFER THIS FILE COULD NOT LOWER STILL CARRIES THE PROFILING RUN'S ARENA
// ADDRESS, and that address means nothing in the run the region is installed
// into: blocks are laid out in decode order, and the two runs do not decode in
// the same order. The `(br $out)` after such a transfer re-resolves $ip in the
// epilogue, so the stale constant was thought to be inert -- but it is also
// what the GO's own CONT selects on, so it decides whether the region publishes
// $ip at all, and it is read as an address in the `then` arm. CARRIE.EXE is the
// proof: 7 unlowered transfers, and compiling ONE extra successor block (which
// shifts the layout and nothing else) turns a frame-identical run into a wrong
// one -- non-monotonically, which is what a stale address that sometimes lands
// on a valid block looks like.
//
// So resolve it live instead of zeroing it. Zeroing forces $slice_exit and a
// handback on every such transfer (and broke DRAGON and ADDY_II back when the
// region ran on past its own exit); `$jlook` of the $gip the GO has just
// published is the same answer the epilogue computes, is layout-independent by
// construction, and costs one hash lookup. `--keep-go-arena` is the A/B.
// Both forms of the operand have to be caught: constprop folds an arena operand
// that was only ever read once straight into the two places GO reads it, so
// half of them are `(local.get $tN)` and half are a bare `(i32.const 16904168)`
// -- and matching only the first left CARRIE.EXE exactly as wrong as before.
const ARENA_EXPR = String.raw`(?:\(i32\.const \d+\)|\(local\.get \$t\d\))`;
const GO_RE = new RegExp(
  String.raw`\(if \(select \(i32\.const 0\) ${ARENA_EXPR}`
  + String.raw`(\s*\(i32\.or \(global\.get \$smc\) \(i32\.lt_s \(global\.get \$steps\)`
  + String.raw` \(i32\.const 0\)\)\)\)\s*\(then \(global\.set \$ip )${ARENA_EXPR}`, 'g');

function resolveGoArena(body) {
  if (flag('keep-go-arena')) return body;
  const live = '(call $jlook (global.get $gip))';
  return body.replace(GO_RE, (m, mid) =>
    `(if (select (i32.const 0) ${live}${mid}${live}`);
}

function stripArenaOperands(ops) {
  let stripped = 0;
  const out = ops.map((op) => {
    const slots = arenaSlots(op.fn);
    if (!slots.size) return op;
    const args = op.args.slice();
    for (const s of slots) {
      if (s < args.length && args[s] !== 0) { args[s] = 0; stripped++; }
    }
    return { ...op, args };
  });
  return { ops: out, stripped };
}

// One reading of `--passes=`, shared by the region build and by the snapshot
// bench behind `--agree` and the gate. They have to agree: a gate that judged a
// differently-optimized body than the one about to be installed would be
// answering a question nobody asked.
function passSpec() {
  const spec = arg('passes', 'constprop,regfold,ea,seg,inline').split(',').filter(Boolean);
  const known = ['constprop', 'regfold', 'deadflags', 'ea', 'seg', 'inline'];
  for (const p of spec) {
    if (!known.includes(p)) {
      console.error(`unknown pass ${p}; known: ${known.join(', ')}`);
      process.exit(2);
    }
  }
  return Object.fromEntries(known.map(k => [k, spec.includes(k)]));
}

function isTransfer(op) {
  return TAKEN_AT.has(op.fn) || /^(call_rel(32)?|ret(32)?)$/.test(op.name);
}

// `why` (optional) collects ip -> which op and which role put it in the list.
// A successor that turns out to be a bad address is a decode of code that is
// not code, and the only way to argue about it is to know which branch named it.
function successorIps(ops, why) {
  const out = new Set();
  const note = (ip, op, role) => {
    out.add(ip);
    if (why && !why.has(ip)) why.set(ip, `${op.name}@0x${(op.gip || 0).toString(16)} ${role}`);
  };
  for (const op of ops) {
    // A call names both its callee and its return point.
    if (/^call_rel(32)?$/.test(op.name)) { note(op.args[1], op, 'callee'); note(op.args[2], op, 'return'); continue; }
    const at = TAKEN_AT.get(op.fn);
    if (at === undefined) continue;
    note(op.args[at], op, 'taken');
    const fall = fallThroughIp(op);
    if (fall !== null) note(fall, op, 'fall');
  }
  return [...out];
}

// COMPILING THE BRANCH INSTEAD OF INTERPRETING IT.
//
// A branch handler exists to serve a threaded-code interpreter that does not
// know where it is going: it publishes $gip, resolves the arena address, and
// checks the budget and the self-patch flag, because the dispatcher after it
// has no other way to find out. Inside a region every one of those answers is
// already known at compile time -- and running the handler anyway, then reading
// $gip BACK to decide whether to loop, is what made the first working region a
// null. Counted on daretro's six-op body: 5 $steps loads, 3 $smc loads, 2 $gip
// stores, 2 $ip stores, 2 $gip loads and 2 $halt loads per iteration, to
// re-derive a destination the compiler wrote down.
//
// So the body is cut apart instead. After operand folding a conditional
// branch's body is exactly `<operand sets> (if <cond> (then GO..) (else GO..))`
// with the two destinations sitting in it as literals, which is enough to keep
// the condition, throw both transfer protocols away, and emit a wasm branch.
// Nothing is guessed: the guest ip of each arm is READ OUT of the arm.
//
// The two costs that remain are real and are paid once per iteration rather
// than once per branch: the budget test, and publishing $gip on the way out.
const GIP_SET = /\(global\.set \$gip \(i32\.const (\d+)\)\)/;
// ...and the same thing one hop away. A TRACED TWIN publishes its taken ip out
// of the operand local rather than as a literal -- `(global.set $gip (local.get
// $t1))` with `(local.set $t1 (i32.const 2470))` sitting at the top of the same
// body, because the operand fold runs inside an op body and these sets are
// emitted around it. Declining on that cost CARRIE.EXE seven of its eight
// unlowered transfers and, through the unlowered-transfer gate, its whole
// region. Following the local one step is exact: the definition is in the same
// body, it is a literal, and a reassignment between definition and use is
// checked for rather than assumed away.
const GIP_LOCAL = /\(global\.set \$gip \(local\.get \$(t\d)\)\)/;

function gipOf(arm, body, armAt) {
  const lit = GIP_SET.exec(arm);
  if (lit) return Number(lit[1]);
  const via = GIP_LOCAL.exec(arm);
  if (!via) return null;
  const defs = [...body.slice(0, armAt).matchAll(
    new RegExp(String.raw`\(local\.set \$${via[1]} `, 'g'))];
  if (!defs.length) return null;
  const last = defs[defs.length - 1].index;
  const def = new RegExp(String.raw`^\(local\.set \$${via[1]} \(i32\.const (\d+)\)\)`)
    .exec(body.slice(last));
  if (!def) return null;
  // No second definition between that one and the arm, and none inside the arm
  // before the publish -- either would make the literal the wrong value.
  if (new RegExp(String.raw`\(local\.set \$${via[1]} `).test(
    body.slice(last + def[0].length, armAt) + arm.slice(0, via.index))) return null;
  return Number(def[1]);
}

// A body is only cut where both halves stand on their own. An ALU handler can
// have an `(if` of its own long before the transfer -- cutting at the FIRST one
// kept a prefix with unclosed parens and the module failed to assemble at
// nesting depth 4, which is at least loud. This is the check that makes the
// surgery safe rather than lucky.
function balanced(s) {
  let d = 0;
  for (const c of s) {
    if (c === '(') d++;
    else if (c === ')') { d--; if (d < 0) return false; }
  }
  return d === 0;
}

// Why the last split declined, for the histogram. A module-level slot rather
// than a richer return type because every caller already treats null as "not
// lowered" and there is exactly one split in flight at a time.
let lastSplitWhy = null;
const no = (why) => { lastSplitWhy = why; return null; };

function splitBranch(body) {
  // The LAST TOP-LEVEL `(if`: the transfer is the tail of the body, and
  // anything earlier belongs to the operation itself. Depth matters and a plain
  // lastIndexOf gets it wrong in both directions -- an ALU body has its own
  // `(if` before the transfer, and the transfer's own arms each contain one
  // (the `CONT` resolve). Taking the textually last one lands INSIDE the else
  // arm, the balance check then rejects it, and the whole branch falls back to
  // the interpreter protocol with a profiling-run arena address baked into it.
  // That is ACCIDENT.EXE's `loop`, and it is why a partially lowered region is
  // worse than either a fully lowered one or none.
  let at = -1;
  for (let d = 0, i = 0; i < body.length; i++) {
    if (d === 0 && body.startsWith('(if ', i)) at = i;
    if (body[i] === '(') d++;
    else if (body[i] === ')') d--;
  }
  // Every `return null` below records WHY first. A decline is not a curiosity
  // here -- a region with one unlowered transfer is declined outright, so this
  // histogram is the whole work list for widening the lowerer.
  if (at < 0) return no('no top-level (if');
  if (!balanced(body.slice(0, at))) return no('prefix unbalanced');
  if (!balanced(body.slice(at))) return no('transfer unbalanced');
  let j = at + 4;
  while (j < body.length && /\s/.test(body[j])) j++;
  const cond = sexpAt(body, j);
  if (cond === null) return no('condition not an s-expr');
  let k = j + cond.length;
  while (k < body.length && /\s/.test(body[k])) k++;
  const thenArm = body[k] === '(' ? sexpAt(body, k) : null;
  if (thenArm === null) return no('no then arm');
  let m = k + thenArm.length;
  while (m < body.length && /\s/.test(body[m])) m++;
  const elseArm = body[m] === '(' ? sexpAt(body, m) : null;
  if (elseArm === null) return no('no else arm');
  const thenIp = gipOf(thenArm, body, k);
  const elseIp = gipOf(elseArm, body, m);
  if (thenIp === null || elseIp === null) {
    return no(thenIp === null && elseIp === null ? 'neither arm publishes a resolvable $gip'
      : `${thenIp === null ? 'then' : 'else'} arm publishes no resolvable $gip`);
  }
  return { pre: body.slice(0, at), cond, thenIp, elseIp };
}

// The same surgery on an unconditional transfer, which is the shape a `jmp`
// back to the loop head has. Its body is `<operands> (global.set $gip <lit>)
// (if <resolve> ...)`: everything from the $gip set onwards is the protocol,
// and everything before it is work the guest asked for -- which is why a
// `call_rel`, whose push and shadow-stack record come first, survives this cut
// with its frame intact.
function splitJump(body) {
  const m = GIP_SET.exec(body);
  if (!m) return no('jump: no literal $gip');
  if (/\(global\.set \$gip /.test(body.slice(m.index + m[0].length))) return no('jump: a second $gip set follows');
  if (!balanced(body.slice(0, m.index)) || !balanced(body.slice(m.index))) return no('jump: unbalanced at the cut');
  return { pre: body.slice(0, m.index), ip: Number(m[1]) };
}

// THE TRANSFER WHOSE DESTINATION IS NOT KNOWN AT COMPILE TIME -- a `ret`, which
// takes its target off the guest stack. Nothing can turn that into a `br` to a
// known label, but it does not have to stay on the interpreter's protocol
// either: the only thing the trailing GO does is resolve $ip from an arena
// address, and the region's epilogue re-resolves $ip from $gip on the way out
// anyway. So cut the GO off, keep everything before it (the pop, the shadow
// stack, and the `(global.set $gip <computed>)` itself), and leave. The result
// has no arena constant in it at all, which is the property the install gate
// actually wants -- "lowered" here means layout-independent, not "became a br".
function splitExit(body) {
  let at = -1;
  for (let d = 0, i = 0; i < body.length; i++) {
    if (d === 0 && body.startsWith('(if (select (i32.const 0) ', i)) at = i;
    if (body[i] === '(') d++;
    else if (body[i] === ')') d--;
  }
  if (at < 0) return no('exit: no trailing GO');
  if (!balanced(body.slice(0, at)) || !balanced(body.slice(at))) return no('exit: unbalanced at the cut');
  const pre = body.slice(0, at);
  if (!/\(global\.set \$gip /.test(pre)) return no('exit: nothing publishes $gip before the GO');
  if (/\(global\.set \$gip /.test(body.slice(at))) return no('exit: the GO publishes $gip too');
  return { pre };
}

function buildRegion(rawOps, nexts, headIp, name) {
  prepareTables();
  // Before anything else, and never optional: the profiling run's arena
  // addresses are not addresses in the run that will execute this region.
  const { ops, stripped } = flag('keep-arena-operands')
    ? { ops: rawOps, stripped: 0 } : stripArenaOperands(rawOps);
  // deadflags off: see the header. constprop and regfold are safe -- neither
  // reasons about what happens after the trace.
  // `--no-promote` keeps the registers in globals. It is a bisector, not a
  // tuning knob: it separates "the region's control flow is wrong" from "a
  // promoted register was read stale", which look identical from the outside.
  // `--passes=` is the other half of that bisector: `--passes=` alone builds the
  // region out of tier-1 bodies (operands folded, nothing else), so a region
  // that is right there and wrong with a pass on names the pass.
  const t3 = emitTier3(ops, { ...passSpec(), promote: !flag('no-promote') });
  const parts = [];
  let pending = 0;            // ops retired since $steps was last charged
  let exits = 0;
  let unlowered = 0;          // transfers left on the interpreter's protocol
  const unloweredWhy = [];    // ...and why each one was left there
  // The back edge, used both mid-body and at the end. `$halt` covers everything
  // that ended the run from inside a handler -- a slice that expired through
  // $slice_exit, a self-modify break, an unimplemented op -- and none of those
  // may be swallowed by looping again. `$steps` is the slice boundary: it is
  // charged inside the body but only ever READ by `$next`, which a region never
  // calls, so without this test the region iterates on with `$steps` deep in the
  // negatives and the host never gets its turn back (measured: 37s in one
  // region, and the machine stopped in the wrong place).
  // May the loop go round again? Everything the interpreter's own block
  // boundary tests, in one place instead of once per branch: budget left, not
  // halted, and no byte of compiled code patched this slice.
  // `--once` never takes the back edge: the region becomes a straight-line
  // replacement for the block, entered and left exactly as the interpreter
  // enters and leaves it. It is a bisector -- it separates "an op body or the
  // stitching is wrong" from "the looping protocol is wrong", which produce the
  // same wrong frame. It is slower than the interpreter by construction.
  const once = flag('once');
  const okToLoop = once ? '(i32.const 0)'
    : `(i32.and (i32.gt_s (global.get $steps) (i32.const 0))`
    + ` (i32.eqz (i32.or (global.get $halt) (global.get $smc))))`;
  const backEdge = once ? ';; --once: no back edge'
    : `(br_if $again (i32.and (i32.and`
    + ` (i32.eq (global.get $gip) (i32.const ${headIp}))`
    + ` (i32.eqz (global.get $halt)))`
    + ` (i32.gt_s (global.get $steps) (i32.const 0))))`;
  for (const [i, op] of ops.entries()) {
    pending++;
    const isLast = i === ops.length - 1;
    const branch = isTransfer(op);
    // $steps is only ever READ by a branch handler (it is what makes a slice
    // end), so charging it just before one is exact rather than approximate:
    // the guest sees the same budget at the same instruction as it would have
    // under the interpreter, and slices end in the same place.
    if (branch) {
      parts.push(`(global.set $steps (i32.sub (global.get $steps) (i32.const ${pending})))`);
      pending = 0;
    }
    // The compiled form: keep the condition, drop both transfer protocols, and
    // let wasm's own control flow carry the edges. `--no-lower` turns it off so
    // the two can be measured against each other on the same region.
    const lowered = (branch && !flag('no-lower')) ? splitBranch(t3.bodies3[i]) : null;
    if (lowered) {
      const cont = isLast ? headIp : nexts[i];
      const act = (ip) => (ip === cont && !isLast ? ''
        : ip === headIp ? `(if ${okToLoop} (then (br $again))`
          + ` (else (global.set $gip (i32.const ${ip})) (br $out)))`
          : `(global.set $gip (i32.const ${ip})) (br $out)`);
      if (lowered.thenIp !== cont && lowered.elseIp !== cont && !isLast) {
        return { declined: `${op.name} continues to ${cont} which is neither of its edges` };
      }
      parts.push(lowered.pre);
      parts.push(`(if ${lowered.cond}\n  (then ${act(lowered.thenIp)})\n  (else ${act(lowered.elseIp)}))`);
      if (lowered.thenIp !== cont && lowered.elseIp !== cont) exits += 2;
      else exits++;
      continue;
    }
    // splitJump runs second and overwrites the reason, so keep splitBranch's --
    // for a CONDITIONAL transfer that is the interesting one, and "jump: ..."
    // is just the unconditional path declining a two-armed body.
    const branchWhy = lastSplitWhy;
    const jump = (branch && !flag('no-lower')) ? splitJump(t3.bodies3[i]) : null;
    if (jump) {
      const cont = isLast ? headIp : nexts[i];
      if (jump.ip !== cont) return { declined: `${op.name} goes to ${jump.ip}, not ${cont}` };
      parts.push(jump.pre);
      if (jump.ip === headIp) {
        parts.push(`(if ${okToLoop} (then (br $again))`
          + ` (else (global.set $gip (i32.const ${jump.ip})) (br $out)))`);
      }
      continue;
    }
    // Last resort before giving up on this transfer: strip the GO and leave.
    // Only the ops that reach here -- a computed destination, so a `ret` -- and
    // never the last op, whose fall-out is the back edge.
    const exit = (branch && !flag('no-lower')) ? splitExit(t3.bodies3[i]) : null;
    if (exit) {
      parts.push(exit.pre);
      parts.push(`;; ${op.name}: destination is computed, so publish $gip and let the epilogue resolve it`);
      // As the last op its fall-out IS the back edge, which is tested below and
      // reads the $gip this just published -- so a `ret` back to the head still
      // keeps the loop, exactly as the lowered conditionals do.
      if (!isLast) { parts.push('(br $out)'); exits++; }
      continue;
    }
    parts.push(resolveGoArena(t3.bodies3[i]));
    if (branch) { unlowered++; unloweredWhy.push(`${op.name}: ${branchWhy || lastSplitWhy || 'not attempted'}`); }
    if (!branch) continue;
    if (isLast) continue;         // the back edge is tested below
    const fall = nexts[i];
    if (fall === null) return { declined: `op ${op.name} has no readable edge tail` };
    // (A four-word operand tail is NOT a reason to stop here, though it looks
    // like one: it would mean the fall-through lives in its own block rather
    // than stitched in behind the branch. Declining on it rejected every region
    // that had already been measured correct, daretro's 2x included -- so the
    // words following such a branch in the arena are its fall-through after
    // all, and the tail width says something else.)
    // A mid-body branch whose TAKEN edge is the head is a second back edge, not
    // an exit. Testing only the fall-through here is what made the first
    // measurable region twice as slow as the interpreter: daretro's inner loop
    // is a `loop` instruction, so every iteration left the region through the
    // taken edge and paid a fresh dispatch to come back in.
    parts.push(`;; back edge if this branch went to the head (${headIp.toString(16)})`);
    parts.push(backEdge);
    // AFTER A TRANSFER THIS FILE COULD NOT LOWER, LEAVE. The region hands $gip
    // back and the host resolves it like any other block edge, which is sound
    // whatever the transfer did.
    //
    // What it replaces -- `--assume-fallthrough` still selects it -- was a test
    // that carried on inside the region whenever $gip came out equal to the
    // recorded fall-through. That is an OFFSET comparison, and an offset is not
    // an address: a far transfer that lands on the same offset in a different
    // selector passes it, and the region then runs its next block's ops in the
    // wrong segment. CMA_SHRT is a 32-bit protected-mode program that does
    // exactly this, and it is the whole of its divergence -- blank screen under
    // the old rule, frame-IDENTICAL (19432 px, same as the interpreter) under
    // this one. Zeroing the arena operands used to hide the same bug by
    // accident: CONT failed, $slice_exit set $halt, and the test exited.
    //
    // It costs a handback per unlowered transfer where one exists, and nothing
    // at all where none does: DRAGON and ADDY_II report the same dispatch and
    // handback counts either way, because every transfer in their regions is
    // lowered.
    if (!flag('assume-fallthrough')) {
      parts.push(`;; leave after the unlowered ${op.name}; ${fall.toString(16)} resolves outside`);
      parts.push('(br $out)');
      exits++;
      continue;
    }
    parts.push(`;; exit unless this branch fell through to ${fall.toString(16)}`);
    // $halt is part of the test, not just of the back edge: a branch whose
    // slice expired takes the $slice_exit arm and still publishes the
    // fall-through as $gip, so a test on $gip alone would run the rest of the
    // body after the machine had already stopped.
    parts.push('(br_if $out (i32.or (global.get $halt)'
      + ` (i32.ne (global.get $gip) (i32.const ${fall}))))`);
    exits++;
  }
  if (pending) {
    parts.push(`(global.set $steps (i32.sub (global.get $steps) (i32.const ${pending})))`);
  }
  parts.push(backEdge);
  // LEAVING THE REGION, LAYOUT-INDEPENDENTLY. Every op body still ends in the
  // ordinary `GO`, which publishes $gip and then sets $ip to an arena address
  // BAKED IN FROM THE PROFILING RUN. That constant means nothing in the run the
  // region is installed into -- blocks are laid out in decode order and the two
  // runs decode in a different order -- so on the way out $ip is re-resolved
  // from $gip through the block-cache hash, which is what every indirect
  // transfer in emit.js already does. A miss yields 0, and 0 is the handback:
  // `(if <arena> (then ...) (else (call $slice_exit)))` treats it as false.
  // (Left in as a comment because it is the bug that made the first working
  // region stop the machine at cs 0.)
  const leave = `
  (local.set $t3 (select (i32.const 0) (call $jlook (global.get $gip)) (global.get $smc)))
  (if (select (i32.const 0) (local.get $t3)
        (i32.or (global.get $smc) (i32.lt_s (global.get $steps) (i32.const 0))))
    (then (global.set $ip (local.get $t3)))
    (else (call $slice_exit)))`;
  // Give back the step `$next` charged to dispatch INTO the region. The region
  // charges every one of its own ops, including the first, so without this the
  // entry costs two steps instead of one -- invisible in a loop that iterates a
  // thousand times, and a real budget error in one that is re-entered
  // constantly. DRAGON.EXE re-enters its region through 18 exits and ran 24
  // interrupts to the interpreter's 107 on the same dispatch budget: the region
  // was not slower at the work, it was being charged for work it had not done.
  const entry = '(global.set $steps (i32.add (global.get $steps) (i32.const 1)))';
  // `--trap` replaces the whole body with `unreachable`. It answers the one
  // question no A/B on the body can: is this region being ENTERED at all. A run
  // that finishes normally with it on has never dispatched the region -- and
  // every measurement of that region is a measurement of something else.
  const body = flag('trap') ? '(unreachable)'
    : `${entry}\n${t3.pro}\n(block $out (loop $again\n${parts.join('\n')}\n))\n${t3.epi}\n${leave}`;
  return {
    name, body, locals: t3.locals, exits, unlowered, unloweredWhy,
    promoted: t3.promoted, declined: t3.promoted ? null : t3.declined,
    eaFolded: t3.eaFolded, segFolded: t3.segFolded, folded: t3.folded,
    inlined: t3.inlined, strippedArena: stripped,
  };
}

// The guest code a region covers, read out of the profiling run's memory as
// [{lin, bytes}]. The extents come from the compiler's own `covered` list --
// the same linear ranges it marks as code for self-modify detection -- so the
// guard checks exactly the bytes the region was decoded from, not a fixed
// window around the head that could miss a patch further in.
function guardBytes(rr, pick) {
  const out = [];
  for (const blk of pick.heads || []) {
    // The program key is the linear code base, with a `d` suffix for a 32-bit
    // descriptor. Both name the same base.
    const codeBase = parseInt(String(blk.cs), 10);
    const start = (codeBase + blk.ip) & 0xFFFFF;
    // AN EXACT START IS THE COMMON CASE AND NOT THE ONLY ONE. `covered` gets one
    // entry per block the decoder walked, keyed on that block's own start -- but
    // the arena is reset on every self-modify break, and after a reset a block
    // that is still live in `pick.heads` may only be inside a range some LATER
    // decode contributed. Silently skipping those (`continue`, which is what
    // this did) costs the region both halves of its safety: the install-time
    // byte guard never checks that block, and `regionCodeBits` never marks it,
    // so a store into it raises no self-modify break and the stale compiled body
    // keeps running over code that no longer exists. That is measurable, not
    // theoretical -- BMGLP.EXE reports 338 FEWER breaks with its region than
    // without, on a program that takes 51158 of them.
    const covered = blk.prog.covered || [];
    const span = covered.find(([s]) => s === start)
      || (([s, e]) => (s === undefined ? null : [start, e]))(
        covered.find(([s, e]) => start > s && start < e) || []);
    // Still nothing: this block's bytes cannot be guarded, so the region cannot
    // be installed safely. Declining is the whole point -- an unguardable region
    // is exactly the one a self-modifying program will invalidate under.
    if (!span) return null;
    out.push({ lin: span[0], bytes: Array.from(rr.vm.mem.slice(span[0], span[1])) });
  }
  return out;
}

// The state trace-jit's snapshot bench seeds its arms from: the whole guest
// memory as the profiling run left it, plus every CPU and machine global. Both
// `--agree` and the install gate below start from exactly this, so a gate
// verdict and an agreement verdict are about the same seeded state.
function snapshotFor(rr, pick) {
  const hot = { bip: pick.headIp, memSnapshot: rr.vm.mem.slice(), regSnapshot: {},
    machineSnapshot: {} };
  for (const g of require('./emit').STATE) {
    if (rr.vm.exports[`get_${g}`]) hot.regSnapshot[g] = rr.vm.raw(g);
  }
  for (const g of require('./emit').MACHINE_STATE) {
    const get = rr.vm.exports[`mget_${g}`];
    if (get) hot.machineSnapshot[g] = get();
  }
  return hot;
}

// --- running it -------------------------------------------------------------

async function once(exe, o, extra) {
  // `--entries` turns on run-dos's own handback census (which cs:ip the run
  // keeps leaving wasm at, and whether that address was in the jump table).
  // That census is the first thing to read when a region is slower than the
  // interpreter: the cost is nearly always round trips, not the body.
  // The emulated clock is driven by the DISPATCH COUNT -- a timer IRQ every
  // `irqEvery` dispatches, a clock word every `dispatchesPerTick` -- so it is
  // the one thing a region can move without executing anything differently.
  // Both arms get the same values, and `--irq-every=1b` switches interrupts off
  // entirely, which is what tells "the region ran the wrong code" apart from
  // "the region moved the clock".
  // A region is built out of the ARENA WORDS the compiler emitted, and those
  // words carry the compiler's own assumptions: a traced conditional has its
  // fall-through stitched in behind it, a spin block has been rewritten, and
  // dead-flag elimination can pick a no-flags twin because it knows what
  // follows. Replaying them somewhere else is only sound if those assumptions
  // still hold, so each is switchable in BOTH arms -- that is what tells an
  // unsound region apart from a wrong one.
  const r = await runDos({ exe, budget: o.budget, slice: o.slice, cpu: o.cpu,
    irqEvery: o.irqEvery, dispatchesPerTick: o.dispatchesPerTick,
    spinLoops: !flag('no-spin'), traceBlocks: !flag('no-traced'),
    crossFlags: !flag('no-cross-flags'), fuse: !flag('no-fuse'),
    deadFlags: !flag('no-dead-flags'),
    // `--smc-diff` turns on the per-site self-modify census in BOTH arms. A
    // missing break has a writer, and "5 breaks missing out of 17600" as an
    // aggregate names nobody; this makes the two maps subtractable.
    smcCensus: flag('smc-diff'),
    autoKey: true, report: flag('entries'), log: () => {}, ...extra });
  if (flag('entries')) {
    const eh = [...r.entryHist].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  ${extra.jitRegions ? 'region ' : 'baseline'} entries: `
      + eh.map(([k, n]) => `${k} x${n}`).join(', '));
  }
  // Everything the corpus equivalence check compares, read while the instance
  // is still alive: the frame, the pixel count, the interrupt tally and the
  // stopping cs:ip. Wall clock and arena footprint are allowed to move.
  // Both clocks are run-dos's own, bracketing only the guest SLICES: the
  // region's wasm module is compiled up front in makeVm and the block
  // compiles happen between slices, so neither arm is billed for compiling.
  // The wall clock measures the box -- on a loaded machine the process waits
  // for a core, and the same guest work has been measured at identical user
  // CPU and three times the wall time -- so the `%` in main() is taken from
  // CPU time, which is what the slices themselves cost. A process-wide
  // `process.cpuUsage()` around the whole run was tried first and read DRAGON's
  // zero-extra-handback region as 11% SLOWER: V8 compiles the region module on
  // background threads, and at a 150ms guest run that compile is the same size
  // as the work.
  return { ms: r.guestSecs * 1000, cpuMs: r.guestCpuSecs * 1000,
    dispatched: r.dispatched, frame: r.frame,
    pixels: r.pixels, ints: r.ints, handbacks: r.handbacks, smcBreaks: r.smcBreaks,
    smcSites: r.smcSites, cs: r.vm.exports.get_cs(), ip: r.vm.exports.get_gip(), r };
}

async function main() {
  const exe = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!exe) {
    console.log('usage: node tools/toyvm/region-jit.js <exe> [--dispatches=12m] [--reps=3]');
    process.exit(1);
  }
  const o = {
    budget: count(arg('dispatches'), 12e6),
    slice: count(arg('slice'), 20000),
    cpu: Number(arg('cpu', 386)),
    reps: Number(arg('reps', 3)),
    minOps: Number(arg('min-ops', 4)),
    sampleFrom: Number(arg('sample-from', 0.5)),
    irqEvery: count(arg('irq-every'), 100e3),
    dispatchesPerTick: count(arg('dispatches-per-tick'), 550e3),
  };
  console.log(`${path.basename(exe)} -- profiling ${(o.budget / 1e6).toFixed(0)}M dispatches`);

  const { r: rr, ranked, total } = await findHotTrace(exe,
    { budget: o.budget, slice: o.slice, cpu: o.cpu, sampleFrom: o.sampleFrom });
  if (!ranked.length) { console.log('no samples landed in a live block'); process.exit(2); }
  const pick = pickRegion(rr, ranked, o.minOps);
  if (!pick) { console.log('no self-loop region found'); process.exit(2); }
  const share = 100 * pick.samples / total;
  console.log(`region at guest ip 0x${pick.headIp.toString(16)}: `
    + `${pick.blocks} block(s), ${pick.ops.length} ops, ${share.toFixed(1)}% of samples`);

  // `--pick-only` stops here: profile, pick, report, exit. Nothing is built,
  // installed, compared or timed. It exists for tools/toyvm/region-why.js,
  // which asks which SHAPES the picker can reach across the corpus and has no
  // use for the run -- and paying for two whole-program runs and a wasm build
  // per program would have made that census too slow to run at all.
  if (flag('pick-only')) return;

  const region = buildRegion(pick.ops, pick.nexts, pick.headIp, 'region_0');
  if (region.declined && !region.body) { console.log(`declined: ${region.declined}`); process.exit(3); }
  console.log(`  ${region.exits} in-body exit(s), ${region.eaFolded} addresses folded, `
    + `${region.folded} register-file calls folded, `
    + `${region.inlined} counter call(s) inlined, `
    + `${region.strippedArena} stale arena operand(s) stripped, `
    + (region.promoted ? `${region.promoted.length} values in locals: ${region.promoted.join(' ')}`
      : `NO register promotion -- ${region.declined}`));
  if (flag('dump')) {
    const f = `/tmp/region-${path.basename(exe)}.wat`;
    fs.writeFileSync(f, `(func $${region.name} ${region.locals}\n${region.body}\n)`);
    console.log(`  body written to ${f}`);
  }

  // `--agree` asks a question the whole-run comparison cannot separate: do
  // THESE ops mean the same thing to the interpreter and to the compiler,
  // independent of the loop protocol wrapped around them? It hands the region's
  // op list to trace-jit's snapshot bench, which runs the shipped interpreter
  // over them and the compiled tiers over them from one seeded state and
  // compares every register and every byte of guest memory afterwards. A
  // MISMATCH here is a lowering bug; ALL THREE MATCH moves the search to the
  // control flow this file supplies.
  if (flag('agree')) {
    // `--agree-ops=N` truncates the op list to its first N. It is the manual
    // form of the prefix walk below: once that has named a k, this prints the
    // full register and memory report for exactly that prefix.
    const n = Number(arg('agree-ops', pick.ops.length));
    await benchTiers(exe, snapshotFor(rr, pick), pick.ops.slice(0, n),
      { iters: Number(arg('agree-iters', 200)), reps: 1, passes: passSpec() });
    return;
  }

  // `--agree-bisect` turns that yes/no into an address. It runs the same
  // snapshot bench over ops[0..k] for growing k and stops at the first k whose
  // arms disagree, which names ONE op: the k-th is the first whose compiled
  // form does not mean what the interpreter's does from this seed.
  //
  // A whole-region MISMATCH is nearly useless on its own -- a 58-op region has
  // 58 candidates and the bench prints one hash -- and for a region with an
  // internal branch the gate cannot even call it a bug (the arms take different
  // paths, so of course they end up in different states). The prefix walk
  // separates those two: an op that flips agreement while sitting in the middle
  // of a straight line is a lowering bug, while one that flips it by being a
  // transfer is the harness's own limit, and the op's NAME says which.
  //
  // Few iterations on purpose. This is not a measurement, and a divergence that
  // needs thousands of iterations to appear is not a divergence, it is a
  // counter running to a different value.
  if (flag('agree-bisect')) {
    const iters = Number(arg('agree-bisect-iters', 50));
    for (let k = Number(arg('agree-bisect-from', 1)); k <= pick.ops.length; k++) {
      // A FRESH snapshot per prefix, not one hoisted out of the loop. The bench
      // hands its arms the snapshot object and the arms write through it, so a
      // reused one seeds prefix k from wherever prefix k-1 stopped -- which
      // reported a disagreement at op 1 that a direct `--agree --agree-ops=2`
      // could not reproduce at any iteration count.
      const hot = snapshotFor(rr, pick);
      const g = await benchTiers(exe, hot, pick.ops.slice(0, k),
        { iters, reps: 1, log: () => {}, passes: passSpec() });
      const op = pick.ops[k - 1];
      if (!g.agree) {
        console.log(`  seed mem=${memHash(hot.memSnapshot)}`);
        console.log(`  first disagreement at op ${k - 1}: ${op.name} `
          + `[${op.args.join(' ')}]${isTransfer(op) ? '  (a TRANSFER -- the arms '
            + 'stop running the same program here, which the bench cannot see past)' : ''}`);
        return;
      }
      if (flag('verbose')) {
        console.log(`  ops[0..${k}] agree (${op.name})  seed mem=${memHash(hot.memSnapshot)}`);
      }
    }
    console.log(`  all ${pick.ops.length} prefixes agree over ${iters} iterations`);
    return;
  }

  // THE GATE. Everything below this point installs the region into a whole-app
  // run, which is a slow and — as ACCIDENT.EXE showed — occasionally a wrong
  // thing to do. Before paying for that, ask the cheap question the whole-run
  // comparison cannot answer on its own: over THESE ops, from a state the app
  // really reached, does the compiled lowering (a) compute the same thing as
  // the shipped interpreter, and (b) run faster than it?
  //
  // Both halves are the snapshot bench `--agree` already wires up, so the gate
  // costs one extra build of the tiers and a few hundred iterations. What it
  // measures is trace-jit's tier 3 — the same op lowering this file emits, but
  // straight-line, with no loop protocol around it. That makes the ratio a
  // proxy, not a promise: it prices the BODY, and says nothing about the
  // prologue, the spills or the per-entry block-cache resolve, which is
  // precisely why a region that clears the gate can still lose end to end. A
  // region that FAILS it, though, cannot win — the body is already behind
  // before the loop protocol charges anything.
  //
  // THE ITERATION COUNT IS PART OF THE VERDICT, and getting it wrong is how
  // this gate was nearly justified by a number that was not real. ACCIDENT's
  // 0x2d41 region benched at 0.94x of the interpreter over 200 iterations,
  // which read as "the compiled body loses" and was the original reason to
  // build the gate at all. It is a warm-up artifact: the same region over 4000
  // iterations is 2.19x and 2.38x on two consecutive runs. Below roughly a
  // thousand iterations the arms are still being tiered up by the host engine
  // and the ratio measures the wasm compiler, not the lowering. Hence the
  // default, and hence the count in the printed line -- a gate verdict without
  // its iteration count beside it cannot be checked.
  //
  // A MISMATCH ONLY COUNTS WHEN THE ARMS RAN THE SAME PROGRAM. The bench runs
  // the op list end to end: the interpreter arm walks arena words, so a branch
  // word inside the list JUMPS, while every compiled arm was emitted as a
  // straight line and falls through it. Where that branch is actually taken the
  // two arms are two different programs and the bench duly reports MISMATCH --
  // all three compiled arms agreeing with each other and only arm 0 differing,
  // which is the signature. CYCLE, BRW and CMA_SHRT are all multi-block picks
  // and all three were being declined for exactly this; CYCLE is
  // frame-IDENTICAL end to end, so that was a false positive, not a find.
  //
  // The test is therefore on the DISAGREEMENT, not on the region: an op list
  // with an internal transfer downgrades a mismatch to INCONCLUSIVE instead of
  // a decline. It does not downgrade a pass -- ACCIDENT's 0x2d41 region has an
  // internal branch that is never taken from this seed, agrees, and is judged
  // on its ratio like any other.
  const gateAt = Number(arg('gate', 1));
  const gateIters = count(arg('gate-iters'), 4000);
  const branchy = pick.ops.slice(0, -1).some(isTransfer);
  // Kept for the payoff line at the end: the gate's in-isolation body ratio is
  // one of the three load-free inputs the expected whole-program win is
  // composed from.
  let gateRatio = null;
  if (!flag('no-gate')) {
    const g = await benchTiers(exe, snapshotFor(rr, pick), pick.ops,
      { iters: gateIters, reps: 2, log: () => {}, passes: passSpec() });
    const ratio = g.agree ? g.speedup.t03 : 0;
    if (g.agree) gateRatio = ratio;
    console.log(`  gate (${gateIters} snapshot iterations): ${g.agree
      ? `tier 3 is ${ratio.toFixed(2)}x of the interpreter`
      : branchy ? 'INCONCLUSIVE -- the arms disagree, and the op list branches '
        + 'internally, so they did not run the same program'
        : 'the lowering DISAGREES with the interpreter over these ops'}`);
    if ((!g.agree && !branchy) || (g.agree && ratio < gateAt)) {
      console.log(`  DECLINED: ${g.agree
        ? `${ratio.toFixed(2)}x is below the ${gateAt.toFixed(2)}x bar`
        : 'a region that computes something else is not faster'}`
        + ' -- not installing (--no-gate overrides)');
      process.exit(5);
    }
  }

  // A REGION THAT COULD NOT LOWER ALL ITS TRANSFERS IS NOT SAFELY INSTALLABLE.
  // Such a transfer keeps the interpreter's protocol inside the region's loop,
  // and everything this file has failed to explain about a wrong frame has been
  // one of those: CARRIE.EXE's region has seven, is entered exactly 3840 times
  // either way, takes the same 1929 self-modify breaks and the same 6
  // interrupts -- and draws a different screen depending on whether ONE extra
  // successor block was compiled at install time, which changes no guest
  // semantics at all. A region whose every edge is a `br` has no such
  // dependence, and DRAGON and ADDY_II report identical dispatch and handback
  // counts either way for exactly that reason. Lowering the rest is the real
  // fix (`splitBranch` declines them); until then this trades coverage for a
  // correct picture. `--allow-unlowered` overrides, and `--no-lower` (which
  // unlowers everything on purpose) is exempt because it is a bisector.
  if (region.unlowered && !flag('allow-unlowered') && !flag('no-lower') && !flag('no-gate')) {
    console.log(`  declined: ${region.unlowered} transfer(s) could not be lowered,`
      + ' so this region depends on the install-time arena (--allow-unlowered overrides)');
    for (const w of region.unloweredWhy) console.log(`    unlowered: ${w}`);
    process.exit(3);
  }

  const guarded = guardBytes(rr, pick);
  if (!guarded && !flag('no-gate')) {
    console.log('  declined: a block of this region has no covered span, so its bytes'
      + ' cannot be guarded (--no-gate overrides)');
    process.exit(3);
  }
  console.log(`  guard: ${(guarded || []).reduce((n, g) => n + g.bytes.length, 0)} guest byte(s) over `
    + `${(guarded || []).length}/${(pick.heads || []).length} block(s)`
    + (!guarded ? ' -- UNGUARDABLE, running anyway under --no-gate' : ''));
  if (flag('why')) {
    for (const blk of pick.heads || []) {
      const cb = parseInt(String(blk.cs), 10);
      console.log(`    block 0x${blk.ip.toString(16)} at linear 0x${((cb + blk.ip) & 0xFFFFF).toString(16)}`);
    }
  }

  // `--emit=PREFIX` writes the two whole modules -- with the region and
  // without it -- as both .wat and .wasm. Nothing here runs them; they are for
  // the tools that cannot drive our JS harness: tools/wasm-native.js (what
  // SpiderMonkey Ion makes of $region_0) and any other engine's shell.
  if (arg('emit')) {
    const p = path.resolve(arg('emit'));
    for (const [suffix, opts] of [['', { regions: [region] }], ['-base', {}]]) {
      const vm = await makeVm('tailcall', opts);
      fs.writeFileSync(`${p}${suffix}.wat`, vm.wat);
      fs.writeFileSync(`${p}${suffix}.wasm`, Buffer.from(vm.bytes));
      // The .wat beside it is what names the functions for wasm-native.js:
      // `--wasm=X.wasm --wat=X.wat --func=$region_0`. The handler-table index
      // (vm.regionBase) is NOT the wasm function index -- more functions are
      // defined after the table -- so do not reach for it here.
      console.log(`  ${p}${suffix}.wasm  ${(vm.bytes.length / 1024).toFixed(0)}KB`);
    }
  }

  // Two more bisectors, both about the INSTALL rather than the body.
  // `--no-succ` withholds the successor list (expect a handback storm).
  // `--succ-only` supplies the successor list and no region at all: the
  // decoder walks the extra addresses and the guest runs the interpreter
  // everywhere, so anything that still moves is the successors' doing, not the
  // compiled loop's.
  const succWhy = new Map();
  const knownBlocks = (pick.block && pick.block.prog && pick.block.prog.blocks) || new Map();
  // OVER-APPROXIMATING THE SUCCESSOR LIST IS NOT FREE, whatever the comment on
  // it used to say. Pre-compiling an edge the program has never taken decodes
  // bytes that are not code yet, and this corpus is full of programs that
  // decrypt themselves: BMGLP.EXE takes 51158 self-modify breaks, and its
  // region's one never-taken fall-through (0x281) is the whole of its
  // divergence -- supplied, the run reports 338 FEWER breaks than the
  // interpreter and draws a different picture; withheld, it is frame-identical.
  // An edge that is taken later costs one handback and is decoded on demand,
  // exactly as the interpreter would decode it. `--succ-unseen` restores the
  // old behaviour for the A/B.
  const allSucc = successorIps(pick.ops, succWhy)
    .filter(ip => flag('succ-unseen') || knownBlocks.has(ip));
  // ...and each one carries the bytes the profiling run decoded it from, so
  // compile.js can decline any whose code has not been written yet. Same span
  // lookup as guardBytes; a successor with no covered span is passed as a bare
  // ip, which is the old unchecked behaviour for that one address.
  const succBytes = (ip) => {
    const codeBase = parseInt(String(pick.cs), 10);
    const start = (codeBase + ip) & 0xFFFFF;
    const covered = (pick.block && pick.block.prog && pick.block.prog.covered) || [];
    const span = covered.find(([s]) => s === start);
    if (!span) return ip;
    return { ip, lin: span[0], bytes: Array.from(rr.vm.mem.slice(span[0], span[1])) };
  };
  // `--succ-take=N` bisects by POSITION, which cannot separate "this address is
  // the culprit" from "the Nth slot is". `--succ-drop=0xa74,0x9a4` removes named
  // addresses and holds every other one still, so one variable moves.
  const succDrop = new Set(String(arg('succ-drop', '')).split(',')
    .filter(Boolean).map(s => Number(s.trim())));
  // A SUCCESSOR INSIDE THE REGION'S OWN BYTES IS A SECOND COPY OF CODE THE
  // REGION ALREADY OWNS. The region replaces the decode of its blocks;
  // pre-compiling an address that lands in the same guest bytes puts an
  // independent arena block over them, reached whenever an exit resolves there
  // instead of handing back. CARRIE.EXE is the measurement: its region covers
  // 135 bytes over six blocks, and supplying ANY ONE of the five successors
  // that fall in its last two blocks (0xa55, 0xa5b, 0xa6e, 0xa72, 0xa74) turns
  // a frame-identical run into a 52101-pixel divergence, with every build knob
  // (--no-lower, --no-promote, --no-fold-ea, --no-inline-counters,
  // --no-region-code-bits) making no difference at all. Withheld, those edges
  // cost one handback each and the interpreter decodes them on demand, which is
  // what the --no-succ arm already did correctly. `--succ-inside` restores them
  // for the A/B.
  // The test is the HULL of those spans, not the spans themselves. Three of
  // CARRIE's five breakers (0xa5b, 0xa6e, 0xa72) are fall-through addresses
  // that sit in the gaps BETWEEN its recorded block extents -- still the
  // region's own territory, still bytes it was compiled from, and each one
  // alone is enough to break the frame.
  // ...over the blocks the region ABSORBED, not over the head. The head block
  // is replaced one-for-one by the region entry, so the arena still owns an
  // entry at that ip and its own edges are ordinary; it is the other blocks
  // that the region swallowed and the arena no longer has. Scoping the hull
  // this way also leaves a single-block region alone, which matters:
  // acme-sns.exe is one block of 138 bytes, and withholding its own interior
  // edges moved it from 16px (phase) to a persistent 38px.
  const spans = flag('succ-inside') ? []
    : (guarded || []).filter((g, i) => (pick.heads || [])[i]
        && (pick.heads || [])[i].ip !== pick.headIp)
      .map(g => [g.lin, g.lin + g.bytes.length]);
  const lo = Math.min(...spans.map(s => s[0]));
  const hi = Math.max(...spans.map(s => s[1]));
  const insideRegion = (ip) => {
    if (!spans.length) return false;
    const lin = (parseInt(String(pick.cs), 10) + ip) & 0xFFFFF;
    return lin >= lo && lin < hi;
  };
  const succList = allSucc.filter(ip => !succDrop.has(ip) && !insideRegion(ip))
    .slice(0, Number(arg('succ-take', allSucc.length)));
  // Marked by MEMBERSHIP, not by position: --succ-drop punches holes in the
  // middle, and an index comparison here would print the wrong addresses as
  // withheld -- which it did, and cost a bisect.
  const kept = new Set(succList);
  console.log(`  successors: ${allSucc.map(x =>
    (kept.has(x) ? '' : '-') + '0x' + x.toString(16)).join(' ')}`
    + (succList.length < allSucc.length
      ? `  (- = withheld; ${succList.length} of ${allSucc.length} installed)` : ''));
  if (flag('why')) {
    // Whether the PROFILING run ever decoded a block at that address. A
    // successor the interpreter never entered is not proof of a bad operand --
    // an edge can simply not have been taken yet -- but a bad operand always
    // looks like this, and it is the cheapest thing that separates the two.
    const known = (pick.block && pick.block.prog && pick.block.prog.blocks) || new Map();
    for (const [i, ip] of allSucc.entries()) {
      console.log(`    [${i}] 0x${ip.toString(16)} <- ${succWhy.get(ip)}`
        + (known.has(ip) ? '' : '   (NEVER DECODED in the profiling run)')
        // A successor with no covered span goes in UNCHECKED, so nothing stops
        // it being compiled from bytes the program has not written yet. That is
        // the same hole guardBytes had, on the other list.
        + (typeof succBytes(ip) === 'number' ? '   (NO COVERED SPAN -- unchecked)' : ''));
    }
  }
  const install = {
    jitRegions: flag('succ-only') ? null : [region],
    // WHICH region, not where it sits in the table: only the built module knows
    // that, and it reports it as `vm.regionBase`.
    regionAt: flag('succ-only') ? new Map() : new Map([[`${pick.cs}:${pick.headIp}`, 0]]),
    // Every guest ip a branch in the region names, so the decoder still walks
    // out of a block whose body it never decodes. Over-approximating is free:
    // an address that turns out to be unreachable just gets compiled and never
    // entered, which is what a decoder that guesses a fall-through already does.
    // `--succ-take=N` keeps only the first N of them, which is the bisector for
    // the claim above: CARRIE.EXE is frame-identical under `--no-succ` and
    // wrong with the full list, so over-approximating is NOT always free and
    // the list has to be cut down to the address that does it.
    regionSucc: flag('no-succ') ? new Map()
      : new Map([[`${pick.cs}:${pick.headIp}`,
        succList.map(ip => (flag('succ-unchecked') ? ip : succBytes(ip)))]]),
    // The guest bytes this region was compiled from, one entry per block the
    // walk covered. compile.js checks them before installing, so a program that
    // rewrites its own loop gets the decoder back instead of a stale region.
    regionBytes: new Map([[`${pick.cs}:${pick.headIp}`, guarded || []]]),
    // ...and those same bytes marked as compiled code, so a store into them
    // still trips the self-modify check. `--no-region-code-bits` is the A/B.
    regionCodeBits: !flag('no-region-code-bits'),
  };

  // HOW MANY TIMES DOES ONE ENTRY GO ROUND? This is the number that decides
  // whether a region is worth installing at all, and nothing else reported here
  // can stand in for it. A region pays its prologue and epilogue -- the register
  // spills -- plus a block-cache resolve on the way out, ONCE PER ENTRY, and
  // saves a dispatch per op ONCE PER ITERATION. A loop with a trip count of
  // three cannot win however good its body is.
  //
  // The handler histogram counts dispatches per handler and a region IS a
  // handler, so its slot is the entry count exactly. Iterations are estimated
  // from the region's sample share, so read the trip count as an order of
  // magnitude, not a measurement. It runs on an instrumented build, which is
  // why it is a separate run and never one of the timed ones.
  if (flag('trips')) {
    const h = await once(exe, o, { ...install, hist: 1 });
    const u32 = new Uint32Array(h.r.vm.mem.buffer);
    const entries = u32[(isa.HIST_BASE >> 2) + h.r.vm.regionBase];
    if (flag('why')) {
      let best = 0, at = -1, sum = 0;
      for (let i = 0; i < isa.HIST_SLOTS; i++) {
        const n = u32[(isa.HIST_BASE >> 2) + i];
        sum += n;
        if (n > best) { best = n; at = i; }
      }
      console.log(`  hist: ${sum} counted, busiest slot ${at} x${best}`);
    }
    const iters = (share / 100) * h.dispatched / pick.ops.length;
    console.log(`  ${entries} region entries, ~${(iters / Math.max(1, entries)).toFixed(1)}`
      + ` iterations per entry (estimated from the ${share.toFixed(1)}% share)`);
  }

  // Interleaved, order rotated, minima -- the method every timing tool in this
  // directory uses, for the reason docs/loop-microbench-harness.md gives.
  const base = [], jit = [], baseCpu = [], jitCpu = [];
  let baseRun = null, jitRun = null;
  for (let i = 0; i < o.reps; i++) {
    const first = i % 2 === 0;
    const a = first ? await once(exe, o, {}) : await once(exe, o, install);
    const b = first ? await once(exe, o, install) : await once(exe, o, {});
    const [bs, jt] = first ? [a, b] : [b, a];
    base.push(bs.ms); jit.push(jt.ms);
    baseCpu.push(bs.cpuMs); jitCpu.push(jt.cpuMs);
    baseRun = bs; jitRun = jt;
  }
  const min = (xs) => Math.min(...xs);
  // At one rep the loop above never rotates: baseline first, region second,
  // min of one. That is an order, not a measurement -- the 2026-08-31 census
  // printed 93 of 93 regions negative at a median of -58% from exactly this,
  // on a box at load 17-27 -- so one rep gets no percentage at all.
  const rotated = o.reps >= 2;
  const pct = (b, j) => `${((min(b) / min(j) - 1) * 100).toFixed(1)}%`;
  // The frame, the pixel count and the interrupt tally are the equivalence
  // test. The stopping cs:ip is NOT part of it: a run that ends because the
  // dispatch budget ran out ends wherever the budget happened to run out, and
  // the region charges $steps in one lump per straight line rather than one per
  // op, so the two runs stop a few instructions apart having done the same
  // work. It is printed as context, not judged. (A run that ends on its own --
  // int 20h, a key -- stops at the same place in both, and that IS visible.)
  const same = baseRun.frame === jitRun.frame && baseRun.pixels === jitRun.pixels
    && baseRun.ints === jitRun.ints;
  // handbacks is the number the wall clock usually turns out to be about: a
  // region that leaves wasm on every exit costs a JS round trip per iteration.
  const hb = (r) => `${String(r.handbacks).padStart(9)}`;
  const ms = (xs) => min(xs).toFixed(1).padStart(9);
  console.log(`\n              dispatched  handbacks    wall ms     cpu ms`);
  console.log(`  baseline    ${String(baseRun.dispatched).padStart(10)}  ${hb(baseRun)}  ${ms(base)}  ${ms(baseCpu)}`);
  console.log(`  region      ${String(jitRun.dispatched).padStart(10)}  ${hb(jitRun)}  ${ms(jit)}  ${ms(jitCpu)}`
    + (rotated ? `   ${pct(baseCpu, jitCpu)} cpu  (${pct(base, jit)} wall)`
      : '   n/a (1 rep: order not rotated, min of one -- pass --reps=2 or more)'));
  // The load-free view of the same question. A region's whole-program win is
  // capped by its share of samples, and inside that share the body runs at the
  // gate's in-isolation ratio, so `share * (1 - 1/ratio)` is the ceiling on
  // what the timing above can show; every handback the region adds is a JS
  // round trip the interpreter did not pay, and is the usual reason the
  // measured number lands under the ceiling. Neither input moves with box
  // load, so this line is comparable across census runs where the `%` is not.
  if (gateRatio !== null) {
    const ceiling = (share / 100) * (1 - 1 / gateRatio) * 100;
    const dhb = jitRun.handbacks - baseRun.handbacks;
    console.log(`  expected    share ${share.toFixed(1)}% x (1 - 1/${gateRatio.toFixed(2)}x)`
      + ` = ${ceiling >= 0 ? '+' : ''}${ceiling.toFixed(1)}% ceiling,`
      + ` handbacks ${dhb >= 0 ? '+' : ''}${dhb} vs baseline`);
  }
  console.log(`\n  frame ${same ? 'IDENTICAL' : '*** DIFFERS ***'}`
    + `  ints ${baseRun.ints}/${jitRun.ints}`
    // Self-modify breaks are the first thing to read on a frame that differs:
    // a region is installed by guest ip, so a program that rewrites the bytes
    // at that ip gets the OLD loop compiled over the new code.
    + `  smc ${baseRun.smcBreaks || 0}/${jitRun.smcBreaks || 0}`
    + `  (baseline ${baseRun.frame} ${baseRun.pixels}px stop ${baseRun.cs.toString(16)}:${baseRun.ip.toString(16)}`
    + ` / region ${jitRun.frame} ${jitRun.pixels}px stop ${jitRun.cs.toString(16)}:${jitRun.ip.toString(16)})`);
  // ...and `--smc-diff` turns that aggregate into names. Every break is a
  // (writer cs:ip, what it hit) pair, so subtracting the two censuses says
  // exactly which write stopped raising one -- which is a guest address to
  // disassemble, where a count is only a number to worry about.
  if (flag('smc-diff') && baseRun.smcSites && jitRun.smcSites) {
    const keys = new Set([...baseRun.smcSites.keys(), ...jitRun.smcSites.keys()]);
    const rows = [];
    for (const k of keys) {
      const b = baseRun.smcSites.get(k) || 0, j = jitRun.smcSites.get(k) || 0;
      if (b !== j) rows.push([k, b, j]);
    }
    rows.sort((a, b) => Math.abs(b[1] - b[2]) - Math.abs(a[1] - a[2]));
    console.log(`  smc sites differing: ${rows.length} of ${keys.size}`);
    for (const [k, b, j] of rows.slice(0, Number(arg('smc-top', 12)))) {
      console.log(`    ${b > j ? '-' : '+'}${Math.abs(b - j)}  ${k}  (baseline ${b}, region ${j})`);
    }
  }

  // `--png=PREFIX` writes PREFIX-base.png and PREFIX-jit.png off the two arms
  // that were just compared. A frame hash says THAT they differ; only the
  // pictures say WHERE, which is the difference between "the loop wrote the
  // wrong colour" and "the loop wrote the right colour in the wrong place".
  // Feed the pair to tools/png-diff.js for the bounding box.
  const pngPrefix = arg('png');
  if (pngPrefix) {
    const { writePng, writeConsolePng } = require('./run-dos');
    for (const [tag, run] of [['base', baseRun], ['jit', jitRun]]) {
      const rr = run.r;
      const file = `${pngPrefix}-${tag}.png`;
      if (rr.surface.text) writeConsolePng(file, rr.machine.con);
      else writePng(file, rr.vm.mem, rr.machine.palette, rr.surface.geom);
      console.log(`  wrote ${file}`);
    }
  }
  // A DIFFERING FRAME AT A FIXED BUDGET IS NOT YET A DEFECT, AND NO NUMBER OF
  // EXTRA BUDGETS SETTLES IT. The interpreter stops dispatch-exact; the region
  // charges $steps in one lump per straight line, so it overshoots its last
  // entry and the two arms end thousands of dispatches apart -- 13087 apart on
  // COMPOVRS.EXE, whose changed pixels were then a 320x5 band, the ~1400 writes
  // that delta buys. The delta is not even signed consistently across budgets
  // (-3228 at 4M, +13087 at 8M), which is why re-confirming at more budgets
  // cannot clear it.
  //
  // So re-run the INTERPRETER with a budget equal to the region arm's actual
  // dispatch count. Both arms have then retired the same amount of guest work,
  // and a frame that still differs is the region computing something else.
  // ... and the re-run cannot land on that count either: the interpreter also
  // stops only at a block boundary, so asking for 8054341 dispatches ran 8062431
  // of them. There is no budget that samples two arms at the same guest instant.
  //
  // What CAN be measured is the phase noise floor. Run the interpreter a second
  // time at the region's dispatch count and count the pixels the BASELINE moved
  // by itself over that delta. That is how much of a picture this program
  // repaints in the distance between the two stops. A baseline-vs-region
  // difference no bigger than the baseline's own drift is phase; a difference
  // far above it is the region computing something else.
  if (!same && !flag('no-rematch') && baseRun.dispatched !== jitRun.dispatched) {
    const { readFrame } = require('./run-dos');
    const px = (run) => readFrame(run.r.vm.mem, run.r.surface.geom).pixels;
    const nd = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
    // ONE SAMPLE OF THE DRIFT IS NOT THE FLOOR. How much a demo repaints in a
    // given number of dispatches is wildly uneven -- a dissolve advances in
    // bursts and sits still in between -- so a single measurement taken across
    // the gap can land in a quiet moment and report a floor of 4px for a
    // program that moves thousands of pixels a few hundred dispatches later.
    // Probe the same-sized gap at several nearby offsets and take the LARGEST.
    const delta = jitRun.dispatched - baseRun.dispatched;
    const probes = [jitRun.dispatched, baseRun.dispatched + 2 * delta,
      baseRun.dispatched - delta].filter(d => d > 0);
    const pb = px(baseRun), pj = px(jitRun);
    let drift = 0;
    for (const d of probes) drift = Math.max(drift, nd(pb, px(await once(exe, { ...o, budget: d }, {}))));
    const gap = nd(pb, pj);
    const phase = gap <= Math.max(drift, 1) * 2;
    console.log(`  phase check: baseline drifts up to ${drift}px over ${probes.length}`
      + ` probes of the ${delta} dispatch gap; baseline vs region is ${gap}px`
      + `  -> ${phase ? 'PHASE, not a defect' : '*** BEYOND THE NOISE FLOOR ***'}`);
    if (phase) { process.exitCode = 6; return; }

    // THE DISPATCH COUNT IS NOT A COMMON CLOCK, and on a self-modifying program
    // that is not a quibble. A region collapses a whole loop into ONE dispatch,
    // so two arms stopped at equal dispatch counts are at different guest
    // instants, and the gap between them is not `jitRun.dispatched -
    // baseRun.dispatched` -- which means the probe above measured the noise
    // floor over the wrong distance and can call a phase difference a defect.
    // acme-sns.exe is the case: the arms end at the same cs:ip, paint the same
    // number of pixels, and differ only in being ~3 iterations apart in ONE
    // self-patching loop (`--smc-diff` names it: two writers, 110:5467 and
    // 110:5484, short by 3 of ~12000 at every budget from 3M to 12M -- a
    // constant, not something accumulating).
    //
    // When the arms disagree on self-modify breaks, USE THOSE AS THE CLOCK.
    // Breaks are monotone in budget, so bisect the baseline for the budget at
    // which it has taken exactly as many as the region did: that is the same
    // guest instant by the program's own measure, and it is what the frame
    // should be compared against.
    if ((baseRun.smcBreaks || 0) !== (jitRun.smcBreaks || 0) && !flag('no-rematch-smc')) {
      const target = jitRun.smcBreaks || 0;
      // Bracket the target by walking DOWN from the full budget in doubling
      // strides before bisecting. Bisecting the whole run instead costs ~22
      // halvings of full-length runs for an answer that is a few thousand
      // dispatches from where it started -- the deficit is single digits of
      // breaks -- and a step count too small to converge silently reports a
      // bracket that is not one (it sat on 10142 -> 10142 across a target of
      // 10134 and called the region wrong).
      let hi = baseRun.dispatched, lo = hi;
      for (let stride = Math.max(1, o.slice); lo > 1; stride *= 2) {
        lo = Math.max(1, hi - stride);
        const at = await once(exe, { ...o, budget: lo }, {});
        if ((at.smcBreaks || 0) < target) break;
        hi = lo;
      }
      for (let i = 0; i < Number(arg('rematch-steps', 40)) && lo < hi; i++) {
        const mid = Math.floor((lo + hi) / 2);
        const at = await once(exe, { ...o, budget: mid }, {});
        if ((at.smcBreaks || 0) < target) lo = mid + 1; else hi = mid;
      }
      // The bisect gets NEAR the target and cannot always land on it: the
      // interpreter stops only at a block boundary, so its break count is a
      // step function of the budget and a step can be wider than the miss. So
      // sweep a few instants either side and take the CLOSEST frame the
      // baseline ever shows. The question a rematch actually answers is not
      // "do these two stops agree" but "does the interpreter, somewhere in
      // here, draw the picture the region drew" -- and if it does, the region
      // computed nothing of its own.
      // ...and the bisect often CANNOT land on the target, because breaks come
      // in bursts: a decryptor patches a run of bytes and the count steps by
      // nine, so a target inside a burst is an instant the interpreter passes
      // through and never stops at. What is still available is the BRACKET --
      // the last instant below the target and the first at or above it. If the
      // region's frame is no further from one of those than they are from each
      // other, it lies inside a step the interpreter itself takes, and there is
      // no picture there that the interpreter does not also draw.
      const above = await once(exe, { ...o, budget: hi }, {});
      const below = await once(exe, { ...o, budget: Math.max(1, hi - 1) }, {});
      const bracket = nd(px(below), px(above));
      const best = Math.min(nd(px(below), pj), nd(px(above), pj));
      const ok = best <= Math.max(bracket, drift, 1) * 2;
      console.log(`  rematched on self-modify breaks: the interpreter steps`
        + ` ${below.smcBreaks} -> ${above.smcBreaks} across the region's ${target}`
        + ` and moves ${bracket}px doing it; the region is ${best}px from the nearer end`
        + `  -> ${ok ? 'PHASE, not a defect' : '*** STILL BEYOND THE NOISE FLOOR ***'}`);
      if (ok) { process.exitCode = 6; return; }
    }
  }
  // NOT CERTIFIED, AS DISTINCT FROM WRONG. A self-modify break is the emulator
  // invalidating what it believes is code, and the two arms believe different
  // things: a region replaces the decode of its blocks, so the walk that would
  // have discovered and marked their neighbours never happens and `regionSucc`
  // stands in for it. When the arms then disagree on the break COUNT, they did
  // not run with the same idea of which bytes are code, and any frame
  // difference that follows cannot be attributed to the region body -- on
  // acme-sns.exe the ops themselves are proven equivalent (`--agree`: ALL THREE
  // MATCH) and the frame is still 6-18 pixels off at every budget from 3M to
  // 12M, always with ~5 breaks missing out of ~17600. That is an open defect,
  // and this reports it as its own verdict rather than burying it in `differs`,
  // where it reads as a lowering bug it demonstrably is not.
  if (!same && (baseRun.smcBreaks || 0) !== (jitRun.smcBreaks || 0)) {
    console.log(`  NOT CERTIFIED: the arms disagree on self-modify breaks`
      + ` (${baseRun.smcBreaks || 0} vs ${jitRun.smcBreaks || 0}), so they did not`
      + ' run with the same notion of what is code');
    process.exitCode = 7;
    return;
  }
  if (!same) process.exitCode = 4;
}

module.exports = { pickRegion, buildRegion };

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
