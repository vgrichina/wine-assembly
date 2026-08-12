#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found');
  process.exit(0);
}

function run(input, max = 245) {
  return spawnSync(process.execPath, [
    path.join(__dirname, 'run.js'), `--exe=${EXE}`,
    `--max-batches=${max}`, '--quiet-api', '--quiet-blocks', `--input=${input}`,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 70000, maxBuffer: 16 * 1024 * 1024 });
}

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const printPng = '/private/tmp/wordpad-print-dialog.png';
const pagePng = '/private/tmp/wordpad-page-setup.png';
for (const file of [printPng, pagePng]) try { fs.unlinkSync(file); } catch (_) {}

const print = run([
  '70:0x111:57607', '105:wait-dlg-control:1154:130', '106:dlg-dump:print',
  '110:dlg-set-edit:1152:2', '112:dlg-set-edit:1153:4',
  '114:dlg-set-edit:1154:3', `120:dlg-png:${printPng}`,
  '125:dlg-cmd:1', '180:dump-windows:after-print', '200:stop',
].join(','));
const po = `${print.stdout || ''}\n${print.stderr || ''}`;
check('Print dialog exposes printer, range, copies, OK and Cancel',
  /dlg-dump:print:.*Printer: Web Printer.*Page range.*id=1152.*id=1153.*Copies:.*id=1154.*text="OK".*text="Cancel"/.test(po));
check('Print edits accept 2..4 and three copies',
  /dlg-set-edit: id=1152 text="2"/.test(po) && /id=1153 text="4"/.test(po) && /id=1154 text="3"/.test(po));
check('Print dialog closes and WordPad remains present',
  /dlg-cmd: cmd=1/.test(po) && /window:after-print .*title="Document - WordPad"/.test(po));
check('Print screenshot written', fs.existsSync(printPng) && fs.statSync(printPng).size > 1000);

const page = run([
  '70:0x111:32771', '105:wait-dlg-control:1158:130', '106:dlg-dump:page',
  '110:dlg-set-edit:1155:1.25', '112:dlg-set-edit:1156:1.50',
  '114:dlg-set-edit:1157:1.75', '116:dlg-set-edit:1158:2.00',
  `122:dlg-png:${pagePng}`, '128:dlg-cmd:1',
  '180:dump-windows:after-page', '200:stop',
].join(','));
const go = `${page.stdout || ''}\n${page.stderr || ''}`;
check('Page Setup exposes Letter paper and four margin edits',
  /dlg-dump:page:.*Paper: Letter 8\.5 x 11 in.*Margins \(inches\).*id=1155.*id=1156.*id=1157.*id=1158/.test(go));
check('Page Setup accepts four distinct decimal margins',
  /id=1155 text="1\.25"/.test(go) && /id=1156 text="1\.50"/.test(go) &&
  /id=1157 text="1\.75"/.test(go) && /id=1158 text="2\.00"/.test(go));
check('Page Setup closes and WordPad remains present',
  /dlg-cmd: cmd=1/.test(go) && /window:after-page .*title="Document - WordPad"/.test(go));
check('Page Setup screenshot written', fs.existsSync(pagePng) && fs.statSync(pagePng).size > 1000);

process.exitCode = failures ? 1 : 0;
