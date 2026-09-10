#!/usr/bin/env node
// tools/bench-loops.js — synthetic guest-loop microbenchmark harness.
//
// WHY THIS EXISTS
// ---------------
// docs/interpreter-dispatch-perf.md section "Timing: attempted four ways,
// resolved nothing" records that whole-app A/B timing on this box has a 24-42%
// noise floor against effects of 5-8%, and that one pass manufactured four fake
// 6-11% "speedups" purely from position in the round. Every interpreter change
// since has been stuck at "needs a timing run".
//
// The fix is not better statistics, it is a bigger effect. A synthetic loop that
// IS the workload turns a 2% whole-app change into a 40% microbenchmark change,
// and running both arms inside ONE process, alternating every rep, makes
// background drift common-mode instead of between-variant.
//
// WHAT IT MEASURES HONESTLY, AND WHAT IT DOES NOT
// ----------------------------------------------
// Trustworthy for the MEMORY path — $g2w, $invalidate_code_write, the page-cross
// test, bulk copies. That cost is straight-line work and reproduces here.
//
// NOT trustworthy for the DISPATCH path. A periodic short loop lets the BTB
// predict every call_indirect target perfectly, and the mispredict IS the ~23%
// $next cost in a real profile. This harness therefore UNDERSTATES dispatch cost
// systematically. A fusion that wins only on op count still needs a whole-app
// confirmation.
//
// And a shape winning here says nothing about whether it occurs in real code.
// tools/find-loops.js / match-loops.js / --handler-hist answer that; quote their
// number next to any result from this tool.
//
// CALIBRATION
// -----------
// Before believing anything new, the harness must reproduce a KNOWN sign. Two
// runtime fold toggles exist for exactly this (13-exports.wat):
//   --toggle=case_chain   handler 423, measured at ~0 on the real app
//   --toggle=rle_run      handler 424, measured at +7% batches on the real app
// A harness that cannot separate those two is measuring itself.
//
// CALIBRATION RESULT, 2026-08-24, box at load 3.5:
//   --shapes=cmp_ladder --toggle=case_chain   +57.4%, +57.8%  (two runs)
//   --shapes=cmp_ladder --toggle=rect_run     +0.7%,  -0.9%   (null control:
//                                             a toggle this shape cannot use)
// So the noise floor here is about +-1%, against 24-42% for the whole-app A/B.
// It TRACKS THE BOX: re-run at load 10.9 and the null control read -5.3% while
// the real toggle held at +58.6%. Run the null control in the same session as
// the real measurement and treat it as the threshold, never as a constant.
//
// AND THE FIRST THING IT FOUND IS THAT OP COUNT LIES ABOUT ITS OWN SIGN.
// On cmp_ladder the fold is +57% FASTER while printing 7.7% MORE handler ops.
// The op count is not what changed: block ENTRIES went 5.50 -> 2.00 per
// iteration, because every `jz` in the unfolded ladder ends a block. Time
// saved divided by entries removed puts a block entry at roughly 27ns here.
// Every fusion in this repo has been judged on the handler histogram, which
// cannot see that number at all. Hence blocks/iter in the output.
//
// USAGE
//   node tools/bench-loops.js --list
//   node tools/bench-loops.js                          # all shapes, 4MB set
//   node tools/bench-loops.js --shapes=lut,store_stream --bytes=16m
//   node tools/bench-loops.js --shapes=lut,store_stream --mapping=sparse
//   node tools/bench-loops.js --shapes=cmp_ladder --toggle=case_chain
//   node tools/bench-loops.js --json

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WASM_PATH = path.join(ROOT, 'build', 'wine-assembly.wasm');

// ---------------------------------------------------------------------------
// x86 encoding helpers. Hand-encoded on purpose: the whole point of a shape is
// that its exact op sequence is pinned, and an assembler would let it drift.
// ---------------------------------------------------------------------------
const le32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
const rel8 = n => [n & 0xFF];

// Close a loop: `body` runs, then dec ecx / jnz back to the top.
// Returns body ++ [49, 75, rel8]. The displacement counts from the byte AFTER
// the jnz, which is why it is -(len + 2).
function loopBack(body) {
  const withDec = body.concat([0x49]);            // dec ecx
  return withDec.concat([0x75], rel8(-(withDec.length + 2)));
}

// ---------------------------------------------------------------------------
// Shapes. Each is a loop the profiles actually name — see the table in the
// session notes. `emit` returns { code, iters, bytesTouched, setup }.
// `setup` runs OUTSIDE the timed region.
// ---------------------------------------------------------------------------
// The block-entry pair (see nop_chain / jmp_chain below). K filler ops per
// iteration, identical except that `jmp $+0` ends a block and `nop` does not.
const BLOCK_ENTRY_K = 8;

function blockEntryShape(a, useJmp) {
  const n = a.iterOverride || 1_000_000;
  const filler = [];
  for (let i = 0; i < BLOCK_ENTRY_K; i++) {
    // One dispatch each — that is the invariant that has to hold. The byte
    // counts differ (2 vs 1) but bytes only cost decode, which is once per rep.
    if (useJmp) filler.push(0xEB, 0x00);   // jmp $+0 — falls through, ends a block
    else filler.push(0x90);                // nop — same dispatch, no block end
  }
  return {
    iters: n,
    bytesTouched: 0,
    code: loopBack(filler),
    setup(e) { e.set_ecx(n); },
    verify(e) {
      return e.get_ecx() === 0 ? null : `ecx=${e.get_ecx()}, expected 0`;
    },
  };
}

