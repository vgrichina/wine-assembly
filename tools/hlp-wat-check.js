#!/usr/bin/env node
// What does the WAT WinHelp parser make of this .hlp?
//
// Loads the real module and reports, for one or more files: whether the file
// loads, the parser's error code and offset if it does not, the topic/context/
// keyword inventory, and per-topic decode and layout results including the
// numbered layout failure reason. This is the "why is this file not rendering"
// tool - tools/hlp-dir.js answers the complementary question ("what is inside
// the file") and works even when the parser refuses it.
//
// Usage: node tools/hlp-wat-check.js <file.hlp> [more.hlp ...] [--topics]
//        --topics  list every topic, not just the failing ones

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// $help_last_error codes, from the parser's own enum.
const ERRORS = {
  0: 'none', 1: 'bad argument', 2: 'allocation', 3: 'bad outer header',
  4: 'bad file header', 5: 'directory btree', 6: 'capacity', 7: 'vfs',
  8: 'missing internal file', 9: 'system record', 10: 'topic index',
  11: 'context index', 12: 'phrase table', 13: 'topic record',
  14: 'topic format', 15: 'font table', 16: 'bitmap table',
  17: 'keyword index', 18: 'cnt',
};
// $help_layout_fail_code, listed above $help_layout_tokens_core.
const LAYOUT_FAILS = {
  1: 'bad width/token/run-capacity argument', 2: 'raw/token/payload out of memory',
  3: 'run buffer out of memory', 4: 'END_TOPIC inside a hotspot',
  5: 'paragraph record would not decode', 6: 'paragraph margins invert',
  7: 'font index out of range', 8: 'hotspot opens inside a hotspot',
  9: 'hotspot ends with none open', 10: 'run capacity, space token',
  11: 'run capacity, bitmap token', 12: 'text offset past raw buffer',
  13: 'text length past raw buffer', 14: 'run capacity, space in text',
  15: 'run capacity, word in text', 16: 'stream ended with no END_TOPIC',
};

// $help_hall_fail_code, listed above $help_decode_hall_topic_data.
const HALL_FAILS = {
  1: 'source exhausted before output complete', 2: 'two-byte phrase code truncated',
  3: 'literal run past source or output', 4: 'run past output',
  5: 'phrase index past phrase table', 6: 'phrase longer than remaining output',
};

async function main() {
  const args = process.argv.slice(2);
  const listAll = args.includes('--topics');
  const files = args.filter(arg => !arg.startsWith('--'));
  if (!files.length) {
    console.error('usage: node tools/hlp-wat-check.js <file.hlp> [...] [--topics]');
    process.exit(2);
  }

  const wasm = await compileWat(file => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  for (const stub of ['create_thread', 'exit_thread', 'create_event', 'set_event',
    'reset_event', 'wait_single', 'wait_multiple']) {
    imports.host[stub] = () => 0;
  }
  imports.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  ctx.exports = e;
  const bytes = new Uint8Array(memory.buffer);
  const staging = e.get_staging();
  const outWA = staging + 0x20000;
  const tokensWA = staging + 0x40000;
  const payloadWA = staging + 0x60000;
  const runsWA = staging + 0x80000;

  for (const file of files) {
    const data = fs.readFileSync(file);
    bytes.set(data, staging);
    const loaded = e.test_help_load_buffer(staging, data.length);
    console.log(`\n${file}  (${data.length} bytes)`);
    if (loaded !== 1) {
      const code = e.get_help_last_error();
      const btree = e.get_help_btree_fail_code ? e.get_help_btree_fail_code() : 0;
      console.log(`  LOAD FAILED  err=${code} (${ERRORS[code] || '?'}) ` +
        `at 0x${(e.get_help_last_error_offset() >>> 0).toString(16)}` +
        ((code === 10 || code === 11) && btree
          ? `  btree check ${btree} (see $help_parse_semantic_btree)` : ''));
      continue;
    }
    const topics = e.get_help_topic_count();
    console.log(`  loaded: ${topics} topics, ${e.get_help_context_count()} contexts, ` +
      `${e.get_help_keyword_count()} keywords, ${e.get_help_font_count()} fonts` +
      (e.get_help_context_dropped && e.get_help_context_dropped()
        ? `, ${e.get_help_context_dropped()} context entries dropped` : ''));
    const phrases = e.get_help_phrase_count();
    const sample = [];
    for (let index = 0; index < Math.min(phrases, 6); index++) {
      const ptr = e.get_help_phrase_ptr(index);
      const len = e.get_help_phrase_len(index);
      sample.push(JSON.stringify(
        Buffer.from(bytes.subarray(ptr, ptr + len)).toString('latin1')));
    }
    console.log(`  phrases: ${phrases}, image ${e.get_help_phrase_image_size()} bytes` +
      (sample.length ? `  first: ${sample.join(' ')}` : ''));
    let ok = 0;
    const lines = [];
    for (let index = 0; index < topics; index++) {
      const tokens = e.test_help_decode_topic_formatted(index, outWA, 0x20000,
        tokensWA, 4096, payloadWA, 0x20000);
      let runs = -1;
      let note = '';
      if (tokens < 1) {
        const code = e.get_help_last_error();
        note = `decode failed err=${code} (${ERRORS[code] || '?'}) ` +
          `at 0x${(e.get_help_last_error_offset() >>> 0).toString(16)}`;
        if (code === 13 && e.get_help_hall_fail_code) {
          note += `  hall=${e.get_help_hall_fail_code()} ` +
            `(${HALL_FAILS[e.get_help_hall_fail_code()] || '?'}) ` +
            `pos=${e.get_help_hall_fail_pos()} phrase=${e.get_help_hall_fail_phrase()} ` +
            `produced=${e.get_help_hall_fail_dest()}`;
        }
      } else {
        runs = e.test_help_layout_tokens_with_payload(outWA, 0x20000, payloadWA,
          e.get_help_formatted_payload_size(), tokensWA, tokens, runsWA, 2048, 560);
        if (runs < 0) {
          const code = e.get_help_layout_fail_code();
          note = `layout refused: ${code} (${LAYOUT_FAILS[code] || '?'}) ` +
            `at token ${e.get_help_layout_fail_token()}`;
        } else {
          ok++;
        }
      }
      if (note || listAll) {
        lines.push(`    topic ${index}: tokens=${tokens} runs=${runs}` +
          (note ? `  ${note}` : ''));
      }
    }
    console.log(`  renders: ${ok}/${topics}`);
    for (const line of lines) console.log(line);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
