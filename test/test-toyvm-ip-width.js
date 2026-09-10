'use strict';

// EIP is 32 bits wide in protected mode even when the code selector's D bit is 0.
//
// D=0 fixes the DEFAULT operand and address size at 16. It does not make the
// instruction pointer sixteen bits wide, and a protected-mode descriptor is free
// to carry a limit past 64K -- so a program can legitimately execute at EIP
// 0x80000 through a 16-bit code selector, with an 0x66 or 0x67 on each
// instruction that wants the wide form. COCAHOLC.EXE's extender does exactly
// that with runtime-generated code at EIP 0x23e60. Fetching that at 0x3e60
// instead does not fault: it decodes whatever else is at that offset, which
// there was an `add sp,[bp+0x67]` followed by a `jmp [bp+0x67]`, so ESP and EIP
// both took the same word out of the stack segment and the demo derailed six
// dispatches into the block and spun on undecodable bytes for the rest of the
// run.
//
// The program below is the smallest thing that has that shape: it copies a stub
// to linear 0x80000, enters protected mode through a D=0 code selector with a
// 4GB granular limit, jumps to 0x08:0x00080000 and writes two characters to the
// text page from there. Either the fetch used the full EIP and the characters
// appear, or it wrapped at 64K and the CPU ran the interrupt vector table.
//
// Real mode is deliberately NOT changed by the fix and is not tested here: there
// the segment is 64K and an offset above 0xFFFF cannot be reached in the first
// place.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RUN = path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js');

// Where the protected-mode stub is copied to and entered. Above 64K by
// construction -- that is the whole point -- and inside conventional memory so
// no A20 or XMS call is needed to reach it.
const STUB_SEG = 0x8000;
const STUB_LIN = STUB_SEG << 4;

// The two cells the stub writes, at the top left of the text page.
const CH0 = 0x0741;   // 'A', light grey on black
const CH1 = 0x0742;   // 'B'

