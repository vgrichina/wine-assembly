// test/watx-compiler-alloc.test.js — the rest of Milestone 6 stage A:
// the deterministic ALLOCATOR, the constraint laws, derived bases,
// region-relative data segments, and the shake.
//
// docs/watx-region-safety-design.md §4.1-§4.4 and §8. test/watx-compiler-regions.test.js
// covers `region.declare-fixed` (the pin) and failure modes 1-14; this suite
// covers the heads that PLACE a region and failure modes 15-20.
//
// What it has to prove, in order of how badly a regression would hurt:
//
//   (1) DETERMINISM. The same source yields the same layout, byte for byte,
//       every time and in both compile modes. Without that, byte identity is
//       not an oracle and stage B's fan-out has nothing to check itself against.
//   (2) REPRODUCTION. Declaration order + explicit gaps can land the allocator
//       on an EXISTING hand-placed map, which is what lets stage A adopt
//       allocation without moving a byte. (The full 160-region version of this
//       is `node tools/region-alloc.js --prove`.)
//   (3) LAWS. A stride, a count, a mask or a power-of-two size that does not
//       hold is a hard error naming the region — the fourteen derived globals
//       §5.2 measured have no assertion behind them today.
//   (4) SEGMENTS. A region-relative data segment emits the same bytes as the
//       absolute form and is bounds-checked INCLUDING its own length.
//   (5) SHAKE. A permuted layout is deterministic per seed and reported, so a
//       shaken artifact can never be mistaken for a canonical one.
//
// Run: node test/watx-compiler-alloc.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? ' (got ' + JSON.stringify(got) + ')' : ''}`); }
}

const MEM = '(memory 2 2)';   // 128 KB, so the memory bound has something to bind

function build(src, opts) {
  return compile(`${MEM}\n${src}`, new Map(), opts || {});
}
function run(src, opts) {
  const r = build(src, opts);
  if (!r.success) throw new Error(r.error);
  const mod = new WebAssembly.Module(r.wasmBinary);
  return { exports: new WebAssembly.Instance(mod, {}).exports, result: r };
}
function mustFail(name, src, fragment, opts) {
  const r = build(src, opts);
  if (r.success) { ck(name, false, 'compiled successfully'); return; }
  ck(`${name} — reports "${fragment}"`, r.error.includes(fragment), r.error);
  ck(`${name} — carries a line number`, r.errorLine > 0, r.errorLine);
}
// The layout the compiler reports, keyed by name.
function layout(src, opts) {
  const r = build(src, opts);
  if (!r.success) throw new Error(r.error);
  const map = new Map(r.regions.regions.map(x => [x.name, x]));
  return { map, report: r.regions, binary: Buffer.from(r.wasmBinary) };
}