const SHAPES = {
  sparse_scatter: {
    describe: 'cyclic dword loads across independent sparse mappings (--scatter-pages)',
    real: 'fragmented VirtualAlloc heaps; upper bound for replacing record scans, not an app-speed claim',
    prepare(inst, a) {
      const pages = [];
      for (let i = 0; i < a.scatterPageCount; i++) {
        // One page in each successive 1MB directory slot prevents adjacent
        // commits from coalescing into the same affine map record.
        const guest = 0x20000000 + i * 0x00100000;
        const got = inst.e.test_virtual_map_commit(guest, 0x1000) >>> 0;
        if (got !== guest) throw new Error(`sparse_scatter: commit 0x${guest.toString(16)} failed`);
        pages.push(guest);
      }
      a.scatterPages = pages;
    },
    emit(a) {
      const n = Math.floor(a.bufBytes / 4);
      const pointers = a.buf;
      return {
        iters: n,
        bytesTouched: n * 8,
        code: loopBack([
          0x8B, 0x06,             // mov eax, [esi]  — direct pointer table
          0x8B, 0x10,             // mov edx, [eax]  — scattered sparse page
          0x01, 0xD3,             // add ebx, edx
          0x83, 0xC6, 0x04,       // add esi, 4
        ]),
        setup(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          for (let i = 0; i < a.scatterPages.length; i++) {
            dv.setUint32(g2w(a.scatterPages[i]), i + 1, true);
          }
          const tableWa = g2w(pointers);
          for (let i = 0; i < n; i++) {
            dv.setUint32(tableWa + i * 4,
              a.scatterPages[i % a.scatterPages.length], true);
          }
          e.set_esi(pointers); e.set_ecx(n); e.set_ebx(0); e.set_eax(0); e.set_edx(0);
        },
        verify(e) {
          const pages = a.scatterPages.length;
          const rounds = Math.floor(n / pages);
          const tail = n % pages;
          let want = rounds * (pages * (pages + 1) / 2);
          for (let i = 0; i < tail; i++) want += i + 1;
          if ((e.get_ebx() >>> 0) !== (want >>> 0)) {
            return `sum=0x${(e.get_ebx() >>> 0).toString(16)} want 0x${(want >>> 0).toString(16)}`;
          }
          if (e.get_ecx() !== 0) return `ecx=${e.get_ecx()}, expected 0`;
          return null;
        },
      };
    },
  },

  lut: {
    describe: 'dst[i] = lut[src[i]] byte loop (Heroes II ICN 0x004c755d, ~9 dispatches/pixel)',
    real: 'Heroes II sprite blitter; the LUT_RUN candidate in docs/loop-idiom-superops-design.md',
    emit(a) {
      const n = Math.floor(a.bufBytes / 2);
      const src = a.buf, dst = a.buf + n, lut = a.lut;
      return {
        iters: n,
        bytesTouched: n * 3,
        code: loopBack([
          0x0F, 0xB6, 0x06,       // movzx eax, byte [esi]
          0x8A, 0x04, 0x03,       // mov   al, [ebx+eax*1]
          0x88, 0x07,             // mov   [edi], al
          0x46,                   // inc   esi
          0x47,                   // inc   edi
        ]),
        setup(e, mem, g2w) {
          // +13 so no index maps to itself and, critically, so lut[0] != 0 —
          // otherwise verifying dst[0]==0 passes on a loop that never ran.
          for (let i = 0; i < 256; i++) mem[g2w(lut) + i] = (i * 7 + 13) & 0xFF;
          for (let i = 0; i < n; i++) mem[g2w(src) + i] = i & 0xFF;
          mem[g2w(dst)] = 0; mem[g2w(dst) + n - 1] = 0;
          e.set_esi(src); e.set_edi(dst); e.set_ebx(lut); e.set_ecx(n); e.set_eax(0);
        },
        verify(e, mem, g2w) {
          for (const i of [0, 1, n >> 1, n - 1]) {
            const want = ((i & 0xFF) * 7 + 13) & 0xFF;
            if (mem[g2w(dst) + i] !== want) return `dst[${i}]=${mem[g2w(dst) + i]} want ${want}`;
          }
          if (e.get_ecx() !== 0) return `ecx=${e.get_ecx()}, expected 0`;
          return null;
        },
      };
    },
  },

  lut16_h3: {
    describe: 'dst16[i] = lut16[src8[i]] (Heroes III 0x44b7ef exact loop shape)',
    real: 'Heroes III 16bpp sprite expansion; nine static LUT_RUN candidates',
    emit(a) {
      const n = Math.floor(a.bufBytes / 3);
      const src = a.buf, dst = src + n, lut = a.lut;
      const body = [
        0x31, 0xC9,                   // xor ecx, ecx
        0x8A, 0x0A,                   // mov cl, [edx]
        0x83, 0xC0, 0x02,             // add eax, 2
        0x42,                         // inc edx
        0x4D,                         // dec ebp
        0x66, 0x8B, 0x4C, 0x4F, 0x50, // mov cx, [edi+ecx*2+0x50]
        0x66, 0x89, 0x48, 0xFE,       // mov [eax-2], cx
      ];
      return {
        iters: n,
        bytesTouched: n * 3,
        code: body.concat([0x75], rel8(-(body.length + 2))),
        setup(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          for (let i = 0; i < 256; i++) {
            dv.setUint16(g2w(lut + 0x50) + i * 2,
              (((i * 17) & 0xF800) | ((i * 29) & 0x07E0) | ((i * 7) & 0x001F)) ^ 0x39E7,
              true);
          }
          for (let i = 0; i < n; i++) mem[g2w(src) + i] = (i * 43 + 11) & 0xFF;
          dv.setUint16(g2w(dst), 0, true);
          dv.setUint16(g2w(dst) + (n - 1) * 2, 0, true);
          e.set_edx(src); e.set_eax(dst); e.set_edi(lut); e.set_ebp(n); e.set_ecx(0);
        },
        verify(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          for (const i of [0, 1, n >> 1, n - 1]) {
            const index = (i * 43 + 11) & 0xFF;
            const want = ((((index * 17) & 0xF800) | ((index * 29) & 0x07E0) |
              ((index * 7) & 0x001F)) ^ 0x39E7) & 0xFFFF;
            const got = dv.getUint16(g2w(dst) + i * 2, true);
            if (got !== want) return `dst16[${i}]=0x${got.toString(16)} want 0x${want.toString(16)}`;
          }
          if (e.get_ebp() !== 0) return `ebp=${e.get_ebp()}, expected 0`;
          if (e.get_edx() !== src + n || e.get_eax() !== dst + n * 2) {
            return 'source/destination cursors did not finish';
          }
          return null;
        },
      };
    },
  },

  lut16_h3_stack: {
    describe: 'stack-loaded table + dst16[i] = lut16[src8[i]] (Heroes III 0x4714bc)',
    real: 'Largest measured Heroes III adventure-map RGB565 loop; table pointer reloads from [esp+0x40]',
    emit(a) {
      const n = Math.floor(a.bufBytes / 3);
      const src = a.buf, dst = src + n, lut = a.lut;
      const body = [
        0x8B, 0x4C, 0x24, 0x40,       // mov ecx, [esp+0x40]
        0x31, 0xC0,                   // xor eax, eax
        0x8A, 0x02,                   // mov al, [edx]
        0x83, 0xC5, 0x02,             // add ebp, 2
        0x42,                         // inc edx
        0x4E,                         // dec esi
        0x66, 0x8B, 0x44, 0x41, 0x1C, // mov ax, [ecx+eax*2+0x1c]
        0x66, 0x89, 0x45, 0xFE,       // mov [ebp-2], ax
      ];
      return {
        iters: n,
        bytesTouched: n * 3,
        code: body.concat([0x75], rel8(-(body.length + 2))),
        setup(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          for (let i = 0; i < 256; i++) {
            dv.setUint16(g2w(lut + 0x1C) + i * 2,
              (((i * 17) & 0xF800) | ((i * 29) & 0x07E0) | ((i * 7) & 0x001F)) ^ 0x39E7,
              true);
          }
          for (let i = 0; i < n; i++) mem[g2w(src) + i] = (i * 43 + 11) & 0xFF;
          dv.setUint16(g2w(dst), 0, true);
          dv.setUint16(g2w(dst) + (n - 1) * 2, 0, true);
          dv.setUint32(g2w(a.stackTop) + 0x40, lut, true);
          e.set_edx(src); e.set_ebp(dst); e.set_esi(n);
          e.set_ecx(0xCCCCCCCC); e.set_eax(0xAAAAAAAA);
        },
        verify(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          for (const i of [0, 1, n >> 1, n - 1]) {
            const index = (i * 43 + 11) & 0xFF;
            const want = ((((index * 17) & 0xF800) | ((index * 29) & 0x07E0) |
              ((index * 7) & 0x001F)) ^ 0x39E7) & 0xFFFF;
            const got = dv.getUint16(g2w(dst) + i * 2, true);
            if (got !== want) return `dst16[${i}]=0x${got.toString(16)} want 0x${want.toString(16)}`;
          }
          if (e.get_esi() !== 0) return `esi=${e.get_esi()}, expected 0`;
          if (e.get_edx() !== src + n || e.get_ebp() !== dst + n * 2) {
            return 'source/destination cursors did not finish';
          }
          if ((e.get_ecx() >>> 0) !== (lut >>> 0)) return 'stack-loaded table register not published';
          return null;
        },
      };
    },
  },

  store_stream: {
    describe: 'mov [edi+edx*1+disp], eax x4 (93% of all Caesar III SIB effective addresses)',
    real: 'Caesar III; the bind-once-store-many candidate',
    emit(a) {
      const n = Math.floor(a.bufBytes / 16);
      return {
        iters: n,
        bytesTouched: n * 16,
        code: loopBack([
          0x89, 0x04, 0x17,             // mov [edi+edx*1], eax
          0x89, 0x44, 0x17, 0x04,       // mov [edi+edx*1+4], eax
          0x89, 0x44, 0x17, 0x08,       // mov [edi+edx*1+8], eax
          0x89, 0x44, 0x17, 0x0C,       // mov [edi+edx*1+12], eax
          0x83, 0xC2, 0x10,             // add edx, 16
        ]),
        setup(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          dv.setUint32(g2w(a.buf), 0, true);
          dv.setUint32(g2w(a.buf) + n * 16 - 4, 0, true);
          e.set_edi(a.buf); e.set_edx(0); e.set_ecx(n); e.set_eax(0xA5A5A5A5 | 0);
        },
        verify(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          for (const off of [0, 4, (n * 16) >> 1, n * 16 - 4]) {
            const got = dv.getUint32(g2w(a.buf) + off, true);
            if (got !== 0xA5A5A5A5) return `[buf+0x${off.toString(16)}]=0x${got.toString(16)} want 0xa5a5a5a5`;
          }
          if (e.get_edx() !== n * 16) return `edx=${e.get_edx()}, expected ${n * 16}`;
          return null;
        },
      };
    },
  },

  stack_traffic: {
    describe: 'push/pop + [ebp-x] spills — the store path on a region that is never code',
    real: 'ubiquitous; the region-typed-store candidate',
    emit(a) {
      const n = a.iterOverride || 2_000_000;
      return {
        iters: n,
        bytesTouched: 0,
        code: loopBack([
          0x50,                   // push eax
          0x53,                   // push ebx
          0x89, 0x45, 0xFC,       // mov [ebp-4], eax
          0x89, 0x5D, 0xF8,       // mov [ebp-8], ebx
          0x5B,                   // pop ebx
          0x58,                   // pop eax
        ]),
        setup(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          // Clear the spill slots, or verify passes on the previous rep's data.
          dv.setUint32(g2w(a.stackTop - 0x100) - 4, 0, true);
          dv.setUint32(g2w(a.stackTop - 0x100) - 8, 0, true);
          e.set_ebp(a.stackTop - 0x100);
          e.set_ecx(n); e.set_eax(1); e.set_ebx(2);
        },
        verify(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          // The push/pop pairs must balance and the spills must have landed.
          if (e.get_eax() !== 1 || e.get_ebx() !== 2) return `eax=${e.get_eax()} ebx=${e.get_ebx()}, expected 1/2`;
          if (dv.getUint32(g2w(a.stackTop - 0x100) - 4, true) !== 1) return '[ebp-4] never written';
          if (dv.getUint32(g2w(a.stackTop - 0x100) - 8, true) !== 2) return '[ebp-8] never written';
          if (e.get_ecx() !== 0) return `ecx=${e.get_ecx()}, expected 0`;
          return null;
        },
      };
    },
  },

  cmp_ladder: {
    describe: 'cmp al,imm8 / jz ladder, 8 cases — CASE_CHAIN NEGATIVE CONTROL (real app: ~0)',
    real: 'Caesar III 0x40f71c token dispatch; folded by handler 423, which measured <=2%',
    emit(a) {
      const CASES = 8;
      const head = [0x8A, 0x06];                    // mov al, [esi]
      const ladder = [];
      // tail sits right after the ladder; each jz reaches it.
      const tailOff = head.length + CASES * 4;
      for (let i = 0; i < CASES; i++) {
        const nextOff = head.length + i * 4 + 4;
        ladder.push(0x3C, i, 0x74, (tailOff - nextOff) & 0xFF);
      }
      const n = Math.floor(a.bufBytes);
      return {
        iters: n,
        bytesTouched: n,
        code: loopBack(head.concat(ladder, [0x46])), // ... inc esi
        setup(e, mem, g2w) {
          for (let i = 0; i < n; i++) mem[g2w(a.buf) + i] = i % CASES;
          e.set_esi(a.buf); e.set_ecx(n); e.set_eax(0);
        },
        verify(e) {
          // The ladder has no memory effect, so the proof it ran is that the
          // cursor walked the whole buffer and AL holds the last token.
          if (e.get_esi() !== a.buf + n) return `esi=0x${e.get_esi().toString(16)}, expected 0x${(a.buf + n).toString(16)}`;
          if ((e.get_eax() & 0xFF) !== (n - 1) % CASES) return `al=${e.get_eax() & 0xFF}, expected ${(n - 1) % CASES}`;
          if (e.get_ecx() !== 0) return `ecx=${e.get_ecx()}, expected 0`;
          return null;
        },
      };
    },
  },

  // --- the block-entry pair -------------------------------------------------
  // These two exist only to be subtracted from each other. Both run K filler
  // ops per iteration and are otherwise identical; the filler is a NOP in one
  // and a `jmp $+0` in the other. A NOP is one dispatch. A `jmp $+0` is one
  // dispatch AND one block end, so it costs an eip store, a cache lookup and a
  // trip round $run's loop on top.
  //
  //   (jmp_chain - nop_chain) / K  =  what a block entry costs
  //
  // Needed because the obvious way to price a block entry -- diff the two arms
  // of cmp_ladder -- is confounded: the unfolded arm runs ~7 MORE real
  // dispatches per iteration as well as 3.5 more block entries, so charging the
  // whole delta to entries overstates them. This pair holds dispatch count
  // equal by construction.
  nop_chain: {
    describe: 'K nops per iteration — the dispatch-only half of the block-entry pair',
    real: 'subtract from jmp_chain to price one block entry',
    emit: a => blockEntryShape(a, false),
  },
  jmp_chain: {
    describe: 'K jmp $+0 per iteration — same dispatches as nop_chain plus K block ends',
    real: 'subtract nop_chain to price one block entry',
    emit: a => blockEntryShape(a, true),
  },

  rep_movsd: {
    describe: 'rep movsd — already lowered to memory.copy; the FLOOR for a bulk copy',
    real: 'every blitter; shows what the store path costs when it is absent entirely',
    emit(a) {
      const n = Math.floor(a.bufBytes / 2 / 4);
      const src = a.buf, dst = a.buf + n * 4;
      return {
        iters: n,
        bytesTouched: n * 8,
        code: [0xF3, 0xA5],           // rep movsd
        setup(e, mem, g2w) {
          // The source MUST carry a pattern. Left zeroed, this shape copies
          // zeros onto zeros and a memory.copy that never ran is byte-identical
          // to one that did — the benchmark would report DRAM bandwidth for
          // doing nothing. `verify` below is what makes that impossible.
          const dv = new DataView(mem.buffer);
          for (let i = 0; i < n; i++) dv.setUint32(g2w(src) + i * 4, i ^ 0x5A5A0000, true);
          dv.setUint32(g2w(dst), 0, true);
          dv.setUint32(g2w(dst) + (n - 1) * 4, 0, true);
          e.set_esi(src); e.set_edi(dst); e.set_ecx(n);
        },
        verify(e, mem, g2w) {
          const dv = new DataView(mem.buffer);
          for (const i of [0, 1, n >> 1, n - 1]) {
            const got = dv.getUint32(g2w(dst) + i * 4, true);
            const want = (i ^ 0x5A5A0000) >>> 0;
            if (got !== want) return `dst[${i}]=0x${got.toString(16)} want 0x${want.toString(16)}`;
          }
          if (e.get_ecx() !== 0) return `ecx=${e.get_ecx()}, expected 0`;
          return null;
        },
      };
    },
  },
};

