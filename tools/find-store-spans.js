#!/usr/bin/env node
'use strict';

// Static census for compiler-unrolled `mov [base+disp],same-r32` spans.  This
// mirrors the deliberately narrow runtime matcher: flat 32-bit base-only
// addressing, monotonically contiguous dword displacements, no prefixes.
// Linear byte scanning can still find data embedded in a code section, so a
// static hit is a generality lead rather than evidence that the site is hot.

const fs = require('fs');
const path = require('path');
const { readPE } = require('../lib/pe');

const REG = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

function i32(buf, off) { return buf.readInt32LE(off); }

function storeAt(buf, off, end) {
  if (off + 2 > end || buf[off] !== 0x89) return null;
  const mr = buf[off + 1];
  const mod = mr >>> 6;
  const base = mr & 7;
  const src = (mr >>> 3) & 7;
  if (mod === 3 || (mod === 0 && base === 5)) return null;
  let p = off + 2;
  if (base === 4) {
    if (p >= end || buf[p++] !== 0x24) return null;
  }
  let disp = 0;
  if (mod === 1) {
    if (p >= end) return null;
    disp = (buf[p] << 24) >> 24;
    p++;
  } else if (mod === 2) {
    if (p + 4 > end) return null;
    disp = i32(buf, p);
    p += 4;
  }
  return { len: p - off, base, src, disp };
}

// Cheap provenance hint, not a proof: find a canonical XOR/SUB reg,reg in the
// preceding 32 bytes.  The runtime optimization never trusts this (it tests
// the live value); it exists only to separate likely clears from structure
// initialization in the static corpus report.  Intervening control flow or an
// unrecognised write can make a hint false, and a zero propagated from farther
// away can make it miss.
function nearbyZero(buf, off, reg, begin) {
  const mr = 0xC0 | (reg << 3) | reg;
  for (let p = off - 2; p >= Math.max(begin, off - 32); p--) {
    if ((buf[p] === 0x31 || buf[p] === 0x33 || buf[p] === 0x29 || buf[p] === 0x2B) &&
        buf[p + 1] === mr) return off - p;
  }
  return 0;
}

function findStoreSpans(file, { min = 4 } = {}) {
  const pe = readPE(file);
  const hits = [];
  for (const sec of pe.sections.filter(s => s.isCode && s.rawSize)) {
    const begin = sec.rawOff;
    const end = Math.min(pe.buf.length, begin + sec.rawSize);
    for (let p = begin; p < end;) {
      const first = storeAt(pe.buf, p, end);
      if (!first) { p++; continue; }
      let q = p + first.len;
      let count = 1;
      let expected = first.disp + 4;
      while (q < end) {
        const next = storeAt(pe.buf, q, end);
        if (!next || next.base !== first.base || next.src !== first.src || next.disp !== expected) break;
        q += next.len;
        expected += 4;
        count++;
      }
      if (count >= min) {
        const zeroDistance = nearbyZero(pe.buf, p, first.src, begin);
        hits.push({ file, section: sec.name, va: pe.off2va(p) >>> 0, bytes: q - p,
          count, spanBytes: count * 4, startDisp: first.disp,
          base: REG[first.base], src: REG[first.src], zeroHint: !!zeroDistance,
          zeroDistance });
        p = q;
      } else {
        p++;
      }
    }
  }
  return hits;
}

function walk(input, out) {
  const st = fs.lstatSync(input);
  // Corpus trees may contain convenience links back to a shared binaries
  // directory.  Never follow them: besides duplicate counts, a self-link can
  // recurse forever.
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(input)) walk(path.join(input, name), out);
  } else if (/\.(exe|dll|ocx|cpl|scr)$/i.test(input)) {
    out.push(input);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const minArg = args.find(a => a.startsWith('--min='));
  const min = minArg ? Number(minArg.slice(6)) : 4;
  const inputs = args.filter(a => !a.startsWith('--'));
  if (!inputs.length || !Number.isInteger(min) || min < 2) {
    console.error('usage: node tools/find-store-spans.js <pe-or-dir> [...] [--min=N] [--json]');
    process.exit(2);
  }
  const files = [];
  for (const input of inputs) walk(input, files);
  const hits = [];
  let rejected = 0;
  for (const file of files) {
    try { hits.push(...findStoreSpans(file, { min })); }
    catch { rejected++; }
  }
  const summary = { min, files: files.length, peFiles: files.length - rejected,
    rejected, sites: hits.length, binaries: new Set(hits.map(h => h.file)).size,
    dwords: hits.reduce((n, h) => n + h.count, 0), hits };
  summary.zeroHintSites = hits.filter(h => h.zeroHint).length;
  summary.zeroHintBinaries = new Set(hits.filter(h => h.zeroHint).map(h => h.file)).size;
  summary.zeroHintDwords = hits.filter(h => h.zeroHint).reduce((n, h) => n + h.count, 0);
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    for (const h of hits) console.log(`${h.file}:0x${h.va.toString(16)} ${h.section} ` +
      `${h.count} dwords/${h.spanBytes}B [${h.base}${h.startDisp < 0 ? '-' : '+'}0x${Math.abs(h.startDisp).toString(16)}],${h.src}` +
      (h.zeroHint ? ` zero<=${h.zeroDistance}B` : ''));
    console.log(`store spans >=${min}: ${summary.sites} sites in ${summary.binaries}/${summary.peFiles} PEs ` +
      `(${summary.dwords} dword stores; zero-hint ${summary.zeroHintSites} sites in ${summary.zeroHintBinaries} PEs/` +
      `${summary.zeroHintDwords} stores; ${summary.rejected} non-PE/rejected)`);
  }
}

module.exports = { findStoreSpans, storeAt };
