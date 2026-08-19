#!/usr/bin/env node
// Trace SkiFree assertion: watches field [esi+0x4a] and surrounding sprite state
// at key code points to find where the invariant breaks.

const fs = require('fs');
const { parseResources } = require('../lib/resources');
const { createHostImports } = require('../lib/host-imports');

const EXE_PATH = 'test/binaries/entertainment-pack/ski32.exe';
const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync(EXE_PATH);
  const resourceJson = parseResources(exeBytes);

  let stopped = false;
  const base = createHostImports({
    getMemory: () => instance.exports.memory.buffer,
    renderer: null,
    resourceJson,
    onExit: () => { stopped = true; },
  });
  const h = base.host;

  // Suppress MessageBox (assertions) — just log and continue
  let assertCount = 0;
  h.message_box = (hw, t, c, u) => {
    const text = base.readStr(t);
    const caption = base.readStr(c);
    assertCount++;
    if (assertCount <= 5) console.log(`[ASSERT #${assertCount}] ${caption}: ${text}`);
    return 1;
  };
  h.exit = () => { stopped = true; };

  // Match test runner: check_input_hwnd returns child window handle
  h.check_input_hwnd = () => 0x10002;

  // Match test runner: log override (counts API calls)
  let apiCount = 0;
  h.log = (ptr, len) => { apiCount++; };
  h.log_i32 = () => {};

  // Trace BitBlt calls
  let bltCount = 0;
  h.gdi_bitblt = (dstDC, dx, dy, w, bh, srcDC, sx, sy, rop, hwnd) => {
    bltCount++;
    if (bltCount <= 30) {
      const isSrc = srcDC === 0x50001, isDst = dstDC === 0x50001;
      const mode = (isSrc ? 'Win' : 'Mem') + '→' + (isDst ? 'Win' : 'Mem');
      console.log(`[BitBlt #${bltCount}] ${mode} dst=0x${dstDC.toString(16)} src=0x${srcDC.toString(16)} (${dx},${dy} ${w}x${bh}) from(${sx},${sy}) rop=0x${(rop>>>0).toString(16)}`);
    }
    return 1;
  };

  const imports = { host: h };
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = new Uint8Array(instance.exports.memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  instance.exports.load_pe(exeBytes.length);

  const e = instance.exports;
  const imageBase = e.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;
  const dv = new DataView(instance.exports.memory.buffer);
  const r32 = addr => dv.getUint32(g2w(addr), true);
  const r16 = addr => dv.getInt16(g2w(addr), true);

  // Run until first assert, then dump sprite state
  const ASSERT_ADDR = 0x4039f0; // mov edx, 0x7EC (line 2028 assert)

  // Set breakpoint on the assert site
  // We'll use watchpoint on EIP instead — check after each batch
  let hitAssert = false;

  for (let batch = 0; batch < 50000 && !stopped; batch++) {
    try {
      e.run(10000);
    } catch (err) {
      console.log(`CRASH at batch ${batch}: ${err.message}`);
      break;
    }

    if (assertCount > 0 && !hitAssert) {
      hitAssert = true;
      console.log(`\nFirst assert at batch ${batch}`);
      console.log(`EIP=${hex(e.get_eip())} ESI=${hex(e.get_esi())}`);

      // Dump the sprite that ESI pointed to when the assert fired
      // ESI should still be near the sprite struct
      const esi = e.get_esi();
      if (esi > imageBase && esi < imageBase + 0x200000) {
        console.log('\n--- Sprite at ESI ---');
        for (let off = 0; off < 0x60; off += 4) {
          const val = r32(esi + off);
          const label = {
            0x00: 'next', 0x04: 'child', 0x08: 'parent', 0x0c: 'data',
            0x10: 'alloc', 0x14: 'bitmap_info', 0x18: 'field_18',
            0x20: 'rect.left', 0x24: 'rect.top', 0x28: 'rect.right', 0x2c: 'rect.bottom',
            0x40: 'field_40', 0x44: 'field_44', 0x48: 'field_48(w)', 0x4c: 'flags',
          }[off] || `+${hex(off)}`;
          let extra = '';
          if (off === 0x44 || off === 0x48) {
            // These are word fields — show as two 16-bit values
            const lo = r16(esi + off);
            const hi = r16(esi + off + 2);
            extra = ` (words: ${lo}, ${hi})`;
          }
          console.log(`  [+0x${off.toString(16).padStart(2,'0')}] ${label}: ${hex(val)}${extra}`);
        }

        // Walk sprite list from global [0x40c618]
        console.log('\n--- Sprite List from [0x40c618] ---');
        let sprPtr = r32(0x40c618);
        let idx = 0;
        while (sprPtr && sprPtr !== 0xFFFFFFFF && idx < 20) {
          const left = r32(sprPtr + 0x20);
          const top = r32(sprPtr + 0x24);
          const right = r32(sprPtr + 0x28);
          const bottom = r32(sprPtr + 0x2c);
          const f48 = r16(sprPtr + 0x48);
          const f4a = r16(sprPtr + 0x4a);
          const f44 = r16(sprPtr + 0x44);
          const f46 = r16(sprPtr + 0x46);
          const flags = r32(sprPtr + 0x4c);
          const parent = r32(sprPtr + 0x08);
          console.log(`  [${idx}] ${hex(sprPtr)}: rect=[${left},${top},${right},${bottom}] ` +
            `f44=${f44} f46=${f46} f48=${f48} f4a=${f4a} flags=${hex(flags)} parent=${hex(parent)}`);
          sprPtr = r32(sprPtr);
          idx++;
        }
      }

      // Also dump the game state globals
      console.log('\n--- Game Globals ---');
      console.log(`  game_active [0x40c67c]: ${r32(0x40c67c)}`);
      console.log(`  tick [0x40c698]: ${r32(0x40c698)}`);
      console.log(`  delta [0x40c5f4]: ${r32(0x40c5f4)}`);
      console.log(`  viewport [0x40c6b0]: left=${r32(0x40c6b0)} top=${r32(0x40c6b4)} right=${r32(0x40c6b8)} bottom=${r32(0x40c6bc)}`);
      break;
    }
  }

  if (!hitAssert && !stopped) {
    console.log('No assertion after 50000 batches');
    console.log(`game_active [0x40c67c]: ${r32(0x40c67c)}`);
    console.log(`tick [0x40c698]: ${r32(0x40c698)}`);
    console.log(`EIP=${hex(e.get_eip())}`);
  }

  console.log(`\nTotal asserts: ${assertCount}`);
}

main().catch(e => console.error(e));
