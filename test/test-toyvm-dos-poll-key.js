'use strict';

// INT 21h AH=06h with DL=0FFh is a POLL, and must answer "nothing waiting".
//
// It is DOS's non-blocking direct console read: ZF set means no character, and a
// program is free to call it every frame to see whether the user wants out. The
// headless auto-key answerer has two halves and they are not interchangeable --
// autoKeyNext() manufactures a keystroke for a read that would otherwise BLOCK
// forever, and autoKeyPoll() only offers one when the screen has settled, which
// is what INT 16h AH=01h has always used. Answering this call out of the
// blocking half told every polling program that a key was down on every call:
// COCAHOLC.EXE was handed 72,000 keystrokes in an 80M-dispatch run and spent the
// whole demo eating them, and CONTAGIO.EXE burned 276,222 of its 80M dispatches
// in the same loop and never reached the second half of its show (22,510 lit
// pixels against 64,000 once the poll told the truth).
//
// AH=0Bh -- "check standard input status", the DOS twin of INT 16h AH=01h --
// gets the other half of the same fix: it must be allowed to manufacture a key,
// or a program that polls there and reads with AH=08h waits forever.
//
// The program below polls 5000 times on a blank text page (nothing the menu
// reader can answer), then does one BLOCKING read. The poll count must be zero
// and the blocking read must still get a character: those two together are the
// distinction, and either one alone can be passed by a wrong answer.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RUN = path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js');
const POLLS = 5000;

// Print BX as four hex digits through INT 21h AH=02h. Position-independent.
function emitHexBx(w) {
  w(0xB9, 0x04, 0x00);               // mov cx,4
  w(0xC1, 0xC3, 0x04);               // rol bx,4
  w(0x88, 0xD8);                     // mov al,bl
  w(0x24, 0x0F);                     // and al,0Fh
  w(0x04, 0x30);                     // add al,'0'
  w(0x3C, 0x39);                     // cmp al,'9'
  w(0x76, 0x02);                     // jbe +2
  w(0x04, 0x07);                     // add al,7
  w(0x88, 0xC2);                     // mov dl,al
  w(0xB4, 0x02);                     // mov ah,2
  w(0xCD, 0x21);                     // int 21h
  w(0xE2, 0xE9);                     // loop back to the rol
}

function build() {
  const b = [];
  const w = (...x) => b.push(...x);

  w(0x31, 0xDB);                     // xor bx,bx            ; answered polls
  w(0xB9, POLLS & 0xFF, POLLS >> 8); // mov cx,POLLS
  const top = 0x100 + b.length;
  w(0x51);                           // push cx
  w(0xB4, 0x06);                     // mov ah,6
  w(0xB2, 0xFF);                     // mov dl,0FFh
  w(0xCD, 0x21);                     // int 21h
  w(0x74, 0x01);                     // jz  skip             ; ZF: nothing waiting
  w(0x43);                           // inc bx
  w(0x59);                           // skip: pop cx
  const back = (top - (0x100 + b.length + 2)) & 0xFF;
  w(0xE2, back);                     // loop top

  emitHexBx(w);                      // the poll count, four hex digits

  // A space, then what a BLOCKING read gets. Zero here would mean the fix went
  // too far and took the manufactured key away from the call that needs it.
  w(0xB4, 0x02, 0xB2, 0x20, 0xCD, 0x21);   // mov ah,2 / mov dl,' ' / int 21h
  w(0xB4, 0x08);                     // mov ah,8             ; blocking read
  w(0xCD, 0x21);                     // int 21h
  w(0x30, 0xE4);                     // xor ah,ah
  w(0x89, 0xC3);                     // mov bx,ax
  emitHexBx(w);

  w(0xB8, 0x00, 0x4C);               // mov ax,4C00h
  w(0xCD, 0x21);                     // int 21h
  return Buffer.from(b);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-poll-'));
const exe = path.join(dir, 'POLLKEY.COM');
fs.writeFileSync(exe, build());

const out = execFileSync('node', [RUN, exe, '--dispatches=8m', '--auto-key', '--report', '--text'],
  { encoding: 'utf8', timeout: 120000 });

const m = /\|([0-9A-F]{4}) ([0-9A-F]{4})/.exec(out);
assert.ok(m, `no "<polls> <blocking>" line on the text page:\n${out}`);
const answered = parseInt(m[1], 16);
const blocking = parseInt(m[2], 16);

assert.strictEqual(answered, 0,
  `${answered} of ${POLLS} polls of INT 21h AH=06h DL=0FFh were answered; `
  + `a poll on an unanswerable screen must report nothing waiting:\n${out}`);
assert.ok(blocking >= 0x20 && blocking < 0x7F,
  `a BLOCKING INT 21h AH=08h still has to get a key from auto-key, got ${blocking}:\n${out}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS test-toyvm-dos-poll-key: ${answered}/${POLLS} polls answered, `
  + `blocking read got "${String.fromCharCode(blocking)}"`);
