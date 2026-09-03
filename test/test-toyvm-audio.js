'use strict';

// The sound behind the ports, without a browser or a corpus.
//
// tools/toyvm/audio.js turns a Sound Blaster transfer into samples pulled
// through the 8237 and the PC speaker into a square wave, and live.js paces
// the guest against the wall clock. All three are checked here from the
// machine's port interface alone: program the DMA controller and the DSP the
// way a driver does, advance guest time, and read what came out.

const assert = require('assert');
const { Machine, STUB_SEG } = require('../tools/toyvm/dos');
const { LiveRun } = require('../tools/toyvm/live');

function machine() {
  const mem = new Uint8Array(1 << 20);
  const m = new Machine(new Uint8Array(0), { log: () => {} });
  m.setMemory(mem, null);
  // A vector that is not the stub's, so the card's IRQ counts as hooked.
  mem[0x0F * 4 + 2] = 0x34; mem[0x0F * 4 + 3] = 0x12;
  assert.notStrictEqual(0x1234, STUB_SEG);
  return m;
}

function collect(m, rate) {
  const out = [];
  m.audio.rate = rate;
  m.audio.sink = (buf, frames) => out.push(Float32Array.from(buf.subarray(0, frames * 2)));
  return out;
}

function peak(chunks, from = 0, to = Infinity) {
  let p = 0, i = 0;
  for (const c of chunks) {
    for (let k = 0; k < c.length; k += 2, i++) {
      if (i < from || i >= to) continue;
      p = Math.max(p, Math.abs(c[k]));
    }
  }
  return p;
}

function crossings(chunks) {
  let n = 0, prev = 0;
  for (const c of chunks) {
    for (let k = 0; k < c.length; k += 2) {
      const s = c[k] > 0 ? 1 : c[k] < 0 ? -1 : 0;
      if (s && prev && s !== prev) n++;
      if (s) prev = s;
    }
  }
  return n;
}

// The 8237 as a driver programs it: mask, clear the flip-flop, mode, address,
// count, page, unmask.
function programDma(m, ch, lin, count, { auto = false } = {}) {
  const second = ch >= 4;
  const base = second ? 0xC0 + (ch - 4) * 4 : ch * 2;
  const addr = second ? (lin >> 1) & 0xFFFF : lin & 0xFFFF;
  const page = second ? (lin >> 16) & 0xFE : (lin >> 16) & 0xFF;
  const PAGE = { 1: 0x83, 5: 0x8B };
  m.portOut(second ? 0xD4 : 0x0A, 4 | (ch & 3), 8);
  m.portOut(second ? 0xD8 : 0x0C, 0, 8);
  m.portOut(second ? 0xD6 : 0x0B, 0x48 | (auto ? 0x10 : 0) | (ch & 3), 8);
  m.portOut(base, addr & 0xFF, 8); m.portOut(base, addr >> 8, 8);
  m.portOut(base + (second ? 2 : 1), (count - 1) & 0xFF, 8);
  m.portOut(base + (second ? 2 : 1), (count - 1) >> 8, 8);
  m.portOut(PAGE[ch], page, 8);
  m.portOut(second ? 0xD4 : 0x0A, ch & 3, 8);
}

function dsp(m, ...bytes) { for (const b of bytes) m.portOut(0x22C, b, 8); }

