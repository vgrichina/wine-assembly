'use strict';

// INT 21h AH=4Ch through a terminate vector gives the parent its context back.
//
// A protector that runs pieces of itself does not use AH=4Bh. It asks for a
// block, calls AH=55h to build a child PSP in it, pokes its own address into
// that PSP at +0Ah, loads SS:SP with the child's stack and far-jumps in --
// STHINTRO.EXE (blsthtro, 1995) is exactly this, and so, in the same shape, is
// every other subfile loader in the corpus. When the child calls AH=4Ch, the
// loader's own SS:SP and DS exist nowhere but in DOS: its INT 21h prologue
// pushed AX BX CX DX SI DI BP DS ES on the caller's stack and recorded SS:SP at
// PSP+2Eh, and the exit path restores all of it before jumping through INT 22h.
//
// Without that, STHINTRO's terminate handler -- `xor ax,ax / ret`, a NEAR ret
// meant to return from the loader's own `call spawn` -- popped the dead child's
// stack and landed at 0000:0000; with SS:SP back but not DS, it ran
// `dec word [0113]` against the child's data segment and took the wrong branch.
//
// This is that sequence as a .COM, with nothing else in it. `spawn` allocates a
// paragraph block, makes a child PSP in it with SI carrying a marker, points
// the terminate vector at a `xor ax,ax / ret`, switches SS:SP and DS to the
// child's segment and jumps to a stub whose only instruction is AH=4Ch. The
// three characters it prints are the three things DOS owes the parent:
//
//   SI  the saved register file came back  (SI is still the 1234h it passed)
//   DS  the saved data segment came back   (DS is the .COM's own segment)
//   SS  the saved stack came back          (SS is the .COM's own segment)
//
// ...and the fact that it prints at all is the fourth: the near `ret` in the
// terminate handler found the return address of `call spawn`, which is only on
// the stack if SP came back too.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ORG = 0x100;
const MARKER = 0x1234;       // what SI carries into AH=55h and must carry back
const CHILD_SP = 0x01F0;     // inside the 20h-paragraph block, above its PSP

