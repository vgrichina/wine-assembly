'use strict';

// A high-speed Sound Blaster block that is never re-issued, on a DSP that has
// no high-speed mode to leave.
//
// 90h and 91h are the SB 2.0/Pro *high-speed* DMA commands. On those cards the
// documented rule is that 91h plays one block, raises its interrupt and leaves
// high-speed mode, so a driver has to send it again for the next block. A DSP
// 4.xx SB16 has no high-speed mode: the commands are not in its manual, the
// card always runs at full rate, and 48h is only an interrupt period.
//
// STHINTRO.EXE (DemoVT 1.60) is the program in this corpus that depends on the
// difference, and it says so out loud -- its block ISR re-sends 91h on every
// card EXCEPT one whose DSP answered 4.x:
//
//     ece3  cmp [d82],0     ; the "the DSP is a 4.x" flag
//     ed25  jz  ed2d        ; 2.x/3.x: send 91h again
//     ed27  cmp [bp+6],0    ; 4.x, and already playing:
//     ed2b  jnz ed37        ;   send nothing at all
//
// With the block ended at a count the card had no way of knowing was final,
// the music stopped after two interrupts, the mixer never ran again, and the
// demo held its title screen for the rest of the run. What is still feeding
// the card at that point is the only counter left armed: the 8237's own
// auto-init bit, which such a driver leaves set (mode 59h). So the block
// reloads while that bit is set, and the DMA controller -- not the DSP --
// decides when the music stops.
//
// Three arms, and each of the other two is a way of getting that wrong:
//
//   * a DSP 4.05 card with the 8237 in auto-init keeps interrupting;
//   * the same card with the 8237 in SINGLE mode stops after one block, so
//     this is not "91h now means auto-init";
//   * a DSP 2.01 card stops after one block even with the 8237 in auto-init,
//     which is the documented high-speed rule and what every other emulator
//     implements. A driver that meets that card re-sends 91h itself.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Machine } = require('../tools/toyvm/dos');

const LEN = 1024;      // bytes per block: 46ms at 22222 Hz, well over a short block
const RATE_TC = 0xD3;  // 40h time constant -> 1e6/(256-0xD3) = 22222 Hz
const RATE = 22222;

// --- the ports, with the sample clock driven by hand -----------------------
//
// One Machine per arm, so nothing carries over. `blocks` runs the transfer for
// `seconds` of guest time and counts how many completion interrupts the card
// offered, acknowledging each the way an ISR does (22Eh) without ever sending
// another DSP command.
function drive({ dspVersion, dmaMode, seconds }) {
  const m = new Machine(new Uint8Array(0), { log: () => {}, dspVersion });
  m.setMemory(new Uint8Array(1 << 20), null);
  m.mem[0x0F * 4 + 2] = 0x34; m.mem[0x0F * 4 + 3] = 0x12;   // a hooked IRQ 7

  // The 8237: channel 1, read, `dmaMode`'s auto-init bit, LEN bytes at 0x20000.
  m.portOut(0x0A, 0x05, 8);                 // mask channel 1
  m.portOut(0x0C, 0, 8);                    // clear the flip-flop
  m.portOut(0x0B, dmaMode, 8);
  m.portOut(0x02, 0x00, 8); m.portOut(0x02, 0x00, 8);
  m.portOut(0x83, 0x02, 8);
  m.portOut(0x03, (LEN - 1) & 0xFF, 8); m.portOut(0x03, (LEN - 1) >> 8, 8);
  m.portOut(0x0A, 0x01, 8);                 // unmask channel 1

  // The DSP, exactly as DemoVT programs it: rate, block length, 91h. Once.
  for (const b of [0xD1, 0x40, RATE_TC, 0x48, (LEN - 1) & 0xFF, (LEN - 1) >> 8, 0x91]) {
    m.portOut(0x22C, b, 8);
  }
  assert.strictEqual(m.sb.pending, true, '91h did not start a transfer');

  // Guest time in 10ms steps, which is about what one timer tick is worth.
  let irqs = 0;
  const step = 0.01;
  for (let t = 0; t < seconds; t += step) {
    m.audio.advance(step, 0, 1);
    while (m.sbIrq()) { irqs++; m.portIn(0x22E, 8); }   // the ISR: acknowledge, nothing else
  }
  return { irqs, m };
}

const out = [];

// The whole point: a 4.xx card with the 8237 in auto-init keeps going.
{
  const seconds = 0.5;                       // ~10 blocks of 46ms
  const { irqs, m } = drive({ dspVersion: [4, 5], dmaMode: 0x59, seconds });
  const want = Math.floor(seconds * RATE / LEN);
  assert.ok(irqs >= want - 1,
    `DSP 4.05 with the 8237 in auto-init interrupted ${irqs} time(s) in ${seconds}s, `
    + `wanted about ${want}: the block was not reloaded, so a player that sends 91h `
    + `once goes silent after its first block`);
  assert.strictEqual(m.sb.pending, true, 'the transfer stopped even though it kept interrupting');
  out.push(`DSP 4.05 + 8237 auto-init: ${irqs} block interrupts in ${seconds}s (~${want} blocks)`);
}

