#!/usr/bin/env node
'use strict';

// Deterministic local-corpus driver for the long path from GOG's bundled
// Windows DOSBox through Daggerfall character creation into the first dungeon.
// This is intentionally a manual acceptance tool: nested interpretation takes
// a long time, the proprietary payload is gitignored, and the output still
// requires visual review before it can be called gameplay.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/gog-free-elder-scrolls-daggerfall/installed');
const dosbox = path.join(installed, 'DOSBOX', 'DOSBox.exe');
const gogConfig = path.join(installed, '__support', 'app', 'dosbox_daggerfall.conf');
const waConfig = path.join(root, 'test/configs/daggerfall-wine-assembly.conf');
const launchConfig = path.join(root, 'test/configs/daggerfall-launch.conf');
const outDir = path.resolve(process.env.DAGGERFALL_SCREENSHOT_DIR ||
  path.join(os.tmpdir(), 'wa-daggerfall-gameplay'));

const events = [];
const add = (batch, action, ...args) => events.push([batch, action, ...args].join(':'));
const click = (batch, x, y, hold = 70) => {
  add(batch, 'mousemove', x, y);
  add(batch + 2, 'mousedown', x, y);
  add(batch + hold, 'mouseup', x, y);
};
const key = (down, up, vk) => {
  add(down, 'keydown', vk);
  add(up, 'keyup', vk);
};
const png = (batch, name) => add(batch, 'png', path.join(outDir, name));

key(2050, 2150, 27);
key(2250, 2350, 27);
click(3500, 160, 128, 150);
click(3900, 95, 80, 150);
click(4300, 128, 151, 150);
click(4700, 128, 126, 150);
click(5400, 160, 90, 150);
add(6000, 'mousemove', 100, 86);
add(6050, 'mousedown', 100, 86);
add(6100, 'mouseup', 100, 86);
add(6150, 'mousedown', 100, 86);
add(6200, 'mouseup', 100, 86);
click(6500, 128, 147, 150);
click(7250, 160, 95, 150);
key(7800, 7900, 13);
for (const [i, vk] of [67, 79, 68, 69, 88].entries()) {
  key(9000 + i * 40, 9020 + i * 40, vk); // CODEX
}
click(9400, 284, 204, 15);
click(9800, 284, 204, 15);

click(10200, 25, 52, 70);
for (let i = 0; i < 12; i++) click(10300 + i * 300, 55, 48, 70);
png(14000, 'attributes.png');
click(14100, 284, 204, 70);

click(14700, 120, 56, 70);
click(14800, 192, 56, 70);
for (let i = 0; i < 8; i++) click(15000 + i * 300, 241, 59, 70);
click(17400, 120, 112, 70);
click(17500, 192, 112, 70);
for (let i = 0; i < 8; i++) click(17700 + i * 300, 241, 108, 70);
click(20100, 120, 156, 70);
click(20200, 192, 156, 70);
for (let i = 0; i < 8; i++) click(20400 + i * 300, 241, 157, 70);
png(22800, 'skills.png');
click(22900, 284, 204, 70);

png(23700, 'reflexes.png');
click(23800, 160, 193, 70);
click(24100, 284, 204, 70);
png(24900, 'final-review.png');
click(25000, 284, 204, 70); // final review OK, not the left edge
png(25800, 'after-final-ok.png');
for (let i = 0; i < 6; i++) key(26100 + i * 300, 26170 + i * 300, 27);
for (const [batch, index] of [[28600, 1], [29800, 2], [31000, 3], [32200, 4], [33400, 5]]) {
  png(batch, `gameplay-${index}.png`);
}

if (process.argv.includes('--dry-run')) {
  console.log(`PASS Daggerfall gameplay schedule: ${events.length} events, final batch 33400`);
  process.exit(0);
}

if (![dosbox, gogConfig, launchConfig].every(fs.existsSync)) {
  console.error('Daggerfall local candidate payload is not present');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const args = [
  'test/run.js', `--exe=${dosbox}`,
  '--args=-conf "c:\\dosbox_daggerfall.conf" -conf "c:\\dosbox-wa.conf" -conf "c:\\dosbox-launch.conf" -noconsole',
  '--vfs-include=*', '--vfs-include=../**/*',
  `--vfs-mount=${gogConfig}=c:\\dosbox_daggerfall.conf`,
  `--vfs-mount=${waConfig}=c:\\dosbox-wa.conf`,
  `--vfs-mount=${launchConfig}=c:\\dosbox-launch.conf`,
  '--no-build', '--screen=800x600', '--batch-size=2000000',
  '--tick-ms-per-batch=200', '--repaint-every=100', '--stuck-after=1000000',
  '--quiet-api', '--quiet-blocks', '--no-close', '--max-batches=33500',
  '--max-seconds=19800', `--input=${events.join(',')}`,
];
const run = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  timeout: 20000000,
});
if (run.error) {
  console.error(run.error.stack || run.error.message);
  process.exit(1);
}
console.log(`Daggerfall candidate frames: ${outDir}`);
process.exit(run.status === 0 ? 0 : 1);
