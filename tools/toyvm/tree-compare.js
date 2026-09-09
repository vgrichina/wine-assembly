#!/usr/bin/env node

'use strict';

// Does a change to the run loop move the picture? Run the SAME programs under
// TWO checkouts and compare what each one drew and played.
//
//   git worktree add --detach /tmp/base <sha>
//   node tools/toyvm/tree-compare.js --base=/tmp/base --set=tools/toyvm/bench-set-20.txt
//
// WHY THIS EXISTS AND WHY IT IS NOT sweep-diff.js. sweep-diff compares two
// sweep JSONs, which is the right tool for a whole-corpus verdict and costs
// hours: sweep-dos.js also benches four interpreter shells and four JIT tiers
// per program, none of which a run-loop change can touch. When the question is
// only "did the frame and the audio move", this runs each program once per
// tree and answers it in minutes.
//
// It is also NOT region-live-ab.js. That one runs two ARMS of one build in one
// process, which is the right shape for a flag and the wrong one for a code
// change: the arms would both be the new code. The only way to compare against
// code that is no longer in the tree is to run the other tree.
//
// Everything that can differ between two trees is held fixed here: the same
// program list, the same flags, the same budget, and each run's audio rendered
// to a wav that is hashed rather than listened to. A row is SAME only if the
// frame hash, the non-black pixel count, the interrupt tally, the dispatch
// count AND the wav all agree.
//
// The HANDBACK count is reported beside every row but is NOT part of the
// verdict, and the difference matters. A handback is not a unit of anything the
// guest can see: the run loop is free to cut a slice wherever it likes, and a
// change to where it cuts is only a bug if it moved the picture or the sound.
// A change that removes handbacks and leaves both alone is the good case, and a
// tool that failed such a row would be reporting its own cost model.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d) => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${n}=`));
  return hit === undefined ? d : hit.slice(n.length + 3);
};
const flag = (n) => process.argv.slice(2).includes(`--${n}`);
const count = (s, d) => {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) return d;
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
};

// One program, one tree. The wav is written to a scratch file because that is
// the only way run-dos.js hands audio out of the process.
function once(tree, exe, budget, extra, wavDir, tag) {
  const wav = path.join(wavDir, `${path.basename(exe)}.${tag}.wav`);
  const args = [path.join(tree, 'tools/toyvm/run-dos.js'), exe,
    `--dispatches=${budget}`, '--pit-clock', '--auto-key', '--sound-pref=sb',
    '--env=ULTRASND=220,1,1,11,7', `--audio=${wav}`, ...extra];
  let out;
  try {
    out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) {
    return { fail: (e.stderr || e.message || '').trim().split('\n').pop() };
  }
  const frame = /frame=([0-9a-f]+)/.exec(out);
  const px = /(\d+) non-black pixels/.exec(out);
  const hb = /(\d+) handbacks, (\d+) interrupts/.exec(out);
  const cells = /(\d+) of \d+ cells non-blank/.exec(out);
  return {
    frame: frame ? frame[1] : 'none',
    pixels: px ? Number(px[1]) : -1,
    // The text page too: a program that never left text mode has no frame hash
    // worth comparing, and a blank one would otherwise match anything.
    cells: cells ? Number(cells[1]) : -1,
    ints: hb ? Number(hb[2]) : -1,
    handbacks: hb ? Number(hb[1]) : -1,
    wav: fs.existsSync(wav)
      ? crypto.createHash('sha256').update(fs.readFileSync(wav)).digest('hex').slice(0, 16)
      : 'none',
  };
}

function main() {
  const base = arg('base');
  if (!base || !fs.existsSync(path.join(base, 'tools/toyvm/run-dos.js'))) {
    console.log('usage: node tools/toyvm/tree-compare.js --base=OTHER_CHECKOUT '
      + '[--set=FILE | --exe=PATH | files...] [--dispatches=80m] [--pass=--flag,--flag]');
    process.exit(2);
  }
  const set = arg('set');
  const one = arg('exe');
  const files = one ? [one]
    : set ? fs.readFileSync(set, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      : process.argv.slice(2).filter(a => !a.startsWith('--'));
  const budget = count(arg('dispatches'), 80e6);
  // Flags handed to BOTH trees, so a bisector switch can be held equal.
  const extra = (arg('pass', '') || '').split(',').filter(Boolean);
  const wavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-compare-'));
  const here = path.resolve(__dirname, '../..');
  let same = 0, diff = 0;
  for (const exe of files) {
    if (!fs.existsSync(exe)) { console.log(`${path.basename(exe)}: MISSING`); continue; }
    // Base first on even rows, this tree first on odd ones: the runs are
    // deterministic, but a machine that is being loaded by something else
    // should not load one side of the comparison more often than the other.
    const first = files.indexOf(exe) % 2 === 0;
    const a = first ? once(base, exe, budget, extra, wavDir, 'base')
      : once(here, exe, budget, extra, wavDir, 'here');
    const b = first ? once(here, exe, budget, extra, wavDir, 'here')
      : once(base, exe, budget, extra, wavDir, 'base');
    const [B, H] = first ? [a, b] : [b, a];
    if (B.fail || H.fail) {
      diff++;
      console.log(`${path.basename(exe).padEnd(16)} *** FAILED ***  base ${B.fail || 'ok'} / here ${H.fail || 'ok'}`);
      continue;
    }
    const ok = B.frame === H.frame && B.pixels === H.pixels && B.cells === H.cells
      && B.ints === H.ints && B.wav === H.wav;
    if (ok) same++; else diff++;
    console.log(`${path.basename(exe).padEnd(16)} ${ok ? 'SAME' : '*** DIFFERS ***'}`
      + `  hb ${B.handbacks}/${H.handbacks}`
      + (ok ? '' : `\n    frame ${B.frame}/${H.frame} px ${B.pixels}/${H.pixels}`
        + ` cells ${B.cells}/${H.cells} ints ${B.ints}/${H.ints}`
        + ` wav ${B.wav}/${H.wav}`));
  }
  console.log(`\n${same}/${same + diff} identical between ${base} and this tree`);
  if (!flag('keep-wavs')) fs.rmSync(wavDir, { recursive: true, force: true });
  process.exit(diff ? 1 : 0);
}

main();
