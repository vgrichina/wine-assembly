#!/usr/bin/env node
// Verify API hash table in the compiled WASM data segment
// Usage: node tools/check-hash-table.js [--name=OleInitialize]

const fs = require('fs');
const path = require('path');

const apiTablePath = path.join(__dirname, '..', 'src', 'api_table.json');
const apiTable = JSON.parse(fs.readFileSync(apiTablePath, 'utf8'));

// FNV-1a hash (must match WAT implementation)
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
    h = h >>> 0;
  }
  return h;
}

// Read the generated WAT data segment directly
const watPath = path.join(__dirname, '..', 'src', 'parts', '01b-api-hashes.generated.wat');
const wat = fs.readFileSync(watPath, 'utf8');

// Parse hex bytes from the data segment
const entries = [];
const re = /"((?:\\[0-9a-f]{2})+)"\s+;;\s+(\d+):\s+(\S+)/g;
let m;
while ((m = re.exec(wat)) !== null) {
  const hexStr = m[1];
  const id = parseInt(m[2]);
  const name = m[3];
  // Parse 8 bytes: 4-byte hash + 4-byte id (little-endian)
  const bytes = hexStr.match(/\\([0-9a-f]{2})/g).map(b => parseInt(b.slice(1), 16));
  const hash = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  const storedId = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  entries.push({ hash: hash >>> 0, storedId, name, commentId: id });
}

console.log(`Parsed ${entries.length} entries from WAT data segment`);
console.log(`api_table.json has ${apiTable.length} entries`);

const nameArg = process.argv.find(a => a.startsWith('--name='));
const searchName = nameArg ? nameArg.slice(7) : null;

let mismatches = 0;
for (let i = 0; i < Math.max(entries.length, apiTable.length); i++) {
  const e = entries[i];
  const a = apiTable[i];
  if (!e || !a) {
    console.log(`MISSING: index ${i} — ${e ? 'in WAT' : 'not in WAT'}, ${a ? 'in JSON' : 'not in JSON'}`);
    mismatches++;
    continue;
  }
  const expectedHash = fnv1a(a.name);
  if (e.hash !== expectedHash || e.storedId !== i) {
    console.log(`[${i}] ${a.name}: WAT hash=0x${e.hash.toString(16)} expected=0x${expectedHash.toString(16)}, WAT id=${e.storedId} expected=${i}`);
    mismatches++;
  }
  if (searchName && a.name === searchName) {
    console.log(`>>> ${searchName} at index ${i}: hash=0x${e.hash.toString(16)} (expected 0x${expectedHash.toString(16)}) id=${e.storedId} ${e.hash === expectedHash && e.storedId === i ? 'OK' : 'BROKEN'}`);
  }
}

if (mismatches === 0) console.log('All entries OK.');
else console.log(`${mismatches} issues found.`);

// Also check: does the linear scan work for a target?
if (searchName) {
  const targetHash = fnv1a(searchName);
  console.log(`\nLinear scan for ${searchName} (hash=0x${targetHash.toString(16)}):`);
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].hash === targetHash) {
      console.log(`  Found at index ${i}, id=${entries[i].storedId}, name=${entries[i].name}`);
    }
  }
}
