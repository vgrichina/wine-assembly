// ═══════════════════════════════════════════════════════════════
// tools/watx-rejection-pairs.js — a NEGATIVE test for every WATX grammar rule.
//
// WHY THIS EXISTS
// ---------------
// The differential oracle next door (tools/watx-differential.js) can only ask
// about the part of the language wabt also speaks. WATX's own extensions — the
// region family above all — have no second implementation to be compared with,
// and their whole value is in what they REFUSE. `(data (region.addr $SPAN 0))`
// compiled cleanly until efba89ca and put bytes in a range the overlap sweep
// does not police; the rule was written, the diagnostic was written, and there
// was no test that would have noticed if either had been dropped.
//
// So this file is the other half of the oracle: a table of PAIRS. For each
// rule, one input that must COMPILE and one that must be REJECTED with a
// located error naming the rule. Two properties are asserted on every negative:
//
//   * the message contains the fragment the rule is about — a rejection for
//     the wrong reason is a rejection that will move when something unrelated
//     changes, and it tells the author nothing;
//   * `errorLine > 0` — a hard error with no location is half a diagnostic,
//     and the editor integration cannot use it at all.
//
// The POSITIVE half is not decoration. Nearly every one of these rules could be
// "enforced" by refusing everything, and the positive is what says the rule is
// a boundary rather than a wall. Several positives here are the exact spelling
// the design tells you to use instead of the rejected one.
//
// The tally is printed on purpose. "Every grammar rule has a negative test"
// is a claim about a COUNT, and a count that is not printed is a claim nobody
// checks.
//
// Usage:
//   const { PAIRS, runPairs } = require('./watx-rejection-pairs');
//   const report = runPairs();
//
// Also runnable directly:  node tools/watx-rejection-pairs.js [--only=RE]
// ═══════════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const { compile } = require(path.join(__dirname, 'watx.js'));

// Two pages, so a fixed region up to 0x20000 is inside the memory that exists
// at instantiation — the bound `checkPlaced` tests against.
const PRELUDE = '(memory 2 2)\n';

function build(src, opts = {}) {
  return compile(PRELUDE + src, new Map(), { mode: 'production', runtimeBuiltins: false, ...opts });
}

// ── The table ─────────────────────────────────────────────────────────────
// group   — which part of the grammar; only used for the printed tally
// rule    — one sentence, the rule this pair pins down
// good    — source that must compile
// bad     — source that must be refused
// says    — a fragment the refusal must contain
const PAIRS = [];
function pair(group, rule, good, bad, says) {
  PAIRS.push({ group, rule, good, bad, says });
}

// A well-formed declaration to hang other rules off.
const OK_FIXED = '(region.declare-fixed $R (base 0x10000) (size 0x100) (owner "test"))';
const OK_SPAN = '(region.declare-span $S (base 0x10000) (size 0x1000) (owner "the window $R lives in"))';

// ── region.floor / region.image-base ──────────────────────────────────────
pair('directives', 'region.floor is declared at most once',
  `(region.floor 0x1000)\n${OK_FIXED}`,
  `(region.floor 0x1000)\n(region.floor 0x2000)\n${OK_FIXED}`,
  'already declared');
pair('directives', 'region.floor takes exactly one operand',
  '(region.floor 0x1000)\n' + OK_FIXED,
  '(region.floor 0x1000 0x2000)\n' + OK_FIXED,
  'exactly one operand');
pair('directives', 'region.floor takes an integer literal',
  '(region.floor 4096)\n' + OK_FIXED,
  '(region.floor banana)\n' + OK_FIXED,
  'not an integer literal');
pair('directives', 'region.image-base is declared at most once',
  `(region.image-base 0x400000)\n${OK_FIXED}`,
  `(region.image-base 0x400000)\n(region.image-base 0x500000)\n${OK_FIXED}`,
  'already declared');
pair('directives', 'region.image-base takes exactly one operand',
  '(region.image-base 0x400000)\n' + OK_FIXED,
  '(region.image-base 0x400000 1)\n' + OK_FIXED,
  'exactly one operand');

// ── region.gap ────────────────────────────────────────────────────────────
pair('gap', 'a gap must carry a (reason "text") clause',
  '(region.gap 0x100 (reason "unknown, preserved"))\n(region.declare $A (size 0x40))',
  '(region.gap 0x100)\n(region.declare $A (size 0x40))',
  'needs a size and a (reason "text") clause');
pair('gap', 'the second clause must actually be (reason "…")',
  '(region.gap 0x100 (reason "documented"))\n(region.declare $A (size 0x40))',
  '(region.gap 0x100 (because "documented"))\n(region.declare $A (size 0x40))',
  '(reason "text")');
pair('gap', 'a zero-size gap advances nothing and is refused',
  '(region.gap 0x10 (reason "documented"))\n(region.declare $A (size 0x40))',
  '(region.gap 0 (reason "documented"))\n(region.declare $A (size 0x40))',
  'advances nothing');

// ── Declaration heads: names, duplicates, clause shape ────────────────────
pair('decl', 'a region name must be $-prefixed',
  OK_FIXED,
  '(region.declare-fixed R (base 0x10000) (size 0x100))',
  'expected a $-prefixed region name');
pair('decl', 'a region is declared once',
  OK_FIXED,
  `${OK_FIXED}\n(region.declare-fixed $R (base 0x11000) (size 0x100))`,
  'is already declared at');
pair('decl', 'clauses are lists, not bare operands',
  OK_FIXED,
  '(region.declare-fixed $R 0x10000 (size 0x100))',
  'unexpected bare operand');
pair('decl', 'an unknown clause is refused',
  OK_FIXED,
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (colour "blue"))',
  'unknown clause');
pair('decl', 'a clause appears at most once',
  OK_FIXED,
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (align 4) (align 8))',
  'duplicate (align ...) clause');
pair('decl', 'a one-operand clause takes exactly one operand',
  OK_FIXED,
  '(region.declare-fixed $R (base 0x10000) (size 0x100 0x200))',
  'takes exactly one operand');
