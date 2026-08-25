#!/usr/bin/env node

'use strict';

// What the DOS corpus is blocked on, as an opcode work list.
//
//   node tools/toyvm/opcode-census.js --dir=/tmp/demos
//   node tools/toyvm/opcode-census.js --dir=/tmp/demos --json=/tmp/census.json
//   node tools/toyvm/opcode-census.js --dir=/tmp/demos --per-program
//
// sweep-dos.js already reports this, but it costs nine minutes because it also
// times four dispatch shells and three JIT tiers. Answering "which opcode do I
// implement next" needs neither, so this runs each program exactly once, with
// one shell, and reports only where the decoder gave up.
//
// One child process per program, for the same reason sweep-dos.js uses one: a
// program that traps or wedges must cost one row, not the whole census.
//
// What it prints, per refused byte: how many programs hit it, how many distinct
// sites, and the bytes that follow -- because the leading byte alone does not
// say whether 0x67 is a real address-size prefix or the 'g' of "got". Several
// give-up sites in this corpus are ASCII data being decoded as code, and those
// must not drive an implementation decision.

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

const hex = (b) => b.toString(16).padStart(2, '0');

// --- child: one program, one run --------------------------------------------
async function runOne(exe, o) {
  const { runDos } = require('./run-dos');
  const r = await runDos({
    exe, variant: 'tailcall', budget: o.budget, cpu: o.cpu, log: () => {}, autoKey: true,
  });
  const sites = [];
  for (const [site, hits] of (r.unimplemented || new Map())) {
    const [seg, off] = site.split(':').map(s => parseInt(s, 16));
    const lin = ((seg << 4) + off) & 0xFFFFF;
    // Six bytes is enough to tell a prefix from a text string and to name the
    // ModRM group a refused 0x0F or 0xD8 belongs to.
    const bytes = [];
    for (let i = 0; i < 6; i++) bytes.push(r.vm.mem[(lin + i) & 0xFFFFF]);
    sites.push({ site, hits, bytes });
  }
  return {
    name: path.basename(exe), dispatched: r.dispatched, pixels: r.pixels,
    stuckAt: r.stuckAt || null, sites,
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
        name: path.basename(exe), sites: [],
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
    console.log('usage: node tools/toyvm/opcode-census.js --dir=DIR [--json=OUT] [--per-program]');
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

  // Group by the refused byte. A program is counted once per byte no matter how
  // many sites it has, because "12 programs need this" is the number that ranks
  // the work and "40 sites" is not.
  const byByte = new Map();
  for (const r of rows) {
    for (const s of r.sites) {
      const b = hex(s.bytes[0]);
      if (!byByte.has(b)) byByte.set(b, { byte: b, programs: new Set(), sites: [] });
      byByte.get(b).programs.add(r.name);
      byByte.get(b).sites.push({ program: r.name, ...s });
    }
  }
  const ranked = [...byByte.values()].sort((a, b) =>
    b.programs.size - a.programs.size || b.sites.length - a.sites.length);

  console.log('| byte | programs | sites | following bytes |');
  console.log('|---|--:|--:|---|');
  for (const g of ranked) {
    // Up to three distinct continuations, which is what separates a real
    // encoding from a byte that happens to start an English word.
    const tails = [...new Set(g.sites.map(s => s.bytes.slice(0, 4).map(hex).join(' ')))];
    console.log(`| \`${g.byte}\` | ${g.programs.size} | ${g.sites.length} | `
      + tails.slice(0, 3).map(t => `\`${t}\``).join(', ')
      + (tails.length > 3 ? ` +${tails.length - 3}` : '') + ' |');
  }

  const blocked = rows.filter(r => r.sites.length).length;
  const failed = rows.filter(r => r.failed).length;
  console.log(`\n${rows.length} program(s): ${blocked} hit an unimplemented opcode, `
    + `${failed} did not complete a run.`);

  if (flag('per-program')) {
    console.log('\n| program | dispatches | px | refused |');
    console.log('|---|--:|--:|---|');
    for (const r of rows.filter(x => x.sites.length)) {
      const bs = [...new Set(r.sites.map(s => hex(s.bytes[0])))].map(b => `\`${b}\``).join(' ');
      console.log(`| ${r.name} | ${(r.dispatched || 0).toLocaleString()} | ${r.pixels || 0} | ${bs} |`);
    }
  }

  const out = arg('json');
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ dir, rows,
      ranked: ranked.map(g => ({ ...g, programs: [...g.programs] })) }, null, 1));
    console.log(`\nwrote ${out}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
