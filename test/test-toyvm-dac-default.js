'use strict';

// What a program is told when it reads the VGA DAC back.
//
// The DAC is not write-only, and a demo of this era reads it far more often
// than the fact is remembered: the standard "fade the DOS prompt out" opening
// is `out 3C7,0`, 768 `in 3C9`, and then 64 passes that scale what was read
// towards black and write each pass back. Every one of those passes is a
// multiplication by the value the card handed over, so a card that hands over
// zeros renders a fade whose first frame is already the last one.
//
// ATTIC.EXE is the corpus's example. It opens exactly that way in mode 3h --
// 768 reads at 0x3C9 before it ever asks for a graphics mode -- and against a
// DAC of 768 zero bytes all 49920 bytes it wrote back were zero. A real VGA
// BIOS has loaded the EGA's 64 colours into entries 0-63 long before a program
// gets the CPU, and reloads them on every mode set that is not 256-colour.
//
// So this asserts on the readback, in both of the places the old code left
// black:
//
//   * at power-on, before the program has set any mode at all, and
//   * after a mode set back to text, which used to leave whatever the previous
//     256-colour mode had installed.
//
// Entry 6 is the probe because it is the one entry whose two default tables
// disagree: it is (2A,2A,00) in the EGA table and (2A,15,00) -- the brown
// correction -- in the 256-colour one, so a text mode still wearing mode 13h's
// palette is distinguishable from one that reloaded, and neither is black.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDos } = require('../tools/toyvm/run-dos');
const { PSP_SEG } = require('../tools/toyvm/dos');

// Read DAC entry 6 into PSP:0200, set mode 13h, set mode 3h, read it again
// into PSP:0203, exit. Hand-assembled so the test needs no corpus and no
// assembler; a .COM is loaded at PSP:0100 with DS = ES = CS = the PSP.
function dacProbeCom() {
  return Uint8Array.from([
    0xFC,                     // 0100  cld
    0xBA, 0xC7, 0x03,         // 0101  mov dx, 0x3C7   (the DAC *read* index)
    0xB0, 0x06,               // 0104  mov al, 6
    0xEE,                     // 0106  out dx, al
    0xBA, 0xC9, 0x03,         // 0107  mov dx, 0x3C9   (the data port, not 3C8)
    0xBF, 0x00, 0x02,         // 010A  mov di, 0x200
    0xB9, 0x03, 0x00,         // 010D  mov cx, 3
    0xEC,                     // 0110  in al, dx
    0xAA,                     // 0111  stosb
    0xE2, 0xFC,               // 0112  loop 0110
    0xB8, 0x13, 0x00,         // 0114  mov ax, 0x0013
    0xCD, 0x10,               // 0117  int 10h
    0xB8, 0x03, 0x00,         // 0119  mov ax, 0x0003
    0xCD, 0x10,               // 011C  int 10h
    0xBA, 0xC7, 0x03,         // 011E  mov dx, 0x3C7
    0xB0, 0x06,               // 0121  mov al, 6
    0xEE,                     // 0123  out dx, al
    0xBA, 0xC9, 0x03,         // 0124  mov dx, 0x3C9
    0xBF, 0x03, 0x02,         // 0127  mov di, 0x203
    0xB9, 0x03, 0x00,         // 012A  mov cx, 3
    0xEC,                     // 012D  in al, dx
    0xAA,                     // 012E  stosb
    0xE2, 0xFC,               // 012F  loop 012D
    0xCD, 0x20,               // 0131  int 20h
  ]);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-dac-'));
  const exe = path.join(dir, 'DACPROBE.COM');
  fs.writeFileSync(exe, dacProbeCom());

  // A handful of instructions; two million dispatches is a budget it cannot
  // spend, and the run ends on int 20h rather than on the budget.
  const r = await runDos({ exe, budget: 2e6 });
  assert.ok(r.machine.exited, 'the probe must reach int 20h, not run out of budget');

  const at = (PSP_SEG << 4) + 0x200;
  const got = [...r.vm.mem.subarray(at, at + 6)];
  const want = [0x2A, 0x2A, 0x00];
  const show = (a) => a.map(b => b.toString(16).padStart(2, '0')).join(' ');

  assert.deepStrictEqual(got.slice(0, 3), want,
    `at power-on the DAC must already hold the BIOS text palette:`
    + ` entry 6 read back as ${show(got.slice(0, 3))}, want ${show(want)}`
    + (got.slice(0, 3).every(b => b === 0)
      ? ' -- all zeros means the card came up with no palette at all, and every'
        + ' demo that fades the prompt out fades black into black'
      : ''));

  assert.deepStrictEqual(got.slice(3, 6), want,
    `a mode set back to text must reload the BIOS text palette:`
    + ` entry 6 read back as ${show(got.slice(3, 6))}, want ${show(want)}`
    + (show(got.slice(3, 6)) === '2a 15 00'
      ? ' -- that is the 256-colour table\'s entry 6, left over from mode 13h'
      : ''));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS test-toyvm-dac-default');
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
