// test/watx-compiler-regions.test.js — region.declare-fixed, the M6 head.
//
// docs/watx-region-safety-design.md. The vendored compiler already had a region
// FAMILY (declare-static/-bump/-rc, region.alloc) in which every head ALLOCATES
// a base — static from address 1024. wine-assembly's bases are an ABI it shares
// with JavaScript, with tests and with guest-address translation, so the head it
// needs is the opposite verb: "this region is AT 0xA and is N bytes — verify
// that, never place it."
//
// What this suite has to prove, in order of how badly a regression would hurt:
//
//   (1) IDENTITY. A declaration emits NOTHING. A module with declarations is
//       byte-identical to the same module without them. This is the invariant
//       the whole adoption rests on: the canonical Wine artifact hashes
//       (01daf6cc… / 0ee64146…) must not move when the memory map is declared.
//   (2) ADDRESSING. A bare `$NAME` resolves to the base through the family's
//       EXISTING symbol handler, and (region.addr $NAME OFF) emits exactly the
//       same bytes as the raw (i32.const base+OFF) — one i32.const, no runtime
//       cost, so adopting it is a pure compile-time gain.
//   (3) VALIDATION. Every failure mode in the design's catalogue is a HARD
//       error with a line number. A memory map that compiles with a diagnostic
//       nobody reads is the status quo we are replacing.
//
// Run: node test/watx-compiler-regions.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? ' (got ' + JSON.stringify(got) + ')' : ''}`); }
}

// A module needs a memory for the bounds check to have a bound. 2 pages = 128KB.
const MEM = '(memory 2 2)';

function build(src, opts) {
  return compile(`${MEM}\n${src}`, new Map(), opts);
}

// Compile and instantiate, returning the exports.
function run(src) {
  const r = build(src);
  if (!r.success) throw new Error(r.error);
  const mod = new WebAssembly.Module(r.wasmBinary);
  return new WebAssembly.Instance(mod, {}).exports;
}

// A source that must FAIL, with the message fragment it must name.
function mustFail(name, src, fragment) {
  const r = build(src);
  if (r.success) { ck(name, false, 'compiled successfully'); return; }
  const ok = r.error.includes(fragment);
  ck(`${name} — reports "${fragment}"`, ok, r.error);
  // Every one of these is raised at a form we have a location for, so the
  // editor is told WHERE. A hard error with line 0 is only half a diagnostic.
  ck(`${name} — carries a line number`, r.errorLine > 0, r.errorLine);
}

console.log('── (1) IDENTITY: declarations emit nothing ──');
{
  const body = `
(func $f (result i32) (effects heap) (i32.const 7))
(wasm-export "f" $f)`;
  const decls = `
(region.declare-fixed $TABLE (base 0x1000) (size 0x800) (align 0x100)
  (owner "a table nothing in this module touches"))
(region.declare-fixed $OTHER (base 0x2000) (end 0x3000))`;
  const bare = build(body);
  const declared = build(`${decls}\n${body}`);
  ck('bare module compiles', bare.success === true, bare.error);
  ck('declared module compiles', declared.success === true, declared.error);
  if (bare.success && declared.success) {
    ck('byte-identical with declarations present',
       Buffer.from(bare.wasmBinary).equals(Buffer.from(declared.wasmBinary)),
       { bare: bare.wasmBinary.length, declared: declared.wasmBinary.length });
  }
  // Declarations must also not disturb the bump heap the rest of the family
  // allocates from — declare-fixed contributes nothing to staticCursor.
  const withStatic = build(`(region.declare-static $S (size 64))\n${body}`);
  const withBoth = build(`(region.declare-static $S (size 64))\n${decls}\n${body}`);
  ck('a fixed declaration does not move the static/bump cursor',
     withStatic.success && withBoth.success &&
     Buffer.from(withStatic.wasmBinary).equals(Buffer.from(withBoth.wasmBinary)),
     withBoth.error);
}

