#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const FIXTURE = path.join(__dirname, 'fixtures', 'wordpad-advanced.rtf');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG = path.join(OUT_DIR, 'advanced-rtf.png');
const LOG = path.join(OUT_DIR, 'advanced-rtf-run.log');
const ERR = path.join(OUT_DIR, 'advanced-rtf-run.err.log');
const INPUT_NAME = 'wordpad-advanced.rtf';
const OUTPUT_NAME = 'wordpad-advanced-saved.rtf';
const SAVED = path.join(OUT_DIR, OUTPUT_NAME);

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const file of [PNG, LOG, ERR, SAVED]) fs.rmSync(file, { force: true });

const seq = [
  `60:vfs-import:${INPUT_NAME}:${FIXTURE}`,
  '72:0x111:57601',
  `125:open-dlg-pick:${INPUT_NAME}`,
  '180:dump-focus-state:opened',
  '184:set-focus-selection:0:12:heading',
  '186:dump-focus-charformat:heading',
  '190:set-focus-selection:13:32:left',
  '192:dump-focus-charformat:left',
  '196:dump-focus-paraformat:left',
  '200:set-focus-selection:33:57:center',
  '202:dump-focus-charformat:center',
  '204:dump-focus-paraformat:center',
  `212:png:${PNG}`,
  '230:0x111:57604',
  `285:open-dlg-pick:${OUTPUT_NAME}`,
  '350:0x111:57600',
  '385:dlg-cmd:1',
  '425:0x111:57601',
  `480:open-dlg-pick:${OUTPUT_NAME}`,
  '535:dump-focus-state:reopened',
  '540:set-focus-selection:0:12:reopened-heading',
  '542:dump-focus-charformat:reopened-heading',
  '546:set-focus-selection:33:57:reopened-center',
  '548:dump-focus-charformat:reopened-center',
  '550:dump-focus-paraformat:reopened-center',
  `554:vfs-export:${OUTPUT_NAME}:${SAVED}`,
  '556:stop',
];

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=570',
  '--batch-size=50000',
  '--quiet-blocks',
  '--quiet-api',
  '--no-close',
];

async function runProbe() {
  console.log('$ node ' + args.map(value => JSON.stringify(value)).join(' '));
  const child = spawn('node', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let artifactReady = false;
  let timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const poll = setInterval(() => {
    if (fs.existsSync(SAVED) && fs.existsSync(PNG)) {
      artifactReady = true;
      child.kill('SIGTERM');
    }
  }, 100);
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, 180000);
  const result = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  clearInterval(poll);
  clearTimeout(deadline);
  fs.writeFileSync(LOG, stdout);
  fs.writeFileSync(ERR, stderr);
  return { result, out: stdout + stderr, artifactReady, timedOut };
}

async function main() {
const probe = await runProbe();
const { result: run, out } = probe;
for (const line of out.split('\n').filter(line =>
  line.includes('dump-focus-') || line.includes('set-focus-selection') ||
  line.includes('open-dlg-pick') || line.includes('vfs-import') ||
  line.includes('png ') || line.includes('UNIMPLEMENTED') || line.includes('CRASH'))) {
  console.log('  ' + line);
}

const saved = fs.existsSync(SAVED) ? fs.readFileSync(SAVED, 'latin1') : '';
const find = marker => out.split('\n').find(line => line.includes(marker)) || '';
const opened = find('dump-focus-state opened:');
const reopened = find('dump-focus-state reopened:');
const heading = find('dump-focus-charformat heading:');
const left = find('dump-focus-charformat left:');
const center = find('dump-focus-charformat center:');
const centerPara = find('dump-focus-paraformat center:');
const reopenedHeading = find('dump-focus-charformat reopened-heading:');
const reopenedCenter = find('dump-focus-charformat reopened-center:');
const reopenedCenterPara = find('dump-focus-paraformat reopened-center:');

const checks = [];
const check = (name, pass) => checks.push({ name, pass: !!pass });
const hasDocumentText = line => /Advanced RTF/.test(line) && /Left red bold text/.test(line) &&
  /Centered blue paragraph/.test(line) && /Cell A/.test(line) && /Cell B/.test(line) && /Tail paragraph/.test(line);

check('emulator produced final artifacts inside timeout', probe.artifactReady && !probe.timedOut);
check('advanced fixture imported into VFS', /vfs-import .*wordpad-advanced\.rtf/.test(out));
check('native RichEdit opened all paragraph and table text', hasDocumentText(opened));
check('heading resolved stylesheet bold and 16pt size', /bold=1/.test(heading) && /yHeight=320/.test(heading));
check('following paragraph resets heading style and remains a mixed inline run', /bold=0/.test(left) && /mask=0xb800003e/.test(left));
check('center paragraph resolved 12pt blue character style', /yHeight=240/.test(center) && /color=0xb40000/.test(center));
check('center paragraph reports centered alignment', /alignment=3/.test(centerPara));
check('advanced RTF screenshot written', fs.existsSync(PNG) && fs.statSync(PNG).size > 1000);
check('Save As emitted an RTF document', saved.startsWith('{\\rtf'));
check('saved RTF retains table row and cell controls', /\\trowd/.test(saved) && /\\cellx/.test(saved) && /\\cell\b/.test(saved) && /\\row\b/.test(saved));
check('saved RTF retains centered and later default-left paragraphs',
  /\\pard\\qc\b/.test(saved) && /\\row[\s\S]*\\pard[^\r\n]*Tail paragraph/.test(saved));
check('saved RTF retains font and color tables', /\\fonttbl/.test(saved) && /\\colortbl/.test(saved));
check('reopened saved document retains all text', hasDocumentText(reopened));
check('reopened heading retains style', /bold=1/.test(reopenedHeading) && /yHeight=320/.test(reopenedHeading));
check('reopened center retains character style', /yHeight=240/.test(reopenedCenter) && /color=0xb40000/.test(reopenedCenter));
check('reopened center retains paragraph alignment', /alignment=3/.test(reopenedCenterPara));
check('no unimplemented API or crash', !/UNIMPLEMENTED API:|CRASH|Unreachable code/.test(out));

console.log('');
let failed = 0;
for (const result of checks) {
  console.log((result.pass ? 'PASS  ' : 'FAIL  ') + result.name);
  if (!result.pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