console.log('── (1) THE ALLOCATOR: declaration-order first-fit above a floor ──');
{
  const src = `
(region.floor 0x1000)
(region.declare $A (size 0x100))
(region.declare $B (size 0x200) (align 0x100))
(region.declare $C (size 0x40))
(func $a (result i32) (effects heap) $A)
(func $b (result i32) (effects heap) $B)
(func $c (result i32) (effects heap) $C)
(wasm-export "a" $a) (wasm-export "b" $b) (wasm-export "c" $c)`;
  const { map } = layout(src);
  ck('the first region sits at the floor', map.get('$A').base === 0x1000, map.get('$A').base);
  ck('the cursor advances past it, honouring the next align',
     map.get('$B').base === 0x1100, map.get('$B').base);
  ck('and again for the third', map.get('$C').base === 0x1300, map.get('$C').base);
  const e = run(src).exports;
  ck('a bare $NAME resolves to the ALLOCATED base', e.a() === 0x1000 && e.b() === 0x1100, [e.a(), e.b()]);

  // Determinism is the whole feature: same source, same bytes, every time.
  const one = build(src), two = build(src);
  ck('the same source compiles to byte-identical wasm twice',
     Buffer.from(one.wasmBinary).equals(Buffer.from(two.wasmBinary)));
}
{
  // Order, not name and not size: a rename or a capacity bump must not reshuffle
  // the map, and reversing the DECLARATIONS must.
  const shape = (decls) => `${decls}
(func $f (result i32) (effects heap) $P)
(wasm-export "f" $f)`;
  const fwd = layout(shape(`(region.floor 0x1000)
(region.declare $P (size 0x100)) (region.declare $Q (size 0x100))`));
  const rev = layout(shape(`(region.floor 0x1000)
(region.declare $Q (size 0x100)) (region.declare $P (size 0x100))`));
  ck('declaration order decides the layout',
     fwd.map.get('$P').base === 0x1000 && rev.map.get('$P').base === 0x1100,
     [fwd.map.get('$P').base, rev.map.get('$P').base]);
}
{
  // Alignment, and never backfilling into the hole alignment left: backfilling
  // would make every base depend on the size history of every earlier region.
  const { map } = layout(`(region.floor 0x1000)
(region.declare $BIG (size 0x10) (align 0x10))
(region.declare $ALIGNED (size 0x10) (align 0x1000))
(region.declare $SMALL (size 0x8))`);
  ck('an aligned region skips forward', map.get('$ALIGNED').base === 0x2000, map.get('$ALIGNED').base);
  ck('the next region does NOT backfill the hole', map.get('$SMALL').base === 0x2010, map.get('$SMALL').base);
}
{
  // §4.1's second mechanism: an explicit, documented gap.
  const { map } = layout(`(region.floor 0x1000)
(region.declare $A (size 0x100))
(region.gap 0x300 (reason "unknown, preserved"))
(region.declare $B (size 0x100))`);
  ck('(region.gap N (reason …)) advances the cursor', map.get('$B').base === 0x1400, map.get('$B').base);
}
mustFail('a gap with no reason',
  `(region.floor 0x1000) (region.gap 0x100)`,
  '(reason "text") clause');
{
  // Reproduction in miniature — the shape tools/region-alloc.js --prove runs
  // over the real 160-region map: order + gaps land on addresses somebody else
  // chose by hand.
  const target = [['$T1', 0x2000, 0x100], ['$T2', 0x2400, 0x80], ['$T3', 0x3000, 0x40]];
  let cursor = 0x1000, src = '(region.floor 0x1000)\n';
  for (const [name, base, size] of target) {
    if (base > cursor) src += `(region.gap ${base - cursor} (reason "preserved"))\n`;
    src += `(region.declare ${name} (size ${size}))\n`;
    cursor = base + size;
  }
  const { map } = layout(src);
  ck('order + gaps reproduce a hand-placed map exactly',
     target.every(([name, base]) => map.get(name).base === base),
     target.map(([n]) => map.get(n).base));
}
{
  // Pins are obstacles: an allocated region skips over one rather than being
  // refused, so a fixed ABI region and an allocated one can coexist.
  const { map } = layout(`(region.floor 0x1000)
(region.declare-fixed $PIN (base 0x1100) (size 0x100))
(region.declare $A (size 0x200))`);
  ck('an allocated region skips a pin in its way', map.get('$A').base === 0x1200, map.get('$A').base);
}

console.log('── (2) FAILURE MODE 15/16: the allocator runs out of room ──');
const OVERFLOW = `(region.floor 0x1000)
   (region.declare $A (size 0x1E000))
   (region.declare $B (size 0x2000))`;
mustFail('15 — allocation past the end of memory', OVERFLOW, 'past the');
{
  const r = build(OVERFLOW);
  ck('15 — names the last region it managed to place', /last placed region was \$A/.test(r.error), r.error);
}
// A pin that reaches the end of memory, with an allocated region landing on it:
// the allocator skips pins, so this is the shape where skipping has nowhere left
// to go.
const PIN_BLOCKS = `(region.floor 0x1000)
   (region.declare-fixed $PIN (base 0x1100) (size 0x1EF00))
   (region.declare $A (size 0x1000))`;
mustFail('16 — a pin leaves no room after it', PIN_BLOCKS, 'cannot be allocated at');
{
  const r = build(PIN_BLOCKS);
  ck('16 — names the pin that is in the way', /pinned \$PIN occupies it/.test(r.error), r.error);
}

