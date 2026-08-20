#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });

const images = {
  paragraph: path.join(OUT, 'paragraph-dialog.png'),
  tabs: path.join(OUT, 'tabs-dialog.png'),
  date: path.join(OUT, 'date-time-dialog.png'),
  rightMargin: path.join(OUT, 'right-margin-wrap.png'),
};
for (const file of Object.values(images)) fs.rmSync(file, { force: true });

function run(input, maxBatches = 320) {
  const result = spawnSync(process.execPath, [
    RUN, `--exe=${EXE}`, `--input=${input.join(',')}`,
    `--max-batches=${maxBatches}`, '--batch-size=50000',
    '--quiet-api', '--quiet-blocks', '--no-close',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  return { result, output: `${result.stdout || ''}${result.stderr || ''}` };
}

// The ruler has two distinct gestures, and the left edge is not where you set
// a tab stop: x=20 is the hanging-indent marker, so a drag from there moves the
// paragraph indent. A tab stop comes from a plain click further along the
// ruler, away from the markers.
const ruler = run([
  '180:click:40:150', '184:keypress:114',
  '190:dump-focus-paraformat:before-ruler',
  '195:mousedown:20:112', '197:mousemove:100:112', '199:mouseup:100:112',
  '205:click:40:150', '210:dump-focus-paraformat:after-indent-drag',
  '215:click:200:112',
  '225:click:40:150', '230:dump-focus-paraformat:after-tab-click',
  '240:stop',
], 265);

const rightMargin = run([
  '170:main-resize:620:420',
  '180:click:40:150',
  '184:set-focus-text-b64:b25lIHR3byB0aHJlZSBmb3VyIGZpdmUgc2l4IHNldmVuIGVpZ2h0IG5pbmUgdGVuIGVsZXZlbiB0d2VsdmUgdGhpcnRlZW4gZm91cnRlZW4gZmlmdGVlbiBzaXh0ZWVuIHNldmVudGVlbiBlaWdodGVlbiBuaW5ldGVlbiB0d2VudHk=:long',
  '190:send-focus-message:186:0:0:before-right-margin-lines',
  '195:mousedown:596:124', '197:mousemove:300:124', '199:mouseup:300:124',
  '205:click:40:150',
  '210:dump-focus-paraformat:after-right-margin',
  '212:send-focus-message:186:0:0:after-right-margin-lines',
  `220:png:${images.rightMargin}`, '225:stop',
], 250);

const paragraph = run([
  '180:0x111:32780', '215:wait-dlg-control:1002:160',
  '220:dlg-dump:paragraph', `225:dlg-png:${images.paragraph}`, '230:stop',
], 265);

const tabs = run([
  '180:0x111:32781', '215:wait-dlg-control:1007:160',
  '220:dlg-dump:tabs', `225:dlg-png:${images.tabs}`, '230:stop',
], 265);

const date = run([
  '180:0x111:32778', '215:wait-dlg-control:1018:160',
  '220:dlg-dump:date-time', `225:dlg-png:${images.date}`,
  '230:dlg-send:1018:390:2:0', '238:dlg-cmd:1',
  '255:click:40:150', '265:dump-focus-state:date-inserted', '275:stop',
], 290);

const runs = [ruler, rightMargin, paragraph, tabs, date];
for (const { output } of runs) {
  for (const line of output.split('\n')) {
    if (/dump-focus-paraformat|send-focus-message .*right-margin|dlg-dump|dump-listbox:date|dlg-send|dump-focus-state date|UNIMPLEMENTED|CRASH|RuntimeError/.test(line)) {
      console.log('  ' + line);
    }
  }
}

const checks = [
  ['all UI emulator runs completed inside their timeouts',
    runs.every(({ result }) => result.status === 0 && !result.signal && !result.error)],
  ['ruler marker drag moves the paragraph indent',
    /before-ruler:.*dxStartIndent=0 .*tabCount=0/.test(ruler.output) &&
    /after-indent-drag:.*dxStartIndent=[1-9]\d*/.test(ruler.output)],
  ['ruler click adds a native RichEdit paragraph tab stop',
    /after-indent-drag:.*tabCount=0/.test(ruler.output) &&
    /after-tab-click:.*tabCount=1 tab0=[1-9]\d*/.test(ruler.output)],
  ['right ruler marker sets a native RichEdit right indent',
    /after-right-margin:.*dxRightIndent=[1-9]\d*/.test(rightMargin.output)],
  ['right ruler margin is enforced by native RichEdit wrapping',
    /before-right-margin-lines:.*ret=0x2/.test(rightMargin.output) &&
    /after-right-margin-lines:.*ret=0x3/.test(rightMargin.output)],
  ['Paragraph dialog exposes indentation and alignment controls',
    /dlg-dump:paragraph:.*Indentation.*id=1000.*id=1001.*id=1002.*Alignment:.*text="Left"/.test(paragraph.output)],
  ['Tabs dialog exposes set, clear, and clear-all commands',
    /dlg-dump:tabs:.*id=1019.*id=1005.*id=1006.*id=1007/.test(tabs.output)],
  ['Date and Time dialog enumerates short, long, and time formats',
    /dlg-dump:date-time:.*rows="1\/1\/01 \|\| Monday, January 1, 2001 \|\| 12:00:00 AM"/.test(date.output)],
  ['Date and Time list accepts the time-format selection',
    /dlg-send: id=1018 .* msg=0x186 ret=2/.test(date.output)],
  ['selected time format inserts into the focused document',
    /dump-focus-state date-inserted:.*12:00:00 AM/.test(date.output)],
  ['all advanced UI screenshots were written',
    [images.paragraph, images.tabs, images.date]
      .every(file => fs.existsSync(file) && fs.statSync(file).size > 1000)],
  ['no UI run hit an unimplemented API or runtime crash',
    runs.every(({ output }) => !/UNIMPLEMENTED|CRASH|RuntimeError|Unreachable code/.test(output))],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