function program() {
  const b = [];
  const w = (...x) => b.push(...x);
  const at = () => ORG + b.length;
  const patch = [];
  // A rel16 call whose target is filled in once its label is known.
  const call = (label) => { w(0xE8, 0, 0); patch.push({ off: b.length - 2, label, at: at() }); };
  const jmp = (label) => { w(0xE9, 0, 0); patch.push({ off: b.length - 2, label, at: at() }); };
  const label = {};

  // --- entry: run the child, then report what came back ---------------------
  call('spawn');
  label.resume = at();

  // SI first, before anything here clobbers it.
  w(0x81, 0xFE, MARKER & 0xFF, MARKER >> 8);   // cmp si,MARKER
  w(0xB2, 0x6E);                               // mov dl,'n'
  w(0x75, 0x02);                               // jne +2
  w(0xB2, 0x53);                               // mov dl,'S'
  call('putc');

  w(0x8C, 0xC8);                               // mov ax,cs
  w(0x8C, 0xDB);                               // mov bx,ds
  w(0xB2, 0x6E);                               // mov dl,'n'
  w(0x39, 0xD8);                               // cmp ax,bx
  w(0x75, 0x02);                               // jne +2
  w(0xB2, 0x44);                               // mov dl,'D'
  call('putc');

  w(0x8C, 0xC8);                               // mov ax,cs
  w(0x8C, 0xD3);                               // mov bx,ss
  w(0xB2, 0x6E);                               // mov dl,'n'
  w(0x39, 0xD8);                               // cmp ax,bx
  w(0x75, 0x02);                               // jne +2
  w(0xB2, 0x54);                               // mov dl,'T'
  call('putc');

  w(0xB8, 0x00, 0x4C);                         // mov ax,4C00h
  w(0xCD, 0x21);                               // int 21h

  // --- putc: DL to stdout ---------------------------------------------------
  label.putc = at();
  w(0xB4, 0x02);                               // mov ah,2
  w(0xCD, 0x21);                               // int 21h
  w(0xC3);                                     // ret

  // --- the terminate vector -------------------------------------------------
  // A near ret, and nothing else: everything it needs is what DOS restores.
  label.handler = at();
  w(0x31, 0xC0);                               // xor ax,ax
  w(0xC3);                                     // ret

  // --- out of memory --------------------------------------------------------
  // A .COM owns every paragraph to the top of the arena, so AH=48h fails until
  // AH=4Ah has given some back. This is here so that failing prints a letter
  // instead of building a PSP at segment 8 and running the BIOS.
  label.oom = at();
  w(0xB2, 0x21);                               // mov dl,'!'
  call('putc');
  w(0xB8, 0x00, 0x4C);                         // mov ax,4C00h
  w(0xCD, 0x21);                               // int 21h

  // --- the child ------------------------------------------------------------
  label.child = at();
  w(0xB8, 0x00, 0x4C);                         // mov ax,4C00h
  w(0xCD, 0x21);                               // int 21h

  // --- spawn ----------------------------------------------------------------
  // The AH=55h call is the anchor: the stack it runs on is the one DOS hands
  // back, and `call spawn`'s return address is sitting on top of it. Nothing
  // below may be pushed before that call, which is why the block allocation
  // comes first and the segment stays in DX rather than in memory.
  label.spawn = at();
  w(0xB4, 0x4A);                               // mov ah,4Ah     (ES = PSP)
  w(0xBB, 0x00, 0x10);                         // mov bx,1000h
  w(0xCD, 0x21);                               // int 21h        shrink to 64KB
  w(0xB4, 0x48);                               // mov ah,48h
  w(0xBB, 0x20, 0x00);                         // mov bx,20h
  w(0xCD, 0x21);                               // int 21h        -> ax = segment
  w(0x73, 0x03);                               // jnc +3
  jmp('oom');
  w(0x89, 0xC2);                               // mov dx,ax
  w(0xBE, MARKER & 0xFF, MARKER >> 8);         // mov si,MARKER
  w(0xB4, 0x55);                               // mov ah,55h
  w(0xCD, 0x21);                               // int 21h        <- the anchor
  w(0x8E, 0xC2);                               // mov es,dx
  w(0xB8, 0, 0); patch.push({ off: b.length - 2, label: 'handler', abs: true });
  w(0x26, 0xA3, 0x0A, 0x00);                   // mov es:[000A],ax
  w(0x26, 0x8C, 0x0E, 0x0C, 0x00);             // mov es:[000C],cs
  w(0xFA);                                     // cli
  w(0x8E, 0xD2);                               // mov ss,dx
  w(0xBC, CHILD_SP & 0xFF, CHILD_SP >> 8);     // mov sp,CHILD_SP
  w(0xFB);                                     // sti
  w(0x8E, 0xDA);                               // mov ds,dx
  jmp('child');

  for (const p of patch) {
    const v = p.abs ? label[p.label] : (label[p.label] - p.at) & 0xFFFF;
    b[p.off] = v & 0xFF; b[p.off + 1] = (v >> 8) & 0xFF;
  }
  return Buffer.from(b);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-dos-terminate-'));
const com = path.join(dir, 'TERM.COM');
fs.writeFileSync(com, program());

const log = execFileSync(process.execPath, [
  path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js'),
  com, '--dispatches=2000000', '--text',
], { encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 24 });

const screen = (log.match(/^  \|(.*)$/gm) || []).map((s) => s.slice(3).trim()).join('');
assert.ok(/exited=true/.test(log), `the program never exited:\n${log}`);
assert.ok(!/stuck at/.test(log), `the terminate vector derailed the run:\n${log}`);
assert.strictEqual(screen, 'SDT',
  `SI/DS/SS did not all come back through INT 22h (got "${screen}"):\n${log}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS test-toyvm-dos-terminate: AH=4Ch through PSP+0Ah restored SI, DS and SS:SP (${screen})`);
