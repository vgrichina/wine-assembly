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
  17: 'run buffer smaller than the counted layout',
};
// The viewer counts a topic's runs and then allocates exactly that many, so it
// is never bounded by a fixed capacity. A long topic is not a broken one, and
// reporting it as a layout refusal is how qbob.hlp came to look damaged.
const RUN_CAPACITY = 16384;
// $HELP_TOPIC_TOKEN_SIZE and $HELP_TOKEN_MACRO, from 09c6-winhelp-core.wat.
const TOKEN_SIZE = 16;
const TOKEN_MACRO = 10;

// $help_block_lz77_fail_code, listed above $help_lz77_expand_topic_block.
const BLOCK_LZ77_FAILS = {
  1: 'literal past end of destination', 2: 'back-reference truncated',
  3: 'back-reference before block start, or run overruns the end',
};

// $help_link_fail_code, listed above $help_topic_link_at. The two aux values
// mean different things per code; see the WAT call sites.
const LINK_FAILS = {
  1: 'position before the first record', 2: 'block would not load',
  3: 'position past the end of its block', 4: 'header gather failed',
  5: 'record smaller than its own header', 6: 'block would not reload',
  7: 'straddling-record gather failed',
};

// $help_kw_fail_code, listed above $help_kw_fail. err=17 alone only says
// "somewhere in |KWBTREE"; the code names which of the two dozen checks the
// file failed, which is the difference between a corrupt index and a
// convention we do not model.
const KW_FAILS = {
  1: '|KWBTREE too short, or |KWDATA not whole postings',
  2: 'bad B+tree magic or flags', 3: 'unknown structure string',
  4: 'header sentinel fields wrong', 5: 'page size not a sane power of two',
  6: 'root page past the end of the tree',
  7: 'declared pages do not fit in the internal file',
  8: 'index page revisited or past the end', 9: 'index page free space',
  10: 'index page leftmost child out of range',
  11: 'index entry keyword runs past the page',
  12: 'index entry child page out of range',
  13: 'index page entries do not end at its used bytes',
  14: 'leaf page revisited or past the end', 15: 'leaf page free space/entries',
  16: 'leaf previous-page link disagrees with the walk',
  17: 'leaf next-page link out of range',
  18: 'leaf entry keyword runs past the page',
  19: 'posting slice outside |KWDATA',
  20: 'leaf page entries do not end at its used bytes',
  21: 'keyword count disagrees with the header',
  22: 'a posting resolves to no topic',
  23: 'index page keywords out of order', 24: 'leaf page keywords out of order',
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
  const listMacros = args.includes('--macros');
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
  const dv = new DataView(memory.buffer);
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
      const lz77 = e.get_help_block_lz77_fail_code ? e.get_help_block_lz77_fail_code() : 0;
      console.log(`  LOAD FAILED  err=${code} (${ERRORS[code] || '?'}) ` +
        `at 0x${(e.get_help_last_error_offset() >>> 0).toString(16)}` +
        ((code === 10 || code === 11) && btree
          ? `  btree check ${btree} (see $help_parse_semantic_btree)` : '') +
        (code === 13 && e.get_help_topic_fail_code && e.get_help_topic_fail_code()
          ? `  topic-link check ${e.get_help_topic_fail_code()}` +
            ` (see $help_parse_topic_links)` +
            (e.get_help_topic_fail_code() === 2 && e.get_help_link_fail_code
              ? `  link ${e.get_help_link_fail_code()} ` +
                `(${LINK_FAILS[e.get_help_link_fail_code()] || '?'}) ` +
                `a=${e.get_help_link_fail_a()} b=${e.get_help_link_fail_b()}`
              : '') : '') +
        (code === 17 && e.get_help_kw_fail_code
          ? `  keyword check ${e.get_help_kw_fail_code()} ` +
            `(${KW_FAILS[e.get_help_kw_fail_code()] || '?'})` : '') +
        (code === 17 && e.get_help_kw_fail_code &&
          e.get_help_kw_fail_code() === 22 && e.get_help_link_fail_a
          ? `  posting ref=0x${e.get_help_link_fail_a().toString(16)} ` +
            `topic offsets stop at 0x${e.get_help_link_fail_b().toString(16)}` : '') +
        (code === 13 && lz77
          ? `  block lz77 ${lz77} (${BLOCK_LZ77_FAILS[lz77] || '?'})` +
            ` src=${e.get_help_block_lz77_fail_src()}` +
            ` dest=${e.get_help_block_lz77_fail_dest()}` +
            ` word=0x${e.get_help_block_lz77_fail_word().toString(16)}`
          : ''));
      continue;
    }
    const topics = e.get_help_topic_count();
    console.log(`  loaded: ${topics} topics, ${e.get_help_context_count()} contexts, ` +
      `${e.get_help_keyword_count()} keywords, ${e.get_help_font_count()} fonts` +
      (e.get_help_context_dropped && e.get_help_context_dropped()
        ? `, ${e.get_help_context_dropped()} context entries dropped` : ''));
    // Routines the file registered when it opened, via RR()/RegisterRoutine
    // in its |SYSTEM macros. These are calls into a DLL the file ships.
    if (e.get_help_routine_count && e.get_help_routine_count()) {
      console.log(`  registered routines: ${e.get_help_routine_count()}` +
        ` of ${e.get_help_system_macro_count()} |SYSTEM macros`);
    }
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
    // Embedded bitmaps are a second way a topic can render wrong while every
    // topic "renders": the text lays out and the picture is missing. A help
    // file with 200 |bmN internal files is mostly pictures.
    const bitmaps = e.get_help_bitmap_count ? e.get_help_bitmap_count() : 0;
    if (bitmaps) {
      let bitmapOk = 0;
      const bitmapFails = [];
      for (let index = 0; index < bitmaps; index++) {
        if (e.test_help_clear_error) e.test_help_clear_error();
        if (e.test_help_decode_bitmap(index, outWA, 0x20000) > 0) { bitmapOk++; continue; }
        // Fields of the 80-byte HelpBitmap the parser normalized, so a failure
        // says WHAT kind of picture we cannot decode, not just that one broke.
        const r = e.get_help_bitmap_record(index);
        const at = off => dv.getUint32(r + off, true);
        bitmapFails.push(`${index}:err${e.get_help_last_error()} ` +
          `type=${at(8)} pack=${at(12)} ${at(32)}x${at(36)}@${at(28)}bpp ` +
          `hotspots=${at(60)} ${at(52)}->${at(72)}b` +
          (e.get_help_bitmap_fail_produced
            ? `  produced=${e.get_help_bitmap_fail_produced()}/` +
              `${e.get_help_bitmap_fail_expect()} rle=${e.get_help_bitmap_fail_rle()}` +
              (e.get_help_bitmap_fail_full
                ? ` stream=${e.get_help_bitmap_fail_full()}` : '')
            : ''));
      }
      console.log(`  bitmaps: ${bitmapOk}/${bitmaps} decode`);
      for (const line of bitmapFails.slice(0, 8)) console.log(`    bitmap ${line}`);
      if (bitmapFails.length > 8) {
        console.log(`    ... ${bitmapFails.length - 8} more failing bitmaps`);
      }
    }
    let ok = 0;
    const lines = [];
    for (let index = 0; index < topics; index++) {
      // The parser keeps the first error since load, so without this every
      // topic after a failure would report the first topic's code.
      if (e.test_help_clear_error) e.test_help_clear_error();
      const tokens = e.test_help_decode_topic_formatted(index, outWA, 0x20000,
        tokensWA, 4096, payloadWA, 0x20000);
      let runs = -1;
      let note = '';
      if (tokens < 1) {
        const code = e.get_help_last_error();
        note = `decode failed err=${code} (${ERRORS[code] || '?'}) ` +
          `at 0x${(e.get_help_last_error_offset() >>> 0).toString(16)}`;
        if (code === 14 && e.get_help_ld1_last_command) {
          const cmd = e.get_help_ld1_last_command();
          note += `  ld1: ` + (cmd & 0x100
            ? `${(cmd & 3) === 1 ? 'LinkData1' : 'text'} ended early`
            : `cmd 0x${cmd.toString(16)}`) +
            ` at ld1+${e.get_help_ld1_last_offset()}` +
            ` text ${e.get_help_ld1_last_raw()}/${e.get_help_ld1_last_raw_end()}`;
        }
        if (code === 13 && e.get_help_hall_fail_code) {
          note += `  hall=${e.get_help_hall_fail_code()} ` +
            `(${HALL_FAILS[e.get_help_hall_fail_code()] || '?'}) ` +
            `pos=${e.get_help_hall_fail_pos()}/${e.get_help_hall_fail_srclen()} ` +
            `phrase=${e.get_help_hall_fail_phrase()} ` +
            `produced=${e.get_help_hall_fail_dest()}/${e.get_help_hall_fail_expect()}`;
        }
      } else {
        runs = e.test_help_layout_tokens_with_payload(outWA, 0x20000, payloadWA,
          e.get_help_formatted_payload_size(), tokensWA, tokens, runsWA,
          RUN_CAPACITY, 560);
        if (runs < 0) {
          const code = e.get_help_layout_fail_code();
          note = `layout refused: ${code} (${LAYOUT_FAILS[code] || '?'}) ` +
            (code === 17
              ? `needs ${e.get_help_layout_fail_token()} runs`
              : `at token ${e.get_help_layout_fail_token()}`);
        } else {
          ok++;
        }
      }
      // Macro hotspots carry their macro string in the payload: a command
      // byte, a u16 length, then the text. Listing them answers "does this
      // file actually call the routines it registers", which no topic or
      // bitmap count can.
      if (listMacros && tokens > 0) {
        for (let t = 0; t < tokens; t++) {
          const token = tokensWA + t * TOKEN_SIZE;
          if (dv.getUint32(token, true) !== TOKEN_MACRO) continue;
          const at = payloadWA + dv.getUint32(token + 4, true);
          const length = dv.getUint16(at + 1, true);
          lines.push(`    topic ${index} macro: ` +
            JSON.stringify(Buffer.from(
              bytes.subarray(at + 3, at + 3 + length)).toString('latin1')));
        }
      }
      const pad = e.get_help_hall_pad_bytes ? e.get_help_hall_pad_bytes() : 0;
      if (pad) note += `${note ? '  ' : ''}hall padded ${pad} omitted tail bytes`;
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
