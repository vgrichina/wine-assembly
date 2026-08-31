// test/watx-compiler-bulk-memory.test.js -- TRACK BULK: WATX compiler emits bulk-memory opcodes
// (memory.copy = 0xFC 0x0A, memory.fill = 0xFC 0x0B) as VOID-effect ops (push nothing).
//
// See tracks/COMPILER-REQUESTS.md (BULK scoped edit-authority grant, 2026-08-12).
// This is the compiler-side unit test that MUST land + stay GREEN before any src/*.watx
// migration to bulk memory (framework-drawpass framebuffer clear/fill, dex string-table
// copies, heap memmove/array copy). Migrations gate on O byte-identical pixel+tree output
// per app; this test only proves the compiler emits correct WASM.
//
// The three things we prove here:
//   (1) EMIT: the raw byte sequence for (memory.copy $d $s $n) is
//       <dst-expr><src-expr><len-expr> 0xFC 0x0A 0x00 0x00, and for
//       (memory.fill $d $v $n) it is <dst><val><len> 0xFC 0x0B 0x00.
//   (2) VOID: the compiler treats these as pushes-nothing, so
//       (begin (memory.copy ...) (memory.fill ...) 0) leaves ONE i32 on the stack
//       (the trailing 0), not three. If they were treated as value-producing, the
//       intermediate ones would need a `drop` -- the test verifies the emitted body
//       contains NO drop op between the bulk ops (checks the raw bytes).
//   (3) BEHAVIOR: the compiled module actually copies + fills memory correctly when
//       run in a real WebAssembly.Instance -- the definitive proof against silent bugs
//       (misplaced memidx byte, off-by-one, wrong subopcode, etc.).
//
// Run: node test/watx-compiler-bulk-memory.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? ' (got ' + JSON.stringify(got) + ')' : ''}`); }
}