// --- an 8-bit single-cycle block through channel 1 --------------------------
function testSb8() {
  const m = machine();
  const len = 2000, at = 0x10000;
  // A 100Hz sawtooth at 8kHz, unsigned 8-bit.
  for (let i = 0; i < len; i++) m.mem[at + i] = 128 + Math.round(100 * ((i % 80) / 80 * 2 - 1));
  programDma(m, 1, at, len);
  dsp(m, 0x40, 256 - Math.round(1e6 / 8000));        // time constant for 8kHz
  dsp(m, 0x14, (len - 1) & 0xFF, (len - 1) >> 8);    // 8-bit single-cycle DMA out
  assert.strictEqual(m.sb.rate, 8000, `rate ${m.sb.rate}`);
  assert.strictEqual(m.sb.len, len);
  assert.ok(m.sb.pending, 'the transfer did not start');

  const out = collect(m, 8000);
  // 0.1s: 800 samples consumed, the count register says so.
  for (let i = 0; i < 10; i++) m.audioAdvance(0.01, i * 1000, 1000);
  m.portOut(0x0C, 0, 8);
  const cnt = m.portIn(0x03, 8) | (m.portIn(0x03, 8) << 8);
  assert.strictEqual(cnt, len - 1 - 800, `DMA count reads ${cnt}`);
  assert.ok(!m.sbDue(), 'the block-done interrupt came early');
  assert.ok(peak(out) > 0.2, `the stream is silent (peak ${peak(out)})`);

  // Through the end of the block, and a quarter second past it.
  for (let i = 0; i < 40; i++) m.audioAdvance(0.01, 10000 + i * 1000, 1000);
  assert.ok(m.sbDue(), 'the block never completed');
  assert.ok(!m.sb.pending, 'a single-cycle block is still pending after its end');
  assert.strictEqual(m.sbIrq(), 0x0F, 'the block-done IRQ was not offered');
  assert.ok(!m.sbDue(), 'the IRQ was offered twice');
  assert.strictEqual(m.sb.irqs, 1);
  const st = m.portIn(0x08, 8);
  assert.ok(st & 2, `terminal count for channel 1 not set (status ${st})`);
  // Nothing after the block but the filter settling.
  assert.ok(peak(out, 8000 * 0.4, 8000 * 0.5) < 0.02,
    `sound after the block ended: ${peak(out, 8000 * 0.4, 8000 * 0.5)}`);
  console.log('  8-bit block: played, counted down, completed once');
}

// --- a 16-bit signed auto-init block through channel 5 ---------------------
function testSb16() {
  const m = machine();
  const len = 400, at = 0x20000;
  for (let i = 0; i < len; i++) {
    const v = i < len / 2 ? 16000 : -16000;
    m.mem[at + i * 2] = v & 0xFF; m.mem[at + i * 2 + 1] = (v >> 8) & 0xFF;
  }
  programDma(m, 5, at, len, { auto: true });
  dsp(m, 0x41, 0x2B, 0x11);                              // 11025 Hz
  dsp(m, 0xB6, 0x10, (len - 1) & 0xFF, (len - 1) >> 8);  // 16-bit auto-init, signed mono
  assert.strictEqual(m.sb.bits, 16); assert.strictEqual(m.sb.chan, 5);
  assert.ok(m.sb.signed && m.sb.autoInit);
  // No sink: consumed by time alone.
  for (let i = 0; i < 10; i++) m.audioAdvance(len / 11025 / 10 * 2.5, i * 1000, 1000);
  assert.ok(m.sb.pending, 'auto-init stopped');
  assert.strictEqual(m.sbIrq(), 0x0F, 'no block-done IRQ over 2.5 blocks');
  // Two and a half blocks in, the level is the first half's.
  assert.ok(Math.abs(m.sb.lastL - 16000 / 32768) < 1e-6, `level ${m.sb.lastL}`);
  m.portOut(0xD8, 0, 8);
  const cnt = m.portIn(0xC6, 8) | (m.portIn(0xC6, 8) << 8);
  assert.ok(cnt < len, `auto-init did not reload (count ${cnt})`);
  console.log('  16-bit auto-init block: reloads and keeps its level');
}

// --- a transfer with no DMA behind it still completes ----------------------
function testProbeWithoutDma() {
  const m = machine();
  dsp(m, 0x40, 256 - Math.round(1e6 / 8000));
  dsp(m, 0x14, 0xFF, 0x03);                             // 1024 samples, channel never programmed
  for (let i = 0; i < 20; i++) m.audioAdvance(0.01, i * 1000, 1000);
  assert.ok(m.sbDue(), 'a block with no DMA channel programmed never completed');
  console.log('  block without DMA: still completes (as silence)');
}

// --- the speaker -----------------------------------------------------------
function testSpeaker() {
  const m = machine();
  const out = collect(m, 44100);
  m.portOut(0x43, 0xB6, 8);                              // channel 2, lo/hi, square wave
  m.portOut(0x42, 1193 & 0xFF, 8); m.portOut(0x42, 1193 >> 8, 8);   // ~1kHz
  m.portOut(0x61, 3, 8);                                 // gate + data
  for (let i = 0; i < 5; i++) m.audioAdvance(0.01, i * 1000, 1000);
  const n = crossings(out);
  assert.ok(n >= 90 && n <= 110, `1kHz for 50ms should cross zero ~100 times, got ${n}`);
  m.portOut(0x61, 0, 8);
  const before = out.length;
  for (let i = 0; i < 10; i++) m.audioAdvance(0.01, 5000 + i * 1000, 1000);
  const tail = out.slice(before + 5);
  assert.ok(peak(tail) < 0.01, `speaker off but still sounding: ${peak(tail)}`);
  console.log(`  speaker: 1kHz square wave (${n} crossings in 50ms), silent when gated off`);
}

