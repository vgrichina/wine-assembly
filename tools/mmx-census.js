#!/usr/bin/env node
// Census of MMX use across a corpus of PEs, and -- the part that matters --
// which of them actually *gate* it on CPUID.
//
//   node tools/mmx-census.js [path ...] [--min=N] [--all] [--json] [--detail]
//
// `--detail` (one file at a time) prints the MMX sites as VAs, collapsed into
// clusters, plus the bit-23 test sites. Use it to tell a real vectorised leaf
// from a linear-sweep artefact: genuine MMX arrives in tight clusters inside
// one function, while data misread as `0F 6F` scatters at random and usually
// lands outside any code section.
//
// With no paths, walks test/binaries (following symlinks; the subdirectories
// are symlinks in a worktree, so a bare `find` misses ~95% of the corpus).
//
// Why this exists: `--no-mmx` only flips the CPUID MMX bit, so an A/B ratio
// needs a guest that picks its own path at runtime. Two binaries have already
// burned a session by looking dual-path and not being one -- AVS 2.8.2 and
// in_mod.dll both compute a feature flag and then run MMX regardless. So the
// useful output is not "has MMX" but "has MMX *and* tests leaf-1 EDX bit 23",
// which is the short list worth confirming at runtime with
// `--handler-hist --handler-hist-thread=N` in both configs.
//
// Detection is a linear sweep, so data-in-code inflates counts. Treat a single
// hit as a lead and a dense cluster as signal -- same caveat as find-loops.js.
'use strict';

const fs = require('fs');
const path = require('path');
const { readPE } = require('../lib/pe');

// --- MMX opcode map (second byte, after a bare 0x0F with no 66/F2/F3 prefix) ---
// A 66/F2/F3 prefix turns these into the SSE2/SSE forms (movdqa, movdqu, ...),
// which are a different question, so the prefix check is not optional.
const MMX_OPS = new Set();
for (const [lo, hi] of [
  [0x60, 0x6F],   // punpck*, packss*, movd, movq
  [0x71, 0x77],   // psll/psrl/psra imm, pcmpeq*, emms
  [0x7E, 0x7F],   // movd/movq store
  [0xD1, 0xD5], [0xD8, 0xDF],
  [0xE0, 0xE5], [0xE8, 0xEF],
  [0xF1, 0xF6], [0xF8, 0xFE],
]) for (let b = lo; b <= hi; b++) MMX_OPS.add(b);

const PREFIXES = new Set([0x66, 0xF2, 0xF3]);
// Segment/addr/opsize/lock/rep prefixes that can sit between an instruction
// start and its 0x0F escape without changing MMX-ness.
const BENIGN_PREFIXES = new Set([0x2E, 0x36, 0x3E, 0x26, 0x64, 0x65, 0x67, 0xF0]);

