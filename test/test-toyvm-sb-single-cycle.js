'use strict';

// A single-cycle Sound Blaster block, driven by a real guest program, on both
// widths of DMA controller.
//
// The card's completion interrupt is the whole of what a driver's card
// detection believes. A player programs the 8237, issues a single-cycle DSP
// output command, and spins on a flag its own IRQ handler sets; if the flag
// never moves it concludes there is no card, whatever the DSP already
// answered about its version. So this drives the sequence from inside the
// guest -- vector hooked, PIC unmasked, 8237 programmed, DSP commanded,
// bounded wait -- and prints whether the interrupt arrived and how much of
// the transfer the controller actually consumed.
//
// The 8-bit arm (14h on channel 1, 800 bytes) is the plain case and is a
// regression guard.
//
// The 16-bit arm is ATTIC.EXE's, and it is the one that was broken: its DSMI
// driver finds the 16-bit channel by masking 8-bit 0/1/3 AND 16-bit 5/6/7,
// issuing B6h for six samples, and only then programming channel 5 and
// unmasking it alone. A short block waits for a channel to open (see
// Machine.sbDmaWritten) and that search only ever looked at channels 0-3, so
// nothing on the second 8237 could ever open it: the probe timed out, no IRQ
// fired, and DSMI reported no card.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Machine, STUB_SEG } = require('../tools/toyvm/dos');

const LEN = 800;          // bytes in the 8-bit block
const WIDE_SAMPLES = 6;   // words in the 16-bit probe, as DSMI sends it
const OUTER = 40;         // outer turns of the bounded wait (~10M dispatches)

// A byte-level assembler with labels: `label(n)` marks a spot, `abs16(n)`
// emits a placeholder for its 16-bit offset and `rel8(n)` for a short jump to
// it. Everything is patched after the body is built, so forward references
// work and an out-of-range short jump is an error rather than a silent wrap.
function assemble(build) {
  const bytes = [];
  const labels = Object.create(null);
  const fixups = [];
  const a = {
    emit: (...b) => bytes.push(...b),
    label: (n) => { labels[n] = 0x100 + bytes.length; },
    abs16: (n) => { fixups.push({ at: bytes.length, name: n, rel: false }); bytes.push(0, 0); },
    rel8: (n) => { fixups.push({ at: bytes.length, name: n, rel: true }); bytes.push(0); },
  };
  build(a);
  for (const f of fixups) {
    const t = labels[f.name];
    assert.ok(t !== undefined, `undefined label ${f.name}`);
    if (f.rel) {
      const d = t - (0x100 + f.at + 1);
      assert.ok(d >= -128 && d <= 127, `short jump to ${f.name} out of range (${d})`);
      bytes[f.at] = d & 0xFF;
    } else {
      bytes[f.at] = t & 0xFF; bytes[f.at + 1] = (t >> 8) & 0xFF;
    }
  }
  return Buffer.from(bytes);
}

const outImm = (a, port, v) => a.emit(0xB0, v & 0xFF, 0xE6, port);   // mov al,v / out port,al
const outDx = (a, v) => a.emit(0xB0, v & 0xFF, 0xEE);                // mov al,v / out dx,al

// jmp over the handler, the handler itself, and the flag it sets.
function prologue(a) {
  a.emit(0xEB); a.rel8('main');
  a.label('isr');
  a.emit(0x50, 0x52);                       // push ax / push dx
  a.emit(0xB0, 0x01);                       // mov al,1
  a.emit(0x2E, 0xA2); a.abs16('flag');      // mov cs:[flag],al
  a.emit(0xBA, 0x2E, 0x02, 0xEC);           // mov dx,22Eh / in al,dx   (ack 8-bit)
  a.emit(0xBA, 0x2F, 0x02, 0xEC);           // mov dx,22Fh / in al,dx   (ack 16-bit)
  a.emit(0xB0, 0x20, 0xE6, 0x20);           // mov al,20h / out 20h,al  (EOI)
  a.emit(0x5A, 0x58, 0xCF);                 // pop dx / pop ax / iret
  a.label('flag');
  a.emit(0x00);
  a.label('main');
  // Hook IRQ 7 (vector 0Fh) and let it through the PIC.
  a.emit(0x31, 0xC0, 0x8E, 0xC0, 0xFA);     // xor ax,ax / mov es,ax / cli
  a.emit(0xB8); a.abs16('isr');             // mov ax,isr
  a.emit(0x26, 0xA3, 0x3C, 0x00);           // mov es:[3Ch],ax
  a.emit(0x8C, 0xC8, 0x26, 0xA3, 0x3E, 0x00); // mov ax,cs / mov es:[3Eh],ax
  a.emit(0xFB);                             // sti
  a.emit(0xE4, 0x21, 0x24, 0x7F, 0xE6, 0x21); // in al,21h / and al,7Fh / out 21h,al
}

