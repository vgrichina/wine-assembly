#!/usr/bin/env node
// Winamp EQ Presets popup regression.
//
// Opens Winamp, dismisses the first-run survey through the normal button path,
// then clicks the Equalizer Presets button. This used to trap at
// unimplemented TrackPopupMenu.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'winamp.exe');
const OUTDIR = path.join(__dirname, 'output');
const PNG = path.join(OUTDIR, 'winamp-eq-presets-popup.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  winamp.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUTDIR, { recursive: true });
if (fs.existsSync(PNG)) fs.unlinkSync(PNG);

async function popupPixels() {
  if (!fs.existsSync(PNG)) return { gray: 0, black: 0, nonTeal: 0 };
  const img = await loadImage(PNG);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const x = 244, y = 164, w = 180, h = 120;
  const d = ctx.getImageData(x, y, Math.min(w, img.width - x), Math.min(h, img.height - y)).data;
  let gray = 0, black = 0, nonTeal = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.abs(r - 192) <= 3 && Math.abs(g - 192) <= 3 && Math.abs(b - 192) <= 3) gray++;
    if (r < 16 && g < 16 && b < 16) black++;
    if (!(r < 4 && g >= 120 && g <= 135 && b >= 120 && b <= 135)) nonTeal++;
  }
  return { gray, black, nonTeal };
}