console.log('── (3) CONSTRAINTS (§4.2) ──');
{
  const r = build(`
(global $SLOTS i32 (i32.const 8))
(global $MASK i32 (i32.const 7))
(region.floor 0x1000)
(region.declare $ARENA (size 0x800) (align 0x100)
  (stride 0x100 (count $SLOTS)) (size-is-power-of-2) (mask $MASK))`);
  ck('a region whose stride/count/mask/pow2 laws all hold compiles', r.success === true, r.error);
}
mustFail('17 — stride x count is not the size',
  `(region.floor 0x1000) (region.declare $A (size 0x2000) (stride 0x400 (count 3)))`,
  'is not (stride');
mustFail('17 — the count may be a global, and it is checked too',
  `(global $CAP i32 (i32.const 3))
   (region.floor 0x1000) (region.declare $A (size 0x2000) (stride 0x400 (count $CAP)))`,
  'is not (stride');
mustFail('17 — a stride naming a global that does not exist',
  `(region.floor 0x1000) (region.declare $A (size 0x2000) (stride $NOPE (count 8)))`,
  'names no (global');
mustFail('18 — (size-is-power-of-2) over a size that is not one',
  `(region.floor 0x1000) (region.declare $A (size 0x1800) (size-is-power-of-2))`,
  'declares (size-is-power-of-2) but its size is');
mustFail('a mask that is off by one — the exact PAGE_DIR_MASK shape',
  `(global $PAGE_DIR_MASK i32 (i32.const 1024))
   (region.floor 0x1000)
   (region.declare $PAGE_DIR (size 0x1000) (stride 4 (count 1024)) (mask $PAGE_DIR_MASK))`,
  'not 0x000003FF — a mask is one below');
{
  const r = build(`(global $PAGE_DIR_MASK i32 (i32.const 1023))
   (region.floor 0x1000)
   (region.declare $PAGE_DIR (size 0x1000) (stride 4 (count 1024)) (mask $PAGE_DIR_MASK))`);
  ck('the correct mask (count - 1) compiles', r.success === true, r.error);
}
mustFail('a mask over a non-power-of-two count cannot be well formed',
  `(global $M i32 (i32.const 2))
   (region.floor 0x1000) (region.declare $A (size 0x300) (stride 0x100 (count 3)) (mask $M))`,
  'power-of-two');
{
  // The laws hold on a PIN too — the constraint is about the extent, not about
  // who chose the address.
  const r = build(`(global $M i32 (i32.const 7))
   (region.declare-fixed $A (base 0x1000) (size 0x800) (stride 0x100 (count 8)) (mask $M))`);
  ck('constraints apply to region.declare-fixed as well', r.success === true, r.error);
}

console.log('── (4) DERIVED BASES (§4.3) ──');
{
  // g2w(VA) = $GUEST_BASE + (VA - image base). The GUEST address is the written
  // constant because it is the one that is actually an ABI.
  const { map } = layout(`
(region.image-base 0x400000)
(region.declare-fixed $GUEST_BASE (base 0x12000) (size 0x1000) (align 0x1000))
(region.declare-derived $GUEST_STACK (base (g2w 0x405000)) (size 0x1000) (align 0x1000)
  (owner "the guest holds these as ESP"))`);
  ck('a derived base is g2w of the guest VA',
     map.get('$GUEST_STACK').base === 0x17000, map.get('$GUEST_STACK').base);
}
{
  const { map } = layout(`
(region.declare-fixed $GUEST_BASE (base 0x12000) (size 0x1000) (align 0x1000))
(region.declare-derived $R (base (g2w 0x401000)) (size 0x1000) (align 0x1000))`);
  ck('the image base defaults to 0x400000 (the PE preferred base)',
     map.get('$R').base === 0x13000, map.get('$R').base);
}
mustFail('19 — a derived base with no $GUEST_BASE region',
  `(region.declare-derived $R (base (g2w 0x401000)) (size 0x1000))`,
  'needs a declared $GUEST_BASE region');
mustFail('19 — a derived base over an ALLOCATED $GUEST_BASE',
  `(region.floor 0x1000)
   (region.declare $GUEST_BASE (size 0x8000) (align 0x1000))
   (region.declare-derived $R (base (g2w 0x401000)) (size 0x1000))`,
  'needs a PINNED $GUEST_BASE');
mustFail('a derived base written as a bare wasm offset',
  `(region.declare-fixed $GUEST_BASE (base 0x12000) (size 0x1000))
   (region.declare-derived $R (base 0x13000) (size 0x100))`,
  'spelled (base (g2w 0xVA))');
