#!/usr/bin/env node
// Dump VS_VERSION_INFO (RT_VERSION) from a PE: file/product version, company,
// original filename, and every StringFileInfo pair.
//
// Usage: node tools/pe-version.js <pe> [<pe>...] [--json]
//
// Why this exists: the corpus mixes DLLs from several DirectX releases and the
// only thing that says which is which is the version resource. macOS strings(1)
// has no -e flag, so the UTF-16 block is invisible to a grep, and
// parse-rsrc.js only walks menu/dialog/string/icon types.

const fs = require('fs');
const path = require('path');
const { readPE } = require(path.join(__dirname, '..', 'lib', 'pe.js'));

const RT_VERSION = 16;

function findVersionBlob(file) {
  const pe = readPE(file);
  const buf = pe.buf;
  const rsrc = pe.sections.find(s => s.name === '.rsrc');
  if (!rsrc) return null;
  const base = rsrc.rawOff;

  // Resource dirs are three levels deep: type -> name -> language.
  function firstChild(off, wantId) {
    const named = buf.readUInt16LE(base + off + 12);
    const ids = buf.readUInt16LE(base + off + 14);
    let e = off + 16;
    for (let i = 0; i < named + ids; i++) {
      const id = buf.readUInt32LE(base + e);
      const child = buf.readUInt32LE(base + e + 4);
      if (wantId === undefined || id === wantId) return child;
      e += 8;
    }
    return null;
  }

  const typeDir = firstChild(0, RT_VERSION);
  if (typeDir === null || !(typeDir & 0x80000000)) return null;
  const nameDir = firstChild(typeDir & 0x7fffffff);
  if (nameDir === null || !(nameDir & 0x80000000)) return null;
  const dataEntry = firstChild(nameDir & 0x7fffffff);
  if (dataEntry === null || (dataEntry & 0x80000000)) return null;

  const rva = buf.readUInt32LE(base + dataEntry);
  const size = buf.readUInt32LE(base + dataEntry + 4);
  const off = rva - rsrc.rva + base;
  if (off < 0 || off + size > buf.length) return null;
  return buf.subarray(off, off + size);
}

// VS_VERSION_INFO is a tree of {wLength, wValueLength, wType, szKey (UTF-16,
// NUL-terminated), padding to dword, Value, Children}.
function parseNode(buf, off) {
  if (off + 6 > buf.length) return null;
  const len = buf.readUInt16LE(off);
  const valueLen = buf.readUInt16LE(off + 2);
  const type = buf.readUInt16LE(off + 4);
  if (len < 6 || off + len > buf.length) return null;
  let p = off + 6;
  let key = '';
  while (p + 1 < buf.length) {
    const c = buf.readUInt16LE(p);
    p += 2;
    if (c === 0) break;
    key += String.fromCharCode(c);
  }
  p = (p + 3) & ~3;
  const valueOff = p;
  // wValueLength counts characters for text values, bytes for binary ones.
  const valueBytes = type === 1 ? valueLen * 2 : valueLen;
  let value = null;
  if (valueBytes > 0 && valueOff + valueBytes <= buf.length) {
    if (type === 1) {
      value = buf.toString('utf16le', valueOff, valueOff + valueBytes).replace(/\0+$/, '');
    } else {
      value = buf.subarray(valueOff, valueOff + valueBytes);
    }
  }
  const childOff = (valueOff + valueBytes + 3) & ~3;
  const children = [];
  let c = childOff;
  while (c < off + len) {
    const child = parseNode(buf, c);
    if (!child || child.len === 0) break;
    children.push(child);
    c = (c + child.len + 3) & ~3;
  }
  return { len, key, type, value, children };
}

function verStr(ms, ls) {
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
}

function describe(file) {
  const out = { file, fileVersion: null, productVersion: null, strings: {} };
  const blob = findVersionBlob(file);
  if (!blob) return out;
  const root = parseNode(blob, 0);
  if (!root) return out;

  if (Buffer.isBuffer(root.value) && root.value.length >= 52 &&
      root.value.readUInt32LE(0) === 0xfeef04bd) {
    out.fileVersion = verStr(root.value.readUInt32LE(8), root.value.readUInt32LE(4));
    out.productVersion = verStr(root.value.readUInt32LE(16), root.value.readUInt32LE(12));
  }
  for (const sfi of root.children) {
    if (sfi.key !== 'StringFileInfo') continue;
    for (const table of sfi.children) {
      for (const pair of table.children) {
        if (typeof pair.value === 'string') out.strings[pair.key] = pair.value;
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter(a => !a.startsWith('--'));
if (files.length === 0) {
  console.error('Usage: node tools/pe-version.js <pe> [<pe>...] [--json]');
  process.exit(2);
}

const results = files.map(f => {
  const r = describe(f);
  r.size = fs.statSync(f).size;
  return r;
});

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.file}  (${r.size} bytes)`);
    if (!r.fileVersion && Object.keys(r.strings).length === 0) {
      console.log('  no VS_VERSION_INFO resource');
      continue;
    }
    if (r.fileVersion) console.log(`  FixedFileInfo   file=${r.fileVersion} product=${r.productVersion}`);
    for (const [k, v] of Object.entries(r.strings)) {
      console.log(`  ${k.padEnd(18)}${v}`);
    }
  }
}
