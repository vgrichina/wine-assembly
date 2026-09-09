'use strict';

// The VBE (VESA BIOS Extension) half of INT 10h: what it says it supports, what
// it refuses, and whether a mode it claims actually produces a picture.
//
// The failure this exists to prevent is a SILENT SUCCESS. Every VBE reply is
// AX=004Fh for "yes" and anything else for "no", so answering 004Fh is free --
// and a mode reported as supported that the frame reader cannot read is worse
// than a refusal: the program sets it, draws into the bank window, and the PNG,
// the frame hash and the live page all read the bytes at the wrong width or not
// at all. That looks exactly like a demo that draws nothing, with no call
// anywhere saying otherwise. So the checks below are in pairs -- a served mode
// must be granted AND render, an unserved one must be refused.
//
// Everything is asked by a guest program, hand-assembled as a .COM, because the
// path that matters runs from the guest: ES:DI buffers filled by the BIOS, the
// 64KB window at A000, and the bank switch through AX=4F05 that moves it. A
// JS-side call into vesaCall would exercise none of that.
//
// The four 8bpp modes are the ones the corpus asks for by name; 0x112 (640x480
// 24bpp direct colour) is here because CHROME.EXE asks 4F01 about exactly that
// one and takes its own no-VESA path when refused. Direct colour is a different
// surface from mode 13h -- three bytes a pixel, blue first, no palette in the
// path -- so it gets its own render check rather than sharing the 8bpp one.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDos } = require('../tools/toyvm/run-dos');
const { PSP_SEG } = require('../tools/toyvm/dos');
const fb = require('../tools/toyvm/framebuffer');
const isa = require('../tools/toyvm/isa');

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

// Where the guest leaves its answers, in its own segment: one word per call at
// 0x500 and up, and the BIOS blocks at 0x600. A .COM loads at 0x100 and this
// one is under 0x100 bytes long, so both are free memory.
const OUT = 0x500;
const BUF = 0x600;      // AX=4F00's controller block
const MODEBUF = 0x700;  // AX=4F01's mode block, kept apart so both survive

const lo = (v) => v & 0xFF;
const hi = (v) => (v >> 8) & 0xFF;

// mov cx,mode / mov ax,4F01 / mov di,MODEBUF / int 10h / mov [slot],ax
const modeInfo = (mode, slot) => [
  0xB9, lo(mode), hi(mode),
  0xB8, 0x01, 0x4F,
  0xBF, lo(MODEBUF), hi(MODEBUF),
  0xCD, 0x10,
  0xA3, lo(slot), hi(slot),
];

