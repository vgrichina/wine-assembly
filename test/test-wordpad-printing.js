#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found');
  process.exit(0);
}

function run(input, max = 2600) {
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

function previewPixels(file) {
  if (!fs.existsSync(file)) return null;
  const image = PNG.sync.read(fs.readFileSync(file));
  let pageWhite = 0;
  let interiorDark = 0;
  for (let y = 57; y < 274; y++) {
    for (let x = 115; x < 283; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      if (r > 245 && g > 245 && b > 245) pageWhite++;
      if (x >= 140 && x < 267 && y >= 78 && y < 252 &&
          r < 96 && g < 96 && b < 96) interiorDark++;
    }
  }
  return { image, pageWhite, interiorDark };
}

function previewInteriorDifference(a, b) {
  if (!a || !b || a.image.width !== b.image.width || a.image.height !== b.image.height) return 0;
  let changed = 0;
  for (let y = 78; y < 252; y++) {
    for (let x = 140; x < 267; x++) {
      const i = (y * a.image.width + x) * 4;
      const delta = Math.abs(a.image.data[i] - b.image.data[i]) +
        Math.abs(a.image.data[i + 1] - b.image.data[i + 1]) +
        Math.abs(a.image.data[i + 2] - b.image.data[i + 2]);
      if (delta > 30) changed++;
    }
  }
  return changed;
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
  '20:wait-title-command:Document_-_WordPad:2000:57607:print',
  '40:wait-dlg-control:1154:1000', '41:dlg-dump:print',
  '45:dlg-set-edit:1152:2', '47:dlg-set-edit:1153:4',
  '49:dlg-set-edit:1154:3', `55:dlg-png:${printPng}`,
  '60:dlg-cmd:1', '205:dump-print-state:completed',
  '235:dump-windows:after-print', '255:stop',
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
  '20:wait-title-command:Document_-_WordPad:2000:57607:print-job',
  '40:wait-dlg-control:1154:1000', '45:dlg-cmd:1',
  '205:dump-print-state:completed', '235:dump-windows:after-job', '255:stop',
].join(','));
const lo = `${lifecycle.stdout || ''}\n${lifecycle.stderr || ''}`;
check('Print job completes one page and returns the driver to idle',
  /dump-print-state:completed: state=0 pages=1 quit=0/.test(lo));
check('Print progress closes and the WordPad frame is re-enabled',
  /window:after-job .*enabled=true.*title="Document - WordPad"/.test(lo) &&
  !/window:after-job .*dialog=true.*title="WordPad"/.test(lo));

const page = run([
  '20:wait-title-command:Document_-_WordPad:2000:32771:page-setup',
  '40:wait-dlg-control:1158:1000', '41:dlg-dump:page',
  '45:dlg-set-edit:1155:1.25', '47:dlg-set-edit:1156:1.50',
  '49:dlg-set-edit:1157:1.75', '51:dlg-set-edit:1158:2.00',
  `57:dlg-png:${pagePng}`, '63:dlg-cmd:1',
  '115:dump-windows:after-page', '135:stop',
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
  `20:vfs-import:print-preview-multipage.txt:${previewFixture}`,
  '30:wait-title-command:Document_-_WordPad:2000:57601:open',
  '50:wait-dlg-control:1090:1000',
  '51:open-dlg-pick:print-preview-multipage.txt',
  `70:wait-focus-length:${previewText.length}:1000`,
  '80:wait-title:print-preview-multipage.txt - WordPad:1000',
  '90:formatrange-probe:7200:7200:multi',
  '100:0x111:57609', '750:dump-windows:preview',
  `780:png:${previewFirstPng}`, '850:0x111:58114',
  '1150:dump-windows:preview-next', `1180:png:${previewNextPng}`, '1190:stop',
].join(','), 3000);
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
check('Print Preview status advances from Page 1 to Page 2',
  /window:preview .*class="msctls_statusbar32".*title="Page 1"/.test(vo) &&
  /window:preview-next .*class="msctls_statusbar32".*title="Page 2"/.test(vo));
const firstPixels = previewPixels(previewFirstPng);
const nextPixels = previewPixels(previewNextPng);
check('Print Preview renders a white page with scaled non-overlapping document ink',
  [firstPixels, nextPixels].every(stats => stats && stats.pageWhite > 25000 &&
    stats.interiorDark > 2000 && stats.interiorDark < 9000));
check('Print Preview Next replaces Page 1 document pixels',
  previewInteriorDifference(firstPixels, nextPixels) > 500);

process.exitCode = failures ? 1 : 0;