// --- OPL2 ----------------------------------------------------------------------
// The presence test a driver runs, then one note the way the AdLib manual
// plays it: a carrier at full level with an instant attack, keyed on channel
// 0 at F-number 0x157 block 4, which is middle C (260 Hz), then keyed off with
// the fastest release.
function testOpl() {
  const m = machine();
  const opl = (reg, v) => { m.portOut(0x388, reg, 8); m.portOut(0x389, v, 8); };
  // Presence: reset timers, read 0; start timer 1, read the flags; reset, 0.
  opl(0x04, 0x60); opl(0x04, 0x80);
  assert.strictEqual(m.portIn(0x388, 8) & 0xE0, 0x00, 'status after reset');
  opl(0x02, 0xFF); opl(0x04, 0x21);
  assert.strictEqual(m.portIn(0x388, 8) & 0xE0, 0xC0, 'timer 1 flag after start');
  opl(0x04, 0x60); opl(0x04, 0x80);
  assert.strictEqual(m.portIn(0x388, 8) & 0xE0, 0x00, 'status after second reset');

  const out = collect(m, 44100);
  opl(0x20, 0x21); opl(0x23, 0x21);          // mult 1, sustaining, both operators
  opl(0x40, 0x3F); opl(0x43, 0x00);          // modulator silent, carrier at full level
  opl(0x60, 0xF0); opl(0x63, 0xF0);          // instant attack, no decay
  opl(0x80, 0x0F); opl(0x83, 0x0F);          // sustain at top, fastest release
  opl(0xA0, 0x57); opl(0xB0, 0x20 | (4 << 2) | 0x01);   // key on, block 4, fnum 0x157
  for (let i = 0; i < 10; i++) m.audioAdvance(0.01, i * 1000, 1000);
  const n = crossings(out);
  assert.ok(n >= 48 && n <= 56, `260Hz for 100ms should cross zero ~52 times, got ${n}`);
  assert.ok(peak(out) > 0.08, `carrier at full level too quiet: ${peak(out)}`);
  opl(0xB0, (4 << 2) | 0x01);                // key off
  const before = out.length;
  for (let i = 0; i < 10; i++) m.audioAdvance(0.01, 10000 + i * 1000, 1000);
  const tail = out.slice(before + 2);
  assert.ok(peak(tail) < 0.01, `released but still sounding: ${peak(tail)}`);
  assert.strictEqual(m.audio.opl.keyOns, 2, 'one channel keyed = two operators');
  console.log(`  opl2: presence test answered, middle C (${n} crossings in 100ms), silent after release`);
}

// --- the OPL timer test while audio is being rendered ------------------------
// With a sink attached, register writes are queued to land at their sample;
// the timer-control registers must not wait in that queue. BLUE.COM and
// brainbug.exe spun on the status read forever, but only when sound was on.
function testOplTimerRendered() {
  const m = machine();
  collect(m, 44100);
  const opl = (reg, v) => { m.portOut(0x388, reg, 8); m.portOut(0x389, v, 8); };
  opl(0x04, 0x60); opl(0x04, 0x80);
  assert.strictEqual(m.portIn(0x388, 8) & 0xE0, 0x00, 'status after reset, rendering');
  opl(0x02, 0xFF); opl(0x04, 0x21);
  assert.strictEqual(m.portIn(0x388, 8) & 0xE0, 0xC0, 'timer 1 flag after start, rendering');
  // The same chip behind the SB Pro's FM ports, and behind an ISA card's
  // 10-bit decode: 0xF389 is 0x389 to the bus (CONTAGIO.EXE reads it there).
  assert.strictEqual(m.portIn(0x228, 8) & 0xE0, 0xC0, 'status at 0x228');
  assert.strictEqual(m.portIn(0xF388, 8) & 0xE0, 0xC0, 'status at the alias 0xF388');
  m.portOut(0xF388, 0x04, 8); m.portOut(0xF389, 0x80, 8);
  assert.strictEqual(m.portIn(0x388, 8) & 0xE0, 0x00, 'reset through the alias');
  console.log('  opl2: timer flags answer while rendering, at 0x228 and through the ISA alias');
}

