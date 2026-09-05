'use strict';

// What port 3DAh answers, and how fast the frame it describes goes round.
//
// Two separate claims, and they fail in different ways, so this checks both.
//
// 1. THE SHAPE. Bit 3 (vertical retrace) is a function of where the dispatch
//    clock sits in the frame -- high for a fraction of the period near its
//    start, low for the rest -- and bit 0 (display disabled) is that plus a
//    horizontal blanking window on every scanline. It is PURE: reading twice
//    at the same phase gives the same byte twice. The model this replaced
//    flipped bit 3 on every read, and under that model a program's guest time
//    per frame was a function of how many times it polled -- two reads and the
//    frame was over -- so the whole clock was whatever the guest's poll loop
//    happened to look like.
//
// 2. THE RATE. The period is a REAL-TIME interval, so it has to be quoted
//    against the same clock guestSeconds() is: dispatchesPerTick, and nothing
//    else. It used to be quoted against tickUnit(), which is dispatchesPerTick
//    only under --pit-clock and irqEvery (100e3) otherwise. On the DEFAULT
//    two-clock path that made a "70Hz" frame 26,000 dispatches while a guest
//    second stayed 10.0M of them, so the card ran at 385Hz and every
//    retrace-paced demo played 5.5x too fast: ACME-SUX.EXE ran its entire show
//    and exited in 7.4M dispatches (0.74 guest seconds) where a real VGA takes
//    ~4 seconds. Both clock modes are checked, because the bug lived in the
//    difference between them and an assertion on --pit-clock alone would have
//    passed throughout.
//
// The guest half also stands as the deadlock check the shape half cannot make:
// it waits for the bit to fall and then for it to rise, 182 times. If either
// edge were unreachable within a frame -- a retrace window rounded away to
// nothing, a bit stuck either way -- the program would never reach its exit
// and the test would fail on a run that ran out of budget rather than on a
// number.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeVm } = require('../tools/toyvm/vm');
const { runDos } = require('../tools/toyvm/run-dos');
const { PSP_SEG } = require('../tools/toyvm/dos');

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

// --- 1. the shape, straight off the exports ---------------------------------
// A 70Hz frame at the default 550k-dispatch tick: 550000 * 18.2065 / 70.
const PERIOD = 143051;
const LINES = 449;

async function shape() {
  const vm = await makeVm('tailcall');
  const ex = vm.exports;
  ex.set_vga_period(PERIOD, LINES);
  check(ex.get_vga_period() === PERIOD, `period is what was set (${ex.get_vga_period()})`);

  const at = (phase) => { ex.set_vga_phase0(phase); return ex.vga_status(); };

  // PURE. The regression this file exists for: ten reads at one phase, one
  // answer. Sampled at three phases so a bit that alternates cannot hide by
  // being read an even number of times at one of them.
  let pure = true;
  for (const phase of [0, PERIOD >> 2, PERIOD - 1]) {
    const first = at(phase);
    for (let i = 0; i < 10; i++) if (ex.vga_status() !== first) pure = false;
  }
  check(pure, 'bit 3 does not flip on every read (10 reads at one phase agree)');

  // The vertical window: one contiguous run, a small fraction of the frame.
  // Real VGA blanks ~45 of 449 lines, so the model's 9% is the target and the
  // band is wide enough to survive a re-tuning that stays honest.
  const STEP = 101;
  let high = 0, total = 0, runs = 0, prev = false;
  for (let p = 0; p < PERIOD; p += STEP) {
    const bit = (at(p) & 8) !== 0;
    total++;
    if (bit) high++;
    if (bit && !prev) runs++;
    prev = bit;
  }
  const frac = high / total;
  check(frac > 0.04 && frac < 0.12,
    `retrace is a fraction of the frame: bit 3 high in ${(frac * 100).toFixed(1)}% of samples`);
  check(runs === 1, `one retrace window per frame, not ${runs}`);
  check((at(0) & 8) !== 0 && (at(PERIOD >> 1) & 8) === 0,
    'the window is at the start of the frame and the middle is display time');

  // The horizontal window, sampled inside two visible scanlines at full
  // resolution. Bit 0 is "display disabled", so it is set through blanking.
  const line = Math.floor(PERIOD / LINES);
  const start = Math.floor(PERIOD / 2);
  let h0 = 0, hruns = 0;
  prev = false;
  for (let i = 0; i < line * 2; i++) {
    const bit = (at(start + i) & 1) !== 0;
    if (bit) h0++;
    if (bit && !prev) hruns++;
    prev = bit;
  }
  check(hruns === 2, `two horizontal blanking windows in two scanlines, not ${hruns}`);
  check(h0 / (line * 2) > 0.1 && h0 / (line * 2) < 0.35,
    `hblank is a fifth of the line (${(h0 / (line * 2) * 100).toFixed(1)}%)`);
}

