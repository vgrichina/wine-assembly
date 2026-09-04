#!/usr/bin/env node

'use strict';

// A reference recording of a DOS program's sound from DOSBox-X, to hold a
// toyvm render against.
//
//   node tools/toyvm/dosbox-ref.js --exe=/tmp/demos/1995-c-cma_brw/BRW.EXE --keys="1 4 2" \
//        --seconds=45 --out=ref.wav
//   node tools/toyvm/audio-check.js ours.wav ref.wav
//
// audio-check.js can say a render is in tune with itself and continuous; it
// cannot say whether a sharp step at every block boundary is a hole the
// emulator left or a drum the tune plays. Only a second implementation can,
// and DOSBox-X is the one installed here (brew `dosbox-x`; the app bundle's
// binary is used because the brew-linked one segfaults right after SDL
// init on this box). The recording is what its SB16 emulation put on the
// mixer, captured with its own DX-CAPTURE command, so no keystrokes or
// window focus are involved: `--keys` are typed into the program by its
// AUTOTYPE (`-w` seconds before the first, `-p` seconds between), which is
// how a sound menu gets answered -- run the program under run-dos.js
// `--auto-key --verbose --text` to read what ours answered.
//
// DOSBox-X is killed at the deadline (a demo has no reason to exit), so
// the RIFF header it never finalized is filled in from the file length.
// Measured 2026-09-03 on BRW.EXE: same tuning as ours to the cent, same
// 185ms beat, and the same samples across a block boundary once the two
// are lined up -- which is how the "click at every block" turned out to be
// the tune's own snare.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function flag(name) { return process.argv.slice(2).includes(`--${name}`); }

const BINARIES = [
  process.env.DOSBOX_X,
  '/Applications/dosbox-x.app/Contents/MacOS/dosbox-x',
  'dosbox-x',
].filter(Boolean);

function findBinary() {
  for (const b of BINARIES) {
    if (b.includes('/') ? fs.existsSync(b) : true) return b;
  }
  return null;
}

// The header DOSBox-X would have written had it been allowed to finish.
function fixWavSizes(file) {
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF') throw new Error(`${file}: not a WAV`);
  b.writeUInt32LE(b.length - 8, 4);
  b.writeUInt32LE(b.length - 44, 40);
  fs.writeFileSync(file, b);
  const rate = b.readUInt32LE(24), ch = b.readUInt16LE(22), bits = b.readUInt16LE(34);
  return { rate, ch, bits, seconds: (b.length - 44) / (rate * ch * bits / 8) };
}

async function main() {
  const exe = arg('exe');
  const out = arg('out');
  if (!exe || !out) {
    console.error('usage: dosbox-ref.js --exe=PATH --out=ref.wav [--keys="1 4 2"] [--seconds=45] [--wait=4] [--pace=1.5] [--cycles=30000] [--sbtype=sb16] [--gus] [--rate=44100]');
    process.exit(2);
  }
  const bin = findBinary();
  if (!bin) { console.error('no dosbox-x found (brew install dosbox-x, or set DOSBOX_X)'); process.exit(2); }
  const seconds = Number(arg('seconds', 45));
  const keys = arg('keys', '').trim();
  const dir = path.dirname(path.resolve(exe));
  const name = path.basename(exe);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dosbox-ref-'));
  const captures = path.join(work, 'capture');
  fs.mkdirSync(captures);
  const conf = [
    '[sdl]', 'output=surface',
    '[dosbox]', `captures=${captures}`,
    '[cpu]', 'core=normal', `cycles=fixed ${arg('cycles', '30000')}`,
    '[mixer]', `rate=${arg('rate', '44100')}`, 'nosound=true',
    '[sblaster]', `sbtype=${arg('sbtype', 'sb16')}`, 'sbbase=220', 'irq=7', 'dma=1',
    // --gus puts a Gravis Ultrasound at 220h/IRQ 11/DMA 1 -- the same
    // machine `run-dos.js --env=ULTRASND=220,1,1,11,7` describes -- and
    // DOSBox-X exports the matching ULTRASND= itself.
    ...(flag('gus') ? ['[gus]', 'gus=true', 'gusbase=220', 'gusirq=11', 'gusdma=1', 'gustype=classic'] : []),
    '[autoexec]', `mount c "${dir}"`, 'c:',
    ...(keys ? [`AUTOTYPE -w ${arg('wait', '4')} -p ${arg('pace', '1.5')} ${keys}`] : []),
    `DX-CAPTURE /A /-V ${name}`,
    'exit', '',
  ].join('\n');
  const confFile = path.join(work, 'ref.conf');
  fs.writeFileSync(confFile, conf);
  const log = path.join(work, 'dosbox-x.log');
  console.log(`${bin}: ${name} in ${dir}, ${seconds}s, keys "${keys}" -> ${out}`);
  const child = spawn(bin, ['-conf', confFile, '-nomenu', '-log-file', log], { stdio: ['ignore', 'ignore', 'ignore'] });
  const done = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  const timer = setTimeout(() => child.kill('SIGKILL'), seconds * 1000);
  const exit = await done;
  clearTimeout(timer);
  const wavs = fs.readdirSync(captures).filter((f) => f.toLowerCase().endsWith('.wav'));
  if (!wavs.length) {
    console.error(`no capture written (exit ${exit.code} ${exit.sig || ''}); conf and log in ${work}`);
    process.exit(1);
  }
  fs.copyFileSync(path.join(captures, wavs[0]), out);
  const info = fixWavSizes(out);
  console.log(`${out}: ${info.seconds.toFixed(2)}s at ${info.rate}Hz, ${info.ch}ch ${info.bits}-bit`
    + (exit.sig ? ` (DOSBox-X killed at the deadline)` : ` (program exited, code ${exit.code})`));
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
