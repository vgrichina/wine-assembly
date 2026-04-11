#!/usr/bin/env node
// tools/headless-run.js — minimal universal runner.
//
// Thin alternative to test/run.js: compiles (or loads) the wasm, boots an
// EXE, pumps the batch loop, drives scripted input, and dumps a PNG. No
// debug cruft, no breakpoints, no API tracing. Use this when test/run.js
// is inconvenient (e.g. carrying experimental patches) or as a scaffold
// for targeted repros.
//
// Flags:
//   --exe=PATH                       required
//   --png=PATH                       final snapshot
//   --max-batches=N                  (default 500)
//   --batch-size=N                   (default 1000)
//   --screen=WxH                     (default 640x480)
//   --no-build                       use build/wine-assembly.wasm as-is
//   --no-close                       don't auto-inject WM_CLOSE on ShowWindow
//   --winver=win98|nt4|win2k|winxp|0xHEX
//   --args="extra cmdline"
//   --dlls=a.dll,b.dll               override DLL autoload
//   --verbose                        log registers each batch
//   --stuck-after=N                  bail after N identical-EIP batches (default 20)
//   --input=SPEC[,SPEC...]           scheduled events (see below)
//
// Input specs (all prefixed with the batch number at which they fire):
//   B:MSG:WPARAM[:LPARAM]            raw message via check_input (hwnd=main)
//   B:cmd:ID                         WM_COMMAND shortcut (== B:0x111:ID)
//   B:png:PATH                       write a snapshot PNG
//   B:click:X:Y                      mouseDown+Up at canvas (X,Y)
//   B:mousedown:X:Y / mouseup / mousemove
//   B:keypress:CHARCODE              renderer.handleKeyPress
//   B:keydown:VK / keyup:VK          renderer.handleKeyDown/Up
//   B:send:HWND:MSG:W:L              send_message directly to a WAT hwnd
//   B:set-edit:CTRL_ID:TEXT          find class-2 edit by id, WM_SETTEXT
//   B:dlg-cmd:CMD_ID                 WM_COMMAND to the topmost non-main window
//   B:quit                           stop the loop cleanly

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { loadDlls, detectRequiredDlls } = require('../lib/dll-loader');
const { compileWat } = require('../lib/compile-wat');

let createCanvas, Win98Renderer;
try {
  createCanvas = require('canvas').createCanvas;
  Win98Renderer = require('../lib/renderer').Win98Renderer;
} catch (_) {}

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const args = process.argv.slice(2);
const getArg = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const hasFlag = n => args.includes(`--${n}`);

const EXE_PATH    = getArg('exe', null);
const PNG_OUT     = getArg('png', null);
const MAX_BATCHES = parseInt(getArg('max-batches', '500'));
const BATCH_SIZE  = parseInt(getArg('batch-size', '1000'));
const [SCREEN_W, SCREEN_H] = (getArg('screen', '640x480')).split('x').map(Number);
const NO_BUILD    = hasFlag('no-build');
const NO_CLOSE    = hasFlag('no-close');
const VERBOSE     = hasFlag('verbose');
const STUCK_AFTER = parseInt(getArg('stuck-after', '20'));
const WINVER      = getArg('winver', null);
const EXTRA_ARGS  = getArg('args', null);
const DLL_OVERRIDE = getArg('dlls', null);
const INPUT_SPEC  = getArg('input', null);

if (!EXE_PATH) { console.error('usage: node tools/headless-run.js --exe=PATH [--png=OUT] [--input=SPEC]'); process.exit(2); }
if (!fs.existsSync(EXE_PATH)) { console.error(`exe not found: ${EXE_PATH}`); process.exit(2); }

const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

