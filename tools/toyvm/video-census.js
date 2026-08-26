#!/usr/bin/env node

'use strict';

// What video mode the DOS corpus actually drives.
//
//   node tools/toyvm/video-census.js --dir=/tmp/demos
//   node tools/toyvm/video-census.js --dir=/tmp/demos --json=/tmp/video.json
//   node tools/toyvm/video-census.js --dir=/tmp/demos --all
//
// The renderer assumed 320x200 linear at A000 because that is what mode 13h is.
// A demo that clears chain-4 in the sequencer is running unchained "mode X"
// instead, where one byte covers four horizontal pixels and the same A000
// offset names four different bytes depending on the map mask -- so a linear
// screenshot of it is not a wrong colour, it is a quarter of the picture
// stretched over the whole frame.
//
// This does not guess from the picture. dos.js models the sequencer, graphics
// controller and CRTC register files, so every number below is read back out of
// the registers the guest wrote: whether it unchained, the geometry the CRTC
// ends up describing, and how it used the map mask (0x0F only = it writes four
// pixels at a time; single-plane values = it plots individual pixels).
//
// One child process per program, for the same reason opcode-census.js uses one:
// a program that traps or wedges must cost one row, not the whole census.

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
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(exe|com)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// The map mask values a program was seen writing, as a shape rather than a
// bitmap: what matters is whether it ever selected a single plane.
function maskShape(seen) {
  if (!seen) return '-';
  const vals = [];
  for (let i = 0; i < 16; i++) if (seen & (1 << i)) vals.push(i);
  const single = vals.filter(v => v && (v & (v - 1)) === 0);
  const parts = [];
  if (vals.includes(0x0F)) parts.push('all4');
  if (single.length) parts.push(`${single.length} single`);
  const other = vals.filter(v => v !== 0x0F && !(v && (v & (v - 1)) === 0));
  if (other.length) parts.push(`${other.length} other`);
  return parts.join('+') || '-';
}

// --- child: one program, one run --------------------------------------------
async function runOne(exe, o) {
  const { runDos } = require('./run-dos');
  const r = await runDos({
    exe, variant: 'tailcall', budget: o.budget, cpu: o.cpu, log: () => {}, autoKey: true,
  });
  return {
    name: path.basename(exe), dispatched: r.dispatched, pixels: r.pixels,
    stuckAt: r.stuckAt || null, video: r.video,
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
      if (line) { try { return resolve(JSON.parse(line)); } catch (e) { /* fall through */ } }
      resolve({
        name: path.basename(exe), video: null,
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
    timeout: Number(arg('timeout', 120)),
  };

  if (one) {
    process.stdout.write(JSON.stringify(await runOne(one, o)) + '\n');
    return;
  }

  const dir = arg('dir');
  if (!dir) {
    console.log('usage: node tools/toyvm/video-census.js --dir=DIR [--json=OUT] [--all]');
    process.exit(2);
  }
  const exes = findExes(dir);
  console.log(`${exes.length} program(s) in ${dir}\n`);

  const rows = [];
  for (const exe of exes) {
    const row = await child(exe, o);
    rows.push(row);
    process.stderr.write(`\r${rows.length}/${exes.length} ${row.name.padEnd(20)}`);
  }
  process.stderr.write('\r' + ' '.repeat(40) + '\r');

  const modex = rows.filter(r => r.video && r.video.unchainCount);
  const tweaked = rows.filter(r => r.video && !r.video.unchainCount
    && (r.video.width !== 320 || r.video.height !== 200 || r.video.start));

  const table = (list) => {
    console.log('| program | mode | geometry | start | unchains | map mask | px |');
    console.log('|---|---|---|--:|--:|---|--:|');
    for (const r of list) {
      const v = r.video;
      console.log(`| ${r.name} | ${v.mode.toString(16)}h${v.planar ? ' X' : ''} `
        + `| ${v.width}x${v.height} | ${v.start} | ${v.unchainCount} `
        + `| ${maskShape(v.masksSeen)} (${v.maskWrites}) | ${(r.pixels || 0).toLocaleString()} |`);
    }
  };

  console.log(`## unchained (mode X): ${modex.length}\n`);
  if (modex.length) table(modex); else console.log('_none_');

  if (tweaked.length) {
    console.log(`\n## chained but retimed: ${tweaked.length}\n`);
    table(tweaked);
  }

  if (flag('all')) {
    console.log('\n## every program\n');
    table(rows.filter(r => r.video));
  }

  const failed = rows.filter(r => r.failed);
  console.log(`\n${rows.length} program(s): ${modex.length} unchained, `
    + `${tweaked.length} retimed the CRTC without unchaining, `
    + `${failed.length} did not complete a run.`);

  const out = arg('json');
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ dir, rows }, null, 1));
    console.log(`\nwrote ${out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
