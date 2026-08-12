#!/usr/bin/env node
'use strict';

// Generate the application-neutral four-slot register packet executor. Slot
// operands are encoded in the opcode, so each case names Wasm locals statically
// and performs no runtime slot selection.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', '05a-slot-packet.generated.wat');
const lines = [];
const p = (line = '') => lines.push(line);

const groups = [];
let nextOpcode = 1;
function group(name, count, body) {
  const base = nextOpcode;
  nextOpcode += count;
  groups.push({ name, base, count, body });
  return base;
}

const EXPORT = group('EXPORT_SLOT_GUEST', 32, i => {
  const slot = i >>> 3;
  const guest = i & 7;
  return [`(call $set_reg (i32.const ${guest}) (local.get $l${slot}))`];
});
const STORE_ABS = group('STORE32_ABS', 4, slot => [
  `(i32.store (call $g2w (call $read_thread_word)) (local.get $l${slot}))`,
]);
const COPY = group('COPY', 16, i => {
  const dst = i >>> 2, src = i & 3;
  return [`(local.set $l${dst} (local.get $l${src}))`];
});
const ADD = group('ADD', 16, i => {
  const dst = i >>> 2, src = i & 3;
  return [`(local.set $l${dst} (i32.add (local.get $l${dst}) (local.get $l${src})))`];
});
const ADD_FLAGS = group('ADD_FLAGS', 16, i => {
  const dst = i >>> 2, src = i & 3;
  return [
    `(local.set $a (local.get $l${dst}))`,
    `(local.set $b (local.get $l${src}))`,
    `(local.set $res (i32.add (local.get $a) (local.get $b)))`,
    `(local.set $l${dst} (local.get $res))`,
    `(call $set_flags_add (local.get $a) (local.get $b) (local.get $res))`,
  ];
});
const ADD_I32 = group('ADD_I32', 4, slot => [
  `(local.set $l${slot} (i32.add (local.get $l${slot}) (call $read_thread_word)))`,
]);
const SUB_I32 = group('SUB_I32', 4, slot => [
  `(local.set $l${slot} (i32.sub (local.get $l${slot}) (call $read_thread_word)))`,
]);
const AND_I32_FLAGS = group('AND_I32_FLAGS', 4, slot => [
  `(local.set $l${slot} (i32.and (local.get $l${slot}) (call $read_thread_word)))`,
  `(call $set_flags_logic (local.get $l${slot}))`,
]);
const SHR_U_I32_FLAGS = group('SHR_U_I32_FLAGS', 4, slot => [
  `(local.set $a (local.get $l${slot}))`,
  `(local.set $b (call $read_thread_word))`,
  `(local.set $l${slot} (i32.shr_u (local.get $a) (local.get $b)))`,
  `(call $set_flags_shift (local.get $l${slot})`,
  `  (i32.and (i32.shr_u (local.get $a) (i32.sub (local.get $b) (i32.const 1))) (i32.const 1)))`,
]);
const LOAD8_U = group('LOAD8_U', 16, i => {
  const dst = i >>> 2, base = i & 3;
  return [`(local.set $l${dst} (i32.load8_u (call $g2w (local.get $l${base}))))`];
});
const LOAD32_ABS = group('LOAD32_ABS', 4, slot => [
  `(local.set $l${slot} (i32.load (call $g2w (call $read_thread_word))))`,
]);
const SUB = group('SUB', 16, i => {
  const dst = i >>> 2, src = i & 3;
  return [`(local.set $l${dst} (i32.sub (local.get $l${dst}) (local.get $l${src})))`];
});
const JMP_TABLE = group('JMP_TABLE', 4, slot => [
  `(local.set $a (call $read_thread_word))`,
  `(local.set $b (call $read_thread_word))`,
  `(global.set $eip (i32.load (call $g2w`,
  `  (i32.add (local.get $a) (i32.shl (local.get $l${slot}) (local.get $b))))))`,
  `(br $packet_done)`,
]);
const CMP_RM32_JCC = group('CMP_RM32_JCC', 16, i => {
  const lhs = i >>> 2, base = i & 3;
  return [
    `(local.set $a (local.get $l${lhs}))`,
    `(local.set $b (i32.load (call $g2w`,
    `  (i32.add (local.get $l${base}) (call $read_thread_word)))))`,
    `(local.set $res (i32.sub (local.get $a) (local.get $b)))`,
    `(call $set_flags_sub (local.get $a) (local.get $b) (local.get $res))`,
    `(local.set $cc (call $read_thread_word))`,
    `(local.set $target (call $read_thread_word))`,
    `(local.set $fall (call $read_thread_word))`,
    `(global.set $eip (if (result i32) (call $eval_cc (local.get $cc))`,
    `  (then (local.get $target)) (else (local.get $fall))))`,
    `(br $packet_done)`,
  ];
});
const JCC = group('JCC', 1, () => [
  `(local.set $cc (call $read_thread_word))`,
  `(local.set $target (call $read_thread_word))`,
  `(local.set $fall (call $read_thread_word))`,
  `(global.set $eip (if (result i32) (call $eval_cc (local.get $cc))`,
  `  (then (local.get $target)) (else (local.get $fall))))`,
  `(br $packet_done)`,
]);
const JMP_I32 = group('JMP_I32', 1, () => [
  `(global.set $eip (call $read_thread_word))`,
  `(br $packet_done)`,
]);

