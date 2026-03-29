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
function patchExeImports(exports, memory, exeBytes, log) {
  const imageBase = exports.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;
  const dv = new DataView(memory);

  // Read import RVA from original EXE PE header
  const peOff = readU32(exeBytes, 0x3C);
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
      const tblPtr = 0xE63000 + di * 32;
      const dllLoadAddr = dv.getUint32(tblPtr, true);
      const expRva = dv.getUint32(tblPtr + 8, true);
      if (expRva === 0) continue;

      const expDirWa = g2w(dllLoadAddr + expRva);
      const expNameRva = dv.getUint32(expDirWa + 12, true);
      const expName = readStr(new Uint8Array(memory), g2w(dllLoadAddr + expNameRva));

      if (dllName.toLowerCase() === expName.toLowerCase()) {
        if (log) log(`Patching EXE imports: ${dllName} -> DLL #${di} (${expName})`);
        exports.patch_caller_iat(imageBase, importRva, dllLoadAddr + expNameRva, di);
        break;
      }
    }
    descWa += 20;
  }
}

/**
 * Load all required DLLs for an EXE and patch imports.
 * @param {object} exports - WASM instance exports
 * @param {ArrayBuffer} memory - WASM memory buffer
 * @param {Uint8Array} exeBytes - original EXE bytes
 * @param {Array<{name: string, bytes: Uint8Array}>} dlls - DLL files to load (in order)
 * @param {function} [log] - optional logging function
 * @returns {Array<{name: string, loadAddr: number, dllMain: number}>}
 */
function loadDlls(exports, memory, exeBytes, dlls, log) {
  const results = [];
  for (const dll of dlls) {
    const { loadAddr, dllMain } = loadDll(exports, memory, dll.bytes);
    const thunks = exports.get_num_thunks();
    if (log) log(`DLL: ${dll.name} at 0x${loadAddr.toString(16)}, DllMain=0x${(dllMain>>>0).toString(16)}, thunks=${thunks}`);
    results.push({ name: dll.name, loadAddr, dllMain });
  }
  patchExeImports(exports, memory, exeBytes, log);
  if (log) log(`After patching: ${exports.get_num_thunks()} thunks`);

  // Initialize msvcrt _wenviron so CRT startup proceeds to WinMain
  const msvcrt = results.find(r => r.name.toLowerCase() === 'msvcrt.dll');
  if (msvcrt && exports.guest_alloc) {
    initMsvcrtGlobals(exports, memory, msvcrt.loadAddr, log);
  }

  return results;
}

/**
 * Initialize msvcrt's CRT globals that are normally set by DllMain.
 * Since we don't call DllMain, _wcmdln, _acmdln, _wenviron etc. remain NULL.
 * The CRT startup checks these and skips WinMain if they're unset.
 */
function initMsvcrtGlobals(exports, memory, msvcrtBase, log) {
  const imageBase = exports.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;
  const dv = new DataView(memory);
  const mem = new Uint8Array(memory);

  // Find export directory in msvcrt
  const dllCount = exports.get_dll_count();
  let expRva = 0;
  for (let di = 0; di < dllCount; di++) {
    const tblPtr = 0xE63000 + di * 32;
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
  const targets = {
    '__p__wcmdln': 0, '__p__acmdln': 0,
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

  // Allocate a wide command line: L"PAINT\0"
  const wCmdLine = exports.guest_alloc(16);
  const wCmd = [0x50, 0x41, 0x49, 0x4E, 0x54, 0]; // P A I N T \0
  for (let i = 0; i < wCmd.length; i++)
    exports.guest_write16(wCmdLine + i * 2, wCmd[i]);

  // Allocate a narrow command line: "PAINT\0"
  const aCmdLine = exports.guest_alloc(8);
  const aCmdWa = g2w(aCmdLine);
  mem[aCmdWa] = 0x50; mem[aCmdWa+1] = 0x41; mem[aCmdWa+2] = 0x49;
  mem[aCmdWa+3] = 0x4E; mem[aCmdWa+4] = 0x54; mem[aCmdWa+5] = 0;

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

  // Patch all CRT globals
  const patches = [
    ['__p__wcmdln', wCmdLine],
    ['__p__acmdln', aCmdLine],
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
      for (let i = nameOff; exeBytes[i]; i++) name += String.fromCharCode(exeBytes[i]);
      names.push(name.toLowerCase());
    }
    descOff += 20;
  }
  return names;
}

// Export for Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadDll, loadDlls, patchExeImports, detectRequiredDlls, DLL_CONFIGS };
} else if (typeof window !== 'undefined') {
  window.DllLoader = { loadDll, loadDlls, patchExeImports, detectRequiredDlls, DLL_CONFIGS };
}
