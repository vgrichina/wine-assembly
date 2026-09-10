'use strict';

// A timer handler installed in the IDT, with the real-mode vector left alone.
//
// A program running under its own DOS extender takes IRQ0 with DPMI 0205 (set
// protected-mode interrupt vector), which writes an IDT gate and never touches
// the real-mode vector table. The host decides whether to deliver a tick by
// asking whether the guest hooked the vector, and that question used to be
// answered off the real-mode table alone -- so such a program was told "no
// handler" forever and never got a single tick. COCAHOLC.EXE's whole frame
// clock is one of these: it renders into an offscreen buffer at linear 0x110000
// and copies that to A000 at the end of each tick's frame, so with no tick it
// rasterized for 60M dispatches, wrote nothing at all to 0xA0000, and was
// photographed as a black screen with a working soundtrack.
//
// The gate cannot simply be read and a present one called hooked: in protected
// mode 8 is #DF, so every extender has a present gate there whatever it thinks
// of hardware interrupts. What says "the guest took this over" is that the
// gate's SELECTOR changed from the one the extender's own table named --
// ACME-BIG.EXE's extender swaps its vector-8 gate between two entries of its
// own exception-stub table (8:7ef -> 8:808) and must NOT be read as a hook.
//
// So both halves are tested here, with one program built twice:
//
//   selector changed (0x08 -> 0x18)  ticks are delivered, the handler runs,
//                                    and the two cells it guards get written
//   selector unchanged (0x08)        no tick, no cells -- the conservative
//                                    answer, which is what it was before
//
// Everything below sits at fixed linear addresses so nothing has to be patched
// at run time: the GDT at 0x80000, the IDT at 0x80040, the protected-mode code
// at 0x80100 and its handler at 0x80200.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RUN = path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js');

const BLOB_SEG = 0x8000;             // where the blob is copied before PE is set
const BLOB_LIN = BLOB_SEG << 4;      // 0x80000
const GDT = BLOB_LIN;                // 4 descriptors
const IDT = BLOB_LIN + 0x40;         // 16 gates, so vector 8 is inside the limit
const PM = BLOB_LIN + 0x100;         // protected-mode entry
const HANDLER = BLOB_LIN + 0x200;    // the vector-8 handler
const STACK = 0x7F000;               // below the blob, in conventional memory
const COUNTER = 0x7F800;             // ticks seen, one byte
const SCRATCH = 0x7F804;             // the delay loop's store target

const SEL_CODE = 0x08;               // 16-bit code, base 0, 4GB -- "the extender"
const SEL_DATA = 0x10;               // 32-bit data, base 0, 4GB
const SEL_GUEST = 0x18;              // 16-bit code, base 0, 4GB -- "the program"

const TEXT = 0xB8000;
const CH0 = 0x0741;                  // 'A', light grey on black
const CH1 = 0x0742;                  // 'B'

const TICKS = 3;                     // how many the waiter insists on seeing
const DELAY = 30000;                 // outer iterations before the gate is moved

const lo = (v) => v & 0xFF;
const hi = (v) => (v >> 8) & 0xFF;
const d32 = (v) => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF];

// One 8-byte descriptor, 386 layout.
function desc(access, gran) {
  return [0xFF, 0xFF, 0x00, 0x00, 0x00, access, gran, 0x00];
}

// One 8-byte 386 interrupt gate (type 0x8E): offset low, selector, 0, type,
// offset high. This is the gate a DOS extender actually writes, and the one
// COCAHOLC's DPMI 0205 lands in -- it pushes a doubleword frame, which is why
// the handler below ends in IRETD and not IRET.
function gate(sel, off) {
  return [lo(off), hi(off), lo(sel), hi(sel), 0x00, 0x8E,
    (off >> 16) & 0xFF, (off >>> 24) & 0xFF];
}

