#!/usr/bin/env node
// Regression: canvas keydown must deliver text-producing keys directly to
// the guest. Real browsers no longer reliably fire keypress/beforeinput for
// a focused canvas, so relying on a later event drops typing in Notepad.
//
// Bug history:
//   6087d88  Added blanket e.preventDefault() on keydown unless reserved
//            for the browser. Broke typing in Notepad / Find dialog /
//            every other edit.
//   b98431a  Carved out printable keys (no Ctrl/Alt/Meta, VK in typing
//            range) so keypress still fires.
//
// We can't run a real browser here, so this test extracts the keyboard
// predicate/helpers from index.html
// by string-matching the source, evals them, and asserts:
//   - 'A'..'Z', '0'..'9', space, common punctuation -> direct WM_CHAR
//     path and preventDefault on keydown
//   - Tab, Enter, Esc, F1..F12, arrows, Ctrl+S, Alt+F, etc. -> handled
//     (preventDefault'd unless explicitly browser-reserved like F5/F11)
//   - Browser-reserved (Ctrl+R, Ctrl+W, F5, F11, F12, Cmd+anything,
//     Ctrl+Shift+I) -> NOT preventDefault'd (browser keeps them)

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');

function extract(name) {
  const re = new RegExp(`const ${name} = \\(e\\) => \\{([\\s\\S]*?)^\\s{6}\\};`, 'm');
  const m = html.match(re);
  if (!m) throw new Error(`could not extract ${name} from index.html`);
  return new Function('e', m[1]);
}

const keepForBrowser = extract('keepForBrowser');
const isPrintableKey = extract('isPrintableKey');
const charCodeFromKeyEvent = extract('charCodeFromKeyEvent');

// Mirror the keydown handler decision after direct text dispatch.
function wouldPreventDefault(e) {
  if (keepForBrowser(e)) return false;
  if (charCodeFromKeyEvent(e)) return true;
  return !isPrintableKey(e);
}

function ev(keyCode, mods = {}) {
  return { keyCode, key: mods.key || '', ctrlKey: !!mods.ctrl, altKey: !!mods.alt,
           shiftKey: !!mods.shift, metaKey: !!mods.meta };
}

const checks = [];
function check(label, cond) { checks.push({ label, ok: !!cond }); }

// --- Printable typing keys: direct char path + preventDefault ---
for (let vk = 0x30; vk <= 0x39; vk++) // 0..9
  check(`digit VK 0x${vk.toString(16)} direct char`, wouldPreventDefault(ev(vk, { key: String.fromCharCode(vk) })));
for (let vk = 0x41; vk <= 0x5A; vk++) // A..Z
  check(`letter VK 0x${vk.toString(16)} direct char`, wouldPreventDefault(ev(vk, { key: String.fromCharCode(vk + 32) })));
check('space direct char',             wouldPreventDefault(ev(32, { key: ' ' })));
check('semicolon direct char',         wouldPreventDefault(ev(0xBA, { key: ';' })));
check('equals direct char',            wouldPreventDefault(ev(0xBB, { key: '=' })));
check('comma direct char',             wouldPreventDefault(ev(0xBC, { key: ',' })));
check('period direct char',            wouldPreventDefault(ev(0xBE, { key: '.' })));
check('slash direct char',             wouldPreventDefault(ev(0xBF, { key: '/' })));
check('backtick direct char',          wouldPreventDefault(ev(0xC0, { key: '`' })));
check('bracket direct char',           wouldPreventDefault(ev(0xDB, { key: '[' })));
check('quote direct char',             wouldPreventDefault(ev(0xDE, { key: "'" })));
check('shift+A direct char',           wouldPreventDefault(ev(0x41, { shift: true, key: 'A' })));
check('Enter direct char',             charCodeFromKeyEvent(ev(13, { key: 'Enter' })) === 13);

// --- Non-printable / chrome keys: claimed by guest (preventDefault) ---
check('Tab (9) prevented',         wouldPreventDefault(ev(9)));
check('Enter (13) prevented',      wouldPreventDefault(ev(13, { key: 'Enter' })));
check('Esc (27) prevented',        wouldPreventDefault(ev(27)));
check('Backspace (8) prevented',   wouldPreventDefault(ev(8)));
check('Arrow Left (37) prevented', wouldPreventDefault(ev(37)));
check('F1 (112) prevented',        wouldPreventDefault(ev(112)));
check('F10 (121) prevented',       wouldPreventDefault(ev(121)));
check('Ctrl+S prevented',          wouldPreventDefault(ev(0x53, { ctrl: true })));
check('Ctrl+F prevented',          wouldPreventDefault(ev(0x46, { ctrl: true })));
check('Ctrl+A prevented',          wouldPreventDefault(ev(0x41, { ctrl: true })));
check('Alt+F prevented',           wouldPreventDefault(ev(0x46, { alt: true })));

// --- Browser-reserved: must NOT preventDefault (let browser handle) ---
check('F5 not prevented',          !wouldPreventDefault(ev(116)));
check('F11 not prevented',         !wouldPreventDefault(ev(122)));
check('F12 not prevented',         !wouldPreventDefault(ev(123)));
check('Ctrl+R not prevented',      !wouldPreventDefault(ev(82, { ctrl: true })));
check('Ctrl+W not prevented',      !wouldPreventDefault(ev(87, { ctrl: true })));
check('Ctrl+T not prevented',      !wouldPreventDefault(ev(84, { ctrl: true })));
check('Ctrl+Shift+I not prevented',!wouldPreventDefault(ev(73, { ctrl: true, shift: true })));
check('Cmd+A not prevented',       !wouldPreventDefault(ev(0x41, { meta: true })));
check('Alt+F4 not prevented',      !wouldPreventDefault(ev(115, { alt: true })));

// --- End-to-end: typing flows through to Notepad's edit ---
//   Drives the CLI path that mirrors the browser flow.
const { execSync } = require('child_process');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');
let cliOk = false;
if (fs.existsSync(EXE)) {
  try {
    const out = execSync(
      `node "${RUN}" --exe="${EXE}" --input=100:keypress:72,110:keypress:73 --max-batches=200`,
      { encoding: 'utf-8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    // run.js prints `[input] keypress code=NN` once per dispatch, and the
    // edit accepts it if there is no UNIMPLEMENTED crash.
    cliOk = out.includes('keypress code=72') && out.includes('keypress code=73')
            && !out.includes('UNIMPLEMENTED') && !out.includes('CRASH');
  } catch (e) { /* keep cliOk=false */ }
  check('CLI keypress flow into Notepad edit succeeds', cliOk);
}

let pass = 0, fail = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`);
  c.ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