// ...but only because the 8237 said so. 91h is still not an auto-init command.
{
  const { irqs, m } = drive({ dspVersion: [4, 5], dmaMode: 0x49, seconds: 0.5 });
  assert.strictEqual(irqs, 1,
    `DSP 4.05 with the 8237 in SINGLE mode interrupted ${irqs} time(s); 91h is a `
    + `single-cycle command and nothing was left to reload the block`);
  assert.strictEqual(m.sb.pending, false, 'a single-cycle block left the transfer running');
  out.push('DSP 4.05 + 8237 single: one block, then the transfer ends');
}

// A real SB 2.0 leaves high-speed mode at the end of the block whatever the
// 8237 is doing. A driver that meets one re-sends 91h itself.
{
  const { irqs, m } = drive({ dspVersion: [2, 1], dmaMode: 0x59, seconds: 0.5 });
  assert.strictEqual(irqs, 1,
    `DSP 2.01 interrupted ${irqs} time(s): 91h on a card that HAS a high-speed mode `
    + `ends the block and leaves it, and this arm must not follow the 8237`);
  assert.strictEqual(m.sb.pending, false, '2.01 high-speed single-cycle kept playing');
  out.push('DSP 2.01 + 8237 auto-init: one block, per the high-speed rule');
}

// 90h is auto-init by command and never depended on any of this.
{
  const m = new Machine(new Uint8Array(0), { log: () => {}, dspVersion: [2, 1] });
  m.setMemory(new Uint8Array(1 << 20), null);
  m.mem[0x0F * 4 + 2] = 0x34; m.mem[0x0F * 4 + 3] = 0x12;
  m.portOut(0x0A, 0x05, 8); m.portOut(0x0C, 0, 8); m.portOut(0x0B, 0x49, 8);
  m.portOut(0x02, 0, 8); m.portOut(0x02, 0, 8); m.portOut(0x83, 0x02, 8);
  m.portOut(0x03, (LEN - 1) & 0xFF, 8); m.portOut(0x03, (LEN - 1) >> 8, 8);
  m.portOut(0x0A, 0x01, 8);
  for (const b of [0x40, RATE_TC, 0x48, (LEN - 1) & 0xFF, (LEN - 1) >> 8, 0x90]) {
    m.portOut(0x22C, b, 8);
  }
  let irqs = 0;
  for (let t = 0; t < 0.5; t += 0.01) {
    m.audio.advance(0.01, 0, 1);
    while (m.sbIrq()) { irqs++; m.portIn(0x22E, 8); }
  }
  assert.ok(irqs >= 8, `90h auto-init interrupted only ${irqs} time(s) on a 2.01 card`);
  out.push(`90h auto-init on DSP 2.01: ${irqs} block interrupts, unaffected`);
}

// --- and the same sequence from inside a guest -----------------------------
//
// The arms above drive the card through the port functions with the sample
// clock stepped by hand. This one is a real .COM: it hooks IRQ 7, programs the
// 8237 in auto-init, sends 40h/48h/91h ONCE, and its handler only counts and
// acknowledges. It prints how many interrupts arrived, which is the number
// DemoVT's mixer needs and got two of.

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

const WANT = 5;          // interrupts to wait for before reporting
const OUTER = 200;       // outer turns of the bounded wait

