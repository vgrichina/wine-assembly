// Verify BS_AUTORADIOBUTTON mutex behavior. Builds the Find dialog (which
// has Up/Down autoradios with IDs 0x420/0x421), clicks each in turn, and
// asserts BM_GETCHECK reflects "exactly one selected".
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const { Win98Renderer } = require('../lib/renderer');

(async () => {
  const SRC = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
  const canvas = createCanvas(640, 480);
  const renderer = new Win98Renderer(canvas);
  const ctx = { getMemory: () => memory.buffer, renderer, resourceJson: { menus:{}, dialogs:{}, strings:{}, bitmaps:{} }, onExit: () => {} };
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
  renderer.wasm = instance;
  renderer.wasmMemory = memory;

  const dlg = e.test_create_find_dialog();

  // Find both autoradios by walking children of dlg
  let up = 0, down = 0;
  let slot = 0;
  while ((slot = e.wnd_next_child_slot(dlg, slot)) !== -1) {
    const h = e.wnd_slot_hwnd(slot);
    slot++;
    if (e.ctrl_get_class(h) !== 1) continue;
    const id = e.ctrl_get_id(h);
    if (id === 0x420) up = h;
    else if (id === 0x421) down = h;
  }
  if (!up || !down) { console.error('FAIL: missing autoradios', { up, down }); process.exit(1); }

  const click = (h) => {
    e.send_message(h, 0x0201, 0, 0); // WM_LBUTTONDOWN
    e.send_message(h, 0x0202, 0, 0); // WM_LBUTTONUP
  };
  const checked = (h) => e.send_message(h, 0x00F0, 0, 0); // BM_GETCHECK

  click(up);
  console.log('click up: up=' + checked(up) + ' down=' + checked(down));
  if (!(checked(up) === 1 && checked(down) === 0)) {
    console.error('FAIL: expected up=1 down=0'); process.exit(1);
  }

  click(down);
  console.log('click dn: up=' + checked(up) + ' down=' + checked(down));
  if (!(checked(up) === 0 && checked(down) === 1)) {
    console.error('FAIL: expected up=0 down=1'); process.exit(1);
  }

  click(up);
  console.log('click up: up=' + checked(up) + ' down=' + checked(down));
  if (!(checked(up) === 1 && checked(down) === 0)) {
    console.error('FAIL: expected up=1 down=0'); process.exit(1);
  }

  console.log('PASS');
})();
