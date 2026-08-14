#!/usr/bin/env node
// WAT-native WinHelp Phase 1: owned HLP bytes, bounded directory parsing,
// exact checked-in fixture records, and deterministic malformed-file errors.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const HELP = path.join(ROOT, 'test', 'binaries', 'help');

const EXPECTED = {
  'calc.hlp': [['|CF0',17045,16],['|CF1',17070,16],['|CF2',17095,16],['|CF4',17120,16],['|CF5',17145,16],['|CF7',17170,5],['|CONTEXT',14950,2086],['|CTXOMAP',12316,530],['|FONT',12201,106],['|PhrImage',16,837],['|PhrIndex',1933,148],['|SYSTEM',2090,868],['|TOPIC',2967,9225],['|TTLBTREE',12855,2086]],
  'freecell.hlp': [['|CF0',6954,16],['|CF1',6979,16],['|CF2',7004,16],['|CF4',7029,16],['|CF5',7054,16],['|CF7',7079,5],['|CONTEXT',4859,2086],['|CTXOMAP',2753,2],['|FONT',2682,62],['|PhrImage',16,66],['|PhrIndex',1162,40],['|SYSTEM',1211,821],['|TOPIC',2041,632],['|TTLBTREE',2764,2086]],
  'mspaint.hlp': [['|CF0',10434,16],['|CF1',10459,16],['|CF2',10484,16],['|CF4',10509,16],['|CF5',10534,16],['|CF7',10559,5],['|CONTEXT',8339,2086],['|CTXOMAP',6049,186],['|FONT',5924,116],['|PhrImage',16,404],['|PhrIndex',1500,84],['|SYSTEM',1593,839],['|TOPIC',2441,3474],['|TTLBTREE',6244,2086],['|bm0',10573,169]],
  'notepad.hlp': [['|CF0',7883,16],['|CF1',7908,16],['|CF2',7933,16],['|CF4',7958,16],['|CF5',7983,16],['|CF7',8008,5],['|CONTEXT',5788,2086],['|CTXOMAP',3666,18],['|FONT',3595,62],['|PhrImage',16,254],['|PhrIndex',1350,64],['|SYSTEM',1423,824],['|TOPIC',2256,1330],['|TTLBTREE',3693,2086]],
  'sol.hlp': [['|CF0',7851,16],['|CF1',7876,16],['|CF2',7901,16],['|CF4',7926,16],['|CF5',7951,16],['|CF7',7976,5],['|CONTEXT',5756,2086],['|CTXOMAP',3650,2],['|FONT',3579,62],['|PhrImage',16,197],['|PhrIndex',1293,60],['|SYSTEM',1362,838],['|TOPIC',2209,1361],['|TTLBTREE',3661,2086],['|bm0',7990,75]],
  'wordpad.hlp': [['|CF0',11981,16],['|CF1',12006,16],['|CF2',12031,16],['|CF4',12056,16],['|CF5',12081,16],['|CF7',12106,5],['|CONTEXT',9886,2086],['|CTXOMAP',7548,234],['|FONT',7466,73],['|PhrImage',16,526],['|PhrIndex',1622,96],['|SYSTEM',1727,824],['|TOPIC',2560,4897],['|TTLBTREE',7791,2086],['|bm0',12120,169],['|bm1',12298,75]],
};

