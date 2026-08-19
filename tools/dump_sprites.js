#!/usr/bin/env node
// Dump SkiFree sprite positions from WASM memory
const fs = require('fs');

const GUEST_BASE = 0x12000;
const IMAGE_BASE = 0x400000;

function dumpSprites(buf) {
  const mem = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  function g2w(ga) { return ga - IMAGE_BASE + GUEST_BASE; }
  function rd32(ga) { return mem.getUint32(g2w(ga), true); }
  function rd16s(ga) { return mem.getInt16(g2w(ga), true); }
  function rd8(ga) { return mem.getUint8(g2w(ga)); }

  const head = rd32(0x40c618);
  console.log(`sprite_list head: 0x${head.toString(16)}`);
  console.log(`client_rect: {${rd32(0x40c6b0)}, ${rd32(0x40c6b4)}, ${rd32(0x40c6b8)}, ${rd32(0x40c6bc)}}`);

  const sprites = [];
  let ptr = head;
  let safety = 0;

  while (ptr && ptr >= 0x410000 && ptr <= 0x700000 && safety < 300) {
    const flags = rd8(ptr + 0x4c);
    const subPtr = rd32(ptr + 0x14);

    let wx = 0, wy = 0, wx2 = 0, wy2 = 0;
    let stripDC = 0, srcYInStrip = 0, expW = 0, expH = 0;

    if (flags & 0x04) {
      wx = rd16s(ptr + 0x20);
      wy = rd16s(ptr + 0x24);
      wx2 = mem.getInt32(g2w(ptr + 0x28), true);
      wy2 = mem.getInt32(g2w(ptr + 0x2c), true);
    }

    if (subPtr >= 0x400000 && subPtr < 0x600000) {
      stripDC = rd32(subPtr + 0x00);
      srcYInStrip = rd16s(subPtr + 0x08);
      expW = rd16s(subPtr + 0x0a);
      expH = rd16s(subPtr + 0x0c);
    }

    const ySortKey = rd16s(ptr + 0x42);

    sprites.push({
      addr: ptr, wx, wy, w: wx2 - wx, h: wy2 - wy,
      stripDC, srcYInStrip, expW, expH, flags, ySortKey,
    });

    ptr = rd32(ptr + 0x00);
    safety++;
  }

  console.log(`\nFound ${sprites.length} sprites:\n`);
  console.log('  #  | addr       | world (x, y)     | size    | stripDC  | srcY | expWxH  | flags | ySort');
  console.log('-----|------------|------------------|---------|----------|------|---------|-------|------');
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i];
    const vis = (s.flags & 0x02) ? 'V' : '.';
    const pre = (s.flags & 0x04) ? 'P' : '.';
    console.log(`${String(i).padStart(4)} | 0x${s.addr.toString(16)} | ${String(s.wx).padStart(6)}, ${String(s.wy).padStart(6)} | ${String(s.w).padStart(3)}x${String(s.h).padStart(3)} | 0x${s.stripDC.toString(16).padStart(5,'0')} | ${String(s.srcYInStrip).padStart(4)} | ${String(s.expW).padStart(3)}x${String(s.expH).padStart(3)} | ${vis}${pre} ${s.flags.toString(16).padStart(2,'0')} | ${s.ySortKey}`);
  }

  const json = sprites.map(s => ({
    x: s.wx, y: s.wy, w: s.w, h: s.h,
    stripDC: s.stripDC, srcYInStrip: s.srcYInStrip,
    expW: s.expW, expH: s.expH,
    flags: s.flags, ySortKey: s.ySortKey,
  }));
  fs.writeFileSync('scratch/ski_sprites.json', JSON.stringify(json, null, 2));
  console.log('\nWrote scratch/ski_sprites.json');
}

module.exports = { dumpSprites };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node tools/dump_sprites.js <memory.bin>'); process.exit(1); }
  dumpSprites(fs.readFileSync(file));
}
