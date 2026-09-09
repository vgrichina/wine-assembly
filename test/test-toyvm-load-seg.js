'use strict';

// Where DOS puts the program, and whether the rest of the machine follows it.
//
// The load address stopped being a constant: `--psp-seg=` / `--load-seg=` on
// run-dos.js and `pspSeg`/`loadSeg` on the Machine move it, and the corpus
// registry (tools/toyvm/program-config.js) names one per program. ACME-VIC.EXE
// is why -- it stores a byte through a DS it forgot to reload, and at the
// default address that byte lands on its own code. See program-config.js.
//
// Moving the PSP is only half a machine. Everything derived from it has to
// move with it, and every one of those is silent when it does not:
//
//   * the PSP itself and its environment pointer,
//   * the free-memory arithmetic -- (ceiling - PSP) * 16, which is what a
//     program's "I need 600K" check reads,
//   * and the MCB chain, whose middle now spans 49KB instead of 1KB. If that
//     gap carries no arena header the chain has a hole and a walk runs into
//     garbage; if it carries one owned by 0 it reads as FREE, and a program
//     adding up the free blocks is told it has 49KB that do not exist. Real
//     DOS writes owner 8 there: the kernel, its buffers and the drivers.
//
// So the probe is a program that walks the chain the way MEM.EXE does -- INT
// 21h AH=52h for the list of lists, the first MCB segment out of the word two
// bytes below it, then header to header until one signs 'Z' -- and adds up
// what it finds by owner. Run at two load addresses, its answers have to move
// by exactly the difference between them and no more.
//
// It shrinks its own block first (AH=4Ah), because a .COM is handed everything
// up to the ceiling and a chain with no free block in it cannot show whether
// free memory tracked the move at all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDos } = require('../tools/toyvm/run-dos');
const {
  PSP_SEG, ENV_SEG, ENV_PARAS, MCB_FIRST, MCB_SYSTEM, DEFAULT_ALLOC_TOP,
} = require('../tools/toyvm/dos');

// How many paragraphs the probe keeps for itself when it shrinks.
const KEEP = 0x1000;

// Where in its own segment the probe leaves its answers.
const OUT = 0x300;
const F = {
  psp: OUT + 0x00, first: OUT + 0x02, count: OUT + 0x04, free: OUT + 0x06,
  sys: OUT + 0x08, mine: OUT + 0x0A, lastSig: OUT + 0x0C, ownerBelowPsp: OUT + 0x0E,
};

// --- a very small assembler ------------------------------------------------
// Two passes over a byte list with named labels, so the walk below can be read
// as code rather than as a column of hand-counted jump displacements. Only the
// forms this probe uses exist.
function asm() {
  const out = [];
  const labels = new Map();
  const fix = [];
  const w = (v) => { out.push(v & 0xFF, (v >> 8) & 0xFF); };
  const api = {
    db(...b) { out.push(...b); return api; },
    dw(v) { w(v); return api; },
    at(name) { labels.set(name, out.length); return api; },
    // Every jump here is rel8; the probe is far shorter than 127 bytes of body.
    jump(op, name) { out.push(op); out.push(0); fix.push({ slot: out.length - 1, name }); return api; },
    bytes() {
      for (const f of fix) {
        if (!labels.has(f.name)) throw new Error(`no such label: ${f.name}`);
        const rel = labels.get(f.name) - (f.slot + 1);
        assert.ok(rel >= -128 && rel <= 127, `${f.name} is out of rel8 range (${rel})`);
        out[f.slot] = rel & 0xFF;
      }
      return Uint8Array.from(out);
    },
  };
  return api;
}