function emitDispatchGroup(g) {
  p(`        ;; ${g.name}: opcodes ${g.base}..${g.base + g.count - 1}`);
  p(`        (if (i32.and (i32.ge_u (local.get $code) (i32.const ${g.base}))`);
  p(`                     (i32.le_u (local.get $code) (i32.const ${g.base + g.count - 1})))`);
  p(`          (then`);
  for (let i = g.count - 1; i >= 0; i--) p(`            (block $${g.name}_${i}`);
  const labels = Array.from({ length: g.count }, (_, i) => `$${g.name}_${i}`).join(' ');
  p(`              (br_table ${labels} $${g.name}_0`);
  p(`                (i32.sub (local.get $code) (i32.const ${g.base})))`);
  for (let i = 0; i < g.count; i++) {
    p(`            ) ;; $${g.name}_${i}`);
    for (const line of g.body(i)) p(`            ${line}`);
    p(`            (br $packet)`);
  }
  p(`          ))`);
}

p('  ;; GENERATED by tools/generate-wat-slot-packet.js. Do not edit directly.');
p('  ;; Four packet-local value slots are mapped to arbitrary guest registers');
p('  ;; by two packed descriptors (four 4-bit guest-register IDs, 0xF=unused).');
p('  (func $wat_slot_packet');
p('    (local $l0 i32) (local $l1 i32) (local $l2 i32) (local $l3 i32)');
p('    (local $imports i32) (local $exports i32) (local $reg i32)');
p('    (local $code i32) (local $a i32) (local $b i32) (local $res i32)');
p('    (local $cc i32) (local $target i32) (local $fall i32)');
p('');
p('    (if (global.get $wat_slot_packet_count_enabled)');
p('      (then (global.set $wat_slot_packet_entries');
p('        (i32.add (global.get $wat_slot_packet_entries) (i32.const 1)))))');
p('    (local.set $imports (call $read_thread_word))');
p('    (local.set $exports (call $read_thread_word))');
for (let slot = 0; slot < 4; slot++) {
  p(`    (local.set $reg (i32.and (i32.shr_u (local.get $imports) (i32.const ${slot * 4})) (i32.const 15)))`);
  p(`    (if (i32.ne (local.get $reg) (i32.const 15))`);
  p(`      (then (local.set $l${slot} (call $get_reg (local.get $reg)))))`);
}
p('');
p('    (block $packet_done');
p('      (loop $packet');
p('        (local.set $code (call $read_thread_word))');
for (const g of groups) emitDispatchGroup(g);
p('        (call $host_log_i32 (i32.const 0x5107BAD))');
p('        (global.set $eip (i32.const 0))');
p('        (br $packet_done)))');
p('');
for (let slot = 0; slot < 4; slot++) {
  p(`    (local.set $reg (i32.and (i32.shr_u (local.get $exports) (i32.const ${slot * 4})) (i32.const 15)))`);
  p(`    (if (i32.ne (local.get $reg) (i32.const 15))`);
  p(`      (then (call $set_reg (local.get $reg) (local.get $l${slot}))))`);
}
p('  )');
p('');
p(`  ;; Opcode bases: EXPORT=${EXPORT}, STORE_ABS=${STORE_ABS}, COPY=${COPY},`);
p(`  ;; ADD=${ADD}, ADD_FLAGS=${ADD_FLAGS}, ADD_I32=${ADD_I32}, SUB_I32=${SUB_I32},`);
p(`  ;; AND_I32_FLAGS=${AND_I32_FLAGS}, SHR_U_I32_FLAGS=${SHR_U_I32_FLAGS},`);
p(`  ;; LOAD8_U=${LOAD8_U}, LOAD32_ABS=${LOAD32_ABS}, SUB=${SUB},`);
p(`  ;; JMP_TABLE=${JMP_TABLE}, CMP_RM32_JCC=${CMP_RM32_JCC}, JCC=${JCC}, JMP_I32=${JMP_I32}.`);

fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`generated ${path.relative(path.join(__dirname, '..'), OUT)} (${nextOpcode - 1} opcodes)`);

module.exports = {
  ADD, ADD_FLAGS, ADD_I32, AND_I32_FLAGS, CMP_RM32_JCC, COPY, EXPORT,
  JCC, JMP_I32, JMP_TABLE, LOAD8_U, LOAD32_ABS, SHR_U_I32_FLAGS,
  STORE_ABS, SUB, SUB_I32,
};