// --- a short block waits for a DMA channel ----------------------------------
// A driver hunting for its DMA channel masks every channel, starts a tiny
// transfer and unmasks the candidates one at a time: the IRQ names the one
// that moved. ACT1.EXE does exactly this, and a transfer that completed on a
// masked channel told it the first candidate was right.
function testShortBlockWaitsForDma() {
  const m = machine();
  m.portOut(0x0A, 4, 8); m.portOut(0x0A, 5, 8); m.portOut(0x0A, 7, 8);   // mask 0, 1, 3
  dsp(m, 0x40, 256 - Math.round(1e6 / 8000));
  dsp(m, 0x14, 9, 0);                                     // 10 samples
  assert.strictEqual(m.sbIrq(), 0, 'a short block completed with every channel masked');
  m.portOut(0x0A, 1, 8);                                  // unmask channel 1
  assert.strictEqual(m.sbIrq(), 0x0F, 'unmasking a channel did not complete the short block');
  assert.strictEqual(m.sb.chan, 1, `the block was credited to channel ${m.sb.chan}`);
  assert.strictEqual(m.sbIrq(), 0, 'the short block interrupted twice');
  // A block after a pause is a new block: ENDPART.EXE paused (D0) at the end
  // of one sample and started the next with 14, and the pause stuck.
  dsp(m, 0xD0);
  assert.ok(m.sb.paused);
  dsp(m, 0x14, 0xFF, 0x03);
  assert.ok(!m.sb.paused && m.sb.pending, 'a new transfer left the DSP paused');
  console.log('  short block: waits for an open DMA channel, names it; a new block clears a pause');
}

// --- the 8259s read back ------------------------------------------------------
function testPic() {
  const m = machine();
  assert.strictEqual(m.portIn(0x21, 8), 0xB8, 'boot mask, master');
  assert.strictEqual(m.portIn(0xA1, 8), 0x8F, 'boot mask, slave');
  m.portOut(0x21, m.portIn(0x21, 8) & ~0x20, 8);          // unmask IRQ5 the way a driver does
  assert.strictEqual(m.portIn(0x21, 8), 0x98, 'mask did not read back');
  // A remap: ICW1 with ICW4, base 0x50, cascade on IRQ2, then a fresh mask.
  m.portOut(0x20, 0x11, 8); m.portOut(0x21, 0x50, 8); m.portOut(0x21, 0x04, 8); m.portOut(0x21, 0x01, 8);
  m.portOut(0x21, 0xFA, 8);
  assert.strictEqual(m.pic.base[0], 0x50, 'ICW2 not recorded');
  assert.strictEqual(m.portIn(0x21, 8), 0xFA, 'the mask after an init sequence');
  // Single mode, no ICW4: only ICW2 follows.
  m.portOut(0xA0, 0x12, 8); m.portOut(0xA1, 0x28, 8); m.portOut(0xA1, 0x0F, 8);
  assert.strictEqual(m.pic.base[1], 0x28);
  assert.strictEqual(m.portIn(0xA1, 8), 0x0F);
  m.portOut(0x20, 0x20, 8);                               // EOI changes nothing
  assert.strictEqual(m.portIn(0x21, 8), 0xFA);
  console.log('  8259: masks read back, init sequences are not masks');
}

// --- an SB16 answers for its wiring ------------------------------------------
function testSb16Mixer() {
  const m = machine();
  dsp(m, 0xE1);
  assert.deepStrictEqual([m.portIn(0x22A, 8), m.portIn(0x22A, 8)], [4, 5], 'DSP version');
  const mixer = (i) => { m.portOut(0x224, i, 8); return m.portIn(0x225, 8); };
  assert.strictEqual(mixer(0x80), 0x04, 'IRQ 7');
  assert.strictEqual(mixer(0x81), 0x22, 'DMA 1 and 5');
  m.portOut(0x224, 0x22, 8); m.portOut(0x225, 0xEE, 8);
  assert.strictEqual(mixer(0x22), 0xEE, 'master volume did not read back');
  assert.strictEqual(mixer(0x82), 0, 'an interrupt outstanding before any');
  dsp(m, 0xF2);
  assert.strictEqual(m.sbIrq(), 0x0F);
  assert.strictEqual(mixer(0x82), 1, 'the forced IRQ is an 8-bit one');
  m.portIn(0x22E, 8);
  assert.strictEqual(mixer(0x82), 0, 'reading the ack port did not clear it');
  const old = new Machine(new Uint8Array(0), { log: () => {}, dspVersion: [2, 1] });
  old.setMemory(new Uint8Array(1 << 20), null);
  dsp(old, 0xE1);
  assert.deepStrictEqual([old.portIn(0x22A, 8), old.portIn(0x22A, 8)], [2, 1], 'dspVersion option');
  console.log('  sb16: version 4.05, mixer says IRQ7 / DMA 1+5, interrupt status follows the ack');
}

