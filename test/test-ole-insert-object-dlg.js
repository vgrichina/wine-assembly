#!/usr/bin/env node
'use strict';

// OleUIInsertObjectA — WordPad's Insert > Object. The export was missing
// entirely, so the app resolved it, got nothing, and put up its own "missing
// export in OLEDLG.DLL" error box. That was the last hard gap the corpus menu
// sweep found.
//
// The part worth testing is the object-type list, because it is the part that
// could easily have been faked. Windows decides what may be embedded by walking
// HKEY_CLASSES_ROOT\CLSID for subkeys carrying an Insertable key, and so does
// this dialog — so the test registers a class first and then checks that it
// shows up and that picking it puts that exact CLSID in the caller's struct.
// A machine with no OLE server registered gets an empty list, which is what
// Windows shows there too, and OK on an empty list reports cancelled rather
// than inserting nothing.

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const { setRegValue } = require('../lib/storage');

const CLSID_TEXT = '{00000315-0000-0000-C000-000000000046}';
const CLSID_BYTES = [0x15, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                     0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46];
const LB_GETCOUNT = 0x018B;
const LB_SETCURSEL = 0x0186;

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  for (const n of ['create_thread', 'exit_thread', 'create_event', 'set_event',
                   'reset_event', 'wait_single', 'wait_multiple']) base.host[n] = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, base);
  const wat = instance.exports;
  ctx.exports = wat;

  const cases = [];
  const check = (name, pass, detail) => cases.push({ name, pass, detail });
  const putStr = (s) => {
    const g = wat.guest_alloc(s.length + 1) >>> 0;
    for (let i = 0; i < s.length; i++) wat.guest_write8(g + i, s.charCodeAt(i));
    wat.guest_write8(g + s.length, 0);
    return g;
  };
  const newParams = () => {
    const g = wat.guest_alloc(112) >>> 0;
    for (let i = 0; i < 112; i++) wat.guest_write8(g + i, 0);
    wat.guest_write32(g, 112);   // cbStruct
    return g;
  };
  const listOf = (dlg) => {
    let slot = 0, found = 0;
    while ((slot = wat.wnd_next_child_slot(dlg, slot)) !== -1) {
      const ch = wat.wnd_slot_hwnd(slot);
      slot++;
      if (wat.ctrl_get_class(ch) === 4) found = ch;
    }
    return found;
  };

  // The CLSID text→bytes conversion the registry walk depends on. Data1/2/3 are
  // numbers stored little-endian while Data4 is a byte string; a parser that
  // gets that backwards produces a CLSID equal to nothing.
  {
    const src = putStr(CLSID_TEXT);
    const dest = wat.guest_alloc(16) >>> 0;
    for (let i = 0; i < 16; i++) wat.guest_write8(dest + i, 0xAA);
    const ok = wat.test_clsid_from_string(src, dest);
    const got = [];
    for (let i = 0; i < 16; i++) got.push(wat.guest_read8(dest + i) & 0xFF);
    check('a CLSID string parses', ok === 1);
    check('Data1-3 are little-endian and Data4 is not',
      JSON.stringify(got) === JSON.stringify(CLSID_BYTES),
      got.map(b => b.toString(16).padStart(2, '0')).join(' '));
    check('a malformed CLSID is refused',
      wat.test_clsid_from_string(putStr('{not-a-clsid}'), dest) === 0);
  }

  // No server registered: an empty list, and OK reports cancelled.
  {
    const params = newParams();
    const dlg = wat.test_create_insert_object_dialog(params) >>> 0;
    check('the dialog is created with no classes registered', dlg !== 0);
    const list = listOf(dlg);
    check('it has an object-type list', list !== 0);
    check('OK with nothing insertable reports cancelled',
      wat.test_insert_object_commit(dlg) === 2);
  }

  // Now register one insertable class, exactly as an OLE server would: a name
  // on the class key and an Insertable subkey to opt into embedding.
  setRegValue(`HKCR\\CLSID\\${CLSID_TEXT}`, '', 1, 'Test Picture Object');
  setRegValue(`HKCR\\CLSID\\${CLSID_TEXT}\\Insertable`, '', 1, '');

  {
    const params = newParams();
    const dlg = wat.test_create_insert_object_dialog(params) >>> 0;
    const list = listOf(dlg);
    const count = list ? wat.send_message(list, LB_GETCOUNT, 0, 0) : 0;
    check('the registered class appears in the list', count === 1, `count=${count}`);
    check('the dialog kept the parsed class alongside it',
      wat.test_insert_object_type_count(dlg) === 1,
      `ctx count=${wat.test_insert_object_type_count(dlg)}`);
    if (list) wat.send_message(list, LB_SETCURSEL, 0, 0);
    check('OK on a selected class reports OLEUI_OK',
      wat.test_insert_object_commit(dlg) === 1);
    const got = [];
    for (let i = 0; i < 16; i++) got.push(wat.guest_read8(params + 36 + i) & 0xFF);
    check('the chosen CLSID lands in the caller struct',
      JSON.stringify(got) === JSON.stringify(CLSID_BYTES),
      got.map(b => b.toString(16).padStart(2, '0')).join(' '));
    check('IOF_CREATENEWOBJECT records which half of the dialog was used',
      (wat.guest_read32(params + 4) & 0x800) !== 0);
  }

  let failed = 0;
  for (const c of cases) {
    if (c.pass) console.log(`PASS  ${c.name}`);
    else { failed++; console.log(`FAIL  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`); }
  }
  console.log('');
  console.log(`${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