function buildSyntheticDirectory({ indexed = false, leafCycle = false, indexCycle = false } = {}) {
  const pageSize = 1024;
  const pageCount = indexed ? 3 : 2;
  const dirOff = 16;
  const used = 38 + pageCount * pageSize;
  const reserved = used + 9;
  const internalA = dirOff + reserved;
  const internalB = internalA + 9;
  const entire = internalB + 9;
  const b = Buffer.alloc(entire);
  b.writeUInt32LE(0x00035f3f, 0);
  b.writeUInt32LE(dirOff, 4);
  b.writeUInt32LE(0xffffffff, 8);
  b.writeUInt32LE(entire, 12);
  b.writeUInt32LE(reserved, dirOff);
  b.writeUInt32LE(used, dirOff + 4);
  b[dirOff + 8] = 4;

  const bt = dirOff + 9;
  b.writeUInt16LE(0x293b, bt);
  b.writeUInt16LE(0x0402, bt + 2);
  b.writeUInt16LE(pageSize, bt + 4);
  b.write('|z4'.slice(1), bt + 6, 'ascii'); // "z4"
  b.writeUInt16LE(indexed ? 0 : 0xffff, bt + 26);
  b.writeUInt16LE(0xffff, bt + 28);
  b.writeUInt16LE(pageCount, bt + 30);
  b.writeUInt16LE(indexed ? 2 : 1, bt + 32);
  b.writeUInt32LE(2, bt + 34);
  const pages = bt + 38;

  function leaf(pageNo, name, fileOff, prev, next) {
    const p = pages + pageNo * pageSize;
    let pos = p + 8;
    b.writeUInt16LE(1, p + 2);
    b.writeUInt16LE(prev, p + 4);
    b.writeUInt16LE(next, p + 6);
    pos += b.write(name, pos, 'ascii');
    b[pos++] = 0;
    b.writeUInt32LE(fileOff, pos);
    pos += 4;
    b.writeUInt16LE(p + pageSize - pos, p);
  }

  if (indexed) {
    const p = pages;
    let pos = p + 6;
    b.writeUInt16LE(1, p + 2);
    b.writeUInt16LE(indexCycle ? 0 : 1, p + 4); // leftmost child
    pos += b.write('|B', pos, 'ascii');
    b[pos++] = 0;
    b.writeUInt16LE(2, pos);
    pos += 2;
    b.writeUInt16LE(p + pageSize - pos, p);
    leaf(1, '|A', internalA, 0xffff, 2);
    leaf(2, '|B', internalB, 1, leafCycle ? 1 : 0xffff);
  } else {
    leaf(0, '|A', internalA, 0xffff, 1);
    leaf(1, '|B', internalB, 0, leafCycle ? 0 : 0xffff);
  }
  for (const off of [internalA, internalB]) {
    b.writeUInt32LE(9, off);
    b.writeUInt32LE(0, off + 4);
    b[off + 8] = 4;
  }
  return b;
}

