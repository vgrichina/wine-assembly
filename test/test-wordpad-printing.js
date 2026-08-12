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

function run(input, max = 380) {
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
const previewFixture = '/private/tmp/wordpad-print-preview-multipage.txt';
const previewFirstPng = '/private/tmp/wordpad-print-preview-first.png';
const previewNextPng = '/private/tmp/wordpad-print-preview-next.png';
for (const file of [printPng, pagePng, previewFirstPng, previewNextPng]) try { fs.unlinkSync(file); } catch (_) {}
const previewText = Array.from({ length: 90 }, (_, i) =>
  `Preview paragraph ${String(i).padStart(2, '0')}: ${i < 45 ? 'FIRST-HALF' : 'SECOND-HALF'} ` +
  'fills a deterministic printable line for pagination and page navigation.'
).join('\r\n');
fs.writeFileSync(previewFixture, previewText, 'latin1');

const print = run([
  '70:0x111:57607', '105:wait-dlg-control:1154:130', '106:dlg-dump:print',
  '110:dlg-set-edit:1152:2', '112:dlg-set-edit:1153:4',
  '114:dlg-set-edit:1154:3', `120:dlg-png:${printPng}`,
  '125:dlg-cmd:1', '270:dump-print-state:completed',
  '300:dump-windows:after-print', '320:stop',
].join(','));
const po = `${print.stdout || ''}\n${print.stderr || ''}`;
check('Print dialog exposes printer, range, copies, OK and Cancel',
  /dlg-dump:print:.*Printer: Web Printer.*Page range.*id=1152.*id=1153.*Copies:.*id=1154.*text="OK".*text="Cancel"/.test(po));
check('Print edits accept 2..4 and three copies',
  /dlg-set-edit: id=1152 text="2"/.test(po) && /id=1153 text="4"/.test(po) && /id=1154 text="3"/.test(po));
check('Print dialog closes and WordPad remains present',
  /dlg-cmd: cmd=1/.test(po) && /window:after-print .*title="Document - WordPad"/.test(po));
check('Print screenshot written', fs.existsSync(printPng) && fs.statSync(printPng).size > 1000);

const lifecycle = run([
  '70:0x111:57607', '105:wait-dlg-control:1154:130', '110:dlg-cmd:1',
  '270:dump-print-state:completed', '300:dump-windows:after-job', '320:stop',
].join(','));
const lo = `${lifecycle.stdout || ''}\n${lifecycle.stderr || ''}`;
check('Print job completes one page and returns the driver to idle',
  /dump-print-state:completed: state=0 pages=1 quit=0/.test(lo));
check('Print progress closes and the WordPad frame is re-enabled',
  /window:after-job .*enabled=true.*title="Document - WordPad"/.test(lo) &&
  !/window:after-job .*dialog=true.*title="WordPad"/.test(lo));

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

const preview = run([
  `60:vfs-import:print-preview-multipage.txt:${previewFixture}`,
  '90:0x111:57601', '180:open-dlg-pick:print-preview-multipage.txt',
  `220:wait-focus-length:${previewText.length}:1000`,
  '230:wait-title:print-preview-multipage.txt - WordPad:1000',
  '240:formatrange-probe:7200:7200:multi',
  '260:0x111:57609', '380:dump-windows:preview',
  `390:png:${previewFirstPng}`, '410:0x111:58114',
  '490:dump-windows:preview-next', `500:png:${previewNextPng}`, '515:stop',
].join(','), 2500);
const vo = `${preview.stdout || ''}\n${preview.stderr || ''}`;
const pagination = /formatrange-probe:multi:.*len=(\d+) pages=(\d+) bounds=([\d,]+) complete=1/.exec(vo);
check('EM_FORMATRANGE returns monotonic boundaries through a multi-page document',
  !!pagination && Number(pagination[1]) === previewText.length && Number(pagination[2]) > 1 &&
  pagination[3].split(',').every((v, i, a) => i === 0 || Number(v) > Number(a[i - 1])));
check('Print Preview replaces the editor with a page-view surface',
  /window:preview .*class="RichEdit20A".*visible=false/.test(vo) &&
  /window:preview .*class="AfxFrameOrView42".*visible=true/.test(vo));
check('Print Preview Next renders without an unimplemented API or crash',
  /window:preview-next .*class="AfxFrameOrView42".*visible=true/.test(vo) &&
  !/UNIMPLEMENTED|CRASH|RuntimeError|Unreachable code/.test(vo));
check('Print Preview first/next screenshots written',
  [previewFirstPng, previewNextPng].every(file => fs.existsSync(file) && fs.statSync(file).size > 1000));

process.exitCode = failures ? 1 : 0;
