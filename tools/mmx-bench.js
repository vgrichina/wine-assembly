#!/usr/bin/env node
// Benchmark the interpreter's MMX path against the scalar x86 that an app
// would run without MMX -- and check the two produce identical bytes.
//
//   node tools/mmx-bench.js [--bytes=N] [--reps=N] [--seed=N]
//
// Why a synthetic kernel rather than a real app: none of the corpus binaries
// that *contain* MMX reach it in a headless run (Liquid War never gets past
// its menu, and the SMACKW32 users have no .smk assets mounted), so timing
// them would measure a code path that never executes. What an emulator's MMX
// support actually buys is measurable on its own: the same saturating byte
// blend costs 7 dispatches per 8 bytes with MMX and ~8.5 dispatches per byte
// without, and that ratio is what an app's blitter inherits.
//
// The kernel is hand-assembled x86 written straight into guest memory and run
// through the shipped wasm, so it exercises the real decoder, the real block
// cache and the real handlers -- not a WAT-level microbenchmark.
//
// Wall-clock on a loaded box is noise, so both variants are run interleaved
// and the *minimum* per variant is reported: the least-interfered sample is
// the one closest to the machine's real throughput. Dispatch counts are exact
// and load-independent; prefer them when the box is busy.
'use strict';

const fs = require('fs');
const path = require('path');

const WASM = path.join(__dirname, '..', 'build', 'wine-assembly.wasm');

// --- guest layout (offsets from the guest image base) ---
// The two kernels get their own addresses: the block cache keys on the guest
// address, so writing a second kernel over the first would just re-run the
// first one's decoded thread.
const CODE_MMX = 0x1000;
const CODE_SCALAR = 0x2000;
const DST = 0x100000;
const SRC = 0x300000;
const STACK = 0x080000;

// --- the two kernels ---
// Both consume ECX iterations, walk ESI (dst) and EDI (src), and end on a RET
// into a zero return address, which is how $run halts.

// movq mm0,[esi] / paddusb mm0,[edi] / movq [esi],mm0 / add esi,8 / add edi,8
// / dec ecx / jnz -18 -- 7 instructions per 8 bytes.
const MMX_KERNEL = [
  0x0F, 0x6F, 0x06,
  0x0F, 0xDC, 0x07,
  0x0F, 0x7F, 0x06,
  0x83, 0xC6, 0x08,
  0x83, 0xC7, 0x08,
  0x49,
  0x75, 0xEE,
  0xC3,
];
const MMX_BODY = 18;      // bytes before the RET
const MMX_INSNS = 7;      // per iteration
const MMX_STRIDE = 8;     // bytes per iteration

// mov al,[esi] / mov dl,[edi] / add al,dl / jnc +2 / mov al,0xFF / mov [esi],al
// / inc esi / inc edi / dec ecx / jnz -17 -- 9 or 10 instructions per byte
// depending on whether the add carried, i.e. on the data.
//
// The source byte goes through DL rather than being added straight from memory
// (`add al,[edi]`, 02 /r). That form is decoded but its handler computes the
// flags from an unmasked 32-bit sum, so CF is lost on a byte carry and the
// saturation branch never fires -- a pre-existing interpreter bug, unrelated to
// MMX, that this kernel would otherwise be measuring instead of scalar speed.
const SCALAR_KERNEL = [
  0x8A, 0x06,
  0x8A, 0x17,
  0x00, 0xD0,
  0x73, 0x02,
  0xB0, 0xFF,
  0x88, 0x06,
  0x46,
  0x47,
  0x49,
  0x75, 0xEF,
  0xC3,
];
const SCALAR_BODY = 17;
const SCALAR_INSNS = 9;   // per byte, plus one more on each saturation
const SCALAR_STRIDE = 1;

function instantiate() {
  const mod = new WebAssembly.Module(fs.readFileSync(WASM));
  const imports = {};
  for (const im of WebAssembly.Module.imports(mod)) {
    imports[im.module] = imports[im.module] || {};
    if (im.kind === 'memory') {
      imports[im.module][im.name] = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    } else if (im.kind === 'global') {
      imports[im.module][im.name] = 0;
    } else {
      // The kernels touch no API thunks, so any host call here means the
      // interpreter went somewhere unexpected. Throwing says so loudly --
      // except for the diagnostic log imports, which the block cache uses to
      // announce ordinary events like a cache wrap.
      imports[im.module][im.name] = im.name.startsWith('log_')
        ? () => 0
        : (...a) => { throw new Error(`mmx-bench: unexpected host call ${im.name}(${a})`); };
    }
  }
  return new WebAssembly.Instance(mod, imports);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s;
  };
}