const TOGGLES = {
  lut_superops: 'set_loop_lut_emit',
  lut16_stack: 'set_loop_lut16_stack_emit',
  case_chain: 'set_case_chain',
  rle_run: 'set_rle_run',
  rect_run: 'set_rect_run',
};

// ---------------------------------------------------------------------------
// Instance management
// ---------------------------------------------------------------------------
let TOP_N = 6;

function ensureBuilt() {
  let wasmTime = 0;
  try { wasmTime = fs.statSync(WASM_PATH).mtimeMs; } catch (_) {}
  const srcDir = path.join(ROOT, 'src');
  const stale = fs.readdirSync(srcDir)
    .filter(f => f.endsWith('.wat'))
    .some(f => fs.statSync(path.join(srcDir, f)).mtimeMs > wasmTime);
  if (stale) {
    console.error('Building...');
    execSync('bash tools/build.sh', { cwd: ROOT, stdio: 'inherit' });
  }
}

async function newInstance() {
  const { createHostImports } = require(path.join(ROOT, 'lib/host-imports'));
  const wasmBytes = fs.readFileSync(WASM_PATH);
  const exeBytes = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'notepad.exe'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer };
  const h = createHostImports(ctx).host;
  h.memory = memory;
  h.exit = () => {};
  h.log = () => {};
  h.log_i32 = process.env.BENCH_TRACE_LOOP
    ? v => console.log(`[i32] 0x${(v >>> 0).toString(16)}`)
    : () => {};
  h.crash_unimplemented = () => {};
  h.wait_multiple = () => 0;
  h.shell_execute = () => 33;

  const { instance } = await WebAssembly.instantiate(wasmBytes, { host: h });
  ctx.exports = instance.exports;
  const e = instance.exports;
  const mem = new Uint8Array(e.memory.buffer);
  mem.set(exeBytes, e.get_staging());
  e.load_pe(exeBytes.length);

  const imageBase = e.get_image_base();
  // Use the module's translator so the same setup/verification code works for
  // both ordinary direct addresses and demand-backed sparse guest mappings.
  const g2w = ga => e.guest_to_wasm(ga >>> 0) >>> 0;
  return { e, mem, g2w, imageBase };
}

