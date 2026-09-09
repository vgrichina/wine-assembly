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

// THIS FILE IS ALSO A LIBRARY, and tools/toyvm/region-live.js is the caller
// that made it one: the live JIT picks, builds, guards and gates a region with
// exactly the functions below, so a live install and a bench install cannot
// diverge into two policies. Two things follow from being loadable in a page:
// `runDos` is required lazily (nothing in the live path runs a second whole
// program, and pulling it in at load costs the browser bundle its evaluation),
// and every process-shaped read below tolerates not having one.
const fs = require('fs');
const path = require('path');
const { makeVm } = require('./vm');
const { findHotTrace, readTrace, emitTier3, benchTiers, memHash } = require('./trace-jit');
const { HANDLERS, TAKEN_AT, prepareTables, sexpAt } = require('./emit');
const isa = require('./isa');

// The CLI's own switches, read from wherever there is an argv to read. In the
// page (and in region-live's worker) there is none, so every `flag()` is false
// and every `arg()` its default -- which is the shipped policy.
const ARGV = (typeof process !== 'undefined' && Array.isArray(process.argv))
  ? process.argv.slice(2) : [];
function arg(name, d) {
  const hit = ARGV.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? d : hit.slice(name.length + 3);
}
const flag = (n) => ARGV.includes(`--${n}`);

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
function chainFrom(head, headByAddr, traceAt, maxOps, why, maxDepth = 3, maxVisits = 3000, policy = {}) {
  const ops = [], nexts = [], spans = [], heads = [];
  // The head is a guest ip, not an arena block: the interpreter holds several
  // copies of one loop, and a walk that only closed on the arena it started
  // from ran through a second copy of ADDY_II's head before it noticed.
  const headIpOf = headByAddr.get(head).ip;
  // Edge order. Taken first is the loop shape (the back edge of a bottom-
  // tested loop is its taken edge); `fallFirst` follows the fall-through of a
  // FORWARD conditional instead -- an if-skip inside a body -- so the skip
  // lands on the path as a forward branch rather than an exit. Neither order
  // is right for every branch, so the picker walks each head both ways and
  // ranks the results.
  const fallFirst = !!policy.fallFirst;
  // NESTED LOOPS. A conditional whose taken edge lands on a block already on
  // this path (not the head, same call depth) is an inner loop's back edge:
  // the walk records it here as {headOp, backOp, headIp} -- the op index the
  // inner head's block starts at, the branch's own index, and the guest ip
  // -- and carries on along the branch's OTHER edge, which is the inner
  // loop's exit. buildRegion wraps ops[headOp..backOp] in a nested wasm loop.
  // Before this a revisit killed the path, so ADDY_II's outer loop was walked
  // AROUND its inner one: the region ran one pass of the inner body, left on
  // the inner back edge, and the interpreter ran the rest of the outer
  // iteration -- 99% share, +58% ceiling, +9-15% measured.
  const inner = [];
  // FORWARD BRANCHES INSIDE THE REGION. The unfollowed edge of every
  // conditional is recorded; when the walk closes, each whose target turns
  // out to be an op LATER in the region becomes a `br` to a block ending at
  // that op instead of an exit. Without this every `jz` that skips a few
  // instructions inside a loop body leaves the region for the interpreter,
  // which then runs the rest of the iteration: ADDY_II's inner body has two
  // such skips, and its 62-op region was entered 348409 times at 0.5
  // iterations each.
  const fwdCand = [];
  const opIp = [];                      // guest ip of each op, where the compiler recorded one
  const depthAt = [];                   // call depth each op was walked at
  const startOp = new Map();
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
    if (flag('why-walk') && why) why(`  walk[${ops.length} ops; path ${heads.map(b => '0x' + b.ip.toString(16)).join(' ')}]: ${s}`);
    if (ops.length > lastDepth) { lastDepth = ops.length; lastWhy = s; }
    return null;
  };

  // `retStack` is the inlined call frames still open, innermost last. Only the
  // return ADDRESS is tracked -- the guest's own frame is built and torn down
  // by the ops. It is copied on the call edge rather than mutated, so a
  // backtrack out of a callee cannot leave a frame behind.
  // The ops a block really owns. See fallArena: cut at the first branch whose
  // fall-through lives somewhere other than the words behind it. Everything
  // past that point is another block's code that readTrace ran into.
  const blockOps = (blk) => {
    const t = traceAt(blk);
    const bad = t.ops.find(o => /^(int|into)/.test(o.name));
    let cut = t.ops.length;
    for (let i = 0; i < t.ops.length - 1; i++) {
      const fa = fallArena(t.ops[i]);
      if (fa === null) continue;
      if (fa !== blk.prog.arenaBase + (t.ops[i + 1].at << 2)) { cut = i + 1; break; }
    }
    const tops = t.ops.slice(0, cut);
    const truncated = cut < t.ops.length;
    const endWord = truncated ? t.ops[cut].at : t.nextWord;
    const span = [blk.addr, blk.addr + ((endWord - ((blk.addr - blk.prog.arenaBase) >> 2)) << 2)];
    return { tops, endWord, bad, span, truncated, t };
  };

  // A DETOUR: the edge the walk did not follow, when what lies behind it is a
  // few straight blocks that come back onto the path. That is the other arm
  // of an if/else, and it is the shape that kept ADDY_II's region cold: its
  // 50 ops were faithful (frame IDENTICAL) and absorbed 0.9% of dispatches,
  // because the row loop's `jb` took its TAKEN arm (`inc [x]; jmp rejoin`) on
  // nearly every row and the region had compiled only the fall-through, so
  // every row left through that exit. The walk could not take that arm
  // itself: the rejoin block was already on the path, and a revisit is how a
  // linear walk detects a cycle. Here the revisit is what qualifies it.
  //
  // Only depth 0, only `jmp`/fall-through chains (a conditional inside the
  // detour is allowed when one of its edges is the path; the other is an
  // exit), no calls, no `int`, at most a handful of ops. The ops are compiled
  // inside the branch arm and the arm ends with the join: a `br` to a forward
  // block when the rejoin is later on the path, an inner-loop `br` when it is
  // an inner head the branch sits in, the back edge when it is the region head.
  const DETOUR_MAX_OPS = 24;
  const onPath = (ip) => ip === headIpOf || opIp.some((x, n) => x === ip && depthAt[n] === 0);
  const detourFrom = (arena, why2) => {
    const dOps = [], dNexts = [], dHeads = [], dSpans = [], dIps = [], dseen = new Set();
    let cur = arena;
    for (let n = 0; n < 4; n++) {
      if (dseen.has(cur)) return why2('revisits itself');
      dseen.add(cur);
      const blk = headByAddr.get(cur);
      if (!blk) return why2(`0x${cur.toString(16)} is not a block head`);
      const bo = blockOps(blk);
      if (bo.bad) return why2(`contains ${bo.bad.name}`);
      const cr = bo.tops.find(o => /^(call|ret)/.test(o.name));
      if (cr) return why2(`contains ${cr.name}`);
      if (dOps.length + bo.tops.length > DETOUR_MAX_OPS) return why2(`over ${DETOUR_MAX_OPS} ops`);
      const wip = blk.prog.wordIp;
      for (const op of bo.tops) { dOps.push(op); dNexts.push(fallThroughIp(op)); dIps.push(wip ? wip.get(op.at) : undefined); }
      dHeads.push(blk); dSpans.push(bo.span);
      const last = bo.tops[bo.tops.length - 1];
      const at = TAKEN_AT.get(last.fn);
      const fall = fallThroughIp(last);
      if (at === undefined) return why2(`ends in ${last.name}, not a transfer`);
      const tip = last.args[at], tarena = last.args[at - 1];
      if (tip !== undefined && onPath(tip)) return { ops: dOps, nexts: dNexts, heads: dHeads, spans: dSpans, ips: dIps, join: tip };
      if (fall !== null && onPath(fall)) return { ops: dOps, nexts: dNexts, heads: dHeads, spans: dSpans, ips: dIps, join: fall };
      if (fall !== null) return why2(`${last.name} leaves the path both ways`);
      if (tarena === undefined || tip === undefined) return why2(`${last.name} has no readable edge`);
      dNexts[dNexts.length - 1] = tip;
      cur = tarena;
    }
    return why2('over 4 blocks without rejoining');
  };

  const walk = (cur, retStack, via = 'root') => {
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
    if (seen.has(key)) return no(`walk revisited 0x${cur.toString(16)} via ${via} at depth ${retStack.length}`);
    const blk = headByAddr.get(cur);
    if (!blk) return no(`0x${cur.toString(16)} is not a block head`);
    const bo = blockOps(blk);
    // `int` still ends the walk: it hands the machine to the host by design and
    // there is nothing to inline.
    if (bo.bad) return no(`0x${cur.toString(16)} contains ${bo.bad.name}`);
    const { tops, endWord, truncated, t } = bo;

    const mark = { ops: ops.length, spans: spans.length, heads: heads.length, inner: inner.length, fwd: fwdCand.length };
    const undo = () => {
      ops.length = mark.ops; nexts.length = mark.ops; opIp.length = mark.ops; depthAt.length = mark.ops;
      spans.length = mark.spans; heads.length = mark.heads;
      inner.length = mark.inner; fwdCand.length = mark.fwd;
      seen.delete(key); startOp.delete(key);
    };
    seen.add(key); startOp.set(key, mark.ops);
    heads.push(blk);
    if (flag('why-walk') && why) {
      why(`  walk enter 0x${blk.ip.toString(16)} (arena 0x${cur.toString(16)}, via ${via}): `
        + tops.map(o => `${o.name}${TAKEN_AT.has(o.fn) ? '->' + (o.args[TAKEN_AT.get(o.fn)] || 0).toString(16) : ''}`).join(' '));
    }
    const wip = blk.prog.wordIp;
    for (const op of tops) {
      // A conditional the tracer folded mid-block (the `_t` twins) never
      // reaches the edges loop below; its taken edge is a candidate too.
      const at = TAKEN_AT.get(op.fn);
      if (op !== tops[tops.length - 1] && at !== undefined && op.args[at] !== undefined) {
        fwdCand.push({ op: ops.length, ip: op.args[at], arena: op.args[at - 1], depth: retStack.length });
      }
      ops.push(op); nexts.push(fallThroughIp(op)); opIp.push(wip ? wip.get(op.at) : undefined); depthAt.push(retStack.length);
    }
    spans.push([cur, cur + ((endWord - ((cur - blk.prog.arenaBase) >> 2)) << 2)]);
    const last = tops[tops.length - 1];
    // Follow one edge: rewrite the terminator's required-gip, recurse, and undo
    // everything this block added if the path behind it dies.
    const follow = (arena, ip, stack) => {
      if (ops.length > maxOps) return no(`over ${maxOps} ops without closing`);
      if ((arena === head || ip === headIpOf) && !stack.length) return close(ip);
      if (!headByAddr.has(arena)) return no(`edge to 0x${(arena >>> 0).toString(16)} is not a block head`);
      nexts[nexts.length - 1] = ip;
      return walk(arena, stack, `${ops[ops.length - 1].name}${stack.length !== retStack.length ? ' (call/ret)' : ''}`);
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
    if (!truncated && !/^jmp(_syn)?$/.test(t.end)) { undo(); return no(`0x${cur.toString(16)} ends ${t.end}, not jmp`); }
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
      if (fallFirst && last.args[at] > fi) edges.reverse();
    }
    // An inner back edge: the taken edge revisits this path. Only a
    // bottom-tested loop is recognised -- one whose back edge is the
    // conditional itself, the 8086 `loop` shape -- because its exit is then
    // the same branch's fall-through. A `jmp` back to a top-tested head has
    // no second edge to continue on and still ends the path. `--no-nested`
    // is the A/B.
    // The inner head is very often NOT a block boundary on this path: the
    // outer loop enters the inner one through a run-in block that starts
    // above the inner head and runs straight through it (ADDY_II enters
    // 0xc9 from a block headed at 0xb5), so the back edge names an arena
    // block the path never visited. The target block's ops are then a
    // SUFFIX-ALIGNED run inside the path -- the same guest code decoded
    // twice -- and matching them, arena operands stripped, finds the op the
    // inner head sits at. Every branch's guest-ip operand takes part in the
    // match, so a coincidental run of the same handlers elsewhere does not.
    const findInnerHead = (arena, ip) => {
      const nest = (j) => (inner.some(e => e.headOp < j && j <= e.backOp) ? undefined : j);
      // Exact first: the compiler's per-op ip map says where the target's
      // code sits on this path, whatever arena copy the edge names. The
      // signature match below is the fallback for ops the map does not cover.
      if (ip !== undefined) {
        const j = opIp.findIndex((x, n) => x === ip && depthAt[n] === retStack.length);
        if (j >= 0) return nest(j);
      }
      const k = `${arena}@${retStack.length}`;
      if (seen.has(k)) return nest(startOp.get(k));
      if (!headByAddr.has(arena)) return undefined;
      const T = headByAddr.get(arena);
      const tt = traceAt(T).ops;
      let tcut = tt.length;
      for (let i = 0; i < tt.length - 1; i++) {
        const fa = fallArena(tt[i]);
        if (fa !== null && fa !== T.prog.arenaBase + (tt[i + 1].at << 2)) { tcut = i + 1; break; }
      }
      const sig = (op) => { const o = stripArenaOperands([op]).ops[0]; return `${o.fn}:${o.args.join(',')}`; };
      const want = tt.slice(0, tcut).map(sig);
      for (let j = ops.length - want.length; j >= 0; j--) {
        if (want.every((w, k) => sig(ops[j + k]) === w) && nest(j) !== undefined) return j;
      }
      return undefined;
    };
    // EITHER edge can be a back edge, and one branch can close two loops.
    // ADDY_II's outer loop enters at its bottom test, so the test's block is
    // on the path before the body; the `loop` that ends the body then has
    // its taken edge back to the innermost head and its FALL-THROUGH back
    // to that test. A back edge closes the inner loop [headOp..this op]; if
    // the other edge is an ordinary one it is that loop's exit (bottom-
    // tested), and if there is none -- a `jmp`, or both edges back -- the
    // exit is an unfollowed edge of a conditional inside the OUTERMOST loop
    // closed here (top-tested), each tried in turn, nearest the head first.
    const backs = flag('no-nested') ? [] : edges.map(([a, ip]) => (a !== head && ip !== headIpOf ? findInnerHead(a, ip) : undefined));
    const backIdx = backs.map((b, i) => (b !== undefined ? i : -1)).filter(i => i >= 0);
    if (backIdx.length) {
      const backOp = ops.length - 1;
      const mark2 = inner.length;
      // Outermost first, so an outer loop's `(block (loop` opens before an
      // inner one's at the same op.
      for (const i of [...backIdx].sort((x, y) => backs[x] - backs[y])) {
        inner.push({ headOp: backs[i], backOp, headIp: edges[i][1] });
      }
      const exitEdges = edges.filter((_, i) => backs[i] === undefined);
      if (exitEdges.length) {
        const r = follow(exitEdges[0][0], exitEdges[0][1], retStack);
        if (r) return r;
        why(`0x${cur.toString(16)}: inner loop at ip ${edges[backIdx[0]][1].toString(16)} closed but the path after it died: ${lastWhy}`);
        undo();
        return no(`inner loop at 0x${edges[backIdx[0]][0].toString(16)} closed but the path after it died`);
      }
      const outer = inner[mark2];
      nexts[backOp] = outer.headIp;
      for (let k = outer.headOp; k < backOp; k++) {
        const o = ops[k];
        const a = TAKEN_AT.get(o.fn);
        if (a === undefined) continue;
        const fa2 = fallArena(o), fi2 = fallThroughIp(o);
        if (fa2 === null || fi2 === null) continue;
        const other = nexts[k] === o.args[a] ? [fa2, fi2] : [o.args[a - 1], o.args[a]];
        if (other[0] === undefined || other[0] === null) continue;
        if (ops.length > maxOps) break;
        outer.exitOp = k; outer.exitIp = other[1];
        if ((other[0] === head || other[1] === headIpOf) && !retStack.length) return close(other[1]);
        if (headByAddr.has(other[0])) {
          const r = walk(other[0], retStack, `inner exit from op ${k}`);
          if (r) return r;
        }
      }
      why(`0x${cur.toString(16)}: top-tested inner loop at ip ${outer.headIp.toString(16)}: no exit continued: ${lastWhy}`);
      undo();
      return no(`inner loop at 0x${edges[backIdx[0]][0].toString(16)} has no exit the walk could continue on`);
    }
    // A branch with one edge back to the head and one onward is the region's
    // own back edge with the body continuing past it -- ADDY_II's `loop
    // 0xa1` at 0xb1 closes the pixel loop and falls into the row loop, and
    // closing there left the row loop outside. Walk the onward edge; if
    // nothing past it closes, close here as before.
    if (!retStack.length && edges.length === 2) {
      const hi = edges.findIndex(e => e[0] === head || e[1] === headIpOf);
      if (hi >= 0) {
        const onward = edges[1 - hi];
        if (headByAddr.has(onward[0]) && !flag('no-head-continue')) {
          const r = follow(onward[0], onward[1], retStack);
          if (r) return r;
        }
        return close(edges[hi][1]);
      }
    }
    for (const [arena, ip] of edges) {
      const other = edges.find(e => e !== ([arena, ip]) && e[0] !== arena);
      const mark3 = fwdCand.length;
      if (other) fwdCand.push({ op: ops.length - 1, ip: other[1], arena: other[0], depth: retStack.length });
      const r = follow(arena, ip, retStack);
      if (r) return r;
      fwdCand.length = mark3;
    }
    undo();
    return null;
  };
  // The op an arena block's code sits at inside the finished path, if it
  // does: a block boundary the walk crossed, or -- the inner-head case
  // again -- a run the same guest code was decoded into mid-block.
  const opOf = (arena, ip, depth, after) => {
    const byIp = opIp.findIndex((x, j) => j > after && x === ip);
    if (byIp >= 0) return byIp;
    const k = `${arena}@${depth}`;
    if (seen.has(k) && startOp.get(k) > after) return startOp.get(k);
    if (!headByAddr.has(arena)) return undefined;
    const T = headByAddr.get(arena);
    const tt = traceAt(T).ops;
    let tcut = tt.length;
    for (let i = 0; i < tt.length - 1; i++) {
      const fa = fallArena(tt[i]);
      if (fa !== null && fa !== T.prog.arenaBase + (tt[i + 1].at << 2)) { tcut = i + 1; break; }
    }
    const sig = (op) => { const o = stripArenaOperands([op]).ops[0]; return `${o.fn}:${o.args.join(',')}`; };
    const want = tt.slice(0, tcut).map(sig);
    if (!want.length) return undefined;
    for (let j = after + 1; j + want.length <= ops.length; j++) {
      if (want.every((w, k) => sig(ops[j + k]) === w)) return j;
    }
    return undefined;
  };
  const close = (headIp) => {
    const forwards = [];
    // Edges that land on the region's own code and still exit: a target the
    // structure cannot reach (a back edge to an ip later on the path, or a
    // forward branch the planner drops). Head choice decides how many there
    // are -- ADDY_II's nest read as 62 ops from four different heads with
    // identical samples, and from 0xac the `loop 0xa1` wrapping the head was
    // an exit on every iteration (348409 entries at 0.5 iterations).
    let inRegionExits = 0, detours = 0;
    const ips = new Set(opIp.filter(x => x !== undefined));
    for (const f of fwdCand) {
      const t = opOf(f.arena, f.ip, f.depth, f.op);
      if (t !== undefined) { forwards.push({ op: f.op, ip: f.ip, targetOp: t }); continue; }
      if (f.ip !== headIp && ips.has(f.ip)
        && !inner.some(e => e.headIp === f.ip && (e.backOp === f.op || e.exitOp === f.op))) inRegionExits++;
      if (f.depth || f.ip === headIp || ips.has(f.ip) || flag('no-detours')) continue;
      // Off the path: is it a detour that comes back?
      let dwhy = null;
      const d = detourFrom(f.arena, (s) => { dwhy = s; return null; });
      if (!d) {
        if (flag('why-walk') && why) why(`  detour from op ${f.op} to 0x${f.ip.toString(16)}: ${dwhy}`);
        continue;
      }
      // Where the detour lands decides the join's shape. Later on the path:
      // a forward branch carrying the arm. The region head: the back edge.
      // Earlier: only an inner-loop head whose loop the branch sits in.
      let entry = null;
      if (d.join === headIp) entry = { kind: 'head' };
      else {
        const j = opIp.findIndex((x, n) => x === d.join && depthAt[n] === 0);
        if (j > f.op) entry = { kind: 'fwd', targetOp: j };
        else {
          const n = inner.findIndex(e => e.headOp === j && e.headOp <= f.op && e.backOp >= f.op);
          if (n >= 0) entry = { kind: 'inner', n };
        }
      }
      if (!entry) {
        if (flag('why-walk') && why) why(`  detour from op ${f.op} to 0x${f.ip.toString(16)} rejoins at 0x${d.join.toString(16)}, which the structure cannot reach`);
        continue;
      }
      if (flag('why-walk') && why) {
        why(`  detour from op ${f.op} to 0x${f.ip.toString(16)}: ${d.ops.map(o => o.name).join(' ')} -> 0x${d.join.toString(16)} (${entry.kind})`);
      }
      forwards.push({ op: f.op, ip: f.ip, ...entry, detour: d });
      heads.push(...d.heads); spans.push(...d.spans);
      detours++;
    }
    inRegionExits += planForwards(inner, forwards).dropped.length;
    return { ops, nexts, spans, heads, headIp, inner, forwards, opIp: opIp.slice(), inRegionExits, detours, policy: fallFirst ? 'fall-first' : 'taken-first' };
  };

  const r = walk(head, []);
  // The depth is printed because it is what makes the corpus histogram
  // meaningful: a program rejects many candidates, and a census that unions
  // their rules reports "a rule this program met", not "the rule blocking this
  // program". tools/toyvm/region-why.js keeps the deepest line per program.
  if (!r && lastWhy) why(`0x${head.toString(16)}: ${lastWhy} [depth ${Math.max(lastDepth, 0)}]`);
  return r;
}