async function main() {
  const cmd = [
    `node "${RUN}"`,
    `--exe="${EXE}"`,
    '--max-batches=900',
    '--batch-size=100',
    '--quiet-api',
    '--quiet-blocks',
    '--buttons=1,1,1,1,1,1,1,1,1,1',
    '--no-close',
    '--stuck-after=5000',
    '--input="10:273:2,20:wait-title:Winamp:1000,420:click:263:164,640:menu-dump:eqmenu,650:stop"',
  ].join(' ');
  console.log('$', cmd);

  let out = '';
  let timedOut = false;
  try {
    out = execSync(cmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
    timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    console.log(timedOut ? '(run.js timed out - output captured)' : '(run.js exited non-zero - output captured)');
  }

  const apiMatch = out.match(/Stats:\s+(\d+)\s+API calls,\s+(\d+)\s+batches/);
  const apiCount = apiMatch ? parseInt(apiMatch[1], 10) : 0;
  const batches = apiMatch ? parseInt(apiMatch[2], 10) : 0;

  const checks = [
    { name: 'run completed without timeout', pass: !timedOut },
    { name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) },
    { name: 'no unreachable trap', pass: !/RuntimeError:\s*unreachable|Unreachable code should not be executed/.test(out) },
    { name: 'EQ preset click was injected', pass: /\[input\].*click.*263,164/.test(out) },
    { name: 'reached message loop', pass: apiCount > 1000 && batches > 100 },
    { name: 'popup exposes grouped preset submenus', pass: /menu-dump:eqmenu:[^\n]*count=3[\s\S]*#0 id=0[\s\S]*"Load"[\s\S]*sub=\[0:40172:"&Preset\.\.\.",1:40173:"&Auto-load preset\.\.\."/.test(out) },
  ];

  console.log('');
  console.log(`  apiCount=${apiCount} batches=${batches}`);
  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }

  const dialogCmd = [
    `node "${RUN}"`,
    `--exe="${EXE}"`,
    '--max-batches=1300',
    '--batch-size=100',
    '--quiet-api',
    '--quiet-blocks',
    '--trace-api=EndDialog',
    '--trace-host=destroy_window',
    '--no-close',
    '--input="10:273:2,20:wait-title:Winamp:1000,420:click:263:164,760:menu-dump:eqmenu,780:click:260:176,820:click:445:196,1000:dlg-dump:eqdlg,1040:click:176:281,1280:stop"',
  ].join(' ');
  console.log('');
  console.log('$', dialogCmd);

  let dialogOut = '';
  let dialogTimedOut = false;
  try {
    dialogOut = execSync(dialogCmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    dialogOut = (e.stdout || '').toString() + (e.stderr || '').toString();
    dialogTimedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    console.log(dialogTimedOut ? '(dialog run timed out - output captured)' : '(dialog run exited non-zero - output captured)');
  }

  const dialogChecks = [
    { name: 'auto-load preset dialog run completed without timeout', pass: !dialogTimedOut },
    { name: 'EQ preset popup groups load commands', pass: /#0 id=0[\s\S]*"Load"[\s\S]*sub=\[0:40172:"&Preset\.\.\.",1:40173:"&Auto-load preset\.\.\."/.test(dialogOut) },
    { name: 'auto-load preset dialog opened', pass: /dlg-dump:eqdlg: dlg=0x[0-9a-f]+/.test(dialogOut) },
    { name: 'auto-load preset dialog click calls EndDialog', pass: /EndDialog\(0x0001000a,/.test(dialogOut) },
    { name: 'auto-load preset dialog frame destroyed', pass: /\[host\] destroy_window\(0x1000a\)/.test(dialogOut) },
  ];

  console.log('');
  for (const c of dialogChecks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }

  const reopenCmd = [
    `node "${RUN}"`,
    `--exe="${EXE}"`,
    '--max-batches=1200',
    '--batch-size=100',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
    '--input="10:273:2,20:wait-title:Winamp:1000,420:click:263:164,520:menu-dump:first,620:click:40:400,720:menu-dump:hidden,820:click:263:164,920:menu-dump:second,1020:stop"',
  ].join(' ');
  console.log('');
  console.log('$', reopenCmd);

  let reopenOut = '';
  let reopenTimedOut = false;
  try {
    reopenOut = execSync(reopenCmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    reopenOut = (e.stdout || '').toString() + (e.stderr || '').toString();
    reopenTimedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    console.log(reopenTimedOut ? '(reopen run timed out - output captured)' : '(reopen run exited non-zero - output captured)');
  }

  const secondMenu = (reopenOut.match(/menu-dump:second:[^\n]*/) || [''])[0];
  const reopenChecks = [
    { name: 'EQ preset second-open run completed without timeout', pass: !reopenTimedOut },
    { name: 'EQ preset menu hides after outside click', pass: /menu-dump:hidden: hwnd=none/.test(reopenOut) },
    { name: 'EQ preset second open uses popup coordinates', pass: /menu-dump:second:[^\n]*xy=244,164/.test(reopenOut) },
    { name: 'EQ preset second open is not Winamp main menu', pass: !/Main|Context menus|Video options|File info/.test(secondMenu) },
    { name: 'EQ preset second open keeps grouped preset commands', pass: /menu-dump:second:[^\n]*#0 id=0[\s\S]*"Load"[\s\S]*sub=\[0:40172:"&Preset\.\.\.",1:40173:"&Auto-load preset\.\.\."/.test(reopenOut) },
  ];

  console.log('');
  for (const c of reopenChecks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }

  const outsidePopupCmd = [
    `node "${RUN}"`,
    `--exe="${EXE}"`,
    '--max-batches=1000',
    '--batch-size=100',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
    '--input="10:273:2,20:wait-title:Winamp:1000,420:click:263:164,520:menu-dump:first,620:click:240:164,720:menu-dump:left-open,820:stop"',
  ].join(' ');
  console.log('');
  console.log('$', outsidePopupCmd);

  let outsidePopupOut = '';
  let outsidePopupTimedOut = false;
  try {
    outsidePopupOut = execSync(outsidePopupCmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    outsidePopupOut = (e.stdout || '').toString() + (e.stderr || '').toString();
    outsidePopupTimedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    console.log(outsidePopupTimedOut ? '(outside-popup run timed out - output captured)' : '(outside-popup run exited non-zero - output captured)');
  }

  const outsidePopupMenu = (outsidePopupOut.match(/menu-dump:left-open:[^\n]*/) || [''])[0];
  const outsidePopupChecks = [
    { name: 'EQ preset outside-popup click completed without timeout', pass: !outsidePopupTimedOut },
    { name: 'EQ preset outside-popup click closes menu', pass: /menu-dump:left-open: hwnd=none/.test(outsidePopupOut) },
    { name: 'EQ preset outside-popup click does not switch to main menu', pass: !/Main|Context menus|Video options|File info/.test(outsidePopupMenu) },
  ];

  console.log('');
  for (const c of outsidePopupChecks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }

  const closeCmd = [
    `node "${RUN}"`,
    `--exe="${EXE}"`,
    '--max-batches=1100',
    '--batch-size=100',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
    '--input="10:273:2,20:wait-title:Winamp:1000,420:click:263:164,460:click:260:176,500:click:445:196,650:dlg-dump:opened,670:click:176:281,860:dlg-dump:after-close,890:stop"',
  ].join(' ');
  console.log('');
  console.log('$', closeCmd);

  let closeOut = '';
  let closeTimedOut = false;
  try {
    closeOut = execSync(closeCmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    closeOut = (e.stdout || '').toString() + (e.stderr || '').toString();
    closeTimedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    console.log(closeTimedOut ? '(close run timed out - output captured)' : '(close run exited non-zero - output captured)');
  }

  const closeChecks = [
    { name: 'auto-load preset close completed without timeout', pass: !closeTimedOut },
    { name: 'auto-load preset dialog existed before close', pass: /dlg-dump:opened: dlg=0x[0-9a-f]+/.test(closeOut) },
    { name: 'auto-load preset cancel removed dialog', pass: /dlg-dump:after-close: dlg=none/.test(closeOut) },
  ];

  console.log('');
  for (const c of closeChecks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }

  const eqfCmd = [
    `node "${RUN}"`,
    `--exe="${EXE}"`,
    '--max-batches=1150',
    '--batch-size=100',
    '--quiet-api',
    '--quiet-blocks',
    '--trace-api=GetOpenFileNameA',
    '--no-close',
    '--input="10:273:2,20:wait-title:Winamp:1000,420:click:263:164,780:click:260:176,820:click:445:256,1000:dlg-dump:eqfopen,1060:stop"',
  ].join(' ');
  console.log('');
  console.log('$', eqfCmd);

  let eqfOut = '';
  let eqfTimedOut = false;
  try {
    eqfOut = execSync(eqfCmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    eqfOut = (e.stdout || '').toString() + (e.stderr || '').toString();
    eqfTimedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    console.log(eqfTimedOut ? '(EQF run timed out - output captured)' : '(EQF run exited non-zero - output captured)');
  }

  const eqfChecks = [
    { name: 'EQF dialog run completed without timeout', pass: !eqfTimedOut },
    { name: 'EQF path calls GetOpenFileNameA', pass: /GetOpenFileNameA\(0x[0-9a-f]+\)/.test(eqfOut) },
    { name: 'EQF dialog keeps Look in label intact', pass: /text="Look in:"/.test(eqfOut) },
    { name: 'EQF dialog keeps File name label intact', pass: /text="File name:"/.test(eqfOut) },
    { name: 'EQF dialog keeps Open and Cancel buttons intact', pass: /text="Open"[\s\S]*text="Cancel"/.test(eqfOut) },
  ];

  console.log('');
  for (const c of eqfChecks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }

  console.log('');
  const total = checks.length + dialogChecks.length + reopenChecks.length + outsidePopupChecks.length + closeChecks.length + eqfChecks.length;
  console.log(`${total - failed}/${total} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
