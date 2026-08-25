#!/usr/bin/env node

'use strict';

// One screenshot per DOS program, for the whole corpus.
//
//   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots
//   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots --json=/tmp/shots.json
//
// Graphics-mode programs are captured off the VGA planes; text-mode programs
// are captured off the console grid, drawn in the real CP437 strike. Both come
// from run-dos.js, which already picks the right one -- this only fans it out.
//
// The distinction is the point. Before the console model existed, a sweep of
// this corpus photographed A000 for every program, and the 159 text-mode ones
// all came back as the same black rectangle: indistinguishable from a program
// that had crashed on its first instruction. A blank tile here now means the
// program really put nothing on either surface.
//
// One child process per program, same as video-census.js and opcode-census.js:
// a program that traps, wedges or runs the arena dry must cost one row rather
// than the whole sweep.

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

// Two programs in different subdirectories can share a basename (ZERO-BBS.COM
// appears three times in this corpus), so the tile name carries the directory
// when it has to.
function shotName(exe, dir, used) {
  const rel = path.relative(dir, exe);
  let base = path.basename(rel).replace(/\.(exe|com)$/i, '');
  if (used.has(base.toLowerCase())) {
    const parent = path.basename(path.dirname(rel));
    base = `${parent}-${base}`;
  }
  used.add(base.toLowerCase());
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}

// --- child: one program, one run --------------------------------------------
async function runOne(exe, png, o) {
  const { runDos, writePng, writeConsolePng } = require('./run-dos');
  const { vgaGeometry } = require('./dos');
  const r = await runDos({
    exe, variant: 'tailcall', budget: o.budget, cpu: o.cpu, log: () => {}, autoKey: true,
  });
  const text = r.machine.videoMode === 3 && r.text.cells > 0;
  if (text) writeConsolePng(png, r.machine.con);
  else writePng(png, r.vm.mem, r.machine.palette, vgaGeometry(r.machine.vga));
  return {
    name: path.basename(exe), exe, png, surface: text ? 'console' : 'vga',
    mode: r.video.mode, width: r.video.width, height: r.video.height,
    planar: !!r.video.planar, bpp: r.video.bpp,
    dispatched: r.dispatched, pixels: r.pixels, cells: r.text.cells,
    written: r.text.written, stuckAt: r.stuckAt || null,
  };
}

// --- parent -----------------------------------------------------------------
function child(exe, png, o) {
  return new Promise((resolve) => {
    const args = [__filename, `--one=${exe}`, `--png=${png}`,
      `--dispatches=${o.budget}`, `--cpu=${o.cpu}`];
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
        name: path.basename(exe), exe, png: null,
        failed: sig === 'SIGKILL' ? 'timeout' : (err.trim().split('\n').pop() || `exit ${code}`),
      });
    });
  });
}

async function main() {
  const one = arg('one');
  const o = {
    budget: count(arg('dispatches'), 30e6),
    cpu: Number(arg('cpu', 386)),
    timeout: Number(arg('timeout', 180)),
  };

  if (one) {
    process.stdout.write(JSON.stringify(await runOne(one, arg('png'), o)) + '\n');
    return;
  }

  const dir = arg('dir');
  const out = arg('out');
  if (!dir || !out) {
    console.log('usage: node tools/toyvm/shot-sweep.js --dir=DIR --out=DIR '
      + '[--json=OUT] [--dispatches=N] [--timeout=SECS]');
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });

  const exes = findExes(dir);
  const used = new Set();
  console.log(`${exes.length} program(s) in ${dir}\n`);

  const rows = [];
  for (const exe of exes) {
    const png = path.join(out, `${shotName(exe, dir, used)}.png`);
    const row = await child(exe, png, o);
    if (row.png && !fs.existsSync(row.png)) { row.png = null; row.failed ||= 'no png'; }
    rows.push(row);
    process.stderr.write(`\r${rows.length}/${exes.length} ${row.name.padEnd(24)}`);
  }
  process.stderr.write('\r' + ' '.repeat(44) + '\r');

  const shots = rows.filter(r => r.png);
  const blank = shots.filter(r => r.surface === 'vga' && !r.pixels);
  const console_ = shots.filter(r => r.surface === 'console');
  const failed = rows.filter(r => r.failed);

  console.log('| program | surface | mode | geometry | content |');
  console.log('|---|---|---|---|--:|');
  for (const r of rows) {
    if (r.failed) { console.log(`| ${r.name} | - | - | - | ${r.failed} |`); continue; }
    const con = r.surface === 'console';
    const content = con ? `${r.cells} cells` : `${(r.pixels || 0).toLocaleString()} px`;
    console.log(`| ${r.name} | ${r.surface} | ${r.mode.toString(16)}h`
      + `${r.planar ? ` planar ${r.bpp}bpp` : ''} `
      + `| ${con ? '80x25' : `${r.width}x${r.height}`} | ${content} |`);
  }

  console.log(`\n${rows.length} program(s): ${shots.length} captured `
    + `(${console_.length} console, ${shots.length - console_.length} VGA), `
    + `${blank.length} blank, ${failed.length} produced no picture.`);
  console.log(`shots in ${out}`);

  const json = arg('json');
  if (json) {
    fs.writeFileSync(json, JSON.stringify({ dir, out, rows }, null, 1));
    console.log(`wrote ${json}`);
  }
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