// Guest-address layout for a shape run. Everything sits inside the direct g2w
// window (wa < 0x8000000) and below the guest stack at imageBase+0x3C00000, so
// no sparse mapping or DIB range is involved. That is deliberate for --cold:
// it prices the g2w FAST path. Exercising the sparse and code-marked paths is
// what warm mode (boot a real app, then inject) is for — see the notes at the
// bottom of this file.
// Guest addresses are laid out so the working buffer sits ABOVE the scratch
// stack, not below it: with the buffer first, a --bytes large enough to be
// interesting ran straight over the stack and the shape trapped on its own
// return address. The whole point of this tool is large working sets, so the
// layout has to make that the safe direction.
function layout(imageBase, bufBytes) {
  const a = {
    code: imageBase + 0x040000,   // fresh page per rep, bumped by the caller
    lut: imageBase + 0x100000,    // 256 bytes
    stackTop: imageBase + 0x800000,
    buf: imageBase + 0x1000000,
    bufBytes,
  };
  // g2w's direct window is wa < 0x8000000, i.e. ga - imageBase < ~0x7FEE000.
  // Past that a guest address falls through to the sparse scan and finally to
  // NULL_SENTINEL, which silently turns the whole benchmark into a no-op
  // against a 4-byte sink rather than failing.
  const top = a.buf + bufBytes;
  if (top - imageBase >= 0x7000000) {
    throw new Error(`--bytes=${bufBytes} puts the working set at 0x${(top - imageBase).toString(16)} ` +
      `past the image base, outside g2w's direct window (limit ~112MB)`);
  }
  return a;
}