function scan(buf, start, end) {
  const r = { mmx: 0, emms: 0, cpuid: 0, bit23: 0, bit23Sites: [], mmxSites: [] };
  for (let i = start; i < end - 1; i++) {
    if (buf[i] !== 0x0F) continue;
    const op = buf[i + 1];

    if (op === 0xA2) { r.cpuid++; continue; }               // cpuid

    // bt reg, 23  ->  0F BA E0+r 17
    if (op === 0xBA && i + 3 < end && buf[i + 2] >= 0xE0 && buf[i + 2] <= 0xE7 && buf[i + 3] === 0x17) {
      r.bit23++; r.bit23Sites.push(i); continue;
    }

    if (!MMX_OPS.has(op)) continue;
    // Walk back over benign prefixes; bail if we meet 66/F2/F3 (SSE form).
    let j = i - 1, sse = false;
    while (j >= start && (PREFIXES.has(buf[j]) || BENIGN_PREFIXES.has(buf[j]))) {
      if (PREFIXES.has(buf[j])) { sse = true; break; }
      j--;
    }
    if (sse) continue;
    r.mmx++;
    if (op === 0x77) r.emms++;
    if (r.mmxSites.length < 4096) r.mmxSites.push(i);
  }

  // Bit-23 tests that are not 0F-escaped, scanned separately so the 0F loop
  // above stays readable.
  for (let i = start; i < end - 5; i++) {
    const b = buf[i];
    // and eax,0x800000 (25 ..) | and r32,0x800000 (81 E0+r ..) | test r32,0x800000 (F7 C0+r ..)
    const isAndEax = b === 0x25;
    const isAndR = b === 0x81 && buf[i + 1] >= 0xE0 && buf[i + 1] <= 0xE7;
    const isTestR = b === 0xF7 && buf[i + 1] >= 0xC0 && buf[i + 1] <= 0xC7;
    const immAt = isAndEax ? i + 1 : (isAndR || isTestR) ? i + 2 : -1;
    if (immAt >= 0 && immAt + 3 < end &&
        buf[immAt] === 0x00 && buf[immAt + 1] === 0x00 &&
        buf[immAt + 2] === 0x80 && buf[immAt + 3] === 0x00) {
      r.bit23++; r.bit23Sites.push(i); continue;
    }
    // shr r32,0x17  ->  C1 E8+r 17   (the idiom that shifts bit 23 down to bit 0)
    if (b === 0xC1 && buf[i + 1] >= 0xE8 && buf[i + 1] <= 0xEF && buf[i + 2] === 0x17) {
      r.bit23++; r.bit23Sites.push(i);
    }
  }
  return r;
}

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }          // statSync follows symlinks
    if (st.isDirectory()) walk(p, out);
    else if (/\.(exe|dll|scr|ape|ax|ocx|cpl|drv)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = n => argv.some(a => a === `--${n}` || a.startsWith(`--${n}=`));
  const val = (n, d) => {
    const hit = argv.find(a => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
  };
  const paths = argv.filter(a => !a.startsWith('--'));
  const minMmx = Number(val('min', 8));
  const showAll = flag('all');
  const asJson = flag('json');

  let files = [];
  for (const p of paths.length ? paths : [path.join(__dirname, '..', 'test', 'binaries')]) {
    let st;
    try { st = fs.statSync(p); } catch { console.error(`mmx-census: cannot stat ${p}`); continue; }
    if (st.isDirectory()) walk(p, files); else files.push(p);
  }
  files = [...new Set(files)].sort();

  const detail = flag('detail');
  const rows = [];
  for (const f of files) {
    let pe;
    try { pe = readPE(f); } catch { continue; }               // 16-bit NE, junk, etc.
    const tot = { mmx: 0, emms: 0, cpuid: 0, bit23: 0 };
    const mmxVas = [], bitVas = [];
    for (const s of pe.sections) {
      if (!s.isCode) continue;
      const start = s.rawOff;
      const size = Math.min(s.rawSize, pe.buf.length - start);
      if (!(size > 0)) continue;
      const r = scan(pe.buf, start, start + size);
      tot.mmx += r.mmx; tot.emms += r.emms; tot.cpuid += r.cpuid; tot.bit23 += r.bit23;
      for (const off of r.mmxSites) mmxVas.push(pe.off2va(off));
      for (const off of r.bit23Sites) bitVas.push(pe.off2va(off));
    }

    // Cluster the sites. This is the precision filter, and it is not optional:
    // a linear sweep resyncs constantly on x86, so a `0F` that is really the
    // tail of a previous instruction reads as `pcmpgtd` and so on. Real MMX is
    // written in tight vectorised leaves -- in_mod puts 82 instructions in 2
    // clusters -- whereas noise scatters one or two hits per site across the
    // whole image (RCT: 588 "instructions" in 249 clusters, every one a
    // misdecode). So the honest signal is the size of the biggest cluster, not
    // the raw count.
    const sorted = mmxVas.slice().sort((a, b) => a - b);
    const clusters = [];
    for (const v of sorted) {
      const last = clusters[clusters.length - 1];
      if (!last || v - last.end > 0x200) clusters.push({ start: v, end: v, n: 1 });
      else { last.end = v; last.n++; }
    }
    const biggest = clusters.reduce((m, c) => Math.max(m, c.n), 0);
    tot.clusters = clusters.length;
    tot.biggest = biggest;
    if (detail) {
      const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
      console.log(`\n${f}: ${tot.mmx} mmx, ${tot.emms} emms, ${tot.cpuid} cpuid, ${tot.bit23} bit23`);
      console.log(`  ${clusters.length} MMX cluster(s):`);
      for (const c of clusters.sort((a, b) => b.n - a.n).slice(0, 20)) {
        console.log(`    ${hex(c.start)}..${hex(c.end)}  ${String(c.n).padStart(5)} instr` +
          `${c.n === 1 ? '   <- lone hit, likely data' : ''}`);
      }
      if (bitVas.length) console.log(`  bit-23 tests: ${bitVas.map(hex).join(', ')}`);
      continue;
    }
    // Gate on the biggest cluster, not the raw count: see the note above.
    if (!showAll && tot.biggest < minMmx) continue;
    // Instructions per cluster is the sharpest discriminator. Noise resyncs at
    // random, so it lands 1-3 hits per site (RCT 2.4, Heroes II 1.6, both
    // measured as 0 MMX retired at runtime); real vectorised code packs many
    // (in_mod 13.5, AVS 40, both measured as heavy MMX at runtime).
    const density = tot.clusters ? tot.mmx / tot.clusters : 0;
    tot.density = density;
    rows.push({
      file: path.relative(process.cwd(), f),
      size: pe.buf.length,
      ...tot,
      verdict: (tot.biggest < minMmx || density < 4) ? 'noise'
        : (tot.cpuid > 0 && tot.bit23 > 0) ? 'GATED?'
          : 'unconditional',
    });
  }

  if (detail) return;   // the per-file dump above is the whole output
  rows.sort((a, b) => (b.verdict === 'GATED?') - (a.verdict === 'GATED?') || b.mmx - a.mmx);

  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }

  console.log(`mmx-census: ${files.length} PEs scanned, ${rows.length} with a cluster of >= ${minMmx} MMX instructions`);
  console.log('("mmx" is the raw hit count; "big" is the largest single cluster, which is the number to trust.)\n');
  console.log('  verdict         mmx   clus   big  dens  emms  cpuid  bit23   file');
  for (const r of rows) {
    console.log(`  ${r.verdict.padEnd(14)} ${String(r.mmx).padStart(5)} ${String(r.clusters).padStart(6)} ` +
      `${String(r.biggest).padStart(5)} ${r.density.toFixed(1).padStart(5)} ${String(r.emms).padStart(5)} ` +
      `${String(r.cpuid).padStart(6)} ${String(r.bit23).padStart(6)}   ${r.file}`);
  }
  const gated = rows.filter(r => r.verdict === 'GATED?');
  console.log(`\n  ${gated.length} candidate(s) test leaf-1 EDX bit 23 and use real MMX.`);
  console.log('  A candidate is only a lead: AVS 2.8.2 and in_mod.dll both look like this');
  console.log('  and run MMX regardless. Confirm with --handler-hist in both configs.');
}

main();
