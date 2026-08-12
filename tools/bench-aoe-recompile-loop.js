#!/usr/bin/env node
// Compare AoE's cached generic threaded blitter loop with the hand-compiled
// WAT allowlist. The synthetic path is a four-block cycle:
//
//   0x535c20 -> 0x535e00 -> 0x535e08 -> 0x535e7c -> 0x535c20
//
// Setup and first decode are outside the timed region. All three variants
// execute the same guest bytes/state, and every measured trial checks state.

const assert = require('assert');
const { performance } = require('perf_hooks');
const { bootRenderHarness } = require('../test/render-helper');

const DISPATCH = 0x00535c20;
const RUN_LENGTH = 0x00535e00;
const CLIP_TEST = 0x00535e08;
const CLIPPED_ADVANCE = 0x00535e7c;
const SOURCE = 0x00200000;
const SPAN = 0x00300000;
const START_EDI = 0x00340001;
const COMMAND = 0x1b; // low nibble selects RUN_LENGTH; high nibble is length 1
const BLOCKS_PER_CYCLE = 4;

const BLOCKS = Math.max(BLOCKS_PER_CYCLE,
  parseInt(process.env.BLOCKS || '2000000', 10) || 2000000);
const WARMUP_BLOCKS = Math.max(BLOCKS_PER_CYCLE,
  parseInt(process.env.WARMUP_BLOCKS || '2000000', 10) || 2000000);
const TRIALS = Math.max(1, parseInt(process.env.TRIALS || '5', 10) || 5);

const blockBytes = new Map([
  [DISPATCH, [
    0x89, 0x35, 0x50, 0x50, 0x77, 0x00, 0x33, 0xc0,
    0x89, 0x3d, 0x54, 0x50, 0x77, 0x00, 0x8a, 0x06,
    0x2b, 0x3d, 0x20, 0x50, 0x77, 0x00, 0x8b, 0xc8,
    0x46, 0x83, 0xe0, 0x0f, 0x8b, 0x1d, 0x3c, 0x50,
    0x77, 0x00, 0xff, 0x24, 0x85, 0x00, 0x44, 0x53, 0x00,
  ]],
  [RUN_LENGTH, [0xc1, 0xe9, 0x04, 0x75, 0x03, 0x8a, 0x0e, 0x46]],
  [CLIP_TEST, [0x8b, 0xd7, 0x03, 0xd1, 0x4a, 0x3b, 0x53, 0x08, 0x7c, 0x6a]],
  [CLIPPED_ADVANCE, [
    0x8b, 0x3d, 0x54, 0x50, 0x77, 0x00, 0x46, 0x03,
    0xf9, 0xe9, 0x96, 0xfd, 0xff, 0xff,
  ]],
]);