// A HOT TRACE THAT NEED NOT CLOSE. `--straight` walks from the candidate the
// way a trace JIT does: one block at a time, following the HOTTER edge of
// every terminator, and stops where it can go no further -- a block that is
// not a head, an `int`, a `ret` with no inlined call, a revisit, or the op
// budget. What it has by then is installed as a region whose last transfer
// exits with $gip published, so the interpreter picks up at the edge the
// walk did not follow, or at the block after the one it stopped on. If the
// walk happens to arrive back at its own head it closes, and the result is
// the same loop chainFrom would have built.
//
// This is the whole-program form of the micro-op tiers: what those measured
// on one snapshot of one hot trace, this installs into a real run for every
// hot trace `--regions=N` allows, so the two backends can be read on one
// scale -- and `--once` on top of it is the pure straight-line arm, a region
// that never takes its back edge and pays an entry per pass.
function traceFrom(head, headByAddr, traceAt, maxOps, why, heat, maxDepth = 3, anchored = 0) {
  const ops = [], nexts = [], spans = [], heads = [];
  const seen = new Set();
  let cur = head, retStack = [], stop = null, closed = false, headIp = null;
  while (cur !== null) {
    const key = `${cur}@${retStack.length}`;
    // A revisit of a block on this very path is a loop whose head is that
    // block, and a trace JIT anchors there: the walk from it follows the same
    // hot edges and closes on itself. Without this ADDY_II's trace entered at
    // 0xac ran its 51-op nest once per entry and left through the inner back
    // edge every time -- 98.8% share, -0.2% measured.
    if (seen.has(key) && cur !== head && !retStack.length && anchored < 2) {
      why(`0x${head.toString(16)}: straight walk loops at 0x${cur.toString(16)}; anchoring there`);
      return traceFrom(cur, headByAddr, traceAt, maxOps, why, heat, maxDepth, anchored + 1);
    }
    if (seen.has(key)) { stop = `revisits 0x${cur.toString(16)}`; break; }
    const blk = headByAddr.get(cur);
    if (!blk) { stop = `0x${cur.toString(16)} is not a block head`; break; }
    const t = traceAt(blk);
    const bad = t.ops.find(o => /^(int|into)/.test(o.name));
    if (bad) { stop = `0x${cur.toString(16)} contains ${bad.name}`; break; }
    let cut = t.ops.length;
    for (let i = 0; i < t.ops.length - 1; i++) {
      const fa = fallArena(t.ops[i]);
      if (fa === null) continue;
      if (fa !== blk.prog.arenaBase + (t.ops[i + 1].at << 2)) { cut = i + 1; break; }
    }
    const tops = t.ops.slice(0, cut);
    const truncated = cut < t.ops.length;
    const endWord = truncated ? t.ops[cut].at : t.nextWord;
    if (ops.length + tops.length > maxOps) { stop = `over ${maxOps} ops`; break; }
    const last = tops[tops.length - 1];
    // Every block in a straight region must END IN A TRANSFER the builder can
    // publish an ip from -- the region leaves through its last op's $gip, so
    // a block that ends on a bad handler or a slice boundary cannot be last,
    // and the walk stops BEFORE it.
    const isCall = /^call_rel(32)?$/.test(last.name);
    const isRet = /^ret(32)?$/.test(last.name);
    const at = TAKEN_AT.get(last.fn);
    if (!isCall && !isRet && ((!truncated && !/^jmp(_syn)?$/.test(t.end)) || at === undefined)) {
      stop = `0x${cur.toString(16)} ends ${t.end}, not a transfer`; break;
    }
    seen.add(key);
    heads.push(blk);
    if (headIp === null) headIp = blk.ip;
    for (const op of tops) { ops.push(op); nexts.push(fallThroughIp(op)); }
    spans.push([cur, cur + ((endWord - ((cur - blk.prog.arenaBase) >> 2)) << 2)]);
    let next = null;
    if (isCall) {
      if (retStack.length >= maxDepth) { stop = `calls nested deeper than ${maxDepth}`; break; }
      retStack = [...retStack, { ip: last.args[2], arena: last.args[3] }];
      next = [last.args[0], last.args[1]];
    } else if (isRet) {
      if (!retStack.length) { stop = `${last.name} with no inlined call to return to`; break; }
      retStack = retStack.slice();
      const frame = retStack.pop();
      next = [frame.arena, frame.ip];
    } else {
      const edges = [[last.args[at - 1], last.args[at]]];
      const fa = fallArena(last), fi = fallThroughIp(last);
      if (fa !== null && fi !== null && fa !== last.args[at - 1]) edges.push([fa, fi]);
      // The hotter edge, by the profile; the taken edge on a tie, as chainFrom.
      edges.sort((a, b) => heat(b[0]) - heat(a[0]));
      next = edges[0];
    }
    nexts[nexts.length - 1] = next[1];
    if (next[0] === head && !retStack.length) { closed = true; headIp = next[1]; break; }
    cur = next[0];
  }
  if (!ops.length) { why(`0x${head.toString(16)}: ${stop}`); return null; }
  if (!closed) why(`0x${head.toString(16)}: straight, ${ops.length} ops over ${heads.length} block(s), stops: ${stop}`);
  return { ops, nexts, spans, heads, headIp, closed };
}

