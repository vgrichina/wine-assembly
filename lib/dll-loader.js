// Shared DLL loading logic for test harness and web host
// Works with both Node.js (Buffer) and browser (Uint8Array)

function readU32(buf, off) {
  if (buf.readUInt32LE) return buf.readUInt32LE(off);
  return buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24);
}

function readStr(mem, wasmAddr, max) {
  let s = '';
  for (let i = 0; i < (max || 256); i++) {
    const ch = mem[wasmAddr + i];
    if (!ch) break;
    s += String.fromCharCode(ch);
  }
  return s;
}

/**
 * Load a DLL into the WASM emulator's guest memory.
 * @param {object} exports - WASM instance exports
 * @param {ArrayBuffer} memory - WASM memory buffer
 * @param {Uint8Array} dllBytes - raw DLL file bytes
 * @returns {{loadAddr: number, dllMain: number}}
 */
function loadDll(exports, memory, dllBytes) {
  const staging = exports.get_staging();
  const stagingSize = exports.get_staging_size ? exports.get_staging_size() >>> 0 : 0x00200000;
  if (dllBytes.length > stagingSize) {
    throw new RangeError(`DLL is ${dllBytes.length} bytes; PE staging capacity is ${stagingSize} bytes`);
  }
  new Uint8Array(memory, staging, dllBytes.length).set(dllBytes);
  const loadAddr = exports.get_next_dll_addr();
  const dllMain = exports.load_dll(dllBytes.length, loadAddr);
  return { loadAddr, dllMain };
}

/**
 * After loading DLLs, patch the EXE's IAT entries to point to loaded DLL code.
 * Reads import descriptors from the original EXE bytes (PE headers aren't in guest memory).
 * @param {object} exports - WASM instance exports
 * @param {ArrayBuffer} memory - WASM memory buffer
 * @param {Uint8Array} exeBytes - original EXE file bytes
 * @param {function} [log] - optional logging function
 */
function nameMatches(importName, expName, fileName) {
  const a = importName.toLowerCase();
  const b = expName.toLowerCase();
  if (a === b) return true;
  if (a.replace('.dll', 'u.dll') === b) return true;
  if (a === b.replace('u.dll', '.dll')) return true;
  // Mingw-style: file name is "SDL.dll" but internal export name is "libSDL.dll".
  // Match by the loaded filename too (case-insensitive).
  if (fileName && a === fileName.toLowerCase()) return true;
  return false;
}

function patchExeImports(exports, memory, exeBytes, dlls, log) {
  const imageBase = exports.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;
  const dv = new DataView(memory);

  // Read import RVA from original EXE PE header. A 16-bit NE task has no such
  // header, and the word this reads as an import RVA is segment data — walking
  // it runs off the end of memory. Its imports are NE fixups, resolved by the
  // WAT loader.
  const peOff = readU32(exeBytes, 0x3C);
  if (peOff + 4 > exeBytes.length || readU32(exeBytes, peOff) !== 0x00004550) return;
  const importRva = readU32(exeBytes, peOff + 128);
  if (!importRva) return;

  // Walk import descriptors from guest memory (sections ARE mapped)
  let descWa = g2w(imageBase + importRva);
  while (true) {
    const iltRva = dv.getUint32(descWa, true);
    const nameRva = dv.getUint32(descWa + 12, true);
    if (iltRva === 0 && nameRva === 0) break;

    const dllName = readStr(new Uint8Array(memory), g2w(imageBase + nameRva));

    // Check each loaded DLL for a match
    const dllCount = exports.get_dll_count();
    for (let di = 0; di < dllCount; di++) {
      const tblPtr = exports.get_dll_table() + di * 32;
      const dllLoadAddr = dv.getUint32(tblPtr, true);
      const expRva = dv.getUint32(tblPtr + 8, true);
      if (expRva === 0) continue;

      const expDirWa = g2w(dllLoadAddr + expRva);
      const expNameRva = dv.getUint32(expDirWa + 12, true);
      const expName = readStr(new Uint8Array(memory), g2w(dllLoadAddr + expNameRva));
      const fileName = dlls && dlls[di] && dlls[di].name;

      if (nameMatches(dllName, expName, fileName)) {
        if (log) log(`Patching EXE imports: ${dllName} -> DLL #${di} (${expName})`);
        // Pass import descriptor's own name so WASM name matching works
        exports.patch_caller_iat(imageBase, importRva, imageBase + nameRva, di);
        break;
      }
    }
    descWa += 20;
  }
}

/**
 * Patch DLL-to-DLL imports (e.g. MFC42→MSVCRT).
 * For each loaded DLL, walk its import descriptors and resolve imports from
 * other loaded DLLs using the same patch_caller_iat WASM function.
 */
