'use strict';

// A remembered operand-repair plan must not survive the arena it points into.
//
// dos-loop.js keeps a per-site plan for code that patches its own immediates
// (CodeCache.rememberPlan): the plan holds the compiled programs and the WORD
// INDEX inside each, and a later break on the same site writes the new operand
// straight into `arena[(prog.arenaBase >> 2) + q]`, guarded only by
// `prog.live`. Recycling the arena used to clear every map that could reach a
// program without ever marking one dead -- so the plan still held live-looking
// programs whose arena words now belonged to whatever had been compiled over
// them, and the next repair wrote a guest operand into the middle of somebody
// else's compiled block.
//
// COUNTDWN.EXE (1995, Realtech) is the program that found it: its blitter
// keeps two loop counters inside its own instruction stream, so the plan for
// that one site fires ~99,000 times in a run, and after the fifth recycle one
// of those writes landed in a live block elsewhere. The run handed back at
// 860:273 -- the patched immediate itself, taken as a guest address -- and
// wandered the interrupt vector table until the stuck detector stopped it. The
// same write landing on a handler-index word instead of an address word is the
// same bug arriving as a wasm `unreachable`.
//
// This is that shape in 450 bytes: a loop that patches an imm16, a churn loop
// that forces enough drop-and-recompile to recycle the arena several times,
// and then the SAME patch loop again. The sum it prints is only right if the
// second run of the patch loop reached the arena words the guest is actually
// executing.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ITER_A = 200;     // patches per phase; two phases share one site
// Enough drop-and-recompile to pass the arena's recycle threshold several
// times over: each iteration re-traces ~110 words, and the arena recycles
// with 256KB of its 1MB left, so ~1800 of these is one recycle.
const ITER_C = 12000;
const NOPS = 100;       // the churn body, sized to stay inside a `loop` rel8

// Print BX as four hex digits and exit. Position-independent (rel8 only).
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

function program() {
  const ORG = 0x100;
  const b = [];
  const w = (...x) => b.push(...x);
  const here = () => ORG + b.length;
  // Forward references: emit a zero word and remember where to write the
  // address (or the rel16) once the label is known.
  const fix = [];
  const abs16 = (label) => { fix.push({ at: b.length, label }); w(0, 0); };
  const L = {};
  // Called through BP, not `call rel16`, so the tracer cannot follow the edge
  // and fold all three routines into ONE compiled program. It matters: the
  // churn's stores drop every program covering them, and a merged program
  // covers the patch site too -- dropping it clears `live`, the plan is
  // discarded on the way in, and the second pass silently repairs from a
  // fresh walk instead of exercising the case at all.
  const call = (label) => { w(0xBD); abs16(label); w(0xFF, 0xD5); };

  w(0x31, 0xDB);                          // xor bx,bx
  w(0xB9, ITER_A & 0xFF, ITER_A >> 8);    // mov cx,ITER_A
  call('patch');
  w(0xB9, ITER_C & 0xFF, ITER_C >> 8);    // mov cx,ITER_C
  call('churn');
  w(0xB9, ITER_A & 0xFF, ITER_A >> 8);    // mov cx,ITER_A
  call('patch');                          // the SAME site again
  tail(w);

  // The patch loop. `add bx,imm16` with the immediate written from CX two
  // instructions earlier, which is the repair machinery's whole subject.
  L.patch = here();
  w(0x89, 0xC8);                          // mov ax,cx
  w(0x2E, 0xA3); abs16('pimm');           // mov cs:[pimm],ax
  w(0x90);                                // nop
  w(0x81, 0xC3); L.pimm = here(); w(0, 0); // add bx,imm16
  w(0xE2, (L.patch - (here() + 2)) & 0xFF); // loop patch
  w(0xC3);                                // ret

  // The churn loop. It toggles one byte of its own body between `nop` (90)
  // and `clc` (F8): a changed OPCODE, which repairOperands declines, so every
  // iteration drops the compiled program and re-traces it. A plain store, not
  // a CS-override one, so the decoder does not cut the block at it -- the
  // break comes from the code bit, which is the ordinary path.
  L.churn = here();
  for (let i = 0; i < NOPS; i++) w(0x90);
  w(0xA0); abs16('tog');                  // mov al,[tog]
  w(0x34, 0x68);                          // xor al,90h^F8h
  w(0xA2); abs16('tog');                  // mov [tog],al
  L.tog = here(); w(0x90);                // the toggled byte
  w(0xE2, (L.churn - (here() + 2)) & 0xFF); // loop churn
  w(0xC3);                                // ret

  for (const f of fix) {
    const v = L[f.label];
    assert.ok(v !== undefined, `no label ${f.label}`);
    b[f.at] = v & 0xFF;
    b[f.at + 1] = (v >> 8) & 0xFF;
  }
  return Buffer.from(b);
}

const hex4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const expected = hex4(2 * (ITER_A * (ITER_A + 1) / 2));

const screen = (log) => (log.match(/^  \|(.*)$/gm) || []).map((s) => s.slice(3).trim()).join('');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-arena-recycle-'));
const com = path.join(dir, 'RECYCLE.COM');
fs.writeFileSync(com, program());

// --no-volatile because the churn site would otherwise be promoted after
// eight breaks and compiled into the scratch arena, which never advances the
// bump pointer and so never recycles -- the whole point of the case.
const log = execFileSync(process.execPath, [
  path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js'), com,
  '--dispatches=40m', '--no-volatile', '--text', '--report',
], { encoding: 'utf8', timeout: 240000, maxBuffer: 1 << 24 });

const m = /traces \((\d+)KB of arena, (\d+) recycles/.exec(log);
assert.ok(m, `no arena line in:\n${log}`);
const recycles = +m[2];
assert.ok(recycles >= 1,
  `the arena never recycled (${recycles}), so this case covers nothing:\n${log}`);
const r = /(\d+) self-modify breaks, (\d+) break\(s\) repaired in place \((\d+) by a remembered plan\)/.exec(log);
assert.ok(r, `no repair count in:\n${log}`);
assert.ok(+r[3] >= ITER_A,
  `expected the patch site to be repaired from a remembered plan, got ${r[3]}:\n${log}`);
assert.ok(/exited=true/.test(log), `did not exit:\n${log}`);
assert.strictEqual(screen(log), expected,
  `the second pass over the patched site added the wrong operands:\n${log}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS test-toyvm-arena-recycle: ${screen(log)} after ${recycles} recycle(s), `
  + `${r[3]}/${r[2]} repairs from a remembered plan of ${r[1]} breaks`);
