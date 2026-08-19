#!/usr/bin/env node
// Standalone tooltips_class32 regression. Loads the wasm module without a
// guest exe, creates a native tooltip control, then exercises common TTM_*
// messages against TOOLINFOA-style records.

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

const TTM_ACTIVATE = 0x0401;
const TTM_SETDELAYTIME = 0x0403;
const TTM_ADDTOOLA = 0x0404;
const TTM_DELTOOLA = 0x0405;
const TTM_NEWTOOLRECTA = 0x0406;
const TTM_RELAYEVENT = 0x0407;
const TTM_GETTOOLINFOA = 0x0408;
const TTM_SETTOOLINFOA = 0x0409;
const TTM_HITTESTA = 0x040A;
const TTM_GETTEXTA = 0x040B;
const TTM_UPDATETIPTEXTA = 0x040C;
const TTM_GETTOOLCOUNT = 0x040D;
const TTM_ENUMTOOLSA = 0x040E;
const TTM_GETCURRENTTOOLA = 0x040F;
const TTM_WINDOWFROMPOINT = 0x0410;
const TTM_GETDELAYTIME = 0x0415;
const TTM_SETMAXTIPWIDTH = 0x0418;
const TTM_GETMAXTIPWIDTH = 0x0419;
const TTM_SETMARGIN = 0x041A;
const TTM_GETMARGIN = 0x041B;

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = {
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = g => g - e.get_image_base() + 0x12000;

  const checks = [];
  function check(name, pass, info = '') {
    checks.push({ name, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (info ? '  (' + info + ')' : ''));
  }
  function writeStr(s) {
    const g = e.guest_alloc(s.length + 1);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i);
    u8[p + s.length] = 0;
    return g;
  }
  function readStr(g, max = 256) {
    const p = wa(g);
    let s = '';
    for (let i = 0; i < max && u8[p + i]; i++) s += String.fromCharCode(u8[p + i]);
    return s;
  }
  function toolInfo({ hwnd, id, text, rect = [0, 0, 100, 20], flags = 0x10 }) {
    const g = e.guest_alloc(48);
    const p = wa(g);
    for (let i = 0; i < 48; i++) u8[p + i] = 0;
    dv.setUint32(p + 0, 48, true);
    dv.setUint32(p + 4, flags, true);
    dv.setUint32(p + 8, hwnd, true);
    dv.setUint32(p + 12, id, true);
    rect.forEach((v, i) => dv.setInt32(p + 16 + i * 4, v, true));
    dv.setUint32(p + 36, text || 0, true);
    return g;
  }
  function getToolText(tt, hwnd, id) {
    const buf = e.guest_alloc(128);
    const ti = toolInfo({ hwnd, id, text: buf });
    const ok = e.send_message(tt, TTM_GETTEXTA, 0, ti);
    return { ok, text: readStr(buf) };
  }

  const baseline = e.wnd_count_used();
  const tt = e.test_create_tooltip();
  check('tooltip hwnd allocated', tt !== 0, 'hwnd=0x' + tt.toString(16));
  check('create added parent + tooltip slots', e.wnd_count_used() === baseline + 2);

  const owner = 0x10001;
  const tip1 = writeStr('Play');
  const tip2 = writeStr('Pause');
  const ti1 = toolInfo({ hwnd: owner, id: 10, text: tip1, rect: [1, 2, 31, 22] });
  const ti2 = toolInfo({ hwnd: owner, id: 11, text: tip2, rect: [40, 2, 80, 22] });

  check('TTM_ADDTOOLA first succeeds', e.send_message(tt, TTM_ADDTOOLA, 0, ti1) === 1);
  check('TTM_ADDTOOLA second succeeds', e.send_message(tt, TTM_ADDTOOLA, 0, ti2) === 1);
  check('TTM_GETTOOLCOUNT is 2', e.send_message(tt, TTM_GETTOOLCOUNT, 0, 0) === 2);

  const out = toolInfo({ hwnd: owner, id: 10, text: 0 });
  check('TTM_GETTOOLINFOA finds first tool', e.send_message(tt, TTM_GETTOOLINFOA, 0, out) === 1);
  check('GETTOOLINFO preserves rect.left', dv.getInt32(wa(out) + 16, true) === 1);
  check('GETTOOLINFO preserves lpszText pointer', dv.getUint32(wa(out) + 36, true) === tip1);

  const enumOut = toolInfo({ hwnd: 0, id: 0, text: 0 });
  check('TTM_ENUMTOOLSA index 1 succeeds', e.send_message(tt, TTM_ENUMTOOLSA, 1, enumOut) === 1);
  check('ENUMTOOLSA returned second id', dv.getUint32(wa(enumOut) + 12, true) === 11);

  const got = getToolText(tt, owner, 10);
  check('TTM_GETTEXTA succeeds', got.ok === 1);
  check('TTM_GETTEXTA copies text', got.text === 'Play', `got "${got.text}"`);

  const newText = writeStr('Play button');
  const update = toolInfo({ hwnd: owner, id: 10, text: newText });
  check('TTM_UPDATETIPTEXTA succeeds', e.send_message(tt, TTM_UPDATETIPTEXTA, 0, update) === 1);
  check('updated text is returned', getToolText(tt, owner, 10).text === 'Play button');

  const newRect = toolInfo({ hwnd: owner, id: 10, text: newText, rect: [5, 5, 55, 25] });
  check('TTM_NEWTOOLRECTA succeeds', e.send_message(tt, TTM_NEWTOOLRECTA, 0, newRect) === 1);
  const hit = e.guest_alloc(60);
  const hp = wa(hit);
  dv.setUint32(hp + 0, owner, true);
  dv.setInt32(hp + 4, 10, true);
  dv.setInt32(hp + 8, 10, true);
  check('TTM_HITTESTA inside updated rect succeeds', e.send_message(tt, TTM_HITTESTA, 0, hit) === 1);
  check('HITTEST copied matching id', dv.getUint32(hp + 12 + 12, true) === 10);

  const msg = e.guest_alloc(28);
  const mp = wa(msg);
  dv.setUint32(mp + 0, owner, true);
  dv.setUint32(mp + 4, 0x0200, true);
  dv.setUint32(mp + 12, (10 & 0xFFFF) | (10 << 16), true);
  check('TTM_RELAYEVENT accepts mouse move', e.send_message(tt, TTM_RELAYEVENT, 0, msg) === 0);
  const cur = toolInfo({ hwnd: 0, id: 0, text: 0 });
  check('TTM_GETCURRENTTOOLA succeeds after relay', e.send_message(tt, TTM_GETCURRENTTOOLA, 0, cur) === 1);
  check('GETCURRENTTOOLA is id 10', dv.getUint32(wa(cur) + 12, true) === 10);
  check('TTM_WINDOWFROMPOINT returns current owner', e.send_message(tt, TTM_WINDOWFROMPOINT, 0, 0) === owner);

  e.send_message(tt, TTM_SETDELAYTIME, 1, 123);
  e.send_message(tt, TTM_SETDELAYTIME, 2, 456);
  e.send_message(tt, TTM_SETDELAYTIME, 3, 789);
  check('TTM_GETDELAYTIME reshow round-trips', e.send_message(tt, TTM_GETDELAYTIME, 1, 0) === 123);
  check('TTM_GETDELAYTIME autopop round-trips', e.send_message(tt, TTM_GETDELAYTIME, 2, 0) === 456);
  check('TTM_GETDELAYTIME initial round-trips', e.send_message(tt, TTM_GETDELAYTIME, 3, 0) === 789);
  check('TTM_SETMAXTIPWIDTH returns previous width', e.send_message(tt, TTM_SETMAXTIPWIDTH, 0, 250) === -1);
  check('TTM_GETMAXTIPWIDTH round-trips', e.send_message(tt, TTM_GETMAXTIPWIDTH, 0, 0) === 250);
  check('TTM_SETMAXTIPWIDTH returns last width', e.send_message(tt, TTM_SETMAXTIPWIDTH, 0, 300) === 250);
  check('TTM_GETMAXTIPWIDTH updates again', e.send_message(tt, TTM_GETMAXTIPWIDTH, 0, 0) === 300);

  const margin = e.guest_alloc(16);
  const mp2 = wa(margin);
  [2, 3, 4, 5].forEach((v, i) => dv.setInt32(mp2 + i * 4, v, true));
  e.send_message(tt, TTM_SETMARGIN, 0, margin);
  const marginOut = e.guest_alloc(16);
  e.send_message(tt, TTM_GETMARGIN, 0, marginOut);
  check('TTM_GETMARGIN returns left/right values',
    dv.getInt32(wa(marginOut), true) === 2 && dv.getInt32(wa(marginOut) + 8, true) === 4);

  check('TTM_DELTOOLA succeeds', e.send_message(tt, TTM_DELTOOLA, 0, ti2) === 1);
  check('TTM_GETTOOLCOUNT is 1 after delete', e.send_message(tt, TTM_GETTOOLCOUNT, 0, 0) === 1);

  e.send_message(tt, TTM_ACTIVATE, 0, 0);
  if (e.wnd_destroy_tree) e.wnd_destroy_tree(tt - 1);
  check('slot count returns to baseline after destroy', e.wnd_count_used() === baseline);

  console.log('');
  const failed = checks.filter(c => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