function patchDllImports(exports, memory, dlls, results, log) {
  const imageBase = exports.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;
  const dv = new DataView(memory);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const dllBytes = dlls[i].bytes;

    // Read import directory RVA from DLL's PE header
    const peOff = readU32(dllBytes, 0x3C);
    const importRva = readU32(dllBytes, peOff + 128);
    if (!importRva) continue;

    // Walk this DLL's import descriptors (in guest memory, already loaded)
    let descWa = g2w(r.loadAddr + importRva);
    while (true) {
      const iltRva = dv.getUint32(descWa, true);
      const nameRva = dv.getUint32(descWa + 12, true);
      if (iltRva === 0 && nameRva === 0) break;

      const importedDllName = readStr(new Uint8Array(memory), g2w(r.loadAddr + nameRva));

      // Find matching loaded DLL
      const dllCount = exports.get_dll_count();
      for (let di = 0; di < dllCount; di++) {
        const tblPtr = exports.get_dll_table() + di * 32;
        const dllLoadAddr = dv.getUint32(tblPtr, true);
        if (dllLoadAddr === r.loadAddr) continue; // skip self
        const expRva = dv.getUint32(tblPtr + 8, true);
        if (expRva === 0) continue;

        const expDirWa = g2w(dllLoadAddr + expRva);
        const expNameRva = dv.getUint32(expDirWa + 12, true);
        const expName = readStr(new Uint8Array(memory), g2w(dllLoadAddr + expNameRva));

        const targetFileName = dlls && dlls[di] && dlls[di].name;
        if (nameMatches(importedDllName, expName, targetFileName)) {
          if (log) log(`Patching DLL imports: ${dlls[i].name}→${importedDllName} -> DLL #${di} (${expName})`);
          exports.patch_caller_iat(r.loadAddr, importRva, r.loadAddr + nameRva, di);
          break;
        }
      }
      descWa += 20;
    }
  }
}

/**
 * Load all required DLLs for an EXE and patch imports.
 * @param {object} exports - WASM instance exports
 * @param {ArrayBuffer} memory - WASM memory buffer
 * @param {Uint8Array} exeBytes - original EXE bytes
 * @param {Array<{name: string, bytes: Uint8Array}>} dlls - DLL files to load (in order)
 * @param {function} [log] - optional logging function
 * @returns {Array<{name: string, loadAddr: number, dllMain: number, origBase: number}>}
 */
function loadDlls(exports, memory, exeBytes, dlls, log, options = {}) {
  const results = [];
  for (const dll of dlls) {
    const { loadAddr, dllMain } = loadDll(exports, memory, dll.bytes);
    const thunks = exports.get_num_thunks();
    const peOff = readU32(dll.bytes, 0x3C);
    const origBase = readU32(dll.bytes, peOff + 52);
    if (log) log(`DLL: ${dll.name} at 0x${loadAddr.toString(16)}, DllMain=0x${(dllMain>>>0).toString(16)}, thunks=${thunks}, origBase=0x${origBase.toString(16)}`);
    results.push({ name: dll.name, loadAddr, dllMain, origBase });
  }
  patchExeImports(exports, memory, exeBytes, dlls, log);

  // Patch DLL-to-DLL imports (e.g. MFC42→MSVCRT)
  patchDllImports(exports, memory, dlls, results, log);

  if (log) log(`After patching: ${exports.get_num_thunks()} thunks`);

  // Register per-module resources before DllMain / exported initializers run.
  // Win32 LoadBitmap(hInstance, id) can resolve resources from an already
  // mapped module; CARDS!cdtInit depends on this to discover 71x96 cards.
  if (options && typeof options.registerDllResources === 'function') {
    options.registerDllResources(dlls, results);
  }

  // These DLLs came from the EXE's import graph, so Windows treats them as
  // static startup loads.  For DLL_PROCESS_ATTACH that distinction is carried
  // in lpReserved: non-NULL here, NULL for a later LoadLibrary call.  Some old
  // DLLs (notably StarCraft's Storm.dll) select different initialization paths
  // from this value.
  // Must happen after import patching so DLLs can call system APIs.
  for (const r of results) {
    if (r.dllMain) {
      callDllMain(exports, r.loadAddr, r.dllMain, log, { lpReserved: 1 });
    }
  }

  // Win9x card games normally call CARDS!cdtInit before the first draw.
  // Some Entertainment Pack binaries start painting through cdtDrawExt before
  // that import is reached under our cooperative startup path, leaving the
  // DLL's internal card width/height globals at zero. Prime CARDS.dll once so
  // its own exported draw functions have valid geometry.
  const cards = results.find(r => r.name.toLowerCase() === 'cards.dll');
  if (cards && exports.guest_alloc) {
    initCardsDll(exports, memory, cards.loadAddr, log);
  }

  // Seal thunks AFTER DllMain (DllMain may create new thunks via LoadLibrary)
  if (exports.seal_thunks) exports.seal_thunks();

  // Patch msvcrt globals that DllMain may not set (e.g. _wcmdln for GUI apps)
  const msvcrt = results.find(r => r.name.toLowerCase() === 'msvcrt.dll');
  if (msvcrt && exports.guest_alloc) {
    initMsvcrtGlobals(exports, memory, msvcrt.loadAddr, log, options);
  }

  return results;
}

