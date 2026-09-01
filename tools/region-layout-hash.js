#!/usr/bin/env node
// region-layout-hash.js — one fingerprint for one placed memory map.
//
// WHY THIS EXISTS
// The wasm and lib/region-map.generated.js are two halves of the same map, and
// since wave 3 the bases in both are the ALLOCATOR's output. Pair a shaken
// artifact with the canonical mirror and nothing fails: every host import reads
// guest memory at the address the mirror names, the guest wrote it somewhere
// else, and the app draws a plausible wrong picture. tools/region-shake-smoke.js
// pairs them correctly on purpose, but `test/run.js --wasm=shaken.wasm` with no
// $WINE_REGION_MAP was silently mismatched and had no way to notice.
//
// So both sides carry a hash of the layout they were built for — the wasm in a
// `wine-region-layout` custom section (emitted by tools/build-compile-wat.js,
// invisible to execution), the mirror in `LAYOUT_HASH` — and the hosts compare
// them at load. A mismatch names both hashes and refuses to run.
//
// THE INPUT IS THE PLACEMENT, NOTHING ELSE. One line per region, `NAME:BASE:SIZE`
// in fixed-width hex, sorted by name, so the hash answers exactly "did any
// region land somewhere else, change size, appear or disappear" and is blind to
// everything that is not that: comments, ownership, declaration order, which
// compiler mode built it. Both artifacts (tail-call and compat) are built from
// one layout and therefore carry the same hash — that is correct, they ARE the
// same map.
//
// CLI:
//   node tools/region-layout-hash.js                  # the canonical layout's hash
//   node tools/region-layout-hash.js --shake=gap      # a shaken one's
//   node tools/region-layout-hash.js --wasm=FILE      # what an artifact carries
//   node tools/region-layout-hash.js --lines          # the hashed text itself
'use strict';

const crypto = require('crypto');

// The wasm custom section both halves meet in. A custom section is skipped by
// every engine, so this is inert at runtime — the artifact grows by ~40 bytes
// and executes identically.
const SECTION_NAME = 'wine-region-layout';

// 16 hex characters of SHA-256. Long enough that a collision is not a thing that
// happens to a map of 175 regions, short enough to read out of an error message
// and compare by eye.
const HASH_CHARS = 16;

const hx = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

// `regions` is anything with { name, base, size } — tools/region-layout.js's
// `regions`, the compiler's `result.regions.regions`, or
// tools/check-region-decls.js's declarations. The `$` on a name is optional and
// stripped, so the two spellings in the tree cannot produce two hashes.
function layoutLines(regions) {
  return regions
    .map(r => `${String(r.name).replace(/^\$/, '')}:${hx(r.base)}:${hx(r.size)}`)
    .sort();
}

function layoutHash(regions) {
  const text = layoutLines(regions).join('\n') + '\n';
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_CHARS);
}

// The placement as the COMPILER reports it, which is the input the build
// stamps into the artifact. Callers must not assemble their own region list:
// tools/check-region-decls.js's declarations, for instance, omit the
// `region.declare-span` entry, and hashing 174 regions on one side and 175 on
// the other produces a permanent, meaningless mismatch. One source, one hash.
function hashOfLayout(shake) {
  const { layout } = require('./region-layout.js');
  return layoutHash(layout(shake ? { shake } : {}).regions);
}

// ---------------------------------------------------------------------------
// The wasm side
// ---------------------------------------------------------------------------

function uleb(n) {
  const out = [];
  let v = n >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}

// A custom section is `0x00, size, nameLen, name, payload` and may appear
// anywhere a section may, so appending it to a finished module is legal and
// leaves every other section byte-for-byte where it was.
function encodeSection(hash) {
  const name = Buffer.from(SECTION_NAME, 'utf8');
  const payload = Buffer.from(hash, 'utf8');
  const body = Buffer.concat([uleb(name.length), name, payload]);
  return Buffer.concat([Buffer.from([0x00]), uleb(body.length), body]);
}

// Stamping is IDEMPOTENT: an already-stamped module has its old section
// removed first. Without that, re-stamping leaves two `wine-region-layout`
// sections and every reader — ours and `WebAssembly.Module.customSections`,
// which returns them in order — takes the FIRST, i.e. the stale one. A check
// that reads the hash the module used to have is worse than no check.
function appendSection(wasmBytes, hash) {
  const bytes = toBuffer(wasmBytes);
  const at = findSection(bytes);
  const body = at ? Buffer.concat([bytes.subarray(0, at.start), bytes.subarray(at.end)]) : bytes;
  return Buffer.concat([body, encodeSection(hash)]);
}

function toBuffer(wasmBytes) {
  if (Buffer.isBuffer(wasmBytes)) return wasmBytes;
  if (ArrayBuffer.isView(wasmBytes)) {
    return Buffer.from(wasmBytes.buffer, wasmBytes.byteOffset, wasmBytes.byteLength);
  }
  return Buffer.from(wasmBytes);
}

// Walks the section list and returns { start, end, hash } for our custom
// section, or null. `start`/`end` bracket the whole section including its id
// and size, so a caller can excise it.
function findSection(wasmBytes) {
  const bytes = toBuffer(wasmBytes);
  if (bytes.length < 8) return null;
  let p = 8; // magic + version
  while (p < bytes.length) {
    const sectionStart = p;
    const id = bytes[p++];
    let size = 0, shift = 0, b;
    do {
      if (p >= bytes.length) return null;
      b = bytes[p++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    const end = p + size;
    if (end > bytes.length) return null;
    if (id === 0) {
      let q = p, nameLen = 0, nshift = 0, nb, truncated = false;
      do {
        if (q >= end) { truncated = true; break; }
        nb = bytes[q++];
        nameLen |= (nb & 0x7f) << nshift;
        nshift += 7;
      } while (nb & 0x80);
      if (!truncated && q + nameLen <= end &&
          bytes.toString('utf8', q, q + nameLen) === SECTION_NAME) {
        return { start: sectionStart, end, hash: bytes.toString('utf8', q + nameLen, end) };
      }
    }
    p = end;
  }
  return null;
}

// Reads the hash back out. Takes bytes rather than a path so a browser host,
// which already has the ArrayBuffer it is about to instantiate, does not have
// to fetch the artifact twice. Returns null when the section is absent — an
// artifact built before this landed, which the caller reports in its own words.
function readSection(wasmBytes) {
  const at = findSection(wasmBytes);
  return at ? at.hash : null;
}

// ---------------------------------------------------------------------------

function main() {
  const arg = (n) => {
    const hit = process.argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
    if (!hit) return null;
    const eq = hit.indexOf('=');
    return eq < 0 ? true : hit.slice(eq + 1);
  };
  const wasm = arg('wasm');
  if (wasm) {
    const found = readSection(require('fs').readFileSync(wasm));
    if (!found) {
      console.error(`region-layout-hash: ${wasm} carries no '${SECTION_NAME}' section`);
      return 1;
    }
    console.log(found);
    return 0;
  }
  const shake = arg('shake');
  const { layout } = require('./region-layout.js');
  const L = layout({ shake: shake === true ? 'gap' : shake });
  if (arg('lines')) { for (const line of layoutLines(L.regions)) console.log(line); return 0; }
  console.log(layoutHash(L.regions));
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); }
  catch (err) { console.error(String(err && err.message || err)); process.exit(2); }
}

module.exports = { layoutHash, layoutLines, hashOfLayout, appendSection, readSection, findSection, encodeSection,
                   SECTION_NAME, HASH_CHARS };