function runToCompletion(e, codeAddr, stackTop) {
  e.set_esp(stackTop);
  // Sentinel return address: the final `ret` pops 0 into EIP, which is how
  // $run's loop learns the shape finished.
  new DataView(e.memory.buffer).setUint32(stackTop - e.get_image_base() + 0x12000, 0, true);
  e.set_eip(codeAddr);
  for (let i = 0; i < 4096; i++) {
    e.run(0x7FFFFFFF);
    if (e.get_eip() === 0) return true;
  }
  return false;
}

// One measured rep. The code is re-emitted at a FRESH address every time so the
// block is decoded fresh — that is what makes a decode-time fold toggle take
// effect without a clear_cache export, and it keeps both A/B arms paying the
// same decode cost.
function oneRep({ e, mem, g2w }, shape, a, repIndex) {
  const codeAddr = a.code + repIndex * 0x1000;
  const built = shape.emit(a);
  const bytes = built.code.concat([0xC3]);           // ret to the 0 sentinel
  mem.set(bytes, g2w(codeAddr));
  built.setup(e, mem, g2w);
  if (process.env.BENCH_TRACE_LOOP && e.set_loop_trace) e.set_loop_trace(1, codeAddr);
  const t0 = process.hrtime.bigint();
  const ok = runToCompletion(e, codeAddr, a.stackTop);
  const t1 = process.hrtime.bigint();
  if (!ok) throw new Error(`${shape.name}: guest loop did not return (EIP=0x${e.get_eip().toString(16)})`);
  // Every rep is verified, outside the timed region and unconditionally. A
  // shape that silently does nothing reports the machine's memory bandwidth
  // for doing nothing, which reads exactly like a spectacular result — this is
  // how rep_movsd shipped copying zeros onto zeros.
  if (built.verify) {
    const why = built.verify(e, mem, g2w);
    if (why) throw new Error(`${shape.name}: shape did not do its work — ${why}`);
  }
  return { ns: Number(t1 - t0), built };
}