/**
 * Call a DLL's DllMain via the x86 emulator.
 * Pushes stdcall args and runs until RET pops the sentinel return address (0).
 * A numeric options argument retains the old maxBlocks calling convention.
 */
function callDllMain(exports, loadAddr, dllMain, log, options = {}) {
  const maxBlocks = typeof options === 'number'
    ? options : (options.maxBlocks == null ? 2000000 : options.maxBlocks);
  const lpReserved = typeof options === 'number'
    ? 0 : (options.lpReserved == null ? 0 : options.lpReserved);
  const dv = new DataView(exports.memory.buffer);
  const imageBase = exports.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;

  // Save state
  const savedEip = exports.get_eip();
  const savedEsp = exports.get_esp();
  const fsBase = exports.get_fs_base();
  const savedSeh = fsBase ? dv.getUint32(g2w(fsBase), true) : 0;

  let esp = savedEsp;
  // Push args in reverse order: lpReserved, fdwReason=1, hModule, ret=0.
  esp -= 4; dv.setUint32(g2w(esp), lpReserved, true);  // static != 0, dynamic = 0
  esp -= 4; dv.setUint32(g2w(esp), 1, true);           // DLL_PROCESS_ATTACH
  esp -= 4; dv.setUint32(g2w(esp), loadAddr, true);    // hModule
  esp -= 4; dv.setUint32(g2w(esp), 0, true);           // return address = 0 (sentinel)
  exports.set_esp(esp);
  exports.set_eip(dllMain);

  if (log) log(`Calling DllMain at 0x${dllMain.toString(16)}...`);
  // Run up to 2M blocks — DllMain should complete well within this
  try {
    exports.run(maxBlocks);
  } catch (e) {
    const crashEip = exports.get_eip();
    const crashEsp = exports.get_esp();
    const crashEax = exports.get_eax() >>> 0;
    // Check if DllMain actually succeeded — return to sentinel addr 0 causes
    // a trap when the decoder tries to execute at address 0/1. EAX=1 means
    // DLL_PROCESS_ATTACH returned TRUE.
    if (crashEip <= 2 && crashEax === 1) {
      if (log) log(`DllMain returned successfully (EAX=1, trapped on sentinel return addr)`);
      exports.set_esp(savedEsp);
      exports.set_eip(savedEip);
      if (fsBase) dv.setUint32(g2w(fsBase), savedSeh, true);
      return;
    }
    if (log) log(`DllMain trapped: ${e.message} (likely unimplemented API stub)`);
    if (log) log(`  crash EIP=0x${crashEip.toString(16)} ESP=0x${crashEsp.toString(16)} EAX=0x${crashEax.toString(16)}`);
    exports.set_esp(savedEsp);
    exports.set_eip(savedEip);
    // Restore SEH chain head — _EH_prolog may have modified it
    if (fsBase) dv.setUint32(g2w(fsBase), savedSeh, true);
    return;
  }

  const finalEip = exports.get_eip();
  if (finalEip !== 0) {
    if (log) log(`WARNING: DllMain did not return cleanly, EIP=0x${finalEip.toString(16)}`);
  } else {
    if (log) log(`DllMain returned, EAX=0x${(exports.get_eax()>>>0).toString(16)}`);
  }

  // Restore ESP (DllMain is stdcall, it cleaned up the 12 bytes of args,
  // and RET popped the return address, so ESP should be back to savedEsp)
  // But just in case, restore it
  exports.set_esp(savedEsp);
  exports.set_eip(savedEip);
}

function findDllExport(exports, memory, dllBase, exportName) {
  const imageBase = exports.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;
  const dv = new DataView(memory);
  const mem = new Uint8Array(memory);

  const dllCount = exports.get_dll_count();
  let expRva = 0;
  for (let di = 0; di < dllCount; di++) {
    const tblPtr = exports.get_dll_table() + di * 32;
    if (dv.getUint32(tblPtr, true) === dllBase) {
      expRva = dv.getUint32(tblPtr + 8, true);
      break;
    }
  }
  if (!expRva) return 0;

  const expDirWa = g2w(dllBase + expRva);
  const numNames = dv.getUint32(expDirWa + 24, true);
  const namesRva = dv.getUint32(expDirWa + 32, true);
  const ordinalsRva = dv.getUint32(expDirWa + 36, true);
  const funcsRva = dv.getUint32(expDirWa + 28, true);

  for (let i = 0; i < numNames; i++) {
    const nameRva = dv.getUint32(g2w(dllBase + namesRva + i * 4), true);
    const name = readStr(mem, g2w(dllBase + nameRva), 64);
    if (name !== exportName) continue;
    const ord = dv.getUint16(g2w(dllBase + ordinalsRva + i * 2), true);
    const funcRva = dv.getUint32(g2w(dllBase + funcsRva + ord * 4), true);
    return dllBase + funcRva;
  }
  return 0;
}

