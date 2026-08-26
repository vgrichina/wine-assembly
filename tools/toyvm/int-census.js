#!/usr/bin/env node

'use strict';

// Which DOS/BIOS service the corpus asks for and does not get.
//
//   node tools/toyvm/int-census.js --dir=/tmp/demos
//   node tools/toyvm/int-census.js --dir=/tmp/demos --json=/tmp/ints.json --blank
//
// The other two censuses answer different questions: video-census.js reads the
// video registers, opcode-census.js reports where the DECODER ran out. Neither
// can see a program that decodes perfectly, drives no video and quits, because
// the one call it needed returned "unknown interrupt" -- which is what
// CATWALK.EXE does. It unpacks four files out of its own tail and then asks DOS
// to run one of them (INT 21h AH=4Bh); with EXEC missing it exits 0 with a
// black screen, indistinguishable here from a crash.
//
// So this counts unhandled calls at FUNCTION granularity (`int 21h AH=4b`, not
// `int 21h`) and ranks them by how many PROGRAMS are affected rather than by
// call count -- a program spinning on one missing call would otherwise outvote
// twenty programs blocked by another.
//
// One child process per program, same isolation model as the other censuses.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

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

// Names for the calls this corpus actually misses, so the table reads as a work
// list instead of a column of hex. Anything unnamed still gets a row.
const NAMES = {
  '21:29': 'parse filename into FCB',
  '21:4b': 'EXEC: load and run a program',
  '21:31': 'terminate and stay resident',
  '21:33': 'get/set break flag',
  '21:38': 'country info',
  '21:39': 'make directory',
  '21:3b': 'change directory',
  '21:44': 'IOCTL',
  '21:56': 'rename',
  '21:57': 'get/set file date',
  '21:5b': 'create new file',
  '15:86': 'BIOS wait (microseconds)',
  '15:88': 'extended memory size',
  '15:c0': 'get system configuration',
  '2f:16': 'DPMI / Windows broadcast',
  '10:1a': 'display combination code',
  '10:12': 'EGA alternate select',
  '10:1b': 'video functionality state',
  '33:00': 'mouse reset',
};

// --- child: one program, one run --------------------------------------------
async function runOne(exe, o) {
  const { runDos } = require('./run-dos');
  const r = await runDos({
    exe, variant: 'tailcall', budget: o.budget, cpu: o.cpu, log: () => {},
    autoKey: true,
  });
  return {
    name: path.basename(exe), exe,
    dispatched: r.dispatched, pixels: r.pixels, cells: r.text.cells,
    exited: !!r.machine.exited, stuckAt: r.stuckAt || null,
    calls: Object.fromEntries(r.machine.unhandledFn),
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
        name: path.basename(exe), exe, calls: {},
        failed: sig === 'SIGKILL' ? 'timeout' : (err.trim().split('\n').pop() || `exit ${code}`),
      });
    });
  });
}

async function main() {
  const one = arg('one');
  const o = {
    budget: count(arg('dispatches'), 15e6),
    cpu: Number(arg('cpu', 386)),
    timeout: Number(arg('timeout', 90)),
    jobs: Number(arg('jobs', 1)),
  };

  if (one) {
    process.stdout.write(JSON.stringify(await runOne(one, o)) + '\n');
    return;
  }

  const dir = arg('dir');
  if (!dir) {
    console.log('usage: node tools/toyvm/int-census.js --dir=DIR [--json=OUT] '
      + '[--blank] [--jobs=N] [--dispatches=N] [--timeout=SECS]');
    process.exit(2);
  }
  const exes = findExes(dir);
  console.log(`${exes.length} program(s) in ${dir}\n`);

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
  await Promise.all(Array.from({ length: Math.max(1, o.jobs) }, worker));
  process.stderr.write('\r' + ' '.repeat(44) + '\r');

  // `--blank` restricts the ranking to programs that put nothing on either
  // surface. That is the bucket the work list is for: a demo that already draws
  // is not blocked by whatever call it also happens to miss.
  const drew = (r) => (r.pixels || 0) > 0 || (r.cells || 0) > 0;
  const pool = flag('blank') ? rows.filter(r => !r.failed && !drew(r)) : rows.filter(r => !r.failed);

  const progs = new Map(), calls = new Map();
  for (const r of pool) {
    for (const [k, n] of Object.entries(r.calls || {})) {
      calls.set(k, (calls.get(k) || 0) + n);
      if (!progs.has(k)) progs.set(k, []);
      progs.get(k).push(r.name);
    }
  }

  const ranked = [...progs].sort((a, b) => b[1].length - a[1].length
    || (calls.get(b[0]) - calls.get(a[0])));

  console.log(`## unhandled services across ${pool.length} program(s)`
    + `${flag('blank') ? ' that drew nothing' : ''}\n`);
  console.log('| call | what it is | programs | calls | who |');
  console.log('|---|---|--:|--:|---|');
  for (const [k, who] of ranked) {
    const [vec, ah] = k.split(':');
    console.log(`| int ${vec}h AH=${ah} | ${NAMES[k] || '-'} | ${who.length} `
      + `| ${calls.get(k)} | ${who.slice(0, 6).join(' ')}${who.length > 6 ? ' …' : ''} |`);
  }

  const failed = rows.filter(r => r.failed);
  console.log(`\n${rows.length} program(s): ${ranked.length} distinct missing call(s), `
    + `${failed.length} did not complete a run.`);

  const out = arg('json');
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ dir, rows }, null, 1));
    console.log(`wrote ${out}`);
  }
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
