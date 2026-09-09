#!/usr/bin/env node

'use strict';

// Which VBE (VESA BIOS Extension) calls the corpus makes, and what it does when
// one is refused.
//
//   node tools/toyvm/vbe-census.js --dir=/tmp/demos --jobs=6 --json=/tmp/vbe.json
//
// The question this exists to answer is "how many modes is it worth rendering",
// and neither of the other censuses can answer it. int-census.js counts calls we
// answer with "unknown" -- but INT 10h AH=4Fh IS answered now, so a VBE call
// never appears there at all; video-census.js reads the VGA registers, which a
// VESA mode does not go through. So this one counts at (function, mode)
// granularity: `4F01 CX=0x112` and `4F02 BX=0x101` are different rows, because
// the work of serving them is per mode.
//
// Two things it reports that a call count on its own would not:
//
//   * whether the answer was GRANTED. Every VBE reply is AX=004Fh for yes and
//     anything else for no, and the machine records both, so a mode a program
//     asked for and was refused is distinguishable from one it was given. The
//     refused list is the work list.
//   * what the program did NEXT. A refusal is only a blocker if the program
//     stops: `exit` means it terminated without drawing (CHROME.EXE's no-VESA
//     path), `13h` means it fell back to a VGA mode and drew, `drew` means it
//     carried on in a VESA mode it did get. Ranking refusals without this
//     counts programs that were never blocked.
//
// The LFB column is the linear-framebuffer bit, 0x4000, OR'd into the mode
// number by a program that wants the whole picture mapped rather than a 64KB
// window. We serve banked modes only, so a program setting it is asking for
// something the machine does not have and the column is there to say who.
//
// One child process per program, same isolation model as int-census.js: a
// program that wedges the emulator takes its own process down and not the run.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

function findExes(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(exe|com)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// The VBE 1.2/2.0 function numbers, so the per-function table reads as names.
const FN = {
  '00': 'controller info',
  '01': 'mode info',
  '02': 'set mode',
  '03': 'get mode',
  '04': 'save/restore state',
  '05': 'window control',
  '06': 'logical scan line',
  '07': 'display start',
  '08': 'DAC palette width',
  '09': 'palette data',
  '0a': 'protected-mode interface',
};

// The VESA-assigned mode numbers, named so a table row says what a program was
// after rather than making the reader look it up.
const MODE = {
  0x100: '640x400x8', 0x101: '640x480x8', 0x102: '800x600x4',
  0x103: '800x600x8', 0x104: '1024x768x4', 0x105: '1024x768x8',
  0x106: '1280x1024x4', 0x107: '1280x1024x8',
  0x10D: '320x200x15', 0x10E: '320x200x16', 0x10F: '320x200x24',
  0x110: '640x480x15', 0x111: '640x480x16', 0x112: '640x480x24',
  0x113: '800x600x15', 0x114: '800x600x16', 0x115: '800x600x24',
  0x116: '1024x768x15', 0x117: '1024x768x16', 0x118: '1024x768x24',
  0x119: '1280x1024x15', 0x11A: '1280x1024x16', 0x11B: '1280x1024x24',
};

// --- child: one program, one run --------------------------------------------
async function runOne(exe, o) {
  const { runDos } = require('./run-dos');
  // The sweep's own flags, so a row here describes the run the sweep
  // photographs rather than a differently-clocked one. The budget matters more
  // than it does for int-census.js and the reason is measured: CHROME.EXE's VBE
  // query sits behind a retrace-paced text scroller, and at the default clock it
  // does not reach the call until ~100M dispatches. A 15M census would have
  // reported it as a program that never asks for VESA.
  const r = await runDos({
    exe, variant: 'tailcall', budget: o.budget, cpu: o.cpu, log: () => {},
    autoKey: true, pitClock: true, soundPref: 'sb',
  });
  const m = r.machine;
  return {
    name: path.basename(exe), exe,
    dispatched: r.dispatched, pixels: r.pixels, cells: r.text.cells,
    exited: !!m.exited, stuckAt: r.stuckAt || null,
    videoMode: m.videoMode, vesaMode: m.vesa ? m.vesa.mode : 0,
    vbe: Object.fromEntries([...m.vbeCalls].map(([k, v]) => [k, [v.n, v.ok]])),
  };
}

// --- parent -----------------------------------------------------------------
function child(exe, o) {
  return new Promise((resolve) => {
    const args = [__filename, `--one=${exe}`, `--dispatches=${o.budget}`, `--cpu=${o.cpu}`];
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), o.timeout * 1000);
    p.on('close', (code, sig) => {
      clearTimeout(kill);
      const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
      if (line) { try { return resolve(JSON.parse(line)); } catch { /* fall through */ } }
      resolve({
        name: path.basename(exe), exe, vbe: {},
        failed: sig === 'SIGKILL' ? 'timeout' : (err.trim().split('\n').pop() || `exit ${code}`),
      });
    });
  });
}

// What the program did after its VBE conversation. Only meaningful for a row
// that made a call at all.
function outcome(r) {
  const drew = (r.pixels || 0) > 0;
  if (r.vesaMode) return drew ? 'vesa+drew' : 'vesa+blank';
  if (drew) return r.exited ? 'fell back, drew, exited' : 'fell back, drew';
  if (r.exited) return 'exited blank';
  return (r.cells || 0) > 0 ? 'text only' : 'blank';
}