function callDllExport(exports, memory, addr, args, log, name, maxBlocks = 2000000) {
  const dv = new DataView(exports.memory.buffer);
  const imageBase = exports.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;
  const savedEip = exports.get_eip();
  const savedEsp = exports.get_esp();
  const fsBase = exports.get_fs_base();
  const savedSeh = fsBase ? dv.getUint32(g2w(fsBase), true) : 0;

  let esp = savedEsp;
  for (let i = args.length - 1; i >= 0; i--) {
    esp -= 4;
    dv.setUint32(g2w(esp), args[i] >>> 0, true);
  }
  esp -= 4;
  dv.setUint32(g2w(esp), 0, true);
  exports.set_esp(esp);
  exports.set_eip(addr);
  if (log) log(`Calling ${name} at 0x${addr.toString(16)}...`);

  try {
    exports.run(maxBlocks);
  } catch (e) {
    const crashEip = exports.get_eip();
    if (crashEip > 2 && log) {
      log(`${name} trapped: ${e.message}`);
      log(`  crash EIP=0x${crashEip.toString(16)} ESP=0x${exports.get_esp().toString(16)} EAX=0x${(exports.get_eax()>>>0).toString(16)}`);
    }
  }

  const eax = exports.get_eax() >>> 0;
  exports.set_esp(savedEsp);
  exports.set_eip(savedEip);
  if (fsBase) dv.setUint32(g2w(fsBase), savedSeh, true);
  return eax;
}

function isLikelyCodeAddress(exports, memory, addr) {
  addr >>>= 0;
  if (!addr) return false;

  try {
    const codeStart = exports.get_code_start ? (exports.get_code_start() >>> 0) : 0;
    const codeEnd = exports.get_code_end ? (exports.get_code_end() >>> 0) : 0;
    if (codeStart && codeEnd && addr >= codeStart && addr < codeEnd) return true;
  } catch (_) {}

  try {
    const thunkBase = exports.get_thunk_base ? (exports.get_thunk_base() >>> 0) : 0;
    const thunkEnd = exports.get_thunk_end ? (exports.get_thunk_end() >>> 0) : 0;
    if (thunkBase && thunkEnd && addr >= thunkBase && addr < thunkEnd) return true;
  } catch (_) {}

  try {
    const dv = new DataView(memory);
    const dllTable = exports.get_dll_table ? (exports.get_dll_table() >>> 0) : 0;
    const dllCount = exports.get_dll_count ? (exports.get_dll_count() | 0) : 0;
    for (let i = 0; dllTable && i < dllCount; i++) {
      const entry = dllTable + i * 32;
      const base = dv.getUint32(entry, true) >>> 0;
      const size = dv.getUint32(entry + 4, true) >>> 0;
      if (base && size && addr >= base && addr < ((base + size) >>> 0)) return true;
    }
  } catch (_) {}

  return false;
}

function resumeAfterLoadLibraryYield(exports, memory, log) {
  if (!exports || !exports.get_eip || !exports.get_esp || !exports.set_eip || !exports.set_esp) {
    return false;
  }
  if ((exports.get_eip() >>> 0) !== 0) return false;

  const imageBase = exports.get_image_base ? (exports.get_image_base() >>> 0) : 0;
  if (!imageBase) return false;
  const g2w = addr => addr - imageBase + 0x12000;
  try {
    const dv = new DataView(memory);
    const esp = exports.get_esp() >>> 0;
    const candidate = dv.getUint32(g2w(esp), true) >>> 0;
    if (!isLikelyCodeAddress(exports, memory, candidate)) return false;
    exports.set_eip(candidate);
    exports.set_esp((esp + 4) >>> 0);
    if (log) log(`[LoadLibrary] resumed sentinel return at 0x${candidate.toString(16)}`);
    return true;
  } catch (_) {
    return false;
  }
}

function initCardsDll(exports, memory, cardsBase, log) {
  const cdtInit = findDllExport(exports, memory, cardsBase, 'cdtInit');
  if (!cdtInit) return;
  const widthPtr = exports.guest_alloc(8);
  const heightPtr = widthPtr + 4;
  exports.guest_write32(widthPtr, 0);
  exports.guest_write32(heightPtr, 0);
  const ok = callDllExport(exports, memory, cdtInit, [widthPtr, heightPtr], log, 'CARDS!cdtInit');
  const w = exports.guest_read32 ? (exports.guest_read32(widthPtr) >>> 0) : 0;
  const h = exports.guest_read32 ? (exports.guest_read32(heightPtr) >>> 0) : 0;
  if (log) log(`Initialized CARDS.dll cdtInit=${ok} card=${w}x${h}`);
}

