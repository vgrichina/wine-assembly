const fs = require('fs');
const { parseResources } = require('../lib/resources');
let createCanvas, Win98Renderer;
try {
  createCanvas = require('canvas').createCanvas;
  Win98Renderer = require('../lib/renderer').Win98Renderer;
} catch (_) {}

// Parse args
const args = process.argv.slice(2);
const getArg = (name, def) => { const a = args.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
const hasFlag = name => args.includes(`--${name}`);

const MAX_BATCHES = parseInt(getArg('max-batches', '200'));
const BATCH_SIZE = parseInt(getArg('batch-size', '1000'));
const VERBOSE = hasFlag('verbose');
const TRACE = hasFlag('trace');           // --trace: log every block's EIP
const TRACE_API = hasFlag('trace-api');   // --trace-api: log all API calls with args + return values
const TRACE_SEH = hasFlag('trace-seh');   // --trace-seh: log SEH chain operations
const BREAKPOINT = getArg('break', null); // --break=0xADDR[,0xADDR,...]: break at address(es)
const BREAK_API = getArg('break-api', null); // --break-api=Name[,Name,...]: break on API call
const WATCH_SPEC = getArg('watch', null);    // --watch=0xADDR:LEN: break on memory change
const DUMP_SPEC = getArg('dump', null);   // --dump=0xADDR:LEN: hexdump memory region
const DUMP_SEH = hasFlag('dump-seh');     // --dump-seh: detailed SEH chain dump at end
const EXE_PATH = getArg('exe', 'test/binaries/notepad.exe');
const PNG_OUT = getArg('png', null);     // --png=out.png: render to PNG via node-canvas

const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
const breakAddrs = BREAKPOINT ? BREAKPOINT.split(',').map(s => parseInt(s, 16)) : [];
const breakApis = BREAK_API ? BREAK_API.split(',') : [];

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync(EXE_PATH);

  const logs = [];
  let stopped = false;
  let apiCount = 0;
  let lastApiName = null;  // track last API name for return value correlation
  let inputEvent = null;   // pending input event to inject via check_input

  // Parse resources directly from EXE
  const resourceJson = parseResources(exeBytes);
  console.log('Resources:', Object.keys(resourceJson.menus).length, 'menus,',
    Object.keys(resourceJson.dialogs).length, 'dialogs,',
    Object.keys(resourceJson.strings).length, 'strings');

  // Set up renderer if node-canvas is available
  let renderer = null;
  if (createCanvas && Win98Renderer) {
    const canvas = createCanvas(640, 480);
    renderer = new Win98Renderer(canvas);
    renderer.loadResources(resourceJson);
  }

  const readStr = (mem, ptr, maxLen = 512) => {
    let s = '';
    for (let i = ptr; i < ptr + maxLen; i++) {
      if (!mem[i]) break;
      s += String.fromCharCode(mem[i]);
    }
    return s;
  };

  // String APIs where we want to log content
  const STRING_APIS = ['lstrlenA', 'lstrcpyA', 'lstrcpynA', 'LoadStringA', 'GetWindowTextA', 'SetWindowTextA', 'SetDlgItemTextA'];

  const imports = { host: {
    log: (ptr, len) => {
      const b = new Uint8Array(instance.exports.memory.buffer, ptr, Math.min(len, 256));
      let t = '';
      for (let i = 0; i < b.length && b[i]; i++) t += String.fromCharCode(b[i]);
      apiCount++;

      // Check API breakpoints
      if (breakApis.length && breakApis.some(name => t.includes(name))) {
        apiBreakHit = t;
      }

      if (TRACE_API) {
        const e = instance.exports;
        const esp = e.get_esp();
        const imageBase = e.get_image_base();
        const dv = new DataView(instance.exports.memory.buffer);
        const g2w = addr => addr - imageBase + 0x12000;
        let argStr = '';
        try {
          for (let i = 0; i < 6; i++) {
            const a = dv.getUint32(g2w(esp + 4 + i * 4), true);
            argStr += (i ? ', ' : '') + hex(a);
          }
        } catch (_) {}

        // Log string content for string APIs
        let strInfo = '';
        const matchedApi = STRING_APIS.find(api => t.includes(api));
        if (matchedApi) {
          try {
            const mem = new Uint8Array(instance.exports.memory.buffer);
            // First arg is usually the string pointer
            const strPtr = dv.getUint32(g2w(esp + 4), true);
            const strVal = readStr(mem, g2w(strPtr), 64);
            if (strVal) strInfo = ` str="${strVal}"`;
          } catch (_) {}
        }

        lastApiName = t;
        logs.push(`[API #${apiCount}] ${t}(${argStr})${strInfo}`);
        // Dump MSG struct contents for DispatchMessageA
        if (t.includes('DispatchMessage') && apiCount <= 100) {
          try {
            const msgPtr = dv.getUint32(g2w(esp + 4), true);
            const msgHwnd = dv.getUint32(g2w(msgPtr), true);
            const msgMsg = dv.getUint32(g2w(msgPtr + 4), true);
            const msgWP = dv.getUint32(g2w(msgPtr + 8), true);
            const msgLP = dv.getUint32(g2w(msgPtr + 12), true);
            logs.push(`  MSG: hwnd=0x${msgHwnd.toString(16)} msg=0x${msgMsg.toString(16)} wP=0x${msgWP.toString(16)} lP=0x${msgLP.toString(16)}`);
          } catch (_) {}
        }

        // SEH tracing for _EH_prolog and _CxxThrowException
        if (TRACE_SEH && (t.includes('_EH_prolog') || t.includes('_CxxThrowException'))) {
          const fsBase = e.get_fs_base();
          try {
            const sehHead = dv.getUint32(g2w(fsBase), true);
            logs.push(`  [SEH] fs:[0]=${hex(sehHead)} EBP=${hex(e.get_ebp())}`);
          } catch (_) {}
        }
      } else {
        logs.push('[API] ' + t);
      }
    },
    log_i32: val => {
      if (TRACE_API && lastApiName) {
        // Correlate with last API call as return value
        logs.push(`  => ${hex(val)}`);
        lastApiName = null;
      } else {
        logs.push('[i32] ' + hex(val));
      }
    },
    shell_about: (h, appPtr) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      logs.push(`[ShellAbout] "${readStr(mem, appPtr)}"`);
      return 1;
    },
    message_box: (h, t, c, u) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      logs.push(`[MessageBox] "${readStr(mem, c)}": "${readStr(mem, t)}"`);
      return 1;
    },
    exit: code => { logs.push('[Exit] code=' + code); stopped = true; },
    draw_rect: (x, y, w, h, color) => {
      if (renderer) { const ctx = renderer.ctx; ctx.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0'); ctx.fillRect(x, y, w, h); }
    },
    read_file: () => 0,
    create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      const title = readStr(mem, titlePtr);
      logs.push(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" style=0x${style.toString(16)} pos=${x},${y} size=${cx}x${cy} menu=${menuId}`);
      if (renderer) renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId);
      return hwnd;
    },
    show_window: (hwnd, cmd) => {
      logs.push(`[ShowWindow] hwnd=0x${hwnd.toString(16)} cmd=${cmd}`);
      if (renderer) renderer.showWindow(hwnd, cmd);
      // Inject WM_CLOSE to test exit flow
      if (!inputEvent) {
        inputEvent = { msg: 0x0010, wParam: 0, lParam: 0 };
        logs.push('[test] Injecting WM_CLOSE');
      }
    },
    create_dialog: (hwnd, dlgId) => {
      logs.push(`[CreateDialog] hwnd=0x${hwnd.toString(16)} dlg=${dlgId}`);
      if (renderer) return renderer.createDialog(hwnd, dlgId);
      return hwnd;
    },
    load_string: (id, bufPtr, bufLen) => {
      if (!resourceJson || !resourceJson.strings) return 0;
      const str = resourceJson.strings[id];
      if (!str || bufLen <= 0) return 0;
      const bytes = new Uint8Array(instance.exports.memory.buffer);
      const maxLen = Math.min(str.length, bufLen - 1);
      for (let i = 0; i < maxLen; i++) bytes[bufPtr + i] = str.charCodeAt(i) & 0xFF;
      bytes[bufPtr + maxLen] = 0;
      return maxLen;
    },
    set_window_text: (hwnd, textPtr) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      const text = readStr(mem, textPtr);
      logs.push(`[SetWindowText] "${text}"`);
      if (renderer) renderer.setWindowText(hwnd, text);
    },
    invalidate: (hwnd) => { if (renderer) renderer.invalidate(hwnd); },
    set_menu: (hwnd, menuResId) => {
      logs.push(`[SetMenu] hwnd=0x${hwnd.toString(16)} menu=${menuResId}`);
      if (renderer) renderer.setMenu(hwnd, menuResId);
    },
    draw_text: (x, y, textPtr, textLen, color) => {
      if (!renderer) return;
      const bytes = new Uint8Array(instance.exports.memory.buffer, textPtr, textLen);
      const text = new TextDecoder().decode(bytes);
      const ctx = renderer.ctx;
      ctx.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      ctx.font = renderer.font;
      ctx.fillText(text, x, y);
    },
    check_input: () => {
      if (inputEvent) {
        const evt = inputEvent;
        inputEvent = null;
        const packed = (evt.wParam << 16) | (evt.msg & 0xFFFF);
        logs.push(`[check_input] returning msg=0x${evt.msg.toString(16)} wParam=0x${evt.wParam.toString(16)} packed=0x${packed.toString(16)}`);
        return packed;
      }
      return 0;
    },
    check_input_lparam: () => 0,
    set_window_class: (hwnd, classPtr) => {
      if (renderer) {
        const bytes = new Uint8Array(instance.exports.memory.buffer);
        let s = '';
        for (let i = classPtr; bytes[i] && i < classPtr + 256; i++) s += String.fromCharCode(bytes[i]);
        renderer.setWindowClass(hwnd, s);
      }
    },
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = new Uint8Array(instance.exports.memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  const entry = instance.exports.load_pe(exeBytes.length);
  console.log('PE loaded. Entry: ' + hex(entry));

  const regs = () => {
    const e = instance.exports;
    return `EIP=${hex(e.get_eip())} EAX=${hex(e.get_eax())} ECX=${hex(e.get_ecx())} EDX=${hex(e.get_edx())} EBX=${hex(e.get_ebx())} ESP=${hex(e.get_esp())} EBP=${hex(e.get_ebp())} ESI=${hex(e.get_esi())} EDI=${hex(e.get_edi())}`;
  };

  const g2w = addr => {
    const imageBase = instance.exports.get_image_base();
    return addr - imageBase + 0x12000;
  };

  const dumpStack = (label, count = 14) => {
    try {
      const esp = instance.exports.get_esp();
      const dv = new DataView(instance.exports.memory.buffer);
      console.log(`  ${label || 'Stack'} around ESP=${hex(esp)}:`);
      for (let i = -2; i < count; i++) {
        const addr = esp + i * 4;
        try {
          const val = dv.getUint32(g2w(addr), true);
          const marker = i === 0 ? ' <-- ESP' : '';
          console.log(`    [${hex(addr)}] = ${hex(val)}${marker}`);
        } catch (_) { break; }
      }
    } catch (_) {}
  };

  const disasmAt = (eip, count = 16) => {
    try {
      const dv = new DataView(instance.exports.memory.buffer);
      let bytes = '';
      for (let i = 0; i < count; i++) {
        bytes += dv.getUint8(g2w(eip + i)).toString(16).padStart(2, '0') + ' ';
      }
      console.log(`  Bytes at ${hex(eip)}: ${bytes.trim()}`);
    } catch (_) {
      console.log(`  Cannot read bytes at ${hex(eip)}`);
    }
  };

  const dumpSEH = (detailed) => {
    try {
      const fsBase = instance.exports.get_fs_base();
      const imageBase = instance.exports.get_image_base();
      const dv = new DataView(instance.exports.memory.buffer);
      let ptr = dv.getUint32(g2w(fsBase), true);

      if (detailed) {
        console.log(`\n=== SEH Chain ===`);
        console.log(`FS base (TIB): ${hex(fsBase)}`);
        console.log(`FS:[0x00] SEH head:    ${hex(ptr)}`);
        console.log(`FS:[0x04] Stack top:   ${hex(dv.getUint32(g2w(fsBase + 4), true))}`);
        console.log(`FS:[0x08] Stack bottom:${hex(dv.getUint32(g2w(fsBase + 8), true))}`);
        console.log(`FS:[0x18] Self:        ${hex(dv.getUint32(g2w(fsBase + 0x18), true))}`);
        console.log('\nSEH frames:');
      } else {
        console.log(`  SEH chain (fs_base=${hex(fsBase)}, fs:[0]=${hex(ptr)}):`);
      }

      let depth = 0;
      while (ptr !== 0xFFFFFFFF && ptr !== 0 && depth < 32) {
        const next = dv.getUint32(g2w(ptr), true);
        const handler = dv.getUint32(g2w(ptr + 4), true);

        let extra = '';
        if (detailed) {
          try {
            const frameEbp = ptr + 8;
            const trylevel = dv.getInt32(g2w(frameEbp - 4), true);
            const funcInfo = dv.getUint32(g2w(frameEbp - 8), true);
            if (funcInfo >= imageBase && funcInfo < imageBase + 0x20000) {
              const magic = dv.getUint32(g2w(funcInfo), true);
              if ((magic & 0xFFFFFFF0) === 0x19930520) {
                const nUnwind = dv.getUint32(g2w(funcInfo + 4), true);
                const nTry = dv.getUint32(g2w(funcInfo + 12), true);
                extra = ` [EH_prolog] trylevel=${trylevel} funcInfo=${hex(funcInfo)} magic=${hex(magic)} nUnwind=${nUnwind} nTry=${nTry}`;
                if (nTry > 0) {
                  const tryMapRva = dv.getUint32(g2w(funcInfo + 16), true);
                  for (let t = 0; t < Math.min(nTry, 4); t++) {
                    const tryAddr = tryMapRva + t * 20;
                    const tryLow = dv.getInt32(g2w(tryAddr), true);
                    const tryHigh = dv.getInt32(g2w(tryAddr + 4), true);
                    const catchHigh = dv.getInt32(g2w(tryAddr + 8), true);
                    const nCatch = dv.getInt32(g2w(tryAddr + 12), true);
                    const catchArr = dv.getUint32(g2w(tryAddr + 16), true);
                    extra += `\n      try[${t}]: levels ${tryLow}-${tryHigh}, catchHigh=${catchHigh}, nCatch=${nCatch}`;
                    for (let c = 0; c < Math.min(nCatch, 4); c++) {
                      const catchAddr = catchArr + c * 16;
                      const flags = dv.getUint32(g2w(catchAddr), true);
                      const typeInfo = dv.getUint32(g2w(catchAddr + 4), true);
                      const dispObj = dv.getInt32(g2w(catchAddr + 8), true);
                      const handlerAddr = dv.getUint32(g2w(catchAddr + 12), true);
                      extra += `\n        catch[${c}]: flags=${hex(flags)} type=${hex(typeInfo)} dispObj=${dispObj} handler=${hex(handlerAddr)}`;
                    }
                  }
                }
              }
            }
          } catch (_) {}
        }

        const indent = detailed ? '  ' : '    ';
        console.log(`${indent}[${depth}] ${hex(ptr)}: next=${hex(next)} handler=${hex(handler)}${extra}`);
        ptr = next;
        depth++;
      }
      if (depth === 0) console.log(detailed ? '  (empty — head is 0xFFFFFFFF)' : '    (empty - head is 0xFFFFFFFF)');

      // EBP chain in detailed mode
      if (detailed) {
        console.log('\n=== EBP Chain ===');
        let ebp = instance.exports.get_ebp();
        for (let i = 0; i < 20 && ebp > 0 && ebp < 0x01A00000; i++) {
          const savedEbp = dv.getUint32(g2w(ebp), true);
          const retAddr = dv.getUint32(g2w(ebp + 4), true);
          let ehInfo = '';
          try {
            const funcInfo = dv.getUint32(g2w(ebp - 8), true);
            if (funcInfo >= imageBase && funcInfo < imageBase + 0x20000) {
              const magic = dv.getUint32(g2w(funcInfo), true);
              if ((magic & 0xFFFFFFF0) === 0x19930520) {
                const trylevel = dv.getInt32(g2w(ebp - 4), true);
                ehInfo = ` [EH frame] trylevel=${trylevel} funcInfo=${hex(funcInfo)}`;
              }
            }
          } catch (_) {}
          console.log(`  [${i}] EBP=${hex(ebp)} saved=${hex(savedEbp)} ret=${hex(retAddr)}${ehInfo}`);
          ebp = savedEbp;
        }
      }
    } catch (e) {
      console.log(`  SEH dump error: ${e.message}`);
    }
  };

  const hexdump = (guestAddr, len) => {
    const dv = new DataView(instance.exports.memory.buffer);
    console.log(`Hexdump ${hex(guestAddr)} (${len} bytes):`);
    for (let off = 0; off < len; off += 16) {
      let hexPart = '', ascPart = '';
      for (let i = 0; i < 16 && off + i < len; i++) {
        const b = dv.getUint8(g2w(guestAddr + off + i));
        hexPart += b.toString(16).padStart(2, '0') + ' ';
        ascPart += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
      }
      console.log(`  ${hex(guestAddr + off)}  ${hexPart.padEnd(49)}${ascPart}`);
    }
  };

  let prevEip = 0, stuckCount = 0;
  let stepping = false;  // single-step mode after breakpoint
  let apiBreakHit = null; // set when an API breakpoint triggers

  // Watchpoint: snapshot memory region to detect changes
  let watchAddr = 0, watchLen = 0, watchSnapshot = null;
  if (WATCH_SPEC) {
    const [addrStr, lenStr] = WATCH_SPEC.split(':');
    watchAddr = parseInt(addrStr, 16);
    watchLen = parseInt(lenStr) || 4;
    console.log(`Watchpoint set: ${hex(watchAddr)} (${watchLen} bytes)`);
  }

  const takeWatchSnapshot = () => {
    if (!watchLen) return null;
    try {
      const off = g2w(watchAddr);
      return Buffer.from(instance.exports.memory.buffer.slice(off, off + watchLen));
    } catch (_) { return null; }
  };

  const checkWatchpoint = (batch) => {
    if (!watchLen) return false;
    const cur = takeWatchSnapshot();
    if (!cur || !watchSnapshot) { watchSnapshot = cur; return false; }
    if (cur.equals(watchSnapshot)) return false;
    console.log(`\n*** WATCHPOINT hit at batch ${batch}: memory at ${hex(watchAddr)} changed`);
    console.log('  Old:', watchSnapshot.toString('hex'));
    console.log('  New:', cur.toString('hex'));
    watchSnapshot = cur;
    return true;
  };

  if (watchLen) watchSnapshot = takeWatchSnapshot();

  const debugPrompt = async (reason) => {
    console.log('  ' + regs());
    dumpStack(reason);
    disasmAt(instance.exports.get_eip());
    if (TRACE_SEH) dumpSEH();
    while (logs.length) console.log(logs.shift());
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve =>
      rl.question('[s]tep / [c]ontinue / [d]ump ADDR:LEN / [r]egs / [q]uit > ', resolve)
    );
    rl.close();
    const cmd = answer.trim().toLowerCase();
    if (cmd === 'q') { process.exit(0); }
    if (cmd === 'c') { stepping = false; return; }
    if (cmd === 's' || cmd === '') { stepping = true; return; }
    if (cmd === 'r') { console.log(regs()); return debugPrompt(reason); }
    if (cmd.startsWith('d')) {
      const parts = cmd.slice(1).trim().split(':');
      const addr = parseInt(parts[0], 16);
      const len = parseInt(parts[1]) || 64;
      if (!isNaN(addr)) hexdump(addr, len);
      return debugPrompt(reason);
    }
    stepping = true;
  };

  for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
    const eipBefore = instance.exports.get_eip();

    // Breakpoint check (EIP)
    if (breakAddrs.length && breakAddrs.includes(eipBefore)) {
      console.log(`\n*** BREAKPOINT hit at ${hex(eipBefore)} (batch ${batch})`);
      stepping = true;
      await debugPrompt('Break');
    }

    // Single-step mode
    if (stepping) {
      console.log(`[${batch}] EIP=${hex(eipBefore)}`);
      await debugPrompt('Step');
    }

    if (TRACE) {
      console.log(`[${batch}] >> ${hex(eipBefore)} ESP=${hex(instance.exports.get_esp())}`);
    }

    try {
      instance.exports.run(BATCH_SIZE);
    } catch (e) {
      while (logs.length) console.log(logs.shift());
      console.log(`\n*** CRASH at batch ${batch}: ${e.message}`);
      console.log('  EIP before batch: ' + hex(eipBefore));
      try { console.log('  thread_alloc: ' + hex(instance.exports.get_thread_alloc())); } catch (_) {}
      console.log('  ' + regs());
      disasmAt(eipBefore);
      disasmAt(instance.exports.get_eip());
      dumpStack();
      if (TRACE_SEH) dumpSEH();
      // Show WASM stack trace
      const frames = e.stack.split('\n').filter(l => l.includes('wasm-function'));
      if (frames.length) {
        console.log('  WASM stack:');
        frames.slice(0, 8).forEach(f => console.log('    ' + f.trim()));
      }
      process.exit(1);
    }

    // Watchpoint check
    if (checkWatchpoint(batch)) {
      stepping = true;
      await debugPrompt('Watch');
    }

    // API breakpoint check (might have been set during batch)
    if (apiBreakHit) {
      while (logs.length) console.log(logs.shift());
      console.log(`\n*** API BREAKPOINT: ${apiBreakHit} (batch ${batch})`);
      apiBreakHit = null;
      stepping = true;
      await debugPrompt('API Break');
    }

    // Flush logs
    while (logs.length) console.log(logs.shift());

    const eip = instance.exports.get_eip();
    if (VERBOSE) {
      console.log(`[${batch}] ${regs()}`);
    } else if (eip !== prevEip) {
      console.log(`[${batch}] ${regs()}`);
      prevEip = eip;
      stuckCount = 0;
    } else {
      stuckCount++;
      if (stuckCount > 10) {
        console.log(`STUCK at EIP=${hex(eip)} after ${stuckCount} batches`);
        dumpStack();
        break;
      }
    }
  }

  if (!stopped) {
    console.log('\n--- Final state ---');
    console.log(regs());
  }

  console.log(`\nStats: ${apiCount} API calls, ${MAX_BATCHES} batches`);

  // --dump: hexdump memory region
  if (DUMP_SPEC) {
    const [addrStr, lenStr] = DUMP_SPEC.split(':');
    const dumpAddr = parseInt(addrStr, 16);
    const dumpLen = parseInt(lenStr) || 256;
    hexdump(dumpAddr, dumpLen);
  }

  // SEH dump at end
  if (DUMP_SEH || TRACE_SEH) {
    dumpSEH(true);
  }

  // Output PNG if requested and renderer is available
  if (PNG_OUT && renderer) {
    renderer.repaint();
    const pngBuf = renderer.canvas.toBuffer('image/png');
    fs.writeFileSync(PNG_OUT, pngBuf);
    console.log(`Wrote ${PNG_OUT} (${pngBuf.length} bytes)`);
  }
}

main().catch(e => console.error(e));