mustFail('a derived region that lands misaligned',
  `(region.declare-fixed $GUEST_BASE (base 0x12000) (size 0x1000) (align 0x1000))
   (region.declare-derived $R (base (g2w 0x400004)) (size 0x100) (align 0x1000))`,
  'is not a multiple of');
mustFail('an allocated region may not state a base',
  `(region.floor 0x1000) (region.declare $A (base 0x2000) (size 0x100))`,
  'is only for region.declare-fixed');
mustFail('an allocated region may not state an end',
  `(region.floor 0x1000) (region.declare $A (end 0x2000))`,
  'which an allocated region does not have');

console.log('── (5) REGION-RELATIVE DATA SEGMENTS (§4.4) ──');
{
  // The byte-level claim: the same segment, addressed two ways, is the same
  // module. That is what makes converting 171 absolute segments safe.
  const relative = build(`
(region.declare-fixed $POOL (base 0x1000) (size 0x800))
(data (region.addr $POOL 0x40) "Button\\00")
(func $f (result i32) (effects heap) (i32.const 0))
(wasm-export "f" $f)`);
  const absolute = build(`
(region.declare-fixed $POOL (base 0x1000) (size 0x800))
(data (i32.const 0x1040) "Button\\00")
(func $f (result i32) (effects heap) (i32.const 0))
(wasm-export "f" $f)`);
  ck('a region-relative data segment compiles', relative.success === true, relative.error);
  ck('and is byte-identical to the absolute form at the same address',
     relative.success && absolute.success &&
     Buffer.from(relative.wasmBinary).equals(Buffer.from(absolute.wasmBinary)),
     relative.error || absolute.error);
}
{
  // It really lands there: read the bytes back out of memory.
  const { exports } = run(`
(region.declare-fixed $POOL (base 0x1000) (size 0x800))
(data (region.addr $POOL 0x40) "Wine")
(func $peek (result i32) (effects heap) (i32.load8_u (i32.const 0x1040)))
(wasm-export "peek" $peek)`);
  ck('the bytes land at base+offset', exports.peek() === 'W'.charCodeAt(0), exports.peek());
}
{
  // An allocated region's segment follows the allocator — this is the whole
  // point: the data moves with the region instead of pinning it.
  const { exports } = run(`
(region.floor 0x1000)
(region.declare $HEAD (size 0x100))
(region.declare $POOL (size 0x100))
(data (region.addr $POOL 0x10) "Z")
(func $peek (result i32) (effects heap) (i32.load8_u (i32.const 0x1110)))
(wasm-export "peek" $peek)`);
  ck('a segment in an ALLOCATED region moves with it', exports.peek() === 'Z'.charCodeAt(0), exports.peek());
}
mustFail('20 — a segment whose LENGTH runs past the region',
  `(region.declare-fixed $A (base 0x1000) (size 0x100))
   (data (region.addr $A 0xFC) "12345678")`,
  'runs past the');
mustFail('20 — a segment whose offset is outside the region',
  `(region.declare-fixed $A (base 0x1000) (size 0x100))
   (data (region.addr $A 0x200) "x")`,
  'runs past the');
mustFail('a segment in a region that does not exist',
  `(data (region.addr $NOPE 0x10) "x")`,
  'unknown region $NOPE');
{
  const r = build(`
(region.declare-fixed $A (base 0x1000) (size 0x100))
(data (region.addr $A 0xF8) "12345678")
(func $f (result i32) (effects heap) (i32.const 0))
(wasm-export "f" $f)`);
  ck('a segment that ends EXACTLY at the region end is legal', r.success === true, r.error);
}