/**
 * Initialize msvcrt's CRT globals that are normally set by DllMain.
 * Since we don't call DllMain, _wcmdln, _acmdln, _wenviron etc. remain NULL.
 * The CRT startup checks these and skips WinMain if they're unset.
 */
function initMsvcrtGlobals(exports, memory, msvcrtBase, log, options = {}) {
  const imageBase = exports.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;
  const dv = new DataView(memory);
  const mem = new Uint8Array(memory);

  // Find export directory in msvcrt
  const dllCount = exports.get_dll_count();
  let expRva = 0;
  for (let di = 0; di < dllCount; di++) {
    const tblPtr = exports.get_dll_table() + di * 32;
    const dllAddr = dv.getUint32(tblPtr, true);
    if (dllAddr === msvcrtBase) {
      expRva = dv.getUint32(tblPtr + 8, true);
      break;
    }
  }
  if (!expRva) return;

  const expDirWa = g2w(msvcrtBase + expRva);
  const numNames = dv.getUint32(expDirWa + 24, true);
  const namesRva = dv.getUint32(expDirWa + 32, true);
  const ordinalsRva = dv.getUint32(expDirWa + 36, true);
  const funcsRva = dv.getUint32(expDirWa + 28, true);

  // Find __p__* accessor exports — each is "mov eax, IMM32; ret" returning the address
  // Cmdline globals (__p__wcmdln, __p__acmdln) are NOT patched here — the WAT-side
  // $store_fake_cmdline + set_extra_cmdline handles GetCommandLineA for all apps.
  const targets = {
    '__p__wenviron': 0, '__p__environ': 0,
    '__p___winitenv': 0, '__p___initenv': 0,
  };
  for (let i = 0; i < numNames; i++) {
    const nameRva = dv.getUint32(g2w(msvcrtBase + namesRva + i * 4), true);
    const name = readStr(mem, g2w(msvcrtBase + nameRva), 32);
    if (name in targets) {
      const ord = dv.getUint16(g2w(msvcrtBase + ordinalsRva + i * 2), true);
      const funcRva = dv.getUint32(g2w(msvcrtBase + funcsRva + ord * 4), true);
      const wa = g2w(msvcrtBase + funcRva);
      if (mem[wa] === 0xB8 && mem[wa + 5] === 0xC3) {
        targets[name] = dv.getUint32(wa + 1, true);
      }
    }
  }

  // Wide environment: L"A=B\0\0"
  const wEnvBlock = exports.guest_alloc(16);
  exports.guest_write16(wEnvBlock, 0x41);     // A
  exports.guest_write16(wEnvBlock + 2, 0x3D); // =
  exports.guest_write16(wEnvBlock + 4, 0x42); // B
  exports.guest_write16(wEnvBlock + 6, 0);
  exports.guest_write16(wEnvBlock + 8, 0);

  // Env array: [ptr, NULL]
  const wEnvArray = exports.guest_alloc(8);
  exports.guest_write32(wEnvArray, wEnvBlock);
  exports.guest_write32(wEnvArray + 4, 0);

  // Narrow environment: "A=B\0\0"
  const aEnvBlock = exports.guest_alloc(8);
  const aEnvWa = g2w(aEnvBlock);
  mem[aEnvWa] = 0x41; mem[aEnvWa+1] = 0x3D; mem[aEnvWa+2] = 0x42;
  mem[aEnvWa+3] = 0; mem[aEnvWa+4] = 0;

  const aEnvArray = exports.guest_alloc(8);
  exports.guest_write32(aEnvArray, aEnvBlock);
  exports.guest_write32(aEnvArray + 4, 0);

  // Patch CRT environment globals
  const patches = [
    ['__p__wenviron', wEnvArray],
    ['__p__environ', aEnvArray],
    ['__p___winitenv', aEnvArray],
    ['__p___initenv', aEnvArray],
  ];
  for (const [name, val] of patches) {
    if (targets[name]) {
      exports.guest_write32(targets[name], val);
      if (log) log(`Patched ${name} [0x${targets[name].toString(16)}] = 0x${val.toString(16)}`);
    }
  }

  // Disable msvcrt's Small Block Heap (sbh) by finding _set_sbh_threshold export
  // and extracting the __active_heap variable address from its code.
  // The sbh manages small allocations (<1KB) internally with its own metadata,
  // which doesn't work correctly under x86 emulation. Setting __active_heap=1
  // forces _heap_alloc_base to skip the SBH and use HeapAlloc directly.
  // _set_sbh_threshold starts: 55 8B EC A1 [__active_heap] ...
  // The A1 at offset 3 is "mov eax, [__active_heap]".
  for (let i = 0; i < numNames; i++) {
    const nameRva = dv.getUint32(g2w(msvcrtBase + namesRva + i * 4), true);
    const name = readStr(mem, g2w(msvcrtBase + nameRva), 32);
    if (name === '_set_sbh_threshold') {
      const ord = dv.getUint16(g2w(msvcrtBase + ordinalsRva + i * 2), true);
      const funcRva = dv.getUint32(g2w(msvcrtBase + funcsRva + ord * 4), true);
      const wa = g2w(msvcrtBase + funcRva);
      if (mem[wa] === 0x55 && mem[wa + 1] === 0x8B && mem[wa + 2] === 0xEC && mem[wa + 3] === 0xA1) {
        const activeHeapGA = dv.getUint32(wa + 4, true);
        exports.guest_write32(activeHeapGA, 1);
        if (log) log(`Patched __active_heap [0x${activeHeapGA.toString(16)}] = 1 (sbh disabled, using HeapAlloc)`);
      }
      break;
    }
  }
}

