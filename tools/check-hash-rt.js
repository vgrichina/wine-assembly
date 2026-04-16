#!/usr/bin/env node
// Check hash table integrity during execution
// Patches run.js to check between batches
const fs = require('fs');
const path = require('path');

// Just check the data segment in the WAT to verify it's correct,
// then use --watch to find what writes to 0x01362000 at runtime

const HASH_TABLE_GUEST = 0x02350000; // g2w⁻¹(0x01362000) = 0x01362000 + 0x01000000 - 0x12000
console.log(`Hash table WASM addr: 0x01362000`);
console.log(`Corresponding guest addr: 0x${HASH_TABLE_GUEST.toString(16)}`);
console.log(`Use --watch=0x${HASH_TABLE_GUEST.toString(16)} to find what overwrites it`);
console.log();
console.log('Or check memory directly after import patching...');

// Actually, let's check via the built wasm
const wasmBytes = fs.readFileSync(path.join(__dirname, '..', 'build', 'wine-assembly.wasm'));
const mod = new WebAssembly.Module(wasmBytes);
const sections = WebAssembly.Module.customSections(mod, 'name');
console.log(`WASM module has ${WebAssembly.Module.imports(mod).length} imports`);
