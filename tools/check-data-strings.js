#!/usr/bin/env node
// Gate: NO lookup or name-match call passes the ADDRESS of a string constant.
//
// This tool used to check the opposite thing. The ordinal-import tables in
// src/08b-dll-loader.wat addressed 01-header.wat's string constants by absolute
// offset — `(call $lookup_api_id (i32.const 0x1130C)) ;; WSAStartup` — and
// inserting or lengthening any earlier string shifted every later offset, with
// no symptom but an ordinal resolving to the WRONG API, in one app, much later.
// Since the trailing comments stated the intent, this checked the code against
// them, and 46 sites passed.
//
// The idiom is gone. Those sites are `"text"` literals now: the WATX compiler
// interns each one into $WATX_STRING_POOL, dedupes it and computes its address,
// so inserting, renaming or resizing a string shifts nothing and there is no
// offset to get wrong. Both packed ordinal-name blobs were deleted outright.
//
// So the gate is inverted rather than retired — a gate that guards nothing but
// keeps reporting OK is worse than none. Its job now is to keep the idiom dead:
// a site that passes an address where a string belongs FAILS, and the tool says
// what to write instead. `--list` still prints matches without failing, which is
// how you survey what is left mid-conversion.
//
// Usage: node tools/check-data-strings.js [--list]
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// Milestone 6 moved these segments and their use sites to the region-relative
// spelling — `(data (region.addr $ORDINAL_NAMES_WSOCK32 0x0C) "…")` and
// `(call $lookup_api_id (region.addr $ORDINAL_NAMES_WSOCK32 0x0C)) ;; WSAStartup`.
// Both forms have to resolve here or this gate quietly stops seeing the very
// tables it exists for: at the conversion commit the raw-literal reader alone
// went from 46 checked sites to 8. The bases come from the generated mirror of
// src/00-regions.wat, so this tool holds no copy of the map.
const { REGIONS } = require('../lib/region-map.generated');

// `(region.addr $NAME 0x40)` -> absolute address, or null for an unknown region.
function regionAddr(name, off) {
  const r = REGIONS[name];
  if (!r) return null;
  return r.base + off;
}

// ── Build addr -> string map from every (data (i32.const N) "...") segment ──
function parseDataSegments(text) {
  const strings = new Map(); // addr -> string starting there
  const re = /\(data\s+\((?:i32\.const\s+(0x[0-9a-fA-F]+|\d+)|region\.addr\s+\$([A-Za-z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+))\)/g;
  let m;
  while ((m = re.exec(text))) {
    let base;
    if (m[1] !== undefined) {
      base = m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
    } else {
      const off = m[3].startsWith('0x') ? parseInt(m[3], 16) : Number(m[3]);
      base = regionAddr(m[2], off);
      // An undeclared region is the compiler's error to report, not this
      // gate's — skip the segment rather than indexing it at NaN.
      if (base === null) continue;
    }
    // Concatenate every quoted chunk until the segment's closing paren.
    const bytes = [];
    let i = re.lastIndex;
    let depth = 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') {
          if (text[j] === '\\' && /[0-9a-fA-F]{2}/.test(text.slice(j + 1, j + 3))) {
            bytes.push(parseInt(text.slice(j + 1, j + 3), 16));
            j += 3;
          } else if (text[j] === '\\') {
            const esc = { n: 10, t: 9, r: 13, '"': 34, "'": 39, '\\': 92 }[text[j + 1]];
            bytes.push(esc === undefined ? text.charCodeAt(j + 1) : esc);
            j += 2;
          } else {
            bytes.push(text.charCodeAt(j));
            j += 1;
          }
        }
        i = j + 1;
        continue;
      }
      if (ch === ';' && text[i + 1] === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      i++;
    }
    let start = 0;
    for (let k = 0; k < bytes.length; k++) {
      if (bytes[k] !== 0) continue;
      strings.set(base + start, String.fromCharCode(...bytes.slice(start, k)));
      start = k + 1;
    }
    if (start < bytes.length) strings.set(base + start, String.fromCharCode(...bytes.slice(start)));
  }
  return strings;
}