// The program, with the selector its "DPMI 0205" writes into gate 8 as the one
// variable. hookSel === SEL_CODE is the negative arm: the offset still moves,
// so this is exactly the extender-tidying-its-own-table case.
function build(hookSel) {
  const blob = new Array(0x300).fill(0);
  const put = (at, bytes) => { for (let i = 0; i < bytes.length; i++) blob[at + i] = bytes[i]; };

  // --- the GDT --------------------------------------------------------------
  put(0x00, [0, 0, 0, 0, 0, 0, 0, 0]);
  put(0x08, desc(0x9A, 0x8F));       // code, D=0, G=1, limit 4GB
  put(0x10, desc(0x92, 0xCF));       // data, D/B=1, G=1
  put(0x18, desc(0x9A, 0x8F));       // a SECOND code selector, identical but for its number

  // --- the IDT: sixteen gates, all the extender's ---------------------------
  for (let v = 0; v < 16; v++) put(0x40 + v * 8, gate(SEL_CODE, HANDLER & 0xFFFF));

  // --- the protected-mode code ---------------------------------------------
  const c = [];
  const w = (...x) => c.push(...x);
  w(0xB8, lo(SEL_DATA), hi(SEL_DATA));      // mov ax, 10h
  w(0x8E, 0xD8);                            // mov ds, ax
  w(0x8E, 0xC0);                            // mov es, ax
  w(0x8E, 0xD0);                            // mov ss, ax
  w(0x66, 0xBC, ...d32(STACK));             // mov esp, STACK
  w(0x66, 0xBF, ...d32(COUNTER));           // mov edi, COUNTER
  w(0x67, 0xC6, 0x07, 0x00);                // mov byte [edi], 0

  // A delay with a store in it, long enough that the host is certain to have
  // looked at the IDT at least once while gate 8 still said what the extender
  // put there. A bare `dec ecx / jnz` self-loop would do the waiting but is
  // exactly the shape the spin detector folds away, and a folded delay never
  // hands back at all.
  w(0x66, 0xB9, ...d32(DELAY));             // mov ecx, DELAY
  w(0x66, 0xBF, ...d32(SCRATCH));           // mov edi, SCRATCH
  const delayTop = c.length;
  w(0x67, 0x88, 0x0F);                      // mov [edi], cl
  w(0x66, 0x49);                            // dec ecx
  w(0x75, (delayTop - (c.length + 2)) & 0xFF);  // jnz delayTop

  // "DPMI 0205": rewrite gate 8 in place.
  w(0x66, 0xBF, ...d32(IDT + 8 * 8));       // mov edi, &IDT[8]
  w(0xB8, lo(HANDLER), hi(HANDLER));        // mov ax, HANDLER
  w(0x67, 0x89, 0x07);                      // mov [edi], ax
  w(0xB8, lo(hookSel), hi(hookSel));        // mov ax, <selector>
  w(0x67, 0x89, 0x47, 0x02);                // mov [edi+2], ax
  w(0xB8, 0x00, 0x8E);                      // mov ax, 8E00h  (present, 386 int gate)
  w(0x67, 0x89, 0x47, 0x04);                // mov [edi+4], ax
  w(0xB8, lo(HANDLER >> 16), hi(HANDLER >> 16));  // mov ax, HANDLER >> 16
  w(0x67, 0x89, 0x47, 0x06);                // mov [edi+6], ax
  w(0xFB);                                  // sti

  // Wait for the handler to have run TICKS times.
  w(0x66, 0xBF, ...d32(COUNTER));           // mov edi, COUNTER
  const waitTop = c.length;
  w(0x67, 0x80, 0x3F, TICKS);               // cmp byte [edi], TICKS
  w(0x72, (waitTop - (c.length + 2)) & 0xFF);   // jb waitTop

  // The two cells, written only once the ticks arrived.
  w(0x66, 0xBF, ...d32(TEXT));              // mov edi, 0B8000h
  w(0xB8, lo(CH0), hi(CH0));                // mov ax, 0741h
  w(0x67, 0x89, 0x07);                      // mov [edi], ax
  w(0xB8, lo(CH1), hi(CH1));                // mov ax, 0742h
  w(0x67, 0x89, 0x47, 0x02);                // mov [edi+2], ax
  w(0xEB, 0xFE);                            // jmp $
  assert.ok(c.length <= 0x100, `pm code overran its slot: ${c.length}`);
  put(0x100, c);

  // --- the handler ---------------------------------------------------------
  const h = [];
  const hw = (...x) => h.push(...x);
  hw(0x50);                                 // push ax
  hw(0x66, 0x57);                           // push edi
  hw(0x66, 0xBF, ...d32(COUNTER));          // mov edi, COUNTER
  hw(0x67, 0xFE, 0x07);                     // inc byte [edi]
  hw(0xB0, 0x20);                           // mov al, 20h
  hw(0xE6, 0x20);                           // out 20h, al     (EOI)
  hw(0x66, 0x5F);                           // pop edi
  hw(0x58);                                 // pop ax
  hw(0x66, 0xCF);                           // iretd
  put(0x200, h);

  // --- the real-mode bootstrap ---------------------------------------------
  const b = [];
  const rw = (...x) => b.push(...x);
  const at = () => 0x100 + b.length;
  rw(0xFA);                                 // cli
  rw(0x8C, 0xC8);                           // mov ax, cs
  rw(0x8E, 0xD8);                           // mov ds, ax
  const siAt = b.length + 1;
  rw(0xBE, 0x00, 0x00);                     // mov si, <blob>
  rw(0xB8, lo(BLOB_SEG), hi(BLOB_SEG));     // mov ax, 8000h
  rw(0x8E, 0xC0);                           // mov es, ax
  rw(0x31, 0xFF);                           // xor di, di
  rw(0xB9, lo(blob.length), hi(blob.length));  // mov cx, <blob length>
  rw(0xF3, 0xA4);                           // rep movsb
  const lgdtAt = b.length + 3;
  rw(0x0F, 0x01, 0x16, 0x00, 0x00);         // lgdt [<gdtr>]
  const lidtAt = b.length + 3;
  rw(0x0F, 0x01, 0x1E, 0x00, 0x00);         // lidt [<idtr>]
  rw(0x0F, 0x20, 0xC0);                     // mov eax, cr0
  rw(0x0C, 0x01);                           // or al, 1
  rw(0x0F, 0x22, 0xC0);                     // mov cr0, eax
  rw(0x66, 0xEA, ...d32(PM), lo(SEL_CODE), hi(SEL_CODE));   // jmp 0008:00080100

  // The two pseudo-descriptors. Their bases are constants because the blob's
  // home is one -- nothing here depends on where DOS put the .COM.
  const gdtrOff = at();
  rw(0x1F, 0x00, ...d32(GDT));              // limit 31, base 0x80000
  const idtrOff = at();
  rw(0x7F, 0x00, ...d32(IDT));              // limit 127, base 0x80040

  const blobOff = at();
  rw(...blob);

  const put16 = (i, v) => { b[i] = v & 0xFF; b[i + 1] = (v >> 8) & 0xFF; };
  put16(siAt, blobOff);
  put16(lgdtAt, gdtrOff);
  put16(lidtAt, idtrOff);
  return Buffer.from(b);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-pmiv-'));

function run(name, hookSel) {
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, build(hookSel));
  const out = execFileSync('node', [RUN, exe, '--dispatches=6m', '--report', '--text'],
    { encoding: 'utf8', timeout: 180000 });
  // A page nothing wrote to is reported as "console grid is empty" rather than
  // as a count of zero, so the negative arm has no number to read at all.
  if (/console grid is empty/.test(out)) return { cells: 0, out };
  const cells = /(\d+) of 2000 cells non-blank/.exec(out);
  assert.ok(cells, `no cell count in report:\n${out}`);
  return { cells: Number(cells[1]), out };
}

// The positive arm: the guest's own selector on the gate, so the tick lands.
const hooked = run('PMIVEC.COM', SEL_GUEST);
assert.strictEqual(hooked.cells, 2,
  `a protected-mode INT 08h handler got no tick (expected 2 cells, got ${hooked.cells}):\n${hooked.out}`);

// The negative arm: the extender moving its own gate inside its own code
// selector, which is not the guest asking for anything.
const stock = run('PMIVEC2.COM', SEL_CODE);
assert.strictEqual(stock.cells, 0,
  `a gate that stayed in the extender's own selector was read as a hook`
  + ` (expected 0 cells, got ${stock.cells}):\n${stock.out}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log('PASS test-toyvm-pm-timer-vector: IDT gate 8 moved to another selector'
  + ' takes the tick; moved within the extender\'s own does not');