// `state` persists across calls so the picker can be asked for the NEXT region:
// `tried` holds every candidate head already walked (a walk is deterministic,
// so retrying one is only cost), and `taken` holds every block an installed
// region absorbed, so a later region cannot be built over the same code.
function pickRegion(rr, ranked, minOps, maxOps = 400, state = { tried: new Set(), taken: new Set() }) {
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

  const { tried, taken } = state;
  const heatByAddr = new Map(ranked.map(x => [x.addr, x.samples]));
  const heat = (arena) => heatByAddr.get(arena) || 0;
  for (const b of ranked) {
    if (taken.has(b.addr)) continue;
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
    // Under `--straight`, every candidate is tried as a LOOP before any is
    // tried as a trace: ASYLUM'95's hottest block does not close, and the
    // trace from it -- 328 ops at 1.06x -- was picked before the 9-op loop at
    // 2.0x that its own branch targets, which is what the second pass finds.
    const straight = flag('straight') || arg('straight') !== undefined;
    const modes = arg('straight') === 'greedy' ? ['trace'] : straight ? ['loop', 'trace'] : ['loop'];
    // EVERY candidate is walked and the one with the most samples wins,
    // rather than the first that closes. The hottest block's own address is
    // tried first, and a block whose terminator jumps BACK to an earlier
    // head closes from its own address too -- as the body of the loop that
    // wraps it. ADDY_II's hottest block is ac..b3, ending in `loop a1`; from
    // ac the walk closed a 62-op region through the whole nest below, with
    // the a1..ac loop -- the one the block is actually in -- as an exit and
    // re-entry on every one of its iterations (348409 entries at 0.5
    // iterations each, -0.5%). From a1 the same nest is an inner structure.
    for (const mode of modes) {
    const found = [];
    for (const h of cands) {
      const tkey = mode === 'loop' ? h : `t${h}`;
      if (tried.has(tkey) || taken.has(h)) continue;
      tried.add(tkey);
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
      // `--straight`: a loop where one closes, a trace where none does. The
      // greedy walk alone is `--straight=greedy`, and it is the worse JIT:
      // from ASYLUM'95's hottest block it followed the hot edges into a
      // 328-op trace at 1.06x over the bytes where the closing walk finds a
      // 9-op loop at 2.0x -- +0.2% against +20% on the same program.
      const chains = mode === 'loop'
        ? [flag('fall-first-only') ? null : chainFrom(h, headByAddr, traceAt, maxOps, why),
           flag('no-fall-first') ? null : chainFrom(h, headByAddr, traceAt, maxOps, why, 3, 3000, { fallFirst: true })]
        : [traceFrom(h, headByAddr, traceAt, maxOps, why, heat)];
      for (const chain of chains) {
      if (!chain) continue;
      if (chain.ops.length < minOps) {
        why(`0x${h.toString(16)}: ${chain.ops.length} ops < ${minOps}`);
        continue;
      }
      // A walk may start outside every installed region and still run THROUGH
      // one: ADDY_II's second pick was a 47-op chain over the same nest as its
      // first, and six such regions summed to 391% of samples and 1039 extra
      // handbacks. Two regions over one block would also both claim its
      // entry, and only one can own it.
      if (chain.heads.some(hb => taken.has(hb.addr))) {
        why(`0x${h.toString(16)}: overlaps a region already picked`);
        continue;
      }
      // ...and the arena test alone is not enough, for the same reason the
      // share is measured in guest bytes below: the interpreter holds several
      // arena copies of one loop, so a second walk over ADDY_II's nest from
      // another entry shares no arena block with the first and still compiles
      // the same guest bytes twice (three such regions read 196% of samples).
      // The guest extents of the region's blocks are the durable identity.
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
      const clash = (state.ranges || []).find(r => r.cs === blk.cs
        && ranges.some(([lo, hi]) => lo < r.hi && hi > r.lo));
      if (clash) {
        why(`0x${h.toString(16)}: guest bytes ${blk.cs.toString(16)}:${clash.lo.toString(16)}-`
          + `${clash.hi.toString(16)} already belong to the region at 0x${clash.head.toString(16)}`);
        continue;
      }
      // A sampled block is credited to ONE region -- the first that claims
      // it -- so the shares of several regions add up to the share of their
      // union, which is what the composed ceiling in main() multiplies.
      const credited = state.credited || new Set();
      const mine = ranked.filter(x => {
        if (credited.has(x.addr)) return false;
        if (chain.spans.some(([a, e]) => x.addr >= a && x.addr < e)) return true;
        if (x.cs !== blk.cs) return false;
        const [lo, hi, targets] = guestExtent(x);
        return ranges.some(([rlo, rhi]) => lo < rhi && hi > rlo) || targets.some(inRegion);
      });
      const samples = mine.reduce((n, x) => n + x.samples, 0);
      why(`share: region guest ${blk.cs.toString(16)}:${glo.toString(16)}-${ghi.toString(16)}; `
        + `top sampled blocks ${ranked.slice(0, 6).map(x => {
          const [lo, hi] = guestExtent(x);
          return `${x.cs.toString(16)}:${lo.toString(16)}-${hi.toString(16)} x${x.samples}`;
        }).join(', ')}`);
      why(`0x${h.toString(16)}: candidate region at ip 0x${chain.headIp.toString(16)}, ${chain.ops.length} ops, ${samples} samples, ${chain.inRegionExits || 0} in-region exit(s)${chain.policy ? ', ' + chain.policy : ''}`);
      found.push({ pick: { block: blk, cs: blk.cs, ops: chain.ops, nexts: chain.nexts,
        blocks: chain.spans.length, heads: chain.heads, headIp: chain.headIp, samples,
        closed: chain.closed !== false, inner: chain.inner || [], forwards: chain.forwards || [], opIp: chain.opIp || [] }, mine, ranges, blk, chain });
      }
    }
    if (!found.length) continue;
    found.sort((x, y) => y.pick.samples - x.pick.samples
      || (x.chain.inRegionExits || 0) - (y.chain.inRegionExits || 0)
      || x.pick.ops.length - y.pick.ops.length);
    const { pick, mine, ranges, blk, chain } = found[0];
    const credited = state.credited || (state.credited = new Set());
    for (const x of mine) credited.add(x.addr);
    (state.ranges || (state.ranges = [])).push(...ranges.map(([lo, hi]) =>
      ({ cs: blk.cs, lo, hi, head: chain.headIp })));
    for (const hb of chain.heads) taken.add(hb.addr);
    taken.add(b.addr);
    return pick;
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
    if (!known.includes(p)) throw new Error(`unknown pass ${p}; known: ${known.join(', ')}`);
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

// Which forward branches can be wasm blocks. A block opens before the branch
// -- or before the head of any loop the branch sits in and the target does
// not, so the br leaves that loop too -- and closes just before the target
// op. One that would cut across a loop or another block is dropped and stays
// the exit it was. Shared by the picker (to price a candidate head) and the
// builder (to emit).
function planForwards(inner, forwards) {
  const spans = [], kept = [], dropped = [];
  const nestsWith = (lo, hi, a, b) => b < lo || a >= hi || (a >= lo && b < hi) || (a < lo && b >= hi);
  for (const f of forwards) {
    // A detour joining the head or an inner head needs no block of its own.
    if (f.kind && f.kind !== 'fwd') continue;
    let lo = f.op;
    const hi = f.targetOp;              // block covers ops lo .. hi-1
    for (const e of inner) if (e.headOp <= f.op && e.backOp < hi && e.backOp >= f.op) lo = Math.min(lo, e.headOp);
    const ok = inner.every(e => nestsWith(lo, hi, e.headOp, e.backOp))
      && spans.every(([a, b]) => nestsWith(lo, hi, a, b));
    if (!ok) { dropped.push(f); continue; }
    spans.push([lo, hi - 1]);
    kept.push({ ...f, lo, n: spans.length - 1 });
  }
  return { spans, kept, dropped };
}

const EXIT_SITES = [];   // --exit-census: one entry per `br $out` site, across regions

function buildRegion(rawOps, nexts, headIp, name, closed = true, inner = [], forwards = []) {
  prepareTables();
  // Detour arms ride behind the path's ops so the tiers see them as part of
  // one region (the same promoted registers, the same folded operands); each
  // one remembers where its ops start. The path is ops 0..mainLen-1.
  const mainLen = rawOps.length;
  nexts = nexts.slice();
  for (const f of forwards) {
    if (!f.detour) continue;
    f.start = rawOps.length;
    rawOps = rawOps.concat(f.detour.ops);
    nexts.push(...f.detour.nexts);
  }
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
  // Inner loops, by the op that opens them and the branch that closes them.
  // `try/finally` around the op so every `continue` still emits the close.
  const opensAt = new Map(), closesAt = new Map(), exitsAt = new Map();
  inner.forEach((e, n) => {
    if (!opensAt.has(e.headOp)) opensAt.set(e.headOp, []);
    opensAt.get(e.headOp).push(n);
    if (!closesAt.has(e.backOp)) closesAt.set(e.backOp, []);
    closesAt.get(e.backOp).push(n);
    if (e.exitOp !== undefined) exitsAt.set(e.exitOp, n);
  });
  // The inner loop (if any) whose head this branch's edge names.
  const closing = (i, ip) => (closesAt.get(i) || []).find(n => inner[n].headIp === ip);
  // Forward branches become `(block $f_n ...)` opened before the branch --
  // or before the head of any loop the branch sits in and the target does
  // not, so the br leaves that loop too -- and closed just before the
  // target op. One that would cut across a loop or another block is left
  // as the exit it was.
  const fwdOpen = new Map(), fwdClose = new Map(), fwdAt = new Map();
  const plan = planForwards(inner, forwards);
  const fwdSpans = plan.spans;
  const fwdDropped = plan.dropped.length;
  for (const f of plan.kept) {
    const n = f.n, lo = f.lo, hi = f.targetOp;
    if (!fwdOpen.has(lo)) fwdOpen.set(lo, []);
    fwdOpen.get(lo).push(n);
    if (!fwdClose.has(hi)) fwdClose.set(hi, []);
    fwdClose.get(hi).push(n);
    if (!fwdAt.has(f.op)) fwdAt.set(f.op, new Map());
    fwdAt.get(f.op).set(f.ip, n);
  }
  const innerBr = (n) => `(if ${okToLoop} (then (br $il_${n}))`
    + ` (else (global.set $gip (i32.const ${inner[n].headIp})) (br $out)))`;
  const headBr = `(if ${okToLoop} (then (br $again))`
    + ` (else (global.set $gip (i32.const ${headIp})) (br $out)))`;
  const exitTo = (ip) => `(global.set $gip (i32.const ${ip})) (br $out)`;
  // Detours, by the branch they hang off and the edge they cover.
  const detourAt = new Map();
  for (const f of forwards) {
    if (!f.detour) continue;
    if (!detourAt.has(f.op)) detourAt.set(f.op, new Map());
    detourAt.get(f.op).set(f.ip, f);
  }
  let detoursBuilt = 0;
  // THE ARM OF A DETOUR: its ops, then the join. Steps are billed inside the
  // arm before each of its transfers and before any label boundary, so the
  // skipping path pays nothing for it. A transfer inside the detour that will
  // not lower makes the whole arm null, and the edge stays the exit it was.
  //
  // The arm has the main path's structure in miniature. A transfer whose edge
  // names an EARLIER op of the arm is a back edge, and the ops between become
  // an inner loop `(block $dx (loop $dl ...))` with the same may-it-go-round
  // test as every other loop here; one that names a LATER op is a forward
  // branch and becomes `(block $df ...)` closed before its target. Without
  // either, a detour is one pass over the arm and out: ADDY_II's fall-first
  // pick put the whole L1 row body (`cld; mov; mov; cmp/jz; mov; cmp/ja; mov;
  // add; add; loop`) in a detour, and every row taking that arm ran ONE pixel
  // inside the region, left through the `jz` or the `loop`, and let the
  // interpreter draw the rest of the row -- 21,244 exits for 21,609 entries,
  // 49% absorbed, +20% against a +67% ceiling, with the frame IDENTICAL.
  // Anything that would cross a block boundary stays the exit it was.
  const detourArm = (f) => {
    const join = f.kind === 'head' ? headBr : f.kind === 'inner' ? innerBr(f.n)
      : (fwdAt.get(f.op) && fwdAt.get(f.op).has(f.ip)) ? `(br $f_${fwdAt.get(f.op).get(f.ip)})` : null;
    if (join === null) return null;
    const d = f.detour, id = f.start, ips = d.ips || [];
    const out = [`;; detour: ${d.ops.map(o => o.name).join(' ')} -> 0x${d.join.toString(16)}`];
    const n = d.ops.length;
    // Pass 1: lower every transfer and name each edge.
    const low = [];
    for (let k = 0; k < n; k++) {
      const idx = f.start + k, op = d.ops[k];
      if (!isTransfer(op)) { low.push(null); continue; }
      const c = splitBranch(t3.bodies3[idx]);
      if (c) { low.push({ cond: true, pre: c.pre, test: c.cond, edges: [c.thenIp, c.elseIp] }); continue; }
      const j = splitJump(t3.bodies3[idx]);
      if (j) { low.push({ cond: false, pre: j.pre, edges: [j.ip] }); continue; }
      return null;
    }
    const kindOf = (k, ip) => {
      const last = k === n - 1;
      if (ip === d.join) return { t: 'join' };
      if (!last && ip === nexts[f.start + k]) return { t: 'fall' };
      const j = ips.findIndex(x => x !== undefined && x === ip);
      if (j >= 0 && j <= k) return { t: 'loop', j };
      if (j > k) return { t: 'fwd', j };
      return { t: 'exit', ip };
    };
    // Pass 2: the structure. Loops are (head op, back op); forwards are
    // (branch op, target op), opened before the outermost loop the branch
    // sits in and the target does not. Anything that crosses is dropped to
    // the exit it was.
    const loops = [], fwds = [];
    const okLoop = (a, b) => loops.every(l => (b < l.a) || (a > l.b) || (a >= l.a && b <= l.b) || (a <= l.a && b >= l.b));
    for (let k = 0; k < n; k++) {
      const l = low[k]; if (!l) continue;
      for (const ip of l.edges) {
        const e = kindOf(k, ip);
        if (e.t === 'loop' && okLoop(e.j, k) && !loops.some(x => x.a === e.j && x.b === k)) loops.push({ a: e.j, b: k });
      }
    }
    for (let k = 0; k < n; k++) {
      const l = low[k]; if (!l) continue;
      for (const ip of l.edges) {
        const e = kindOf(k, ip);
        if (e.t !== 'fwd') continue;
        let lo = k, cross = false;
        for (const L of loops) {
          if (k >= L.a && k <= L.b && e.j > L.b) lo = Math.min(lo, L.a);          // leaves the loop: open outside it
          else if (!(k >= L.a && k <= L.b) && e.j > L.a && e.j <= L.b) cross = true; // lands inside a loop it is not in
        }
        if (cross) continue;
        if (fwds.some(x => (x.lo < lo && x.hi > lo && x.hi < e.j) || (lo < x.lo && e.j > x.lo && e.j < x.hi))) continue;
        if (!fwds.some(x => x.op === k && x.ip === ip)) fwds.push({ op: k, ip, lo, hi: e.j });
      }
    }
    const loopN = new Map(loops.map((l, i) => [`${l.a}:${l.b}`, i]));
    const fwdN = new Map(fwds.map((x, i) => [`${x.op}:${x.ip}`, i]));
    let owed = 0;
    const bill = () => {
      if (owed) out.push(`(global.set $steps (i32.sub (global.get $steps) (i32.const ${owed})))`);
      owed = 0;
    };
    const armOf = (k, ip) => {
      const e = kindOf(k, ip);
      if (e.t === 'join') return join;
      if (e.t === 'fall') return '';
      if (e.t === 'loop') {
        const l = loops.find(x => x.a === e.j && x.b === k);
        if (!l) return exitTo(ip);
        return `(if ${okToLoop} (then (br $dl_${id}_${loopN.get(`${l.a}:${l.b}`)}))`
          + ` (else ${exitTo(ip)}))`;
      }
      if (e.t === 'fwd' && fwdN.has(`${k}:${ip}`)) return `(br $df_${id}_${fwdN.get(`${k}:${ip}`)})`;
      return exitTo(ip);
    };
    for (let k = 0; k < n; k++) {
      const idx = f.start + k, op = d.ops[k], last = k === n - 1;
      const closeF = fwds.filter(x => x.hi === k), openL = loops.filter(x => x.a === k), openF = fwds.filter(x => x.lo === k);
      if (closeF.length || openL.length || openF.length) bill();
      for (const x of closeF) out.push(`) ;; end detour forward ${fwdN.get(`${x.op}:${x.ip}`)}`);
      for (const x of openL.sort((p, q) => q.b - p.b)) out.push(`(block $dx_${id}_${loopN.get(`${x.a}:${x.b}`)} (loop $dl_${id}_${loopN.get(`${x.a}:${x.b}`)}`);
      for (const x of openF.sort((p, q) => q.hi - p.hi)) out.push(`(block $df_${id}_${fwdN.get(`${x.op}:${x.ip}`)}`);
      owed++;
      const l = low[k];
      if (!l) { out.push(resolveGoArena(t3.bodies3[idx])); }
      else {
        bill();
        out.push(l.pre);
        if (l.cond) {
          const a = armOf(k, l.edges[0]), b = armOf(k, l.edges[1]);
          if (last && a === '' || last && b === '') return null;
          out.push(`(if ${l.test}\n  (then ${a})\n  (else ${b}))`);
        } else {
          const a = armOf(k, l.edges[0]);
          if (last && a === '') return null;
          if (a) out.push(a);
        }
      }
      for (const x of loops.filter(x => x.b === k)) out.push(`)) ;; end detour loop ${loopN.get(`${x.a}:${x.b}`)}`);
      if (last && !l) { bill(); out.push(join); }
    }
    detoursBuilt++;
    // The arm sits inside `(then ...)`: it must not END with a comment, or
    // the paren that closes the `then` is swallowed by it.
    return out.join('\n') + '\n';
  };
  for (const [i, op] of ops.slice(0, mainLen).entries()) {
    // Steps still owed are billed before any label boundary, not only before
    // a branch: a `br` over a forward block skips the ops inside it, and a
    // bill deferred past the block's end would charge them on the skipping
    // path too (ADDY_II's 7-op pixel loop stopped at a different instruction
    // from the interpreter for exactly that). A loop head is the same case
    // from the other side -- ops before it must not be re-billed per pass.
    if (pending && (fwdClose.has(i) || opensAt.has(i))) {
      parts.push(`(global.set $steps (i32.sub (global.get $steps) (i32.const ${pending})))`);
      pending = 0;
    }
    // Forward blocks ending here close before anything opens here.
    for (const n of fwdClose.get(i) || []) parts.push(`) ;; end forward block ${n}`);
    // Outermost first: entries are pushed in walk order, and an outer loop's
    // head is walked before an inner one's. A forward block that starts at
    // a loop head opens inside the loop (it ends before the loop does).
    for (const n of opensAt.get(i) || []) parts.push(`(block $ix_${n} (loop $il_${n}`);
    for (const n of (fwdOpen.get(i) || []).slice().sort((a, b) => fwdSpans[b][1] - fwdSpans[a][1])) parts.push(`(block $f_${n}`);
    try {
    pending++;
    const isLast = i === mainLen - 1;
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
      const cont = isLast && !closesAt.has(i) && !exitsAt.has(i) ? headIp : nexts[i];
      const ex = exitsAt.get(i);
      // The exit of a top-tested inner loop leaves its block; when that
      // exit is also the region's closing edge (the walk ended there) it is
      // the outer back edge instead.
      // An edge that closes an inner loop is tested FIRST: the walk records
      // the inner head as the branch's continuation when both of its edges
      // are back edges, and "continues to the next op" would fall out of
      // the loop instead of taking it (ADDY_II: 348409 entries at 0.5
      // iterations each, -1.4%, with the whole nest compiled).
      const fw = fwdAt.get(i), dt = detourAt.get(i);
      const detourMemo = new Map();
      const detour = (ip) => {
        if (!dt || !dt.has(ip)) return null;
        if (!detourMemo.has(ip)) detourMemo.set(ip, detourArm(dt.get(ip)));
        return detourMemo.get(ip);
      };
      const act = (ip) => (closing(i, ip) !== undefined ? innerBr(closing(i, ip))
        : ip === cont && !isLast ? ''
        : detour(ip) !== null ? detour(ip)
        : fw && fw.has(ip) ? `(br $f_${fw.get(ip)})`
        : ip === headIp ? `(if ${okToLoop} (then (br $again))`
          + ` (else (global.set $gip (i32.const ${ip})) (br $out)))`
        : ex !== undefined && ip === inner[ex].exitIp && !isLast ? `(br $ix_${ex})`
          : `(global.set $gip (i32.const ${ip})) (br $out)`);
      if (lowered.thenIp !== cont && lowered.elseIp !== cont && !isLast) {
        return { declined: `${op.name} continues to ${cont} which is neither of its edges` };
      }
      parts.push(lowered.pre);
      const thenAct = act(lowered.thenIp), elseAct = act(lowered.elseIp);
      parts.push(`(if ${lowered.cond}\n  (then ${thenAct})\n  (else ${elseAct}))`);
      exits += (thenAct.includes('$out') ? 1 : 0) + (elseAct.includes('$out') ? 1 : 0);
      continue;
    }
    // splitJump runs second and overwrites the reason, so keep splitBranch's --
    // for a CONDITIONAL transfer that is the interesting one, and "jump: ..."
    // is just the unconditional path declining a two-armed body.
    const branchWhy = lastSplitWhy;
    const jump = (branch && !flag('no-lower')) ? splitJump(t3.bodies3[i]) : null;
    if (jump) {
      const cont = isLast && !closesAt.has(i) ? headIp : nexts[i];
      // A straight region ends where its walk stopped, so its last jump is an
      // exit like any other: publish the ip and fall out through the back-edge
      // test, which cannot pass because the ip is not the head.
      if (isLast && !closed && jump.ip !== headIp) {
        parts.push(jump.pre);
        parts.push(`(global.set $gip (i32.const ${jump.ip}))`);
        continue;
      }
      if (jump.ip !== cont) return { declined: `${op.name} goes to ${jump.ip}, not ${cont}` };
      parts.push(jump.pre);
      if (closing(i, jump.ip) !== undefined) {
        parts.push(innerBr(closing(i, jump.ip)));
      } else if (jump.ip === headIp) {
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
    } finally {
      // A branch that could not be lowered leaves through `(br $out)` above,
      // so closing the inner loop after it is dead code, but it must still
      // close for the wasm to validate.
      for (const n of closesAt.get(i) || []) parts.push(`)) ;; end inner loop ${n}`);
    }
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
  const entry = flag('no-entry-refund') ? ';; --no-entry-refund' : '(global.set $steps (i32.add (global.get $steps) (i32.const 1)))';
  // `--trap` replaces the whole body with `unreachable`. It answers the one
  // question no A/B on the body can: is this region being ENTERED at all. A run
  // that finishes normally with it on has never dispatched the region -- and
  // every measurement of that region is a measurement of something else.
  // `--exit-census`: count every `br $out` site, in the top slots of the
  // dispatch histogram (the handler indices grow from the bottom). Read back
  // by `--trips`. It is what says WHICH exit is draining a region whose
  // share is high and whose absorption is not.
  let inner_parts = parts.join('\n');
  if (flag('exit-census')) {
    inner_parts = inner_parts.replace(/(\(global\.set \$gip \(i32\.const (\d+)\)\) )?\(br \$out\)/g, (m, g, ip) => {
      const site = EXIT_SITES.length;
      EXIT_SITES.push({ region: name, ip: ip === undefined ? null : Number(ip) });
      const addr = isa.HIST_BASE + (isa.HIST_SLOTS - 1 - site) * 4;
      return `(i32.store (i32.const ${addr}) (i32.add (i32.load (i32.const ${addr})) (i32.const 1))) ${m}`;
    });
  }
  // `--step-audit`: does the region charge $steps exactly one per x86
  // instruction it retires (two for a fused pair)? Every charge in the body
  // is mirrored into one histogram slot and every op's weight into another;
  // `--trips` prints both. Unequal means the region itself; equal moves the
  // question to the dispatch into it.
  if (flag('step-audit')) {
    const chargeAddr = isa.HIST_BASE + (isa.HIST_SLOTS - 200) * 4;
    const weightAddr = chargeAddr + 4;
    const bump = (addr, n) => `(i32.store (i32.const ${addr}) (i32.add (i32.load (i32.const ${addr})) (i32.const ${n})))`;
    inner_parts = inner_parts.replace(/\(global\.set \$steps \(i32\.sub \(global\.get \$steps\) \(i32\.const (\d+)\)\)\)/g,
      (m, n) => `${bump(chargeAddr, Number(n))} ${m}`);
    inner_parts = inner_parts.replace(/\(global\.set \$steps \(i32\.add \(global\.get \$steps\) \(i32\.const 1\)\)\)/g,
      (m) => `${bump(chargeAddr, -1)} ${m}`);
    inner_parts = inner_parts.replace(/^;; ([a-z0-9_]+)$/gm,
      (m, nm) => `${m}\n${bump(weightAddr, nm === 'jmp_syn' ? 0 : /_j[a-z]+(_t)?(_spin)?$/.test(nm) ? 2 : 1)}`);
  }
  const body = flag('trap') ? '(unreachable)'
    : `${entry}\n${t3.pro}\n(block $out (loop $again\n${inner_parts}\n))\n${t3.epi}\n${leave}`;
  return {
    name, body, locals: t3.locals, exits, unlowered, unloweredWhy, fwdKept: fwdSpans.length, fwdDropped, detours: detoursBuilt,
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
// The guest ips a region can leave to, and which of them are safe to hand the
// compiler at install time. Its own function because the LIVE jit installs
// through the same door (tools/toyvm/region-live.js): every rule below was
// bought with a bisect, and a second copy of them in the live path would be a
// second policy that nobody re-measures.
function regionSuccessors(rr, pick, guarded) {
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
  const allSucc = successorIps(pick.ops.concat(...(pick.forwards || []).filter(f => f.detour).map(f => f.detour.ops)), succWhy)
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
  return { allSucc, succList, succBytes, succWhy, kept: new Set(succList) };
}

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
  const { runDos } = require('./run-dos');
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
  const r = await runDos({ exe, budget: o.budget, slice: o.slice, cpu: o.cpu, cpuMeter: true,
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
  // `--regions=N` asks for up to N regions, hottest first, each built over
  // code no earlier one absorbed. One is the historical default and what every
  // census before 2026-09-02 measured; the whole-program question -- what does
  // compiling EVERY hot loop buy -- is `--regions=8` or so. `--min-share=X`
  // skips a pick below X% of samples, which is the floor the census's ceiling
  // column exists to set.
  const maxRegions = Number(arg('regions', 1));
  const minShare = Number(arg('min-share', 0));
  const pickState = { tried: new Set(), taken: new Set() };
  const picks = [];
  for (let attempt = 0; attempt < maxRegions * 4 && picks.length < maxRegions; attempt++) {
    const p = pickRegion(rr, ranked, o.minOps, 400, pickState);
    if (!p) break;
    p.share = 100 * p.samples / total;
    if (p.share < minShare) {
      console.log(`  skipped region at 0x${p.headIp.toString(16)}: ${p.share.toFixed(1)}% share is below --min-share=${minShare}`);
      continue;
    }
    picks.push(p);
    console.log(`region at guest ip 0x${p.headIp.toString(16)}: `
      + `${p.blocks} block(s), ${p.ops.length} ops, ${p.share.toFixed(1)}% of samples`
      + (p.closed === false ? ' (straight)' : '')
      + (p.inner && p.inner.length ? ` (${p.inner.length} nested loop(s))` : '')
      + (p.forwards && p.forwards.length ? ` (${p.forwards.length} forward branch(es))` : ''));
  }
  if (!picks.length) { console.log('no self-loop region found'); process.exit(2); }
  const pick = picks[0];
  // `--dump-ops`: the picked region's op list with the walk's structure on
  // it -- where each nested loop opens, which branch closes it, which edge
  // leaves it -- so a region that does not iterate can be read rather than
  // re-derived from the emitted wasm.
  if (flag('dump-ops')) {
    for (const p of picks) {
      console.log(`ops of region at 0x${p.headIp.toString(16)} (${p.inner.length} nested):`);
      p.inner.forEach((e, n) => console.log(`  loop ${n}: ops ${e.headOp}..${e.backOp} head ip 0x${e.headIp.toString(16)}`
        + (e.exitOp !== undefined ? ` exit at op ${e.exitOp} to 0x${e.exitIp.toString(16)}` : '')));
      p.ops.forEach((op, i) => {
        const at = TAKEN_AT.get(op.fn);
        const marks = [];
        p.inner.forEach((e, n) => {
          if (e.headOp === i) marks.push(`open L${n}`);
          if (e.backOp === i) marks.push(`close L${n}`);
          if (e.exitOp === i) marks.push(`exit L${n}`);
        });
        (p.forwards || []).forEach((f) => {
          if (f.op === i) marks.push(`fwd 0x${f.ip.toString(16)} -> op ${f.targetOp}`);
        });
        const oip = (p.opIp || [])[i];
        if (flag('dump-words') && p.heads[0] && p.heads[0].prog.wordIp) {
          const m = p.heads[0].prog.wordIp; const near = [];
          for (let k = op.at - 2; k <= op.at + 4; k++) if (m.has(k)) near.push(`${k}:${m.get(k).toString(16)}`);
          console.log(`        at=${op.at} args=${op.args.length} wordIp near: ${near.join(' ')}`);
        }
        console.log(`  [${String(i).padStart(3)}] ${(oip !== undefined ? '@' + oip.toString(16) : '@?').padEnd(6)} ${op.name.padEnd(18)}`
          + (at !== undefined ? ` taken 0x${(op.args[at] || 0).toString(16)}` : '')
          + (fallThroughIp(op) !== null && fallThroughIp(op) !== undefined ? ` fall 0x${fallThroughIp(op).toString(16)}` : '')
          + (p.nexts[i] !== null && p.nexts[i] !== undefined ? ` next 0x${p.nexts[i].toString(16)}` : '')
          + (marks.length ? `   <- ${marks.join(', ')}` : ''));
      });
    }
  }

  // `--pick-only` stops here: profile, pick, report, exit. Nothing is built,
  // installed, compared or timed. It exists for tools/toyvm/region-why.js,
  // which asks which SHAPES the picker can reach across the corpus and has no
  // use for the run -- and paying for two whole-program runs and a wasm build
  // per program would have made that census too slow to run at all.
  if (flag('pick-only')) return;

  // Everything from the build to the successor list is per region. A decline
  // returns the exit code it used to exit with; main exits with the first one
  // only when NO region survives, so the single-region contract is unchanged.
  const prepareRegion = async (pick, idx) => {
  const share = pick.share;
  const region = buildRegion(pick.ops, pick.nexts, pick.headIp, `region_${idx}`, pick.closed !== false, pick.inner || [], pick.forwards || []);
  if (region.declined && !region.body) { console.log(`declined: ${region.declined}`); return { declined: 3 }; }
  console.log(`  ${region.exits} in-body exit(s), ${region.fwdKept || 0} forward branch(es) kept, ${region.fwdDropped || 0} dropped, ${region.detours || 0} detour arm(s), ${region.eaFolded} addresses folded, `
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
  if (flag('agree') && idx === 0) {
    // `--agree-ops=N` truncates the op list to its first N. It is the manual
    // form of the prefix walk below: once that has named a k, this prints the
    // full register and memory report for exactly that prefix.
    const n = Number(arg('agree-ops', pick.ops.length));
    await benchTiers(exe, snapshotFor(rr, pick), pick.ops.slice(0, n),
      { iters: Number(arg('agree-iters', 200)), reps: 1, passes: passSpec() });
    return { stop: true };
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
  if (flag('agree-bisect') && idx === 0) {
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
        return { stop: true };
      }
      if (flag('verbose')) {
        console.log(`  ops[0..${k}] agree (${op.name})  seed mem=${memHash(hot.memSnapshot)}`);
      }
    }
    console.log(`  all ${pick.ops.length} prefixes agree over ${iters} iterations`);
    return { stop: true };
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
    // An EXTRA region (anything past the primary pick under `--regions=N`)
    // is installed on the strength of the gate alone, so an inconclusive
    // gate is a decline for it: ASYLUM'95's fifth region at 0x760 -- 255 ops,
    // 32 exits, no register promotion, gate INCONCLUSIVE -- was entered 3404
    // times at 0.3 iterations per entry and added 3213 handbacks to a run
    // whose four other regions added none. The primary pick keeps the
    // single-region contract: it is installed and the whole-program run is
    // its measurement.
    if (!g.agree && branchy && idx > 0) {
      console.log('  DECLINED: an extra region needs a measured gate -- not installing (--no-gate overrides)');
      return { declined: 5 };
    }
    if ((!g.agree && !branchy) || (g.agree && ratio < gateAt)) {
      console.log(`  DECLINED: ${g.agree
        ? `${ratio.toFixed(2)}x is below the ${gateAt.toFixed(2)}x bar`
        : 'a region that computes something else is not faster'}`
        + ' -- not installing (--no-gate overrides)');
      return { declined: 5 };
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
    return { declined: 3 };
  }

  const guarded = guardBytes(rr, pick);
  if (!guarded && !flag('no-gate')) {
    console.log('  declined: a block of this region has no covered span, so its bytes'
      + ' cannot be guarded (--no-gate overrides)');
    return { declined: 3 };
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
  const { allSucc, succList, succBytes, succWhy, kept } = regionSuccessors(rr, pick, guarded);
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
  return { pick, region, guarded, succList, succBytes, gateRatio, share };
  };

  const prepared = [];
  let firstDecline = null;
  for (const [idx, p] of picks.entries()) {
    if (picks.length > 1) console.log(`-- region ${idx}: 0x${p.headIp.toString(16)}, ${p.share.toFixed(1)}%`);
    const got = await prepareRegion(p, idx);
    if (got.stop) return;
    if (got.declined) { if (firstDecline === null) firstDecline = got.declined; continue; }
    prepared.push(got);
  }
  if (!prepared.length) process.exit(firstDecline || 3);
  if (picks.length > 1) {
    console.log(`installing ${prepared.length} of ${picks.length} region(s): `
      + prepared.map(x => `0x${x.pick.headIp.toString(16)}`).join(' ')
      + `  (${prepared.reduce((n, x) => n + x.share, 0).toFixed(1)}% of samples)`);
  }
  const key = (x) => `${x.pick.cs}:${x.pick.headIp}`;
  const install = {
    jitRegions: flag('succ-only') ? null : prepared.map(x => x.region),
    // WHICH region, not where it sits in the table: only the built module knows
    // that, and it reports it as `vm.regionBase`. The ordinal is the position
    // in `jitRegions`, so both are built from the same list in the same order.
    regionAt: new Map(flag('succ-only') ? [] : prepared.map((x, i) => [key(x), i])),
    // Every guest ip a branch in the region names, so the decoder still walks
    // out of a block whose body it never decodes. Over-approximating is free:
    // an address that turns out to be unreachable just gets compiled and never
    // entered, which is what a decoder that guesses a fall-through already does.
    // `--succ-take=N` keeps only the first N of them, which is the bisector for
    // the claim above: CARRIE.EXE is frame-identical under `--no-succ` and
    // wrong with the full list, so over-approximating is NOT always free and
    // the list has to be cut down to the address that does it.
    regionSucc: new Map(flag('no-succ') ? [] : prepared.map(x => [key(x),
      x.succList.map(ip => (flag('succ-unchecked') ? ip : x.succBytes(ip)))])),
    // The guest bytes this region was compiled from, one entry per block the
    // walk covered. compile.js checks them before installing, so a program that
    // rewrites its own loop gets the decoder back instead of a stale region.
    regionBytes: new Map(prepared.map(x => [key(x), x.guarded || []])),
    // ...and those same bytes marked as compiled code, so a store into them
    // still trips the self-modify check. `--no-region-code-bits` is the A/B.
    regionCodeBits: !flag('no-region-code-bits'),
  };
  const share = prepared.reduce((n, x) => n + x.share, 0);
  // The composed ceiling: each region's share at its own gate ratio, summed.
  // Printed as one effective ratio so the line keeps the shape the census parses.
  const ceilingPct = prepared.reduce((n, x) =>
    n + (x.gateRatio ? (x.share / 100) * (1 - 1 / x.gateRatio) * 100 : 0), 0);
  const gateRatio = prepared.some(x => x.gateRatio !== null)
    ? (share > ceilingPct ? 1 / (1 - ceilingPct / share) : Infinity) : null;

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
    if (flag('why')) {
      // What the interpreter still dispatches with the region in, against
      // what it dispatched without: the difference is what the region
      // absorbed, and a region whose share says 98% while this says 30% is
      // being run around, not through.
      const histOf = (mem) => {
        const v = new Uint32Array(mem.buffer);
        const top = [];
        let sum = 0;
        // Handler slots only: the top of the table holds the --exit-census and
        // --step-audit counters.
        for (let i = 0; i < isa.HIST_SLOTS - 256; i++) { const n = v[(isa.HIST_BASE >> 2) + i]; sum += n; top.push([i, n]); }
        top.sort((a, b) => b[1] - a[1]);
        return { sum, top: top.slice(0, 10).map(([i, n]) => `${(HANDLERS[i] || {}).name || ('#' + i)} x${n}`).join(', ') };
      };
      const hb = await once(exe, o, { hist: 1 });
      const a = histOf(hb.r.vm.mem), b = histOf(h.r.vm.mem);
      console.log(`  hist baseline: ${a.sum} dispatches: ${a.top}`);
      console.log(`  hist region:   ${b.sum} dispatches (${(100 * (1 - b.sum / Math.max(1, a.sum))).toFixed(1)}% absorbed): ${b.top}`);
      if (arg('hist-diff')) {
        // Every handler whose dispatch count moved, most-moved first: what the
        // region took over and, just as telling, what the interpreter now
        // runs that it did not before (a synthetic jump into the region, a
        // block cut where none was).
        const va = new Uint32Array(hb.r.vm.mem.buffer), vb = new Uint32Array(h.r.vm.mem.buffer);
        const rows = [];
        for (let i = 0; i < isa.HIST_SLOTS; i++) {
          const x = va[(isa.HIST_BASE >> 2) + i], y = vb[(isa.HIST_BASE >> 2) + i];
          if (x !== y) rows.push([(HANDLERS[i] || {}).name || ('#' + i), x, y]);
        }
        rows.sort((p, q) => Math.abs(q[2] - q[1]) - Math.abs(p[2] - p[1]));
        const n = Number(arg('hist-diff'));
        for (const [nm, x, y] of rows.slice(0, n > 1 ? n : 40)) console.log(`    ${nm.padEnd(22)} ${String(x).padStart(9)} -> ${String(y).padStart(9)}  (${y >= x ? '+' : ''}${y - x})`);
      }
    }
    for (const [i, x] of prepared.entries()) {
      const entries = u32[(isa.HIST_BASE >> 2) + h.r.vm.regionBase + i];
      const iters = (x.share / 100) * h.dispatched / x.pick.ops.length;
      console.log(`  ${prepared.length > 1 ? `region ${i} (0x${x.pick.headIp.toString(16)}): ` : ''}`
        + `${entries} region entries, ~${(iters / Math.max(1, entries)).toFixed(1)}`
        + ` iterations per entry (estimated from the ${x.share.toFixed(1)}% share)`);
    }
    if (flag('step-audit')) {
      const base = (isa.HIST_BASE >> 2) + isa.HIST_SLOTS - 200;
      console.log(`  step audit: regions charged ${u32[base]} steps for ${u32[base + 1]} instruction weights`);
    }
    if (flag('exit-census')) {
      const rows = EXIT_SITES.map((e, k) => ({ ...e, n: u32[(isa.HIST_BASE >> 2) + isa.HIST_SLOTS - 1 - k] }))
        .filter(e => e.n > 0).sort((a, b) => b.n - a.n);
      for (const e of rows) console.log(`  exit ${e.region} -> ${e.ip === null ? 'computed' : '0x' + e.ip.toString(16)}: ${e.n}`);
    }
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
  // `--peek-ds=OFF,OFF`: the guest's own counters at the stop, per arm. A
  // frame hash cannot see a ~1-step-per-entry accounting error (a demo holds
  // one picture for tens of thousands of dispatches); a row counter can.
  if (arg('peek-ds')) {
    const offs = String(arg('peek-ds')).split(',').map(Number);
    for (const [tag, run] of [['baseline', baseRun], ['region', jitRun]]) {
      const ex = run.r.vm.exports, mem = new Uint8Array(run.r.vm.mem.buffer);
      const dsb = ex.get_dsb();
      const w = (off) => mem[dsb + off] | (mem[dsb + off + 1] << 8);
      console.log(`  peek ${tag} (${run.dispatched} dispatches, stop ${run.cs.toString(16)}:${run.ip.toString(16)}):`
        + ` ${offs.map(o => `ds:${o}=${w(o)}`).join(' ')} cx=${ex.get_cx()} di=${ex.get_di()} si=${ex.get_si()}`);
    }
  }
  // `--peek-block=0xIP,...`: the arena words the LAST compile of each arm
  // left at a guest ip, as handler names. It is how "the interpreter stopped
  // dispatching X" (from --hist-diff) turns into the words that replaced it.
  if (arg('peek-block')) {
    const { ARITY } = require('./emit');
    const ips = String(arg('peek-block')).split(',').map(Number);
    for (const [tag, run] of [['baseline', baseRun], ['region', jitRun]]) {
      const r = run.r, u32 = new Uint32Array(r.vm.mem.buffer);
      for (const ip of ips) {
        const slot = isa.jhash(run.cs, ip) * 4;
        const arena = r.jtab[slot] === ip && r.jtab[slot + 1] === (run.cs & 0xFFFF) ? r.jtab[slot + 2] : 0;
        if (!arena) { console.log(`  peek-block ${tag} ${run.cs.toString(16)}:${ip.toString(16)}: not in the block table`); continue; }
        const parts = [];
        let w = arena >> 2;
        for (let n = 0; n < 12; n++) {
          const fn = u32[w];
          const h = HANDLERS[fn];
          const ar = h ? ARITY[fn] : 0;
          parts.push(`${h ? h.name : '#' + fn}${ar ? '(' + Array.from({ length: ar }, (_, k) => u32[w + 1 + k]).map(v => '0x' + (v >>> 0).toString(16)).join(',') + ')' : ''}`);
          if (!h || /^(jmp|ret|end|loop)|_j[a-z]+(_t)?$|^j[a-z]+$/.test(h.name) || fn >= (r.vm.regionBase || 1e9)) break;
          w += 1 + ar;
        }
        console.log(`  peek-block ${tag} ${run.cs.toString(16)}:${ip.toString(16)} @0x${arena.toString(16)}: ${parts.join(' ')}`);
      }
    }
  }
  if (!same && !flag('no-rematch') && baseRun.dispatched !== jitRun.dispatched) {
    const { readFrame } = require('./run-dos');
    const { frameBytes } = require('./framebuffer');
    // frameBytes, not `.pixels`: a direct-colour VBE frame has no index plane
    // and reaching for that field would compare two undefineds and call every
    // frame identical.
    const px = (run) => frameBytes(readFrame(run.r.vm.mem, run.r.surface.geom));
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

module.exports = {
  pickRegion, buildRegion, guardBytes, regionSuccessors, snapshotFor, successorIps,
  passSpec, isTransfer,
};

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