function countOps(inst, shape, a, repIndex) {
  const { e, mem } = inst;
  const lutRuns0 = e.get_loop_lut_runs ? e.get_loop_lut_runs() : 0;
  const lutBytes0 = e.get_loop_lut_bytes ? e.get_loop_lut_bytes() : 0n;
  const lut16Runs0 = e.get_loop_lut16_runs ? e.get_loop_lut16_runs() : 0;
  const lut16Bytes0 = e.get_loop_lut16_bytes ? e.get_loop_lut16_bytes() : 0n;
  const lut16Matches0 = e.get_loop_lut16_matches ? e.get_loop_lut16_matches() : 0;
  const matched0 = e.get_loop_matched_blocks ? e.get_loop_matched_blocks() : 0;
  e.set_handler_hist_enabled(1);
  e.reset_handler_hist();
  oneRep(inst, shape, a, repIndex);
  e.set_handler_hist_enabled(0);
  const base = e.get_handler_hist_base();
  const slots = e.get_handler_hist_slots();
  const dv = new DataView(e.memory.buffer);
  let total = 0;
  const perHandler = [];
  for (let i = 0; i < slots; i++) {
    const c = dv.getUint32(base + i * 4, true);
    if (c) { total += c; perHandler.push([i, c]); }
  }
  perHandler.sort((x, y) => y[1] - x[1]);

  // Block ENTRIES, from the same gate (13-exports.wat:181 records the hot-block
  // histogram whenever handler_hist is on, and reset_handler_hist clears it).
  //
  // This is not a nicety. A block entry costs an eip store, a cache lookup and
  // a trip round $run's loop, and NONE of that is a handler dispatch — so the
  // handler histogram, which is what every fusion in this repo has been judged
  // on, is structurally blind to it. Every `jz` in an unfolded switch ladder
  // ends a block; folding the ladder deletes those entries while leaving the
  // dispatch count almost unchanged. Measure both or you cannot see the fold.
  const hbBase = e.get_hot_block_hist_base();
  const hbCount = e.get_hot_block_hist_count();
  let blockEntries = 0;
  for (let i = 0; i < hbCount; i++) {
    if (dv.getUint32(hbBase + i * 8, true) !== 0) {
      blockEntries += dv.getUint32(hbBase + i * 8 + 4, true);
    }
  }
  // The hot-block histogram is a 4-way bucket, and $hot_block_hist_record
  // (04-cache.wat:727) bumps the collision counter exactly once per entry it
  // could not place. So recorded + collisions is the EXACT entry count, not an
  // estimate — and the recorded half alone can be wildly short. jmp_chain
  // records 5.00 blocks/iter against a true 9.00, which put this tool's first
  // block-entry price at 25ns instead of 11.5ns.
  const blockCollisions = e.get_hot_block_hist_collisions();
  blockEntries += blockCollisions;
  return {
    total, blockEntries, blockCollisions,
    top: perHandler.slice(0, TOP_N), all: perHandler,
    lutRuns: e.get_loop_lut_runs ? e.get_loop_lut_runs() - lutRuns0 : 0,
    lutBytes: e.get_loop_lut_bytes ? e.get_loop_lut_bytes() - lutBytes0 : 0n,
    lut16Runs: e.get_loop_lut16_runs ? e.get_loop_lut16_runs() - lut16Runs0 : 0,
    lut16Bytes: e.get_loop_lut16_bytes ? e.get_loop_lut16_bytes() - lut16Bytes0 : 0n,
    lut16Matches: e.get_loop_lut16_matches ? e.get_loop_lut16_matches() - lut16Matches0 : 0,
    matched: e.get_loop_matched_blocks ? e.get_loop_matched_blocks() - matched0 : 0,
  };
}