function main() {
  const one = arg('one');
  const o = {
    budget: count(arg('dispatches'), 150e6),
    cpu: Number(arg('cpu', 386)),
    timeout: Number(arg('timeout', 180)),
    jobs: Number(arg('jobs', 1)),
  };

  if (one) {
    return runOne(one, o).then((v) => { process.stdout.write(JSON.stringify(v) + '\n'); });
  }

  const dir = arg('dir');
  if (!dir) {
    console.log('usage: node tools/toyvm/vbe-census.js --dir=DIR [--json=OUT] '
      + '[--jobs=N] [--dispatches=N] [--timeout=SECS]');
    process.exit(2);
  }
  const exes = findExes(dir);
  console.log(`${exes.length} program(s) in ${dir}, ${o.budget} dispatches each\n`);

  const rows = new Array(exes.length);
  let next = 0, finished = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= exes.length) return;
      rows[i] = await child(exes[i], o);
      process.stderr.write(`\r${++finished}/${exes.length} ${rows[i].name.padEnd(24)}`);
    }
  };
  return Promise.all(Array.from({ length: Math.max(1, o.jobs) }, worker)).then(() => {
    process.stderr.write('\r' + ' '.repeat(60) + '\r');
    report(rows, dir, o);
  });
}

function report(rows, dir, o) {
  const users = rows.filter(r => r.vbe && Object.keys(r.vbe).length);

  // --- per program ---------------------------------------------------------
  console.log(`## the ${users.length} program(s) of ${rows.length} that call VBE at all\n`);
  console.log('| program | functions | mode info (4F01) | set mode (4F02) | LFB | outcome |');
  console.log('|---|---|---|---|---|---|');
  for (const r of users.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const fns = new Set(), info = [], set = [], lfb = new Set();
    for (const [k, [n, ok]] of Object.entries(r.vbe)) {
      const p = k.split(':');
      fns.add(p[0]);
      if (p.length > 1) {
        const mode = parseInt(p[1], 16);
        const tag = `${p[1]}${ok ? '' : '✗'}`;
        if (p[0] === '01') info.push(tag);
        if (p[0] === '02') set.push(tag);
        if (p.includes('lfb')) lfb.add(p[1]);
        void mode; void n;
      }
    }
    console.log(`| ${r.name} | ${[...fns].sort().map(f => `4F${f.toUpperCase()}`).join(' ')} `
      + `| ${info.sort().join(' ') || '-'} | ${set.sort().join(' ') || '-'} `
      + `| ${[...lfb].join(' ') || '-'} | ${outcome(r)} |`);
  }

  // --- per mode ------------------------------------------------------------
  // The deliverable table: mode -> how many programs want it. A program that
  // asks 4F01 about a mode and never sets it still wants it -- that is exactly
  // what a refusal turns into, since a refused mode cannot be set.
  const want = new Map();     // mode -> Map(name -> {info, set, granted})
  for (const r of users) {
    for (const [k, [, ok]] of Object.entries(r.vbe)) {
      const p = k.split(':');
      if (p.length < 2 || (p[0] !== '01' && p[0] !== '02')) continue;
      const mode = parseInt(p[1], 16);
      if (!want.has(mode)) want.set(mode, new Map());
      const per = want.get(mode);
      const e = per.get(r.name) || { info: false, set: false, granted: false };
      if (p[0] === '01') e.info = true; else e.set = true;
      if (ok) e.granted = true;
      per.set(r.name, e);
    }
  }
  const ranked = [...want].sort((a, b) => b[1].size - a[1].size || a[0] - b[0]);
  console.log(`\n## modes asked for, by how many programs\n`);
  console.log('| mode | what it is | served now | programs | who (✗ = refused) |');
  console.log('|---|---|---|--:|---|');
  for (const [mode, per] of ranked) {
    const served = [...per.values()].some(e => e.granted);
    const who = [...per].map(([n, e]) => `${n}${e.granted ? '' : '✗'}`);
    console.log(`| 0x${mode.toString(16)} | ${MODE[mode] || '?'} | ${served ? 'yes' : 'NO'} `
      + `| ${per.size} | ${who.join(' ')} |`);
  }

  // --- per function --------------------------------------------------------
  const fnProgs = new Map(), fnCalls = new Map();
  for (const r of users) {
    for (const [k, [n]] of Object.entries(r.vbe)) {
      const f = k.split(':')[0];
      fnCalls.set(f, (fnCalls.get(f) || 0) + n);
      if (!fnProgs.has(f)) fnProgs.set(f, new Set());
      fnProgs.get(f).add(r.name);
    }
  }
  console.log(`\n## functions used\n`);
  console.log('| function | what it is | programs | calls |');
  console.log('|---|---|--:|--:|');
  for (const [f, who] of [...fnProgs].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))) {
    console.log(`| 4F${f.toUpperCase()} | ${FN[f] || '?'} | ${who.size} | ${fnCalls.get(f)} |`);
  }

  const failed = rows.filter(r => r.failed);
  console.log(`\n${rows.length} program(s), ${users.length} VBE caller(s), `
    + `${ranked.length} distinct mode(s) asked for, `
    + `${failed.length} did not complete a run`
    + `${failed.length ? `: ${failed.map(f => f.name).join(' ')}` : ''}.`);

  const out = arg('json');
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ dir, budget: o.budget, rows }, null, 1));
    console.log(`wrote ${out}`);
  }
}

Promise.resolve().then(main).catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