// ---- parse --input spec ----
// Each comma-separated chunk: BATCH:KIND[:...]. KIND may be a hex msg id.
function parseInputSpec(spec) {
  if (!spec) return [];
  const out = [];
  for (const chunk of spec.split(',')) {
    const p = chunk.split(':');
    const batch = parseInt(p[0]);
    const kind = p[1];
    if (kind === 'png')        out.push({ batch, action: 'png', path: p.slice(2).join(':') });
    else if (kind === 'click') out.push({ batch, action: 'click', x: +p[2], y: +p[3] });
    else if (kind === 'mousedown') out.push({ batch, action: 'mousedown', x: +p[2], y: +p[3] });
    else if (kind === 'mouseup')   out.push({ batch, action: 'mouseup', x: +p[2], y: +p[3] });
    else if (kind === 'mousemove') out.push({ batch, action: 'mousemove', x: +p[2], y: +p[3] });
    else if (kind === 'keypress')  out.push({ batch, action: 'keypress', code: parseInt(p[2]) });
    else if (kind === 'keydown')   out.push({ batch, action: 'keydown', code: parseInt(p[2]) });
    else if (kind === 'keyup')     out.push({ batch, action: 'keyup', code: parseInt(p[2]) });
    else if (kind === 'cmd')       out.push({ batch, action: 'msg', msg: 0x111, wParam: parseInt(p[2]), lParam: 0 });
    else if (kind === 'send')      out.push({ batch, action: 'send', hwnd: parseInt(p[2]), msg: parseInt(p[3]), wParam: parseInt(p[4]||'0'), lParam: parseInt(p[5]||'0') });
    else if (kind === 'set-edit')  out.push({ batch, action: 'set-edit', ctrlId: parseInt(p[2]), text: p.slice(3).join(':') });
    else if (kind === 'dlg-cmd')   out.push({ batch, action: 'dlg-cmd', cmdId: parseInt(p[2]) });
    else if (kind === 'quit')      out.push({ batch, action: 'quit' });
    else {
      const msg = parseInt(kind);
      if (Number.isNaN(msg)) { console.error(`bad input spec: ${chunk}`); process.exit(2); }
      out.push({ batch, action: 'msg', msg, wParam: parseInt(p[2]||'0'), lParam: parseInt(p[3]||'0') });
    }
  }
  out.sort((a, b) => a.batch - b.batch);
  return out;
}