function vbeCom() {
  return Uint8Array.from([
    0x1E, 0x07,                     // push ds / pop es   (the BIOS blocks are ours)

    // AX=4F00: controller info into ES:DI.
    0xB8, 0x00, 0x4F,
    0xBF, lo(BUF), hi(BUF),
    0xCD, 0x10,
    0xA3, lo(OUT), hi(OUT),

    // AX=4F01: mode info. A served 8bpp mode, the served 24bpp one, a mode we
    // do not serve, and the served 24bpp one again with the linear-framebuffer
    // bit set -- which we have no address for and must refuse.
    ...modeInfo(0x101, OUT + 2),
    ...modeInfo(0x112, OUT + 4),
    ...modeInfo(0x114, OUT + 6),
    ...modeInfo(0x4112, OUT + 8),

    // The 24bpp block is the one read back below, so ask for it last.
    ...modeInfo(0x112, OUT + 10),

    // AX=4F02 BX=0x112: set it.
    0xBB, 0x12, 0x01,
    0xB8, 0x02, 0x4F,
    0xCD, 0x10,
    0xA3, lo(OUT + 12), hi(OUT + 12),

    // Sixteen red pixels at the top left of bank 0. Direct colour is three
    // bytes a pixel in BLUE, GREEN, RED order.
    0xB8, 0x00, 0xA0,               // mov ax,0xA000
    0x8E, 0xC0,                     // mov es,ax
    0x31, 0xFF,                     // xor di,di
    0xB9, 0x10, 0x00,               // mov cx,16
    0x30, 0xC0,                     // fill: xor al,al
    0xAA,                           //       stosb            (blue)
    0xAA,                           //       stosb            (green)
    0xB0, 0xFF,                     //       mov al,0xFF
    0xAA,                           //       stosb            (red)
    0xE2, 0xF7,                     //       loop fill

    // AX=4F05 BH=0 BL=0 DX=1: move the window onto bank 1.
    0xBB, 0x00, 0x00,
    0xBA, 0x01, 0x00,
    0xB8, 0x05, 0x4F,
    0xCD, 0x10,
    0xA3, lo(OUT + 14), hi(OUT + 14),

    // One green pixel at bank 1 + 2. The picture is 1920 bytes a line, and
    // 65538 is divisible by three, so that byte triple is a whole pixel:
    // 65538/3 = 21846, which is x=86 of row 34.
    0xBF, 0x02, 0x00,               // mov di,2
    0x30, 0xC0,                     // xor al,al
    0xAA,                           // stosb                  (blue)
    0xB0, 0xFF,                     // mov al,0xFF
    0xAA,                           // stosb                  (green)
    0x30, 0xC0,                     // xor al,al
    0xAA,                           // stosb                  (red)

    // The other way to move the window: the far pointer the mode block carries
    // at offset 0x0C. A program is entitled to call it instead of AX=4F05, and
    // CHROME.EXE does, so a pointer that is merely present is not enough --
    // this call has to move the window and come back with the caller's
    // registers intact.
    0xBB, 0x00, 0x00,               // mov bx,0        (BH=0 set, BL=0 window A)
    0xBA, 0x02, 0x00,               // mov dx,2
    0xB8, 0x34, 0x12,               // mov ax,0x1234   (a marker it must not eat)
    0xFF, 0x1E, lo(MODEBUF + 0x0C), hi(MODEBUF + 0x0C),   // call far [WinFuncPtr]
    0xA3, lo(OUT + 16), hi(OUT + 16),

    // A red pixel one byte into bank 2. 131073 is divisible by three, so that
    // triple is pixel 43691 -- x=171 of row 68.
    0xBF, 0x01, 0x00,               // mov di,1
    0x30, 0xC0,                     // xor al,al
    0xAA,                           // stosb                  (blue)
    0xAA,                           // stosb                  (green)
    0xB0, 0xFF,                     // mov al,0xFF
    0xAA,                           // stosb                  (red)

    0xB8, 0x00, 0x4C,               // mov ax,0x4C00
    0xCD, 0x21,                     // int 21h
  ]);
}

// The 15bpp mode gets its own program because only one mode can be set at a
// time and the frame is read after the guest has finished: two depths means
// two runs. COLORS.EXE is the program that asks for this one.
function vbe15Com() {
  return Uint8Array.from([
    0x1E, 0x07,                     // push ds / pop es
    ...modeInfo(0x10D, OUT),
    0xBB, 0x0D, 0x01,               // mov bx,0x10D
    0xB8, 0x02, 0x4F,               // mov ax,0x4F02
    0xCD, 0x10,
    0xA3, lo(OUT + 2), hi(OUT + 2),

    0xB8, 0x00, 0xA0,               // mov ax,0xA000
    0x8E, 0xC0,                     // mov es,ax
    // 5-5-5, red at bit 10: 0x7C00 is full red, 0x03E0 full green.
    0x26, 0xC7, 0x06, 0x00, 0x00, 0x00, 0x7C,   // mov word es:[0],0x7C00
    0x26, 0xC7, 0x06, 0x02, 0x00, 0xE0, 0x03,   // mov word es:[2],0x03E0

    0xB8, 0x00, 0x4C,
    0xCD, 0x21,
  ]);
}