// ---------------------------------------------------------------------------
function parseBytes(s) {
  const m = /^(\d+)([kmg]?)$/i.exec(String(s));
  if (!m) throw new Error(`bad --bytes: ${s}`);
  const mult = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

function fmt(n) { return n.toLocaleString('en-US'); }

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const hit = argv.find(x => x.startsWith(`--${name}=`));
    return hit === undefined ? dflt : hit.slice(name.length + 3);
  };
  const has = name => argv.includes(`--${name}`);

  if (has('list')) {
    for (const [name, s] of Object.entries(SHAPES)) {
      console.log(`${name.padEnd(14)} ${s.describe}`);
      console.log(`${' '.repeat(14)} real: ${s.real}`);
    }
    return;
  }

  const bufBytes = parseBytes(arg('bytes', '4m'));
  const reps = Number(arg('reps', 9));
  const toggle = arg('toggle', null);
  const wantJson = has('json');
  const mapping = arg('mapping', 'direct');
  const scatterPageCount = Number(arg('scatter-pages', 64));
  TOP_N = Number(arg('top', 6));
  const names = String(arg('shapes', Object.keys(SHAPES).join(','))).split(',').filter(Boolean);

  for (const n of names) if (!SHAPES[n]) throw new Error(`unknown shape: ${n} (try --list)`);
  if (toggle && !TOGGLES[toggle]) throw new Error(`unknown toggle: ${toggle} (${Object.keys(TOGGLES).join(', ')})`);
  if (!['direct', 'sparse'].includes(mapping)) {
    throw new Error(`unknown --mapping=${mapping} (expected direct or sparse)`);
  }
  if (!Number.isInteger(scatterPageCount) || scatterPageCount < 1 || scatterPageCount > 256) {
    throw new Error(`bad --scatter-pages=${scatterPageCount} (expected integer 1..256)`);
  }

  ensureBuilt();

  const results = [];
  for (const name of names) {
    const shape = { ...SHAPES[name], name };
    // A fresh instance per shape: a block cache and code-page bitmap carried
    // over from the previous shape would make this one's numbers depend on run
    // order, which is the exact failure mode that wrecked the whole-app A/Bs.
    const inst = await newInstance();
    const a = layout(inst.imageBase, bufBytes);
    a.scatterPageCount = scatterPageCount;
    if (mapping === 'sparse') {
      const sparse = inst.e.guest_map_alloc(bufBytes) >>> 0;
      if (!sparse) throw new Error(`${name}: could not allocate ${bufBytes} sparse guest bytes`);
      a.buf = sparse;
    }
    if (shape.prepare) shape.prepare(inst, a);


    const arms = toggle
      ? String(arg('arms', '1,0')).split(',').map(Number)
      : [null];
    const armNs = new Map(arms.map(v => [v, []]));
    const armOps = new Map();

    let repIndex = 0;
    for (const v of arms) {
      if (v !== null) inst.e[TOGGLES[toggle]](v);
      armOps.set(v, countOps(inst, shape, a, repIndex++));
    }
    // Interleave the arms rep by rep. Background load drifts on the scale of
    // seconds; alternating at millisecond granularity makes it common-mode.
    //
    // And ROTATE the order within each rep. docs/interpreter-dispatch-perf.md
    // pass 3 gave every variant a fixed slot in the round and manufactured four
    // 6-11% "speedups" out of slot position alone; pass 4, same binaries with
    // the order rotated, flipped one of them from -7.3% to +17.5%. Interleaving
    // removes drift between variants but not between positions.
    for (let r = 0; r < reps; r++) {
      // Rotate every arm through every slot. Reversing is sufficient for two
      // arms, but leaves the middle arm permanently in slot 2 for three arms.
      const shift = r % arms.length;
      const order = arms.slice(shift).concat(arms.slice(0, shift));
      for (const v of order) {
        if (v !== null) inst.e[TOGGLES[toggle]](v);
        const { ns, built } = oneRep(inst, shape, a, repIndex++);
        armNs.get(v).push(ns);
        a.lastBuilt = built;
      }
    }

    const built = a.lastBuilt;
    const row = {
      shape: name,
      iters: built.iters,
      bytesTouched: built.bytesTouched,
      arms: arms.map(v => {
        const ns = armNs.get(v).slice().sort((x, y) => x - y);
        const ops = armOps.get(v);
        // Minima, not means: contention is one-sided, it only ever adds time.
        const min = ns[0];
        const median = ns[Math.floor(ns.length / 2)];
        return {
          arm: v === null ? 'base' : `${toggle}=${v}`,
          minMs: min / 1e6,
          medianMs: median / 1e6,
          nsPerIter: min / built.iters,
          opsTotal: ops.total,
          opsPerIter: ops.total / built.iters,
          nsPerOp: ops.total ? min / ops.total : 0,
          bytesPerIter: built.bytesTouched / built.iters,
          blockEntries: ops.blockEntries,
          blocksPerIter: ops.blockEntries / built.iters,
          blockCollisions: ops.blockCollisions,
          // Handlers 420-424 deliberately re-record the ops they replaced into
          // the histogram so totals stay comparable with a fold-off build (see
          // $th_case_chain in 06b-core-handlers.wat). When one of them is live,
          // opsTotal is NOT the dispatch count — it is the unfolded-equivalent
          // count plus the fold's own dispatch. Read blocksPerIter instead.
          foldsLive: ops.all.filter(([i]) => i >= 420 && i <= 424).map(([i]) => `H${i}`),
          lutRuns: ops.lutRuns,
          lutBytes: Number(ops.lutBytes),
          lut16Matches: ops.lut16Matches,
          lut16Runs: ops.lut16Runs,
          lut16Bytes: Number(ops.lut16Bytes),
          matched: ops.matched,
          topHandlers: ops.top,
          guestMBps: built.bytesTouched ? (built.bytesTouched / (min / 1e9)) / (1024 * 1024) : null,
        };
      }),
    };
    if (arms.length > 1) {
      const baseline = armNs.get(arms[arms.length - 1]);
      row.paired = arms.slice(0, -1).map(v => {
        const ratios = armNs.get(v).map((ns, i) =>
          (baseline[i] - ns) / baseline[i] * 100).sort((x, y) => x - y);
        return { arm: `${toggle}=${v}`, vs: `${toggle}=${arms[arms.length - 1]}`,
          medianPct: ratios[Math.floor(ratios.length / 2)] };
      });
    }
    if (arms.length === 2) {
      const [on, off] = row.arms;
      row.delta = {
        timePct: (off.minMs - on.minMs) / off.minMs * 100,
        opsPct: (off.opsTotal - on.opsTotal) / off.opsTotal * 100,
        blocksPct: (off.blockEntries - on.blockEntries) / off.blockEntries * 100,
      };
    }
    results.push(row);
  }

  if (wantJson) { console.log(JSON.stringify({ bufBytes, reps, mapping, toggle, results }, null, 2)); return; }

  console.log(`\nworking set ${fmt(bufBytes)} bytes (${mapping} guest mapping), ${reps} interleaved reps, minima quoted`);
  if (toggle) console.log(`A/B toggle: ${toggle} (on vs off, same process, alternating)`);
  console.log('');
  for (const r of results) {
    console.log(`${r.shape}  —  ${SHAPES[r.shape].describe}`);
    console.log(`  ${fmt(r.iters)} iterations, ${fmt(r.bytesTouched)} guest bytes touched`);
    for (const arm of r.arms) {
      // MB/s is bytes/time, and the shapes move 1, 3 and 16 bytes per
      // iteration — so it is NOT comparable ACROSS shapes, only between two
      // arms of one shape, or between two shapes moving the same bytes by
      // different routes (store_stream vs rep_movsd is the one that matters).
      // ns/op is the cross-shape number: it says what one interpreted x86
      // instruction of this kind costs.
      const mb = arm.guestMBps === null ? '' : `  ${arm.guestMBps.toFixed(0)} MB/s(same-shape only)`;
      console.log(`    ${arm.arm.padEnd(16)} min ${arm.minMs.toFixed(1)}ms  med ${arm.medianMs.toFixed(1)}ms  ` +
        // A REP is one op for the whole range, so per-op cost is not a
        // per-instruction number there and printing it invites nonsense.
        `${arm.nsPerIter.toFixed(1)} ns/iter  ${arm.opsPerIter >= 1 ? `${arm.nsPerOp.toFixed(1)} ns/op` : '(bulk op)'}  ` +
        `${arm.opsPerIter.toFixed(2)} ops/iter  ${arm.bytesPerIter} B/iter  ` +
        `${arm.blocksPerIter.toFixed(2)} blocks/iter${mb}`);
      console.log(`    ${' '.repeat(16)} top handlers: ${arm.topHandlers.map(([i, c]) => `H${i}:${fmt(c)}`).join('  ')}`);
      console.log(`    ${' '.repeat(16)} LUT matches/runs/bytes: ${fmt(arm.matched)}/${fmt(arm.lutRuns)}/${fmt(arm.lutBytes)}`);
      if (arm.lut16Matches || arm.lut16Runs) {
        console.log(`    ${' '.repeat(16)} RGB565 matches/runs/pixels: ` +
          `${fmt(arm.lut16Matches)}/${fmt(arm.lut16Runs)}/${fmt(arm.lut16Bytes)}`);
      }
      if (arm.blockCollisions) {
        console.log(`    ${' '.repeat(16)} (${fmt(arm.blockCollisions)} of those entries came from the collision counter, ` +
          `not the bucket)`);
      }
      if (arm.foldsLive.length) {
        console.log(`    ${' '.repeat(16)} NOTE: ${arm.foldsLive.join(',')} live — ops/iter is the unfolded-equivalent`);
        console.log(`    ${' '.repeat(16)}       count, not the dispatch count, so ns/op is understated too.`);
        console.log(`    ${' '.repeat(16)}       Compare blocks/iter and time.`);
      }
    }
    if (r.delta) {
      const sign = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
      console.log(`    => fold is worth ${sign(r.delta.timePct)} time, ` +
        `${sign(r.delta.opsPct)} ops, ${sign(r.delta.blocksPct)} block entries`);
    }
    if (r.paired) {
      for (const p of r.paired) {
        console.log(`    => paired median ${p.arm} vs ${p.vs}: ${p.medianPct >= 0 ? '+' : ''}${p.medianPct.toFixed(1)}%`);
      }
    }
    console.log('');
  }
  console.log('Reminder: this harness understates dispatch cost (a periodic loop is');
  console.log('perfectly BTB-predicted) and says nothing about whether a shape occurs in');
  console.log('real code. Pair every result with --handler-hist / tools/match-loops.js.');
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