const program = () => assemble((a) => {
  a.emit(0xEB); a.rel8('main');
  // The ISR: count, acknowledge on 22Eh, EOI. It sends no DSP command, which
  // is the whole point -- on this card the driver believes it does not have to.
  a.label('isr');
  a.emit(0x50, 0x52);                       // push ax / push dx
  a.emit(0x2E, 0xFE, 0x06); a.abs16('n');   // inc byte cs:[n]
  a.emit(0xBA, 0x2E, 0x02, 0xEC);           // mov dx,22Eh / in al,dx
  a.emit(0xB0, 0x20, 0xE6, 0x20);           // mov al,20h / out 20h,al
  a.emit(0x5A, 0x58, 0xCF);                 // pop dx / pop ax / iret
  a.label('n');
  a.emit(0x00);
  a.label('main');
  a.emit(0x31, 0xC0, 0x8E, 0xC0, 0xFA);     // xor ax,ax / mov es,ax / cli
  a.emit(0xB8); a.abs16('isr');             // mov ax,isr
  a.emit(0x26, 0xA3, 0x3C, 0x00);           // mov es:[3Ch],ax
  a.emit(0x8C, 0xC8, 0x26, 0xA3, 0x3E, 0x00); // mov ax,cs / mov es:[3Eh],ax
  a.emit(0xFB);                             // sti
  a.emit(0xE4, 0x21, 0x24, 0x7F, 0xE6, 0x21); // in al,21h / and al,7Fh / out 21h,al

  // A ramp in the buffer, so the transfer moves real bytes.
  a.emit(0xBF); a.abs16('buf');             // mov di,buf
  a.emit(0xB9, LEN & 0xFF, LEN >> 8);       // mov cx,LEN
  a.emit(0xB0, 0x00);                       // mov al,0
  a.label('fill');
  a.emit(0x88, 0x05, 0x47, 0x04, 0x03);     // mov [di],al / inc di / add al,3
  a.emit(0xE2); a.rel8('fill');             // loop fill

  // DX:AX <- linear address of buf.
  a.emit(0x8C, 0xD8, 0x89, 0xC2);           // mov ax,ds / mov dx,ax
  a.emit(0xB1, 0x0C, 0xD3, 0xEA);           // mov cl,12 / shr dx,cl
  a.emit(0xB1, 0x04, 0xD3, 0xE0);           // mov cl,4 / shl ax,cl
  a.emit(0x05); a.abs16('buf');             // add ax,buf
  a.emit(0x83, 0xD2, 0x00);                 // adc dx,0
  a.emit(0x50);                             // push ax

  outImm(a, 0x0A, 0x05);                    // mask channel 1
  a.emit(0x30, 0xC0, 0xE6, 0x0C);           // clear the flip-flop
  outImm(a, 0x0B, 0x59);                    // single, read, AUTO-INIT, channel 1
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
  outDx(a, 0xD1);                           // speaker on
  outDx(a, 0x40); outDx(a, RATE_TC);        // 22222 Hz
  outDx(a, 0x48); outDx(a, (LEN - 1) & 0xFF); outDx(a, (LEN - 1) >> 8);
  outDx(a, 0x91);                           // high-speed single-cycle, once

  // Wait for WANT interrupts, or give up.
  a.emit(0xBE, OUTER & 0xFF, OUTER >> 8);   // mov si,OUTER
  a.label('wo');
  a.emit(0x31, 0xC9);                       // xor cx,cx
  a.label('wi');
  a.emit(0x2E, 0xA0); a.abs16('n');         // mov al,cs:[n]
  a.emit(0x3C, WANT);                       // cmp al,WANT
  a.emit(0x73); a.rel8('done');             // jnb done
  a.emit(0xE2); a.rel8('wi');               // loop wi
  a.emit(0x4E);                             // dec si
  a.emit(0x75); a.rel8('wo');               // jnz wo
  a.label('done');
  // Print the count as two hex digits, then exit.
  a.emit(0x2E, 0xA0); a.abs16('n');         // mov al,cs:[n]
  a.emit(0x88, 0xC3);                       // mov bl,al
  a.emit(0xB9, 0x02, 0x00);                 // mov cx,2
  a.label('hex');
  a.emit(0xC0, 0xC3, 0x04);                 // rol bl,4
  a.emit(0x88, 0xD8, 0x24, 0x0F, 0x04, 0x30); // mov al,bl / and al,0Fh / add al,'0'
  a.emit(0x3C, 0x39, 0x76, 0x02, 0x04, 0x07); // cmp al,'9' / jbe +2 / add al,7
  a.emit(0x88, 0xC2, 0xB4, 0x02, 0xCD, 0x21); // mov dl,al / mov ah,2 / int 21h
  a.emit(0xE2); a.rel8('hex');              // loop hex
  a.emit(0xB8, 0x00, 0x4C, 0xCD, 0x21);     // mov ax,4C00h / int 21h
  a.label('buf');
});

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-sb-hs-'));
  const com = path.join(dir, 'SBHS.COM');
  fs.writeFileSync(com, program());
  const log = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js'), com,
    '--dispatches=40m', '--pit-clock', '--sound=full', '--text', '--report',
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 24 });
  assert.ok(/exited=true/.test(log), `the program did not exit:\n${log}`);
  const screen = (log.match(/^  \|(.*)$/gm) || []).map((s) => s.slice(3).trim()).join('');
  const n = parseInt(screen, 16);
  assert.ok(n >= WANT,
    `the guest saw ${screen} (${n}) block interrupts from one 91h, wanted ${WANT}: a `
    + `player that does not re-send the command goes silent after its first block\n${log}`);
  out.push(`a guest sending 91h once got ${n} block interrupts`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`PASS test-toyvm-sb-highspeed-autoinit: ${out.join('; ')}`);
