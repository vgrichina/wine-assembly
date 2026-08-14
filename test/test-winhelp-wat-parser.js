#!/usr/bin/env node
// WAT-native WinHelp parser: owned HLP bytes, bounded directory and semantic
// B+trees, exact checked-in topic/context indexes, and malformed-file errors.

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

const EXPECTED_SEMANTICS = {
  'calc.hlp': {
    title: 'Calculator Help', cnt: '', topics: [0,63,123,208,288,358,459,532,625,715,787,859,1095,1130,1168,1205,1237,1315,1701,1829,2015,2106,2191,2275,2364,2554,2719,2807,2895,2986,3149,3383,3564,32768,32982,33194,33436,33576,33641,33721,33822,33880,33930,34114,34442,34726,35018,35314,35551,35787,35887,35991,36146,36276,36353,36521,36589,36784,36939,37291,37447,37612,37772,65536,65670,65725,65930,66011,66117,66155],
    contextCount: 69,
    hashes: [[2443218355,208],[2135795120,715]],
    maps: [[119,33194],[65,65536],[81,0]],
    mapCount: 66,
  },
  'freecell.hlp': {
    title: 'Free Cell', cnt: '', topics: [0,115,383,421],
    contextCount: 3,
    hashes: [[2535747381,0],[3742568226,383],[1048560214,115]],
    maps: [], mapCount: 0,
  },
  'mspaint.hlp': {
    title: 'Paint Help', cnt: 'mspaint.cnt', topics: [0,38,187,313,376,437,514,700,884,1051,1229,1285,1341,1424,1511,1593,1661,1833,1933,1992,2056,2117,2182,2236,2377,2509,2580,2725,2763],
    contextCount: 28,
    hashes: [[2162765496,376],[2099753053,2182]],
    maps: [[30050,1933],[30300,0],[30000,1229]],
    mapCount: 23,
  },
  'notepad.hlp': {
    title: 'Notepad Help', cnt: '', topics: [0,495,994,1032],
    contextCount: 3,
    hashes: [[3742568226,994],[1037673951,0]],
    maps: [[1000,495],[1001,0]], mapCount: 2,
  },
  'sol.hlp': {
    title: 'Solitaire Help', cnt: 'sol.cnt', topics: [0,155,331,1047,1273,1311],
    contextCount: 5,
    hashes: [[2713696239,0],[1807483151,1047]],
    maps: [], mapCount: 0,
  },
  'wordpad.hlp': {
    title: 'WordPad Help', cnt: '', topics: [0,30,63,91,242,311,409,557,643,712,781,855,923,968,1175,1245,1314,1461,1495,1528,1563,1729,2204,2289,2386,2509,2657,2692,2730,2891,3054,32768,32914,33299,33689,33727],
    contextCount: 34,
    hashes: [[2162146575,32768],[2116727712,1245]],
    maps: [[1004,1461],[1031,0],[1029,712]],
    mapCount: 29,
  },
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

function buildSemanticBtree(kind) {
  const pageSize = 512;
  const b = Buffer.alloc(38 + pageSize * 3);
  b.writeUInt16LE(0x293b, 0);
  b.writeUInt16LE(0x0002, 2);
  b.writeUInt16LE(pageSize, 4);
  b.write(kind === 'titles' ? 'Lz' : 'L4', 6, 'ascii');
  b.writeUInt16LE(0, 22);
  b.writeUInt16LE(0, 24);
  b.writeUInt16LE(0, 26);
  b.writeUInt16LE(0xffff, 28);
  b.writeUInt16LE(3, 30);
  b.writeUInt16LE(2, 32);
  b.writeUInt32LE(4, 34);

  const root = 38;
  b.writeUInt16LE(1, root + 2);
  b.writeUInt16LE(1, root + 4);
  b.writeInt32LE(kind === 'titles' ? 20 : 5, root + 6);
  b.writeUInt16LE(2, root + 10);
  b.writeUInt16LE(pageSize - 12, root);

  const values = kind === 'titles'
    ? [[0, 'Alpha'], [10, 'Beta'], [20, 'Gamma'], [30, 'Delta']]
    : [[-10, 0], [-1, 10], [5, 20], [20, 30]];
  for (let leafNo = 1; leafNo <= 2; leafNo++) {
    const leaf = 38 + leafNo * pageSize;
    let pos = leaf + 8;
    b.writeUInt16LE(2, leaf + 2);
    b.writeUInt16LE(leafNo === 1 ? 0xffff : 1, leaf + 4);
    b.writeUInt16LE(leafNo === 1 ? 2 : 0xffff, leaf + 6);
    for (const entry of values.slice((leafNo - 1) * 2, leafNo * 2)) {
      b.writeInt32LE(entry[0], pos);
      pos += 4;
      if (kind === 'titles') {
        pos += b.write(entry[1], pos, 'latin1');
        b[pos++] = 0;
      } else {
        b.writeUInt32LE(entry[1], pos);
        pos += 4;
      }
    }
    b.writeUInt16LE(leaf + pageSize - pos, leaf);
  }
  return b;
}

function buildSyntheticSemanticHelp() {
  const title = Buffer.from('Synthetic Help\0', 'latin1');
  const system = Buffer.alloc(12 + 4 + title.length + 8);
  system.writeUInt16LE(0x036c, 0);
  system.writeUInt16LE(33, 2);
  system.writeUInt16LE(1, 4);
  system.writeUInt16LE(4, 10);
  system.writeUInt16LE(1, 12);
  system.writeUInt16LE(title.length, 14);
  title.copy(system, 16);
  const contents = 16 + title.length;
  system.writeUInt16LE(3, contents);
  system.writeUInt16LE(4, contents + 2);
  system.writeUInt32LE(0, contents + 4);

  const map = Buffer.alloc(18);
  map.writeUInt16LE(2, 0);
  map.writeUInt32LE(7, 2);
  map.writeUInt32LE(20, 6);
  map.writeUInt32LE(8, 10);
  map.writeUInt32LE(0, 14);

  const contentsByName = new Map([
    ['|CONTEXT', buildSemanticBtree('contexts')],
    ['|CTXOMAP', map],
    ['|SYSTEM', system],
    ['|TOPIC', Buffer.alloc(1)],
    ['|TTLBTREE', buildSemanticBtree('titles')],
  ]);
  const names = [...contentsByName.keys()].sort();
  const dirContent = Buffer.alloc(38 + 1024);
  dirContent.writeUInt16LE(0x293b, 0);
  dirContent.writeUInt16LE(0x0402, 2);
  dirContent.writeUInt16LE(1024, 4);
  dirContent.write('z4', 6, 'ascii');
  dirContent.writeUInt16LE(0xffff, 26);
  dirContent.writeUInt16LE(0xffff, 28);
  dirContent.writeUInt16LE(1, 30);
  dirContent.writeUInt16LE(1, 32);
  dirContent.writeUInt32LE(names.length, 34);

  const dirOff = 16;
  const firstInternal = dirOff + 9 + dirContent.length;
  let nextInternal = firstInternal;
  const offsets = {};
  for (const name of names) {
    offsets[name] = nextInternal;
    nextInternal += 9 + contentsByName.get(name).length;
  }
  const file = Buffer.alloc(nextInternal);
  file.writeUInt32LE(0x00035f3f, 0);
  file.writeUInt32LE(dirOff, 4);
  file.writeUInt32LE(0xffffffff, 8);
  file.writeUInt32LE(file.length, 12);
  file.writeUInt32LE(9 + dirContent.length, dirOff);
  file.writeUInt32LE(dirContent.length, dirOff + 4);
  file[dirOff + 8] = 4;

  const leaf = 38;
  let dirPos = leaf + 8;
  dirContent.writeUInt16LE(names.length, leaf + 2);
  dirContent.writeUInt16LE(0xffff, leaf + 4);
  dirContent.writeUInt16LE(0xffff, leaf + 6);
  for (const name of names) {
    dirPos += dirContent.write(name, dirPos, 'latin1');
    dirContent[dirPos++] = 0;
    dirContent.writeUInt32LE(offsets[name], dirPos);
    dirPos += 4;
  }
  dirContent.writeUInt16LE(dirContent.length - dirPos, leaf);
  dirContent.copy(file, dirOff + 9);

  for (const name of names) {
    const content = contentsByName.get(name);
    const off = offsets[name];
    file.writeUInt32LE(9 + content.length, off);
    file.writeUInt32LE(content.length, off + 4);
    content.copy(file, off + 9);
  }
  return { file, offsets };
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

  function load(data, directoryOnly = false) {
    bytes.set(data, staging);
    return directoryOnly
      ? e.test_help_load_directory_buffer(staging, data.length)
      : e.test_help_load_buffer(staging, data.length);
  }

  function readLatin1(ptr, len) {
    return Buffer.from(bytes.subarray(ptr, ptr + len)).toString('latin1');
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

    const semantic = EXPECTED_SEMANTICS[file];
    check(`${file} exact SYSTEM metadata`,
      e.get_help_system_minor() === 33 && e.get_help_system_major() === 1 &&
      e.get_help_system_flags() === 4 && e.get_help_contents_ref() === 0 &&
      readLatin1(e.get_help_title_ptr(), e.get_help_title_len()) === semantic.title);
    check(`${file} exact CNT metadata`,
      readLatin1(e.get_help_cnt_ptr(), e.get_help_cnt_len()) === semantic.cnt);

    const topics = [];
    const topicsByRef = new Map();
    for (let i = 0; i < e.get_help_topic_count(); i++) {
      const rec = e.get_help_topic_record(i);
      const topic = {
        ref: dv.getUint32(rec, true),
        recordOff: dv.getUint32(rec + 4, true),
        title: readLatin1(e.get_help_file_ptr() + dv.getUint32(rec + 8, true), dv.getUint32(rec + 12, true)),
        contextHash: dv.getUint32(rec + 16, true),
        flags: dv.getUint32(rec + 28, true),
      };
      topics.push(topic);
      topicsByRef.set(topic.ref, topic);
    }
    check(`${file} exact canonical topic references`,
      JSON.stringify(topics.map(topic => topic.ref)) === JSON.stringify(semantic.topics));
    check(`${file} title metadata is not guessed from body text`,
      topics.every(topic => topic.title === '' && topic.recordOff === 0));

    const contexts = [];
    for (let i = 0; i < e.get_help_context_count(); i++) {
      const rec = e.get_help_context_record(i);
      contexts.push([dv.getUint32(rec, true), dv.getUint32(rec + 4, true)]);
    }
    check(`${file} exact hashed-context count`, contexts.length === semantic.contextCount);
    check(`${file} hashed contexts annotate canonical topics`, contexts.every(([hash, ref]) => {
      const topic = topicsByRef.get(ref);
      return topic && (topic.flags & 1) !== 0 && topic.contextHash === hash;
    }));
    for (const [hash, ref] of semantic.hashes) {
      check(`${file} resolves context hash ${hash}`, e.test_help_resolve_context_hash(hash) === ref);
    }
    check(`${file} missing context hash is explicit`, e.test_help_resolve_context_hash(0x12345678) === -1);

    check(`${file} exact numeric-context count`, e.get_help_map_count() === semantic.mapCount);
    for (const [id, ref] of semantic.maps) {
      check(`${file} resolves numeric context ${id}`, e.test_help_resolve_context_id(id) === ref);
    }
    check(`${file} missing numeric context is explicit`, e.test_help_resolve_context_id(0x7fffffff) === -1);
  }

  for (const indexed of [false, true]) {
    const data = buildSyntheticDirectory({ indexed });
    check(`${indexed ? 'indexed' : 'linked'} multi-page directory parses`, load(data, true) === 1,
      `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
    check(`${indexed ? 'indexed' : 'linked'} leaf order`,
      JSON.stringify(readDirectory().map(x => x[0])) === JSON.stringify(['|A', '|B']));
  }

  const semanticTree = buildSyntheticSemanticHelp();
  check('two-level semantic B+trees parse', load(semanticTree.file) === 1,
    `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
  check('synthetic SYSTEM title is exact',
    readLatin1(e.get_help_title_ptr(), e.get_help_title_len()) === 'Synthetic Help');
  const syntheticTopics = [];
  for (let i = 0; i < e.get_help_topic_count(); i++) {
    const rec = e.get_help_topic_record(i);
    syntheticTopics.push([
      dv.getUint32(rec, true),
      readLatin1(e.get_help_file_ptr() + dv.getUint32(rec + 8, true), dv.getUint32(rec + 12, true)),
    ]);
  }
  check('two-level title leaves publish exact canonical topics',
    JSON.stringify(syntheticTopics) === JSON.stringify([[0,'Alpha'],[10,'Beta'],[20,'Gamma'],[30,'Delta']]));
  check('two-level signed hash tree resolves both leaves',
    e.test_help_resolve_context_hash(-10) === 0 && e.test_help_resolve_context_hash(20) === 30);
  check('synthetic numeric maps resolve canonical topics',
    e.test_help_resolve_context_id(7) === 20 && e.test_help_resolve_context_id(8) === 0);

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

  function fixtureInternalOffset(file, name) {
    return EXPECTED[file].find(entry => entry[0] === name)[1];
  }

  const missingSystem = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  const systemName = missingSystem.indexOf(Buffer.from('|SYSTEM\0', 'latin1'));
  missingSystem[systemName + 6] = 'N'.charCodeAt(0); // |SYSTEN remains sorted but is not semantic.
  check('missing required SYSTEM file fails explicitly',
    load(missingSystem) === 0 && e.get_help_last_error() === 8);
  check('semantic failure publishes no document or indexes',
    e.get_help_file_ptr() === 0 && e.get_help_topic_count() === 0 &&
    e.get_help_context_count() === 0 && e.get_help_map_count() === 0);

  const badSystemMagic = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  badSystemMagic.writeUInt16LE(0, fixtureInternalOffset('freecell.hlp', '|SYSTEM') + 9);
  check('bad SYSTEM magic fails with semantic error',
    load(badSystemMagic) === 0 && e.get_help_last_error() === 9);

  const unterminatedSystemTitle = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  const freecellSystem = fixtureInternalOffset('freecell.hlp', '|SYSTEM') + 9;
  unterminatedSystemTitle[freecellSystem + 16 + 'Free Cell'.length] = 0x58;
  check('SYSTEM strings are bounded by their record',
    load(unterminatedSystemTitle) === 0 && e.get_help_last_error() === 9);

  const badTitleStructure = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  const freecellTitles = fixtureInternalOffset('freecell.hlp', '|TTLBTREE') + 9;
  badTitleStructure[freecellTitles + 7] = 0x34;
  check('TTLBTREE structure mismatch fails',
    load(badTitleStructure) === 0 && e.get_help_last_error() === 10);

  const duplicateTopic = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  duplicateTopic.writeUInt32LE(0, freecellTitles + 38 + 8 + 5);
  check('duplicate canonical topic references fail',
    load(duplicateTopic) === 0 && e.get_help_last_error() === 10);
  check('bad title tree publishes no partial topic index', e.get_help_topic_count() === 0);

  const topicCapacity = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  topicCapacity.writeUInt32LE(65537, freecellTitles + 34);
  check('topic count cap is enforced',
    load(topicCapacity) === 0 && e.get_help_last_error() === 6);

  const badContextRef = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  const freecellContexts = fixtureInternalOffset('freecell.hlp', '|CONTEXT') + 9;
  badContextRef.writeUInt32LE(999, freecellContexts + 38 + 8 + 4);
  check('hashed context must reference a canonical topic',
    load(badContextRef) === 0 && e.get_help_last_error() === 11);

  const duplicateContextHash = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  duplicateContextHash.writeUInt32LE(
    duplicateContextHash.readUInt32LE(freecellContexts + 38 + 8),
    freecellContexts + 38 + 16);
  check('duplicate or unsorted context hashes fail',
    load(duplicateContextHash) === 0 && e.get_help_last_error() === 11);

  const badMapCount = Buffer.from(fs.readFileSync(path.join(HELP, 'notepad.hlp')));
  const notepadMap = fixtureInternalOffset('notepad.hlp', '|CTXOMAP') + 9;
  badMapCount.writeUInt16LE(3, notepadMap);
  check('CTXOMAP count must match its bounded slice',
    load(badMapCount) === 0 && e.get_help_last_error() === 11);

  const badMapRef = Buffer.from(fs.readFileSync(path.join(HELP, 'notepad.hlp')));
  badMapRef.writeUInt32LE(999, notepadMap + 6);
  check('numeric context must reference a canonical topic',
    load(badMapRef) === 0 && e.get_help_last_error() === 11);

  const semanticIndexCycle = buildSyntheticSemanticHelp();
  semanticIndexCycle.file.writeUInt16LE(0,
    semanticIndexCycle.offsets['|TTLBTREE'] + 9 + 38 + 4);
  check('cyclic semantic index descent fails',
    load(semanticIndexCycle.file) === 0 && e.get_help_last_error() === 10);

  const semanticLeafCycle = buildSyntheticSemanticHelp();
  semanticLeafCycle.file.writeUInt16LE(1,
    semanticLeafCycle.offsets['|TTLBTREE'] + 9 + 38 + 2 * 512 + 6);
  check('cyclic semantic leaf links fail',
    load(semanticLeafCycle.file) === 0 && e.get_help_last_error() === 10);

  const unterminatedTopicTitle = buildSyntheticSemanticHelp();
  const lastTitleNul = unterminatedTopicTitle.offsets['|TTLBTREE'] + 9 + 38 + 2 * 512 +
    8 + (4 + 'Gamma'.length + 1) + 4 + 'Delta'.length;
  unterminatedTopicTitle.file[lastTitleNul] = 0x58;
  check('topic titles cannot scan past their leaf page',
    load(unterminatedTopicTitle.file) === 0 && e.get_help_last_error() === 10);

  e.test_help_reset();
  check('reset releases parser state',
    e.get_help_file_ptr() === 0 && e.get_help_directory_count() === 0 &&
    e.get_help_topic_count() === 0 && e.get_help_context_count() === 0 &&
    e.get_help_map_count() === 0 && e.get_help_last_error() === 0);

  console.log(`--- winhelp-wat-parser: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