console.log('── (6) THE SHAKE (§8) ──');
{
  const src = `
(region.floor 0x1000)
(region.declare $A (size 0x100))
(region.declare $B (size 0x100))
(region.declare $C (size 0x100))
(func $f (result i32) (effects heap) $A)
(wasm-export "f" $f)`;
  const plain = layout(src);
  const gap = layout(src, { regionShake: 'gap' });
  const rev = layout(src, { regionShake: 'reverse' });
  const rot = layout(src, { regionShake: 'rotate' });
  const pad = layout(src, { regionShake: 'pad' });
  const seed = layout(src, { regionShake: '0x9E3779B9' });
  ck('gap moves every region', gap.map.get('$A').base !== plain.map.get('$A').base,
     [plain.map.get('$A').base, gap.map.get('$A').base]);
  // 4099 is prime; the region's own (align 4) rounds the landing up by one byte.
  // What matters is that the SHIFT is not a multiple of a plausible stride, so
  // an off-by-a-stride bug cannot absorb it and stay green.
  ck('gap inserts a prime-sized gap (a shift no stride divides)',
     gap.map.get('$A').base === 0x1000 + 4100 && (4100 % 8) !== 0, gap.map.get('$A').base);
  ck('reverse permutes the order', rev.map.get('$C').base === 0x1000, rev.map.get('$C').base);
  ck('rotate permutes the order differently', rot.map.get('$B').base === 0x1000, rot.map.get('$B').base);
  ck('pad spaces regions out without changing their declared size',
     pad.map.get('$B').base > plain.map.get('$B').base && pad.map.get('$A').size === 0x100,
     [pad.map.get('$B').base, pad.map.get('$A').size]);
  ck('a numeric seed permutes too', seed.report.shake === 'seed 0x9e3779b9', seed.report.shake);

  // Deterministic per seed: the same shake twice is the same module.
  const again = layout(src, { regionShake: '0x9E3779B9' });
  ck('a seeded shake is deterministic', seed.binary.equals(again.binary));
  const other = layout(src, { regionShake: '0x12345678' });
  ck('a different seed is a different layout',
     other.map.get('$A').base !== seed.map.get('$A').base ||
     other.map.get('$B').base !== seed.map.get('$B').base);

  // The report is what stops a shaken artifact being mistaken for a canonical
  // one — the build banner prints exactly these fields.
  ck('the layout report names the shake', gap.report.shake === 'gap', gap.report.shake);
  ck('and counts what it moved', gap.report.shaken === 3, gap.report.shaken);
  ck('a canonical build reports no shake', plain.report.shake === null, plain.report.shake);
}
{
  // The state of the tree TODAY: 100% declare-fixed. A pin is never shaken —
  // moving $GUEST_BASE changes the guest ABI, which is a different experiment —
  // so the shake is a no-op here, and the compiler says so by reporting zero
  // allocated regions. tools/build-compile-wat.js turns that into a hard error
  // rather than let a proves-nothing shaken build look like a green run.
  const src = `
(region.declare-fixed $A (base 0x1000) (size 0x100))
(region.declare-fixed $B (base 0x2000) (size 0x100))
(func $f (result i32) (effects heap) $A)
(wasm-export "f" $f)`;
  const plain = layout(src);
  const shaken = layout(src, { regionShake: 'gap' });
  ck('shaking an all-fixed map moves nothing', shaken.binary.equals(plain.binary));
  ck('and reports 0 allocated regions, which is how the build refuses it',
     shaken.report.allocated === 0 && shaken.report.shaken === 0, shaken.report);
}
{
  // A misspelled shake must not silently produce the canonical layout under a
  // name that says otherwise. (No line number here on purpose: the mistake is in
  // a build option, not in the source.)
  const r = build(`(region.floor 0x1000) (region.declare $A (size 0x100))`, { regionShake: 'sideways' });
  ck('an unusable shake value is refused, not ignored',
     r.success === false && r.error.includes('is not gap, rotate, reverse, pad or a positive numeric seed'),
     r.error);
}

console.log('── (7) BOTH CANONICAL MODES ──');
{
  const src = `
(region.floor 0x1000)
(region.declare $A (size 0x100) (align 0x100))
(data (region.addr $A 0x10) "x")
(func $f (result i32) (effects heap) (region.addr $A 0x20))
(wasm-export "f" $f)`;
  const tail = compile(`${MEM}\n${src}`, new Map(), { tailCalls: true });
  const compat = compile(`${MEM}\n${src}`, new Map(), { tailCalls: false });
  ck('compiles with tail calls', tail.success === true, tail.error);
  ck('compiles without tail calls', compat.success === true, compat.error);
  ck('and lays the map out identically in both',
     tail.success && compat.success &&
     tail.regions.regions[0].base === compat.regions.regions[0].base);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