// DX:AX <- the linear address of `buf`.
function linear(a) {
  a.emit(0x8C, 0xD8, 0x89, 0xC2);           // mov ax,ds / mov dx,ax
  a.emit(0xB1, 0x0C, 0xD3, 0xEA);           // mov cl,12 / shr dx,cl
  a.emit(0xB1, 0x04, 0xD3, 0xE0);           // mov cl,4 / shl ax,cl
  a.emit(0x05); a.abs16('buf');             // add ax,buf
  a.emit(0x83, 0xD2, 0x00);                 // adc dx,0
}

// The bounded wait, then the result: 'Y' or 'N' followed by BX in hex.
function waitAndReport(a, countPort) {
  a.emit(0xBE, OUTER & 0xFF, OUTER >> 8);   // mov si,OUTER
  a.label('wo');
  a.emit(0x31, 0xC9);                       // xor cx,cx
  a.label('wi');
  a.emit(0x2E, 0xA0); a.abs16('flag');      // mov al,cs:[flag]
  a.emit(0x08, 0xC0);                       // or al,al
  a.emit(0x75); a.rel8('done');             // jnz done
  a.emit(0xE2); a.rel8('wi');               // loop wi
  a.emit(0x4E);                             // dec si
  a.emit(0x75); a.rel8('wo');               // jnz wo
  a.label('done');
  // What the controller consumed: clear the flip-flop, read the count.
  if (countPort === 0x03) a.emit(0x30, 0xC0, 0xE6, 0x0C);   // xor al,al / out 0Ch,al
  else a.emit(0x30, 0xC0, 0xE6, 0xD8);                      // xor al,al / out D8h,al
  a.emit(0xE4, countPort, 0x88, 0xC3);      // in al,port / mov bl,al
  a.emit(0xE4, countPort, 0x88, 0xC7);      // in al,port / mov bh,al
  a.emit(0xB2, 0x4E);                       // mov dl,'N'
  a.emit(0x2E, 0xA0); a.abs16('flag');      // mov al,cs:[flag]
  a.emit(0x08, 0xC0, 0x74, 0x02);           // or al,al / jz +2
  a.emit(0xB2, 0x59);                       // mov dl,'Y'
  a.emit(0xB4, 0x02, 0xCD, 0x21);           // mov ah,2 / int 21h
  // BX as four hex digits, then exit.
  a.emit(0xB9, 0x04, 0x00);                 // mov cx,4
  a.label('hex');
  a.emit(0xC1, 0xC3, 0x04);                 // rol bx,4
  a.emit(0x88, 0xD8, 0x24, 0x0F, 0x04, 0x30); // mov al,bl / and al,0Fh / add al,'0'
  a.emit(0x3C, 0x39, 0x76, 0x02, 0x04, 0x07); // cmp al,'9' / jbe +2 / add al,7
  a.emit(0x88, 0xC2, 0xB4, 0x02, 0xCD, 0x21); // mov dl,al / mov ah,2 / int 21h
  a.emit(0xE2); a.rel8('hex');              // loop hex
  a.emit(0xB8, 0x00, 0x4C, 0xCD, 0x21);     // mov ax,4C00h / int 21h
}

// --- 14h: 8-bit single-cycle output on channel 1 ---------------------------
const narrow = () => assemble((a) => {
  prologue(a);
  // Fill the buffer with a ramp so the transfer moves real bytes.
  a.emit(0xBF); a.abs16('buf');             // mov di,buf
  a.emit(0xB9, LEN & 0xFF, LEN >> 8);       // mov cx,LEN
  a.emit(0xB0, 0x00);                       // mov al,0
  a.label('fill');
  a.emit(0x88, 0x05, 0x47, 0x04, 0x03);     // mov [di],al / inc di / add al,3
  a.emit(0xE2); a.rel8('fill');             // loop fill

  linear(a);
  a.emit(0x50);                             // push ax
  outImm(a, 0x0A, 0x05);                    // mask channel 1
  a.emit(0x30, 0xC0, 0xE6, 0x0C);           // clear the flip-flop
  outImm(a, 0x0B, 0x49);                    // single, read, channel 1
  a.emit(0x88, 0xD0, 0xE6, 0x83);           // mov al,dl / out 83h,al   (page)
  a.emit(0x58, 0xE6, 0x02);                 // pop ax / out 02h,al
  a.emit(0x88, 0xE0, 0xE6, 0x02);           // mov al,ah / out 02h,al
  outImm(a, 0x03, (LEN - 1) & 0xFF);
  outImm(a, 0x03, (LEN - 1) >> 8);
  outImm(a, 0x0A, 0x01);                    // unmask channel 1

  a.emit(0xBA, 0x26, 0x02);                 // mov dx,226h
  outDx(a, 0x01); outDx(a, 0x00);           // DSP reset
  a.emit(0xBA, 0x2A, 0x02, 0xEC);           // mov dx,22Ah / in al,dx  (the AAh)
  a.emit(0xBA, 0x2C, 0x02);                 // mov dx,22Ch
  outDx(a, 0x40); outDx(a, 256 - Math.round(1e6 / 8000));   // time constant, 8kHz
  outDx(a, 0xD1);                           // speaker on
  outDx(a, 0x14); outDx(a, (LEN - 1) & 0xFF); outDx(a, (LEN - 1) >> 8);

  waitAndReport(a, 0x03);
  a.label('buf');
});

