#!/usr/bin/env node
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const CODE = 0x00530000;
const DATA = 0x00600000;
const u32 = v => v >>> 0;

async function makeHarness(enabled) {
  const h = await bootRenderHarness();
  const e = h.exports;
  const mem = new Uint8Array(h.memory.buffer);
  const guestBase = e.get_guest_base() >>> 0;
  const imageBase = e.get_image_base() >>> 0;
  const wa = ga => (u32(ga) - imageBase + guestBase) >>> 0;
  e.set_hotform_specialization_enabled(enabled ? 1 : 0);
  return { e, mem, wa };
}

function snapshot(h) {
  const { e, mem, wa } = h;
  return {
    eip: u32(e.get_eip()),
    eax: u32(e.get_eax()), ecx: u32(e.get_ecx()),
    edx: u32(e.get_edx()), ebx: u32(e.get_ebx()),
    esp: u32(e.get_esp()), ebp: u32(e.get_ebp()),
    esi: u32(e.get_esi()), edi: u32(e.get_edi()),
    flagOp: u32(e.get_flag_op()), flagA: u32(e.get_flag_a()),
    flagB: u32(e.get_flag_b()), flagRes: u32(e.get_flag_res()),
    flagShift: u32(e.get_flag_sign_shift()),
    data: [u32(e.guest_read32(DATA)), u32(e.guest_read32(DATA + 4)),
      u32(e.guest_read32(DATA + 8)), u32(e.guest_read32(DATA + 12))],
  };
}

function seed(h, bytes, regs, dataOffset = 0, dataValue = 0) {
  const { e, mem, wa } = h;
  e.set_hotform_specialization_enabled(e.get_hotform_specialization_enabled());
  mem.fill(0, wa(CODE), wa(CODE) + 16);
  mem.set(bytes.concat([0xeb, 0xfe]), wa(CODE));
  e.guest_write32(DATA, (dataValue & 0xff) << (dataOffset * 8));
  e.guest_write32(DATA + 4, 0);
  e.guest_write32(DATA + 8, 0);
  e.guest_write32(DATA + 12, 0);
  e.set_eip(CODE);
  e.set_eax(regs.eax || 0); e.set_ecx(regs.ecx || 0);
  e.set_edx(regs.edx || 0); e.set_ebx(regs.ebx || 0);
  e.set_esp(regs.esp || 0); e.set_ebp(regs.ebp || 0);
  e.set_esi(regs.esi || 0); e.set_edi(regs.edi || 0);
}

function runCase(generic, specialized, name, bytes, regs, dataOffset, dataValue) {
  seed(generic, bytes, regs, dataOffset, dataValue);
  seed(specialized, bytes, regs, dataOffset, dataValue);
  generic.e.run(1);
  specialized.e.run(1);
  assert.deepStrictEqual(snapshot(specialized), snapshot(generic), name);
  assert(specialized.e.get_hotform_specialized_emits() > 0, `${name}: no specialized emit`);
}

(async () => {
  const generic = await makeHarness(false);
  const specialized = await makeHarness(true);
  runCase(generic, specialized, 'add byte [eax], al', [0x00, 0x00],
    { eax: DATA + 1 }, 1, 0xf0);
  runCase(generic, specialized, 'add byte [ecx+4], al', [0x00, 0x41, 0x04],
    { eax: 0x33, ecx: DATA }, 4, 0xe2);
  runCase(generic, specialized, 'add dl, dh', [0x00, 0xf2],
    { edx: 0x1234f010 }, 0, 0);
  runCase(generic, specialized, 'mov ecx, eax', [0x89, 0xc1],
    { eax: 0x12345678, ecx: 0xaaaaaaaa }, 0, 0);
  runCase(generic, specialized, 'mov edx, edi', [0x89, 0xfa],
    { edx: 0xaaaaaaaa, edi: 0x87654321 }, 0, 0);
  runCase(generic, specialized, 'add edx, ecx', [0x01, 0xca],
    { edx: 0xf0000010, ecx: 0x20000020 }, 0, 0);
  runCase(generic, specialized, 'add edi, ecx', [0x01, 0xcf],
    { edi: 0x01020304, ecx: 0x10203040 }, 0, 0);
  specialized.e.set_handler_hist_enabled(1);
  seed(specialized, [0x00, 0x00], { eax: DATA + 1 }, 1, 0xf0);
  specialized.e.run(1);
  assert.strictEqual(specialized.e.get_hotform_specialized_emits(), 0,
    'histogram mode must re-decode generic handler IDs');
  specialized.e.set_handler_hist_enabled(0);
  console.log('PASS  profile-guided exact handlers match generic threaded handlers');
})().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
