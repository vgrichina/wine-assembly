'use strict';

// Self-modifying code switches the JIT off where it happens, not everywhere.
//
// A program that rewrites one of its own immediates every iteration used to
// cost a self-modify break, a dropped region and a fresh trace per iteration,
// and on CYCLE.EXE's mixer (which does this per timer interrupt) that was
// 28MB of arena and 37 recycles in a minute. dos-loop.js now counts the
// stores per paragraph, promotes the ones written VOLATILE_AFTER times to
// "volatile", and runs code in them from a scratch compile with no code bits
// -- the store then hits nothing compiled and there is no break to take.
//
// This checks, on a synthetic loop, that the mechanism engages (paragraphs
// promoted, no arena recycling), that the program still computes the same
// answer as the --no-volatile arm, and that the answer is the right one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ITER = 3000;

// A .COM: ITER times, patch the imm8 of `add bx,imm8` with the loop counter's
// low byte and run it; then print BX as four hex digits and exit.
function program() {
  const b = [];
  const w = (...x) => b.push(...x);
  w(0xB9, ITER & 0xFF, ITER >> 8);   // 0100 mov cx,ITER
  w(0x31, 0xDB);                     // 0103 xor bx,bx
  w(0x31, 0xC0);                     // 0105 xor ax,ax
  w(0x40);                           // 0107 inc ax
  w(0x2E, 0xA2, 0x10, 0x01);         // 0108 mov cs:[0110],al
  w(0x90, 0x90);                     // 010C nop nop
  w(0x83, 0xC3, 0x00);               // 010E add bx,imm8   (imm at 0110)
  w(0xE2, 0xF4);                     // 0111 loop 0107
  w(0xB9, 0x04, 0x00);               // 0113 mov cx,4
  w(0xC1, 0xC3, 0x04);               // 0116 rol bx,4
  w(0x88, 0xD8);                     // 0119 mov al,bl
  w(0x24, 0x0F);                     // 011B and al,0Fh
  w(0x04, 0x30);                     // 011D add al,'0'
  w(0x3C, 0x39);                     // 011F cmp al,'9'
  w(0x76, 0x02);                     // 0121 jbe 0125
  w(0x04, 0x07);                     // 0123 add al,7
  w(0x88, 0xC2);                     // 0125 mov dl,al
  w(0xB4, 0x02);                     // 0127 mov ah,2
  w(0xCD, 0x21);                     // 0129 int 21h
  w(0xE2, 0xE9);                     // 012B loop 0116
  w(0xB8, 0x00, 0x4C);               // 012D mov ax,4C00h
  w(0xCD, 0x21);                     // 0130 int 21h
  return Buffer.from(b);
}

function expected() {
  let bx = 0;
  for (let i = 1; i <= ITER; i++) bx = (bx + ((i & 0xFF) << 24 >> 24)) & 0xFFFF;   // imm8 is sign-extended
  return bx.toString(16).toUpperCase().padStart(4, '0');
}

function run(com, extra) {
  const args = [path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js'), com, '--dispatches=2000000', '--text', ...extra];
  return execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 24 });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-volatile-'));
const com = path.join(dir, 'SMC.COM');
fs.writeFileSync(com, program());

// The screen the program left: the `--text` page's non-blank rows, joined.
const screen = (log) => (log.match(/^  \|(.*)$/gm) || []).map((s) => s.slice(3).trim()).join('');
const arenaKb = (log) => +(/traces \((\d+)KB of arena, (\d+) recycles/.exec(log) || [0, 0])[1];

const vol = run(com, []);
const base = run(com, ['--no-volatile']);
fs.rmSync(dir, { recursive: true, force: true });

assert.ok(/exited=true/.test(vol), `volatile arm did not exit:\n${vol}`);
assert.ok(/exited=true/.test(base), `--no-volatile arm did not exit:\n${base}`);
assert.strictEqual(screen(vol), expected(), 'volatile arm printed the wrong sum');
assert.strictEqual(screen(base), expected(), '--no-volatile arm printed the wrong sum');

const report = /(\d+) volatile paragraph\(s\): (\d+) uncached compiles, (\d+) without code bits/.exec(vol);
assert.ok(report, `no volatile report line in:\n${vol}`);
assert.ok(+report[1] >= 1, 'no paragraph was promoted');
// The store still cuts the block it sits in, because the byte it patches is
// the next instruction's immediate (see benignPatch: that cut is never
// retired), so both arms hand back once per iteration. What the mechanism
// removes is the retrace: without it every iteration drops the region and
// traces a new copy of the loop into the arena, and the arena grows by ITER
// programs; with it the paragraph is compiled into scratch space that is
// reused, and the arena stays at the size of the code that is not volatile.
assert.ok(arenaKb(base) >= 100, `expected the --no-volatile arm to fill the arena, got ${arenaKb(base)}KB`);
assert.ok(arenaKb(vol) <= 16, `volatile arm still grew the arena: ${arenaKb(vol)}KB`);
assert.ok(+report[3] >= ITER - 50, `expected ~${ITER} scratch compiles without code bits, got ${report[3]}`);
console.log(`PASS test-toyvm-volatile: ${screen(vol)} from both arms; arena ${arenaKb(base)}KB -> ${arenaKb(vol)}KB, `
  + `${report[1]} paragraph(s) promoted, ${report[2]} scratch compiles`);