// --- pacing --------------------------------------------------------------------
// A wall clock that moves half a millisecond per look, so a frame's deadline
// is reachable and the paced budget is a known number of dispatches.
async function testPacing() {
  let t = 0;
  global.performance = { now: () => (t += 0.5) };
  const frames = [];
  global.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  global.cancelAnimationFrame = () => {};
  const fakeCanvas = () => ({
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    }),
    focus() {},
  });
  const spin = Uint8Array.from([0xEB, 0xFE]);            // jmp $
  async function runFrames(paced) {
    const run = new LiveRun({
      canvas: fakeCanvas(), exe: 'spin.com', files: { 'spin.com': spin },
      mips: 1, paced, msPerFrame: 8,
    });
    const t0 = t;
    await run.start();
    for (let i = 0; i < 20 && frames.length; i++) { const f = frames.shift(); t += 16; f(); }
    run.stop();
    return { dispatched: run.session.dispatched, wallMs: t - t0, stalls: run.stalls };
  }
  const paced = await runFrames(true);
  const flat = await runFrames(false);
  // 1 MIPS: one dispatch per microsecond of wall time, plus at most a slice.
  const ceiling = paced.wallMs * 1000 + 20000;
  assert.ok(paced.dispatched <= ceiling,
    `paced run did ${paced.dispatched} dispatches in ${paced.wallMs}ms at 1 MIPS (ceiling ${ceiling})`);
  assert.ok(paced.dispatched >= paced.wallMs * 1000 * 0.5,
    `paced run starved: ${paced.dispatched} dispatches in ${paced.wallMs}ms`);
  // Unpaced, the frame's 8ms deadline is the only limit -- sixteen looks at
  // this clock -- so it runs a few times as far.
  assert.ok(flat.dispatched > paced.dispatched * 1.5,
    `unpaced (${flat.dispatched}) is not clearly faster than paced (${paced.dispatched})`);
  console.log(`  pacing: ${paced.dispatched} dispatches in ${paced.wallMs}ms at 1 MIPS, `
    + `${flat.dispatched} unpaced`);
}

