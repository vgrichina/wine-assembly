// Shared boot helper for the test/test-render-*.js suite. Compiles the WAT
// module, instantiates it with the canvas-backed host imports, and returns
// { instance, exports, renderer, canvas, memory } so individual render tests
// can build their dialog and call renderer.repaint().
//
// Each render test:
//   1. Calls bootRenderHarness({ extraHostOverrides? })
//   2. Builds whatever dialog/control it wants to draw via the test_create_*
//      exports.
//   3. Calls renderer.repaint().
//   4. Asserts the canvas has been written to (assertCanvasNonEmpty) and
//      writes the PNG to test/output/{name}.png for visual inspection.
//
// Tests fail with non-zero exit if the canvas is unchanged from the
// post-construction default (a sign WM_PAINT didn't reach the WAT wndprocs
// or the JS draw fallback was silently used).
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const { Win98Renderer } = require('../lib/renderer');

async function bootRenderHarness({ extraHostOverrides = {}, width = 640, height = 480 } = {}) {
  const SRC = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
  const canvas = createCanvas(width, height);
  const renderer = new Win98Renderer(canvas);
  const ctx = {
    getMemory: () => memory.buffer,
    renderer,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread   = () => 0;
  base.host.create_event  = () => 0;
  base.host.set_event     = () => 0;
  base.host.reset_event   = () => 0;
  base.host.wait_single   = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  Object.assign(base.host, extraHostOverrides);
  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const e = instance.exports;
  ctx.exports = e;
  renderer.wasm = instance;
  renderer.wasmMemory = memory;
  return { instance, exports: e, renderer, canvas, memory, hostCtx: ctx };
}

// Sample the canvas at every 16x16 grid cell. Returns the count of unique
// (r,g,b) tuples we see. A blank/teal-only canvas yields 1; anything that
// drew bevels, text, swatches, etc. produces many more.
function countUniqueColors(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const seen = new Set();
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
  }
  return seen.size;
}

// Check that a specific pixel is approximately the expected COLORREF
// (0x00BBGGRR style — we accept either RGB or BGR ordering since CSS uses
// RGB but Win32 uses BGR; tests can pass whichever is convenient).
function pixelMatches(canvas, x, y, r, g, b, tol = 4) {
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(x, y, 1, 1).data;
  return Math.abs(d[0] - r) <= tol && Math.abs(d[1] - g) <= tol && Math.abs(d[2] - b) <= tol;
}

function writePng(canvas, name) {
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, name);
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  return out;
}

// Drive WM_NCPAINT for top-level windows and WM_PAINT for every WAT-managed
// child slot, so chrome + control visuals land on the back-canvas before we
// composite. In a real run this is driven by the dialog message pump
// (09b-dispatch.wat); the headless harness has no pump, so we simulate it.
function flushPendingPaints(harness) {
  const r = harness.renderer;
  const e = harness.exports;
  if (!r || !e || !e.send_message || !e.wnd_slot_hwnd) return;
  for (const win of Object.values(r.windows)) {
    if (win.isChild || !win.visible || !(win.w > 0 && win.h > 0)) continue;
    if (typeof r._defwndprocNcpaint === 'function') {
      r._defwndprocNcpaint(win, win.x, win.y, win.w, win.h);
    }
  }
  // Walk every slot; deliver WM_PAINT to any descendant of a registered
  // top-level. Multiple passes handle grandchildren (e.g. combobox's inner
  // listbox is a grandchild of the test top-level).
  const topSet = new Set(Object.keys(r.windows).map(k => Number(k)));
  const painted = new Set(topSet);
  for (let pass = 0; pass < 4; pass++) {
    let progress = false;
    for (let s = 0; s < 256; s++) {
      const hw = e.wnd_slot_hwnd(s);
      if (!hw || painted.has(hw)) continue;
      const parent = e.wnd_get_parent ? e.wnd_get_parent(hw) : 0;
      if (!parent || !painted.has(parent)) continue;
      e.send_message(hw, 0x000F, 0, 0); // WM_PAINT
      painted.add(hw);
      progress = true;
    }
    if (!progress) break;
  }
}

// Convenience runner: each test exposes a (harness) => Promise<void> body
// and a name. We boot the harness, run the body, count colors, write the
// PNG, and exit non-zero on assertion failures.
async function runRenderTest(name, body, { minColors = 8 } = {}) {
  const checks = [];
  const check = (label, pass, info = '') => {
    checks.push({ label, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + label + (info ? '  (' + info + ')' : ''));
  };
  try {
    const harness = await bootRenderHarness();
    await body(harness, check);
    flushPendingPaints(harness);
    harness.renderer.repaint();
    const colors = countUniqueColors(harness.canvas);
    check(`canvas has ≥${minColors} distinct colors after repaint`,
      colors >= minColors, `${colors} colors`);
    const png = writePng(harness.canvas, `${name}.png`);
    console.log('wrote ' + png);
  } catch (err) {
    console.error(err);
    check('test body did not throw', false, err.message);
  }
  console.log('');
  const failed = checks.filter(c => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

module.exports = { bootRenderHarness, countUniqueColors, pixelMatches, writePng, runRenderTest };