// Known DLL dependencies per EXE (by import table DLL names)
const DLL_CONFIGS = {
  mspaint: [
    { name: 'msvcrt.dll', path: 'dlls/msvcrt.dll' },
    { name: 'mfc42u.dll', path: 'dlls/mfc42u.dll' },
  ],
};

/**
 * Detect which DLLs an EXE needs by scanning its import table.
 * @param {Uint8Array} exeBytes
 * @returns {string[]} lowercase DLL names
 */
function detectRequiredDlls(exeBytes) {
  const names = [];
  const peOff = readU32(exeBytes, 0x3C);
  // A 16-bit NE image has an 'NE' header where this expects 'PE\0\0', and
  // every field read past it is then a different field entirely — the import
  // RVA lands on segment data and the offset arithmetic throws. There are no
  // 32-bit DLL imports to find in one, so say so.
  if (peOff + 4 > exeBytes.length || readU32(exeBytes, peOff) !== 0x00004550) return names;
  const importRva = readU32(exeBytes, peOff + 128);
  if (!importRva) return names;

  // Parse sections to find file offset for import RVA
  const numSec = exeBytes[peOff + 6] | (exeBytes[peOff + 7] << 8);
  const optSize = exeBytes[peOff + 20] | (exeBytes[peOff + 21] << 8);
  const secOff = peOff + 24 + optSize;
  const sections = [];
  for (let i = 0; i < numSec; i++) {
    const s = secOff + i * 40;
    const va = readU32(exeBytes, s + 12);
    const rawSize = readU32(exeBytes, s + 16);
    const rawPtr = readU32(exeBytes, s + 20);
    sections.push({ va, rawSize, rawPtr });
  }
  const rvaToFile = rva => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + s.rawSize) return s.rawPtr + (rva - s.va);
    }
    return null;
  };

  let descOff = rvaToFile(importRva);
  if (descOff === null) return names;
  while (true) {
    const nameRva = readU32(exeBytes, descOff + 12);
    if (nameRva === 0 && readU32(exeBytes, descOff) === 0) break;
    const nameOff = rvaToFile(nameRva);
    if (nameOff !== null) {
      let name = '';
      for (let i = nameOff; i < exeBytes.length && exeBytes[i]; i++) name += String.fromCharCode(exeBytes[i]);
      names.push(name.toLowerCase());
    }
    descOff += 20;
  }
  return names;
}

// Module ids as assigned by $win16_module_id in src/08c-ne-loader.wat. The
// first eight are system modules the emulator implements itself; anything past
// them is a real DLL that has to be found and loaded.
const WIN16_MODULE_IDS = {
  KERNEL: 1, USER: 2, GDI: 3, KEYBOARD: 4,
  SOUND: 5, SHELL: 6, MMSYSTEM: 7, COMMDLG: 8, CARDS: 9,
};
const WIN16_SYSTEM_MODULES = 8;
// Written out in WAT like the system libraries, but numbered past them because
// the low ids were already taken. There is no file to stage for these.
// WIN87EM is the 80x87 emulator; this machine has an FPU and answers for the
// module itself, so its file must not be staged or loaded even when it is
// sitting next to the exe — see $win16_win87em.
const WIN16_EMULATED_MODULES = new Set(['DDEML', 'WIN87EM']);
// The first module id an app's own DLLs can take. Must match $WIN16_DYNAMIC_BASE.
const WIN16_DYNAMIC_BASE = 13;