// --- B6h: 16-bit single-cycle output, ATTIC.EXE's channel hunt -------------
const wide = () => assemble((a) => {
  prologue(a);
  for (const v of [0x04, 0x05, 0x07]) outImm(a, 0x0A, v);   // mask 8-bit 0, 1, 3
  for (const v of [0x05, 0x06, 0x07]) outImm(a, 0xD4, v);   // mask 16-bit 5, 6, 7
  a.emit(0xBA, 0x2C, 0x02);                 // mov dx,22Ch
  outDx(a, 0x41); outDx(a, 0x2B); outDx(a, 0x11);           // 11025 Hz
  // 16-bit single-cycle output, signed mono, WIDE_SAMPLES samples. Issued
  // with every candidate channel masked, exactly as DSMI does.
  outDx(a, 0xB6); outDx(a, 0x10);
  outDx(a, (WIDE_SAMPLES - 1) & 0xFF); outDx(a, (WIDE_SAMPLES - 1) >> 8);

  linear(a);
  a.emit(0xD1, 0xEA, 0xD1, 0xD8);           // shr dx,1 / rcr ax,1   (16-bit channels count words)
  a.emit(0x50);                             // push ax
  outImm(a, 0xD4, 0x05);                    // mask channel 5
  a.emit(0x30, 0xC0, 0xE6, 0xD8);           // clear the flip-flop
  outImm(a, 0xD6, 0x49);                    // single, read, channel 5
  a.emit(0x88, 0xD0, 0x24, 0xFE, 0xE6, 0x8B); // mov al,dl / and al,0FEh / out 8Bh,al
  a.emit(0x58, 0xE6, 0xC4);                 // pop ax / out C4h,al
  a.emit(0x88, 0xE0, 0xE6, 0xC4);           // mov al,ah / out C4h,al
  outImm(a, 0xC6, (WIDE_SAMPLES - 1) & 0xFF);
  outImm(a, 0xC6, (WIDE_SAMPLES - 1) >> 8);
  outImm(a, 0xD4, 0x01);                    // unmask channel 5, alone

  waitAndReport(a, 0xC6);
  a.label('buf');
});

function run(com) {
  const args = [path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js'), com,
    '--dispatches=30m', '--pit-clock', '--sound=full', '--text', '--report'];
  return execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 24 });
}

const screen = (log) => (log.match(/^  \|(.*)$/gm) || []).map((s) => s.slice(3).trim()).join('');
const irqs = (log) => +(/sb .*?(\d+) irq\(s\)/.exec(log) || [0, 0])[1];

