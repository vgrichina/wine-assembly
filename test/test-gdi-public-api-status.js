#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BINARY_ROOT = path.join(ROOT, 'test', 'binaries');
const status = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs', 'gdi-public-api-status.json'), 'utf8'));
const apiNames = new Set(JSON.parse(fs.readFileSync(
  path.join(ROOT, 'src', 'api_table.json'), 'utf8')).map(api => api.name));

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else if (/\.(?:exe|dll)$/i.test(entry.name)) files.push(file);
  }
  return files;
}

function readCString(bytes, offset) {
  let value = '';
  while (offset >= 0 && offset < bytes.length && bytes[offset]) {
    value += String.fromCharCode(bytes[offset++]);
  }
  return value;
}

function gdiImports(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') return [];
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 0x78 >= bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') return [];
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) return [];
  const directories = optional + (magic === 0x10b ? 96 : 112);
  const importRva = bytes.readUInt32LE(directories + 8);
  const sections = optional + optionalSize;
  const rvaToOffset = rva => {
    for (let index = 0; index < sectionCount; index++) {
      const section = sections + index * 40;
      if (section + 40 > bytes.length) return -1;
      const virtualAddress = bytes.readUInt32LE(section + 12);
      const span = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (rva >= virtualAddress && rva < virtualAddress + span) {
        return bytes.readUInt32LE(section + 20) + rva - virtualAddress;
      }
    }
    return -1;
  };
  let descriptor = rvaToOffset(importRva);
  if (descriptor < 0) return [];
  const imports = [];
  for (; descriptor + 20 <= bytes.length; descriptor += 20) {
    const lookupRva = bytes.readUInt32LE(descriptor);
    const nameRva = bytes.readUInt32LE(descriptor + 12);
    if (!lookupRva && !nameRva) break;
    const dll = readCString(bytes, rvaToOffset(nameRva));
    if (!/^gdi32(?:\.dll)?$/i.test(dll)) continue;
    const lookup = rvaToOffset(lookupRva);
    if (lookup < 0) continue;
    for (let index = 0; lookup + index * 4 + 4 <= bytes.length; index++) {
      const entry = bytes.readUInt32LE(lookup + index * 4);
      if (!entry) break;
      if (!(entry & 0x80000000)) {
        imports.push(readCString(bytes, rvaToOffset(entry) + 2));
      }
    }
  }
  return imports;
}

const peFiles = walk(BINARY_ROOT);
const imports = [...new Set(peFiles.flatMap(gdiImports))].sort();
const digest = crypto.createHash('sha256').update(imports.join('\n')).digest('hex');
const notExposed = imports.filter(name => !apiNames.has(name));

assert.strictEqual(peFiles.length, status.corpus.peFileCount,
  'checked-in PE corpus changed; refresh the GDI public API inventory');
assert.strictEqual(imports.length, status.corpus.importCount);
assert.strictEqual(digest, status.corpus.sortedImportSha256,
  'GDI32 import set changed; classify the new public surface explicitly');
assert.deepStrictEqual(notExposed, [...status.notExposed].sort());
assert.strictEqual(imports.length - notExposed.length, status.corpus.representedInApiTable);

console.log(`PASS  GDI corpus inventory: ${imports.length} imports from ${peFiles.length} PE files`);
console.log(`PASS  API table covers ${imports.length - notExposed.length}; ${notExposed.length} remain explicit`);