// The modules that have to come from a file. The browser has no directory to
// look in, so it fetches these by name up front and answers loadWin16Dlls out
// of what it got; the CLI reads the exe's own directory instead.
// `exeBytes` is optional: with it, the task's own module-reference table joins
// the list, which is the only way an app-local module gets named at all — an
// Entertainment Pack game imports its own about-box DLL and the pack's shared
// helper (ABOUTWEP, IWLIB, WEPUTIL, WEP4UTIL, VBRUN100), and no compiled-in
// table can know those names. The CLI needs none of this: it lists the exe's
// own directory.
function win16StageableModules(exeBytes) {
  const compiledIn = Object.keys(WIN16_MODULE_IDS)
    .filter(name => WIN16_MODULE_IDS[name] > WIN16_SYSTEM_MODULES);
  const imported = exeBytes ? win16ModuleNames(exeBytes) : [];
  // A module name in an NE table is whatever case the linker was given —
  // TETRIS imports "Abouttet" and "win87em" — so both the system-module and
  // the emulated-module tests compare uppercased.
  const id = name => WIN16_MODULE_IDS[name.toUpperCase()];
  return [...new Set([...compiledIn, ...imported])]
    .filter(name => !id(name) || id(name) > WIN16_SYSTEM_MODULES)
    .filter(name => !WIN16_EMULATED_MODULES.has(name.toUpperCase()));
}

// The modules an NE image imports from, read out of its module-reference
// table: each entry is an offset into the imported-name table, where the name
// sits as a Pascal string.
function win16ModuleNames(exeBytes) {
  if (exeBytes.length < 0x40 || exeBytes[0] !== 0x4D || exeBytes[1] !== 0x5A) return [];
  const ne = readU32(exeBytes, 0x3c);
  if (ne + 0x40 > exeBytes.length) return [];
  if (exeBytes[ne] !== 0x4E || exeBytes[ne + 1] !== 0x45) return [];
  const count = exeBytes[ne + 0x1e] | (exeBytes[ne + 0x1f] << 8);
  const modTab = ne + (exeBytes[ne + 0x28] | (exeBytes[ne + 0x29] << 8));
  const nameTab = ne + (exeBytes[ne + 0x2a] | (exeBytes[ne + 0x2b] << 8));
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = exeBytes[modTab + i * 2] | (exeBytes[modTab + i * 2 + 1] << 8);
    const p = nameTab + off;
    const n = exeBytes[p];
    let name = '';
    for (let j = 0; j < n; j++) name += String.fromCharCode(exeBytes[p + 1 + j]);
    out.push(name);
  }
  return out;
}

