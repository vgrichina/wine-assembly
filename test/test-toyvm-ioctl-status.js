'use strict';

// What DOS answers when a program asks whether a handle is ready.
//
// INT 21h AH=44h is IOCTL, and only AL=00 -- "get device information" -- was
// implemented. Everything else came back CF set, AX=1 ("invalid function").
// AL=06 ("get input status") and AL=07 ("get output status") are not exotic:
// they are the second half of the standard "is this handle a live character
// device" sequence, and DOS answers them with AL=0FFh for ready and 00h for
// not ready, CF clear. A device is always ready to be written; a *file* is
// always ready to write and is ready to read until the position reaches the
// end, which is how a program tests for EOF without reading.
//
// ACME-VIC.EXE is the corpus's example and it is the reason this exists. Its
// expanded-memory probe at 110:c554 opens the classic EMS device name
// EMMXXXX0, checks bit 7 of the AL=00 word to confirm it really is a device,
// then asks AL=07 and compares AL against 0FFh:
//
//   c576  b8 07 44   mov ax, 0x4407
//   c579  cd 21      int 0x21
//   c57b  50         push ax
//   c57c  b4 3e      mov ah, 0x3e      ; close the handle
//   c57e  cd 21      int 0x21
//   c580  58         pop ax
//   c581  3c ff      cmp al, 0xff
//   c583  75 05      jne 0xc58a        ; ... skip "EMS is present"
//   c585  c6 06 4a c5 ff  mov byte [0xc54a], 0xff
//
// Answering "invalid function" put AL=1 there, so the ready device read as
// dead and the demo ran with expanded memory switched off -- it never issued
// an INT 67h at all. With the documented answer it takes the EMS path, and
// the run goes from 11 DOS calls and no sound to 145 DOS calls, two INT 67h
// calls and a GUS playing 14 voices.
//
// The probe below is that same sequence against the same device name, plus
// AL=06 on the same handle, hand-assembled so the test needs no corpus and no
// assembler: a .COM is loaded at PSP:0100 with DS = ES = CS = the PSP.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDos } = require('../tools/toyvm/run-dos');
const { PSP_SEG } = require('../tools/toyvm/dos');

function ioctlProbeCom() {
  return Uint8Array.from([
    0xB8, 0x00, 0x3D,         // 0100  mov ax, 0x3D00   open, read-only
    0xBA, 0x30, 0x01,         // 0103  mov dx, 0x0130   -> "EMMXXXX0",0
    0xCD, 0x21,               // 0106  int 21h
    0x72, 0x20,               // 0108  jc  012A         open failed: nothing to say
    0x8B, 0xD8,               // 010A  mov bx, ax       the handle
    0xB8, 0x07, 0x44,         // 010C  mov ax, 0x4407   get output status
    0xCD, 0x21,               // 010F  int 21h
    0xA2, 0x00, 0x02,         // 0111  mov [0200], al
    0x73, 0x05,               // 0114  jnc 011B
    0xC6, 0x06, 0x02, 0x02, 0x01, // 0116  mov byte [0202], 1   CF was set
    0xB8, 0x06, 0x44,         // 011B  mov ax, 0x4406   get input status
    0xCD, 0x21,               // 011E  int 21h
    0xA2, 0x01, 0x02,         // 0120  mov [0201], al
    0x73, 0x05,               // 0123  jnc 012A
    0xC6, 0x06, 0x03, 0x02, 0x01, // 0125  mov byte [0203], 1   CF was set
    0xCD, 0x20,               // 012A  int 20h
    0x00, 0x00, 0x00, 0x00,   // 012C  pad to the name
    0x45, 0x4D, 0x4D, 0x58, 0x58, 0x58, 0x58, 0x30, 0x00, // 0130 "EMMXXXX0"
  ]);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-ioctl-'));
  const exe = path.join(dir, 'IOCTL.COM');
  fs.writeFileSync(exe, ioctlProbeCom());

  const r = await runDos({ exe, budget: 2e6 });
  assert.ok(r.machine.exited, 'the probe must reach int 20h, not run out of budget');
  assert.ok((r.machine.filesOpened || []).includes('EMMXXXX0'),
    `the probe must get a handle on the EMS device name; opened`
    + ` ${JSON.stringify(r.machine.filesOpened || [])}`);

  const at = (PSP_SEG << 4) + 0x200;
  const [outAl, inAl, outCf, inCf] = [...r.vm.mem.subarray(at, at + 4)];
  const hex = (b) => b.toString(16).padStart(2, '0');
  const stale = (al, cf) => cf === 1 && al === 0x01
    ? ' -- CF set with AL=1 is the "invalid function" return, i.e. the'
      + ' subfunction is not implemented at all'
    : '';

  assert.strictEqual(outAl, 0xFF,
    `IOCTL AL=07 on a character device must report ready (AL=0FFh);`
    + ` got AL=${hex(outAl)} CF=${outCf}${stale(outAl, outCf)}`);
  assert.strictEqual(outCf, 0, 'IOCTL AL=07 must return with CF clear');
  assert.strictEqual(inAl, 0xFF,
    `IOCTL AL=06 on a character device must report ready (AL=0FFh);`
    + ` got AL=${hex(inAl)} CF=${inCf}${stale(inAl, inCf)}`);
  assert.strictEqual(inCf, 0, 'IOCTL AL=06 must return with CF clear');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS test-toyvm-ioctl-status');
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
