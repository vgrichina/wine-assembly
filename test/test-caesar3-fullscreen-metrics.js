#!/usr/bin/env node
// Caesar III runs DirectDraw fullscreen-exclusive at 800x600 and scales the
// cursor by the client rect its wndproc builds from
// SetRect(0, 0, SM_CXSCREEN, SM_CYSCREEN). If GetSystemMetrics answers with
// the host window instead of the mode that DirectDraw put in effect, every
// cursor position is divided by the wrong number and the main menu stops
// responding where the player is actually pointing.
//
// So run the game on a host screen that is deliberately NOT 800x600 and read
// back the RECT it computed at 0x5807d0: it must be the display mode.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(ROOT, 'test/binaries/candidates/caesar-3-demo/installed/c3.exe');
const CLIENT_RECT = 0x5807d0;

if (!fs.existsSync(EXE)) { console.log('SKIP  Caesar III demo missing'); process.exit(0); }

const cmd = `node "${RUN}" --app=caesar3_demo --screen=1024x768 --batch-size=20000`
  + ` --max-batches=3000 --repaint-every=100000 --dump=0x${CLIENT_RECT.toString(16)}:16`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 300000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
}

const line = out.split('\n').find(l => l.includes(`0x00${CLIENT_RECT.toString(16)}  `));
if (!line) { console.error(out); throw new Error('no hexdump of the client rect in the run output'); }
const bytes = line.trim().split(/\s+/).slice(1, 17).map(b => parseInt(b, 16));
const dword = i => bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
const rect = { left: dword(0), top: dword(1), right: dword(2), bottom: dword(3) };
console.log('client rect:', JSON.stringify(rect));

const assert = require('assert');
assert.deepStrictEqual(rect, { left: 0, top: 0, right: 800, bottom: 600 },
  'the fullscreen client rect must follow the DirectDraw display mode, not the host screen');
console.log('PASS  DirectDraw exclusive mode drives SM_CXSCREEN/SM_CYSCREEN');