console.log('── (2) ADDRESSING ──');
{
  const src = `
(region.declare-fixed $TABLE (base 0x1000) (size 0x800))
(func $base (result i32) (effects heap) $TABLE)
(func $at (result i32) (effects heap) (region.addr $TABLE 0x40))
(func $span (result i32) (effects heap) (region.addr $TABLE 0x7FC (span 4)))
(func $size (result i32) (effects heap) (region.size $TABLE))
(func $end (result i32) (effects heap) (region.end $TABLE))
(wasm-export "base" $base) (wasm-export "at" $at) (wasm-export "span" $span)
(wasm-export "size" $size) (wasm-export "end" $end)`;
  const e = run(src);
  ck('bare $NAME is the base (inherited family resolution)', e.base() === 0x1000, e.base());
  ck('region.addr adds the offset', e.at() === 0x1040, e.at());
  ck('region.addr accepts a span that ends exactly at the region end',
     e.span() === 0x17FC, e.span());
  ck('region.size', e.size() === 0x800, e.size());
  ck('region.end is exclusive', e.end() === 0x1800, e.end());
}
{
  // The byte-level claim: region.addr is an i32.const and nothing else. Compare
  // a module using the form against the same module using the raw constant.
  const shape = (addr) => `
(region.declare-fixed $TABLE (base 0x1000) (size 0x800))
(func $f (result i32) (effects heap) ${addr})
(wasm-export "f" $f)`;
  const checked = build(shape('(region.addr $TABLE 0x40)'));
  const raw = build(shape('(i32.const 0x1040)'));
  ck('region.addr emits byte-identical wasm to the raw i32.const',
     checked.success && raw.success &&
     Buffer.from(checked.wasmBinary).equals(Buffer.from(raw.wasmBinary)),
     checked.error || raw.error);
  const bareSym = build(shape('$TABLE'));
  const rawBase = build(shape('(i32.const 0x1000)'));
  ck('a bare region symbol emits byte-identical wasm to the raw i32.const',
     bareSym.success && rawBase.success &&
     Buffer.from(bareSym.wasmBinary).equals(Buffer.from(rawBase.wasmBinary)),
     bareSym.error || rawBase.error);
}

console.log('── (3) DECLARATION-SET VALIDATION ──');
mustFail('overlap',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (region.declare-fixed $B (base 0x1400) (size 0x800))`,
  'overlaps $A');
mustFail('overlap is caught whichever order the declarations are written in',
  `(region.declare-fixed $B (base 0x1400) (size 0x800))
   (region.declare-fixed $A (base 0x1000) (size 0x800))`,
  'overlaps $A');
mustFail('duplicate name',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (region.declare-fixed $A (base 0x4000) (size 0x800))`,
  'already declared');
mustFail('past the end of initial memory',
  `(region.declare-fixed $A (base 0x1F000) (size 0x2000))`,
  'past the');
mustFail('unknown clause',
  `(region.declare-fixed $A (base 0x1000) (sixe 0x800))`,
  'unknown clause');
mustFail('no extent at all',
  `(region.declare-fixed $A (base 0x1000))`,
  'exactly one of');
mustFail('both size and end',
  `(region.declare-fixed $A (base 0x1000) (size 0x800) (end 0x1800))`,
  'exactly one of');
mustFail('end below base',
  `(region.declare-fixed $A (base 0x1000) (end 0x800))`,
  'is not above');
mustFail('zero size',
  `(region.declare-fixed $A (base 0x1000) (size 0))`,
  'a region must have an extent');
mustFail('misaligned base',
  `(region.declare-fixed $A (base 0x1004) (size 0x800) (align 0x1000))`,
  'not a multiple of');
mustFail('align is not a power of two',
  `(region.declare-fixed $A (base 0x1000) (size 0x800) (align 12))`,
  'not a power of two');
mustFail('non-integer extent',
  `(region.declare-fixed $A (base 0x1000) (size "big"))`,
  'not an integer literal');
mustFail('duplicate clause',
  `(region.declare-fixed $A (base 0x1000) (base 0x2000) (size 0x800))`,
  'duplicate (base ...) clause');
mustFail('missing region name',
  `(region.declare-fixed (base 0x1000) (size 0x800))`,
  '$-prefixed region name');

console.log('── (3b) DELIBERATE NESTING via (within $OUTER) ──');
{
  // The map really does contain regions inside regions (test-wat-memory-map.js
  // audits several by hand today). Requiring them to SAY so keeps the exemption
  // at the point of overlap instead of in a gate's exception list.
  const r = build(`
(region.declare-fixed $OUTER (base 0x1000) (size 0x1000))
(region.declare-fixed $INNER (base 0x1200) (size 0x100) (within $OUTER))
(func $f (result i32) (effects heap) $INNER)
(wasm-export "f" $f)`);
  ck('a declared nested region compiles', r.success === true, r.error);
}
mustFail('(within ...) naming an undeclared region',
  `(region.declare-fixed $A (base 0x1000) (size 0x100) (within $NOPE))`,
  'names no declared region');