// --- the same hunt at the ports, with no guest time allowed to pass --------
//
// This is the discriminating arm. A guest that waits long enough gets the
// interrupt either way -- six samples at 11025 Hz is half a millisecond, and
// the block completes off the sample clock once the channel is finally open.
// DSMI does NOT wait that long: it gives the probe a short `loopz` and moves
// on to the next candidate. So what has to hold is that unmasking the channel
// completes the block *there*, at the port write, the way a real card's DREQ
// does -- which is what the arms above cannot tell apart and what channel 5
// never got.
function testWideChannelHuntIsImmediate() {
  const mem = new Uint8Array(1 << 20);
  const m = new Machine(new Uint8Array(0), { log: () => {} });
  m.setMemory(mem, null);
  mem[0x0F * 4 + 2] = 0x34; mem[0x0F * 4 + 3] = 0x12;   // a hooked IRQ 7
  assert.notStrictEqual(0x1234, STUB_SEG);

  for (const v of [0x04, 0x05, 0x07]) m.portOut(0x0A, v, 8);   // mask 8-bit 0, 1, 3
  for (const v of [0x05, 0x06, 0x07]) m.portOut(0xD4, v, 8);   // mask 16-bit 5, 6, 7
  for (const b of [0x41, 0x2B, 0x11]) m.portOut(0x22C, b, 8);  // 11025 Hz
  for (const b of [0xB6, 0x10, WIDE_SAMPLES - 1, 0]) m.portOut(0x22C, b, 8);
  assert.strictEqual(m.sb.bits, 16, 'B6h is a 16-bit transfer');
  assert.strictEqual(m.sbIrq(), 0, 'the probe completed with every channel masked');

  // Program channel 5 and unmask it alone, as DSMI does.
  m.portOut(0xD8, 0, 8);
  m.portOut(0xD6, 0x49, 8);
  m.portOut(0xC4, 0, 8); m.portOut(0xC4, 0, 8);
  m.portOut(0xC6, WIDE_SAMPLES - 1, 8); m.portOut(0xC6, 0, 8);
  m.portOut(0x8B, 0, 8);
  m.portOut(0xD4, 0x01, 8);

  assert.strictEqual(m.sbIrq(), 0x0F,
    'unmasking channel 5 did not complete the 16-bit short block');
  assert.strictEqual(m.sb.chan, 5, `the block was credited to channel ${m.sb.chan}`);
  assert.strictEqual(m.sbIrq(), 0, 'the short block interrupted twice');
  // A 16-bit block's interrupt is bit 1 of mixer register 82h, and an ISR
  // reads that to pick 22Fh over 22Eh to acknowledge on.
  m.portOut(0x224, 0x82, 8);
  assert.strictEqual(m.portIn(0x225, 8) & 3, 2,
    'a 16-bit block latched the 8-bit interrupt bit');
  m.portIn(0x22F, 8);
  m.portOut(0x224, 0x82, 8);
  assert.strictEqual(m.portIn(0x225, 8) & 3, 0, '22Fh did not acknowledge it');

  // An 8-bit short block still finds an 8-bit channel and still latches bit 0.
  const m8 = new Machine(new Uint8Array(0), { log: () => {} });
  m8.setMemory(new Uint8Array(1 << 20), null);
  m8.mem[0x0F * 4 + 2] = 0x34; m8.mem[0x0F * 4 + 3] = 0x12;
  for (const v of [0x04, 0x05, 0x07]) m8.portOut(0x0A, v, 8);
  for (const b of [0x40, 256 - 125, 0x14, 9, 0]) m8.portOut(0x22C, b, 8);
  assert.strictEqual(m8.sbIrq(), 0, 'an 8-bit short block completed with every channel masked');
  m8.portOut(0xD4, 0x01, 8);
  assert.strictEqual(m8.sbIrq(), 0,
    'a 16-bit channel completed an 8-bit block');
  m8.portOut(0x0A, 0x01, 8);
  assert.strictEqual(m8.sbIrq(), 0x0F, 'unmasking channel 1 did not complete the 8-bit block');
  assert.strictEqual(m8.sb.chan, 1, `the block was credited to channel ${m8.sb.chan}`);
  m8.portOut(0x224, 0x82, 8);
  assert.strictEqual(m8.portIn(0x225, 8) & 3, 1, 'an 8-bit block latched the wrong interrupt bit');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-sb-single-cycle-'));
const out = [];

testWideChannelHuntIsImmediate();
out.push('channel hunt: an open channel completes the block at the port write, per width');

{
  const com = path.join(dir, 'SB8.COM');
  fs.writeFileSync(com, narrow());
  const log = run(com);
  assert.ok(/exited=true/.test(log), `8-bit: the program did not exit:\n${log}`);
  const s = screen(log);
  assert.strictEqual(s[0], 'Y',
    `8-bit single-cycle block on channel 1 never interrupted (screen "${s}")\n${log}`);
  assert.strictEqual(s.slice(1), '0000',
    `8-bit block left ${s.slice(1)} in the channel-1 count instead of running it out\n${log}`);
  assert.ok(irqs(log) >= 1, `8-bit: the card reports ${irqs(log)} interrupts\n${log}`);
  out.push(`14h on channel 1: IRQ fired, ${LEN} bytes consumed`);
}

{
  const com = path.join(dir, 'SB16.COM');
  fs.writeFileSync(com, wide());
  const log = run(com);
  assert.ok(/exited=true/.test(log), `16-bit: the program did not exit:\n${log}`);
  const s = screen(log);
  assert.strictEqual(s[0], 'Y',
    `16-bit single-cycle block never interrupted after channel 5 was unmasked `
    + `(screen "${s}") -- the short-block channel search is not looking at the `
    + `second 8237\n${log}`);
  assert.ok(irqs(log) >= 1, `16-bit: the card reports ${irqs(log)} interrupts\n${log}`);
  out.push('B6h on channel 5: IRQ fired once the channel was unmasked');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS test-toyvm-sb-single-cycle: ${out.join('; ')}`);
