#!/usr/bin/env node
// WAT-native WinHelp parser: owned HLP bytes, bounded directory and semantic
// B+trees, exact checked-in topic/context indexes, and malformed-file errors.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
    phraseCount: 199, phraseSize: 940, phrases: [[0,'+'],[5,'all'],[198,'yth']],
    rawTopicLengths: [63,60,85,80,70,101,73,93,90,72,72,236,35,38,37,32,78,386,128,186,91,85,84,89,190,165,88,88,91,163,234,181,119,214,212,242,140,65,80,101,58,50,184,328,284,292,296,237,236,100,104,155,130,77,168,68,195,155,352,156,165,160,147,134,55,205,81,106,38,0],
    rawTopicBytes: 9453,
    rawTopicHash: '29a572c4051d6dfb19a2d308dfed6879dd5211a3ce03f5cdf1c48f0528a701dc',
    formatCounts: [69,69,0,556],
    formattedKinds: { 2: 4, 3: 152, 4: 69, 5: 331 }, payloadBytes: 2150,
    fontFaces: ['MS Sans Serif'],
    fonts: [[0,16,3,0,400,257,257],[0,16,3,32,400,257,257],[0,14,3,32,400,257,257],[0,16,3,1,700,257,257],[0,14,3,0,400,257,257],[0,16,3,0,400,0,257]],
    bitmaps: [],
  },
  'freecell.hlp': {
    title: 'Free Cell', cnt: '', topics: [0,115,383,421],
    contextCount: 3,
    hashes: [[2535747381,0],[3742568226,383],[1048560214,115]],
    maps: [], mapCount: 0,
    phraseCount: 17, phraseSize: 66, phrases: [[0,'.'],[4,'card'],[16,'to']],
    rawTopicLengths: [115,268,38,0],
    rawTopicBytes: 421,
    rawTopicHash: '275ba9bdf872ccd38f6c147f7a15183ed7bbcb706b24add13af7389e0260889b',
    formatCounts: [3,3,0,9],
    formattedKinds: { 3: 3, 4: 3, 5: 3 }, payloadBytes: 56,
    fontFaces: ['MS Sans Serif'],
    fonts: [[0,16,3,0,400,257,257],[0,16,3,1,700,257,257]],
    bitmaps: [],
  },
  'mspaint.hlp': {
    title: 'Paint Help', cnt: 'mspaint.cnt', topics: [0,38,187,313,376,437,514,700,884,1051,1229,1285,1341,1424,1511,1593,1661,1833,1933,1992,2056,2117,2182,2236,2377,2509,2580,2725,2763],
    contextCount: 28,
    hashes: [[2162765496,376],[2099753053,2182]],
    maps: [[30050,1933],[30300,0],[30000,1229]],
    mapCount: 23,
    phraseCount: 82, phraseSize: 424, phrases: [[0,'%'],[5,'100'],[81,'your']],
    rawTopicLengths: [38,148,126,63,61,77,186,184,167,178,56,56,83,87,82,68,172,100,59,64,61,65,54,141,132,71,145,38,0],
    rawTopicBytes: 2762,
    rawTopicHash: 'e060a6a35b928d056701cea5e91da8acc209452f556a7d4cba35d687a487db67',
    formatCounts: [28,28,0,92],
    formattedKinds: { 3: 28, 4: 28, 5: 35, 9: 1 }, payloadBytes: 544,
    fontFaces: ['MS Sans Serif','Times New Roman'],
    fonts: [[0,16,3,0,400,257,257],[0,16,3,0,400,255,257],[1,16,2,0,400,0,257],[0,16,3,1,700,257,257]],
    bitmaps: [[0,0,6,3,0,80,1,4,10,11,16,0,10682,69,0,0,10618,16,88,0]],
    bitmapPayloads: [[88,'af05e0d1c22157124c3ca4e1c71071af65b688028ee80ac8f44b59d426310b2d']],
  },
  'notepad.hlp': {
    title: 'Notepad Help', cnt: '', topics: [0,495,994,1032],
    contextCount: 3,
    hashes: [[3742568226,994],[1037673951,0]],
    maps: [[1000,495],[1001,0]], mapCount: 2,
    phraseCount: 62, phraseSize: 254, phrases: [[0,'"('],[7,'Align'],[61,'your']],
    rawTopicLengths: [495,499,38,0],
    rawTopicBytes: 1032,
    rawTopicHash: 'f41f6f28c5daac376b0888eadee88b4f5cc7bea26359e12fbdf733c892540478',
    formatCounts: [21,41,16,128],
    formattedKinds: { 3: 34, 4: 41, 5: 53 }, payloadBytes: 1065,
    fontFaces: ['MS Sans Serif'],
    fonts: [[0,16,3,0,400,257,257],[0,16,3,1,700,257,257]],
    bitmaps: [],
  },
  'sol.hlp': {
    title: 'Solitaire Help', cnt: 'sol.cnt', topics: [0,155,331,1047,1273,1311],
    contextCount: 5,
    hashes: [[2713696239,0],[1807483151,1047]],
    maps: [], mapCount: 0,
    phraseCount: 52, phraseSize: 197, phrases: [[0,','],[5,'after'],[51,'You']],
    rawTopicLengths: [155,176,709,223,38,0],
    rawTopicBytes: 1301,
    rawTopicHash: '56cf53aa2a1a4949b3cefd24ee2968665708858911f0c69ac667f3e6351a5350',
    formatCounts: [10,10,0,59],
    formattedKinds: { 2: 10, 3: 15, 4: 10, 5: 14, 9: 10 }, payloadBytes: 320,
    fontFaces: ['MS Sans Serif'],
    fonts: [[0,16,3,0,400,257,257],[0,16,3,1,700,257,257]],
    bitmaps: [[0,0,6,2,0,0,1,1,4,8,2,0,8043,31,0,0,8035,2,32,0]],
    bitmapPayloads: [[32,'d906e1459df649cadb63bbe2b5fcc7572a7c78fd373f6e6a176e54ae3f896e44']],
  },
  'wordpad.hlp': {
    title: 'WordPad Help', cnt: '', topics: [0,30,63,91,242,311,409,557,643,712,781,855,923,968,1175,1245,1314,1461,1495,1528,1563,1729,2204,2289,2386,2509,2657,2692,2730,2891,3054,32768,32914,33299,33689,33727],
    contextCount: 34,
    hashes: [[2162146575,32768],[2116727712,1245]],
    maps: [[1004,1461],[1031,0],[1029,712]],
    mapCount: 29,
    phraseCount: 116, phraseSize: 565, phrases: [[0,'('],[6,'Aligns'],[115,'your']],
    rawTopicLengths: [30,33,28,150,69,98,148,86,69,69,74,68,45,204,70,69,147,34,33,35,166,471,85,97,123,148,35,38,161,163,41,146,385,390,38,0],
    rawTopicBytes: 4046,
    rawTopicHash: '69bfb58fc671db239cc3bb8b36fe3c65419565c8a82d876b46d9f95ff9161c8b',
    formatCounts: [39,39,0,168],
    formattedKinds: { 2: 10, 3: 48, 4: 39, 5: 63, 9: 8 }, payloadBytes: 891,
    fontFaces: ['MS Sans Serif'],
    fonts: [[0,16,3,0,400,257,257],[0,16,3,1,700,257,257],[0,18,3,0,400,257,257]],
    bitmaps: [[0,0,6,3,0,80,1,4,10,11,16,0,12229,69,0,0,12165,16,88,0],[1,0,6,2,0,0,1,1,4,8,2,0,12351,31,0,0,12343,2,32,0]],
    bitmapPayloads: [[88,'af05e0d1c22157124c3ca4e1c71071af65b688028ee80ac8f44b59d426310b2d'],[32,'d906e1459df649cadb63bbe2b5fcc7572a7c78fd373f6e6a176e54ae3f896e44']],
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

function buildSemanticBtree(kind, danglingTopicRef = null) {
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
    : [[-10, 0], [-1, 10], [5, 20], [20, danglingTopicRef === null ? 30 : danglingTopicRef]];
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

function buildKeywordIndex(entries, { leafCycle = false, indexCycle = false } = {}) {
  const pageSize = 512;
  const pageCount = 3;
  const tree = Buffer.alloc(38 + pageSize * pageCount);
  const postingOffsets = [];
  const dataParts = [];
  let dataSize = 0;
  for (const [, refs] of entries) {
    postingOffsets.push(dataSize);
    const part = Buffer.alloc(refs.length * 4);
    refs.forEach((ref, index) => part.writeInt32LE(ref, index * 4));
    dataParts.push(part);
    dataSize += part.length;
  }
  const data = Buffer.concat(dataParts);
  tree.writeUInt16LE(0x293b, 0);
  tree.writeUInt16LE(0x0002, 2);
  tree.writeUInt16LE(pageSize, 4);
  tree.write('z24', 6, 'ascii');
  tree.writeUInt16LE(0, 22);
  tree.writeUInt16LE(0, 24);
  tree.writeUInt16LE(0, 26);
  tree.writeUInt16LE(0xffff, 28);
  tree.writeUInt16LE(pageCount, 30);
  tree.writeUInt16LE(2, 32);
  tree.writeUInt32LE(entries.length, 34);

  const split = Math.ceil(entries.length / 2);
  const root = 38;
  let rootPos = root + 6;
  tree.writeUInt16LE(1, root + 2);
  tree.writeUInt16LE(indexCycle ? 0 : 1, root + 4);
  rootPos += tree.write(entries[split][0], rootPos, 'latin1');
  tree[rootPos++] = 0;
  tree.writeUInt16LE(2, rootPos);
  rootPos += 2;
  tree.writeUInt16LE(root + pageSize - rootPos, root);

  const leafEntries = [];
  for (let leafNo = 1; leafNo <= 2; leafNo++) {
    const leaf = 38 + leafNo * pageSize;
    const first = leafNo === 1 ? 0 : split;
    const last = leafNo === 1 ? split : entries.length;
    let pos = leaf + 8;
    tree.writeUInt16LE(last - first, leaf + 2);
    tree.writeUInt16LE(leafNo === 1 ? 0xffff : 1, leaf + 4);
    tree.writeUInt16LE(leafNo === 1 ? 2 : (leafCycle ? 1 : 0xffff), leaf + 6);
    for (let entryIndex = first; entryIndex < last; entryIndex++) {
      const [keyword, refs] = entries[entryIndex];
      const entryStart = pos;
      pos += tree.write(keyword, pos, 'latin1');
      tree[pos++] = 0;
      tree.writeUInt16LE(refs.length, pos);
      pos += 2;
      tree.writeUInt32LE(postingOffsets[entryIndex], pos);
      leafEntries.push({ entryStart, dataOffsetField: pos });
      pos += 4;
    }
    tree.writeUInt16LE(leaf + pageSize - pos, leaf);
  }
  return { tree, data, leafEntries };
}

function encodeLiteralLz77(raw) {
  const chunks = [];
  for (let pos = 0; pos < raw.length; pos += 8) {
    chunks.push(Buffer.from([0]));
    chunks.push(raw.subarray(pos, Math.min(pos + 8, raw.length)));
  }
  return Buffer.concat(chunks);
}

function buildSyntheticTopic(topicCount = 4) {
  const links = Buffer.alloc(topicCount * 49);
  for (let i = 0; i < topicCount; i++) {
    const pos = i * 49;
    links.writeUInt32LE(49, pos);
    links.writeUInt32LE(0, pos + 4);
    links.writeInt32LE(i === 0 ? -1 : 12 + (i - 1) * 49, pos + 8);
    links.writeInt32LE(i + 1 === topicCount ? -1 : 12 + (i + 1) * 49, pos + 12);
    links.writeUInt32LE(49, pos + 16);
    links[pos + 20] = 2;
  }
  const header = Buffer.alloc(12);
  header.writeInt32LE(-1, 0);
  header.writeUInt32LE(12, 4);
  header.writeUInt32LE(0, 8);
  return Buffer.concat([header, encodeLiteralLz77(links)]);
}

function buildSyntheticOldTopic(compressed = true) {
  const positions = [12, 61, 98, 147, 196];
  const types = [2, 0x20, 2, 2, 2];
  const sizes = [49, 37, 49, 49, 49];
  const displayFormat = Buffer.alloc(10);
  displayFormat.writeUInt16LE(0x801a, 0); // compressed long TopicSize = 13
  displayFormat[2] = 26; // compressed unsigned TopicLength = 13
  displayFormat[9] = 0xff;
  const links = Buffer.alloc(sizes.reduce((sum, size) => sum + size, 0));
  let raw = 0;
  for (let i = 0; i < positions.length; i++) {
    const source = i === 1 ? Buffer.from([1, 0, 1, 3, '!'.charCodeAt(0), 0]) : Buffer.alloc(0);
    links.writeUInt32LE(sizes[i], raw);
    links.writeUInt32LE(i === 1 ? 13 : 0, raw + 4);
    links.writeInt32LE(i === 0 ? -1 : positions[i - 1], raw + 8);
    links.writeInt32LE(i + 1 === positions.length ? -1 : positions[i + 1], raw + 12);
    links.writeUInt32LE(i === 1 ? 31 : 49, raw + 16);
    links[raw + 20] = types[i];
    if (i === 1) displayFormat.copy(links, raw + 21);
    source.copy(links, raw + (i === 1 ? 31 : 21));
    raw += sizes[i];
  }
  const header = Buffer.alloc(12);
  header.writeInt32LE(-1, 0);
  header.writeUInt32LE(12, 4);
  header.writeUInt32LE(0, 8);
  return Buffer.concat([header, compressed ? encodeLiteralLz77(links) : links]);
}

function encodeCompressedLong(value) {
  const result = Buffer.alloc(2);
  result.writeUInt16LE((value + 0x4000) * 2);
  return result;
}

function encodeCompressedUnsignedLong(value) {
  if (value >= 0x8000) throw new Error('synthetic compressed ulong too large');
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value * 2);
  return result;
}

function encodeCompressedSignedShort(value) {
  if (value < -0x4000 || value >= 0x4000) {
    throw new Error('synthetic compressed signed short out of range');
  }
  if (value >= -0x40 && value < 0x40) return Buffer.from([(value + 0x40) * 2]);
  const result = Buffer.alloc(2);
  result.writeUInt16LE(((value + 0x4000) * 2) | 1);
  return result;
}

function encodeCompressedUnsignedShort(value) {
  if (value < 0 || value >= 0x8000) {
    throw new Error('synthetic compressed unsigned short out of range');
  }
  if (value < 0x80) return Buffer.from([value * 2]);
  const result = Buffer.alloc(2);
  result.writeUInt16LE((value * 2) | 1);
  return result;
}

function buildExternalHotspot(opcode, type, hash, {
  windowNumber = 0, file = '', window = '',
} = {}) {
  const fixed = Buffer.alloc(5);
  fixed[0] = type;
  fixed.writeUInt32LE(hash >>> 0, 1);
  const parts = [fixed];
  if (type === 1) parts.push(Buffer.from([windowNumber]));
  if (type === 4 || type === 6) parts.push(Buffer.from(file + '\0', 'latin1'));
  if (type === 6) parts.push(Buffer.from(window + '\0', 'latin1'));
  const structure = Buffer.concat(parts);
  const result = Buffer.alloc(3 + structure.length);
  result[0] = opcode;
  result.writeUInt16LE(structure.length, 1);
  structure.copy(result, 3);
  return result;
}

function buildSystemWindow({
  flags = 0x03ff, type = 'secondary', name = 'secondary', caption = 'Secondary Help',
  x = 100, y = 120, width = 500, height = 400, show = 1,
  scrollColor = 0xffffff, nonScrollColor = 0xffffff,
} = {}) {
  const payload = Buffer.alloc(90);
  payload.writeUInt16LE(flags, 0);
  payload.write(type, 2, 10, 'latin1');
  payload.write(name, 12, 9, 'latin1');
  payload.write(caption, 21, 51, 'latin1');
  payload.writeInt16LE(x, 72);
  payload.writeInt16LE(y, 74);
  payload.writeInt16LE(width, 76);
  payload.writeInt16LE(height, 78);
  payload.writeUInt16LE(show, 80);
  payload.writeUInt32LE(scrollColor >>> 0, 82);
  payload.writeUInt32LE(nonScrollColor >>> 0, 86);
  const record = Buffer.alloc(94);
  record.writeUInt16LE(6, 0);
  record.writeUInt16LE(payload.length, 2);
  payload.copy(record, 4);
  return record;
}

function buildParagraphHeader({ column = null, flags = 0, metrics = [], tabs = [] } = {}) {
  const base = Buffer.alloc(column === null ? 6 : 11);
  let offset = 0;
  if (column !== null) {
    base.writeInt16LE(column, 0);
    offset = 5;
  }
  base.writeUInt16LE(flags, offset + 4);
  const parts = [base, ...metrics.map(encodeCompressedSignedShort)];
  if (flags & 0x0200) {
    parts.push(encodeCompressedSignedShort(tabs.length));
    for (const [stop, type = 0] of tabs) {
      parts.push(encodeCompressedUnsignedShort(type ? stop | 0x4000 : stop));
      if (type) parts.push(encodeCompressedUnsignedShort(type));
    }
  }
  return Buffer.concat(parts);
}

function buildSyntheticBitmap({
  packing = 0, pictureType = 6,
  payload = Buffer.from([0,0,0,0,1,0,1,0]),
} = {}) {
  const pictureParts = [
    Buffer.from([pictureType, packing]),
    encodeCompressedUnsignedLong(96), encodeCompressedUnsignedLong(96),
    Buffer.from([2, 16]),
    encodeCompressedUnsignedLong(2), encodeCompressedUnsignedLong(2),
    encodeCompressedUnsignedLong(2), encodeCompressedUnsignedLong(1),
    encodeCompressedUnsignedLong(payload.length), encodeCompressedUnsignedLong(0),
  ];
  const pictureHeader = Buffer.concat(pictureParts);
  const palette = pictureType === 6
    ? Buffer.from([0,0,0,0, 0xff,0xff,0xff,0]) : Buffer.alloc(0);
  const picture = Buffer.alloc(pictureHeader.length + 8 + palette.length + payload.length);
  pictureHeader.copy(picture);
  picture.writeUInt32LE(pictureHeader.length + 8 + palette.length, pictureHeader.length);
  picture.writeUInt32LE(0, pictureHeader.length + 4);
  palette.copy(picture, pictureHeader.length + 8);
  payload.copy(picture, pictureHeader.length + 8 + palette.length);
  const result = Buffer.alloc(8 + picture.length);
  result.writeUInt16LE(0x506c, 0);
  result.writeUInt16LE(1, 2);
  result.writeUInt32LE(8, 4);
  picture.copy(result, 8);
  return result;
}

function buildOldFont(faces, descriptors, slotSize = 32) {
  const faceOffset = 8;
  const descriptorOffset = faceOffset + faces.length * slotSize;
  const result = Buffer.alloc(descriptorOffset + descriptors.length * 11);
  result.writeUInt16LE(faces.length, 0);
  result.writeUInt16LE(descriptors.length, 2);
  result.writeUInt16LE(faceOffset, 4);
  result.writeUInt16LE(descriptorOffset, 6);
  faces.forEach((face, index) => result.write(face, faceOffset + index * slotSize,
    Math.min(Buffer.byteLength(face, 'latin1'), slotSize), 'latin1'));
  descriptors.forEach(([face, halfPoints, family, attributes, foreground = 0, background = 0], index) => {
    const p = descriptorOffset + index * 11;
    result[p] = attributes;
    result[p + 1] = halfPoints;
    result[p + 2] = family;
    result.writeUInt16LE(face, p + 3);
    result[p + 5] = foreground & 0xff;
    result[p + 6] = (foreground >>> 8) & 0xff;
    result[p + 7] = (foreground >>> 16) & 0xff;
    result[p + 8] = background & 0xff;
    result[p + 9] = (background >>> 8) & 0xff;
    result[p + 10] = (background >>> 16) & 0xff;
  });
  return result;
}

function buildSyntheticFormattedTopic({
  stringCount = null, returnParts = false, hotspotOpcode = 0xe2, hotspotHash = 0x12345678,
  hotspotCommand = null, closeVariableHotspot = false, variableHotspotCommand = null,
  externalBitmapNumber = null, stringPadding = 0, trailingNuls = 0,
} = {}) {
  const fixedHotspot = Buffer.alloc(5);
  fixedHotspot[0] = hotspotOpcode;
  fixedHotspot.writeInt32LE(hotspotHash, 1);
  const primaryHotspot = hotspotCommand || fixedHotspot;
  const secondaryHotspot = variableHotspotCommand ||
    Buffer.from([0xea, 6, 0, 1, 1, 2, 3, 4, 5]);
  const bitmapCommand = externalBitmapNumber === null
    ? Buffer.concat([
      Buffer.from([0x86, 3]), encodeCompressedLong(4), Buffer.from([0, 0, 7, 0]),
    ])
    : Buffer.concat([
      Buffer.from([0x86, 0x22]), encodeCompressedLong(4), Buffer.from([0]),
      Buffer.from([0, 0, externalBitmapNumber & 0xff, externalBitmapNumber >>> 8 & 0xff]),
    ]);
  // One LinkData2 string per LinkData1 command, so the exact count is derived
  // rather than restated at every call site; stringCount only overrides it for
  // the tests that deliberately mispair the two.
  const commandList = [
    Buffer.from([0x80, 2, 0]), Buffer.from([0x81]), Buffer.from([0x82]),
    Buffer.from([0x83]),
    bitmapCommand,
    primaryHotspot, Buffer.from([0x89]),
    // A macro command opens a hotspot region and is closed by the same 0x89
    // terminator a jump uses, so the fixture spells that pairing out.
    Buffer.from([0xc8, 2, 0, 'X'.charCodeAt(0), 0]), Buffer.from([0x89]),
    secondaryHotspot,
    ...(closeVariableHotspot ? [Buffer.from([0x89])] : []),
    Buffer.from([0x8b]), Buffer.from([0x8c]), Buffer.from([0xff]),
  ];
  const commands = Buffer.concat(commandList);
  const stringTotal = stringCount === null ? commandList.length : stringCount;
  // Padding lengthens the last LinkData2 string instead of adding commands,
  // so a record can be grown past a block boundary without changing its
  // command/string pairing or its token count.
  // trailingNuls models the tail a phrase-compressed stream is allowed to
  // omit: DataLen2 bytes the commands never claim, which the reader supplies
  // as NUL because it decompresses into a zeroed buffer of that size.
  const strings = Buffer.concat([
    ...Array.from({ length: stringTotal }, (_, index) =>
      index + 1 === stringTotal && stringPadding
        ? Buffer.concat([Buffer.from([65 + index]), Buffer.alloc(stringPadding, 0x58),
          Buffer.from([0])])
        : Buffer.from([65 + index, 0])),
    Buffer.alloc(trailingNuls, 0),
  ]);
  const displayFormat = Buffer.alloc(9 + commands.length);
  encodeCompressedLong(strings.length).copy(displayFormat, 0);
  displayFormat[2] = strings.length * 2;
  commands.copy(displayFormat, 9);
  const displaySize = 21 + displayFormat.length + strings.length;
  const sizes = [49, displaySize, 49, 49, 49];
  const positions = [12];
  for (let i = 1; i < sizes.length; i++) positions.push(positions[i - 1] + sizes[i - 1]);
  const links = Buffer.alloc(sizes.reduce((sum, size) => sum + size, 0));
  let raw = 0;
  for (let i = 0; i < sizes.length; i++) {
    links.writeUInt32LE(sizes[i], raw);
    links.writeUInt32LE(i === 1 ? strings.length : 0, raw + 4);
    links.writeInt32LE(i === 0 ? -1 : positions[i - 1], raw + 8);
    links.writeInt32LE(i + 1 === sizes.length ? -1 : positions[i + 1], raw + 12);
    links.writeUInt32LE(i === 1 ? 21 + displayFormat.length : 49, raw + 16);
    links[raw + 20] = i === 1 ? 0x20 : 2;
    if (i === 1) {
      displayFormat.copy(links, raw + 21);
      strings.copy(links, raw + 21 + displayFormat.length);
    }
    raw += sizes[i];
  }
  const header = Buffer.alloc(12);
  header.writeInt32LE(-1, 0);
  header.writeUInt32LE(12, 4);
  const topic = Buffer.concat([header, encodeLiteralLz77(links)]);
  return returnParts ? { topic, displayFormat, strings, links } : topic;
}

// Lay a raw link stream out as uncompressed physical topic blocks. With
// SYSTEM flags 0 the parser reads 4096-byte physical blocks whose 12-byte
// header is not part of the logical stream, so records straddle boundaries
// exactly as they do in a real compressed file.
function packUncompressedTopicBlocks(links, physical = 4096) {
  const logical = physical - 12;
  const parts = [];
  for (let pos = 0; pos < links.length; pos += logical) {
    const header = Buffer.alloc(12);
    header.writeInt32LE(-1, 0);
    header.writeUInt32LE(12, 4);
    parts.push(header, links.subarray(pos, Math.min(pos + logical, links.length)));
  }
  return Buffer.concat(parts);
}

function buildOldPhrases(values, variant = 'hc31') {
  const image = Buffer.concat(values.map(value => Buffer.from(value, 'latin1')));
  const tableSize = (values.length + 1) * 2;
  const headerSize = variant === 'hc30' ? 4 : variant === 'mvb' ? 40 : 8;
  const imageBytes = variant === 'hc30' ? image : encodeLiteralLz77(image);
  const result = Buffer.alloc(headerSize + tableSize + imageBytes.length);
  let offsetsStart;
  if (variant === 'mvb') {
    result.writeUInt16LE(0x0800, 0);
    result.writeUInt16LE(values.length, 2);
    result.writeUInt16LE(0x0100, 4);
    result.writeUInt32LE(image.length, 6);
    offsetsStart = 40;
  } else {
    result.writeUInt16LE(values.length, 0);
    result.writeUInt16LE(0x0100, 2);
    if (variant === 'hc31') result.writeUInt32LE(image.length, 4);
    offsetsStart = headerSize;
  }
  let offset = tableSize;
  result.writeUInt16LE(offset, offsetsStart);
  for (let i = 0; i < values.length; i++) {
    offset += Buffer.byteLength(values[i], 'latin1');
    result.writeUInt16LE(offset, offsetsStart + (i + 1) * 2);
  }
  imageBytes.copy(result, offsetsStart + tableSize);
  return result;
}

function writeSyntheticTopicRaw(document, rawOffset, value, byteLength = 4) {
  const compressed = document.offsets['|TOPIC'] + 9 + 12;
  for (let i = 0; i < byteLength; i++) {
    const sourceOffset = rawOffset + i;
    const encodedOffset = compressed + Math.floor(sourceOffset / 8) * 9 + 1 + sourceOffset % 8;
    document.file[encodedOffset] = value >>> (i * 8) & 0xff;
  }
}

function buildSyntheticSemanticHelp({
  systemMinor = 33, systemFlags = 4, topic = null, oldPhrases = null, font = null,
  extraFiles = [], windows = [],
} = {}) {
  const title = Buffer.from('Synthetic Help\0', 'latin1');
  const system = Buffer.alloc(12 + 4 + title.length + 8 +
    windows.reduce((size, window) => size + window.length, 0));
  system.writeUInt16LE(0x036c, 0);
  system.writeUInt16LE(systemMinor, 2);
  system.writeUInt16LE(1, 4);
  system.writeUInt16LE(systemFlags, 10);
  system.writeUInt16LE(1, 12);
  system.writeUInt16LE(title.length, 14);
  title.copy(system, 16);
  const contents = 16 + title.length;
  system.writeUInt16LE(3, contents);
  system.writeUInt16LE(4, contents + 2);
  system.writeUInt32LE(0, contents + 4);
  let systemPos = contents + 8;
  for (const window of windows) {
    window.copy(system, systemPos);
    systemPos += window.length;
  }

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
    ['|TOPIC', topic || buildSyntheticTopic()],
    ['|TTLBTREE', buildSemanticBtree('titles')],
  ]);
  if (oldPhrases) contentsByName.set('|Phrases', oldPhrases);
  if (font) contentsByName.set('|FONT', font);
  for (const [name, content] of extraFiles) contentsByName.set(name, content);
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
  const windowCreates = [];
  const windowDestroys = [];
  const createWindow = imports.host.create_window;
  const destroyWindow = imports.host.destroy_window;
  imports.host.create_window = (...args) => {
    windowCreates.push(args.slice(0, 6));
    return createWindow(...args);
  };
  imports.host.destroy_window = hwnd => {
    windowDestroys.push(hwnd);
    return destroyWindow(hwnd);
  };
  const windowMoves = [];
  const windowTexts = [];
  const moveWindow = imports.host.move_window;
  const setWindowText = imports.host.set_window_text;
  imports.host.move_window = (...args) => {
    windowMoves.push(args.slice(0, 5));
    return moveWindow(...args);
  };
  imports.host.set_window_text = (hwnd, textPtr) => {
    windowTexts.push([hwnd, textPtr]);
    return setWindowText(hwnd, textPtr);
  };
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
  const topicOutWA = staging + 0x20000;
  const topicOutCapacity = 0x10000;
  const topicTokensWA = staging + 0x40000;
  const topicTokenCapacity = 4096;
  const topicPayloadWA = staging + 0x60000;
  const topicPayloadCapacity = 0x10000;

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

  const semanticHelpImports = new Set(['help_open', 'help_get_topic', 'help_get_title']);
  const wasmImports = WebAssembly.Module.imports(new WebAssembly.Module(wasm));
  check('production WASM has no semantic JavaScript WinHelp imports',
    wasmImports.every(entry => !semanticHelpImports.has(entry.name)) &&
    [...semanticHelpImports].every(name => !(name in imports.host)));
  const runtimeHelpReferences = [
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'test', 'run.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'lib', 'host-imports.js'), 'utf8'),
  ].join('\n');
  check('browser and CLI no longer load or initialize the semantic HlpParser',
    !/HlpParser|hlp-parser|_helpParser|_helpPendingPath/.test(runtimeHelpReferences));

  function load(data, directoryOnly = false) {
    bytes.set(data, staging);
    return directoryOnly
      ? e.test_help_load_directory_buffer(staging, data.length)
      : e.test_help_load_buffer(staging, data.length);
  }

  function loadCnt(data) {
    bytes.set(data, staging);
    return e.test_help_load_cnt_buffer(staging, data.length);
  }

  function readLatin1(ptr, len) {
    return Buffer.from(bytes.subarray(ptr, ptr + len)).toString('latin1');
  }

  function writeCString(ptr, value) {
    const encoded = Buffer.from(value, 'latin1');
    bytes.fill(0, ptr, ptr + encoded.length + 1);
    bytes.set(encoded, ptr);
  }

  function allocGuestAnsi(value) {
    const encoded = Buffer.from(value, 'latin1');
    const guest = e.guest_alloc(encoded.length + 1);
    for (let i = 0; i < encoded.length; i += 2) {
      e.guest_write16(guest + i,
        encoded[i] | ((i + 1 < encoded.length ? encoded[i + 1] : 0) << 8));
    }
    e.guest_write16(guest + encoded.length, 0);
    return guest;
  }

  function allocGuestWide(value) {
    const guest = e.guest_alloc((value.length + 1) * 2);
    for (let i = 0; i < value.length; i++) e.guest_write16(guest + i * 2, value.charCodeAt(i));
    e.guest_write16(guest + value.length * 2, 0);
    return guest;
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
    const windows = Array.from({ length: e.get_help_window_count() }, (_, index) => {
      const rec = e.get_help_window_record(index);
      const field = offset => readLatin1(e.get_help_file_ptr() + dv.getUint32(rec + offset, true),
        dv.getUint32(rec + offset + 4, true));
      return {
        flags: dv.getUint32(rec, true), type: field(4), name: field(12), caption: field(20),
        geometry: Array.from({ length: 4 }, (_, n) => dv.getInt32(rec + 28 + n * 4, true)),
        show: dv.getUint32(rec + 44, true),
        colors: [dv.getUint32(rec + 48, true), dv.getUint32(rec + 52, true)],
      };
    });
    check(`${file} exact normalized SYSTEM window table`,
      windows.length === 8 &&
      JSON.stringify(windows.map(window => window.name)) ===
        JSON.stringify(['proc4','trouble','big','moreinfo','error','medium','bigbrows','main']) &&
      JSON.stringify(windows[7].geometry) === JSON.stringify([115,18,350,425]) &&
      windows[7].flags === 0x1b7f && windows[7].show === 20740 &&
      JSON.stringify(windows[7].colors) === JSON.stringify([0xe2ffff,0xc0c0c0]));
    bytes.set(Buffer.from('BIGBROWS', 'latin1'), nameWA);
    check(`${file} window lookup is case-insensitive and bounded`,
      e.test_help_find_window_index(nameWA, 8) === 6 &&
      e.test_help_find_window_index(nameWA, 0) === -1 &&
      e.get_help_window_record(windows.length) === 0);
    bytes.set(Buffer.from('nosuchwin', 'latin1'), nameWA);
    check(`${file} missing window lookup is explicit`,
      e.test_help_find_window_index(nameWA, 9) === -1);

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
      topics.every((topic, index) => topic.title === '' && topic.recordOff >= 12 &&
        (!index || topics[index - 1].recordOff < topic.recordOff)));

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

    check(`${file} exact Hall phrase table dimensions`,
      e.get_help_phrase_count() === semantic.phraseCount &&
      e.get_help_phrase_image_size() === semantic.phraseSize);
    for (const [index, phrase] of semantic.phrases) {
      check(`${file} exact phrase ${index}`,
        readLatin1(e.get_help_phrase_ptr(index), e.get_help_phrase_len(index)) === phrase);
    }
    check(`${file} phrase lookup is bounded`,
      e.get_help_phrase_ptr(semantic.phraseCount) === 0 &&
      e.get_help_phrase_len(semantic.phraseCount) === 0);
    check(`${file} exact LinkData1 record grammar counts`,
      JSON.stringify([
        e.get_help_display_record_count(),
        e.get_help_paragraph_count(),
        e.get_help_table_count(),
        e.get_help_format_command_count(),
      ]) === JSON.stringify(semantic.formatCounts));
    const fontFaces = Array.from({ length: e.get_help_font_face_count() }, (_, index) =>
      readLatin1(e.get_help_font_face_ptr(index), e.get_help_font_face_len(index)));
    const fonts = Array.from({ length: e.get_help_font_count() }, (_, index) => {
      const record = e.get_help_font_record(index);
      return Array.from({ length: 7 }, (_, field) => dv.getUint32(record + field * 4, true));
    });
    check(`${file} exact normalized FONT faces and descriptors`,
      e.get_help_font_metric_mode() === 0 &&
      JSON.stringify(fontFaces) === JSON.stringify(semantic.fontFaces) &&
      JSON.stringify(fonts) === JSON.stringify(semantic.fonts),
      `faces=${JSON.stringify(fontFaces)} fonts=${JSON.stringify(fonts)}`);
    check(`${file} FONT lookup is bounded`,
      e.get_help_font_face_record(semantic.fontFaces.length) === 0 &&
      e.get_help_font_face_ptr(semantic.fontFaces.length) === 0 &&
      e.get_help_font_face_len(semantic.fontFaces.length) === 0 &&
      e.get_help_font_record(semantic.fonts.length) === 0);
    const bitmaps = Array.from({ length: e.get_help_bitmap_count() }, (_, index) => {
      const record = e.get_help_bitmap_record(index);
      return Array.from({ length: 20 }, (_, field) => dv.getUint32(record + field * 4, true));
    });
    check(`${file} exact normalized bitmap resource metadata`,
      JSON.stringify(bitmaps) === JSON.stringify(semantic.bitmaps),
      `bitmaps=${JSON.stringify(bitmaps)}`);
    check(`${file} bitmap lookup is exact and bounded`,
      semantic.bitmaps.every((bitmap, index) =>
        e.test_help_find_bitmap(bitmap[0], bitmap[1]) === index) &&
      e.test_help_find_bitmap(0xffff, 0xffff) === -1 &&
      e.get_help_bitmap_record(semantic.bitmaps.length) === 0);
    const bitmapPayloads = semantic.bitmapPayloads || [];
    const decodedBitmaps = semantic.bitmaps.map((bitmap, index) => {
      const length = e.test_help_decode_bitmap(index, topicOutWA, topicOutCapacity);
      return [length, length < 0 ? '' : crypto.createHash('sha256')
        .update(Buffer.from(bytes.subarray(topicOutWA, topicOutWA + length))).digest('hex')];
    });
    check(`${file} exact decoded bitmap payloads`,
      JSON.stringify(decodedBitmaps) === JSON.stringify(bitmapPayloads),
      `decoded=${JSON.stringify(decodedBitmaps)}`);
    const expectedKeywords = semantic.keywords || [];
    const keywords = Array.from({ length: e.get_help_keyword_count() }, (_, index) => {
      const record = e.get_help_keyword_record(index);
      return [
        readLatin1(e.get_help_keyword_ptr(index), e.get_help_keyword_len(index)),
        dv.getUint32(record + 8, true), dv.getUint32(record + 12, true),
      ];
    });
    const keywordPostings = Array.from({ length: e.get_help_keyword_posting_count() }, (_, index) => {
      const posting = e.get_help_keyword_posting(index);
      return [dv.getUint32(posting, true), dv.getUint32(posting + 4, true)];
    });
    check(`${file} exact normalized keyword index`,
      JSON.stringify(keywords) === JSON.stringify(expectedKeywords) &&
      JSON.stringify(keywordPostings) === JSON.stringify(semantic.keywordPostings || []),
      `keywords=${JSON.stringify(keywords)} postings=${JSON.stringify(keywordPostings)}`);
    check(`${file} keyword inspection is bounded`,
      e.get_help_keyword_record(expectedKeywords.length) === 0 &&
      e.get_help_keyword_ptr(expectedKeywords.length) === 0 &&
      e.get_help_keyword_len(expectedKeywords.length) === 0 &&
      e.get_help_keyword_posting((semantic.keywordPostings || []).length) === 0);

    const rawParts = [];
    const rawTopics = [];
    const rawLengths = [];
    let rawBytes = 0;
    let rawOk = true;
    for (let i = 0; i < semantic.topics.length; i++) {
      const length = e.test_help_decode_topic_raw(i, topicOutWA, topicOutCapacity);
      rawLengths.push(length);
      if (length < 0) {
        rawOk = false;
        break;
      }
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32LE(length);
      const rawTopic = Buffer.from(bytes.subarray(topicOutWA, topicOutWA + length));
      rawTopics.push(rawTopic);
      rawParts.push(lengthPrefix, rawTopic);
      rawBytes += length;
    }
    const rawHash = rawOk
      ? crypto.createHash('sha256').update(Buffer.concat(rawParts)).digest('hex')
      : '';
    check(`${file} exact raw topic lengths`,
      rawOk && JSON.stringify(rawLengths) === JSON.stringify(semantic.rawTopicLengths),
      `actual=${JSON.stringify(rawLengths)}`);
    check(`${file} exact raw topic corpus`,
      rawOk && rawBytes === semantic.rawTopicBytes && rawHash === semantic.rawTopicHash,
      `bytes=${rawBytes} hash=${rawHash}`);

    let stringTokensOk = rawOk;
    let stringTokenDetail = '';
    for (let topicIndex = 0; topicIndex < rawTopics.length && stringTokensOk; topicIndex++) {
      const rawTopic = rawTopics[topicIndex];
      const expectedStrings = [];
      let start = -1;
      for (let i = 0; i <= rawTopic.length; i++) {
        if (i === rawTopic.length || rawTopic[i] === 0) {
          if (start >= 0) expectedStrings.push([start, i - start]);
          start = -1;
        } else if (start < 0) {
          start = i;
        }
      }
      const tokenCount = e.test_help_decode_topic_strings(
        topicIndex, topicOutWA, topicOutCapacity, topicTokensWA, topicTokenCapacity);
      if (tokenCount !== expectedStrings.length + 1) {
        stringTokensOk = false;
        stringTokenDetail = `topic=${topicIndex} count=${tokenCount} expected=${expectedStrings.length + 1}`;
        break;
      }
      for (let i = 0; i < expectedStrings.length; i++) {
        const token = topicTokensWA + i * 16;
        if (dv.getUint32(token, true) !== 1 ||
            dv.getUint32(token + 4, true) !== expectedStrings[i][0] ||
            dv.getUint32(token + 8, true) !== expectedStrings[i][1] ||
            dv.getUint32(token + 12, true) !== 0) {
          stringTokensOk = false;
          stringTokenDetail = `topic=${topicIndex} token=${i}`;
          break;
        }
      }
      const end = topicTokensWA + expectedStrings.length * 16;
      if (stringTokensOk && (dv.getUint32(end, true) !== 13 ||
          dv.getUint32(end + 4, true) !== rawTopic.length ||
          dv.getBigUint64(end + 8, true) !== 0n)) {
        stringTokensOk = false;
        stringTokenDetail = `topic=${topicIndex} bad END_TOPIC`;
      }
    }
    check(`${file} exact NUL-delimited topic string tokens`, stringTokensOk, stringTokenDetail);

    const formattedKinds = {};
    let formattedPayloadBytes = 0;
    let formattedOk = rawOk;
    let formattedDetail = '';
    for (let topicIndex = 0; topicIndex < rawTopics.length && formattedOk; topicIndex++) {
      const rawTopic = rawTopics[topicIndex];
      const expectedStrings = [];
      let start = -1;
      for (let i = 0; i <= rawTopic.length; i++) {
        if (i === rawTopic.length || rawTopic[i] === 0) {
          if (start >= 0) expectedStrings.push([start, i - start]);
          start = -1;
        } else if (start < 0) {
          start = i;
        }
      }
      const tokenCount = e.test_help_decode_topic_formatted(
        topicIndex, topicOutWA, topicOutCapacity, topicTokensWA, topicTokenCapacity,
        topicPayloadWA, topicPayloadCapacity);
      if (tokenCount < 1) {
        formattedOk = false;
        formattedDetail = `topic=${topicIndex} count=${tokenCount} error=${e.get_help_last_error()}`;
        break;
      }
      const payloadSize = e.get_help_formatted_payload_size();
      formattedPayloadBytes += payloadSize;
      let textIndex = 0;
      for (let i = 0; i < tokenCount; i++) {
        const token = topicTokensWA + i * 16;
        const kind = dv.getUint32(token, true);
        const off = dv.getUint32(token + 4, true);
        const len = dv.getUint32(token + 8, true);
        if (kind === 1) {
          const expected = expectedStrings[textIndex++];
          if (!expected || off !== expected[0] || len !== expected[1]) {
            formattedOk = false;
            formattedDetail = `topic=${topicIndex} token=${i} TEXT=${off},${len}`;
            break;
          }
        } else if (kind === 13) {
          if (i + 1 !== tokenCount || off !== rawTopic.length || len !== 0) {
            formattedOk = false;
            formattedDetail = `topic=${topicIndex} token=${i} bad END_TOPIC`;
            break;
          }
        } else {
          formattedKinds[kind] = (formattedKinds[kind] || 0) + 1;
          if ([4,7,8,9,10].includes(kind) && off + len > payloadSize) {
            formattedOk = false;
            formattedDetail = `topic=${topicIndex} token=${i} payload=${off}+${len}>${payloadSize}`;
            break;
          }
        }
      }
      if (textIndex !== expectedStrings.length) {
        formattedOk = false;
        formattedDetail = `topic=${topicIndex} text=${textIndex}/${expectedStrings.length}`;
      }
    }
    check(`${file} exact interleaved formatted topic IR`,
      formattedOk && formattedPayloadBytes === semantic.payloadBytes &&
      JSON.stringify(formattedKinds) === JSON.stringify(semantic.formattedKinds),
      `${formattedDetail} payload=${formattedPayloadBytes} kinds=${JSON.stringify(formattedKinds)}`);
  }

  const cntHashText = Buffer.from('WIN_HELP_AUTOCLOSE', 'latin1');
  bytes.set(cntHashText, nameWA);
  check('CNT context-name hash matches the WinHelp compiler algorithm',
    (e.test_help_cnt_hash(nameWA, cntHashText.length) >>> 0) === 3742568226);
  function expectedCntHashByte(ch) {
    if (ch === 0) return 0;
    if (ch === 33) return 11;
    if (ch === 46) return 12;
    if (ch <= 90) return ch - 48;
    if (ch <= 94) return ch - 80;
    if (ch === 95) return 13;
    if (ch === 96) return 16;
    if (ch <= 127) return ch - 80;
    if (ch === 132) return 11;
    return ch - 256;
  }
  check('CNT hash implements every entry in the documented signed-byte table',
    Array.from({ length: 256 }, (_, ch) => {
      bytes[nameWA] = ch;
      return e.test_help_cnt_hash(nameWA, 1) === expectedCntHashByte(ch);
    }).every(Boolean) && e.test_help_cnt_hash(nameWA, 0) === 1);
  check('CNT recognizes every standard directive case-insensitively',
    [['bAsE', 1], ['TITLE', 2], ['Index', 3], ['include', 4], ['LINK', 5], ['NoDef', 6]]
      .every(([name, kind]) => {
        bytes.set(Buffer.from(name, 'latin1'), nameWA);
        return e.test_help_cnt_directive_kind(nameWA, name.length) === kind;
      }));

  function readCntNode(index) {
    const record = e.get_help_cnt_node(index);
    if (!record) return null;
    return {
      parent: dv.getInt32(record, true),
      firstChild: dv.getInt32(record + 4, true),
      nextSibling: dv.getInt32(record + 8, true),
      depth: dv.getUint16(record + 12, true),
      flags: dv.getUint16(record + 14, true),
      title: readLatin1(dv.getUint32(record + 16, true), dv.getUint32(record + 20, true)),
      topicRef: dv.getInt32(record + 24, true),
      target: dv.getUint32(record + 28, true)
        ? readLatin1(dv.getUint32(record + 28, true),
          bytes.indexOf(0, dv.getUint32(record + 28, true)) - dv.getUint32(record + 28, true))
        : '',
    };
  }

  const cntFixtures = [
    ['calc', 'calc.hlp', 'calc.hlp', 'Calculator Help', 1],
    ['freecell', 'freecell.hlp', 'freecell.hlp>proc4', 'FreeCell Help', 3],
    ['mspaint', 'mspaint.hlp', 'mspaint.hlp', 'Paint Help', 1],
    ['notepad', 'notepad.hlp', 'notepad.hlp', 'Notepad Help', 1],
    ['wordpad', 'wordpad.hlp', 'wordpad.hlp', 'WordPad Help', 1],
  ];
  for (const [name, hlpName, base, title, nodeCount] of cntFixtures) {
    const hlp = fs.readFileSync(path.join(HELP, hlpName));
    const cnt = fs.readFileSync(path.join(HELP, `${name}.cnt`));
    check(`${name}.cnt HLP fixture reloads`, load(hlp) === 1);
    check(`${name}.cnt parses transactionally`, loadCnt(cnt) === 1,
      `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
    check(`${name}.cnt exact directives and inventory`,
      readLatin1(e.get_help_cnt_base_ptr(), e.get_help_cnt_base_length()) === base &&
      readLatin1(e.get_help_cnt_title_ptr(), e.get_help_cnt_title_length()) === title &&
      e.get_help_cnt_node_count() === nodeCount);
    const nodes = Array.from({ length: nodeCount }, (_, index) => readCntNode(index));
    check(`${name}.cnt canonical root sibling chain`, nodes.every((node, index) =>
      node && node.parent === -1 && node.firstChild === -1 && node.depth === 1 &&
      node.nextSibling === (index + 1 < nodeCount ? index + 1 : -1) &&
      (node.flags & 2) !== 0 && node.target !== ''));
    if (name === 'notepad') {
      check('notepad.cnt leaf binds through the exact context hash',
        nodes[0].topicRef === 994 && (nodes[0].flags & 8) === 0);
    }
    if (name === 'freecell') {
      check('freecell.cnt retains explicit unresolved leaves',
        nodes.every(node => node.topicRef === -1 && (node.flags & 8) !== 0));
    }
  }

  const hoverCnt = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'shareware', 'HOVER!', 'HOVER.CNT'));
  check('HOVER.CNT parses its real compact-depth syntax', loadCnt(hoverCnt) === 1,
    `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
  const hoverNodes = Array.from({ length: e.get_help_cnt_node_count() }, (_, index) => readCntNode(index));
  check('HOVER.CNT exact directives and node inventory',
    readLatin1(e.get_help_cnt_base_ptr(), e.get_help_cnt_base_length()) === 'Hover.hlp>PROC4' &&
    readLatin1(e.get_help_cnt_title_ptr(), e.get_help_cnt_title_length()) === 'Hover! Help' &&
    hoverNodes.length === 22);
  check('HOVER.CNT canonical hierarchy and macro flags',
    hoverNodes[0]?.title === 'Introduction' && hoverNodes[1]?.title === 'ReadMe' &&
    (hoverNodes[1]?.flags & (2 | 8 | 16)) === (2 | 8 | 16) &&
    hoverNodes[2]?.title === 'Getting Started' && hoverNodes[2]?.firstChild === 3 &&
    hoverNodes[3]?.parent === 2 && hoverNodes[9]?.title === 'Tips and strategies' &&
    hoverNodes[10]?.title === 'Customizing Hover!' && hoverNodes[10]?.firstChild === 11 &&
    hoverNodes[16]?.title === 'Troubleshooting' && hoverNodes[16]?.firstChild === 17 &&
    hoverNodes[21]?.nextSibling === -1);

  {
    // notepad.hlp's first two topics are single-column tables that hold the
    // whole topic body. Layout rejected both outright, so notepad's help
    // could only ever open on its third topic. Fail code 6 is the margin
    // check that a 1-unit-wide cell could not pass.
    check('notepad.hlp reloads for the table-topic check',
      load(fs.readFileSync(path.join(HELP, 'notepad.hlp'))) === 1);
    const laid = [];
    for (let index = 0; index < e.get_help_topic_count(); index++) {
      const tokens = e.test_help_decode_topic_formatted(index, topicOutWA, topicOutCapacity,
        topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity);
      laid.push(tokens < 1 ? -1 : e.test_help_layout_tokens_with_payload(
        topicOutWA, topicOutCapacity, topicPayloadWA, e.get_help_formatted_payload_size(),
        topicTokensWA, tokens, staging + 0x80000, 2048, 560));
    }
    check('every notepad.hlp topic lays out, tables included',
      laid.length === 4 && laid.every(runs => runs >= 0) &&
      laid[0] > 100 && laid[1] > 100,
      `runs=${JSON.stringify(laid)} fail=${e.get_help_layout_fail_code()}`);
    // A caller whose run buffer is too small used to get a bare -1 with no
    // fail code, which reads as "this topic is broken" when the topic is
    // merely long. Code 17 says so and reports the count the caller needs.
    const tokens = e.test_help_decode_topic_formatted(2, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity);
    const short = e.test_help_layout_tokens_with_payload(topicOutWA, topicOutCapacity,
      topicPayloadWA, e.get_help_formatted_payload_size(), topicTokensWA, tokens,
      staging + 0x80000, 4, 560);
    check('too small a run buffer reports its own code and the count needed',
      tokens > 1 && short === -1 && e.get_help_layout_fail_code() === 17 &&
      e.get_help_layout_fail_token() > 4 && e.get_help_layout_fail_token() === laid[2],
      `short=${short} code=${e.get_help_layout_fail_code()} ` +
      `needs=${e.get_help_layout_fail_token()} actual=${laid[2]}`);
  }

  const syntheticCnt = Buffer.from(
    ':Base fixture.hlp\n:Title Fixture\n1 Root\n2 Child=WIN_HELP_AUTOCLOSE\n' +
    '2 Macro=!ExecProgram("bad.exe")\n1 Peer=999999\n', 'latin1');
  check('synthetic CNT binding HLP reloads',
    load(fs.readFileSync(path.join(HELP, 'notepad.hlp'))) === 1);
  check('synthetic CNT hierarchy parses', loadCnt(syntheticCnt) === 1);
  const syntheticCntNodes = Array.from({ length: e.get_help_cnt_node_count() }, (_, index) => readCntNode(index));
  check('synthetic CNT publishes exact parent/child/sibling records',
    syntheticCntNodes.length === 4 && syntheticCntNodes[0].firstChild === 1 &&
    syntheticCntNodes[0].nextSibling === 3 && syntheticCntNodes[1].parent === 0 &&
    syntheticCntNodes[1].nextSibling === 2 && syntheticCntNodes[2].parent === 0 &&
    (syntheticCntNodes[2].flags & (2 | 8 | 16)) === (2 | 8 | 16) &&
    (syntheticCntNodes[3].flags & (2 | 8)) === (2 | 8));
  check('Topics Contents starts with only canonical root rows visible',
    e.test_help_dispatch_loaded(0x5151, 0x000b, 0) === 1 &&
    e.get_help_session_mode() === 3 && e.get_help_topics_contents_selection() === 0 &&
    e.get_help_cnt_visible_count() === 2 && e.get_help_cnt_visible_at(0) === 0 &&
    e.get_help_cnt_visible_at(1) === 3 && e.get_help_cnt_visible_at(2) === -1);
  check('Topics Display toggles a book and exposes its children',
    e.test_help_topics_activate(0x5151) === 2 && e.get_help_cnt_visible_count() === 4 &&
    (readCntNode(0).flags & 4) !== 0 && e.get_help_cnt_visible_at(1) === 1);
  check('Topics keyboard movement selects a visible child',
    e.test_help_topics_move_selection(1) === 1 &&
    e.get_help_topics_contents_selection() === 1);
  check('Topics Display binds a resolved CNT leaf transactionally',
    e.test_help_topics_activate(0x5151) === 1 && e.get_help_session_mode() === 1 &&
    e.get_help_session_topic_ref() === 994);
  check('Topics macro leaves fail safely without changing the visible topic',
    e.test_help_dispatch_loaded(0x5151, 0x000b, 0) === 1 &&
    e.test_help_topics_expand_contents(0, 2) === 1 &&
    e.test_help_topics_select_contents(2) === 1 &&
    e.test_help_topics_activate(0x5151) === 0 && e.get_help_dispatch_status() === 6 &&
    e.get_help_session_topic_ref() === 994 && e.get_help_session_mode() === 3);
  check('collapsing a book moves a hidden selection back to the book',
    e.test_help_topics_expand_contents(0, 1) === 1 &&
    e.get_help_topics_contents_selection() === 0 && e.get_help_cnt_visible_count() === 2);
  const preservedCntNode = e.get_help_cnt_node(0);
  const malformedCntCases = [
    ['depth jump', '1 Root\n3 Bad\n', 18],
    ['empty title', '1 =WIN_HELP_AUTOCLOSE\n', 18],
    ['child below leaf', '1 Leaf=WIN_HELP_AUTOCLOSE\n2 Child\n', 18],
    ['unknown directive', ':Mystery value\n1 Root\n', 18],
    ['embedded NUL', '1 Root\0Hidden\n', 18],
  ];
  for (const [name, source, error] of malformedCntCases) {
    check(`CNT rejects ${name} without replacing the published hierarchy`,
      loadCnt(Buffer.from(source, 'latin1')) === 0 && e.get_help_last_error() === error &&
      e.get_help_cnt_node_count() === 4 && e.get_help_cnt_node(0) === preservedCntNode);
  }
  const excessiveCnt = Buffer.from(`${'1 x\n'.repeat(16385)}`, 'latin1');
  check('CNT node cap is enforced transactionally',
    loadCnt(excessiveCnt) === 0 && e.get_help_last_error() === 6 &&
    e.get_help_cnt_node_count() === 4 && e.get_help_cnt_node(0) === preservedCntNode);
  check('CNT byte cap precedes source access',
    e.test_help_load_cnt_buffer(staging, 0x00100001) === 0 && e.get_help_last_error() === 6);
  check('CNT source range is bounded',
    e.test_help_load_cnt_buffer(memory.buffer.byteLength - 1, 2) === 0 && e.get_help_last_error() === 1);

  const capacityFixture = fs.readFileSync(path.join(HELP, 'freecell.hlp'));
  check('topic decoder fixture reloads for capacity test', load(capacityFixture) === 1);
  check('topic decoder enforces caller output capacity',
    e.test_help_decode_topic_raw(0, topicOutWA, 114) === -1 && e.get_help_last_error() === 6);
  check('topic decoder rejects an out-of-range topic index',
    e.test_help_decode_topic_raw(e.get_help_topic_count(), topicOutWA, topicOutCapacity) === -1);
  check('topic string-token builder fixture reloads', load(capacityFixture) === 1);
  bytes.fill(0xaa, topicTokensWA, topicTokensWA + 16);
  check('topic string-token builder preflights output capacity',
    e.test_help_decode_topic_strings(0, topicOutWA, topicOutCapacity, topicTokensWA, 0) === -1 &&
    e.get_help_last_error() === 6 && bytes.subarray(topicTokensWA, topicTokensWA + 16).every(byte => byte === 0xaa));
  check('topic string-token builder validates output memory bounds',
    load(capacityFixture) === 1 &&
    e.test_help_decode_topic_strings(0, topicOutWA, topicOutCapacity, memory.buffer.byteLength - 8, 1) === -1 &&
    e.get_help_last_error() === 1);
  check('topic string-token builder rejects overlapping raw and token buffers',
    load(capacityFixture) === 1 &&
    e.test_help_decode_topic_strings(0, topicOutWA, topicOutCapacity, topicOutWA, topicTokenCapacity) === -1 &&
    e.get_help_last_error() === 1);

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
  check('synthetic canonical topics bind to exact TOPICPOS records',
    [12,61,110,159].every((pos, index) =>
      dv.getUint32(e.get_help_topic_record(index) + 4, true) === pos));
  check('two-level signed hash tree resolves both leaves',
    e.test_help_resolve_context_hash(-10) === 0 && e.test_help_resolve_context_hash(20) === 30);
  check('synthetic numeric maps resolve canonical topics',
    e.test_help_resolve_context_id(7) === 20 && e.test_help_resolve_context_id(8) === 0);

  const keywordEntries = [
    ['Alpha', [0,20]],
    ['Beta', [10]],
    ['Gamma', [-1,30]],
    ['zeta', [20]],
  ];
  const keywordIndex = buildKeywordIndex(keywordEntries);
  {
    // A |CONTEXT entry or |CTXOMAP entry that names no topic header costs
    // that one jump, not the document. CHIPEDIT.HLP (132KB) and qbob.hlp
    // (85KB) were both refused entirely over exactly this, and qbob.hlp
    // renders 9 of its 10 topics once it is allowed to load. The count is
    // exported so a file dropping many entries stays visible - that would
    // mean the topic-header scan is wrong, not the file.
    const danglingMap = Buffer.alloc(26);
    danglingMap.writeUInt16LE(3, 0);
    danglingMap.writeUInt32LE(7, 2);
    danglingMap.writeUInt32LE(20, 6);
    danglingMap.writeUInt32LE(8, 10);
    danglingMap.writeUInt32LE(0, 14);
    danglingMap.writeUInt32LE(9, 18);
    danglingMap.writeUInt32LE(999999, 22);
    const danglingHelp = buildSyntheticSemanticHelp({
      extraFiles: [['|CTXOMAP', danglingMap],
        ['|CONTEXT', buildSemanticBtree('contexts', 999999)]],
    });
    check('a context entry naming no topic drops that entry, not the file',
      load(danglingHelp.file) === 1 && e.get_help_context_dropped() === 2 &&
      e.get_help_topic_count() === 4,
      `error=${e.get_help_last_error()} dropped=${e.get_help_context_dropped()}`);
    check('the surviving context entries still resolve',
      e.test_help_resolve_context_id(7) === 20 &&
      e.test_help_resolve_context_id(9) === -1);
    check('a healthy file drops no context entries',
      load(semanticTree.file) === 1 && e.get_help_context_dropped() === 0);
  }

  const keywordHelp = buildSyntheticSemanticHelp({ extraFiles: [
    ['|KWBTREE', keywordIndex.tree], ['|KWDATA', keywordIndex.data],
  ] });
  check('two-level keyword B+tree and KWDATA parse transactionally',
    load(keywordHelp.file) === 1 && e.get_help_keyword_count() === 4 &&
    e.get_help_keyword_posting_count() === 6,
    `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
  const syntheticKeywords = Array.from({ length: e.get_help_keyword_count() }, (_, index) => {
    const record = e.get_help_keyword_record(index);
    return [readLatin1(e.get_help_keyword_ptr(index), e.get_help_keyword_len(index)),
      dv.getUint32(record + 8, true), dv.getUint32(record + 12, true)];
  });
  const syntheticPostings = Array.from({ length: e.get_help_keyword_posting_count() }, (_, index) => {
    const posting = e.get_help_keyword_posting(index);
    return [dv.getUint32(posting, true), dv.getUint32(posting + 4, true)];
  });
  check('keyword records retain exact sorted strings and posting ranges',
    JSON.stringify(syntheticKeywords) === JSON.stringify([
      ['Alpha',0,2],['Beta',2,1],['Gamma',3,2],['zeta',5,1],
    ]) && JSON.stringify(syntheticPostings) === JSON.stringify([
      [0,0],[20,0],[10,0],[0xffffffff,1],[30,0],[20,0],
    ]));
  bytes.set(Buffer.from('ALPHA', 'latin1'), nameWA);
  const exactKeyword = e.test_help_find_keyword(nameWA, 5);
  bytes.set(Buffer.from('ga', 'latin1'), nameWA);
  const prefixKeyword = e.test_help_find_keyword_prefix(nameWA, 2);
  const resolvedGamma = e.test_help_resolve_keyword_prefix(nameWA, 2);
  bytes.set(Buffer.from('ZE', 'latin1'), nameWA);
  const resolvedZeta = e.test_help_resolve_keyword_prefix(nameWA, 2);
  bytes.set(Buffer.from('missing', 'latin1'), nameWA);
  check('keyword lookup is case-insensitive with deterministic prefix selection',
    exactKeyword === 0 && prefixKeyword === 2 && resolvedGamma === 30 && resolvedZeta === 20 &&
    e.test_help_find_keyword(nameWA, 7) === -1 &&
    e.test_help_resolve_keyword(nameWA, 7) === -1 &&
    e.test_help_find_keyword(memory.buffer.byteLength - 1, 2) === -1);
  check('keyword inspection is bounded',
    e.get_help_keyword_record(4) === 0 && e.get_help_keyword_ptr(4) === 0 &&
    e.get_help_keyword_len(4) === 0 && e.get_help_keyword_posting(6) === 0);

  const dispatchOwner = 0x1111;
  check('HELP_CONTEXT resolves and atomically owns the loaded session',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0001, 7) === 1 &&
    e.get_help_session_owner() === dispatchOwner &&
    e.get_help_session_topic_ref() === 20 && e.get_help_session_topic_index() === 2 &&
    e.get_help_session_mode() === 1 && e.get_help_dispatch_status() === 1);
  check('unresolved HELP_CONTEXT preserves the visible topic',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0001, 0x7fffffff) === 0 &&
    e.get_help_session_topic_ref() === 20 && e.get_help_session_topic_index() === 2 &&
    e.get_help_session_mode() === 1 && e.get_help_dispatch_status() === 4);
  writeCString(nameWA, 'BETA');
  check('HELP_KEY performs an exact case-insensitive keyword navigation',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0101, nameWA) === 1 &&
    e.get_help_session_topic_ref() === 10 && e.get_help_session_topic_index() === 1 &&
    e.get_help_session_mode() === 1 && e.get_help_session_keyword_index() === -1);
  writeCString(nameWA, 'missing');
  check('missing HELP_KEY preserves the current topic transactionally',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0101, nameWA) === 0 &&
    e.get_help_session_topic_ref() === 10 && e.get_help_session_topic_index() === 1 &&
    e.get_help_dispatch_status() === 4);
  check('HELP_KEY rejects a null string pointer without changing topic state',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0101, 0) === 0 &&
    e.get_help_session_topic_ref() === 10 && e.get_help_dispatch_status() === 5);
  {
    // The allowlisted macros navigate through exactly the dispatch the API
    // commands use - map id 7 and keyword BETA are the same targets the two
    // checks above resolved.
    const macroWA = nameWA + 0x400;
    const runMacro = text => {
      const buf = Buffer.from(text, 'latin1');
      bytes.set(buf, macroWA);
      return e.test_help_macro_execute(dispatchOwner, macroWA, buf.length);
    };
    check('JumpContext navigates exactly like HELP_CONTEXT',
      runMacro('JumpContext(7)') === 1 && e.get_help_session_topic_ref() === 20 &&
      e.get_help_session_mode() === 1 && e.get_help_dispatch_status() === 1);
    check('KLink navigates exactly like HELP_KEY',
      runMacro('KL("BETA")') === 1 && e.get_help_session_topic_ref() === 10 &&
      e.get_help_session_mode() === 1 && e.get_help_dispatch_status() === 1);
    check('a macro is matched case-insensitively and tolerates spacing',
      runMacro('  jumpcontext ( 7 )') === 1 &&
      e.get_help_session_topic_ref() === 20 && e.get_help_session_mode() === 1);
    // Runs last of the group: it leaves the session in popup mode, and the
    // keyword checks that follow expect the main viewer.
    check('PopupContext presents the same topic as a popup',
      runMacro('PC(7)') === 1 && e.get_help_session_topic_ref() === 20 &&
      e.get_help_session_mode() === 2);
    writeCString(nameWA, 'BETA');
    e.test_help_dispatch_loaded(dispatchOwner, 0x0101, nameWA);
  }
  bytes.fill(0x61, nameWA, nameWA + 512);
  check('HELP_KEY bounds unterminated command data',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0101, nameWA) === 0 &&
    e.get_help_session_topic_ref() === 10 && e.get_help_dispatch_status() === 5);
  bytes[memory.buffer.byteLength - 1] = 0x61;
  check('HELP_KEY bounds command data at the end of linear memory',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0101, memory.buffer.byteLength - 1) === 0 &&
    e.get_help_session_topic_ref() === 10 && e.get_help_dispatch_status() === 5);
  writeCString(nameWA, 'ga');
  check('HELP_PARTIALKEY opens Index with deterministic prefix selection',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0105, nameWA) === 1 &&
    e.get_help_session_mode() === 4 && e.get_help_session_keyword_index() === 2 &&
    e.get_help_session_topic_ref() === 10);
  writeCString(nameWA, '');
  check('empty HELP_PARTIALKEY opens Index without a selection',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0105, nameWA) === 1 &&
    e.get_help_session_mode() === 4 && e.get_help_session_keyword_index() === -1);
  check('Index keyboard movement chooses the first canonical keyword',
    e.test_help_topics_move_selection(1) === 1 &&
    e.get_help_session_keyword_index() === 0 && e.get_help_topics_first_visible() === 0);
  check('Index Display resolves postings through the shared navigation engine',
    e.test_help_topics_activate(dispatchOwner) === 1 &&
    e.get_help_session_mode() === 1 && e.get_help_session_topic_ref() === 0);
  writeCString(nameWA, 'Beta');
  check('keyword navigation restores the dispatcher fixture topic',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0101, nameWA) === 1 &&
    e.get_help_session_topic_ref() === 10);
  check('HELP_FINDER opens the Topics dialog without changing topic state',
    e.test_help_dispatch_loaded(dispatchOwner, 0x000b, 0) === 1 &&
    e.get_help_session_mode() === 3 && e.get_help_session_topic_ref() === 10);
  check('a different owner cannot reuse the active document session',
    e.test_help_dispatch_loaded(0x2222, 0x0001, 8) === 0 &&
    e.get_help_session_owner() === dispatchOwner && e.get_help_session_topic_ref() === 10 &&
    e.get_help_dispatch_status() === 3);
  check('HELP_SETCONTENTS resolves a context before publishing the override',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0005, 8) === 1 &&
    e.get_help_session_contents_override() === 0 && e.get_help_session_topic_ref() === 10);
  check('HELP_CONTENTS and HELP_INDEX use the configured override',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0003, 0) === 1 &&
    e.get_help_session_topic_ref() === 0 && e.get_help_session_topic_index() === 0 &&
    e.get_help_session_mode() === 1);
  check('HELP_CONTEXTPOPUP resolves the numeric context into popup state',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0008, 7) === 1 &&
    e.get_help_session_topic_ref() === 20 && e.get_help_session_mode() === 2);
  check('known but not-yet-parsed structured commands fail explicitly',
    e.test_help_dispatch_loaded(dispatchOwner, 0x000a, nameWA) === 0 &&
    e.get_help_session_topic_ref() === 20 && e.get_help_session_mode() === 2 &&
    e.get_help_dispatch_status() === 6);
  check('unknown WinHelp commands fail explicitly without falling through',
    e.test_help_dispatch_loaded(dispatchOwner, 0x7777, 0) === 0 &&
    e.get_help_session_topic_ref() === 20 && e.get_help_session_mode() === 2 &&
    e.get_help_dispatch_status() === 6);
  check('HELP_QUIT rejects an unrelated owner without releasing the document',
    e.test_help_dispatch_loaded(0x2222, 0x0002, 0) === 0 &&
    e.get_help_file_ptr() !== 0 && e.get_help_session_owner() === dispatchOwner &&
    e.get_help_dispatch_status() === 3);
  check('HELP_QUIT releases the matching owner and document state',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0002, 0) === 1 &&
    e.get_help_file_ptr() === 0 && e.get_help_session_owner() === 0 &&
    e.get_help_session_topic_ref() === -1 && e.get_help_session_mode() === 0 &&
    e.get_help_dispatch_status() === 1);
  check('non-QUIT dispatch without a document fails deterministically',
    e.test_help_dispatch_loaded(dispatchOwner, 0x0001, 7) === 0 &&
    e.get_help_dispatch_status() === 2 && e.get_help_session_topic_ref() === -1);

  const halfKeywordHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|KWBTREE', keywordIndex.tree]],
  });
  check('half of a keyword index pair is a missing-internal error',
    load(halfKeywordHelp.file) === 0 && e.get_help_last_error() === 8 &&
    e.get_help_keyword_count() === 0 && e.get_help_topic_count() === 0);
  const badKeywordSlice = Buffer.from(keywordIndex.tree);
  badKeywordSlice.writeUInt32LE(0xfffffffc, keywordIndex.leafEntries[0].dataOffsetField);
  const badKeywordSliceHelp = buildSyntheticSemanticHelp({ extraFiles: [
    ['|KWBTREE', badKeywordSlice], ['|KWDATA', keywordIndex.data],
  ] });
  check('keyword posting slices are bounded by KWDATA',
    load(badKeywordSliceHelp.file) === 0 && e.get_help_last_error() === 17 &&
    e.get_help_keyword_count() === 0 && e.get_help_topic_count() === 0);
  const badKeywordTopicData = Buffer.from(keywordIndex.data);
  badKeywordTopicData.writeUInt32LE(999, 0);
  const badKeywordTopicHelp = buildSyntheticSemanticHelp({ extraFiles: [
    ['|KWBTREE', keywordIndex.tree], ['|KWDATA', badKeywordTopicData],
  ] });
  check('keyword postings must resolve canonical topics or macro sentinels',
    load(badKeywordTopicHelp.file) === 0 && e.get_help_last_error() === 17 &&
    e.get_help_keyword_count() === 0 && e.get_help_topic_count() === 0);
  const unsortedKeywordIndex = buildKeywordIndex([
    ['Beta',[0]],['alpha',[10]],['Gamma',[20]],['zeta',[30]],
  ]);
  const unsortedKeywordHelp = buildSyntheticSemanticHelp({ extraFiles: [
    ['|KWBTREE', unsortedKeywordIndex.tree], ['|KWDATA', unsortedKeywordIndex.data],
  ] });
  check('keyword leaves must be strictly case-folded sorted',
    load(unsortedKeywordHelp.file) === 0 && e.get_help_last_error() === 17 &&
    e.get_help_keyword_count() === 0);
  const cyclicKeywordIndex = buildKeywordIndex(keywordEntries, { leafCycle: true });
  const cyclicKeywordHelp = buildSyntheticSemanticHelp({ extraFiles: [
    ['|KWBTREE', cyclicKeywordIndex.tree], ['|KWDATA', cyclicKeywordIndex.data],
  ] });
  check('cyclic keyword leaf links fail before publication',
    load(cyclicKeywordHelp.file) === 0 && e.get_help_last_error() === 17 &&
    e.get_help_keyword_count() === 0);
  const cyclicKeywordRoot = buildKeywordIndex(keywordEntries, { indexCycle: true });
  const cyclicKeywordRootHelp = buildSyntheticSemanticHelp({ extraFiles: [
    ['|KWBTREE', cyclicKeywordRoot.tree], ['|KWDATA', cyclicKeywordRoot.data],
  ] });
  check('cyclic keyword index descent fails before publication',
    load(cyclicKeywordRootHelp.file) === 0 && e.get_help_last_error() === 17 &&
    e.get_help_keyword_count() === 0);
  const oversizedKeywordTree = Buffer.from(keywordIndex.tree);
  oversizedKeywordTree.writeUInt32LE(65537, 34);
  const oversizedKeywordHelp = buildSyntheticSemanticHelp({ extraFiles: [
    ['|KWBTREE', oversizedKeywordTree], ['|KWDATA', keywordIndex.data],
  ] });
  check('keyword count cap is enforced before allocation',
    load(oversizedKeywordHelp.file) === 0 && e.get_help_last_error() === 6 &&
    e.get_help_keyword_count() === 0);
  const oddKeywordDataHelp = buildSyntheticSemanticHelp({ extraFiles: [
    ['|KWBTREE', keywordIndex.tree],
    ['|KWDATA', Buffer.concat([keywordIndex.data, Buffer.from([0])])],
  ] });
  check('KWDATA must be a complete topic-reference array',
    load(oddKeywordDataHelp.file) === 0 && e.get_help_last_error() === 17 &&
    e.get_help_keyword_count() === 0);
  check('keyword fixture reloads after transactional failure tests',
    load(keywordHelp.file) === 1 && e.get_help_keyword_count() === 4);
  check('synthetic header-only topics decode to empty raw streams',
    [0,1,2,3].every(index => e.test_help_decode_topic_raw(index, topicOutWA, topicOutCapacity) === 0));
  check('empty synthetic topic emits only END_TOPIC',
    e.test_help_decode_topic_strings(0, topicOutWA, topicOutCapacity, topicTokensWA, topicTokenCapacity) === 1 &&
    dv.getUint32(topicTokensWA, true) === 13 && dv.getUint32(topicTokensWA + 4, true) === 0);
  check('empty formatted topic permits zero-length arena aliases',
    e.test_help_decode_topic_formatted(0, topicTokensWA, 0,
      topicTokensWA, 1, topicTokensWA, 0) === 1 &&
    dv.getUint32(topicTokensWA, true) === 13);

  const formattedParts = buildSyntheticFormattedTopic({ returnParts: true });
  const formattedCommands = buildSyntheticSemanticHelp({ topic: formattedParts.topic });
  check('documented LinkData1 command payload families parse',
    load(formattedCommands.file) === 1 &&
    e.get_help_display_record_count() === 1 && e.get_help_paragraph_count() === 1 &&
    e.get_help_table_count() === 0 && e.get_help_format_command_count() === 13);
  check('formatted-command fixture retains one string per command',
    e.test_help_decode_topic_strings(0, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity) === 14 &&
    Array.from({ length: 13 }, (_, index) =>
      dv.getUint32(topicTokensWA + index * 16, true) === 1 &&
      dv.getUint32(topicTokensWA + index * 16 + 8, true) === 1).every(Boolean) &&
    dv.getUint32(topicTokensWA + 13 * 16, true) === 13);
  const formattedTokenKinds = [
    4, 1, 5, 1, 3, 1, 3, 1, 2, 1, 9, 1, 7, 1, 8, 1, 10, 1, 8, 1, 7, 1, 2, 1, 2, 1, 13,
  ];
  const formattedTokenCount = e.test_help_decode_topic_formatted(
    0, topicOutWA, topicOutCapacity, topicTokensWA, topicTokenCapacity,
    topicPayloadWA, topicPayloadCapacity);
  check('formatted topic interleaves every documented semantic token kind',
    formattedTokenCount === formattedTokenKinds.length &&
    formattedTokenKinds.every((kind, index) =>
      dv.getUint32(topicTokensWA + index * 16, true) === kind),
    `count=${formattedTokenCount}`);
  check('formatted topic owns an exact stable LinkData1 payload copy',
    e.get_help_formatted_payload_size() === formattedParts.displayFormat.length &&
    Buffer.from(bytes.subarray(topicPayloadWA,
      topicPayloadWA + formattedParts.displayFormat.length)).equals(formattedParts.displayFormat));
  const formattedTextTokens = formattedTokenKinds
    .map((kind, index) => [kind, topicTokensWA + index * 16])
    .filter(([kind]) => kind === 1)
    .map(([, token]) => [dv.getUint32(token + 4, true), dv.getUint32(token + 8, true)]);
  check('formatted TEXT tokens retain exact LinkData2 offsets',
    JSON.stringify(formattedTextTokens) ===
      JSON.stringify(Array.from({ length: 13 }, (_, index) => [index * 2, 1])));
  check('formatted variable tokens address their copied command payloads',
    formattedTokenKinds.every((kind, index) => {
      if (![7, 8, 10].includes(kind)) return true;
      const token = topicTokensWA + index * 16;
      const off = dv.getUint32(token + 4, true);
      const len = dv.getUint32(token + 8, true);
      const value = dv.getUint32(token + 12, true);
      return len >= 1 && bytes[topicPayloadWA + off] === value;
    }));
  const unsupportedBitmapToken = topicTokensWA + formattedTokenKinds.indexOf(9) * 16;
  check('inline bitmap tokens retain exact bytes without a resource alias',
    dv.getUint32(unsupportedBitmapToken + 12, true) === 0 &&
    bytes[topicPayloadWA + dv.getUint32(unsupportedBitmapToken + 4, true)] === 0x86);
  const formattedParagraphTokens = formattedTokenKinds
    .map((kind, index) => [kind, topicTokensWA + index * 16])
    .filter(([kind]) => kind === 4)
    .map(([, token]) => token);
  check('PARAGRAPH tokens retain exact direct headers and complete-record identity',
    formattedParagraphTokens.length > 0 && formattedParagraphTokens.every(token => {
      const off = dv.getUint32(token + 4, true);
      const len = dv.getUint32(token + 8, true);
      const value = dv.getUint32(token + 12, true);
      const recordOff = value & 0x00ffffff;
      const recordType = value >>> 24;
      return off > recordOff && len >= 6 &&
        off + len <= e.get_help_formatted_payload_size() &&
        [1, 0x20, 0x23].includes(recordType);
    }));

  const layoutRunsWA = staging + 0x80000;
  const layoutText = Buffer.from('alpha beta gamma', 'latin1');
  bytes.set(layoutText, topicOutWA);
  dv.setUint32(topicTokensWA, 1, true);
  dv.setUint32(topicTokensWA + 4, 0, true);
  dv.setUint32(topicTokensWA + 8, layoutText.length, true);
  dv.setUint32(topicTokensWA + 12, 0, true);
  dv.setUint32(topicTokensWA + 16, 13, true);
  dv.setUint32(topicTokensWA + 20, layoutText.length, true);
  dv.setBigUint64(topicTokensWA + 24, 0n, true);
  check('typed layout preflights the exact wrapped run count',
    e.test_help_layout_tokens(topicOutWA, layoutText.length,
      topicTokensWA, 2, 0, 131072, 64) === 5);
  const layoutCount = e.test_help_layout_tokens(topicOutWA, layoutText.length,
    topicTokensWA, 2, layoutRunsWA, 5, 64);
  const expectedLayout = [
    [1,8,8,35,16,0,5], [2,43,8,7,16,5,1],
    [1,8,24,28,16,6,4], [2,36,24,7,16,10,1],
    [1,8,40,35,16,11,5],
  ];
  const actualLayout = Array.from({ length: layoutCount }, (_, index) =>
    Array.from({ length: 7 }, (_, field) =>
      dv.getUint32(layoutRunsWA + index * 40 + field * 4, true)));
  check('typed layout owns deterministic word-wrap geometry and raw slices',
    layoutCount === expectedLayout.length &&
    JSON.stringify(actualLayout) === JSON.stringify(expectedLayout) &&
    e.get_help_layout_extent() === 56,
    `actual=${JSON.stringify(actualLayout)} extent=${e.get_help_layout_extent()}`);
  const hotspotText = Buffer.from('link', 'latin1');
  bytes.set(hotspotText, topicOutWA);
  bytes.fill(0, topicTokensWA, topicTokensWA + 64);
  dv.setUint32(topicTokensWA, 7, true);
  dv.setUint32(topicTokensWA + 16, 1, true);
  dv.setUint32(topicTokensWA + 20, 0, true);
  dv.setUint32(topicTokensWA + 24, hotspotText.length, true);
  dv.setUint32(topicTokensWA + 32, 8, true);
  dv.setUint32(topicTokensWA + 48, 13, true);
  check('typed layout retains exact hotspot token identity in each run',
    e.test_help_layout_tokens(topicOutWA, hotspotText.length,
      topicTokensWA, 4, layoutRunsWA, 1, 200) === 1 &&
    dv.getUint32(layoutRunsWA + 36, true) === 1);
  dv.setUint32(topicTokensWA + 32, 13, true);
  check('typed layout rejects an unterminated hotspot',
    e.test_help_layout_tokens(topicOutWA, hotspotText.length,
      topicTokensWA, 3, layoutRunsWA, 1, 200) === -1);
  dv.setUint32(topicTokensWA, 8, true);
  check('typed layout rejects an orphan hotspot terminator',
    e.test_help_layout_tokens(topicOutWA, hotspotText.length,
      topicTokensWA, 3, layoutRunsWA, 1, 200) === -1);

  // Both 0xC8 and its 0xCC without-font-change variant are closed by the same
  // 0x89 end command, so a macro command opens a hotspot region exactly like a
  // jump does. Real files rely on it: hover.hlp closes all 24 of its macros
  // that way, and a macro that did not open a region left every one of those
  // terminators orphaned and failed the whole topic.
  bytes.fill(0, topicTokensWA, topicTokensWA + 64);
  dv.setUint32(topicTokensWA, 10, true);
  dv.setUint32(topicTokensWA + 16, 1, true);
  dv.setUint32(topicTokensWA + 20, 0, true);
  dv.setUint32(topicTokensWA + 24, hotspotText.length, true);
  dv.setUint32(topicTokensWA + 32, 8, true);
  dv.setUint32(topicTokensWA + 48, 13, true);
  check('typed layout opens a hotspot region on a macro command',
    e.test_help_layout_tokens(topicOutWA, hotspotText.length,
      topicTokensWA, 4, layoutRunsWA, 1, 200) === 1 &&
    dv.getUint32(layoutRunsWA + 36, true) === 1);
  dv.setUint32(topicTokensWA + 32, 13, true);
  check('typed layout rejects an unterminated macro region',
    e.test_help_layout_tokens(topicOutWA, hotspotText.length,
      topicTokensWA, 3, layoutRunsWA, 1, 200) === -1);
  dv.setUint32(topicTokensWA, 7, true);
  dv.setUint32(topicTokensWA + 16, 10, true);
  dv.setUint32(topicTokensWA + 32, 8, true);
  dv.setUint32(topicTokensWA + 48, 13, true);
  check('typed layout rejects a macro region nested inside a hotspot',
    e.test_help_layout_tokens(topicOutWA, hotspotText.length,
      topicTokensWA, 4, layoutRunsWA, 1, 200) === -1);
  bytes.set(layoutText, topicOutWA);
  bytes.fill(0, topicTokensWA, topicTokensWA + 32);
  dv.setUint32(topicTokensWA, 1, true);
  dv.setUint32(topicTokensWA + 8, layoutText.length, true);
  dv.setUint32(topicTokensWA + 16, 13, true);
  dv.setUint32(topicTokensWA + 20, layoutText.length, true);
  bytes.fill(0xa5, layoutRunsWA, layoutRunsWA + 4 * 40);
  check('typed layout rejects short run capacity before writing',
    e.test_help_layout_tokens(topicOutWA, layoutText.length,
      topicTokensWA, 2, layoutRunsWA, 4, 64) === -1 &&
    bytes.subarray(layoutRunsWA, layoutRunsWA + 4 * 40).every(byte => byte === 0xa5));
  dv.setUint32(topicTokensWA + 4, layoutText.length, true);
  dv.setUint32(topicTokensWA + 8, 1, true);
  check('typed layout bounds every TEXT slice against LinkData2',
    e.test_help_layout_tokens(topicOutWA, layoutText.length,
      topicTokensWA, 2, 0, 131072, 64) === -1);
  bytes.fill(0xaa, topicTokensWA, topicTokensWA + 16);
  bytes.fill(0xbb, topicPayloadWA, topicPayloadWA + formattedParts.displayFormat.length);
  check('formatted topic preflights token capacity',
    load(formattedCommands.file) === 1 &&
    e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
      topicTokensWA, 1, topicPayloadWA, topicPayloadCapacity) === -1 &&
    e.get_help_last_error() === 6 &&
    bytes.subarray(topicTokensWA, topicTokensWA + 16).every(byte => byte === 0xaa) &&
    bytes.subarray(topicPayloadWA,
      topicPayloadWA + formattedParts.displayFormat.length).every(byte => byte === 0xbb));
  check('formatted topic preflights payload capacity',
    load(formattedCommands.file) === 1 &&
    e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, 1) === -1 &&
    e.get_help_last_error() === 6 &&
    bytes.subarray(topicTokensWA, topicTokensWA + 16).every(byte => byte === 0xaa) &&
    bytes.subarray(topicPayloadWA,
      topicPayloadWA + formattedParts.displayFormat.length).every(byte => byte === 0xbb));
  const overlapLoaded = load(formattedCommands.file);
  const overlapResult = e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
    topicTokensWA, topicTokenCapacity, topicTokensWA, topicPayloadCapacity);
  check('formatted topic rejects overlapping non-empty output arenas',
    overlapLoaded === 1 && overlapResult === -1 && e.get_help_last_error() === 1,
    `load=${overlapLoaded} result=${overlapResult} error=${e.get_help_last_error()}`);
  const mismatchedFormatted = buildSyntheticSemanticHelp({
    topic: buildSyntheticFormattedTopic({ stringCount: 11 }),
  });
  check('formatted topic rejects command/string count mismatch',
    load(mismatchedFormatted.file) === 1 &&
    e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity) === -1 &&
    e.get_help_last_error() === 14);

  // The two sides of the omitted-tail rule. A record whose text ends in bytes
  // no command claims is fine when they are NUL - that is what a Hall stream
  // that stopped early leaves behind - and is still malformed when they are
  // not, because then real text went unread.
  const pairedTokens = (() => {
    const paired = buildSyntheticSemanticHelp({ topic: buildSyntheticFormattedTopic() });
    load(paired.file);
    return e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity);
  })();
  const nulTailFormatted = buildSyntheticSemanticHelp({
    topic: buildSyntheticFormattedTopic({ trailingNuls: 6 }),
  });
  const nulTailLoaded = load(nulTailFormatted.file);
  const nulTailTokens = e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
    topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity);
  check('a text tail of unclaimed NULs is accepted and adds no tokens',
    nulTailLoaded === 1 && pairedTokens > 1 && nulTailTokens === pairedTokens,
    `loaded=${nulTailLoaded} paired=${pairedTokens} withTail=${nulTailTokens}`);
  const textTailFormatted = buildSyntheticSemanticHelp({
    topic: buildSyntheticFormattedTopic({ stringCount: 15 }),
  });
  check('a text tail carrying real bytes is still rejected',
    load(textTailFormatted.file) === 1 &&
    e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity) === -1 &&
    e.get_help_last_error() === 14);

  // A display record wider than one physical block: the walkers must gather
  // it across the boundary instead of rejecting it. Real files hit this on
  // any topic longer than a block (hover.hlp does it 20+ times).
  const crossBlockParts = buildSyntheticFormattedTopic({
    closeVariableHotspot: true, stringPadding: 4200,
    returnParts: true,
  });
  const crossBlockHelp = buildSyntheticSemanticHelp({
    systemFlags: 0, topic: packUncompressedTopicBlocks(crossBlockParts.links),
  });
  const crossBlockLoaded = load(crossBlockHelp.file);
  const crossBlockLoadGathers = e.get_help_topic_gather_count();
  const crossBlockTokens = e.test_help_decode_topic_formatted(0, topicOutWA,
    topicOutCapacity, topicTokensWA, topicTokenCapacity, topicPayloadWA,
    topicPayloadCapacity);
  check('a topic record straddling a physical block is gathered, not rejected',
    crossBlockLoaded === 1 && crossBlockLoadGathers === 1 &&
    crossBlockTokens > 0 && e.get_help_topic_gather_count() === 1 &&
    e.get_help_topic_count() === 4,
    `loaded=${crossBlockLoaded} loadGathers=${crossBlockLoadGathers} ` +
    `tokens=${crossBlockTokens} error=${e.get_help_last_error()}`);
  const crossBlockRaw = e.test_help_decode_topic_raw(0, topicOutWA, topicOutCapacity);
  const crossBlockText = Buffer.from(
    bytes.subarray(topicOutWA, topicOutWA + Math.max(crossBlockRaw, 0))).toString('latin1');
  const expectedCrossBlockText =
    Array.from({ length: 13 }, (_, index) => String.fromCharCode(65 + index) + '\0').join('') +
    'N' + 'X'.repeat(4200) + '\0';
  check('the reassembled record decodes to its exact bytes across the boundary',
    crossBlockRaw === expectedCrossBlockText.length &&
    crossBlockText === expectedCrossBlockText,
    `raw=${crossBlockRaw} expected=${expectedCrossBlockText.length}`);
  // The same fixture without padding fits inside one block and must not
  // touch the gather path at all.
  const singleBlockHelp = buildSyntheticSemanticHelp({
    systemFlags: 0,
    topic: packUncompressedTopicBlocks(buildSyntheticFormattedTopic({
      closeVariableHotspot: true, returnParts: true,
    }).links),
  });
  check('gathering is used only when a record actually crosses a boundary',
    load(singleBlockHelp.file) === 1 && e.get_help_topic_gather_count() === 0 &&
    e.test_help_decode_topic_raw(0, topicOutWA, topicOutCapacity) === 28);
  const truncatedCrossBlock = buildSyntheticSemanticHelp({
    systemFlags: 0,
    topic: packUncompressedTopicBlocks(crossBlockParts.links).subarray(0, 4096),
  });
  check('a record whose continuation block is missing fails before publication',
    load(truncatedCrossBlock.file) === 0 && e.get_help_last_error() === 13);

  // HOVER.HLP is the only real file in reach that uses macro commands at all,
  // and it is where the macro/hotspot pairing was discovered: all 24 of its
  // macros are closed by an 0x89 that had nothing to close before this.
  const hoverHelp = fs.readFileSync(
    path.join(ROOT, 'test', 'binaries', 'shareware', 'HOVER!', 'HOVER.HLP'));
  check('HOVER.HLP parses completely', load(hoverHelp) === 1 &&
    e.get_help_topic_count() === 49,
    `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
  const hoverMacros = [];
  let hoverLaidOut = 0;
  let hoverMacroRuns = 0;
  for (let index = 0; index < e.get_help_topic_count(); index++) {
    const tokens = e.test_help_decode_topic_formatted(index, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity);
    if (tokens < 1) continue;
    const payloadSize = e.get_help_formatted_payload_size();
    for (let token = 0; token < tokens; token++) {
      if (dv.getUint32(topicTokensWA + token * 16, true) !== 10) continue;
      const off = dv.getUint32(topicTokensWA + token * 16 + 4, true);
      hoverMacros.push({
        command: bytes[topicPayloadWA + off],
        text: readLatin1(topicPayloadWA + off + 3,
          dv.getUint16(topicPayloadWA + off + 1, true)).replace(/\0+$/, ''),
      });
    }
    const runs = e.test_help_layout_tokens_with_payload(topicOutWA, topicOutCapacity,
      topicPayloadWA, payloadSize, topicTokensWA, tokens, layoutRunsWA, 2048, 560);
    if (runs < 0) continue;
    hoverLaidOut++;
    for (let run = 0; run < runs; run++) {
      const flags = dv.getUint32(layoutRunsWA + run * 40 + 36, true) & 0x0fffffff;
      if (!flags) continue;
      if (dv.getUint32(topicTokensWA + (flags - 1) * 16, true) === 10) hoverMacroRuns++;
    }
  }
  check('HOVER.HLP macro commands are exactly the two documented forms',
    hoverMacros.length === 24 &&
    hoverMacros.filter(macro => macro.command === 0xc8).length === 23 &&
    hoverMacros.filter(macro => macro.command === 0xcc).length === 1 &&
    hoverMacros.filter(macro => macro.text.startsWith('PlayWave(')).length === 23 &&
    hoverMacros.find(macro => macro.command === 0xcc).text === 'AL("a-playingtopics")',
    `macros=${JSON.stringify(hoverMacros.slice(0, 3))} n=${hoverMacros.length}`);
  // Every topic in the file lays out, tables included. The five that used to
  // be rejected were single-column tables whose column record was read as
  // { gap, width } instead of { width, gap }.
  check('HOVER.HLP macro regions lay out as clickable runs',
    hoverLaidOut === 49 && hoverMacroRuns === 26,
    `laidOut=${hoverLaidOut} macroRuns=${hoverMacroRuns}`);

  // EMPIPEE.HLP is the file that proved a Hall stream may simply stop: every
  // one of its text records ends 3-13 bytes before DataLen2, and it was the
  // only reason 7 of its 8 topics were unreadable. The six shipped help files
  // never take that path, so this is the only guard on it.
  const empipeeHelp = fs.readFileSync(
    path.join(ROOT, 'test', 'binaries', 'wep32-community', 'EmPipe', 'EMPIPEE.HLP'));
  const empipeeLoaded = load(empipeeHelp);
  let empipeeLaidOut = 0;
  let empipeePadded = 0;
  let empipeePadBytes = 0;
  for (let index = 0; index < e.get_help_topic_count(); index++) {
    const tokens = e.test_help_decode_topic_formatted(index, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity);
    if (tokens < 1) continue;
    if (e.get_help_hall_pad_bytes()) {
      empipeePadded++;
      empipeePadBytes += e.get_help_hall_pad_bytes();
    }
    if (e.test_help_layout_tokens_with_payload(topicOutWA, topicOutCapacity,
      topicPayloadWA, e.get_help_formatted_payload_size(), topicTokensWA, tokens,
      layoutRunsWA, 2048, 560) >= 0) empipeeLaidOut++;
  }
  check('EMPIPEE.HLP decodes and lays out every topic despite omitted tails',
    empipeeLoaded === 1 && e.get_help_topic_count() === 8 && empipeeLaidOut === 8,
    `loaded=${empipeeLoaded} topics=${e.get_help_topic_count()} laidOut=${empipeeLaidOut}`);
  check('EMPIPEE.HLP is the file that exercises the omitted-tail rule',
    empipeePadded === 7 && empipeePadBytes === 50,
    `padded=${empipeePadded} bytes=${empipeePadBytes}`);

  const validExternalCommands = [
    buildExternalHotspot(0xea, 0, 20),
    buildExternalHotspot(0xeb, 1, 20, { windowNumber: 3 }),
    buildExternalHotspot(0xee, 4, 20, { file: 'other.hlp' }),
    buildExternalHotspot(0xef, 6, 20, { file: 'other.hlp', window: 'secondary' }),
  ];
  check('external hotspot types 0/1/4/6 parse with exact bounded structures',
    validExternalCommands.every(command => load(buildSyntheticSemanticHelp({
      topic: buildSyntheticFormattedTopic({ hotspotCommand: command }),
    }).file) === 1));
  const malformedExternalCommands = [
    Buffer.from([0xea, 5, 0, 2, 0, 0, 0, 0]),                 // unknown type
    Buffer.from([0xea, 6, 0, 0, 0, 0, 0, 0, 0]),              // type 0 extra byte
    Buffer.from([0xea, 7, 0, 4, 0, 0, 0, 0, 0x61, 0x62]),     // file lacks NUL
    Buffer.from([0xea, 8, 0, 6, 0, 0, 0, 0, 0x61, 0, 0]),    // empty window
    Buffer.from([0xea, 8, 0, 4, 0, 0, 0, 0, 0x61, 0, 0x78]), // bytes after file NUL
  ];
  check('malformed external hotspot sizes, types, and strings reject publication',
    malformedExternalCommands.every(command => load(buildSyntheticSemanticHelp({
      topic: buildSyntheticFormattedTopic({ hotspotCommand: command }),
    }).file) === 0 && e.get_help_last_error() === 14 && e.get_help_topic_count() === 0));

  const syntheticFont = buildOldFont(
    ['Fixture Face'], [[0,20,2,3,0x112233,0x445566]]);
  const fontHelp = buildSyntheticSemanticHelp({ font: syntheticFont });
  check('synthetic old FONT table parses into normalized records',
    load(fontHelp.file) === 1 && e.get_help_font_face_count() === 1 &&
    e.get_help_font_count() === 1 && e.get_help_font_metric_mode() === 0 &&
    readLatin1(e.get_help_font_face_ptr(0), e.get_help_font_face_len(0)) === 'Fixture Face' &&
    (() => {
      const record = e.get_help_font_record(0);
      return JSON.stringify(Array.from({ length: 7 }, (_, field) =>
        dv.getUint32(record + field * 4, true))) ===
        JSON.stringify([0,20,2,3,700,0x112233,0x445566]);
    })());

  const writeLayoutToken = (index, kind, off = 0, len = 0, value = 0) => {
    const token = topicTokensWA + index * 16;
    dv.setUint32(token, kind, true);
    dv.setUint32(token + 4, off, true);
    dv.setUint32(token + 8, len, true);
    dv.setUint32(token + 12, value, true);
  };
  const layoutParagraph = ({
    raw, header, recordType = 0x20, recordPrefix = Buffer.alloc(0), width = 100,
    extraTokens = [], capacity = 32,
  }) => {
    const prefix = Buffer.concat([
      encodeCompressedLong(0), encodeCompressedUnsignedShort(0), recordPrefix,
    ]);
    const payload = Buffer.concat([prefix, header]);
    bytes.set(raw, topicOutWA);
    bytes.set(payload, topicPayloadWA);
    bytes.fill(0, topicTokensWA, topicTokensWA + (extraTokens.length + 3) * 16);
    writeLayoutToken(0, 4, prefix.length, header.length,
      ((recordType & 0xff) << 24) >>> 0);
    extraTokens.forEach((token, index) => writeLayoutToken(index + 1, ...token));
    writeLayoutToken(extraTokens.length + 1, 1, 0, raw.length);
    writeLayoutToken(extraTokens.length + 2, 13);
    const count = e.test_help_layout_tokens_with_payload(
      topicOutWA, raw.length, topicPayloadWA, payload.length,
      topicTokensWA, extraTokens.length + 3, layoutRunsWA, capacity, width);
    return { count, payload };
  };

  const metricParagraphHeader = buildParagraphHeader({
    flags: 0x007e, metrics: [12, 9, 30, 15, 12, 9],
  });
  const metricParagraph = layoutParagraph({
    raw: Buffer.from('alpha beta gamma', 'latin1'), header: metricParagraphHeader,
  });
  const metricRuns = Array.from({ length: metricParagraph.count }, (_, index) =>
    Array.from({ length: 5 }, (_, field) =>
      dv.getUint32(layoutRunsWA + index * 40 + field * 4, true)));
  check('paragraph metrics own exact margins, first-line indent, spacing, and line height',
    metricParagraph.count === 5 && JSON.stringify(metricRuns) === JSON.stringify([
      [1,24,16,35,16], [2,59,16,7,16], [1,18,36,28,16],
      [2,46,36,7,16], [1,18,56,35,16],
    ]) && e.get_help_layout_extent() === 78,
    `runs=${JSON.stringify(metricRuns)} extent=${e.get_help_layout_extent()}`);

  const exactLineHeader = buildParagraphHeader({ flags: 0x0008, metrics: [-30] });
  const exactLinePrefix = Buffer.concat([
    encodeCompressedLong(0), encodeCompressedUnsignedShort(0),
  ]);
  const exactLinePayload = Buffer.concat([exactLinePrefix, exactLineHeader]);
  bytes.set(Buffer.from('ab', 'latin1'), topicOutWA);
  bytes.set(exactLinePayload, topicPayloadWA);
  bytes.fill(0, topicTokensWA, topicTokensWA + 80);
  writeLayoutToken(0, 4, exactLinePrefix.length, exactLineHeader.length, 0x20000000);
  writeLayoutToken(1, 1, 0, 1);
  writeLayoutToken(2, 3);
  writeLayoutToken(3, 1, 1, 1);
  writeLayoutToken(4, 13);
  const exactLineCount = e.test_help_layout_tokens_with_payload(
    topicOutWA, 2, topicPayloadWA, exactLinePayload.length,
    topicTokensWA, 5, layoutRunsWA, 2, 100);
  check('negative paragraph line spacing produces an exact line advance',
    exactLineCount === 2 &&
    dv.getUint32(layoutRunsWA + 8, true) === 8 &&
    dv.getUint32(layoutRunsWA + 40 + 8, true) === 28);

  const centerParagraph = layoutParagraph({
    raw: Buffer.from('abcd', 'latin1'),
    header: buildParagraphHeader({ flags: 0x0800 }),
  });
  check('center paragraph alignment shifts the complete positioned line',
    centerParagraph.count === 1 && dv.getUint32(layoutRunsWA + 4, true) === 36);
  const rightParagraph = layoutParagraph({
    raw: Buffer.from('abcd', 'latin1'),
    header: buildParagraphHeader({ flags: 0x0400 }),
  });
  check('right paragraph alignment shifts the complete positioned line',
    rightParagraph.count === 1 && dv.getUint32(layoutRunsWA + 4, true) === 64);

  const tabHeader = buildParagraphHeader({
    flags: 0x0200, tabs: [[72, 1]],
  });
  const tabPrefix = Buffer.concat([
    encodeCompressedLong(0), encodeCompressedUnsignedShort(0),
  ]);
  const tabPayload = Buffer.concat([tabPrefix, tabHeader]);
  bytes.set(Buffer.from('abc', 'latin1'), topicOutWA);
  bytes.set(tabPayload, topicPayloadWA);
  bytes.fill(0, topicTokensWA, topicTokensWA + 80);
  writeLayoutToken(0, 4, tabPrefix.length, tabHeader.length, 0x20000000);
  writeLayoutToken(1, 1, 0, 1);
  writeLayoutToken(2, 2, 0, 0, 0x83);
  writeLayoutToken(3, 1, 1, 2);
  writeLayoutToken(4, 13);
  const tabCount = e.test_help_layout_tokens_with_payload(
    topicOutWA, 3, topicPayloadWA, tabPayload.length,
    topicTokensWA, 5, layoutRunsWA, 3, 100);
  check('right tab stops align the following text against retained tab metadata',
    tabCount === 3 &&
    dv.getUint32(layoutRunsWA + 4, true) === 8 &&
    dv.getUint32(layoutRunsWA + 40 + 4, true) === 15 &&
    dv.getUint32(layoutRunsWA + 40 + 12, true) === 27 &&
    dv.getUint32(layoutRunsWA + 80 + 4, true) === 42,
    `count=${tabCount} runs=${JSON.stringify(Array.from({ length: Math.max(0, tabCount) },
      (_, index) => Array.from({ length: 5 }, (_, field) =>
        dv.getUint32(layoutRunsWA + index * 40 + field * 4, true))))}`);

  // Column records are { width, gap }. These fixtures were written against
  // the reversed reading and are swapped here so they still describe the same
  // two columns; real files (notepad.hlp, HOVER.HLP) are what settled the
  // order, since the reversed one gave them 1-unit-wide cells.
  const tablePrefix = Buffer.alloc(12);
  tablePrefix[0] = 2;
  tablePrefix[1] = 0;
  tablePrefix.writeInt16LE(0, 2);
  tablePrefix.writeInt16LE(16384, 4);
  tablePrefix.writeInt16LE(0, 6);
  tablePrefix.writeInt16LE(16383, 8);
  tablePrefix.writeInt16LE(0, 10);
  const tableParagraph = layoutParagraph({
    raw: Buffer.from('cell', 'latin1'), width: 200, recordType: 0x23,
    recordPrefix: tablePrefix,
    header: buildParagraphHeader({ column: 1 }),
  });
  check('variable-width table paragraphs scale into exact client cell geometry',
    tableParagraph.count === 1 &&
    dv.getUint32(layoutRunsWA + 4, true) === 100 &&
    dv.getUint32(layoutRunsWA + 12, true) === 28);

  tablePrefix.writeInt16LE(300, 2);
  const minimumTableParagraph = layoutParagraph({
    raw: Buffer.from('cell', 'latin1'), width: 200, recordType: 0x23,
    recordPrefix: tablePrefix,
    header: buildParagraphHeader({ column: 1 }),
  });
  check('variable table minimum width expands cell geometry beyond a narrow client',
    minimumTableParagraph.count === 1 &&
    dv.getUint32(layoutRunsWA + 4, true) === 108);

  const fixedTablePrefix = Buffer.alloc(10);
  fixedTablePrefix[0] = 2;
  fixedTablePrefix[1] = 1;
  fixedTablePrefix.writeInt16LE(60, 2);
  fixedTablePrefix.writeInt16LE(0, 4);
  fixedTablePrefix.writeInt16LE(75, 6);
  fixedTablePrefix.writeInt16LE(15, 8);
  const fixedTableParagraph = layoutParagraph({
    raw: Buffer.from('cell', 'latin1'), width: 200, recordType: 0x23,
    recordPrefix: fixedTablePrefix,
    header: buildParagraphHeader({ column: 1 }),
  });
  check('fixed-width table paragraphs convert exact metric cell geometry',
    fixedTableParagraph.count === 1 &&
    dv.getUint32(layoutRunsWA + 4, true) === 58);

  fixedTablePrefix[1] = 4;
  check('paragraph layout rejects unsupported table geometry types',
    layoutParagraph({
      raw: Buffer.from('cell', 'latin1'), width: 200, recordType: 0x23,
      recordPrefix: fixedTablePrefix,
      header: buildParagraphHeader({ column: 1 }),
    }).count === -1);

  bytes.fill(0xa5, layoutRunsWA, layoutRunsWA + 40);
  writeLayoutToken(0, 4, metricParagraph.payload.length, 1, 0x20000000);
  writeLayoutToken(1, 13);
  check('paragraph layout rejects an out-of-range retained header before writing',
    e.test_help_layout_tokens_with_payload(
      topicOutWA, 0, topicPayloadWA, metricParagraph.payload.length,
      topicTokensWA, 2, layoutRunsWA, 1, 100) === -1 &&
    bytes.subarray(layoutRunsWA, layoutRunsWA + 40).every(byte => byte === 0xa5));

  bytes.set(Buffer.from('font', 'latin1'), topicOutWA);
  for (let i = 0; i < 3; i++) bytes.fill(0, topicTokensWA + i * 16, topicTokensWA + (i + 1) * 16);
  dv.setUint32(topicTokensWA, 5, true);
  dv.setUint32(topicTokensWA + 12, 0, true);
  dv.setUint32(topicTokensWA + 16, 1, true);
  dv.setUint32(topicTokensWA + 20, 0, true);
  dv.setUint32(topicTokensWA + 24, 4, true);
  dv.setUint32(topicTokensWA + 32, 13, true);
  check('typed layout applies normalized font height and foreground color',
    e.test_help_layout_tokens(topicOutWA, 4, topicTokensWA, 3,
      layoutRunsWA, 1, 200) === 1 &&
    dv.getUint32(layoutRunsWA + 16, true) === 17 &&
    dv.getUint32(layoutRunsWA + 28, true) === 0 &&
    dv.getUint32(layoutRunsWA + 32, true) === 0x112233);
  const fontViewParts = buildSyntheticFormattedTopic({
    returnParts: true, closeVariableHotspot: true,
  });
  const fontViewHelp = buildSyntheticSemanticHelp({
    topic: fontViewParts.topic,
    font: buildOldFont(['MS Sans Serif'], [
      [0,16,3,0], [0,18,3,0], [0,20,3,0x0f,0x112233,0x445566],
    ]),
  });
  check('typed view materializes each referenced logical font as an owned HFONT',
    load(fontViewHelp.file) === 1 && e.test_help_replace_typed_view(0) === 1 && (() => {
      const handle = e.get_help_view_font_handle(2);
      return e.get_help_view_font_slot_count() === 3 && e.get_help_view_font_count() === 1 &&
        e.get_help_view_font_handle(0) === 0 && e.get_help_view_font_handle(1) === 0 &&
        handle !== 0 && e.test_gdi_object_type(handle) === 4 &&
        e.test_help_view_font_height(2) === -14 &&
        e.test_help_view_font_weight(2) === 700 &&
        e.test_help_view_font_italic(2) === 1 &&
        readLatin1(e.test_help_view_font_face(2), 13) === 'MS Sans Serif';
    })(), `error=${e.get_help_last_error()} count=${e.get_help_view_font_count()}`);
  const fontViewHandle = e.get_help_view_font_handle(2);
  const fontViewHdc = e.get_help_view_font_hdc();
  const decoratedFontRun = Array.from({ length: e.get_help_view_run_count() }, (_, index) =>
    e.get_help_view_run_ptr() + index * 40).find(run =>
    dv.getUint32(run, true) === 1 && dv.getUint32(run + 28, true) === 2 &&
    (dv.getUint32(run + 36, true) & 0x0fffffff) === 0);
  check('font-aware layout uses realized metrics and retains decorations in positioned runs',
    decoratedFontRun && dv.getUint32(decoratedFontRun + 16, true) >= 8 &&
    dv.getUint32(decoratedFontRun + 16, true) < 17 &&
    (dv.getUint32(decoratedFontRun + 36, true) >>> 28) === 0x0c);
  e.test_help_paint_typed_view(fontViewHdc);
  check('production repaint selects the run HFONT into the canonical target DC',
    e.test_gdi_dc_get_field(fontViewHdc, 88, 0) === fontViewHandle);
  const fontProbeA = e.test_help_paint_bitmap_probe(512, 128);
  const fontProbeB = e.test_help_paint_bitmap_probe(512, 128);
  check('production repaint draws retained underline and strikeout geometry deterministically',
    decoratedFontRun && fontProbeA !== 0 && fontProbeB !== 0 && (() => {
      const x = dv.getUint32(decoratedFontRun + 4, true);
      const y = dv.getUint32(decoratedFontRun + 8, true);
      const width = dv.getUint32(decoratedFontRun + 12, true);
      const height = dv.getUint32(decoratedFontRun + 16, true);
      const rows = [y + height - 2, y + Math.floor(height / 2)];
      const line = (storage, row) => Array.from({ length: width }, (_, dx) =>
        dv.getUint32(storage + (row * 512 + x + dx) * 4, true));
      const a = e.test_gdi_bitmap_storage(fontProbeA);
      const b = e.test_gdi_bitmap_storage(fontProbeB);
      return rows.every(row => line(a, row).every(pixel => pixel !== 0) &&
        JSON.stringify(line(a, row)) === JSON.stringify(line(b, row)));
    })());
  if (fontProbeA) e.test_help_release_bitmap_probe(fontProbeA);
  if (fontProbeB) e.test_help_release_bitmap_probe(fontProbeB);
  const retainedFontRuns = e.get_help_view_run_ptr();
  const occupiedGdiHandles = [];
  for (let i = 0; i < 512; i++) {
    const handle = 0x510000 + i;
    if (!e.test_gdi_object_adopt(handle, 1, 1, 1, 0, 0)) break;
    occupiedGdiHandles.push(handle);
  }
  check('font allocation failure retains the prior complete view transaction',
    occupiedGdiHandles.length > 0 && e.test_help_replace_typed_view(0) === 0 &&
    e.get_help_last_error() === 2 && e.get_help_view_run_ptr() === retainedFontRuns &&
    e.get_help_view_font_handle(2) === fontViewHandle &&
    e.test_gdi_object_type(fontViewHandle) === 4);
  occupiedGdiHandles.forEach(handle => e.test_gdi_object_delete(handle));
  check('topic replacement releases prior HFONTs and clears selected DC references',
    e.test_help_replace_typed_view(2) === 1 && e.get_help_view_font_count() === 0 &&
    e.test_gdi_object_type(fontViewHandle) === 0 &&
    e.test_gdi_dc_get_field(fontViewHdc, 88, 0) === 0x3001d);
  const badFontFace = Buffer.from(syntheticFont);
  badFontFace.writeUInt16LE(1, badFontFace.readUInt16LE(6) + 3);
  const badFontFaceHelp = buildSyntheticSemanticHelp({ font: badFontFace });
  check('FONT descriptors reject out-of-range face indexes transactionally',
    load(badFontFaceHelp.file) === 0 && e.get_help_last_error() === 15 &&
    e.get_help_font_face_count() === 0 && e.get_help_font_count() === 0 &&
    e.get_help_bitmap_count() === 0 &&
    e.get_help_topic_count() === 0);
  const truncatedFontHelp = buildSyntheticSemanticHelp({
    font: syntheticFont.subarray(0, syntheticFont.length - 1),
  });
  check('truncated FONT descriptors fail before publication',
    load(truncatedFontHelp.file) === 0 && e.get_help_last_error() === 15 &&
    e.get_help_font_count() === 0);
  const oversizedFont = Buffer.from(syntheticFont);
  oversizedFont.writeUInt16LE(4097, 0);
  const oversizedFontHelp = buildSyntheticSemanticHelp({ font: oversizedFont });
  check('FONT face capacity is enforced before allocation',
    load(oversizedFontHelp.file) === 0 && e.get_help_last_error() === 6 &&
    e.get_help_font_face_count() === 0);

  const realPaintHelp = fs.readFileSync(path.join(HELP, 'mspaint.hlp'));
  const realPaintLoaded = load(realPaintHelp);
  const realPaintTokenCount = realPaintLoaded === 1
    ? e.test_help_decode_topic_formatted(1, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity)
    : -1;
  check('checked-in Paint help resolves its bmc command to normalized |bm0',
    realPaintTokenCount > 0 && Array.from({ length: realPaintTokenCount }, (_, index) =>
      topicTokensWA + index * 16).some(token =>
      dv.getUint32(token, true) === 9 && dv.getUint32(token + 12, true) === 1));
  check('checked-in Paint bitmap materializes with its exact native geometry',
    e.test_help_replace_typed_view(1) === 1 && e.get_help_view_bitmap_count() === 1 && (() => {
      const run = Array.from({ length: e.get_help_view_run_count() }, (_, index) =>
        e.get_help_view_run_ptr() + index * 40).find(record => dv.getUint32(record, true) === 9);
      const handle = e.get_help_view_bitmap_handle(0);
      return run && handle !== 0 && dv.getUint32(run + 12, true) === 10 &&
        dv.getUint32(run + 16, true) === 11 &&
        crypto.createHash('sha256').update(Buffer.from(bytes.subarray(
          e.test_gdi_bitmap_storage(handle), e.test_gdi_bitmap_storage(handle) + 88)))
          .digest('hex') === EXPECTED_SEMANTICS['mspaint.hlp'].bitmapPayloads[0][1];
    })());
  e.test_help_replace_typed_view(0);

  const syntheticBitmap = buildSyntheticBitmap();
  const bitmapHelp = buildSyntheticSemanticHelp({ extraFiles: [['|bm7', syntheticBitmap]] });
  const bitmapDataOff = bitmapHelp.offsets['|bm7'] + 9;
  check('synthetic bitmap resource publishes exact normalized metadata',
    load(bitmapHelp.file) === 1 && e.get_help_bitmap_count() === 1 &&
    e.test_help_find_bitmap(7, 0) === 0 && (() => {
      const record = e.get_help_bitmap_record(0);
      return JSON.stringify(Array.from({ length: 20 }, (_, field) =>
        dv.getUint32(record + field * 4, true))) === JSON.stringify([
        7,0,6,0,96,96,1,8,2,2,2,1,bitmapDataOff + 44,8,0,0,
        bitmapDataOff + 36,2,8,0,
      ]);
    })());
  check('synthetic unpacked bitmap decodes exact pixels',
    e.test_help_decode_bitmap(0, topicOutWA, 8) === 8 &&
    Buffer.from(bytes.subarray(topicOutWA, topicOutWA + 8)).equals(
      Buffer.from([0,0,0,0,1,0,1,0])));
  const bitmapViewParts = buildSyntheticFormattedTopic({
    returnParts: true, externalBitmapNumber: 7,
    closeVariableHotspot: true,
  });
  const bitmapViewHelp = buildSyntheticSemanticHelp({
    topic: bitmapViewParts.topic,
    font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
    extraFiles: [['|bm7', syntheticBitmap]],
  });
  const bitmapViewLoaded = load(bitmapViewHelp.file);
  const bitmapViewTokenCount = bitmapViewLoaded === 1
    ? e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity)
    : -1;
  check('external bitmap command resolves to a normalized token index',
    bitmapViewLoaded === 1 && bitmapViewTokenCount > 0 && (() => {
      const bitmapToken = Array.from({ length: bitmapViewTokenCount }, (_, index) =>
        topicTokensWA + index * 16).find(token => dv.getUint32(token, true) === 9);
      return bitmapToken && dv.getUint32(bitmapToken + 12, true) === 1 &&
        bytes[topicPayloadWA + dv.getUint32(bitmapToken + 4, true)] === 0x86;
    })());
  check('typed view materializes referenced pixels and palette into owned GDI state',
    e.test_help_replace_typed_view(0) === 1 &&
    e.get_help_view_bitmap_slot_count() === 1 && e.get_help_view_bitmap_count() === 1 &&
    e.get_help_view_bitmap_dc() !== 0 && (() => {
      const handle = e.get_help_view_bitmap_handle(0);
      const object = e.test_gdi_object_record(handle);
      const storage = e.test_gdi_bitmap_storage(handle);
      const palette = e.test_gdi_bitmap_palette(handle);
      return handle !== 0 && object !== 0 && dv.getUint32(object + 4, true) === 3 &&
        dv.getUint32(object + 8, true) === 2 && dv.getUint32(object + 12, true) === 2 &&
        dv.getUint32(object + 16, true) === 8 && dv.getUint32(object + 28, true) === 4 &&
        Buffer.from(bytes.subarray(storage, storage + 8)).equals(
          Buffer.from([0,0,0,0,1,0,1,0])) &&
        e.test_gdi_bitmap_palette_count(handle) === 2 &&
        Buffer.from(bytes.subarray(palette, palette + 8)).equals(
          Buffer.from([0,0,0,0,0xff,0xff,0xff,0]));
    })(), `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()} ` +
      `runs=${e.get_help_view_run_count()} slots=${e.get_help_view_bitmap_slot_count()} ` +
      `count=${e.get_help_view_bitmap_count()} dc=${e.get_help_view_bitmap_dc()}`);
  const bitmapViewRun = Array.from({ length: e.get_help_view_run_count() }, (_, index) => {
    const run = e.get_help_view_run_ptr() + index * 40;
    return dv.getUint32(run, true) === 9 ? run : 0;
  }).find(Boolean);
  check('bitmap layout uses intrinsic normalized dimensions and canonical index',
    bitmapViewRun && dv.getUint32(bitmapViewRun + 12, true) === 2 &&
    dv.getUint32(bitmapViewRun + 16, true) === 2 &&
    dv.getUint32(bitmapViewRun + 20, true) === 0);
  const bitmapProbeA = e.test_help_paint_bitmap_probe(128, 128);
  const bitmapProbeB = e.test_help_paint_bitmap_probe(128, 128);
  check('production painter blits exact bitmap pixels at the positioned run on repaint',
    bitmapViewRun && bitmapProbeA !== 0 && bitmapProbeB !== 0 && (() => {
      const x = dv.getUint32(bitmapViewRun + 4, true);
      const y = dv.getUint32(bitmapViewRun + 8, true);
      const a = e.test_gdi_bitmap_storage(bitmapProbeA);
      const b = e.test_gdi_bitmap_storage(bitmapProbeB);
      const pixelsAt = storage => [
        dv.getUint32(storage + (y * 128 + x) * 4, true),
        dv.getUint32(storage + (y * 128 + x + 1) * 4, true),
        dv.getUint32(storage + ((y + 1) * 128 + x) * 4, true),
        dv.getUint32(storage + ((y + 1) * 128 + x + 1) * 4, true),
      ];
      return JSON.stringify(pixelsAt(a)) === JSON.stringify([0xffffff,0,0,0]) &&
        JSON.stringify(pixelsAt(b)) === JSON.stringify(pixelsAt(a));
    })(), bitmapViewRun && bitmapProbeA ? `pixels=${JSON.stringify((() => {
      const x = dv.getUint32(bitmapViewRun + 4, true);
      const y = dv.getUint32(bitmapViewRun + 8, true);
      const storage = e.test_gdi_bitmap_storage(bitmapProbeA);
      return [0,1,128,129].map(delta => dv.getUint32(storage + (y * 128 + x + delta) * 4, true));
    })())}` : 'missing run/probe');
  if (bitmapProbeA) e.test_help_release_bitmap_probe(bitmapProbeA);
  if (bitmapProbeB) e.test_help_release_bitmap_probe(bitmapProbeB);
  const replacedBitmapHandle = e.get_help_view_bitmap_handle(0);
  check('topic replacement tears down prior materialized bitmap and DC state',
    e.test_help_replace_typed_view(2) === 1 && e.get_help_view_bitmap_count() === 0 &&
    e.get_help_view_bitmap_dc() === 0 && e.test_gdi_object_type(replacedBitmapHandle) === 0);
  const unresolvedBitmapHelp = buildSyntheticSemanticHelp({
    topic: bitmapViewParts.topic,
    font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
  });
  check('missing external bitmap resource remains a bounded non-owning placeholder',
    load(unresolvedBitmapHelp.file) === 1 && e.test_help_replace_typed_view(0) === 1 &&
    e.get_help_view_bitmap_slot_count() === 0 && e.get_help_view_bitmap_count() === 0 &&
    e.get_help_view_bitmap_dc() === 0 && (() => {
      const run = Array.from({ length: e.get_help_view_run_count() }, (_, index) =>
        e.get_help_view_run_ptr() + index * 40).find(record => dv.getUint32(record, true) === 9);
      return run && dv.getUint32(run + 12, true) === 16 &&
        dv.getUint32(run + 16, true) === 16 && dv.getUint32(run + 20, true) === 0xffffffff;
    })());
  const syntheticDdbPixels = Buffer.from([1,2,3,4]);
  const bitmapDdbHelp = buildSyntheticSemanticHelp({
    topic: bitmapViewParts.topic,
    font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
    extraFiles: [['|bm7', buildSyntheticBitmap({
      pictureType: 5, payload: syntheticDdbPixels,
    })]],
  });
  check('device-dependent embedded bitmap materializes with WORD-aligned pixels',
    load(bitmapDdbHelp.file) === 1 && e.test_help_replace_typed_view(0) === 1 && (() => {
      const handle = e.get_help_view_bitmap_handle(0);
      const object = e.test_gdi_object_record(handle);
      const storage = e.test_gdi_bitmap_storage(handle);
      return e.get_help_view_bitmap_count() === 1 && handle !== 0 && object !== 0 &&
        dv.getUint32(object + 16, true) === 8 && dv.getUint32(object + 28, true) === 2 &&
        e.test_gdi_bitmap_palette_count(handle) === 0 &&
        Buffer.from(bytes.subarray(storage, storage + 4)).equals(syntheticDdbPixels);
    })());
  e.test_help_replace_typed_view(2);
  const syntheticPixels = Buffer.from([0,0,0,0,1,0,1,0]);
  const syntheticRle = Buffer.from([4,0,0x84,1,0,1,0]);
  const syntheticPackingPayloads = [
    syntheticPixels,
    syntheticRle,
    encodeLiteralLz77(syntheticPixels),
    encodeLiteralLz77(syntheticRle),
  ];
  for (let packing = 0; packing < syntheticPackingPayloads.length; packing++) {
    const packedHelp = buildSyntheticSemanticHelp({
      extraFiles: [['|bm7', buildSyntheticBitmap({
        packing, payload: syntheticPackingPayloads[packing],
      })]],
    });
    bytes.fill(0xa5, topicOutWA, topicOutWA + 8);
    const length = load(packedHelp.file) === 1
      ? e.test_help_decode_bitmap(0, topicOutWA, 8)
      : -1;
    check(`bitmap packing ${packing} decodes exact pixels`,
      length === 8 &&
      Buffer.from(bytes.subarray(topicOutWA, topicOutWA + 8)).equals(syntheticPixels));
  }
  const malformedRleHelp = buildSyntheticSemanticHelp({
    topic: bitmapViewParts.topic,
    font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
    extraFiles: [['|bm7', buildSyntheticBitmap({
      packing: 1, payload: Buffer.from([0x88,0,0]),
    })]],
  });
  bytes.fill(0xa5, topicOutWA, topicOutWA + 8);
  check('truncated bitmap RLE fails without partial output',
    load(malformedRleHelp.file) === 1 &&
    e.test_help_decode_bitmap(0, topicOutWA, 8) === -1 &&
    e.get_help_last_error() === 16 &&
    bytes.subarray(topicOutWA, topicOutWA + 8).every(byte => byte === 0xa5));
  let bitmapFailureState = {};
  check('bitmap materialization failure retains the prior complete view transaction',
    load(bitmapViewHelp.file) === 1 && e.test_help_replace_typed_view(0) === 1 && (() => {
      const oldRuns = e.get_help_view_run_ptr();
      const oldHandle = e.get_help_view_bitmap_handle(0);
      const oldDC = e.get_help_view_bitmap_dc();
      const loaded = load(malformedRleHelp.file);
      const replaced = e.test_help_replace_typed_view(0);
      bitmapFailureState = {
        loaded, replaced, error: e.get_help_last_error(), oldRuns,
        runs: e.get_help_view_run_ptr(), oldHandle, handle: e.get_help_view_bitmap_handle(0),
        oldDC, dc: e.get_help_view_bitmap_dc(), count: e.get_help_view_bitmap_count(),
        type: e.test_gdi_object_type(oldHandle),
      };
      return loaded === 1 && replaced === 0 &&
        e.get_help_last_error() === 16 && e.get_help_view_run_ptr() === oldRuns &&
        e.get_help_view_bitmap_handle(0) === oldHandle &&
        e.get_help_view_bitmap_dc() === oldDC && e.get_help_view_bitmap_count() === 1 &&
        e.test_gdi_object_type(oldHandle) === 3;
    })(), JSON.stringify(bitmapFailureState));
  check('a later valid topic replacement releases the retained failure snapshot',
    e.test_help_replace_typed_view(2) === 1 && e.get_help_view_bitmap_count() === 0 &&
    e.get_help_view_bitmap_dc() === 0);
  const malformedLzHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|bm7', buildSyntheticBitmap({
      packing: 2, payload: Buffer.from([1,0,0]),
    })]],
  });
  bytes.fill(0xa5, topicOutWA, topicOutWA + 8);
  check('invalid bitmap LZ77 back-reference fails without partial output',
    load(malformedLzHelp.file) === 1 &&
    e.test_help_decode_bitmap(0, topicOutWA, 8) === -1 &&
    e.get_help_last_error() === 16 &&
    bytes.subarray(topicOutWA, topicOutWA + 8).every(byte => byte === 0xa5));
  bytes.fill(0xa5, topicOutWA, topicOutWA + 8);
  check('bitmap decoder preflights caller capacity',
    load(bitmapHelp.file) === 1 &&
    e.test_help_decode_bitmap(0, topicOutWA, 7) === -1 &&
    e.get_help_last_error() === 6 &&
    bytes.subarray(topicOutWA, topicOutWA + 8).every(byte => byte === 0xa5));
  check('bitmap decoder rejects output aliases into the owned HLP',
    load(bitmapHelp.file) === 1 && (() => {
      const record = e.get_help_bitmap_record(0);
      const source = e.get_help_file_ptr() + dv.getUint32(record + 48, true);
      const before = Buffer.from(bytes.subarray(source, source + 8));
      return e.test_help_decode_bitmap(0, source, 8) === -1 &&
        e.get_help_last_error() === 1 &&
        Buffer.from(bytes.subarray(source, source + 8)).equals(before);
    })());
  check('bitmap decoder validates output memory bounds and index',
    load(bitmapHelp.file) === 1 &&
    e.test_help_decode_bitmap(0, memory.buffer.byteLength - 4, 8) === -1 &&
    e.get_help_last_error() === 1 &&
    load(bitmapHelp.file) === 1 &&
    e.test_help_decode_bitmap(1, topicOutWA, 8) === -1 &&
    e.get_help_last_error() === 1);
  const badBitmapOffset = Buffer.from(syntheticBitmap);
  badBitmapOffset.writeUInt32LE(0xffffffff, 28);
  const badBitmapOffsetHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|bm7', badBitmapOffset]],
  });
  check('bitmap compressed payload offsets are bounded transactionally',
    load(badBitmapOffsetHelp.file) === 0 && e.get_help_last_error() === 16 &&
    e.get_help_bitmap_count() === 0 && e.get_help_topic_count() === 0);
  const badBitmapHotspot = Buffer.from(syntheticBitmap);
  badBitmapHotspot.writeUInt16LE(2, 26);
  const badBitmapHotspotHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|bm7', badBitmapHotspot]],
  });
  check('bitmap hotspot size and offset must be paired',
    load(badBitmapHotspotHelp.file) === 0 && e.get_help_last_error() === 16 &&
    e.get_help_bitmap_count() === 0);
  const tooManyPictures = Buffer.from(syntheticBitmap);
  tooManyPictures.writeUInt16LE(4097, 2);
  const tooManyPicturesHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|bm7', tooManyPictures]],
  });
  check('bitmap picture capacity is enforced before allocation',
    load(tooManyPicturesHelp.file) === 0 && e.get_help_last_error() === 6 &&
    e.get_help_bitmap_count() === 0);
  const duplicateBitmapHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|bm7', syntheticBitmap], ['bm7', syntheticBitmap]],
  });
  check('duplicate bitmap resource numbers fail before publication',
    load(duplicateBitmapHelp.file) === 0 && e.get_help_last_error() === 16 &&
    e.get_help_bitmap_count() === 0);
  const mismatchedRawBitmap = Buffer.from(syntheticBitmap);
  mismatchedRawBitmap.writeUInt16LE(14, 24);
  const mismatchedRawBitmapHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|bm7', mismatchedRawBitmap]],
  });
  check('unpacked bitmap byte count must match normalized raster size',
    load(mismatchedRawBitmapHelp.file) === 0 && e.get_help_last_error() === 16 &&
    e.get_help_bitmap_count() === 0);
  const oversizedBitmap = Buffer.from(syntheticBitmap);
  oversizedBitmap.writeUInt16LE(0xfffe, 16);
  oversizedBitmap.writeUInt16LE(0xfffe, 18);
  const oversizedBitmapHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|bm7', oversizedBitmap]],
  });
  check('decoded bitmap byte cap rejects hostile geometry without wrap',
    load(oversizedBitmapHelp.file) === 0 && e.get_help_last_error() === 6 &&
    e.get_help_bitmap_count() === 0);
  const unsupportedDdbPacking = Buffer.from(syntheticBitmap);
  unsupportedDdbPacking[8] = 5;
  unsupportedDdbPacking[9] = 2;
  const unsupportedDdbPackingHelp = buildSyntheticSemanticHelp({
    extraFiles: [['|bm7', unsupportedDdbPacking]],
  });
  check('DDB resources reject unsupported LZ77 packing modes',
    load(unsupportedDdbPackingHelp.file) === 0 && e.get_help_last_error() === 16 &&
    e.get_help_bitmap_count() === 0);

  for (const [variant, minor, compressedTopic] of [
    ['hc30', 15, false],
    ['hc31', 16, true],
    ['mvb', 27, true],
  ]) {
    const oldPhraseHelp = buildSyntheticSemanticHelp({
      systemMinor: minor,
      topic: buildSyntheticOldTopic(compressedTopic),
      oldPhrases: buildOldPhrases(['hello', 'world', '!'], variant),
    });
    check(`${variant} old-style phrase table parses`, load(oldPhraseHelp.file) === 1,
      `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
    check(`${variant} old-style phrases publish exact offsets and bytes`,
      e.get_help_phrase_count() === 3 && e.get_help_phrase_image_size() === 11 &&
      readLatin1(e.get_help_phrase_ptr(0), e.get_help_phrase_len(0)) === 'hello' &&
      readLatin1(e.get_help_phrase_ptr(1), e.get_help_phrase_len(1)) === 'world' &&
      readLatin1(e.get_help_phrase_ptr(2), e.get_help_phrase_len(2)) === '!');
    const oldLength = e.test_help_decode_topic_raw(0, topicOutWA, topicOutCapacity);
    check(`${variant} topic stream uses old-style phrase references and spacing`,
      oldLength === 13 && readLatin1(topicOutWA, 12) === 'helloworld !' &&
      bytes[topicOutWA + 12] === 0);
    check(`${variant} old-style stream emits TEXT then END_TOPIC`,
      e.test_help_decode_topic_strings(0, topicOutWA, topicOutCapacity,
        topicTokensWA, topicTokenCapacity) === 2 &&
      dv.getUint32(topicTokensWA, true) === 1 && dv.getUint32(topicTokensWA + 4, true) === 0 &&
      dv.getUint32(topicTokensWA + 8, true) === 12 &&
      dv.getUint32(topicTokensWA + 16, true) === 13);
    check(`${variant} old-style stream emits formatted paragraph, text, and end`,
      e.test_help_decode_topic_formatted(0, topicOutWA, topicOutCapacity,
        topicTokensWA, topicTokenCapacity, topicPayloadWA, topicPayloadCapacity) === 3 &&
      dv.getUint32(topicTokensWA, true) === 4 &&
      dv.getUint32(topicTokensWA + 16, true) === 1 &&
      dv.getUint32(topicTokensWA + 32, true) === 13);
  }

  const emptyOldPhrases = buildSyntheticSemanticHelp({ oldPhrases: buildOldPhrases([]) });
  check('empty old-style phrase table is represented canonically',
    load(emptyOldPhrases.file) === 1 && e.get_help_phrase_count() === 0 &&
    e.get_help_phrase_image_size() === 0);

  const mounted = fs.readFileSync(path.join(HELP, 'freecell.hlp'));
  const mountedCnt = fs.readFileSync(path.join(HELP, 'freecell.cnt'));
  ctx.vfs.files.set('c:\\fixture.hlp', { data: new Uint8Array(mounted), attrs: 0x20 });
  ctx.vfs.files.set('c:\\fixture.cnt', { data: new Uint8Array(mountedCnt), attrs: 0x20 });
  const mountedPath = Buffer.from('c:\\fixture.hlp\0', 'latin1');
  bytes.set(mountedPath, nameWA);
  check('mounted file loads through raw VFS boundary', e.test_help_load_vfs(nameWA) === 1,
    `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
  check('VFS load publishes exact directory', e.get_help_directory_count() === EXPECTED['freecell.hlp'].length);
  check('VFS load derives and binds the same-directory CNT companion',
    e.get_help_cnt_node_count() === 3 &&
    readLatin1(e.get_help_cnt_title_ptr(), e.get_help_cnt_title_length()) === 'FreeCell Help');
  ctx.vfs.files.set('c:\\nocnt.hlp', { data: new Uint8Array(mounted), attrs: 0x20 });
  bytes.set(Buffer.from('c:\\nocnt.hlp\0', 'latin1'), nameWA);
  check('a missing optional CNT companion does not reject its HLP',
    e.test_help_load_vfs(nameWA) === 1 && e.get_help_cnt_node_count() === 0);
  ctx.vfs.files.set('c:\\badcnt.hlp', { data: new Uint8Array(mounted), attrs: 0x20 });
  ctx.vfs.files.set('c:\\badcnt.cnt', {
    data: new Uint8Array(Buffer.from('1 Root\n3 Bad\n', 'latin1')), attrs: 0x20,
  });
  bytes.set(Buffer.from('c:\\badcnt.hlp\0', 'latin1'), nameWA);
  check('a malformed mounted CNT rejects the document without partial publication',
    e.test_help_load_vfs(nameWA) === 0 && e.get_help_last_error() === 18 &&
    e.get_help_file_ptr() === 0 && e.get_help_cnt_node_count() === 0);
  bytes.set(mountedPath, nameWA);
  check('unified dispatcher loads a mounted path and applies its command',
    e.test_help_dispatch(0x3333, nameWA, 0x0003, 0, 0) === 1 &&
    e.get_help_session_owner() === 0x3333 && e.get_help_session_topic_ref() === 0 &&
    e.get_help_session_mode() === 1 && e.get_help_dispatch_status() === 1,
    `error=${e.get_help_last_error()} off=${e.get_help_last_error_offset()}`);
  bytes.set(Buffer.from('c:\\missing.hlp\0', 'latin1'), nameWA);
  check('unified dispatcher reports a missing VFS path without stale state',
    e.test_help_dispatch(0x3333, nameWA, 0x0003, 0, 0) === 0 &&
    e.get_help_last_error() === 7 && e.get_help_dispatch_status() === 7 &&
    e.get_help_file_ptr() === 0 && e.get_help_session_owner() === 0);

  const mountedPathA = allocGuestAnsi('c:\\fixture.hlp');
  check('WinHelpA ABI normalizes its guest path into the unified dispatcher',
    e.test_call_WinHelpA(0x4444, mountedPathA, 0x0003, 0) === 1 &&
    e.get_help_session_owner() === 0x4444 && e.get_help_session_topic_ref() === 0 &&
    e.get_help_dispatch_status() === 1,
    `status=${e.get_help_dispatch_status()} parse=${e.get_help_last_error()} owner=${e.get_help_session_owner()} ref=${e.get_help_session_topic_ref()}`);
  check('WinHelpA null path reuses only the matching active session',
    e.test_call_WinHelpA(0x4444, 0, 0x0003, 0) === 1 &&
    e.test_call_WinHelpA(0x5555, 0, 0x0003, 0) === 0 &&
    e.get_help_session_owner() === 0x4444 && e.get_help_dispatch_status() === 3);
  check('WinHelpA propagates unsupported command failure instead of TRUE',
    e.test_call_WinHelpA(0x4444, 0, 0x7777, 0) === 0 && e.get_help_dispatch_status() === 6);
  check('WinHelpA matching HELP_QUIT releases the active ABI session',
    e.test_call_WinHelpA(0x4444, 0, 0x0002, 0) === 1 && e.get_help_file_ptr() === 0);

  const mountedPathW = allocGuestWide('c:\\fixture.hlp');
  check('WinHelpW converts UTF-16 paths and shares the WinHelpA engine',
    e.test_call_WinHelpW(0x6666, mountedPathW, 0x0003, 0) === 1 &&
    e.get_help_session_owner() === 0x6666 && e.get_help_session_topic_ref() === 0 &&
    e.get_help_dispatch_status() === 1,
    `status=${e.get_help_dispatch_status()} parse=${e.get_help_last_error()} owner=${e.get_help_session_owner()} ref=${e.get_help_session_topic_ref()}`);
  ctx.vfs.files.set('c:\\keyword.hlp', { data: new Uint8Array(keywordHelp.file), attrs: 0x20 });
  const keywordPathW = allocGuestWide('c:\\keyword.hlp');
  const betaW = allocGuestWide('BETA');
  check('WinHelpW converts command-specific UTF-16 keyword data',
    e.test_call_WinHelpW(0x7777, keywordPathW, 0x0101, betaW) === 1 &&
    e.get_help_session_owner() === 0x7777 && e.get_help_session_topic_ref() === 10 &&
    e.get_help_session_topic_index() === 1,
    `status=${e.get_help_dispatch_status()} parse=${e.get_help_last_error()} owner=${e.get_help_session_owner()} ref=${e.get_help_session_topic_ref()}`);
  const oversizedWidePath = allocGuestWide('a'.repeat(1024));
  check('WinHelpW bounds UTF-16 pathname normalization before dispatch',
    e.test_call_WinHelpW(0x7777, oversizedWidePath, 0x0003, 0) === 0 &&
    e.get_help_session_owner() === 0x7777 && e.get_help_session_topic_ref() === 10 &&
    e.get_help_dispatch_status() === 5,
    `status=${e.get_help_dispatch_status()} owner=${e.get_help_session_owner()} ref=${e.get_help_session_topic_ref()}`);
  check('WinHelpW matching HELP_QUIT releases converted session state',
    e.test_call_WinHelpW(0x7777, 0, 0x0002, 0) === 1 && e.get_help_file_ptr() === 0);

  const notepadMounted = fs.readFileSync(path.join(HELP, 'notepad.hlp'));
  const notepadMountedCnt = fs.readFileSync(path.join(HELP, 'notepad.cnt'));
  ctx.vfs.files.set('c:\\notepad.hlp', { data: new Uint8Array(notepadMounted), attrs: 0x20 });
  ctx.vfs.files.set('c:\\notepad.cnt', { data: new Uint8Array(notepadMountedCnt), attrs: 0x20 });
  const notepadPathA = allocGuestAnsi('c:\\notepad.hlp');
  check('HELP_FINDER opens a separate WAT-native Topics window',
    e.test_invoke_WinHelpA(0x8888, notepadPathA, 0x000b, 0) === 1 &&
    e.get_help_topics_hwnd() !== 0 && e.get_help_window() === 0 &&
    e.get_help_session_mode() === 3 && e.get_help_topics_contents_selection() === 0);
  // $wnd_table_set zeroes the record's style, and $paint_select_next_dirty
  // discards the paint bit of any window without WS_VISIBLE. Without a style
  // the dialog painted once at creation and every later invalidate - tab
  // switch, selection move, scroll - was silently dropped on screen.
  check('the Topics window carries the style its repaints depend on',
    (e.wnd_get_style_export(e.get_help_topics_hwnd()) & 0x10000000) !== 0,
    `style=0x${(e.wnd_get_style_export(e.get_help_topics_hwnd()) >>> 0).toString(16)}`);
  // The dialog is assembled from the controls the emulator already
  // implements, so these assert the controls exist and are wired, not that a
  // hand-painted rectangle landed on the right pixel. Class 4 = ListBox,
  // class 1 = Button, per $ctrl_table_set.
  check('the Topics dialog shows its rows in a real listbox',
    e.ctrl_get_class(e.get_help_topics_list_hwnd()) === 4 &&
    e.listbox_get_count(e.get_help_topics_list_hwnd()) >= 1,
    `class=${e.ctrl_get_class(e.get_help_topics_list_hwnd())} ` +
    `count=${e.listbox_get_count(e.get_help_topics_list_hwnd())}`);
  check('the Topics dialog carries a real tab control and real buttons',
    e.ctrl_get_class(e.get_help_topics_control(0x502)) === 27 &&
    [1, 2].every(id => e.ctrl_get_class(e.get_help_topics_control(id)) === 1));
  {
    // Row text comes from the .cnt node, not from a marker glyph alone: the
    // rows once rendered as bare marks because the paint erased its own text.
    const dest = e.guest_alloc(160);
    e.listbox_get_item_text(e.get_help_topics_list_hwnd(), 0, dest, 128);
    let row = '';
    for (let i = 0; i < 128; i++) {
      const ch = e.guest_read8(dest + i);
      if (!ch) break;
      row += String.fromCharCode(ch);
    }
    check('a Topics row carries its title text',
      row.replace(/^[\s>+-]+/, '').length > 0, JSON.stringify(row));
  }
  // A click lands on the tab control itself. COMCTL32's tab mirror records
  // the new selection before any wndproc runs, and the strip's wndproc reads
  // it back - so this drives the real control, not a shortcut into the model.
  // Tab widths are len*5+16, so "Contents" spans x 0..55 and "Index" 56..96.
  {
    const tabs = e.get_help_topics_control(0x502);
    const click = x => e.send_message(tabs, 0x0201, 0, (8 << 16) | x);
    click(70);
    const switched = e.get_help_session_mode() === 4;
    click(20);
    check('clicking the tab control switches the Topics dialog',
      switched && e.get_help_session_mode() === 3);
  }
  check('Topics keyboard tab switching retains canonical dialog state',
    e.test_help_topics_message(0x0100, 0x09, 0) === 0 && e.get_help_session_mode() === 4 &&
    e.test_help_topics_message(0x0100, 0x09, 0) === 0 && e.get_help_session_mode() === 3 &&
    e.get_help_topics_hwnd() !== 0);
  check('Topics Cancel restores the prior viewer mode without releasing the document',
    e.test_help_topics_message(0x0100, 0x1b, 0) === 0 &&
    e.get_help_topics_hwnd() === 0 && e.get_help_session_mode() === 0 &&
    e.get_help_file_ptr() !== 0 &&
    e.test_invoke_WinHelpA(0x8888, 0, 0x000b, 0) === 1 && e.get_help_topics_hwnd() !== 0);
  check('Topics Display closes the dialog and presents its resolved CNT leaf',
    e.test_help_topics_message(0x0100, 0x0d, 0) === 0 &&
    e.get_help_topics_hwnd() === 0 && e.get_help_window() !== 0 &&
    e.get_help_session_mode() === 1 && e.get_help_session_topic_ref() === 994 &&
    e.get_help_view_topic_index() === 2);
  // $gdi_dc_state_entry binds a window DC to its HWND only when it first
  // creates the record, and the host composites during $host_create_window -
  // so registering the window afterwards left the viewer's DC unbound
  // forever. Every paint then drew into a record with no window and
  // $gdi_surface_descriptor refused it: the window was visible, sized, laid
  // out, and blank.
  // (Whether that surface then materialises depends on a renderer, which this
  // harness has none of - the binding is the part that was broken.)
  check('the help viewer client DC is bound to its window',
    e.test_gdi_dc_get_field(e.get_help_window() + 0x40000, 92, 0)
      === e.get_help_window());
  check('the help viewer closes from its title bar',
    e.test_help_window_message(0x00A1, 20, 0) === 0 && e.get_help_window() === 0);
  check('HELP_QUIT tears down both Topics and main help windows',
    e.test_invoke_WinHelpA(0x8888, 0, 0x0002, 0) === 1 &&
    e.get_help_topics_hwnd() === 0 && e.get_help_window() === 0);

  {
    // Every .cnt in the Win98 corpus is the one-line "not meant for browsing"
    // stub, so the Contents tab alone cannot prove the listbox fills from a
    // real model. HOVER.HLP is the file in reach that ships a |KWBTREE, and
    // its keywords are what the Index tab lists.
    ctx.vfs.files.set('c:\\hover.hlp', { data: new Uint8Array(hoverHelp), attrs: 0x20 });
    const hoverPathA = allocGuestAnsi('c:\\hover.hlp');
    const opened = e.test_invoke_WinHelpA(0x8888, hoverPathA, 0x000b, 0) === 1;
    e.send_message(e.get_help_topics_control(0x502), 0x0201, 0, (8 << 16) | 70);
    const list = e.get_help_topics_list_hwnd();
    const dest = e.guest_alloc(160);
    e.listbox_get_item_text(list, 0, dest, 128);
    let first = '';
    for (let i = 0; i < 128; i++) {
      const ch = e.guest_read8(dest + i);
      if (!ch) break;
      first += String.fromCharCode(ch);
    }
    check('the Index tab lists one row per keyword',
      opened && e.get_help_session_mode() === 4 &&
      e.get_help_keyword_count() > 0 &&
      e.listbox_get_count(list) === e.get_help_keyword_count() && first.length > 0,
      `keywords=${e.get_help_keyword_count()} rows=${e.listbox_get_count(list)} ` +
      `first=${JSON.stringify(first)}`);
    e.test_invoke_WinHelpA(0x8888, 0, 0x0002, 0);
  }

  ctx.vfs.files.set('c:\\bitmap-view.hlp', {
    data: new Uint8Array(bitmapViewHelp.file), attrs: 0x20,
  });
  const bitmapViewPathA = allocGuestAnsi('c:\\bitmap-view.hlp');
  const bitmapWindowAccepted = e.test_invoke_WinHelpA(
    0x8888, bitmapViewPathA, 0x0001, 8);
  const bitmapWindowHandle = e.get_help_view_bitmap_handle(0);
  const bitmapWindowFont = e.get_help_view_font_handle(2);
  check('real WinHelp window path publishes WAT-owned bitmap and font objects',
    bitmapWindowAccepted === 1 && e.get_help_window() !== 0 &&
    e.get_help_view_bitmap_count() === 1 && bitmapWindowHandle !== 0 &&
    e.test_gdi_object_type(bitmapWindowHandle) === 3 &&
    e.get_help_view_font_count() === 1 && bitmapWindowFont !== 0 &&
    e.test_gdi_object_type(bitmapWindowFont) === 4);
  check('HELP_QUIT releases embedded bitmap/font objects and source DC state',
    e.test_invoke_WinHelpA(0x8888, 0, 0x0002, 0) === 1 &&
    e.get_help_window() === 0 && e.get_help_view_bitmap_count() === 0 &&
    e.get_help_view_bitmap_dc() === 0 && e.get_help_view_font_count() === 0 &&
    e.test_gdi_object_type(bitmapWindowHandle) === 0 &&
    e.test_gdi_object_type(bitmapWindowFont) === 0);

  const hotspotHelp = buildSyntheticSemanticHelp({
    topic: buildSyntheticFormattedTopic({
      hotspotOpcode: 0xe3, hotspotHash: 20, closeVariableHotspot: true,
    }),
    font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
  });
  ctx.vfs.files.set('c:\\hotspot.hlp', {
    data: new Uint8Array(hotspotHelp.file), attrs: 0x20,
  });
  const hotspotPathA = allocGuestAnsi('c:\\hotspot.hlp');
  const hotspotAccepted = e.test_invoke_WinHelpA(0x8888, hotspotPathA, 0x0001, 8);
  check('formatted hotspot fixture opens through the real WinHelp handler',
    hotspotAccepted === 1 &&
    e.get_help_session_topic_ref() === 0 && e.get_help_view_run_count() > 0,
    `status=${e.get_help_dispatch_status()} parse=${e.get_help_last_error()} ` +
      `ref=${e.get_help_session_topic_ref()} runs=${e.get_help_view_run_count()}`);
  const hotspotRuns = Array.from({ length: e.get_help_view_run_count() }, (_, index) => {
    const record = e.get_help_view_run_ptr() + index * 40;
    return {
      token: dv.getUint32(record + 36, true) - 1,
      x: dv.getInt32(record + 4, true), y: dv.getInt32(record + 8, true),
      width: dv.getInt32(record + 12, true), height: dv.getInt32(record + 16, true),
      flagged: dv.getUint32(record + 36, true) !== 0,
    };
  }).filter(run => run.flagged && run.width > 0 && run.height > 0);
  const fixedHotspotRun = hotspotRuns[0];
  check('hotspot hit-testing returns the exact retained begin token',
    fixedHotspotRun &&
    e.test_help_view_hotspot_token_at(fixedHotspotRun.x, fixedHotspotRun.y) === fixedHotspotRun.token &&
    e.test_help_view_hotspot_token_at(399, 270) === -1);
  check('hotspot click uses canonical hash navigation and Back history',
    fixedHotspotRun && e.test_help_window_message(0x0201, 0,
      (fixedHotspotRun.y << 16) | (fixedHotspotRun.x & 0xffff)) === 0 &&
    e.get_help_session_topic_ref() === 30 && e.get_help_session_mode() === 1 &&
    e.get_help_view_topic_index() === 3 && e.get_help_view_back_count() === 1);
  e.test_help_view_go_back();
  check('Back returns from a clicked hotspot without reparsing through JS',
    e.get_help_session_topic_ref() === 0 && e.get_help_view_topic_index() === 0 &&
    e.get_help_view_back_count() === 0);
  // The fixture emits three regions in command order: the fixed hash hotspot,
  // the macro, then the variable external hotspot.
  const macroRun = hotspotRuns[1];
  const variableHotspotRun = hotspotRuns[2];
  check('a macro region is clickable and reports the macro explicitly',
    macroRun && variableHotspotRun &&
    macroRun.token > fixedHotspotRun.token &&
    variableHotspotRun.token > macroRun.token &&
    e.test_help_view_hotspot_token_at(macroRun.x, macroRun.y) === macroRun.token &&
    e.test_help_activate_hotspot_at(0x8888, macroRun.x, macroRun.y) === 0 &&
    e.get_help_dispatch_status() === 6 && e.get_help_session_topic_ref() === 0 &&
    e.get_help_view_topic_index() === 0 && e.get_help_view_back_count() === 0,
    `runs=${hotspotRuns.length} status=${e.get_help_dispatch_status()}`);
  {
    // Macro allowlist. The names are matched by an upper-cased FNV-1a hash so
    // the WAT side needs no data segment of literals; these first assertions
    // prove each constant in the source still belongs to the name its comment
    // claims, which is the part a reader cannot check by eye.
    const hashOf = text => {
      const wa = topicPayloadWA + 0x8000;
      const buf = Buffer.from(text, 'latin1');
      bytes.set(buf, wa);
      return e.test_help_macro_name_hash(wa, buf.length) >>> 0;
    };
    check('macro names hash to the constants the allowlist switches on',
      hashOf('JumpContext') === 0x4C586124 && hashOf('JC') === 0x4DF12BFA &&
      hashOf('PopupContext') === 0xF5739554 && hashOf('PC') === 0x2E000424 &&
      hashOf('JumpId') === 0x367A77D8 && hashOf('KLink') === 0x6C09F342 &&
      hashOf('Contents') === 0x314DC863 && hashOf('Exit') === 0x79836105);
    const runMacro = text => {
      const wa = topicPayloadWA + 0x8000;
      const buf = Buffer.from(text, 'latin1');
      bytes.set(buf, wa);
      const ok = e.test_help_macro_execute(0x8888, wa, buf.length);
      return { ok, status: e.get_help_dispatch_status() };
    };
    // 6 = UNSUPPORTED, 5 = BAD_DATA, 4 = UNRESOLVED.
    check('macros this emulator does not perform report UNSUPPORTED',
      ['PlayWave("ding", 1)', 'ExecProgram("notepad.exe", 0)', 'Annotate()',
       'AL("a-playingtopics")', 'ALink("x")', 'RegisterRoutine("a","b","c")']
        .every(macro => {
          const result = runMacro(macro);
          return result.ok === 0 && result.status === 6;
        }));
    check('a known macro with the wrong argument shape reports BAD_DATA',
      runMacro('JumpContext("not a number")').status === 5 &&
      runMacro('KLink(17)').status === 5);
    check('a known macro naming nothing in this document reports UNRESOLVED',
      runMacro('JumpContext(999999)').status === 4 &&
      runMacro('JumpId("nosuch.hlp", "IDH_NOT_HERE")').status === 4 &&
      runMacro('KL("no such keyword")').status === 4);
  }

  // The variable hotspot names window 5, which this fixture's document does
  // not define, so activation fails as unresolved rather than misrouting.
  check('unresolvable variable hotspots fail safely without changing topic or history',
    variableHotspotRun &&
    e.test_help_activate_hotspot_at(0x8888,
      variableHotspotRun.x, variableHotspotRun.y) === 0 &&
    e.get_help_dispatch_status() === 4 && e.get_help_session_topic_ref() === 0 &&
    e.get_help_view_topic_index() === 0 && e.get_help_view_back_count() === 0);

  function firstVisibleHotspotRun() {
    return Array.from({ length: e.get_help_view_run_count() }, (_, index) => {
      const record = e.get_help_view_run_ptr() + index * 40;
      return {
        x: dv.getInt32(record + 4, true), y: dv.getInt32(record + 8, true),
        width: dv.getInt32(record + 12, true), height: dv.getInt32(record + 16, true),
        flagged: dv.getUint32(record + 36, true) !== 0,
      };
    }).find(run => run.flagged && run.width > 0 && run.height > 0);
  }

  const fixedOpcodeCases = [
    [0xe1, 20, 1, 'direct E1 topic jump'],
    [0xe7, 30, 1, 'hash E7 topic jump without font change'],
    [0xe0, 20, 2, 'direct E0 popup'],
    [0xe6, 30, 2, 'hash E6 popup without font change'],
  ];
  for (const [opcode, expectedRef, expectedMode, label] of fixedOpcodeCases) {
    const fixedCaseHelp = buildSyntheticSemanticHelp({
      topic: buildSyntheticFormattedTopic({
        hotspotOpcode: opcode, hotspotHash: 20,
        closeVariableHotspot: true,
      }),
      font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
    });
    const fixedCasePath = `c:\\fixed-${opcode.toString(16)}.hlp`;
    ctx.vfs.files.set(fixedCasePath, {
      data: new Uint8Array(fixedCaseHelp.file), attrs: 0x20,
    });
    const fixedCaseAccepted = e.test_invoke_WinHelpA(
      0x8888, allocGuestAnsi(fixedCasePath), 0x0001, 8);
    const run = fixedCaseAccepted === 1 ? firstVisibleHotspotRun() : null;
    const clicked = run && e.test_help_window_message(0x0201, 0,
      (run.y << 16) | (run.x & 0xffff)) === 0;
    check(`${label} uses exact target semantics and opcode parity`,
      fixedCaseAccepted === 1 && clicked &&
      e.get_help_session_topic_ref() === expectedRef &&
      e.get_help_session_mode() === expectedMode &&
      (expectedMode === 2 ? e.get_help_popup_hwnd() !== 0 : e.get_help_popup_hwnd() === 0));
    if (expectedMode === 2 && e.get_help_popup_hwnd()) {
      e.test_help_popup_message(0x0010, 0, 0);
    }
  }

  const currentFileExternalCases = [
    [buildExternalHotspot(0xeb, 0, 20), 1, 'type 0 current-file jump'],
    [buildExternalHotspot(0xea, 1, 20, { windowNumber: 0xff }), 2,
      'type 1 current-window popup'],
  ];
  for (const [command, expectedMode, label] of currentFileExternalCases) {
    const currentFileHelp = buildSyntheticSemanticHelp({
      topic: buildSyntheticFormattedTopic({
        hotspotCommand: command, closeVariableHotspot: true,
      }),
      font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
    });
    const currentFilePath = `c:\\current-${expectedMode}.hlp`;
    ctx.vfs.files.set(currentFilePath, {
      data: new Uint8Array(currentFileHelp.file), attrs: 0x20,
    });
    const accepted = e.test_invoke_WinHelpA(
      0x8888, allocGuestAnsi(currentFilePath), 0x0001, 8);
    const run = accepted === 1 ? firstVisibleHotspotRun() : null;
    const clicked = run && e.test_help_window_message(0x0201, 0,
      (run.y << 16) | (run.x & 0xffff)) === 0;
    check(`${label} resolves through the bounded external structure`,
      accepted === 1 && clicked && e.get_help_session_topic_ref() === 30 &&
      e.get_help_session_mode() === expectedMode &&
      e.get_help_document_snapshot_count() === 0);
    if (expectedMode === 2 && e.get_help_popup_hwnd()) {
      e.test_help_popup_message(0x0010, 0, 0);
    }
  }

  const secondaryWindowTable = [
    buildSystemWindow({ flags: 0x007f, type: 'main', name: 'main',
      caption: 'Main Help', x: 100, y: 50, width: 400, height: 300 }),
    buildSystemWindow({ flags: 0x007f, type: 'secondary', name: 'Glossary',
      caption: 'Glossary Window', x: 128, y: 64, width: 512, height: 384 }),
  ];
  const scaleWindowX = value => Math.trunc(value * 640 / 1024);
  const scaleWindowY = value => Math.trunc(value * 480 / 1024);
  const readCString = ptr => {
    let end = ptr;
    while (bytes[end]) end++;
    return Buffer.from(bytes.subarray(ptr, end)).toString('latin1');
  };
  const buildWindowSelectorHelp = command => buildSyntheticSemanticHelp({
    topic: buildSyntheticFormattedTopic({
      hotspotCommand: command, closeVariableHotspot: true,
    }),
    font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
    windows: secondaryWindowTable,
  });

  const numericWindowPath = 'c:\\numeric-window.hlp';
  ctx.vfs.files.set(numericWindowPath, {
    data: new Uint8Array(buildWindowSelectorHelp(
      buildExternalHotspot(0xeb, 1, 20, { windowNumber: 1 })).file), attrs: 0x20,
  });
  const numericAccepted = e.test_invoke_WinHelpA(
    0x8888, allocGuestAnsi(numericWindowPath), 0x0001, 8);
  const glossaryRecord = e.get_help_window_record(1);
  check('synthetic SYSTEM records publish exact normalized window metadata',
    numericAccepted === 1 && e.get_help_window_count() === 2 &&
    e.get_help_active_window_index() === -1 && glossaryRecord !== 0 &&
    readLatin1(e.get_help_file_ptr() + dv.getUint32(glossaryRecord + 12, true),
      dv.getUint32(glossaryRecord + 16, true)) === 'Glossary' &&
    readLatin1(e.get_help_file_ptr() + dv.getUint32(glossaryRecord + 20, true),
      dv.getUint32(glossaryRecord + 24, true)) === 'Glossary Window' &&
    JSON.stringify(Array.from({ length: 4 },
      (_, index) => dv.getInt32(glossaryRecord + 28 + index * 4, true))) ===
      JSON.stringify([128, 64, 512, 384]));
  const numericRun = numericAccepted === 1 ? firstVisibleHotspotRun() : null;
  const numericMoveBase = windowMoves.length;
  const numericTextBase = windowTexts.length;
  check('numeric type-1 selector presents its normalized SYSTEM window',
    numericRun && e.test_help_window_message(0x0201, 0,
      (numericRun.y << 16) | (numericRun.x & 0xffff)) === 0 &&
    e.get_help_active_window_index() === 1 &&
    e.get_help_session_topic_ref() === 30 && e.get_help_session_mode() === 1 &&
    windowMoves.length === numericMoveBase + 1 &&
    JSON.stringify(windowMoves[numericMoveBase].slice(1)) === JSON.stringify([
      scaleWindowX(128), scaleWindowY(64), scaleWindowX(512), scaleWindowY(384)]) &&
    windowTexts.length > numericTextBase &&
    readCString(windowTexts[windowTexts.length - 1][1]) === 'Glossary Window');

  const mainMoveBase = windowMoves.length;
  check('an API-issued command returns the viewer to the main presentation',
    e.test_invoke_WinHelpA(0x8888, allocGuestAnsi(numericWindowPath), 0x0001, 8) === 1 &&
    e.get_help_active_window_index() === -1 &&
    windowMoves.length === mainMoveBase + 1 &&
    JSON.stringify(windowMoves[mainMoveBase].slice(1)) ===
      JSON.stringify([100, 50, 400, 300]));

  const badNumberPath = 'c:\\numeric-window-bad.hlp';
  ctx.vfs.files.set(badNumberPath, {
    data: new Uint8Array(buildWindowSelectorHelp(
      buildExternalHotspot(0xeb, 1, 20, { windowNumber: 4 })).file), attrs: 0x20,
  });
  const badNumberAccepted = e.test_invoke_WinHelpA(
    0x8888, allocGuestAnsi(badNumberPath), 0x0001, 8);
  const badNumberRun = badNumberAccepted === 1 ? firstVisibleHotspotRun() : null;
  const badNumberMoveBase = windowMoves.length;
  check('out-of-range numeric window selectors fail without changing topic or presentation',
    badNumberRun &&
    e.test_help_activate_hotspot_at(0x8888, badNumberRun.x, badNumberRun.y) === 0 &&
    e.get_help_dispatch_status() === 4 && e.get_help_session_topic_ref() === 0 &&
    e.get_help_active_window_index() === -1 &&
    windowMoves.length === badNumberMoveBase &&
    e.get_help_document_snapshot_count() === 0);

  const popupHelp = buildSyntheticSemanticHelp({
    topic: buildSyntheticFormattedTopic({
      hotspotOpcode: 0xe2, hotspotHash: 20, closeVariableHotspot: true,
    }),
    font: buildOldFont(['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0])),
  });
  ctx.vfs.files.set('c:\\popup.hlp', {
    data: new Uint8Array(popupHelp.file), attrs: 0x20,
  });
  const popupPathA = allocGuestAnsi('c:\\popup.hlp');
  check('fixed popup hotspot fixture replaces the active document transactionally',
    e.test_invoke_WinHelpA(0x8888, popupPathA, 0x0001, 8) === 1 &&
    e.get_help_session_topic_ref() === 0 && e.get_help_session_mode() === 1 &&
    e.get_help_view_back_count() === 0);
  const popupMainHwnd = e.get_help_window();
  const popupMainTopicPtr = e.get_help_view_topic_ptr();
  const popupMainRunsPtr = e.get_help_view_run_ptr();
  const popupMainFont = Array.from({ length: e.get_help_view_font_slot_count() },
    (_, index) => e.get_help_view_font_handle(index)).find(Boolean) || 0;
  const popupCreateStart = windowCreates.length;
  const popupRun = Array.from({ length: e.get_help_view_run_count() }, (_, index) => {
    const record = e.get_help_view_run_ptr() + index * 40;
    return {
      x: dv.getInt32(record + 4, true), y: dv.getInt32(record + 8, true),
      flagged: dv.getUint32(record + 36, true) !== 0,
    };
  }).find(run => run.flagged);
  check('fixed popup hotspot opens a separate owned popup and shadow window',
    popupRun && e.test_help_window_message(0x0201, 0,
      (popupRun.y << 16) | (popupRun.x & 0xffff)) === 0 &&
    e.get_help_popup_hwnd() !== 0 && e.get_help_popup_shadow_hwnd() !== 0 &&
    e.get_help_popup_hwnd() !== popupMainHwnd && e.get_help_window() === popupMainHwnd &&
    e.wnd_get_owner(e.get_help_popup_hwnd()) === popupMainHwnd &&
    e.wnd_get_owner(e.get_help_popup_shadow_hwnd()) === popupMainHwnd);
  const popupHwnd = e.get_help_popup_hwnd();
  const popupShadowHwnd = e.get_help_popup_shadow_hwnd();
  const popupCreates = windowCreates.slice(popupCreateStart);
  check('fixed popup owns bounded content-sized geometry and popup styles',
    popupCreates.length === 2 && popupCreates[0][0] === popupShadowHwnd &&
    (popupCreates[0][1] >>> 0) === 0x90000000 && popupCreates[1][0] === popupHwnd &&
    (popupCreates[1][1] >>> 0) === 0x90800000 &&
    e.get_help_popup_width() >= 96 && e.get_help_popup_width() <= 336 &&
    e.get_help_popup_height() >= 32 && e.get_help_popup_height() <= 240 &&
    popupCreates.every(call => call[4] === e.get_help_popup_width() &&
      call[5] === e.get_help_popup_height()));
  check('popup navigation preserves primary Back history while publishing popup state',
    e.get_help_session_topic_ref() === 30 && e.get_help_session_mode() === 2 &&
    e.get_help_view_topic_index() === 3 && e.get_help_view_back_count() === 0 &&
    e.get_help_view_topic_ptr() !== popupMainTopicPtr);
  check('Escape dismisses popup and atomically restores the exact primary view',
    e.test_help_popup_message(0x0100, 0x1b, 0) === 0 &&
    e.get_help_popup_hwnd() === 0 && e.get_help_popup_shadow_hwnd() === 0 &&
    e.get_help_window() === popupMainHwnd &&
    e.get_help_session_topic_ref() === 0 && e.get_help_session_mode() === 1 &&
    e.get_help_view_topic_index() === 0 && e.get_help_view_back_count() === 0 &&
    e.get_help_view_topic_ptr() === popupMainTopicPtr &&
    e.get_help_view_run_ptr() === popupMainRunsPtr &&
    windowDestroys.includes(popupHwnd) && windowDestroys.includes(popupShadowHwnd));
  check('HELP_CONTEXTPOPUP uses the same separate popup lifecycle',
    e.test_invoke_WinHelpA(0x8888, 0, 0x0008, 7) === 1 &&
    e.get_help_window() === popupMainHwnd && e.get_help_popup_hwnd() !== 0 &&
    e.get_help_session_topic_ref() === 20 && e.get_help_session_mode() === 2 &&
    e.get_help_view_back_count() === 0);
  const apiPopupFont = Array.from({ length: e.get_help_view_font_slot_count() },
    (_, index) => e.get_help_view_font_handle(index)).find(Boolean) || 0;
  check('WM_CLOSE dismisses an API popup without closing its primary viewer',
    e.test_help_popup_message(0x0010, 0, 0) === 0 &&
    e.get_help_popup_hwnd() === 0 && e.get_help_popup_shadow_hwnd() === 0 &&
    e.get_help_window() === popupMainHwnd && e.get_help_session_topic_ref() === 0 &&
    e.get_help_session_mode() === 1 && e.get_help_view_topic_ptr() === popupMainTopicPtr &&
    (!apiPopupFont || e.test_gdi_object_type(apiPopupFont) === 0) &&
    (!popupMainFont || e.test_gdi_object_type(popupMainFont) === 4));
  check('a primary-window background click dismisses the owned popup',
    e.test_invoke_WinHelpA(0x8888, 0, 0x0008, 7) === 1 &&
    e.test_help_window_message(0x0201, 0, 0) === 0 &&
    e.get_help_popup_hwnd() === 0 && e.get_help_session_topic_ref() === 0 &&
    e.get_help_view_topic_ptr() === popupMainTopicPtr);
  check('popup focus loss restores the primary transaction',
    e.test_invoke_WinHelpA(0x8888, 0, 0x0008, 7) === 1 &&
    e.test_help_popup_message(0x0008, popupMainHwnd, 0) === 0 &&
    e.get_help_popup_hwnd() === 0 && e.get_help_session_mode() === 1 &&
    e.get_help_view_topic_ptr() === popupMainTopicPtr);
  check('HELP_QUIT releases both views while a context popup is live',
    e.test_invoke_WinHelpA(0x8888, 0, 0x0008, 7) === 1 &&
    e.get_help_popup_hwnd() !== 0 &&
    e.test_invoke_WinHelpA(0x8888, 0, 0x0002, 0) === 1 &&
    e.get_help_window() === 0 && e.get_help_popup_hwnd() === 0 &&
    e.get_help_popup_shadow_hwnd() === 0 && e.get_help_view_topic_ptr() === 0 &&
    (!popupMainFont || e.test_gdi_object_type(popupMainFont) === 0));

  const hotspotFont = buildOldFont(
    ['Fixture Face'], Array.from({ length: 3 }, () => [0,20,2,0]));
  const buildRuntimeHotspotHelp = command => buildSyntheticSemanticHelp({
    topic: buildSyntheticFormattedTopic({
      hotspotCommand: command, closeVariableHotspot: true,
    }),
    font: hotspotFont,
  });
  const externalTargetPath = 'c:\\manual\\target.hlp';
  const externalTargetHelp = buildRuntimeHotspotHelp(
    Buffer.from([0xe3, 20, 0, 0, 0]));
  ctx.vfs.files.set(externalTargetPath, {
    data: new Uint8Array(externalTargetHelp.file), attrs: 0x20,
  });

  const externalSourcePath = 'c:\\manual\\source.hlp';
  const externalSourceHelp = buildRuntimeHotspotHelp(
    buildExternalHotspot(0xeb, 4, 20, { file: 'target.hlp' }));
  ctx.vfs.files.set(externalSourcePath, {
    data: new Uint8Array(externalSourceHelp.file), attrs: 0x20,
  });
  const externalSourceAccepted = e.test_invoke_WinHelpA(
    0x8888, allocGuestAnsi(externalSourcePath), 0x0001, 8);
  const externalMainHwnd = e.get_help_window();
  const externalRun = externalSourceAccepted === 1 ? firstVisibleHotspotRun() : null;
  check('relative external topic hotspot loads a mounted target through WAT',
    externalRun && e.test_help_window_message(0x0201, 0,
      (externalRun.y << 16) | (externalRun.x & 0xffff)) === 0 &&
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
      externalTargetPath &&
    e.get_help_document_snapshot_count() === 1 &&
    e.get_help_session_topic_ref() === 30 && e.get_help_session_mode() === 1 &&
    e.get_help_window() === externalMainHwnd);
  e.test_help_view_go_back();
  check('Back restores the suspended external source document and visible topic',
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
      externalSourcePath &&
    e.get_help_document_snapshot_count() === 0 &&
    e.get_help_session_topic_ref() === 0 && e.get_help_view_topic_index() === 0 &&
    e.get_help_view_run_count() > 0 && e.get_help_window() === externalMainHwnd);

  const namedWindowTargetPath = 'c:\\manual\\window-target.hlp';
  ctx.vfs.files.set(namedWindowTargetPath, {
    data: new Uint8Array(buildSyntheticSemanticHelp({
      topic: buildSyntheticFormattedTopic({
        hotspotCommand: Buffer.from([0xe3, 20, 0, 0, 0]),
        closeVariableHotspot: true,
      }),
      font: hotspotFont, windows: secondaryWindowTable,
    }).file), attrs: 0x20,
  });
  const namedWindowSourcePath = 'c:\\manual\\window-source.hlp';
  ctx.vfs.files.set(namedWindowSourcePath, {
    data: new Uint8Array(buildRuntimeHotspotHelp(buildExternalHotspot(0xef, 6, 20,
      { file: 'window-target.hlp', window: 'GLOSSARY' })).file), attrs: 0x20,
  });
  const namedWindowAccepted = e.test_invoke_WinHelpA(
    0x8888, allocGuestAnsi(namedWindowSourcePath), 0x0001, 8);
  const namedWindowRun = namedWindowAccepted === 1 ? firstVisibleHotspotRun() : null;
  const namedWindowMoveBase = windowMoves.length;
  check('type-6 selectors resolve a named window inside the loaded target file',
    namedWindowRun && e.test_help_window_message(0x0201, 0,
      (namedWindowRun.y << 16) | (namedWindowRun.x & 0xffff)) === 0 &&
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
      namedWindowTargetPath &&
    e.get_help_document_snapshot_count() === 1 &&
    e.get_help_active_window_index() === 1 &&
    e.get_help_session_topic_ref() === 30 && e.get_help_session_mode() === 1 &&
    windowMoves.length === namedWindowMoveBase + 1 &&
    JSON.stringify(windowMoves[namedWindowMoveBase].slice(1)) === JSON.stringify([
      scaleWindowX(128), scaleWindowY(64), scaleWindowX(512), scaleWindowY(384)]));
  const namedWindowBackMoveBase = windowMoves.length;
  e.test_help_view_go_back();
  check('cross-file Back restores the source document and its main presentation',
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
      namedWindowSourcePath && e.get_help_document_snapshot_count() === 0 &&
    e.get_help_active_window_index() === -1 &&
    windowMoves.length === namedWindowBackMoveBase + 1 &&
    JSON.stringify(windowMoves[namedWindowBackMoveBase].slice(1)) ===
      JSON.stringify([100, 50, 400, 300]));

  const unknownWindowSourcePath = 'c:\\manual\\window-unknown.hlp';
  ctx.vfs.files.set(unknownWindowSourcePath, {
    data: new Uint8Array(buildRuntimeHotspotHelp(buildExternalHotspot(0xef, 6, 20,
      { file: 'window-target.hlp', window: 'nosuchwin' })).file), attrs: 0x20,
  });
  const unknownWindowAccepted = e.test_invoke_WinHelpA(
    0x8888, allocGuestAnsi(unknownWindowSourcePath), 0x0001, 8);
  const unknownWindowRun = unknownWindowAccepted === 1 ? firstVisibleHotspotRun() : null;
  const unknownWindowDoc = e.get_help_file_ptr();
  const unknownWindowView = e.get_help_view_topic_ptr();
  check('an unknown named window rolls the loaded target back exactly',
    unknownWindowRun &&
    e.test_help_activate_hotspot_at(0x8888, unknownWindowRun.x, unknownWindowRun.y) === 0 &&
    e.get_help_dispatch_status() === 4 &&
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
      unknownWindowSourcePath &&
    e.get_help_file_ptr() === unknownWindowDoc &&
    e.get_help_view_topic_ptr() === unknownWindowView &&
    e.get_help_active_window_index() === -1 &&
    e.get_help_session_topic_ref() === 0 && e.get_help_view_back_count() === 0 &&
    e.get_help_document_snapshot_count() === 0);

  const missingSourcePath = 'c:\\manual\\missing-source.hlp';
  const missingSourceHelp = buildRuntimeHotspotHelp(
    buildExternalHotspot(0xeb, 4, 20, { file: 'absent.hlp' }));
  ctx.vfs.files.set(missingSourcePath, {
    data: new Uint8Array(missingSourceHelp.file), attrs: 0x20,
  });
  const missingAccepted = e.test_invoke_WinHelpA(
    0x8888, allocGuestAnsi(missingSourcePath), 0x0001, 8);
  const missingRun = missingAccepted === 1 ? firstVisibleHotspotRun() : null;
  const missingDoc = e.get_help_file_ptr();
  const missingView = e.get_help_view_topic_ptr();
  const missingRuns = e.get_help_view_run_ptr();
  check('missing external targets roll back document, session, view, and history exactly',
    missingRun && e.test_help_activate_hotspot_at(0x8888, missingRun.x, missingRun.y) === 0 &&
    e.get_help_dispatch_status() === 7 &&
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
      missingSourcePath &&
    e.get_help_file_ptr() === missingDoc && e.get_help_view_topic_ptr() === missingView &&
    e.get_help_view_run_ptr() === missingRuns && e.get_help_session_topic_ref() === 0 &&
    e.get_help_view_back_count() === 0 && e.get_help_document_snapshot_count() === 0);

  const externalPopupSourcePath = 'c:\\manual\\popup-source.hlp';
  const externalPopupSourceHelp = buildRuntimeHotspotHelp(
    buildExternalHotspot(0xea, 4, 20, { file: 'target.hlp' }));
  ctx.vfs.files.set(externalPopupSourcePath, {
    data: new Uint8Array(externalPopupSourceHelp.file), attrs: 0x20,
  });
  const externalPopupAccepted = e.test_invoke_WinHelpA(
    0x8888, allocGuestAnsi(externalPopupSourcePath), 0x0001, 8);
  const externalPopupMainView = e.get_help_view_topic_ptr();
  const externalPopupMainRuns = e.get_help_view_run_ptr();
  const externalPopupRun = externalPopupAccepted === 1 ? firstVisibleHotspotRun() : null;
  check('external popup suspends its source document behind an owned popup',
    externalPopupRun && e.test_help_window_message(0x0201, 0,
      (externalPopupRun.y << 16) | (externalPopupRun.x & 0xffff)) === 0 &&
    e.get_help_popup_hwnd() !== 0 && e.get_help_session_mode() === 2 &&
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
      externalTargetPath && e.get_help_document_snapshot_count() === 1);
  check('closing an external popup restores the exact source view and document',
    e.test_help_popup_message(0x0010, 0, 0) === 0 &&
    e.get_help_popup_hwnd() === 0 &&
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
      externalPopupSourcePath && e.get_help_document_snapshot_count() === 0 &&
    e.get_help_session_topic_ref() === 0 && e.get_help_session_mode() === 1 &&
    e.get_help_view_topic_ptr() === externalPopupMainView &&
    e.get_help_view_run_ptr() === externalPopupMainRuns);

  const chainPaths = Array.from({ length: 6 }, (_, index) =>
    `c:\\chain\\chain${index}.hlp`);
  chainPaths.forEach((chainPath, index) => {
    const nextName = `chain${Math.min(index + 1, 5)}.hlp`;
    const chainHelp = buildRuntimeHotspotHelp(
      buildExternalHotspot(0xeb, 4, -10, { file: nextName }));
    ctx.vfs.files.set(chainPath, { data: new Uint8Array(chainHelp.file), attrs: 0x20 });
  });
  let chainOk = e.test_invoke_WinHelpA(
    0x8888, allocGuestAnsi(chainPaths[0]), 0x0001, 8) === 1;
  for (let depth = 0; depth < 4 && chainOk; depth++) {
    const run = firstVisibleHotspotRun();
    chainOk = !!run && e.test_help_window_message(0x0201, 0,
      (run.y << 16) | (run.x & 0xffff)) === 0 &&
      readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
        chainPaths[depth + 1] &&
      e.get_help_document_snapshot_count() === depth + 1;
  }
  check('external navigation retains a bounded four-document Back chain', chainOk);
  const cappedRun = chainOk ? firstVisibleHotspotRun() : null;
  const cappedDoc = e.get_help_file_ptr();
  const cappedView = e.get_help_view_topic_ptr();
  check('a fifth external suspension fails without disturbing the visible document',
    cappedRun && e.test_help_activate_hotspot_at(0x8888, cappedRun.x, cappedRun.y) === 0 &&
    e.get_help_dispatch_status() === 7 && e.get_help_document_snapshot_count() === 4 &&
    e.get_help_file_ptr() === cappedDoc && e.get_help_view_topic_ptr() === cappedView &&
    readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) === chainPaths[4]);
  let unwindOk = true;
  for (let depth = 3; depth >= 0; depth--) {
    e.test_help_view_go_back();
    unwindOk = unwindOk &&
      readLatin1(e.get_help_document_path_ptr(), e.get_help_document_path_len()) ===
        chainPaths[depth] && e.get_help_document_snapshot_count() === depth;
  }
  check('cross-document Back unwinds every suspended path in LIFO order', unwindOk);
  check('HELP_QUIT releases the active document and all suspended external roots',
    e.test_invoke_WinHelpA(0x8888, 0, 0x0002, 0) === 1 &&
    e.get_help_window() === 0 && e.get_help_file_ptr() === 0 &&
    e.get_help_document_snapshot_count() === 0);

  check('WinHelpA handler opens a window from WAT-owned title/topic state',
    e.test_invoke_WinHelpA(0x8888, mountedPathA, 0x0003, 0) === 1 &&
    e.get_help_window() !== 0 && e.get_help_view_topic_ptr() !== 0 &&
    e.get_help_view_topic_len() === EXPECTED_SEMANTICS['freecell.hlp'].rawTopicLengths[0] &&
    readLatin1(e.get_help_view_title_ptr(), e.get_help_view_title_len()) === 'Free Cell' &&
    e.get_help_view_run_count() > 0 && e.get_help_view_run_ptr() !== 0 &&
    e.get_help_view_extent_height() >= 16);
  check('WinHelpW handler reuses the same visible dispatcher/window path',
    e.test_invoke_WinHelpW(0x8888, 0, 0x0003, 0) === 1 &&
    e.get_help_window() !== 0 && e.get_help_session_owner() === 0x8888 &&
    e.get_help_view_topic_len() === EXPECTED_SEMANTICS['freecell.hlp'].rawTopicLengths[0]);
  check('actual WinHelp handler returns FALSE for unsupported commands',
    e.test_invoke_WinHelpA(0x8888, 0, 0x7777, 0) === 0 &&
    e.get_help_window() !== 0 && e.get_help_dispatch_status() === 6);
  const keywordPathA = allocGuestAnsi('c:\\keyword.hlp');
  const betaA = allocGuestAnsi('Beta');
  const alphaA = allocGuestAnsi('Alpha');
  check('visible keyword navigation starts fresh after document replacement',
    e.test_invoke_WinHelpA(0x8888, keywordPathA, 0x0101, betaA) === 1 &&
    e.get_help_session_topic_ref() === 10 && e.get_help_view_topic_index() === 1 &&
    e.get_help_view_back_count() === 0);
  check('visible WAT navigation records canonical Back history',
    e.test_invoke_WinHelpA(0x8888, 0, 0x0101, alphaA) === 1 &&
    e.get_help_session_topic_ref() === 0 && e.get_help_view_back_count() === 1);
  e.test_help_view_go_back();
  check('Back restores a WAT-owned canonical topic without a host callback',
    e.get_help_session_topic_ref() === 10 && e.get_help_view_topic_index() === 1 &&
    e.get_help_view_back_count() === 0);
  check('a different document clears stale Back history before presentation',
    e.test_invoke_WinHelpA(0x8888, mountedPathA, 0x0003, 0) === 1 &&
    e.get_help_session_topic_ref() === 0 && e.get_help_view_back_count() === 0);
  const missingPathA = allocGuestAnsi('c:\\not-mounted.hlp');
  check('failed replacement closes the old window instead of showing stale text',
    e.test_invoke_WinHelpA(0x8888, missingPathA, 0x0003, 0) === 0 &&
    e.get_help_window() === 0 && e.get_help_view_topic_ptr() === 0 &&
    e.get_help_file_ptr() === 0 && e.get_help_dispatch_status() === 7);
  check('actual HELP_QUIT remains idempotent after a failed replacement',
    e.test_invoke_WinHelpW(0x8888, 0, 0x0002, 0) === 1 &&
    e.get_help_window() === 0 && e.get_help_view_topic_ptr() === 0 &&
    e.get_help_view_title_ptr() === 0 && e.get_help_view_run_ptr() === 0 &&
    e.get_help_view_run_count() === 0 && e.get_help_file_ptr() === 0);

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
  // Dangling context entries are dropped rather than fatal - real WinHelp
  // fails only that jump. The entry disappears; the document still loads.
  check('a hashed context naming no topic is dropped, not fatal',
    load(badContextRef) === 1 && e.get_help_context_dropped() === 1 &&
    e.get_help_topic_count() === 4);

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
  check('a numeric context naming no topic is dropped, not fatal',
    load(badMapRef) === 1 && e.get_help_context_dropped() === 1 &&
    e.test_help_resolve_context_id(999) === -1);

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

  const badPhraseMagic = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  const freecellPhraseIndex = fixtureInternalOffset('freecell.hlp', '|PhrIndex') + 9;
  badPhraseMagic.writeUInt32LE(0, freecellPhraseIndex);
  check('bad Hall phrase-index magic fails',
    load(badPhraseMagic) === 0 && e.get_help_last_error() === 12);

  const phraseCapacity = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  phraseCapacity.writeUInt32LE(65537, freecellPhraseIndex + 4);
  check('phrase count cap is enforced',
    load(phraseCapacity) === 0 && e.get_help_last_error() === 6);

  const badPhraseIndexSize = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  badPhraseIndexSize.writeUInt32LE(15, freecellPhraseIndex + 8);
  check('phrase bitstream size must match its internal slice',
    load(badPhraseIndexSize) === 0 && e.get_help_last_error() === 12);

  const badPhraseTotal = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  badPhraseTotal.writeUInt32LE(67, freecellPhraseIndex + 12);
  check('phrase offsets must end at decompressed image size',
    load(badPhraseTotal) === 0 && e.get_help_last_error() === 12);

  const missingPhraseImage = Buffer.from(fs.readFileSync(path.join(HELP, 'freecell.hlp')));
  const phraseImageName = missingPhraseImage.indexOf(Buffer.from('|PhrImage\0', 'latin1'));
  missingPhraseImage[phraseImageName + 8] = 'f'.charCodeAt(0);
  check('half of a Hall phrase pair is a missing-internal error',
    load(missingPhraseImage) === 0 && e.get_help_last_error() === 8);

  const badPhraseLz = Buffer.from(fs.readFileSync(path.join(HELP, 'calc.hlp')));
  const calcPhraseImage = fixtureInternalOffset('calc.hlp', '|PhrImage') + 9;
  badPhraseLz[calcPhraseImage] = 1;
  badPhraseLz.writeUInt16LE(0x0fff, calcPhraseImage + 1);
  check('invalid LZ77 back-reference fails before publication',
    load(badPhraseLz) === 0 && e.get_help_last_error() === 12 &&
    e.get_help_phrase_count() === 0);

  const badOldMarker = buildSyntheticSemanticHelp({
    oldPhrases: buildOldPhrases(['old', 'phrase']),
  });
  badOldMarker.file.writeUInt16LE(0,
    badOldMarker.offsets['|Phrases'] + 9 + 2);
  check('old-style phrase marker is validated',
    load(badOldMarker.file) === 0 && e.get_help_last_error() === 12 &&
    e.get_help_phrase_count() === 0);

  const badOldFirstOffset = buildSyntheticSemanticHelp({
    oldPhrases: buildOldPhrases(['old', 'phrase']),
  });
  badOldFirstOffset.file.writeUInt16LE(7,
    badOldFirstOffset.offsets['|Phrases'] + 9 + 8);
  check('old-style first offset must equal its table size',
    load(badOldFirstOffset.file) === 0 && e.get_help_last_error() === 12);

  const descendingOldOffsets = buildSyntheticSemanticHelp({
    oldPhrases: buildOldPhrases(['old', 'phrase']),
  });
  descendingOldOffsets.file.writeUInt16LE(5,
    descendingOldOffsets.offsets['|Phrases'] + 9 + 8 + 2);
  check('old-style phrase offsets must be monotonic',
    load(descendingOldOffsets.file) === 0 && e.get_help_last_error() === 12);

  const badOldTotal = buildSyntheticSemanticHelp({
    oldPhrases: buildOldPhrases(['old', 'phrase']),
  });
  badOldTotal.file.writeUInt32LE(10,
    badOldTotal.offsets['|Phrases'] + 9 + 4);
  check('old-style final offset must equal decompressed size',
    load(badOldTotal.file) === 0 && e.get_help_last_error() === 12);

  const badOldLz = buildSyntheticSemanticHelp({
    oldPhrases: buildOldPhrases(['old', 'phrase']),
  });
  const badOldLzData = badOldLz.offsets['|Phrases'] + 9 + 8 + 6;
  badOldLz.file[badOldLzData] = 1;
  badOldLz.file.writeUInt16LE(0x0fff, badOldLzData + 1);
  check('invalid old-style phrase LZ77 fails before publication',
    load(badOldLz.file) === 0 && e.get_help_last_error() === 12 &&
    e.get_help_phrase_count() === 0);

  const oldPhraseCapacity = buildSyntheticSemanticHelp({
    oldPhrases: buildOldPhrases(['old']),
  });
  oldPhraseCapacity.file.writeUInt16LE(32767,
    oldPhraseCapacity.offsets['|Phrases'] + 9);
  check('old-style representable phrase count is bounded',
    load(oldPhraseCapacity.file) === 0 && e.get_help_last_error() === 6);

  const truncatedMvbPhrases = buildSyntheticSemanticHelp({
    oldPhrases: Buffer.from([0x00, 0x08, 0x01, 0x00]),
  });
  check('truncated MVB old-style phrase header fails',
    load(truncatedMvbPhrases.file) === 0 && e.get_help_last_error() === 12);

  const unknownFormatCommand = buildSyntheticSemanticHelp({
    topic: buildSyntheticOldTopic(),
    oldPhrases: buildOldPhrases(['hello', 'world', '!']),
  });
  writeSyntheticTopicRaw(unknownFormatCommand, 49 + 21 + 9, 0x90, 1);
  check('unknown LinkData1 commands fail without partial publication',
    load(unknownFormatCommand.file) === 0 && e.get_help_last_error() === 14 &&
    e.get_help_topic_count() === 0 && e.get_help_display_record_count() === 0 &&
    e.get_help_paragraph_count() === 0 && e.get_help_format_command_count() === 0);

  const truncatedFormatHeader = buildSyntheticSemanticHelp({
    topic: buildSyntheticOldTopic(),
    oldPhrases: buildOldPhrases(['hello', 'world', '!']),
  });
  writeSyntheticTopicRaw(truncatedFormatHeader, 49 + 16, 30);
  check('truncated LinkData1 paragraph header fails before publication',
    load(truncatedFormatHeader.file) === 0 && e.get_help_last_error() === 14 &&
    e.get_help_topic_count() === 0);

  const truncatedTabInfo = buildSyntheticSemanticHelp({
    topic: buildSyntheticOldTopic(),
    oldPhrases: buildOldPhrases(['hello', 'world', '!']),
  });
  writeSyntheticTopicRaw(truncatedTabInfo, 49 + 21 + 7, 0x0200, 2);
  check('truncated LinkData1 tab metadata fails before publication',
    load(truncatedTabInfo.file) === 0 && e.get_help_last_error() === 14);

  const truncatedPictureCommand = buildSyntheticSemanticHelp({
    topic: buildSyntheticOldTopic(),
    oldPhrases: buildOldPhrases(['hello', 'world', '!']),
  });
  writeSyntheticTopicRaw(truncatedPictureCommand, 49 + 21 + 9, 0x86, 1);
  check('truncated LinkData1 picture payload fails before publication',
    load(truncatedPictureCommand.file) === 0 && e.get_help_last_error() === 14);

  const shortTopicBlock = buildSyntheticSemanticHelp();
  shortTopicBlock.file.writeUInt32LE(11, shortTopicBlock.offsets['|TOPIC'] + 4);
  check('truncated TOPIC physical block fails before publication',
    load(shortTopicBlock.file) === 0 && e.get_help_last_error() === 13 &&
    e.get_help_topic_count() === 0);

  const badTopicLz = buildSyntheticSemanticHelp();
  const badTopicCompressed = badTopicLz.offsets['|TOPIC'] + 9 + 12;
  badTopicLz.file[badTopicCompressed] = 1;
  badTopicLz.file.writeUInt16LE(0x0fff, badTopicCompressed + 1);
  check('invalid TOPIC LZ77 back-reference fails before publication',
    load(badTopicLz.file) === 0 && e.get_help_last_error() === 13 &&
    e.get_help_topic_count() === 0);

  const truncatedTopicLz = buildSyntheticSemanticHelp();
  const truncatedTopicCompressed = truncatedTopicLz.offsets['|TOPIC'] + 9 + 12;
  truncatedTopicLz.file.writeUInt32LE(14, truncatedTopicLz.offsets['|TOPIC'] + 4);
  truncatedTopicLz.file[truncatedTopicCompressed] = 1;
  check('truncated TOPIC LZ77 back-reference fails before publication',
    load(truncatedTopicLz.file) === 0 && e.get_help_last_error() === 13 &&
    e.get_help_topic_count() === 0);

  const badTopicPrev = buildSyntheticSemanticHelp();
  writeSyntheticTopicRaw(badTopicPrev, 49 + 8, -1);
  check('TOPIC link previous pointer must match the chain',
    load(badTopicPrev.file) === 0 && e.get_help_last_error() === 13);

  const cyclicTopicLinks = buildSyntheticSemanticHelp();
  writeSyntheticTopicRaw(cyclicTopicLinks, 12, 12);
  check('cyclic TOPIC links fail before publication',
    load(cyclicTopicLinks.file) === 0 && e.get_help_last_error() === 13 &&
    e.get_help_topic_count() === 0);

  const topicLinkOutsideBlock = buildSyntheticSemanticHelp();
  writeSyntheticTopicRaw(topicLinkOutsideBlock, 12, 16000);
  check('TOPIC links cannot point beyond a decompressed block',
    load(topicLinkOutsideBlock.file) === 0 && e.get_help_last_error() === 13 &&
    e.get_help_topic_count() === 0);

  const unknownTopicRecord = buildSyntheticSemanticHelp();
  writeSyntheticTopicRaw(unknownTopicRecord, 20, 0x99, 1);
  check('unknown TOPIC record types fail explicitly',
    load(unknownTopicRecord.file) === 0 && e.get_help_last_error() === 13);

  const missingTopicHeaders = buildSyntheticSemanticHelp();
  writeSyntheticTopicRaw(missingTopicHeaders, 12, -1);
  check('TOPIC header count must match canonical titles',
    load(missingTopicHeaders.file) === 0 && e.get_help_last_error() === 13 &&
    e.get_help_topic_count() === 0);

  e.test_help_reset();
  check('reset releases parser state',
    e.get_help_file_ptr() === 0 && e.get_help_directory_count() === 0 &&
    e.get_help_topic_count() === 0 && e.get_help_context_count() === 0 &&
    e.get_help_map_count() === 0 && e.get_help_phrase_count() === 0 &&
    e.get_help_font_face_count() === 0 && e.get_help_font_count() === 0 &&
    e.get_help_bitmap_count() === 0 && e.get_help_keyword_count() === 0 &&
    e.get_help_keyword_posting_count() === 0 &&
    e.get_help_cnt_node_count() === 0 && e.get_help_cnt_node(0) === 0 &&
    e.get_help_cnt_title_ptr() === 0 && e.get_help_cnt_base_ptr() === 0 &&
    e.get_help_display_record_count() === 0 && e.get_help_paragraph_count() === 0 &&
    e.get_help_table_count() === 0 && e.get_help_format_command_count() === 0 &&
    e.get_help_last_error() === 0);

  console.log(`--- winhelp-wat-parser: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
