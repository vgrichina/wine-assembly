#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const PNG = path.join(ROOT, 'test', 'output', 'wordpad-richedit', 'international-text.png');
if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found');
  process.exit(0);
}
fs.mkdirSync(path.dirname(PNG), { recursive: true });
fs.rmSync(PNG, { force: true });

const chars = [
  ...'Latin ',
  'Ω', ' ', '你', ' ',
  ...'עברית', ' ', ...'العربية', ' ',
  ...'हिन्दी', ' ', '\uD83D', '\uDE00',
];
const seq = ['180:click:40:150'];
let batch = 185;
for (const ch of chars) seq.push(`${batch++}:keypress:${ch.charCodeAt(0)}`);
seq.push(`${batch + 8}:dump-focus-unicode:direct`);
seq.push(`${batch + 12}:ime-start`);
seq.push(`${batch + 14}:ime-update:日本`);
seq.push(`${batch + 16}:ime-commit:日本`);
seq.push(`${batch + 24}:dump-focus-unicode:committed`);
seq.push(`${batch + 28}:ime-start`);
seq.push(`${batch + 30}:ime-update:取消`);
seq.push(`${batch + 32}:ime-commit:`);
seq.push(`${batch + 38}:dump-focus-unicode:cancelled`);
seq.push(`${batch + 44}:png-pixels:${PNG}`);
seq.push(`${batch + 50}:stop`);

const result = spawnSync(process.execPath, [
  path.join(__dirname, 'run.js'), `--exe=${EXE}`, `--input=${seq.join(',')}`,
  `--max-batches=${batch + 48}`, '--batch-size=50000', '--quiet-api',
  '--quiet-blocks', '--no-close',
], { cwd: ROOT, encoding: 'utf8', timeout: 100000, maxBuffer: 32 * 1024 * 1024 });
const output = `${result.stdout || ''}${result.stderr || ''}`;
for (const line of output.split('\n')) {
  if (/dump-focus-unicode|ime-|png-pixels|UNIMPLEMENTED|CRASH|RuntimeError/.test(line)) console.log('  ' + line);
}

const direct = output.split('\n').find(line => line.includes('dump-focus-unicode direct:')) || '';
const committed = output.split('\n').find(line => line.includes('dump-focus-unicode committed:')) || '';
const cancelled = output.split('\n').find(line => line.includes('dump-focus-unicode cancelled:')) || '';
const checks = [
  ['emulator completed inside timeout', result.status === 0 && !result.signal && !result.error],
  ['BMP Greek and CJK round-trip through EM_GETTEXTEX',
    direct.includes('U+3A9') && direct.includes('U+4F60')],
  ['Hebrew and Arabic preserve logical Unicode order',
    direct.includes('text="Latin Ω 你 עברית العربية')],
  ['Devanagari combining sequence round-trips intact', direct.includes('हिन्दी')],
  ['surrogate-pair emoji round-trips as one code point', direct.includes('U+1F600')],
  ['browser IME lifecycle commits Japanese text once',
    /ime-start/.test(output) && /ime-update text="日本"/.test(output) &&
    /ime-commit text="日本"/.test(output) && committed.includes('日本" at batch') &&
    (committed.match(/日本/g) || []).length === 1],
  ['empty IME result cancels composition without changing the document',
    /ime-update text="取消"/.test(output) && /ime-commit text=""/.test(output) &&
    cancelled.includes('日本" at batch') && !cancelled.includes('取消')],
  ['international text screenshot written', fs.existsSync(PNG) && fs.statSync(PNG).size > 1000],
  ['no unimplemented API or runtime crash', !/UNIMPLEMENTED|CRASH|RuntimeError|Unreachable code/.test(output)],
];
let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
