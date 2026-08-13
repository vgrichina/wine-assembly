#!/usr/bin/env node
// Compare AoE's cached generic threaded blitter loop with the hand-compiled
// WAT allowlist. The synthetic path is a four-block cycle:
//
//   0x535c20 -> 0x535e00 -> 0x535e08 -> 0x535e7c -> 0x535c20
//
// Setup and first decode are outside the timed region. All variants
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
const WARM_ONCE = process.env.WARM_ONCE === '1';

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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
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

  function runnerFor(variant) {
    if (variant === 'brtable-generic-global-ip') return e.run_aoe_brtable_generic_global_ip;
    if (variant === 'brtable-generic-local-ip') return e.run_aoe_brtable_generic_local_ip;
    if (variant === 'brtable-direct-generic-alu') return e.run_aoe_brtable_direct_generic_alu;
    if (variant === 'brtable-subset-generic') return e.run_aoe_brtable_subset_generic;
    if (variant === 'brtable-subset-direct') return e.run_aoe_brtable_subset_direct;
    if (variant === 'brtable-cached-generic' || variant === 'brtable-cached-cold' ||
        variant === 'brtable-cached-mixed') {
      return e.run_aoe_brtable_cached_generic;
    }
    if (variant === 'brtable-globals') return e.run_aoe_brtable_globals;
    if (variant === 'brtable-locals') return e.run_aoe_brtable_locals;
    return e.run;
  }

  const rawWordsByHandler = new Map([
    [7, 1], [20, 1], [21, 1], [28, 1], [43, 1], [48, 1], [128, 1],
    [312, 2], [319, 2], [355, 1],
  ]);
  const terminalHandlers = new Set([43, 312, 319, 355]);
  const aluOnlyHandlers = new Map([
    ['48:87', 358], ['53:263425', 359], ['128:1827', 360],
    ['312:0', 361], ['319:0', 362],
  ]);
  const registerOnlyHandlers = new Map([
    ['21:6', 363], ['18:0', 364], ['21:7', 365], ['28:6', 366],
    ['48:87', 367], ['11:16', 368], ['64:6', 369], ['7:0', 370],
    ['20:3', 371], ['53:263425', 372], ['11:39', 373], ['12:33', 374],
    ['65:2', 375], ['128:1827', 376], ['20:7', 377], ['12:113', 378],
  ]);
  const combinedOverrides = new Map([
    ['48:87', 379], ['53:263425', 380], ['128:1827', 381],
    ['312:0', 361], ['319:0', 362],
  ]);
  const originalHandlerBySpecialized = new Map([
    [358, 48], [359, 53], [360, 128], [361, 312], [362, 319],
    [363, 21], [364, 18], [365, 21], [366, 28], [367, 48], [368, 11],
    [369, 64], [370, 7], [371, 20], [372, 53], [373, 11], [374, 12],
    [375, 65], [376, 128], [377, 20], [378, 12], [379, 48], [380, 53], [381, 128],
  ]);

  function promotionMap(variant) {
    if (variant === 'x86-alu-specialized') return aluOnlyHandlers;
    if (variant === 'x86-register-specialized') return registerOnlyHandlers;
    if (variant === 'x86-register-alu-specialized') {
      return new Map([...registerOnlyHandlers, ...combinedOverrides]);
    }
    return null;
  }

  function rewriteCachedHandlers(variant) {
    const promotions = promotionMap(variant);
    const words = new Uint32Array(memory.buffer);
    const cacheBase = 0x07152000;
    for (const guestAddress of blockBytes.keys()) {
      const cacheEntry = cacheBase + (((guestAddress >>> 2) & 0xfff) * 8);
      assert.strictEqual(words[cacheEntry >>> 2] >>> 0, guestAddress,
        `missing decoded cache entry for 0x${guestAddress.toString(16)}`);
      const pointerIndex = (cacheEntry + 4) >>> 2;
      const thread = (words[pointerIndex] & 0xfffffffe) >>> 0;
      words[pointerIndex] = thread;
      let cursor = thread;
      for (let count = 0; count < 64; count++) {
        const encodedHandler = words[cursor >>> 2] >>> 0;
        const handler = originalHandlerBySpecialized.get(encodedHandler) || encodedHandler;
        const operand = words[(cursor + 4) >>> 2] >>> 0;
        const promoted = promotions && promotions.get(`${handler}:${operand}`);
        words[cursor >>> 2] = promoted == null ? handler : promoted;
        cursor += 8 + (rawWordsByHandler.get(handler) || 0) * 4;
        if (terminalHandlers.has(handler)) break;
        assert(count !== 63, `unterminated thread stream for 0x${guestAddress.toString(16)}`);
      }
      if (variant === 'brtable-cached-generic' ||
          (variant === 'brtable-cached-mixed' && guestAddress === DISPATCH)) {
        words[pointerIndex] = (thread | 1) >>> 0;
      }
    }
  }

  function configureAndWarm(variant) {
    e.set_aoe_recompile_count_enabled(1);
    e.set_wat_stack_packet_count_enabled(1);
    e.set_wat_slot_packet_count_enabled(1);
    e.set_aoe_recompile_enabled(0);
    e.set_aoe_wat_threaded_enabled(0);
    e.set_wat_stack_packet_enabled(0);
    e.set_wat_slot_packet_enabled(0);
    e.set_wat_stack_superops_enabled(variant === 'wat-stack-cmp-jcc' ? 1 : 0);
    if (variant === 'wat-threaded') e.set_aoe_wat_threaded_enabled(1);
    if (variant === 'wat-stack' || variant === 'wat-stack-cmp-jcc') {
      e.set_wat_stack_packet_enabled(1);
    }
    if (variant === 'wat-slot-copy' || variant === 'wat-slot-reuse') {
      e.set_wat_slot_packet_allocation_mode(variant === 'wat-slot-reuse' ? 1 : 0);
      e.set_wat_slot_packet_enabled(1);
    }
    if (variant === 'wat-optimized') e.set_aoe_recompile_enabled(1);
    seed();
    e.reset_aoe_recompile_counters();
    if (promotionMap(variant) || variant === 'brtable-cached-generic' ||
        variant === 'brtable-cached-mixed') {
      e.run(BLOCKS_PER_CYCLE);
      seed();
      rewriteCachedHandlers(variant);
      e.reset_aoe_recompile_counters();
    }
    runnerFor(variant)(warmupBlocks);
    if (variant === 'wat-slot-copy' || variant === 'wat-slot-reuse') {
      assert.strictEqual(u32(e.get_wat_slot_packet_entries()), warmupBlocks,
        `warmup must reach the ${variant} backend`);
    } else if (variant === 'wat-stack' || variant === 'wat-stack-cmp-jcc') {
      assert.strictEqual(u32(e.get_wat_stack_packet_entries()), warmupBlocks,
        `warmup must reach the ${variant} backend`);
    } else if (!variant.startsWith('x86-') && !variant.startsWith('brtable-')) {
      assert.strictEqual(u32(e.get_aoe_recompile_entries()), warmupBlocks,
        `warmup must reach the ${variant} backend`);
    }
  }

  function measure(variant, prewarmed = false) {
    if (!prewarmed) configureAndWarm(variant);
    else rewriteCachedHandlers(variant);
    seed();
    e.reset_aoe_recompile_counters();
    e.set_aoe_recompile_count_enabled(0);
    e.set_wat_stack_packet_count_enabled(0);
    e.set_wat_slot_packet_count_enabled(0);
    const start = performance.now();
    runnerFor(variant)(measuredBlocks);
    const elapsedMs = performance.now() - start;
    const state = snapshot();
    const expected = expectedState();
    assert.strictEqual(state.eip, expected.eip, 'loop must end at dispatch block');
    assert.strictEqual(state.esi, expected.esi, 'loop must consume two source bytes per cycle');
    assert.strictEqual(state.edi, expected.edi, 'loop must advance one pixel per cycle');
    return { elapsedMs, state };
  }

  const defaultVariants = [
    'x86-threaded',
    'x86-alu-specialized',
    'x86-register-specialized',
    'x86-register-alu-specialized',
    'brtable-generic-global-ip',
    'brtable-generic-local-ip',
    'brtable-direct-generic-alu',
    'brtable-subset-generic',
    'brtable-subset-direct',
    'brtable-cached-generic',
    'brtable-cached-cold',
    'brtable-cached-mixed',
    'brtable-globals',
    'brtable-locals',
    'wat-threaded',
    'wat-stack',
    'wat-stack-cmp-jcc',
    'wat-slot-copy',
    'wat-slot-reuse',
    'wat-optimized',
  ];
  const variants = (process.env.VARIANTS
    ? process.env.VARIANTS.split(',').map(value => value.trim()).filter(Boolean)
    : defaultVariants);
  for (const variant of variants) {
    assert(defaultVariants.includes(variant), `unknown benchmark variant ${variant}`);
  }
  assert(variants.includes('x86-threaded'), 'VARIANTS must include x86-threaded');
  if (WARM_ONCE) {
    assert(variants.every(name => name.startsWith('x86-') || name.startsWith('brtable-')),
      'WARM_ONCE is valid only for variants sharing the ordinary x86 thread stream');
    configureAndWarm('x86-threaded');
    for (const variant of variants) {
      rewriteCachedHandlers(variant);
      seed();
      runnerFor(variant)(warmupBlocks);
    }
  }
  const samples = Object.fromEntries(variants.map(name => [name, []]));
  let referenceState = null;
  for (let trial = 0; trial < TRIALS; trial++) {
    // Rotate the first variant to reduce ordering/thermal bias.
    const order = variants.slice(trial % variants.length).concat(variants.slice(0, trial % variants.length));
    for (const variant of order) {
      const result = measure(variant, WARM_ONCE);
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
  console.log('variant                     p10 ms   p25 ms  median ms  blocks/ms  vs x86  paired  vs previous');
  const baseMedian = median(samples['x86-threaded']);
  let previousMedian = null;
  for (const variant of variants) {
    const p10 = percentile(samples[variant], 0.10);
    const p25 = percentile(samples[variant], 0.25);
    const sampleMedian = median(samples[variant]);
    const speedup = baseMedian / sampleMedian;
    const pairedSpeedup = median(samples['x86-threaded'].map((value, index) =>
      value / samples[variant][index]));
    const incremental = previousMedian == null ? 1 : previousMedian / sampleMedian;
    console.log(
      variant.padEnd(28) +
      p10.toFixed(2).padStart(7) + '  ' +
      p25.toFixed(2).padStart(7) + '  ' +
      sampleMedian.toFixed(2).padStart(9) + '  ' +
      (measuredBlocks / sampleMedian).toFixed(1).padStart(9) + '  ' +
      speedup.toFixed(3).padStart(6) + 'x  ' +
      pairedSpeedup.toFixed(3).padStart(6) + 'x  ' +
      incremental.toFixed(3).padStart(8) + 'x'
    );
    previousMedian = sampleMedian;
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