let strings = new Map();
for (const f of fs.readdirSync(SRC).filter(f => f.endsWith('.wat'))) {
  const found = parseDataSegments(fs.readFileSync(path.join(SRC, f), 'utf8'));
  for (const [addr, s] of found) if (!strings.has(addr)) strings.set(addr, s);
}

// ── Check every annotated string-address use ────────────────────────────────
// Matches: (call $lookup_api_id (i32.const 0x1130C)) ... ;; WSAStartup
const SITE = /\$(lookup_api_id|str_eq|dll_name_match|str_eq_ci)\b[^;\n]*\((?:i32\.const\s+(0x[0-9a-fA-F]+)|region\.addr\s+\$([A-Za-z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+))\)/;
const COMMENT = /;;\s*([A-Za-z_][A-Za-z0-9_@.]*)\s*$/;

const LIST = process.argv.includes('--list');
let checked = 0, bad = 0;

for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.wat')).sort()) {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const site = SITE.exec(line);
    if (!site) continue;
    const comment = COMMENT.exec(line);
    if (!comment) continue;
    let addr;
    if (site[2] !== undefined) {
      addr = parseInt(site[2], 16);
    } else {
      const off = site[4].startsWith('0x') ? parseInt(site[4], 16) : Number(site[4]);
      addr = regionAddr(site[3], off);
      if (addr === null) continue;
    }
    const want = comment[1];
    const got = strings.get(addr);
    checked++;
    if (got === undefined) {
      // Only flag addresses that fall inside a segment we actually parsed —
      // a const in an unparsed range is not evidence of anything.
      const inRange = [...strings.keys()].some(a => a <= addr && addr < a + 256);
      if (!inRange) continue;
      console.error(`ERROR: ${file}:${i + 1}  0x${addr.toString(16).toUpperCase()} is not a string start ` +
        `(comment says "${want}")`);
      bad++;
    } else if (got !== want) {
      console.error(`ERROR: ${file}:${i + 1}  0x${addr.toString(16).toUpperCase()} holds "${got}" ` +
        `but the comment says "${want}" — a data-segment string was inserted or resized above it.`);
      bad++;
    } else {
      // The address resolves to exactly the string the comment claims — which
      // used to be this tool's PASS. It is now the failure: the idiom itself is
      // retired, so a site spelled this way is a new one, and the drift it
      // reintroduces is invisible until an ordinal resolves to the wrong API.
      if (LIST) {
        console.log(`ok  ${file}:${i + 1}  0x${addr.toString(16).toUpperCase()} "${got}"`);
      } else {
        console.error(`ERROR: ${file}:${i + 1}  passes the ADDRESS of "${got}" ` +
          `(0x${addr.toString(16).toUpperCase()}) where the string itself belongs. ` +
          `Write it as a literal: (call $${site[1]} ... "${got}").`);
      }
      bad++;
    }
  }
}

if (bad && !LIST) {
  console.error('');
  console.error(`${bad} hand-addressed string constant(s). Every string a name-matching or`);
  console.error('API-lookup call needs is a `"text"` literal now: the compiler interns it into');
  console.error('$WATX_STRING_POOL, dedupes it, and computes the address, so nothing shifts when');
  console.error('a string is inserted, renamed or resized. See the 2026-08-31 entry in');
  console.error('tools/watx-src/CHANGELOG.md and src/08b-dll-loader.wat for the converted form.');
  process.exit(1);
}
if (LIST) {
  console.log(`${checked} hand-addressed site(s) listed (${strings.size} strings indexed).`);
} else {
  console.log(`data strings OK: no hand-addressed string constants (${strings.size} strings indexed).`);
}