pair('decl', 'a clause operand must be an integer literal',
  OK_FIXED,
  '(region.declare-fixed $R (base 0x10000) (size banana))',
  'is not an integer literal');
pair('decl', 'exactly one of (size N) / (end N) states the extent',
  OK_FIXED,
  '(region.declare-fixed $R (base 0x10000))',
  'needs exactly one of (size N) or (end N)');
pair('decl', 'stating BOTH size and end is refused too',
  '(region.declare-fixed $R (base 0x10000) (end 0x10100) (owner "test"))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (end 0x10100))',
  'needs exactly one of (size N) or (end N)');
pair('decl', '(end N) must be above (base N)',
  '(region.declare-fixed $R (base 0x10000) (end 0x10100))',
  '(region.declare-fixed $R (base 0x10000) (end 0x10000))',
  'is not above (base');
pair('decl', 'a region has a nonzero extent',
  OK_FIXED,
  '(region.declare-fixed $R (base 0x10000) (size 0))',
  'a region must have an extent');
pair('decl', 'a fixed region needs a (base N)',
  OK_FIXED,
  '(region.declare-fixed $R (size 0x100))',
  'needs a (base N) clause');
pair('decl', 'an allocated region may not pin its own base',
  '(region.declare $A (size 0x100))',
  '(region.declare $A (base 0x10000) (size 0x100))',
  '(base ...) is only for region.declare-fixed');
pair('decl', 'an allocated region has no absolute (end N)',
  '(region.declare $A (size 0x100))',
  '(region.declare $A (end 0x10100))',
  'which an allocated region does not have');
pair('decl', '(align N) must be a power of two',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (align 16))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (align 12))',
  'is not a power of two');
pair('decl', 'a base must respect its own alignment',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (align 0x1000))',
  '(region.declare-fixed $R (base 0x10010) (size 0x100) (align 0x1000))',
  'is not a multiple of its');
pair('decl', 'a region may not end past the memory that exists at instantiation',
  '(region.declare-fixed $R (base 0x1F000) (size 0x1000))',
  '(region.declare-fixed $R (base 0x1F000) (size 0x2000))',
  'past the');

// ── region.declare-derived ────────────────────────────────────────────────
const GUEST = '(region.declare-fixed $GUEST_BASE (base 0x1000) (size 0x1F000))';
pair('derived', 'a derived base is spelled (base (g2w 0xVA))',
  `${GUEST}\n(region.image-base 0x400000)\n(region.declare-derived $D (base (g2w 0x400100)) (size 0x100) (within $GUEST_BASE))`,
  `${GUEST}\n(region.image-base 0x400000)\n(region.declare-derived $D (base 0x1100) (size 0x100))`,
  'a derived base is spelled (base (g2w 0xVA))');
pair('derived', 'a derived region needs a base clause at all',
  `${GUEST}\n(region.declare-derived $D (base (g2w 0x400100)) (size 0x100) (within $GUEST_BASE))`,
  `${GUEST}\n(region.declare-derived $D (size 0x100))`,
  'needs a (base (g2w VA)) clause');
pair('derived', 'g2w needs a declared $GUEST_BASE',
  `${GUEST}\n(region.declare-derived $D (base (g2w 0x400100)) (size 0x100) (within $GUEST_BASE))`,
  '(region.declare-derived $D (base (g2w 0x400100)) (size 0x100) (within $GUEST_BASE))',
  'needs a declared $GUEST_BASE');
pair('derived', 'g2w needs a PINNED $GUEST_BASE, not an allocated one',
  `${GUEST}\n(region.declare-derived $D (base (g2w 0x400100)) (size 0x100) (within $GUEST_BASE))`,
  '(region.declare $GUEST_BASE (size 0x1000))\n(region.declare-derived $D (base (g2w 0x400100)) (size 0x100) (within $GUEST_BASE))',
  'needs a PINNED $GUEST_BASE');
pair('derived', 'a guest VA below the image base is refused',
  `${GUEST}\n(region.image-base 0x400000)\n(region.declare-derived $D (base (g2w 0x400100)) (size 0x100) (within $GUEST_BASE))`,
  `${GUEST}\n(region.image-base 0x400000)\n(region.declare-derived $D (base (g2w 0x100)) (size 0x100))`,
  'is below the image base');

// ── Spans ─────────────────────────────────────────────────────────────────
// This is the family the adversarial reviews keep landing on, so it gets the
// most pairs: a span is transparent to the overlap sweep, which makes every
// way of treating one as storage a silent hole rather than a loud one.
pair('span', 'a span must document what limit it stands for',
  OK_SPAN,
  '(region.declare-span $S (base 0x10000) (size 0x1000))',
  'needs an (owner "text") clause');
pair('span', 'a span takes no (align N)',
  OK_SPAN,
  '(region.declare-span $S (base 0x10000) (size 0x1000) (owner "x") (align 16))',
  'is not a span clause');
pair('span', 'a span takes no (within $R)',
  OK_SPAN,
  `${OK_FIXED}\n(region.declare-span $S (base 0x10000) (size 0x1000) (owner "x") (within $R))`,
  'is not a span clause');
pair('span', 'a span takes no (stride N (count N))',
  OK_SPAN,
  '(region.declare-span $S (base 0x10000) (size 0x1000) (owner "x") (stride 16 (count 256)))',
  'is not a span clause');
pair('span', 'region.addr on a span is refused at a nonzero offset',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x10))\n(export "f" (func $f))`,
  `${OK_SPAN}\n(func $f (result i32) (region.addr $S 0x10))\n(export "f" (func $f))`,
  'is a span');
pair('span', 'region.addr on a span is refused at offset ZERO as well',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0))\n(export "f" (func $f))`,
  `${OK_SPAN}\n(func $f (result i32) (region.addr $S 0))\n(export "f" (func $f))`,
  'is a span');
