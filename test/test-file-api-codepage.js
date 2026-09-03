#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createFilesystemImports } = require('../lib/filesystem');

const root = path.join(__dirname, '..');
const handlers = fs.readFileSync(path.join(root, 'src', '09a-handlers.wat'), 'utf8');
const apiTable = require('../src/api_table.json');

for (const name of ['SetFileApisToOEM', 'SetFileApisToANSI', 'AreFileApisANSI']) {
  const api = apiTable.find(entry => entry.name === name);
  assert(api, `${name} is registered`);
  assert.strictEqual(api.nargs, 0, `${name} takes no arguments`);
}

assert.match(handlers,
  /\(func \$handle_SetFileApisToOEM[\s\S]*?\(global\.set \$file_apis_ansi \(i32\.const 0\)\)[\s\S]*?\(call \$host_fs_file_api_ansi \(i32\.const 0\)\)[\s\S]*?\(i32\.const 4\)\)\)\)/,
  'OEM setter changes guest and host process mode and pops the return address');
assert.match(handlers,
  /\(func \$handle_SetFileApisToANSI[\s\S]*?\(global\.set \$file_apis_ansi \(i32\.const 1\)\)[\s\S]*?\(call \$host_fs_file_api_ansi \(i32\.const 1\)\)[\s\S]*?\(i32\.const 4\)\)\)\)/,
  'ANSI setter restores guest and host process mode and pops the return address');
assert.match(handlers,
  /\(func \$handle_AreFileApisANSI[\s\S]*?\(global\.set \$eax \(call \$host_fs_file_api_ansi \(i32\.const -1\)\)\)[\s\S]*?\(i32\.const 4\)\)\)\)/,
  'query reads the shared host process mode');

const memory = new ArrayBuffer(0x2000);
const mem = new Uint8Array(memory);
const ctx = { getMemory: () => memory };
const host = createFilesystemImports(ctx);
const pathAt = 0x100;
const findAt = 0x400;

const writeBytes = bytes => {
  mem.fill(0, pathAt, pathAt + 64);
  mem.set(bytes, pathAt);
};
const ansiPath = Uint8Array.from([
  0x43, 0x3A, 0x5C, 0x63, 0x61, 0x66, 0xE9, 0x2E, 0x74, 0x78, 0x74, 0,
]);
const oemPath = Uint8Array.from([
  0x43, 0x3A, 0x5C, 0x63, 0x61, 0x66, 0x82, 0x2E, 0x74, 0x78, 0x74, 0,
]);
const euroPath = Uint8Array.from([
  0x43, 0x3A, 0x5C, 0x80, 0x75, 0x72, 0x6F, 0x2E, 0x74, 0x78, 0x74, 0,
]);

writeBytes(ansiPath);
const created = host.fs_create_file(pathAt, 0, 2, 0, 0);
assert.notStrictEqual(created >>> 0, 0xFFFFFFFF, 'ANSI APIs create the CP1252 name by default');
host.fs_close_handle(created);

host.fs_file_api_ansi(0);
const siblingHost = createFilesystemImports({ getMemory: () => memory, vfs: ctx.vfs });
assert.strictEqual(siblingHost.fs_file_api_ansi(-1), 0,
  'a second thread-facing import table observes the process OEM mode');
writeBytes(oemPath);
const openedOem = siblingHost.fs_create_file(pathAt, 0, 3, 0, 0);
assert.notStrictEqual(openedOem >>> 0, 0xFFFFFFFF,
  'OEM CP437 byte 0x82 opens the same Unicode é filename');
host.fs_close_handle(openedOem);
const findOem = host.fs_find_first_file(pathAt, findAt, 0);
assert.notStrictEqual(findOem >>> 0, 0xFFFFFFFF);
assert.strictEqual(mem[findAt + 44 + 3], 0x82,
  'FindFirstFileA returns é in the selected OEM code page');
host.fs_find_close(findOem);

host.fs_file_api_ansi(1);
assert.strictEqual(siblingHost.fs_file_api_ansi(-1), 1,
  'restoring ANSI is process-wide across import tables');
writeBytes(ansiPath);
const findAnsi = host.fs_find_first_file(pathAt, findAt, 0);
assert.notStrictEqual(findAnsi >>> 0, 0xFFFFFFFF);
assert.strictEqual(mem[findAt + 44 + 3], 0xE9,
  'SetFileApisToANSI restores CP1252 filename output');
host.fs_find_close(findAnsi);

writeBytes(euroPath);
const createdEuro = host.fs_create_file(pathAt, 0, 2, 0, 0);
assert.notStrictEqual(createdEuro >>> 0, 0xFFFFFFFF,
  'ANSI byte 0x80 decodes as the CP1252 euro sign');
host.fs_close_handle(createdEuro);
const findEuro = host.fs_find_first_file(pathAt, findAt, 0);
assert.notStrictEqual(findEuro >>> 0, 0xFFFFFFFF);
assert.strictEqual(mem[findAt + 44], 0x80,
  'CP1252 filename output encodes the euro sign as byte 0x80');
host.fs_find_close(findEuro);

host.fs_file_api_ansi(0);
mem.fill(0, pathAt, pathAt + 64);
mem.set(Buffer.from('C:\\café.txt\0', 'utf16le'), pathAt);
const openedWide = host.fs_create_file(pathAt, 0, 3, 0, 1);
assert.notStrictEqual(openedWide >>> 0, 0xFFFFFFFF,
  'wide file APIs remain Unicode while narrow APIs use OEM');
host.fs_close_handle(openedWide);

console.log('PASS  Win98 file-API ANSI/OEM selection reaches Kernel32 filenames');