function mcbWalkCom() {
  const a = asm();
  const movAxImmStore = (off) => a.db(0xA3).dw(off);          // mov [off], ax
  a.db(0x8C, 0xC8);                                            // mov ax, cs
  a.db(0x8B, 0xE8);                                            // mov bp, ax     (our PSP)
  movAxImmStore(F.psp);
  // Zero the accumulators: the segment above the image is whatever memory was
  // there, and at a moved load address that is not necessarily zero.
  a.db(0x31, 0xC0);                                            // xor ax, ax
  for (const off of [F.count, F.free, F.sys, F.mine, F.lastSig]) movAxImmStore(off);
  // Give back everything above KEEP paragraphs, so the chain has a free block.
  a.db(0x8C, 0xC8);                                            // mov ax, cs
  a.db(0x8E, 0xC0);                                            // mov es, ax
  a.db(0xBB).dw(KEEP);                                         // mov bx, KEEP
  a.db(0xB4, 0x4A);                                            // mov ah, 4Ah
  a.db(0xCD, 0x21);                                            // int 21h
  // The arena header immediately below the PSP: DOS's record that this block
  // is the program's. A walk can start here too, which is the other half of
  // "the chain is well formed".
  a.db(0x8B, 0xC5);                                            // mov ax, bp
  a.db(0x48);                                                  // dec ax
  a.db(0x8E, 0xC0);                                            // mov es, ax
  a.db(0x26, 0xA1).dw(0x0001);                                 // mov ax, es:[1]
  movAxImmStore(F.ownerBelowPsp);
  // The list of lists, and the first MCB out of the word below it.
  a.db(0xB4, 0x52);                                            // mov ah, 52h
  a.db(0xCD, 0x21);                                            // int 21h
  a.db(0x26, 0x8B, 0x47, 0xFE);                                // mov ax, es:[bx-2]
  movAxImmStore(F.first);
  a.db(0x8B, 0xF0);                                            // mov si, ax

  a.at('walk');
  a.db(0x8E, 0xC6);                                            // mov es, si
  a.db(0x26, 0xA0).dw(0x0000);                                 // mov al, es:[0]  signature
  a.db(0x26, 0x8B, 0x1E).dw(0x0001);                           // mov bx, es:[1]  owner
  a.db(0x26, 0x8B, 0x0E).dw(0x0003);                           // mov cx, es:[3]  paragraphs
  a.db(0xFF, 0x06).dw(F.count);                                // inc word [count]
  a.db(0xB4, 0x00);                                            // mov ah, 0
  movAxImmStore(F.lastSig);                                    // remember the signature
  a.db(0x81, 0xFB).dw(0x0000);                                 // cmp bx, 0
  a.jump(0x75, 'notFree');
  a.db(0x01, 0x0E).dw(F.free);                                 // add [free], cx
  a.jump(0xEB, 'next');
  a.at('notFree');
  a.db(0x81, 0xFB).dw(MCB_SYSTEM);                             // cmp bx, 8
  a.jump(0x75, 'notSys');
  a.db(0x01, 0x0E).dw(F.sys);                                  // add [sys], cx
  a.jump(0xEB, 'next');
  a.at('notSys');
  a.db(0x39, 0xEB);                                            // cmp bx, bp
  a.jump(0x75, 'next');
  a.db(0x01, 0x0E).dw(F.mine);                                 // add [mine], cx
  a.at('next');
  a.db(0x3C, 0x5A);                                            // cmp al, 'Z'
  a.jump(0x74, 'done');
  a.db(0x8B, 0xD6);                                            // mov dx, si
  a.db(0x01, 0xCA);                                            // add dx, cx
  a.db(0x42);                                                  // inc dx
  a.db(0x8B, 0xF2);                                            // mov si, dx
  // A chain that never signs 'Z' must not walk into the video ROM forever.
  a.db(0x81, 0xFE).dw(0xA000);                                 // cmp si, A000h
  a.jump(0x72, 'walk');
  a.at('done');
  a.db(0xCD, 0x20);                                            // int 20h
  return a.bytes();
}

async function walkAt(dir, pspSeg) {
  const exe = path.join(dir, 'MCBWALK.COM');
  fs.writeFileSync(exe, mcbWalkCom());
  const opts = { exe, budget: 2e6 };
  if (pspSeg !== null) { opts.pspSeg = pspSeg; opts.loadSeg = pspSeg + 0x10; }
  const r = await runDos(opts);
  const psp = pspSeg === null ? PSP_SEG : pspSeg;
  assert.ok(r.machine.exited,
    `the probe must reach int 20h at psp ${psp.toString(16)}, not run out of budget`
    + ` (cs:ip=${r.vm.get('cs').toString(16)}:${r.vm.get('gip').toString(16)})`);
  const base = psp << 4;
  const rd = (off) => r.vm.mem[base + off] | (r.vm.mem[base + off + 1] << 8);
  return {
    psp: rd(F.psp), first: rd(F.first), count: rd(F.count), free: rd(F.free),
    sys: rd(F.sys), mine: rd(F.mine), lastSig: rd(F.lastSig),
    ownerBelowPsp: rd(F.ownerBelowPsp),
  };
}