// Stage and load every NE DLL a 16-bit task imports from. Must run after
// load_pe, because placing a DLL's segments continues the same arena the task
// image started, and before the task's first call into one.
//
// A Win16 module name is not its filename in general -- SOUND ships as
// mmsound.drv -- but for the ones that matter here (CARDS) it is, so the
// lookup is by name with the usual extension.
// A task's static imports are loaded here; every other DLL we have a file for
// is only staged, so a LoadLibrary at runtime can find its bytes. Hearts does
// not import CARDS at all -- it calls LoadLibrary("cards.dll") and gives up
// with "Cannot find cards.dll" if that returns an error -- so staging cannot be
// driven by the module-reference table alone.
// `extraNames` are module names the task does not import but may still ask for
// by name at runtime — the Entertainment Pack's shared helper DLLs, which each
// game reaches through LoadLibrary. The CLI reads them off the exe's own
// directory; the browser passes the ones it managed to fetch.
function loadWin16Dlls(exports, memory, exeBytes, dir, readFile, log = () => {}, extraNames = []) {
  if (!exports.load_ne_dll || !exports.is_win16 || !exports.is_win16()) return [];
  const mem = new Uint8Array(memory.buffer);
  const loaded = [];
  // Two areas, two sizes: the system modules have a slot each, an app's own
  // modules have a much larger one (see $win16_dll_staging).
  const stride = exports.win16_dll_staging(1) - exports.win16_dll_staging(0);
  const appStride = exports.win16_dll_staging(WIN16_DYNAMIC_BASE + 1)
    - exports.win16_dll_staging(WIN16_DYNAMIC_BASE);
  const imported = new Set(win16ModuleNames(exeBytes));
  // The slots are NOT cleared here: load_pe clears them and then fills them in
  // as it resolves the task's fixups, so by now they hold the ids the thunks
  // were built with. Clearing them would renumber every app-local module out
  // from under code that already refers to it by id.
  const stage = (name, id) => {
    const bytes = readFile(dir, name);
    if (!bytes) return false;
    const room = id >= WIN16_DYNAMIC_BASE ? appStride : stride;
    if (bytes.length > room) { log(`[win16] ${name}: ${bytes.length} bytes exceeds the staging slot`); return false; }
    mem.set(bytes, exports.win16_dll_staging(id));
    return true;
  };
  for (const [name, id] of Object.entries(WIN16_MODULE_IDS)) {
    if (id <= WIN16_SYSTEM_MODULES || WIN16_EMULATED_MODULES.has(name)) continue;
    const isImport = imported.has(name);
    if (!stage(name, id)) {
      if (isImport) log(`[win16] ${name}: no DLL found, imports from it will stop the task`);
      continue;
    }
    if (!isImport) { log(`[win16] staged ${name} for LoadLibrary`); continue; }
    if (exports.load_ne_dll(id)) { loaded.push(name); log(`[win16] loaded ${name}`); }
    else log(`[win16] ${name}: not a loadable NE`);
  }

  // Whatever else the app is made of. An Entertainment Pack game imports its
  // own about-box DLL and the pack's shared helpers, and those names cannot be
  // in any compiled-in table: they are per-app. Give each one a module id of
  // its own, tell WAT the name, and load it like the rest.
  if (exports.win16_dynamic_module_slot) {
    // Whichever slots load_pe already claimed name the modules the task's own
    // fixups referred to, and their ids are fixed. Load those under the ids
    // they were given; anything left over is a module nothing imports directly,
    // which still gets staged so a LoadLibrary can find it.
    const slotName = (i) => {
      const at = exports.win16_dynamic_module_slot(i);
      const n = mem[at];
      if (!n) return null;
      let s = '';
      for (let j = 0; j < n; j++) s += String.fromCharCode(mem[at + 1 + j]);
      return s;
    };
    const claimed = new Set();
    let next = WIN16_DYNAMIC_BASE;
    for (let i = 0; i < 4; i++) {
      const name = slotName(i);
      if (!name) break;
      claimed.add(name);
      next = WIN16_DYNAMIC_BASE + i + 1;
      if (!stage(name, WIN16_DYNAMIC_BASE + i)) {
        log(`[win16] ${name}: no DLL found, imports from it will stop the task`);
        continue;
      }
      if (exports.load_ne_dll(WIN16_DYNAMIC_BASE + i)) {
        loaded.push(name);
        log(`[win16] loaded ${name} as module ${WIN16_DYNAMIC_BASE + i}`);
      } else {
        log(`[win16] ${name}: not a loadable NE`);
      }
    }
    // Then the rest: the task's other imports, and whatever else sits beside
    // it that it might reach for at runtime. FreeCell's WEPUTIL arrives only
    // through LoadLibrary, so a name has to be claimed and staged before the
    // call to have anywhere to load from — the same reasoning as the system
    // modules staged above, applied to the app's own files.
    for (const name of [...imported, ...extraNames]) {
      // Uppercased, because a module-reference table holds the linker's
      // spelling: Tut's Tomb and Chess import "win87em", and matching that
      // byte for byte gave the 80x87 emulator a second, app-local module id
      // beside the one WAT answers for — harmless where the file is sitting
      // next to the exe, fatal on the page, where it is not there to stage
      // and the task stopped on an import it never actually needed.
      if (WIN16_MODULE_IDS[name.toUpperCase()] ||
          WIN16_EMULATED_MODULES.has(name.toUpperCase())) continue;
      if (claimed.has(name)) continue;
      claimed.add(name);
      if (next >= WIN16_DYNAMIC_BASE + 4) {
        log(`[win16] ${name}: no module slot left`); continue;
      }
      if (!stage(name, next)) {
        if (imported.has(name)) {
          log(`[win16] ${name}: no DLL found, imports from it will stop the task`);
        }
        continue;
      }
      const slot = exports.win16_dynamic_module_slot(next - WIN16_DYNAMIC_BASE);
      mem[slot] = name.length;
      for (let i = 0; i < name.length; i++) mem[slot + 1 + i] = name.charCodeAt(i);
      if (!imported.has(name)) {
        log(`[win16] staged ${name} as module ${next} for LoadLibrary`);
        next++;
        continue;
      }
      if (exports.load_ne_dll(next)) {
        loaded.push(name);
        log(`[win16] loaded ${name} as module ${next}`);
        next++;
      } else {
        mem[slot] = 0;
        log(`[win16] ${name}: not a loadable NE`);
      }
    }
  }
  return loaded;
}

function shouldReportNtForDlls(dllNames) {
  if (!Array.isArray(dllNames)) return false;
  return dllNames.some(name => String(name).toLowerCase() === 'mfc42u.dll');
}

// Export for Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadDll, loadDlls, patchExeImports, patchDllImports, callDllMain, resumeAfterLoadLibraryYield, detectRequiredDlls, shouldReportNtForDlls, loadWin16Dlls, win16ModuleNames, win16StageableModules, DLL_CONFIGS };
} else if (typeof window !== 'undefined') {
  window.DllLoader = { loadDll, loadDlls, patchExeImports, patchDllImports, callDllMain, resumeAfterLoadLibraryYield, detectRequiredDlls, shouldReportNtForDlls, loadWin16Dlls, win16ModuleNames, win16StageableModules, DLL_CONFIGS };
}