pair('span', 'a data segment may not be anchored to a span',
  `${OK_FIXED}\n(data (region.addr $R 0x10) "abc")`,
  `${OK_SPAN}\n(data (region.addr $S 0x10) "abc")`,
  'nothing checks a span for overlap');
pair('span', 'a data segment at span offset ZERO is refused too',
  `${OK_FIXED}\n(data (region.addr $R 0) "abc")`,
  `${OK_SPAN}\n(data (region.addr $S 0) "abc")`,
  'nothing checks a span for overlap');
pair('span', 'a span in a global initializer may not use region.addr',
  `${OK_FIXED}\n(global $G i32 (region.addr $R 0x10))`,
  `${OK_SPAN}\n(global $G i32 (region.addr $S 0x10))`,
  'is a span');
pair('span', 'the three legal span spellings still work',
  `${OK_SPAN}\n(global $A i32 (region.end $S))\n(global $B i32 (region.size $S))\n` +
  '(func $f (result i32) $S)\n(export "f" (func $f))',
  `${OK_SPAN}\n(func $f (result i32) (region.addr $S 4))\n(export "f" (func $f))`,
  'no interior to address');

// ── region.addr / region.size / region.end ────────────────────────────────
pair('addr', 'the region must be declared',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x10))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.addr $NOPE 0x10))\n(export "f" (func $f))`,
  'unknown region');
pair('addr', 'region.addr needs an offset operand',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x10))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R))\n(export "f" (func $f))`,
  'expected a constant offset operand');
pair('addr', 'the offset is a literal, not an expression',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x10))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R (i32.const 16)))\n(export "f" (func $f))`,
  'must be a non-negative integer literal');
pair('addr', 'the offset must name a byte inside the region',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0xFF))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x100))\n(export "f" (func $f))`,
  "runs past the region's");
pair('addr', 'the only extra clause is (span N)',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x10 (span 4)))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x10 (width 4)))\n(export "f" (func $f))`,
  'the only extra clause is (span N)');
pair('addr', '(span N) must be positive',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x10 (span 1)))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0x10 (span 0)))\n(export "f" (func $f))`,
  'must be a positive integer');
