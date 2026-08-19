#!/usr/bin/env node
// Regression coverage for two differently sized WordPad RichEdit runs across
// Save As -> New -> Open. The first word is 24pt; the second keeps its default
// size. A whole-document query must remain mixed after reopen.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-mixed-format-roundtrip');
const VFS_DIR = path.join(OUT_DIR, 'vfs');
const SAVE_NAME = 'wordpad-mixed-format-roundtrip.rtf';
const savedPath = path.join(VFS_DIR, 'windows', SAVE_NAME);

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(VFS_DIR, { recursive: true });
if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath);

const seq = ['70:click:40:150'];
let batch = 74;
for (const ch of 'small large') seq.push(`${batch++}:keypress:${ch.charCodeAt(0)}`);

// Select "small" and make only that run 24pt.
seq.push('92:keydown:36');
seq.push('93:keyup:36');
seq.push('96:keydown:16');
for (let i = 0; i < 5; i++) {
  seq.push(`${97 + i * 2}:keydown:39`);
  seq.push(`${98 + i * 2}:keyup:39`);
}
seq.push('108:keyup:16');
seq.push('112:set-focus-charformat-size:480:first-before-save');

seq.push('130:0x111:57604'); // File > Save As
seq.push(`180:open-dlg-pick:${SAVE_NAME}`);
seq.push('245:0x111:57600'); // File > New
seq.push('275:dlg-cmd:1');
seq.push('325:0x111:57601'); // File > Open
seq.push(`375:open-dlg-pick:${SAVE_NAME}`);
seq.push('465:dump-focus-text:after-open');

// Query first word, second word, then the whole mixed document.
seq.push('475:keydown:36');
seq.push('476:keyup:36');
seq.push('480:keydown:16');
for (let i = 0; i < 5; i++) {
  seq.push(`${481 + i * 2}:keydown:39`);
  seq.push(`${482 + i * 2}:keyup:39`);
}
seq.push('492:keyup:16');
seq.push('498:dump-focus-charformat:first-after-open');
seq.push('505:keydown:35');
seq.push('506:keyup:35');
seq.push('510:keydown:16');
for (let i = 0; i < 5; i++) {
  seq.push(`${511 + i * 2}:keydown:37`);
  seq.push(`${512 + i * 2}:keyup:37`);
}
seq.push('522:keyup:16');
seq.push('528:dump-focus-charformat:second-after-open');
seq.push('535:keydown:17');
seq.push('536:keydown:65');
seq.push('537:keyup:65');
seq.push('538:keyup:17');
seq.push('544:dump-focus-charformat:mixed-after-open');
seq.push('550:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=650',
  '--batch-size=50000',
  '--quiet-api',
  '--no-close',
  `--save-vfs=${VFS_DIR}`,
];

console.log('$ node ' + args.map(arg => JSON.stringify(arg)).join(' '));

let output = '';
let timedOut = false;
try {
  output = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  timedOut = error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

const matching = label => output.split('\n').find(line =>
  line.includes(`dump-focus-charformat ${label}:`)) || '';
const first = matching('first-after-open');
const second = matching('second-after-open');
const mixed = matching('mixed-after-open');
const rtf = fs.existsSync(savedPath) ? fs.readFileSync(savedPath, 'latin1') : '';
const mixedMaskMatch = mixed.match(/mask=0x([0-9a-f]+)/i);
const mixedMask = mixedMaskMatch ? parseInt(mixedMaskMatch[1], 16) >>> 0 : 0xFFFFFFFF;
const checks = [
  ['emulator run completed', !timedOut],
  ['saved document reopened', /after-open: .*len=11 text="small large"/.test(output)],
  ['first run reopened at 24pt', /yHeight=480/.test(first)],
  ['second run did not reopen at 24pt', !/yHeight=480/.test(second)],
  ['whole reopened selection clears CFM_SIZE as mixed', (mixedMask & 0x80000000) === 0],
  ['saved RTF exists', rtf.startsWith('{\\rtf')],
  ['saved RTF restores 10pt after the selected run', /\\fs48 small\\fs20 +large/.test(rtf)],
  ['saved RTF does not retain size sentinel', !/\\fs3277/.test(rtf)],
  ['no runtime crash', !/CRASH|Unreachable code|EIP=0x00000000/.test(output)],
];

for (const line of output.split('\n')) {
  if (line.includes('dump-focus-text after-open:') ||
      line.includes('dump-focus-charformat') ||
      (line.includes('[save-vfs]') && line.includes(SAVE_NAME))) {
    console.log('  ' + line);
  }
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

if (rtf) {
  const sizeControls = rtf.match(/\\(?:fs|up)-?\d+/g) || [];
  console.log('RTF size controls:', sizeControls.join(' '));
}

process.exit(failed ? 1 : 0);