async function main() {
  const wasm = await compileWat(file => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  ctx.exports = e;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const staging = e.get_staging();
  const nameWA = staging + 0x10000;

  let passed = 0;
  let failed = 0;
  function check(name, ok, detail = '') {
    if (ok) {
      passed++;
      console.log('PASS  ' + name);
    } else {
      failed++;
      console.log('FAIL  ' + name + (detail ? '  ' + detail : ''));
    }
  }

  function load(data) {
    bytes.set(data, staging);
    return e.test_help_load_buffer(staging, data.length);
  }

  function readDirectory() {
    const fileWA = e.get_help_file_ptr();
    const out = [];
    for (let i = 0; i < e.get_help_directory_count(); i++) {
      const rec = e.get_help_directory_record(i);
      const nameOff = dv.getUint32(rec + 4, true);
      const nameLen = dv.getUint16(rec + 8, true);
      const name = Buffer.from(bytes.subarray(fileWA + nameOff, fileWA + nameOff + nameLen)).toString('latin1');
      out.push([
        name,
        dv.getUint32(rec + 12, true) - 9,
        dv.getUint32(rec + 16, true),
        dv.getUint16(rec + 10, true),
      ]);
    }
    return out;
  }

  for (const [file, expected] of Object.entries(EXPECTED)) {
    const input = fs.readFileSync(path.join(HELP, file));
    check(`${file} parses`, load(input) === 1,
      `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
    const actual = readDirectory();
    check(`${file} exact internal directory`,
      JSON.stringify(actual.map(x => x.slice(0, 3))) === JSON.stringify(expected),
      `actual=${JSON.stringify(actual)}`);
    check(`${file} internal flags`, actual.every(x => x[3] === 0));
    check(`${file} logical file size`, e.get_help_file_size() === input.length);

    const owned = e.get_help_file_ptr();
    const first = bytes[owned];
    bytes[staging] ^= 0xff;
    check(`${file} bytes copied into WAT-owned storage`, bytes[owned] === first && owned !== staging);

    for (const wanted of ['|SYSTEM', '|TOPIC', '|TTLBTREE']) {
      const enc = Buffer.from(wanted, 'latin1');
      bytes.set(enc, nameWA);
      const index = e.test_help_find_internal(nameWA, enc.length);
      check(`${file} lookup ${wanted} verifies name`, index >= 0 && actual[index][0] === wanted);
    }
    bytes.set(Buffer.from('|SYSTEMX', 'latin1'), nameWA);
    check(`${file} missing internal lookup`, e.test_help_find_internal(nameWA, 8) === -1);
  }

  for (const indexed of [false, true]) {
    const data = buildSyntheticDirectory({ indexed });
    check(`${indexed ? 'indexed' : 'linked'} multi-page directory parses`, load(data) === 1,
      `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
    check(`${indexed ? 'indexed' : 'linked'} leaf order`,
      JSON.stringify(readDirectory().map(x => x[0])) === JSON.stringify(['|A', '|B']));
  }

  const mounted = fs.readFileSync(path.join(HELP, 'freecell.hlp'));
  ctx.vfs.files.set('c:\\fixture.hlp', { data: new Uint8Array(mounted), attrs: 0x20 });
  const mountedPath = Buffer.from('c:\\fixture.hlp\0', 'latin1');
  bytes.set(mountedPath, nameWA);
  check('mounted file loads through raw VFS boundary', e.test_help_load_vfs(nameWA) === 1,
    `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
  check('VFS load publishes exact directory', e.get_help_directory_count() === EXPECTED['freecell.hlp'].length);
  bytes.set(Buffer.from('c:\\missing.hlp\0', 'latin1'), nameWA);
  check('missing VFS file reports stable error', e.test_help_load_vfs(nameWA) === 0 && e.get_help_last_error() === 7);

  const badMagic = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  badMagic[0] = 0;
  check('bad outer magic fails', load(badMagic) === 0 && e.get_help_last_error() === 3);
  check('failed parse publishes no document', e.get_help_file_ptr() === 0 && e.get_help_directory_count() === 0);

  const truncated = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp'))).subarray(0, 12);
  check('truncated outer header fails', load(truncated) === 0 && e.get_help_last_error() === 3);

  const badEntire = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  badEntire.writeUInt32LE(badEntire.length + 1, 12);
  check('oversized logical file fails', load(badEntire) === 0 && e.get_help_last_error() === 3 && e.get_help_last_error_offset() === 12);

  const badInternal = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  const dir = badInternal.readUInt32LE(4);
  const firstLeaf = dir + 9 + 38;
  const firstNameLen = badInternal.indexOf(0, firstLeaf + 8) - (firstLeaf + 8);
  badInternal.writeUInt32LE(badInternal.length - 4, firstLeaf + 8 + firstNameLen + 1);
  check('out-of-range internal file header fails', load(badInternal) === 0 && e.get_help_last_error() === 4);
  check('partial directory is never published', e.get_help_directory_count() === 0);

  const unterminated = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  const udir = unterminated.readUInt32LE(4);
  const upage = udir + 9 + 38;
  unterminated.writeUInt16LE(1024 - 10, upage); // used bytes end inside first name
  check('unterminated page-local name fails', load(unterminated) === 0 && e.get_help_last_error() === 5);

  check('cyclic leaf links fail',
    load(buildSyntheticDirectory({ leafCycle: true })) === 0 && e.get_help_last_error() === 5);
  check('cyclic index descent fails',
    load(buildSyntheticDirectory({ indexed: true, indexCycle: true })) === 0 && e.get_help_last_error() === 5);

  const tooMany = buildSyntheticDirectory();
  const tooManyBt = tooMany.readUInt32LE(4) + 9;
  tooMany.writeUInt32LE(4097, tooManyBt + 34);
  check('directory entry cap enforced', load(tooMany) === 0 && e.get_help_last_error() === 6);
  check('file byte cap enforced', e.test_help_load_buffer(staging, 0x02000001) === 0 && e.get_help_last_error() === 6);
  check('source memory bounds enforced',
    e.test_help_load_buffer(memory.buffer.byteLength - 4, 8) === 0 && e.get_help_last_error() === 1);

  e.test_help_reset();
  check('reset releases parser state',
    e.get_help_file_ptr() === 0 && e.get_help_directory_count() === 0 && e.get_help_last_error() === 0);

  console.log(`--- winhelp-wat-parser: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
