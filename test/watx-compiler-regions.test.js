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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