function check(w, psp) {
  const h = (n) => `0x${n.toString(16)}`;
  assert.strictEqual(w.psp, psp,
    `the program must be entered with CS at the configured PSP; got ${h(w.psp)}`);
  assert.strictEqual(w.ownerBelowPsp, psp,
    `the arena header below the PSP must say the program owns its block;`
    + ` got owner ${h(w.ownerBelowPsp)} at ${h(psp - 1)}`);
  assert.strictEqual(w.first, MCB_FIRST,
    `AH=52h must lead to the first arena header; got ${h(w.first)}`);
  assert.strictEqual(w.lastSig, 0x5A,
    `the walk must end on a 'Z' header, not run off the end;`
    + ` last signature was ${h(w.lastSig)} after ${w.count} block(s)`);
  // environment, DOS+drivers, the program, the tail it gave back.
  assert.strictEqual(w.count, 4,
    `expected 4 blocks in the chain (environment, system, program, free); got ${w.count}`);

  // The gap between the environment block and the PSP is DOS and its drivers,
  // and it MUST NOT read as free -- that is the whole reason the middle rung
  // exists. At the default address it is 0x3F paragraphs; at 0x0D00, 0xC3F.
  const sys = psp - 1 - (ENV_SEG + ENV_PARAS + 1);
  assert.strictEqual(w.sys, sys,
    `the memory below the PSP must be owned by DOS (${h(MCB_SYSTEM)}):`
    + ` expected ${h(sys)} paragraphs, walk found ${h(w.sys)}`);

  // What the program holds: its environment plus the block it kept.
  assert.strictEqual(w.mine, ENV_PARAS + KEEP,
    `expected the program to own ${h(ENV_PARAS + KEEP)} paragraphs`
    + ` (environment ${h(ENV_PARAS)} + kept ${h(KEEP)}); got ${h(w.mine)}`);

  // Free memory is the ceiling less where the program ends, less the free
  // block's own header. This is the number a "600K or I quit" check reads.
  const free = DEFAULT_ALLOC_TOP - (psp + KEEP) - 1;
  assert.strictEqual(w.free, free,
    `free memory must follow the load address: expected ${h(free)} paragraphs`
    + ` at psp ${h(psp)}, walk found ${h(w.free)}`);

  // ...and the four blocks plus their headers must tile the arena exactly,
  // with no hole and no overlap.
  const covered = w.sys + w.mine + w.free + w.count;
  const arena = DEFAULT_ALLOC_TOP - MCB_FIRST;
  assert.strictEqual(covered, arena,
    `the chain must cover the arena with no hole: ${h(covered)} paragraphs`
    + ` of ${h(arena)} from ${h(MCB_FIRST)} to ${h(DEFAULT_ALLOC_TOP)}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-loadseg-'));
  const MOVED = 0x0D00;                     // the address the registry gives ACME-VIC

  const base = await walkAt(dir, null);
  check(base, PSP_SEG);
  const moved = await walkAt(dir, MOVED);
  check(moved, MOVED);

  // The whole point, stated as one number: everything the move costs is the
  // move, and free memory pays for it paragraph for paragraph.
  const delta = MOVED - PSP_SEG;
  assert.strictEqual(base.free - moved.free, delta,
    `moving the program up ${delta.toString(16)} paragraphs must cost exactly that`
    + ` much free memory; free went ${base.free.toString(16)} ->`
    + ` ${moved.free.toString(16)}`);
  assert.strictEqual(moved.sys - base.sys, delta,
    `...and DOS must be the one holding it: system paragraphs went`
    + ` ${base.sys.toString(16)} -> ${moved.sys.toString(16)}`);
  assert.strictEqual(base.mine, moved.mine,
    'what the program itself owns must not change with the load address');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`PASS test-toyvm-load-seg (psp ${PSP_SEG.toString(16)}: free`
    + ` ${base.free.toString(16)}, dos ${base.sys.toString(16)};`
    + ` psp ${MOVED.toString(16)}: free ${moved.free.toString(16)},`
    + ` dos ${moved.sys.toString(16)})`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