// --- the Gravis Ultrasound -----------------------------------------------------
// The GF1 the way a module player drives it: a sample poked into DRAM a byte
// at a time, one voice looping over it, and the card's own timer as the
// player's beat -- DOPE, CYBOMAN2 and CATWALK all do exactly this and
// nothing else (none of them uses DMA).
function testGus() {
  const m = machine();
  const B = m.gus.base;
  assert.strictEqual(B, 0x220, 'factory base without ULTRASND');
  const reg8 = (r, v) => { m.portOut(B + 0x103, r, 8); m.portOut(B + 0x105, v, 8); };
  const reg16 = (r, v) => { m.portOut(B + 0x103, r, 8); m.portOut(B + 0x104, v, 16); };
  const poke = (a, v) => { reg16(0x43, a & 0xFFFF); reg8(0x44, a >> 16); m.portOut(B + 0x107, v, 8); };
  // Reset, IRQ latch (7), DAC and interrupts on, 14 voices (44100Hz).
  reg8(0x4C, 0); reg8(0x4C, 1);
  m.portOut(B + 0x000, 0x40 | 0x08, 8); m.portOut(B + 0x00B, 0x04, 8); m.portOut(B + 0x000, 0x09, 8);
  assert.strictEqual(m.gus.irqLine(), 7, 'IRQ latch');
  reg8(0x0E, 0xC0 | 13);
  reg8(0x4C, 7);
  // A 64-byte sawtooth at DRAM 0x100, read back through the peek port.
  for (let i = 0; i < 64; i++) poke(0x100 + i, (i * 4 - 128) & 0xFF);
  reg16(0x43, 0x110); reg8(0x44, 0);
  assert.strictEqual(m.portIn(B + 0x107, 8), (16 * 4 - 128) & 0xFF, 'DRAM peek');
  // Voice 0: loop 0x100..0x140 at one DRAM byte per output sample, full volume.
  m.portOut(B + 0x102, 0, 8);
  reg16(0x02, 0x100 >> 7); reg16(0x03, (0x100 & 0x7F) << 9);
  reg16(0x04, 0x140 >> 7); reg16(0x05, (0x140 & 0x7F) << 9);
  reg16(0x0A, 0x100 >> 7); reg16(0x0B, (0x100 & 0x7F) << 9);
  reg16(0x01, 1 << 10);
  reg16(0x09, 0xFFF0); reg8(0x0C, 7);
  reg8(0x00, 0x08);
  assert.strictEqual(m.gus.stats.starts, 1, 'the voice did not start');
  const out = collect(m, 44100);
  for (let i = 0; i < 10; i++) m.audioAdvance(0.01, i * 1000, 1000);
  assert.ok(peak(out) > 0.05, `the sawtooth is inaudible (peak ${peak(out)})`);
  // 64 bytes per period at 44100Hz is 689Hz: ~69 periods in 0.1s, two
  // crossings each.
  const c = crossings(out);
  assert.ok(c > 120 && c < 160, `the loop runs at the wrong pitch (${c} crossings)`);
  // The current-position registers move with it.
  m.portOut(B + 0x103, 0x8A, 8);
  const hi = m.portIn(B + 0x104, 16);
  assert.ok(hi === 0x100 >> 7 || hi === 0x140 >> 7, `current address high ${hi}`);
  // Timer 2 at 320us x 4 = 1.28ms, through the AdLib-compatible pair: the
  // interrupt comes on the latched line once the period passes, the status
  // names it, and taking it does not repeat it until the next period.
  reg8(0x47, 256 - 4); reg8(0x45, 0x08);
  m.portOut(B + 0x008, 0x04, 8); m.portOut(B + 0x009, 0x02, 8);
  assert.strictEqual(m.gusIrq(), 0, 'an interrupt before the period passed');
  assert.ok(Math.abs(m.gusPeriod() - 0.00128) < 1e-6, `timer period ${m.gusPeriod()}`);
  m.audioAdvance(0.002, 10000, 1000);
  assert.strictEqual(m.gusIrq(), 0x0F, 'timer 2 did not interrupt on IRQ 7');
  assert.strictEqual(m.portIn(B + 0x006, 8) & 0x08, 0x08, 'IRQ status without timer 2');
  assert.strictEqual(m.portIn(B + 0x008, 8) & 0xA0, 0xA0, 'AdLib status without timer 2');
  assert.strictEqual(m.gusIrq(), 0, 'the same expiry interrupted twice');
  m.audioAdvance(0.002, 11000, 1000);
  assert.strictEqual(m.gusIrq(), 0x0F, 'the timer did not keep running');
  // At 0x240 from the environment, with the card's own registers in place.
  const at240 = new Machine(new Uint8Array(0), { log: () => {}, env: ['ULTRASND=240,1,1,11,7'] });
  at240.setMemory(new Uint8Array(1 << 20), null);
  assert.strictEqual(at240.gus.base, 0x240, 'ULTRASND= base');
  at240.portOut(0x343, 0x4C, 8); at240.portOut(0x345, 1, 8);
  assert.strictEqual(at240.gus.reset & 1, 1, 'register write at 0x345 did not land');
  at240.portOut(0x223, 0x4C, 8); at240.portOut(0x225, 0, 8);
  assert.strictEqual(at240.gus.reset & 1, 1, 'a write to 0x225 reached the card at 0x240');
  console.log('  gus: DRAM pokes read back, a looping voice renders at pitch, timer 2 interrupts on the latch');
}

async function main() {
  testSb8();
  testSb16();
  testProbeWithoutDma();
  testSpeaker();
  testOpl();
  testOplTimerRendered();
  testShortBlockWaitsForDma();
  testPic();
  testSb16Mixer();
  testGus();
  await testPacing();
  console.log('PASS test-toyvm-audio');
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