mustFail('(within ...) that is not actually contained',
  `(region.declare-fixed $OUTER (base 0x2000) (size 0x1000))
   (region.declare-fixed $INNER (base 0x1000) (size 0x1000) (within $OUTER))`,
  'is not contained in');

console.log('── (3c) ADDRESSING VALIDATION ──');
mustFail('region.addr on an unknown region',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (func $f (result i32) (effects heap) (region.addr $NOPE 0))
   (wasm-export "f" $f)`,
  'unknown region $NOPE');
mustFail('region.addr offset past the region',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (func $f (result i32) (effects heap) (region.addr $A 0x800))
   (wasm-export "f" $f)`,
  'runs past the');
mustFail('region.addr span past the region',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (func $f (result i32) (effects heap) (region.addr $A 0x7FC (span 8)))
   (wasm-export "f" $f)`,
  'runs past the');
mustFail('region.addr with a negative offset',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (func $f (result i32) (effects heap) (region.addr $A -4))
   (wasm-export "f" $f)`,
  'non-negative integer literal');
mustFail('region.addr with a computed offset',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (func $f (param $i i32) (result i32) (effects heap) (region.addr $A (local.get $i)))
   (wasm-export "f" $f)`,
  'non-negative integer literal');
mustFail('region.addr with no offset at all',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (func $f (result i32) (effects heap) (region.addr $A))
   (wasm-export "f" $f)`,
  'expected a constant offset');
mustFail('a region declared both fixed and allocated',
  `(region.declare-fixed $A (base 0x1000) (size 0x800))
   (region.declare-static $A (size 64))`,
  'one base');

console.log('── (3d) THE SHARED $-NAMESPACE ──');
// Regions share `$name` with functions, globals and locals. Exactly ONE of those
// collisions is intentional — a region named after the (global $R i32 base) it
// replaces, which is the whole migration pattern — and the others resolve
// silently in a direction nobody chose. During a fan-out that silence is the
// dangerous part: the conversion's premise is that `$REGION` IS an address.
{
  const r = build(`
(global $TABLE i32 (i32.const 0x1000))
(region.declare-fixed $TABLE (base 0x1000) (size 0x800))
(func $f (result i32) (effects heap) (global.get $TABLE))
(func $g (result i32) (effects heap) $TABLE)
(wasm-export "f" $f) (wasm-export "g" $g)`);
  ck('a region may share its name with the global it mirrors', r.success === true, r.error);
  if (r.success) {
    const e = new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {}).exports;
    ck('(global.get $R) still reads the global, bare $R is the region base',
       e.f() === 0x1000 && e.g() === 0x1000, [e.f(), e.g()]);
  }
}
mustFail('a region named after a FUNCTION',
  `(region.declare-fixed $helper (base 0x1000) (size 0x800))
   (func $helper (result i32) (effects heap) (i32.const 1))
   (wasm-export "helper" $helper)`,
  'collides with a function of the same name');
mustFail('a bare region symbol shadowed by a local',
  `(region.declare-fixed $TABLE (base 0x1000) (size 0x800))
   (func $f (param $TABLE i32) (result i32) (effects heap) $TABLE)
   (wasm-export "f" $f)`,
  'is both a local/parameter and a declared region');
{
  // A local of that name is only a problem where the ambiguity is READ: a
  // function that never mentions the name bare compiles, so the rejection is
  // targeted rather than a repo-wide rename.
  const r = build(`
(region.declare-fixed $TABLE (base 0x1000) (size 0x800))
(func $f (param $TABLE i32) (result i32) (effects heap) (local.get $TABLE))
(wasm-export "f" $f)`);
  ck('an explicit (local.get $X) is unambiguous and stays legal', r.success === true, r.error);
}

console.log('── (4) STANDARD-WAT / COMPAT MODE ──');
{
  // Both canonical artifacts (tail calls and compat) must agree that a
  // declaration is inert; the map is declared once for both.
  const src = `
(region.declare-fixed $A (base 0x1000) (size 0x800))
(func $f (result i32) (effects heap) (region.addr $A 0x10))
(wasm-export "f" $f)`;
  const tail = compile(`${MEM}\n${src}`, new Map(), { tailCalls: true });
  const compat = compile(`${MEM}\n${src}`, new Map(), { tailCalls: false });
  ck('compiles with tail calls', tail.success === true, tail.error);
  ck('compiles without tail calls', compat.success === true, compat.error);
}