async function check15(dir) {
  const com = path.join(dir, 'VBE15.COM');
  fs.writeFileSync(com, vbe15Com());
  const r = await runDos({ exe: com, budget: 20e6, log: () => {}, stuckLimit: 0 });
  const mem = r.vm.mem;
  const base = PSP_SEG << 4;
  const w16 = (off) => mem[base + off] | (mem[base + off + 1] << 8);

  check(w16(OUT) === 0x004F, `4F01 grants 0x10D, the served 15bpp mode (AX=${w16(OUT).toString(16)})`);
  check(mem[base + MODEBUF + 0x19] === 15,
    `mode 0x10D reports 15 bits per pixel (${mem[base + MODEBUF + 0x19]})`);
  check(mem[base + MODEBUF + 0x1F] === 5 && mem[base + MODEBUF + 0x20] === 10
    && mem[base + MODEBUF + 0x23] === 5 && mem[base + MODEBUF + 0x24] === 0,
    'mode 0x10D reports 5-5-5 with red at bit 10 and blue at bit 0');
  check(w16(OUT + 2) === 0x004F, `4F02 sets 0x10D (AX=${w16(OUT + 2).toString(16)})`);

  const g = fb.screenSurface(r.machine).geom;
  check(g.width === 320 && g.height === 200 && g.bpp === 15 && g.stride === 640,
    `the screen reads as 320x200x15 with a 640-byte stride `
    + `(${g.width}x${g.height}x${g.bpp} stride=${g.stride})`);
  const f = fb.readFrame(mem, g);
  const at = (x, y) => [f.rgb[(y * 320 + x) * 3], f.rgb[(y * 320 + x) * 3 + 1], f.rgb[(y * 320 + x) * 3 + 2]];
  check(JSON.stringify(at(0, 0)) === '[255,0,0]', `15bpp pixel (0,0) is red (${at(0, 0)})`);
  check(JSON.stringify(at(1, 0)) === '[0,255,0]', `15bpp pixel (1,0) is green (${at(1, 0)})`);
  check(r.pixels === 2, `the run reports 2 non-black pixels of the 15bpp picture (${r.pixels})`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-vbe-'));
  const com = path.join(dir, 'VBE.COM');
  fs.writeFileSync(com, vbeCom());

  const r = await runDos({ exe: com, budget: 20e6, log: () => {}, stuckLimit: 0 });
  const mem = r.vm.mem;
  const base = PSP_SEG << 4;
  const w16 = (off) => mem[base + off] | (mem[base + off + 1] << 8);

  check(r.machine.exited === true && r.machine.exitCode === 0,
    `the guest runs to its own exit (exited=${r.machine.exited} code=${r.machine.exitCode})`);

  // --- what the BIOS said ---------------------------------------------------
  check(w16(OUT) === 0x004F, `4F00 controller info is supported (AX=${w16(OUT).toString(16)})`);
  const sig = String.fromCharCode(...[0, 1, 2, 3].map(i => mem[base + BUF + i]));
  check(sig === 'VESA', `the controller block is signed VESA (got ${JSON.stringify(sig)})`);

  check(w16(OUT + 2) === 0x004F, `4F01 grants 0x101, a served 8bpp mode (AX=${w16(OUT + 2).toString(16)})`);
  check(w16(OUT + 4) === 0x004F, `4F01 grants 0x112, the served 24bpp mode (AX=${w16(OUT + 4).toString(16)})`);
  check(w16(OUT + 6) !== 0x004F,
    `4F01 REFUSES 0x114, which nothing here renders (AX=${w16(OUT + 6).toString(16)})`);
  check(w16(OUT + 8) !== 0x004F,
    `4F01 refuses the linear-framebuffer bit on a mode it otherwise serves `
    + `(AX=${w16(OUT + 8).toString(16)})`);

  // The 0x112 block, as the guest can read it. Getting any of these wrong is
  // how a program computes the wrong address for every pixel it draws.
  check(mem[base + MODEBUF + 0x19] === 24, `mode 0x112 reports 24 bits per pixel (${mem[base + MODEBUF + 0x19]})`);
  check(w16(MODEBUF + 0x10) === 1920, `mode 0x112 reports a 1920-byte scan line (${w16(MODEBUF + 0x10)})`);
  check(mem[base + MODEBUF + 0x1B] === 6,
    `mode 0x112 reports memory model 6, direct colour (${mem[base + MODEBUF + 0x1B]})`);
  check(w16(MODEBUF + 0x12) === 640 && w16(MODEBUF + 0x14) === 480,
    `mode 0x112 reports 640x480 (${w16(MODEBUF + 0x12)}x${w16(MODEBUF + 0x14)})`);
  check(mem[base + MODEBUF + 0x1F] === 8 && mem[base + MODEBUF + 0x20] === 16
    && mem[base + MODEBUF + 0x23] === 8 && mem[base + MODEBUF + 0x24] === 0,
    'mode 0x112 reports red at bit 16 and blue at bit 0, which is the BGR byte order');
  check(w16(OUT + 12) === 0x004F, `4F02 sets 0x112 (AX=${w16(OUT + 12).toString(16)})`);
  check(w16(OUT + 14) === 0x004F, `4F05 moves the window to bank 1 (AX=${w16(OUT + 14).toString(16)})`);

  // --- and whether it is a picture -----------------------------------------
  const surface = fb.screenSurface(r.machine);
  check(!surface.text && surface.geom.width === 640 && surface.geom.height === 480
    && surface.geom.bpp === 24 && surface.geom.stride === 1920,
    `the screen reads as 640x480x24 with a 1920-byte stride `
    + `(${surface.geom && `${surface.geom.width}x${surface.geom.height}x${surface.geom.bpp}`
      + ` stride=${surface.geom.stride}`})`);

  const f = fb.readFrame(mem, surface.geom);
  check(f.direct === true && f.rgb && f.rgb.length === 640 * 480 * 3,
    'the frame comes back as direct colour, three bytes a pixel');
  const at = (x, y) => [f.rgb[(y * 640 + x) * 3], f.rgb[(y * 640 + x) * 3 + 1], f.rgb[(y * 640 + x) * 3 + 2]];
  check(JSON.stringify(at(0, 0)) === '[255,0,0]', `pixel (0,0) is red (${at(0, 0)})`);
  check(JSON.stringify(at(15, 0)) === '[255,0,0]', `pixel (15,0) is red (${at(15, 0)})`);
  check(JSON.stringify(at(16, 0)) === '[0,0,0]', `pixel (16,0) is untouched (${at(16, 0)})`);
  // The bank switch: this pixel is 65538 bytes in, so it only exists in the
  // picture if the window the guest wrote through was copied to bank 1.
  check(JSON.stringify(at(86, 34)) === '[0,255,0]',
    `pixel (86,34), written through bank 1, is green (${at(86, 34)})`);

  check(w16(MODEBUF + 0x0C) !== 0 || w16(MODEBUF + 0x0E) !== 0,
    'the mode block carries a window-positioning far pointer, not a null one');
  check(w16(OUT + 16) === 0x1234,
    `the window far call leaves AX alone (${w16(OUT + 16).toString(16)})`);
  check(JSON.stringify(at(171, 68)) === '[255,0,0]',
    `pixel (171,68), written after a far call to the window function, is red (${at(171, 68)})`);

  check(r.pixels === 18, `the run reports 18 non-black pixels of the VBE picture (${r.pixels})`);

  // The frame hash covers the VBE picture the same way it covers mode 13h: it
  // is read through readFrame, so a byte changed anywhere in the 640x480x24
  // surface changes it. Poke a byte in bank 0 -- the window is on bank 1, so
  // nothing flushes over it.
  const before = fb.frameHash(mem, surface.geom);
  mem[isa.VESA_FB + 3000] ^= 0xFF;
  const after = fb.frameHash(mem, surface.geom);
  check(before !== after, `the frame hash covers the VBE picture (${before} -> ${after})`);

  await check15(dir);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail.length ? `\n${fail.length} FAILED` : '\nall VBE checks passed');
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
