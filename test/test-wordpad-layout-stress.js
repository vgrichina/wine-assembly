#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const FIXTURE = path.join(os.tmpdir(), 'wordpad-layout-stress.txt');
const NARROW = path.join(OUT, 'layout-stress-narrow.png');
const WIDE = path.join(OUT, 'layout-stress-wide.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const file of [NARROW, WIDE]) try { fs.unlinkSync(file); } catch (_) {}

const paragraphs = [];
for (let i = 0; i < 80; i++) {
  paragraphs.push(`Paragraph ${String(i).padStart(2, '0')} carries enough repeated words to wrap at narrow widths while preserving selection, scrolling, and repaint state.`);
}
const documentText = paragraphs.join('\r\n');
fs.writeFileSync(FIXTURE, documentText, 'latin1');
const boundary = paragraphs[39].length + paragraphs.slice(0, 39).reduce((n, p) => n + p.length + 2, 0);

const seq = [
  `60:vfs-import:layout-stress.txt:${FIXTURE}`,
  '72:0x111:57601', '125:open-dlg-pick:layout-stress.txt',
  '175:dump-focus-state:opened',
  '185:wheel:200:220:120', '188:wheel:200:220:120',
  '191:wheel:200:220:120', '194:wheel:200:220:120',
  '200:dump-focus-state:scrolled',
  '210:main-resize:320:240', '235:dump-windows:narrow', `242:png:${NARROW}`,
  '252:main-resize:640:480', '280:dump-windows:wide', `288:png:${WIDE}`,
  `300:set-focus-selection:${boundary - 3}:${boundary + 3}:cross-crlf`,
  '302:keypress:88', '310:dump-focus-state:replaced',
  '315:keydown:17', '316:keydown:90', '317:keyup:90', '318:keyup:17',
  '326:dump-focus-state:undone', '332:stop',
];

const result = spawnSync(process.execPath, [
  path.join(__dirname, 'run.js'), `--exe=${EXE}`, `--input=${seq.join(',')}`,
  '--max-batches=345', '--batch-size=50000', '--quiet-api', '--quiet-blocks', '--no-close',
], { cwd: ROOT, encoding: 'utf8', timeout: 170000, maxBuffer: 64 * 1024 * 1024 });
const output = `${result.stdout || ''}${result.stderr || ''}`;
for (const line of output.split('\n')) {
  if (/dump-focus-state|main-resize|window:(narrow|wide).*RichEdit|set-focus-selection|png |UNIMPLEMENTED|CRASH|RuntimeError/.test(line)) {
    console.log('  ' + line.replace(/ text=.* at batch/, ' text=<omitted> at batch'));
  }
}

const state = label => output.split('\n').find(line => line.includes(`dump-focus-state ${label}:`)) || '';
const windowLine = label => output.split('\n').find(line => line.includes(`window:${label}`) && line.includes('RichEdit20A')) || '';
const narrowWindow = windowLine('narrow');
const wideWindow = windowLine('wide');
const narrowSize = /size=(\d+)x(\d+)/.exec(narrowWindow);
const wideSize = /size=(\d+)x(\d+)/.exec(wideWindow);
const expectedLen = documentText.length;

const checks = [
  ['emulator completed inside timeout', result.status === 0 && !result.signal && !result.error],
  ['large 80-paragraph document opened intact', new RegExp(`len=${expectedLen} `).test(state('opened')) && state('opened').includes('Paragraph 79')],
  ['large document scroll reaches a nonzero visible line', /dump-focus-state scrolled:.*firstVisible=[1-9]\d*/.test(output)],
  ['narrow resize relaid out the native RichEdit', narrowSize && Number(narrowSize[1]) < 320],
  ['wide resize expanded the native RichEdit', wideSize && narrowSize && Number(wideSize[1]) > Number(narrowSize[1])],
  ['selection crosses the paragraph CRLF boundary', new RegExp(`set-focus-selection cross-crlf:.*range=${boundary - 3}\\.\\.${boundary + 3}`).test(output)],
  ['replacement across wrapped paragraph boundary changed length predictably', new RegExp(`len=${expectedLen - 5} `).test(state('replaced'))],
  ['Undo restored the entire large document', new RegExp(`len=${expectedLen} `).test(state('undone')) && state('undone').includes('Paragraph 79')],
  ['narrow and wide screenshots written', [NARROW, WIDE].every(file => fs.existsSync(file) && fs.statSync(file).size > 1000)],
  ['no unimplemented API or crash', !/UNIMPLEMENTED|CRASH|RuntimeError|Unreachable code/.test(output)],
];
let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