console.log('── (5) SPANS: a named address LIMIT, transparent to overlap ──');
//
// §5.1. `$g2w`'s direct guest window has an upper bound written as the bare
// literal 0x8000000 in three places in src/03-registers.wat. It is not a
// storage region — it CONTAINS $GUEST_BASE, the stack, the thunks and PE
// staging — so declaring it with any other head makes the compiler reject the
// whole map as overlapping. `region.declare-span` is the head whose one
// distinguishing property is that it does not participate in the overlap sweep.
//
// The risk this suite has to hold down is that transparency spreads: a span
// that could be nested, aligned, allocated or shaken would be a hole in the
// overlap check with a friendly name, which is strictly worse than the literal.
const SPAN = '(region.declare-span $WINDOW (base 0x0) (end 0x8000) ' +
  '(owner "the direct window $g2w tests against"))';
{
  // Transparency, both directions: a span may contain regions, and regions
  // inside it are still checked against EACH OTHER.
  const inside = build(`${SPAN}
(region.declare-fixed $A (base 0x1000) (size 0x100))
(region.declare-fixed $B (base 0x2000) (size 0x100))
(func $f (result i32) (effects heap) (i32.const 0))
(wasm-export "f" $f)`);
  ck('regions live INSIDE a span without overlapping it', inside.success === true, inside.error);

  const collide = build(`${SPAN}
(region.declare-fixed $A (base 0x1000) (size 0x100))
(region.declare-fixed $B (base 0x1080) (size 0x100))
(func $f (result i32) (effects heap) (i32.const 0))
(wasm-export "f" $f)`);
  ck('a span does not suppress the overlap check between the regions it covers',
    collide.success === false && /overlaps \$A/.test(collide.error || ''), collide.error);

  // Two spans may nest — a window inside a window is a real shape, and the
  // sweep drops spans entirely rather than special-casing them.
  const nested = build(`${SPAN}
(region.declare-span $INNER (base 0x1000) (size 0x1000) (owner "a sub-window"))
(func $f (result i32) (effects heap) (i32.const 0))
(wasm-export "f" $f)`);
  ck('two spans may overlap each other', nested.success === true, nested.error);
}
{
  // The point of the head: the literal goes away. `(region.end $WINDOW)` is the
  // 0x8000000 that `$g2w` compares against, and it is one i32.const.
  const e = run(`${SPAN}
(func $base (result i32) (effects heap) $WINDOW)
(func $end (result i32) (effects heap) (region.end $WINDOW))
(func $size (result i32) (effects heap) (region.size $WINDOW))
(func $mid (result i32) (effects heap) (region.addr $WINDOW 0x40))
(wasm-export "base" $base) (wasm-export "end" $end)
(wasm-export "size" $size) (wasm-export "mid" $mid)`);
  ck('a span symbol resolves like a fixed region\'s',
    e.base() === 0 && e.end() === 0x8000 && e.size() === 0x8000 && e.mid() === 0x40,
    [e.base(), e.end(), e.size(), e.mid()]);
}
{
  // Identity: like every other declaration head, a span emits nothing.
  const body = `
(func $f (result i32) (effects heap) (i32.const 7))
(wasm-export "f" $f)`;
  const bare = build(body);
  const withSpan = build(`${SPAN}\n${body}`);
  ck('a span declaration emits no bytes',
    bare.success && withSpan.success &&
    Buffer.from(bare.wasmBinary).equals(Buffer.from(withSpan.wasmBinary)),
    withSpan.error);
}
{
  // A span is not an obstacle: the allocator places straight through it. If it
  // were treated as a pin, the direct window would push all 160 of Wine's
  // regions above 0x08000000 and invert the map.
  const r = build(`${SPAN}
(region.floor 0x1000)
(region.declare $A (size 0x100) (align 0x100))
(func $f (result i32) (effects heap) $A)
(wasm-export "f" $f)`);
  ck('the allocator places INTO a span rather than skipping it',
    r.success === true && r.regions.regions.find(x => x.name === '$A').base === 0x1000,
    r.success ? r.regions.regions : r.error);
  ck('a span reports itself as kind "span" in the layout',
    r.success === true && r.regions.regions.find(x => x.name === '$WINDOW').kind === 'span',
    r.success ? r.regions.regions : r.error);
  // …and it is not counted as allocated, so it can never be shaken.
  ck('a span is not part of the allocated sequence',
    r.success === true && r.regions.allocated === 1, r.success ? r.regions.allocated : r.error);
}
mustFail('a span with no (base N)',
  `${'(region.declare-span $W (size 0x1000) (owner "x"))'}
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'needs a (base N) clause');
mustFail('a span with no (owner "…")',
  `(region.declare-span $W (base 0x0) (size 0x1000))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'needs an (owner "text") clause');
