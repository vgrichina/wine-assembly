#!/usr/bin/env node
// Run a whole demo corpus under two sets of run-dos.js flags and check the two
// arms are indistinguishable.
//
//   node tools/toyvm/equiv-dos.js --dir=/tmp/demos --arm=--no-crossflags
//   node tools/toyvm/equiv-dos.js A.EXE B.EXE --arm=--no-fuse --dispatches=2m
//   node tools/toyvm/equiv-dos.js --dir=/tmp/demos --arm=--no-deadflags --allow-arena
//
// WHY A TOOL. Every compiler switch in this VM is justified the same way: the
// two arms run the same guest, so they must produce the same frame, the same
// handbacks, the same interrupts and the same stopping cs:ip over the whole
// corpus, and anything else is a bug rather than a retiming. That sweep has now
// been written four times -- for fusion, for lazy flags, for the fused-branch
// specialization and for dead-flag elimination -- as a throwaway /tmp/equiv-*.sh
// each time, and each one is gone. It is also what CAUGHT the one real bug in
// the dead-flag work (DEMO5.EXE, `cmp / cmc / ret`).
//
// Nothing else covers it: sweep-dos.js compares dispatch SHELLS and JIT tiers,
// not two flag arms, and bench-dos.js checks cross-arm agreement only on its
// ten-program core set and only on the dispatch count and frame hash.
//
// A differing arena footprint is a legitimate outcome for a switch that changes
// how many words a block occupies (fusion does), so `--allow-arena` downgrades
// the arena/compile/recycle columns to a note. Everything else must match.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const opt = (n, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
  return hit === undefined ? d : hit.slice(n.length + 3);
};
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

// The report lines, with the parts that are allowed to differ taken out: wall
// clock and throughput are properties of the box, and the flagless-op count is
// the very thing an arm is being asked to change.
function normalize(out, allowArena) {
  const lines = out.split('\n');
  const keep = [];
  for (const raw of lines) {
    let l = raw;
    if (/^\S.*variant=/.test(l)) continue;               // header, carries wall time
    l = l.replace(/, \d+ flagless ops of \d+/, '');
    l = l.replace(/, \d+ traced edges/, '');
    l = l.replace(/, \d+ spin loops/, '');
    l = l.replace(/, \d+ regs pinned/, '');
    l = l.replace(/[\d.]+[KM]\/s in wasm \(\d+% of wall\)/, 'RATE');
    if (allowArena) {
      // A switch that changes how many words a block occupies moves the arena
      // layout, and with it the boundary the arena is recycled at -- so the
      // number of times a region is recompiled, and the number of self-patch
      // breaks that recompile notices, are downstream of the same choice. What
      // must NOT move is on the other lines: the frame, the pixels, the
      // console, the interrupts and the stopping cs:ip.
      l = l.replace(/\d+ traces \(\d+KB of arena, \d+ recycles\)/, 'ARENA');
      l = l.replace(/^\s*\d+ self-modify breaks/, '  SMC');
    }
    keep.push(l.trimEnd());
  }
  return keep.join('\n').trim();
}

function run(exe, extra, o) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'run-dos.js'), exe,
      `--dispatches=${o.dispatches}`, ...extra];
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), o.timeout * 1000);
    p.on('close', (code, sig) => {
      clearTimeout(kill);
      resolve({ out, timedOut: sig === 'SIGKILL', code });
    });
  });
}

function findExes(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findExes(p));
    else if (/\.(exe|com)$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

async function main() {
  const o = {
    dispatches: opt('dispatches', '8m'),
    timeout: Number(opt('timeout', '180')),
    jobs: Number(opt('jobs', '2')),
  };
  const armB = process.argv.slice(2).filter((a) => a.startsWith('--arm='))
    .map((a) => a.slice(6));
  if (!armB.length) {
    console.error('need at least one --arm=FLAG (the flags for the second arm)');
    process.exit(2);
  }
  const armA = process.argv.slice(2).filter((a) => a.startsWith('--base='))
    .map((a) => a.slice(7));
  const allowArena = flag('allow-arena');

  const dir = opt('dir', null);
  const exes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (dir) exes.push(...findExes(dir));
  if (!exes.length) { console.error('no programs'); process.exit(2); }

  let same = 0, diff = 0, broke = 0;
  const queue = exes.slice();
  const worker = async () => {
    for (;;) {
      const exe = queue.shift();
      if (!exe) return;
      const name = path.basename(exe);
      const [a, b] = [await run(exe, armA, o), await run(exe, armB, o)];
      if (a.timedOut || b.timedOut) {
        broke++;
        console.log(`TIMEOUT ${name}`);
        continue;
      }
      const na = normalize(a.out, allowArena), nb = normalize(b.out, allowArena);
      if (na === nb) { same++; console.log(`SAME ${name}`); continue; }
      diff++;
      console.log(`DIFF ${name}`);
      const la = na.split('\n'), lb = nb.split('\n');
      for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) {
          console.log(`  base: ${la[i] === undefined ? '(none)' : la[i].trim()}`);
          console.log(`  arm : ${lb[i] === undefined ? '(none)' : lb[i].trim()}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.jobs) }, worker));
  console.log(`\n${exes.length} programs: ${same} same, ${diff} differ, ${broke} timed out`);
  process.exit(diff || broke ? 1 : 0);
}

main();