const u32 = value => value >>> 0;
const roundDownCycle = value => Math.floor(value / BLOCKS_PER_CYCLE) * BLOCKS_PER_CYCLE;
const measuredBlocks = roundDownCycle(BLOCKS);
const warmupBlocks = roundDownCycle(WARMUP_BLOCKS);
const measuredCycles = measuredBlocks / BLOCKS_PER_CYCLE;
const requiredSourceBytes = Math.max(measuredBlocks, warmupBlocks) / 2 + 64;

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness();
  const mem = new Uint8Array(memory.buffer);
  const guestBase = u32(e.get_guest_base());
  const imageBase = u32(e.get_image_base());
  const wa = ga => (u32(ga) - imageBase + guestBase) >>> 0;

  for (const [address, bytes] of blockBytes) mem.set(bytes, wa(address));
  mem.fill(COMMAND, wa(SOURCE), wa(SOURCE) + requiredSourceBytes);

  e.guest_write32(0x00775020, 0); // clip base; keep EDI monotonic
  e.guest_write32(0x0077503c, SPAN);
  e.guest_write32(SPAN + 8, 0x7fffffff); // always take clipped-run path
  e.guest_write32(0x00534400 + 0x0b * 4, RUN_LENGTH);

  function seed() {
    e.set_eip(DISPATCH);
    e.set_eax(0x11223344);
    e.set_ecx(0x55667788);
    e.set_edx(0x10203040);
    e.set_ebx(SPAN);
    e.set_ebp(0x00440000);
    e.set_esp(0x00450000);
    e.set_esi(SOURCE);
    e.set_edi(START_EDI);
    e.guest_write32(0x00775050, 0);
    e.guest_write32(0x00775054, 0);
  }

  function snapshot() {
    return {
      eip: u32(e.get_eip()),
      eax: u32(e.get_eax()),
      ecx: u32(e.get_ecx()),
      edx: u32(e.get_edx()),
      ebx: u32(e.get_ebx()),
      ebp: u32(e.get_ebp()),
      esp: u32(e.get_esp()),
      esi: u32(e.get_esi()),
      edi: u32(e.get_edi()),
      flagOp: u32(e.get_flag_op()),
      flagA: u32(e.get_flag_a()),
      flagB: u32(e.get_flag_b()),
      flagRes: u32(e.get_flag_res()),
      flagShift: u32(e.get_flag_sign_shift()),
      savedEsi: u32(e.guest_read32(0x00775050)),
      savedEdi: u32(e.guest_read32(0x00775054)),
    };
  }

  function expectedState() {
    return {
      eip: DISPATCH,
      esi: SOURCE + measuredCycles * 2,
      edi: START_EDI + measuredCycles,
    };
  }

  function configureAndWarm(variant) {
    e.set_aoe_recompile_count_enabled(1);
    e.set_aoe_recompile_enabled(0);
    e.set_aoe_wat_threaded_enabled(0);
    if (variant === 'wat-threaded') e.set_aoe_wat_threaded_enabled(1);
    if (variant === 'wat-optimized') e.set_aoe_recompile_enabled(1);
    seed();
    e.reset_aoe_recompile_counters();
    e.run(warmupBlocks);
    if (variant !== 'x86-threaded') {
      assert.strictEqual(u32(e.get_aoe_recompile_entries()), warmupBlocks,
        `warmup must reach the ${variant} backend`);
    }
  }

  function measure(variant) {
    configureAndWarm(variant);
    seed();
    e.reset_aoe_recompile_counters();
    e.set_aoe_recompile_count_enabled(0);
    const start = performance.now();
    e.run(measuredBlocks);
    const elapsedMs = performance.now() - start;
    const state = snapshot();
    const expected = expectedState();
    assert.strictEqual(state.eip, expected.eip, 'loop must end at dispatch block');
    assert.strictEqual(state.esi, expected.esi, 'loop must consume two source bytes per cycle');
    assert.strictEqual(state.edi, expected.edi, 'loop must advance one pixel per cycle');
    return { elapsedMs, state };
  }

  const variants = ['x86-threaded', 'wat-threaded', 'wat-optimized'];
  const samples = Object.fromEntries(variants.map(name => [name, []]));
  let referenceState = null;
  for (let trial = 0; trial < TRIALS; trial++) {
    // Rotate the first variant to reduce ordering/thermal bias.
    const order = variants.slice(trial % variants.length).concat(variants.slice(0, trial % variants.length));
    for (const variant of order) {
      const result = measure(variant);
      samples[variant].push(result.elapsedMs);
      if (referenceState == null) referenceState = result.state;
      else assert.deepStrictEqual(result.state, referenceState,
        `${variant} final state differs from x86-threaded execution`);
    }
  }

  console.log(`AoE four-block blitter loop: ${measuredBlocks} blocks, ${measuredCycles} cycles, ${TRIALS} trials`);
  for (const variant of variants) {
    console.log(`${variant} ms: ${samples[variant].map(v => v.toFixed(2)).join(', ')}`);
  }
  console.log('');
  console.log('variant         mean ms  median ms  blocks/ms  vs x86 median');
  const baseMedian = median(samples['x86-threaded']);
  for (const variant of variants) {
    const sampleMean = mean(samples[variant]);
    const sampleMedian = median(samples[variant]);
    const speedup = baseMedian / sampleMedian;
    console.log(
      variant.padEnd(15) +
      sampleMean.toFixed(2).padStart(8) + '  ' +
      sampleMedian.toFixed(2).padStart(9) + '  ' +
      (measuredBlocks / sampleMedian).toFixed(1).padStart(9) + '  ' +
      speedup.toFixed(3).padStart(8) + 'x'
    );
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