// --- 2. the rate, as a guest program sees it --------------------------------
// A .COM that waits for 182 vertical retraces and reports how many BIOS ticks
// (0040:006C, 18.2065Hz) went past while it did. 182 frames of a 70Hz card is
// 2.60 seconds, which is 47.3 ticks; the same 182 frames on the old default
// path took 0.47 seconds and 8 ticks, so the two are not near each other.
//
// Hand-assembled -- a .COM loads at PSP:0100 with DS = ES = CS = the PSP, and
// the waits are the canonical `in al,dx / test al,8 / jcc $-4` spelling that
// the port-poll superop in emit.js folds, so this exercises the folded path
// and not some shape only this test writes.
const FRAMES = 182;

function retraceCom() {
  return Uint8Array.from([
    0xB8, 0x40, 0x00,               // 0100  mov ax,0x40        (BIOS data area)
    0x8E, 0xC0,                     // 0103  mov es,ax
    0xBA, 0xDA, 0x03,               // 0105  mov dx,0x3DA
    // Align on a rising edge, so every counted frame below is a whole one.
    0xEC,                           // 0108  w0:  in al,dx
    0xA8, 0x08,                     // 0109  test al,8
    0x75, 0xFB,                     // 010B  jnz w0             (wait out a retrace)
    0xEC,                           // 010D  w0b: in al,dx
    0xA8, 0x08,                     // 010E  test al,8
    0x74, 0xFB,                     // 0110  jz w0b             (wait for the next one)
    0x26, 0x8B, 0x36, 0x6C, 0x00,   // 0112  mov si,es:[0x6C]   (tick count, low word)
    0xB9, FRAMES & 0xFF, FRAMES >> 8, // 0117 mov cx,FRAMES
    0xEC,                           // 011A  w1:  in al,dx
    0xA8, 0x08,                     // 011B  test al,8
    0x75, 0xFB,                     // 011D  jnz w1             (wait for retrace to end)
    0xEC,                           // 011F  w2:  in al,dx
    0xA8, 0x08,                     // 0120  test al,8
    0x74, 0xFB,                     // 0122  jz w2              (wait for it to start)
    0xE2, 0xF4,                     // 0124  loop w1
    0x26, 0x8B, 0x1E, 0x6C, 0x00,   // 0126  mov bx,es:[0x6C]
    0x29, 0xF3,                     // 012B  sub bx,si
    0x89, 0x1E, 0x00, 0x02,         // 012D  mov [0x0200],bx    (the answer)
    0xB8, 0x00, 0x4C,               // 0131  mov ax,0x4C00
    0xCD, 0x21,                     // 0134  int 21h
  ]);
}

// 182 frames of 143051 dispatches is 26.0M; the budget is well past that so a
// run that does NOT finish is a real failure and not a short budget.
const BUDGET = 80e6;
const EXPECT = FRAMES / 70 * (1193182 / 65536);   // 47.3 ticks

async function rate(com) {
  for (const pitClock of [false, true]) {
    const name = pitClock ? '--pit-clock' : 'default two-clock';
    const r = await runDos({
      exe: com, budget: BUDGET, log: () => {}, pitClock, stuckLimit: 0,
    });
    const at = (PSP_SEG << 4) + 0x200;
    const ticks = r.vm.mem[at] | (r.vm.mem[at + 1] << 8);
    check(r.machine.exited === true && r.machine.exitCode === 0,
      `${name}: the poll loop reaches both edges ${FRAMES} times and exits`
      + ` (exited=${r.machine.exited} code=${r.machine.exitCode},`
      + ` ${(r.dispatched / 1e6).toFixed(1)}M dispatches)`);
    check(ticks >= EXPECT * 0.88 && ticks <= EXPECT * 1.12,
      `${name}: ${FRAMES} retraces take ${ticks} BIOS ticks, want ~${EXPECT.toFixed(0)}`);
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-retrace-'));
  const com = path.join(dir, 'RETRACE.COM');
  fs.writeFileSync(com, retraceCom());
  await shape();
  await rate(com);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail.length ? `\n${fail.length} FAILED` : '\nall retrace checks passed');
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