pair('addr', 'offset + span must fit inside the region',
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0xF0 (span 0x10)))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.addr $R 0xF0 (span 0x11)))\n(export "f" (func $f))`,
  "runs past the region's");
pair('addr', 'region.size takes no operand besides the region',
  `${OK_FIXED}\n(func $f (result i32) (region.size $R))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.size $R 4))\n(export "f" (func $f))`,
  'takes no operand besides the region');
pair('addr', 'region.end takes no operand besides the region',
  `${OK_FIXED}\n(func $f (result i32) (region.end $R))\n(export "f" (func $f))`,
  `${OK_FIXED}\n(func $f (result i32) (region.end $R 4))\n(export "f" (func $f))`,
  'takes no operand besides the region');

// ── Data segments ─────────────────────────────────────────────────────────
pair('data', 'a data offset is i32.const or (region.addr $R OFF)',
  '(data (i32.const 0x400) "abc")',
  '(data (f32.const 1.0) "abc")',
  'Active data requires an i32.const offset');
pair('data', 'a segment may not be anchored to (region.end $R)',
  `${OK_FIXED}\n(data (region.addr $R 0) "abc")`,
  `${OK_FIXED}\n(data (region.end $R) "abc")`,
  'is not an addressable');
pair('data', 'a segment may not be anchored to (region.size $R)',
  `${OK_FIXED}\n(data (region.addr $R 0) "abc")`,
  `${OK_FIXED}\n(data (region.size $R) "abc")`,
  'is not an addressable');
pair('data', "a segment's own payload length is bounds-checked against the region",
  `${OK_FIXED}\n(data (region.addr $R 0xFD) "abc")`,
  `${OK_FIXED}\n(data (region.addr $R 0xFE) "abc")`,
  "runs past the region's");

// ── Global initializers ───────────────────────────────────────────────────
pair('global', 'a region constant initializer must be i32',
  `${OK_FIXED}\n(global $G i32 (region.addr $R 0x10))`,
  `${OK_FIXED}\n(global $G i64 (region.addr $R 0x10))`,
  'which is an i32, not a');
pair('global', 'a non-region initializer must match the global type',
  '(global $G i32 (i32.const 5))',
  '(global $G i32 (f32.const 5.0))',
  'requires a i32.const initializer');
pair('global', 'a global is declared once',
  '(global $G i32 (i32.const 5))',
  '(global $G i32 (i32.const 5))\n(global $G i32 (i32.const 6))',
  "Duplicate global '$G'");
pair('global', 'a global has one of the four numeric types',
  '(global $G f64 (f64.const 5.0))',
  '(global $G v128 (i32.const 5))',
  'Unsupported global type');

// ── Set-level laws: within, overlap ───────────────────────────────────────
pair('law', '(within $R) must name a declared region',
  `${OK_FIXED}\n(region.declare-fixed $I (base 0x10000) (size 0x40) (within $R))`,
  `${OK_FIXED}\n(region.declare-fixed $I (base 0x10000) (size 0x40) (within $NOPE))`,
  'names no declared region');
pair('law', '(within $R) may not name itself',
  `${OK_FIXED}\n(region.declare-fixed $I (base 0x10000) (size 0x40) (within $R))`,
  '(region.declare-fixed $I (base 0x10000) (size 0x40) (within $I))',
  'names itself');
pair('law', 'a (within $R) region must actually be contained in $R',
  `${OK_FIXED}\n(region.declare-fixed $I (base 0x100C0) (size 0x40) (within $R))`,
  `${OK_FIXED}\n(region.declare-fixed $I (base 0x100C0) (size 0x80) (within $R))`,
  'is not contained in');
pair('law', 'two regions may not overlap',
  `${OK_FIXED}\n(region.declare-fixed $B (base 0x10100) (size 0x100))`,
  `${OK_FIXED}\n(region.declare-fixed $B (base 0x10080) (size 0x100))`,
  'overlaps');
pair('law', 'a name may not be both fixed and allocated',
  `${OK_FIXED}\n(region.declare $A (size 0x100))`,
  '(region.declare-static $R 64)\n(region.declare-fixed $R (base 0x10000) (size 0x100))',
  'a region has one base');

// ── The (§4.2) laws: size-is-power-of-2, stride/count, mask ───────────────
pair('law', '(size-is-power-of-2) is enforced',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (size-is-power-of-2))',
  '(region.declare-fixed $R (base 0x10000) (size 0x180) (size-is-power-of-2))',
  'declares (size-is-power-of-2) but its size is');
pair('law', '(size-is-power-of-2) takes no operand',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (size-is-power-of-2))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (size-is-power-of-2 1))',
  'takes no operand');
pair('law', '(stride ...) is spelled (stride N (count N))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 16))',
  'is spelled (stride N (count N))');
pair('law', 'stride x count must equal the size',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 15)))',
  'is not');
pair('law', 'a $-named stride operand must be a declared i32 constant global',
  '(global $CAP i32 (i32.const 16))\n(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count $CAP)))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count $CAP)))',
  'names no (global');
pair('law', '(mask $G) names an i32 constant global',
  '(global $M i32 (i32.const 15))\n(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)) (mask $M))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)) (mask 15))',
  'names an i32 constant global');
pair('law', '(mask $G) must name a global that exists',
  '(global $M i32 (i32.const 15))\n(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)) (mask $M))',
  '(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)) (mask $M))',
  'names no');
pair('law', 'a mask is only well formed over a power-of-two count',
  '(global $M i32 (i32.const 15))\n(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)) (mask $M))',
  '(global $M i32 (i32.const 14))\n(region.declare-fixed $R (base 0x10000) (size 0xF0) (stride 16 (count 15)) (mask $M))',
  'is only well formed over a power-of-two');
pair('law', 'a mask must be one below the count it comes from',
  '(global $M i32 (i32.const 15))\n(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)) (mask $M))',
  '(global $M i32 (i32.const 16))\n(region.declare-fixed $R (base 0x10000) (size 0x100) (stride 16 (count 16)) (mask $M))',
  'a mask is one below the');

// ── Allocation ────────────────────────────────────────────────────────────
pair('alloc', 'an allocation that does not fit is refused',
  '(region.declare $A (size 0x1000))',
  '(region.declare $A (size 0x1000))\n(region.declare $B (size 0x20000))',
  'past the');
pair('alloc', 'a region shake spelling is validated',
  OK_FIXED, OK_FIXED, null,   // positive-only; the negative goes through options
  );
PAIRS[PAIRS.length - 1].badOptions = { regionShake: 'sideways' };
PAIRS[PAIRS.length - 1].says = 'is not gap, rotate, reverse, pad or a positive numeric seed';

// ── Types, functions, duplicates ──────────────────────────────────────────
pair('module', 'a named type declaration is well formed',
  '(type $t (func (param i32) (result i32)))',
  '(type $t (i32))',
  'Invalid type declaration');
pair('module', 'a type name is declared once',
  '(type $t (func (param i32) (result i32)))',
  '(type $t (func (param i32) (result i32)))\n(type $t (func (result i32)))',
  "Duplicate type '$t'");
pair('module', 'an export must reference something that exists',
  '(func $f (result i32) (i32.const 1))\n(export "f" (func $f))',
  '(func $f (result i32) (i32.const 1))\n(export "g" (func $nope))',
  'references unknown');
PAIRS[PAIRS.length - 1].goodOptions = { standardWat: true };
PAIRS[PAIRS.length - 1].badOptions = { standardWat: true };
pair('module', 'a call passes the declared number of arguments',
  '(func $g (param $a i32) (result i32) (local.get $a))\n(func $f (result i32) (call $g (i32.const 1)))\n(export "f" (func $f))',
  '(func $g (param $a i32) (result i32) (call $g (i32.const 1) (i32.const 2)))\n(export "f" (func $g))',
  'expected 1 args, got 2');
pair('module', 'br_table needs a default label and an index',
  '(func $f (param $i i32) (result i32) (block $a (br_table $a $a (local.get $i))) (i32.const 1))\n(export "f" (func $f))',
  '(func $f (param $i i32) (result i32) (block $a (br_table)) (i32.const 1))\n(export "f" (func $f))',
  'br_table');
pair('module', 'memory.copy takes three arguments',
  '(func $f (memory.copy (i32.const 0) (i32.const 4) (i32.const 4)))\n(export "f" (func $f))',
  '(func $f (memory.copy (i32.const 0) (i32.const 4)))\n(export "f" (func $f))',
  'expected exactly 3 operand(s)');
pair('folded op', 'a scalar binary operator takes exactly two operands',
  '(func $f (result i32) (i32.or (i32.const 1) (i32.const 2)))\n(export "f" (func $f))',
  '(func $f (result i32) (i32.or (i32.const 1) (i32.const 2) (i32.const 4) (i32.const 8)))\n(export "f" (func $f))',
  'expected exactly 2 operand(s), got 4');
pair('folded op', 'a scalar unary operator takes exactly one operand',
  '(func $f (result i32) (i32.eqz (i32.const 0)))\n(export "f" (func $f))',
  '(func $f (result i32) (i32.eqz (i32.const 0) (i32.const 1)))\n(export "f" (func $f))',
  'expected exactly 1 operand(s), got 2');
pair('folded op', 'a SIMD binary operator takes exactly two operands',
  '(func $f (result v128) (v128.or (v128.const i32x4 1 2 3 4) (v128.const i32x4 5 6 7 8)))',
  '(func $f (result v128) (v128.or (v128.const i32x4 1 2 3 4) (v128.const i32x4 5 6 7 8) (v128.const i32x4 9 10 11 12)))',
  'expected exactly 2 operand(s), got 3');

// Direct emitters used to be the second half of the same silent-drop class:
// each branch read the operands it needed and returned without checking that
// the form ended. Keep representative coverage for every direct-emitter shape
// (zero/one/optional operands, structural control, memargs and WATX layouts),
// so adding requireArity to the opcode tables alone cannot make this suite green.
const SIDE = '(func $side (result i32) (i32.const 9))';
pair('direct arity', 'a zero-operand instruction refuses a folded child',
  '(func $f (nop))',
  `${SIDE}\n(func $f (nop (call $side)))`,
  'nop in function $f: expected exactly 0 operand(s), got 1');
pair('direct arity', 'a local.get consumes only its local immediate',
  '(func $f (param $x i32) (result i32) (local.get $x))',
  '(func $f (param $x i32) (result i32) (local.get $x (i32.const 9)))',
  'local.get in function $f: expected exactly 1 operand(s), got 2');
pair('direct arity', 'a local.set consumes its local and value',
  '(func $f (local $x i32) (drop (local.set $x (i32.const 1))))',
  `${SIDE}\n(func $f (local $x i32) (drop (local.set $x (i32.const 1) (call $side))))`,
  'local.set in function $f: expected exactly 2 operand(s), got 3');
pair('direct arity', 'a local declaration has one name and one type',
  '(func $f (local $x i32) (drop (local.get $x)))',
  `${SIDE}\n(func $f (local $x i32 (call $side)))`,
  'local in function $f: expected exactly 2 operand(s), got 3');
pair('direct arity', 'a let binding has no silently discarded body operand',
  '(func $f (drop (let $x i32 (i32.const 1))))',
  `${SIDE}\n(func $f (drop (let $x i32 (i32.const 1) (call $side))))`,
  'let in function $f: expected exactly 3 operand(s), got 4');
pair('direct arity', 'a length-prefixed string takes one string token',
  '(func $f (result i32) (string "ok"))',
  `${SIDE}\n(func $f (result i32) (string "ok" (call $side)))`,
  'string in function $f: expected exactly 1 operand(s), got 2');
pair('direct arity', 'return accepts at most one folded value',
  '(func $f (result i32) (return (i32.const 1)))',
  `${SIDE}\n(func $f (result i32) (return (i32.const 1) (call $side)))`,
  'return in function $f: expected 0 or 1 operand(s), got 2');
pair('direct arity', 'drop accepts stacked or one folded value, never two',
  '(func $f (drop (i32.const 1)))',
  `${SIDE}\n(func $f (drop (i32.const 1) (call $side)))`,
  'drop in function $f: expected 0 or 1 operand(s), got 2');
pair('direct arity', 'br accepts at most one folded branch value',
  '(func $f (block $done (br $done)))',
  `${SIDE}\n(func $f (block $done (br $done (i32.const 1) (call $side))))`,
  'br in function $f: expected 1 or 2 operand(s), got 3');
pair('direct arity', 'grouped br_table consumes exactly its labels, default and index',
  '(func $f (param $i i32) (block $done (br_table (labels $done) $done (local.get $i))))',
  `${SIDE}\n(func $f (param $i i32) ` +
    '(block $done (br_table (labels $done) $done (local.get $i) (call $side))))',
  'br_table in function $f: expected exactly 3 operand(s), got 4');
pair('direct arity', 'if refuses expressions after its recognized else arm',
  '(func $f (if (i32.const 1) (then (nop)) (else (nop))))',
  `${SIDE}\n(func $f (if (i32.const 1) (then (nop)) (else (nop)) (call $side)))`,
  'if in function $f: expected exactly 3 operand(s), got 4');
pair('direct arity', 'a scalar load counts memargs and one address',
  '(func $f (result i32) (i32.load offset=4 align=4 (i32.const 0)))',
  `${SIDE}\n(func $f (result i32) (i32.load offset=4 align=4 (i32.const 0) (call $side)))`,
  'i32.load in function $f: expected exactly 3 operand(s), got 4');
pair('direct arity', 'a SIMD load counts memargs and one address',
  '(func $f (result v128) (v128.load offset=16 (i32.const 0)))',
  `${SIDE}\n(func $f (result v128) (v128.load offset=16 (i32.const 0) (call $side)))`,
  'v128.load in function $f: expected exactly 2 operand(s), got 3');
pair('direct arity', 'an atomic operation consumes its complete operand list',
  '(func $f (result i32) (i32.atomic.load (i32.const 0)))',
  `${SIDE}\n(func $f (result i32) (i32.atomic.load (i32.const 0) (call $side)))`,
  'i32.atomic.load in function $f: expected exactly 1 operand(s), got 2');
pair('direct arity', 'a layout accessor consumes layout, field and address',
  '(layout ArityRec (field value i32))\n(func $f (result i32) (load.field ArityRec value (i32.const 0)))',
  `${SIDE}\n(layout ArityRec (field value i32))\n` +
    '(func $f (result i32) (load.field ArityRec value (i32.const 0) (call $side)))',
  'load.field in function $f: expected exactly 3 operand(s), got 4');
pair('direct arity', 'a global.get consumes only its global immediate',
  '(global $g (mut i32) (i32.const 1))\n(func $f (result i32) (global.get $g))',
  '(global $g (mut i32) (i32.const 1))\n(func $f (result i32) (global.get $g (i32.const 2)))',
  'global.get in function $f: expected exactly 1 operand(s), got 2');
pair('module', 'a function name is declared once (strictDeclarations)',
  '(func $f (result i32) (i32.const 1))\n(export "f" (func $f))',
  '(func $f (result i32) (i32.const 1))\n(func $f (result i32) (i32.const 2))',
  'Duplicate function');
PAIRS[PAIRS.length - 1].goodOptions = { strictDeclarations: true };
PAIRS[PAIRS.length - 1].badOptions = { strictDeclarations: true };

// ── Macros ────────────────────────────────────────────────────────────────
// Macro arity is checked in both directions as of 2026-08-31. Before that a
// missing argument was caught only downstream, by the parameter symbol failing
// to resolve — which named `$x` and the CALLING function, not the macro or the
// call site — and this entry carried a `weakDiagnostic` saying the refusal
// "should name the macro and its arity". It does now, so the expected message
// is that one; a surplus argument was dropped in silence and is the pair below.
pair('macro', 'a macro invoked with too FEW arguments',
  '(defmacro (double $x) (i32.mul $x (i32.const 2)))\n' +
  '(func $f (result i32) (double (i32.const 21)))\n(export "f" (func $f))',
  '(defmacro (double $x) (i32.mul $x (i32.const 2)))\n' +
  '(func $f (result i32) (double))\n(export "f" (func $f))',
  'macro double takes 1 argument(s)');
pair('macro', 'a macro invoked with too MANY arguments',
  '(defmacro (double $x) (i32.mul $x (i32.const 2)))\n' +
  '(func $f (result i32) (double (i32.const 21)))\n(export "f" (func $f))',
  '(defmacro (double $x) (i32.mul $x (i32.const 2)))\n' +
  '(func $f (result i32) (double (i32.const 21) (i32.const 3)))\n(export "f" (func $f))',
  'macro double');
// Was `notEnforced` until 2026-08-31: surplus arguments were dropped by
// `params.forEach`, which iterates the parameters and so never looks at an
// argument past the last one. Arity is checked in both directions now.
pair('macro', 'an include must resolve',
  '(func $f (result i32) (i32.const 1))\n(export "f" (func $f))',
  '(include "nowhere.watx")\n(func $f (result i32) (i32.const 1))',
  "Missing include 'nowhere.watx'");

// ── Numeric literals ──────────────────────────────────────────────────────
pair('literal', 'a constant takes exactly one complete literal token',
  '(func $f (result i32) (i32.const 5))\n(export "f" (func $f))',
  '(func $f (result i32) (i32.const 5 6))\n(export "f" (func $f))',
  'expected exactly one literal operand');
pair('literal', 'trailing junk on a literal is not ignored',
  '(func $f (result f32) (f32.const 1.5))\n(export "f" (func $f))',
  '(func $f (result f32) (f32.const 1.5 6))\n(export "f" (func $f))',
  'expected exactly one literal operand');
pair('literal', 'a malformed float literal is refused',
  '(func $f (result f32) (f32.const 1.5))\n(export "f" (func $f))',
  // One TOKEN that is not one number. `1.5q` would be tokenized as two tokens
  // and caught by the arity rule above instead, which is a different rule.
  '(func $f (result f32) (f32.const 1.2.3))\n(export "f" (func $f))',
  'Invalid floating-point literal');
pair('literal', 'a malformed integer literal is refused',
  '(func $f (result i32) (i32.const 0x1f))\n(export "f" (func $f))',
  '(func $f (result i32) (i32.const 0x1g))\n(export "f" (func $f))',
  'literal');

// ── The string pool ───────────────────────────────────────────────────────
// A bare "text" literal, (string ...) and (cstring ...) all intern into one
// pool. Its default address is "just above the last data segment", which is
// only above the MAP when WATX allocated that map itself via
// region.declare-static/-bump/-rc. With regions allocated instead, the default
// lands inside somebody's storage — measured in wine-assembly as a literal
// placed at 0x07B7B040, in the middle of a live region, with every gate green.
// So the pool is either pinned by (string.pool $R) or its default is checked.
const OK_POOL = '(region.declare-fixed $POOL (base 0x11000) (size 0x100) (owner "strings"))';
const USES_STR = '(func $f (result i32) "hi")\n(export "f" (func $f))';
// The legacy pool address with no data segments is 1024 = 0x400, so a region
// placed there is exactly the collision the default cannot see for itself.
const LOW_TENANT = '(region.declare-fixed $LOW (base 0x400) (size 0x100) (owner "a tenant at the default pool address"))';
pair('string pool', 'a pool that lands inside an allocated region is refused',
  `${LOW_TENANT}\n${OK_POOL}\n(string.pool $POOL)\n${USES_STR}`,
  `${LOW_TENANT}\n${OK_POOL}\n${USES_STR}`,
  'overlaps the storage of region');
pair('string pool', 'string.pool is declared at most once',
  `${OK_POOL}\n(string.pool $POOL)\n${USES_STR}`,
  `${OK_POOL}\n(string.pool $POOL)\n(string.pool $POOL)\n${USES_STR}`,
  'already declared');
pair('string pool', 'string.pool names a declared region',
  `${OK_POOL}\n(string.pool $POOL)\n${USES_STR}`,
  `${OK_POOL}\n(string.pool $NOPE)\n${USES_STR}`,
  'unknown region');
pair('string pool', 'string.pool takes exactly one operand',
  `${OK_POOL}\n(string.pool $POOL)\n${USES_STR}`,
  `${OK_POOL}\n(string.pool $POOL $POOL)\n${USES_STR}`,
  'exactly one operand');
pair('string pool', 'a span owns no storage to lend the pool',
  `${OK_POOL}\n(string.pool $POOL)\n${USES_STR}`,
  `${OK_SPAN}\n${OK_FIXED}\n(string.pool $S)\n${USES_STR}`,
  'is a span');
// "hello" interns as 5 bytes + NUL, padded to 8 — which fits 0x100 and does not fit 4.
pair('string pool', 'a pool that outgrows its region is refused',
  `(region.declare-fixed $P2 (base 0x11000) (size 0x100) (owner "strings"))\n(string.pool $P2)\n(func $f (result i32) "hello")\n(export "f" (func $f))`,
  `(region.declare-fixed $P2 (base 0x11000) (size 0x4) (owner "strings"))\n(string.pool $P2)\n(func $f (result i32) "hello")\n(export "f" (func $f))`,
  'runs past');

// ── Struct layouts ────────────────────────────────────────────────────────
// Every rule here guards a refusal that USED to be a silent default: an unknown
// layout or field name resolved to offset 0 / size 16, which turns one typo into
// a read or write of the wrong field — the exact silent bug class
// docs/watx-layout-migration-design.md exists to delete. A rule that only fires
// as a comment is not a rule.
const OK_LAYOUT = '(layout Rec (field state i32) (field value i32) (field ports i32 4))';
// The PRELUDE above already declares the memory these bodies address.
const useField = (l, f) =>
  `(func $g (param $p i32) (result i32) (load.field ${l} ${f} (local.get $p)))\n(export "g" (func $g))`;

pair('layout', 'load.field names a declared layout',
  `${OK_LAYOUT}\n${useField('Rec', 'value')}`,
  `${OK_LAYOUT}\n${useField('Nope', 'value')}`,
  'no such');
pair('layout', 'load.field names a field the layout has',
  `${OK_LAYOUT}\n${useField('Rec', 'value')}`,
  `${OK_LAYOUT}\n${useField('Rec', 'valu')}`,
  'Unknown field');
pair('layout', 'store.field names a field the layout has',
  `${OK_LAYOUT}\n(func $s (param $p i32) (store.field Rec value (local.get $p) (i32.const 1)))\n(export "s" (func $s))`,
  `${OK_LAYOUT}\n(func $s (param $p i32) (store.field Rec vlaue (local.get $p) (i32.const 1)))\n(export "s" (func $s))`,
  'Unknown field');
pair('layout', 'offset-of names a field the layout has',
  `${OK_LAYOUT}\n(func $o (result i32) (offset-of Rec ports))\n(export "o" (func $o))`,
  `${OK_LAYOUT}\n(func $o (result i32) (offset-of Rec portz))\n(export "o" (func $o))`,
  'Unknown field');
pair('layout', 'size-of names a declared layout',
  `${OK_LAYOUT}\n(func $z (result i32) (size-of Rec))\n(export "z" (func $z))`,
  `${OK_LAYOUT}\n(func $z (result i32) (size-of Reck))\n(export "z" (func $z))`,
  'no such');
pair('layout', 'an array field count is a positive integer',
  '(layout R2 (field a i32) (field ports i32 4))\n(func $z (result i32) (size-of R2))\n(export "z" (func $z))',
  '(layout R2 (field a i32) (field ports i32 0))\n(func $z (result i32) (size-of R2))\n(export "z" (func $z))',
  'positive integer');
pair('layout', 'an explicit stride is at least the element size',
  '(layout R3 (field v f64 2 16))\n(func $z (result i32) (size-of R3))\n(export "z" (func $z))',
  '(layout R3 (field v f64 2 4))\n(func $z (result i32) (size-of R3))\n(export "z" (func $z))',
  'stride');
// ── Field TYPES (WATX_LAYOUT_FIELD_TYPES, compiler-stages.js) ─────────────
// A layout field is a memory access of a fixed width, so the type name decides
// both the struct's stride and the opcode. emitLayoutAccess used to end
// `group[fieldType] || group.i32`: any name it did not know became a four-byte
// i32 access, and sizeOfType answered 4 to match, so `(field w u16)` was two
// silently wrong things that agreed with each other. The refusal is at the
// DECLARATION — one diagnostic naming the field, not one per access site.
pair('layout', 'a field type outside the declared set is refused',
  '(layout T1 (field a i32) (field b u16))\n(func $z (result i32) (size-of T1))\n(export "z" (func $z))',
  '(layout T1 (field a i32) (field b u24))\n(func $z (result i32) (size-of T1))\n(export "z" (func $z))',
  'unknown field type');
pair('layout', 'an ARRAY field with an unknown type is refused too',
  '(layout T2 (field a i32) (field b s16 4))\n(func $z (result i32) (size-of T2))\n(export "z" (func $z))',
  '(layout T2 (field a i32) (field b s24 4))\n(func $z (result i32) (size-of T2))\n(export "z" (func $z))',
  'unknown field type');
// v128 is a real valtype and a legal `let` annotation, which is exactly why it
// needs its own pair: the checker's valtype list admitted it, and there is no
// v128 entry in emitLayoutAccess, so a v128 field compiled to a 4-byte i32
// access over 16 declared bytes. Refused until both tables gain an entry.
pair('layout', 'v128 is a valtype but not a field type',
  '(func $z (local $v v128) (local.set $v (v128.const i32x4 0 0 0 0)) (i32.const 0))\n(export "z" (func $z))',
  '(layout T3 (field v v128))\n(func $z (result i32) (size-of T3))\n(export "z" (func $z))',
  'unknown field type');
// The set's own boundary: the sub-width types must be ACCEPTED and must lay the
// struct out at their true widths, or the refusal above is just a wall.
pair('layout', 'the sub-width field types lay the struct out at their true widths',
  '(layout T4 (field b u8) (field c s8) (field d u16) (field e s16))\n' +
    '(func $z (result i32) (i32.sub (size-of T4) (i32.const 6)))\n(export "z" (func $z))',
  '(layout T4 (field b u8) (field c s8) (field d u16) (field e s16))\n' +
    '(func $z (result i32) (offset-of T4 nope))\n(export "z" (func $z))',
  'Unknown field');
pair('layout', 'load.field-elem names a field the layout has',
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (load.field-elem Rec ports (local.get $p) (i32.const 1)))\n(export "g" (func $g))`,
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (load.field-elem Rec porz (local.get $p) (i32.const 1)))\n(export "g" (func $g))`,
  'Unknown field');
pair('layout', 'elem-addr names a declared layout',
  `${OK_LAYOUT}\n(func $a (param $p i32) (result i32) (elem-addr Rec ports (local.get $p) (i32.const 1)))\n(export "a" (func $a))`,
  `${OK_LAYOUT}\n(func $a (param $p i32) (result i32) (elem-addr Nope ports (local.get $p) (i32.const 1)))\n(export "a" (func $a))`,
  'no such');

// ── The `.memarg` lowering modifier (design §3.4) ──────────────────────────
// `load.field.memarg` folds the field offset into the memory instruction's
// memarg instead of adding it to the address first. The rules below all guard
// the same failure: a modifier that is ACCEPTED where it means nothing. A site
// spelled `.memarg` on an op that performs no memory access, or on a head that
// is not a layout accessor at all, must not compile to something plausible —
// it would read as converted while the offset it names went nowhere.
pair('layout', '.memarg is accepted on an accessor and refused on elem-addr',
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (load.field.memarg Rec value (local.get $p)))\n(export "g" (func $g))`,
  `${OK_LAYOUT}\n(func $a (param $p i32) (result i32) (elem-addr.memarg Rec ports (local.get $p) (i32.const 1)))\n(export "a" (func $a))`,
  'no memarg');
