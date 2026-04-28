#!/usr/bin/env node
// Pinball Player Controls dialog regression: drives the real pinball.exe,
// posts WM_COMMAND id=406 (the F8 menu/accelerator) to open the Player
// Controls dialog, and verifies it renders without crashing.
//
// This dialog is the in-tree fixture for combobox CB_GETITEMDATA /
// CB_SETITEMDATA (commit 8b3b1f3) and the listbox WM_PAINT-while-hidden
// guard (commit ebbd8a4). Pinball stores VK codes per slot via
// CB_SETITEMDATA and reads them back later — without round-tripping
// item-data the dialog's OK button silently lost the user's binding.
//
// PASS criteria:
//   - emulator runs to completion without UNIMPLEMENTED / LinkError
//   - PNG snapshot is written and >1KB
//   - dialog frame ("3D Pinball: Player Controls") logged via CreateDialog
//   - dialog top-level hwnd has visible content (>=8 distinct colors)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try { ({ createCanvas, loadImage } = require('canvas')); } catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'pinball', 'pinball.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  node-canvas not available');
  process.exit(0);
}

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const dlgPng = path.join(TMP, 'pinball_player_controls.png');
try { fs.unlinkSync(dlgPng); } catch (_) {}

// 200 batches lets pinball reach its main GetMessage loop; 300 lets the
// posted WM_COMMAND deliver and the dialog populate + paint.
const inputSpec = [
  `200:post-cmd:406`,
  `300:png:${dlgPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --batch-size=200000 --max-batches=400 --input='${inputSpec}'`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 180000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const checks = [];
checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
checks.push({ name: 'no LinkError',               pass: !/LinkError/.test(out) });
checks.push({ name: 'no unreachable trap',        pass: !/RuntimeError: unreachable/.test(out) });

const dlgOk = fs.existsSync(dlgPng) && fs.statSync(dlgPng).size > 1000;
checks.push({ name: 'dialog snapshot written', pass: dlgOk });

const dialogLogged = /\[CreateDialog\] hwnd=0x[0-9a-f]+ parent=0x10002/.test(out);
checks.push({ name: 'CreateDialog fired with main parent', pass: dialogLogged });

(async () => {
  if (dlgOk) {
    const img = await loadImage(dlgPng);
    const c = createCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    const data = c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    const seen = new Set();
    for (let y = 0; y < img.height; y += 4) {
      for (let x = 0; x < img.width; x += 4) {
        const i = (y * img.width + x) * 4;
        seen.add((data[i] << 16) | (data[i+1] << 8) | data[i+2]);
      }
    }
    console.log(`  dialog png: ${img.width}x${img.height}, ${seen.size} distinct sampled colors`);
    checks.push({ name: 'dialog snapshot has ≥8 distinct colors', pass: seen.size >= 8 });
  }

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  console.log(`Snapshot: ${dlgPng}`);
  process.exit(failed > 0 ? 1 : 0);
})();
