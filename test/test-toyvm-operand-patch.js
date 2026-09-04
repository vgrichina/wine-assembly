'use strict';

// A store into an operand of cached code is repaired in place, not recompiled.
//
// CYBOMAN2's span filler rewrites the imm32 slopes and imm16 counts of its
// inner loop per span, and CYCLE's mixer ISR advances a sample pointer that
// lives in a `mov bl,[bx+disp16]` displacement -- at ~17.7kHz. Each store
// used to be a self-modify break that dropped the program and compiled it
// again (~12us), and the volatile fallback (test-toyvm-volatile.js) only
// trades that for an uncached compile per entry. dos-loop.js now decodes the
// instructions the store touched, checks that they still lower to the words
// the arena holds up to their operand words, and rewrites just those words
// (CodeCache.repairOperands).
//
// Three synthetic loops, each patching one operand kind ITER times: an imm8,
// an imm16 and a ModRM disp16. Every one must print the right sum, keep the
// arena at the size of one program, report ~ITER breaks repaired and never
// promote a paragraph to volatile.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ITER = 3000;

// Shared tail at `at`: print BX as four hex digits, exit. Position-independent
// (rel8 jumps only).
function tail(w) {
  w(0xB9, 0x04, 0x00);               // mov cx,4
  w(0xC1, 0xC3, 0x04);               // +3  rol bx,4
  w(0x88, 0xD8);                     // +6  mov al,bl
  w(0x24, 0x0F);                     // +8  and al,0Fh
  w(0x04, 0x30);                     // +A  add al,'0'
  w(0x3C, 0x39);                     // +C  cmp al,'9'
  w(0x76, 0x02);                     // +E  jbe +12
  w(0x04, 0x07);                     // +10 add al,7
  w(0x88, 0xC2);                     // +12 mov dl,al
  w(0xB4, 0x02);                     // +14 mov ah,2
  w(0xCD, 0x21);                     // +16 int 21h
  w(0xE2, 0xE9);                     // +18 loop +3
  w(0xB8, 0x00, 0x4C);               // +1A mov ax,4C00h
  w(0xCD, 0x21);                     // +1D int 21h
}

const hex4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

const CASES = {
  // imm8 of `add bx,imm8` <- low byte of CX (sign-extended by the add).
  imm8: {
    program() {
      const b = []; const w = (...x) => b.push(...x);
      w(0xB9, ITER & 0xFF, ITER >> 8);   // 0100 mov cx,ITER
      w(0x31, 0xDB);                     // 0103 xor bx,bx
      w(0x88, 0xC8);                     // 0105 mov al,cl
      w(0x2E, 0xA2, 0x0E, 0x01);         // 0107 mov cs:[010E],al
      w(0x90);                           // 010B nop
      w(0x83, 0xC3, 0x00);               // 010C add bx,imm8   (imm at 010E)
      w(0xE2, 0xF4);                     // 010F loop 0105
      tail(w);                           // 0111
      return Buffer.from(b);
    },
    expected() {
      let bx = 0;
      for (let i = 1; i <= ITER; i++) bx = (bx + ((i & 0xFF) << 24 >> 24)) & 0xFFFF;
      return hex4(bx);
    },
  },
  // imm16 of `add bx,imm16` <- CX*3 (a value with both bytes live).
  imm16: {
    program() {
      const b = []; const w = (...x) => b.push(...x);
      w(0xB9, ITER & 0xFF, ITER >> 8);   // 0100 mov cx,ITER
      w(0x31, 0xDB);                     // 0103 xor bx,bx
      w(0x89, 0xC8);                     // 0105 mov ax,cx
      w(0x01, 0xC8);                     // 0107 add ax,cx
      w(0x01, 0xC8);                     // 0109 add ax,cx
      w(0x2E, 0xA3, 0x12, 0x01);         // 010B mov cs:[0112],ax
      w(0x90);                           // 010F nop
      w(0x81, 0xC3, 0x00, 0x00);         // 0110 add bx,imm16  (imm at 0112)
      w(0xE2, 0xEF);                     // 0114 loop 0105
      tail(w);                           // 0116
      return Buffer.from(b);
    },
    expected() {
      let bx = 0;
      for (let i = 1; i <= ITER; i++) bx = (bx + i * 3) & 0xFFFF;
      return hex4(bx);
    },
  },
  // disp16 of `mov al,[si+disp16]` <- 0200h + (CX & FFh), over a table at
  // 0200h holding table[i] = i; the sum lands in BL.
  disp16: {
    program() {
      const b = []; const w = (...x) => b.push(...x);
      w(0xB9, ITER & 0xFF, ITER >> 8);   // 0100 mov cx,ITER
      w(0x31, 0xDB);                     // 0103 xor bx,bx
      w(0x31, 0xF6);                     // 0105 xor si,si
      w(0x89, 0xC8);                     // 0107 mov ax,cx
      w(0x25, 0xFF, 0x00);               // 0109 and ax,00FFh
      w(0x05, 0x00, 0x02);               // 010C add ax,0200h
      w(0x2E, 0xA3, 0x15, 0x01);         // 010F mov cs:[0115],ax
      w(0x8A, 0x84, 0x00, 0x02);         // 0113 mov al,[si+disp16]  (disp at 0115)
      w(0x00, 0xC3);                     // 0117 add bl,al
      w(0xE2, 0xEC);                     // 0119 loop 0107
      tail(w);                           // 011B
      while (b.length < 0x100) b.push(0);
      for (let i = 0; i < 256; i++) b.push(i);   // 0200..02FF: table[i] = i
      return Buffer.from(b);
    },
    expected() {
      let bl = 0;
      for (let i = 1; i <= ITER; i++) bl = (bl + (i & 0xFF)) & 0xFF;
      return hex4(bl);
    },
  },
};

function run(com, extra) {
  const args = [path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js'), com, '--dispatches=2000000', '--text', ...extra];
  return execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 24 });
}

const screen = (log) => (log.match(/^  \|(.*)$/gm) || []).map((s) => s.slice(3).trim()).join('');
const arenaKb = (log) => +(/traces \((\d+)KB of arena, (\d+) recycles/.exec(log) || [0, 0])[1];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-operand-patch-'));
const summary = [];
for (const [name, c] of Object.entries(CASES)) {
  const com = path.join(dir, `${name.toUpperCase()}.COM`);
  fs.writeFileSync(com, c.program());
  const log = run(com, []);
  const flushed = run(com, ['--no-volatile']);
  assert.ok(/exited=true/.test(log), `${name}: did not exit:\n${log}`);
  assert.strictEqual(screen(log), c.expected(), `${name}: printed the wrong sum`);
  assert.strictEqual(screen(flushed), c.expected(), `${name}: --no-volatile arm printed the wrong sum`);
  const m = /(\d+) self-modify breaks, (\d+) break\(s\) repaired in place/.exec(log);
  assert.ok(m, `${name}: no repair count in:\n${log}`);
  assert.ok(+m[2] >= ITER - 5, `${name}: expected ~${ITER} repairs, got ${m[2]} of ${m[1]} breaks`);
  assert.ok(!/volatile paragraph/.test(log), `${name}: a paragraph went volatile:\n${log}`);
  assert.ok(arenaKb(log) <= 8, `${name}: the arena grew to ${arenaKb(log)}KB`);
  summary.push(`${name} ${screen(log)} (${m[2]}/${m[1]} breaks repaired, ${arenaKb(log)}KB)`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS test-toyvm-operand-patch: ${summary.join('; ')}`);
