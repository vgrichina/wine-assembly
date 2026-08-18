#!/usr/bin/env node
// Typing past the bottom of a multiline edit must scroll, and arrowing back up
// must scroll the other way.
//
// This is the bug this test was written for: EM_SCROLLCARET was a no-op stub
// and nothing else moved the viewport, so once the caret passed the last
// visible line, notepad went on accepting characters into text nobody could
// see -- the window kept showing line 1 while you typed line 26. USER does
// this after every operation that moves the caret; so do we now.
//
// The assertions read the control's own state through EM_GETFIRSTVISIBLELINE
// (run.js reports it as firstVisible in dump-focus-state), so this is about
// where the viewport is, not about which pixels landed.
//
//   node test/test-notepad-typing-scroll.js

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOTEPAD = path.join(ROOT, 'test', 'binaries', 'notepad.exe');
const RUN_JS = path.join(ROOT, 'test', 'run.js');

const LINES = 26;             // comfortably more than the ~14 rows that fit
const FIRST_BATCH = 60;

// The viewport is (height - chrome) / 16 rows; the test does not care about
// the exact number, only that the caret ends up inside it.
const MAX_VIEWPORT_LINES = 20;

function build() {
  const ev = [];
  let b = FIRST_BATCH;
  for (let i = 1; i <= LINES; i++) {
    ev.push(`${b}:keypress:${65 + (i % 26)}`);   // a letter
    ev.push(`${b + 1}:keypress:13`);             // and a newline
    b += 2;
  }
  ev.push(`${b + 2}:dump-focus-state:typed`);
  b += 4;
  for (let i = 0; i < LINES; i++) ev.push(`${b++}:keydown:38`);  // VK_UP
  ev.push(`${b + 2}:dump-focus-state:scrolled-back`);
  return { input: ev.join(','), batches: b + 8 };
}

function parse(out, label) {
  const line = out.split('\n').find(l => l.includes(`dump-focus-state ${label}:`));
  if (!line) throw new Error(`no dump-focus-state for "${label}" — did the input schedule change?`);
  const num = key => {
    const m = line.match(new RegExp(`${key}=(-?\\d+)`));
    return m ? Number(m[1]) : null;
  };
  return { firstVisible: num('firstVisible'), lineCount: num('lineCount'), raw: line };
}

function main() {
  const { input, batches } = build();
  const out = execFileSync('node', [
    RUN_JS, '--exe=' + NOTEPAD, '--max-batches=' + batches, '--quiet-api',
    '--input=' + input,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

  const typed = parse(out, 'typed');
  const back = parse(out, 'scrolled-back');
  const failures = [];

  if (!(typed.lineCount > MAX_VIEWPORT_LINES)) {
    failures.push(`only ${typed.lineCount} lines were typed — the test needs more than ` +
      `${MAX_VIEWPORT_LINES} to push the caret off-screen`);
  }
  if (!(typed.firstVisible > 0)) {
    failures.push(`typing ${LINES} lines left the view at line ${typed.firstVisible} — ` +
      `the caret is off-screen and the text is invisible`);
  }
  const caretLine = typed.lineCount - 1;
  if (caretLine - typed.firstVisible >= MAX_VIEWPORT_LINES) {
    failures.push(`caret is on line ${caretLine} but the view starts at ` +
      `${typed.firstVisible} — more than a viewport away`);
  }
  if (typed.firstVisible > caretLine) {
    failures.push(`view scrolled past the caret: first visible ${typed.firstVisible}, ` +
      `caret on ${caretLine}`);
  }
  if (back.firstVisible !== 0) {
    failures.push(`arrowing back to the top left the view at line ${back.firstVisible}`);
  }

  console.log(`typed ${LINES} lines   lineCount=${typed.lineCount} firstVisible=${typed.firstVisible} ` +
    `(caret on line ${caretLine})`);
  console.log(`arrowed back up   firstVisible=${back.firstVisible}`);

  if (failures.length) {
    for (const f of failures) console.log(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log('PASS  the caret stays inside the viewport in both directions');
}

main();
