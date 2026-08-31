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
const { findHotTrace, readTrace, emitTier3 } = require('./trace-jit');
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
function chainFrom(head, headByAddr, traceAt, maxOps, why, maxDepth = 3) {
  const ops = [], nexts = [], spans = [];
  const seen = new Set();
  // The inlined call frames still open, innermost last. Only the return ADDRESS
  // is tracked -- the guest's own frame is built and torn down by the ops.
  const retStack = [];
  let cur = head;
  for (;;) {
    // A block may legitimately appear twice once calls are inlined (one helper
    // called from two places in the loop), so the revisit test is on the block
    // AND the call depth, not the block alone.
    const key = `${cur}@${retStack.length}`;
    if (seen.has(key)) { why(`0x${head.toString(16)}: walk revisited 0x${cur.toString(16)}`); return null; }
    seen.add(key);
    const blk = headByAddr.get(cur);
    if (!blk) { why(`0x${head.toString(16)}: 0x${cur.toString(16)} is not a block head`); return null; }
    const t = traceAt(blk);
    // `int` still ends the walk: it hands the machine to the host by design and
    // there is nothing to inline. `call` and `ret` do not, any more -- see
    // below.
    const bad = t.ops.find(o => /^(int|into)/.test(o.name));
    if (bad) { why(`0x${head.toString(16)}: 0x${cur.toString(16)} contains ${bad.name}`); return null; }
    for (const op of t.ops) { ops.push(op); nexts.push(fallThroughIp(op)); }
    spans.push([cur, cur + ((t.nextWord - ((cur - blk.prog.arenaBase) >> 2)) << 2)]);
    const last = t.ops[t.ops.length - 1];

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
      if (retStack.length >= maxDepth) { why(`0x${head.toString(16)}: calls nested deeper than ${maxDepth}`); return null; }
      retStack.push({ ip: last.args[2], arena: last.args[3] });
      nexts[nexts.length - 1] = last.args[1];
      cur = last.args[0];
      if (!headByAddr.has(cur)) { why(`0x${head.toString(16)}: callee 0x${(cur >>> 0).toString(16)} is not a block head`); return null; }
      if (ops.length > maxOps) { why(`0x${head.toString(16)}: over ${maxOps} ops without closing`); return null; }
      continue;
    }
    // ...and the matching return is the same edge run backwards. `ret` reads
    // its target off the guest stack, so unlike a branch it has no operand to
    // read it from -- the walk supplies it, and the exit test that follows is
    // exactly the guard that makes that safe: a callee that returned somewhere
    // else leaves the region instead of being believed.
    if (/^ret(32)?$/.test(last.name)) {
      const frame = retStack.pop();
      if (!frame) { why(`0x${head.toString(16)}: ${last.name} with no inlined call to return to`); return null; }
      nexts[nexts.length - 1] = frame.ip;
      cur = frame.arena;
      if (cur === head) return { ops, nexts, spans, headIp: frame.ip };
      if (!headByAddr.has(cur)) { why(`0x${head.toString(16)}: return to 0x${(cur >>> 0).toString(16)} is not a block head`); return null; }
      if (ops.length > maxOps) { why(`0x${head.toString(16)}: over ${maxOps} ops without closing`); return null; }
      continue;
    }
    if (t.end !== 'jmp') { why(`0x${head.toString(16)}: 0x${cur.toString(16)} ends ${t.end}, not jmp`); return null; }
    const at = TAKEN_AT.get(last.fn);
    if (at === undefined) { why(`0x${head.toString(16)}: terminator ${last.name} has no edge tail`); return null; }
    // The terminator's arena target sits one slot in front of its guest ip.
    const tgt = last.args[at - 1];
    if (tgt === head && !retStack.length) return { ops, nexts, spans, headIp: last.args[at] };
    if (ops.length > maxOps) { why(`0x${head.toString(16)}: over ${maxOps} ops without closing`); return null; }
    if (!headByAddr.has(tgt)) {
      why(`0x${head.toString(16)}: ${last.name} leaves to 0x${(tgt >>> 0).toString(16)}, not a block head`);
      return null;
    }
    // Chaining on: control must be at the NEXT block's guest ip to stay in.
    nexts[nexts.length - 1] = last.args[at];
    cur = tgt;
  }
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
    for (const p of progs) for (const [, addr] of p.blocks) headByAddr.set(addr, { addr, prog: p, cs });
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
    for (const h of cands) {
      if (tried.has(h)) continue;
      tried.add(h);
      const blk = headByAddr.get(h);
      if (!blk) { why(`0x${h.toString(16)}: not a block head`); continue; }
      const chain = chainFrom(h, headByAddr, traceAt, maxOps, why);
      if (!chain) continue;
      if (chain.ops.length < minOps) {
        why(`0x${h.toString(16)}: ${chain.ops.length} ops < ${minOps}`);
        continue;
      }
      // The region's share is every sample inside the arena extents of its
      // blocks, not just the ones that landed on the head word.
      const samples = ranked.filter(x => chain.spans.some(([a, e]) => x.addr >= a && x.addr < e))
        .reduce((n, x) => n + x.samples, 0);
      return { block: blk, cs: blk.cs, ops: chain.ops, nexts: chain.nexts,
        blocks: chain.spans.length, headIp: chain.headIp, samples };
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

// Both guest edges of every branch in the region: the taken ip and, when the
// operand tail carries one, the fall-through ip.
// Anything that can publish a new $gip, which after call inlining is more than
// TAKEN_AT knows about: `ret` reads its target off the guest stack and so has no
// operand tail at all, and `call_rel` has one in a different shape.
function isTransfer(op) {
  return TAKEN_AT.has(op.fn) || /^(call_rel(32)?|ret(32)?)$/.test(op.name);
}

function successorIps(ops) {
  const out = new Set();
  for (const op of ops) {
    // A call names both its callee and its return point.
    if (/^call_rel(32)?$/.test(op.name)) { out.add(op.args[1]); out.add(op.args[2]); continue; }
    const at = TAKEN_AT.get(op.fn);
    if (at === undefined) continue;
    out.add(op.args[at]);
    const fall = fallThroughIp(op);
    if (fall !== null) out.add(fall);
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

function splitBranch(body) {
  // Last `(if` first: the transfer is the tail of the body, and anything
  // earlier belongs to the operation itself.
  const at = body.lastIndexOf('(if ');
  if (at < 0) return null;
  if (!balanced(body.slice(0, at))) return null;
  if (!balanced(body.slice(at))) return null;
  let j = at + 4;
  while (j < body.length && /\s/.test(body[j])) j++;
  const cond = sexpAt(body, j);
  if (cond === null) return null;
  let k = j + cond.length;
  while (k < body.length && /\s/.test(body[k])) k++;
  const thenArm = body[k] === '(' ? sexpAt(body, k) : null;
  if (thenArm === null) return null;
  let m = k + thenArm.length;
  while (m < body.length && /\s/.test(body[m])) m++;
  const elseArm = body[m] === '(' ? sexpAt(body, m) : null;
  if (elseArm === null) return null;
  const thenIp = GIP_SET.exec(thenArm);
  const elseIp = GIP_SET.exec(elseArm);
  if (!thenIp || !elseIp) return null;
  return { pre: body.slice(0, at), cond,
    thenIp: Number(thenIp[1]), elseIp: Number(elseIp[1]) };
}

// The same surgery on an unconditional transfer, which is the shape a `jmp`
// back to the loop head has. Its body is `<operands> (global.set $gip <lit>)
// (if <resolve> ...)`: everything from the $gip set onwards is the protocol,
// and everything before it is work the guest asked for -- which is why a
// `call_rel`, whose push and shadow-stack record come first, survives this cut
// with its frame intact.
function splitJump(body) {
  const m = GIP_SET.exec(body);
  if (!m) return null;
  if (/\(global\.set \$gip /.test(body.slice(m.index + m[0].length))) return null;
  if (!balanced(body.slice(0, m.index)) || !balanced(body.slice(m.index))) return null;
  return { pre: body.slice(0, m.index), ip: Number(m[1]) };
}

function buildRegion(ops, nexts, headIp, name) {
  prepareTables();
  // deadflags off: see the header. constprop and regfold are safe -- neither
  // reasons about what happens after the trace.
  // `--no-promote` keeps the registers in globals. It is a bisector, not a
  // tuning knob: it separates "the region's control flow is wrong" from "a
  // promoted register was read stale", which look identical from the outside.
  const t3 = emitTier3(ops, { constprop: true, regfold: true, deadflags: false,
    promote: !flag('no-promote') });
  const parts = [];
  let pending = 0;            // ops retired since $steps was last charged
  let exits = 0;
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
  const okToLoop = `(i32.and (i32.gt_s (global.get $steps) (i32.const 0))`
    + ` (i32.eqz (i32.or (global.get $halt) (global.get $smc))))`;
  const backEdge = `(br_if $again (i32.and (i32.and`
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
    parts.push(t3.bodies3[i]);
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
  const body = `${entry}\n${t3.pro}\n(block $out (loop $again\n${parts.join('\n')}\n))\n${t3.epi}\n${leave}`;
  return {
    name, body, locals: t3.locals, exits,
    promoted: t3.promoted, declined: t3.promoted ? null : t3.declined,
    eaFolded: t3.eaFolded, segFolded: t3.segFolded, folded: t3.folded,
  };
}

// --- running it -------------------------------------------------------------

async function once(exe, o, extra) {
  const t0 = performance.now();
  // `--entries` turns on run-dos's own handback census (which cs:ip the run
  // keeps leaving wasm at, and whether that address was in the jump table).
  // That census is the first thing to read when a region is slower than the
  // interpreter: the cost is nearly always round trips, not the body.
  const r = await runDos({ exe, budget: o.budget, slice: o.slice, cpu: o.cpu,
    autoKey: true, report: flag('entries'), log: () => {}, ...extra });
  if (flag('entries')) {
    const eh = [...r.entryHist].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  ${extra.jitRegions ? 'region ' : 'baseline'} entries: `
      + eh.map(([k, n]) => `${k} x${n}`).join(', '));
  }
  // Everything the corpus equivalence check compares, read while the instance
  // is still alive: the frame, the pixel count, the interrupt tally and the
  // stopping cs:ip. Wall clock and arena footprint are allowed to move.
  return { ms: performance.now() - t0, dispatched: r.dispatched, frame: r.frame,
    pixels: r.pixels, ints: r.ints, handbacks: r.handbacks,
    cs: r.vm.exports.get_cs(), ip: r.vm.exports.get_gip(), r };
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

  const region = buildRegion(pick.ops, pick.nexts, pick.headIp, 'region_0');
  if (region.declined && !region.body) { console.log(`declined: ${region.declined}`); process.exit(3); }
  console.log(`  ${region.exits} in-body exit(s), ${region.eaFolded} addresses folded, `
    + `${region.folded} register-file calls folded, `
    + (region.promoted ? `${region.promoted.length} values in locals: ${region.promoted.join(' ')}`
      : `NO register promotion -- ${region.declined}`));
  if (flag('dump')) {
    const f = `/tmp/region-${path.basename(exe)}.wat`;
    fs.writeFileSync(f, `(func $${region.name} ${region.locals}\n${region.body}\n)`);
    console.log(`  body written to ${f}`);
  }

  const install = {
    jitRegions: [region],
    // WHICH region, not where it sits in the table: only the built module knows
    // that, and it reports it as `vm.regionBase`.
    regionAt: new Map([[`${pick.cs}:${pick.headIp}`, 0]]),
    // Every guest ip a branch in the region names, so the decoder still walks
    // out of a block whose body it never decodes. Over-approximating is free:
    // an address that turns out to be unreachable just gets compiled and never
    // entered, which is what a decoder that guesses a fall-through already does.
    regionSucc: new Map([[`${pick.cs}:${pick.headIp}`, successorIps(pick.ops)]]),
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
  const base = [], jit = [];
  let baseRun = null, jitRun = null;
  for (let i = 0; i < o.reps; i++) {
    const first = i % 2 === 0;
    const a = first ? await once(exe, o, {}) : await once(exe, o, install);
    const b = first ? await once(exe, o, install) : await once(exe, o, {});
    const [bs, jt] = first ? [a, b] : [b, a];
    base.push(bs.ms); jit.push(jt.ms);
    baseRun = bs; jitRun = jt;
  }
  const min = (xs) => Math.min(...xs);
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
  console.log(`\n              dispatched  handbacks     min ms`);
  console.log(`  baseline    ${String(baseRun.dispatched).padStart(10)}  ${hb(baseRun)}  ${min(base).toFixed(1).padStart(9)}`);
  console.log(`  region      ${String(jitRun.dispatched).padStart(10)}  ${hb(jitRun)}  ${min(jit).toFixed(1).padStart(9)}`
    + `   ${((min(base) / min(jit) - 1) * 100).toFixed(1)}%`);
  console.log(`\n  frame ${same ? 'IDENTICAL' : '*** DIFFERS ***'}`
    + `  ints ${baseRun.ints}/${jitRun.ints}`
    + `  (baseline ${baseRun.frame} ${baseRun.pixels}px stop ${baseRun.cs.toString(16)}:${baseRun.ip.toString(16)}`
    + ` / region ${jitRun.frame} ${jitRun.pixels}px stop ${jitRun.cs.toString(16)}:${jitRun.ip.toString(16)})`);
  if (!same) process.exitCode = 4;
}

module.exports = { pickRegion, buildRegion };

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
