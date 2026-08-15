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

function buildSyntheticBitmap({
  packing = 0,
  payload = Buffer.from([0,0,0,0,1,0,1,0]),
} = {}) {
  const pictureParts = [
    Buffer.from([6, packing]),
    encodeCompressedUnsignedLong(96), encodeCompressedUnsignedLong(96),
    Buffer.from([2, 16]),
    encodeCompressedUnsignedLong(2), encodeCompressedUnsignedLong(2),
    encodeCompressedUnsignedLong(2), encodeCompressedUnsignedLong(1),
    encodeCompressedUnsignedLong(payload.length), encodeCompressedUnsignedLong(0),
  ];
  const pictureHeader = Buffer.concat(pictureParts);
  const palette = Buffer.from([0,0,0,0, 0xff,0xff,0xff,0]);
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

function buildSyntheticFormattedTopic({ stringCount = 12, returnParts = false } = {}) {
  const commands = Buffer.concat([
    Buffer.from([0x80, 2, 0, 0x81, 0x82, 0x83]),
    Buffer.from([0x86, 3]), encodeCompressedLong(4), Buffer.from([0, 0, 7, 0]),
    Buffer.from([0xe2, 0x78, 0x56, 0x34, 0x12, 0x89]),
    Buffer.from([0xc8, 2, 0, 'X'.charCodeAt(0), 0]),
    Buffer.from([0xea, 6, 0, 0, 1, 2, 3, 4, 5]),
    Buffer.from([0x8b, 0x8c, 0xff]),
  ]);
  const strings = Buffer.concat(Array.from({ length: stringCount }, (_, index) =>
    Buffer.from([65 + index, 0])));
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
  return returnParts ? { topic, displayFormat, strings } : topic;
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
  systemMinor = 33, topic = null, oldPhrases = null, font = null, extraFiles = [],
} = {}) {
  const title = Buffer.from('Synthetic Help\0', 'latin1');
  const system = Buffer.alloc(12 + 4 + title.length + 8);
  system.writeUInt16LE(0x036c, 0);
  system.writeUInt16LE(systemMinor, 2);
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
    e.get_help_table_count() === 0 && e.get_help_format_command_count() === 12);
  check('formatted-command fixture retains one string per command',
    e.test_help_decode_topic_strings(0, topicOutWA, topicOutCapacity,
      topicTokensWA, topicTokenCapacity) === 13 &&
    Array.from({ length: 12 }, (_, index) =>
      dv.getUint32(topicTokensWA + index * 16, true) === 1 &&
      dv.getUint32(topicTokensWA + index * 16 + 8, true) === 1).every(Boolean) &&
    dv.getUint32(topicTokensWA + 12 * 16, true) === 13);
  const formattedTokenKinds = [
    4, 1, 5, 1, 3, 1, 3, 1, 2, 1, 9, 1, 7, 1, 8, 1, 10, 1, 7, 1, 2, 1, 2, 1, 13,
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
      JSON.stringify(Array.from({ length: 12 }, (_, index) => [index * 2, 1])));
  check('formatted variable tokens address their copied command payloads',
    formattedTokenKinds.every((kind, index) => {
      if (![7, 8, 9, 10].includes(kind)) return true;
      const token = topicTokensWA + index * 16;
      const off = dv.getUint32(token + 4, true);
      const len = dv.getUint32(token + 8, true);
      const value = dv.getUint32(token + 12, true);
      return len >= 1 && bytes[topicPayloadWA + off] === value;
    }));
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