function build() {
  const b = [];
  const w = (...x) => b.push(...x);
  const at = () => 0x100 + b.length;      // the .COM offset of the next byte
  const patch = [];                       // [indexIntoB, () => value] word fixups

  w(0xFA);                                 // cli

  // DS = ES = CS, then copy the stub up to 0x8000:0000.
  w(0x8C, 0xC8);                           // mov ax, cs
  w(0x8E, 0xD8);                           // mov ds, ax
  const siAt = b.length + 1;
  w(0xBE, 0x00, 0x00);                     // mov si, <stub>
  w(0xB8, STUB_SEG & 0xFF, STUB_SEG >> 8); // mov ax, 8000h
  w(0x8E, 0xC0);                           // mov es, ax
  w(0x31, 0xFF);                           // xor di, di
  const cxAt = b.length + 1;
  w(0xB9, 0x00, 0x00);                     // mov cx, <stub length>
  w(0xF3, 0xA4);                           // rep movsb

  // The GDT's linear address is (CS<<4) + gdt, which only the running program
  // knows -- so the GDTR's base is filled in here rather than assembled.
  w(0x66, 0x31, 0xC0);                     // xor eax, eax
  w(0x8C, 0xC8);                           // mov ax, cs
  w(0x66, 0xC1, 0xE0, 0x04);               // shl eax, 4
  const gdtAddAt = b.length + 2;
  w(0x66, 0x05, 0x00, 0x00, 0x00, 0x00);   // add eax, <gdt>
  const gdtrBaseAt = b.length + 2;
  w(0x66, 0xA3, 0x00, 0x00);               // mov [<gdtr>+2], eax
  const lgdtAt = b.length + 3;
  w(0x0F, 0x01, 0x16, 0x00, 0x00);         // lgdt [<gdtr>]

  w(0x0F, 0x20, 0xC0);                     // mov eax, cr0
  w(0x0C, 0x01);                           // or al, 1
  w(0x0F, 0x22, 0xC0);                     // mov cr0, eax
  // The far jump that is the test: a 32-bit offset above 64K through a selector
  // whose descriptor has D=0.
  w(0x66, 0xEA,
    STUB_LIN & 0xFF, (STUB_LIN >> 8) & 0xFF, (STUB_LIN >> 16) & 0xFF, (STUB_LIN >>> 24) & 0xFF,
    0x08, 0x00);                           // jmp 0008:00080000

  // --- the GDT, 8-byte aligned for tidiness rather than necessity ------------
  while ((at() & 7) !== 0) w(0x90);
  const gdtOff = at();
  // null
  w(0, 0, 0, 0, 0, 0, 0, 0);
  // 0x08: code, base 0, limit 4GB (G=1), 16-BIT (D=0), present, DPL 0
  w(0xFF, 0xFF, 0x00, 0x00, 0x00, 0x9A, 0x8F, 0x00);
  // 0x10: data, base 0, limit 4GB (G=1), 32-bit
  w(0xFF, 0xFF, 0x00, 0x00, 0x00, 0x92, 0xCF, 0x00);
  const gdtrOff = at();
  w(0x17, 0x00, 0, 0, 0, 0);               // limit 23, base filled at run time

  // --- the stub, assembled here and copied to 0x80000 before it runs ---------
  // Every instruction that wants a 32-bit register or a 32-bit address carries
  // its own prefix, because the segment it runs in is 16-bit.
  const stubOff = at();
  const s = [];
  const sw = (...x) => s.push(...x);
  sw(0xB8, 0x10, 0x00);                    // mov ax, 10h
  sw(0x8E, 0xD8);                          // mov ds, ax
  sw(0x66, 0xBF, 0x00, 0x80, 0x0B, 0x00);  // mov edi, 000B8000h
  sw(0xB8, CH0 & 0xFF, CH0 >> 8);          // mov ax, 0741h
  sw(0x67, 0x89, 0x07);                    // a32 mov [edi], ax
  sw(0xB8, CH1 & 0xFF, CH1 >> 8);          // mov ax, 0742h
  sw(0x67, 0x89, 0x47, 0x02);              // a32 mov [edi+2], ax
  sw(0xEB, 0xFE);                          // jmp $
  w(...s);

  const put16 = (i, v) => { b[i] = v & 0xFF; b[i + 1] = (v >> 8) & 0xFF; };
  put16(siAt, stubOff);
  put16(cxAt, s.length);
  put16(gdtAddAt, gdtOff);
  put16(gdtrBaseAt, gdtrOff + 2);
  put16(lgdtAt, gdtrOff);
  void patch;
  return Buffer.from(b);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-ipw-'));
const exe = path.join(dir, 'IPWIDTH.COM');
fs.writeFileSync(exe, build());

// A short budget on purpose. The stub ends in a self-loop, and the stuck
// detector only fires after 20M idle dispatches -- staying well under that keeps
// the run's ending unambiguous ("budget spent") whichever way the fetch went.
const out = execFileSync('node', [RUN, exe, '--dispatches=2m', '--report', '--text'],
  { encoding: 'utf8', timeout: 120000 });

const cells = /(\d+) of 2000 cells non-blank/.exec(out);
const csip = /cs:ip=([0-9a-f]+):([0-9a-f]+)/.exec(out);

assert.ok(cells, `no cell count in report:\n${out}`);
assert.ok(csip, `no cs:ip in report:\n${out}`);

// The two characters the stub wrote. Without the fix the CPU never reached the
// stub at all, so this is 0.
assert.strictEqual(Number(cells[1]), 2,
  `expected the two cells the protected-mode stub writes, got ${cells[1]}:\n${out}`);
// ...and it is still there, spinning, at an EIP above 64K in a 16-bit segment.
assert.strictEqual(parseInt(csip[1], 16), 0x08,
  `expected to end in the 16-bit code selector:\n${out}`);
assert.ok(parseInt(csip[2], 16) > 0xFFFF,
  `expected an EIP above 64K, got ${csip[2]}:\n${out}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS test-toyvm-ip-width: ran at ${csip[1]}:${csip[2]} through a D=0 selector`);