mustFail('a span with BOTH (size) and (end)',
  `(region.declare-span $W (base 0x0) (size 0x1000) (end 0x2000) (owner "x"))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'needs exactly one of (size N) or (end N)');
mustFail('a span with NEITHER (size) nor (end)',
  `(region.declare-span $W (base 0x0) (owner "x"))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'needs exactly one of (size N) or (end N)');
mustFail('a span whose (end) is below its (base)',
  `(region.declare-span $W (base 0x1000) (end 0x800) (owner "x"))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'is not above (base');
mustFail('a zero-extent span',
  `(region.declare-span $W (base 0x0) (size 0) (owner "x"))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  '(size 0)');
mustFail('a span ending past initial memory',
  `(region.declare-span $W (base 0x0) (size 0x40000) (owner "x"))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'past the');
mustFail('a span declared twice',
  `${SPAN}
   ${SPAN}
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'is already declared at');
mustFail('a span sharing a name with a fixed region',
  `${SPAN}
   (region.declare-fixed $WINDOW (base 0x1000) (size 0x100))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'is already declared at');
mustFail('a span with a non-integer extent',
  `(region.declare-span $W (base 0x0) (size "big") (owner "x"))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'is not an integer literal');
mustFail('region.addr past a span\'s extent',
  `${SPAN}
   (func $f (result i32) (effects heap) (region.addr $WINDOW 0x8000))
   (wasm-export "f" $f)`,
  "runs past the region's");
// The clauses a span REFUSES, one per clause, because each one would smuggle a
// property back in that a transparent range cannot honestly have.
for (const [label, clause] of [
  ['alignment', '(align 0x1000)'],
  ['nesting', '(within $OUTER)'],
  ['a stride law', '(stride 4 (count 2))'],
  ['a mask law', '(mask $M)'],
  ['a power-of-two law', '(size-is-power-of-2)'],
]) {
  mustFail(`a span carrying ${label}`,
    `(region.declare-span $W (base 0x0) (size 0x1000) ${clause} (owner "x"))
     (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
    'is not a span clause');
}
mustFail('a span with a misspelled clause names SPAN clauses, not every clause',
  `(region.declare-span $W (base 0x0) (sixe 0x1000) (owner "x"))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  '(sixe ...) is not a span clause');
mustFail('a span with a duplicate clause',
  `(region.declare-span $W (base 0x0) (size 0x1000) (size 0x10) (owner "x"))
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'duplicate (size ...) clause');

console.log('── (6) DATA SEGMENT OFFSETS: region.addr is the ONLY region form ──');
//
// Failure mode 20 checks a segment's payload LENGTH against its region's
// extent, and only `region.addr` has an offset for that check to be about.
// `(region.end $R)` and `(region.size $R)` were previously accepted as data
// offsets and reached the emitter with the bounds check skipped — the exact
// hole §4.4 exists to close, wearing the syntax of the fix.
{
  const R = '(region.declare-fixed $R (base 0x1000) (size 0x10))';
  const ok = build(`${R}
(data (region.addr $R 0xF) "X")
(func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`);
  ck('a region-relative segment that FITS compiles', ok.success === true, ok.error);
}
mustFail('a segment whose payload runs past its region',
  `(region.declare-fixed $R (base 0x1000) (size 0x10))
   (data (region.addr $R 0x10) "X")
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  "runs past the region's");
mustFail('a segment at (region.end $R)',
  `(region.declare-fixed $R (base 0x1000) (size 0x10))
   (data (region.end $R) "X")
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'is not an addressable location');
mustFail('a segment at (region.size $R)',
  `(region.declare-fixed $R (base 0x1000) (size 0x10))
   (data (region.size $R) "X")
   (func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`,
  'is not an addressable location');
{
  // The bytes a region-relative segment produces are the bytes the absolute
  // form produces — that is what makes converting one a no-op.
  const abs = build(`(data (i32.const 0x1004) "hello")
(func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`);
  const rel = build(`(region.declare-fixed $R (base 0x1000) (size 0x10))
(data (region.addr $R 0x4) "hello")
(func $f (result i32) (effects heap) (i32.const 0)) (wasm-export "f" $f)`);
  ck('a region-relative segment emits the absolute form\'s bytes',
    abs.success && rel.success &&
    Buffer.from(abs.wasmBinary).equals(Buffer.from(rel.wasmBinary)), rel.error || abs.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