function main() {
  const arg = (name, dflt) => {
    const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
    return hit ? Number(hit.slice(name.length + 3)) : dflt;
  };
  if (!fs.existsSync(WASM)) {
    console.error(`mmx-bench: ${WASM} not found -- run tools/build.sh first`);
    process.exit(2);
  }

  const bytes = arg('bytes', 1 << 20);
  const reps = arg('reps', 5);
  const seed = arg('seed', 0x5eed1234);
  if (bytes % 8 !== 0) {
    console.error('mmx-bench: --bytes must be a multiple of 8');
    process.exit(2);
  }

  // Hand-assembled rel8 back-edges: the jnz displacement must land exactly on
  // the first byte of the body, or the kernel silently computes something else.
  for (const [name, k, body] of [['mmx', MMX_KERNEL, MMX_BODY], ['scalar', SCALAR_KERNEL, SCALAR_BODY]]) {
    const rel = (k[body - 1] << 24) >> 24;    // sign-extend the rel8
    if (body + rel !== 0) {
      console.error(`mmx-bench: ${name} kernel jnz rel8 ${rel} does not target its own start`);
      process.exit(2);
    }
  }

  const inst = instantiate();
  const ex = inst.exports;
  for (const need of ['run', 'set_eip', 'set_esp', 'set_ecx', 'set_esi', 'set_edi', 'get_guest_base', 'get_image_base']) {
    if (!ex[need]) {
      console.error(`mmx-bench: build has no ${need} export`);
      process.exit(2);
    }
  }

  const mem = new Uint8Array(ex.memory ? ex.memory.buffer : inst.exports.memory.buffer);
  const view = new DataView(mem.buffer);
  const guestBase = ex.get_guest_base();
  const imageBase = ex.get_image_base();
  const g2w = g => g - imageBase + guestBase;

  // Two source buffers of random bytes; dst is restored from a pristine copy
  // before every run so each variant starts from the same state.
  const rand = rng(seed);
  const pristine = new Uint8Array(bytes);
  const src = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    const r = rand();
    pristine[i] = r & 0xFF;
    src[i] = (r >>> 8) & 0xFF;
  }
  mem.set(src, g2w(SRC));

  // Expected result, computed independently of both kernels.
  const expect = new Uint8Array(bytes);
  let carries = 0;
  for (let i = 0; i < bytes; i++) {
    const sum = pristine[i] + src[i];
    if (sum > 255) carries++;
    expect[i] = sum > 255 ? 255 : sum;
  }

  function runKernel(name, kernel, at, stride) {
    mem.set(kernel, g2w(at));
    mem.set(pristine, g2w(DST));
    view.setUint32(g2w(STACK), 0, true);      // return address -> eip 0 -> halt
    ex.set_eip(at);
    ex.set_esp(STACK);
    ex.set_esi(DST);
    ex.set_edi(SRC);
    ex.set_ecx(bytes / stride);
    const t0 = process.hrtime.bigint();
    ex.run(2000000000);
    const t1 = process.hrtime.bigint();
    if (ex.get_eip() !== 0) throw new Error(`${name} kernel did not finish: eip=0x${ex.get_eip().toString(16)}`);
    const out = mem.slice(g2w(DST), g2w(DST) + bytes);
    for (let i = 0; i < bytes; i++) {
      if (out[i] !== expect[i]) {
        throw new Error(`${name} kernel: byte ${i}: got 0x${out[i].toString(16)} want 0x${expect[i].toString(16)}`);
      }
    }
    return Number(t1 - t0) / 1e6;
  }

  const mmxBefore = ex.get_mmx_exec_count ? ex.get_mmx_exec_count() : null;
  const times = { mmx: [], scalar: [] };
  for (let r = 0; r < reps; r++) {
    // Interleaved so a load spike hits both variants, not just the first.
    times.mmx.push(runKernel('mmx', MMX_KERNEL, CODE_MMX, MMX_STRIDE));
    times.scalar.push(runKernel('scalar', SCALAR_KERNEL, CODE_SCALAR, SCALAR_STRIDE));
  }
  const mmxRetired = ex.get_mmx_exec_count ? ex.get_mmx_exec_count() - mmxBefore : null;

  const mmxIters = bytes / MMX_STRIDE;
  const scalarIters = bytes / SCALAR_STRIDE;
  const mmxInsns = mmxIters * MMX_INSNS;
  const scalarInsns = scalarIters * SCALAR_INSNS + carries;

  const min = a => Math.min(...a);
  const mmxMs = min(times.mmx), scalarMs = min(times.scalar);
  const f = (n, d = 2) => n.toFixed(d);

  console.log(`mmx-bench: saturating byte blend, ${bytes} bytes x ${reps} reps`);
  console.log(`  both kernels produced the expected bytes (${carries} saturations)`);
  if (mmxRetired !== null) console.log(`  MMX instructions retired: ${mmxRetired} (expected ${mmxIters * 3 * reps})`);
  console.log('');
  console.log('                 x86 insns   dispatches/byte    best ms     MB/s');
  console.log(`  MMX          ${String(mmxInsns).padStart(11)}   ${f(mmxInsns / bytes, 3).padStart(15)}   ${f(mmxMs).padStart(8)}   ${f(bytes / 1048576 / (mmxMs / 1000)).padStart(6)}`);
  console.log(`  scalar       ${String(scalarInsns).padStart(11)}   ${f(scalarInsns / bytes, 3).padStart(15)}   ${f(scalarMs).padStart(8)}   ${f(bytes / 1048576 / (scalarMs / 1000)).padStart(6)}`);
  console.log('');
  console.log(`  speedup: ${f(scalarInsns / mmxInsns)}x fewer x86 instructions, ${f(scalarMs / mmxMs)}x faster wall clock`);
  console.log(`  (wall clock is min-of-${reps} interleaved; the instruction ratio is exact)`);
}

main();