async function main() {
  // Compile or load wasm
  let wasmBytes;
  const prebuilt = path.join(ROOT, 'build', 'wine-assembly.wasm');
  if (NO_BUILD && fs.existsSync(prebuilt)) {
    wasmBytes = fs.readFileSync(prebuilt);
  } else {
    wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  }

  const exeBytes = fs.readFileSync(EXE_PATH);
  const scheduledInput = parseInputSpec(INPUT_SPEC);

  // Renderer
  let renderer = null;
  if (createCanvas && Win98Renderer) {
    renderer = new Win98Renderer(createCanvas(SCREEN_W, SCREEN_H));
  }

  // Host imports context
  let stopped = false;
  const apiTable = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'api_table.json'), 'utf8'));
  const ctx = {
    getMemory: () => ctx._memory ? ctx._memory.buffer : null,
    renderer,
    apiTable,
    verbose: VERBOSE,
    onExit: () => { stopped = true; },
    trace: new Set(),
    readFile: (name) => {
      const exeDir = path.dirname(EXE_PATH);
      for (const p of [path.join(exeDir, name), path.join(exeDir, path.basename(name)),
                       path.join(ROOT, 'test', 'binaries', 'help', path.basename(name))]) {
        try { return new Uint8Array(fs.readFileSync(p)); } catch (_) {}
      }
      return null;
    },
  };
  const base = createHostImports(ctx);
  const h = base.host;

  // Input queue — holds raw {msg,wParam,lParam,hwnd} events delivered via
  // check_input. Menu selections and scripted messages go here.
  let pendingEvent = null;
  let lastEvent = null;
  const queue = [];

  h.check_input = () => {
    let evt = pendingEvent;
    if (evt) pendingEvent = null;
    else if (queue.length) evt = queue.shift();
    else if (renderer) evt = renderer.checkInput();
    if (!evt) return 0;
    lastEvent = evt;
    return ((evt.wParam & 0xFFFF) << 16) | (evt.msg & 0xFFFF);
  };
  h.check_input_hwnd = () => {
    if (!lastEvent) return 0;
    if (lastEvent.hwnd) return lastEvent.hwnd;
    const m = lastEvent.msg;
    if (m >= 0x100 && m <= 0x108) return 0x10002; // keyboard → edit child default
    return 0;
  };
  h.check_input_lparam = () => (lastEvent ? (lastEvent.lParam || 0) : 0);
  h.get_async_key_state = (vk) => (renderer ? renderer.getAsyncKeyState(vk) : 0);

  // Deterministic tick derived from batch counter — same approach as run.js.
  const tickState = { batch: 0, callsInBatch: 0 };
  h.get_ticks = () => (((tickState.batch * 200 + tickState.callsInBatch++) & 0x7FFFFFFF));

  h.exit = (code) => { stopped = true; };

  // Shared memory
  const memory = new WebAssembly.Memory({ initial: 1024 });
  ctx._memory = memory;
  h.memory = memory;

  // COM/LoadLibrary yields need a ThreadManager import on the host side —
  // we're not implementing threads in this runner, so stub them out. Apps
  // that actually spawn threads aren't supported by headless-run.
  const notSupported = () => 0;
  h.create_thread = notSupported;
  h.exit_thread = () => {};
  h.create_event = notSupported;
  h.set_event = notSupported;
  h.reset_event = notSupported;
  h.wait_single = () => 0;
  h.com_create_instance = () => 0x80004002; // E_NOINTERFACE
  h.has_dll_file = (nameWA) => {
    const m8 = new Uint8Array(memory.buffer);
    let s = '';
    for (let i = 0; i < 260 && m8[nameWA + i]; i++) s += String.fromCharCode(m8[nameWA + i]);
    const base = s.split('\\').pop().toLowerCase();
    for (const dir of [path.dirname(EXE_PATH), path.join(ROOT, 'test', 'binaries', 'dlls')]) {
      if (fs.existsSync(path.join(dir, base))) return 1;
    }
    return 0;
  };

  // Log override: auto-inject WM_CLOSE when the main window is first shown
  // (unless --no-close or the user's --input is driving events). Mirrors
  // run.js's behavior so short-lived test runs exit cleanly.
  let installingFiles = false;
  h.show_window = (hwnd, cmd) => {
    if (renderer) renderer.showWindow(hwnd, cmd);
    if (!pendingEvent && queue.length === 0 && !INPUT_SPEC && !NO_CLOSE) {
      pendingEvent = { msg: 0x0010, wParam: 0, lParam: 0 }; // WM_CLOSE
    }
  };

  // Minimal window-state plumbing the renderer needs
  const readStr = base.readStr;
  h.create_window = (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
    if (renderer) renderer.createWindow(hwnd, style, x, y, cx, cy, readStr(titlePtr), menuId);
    return hwnd;
  };
  h.dialog_loaded = (hwnd, parentHwnd) => { if (renderer) renderer.createDialog(hwnd, parentHwnd); };
  h.set_window_text = (hwnd, textPtr) => {
    const t = readStr(textPtr);
    if (renderer) renderer.setWindowText(hwnd, t);
    if (t.includes('Installing')) installingFiles = true;
  };
  h.set_menu = (hwnd, menuResId) => { if (renderer) renderer.setMenu(hwnd, menuResId); };
  h.set_dlg_item_text = (hwnd, ctrlId, textPtr) => {
    if (renderer) renderer.setDlgItemText(hwnd, ctrlId, readStr(textPtr));
  };
  h.message_box = () => 1;
  h.shell_about = () => 1;

  // Instantiate
  const mod = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(mod, { host: h });
  ctx.exports = instance.exports;
  if (renderer) { renderer.wasm = instance; renderer.wasmMemory = memory; }

  // Load PE
  const mem = new Uint8Array(memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  const entry = instance.exports.load_pe(exeBytes.length);
  console.log('PE entry:', hex(entry));

  if (instance.exports.set_exe_name) {
    const name = Buffer.from(path.basename(EXE_PATH));
    const staging = instance.exports.get_staging();
    mem.set(name, staging);
    instance.exports.set_exe_name(staging, name.length);
  }
  if (EXTRA_ARGS && instance.exports.set_extra_cmdline) {
    const b = Buffer.from(EXTRA_ARGS);
    const staging = instance.exports.get_staging();
    mem.set(b, staging);
    instance.exports.set_extra_cmdline(staging, b.length);
  }
  if (WINVER && instance.exports.set_winver) {
    const versions = { win98: 0xC0000A04, nt4: 0x05650004, win2k: 0x05650005, winxp: 0x0A280105 };
    const v = versions[WINVER.toLowerCase()] || parseInt(WINVER);
    if (v) instance.exports.set_winver(v);
  }

  // DLL autoload (same dirs as run.js)
  const dllDir = path.join(path.dirname(EXE_PATH), 'dlls');
  let dlls;
  if (DLL_OVERRIDE) {
    dlls = DLL_OVERRIDE.split(',').map(p => ({ name: path.basename(p.trim()), bytes: fs.readFileSync(p.trim()) }));
  } else {
    const LOADABLE = new Set(['msvcrt.dll','mfc42.dll','mfc42u.dll','comctl32.dll','msvcp60.dll','riched20.dll','cabinet.dll','usp10.dll','cards.dll']);
    const required = detectRequiredDlls(exeBytes);
    const dirs = [dllDir, path.dirname(EXE_PATH), path.join(ROOT, 'test', 'binaries', 'dlls')];
    dlls = [];
    for (const name of required) {
      if (!LOADABLE.has(name.toLowerCase())) continue;
      for (const dir of dirs) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) { dlls.push({ name, bytes: fs.readFileSync(p) }); break; }
      }
    }
  }
  if (dlls.length) {
    loadDlls(instance.exports, memory.buffer, exeBytes, dlls, VERBOSE ? console.log : () => {}, {
      exeName: path.basename(EXE_PATH), extraArgs: EXTRA_ARGS || '',
    });
  }

  // VFS seed: EXE itself + files from its directory
  if (ctx.vfs) {
    const exeData = new Uint8Array(exeBytes);
    const exeName = path.basename(EXE_PATH).toLowerCase();
    ctx.vfs.files.set('c:\\app.exe', { data: exeData, attrs: 0x20 });
    ctx.vfs.files.set('c:\\' + exeName, { data: exeData, attrs: 0x20 });
    const exeDir = path.dirname(EXE_PATH);
    const loadDir = (host, prefix) => {
      for (const f of fs.readdirSync(host)) {
        if (prefix === 'c:\\' && f.toLowerCase() === exeName) continue;
        const fp = path.join(host, f);
        try {
          const st = fs.statSync(fp);
          if (st.isFile()) ctx.vfs.files.set(prefix + f.toLowerCase(), { data: new Uint8Array(fs.readFileSync(fp)), attrs: 0x20 });
          else if (st.isDirectory()) { const sub = prefix + f.toLowerCase() + '\\'; ctx.vfs.dirs.add(sub); loadDir(fp, sub); }
        } catch (_) {}
      }
    };
    try { loadDir(exeDir, 'c:\\'); } catch (_) {}
  }

  // ---- Batch loop ----
  const dispatchScheduled = (batch) => {
    while (scheduledInput.length && scheduledInput[0].batch <= batch) {
      const ev = scheduledInput.shift();
      if (ev.action === 'msg') {
        queue.push({ msg: ev.msg, wParam: ev.wParam, lParam: ev.lParam });
        console.log(`[input b${batch}] msg=${hex(ev.msg)} wP=${hex(ev.wParam)} lP=${hex(ev.lParam)}`);
      } else if (ev.action === 'send' && instance.exports.send_message) {
        instance.exports.send_message(ev.hwnd, ev.msg, ev.wParam, ev.lParam);
        console.log(`[input b${batch}] send hwnd=${hex(ev.hwnd)} msg=${hex(ev.msg)}`);
      } else if (ev.action === 'click' && renderer) {
        renderer.handleMouseDown(ev.x, ev.y); renderer.handleMouseUp(ev.x, ev.y);
        console.log(`[input b${batch}] click ${ev.x},${ev.y}`);
      } else if (ev.action === 'mousedown' && renderer) renderer.handleMouseDown(ev.x, ev.y);
      else if (ev.action === 'mouseup' && renderer) renderer.handleMouseUp(ev.x, ev.y);
      else if (ev.action === 'mousemove' && renderer) renderer.handleMouseMove(ev.x, ev.y);
      else if (ev.action === 'keypress' && renderer && renderer.handleKeyPress) renderer.handleKeyPress(ev.code);
      else if (ev.action === 'keydown' && renderer && renderer.handleKeyDown) renderer.handleKeyDown(ev.code);
      else if (ev.action === 'keyup' && renderer && renderer.handleKeyUp) renderer.handleKeyUp(ev.code);
      else if (ev.action === 'set-edit') {
        const we = instance.exports;
        let edit = 0;
        for (let s = 0; s < 256; s++) {
          const hwnd = we.wnd_slot_hwnd ? we.wnd_slot_hwnd(s) : 0;
          if (!hwnd) continue;
          if (we.ctrl_get_class(hwnd) === 2 && we.ctrl_get_id(hwnd) === ev.ctrlId) { edit = hwnd; break; }
        }
        if (!edit) console.log(`[input b${batch}] set-edit id=${ev.ctrlId} NOT FOUND`);
        else {
          const g = we.guest_alloc(ev.text.length + 1);
          const wa = g - we.get_image_base() + 0x12000;
          const u8 = new Uint8Array(memory.buffer);
          for (let i = 0; i < ev.text.length; i++) u8[wa + i] = ev.text.charCodeAt(i);
          u8[wa + ev.text.length] = 0;
          we.send_message(edit, 0x000C, 0, g); // WM_SETTEXT
          console.log(`[input b${batch}] set-edit id=${ev.ctrlId} "${ev.text}" hwnd=${hex(edit)}`);
        }
      }
      else if (ev.action === 'dlg-cmd') {
        const we = instance.exports;
        const main = we.get_main_hwnd ? we.get_main_hwnd() : 0;
        let dlg = 0;
        for (let s = 0; s < 256; s++) {
          const hwnd = we.wnd_slot_hwnd ? we.wnd_slot_hwnd(s) : 0;
          if (!hwnd || hwnd === main) continue;
          if (we.wnd_next_child_slot && we.wnd_next_child_slot(hwnd, 0) !== -1) { dlg = hwnd; break; }
        }
        if (!dlg) console.log(`[input b${batch}] dlg-cmd id=${ev.cmdId} NO DIALOG`);
        else {
          we.send_message(dlg, 0x0111, ev.cmdId, 0);
          console.log(`[input b${batch}] dlg-cmd id=${ev.cmdId} hwnd=${hex(dlg)}`);
        }
      }
      else if (ev.action === 'png' && renderer && renderer.canvas) {
        renderer.repaint();
        fs.writeFileSync(ev.path, renderer.canvas.toBuffer('image/png'));
        console.log(`[input b${batch}] png ${ev.path}`);
      } else if (ev.action === 'quit') { stopped = true; }
    }
  };

  const handleYields = () => {
    const e = instance.exports;
    if (e.get_yield_reason && e.get_yield_reason() === 3) {
      // COM DLL load not supported here — fail class-not-reg
      e.set_eax && e.set_eax(0x80040154);
      e.set_esp && e.set_esp(e.get_esp() + 24);
      e.clear_yield && e.clear_yield();
    }
    if (e.get_yield_reason && e.get_yield_reason() === 5) {
      // LoadLibraryA — try to resolve the DLL from host fs/VFS
      const nameWA = e.get_loadlib_name ? e.get_loadlib_name() : 0;
      const m8 = new Uint8Array(memory.buffer);
      let name = '';
      for (let i = 0; i < 260 && m8[nameWA + i]; i++) name += String.fromCharCode(m8[nameWA + i]);
      const base = name.split('\\').pop().toLowerCase();
      let data = null;
      for (const dir of [path.join(ROOT, 'test', 'binaries', 'dlls'), path.dirname(EXE_PATH)]) {
        const p = path.join(dir, base);
        if (fs.existsSync(p)) { data = new Uint8Array(fs.readFileSync(p)); break; }
      }
      if (data) {
        const { loadDll, patchDllImports } = require('../lib/dll-loader');
        const r = loadDll(instance.exports, memory.buffer, data);
        patchDllImports(instance.exports, memory.buffer, [{ name: base, bytes: data }], [r], () => {});
        e.set_eax(r.loadAddr);
      } else {
        e.set_eax(0);
      }
      e.clear_yield();
    }
  };

  let prevEip = -1, stuck = 0;
  for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
    tickState.batch = batch; tickState.callsInBatch = 0;
    dispatchScheduled(batch);
    try {
      instance.exports.run(BATCH_SIZE);
    } catch (e) {
      console.log(`\n*** CRASH at batch ${batch}: ${e.message}`);
      console.log('  EIP:', hex(instance.exports.get_eip()));
      console.log(e.stack.split('\n').slice(0, 10).join('\n'));
      process.exit(1);
    }
    if (renderer && renderer.flushRepaint) renderer.flushRepaint();
    handleYields();

    const eip = instance.exports.get_eip();
    if (VERBOSE) console.log(`[b${batch}] EIP=${hex(eip)}`);
    if (eip === prevEip) {
      stuck++;
      if (stuck > STUCK_AFTER && !scheduledInput.length && !queue.length) {
        console.log(`stuck at ${hex(eip)} after ${stuck} batches`);
        break;
      }
    } else { stuck = 0; prevEip = eip; }
  }

  if (PNG_OUT && renderer) {
    renderer.repaint();
    fs.writeFileSync(PNG_OUT, renderer.canvas.toBuffer('image/png'));
    console.log(`wrote ${PNG_OUT}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