function findSubseq(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ── (1) + (2) EMIT + VOID: compile a module with both bulk ops in a begin, then bit-scan the binary. ──
// The function loads dst/src/val/len as immediates so the operand emit is a simple i32.const chain that
// we can locate by hand: memory.copy uses (dst=1000, src=2000, len=3), memory.fill uses (dst=4000, val=0x55, len=5).
// NOTE: WATX top-level does NOT accept a (module ...) wrapper -- the codegen scans
// top-level forms directly for (func ...) / (wasm-export ...) / (wasm-import ...).
// Wrapping in (module ...) silently produces an empty binary (see the watx-compiler-emit-stack
// test's guard weakness -- it only checks length>0, so the module-wrap bug didn't fire there).
const bulkSrc = `
(func $bulk (result i32) (effects heap)
  (memory.copy (i32.const 1000) (i32.const 2000) (i32.const 3))
  (memory.fill (i32.const 4000) (i32.const 0x55) (i32.const 5))
  (i32.const 0))
(wasm-export "bulk" $bulk)`;

const r1 = compile(bulkSrc, new Map());
ck('bulk-emit: compile succeeded', r1.success === true, r1.error);
ck('bulk-emit: wasmBinary present', !!(r1.wasmBinary && r1.wasmBinary.length > 0),
   r1.wasmBinary ? r1.wasmBinary.length : 'no binary');

if (r1.success && r1.wasmBinary) {
  const bin = Array.from(r1.wasmBinary);
  // memory.copy suffix: 0xFC 0x0A 0x00 0x00 (subopcode 10 + two memidx bytes)
  const copyIdx = findSubseq(bin, [0xFC, 0x0A, 0x00, 0x00]);
  ck('bulk-emit: memory.copy bytes 0xFC 0x0A 0x00 0x00 present', copyIdx >= 0, copyIdx);
  // memory.fill suffix: 0xFC 0x0B 0x00 (subopcode 11 + one memidx byte)
  const fillIdx = findSubseq(bin, [0xFC, 0x0B, 0x00]);
  ck('bulk-emit: memory.fill bytes 0xFC 0x0B 0x00 present', fillIdx >= 0, fillIdx);
  // Ordering: copy must appear before fill in the code section (source order preserved).
  if (copyIdx >= 0 && fillIdx >= 0) {
    ck('bulk-emit: memory.copy emitted BEFORE memory.fill (source order)', copyIdx < fillIdx,
       {copyIdx, fillIdx});
  }
  // VOID: neither bulk op should be followed by an OP.drop (0x1a). The next byte after the
  // memidx tail is the start of the NEXT expression -- for both, the next thing is another
  // (i32.const ...) or an end-of-body. If the compiler wrongly treated them as pushing an
  // i32, `begin` would emit a `drop` between the two bulk ops. Scan the intervening bytes.
  if (copyIdx >= 0 && fillIdx >= 0 && copyIdx < fillIdx) {
    const between = bin.slice(copyIdx + 4, fillIdx);
    const dropAt = between.indexOf(0x1a);
    // A `drop` opcode 0x1a could theoretically appear as a byte inside a ULEB128 constant
    // (e.g. i32.const 0x1a). But the constants we picked (4000, 0x55, 5) have SLEB128
    // encodings that do not contain 0x1a: 4000 -> 0xa0 0x1f; 0x55 -> 0xd5 0x00; 5 -> 0x05.
    // So a literal 0x1a in `between` MUST be an actual drop op.
    ck('bulk-emit: NO drop (0x1a) emitted between memory.copy and memory.fill (void stack-effect)',
       dropAt < 0, {between: between.map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ')});
  }

  // ── (3) BEHAVIOR: instantiate and check that copy + fill actually mutate memory correctly. ──
  const stubs = {
    log_i32: () => {}, log_str_ptr: () => {}, log_bytes_at: () => {}, native_pc_probe: () => {},
    js_dispatch: () => 0, native_hostcall: () => 0, js_console_log: () => {}, browser_touch_event: () => {},
    browser_key_event: () => 0, browser_scroll_event: () => 0, gl_capture_call: () => {},
  };
  const imports = {};
  for (const imp of r1.importMeta || []) {
    imports[imp.module] = imports[imp.module] || {};
    imports[imp.module][imp.name] = stubs[imp.name] || (() => 0);
  }
  let mod, inst;
  try {
    mod = new WebAssembly.Module(r1.wasmBinary);
    inst = new WebAssembly.Instance(mod, imports);
  } catch (e) {
    ck('bulk-behavior: module instantiates cleanly', false, e && e.message);
  }
  if (inst) {
    ck('bulk-behavior: module instantiates cleanly', true);
    const mem = inst.exports.memory;
    const view = new Uint8Array(mem.buffer);
    // Seed src bytes at 2000..2002 with a pattern; leave dst 1000..1002 zero.
    view[2000] = 0xAA; view[2001] = 0xBB; view[2002] = 0xCC;
    view[1000] = 0; view[1001] = 0; view[1002] = 0;
    // Seed fill target 4000..4004 with an easily-distinguishable non-0x55 pattern.
    for (let i = 0; i < 5; i++) view[4000 + i] = 0x11;
    // Also seed a byte JUST past the fill length to confirm we didn't run over.
    view[4005] = 0x99;
    // Run the exported function.
    const rv = inst.exports.bulk();
    ck('bulk-behavior: exported bulk() returns the trailing 0', rv === 0, rv);
    // memory.copy: dst 1000..1002 should now match src 2000..2002.
    ck('bulk-behavior: memory.copy copied byte 0 (0xAA)', view[1000] === 0xAA, '0x' + view[1000].toString(16));
    ck('bulk-behavior: memory.copy copied byte 1 (0xBB)', view[1001] === 0xBB, '0x' + view[1001].toString(16));
    ck('bulk-behavior: memory.copy copied byte 2 (0xCC)', view[1002] === 0xCC, '0x' + view[1002].toString(16));
    // memory.fill: 4000..4004 should all be 0x55, and 4005 should still be 0x99.
    let fillOk = true;
    for (let i = 0; i < 5; i++) if (view[4000 + i] !== 0x55) { fillOk = false; break; }
    ck('bulk-behavior: memory.fill wrote 0x55 across the 5-byte range', fillOk,
       Array.from(view.slice(4000, 4005)).map(b => '0x'+b.toString(16)).join(' '));
    ck('bulk-behavior: memory.fill did NOT overrun the length (byte at 4005 untouched)',
       view[4005] === 0x99, '0x' + view[4005].toString(16));
  }
}

// ── (4) ARITY: (memory.copy dst src)  -- 2 args instead of 3 -- must fail type check. ──
const badArity = `
(func $bad (result i32) (effects heap)
  (memory.copy (i32.const 100) (i32.const 200))
  (i32.const 0))
(wasm-export "bad" $bad)`;
const r2 = compile(badArity, new Map());
ck('bulk-arity: 2-arg memory.copy is rejected', r2.success === false, r2.success);
if (!r2.success) {
  ck('bulk-arity: error message mentions memory.copy',
     /memory\.copy/.test(r2.error || ''), r2.error);
}

console.log(`\nwatx-compiler-bulk-memory: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