pair('layout', '.memarg is refused on size-of, which yields a constant',
  `${OK_LAYOUT}\n(func $z (result i32) (size-of Rec))\n(export "z" (func $z))`,
  `${OK_LAYOUT}\n(func $z (result i32) (size-of.memarg Rec))\n(export "z" (func $z))`,
  'no memarg');
pair('layout', '.memarg is refused on offset-of, which yields a constant',
  `${OK_LAYOUT}\n(func $o (result i32) (offset-of Rec value))\n(export "o" (func $o))`,
  `${OK_LAYOUT}\n(func $o (result i32) (offset-of.memarg Rec value))\n(export "o" (func $o))`,
  'no memarg');
pair('layout', '.memarg on a non-layout head is an unknown head, not a modifier',
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (i32.load offset=4 (local.get $p)))\n(export "g" (func $g))`,
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (i32.load.memarg offset=4 (local.get $p)))\n(export "g" (func $g))`,
  'Unknown form head');
pair('layout', 'a misspelled modifier is not silently the plain accessor',
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (load.field.memarg Rec value (local.get $p)))\n(export "g" (func $g))`,
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (load.field.memrag Rec value (local.get $p)))\n(export "g" (func $g))`,
  'Unknown form head');
pair('layout', '.memarg still checks the layout name',
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (load.field.memarg Rec value (local.get $p)))\n(export "g" (func $g))`,
  `${OK_LAYOUT}\n(func $g (param $p i32) (result i32) (load.field.memarg Nope value (local.get $p)))\n(export "g" (func $g))`,
  'no such');
pair('layout', '.memarg still checks the field name',
  `${OK_LAYOUT}\n(func $s (param $p i32) (store.field.memarg Rec value (local.get $p) (i32.const 1)))\n(export "s" (func $s))`,
  `${OK_LAYOUT}\n(func $s (param $p i32) (store.field.memarg Rec vlaue (local.get $p) (i32.const 1)))\n(export "s" (func $s))`,
  'Unknown field');

// ── The runner ────────────────────────────────────────────────────────────

function runPairs({ only = null, onResult = null } = {}) {
  const entries = only ? PAIRS.filter((p) => only.test(`${p.group} ${p.rule}`)) : PAIRS;
  const results = [];
  for (const p of entries) {
    const r = { group: p.group, rule: p.rule, ok: true, problems: [] };

    const good = build(p.good, p.goodOptions || {});
    if (!good.success) {
      r.ok = false;
      r.problems.push(`the ACCEPTED half was rejected: ${good.error}`);
    }

    const bad = build(p.bad, p.badOptions || {});
    if (p.notEnforced) {
      // A rule that is NOT enforced today. The pair still exists, and it is
      // still an assertion: it must keep compiling, and the day it starts being
      // refused the marker has to come off. Deleting the pair instead would
      // delete the record of the gap.
      r.notEnforced = p.notEnforced;
      if (!bad.success) {
        r.ok = false;
        r.problems.push(`this rule is now ENFORCED ("${bad.error}") — drop the notEnforced marker ` +
          `and set says to the message it produces`);
      }
    } else if (bad.success) {
      r.ok = false;
      r.problems.push('the REJECTED half compiled');
    } else {
      if (p.says && !bad.error.includes(p.says)) {
        r.ok = false;
        r.problems.push(`rejected for the wrong reason: wanted "${p.says}", got "${bad.error}"`);
      }
      // A rule the editor cannot point at is a rule the author has to bisect
      // by hand. It is a real shortcoming and it is counted and printed, but it
      // does not fail the pair — a diagnostic with the right text and no line
      // is still a diagnostic, and conflating the two would let one repair hide
      // behind the other. `unlocated` is the work list.
      if (!(bad.errorLine > 0)) r.unlocated = true;
    }
    results.push(r);
    if (onResult) onResult(r);
  }
  const byGroup = new Map();
  for (const p of entries) byGroup.set(p.group, (byGroup.get(p.group) || 0) + 1);
  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    unlocated: results.filter((r) => r.unlocated).length,
    notEnforced: results.filter((r) => r.notEnforced).length,
    byGroup: [...byGroup].sort((a, b) => b[1] - a[1]),
    results,
  };
}

module.exports = { PAIRS, runPairs };

if (require.main === module) {
  const onlyArg = process.argv.slice(2).find((a) => a.startsWith('--only='));
  const rep = runPairs({
    only: onlyArg ? new RegExp(onlyArg.slice(7)) : null,
    onResult: (r) => {
      if (r.ok) return;
      console.log(`  FAIL [${r.group}] ${r.rule}`);
      for (const p of r.problems) console.log(`       ${p}`);
    },
  });
  console.log(`\n${rep.passed}/${rep.total} accepted/rejected pairs hold.`);
  console.log('Negative tests per grammar area:');
  for (const [g, n] of rep.byGroup) console.log(`  ${String(n).padStart(3)}  ${g}`);
  console.log(`${rep.unlocated} of ${rep.total} refusals carry NO line number ` +
    `(right message, no location — an editor cannot point at them):`);
  for (const r of rep.results) if (r.unlocated) console.log(`     [${r.group}] ${r.rule}`);
  if (rep.notEnforced) {
    console.log(`${rep.notEnforced} rule(s) are recorded but NOT enforced:`);
    for (const r of rep.results) if (r.notEnforced) console.log(`     [${r.group}] ${r.rule} — ${r.notEnforced}`);
  }
  process.exit(rep.passed === rep.total ? 0 : 1);
}
