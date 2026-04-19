/**
 * Virtual filesystem and registry backed by localStorage (browser) or in-memory Map (Node.js).
 * Provides host imports for Win32 registry and INI file APIs.
 */

// Storage backend: localStorage in browser, Map in Node.js
const _store = (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') ? {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  remove: (k) => localStorage.removeItem(k),
  keys: () => Object.keys(localStorage),
} : (() => {
  const m = new Map();
  return {
    get: (k) => m.has(k) ? m.get(k) : null,
    set: (k, v) => m.set(k, v),
    remove: (k) => m.delete(k),
    keys: () => [...m.keys()],
  };
})();

// ---- Registry ----
// Keys stored as: "reg:<rootHex>/<subkey path>" → JSON { values: { name: { type, data } } }
// Handle allocation: 0xBEEF0000 + counter
let _nextRegHandle = 1;
const _regHandles = {}; // handle → key path

const ROOT_NAMES = {
  0x80000000: 'HKCR', 0x80000001: 'HKCU', 0x80000002: 'HKLM',
  0x80000003: 'HKU',  0x80000005: 'HKCC',
};

function _regKeyPath(hKey, subKey) {
  // If hKey is a known root
  const root = ROOT_NAMES[hKey >>> 0];
  if (root) return subKey ? `${root}\\${subKey}` : root;
  // If hKey is one of our allocated handles
  const parent = _regHandles[hKey >>> 0];
  if (parent) return subKey ? `${parent}\\${subKey}` : parent;
  return subKey || '';
}

function _regGet(path) {
  const raw = _store.get('reg:' + path);
  return raw ? JSON.parse(raw) : { values: {} };
}

function _regPut(path, obj) {
  _store.set('reg:' + path, JSON.stringify(obj));
}

function _allocRegHandle(path) {
  const h = (0xBEEF0000 + (_nextRegHandle++)) | 0;
  _regHandles[h >>> 0] = path;
  return h;
}

// Pre-populate default Windows registry keys
function _initDefaultRegistry() {
  const defaults = {
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion': {
      values: {
        'ProgramFilesDir': { type: 1, data: 'C:\\Program Files' },
        'CommonFilesDir': { type: 1, data: 'C:\\Program Files\\Common Files' },
        'SystemRoot': { type: 1, data: 'C:\\Windows' },
      }
    },
    'HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion': {
      values: {
        'SystemRoot': { type: 1, data: 'C:\\Windows' },
      }
    },
    'HKLM\\Software\\Fish Technology Group\\RollerCoaster Tycoon Demo Setup': {
      values: {
        'Path': { type: 1, data: 'C:\\' },
      }
    },
    'HKLM\\SOFTWARE\\Microsoft\\Microsoft Games\\Motocross Madness Trial\\1.0': {
      values: {
        'InstallType': { type: 1, data: 'Full' },
        'HardDriveRootPath': { type: 1, data: 'C:\\Program Files\\Microsoft Games\\Motocross Madness Trial\\' },
        'CDRootPath': { type: 1, data: 'C:\\Program Files\\Microsoft Games\\Motocross Madness Trial\\' },
        'InstallPath': { type: 1, data: 'C:\\Program Files\\Microsoft Games\\Motocross Madness Trial\\' },
      }
    },
    // Plus!98 Organic Art screensavers (ARCHITEC.SCR etc.) read DefaultScene
    // here; without it the app falls through playlist-enum without committing
    // a selection and nothing loads. Scene display name comes from the SCN
    // file's [Description] Name= field.
    'HKCU\\Software\\Computer Artworks\\Organic Art\\Plus': {
      values: {
        'DefaultScene': { type: 1, data: 'Architecture' },
      }
    },
  };
  for (const [path, obj] of Object.entries(defaults)) {
    if (_store.get('reg:' + path) === null) {
      _regPut(path, obj);
    }
  }
}
_initDefaultRegistry();

// ---- INI Files ----
// Stored as: "ini:<filename lowercase>" → JSON { sections: { "SectionName": { "Key": "Value" } } }

function _iniGet(fileName) {
  const norm = fileName.toLowerCase().replace(/\\/g, '/').split('/').pop();
  const raw = _store.get('ini:' + norm);
  return raw ? JSON.parse(raw) : { sections: {} };
}

// Parse INI text into { sections: { name: { key: value } } }.
// Accepts standard Windows INI: [Section] headers, key=value lines, ; or # comments.
function _parseIniText(text) {
  const sections = {};
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let line of lines) {
    line = line.replace(/^\uFEFF/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^\[([^\]]+)\]$/);
    if (m) { cur = m[1]; if (!sections[cur]) sections[cur] = {}; continue; }
    if (!cur) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    sections[cur][key] = val;
  }
  return { sections };
}

// Read file contents as text from a VFS instance given a filename.
function _vfsReadText(vfs, fileName) {
  if (!vfs) return null;
  const base = fileName.toLowerCase().replace(/\\/g, '/').split('/').pop();
  for (const p of vfs.files.keys()) {
    const pb = p.toLowerCase().replace(/\\/g, '/').split('/').pop();
    if (pb === base) {
      const data = vfs.files.get(p).data;
      let s = ''; for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
      return s;
    }
  }
  return null;
}

// Merged lookup: localStorage first, then VFS file parse. Never caches VFS result
// back into localStorage (the on-disk file is the source of truth).
function _iniResolve(vfs, fileName) {
  const norm = fileName.toLowerCase().replace(/\\/g, '/').split('/').pop();
  const raw = _store.get('ini:' + norm);
  const stored = raw ? JSON.parse(raw) : null;
  if (stored && Object.keys(stored.sections).length) return stored;
  const text = _vfsReadText(vfs, fileName);
  if (text) return _parseIniText(text);
  return stored || { sections: {} };
}

function _iniPut(fileName, obj) {
  const norm = fileName.toLowerCase().replace(/\\/g, '/').split('/').pop();
  _store.set('ini:' + norm, JSON.stringify(obj));
}

/**
 * Create host imports for registry and INI file operations.
 * @param {object} ctx - context with getMemory() returning ArrayBuffer
 * @returns {object} host import functions
 */
var _mu2 = typeof require !== 'undefined' ? require('./mem-utils') : (typeof window !== 'undefined' && window.memUtils || {});

function createStorageImports(ctx) {
  const readStrA = (wasmAddr, maxLen = 260) => _mu2.readStrA(ctx.getMemory(), wasmAddr, maxLen);
  const readStrW = (wasmAddr, maxLen = 260) => _mu2.readStrW(ctx.getMemory(), wasmAddr, maxLen);
  const readStr = (wasmAddr, isWide, maxLen) => isWide ? readStrW(wasmAddr, maxLen) : readStrA(wasmAddr, maxLen);

  const g2w = (addr) => {
    const exports = ctx.exports;
    return exports ? _mu2.g2w(addr, exports.get_image_base()) : addr;
  };

  const writeStrA = (guestAddr, str, maxLen) => {
    const mem = new Uint8Array(ctx.getMemory());
    const wa = g2w(guestAddr);
    const len = Math.min(str.length, maxLen - 1);
    for (let i = 0; i < len; i++) mem[wa + i] = str.charCodeAt(i) & 0xFF;
    mem[wa + len] = 0;
    return len;
  };

  const writeStrW = (guestAddr, str, maxLen) => {
    const dv = new DataView(ctx.getMemory());
    const wa = g2w(guestAddr);
    const len = Math.min(str.length, maxLen - 1);
    for (let i = 0; i < len; i++) dv.setUint16(wa + i * 2, str.charCodeAt(i), true);
    dv.setUint16(wa + len * 2, 0, true);
    return len;
  };

  const writeStr = (guestAddr, str, maxLen, isWide) => isWide ? writeStrW(guestAddr, str, maxLen) : writeStrA(guestAddr, str, maxLen);

  // Trace gate shared by all reg_* ops. `--trace-reg` enables it; verbose is legacy catch-all.
  const _traceReg = () => (ctx.trace && ctx.trace.has('reg')) || ctx.verbose;

  const gs32 = (guestAddr, val) => {
    new DataView(ctx.getMemory()).setUint32(g2w(guestAddr), val, true);
  };

  const gl32 = (guestAddr) => {
    return new DataView(ctx.getMemory()).getUint32(g2w(guestAddr), true);
  };

  // ---- COM state ----
  let _comPendingDll = null; // DLL path string awaiting async fetch
  const SCRATCH_ADDR = 0x900; // WASM scratch area (below GUEST_BASE, safe)

  function _writeStringToScratch(str) {
    const mem = new Uint8Array(ctx.getMemory());
    for (let i = 0; i < str.length; i++) mem[SCRATCH_ADDR + i] = str.charCodeAt(i) & 0xFF;
    mem[SCRATCH_ADDR + str.length] = 0;
    return SCRATCH_ADDR;
  }

  // Resolve a named export from a loaded DLL by scanning its export table in guest memory
  function _resolveExport(dllIdx, funcName) {
    const exports = ctx.exports;
    const dllTable = exports.get_dll_table();
    const imageBase = exports.get_image_base();
    const mem = new Uint8Array(ctx.getMemory());
    const dvx = new DataView(ctx.getMemory());
    // g2w from outer scope works here (exports is available)

    const tblPtr = dllTable + dllIdx * 32;
    const loadAddr = dvx.getUint32(tblPtr, true);
    const expRva = dvx.getUint32(tblPtr + 8, true);
    if (!expRva) return 0;

    const expDirWa = g2w(loadAddr + expRva);
    const numNames = dvx.getUint32(expDirWa + 24, true);
    const namesRva = dvx.getUint32(expDirWa + 32, true);
    const ordinalsRva = dvx.getUint32(expDirWa + 36, true);
    const funcsRva = dvx.getUint32(expDirWa + 28, true);

    for (let i = 0; i < numNames; i++) {
      const nameRva = dvx.getUint32(g2w(loadAddr + namesRva + i * 4), true);
      let name = '';
      for (let j = 0; j < 64; j++) {
        const ch = mem[g2w(loadAddr + nameRva) + j];
        if (!ch) break;
        name += String.fromCharCode(ch);
      }
      if (name === funcName) {
        const ord = dvx.getUint16(g2w(loadAddr + ordinalsRva + i * 2), true);
        const funcRva = dvx.getUint32(g2w(loadAddr + funcsRva + ord * 4), true);
        return loadAddr + funcRva;
      }
    }
    return 0;
  }

  function guidToString(wasmAddr) {
    const dv = new DataView(ctx.getMemory());
    const d1 = dv.getUint32(wasmAddr, true);
    const d2 = dv.getUint16(wasmAddr + 4, true);
    const d3 = dv.getUint16(wasmAddr + 6, true);
    const mem = new Uint8Array(ctx.getMemory());
    const hex = (v, n) => v.toString(16).padStart(n, '0');
    let d4 = '';
    for (let i = 0; i < 8; i++) d4 += hex(mem[wasmAddr + 8 + i], 2);
    return `{${hex(d1,8)}-${hex(d2,4)}-${hex(d3,4)}-${d4.slice(0,4)}-${d4.slice(4)}}`;
  }

  return {
    // ---- COM ----
    com_create_instance: (rclsidWA, pUnkOuterGA, dwClsContext, riidWA, ppvGA) => {
      const clsid = guidToString(rclsidWA);
      const iid = guidToString(riidWA);
      if (ctx.log) ctx.log(`CoCreateInstance: CLSID=${clsid} IID=${iid}`);

      // Registry lookup: HKCR\CLSID\{guid}\InprocServer32
      const keyPath = `HKCR\\CLSID\\${clsid}\\InprocServer32`;
      const raw = _store.get('reg:' + keyPath);
      if (!raw) {
        // Key not found — check if we have a static CLSID→DLL mapping
        // (for pre-populated registry entries)
        if (ctx.log) ctx.log(`CoCreateInstance: CLSID ${clsid} not in registry`);
        // Write NULL to *ppv
        if (ppvGA) gs32(ppvGA, 0);
        return 0x80040154; // REGDB_E_CLASSNOTREG
      }
      const entry = JSON.parse(raw);
      const dllPath = (entry.values && entry.values[''] && entry.values[''].data) || '';
      if (!dllPath) {
        if (ppvGA) gs32(ppvGA, 0);
        return 0x80040154; // REGDB_E_CLASSNOTREG
      }

      // Check if this DLL is already loaded
      const exports = ctx.exports;
      if (!exports) {
        if (ppvGA) gs32(ppvGA, 0);
        return 0x80004005; // E_FAIL
      }
      const dllCount = exports.get_dll_count();
      const dllTable = exports.get_dll_table();
      const imageBase = exports.get_image_base();
      const mem = new Uint8Array(ctx.getMemory());
      const dvx = new DataView(ctx.getMemory());
      // Search loaded DLLs for matching name
      const dllName = dllPath.split('\\').pop().toLowerCase();
      let dllIdx = -1;
      for (let i = 0; i < dllCount; i++) {
        const tblPtr = dllTable + i * 32;
        const loadAddr = dvx.getUint32(tblPtr, true);
        const expRva = dvx.getUint32(tblPtr + 8, true);
        if (!expRva) continue;
        const expDirWa = g2w(loadAddr + expRva);
        const expNameRva = dvx.getUint32(expDirWa + 12, true);
        let name = '';
        for (let j = 0; j < 64; j++) {
          const ch = mem[g2w(loadAddr + expNameRva) + j];
          if (!ch) break;
          name += String.fromCharCode(ch);
        }
        if (name.toLowerCase() === dllName || name.toLowerCase().replace('.dll','') === dllName.replace('.dll','')) {
          dllIdx = i;
          break;
        }
      }

      if (dllIdx < 0) {
        // DLL not loaded — signal async fetch needed
        _comPendingDll = dllPath;
        if (ctx.log) ctx.log(`CoCreateInstance: need to load ${dllPath}`);
        return 0x800401F0; // CO_E_DLLNOTFOUND (triggers yield)
      }

      // DLL is loaded — find DllGetClassObject export
      const dllGetClassObj = _resolveExport(dllIdx, 'DllGetClassObject');

      if (!dllGetClassObj) {
        if (ctx.log) ctx.log(`CoCreateInstance: DllGetClassObject not found in ${dllName}`);
        if (ppvGA) gs32(ppvGA, 0);
        return 0x80040154;
      }

      // Reentrant call: DllGetClassObject(rclsid, riid_factory, &pFactory)
      // IID_IClassFactory = {00000001-0000-0000-C000-000000000046}
      const savedEip = exports.get_eip();
      const savedEsp = exports.get_esp();
      const fsBase = exports.get_fs_base();
      const savedSeh = fsBase ? dvx.getUint32(g2w(fsBase), true) : 0;

      // Allocate temp space for IID_IClassFactory (16 bytes) + pFactory ptr (4 bytes)
      const tmpBase = exports.guest_alloc(32);
      const iidFactoryGA = tmpBase;
      const pFactoryGA = tmpBase + 16;

      // Write IID_IClassFactory
      const iidWa = g2w(iidFactoryGA);
      dvx.setUint32(iidWa, 0x00000001, true);      // Data1
      dvx.setUint16(iidWa + 4, 0x0000, true);      // Data2
      dvx.setUint16(iidWa + 6, 0x0000, true);      // Data3
      mem[iidWa + 8] = 0xC0; mem[iidWa + 9] = 0x00;
      mem[iidWa + 10] = 0x00; mem[iidWa + 11] = 0x00;
      mem[iidWa + 12] = 0x00; mem[iidWa + 13] = 0x00;
      mem[iidWa + 14] = 0x00; mem[iidWa + 15] = 0x46;

      // Zero pFactory
      dvx.setUint32(g2w(pFactoryGA), 0, true);

      // Convert rclsidWA back to guest addr
      const rclsidGA = rclsidWA - 0x12000 + imageBase;
      const riidGA = riidWA - 0x12000 + imageBase;

      // Push args: ret=0, rclsid, riid_factory, &pFactory (stdcall, 3 args)
      let esp = savedEsp;
      esp -= 4; dvx.setUint32(g2w(esp), pFactoryGA, true);    // ppv
      esp -= 4; dvx.setUint32(g2w(esp), iidFactoryGA, true);  // riid (IClassFactory)
      esp -= 4; dvx.setUint32(g2w(esp), rclsidGA, true);      // rclsid
      esp -= 4; dvx.setUint32(g2w(esp), 0, true);             // return addr = sentinel
      exports.set_esp(esp);
      exports.set_eip(dllGetClassObj);

      if (ctx.log) ctx.log(`Calling DllGetClassObject at 0x${dllGetClassObj.toString(16)}`);
      let hr = 0x80004005; // E_FAIL
      try {
        exports.run(500000);
        const finalEip = exports.get_eip();
        hr = exports.get_eax();
        if (finalEip <= 2 && (hr === 0 || hr >>> 0 === 0)) {
          hr = 0; // S_OK
        }
      } catch (e) {
        const eip = exports.get_eip();
        hr = exports.get_eax();
        if (eip <= 2 && (hr === 0 || hr >>> 0 === 0)) hr = 0;
        else {
          if (ctx.log) ctx.log(`DllGetClassObject trapped: ${e.message}`);
        }
      }
      exports.set_esp(savedEsp);
      exports.set_eip(savedEip);
      if (fsBase) dvx.setUint32(g2w(fsBase), savedSeh, true);

      if (hr !== 0) {
        if (ctx.log) ctx.log(`DllGetClassObject failed: 0x${(hr>>>0).toString(16)}`);
        if (ppvGA) gs32(ppvGA, 0);
        return hr;
      }

      const pFactory = dvx.getUint32(g2w(pFactoryGA), true);
      if (!pFactory) {
        if (ppvGA) gs32(ppvGA, 0);
        return 0x80004005;
      }
      if (ctx.log) ctx.log(`IClassFactory at 0x${pFactory.toString(16)}`);

      // Call IClassFactory::CreateInstance(pUnkOuter, riid, ppv)
      // vtable method index 3 (after QueryInterface=0, AddRef=1, Release=2)
      const vtableAddr = dvx.getUint32(g2w(pFactory), true);
      const createInstanceAddr = dvx.getUint32(g2w(vtableAddr + 12), true); // vtable[3]

      esp = savedEsp;
      esp -= 4; dvx.setUint32(g2w(esp), ppvGA, true);        // ppv
      esp -= 4; dvx.setUint32(g2w(esp), riidGA, true);       // riid
      esp -= 4; dvx.setUint32(g2w(esp), pUnkOuterGA, true);  // pUnkOuter
      esp -= 4; dvx.setUint32(g2w(esp), pFactory, true);     // this (COM thiscall = first arg)
      esp -= 4; dvx.setUint32(g2w(esp), 0, true);            // return addr = sentinel
      exports.set_esp(esp);
      exports.set_eip(createInstanceAddr);

      if (ctx.log) ctx.log(`Calling CreateInstance at 0x${createInstanceAddr.toString(16)}`);
      try {
        exports.run(500000);
        const finalEip = exports.get_eip();
        hr = exports.get_eax();
        if (finalEip <= 2) {
          // Success — hr is in EAX
        }
      } catch (e) {
        const eip = exports.get_eip();
        hr = exports.get_eax();
        if (eip > 2) {
          if (ctx.log) ctx.log(`CreateInstance trapped: ${e.message}`);
          hr = 0x80004005;
        }
      }
      exports.set_esp(savedEsp);
      exports.set_eip(savedEip);
      if (fsBase) dvx.setUint32(g2w(fsBase), savedSeh, true);

      if (ctx.log) ctx.log(`CoCreateInstance result: 0x${(hr>>>0).toString(16)}`);
      return hr;
    },

    com_get_pending_dll: () => {
      if (!_comPendingDll) return 0;
      // Write the DLL path into scratch memory so WAT can read it
      return _writeStringToScratch(_comPendingDll);
    },

    // ---- Registry ----
    reg_open_key: (hKey, subKeyWA, isWide) => {
      const subKey = readStr(subKeyWA, isWide);
      const path = _regKeyPath(hKey, subKey);
      // Check if key exists in storage
      const raw = _store.get('reg:' + path);
      if (_traceReg()) console.log(`[reg] open  ${path} -> ${raw !== null ? 'found' : 'not found'}`);
      if (raw !== null) return _allocRegHandle(path);
      // Key doesn't exist — return 0 (failure)
      return 0;
    },

    reg_create_key: (hKey, subKeyWA, phkResultGA, isWide) => {
      const subKey = readStr(subKeyWA, isWide);
      const path = _regKeyPath(hKey, subKey);
      // Create key if it doesn't exist
      const existing = _store.get('reg:' + path);
      const created = existing === null;
      if (created) _regPut(path, { values: {} });
      const h = _allocRegHandle(path);
      if (phkResultGA) gs32(phkResultGA, h);
      if (_traceReg()) console.log(`[reg] create ${path} (${created ? 'new' : 'existing'})`);
      return 0; // ERROR_SUCCESS
    },

    reg_query_value: (hKey, nameWA, typeGA, dataGA, cbDataGA, isWide) => {
      const path = _regHandles[hKey >>> 0];
      if (!path) {
        if (_traceReg()) console.log(`[reg] query  <invalid handle 0x${(hKey>>>0).toString(16)}>`);
        return 2; // ERROR_FILE_NOT_FOUND
      }
      const name = nameWA ? readStr(nameWA, isWide) : '';
      const entry = _regGet(path);
      const val = entry.values[name];
      if (_traceReg()) console.log(`[reg] query  ${path}\\${name} -> ${val ? JSON.stringify(val.data) : 'not found'}`);
      if (!val) return 2; // ERROR_FILE_NOT_FOUND

      // Write type if requested
      if (typeGA) gs32(typeGA, val.type || 1); // REG_SZ default

      // Write data if buffer provided
      if (dataGA && cbDataGA) {
        const maxLen = gl32(cbDataGA);
        if (val.type === 4) { // REG_DWORD
          if (maxLen >= 4) {
            gs32(dataGA, val.data | 0);
            gs32(cbDataGA, 4);
          } else {
            gs32(cbDataGA, 4);
            return 234; // ERROR_MORE_DATA
          }
        } else { // REG_SZ or REG_EXPAND_SZ
          const str = val.data || '';
          if (isWide) {
            const needed = (str.length + 1) * 2;
            if (maxLen >= needed) {
              writeStrW(dataGA, str, str.length + 1);
              gs32(cbDataGA, needed);
            } else {
              gs32(cbDataGA, needed);
              return 234; // ERROR_MORE_DATA
            }
          } else {
            const needed = str.length + 1;
            if (maxLen >= needed) {
              writeStrA(dataGA, str, needed);
              gs32(cbDataGA, needed);
            } else {
              gs32(cbDataGA, needed);
              return 234; // ERROR_MORE_DATA
            }
          }
        }
      }
      return 0; // ERROR_SUCCESS
    },

    reg_set_value: (hKey, nameWA, type, dataGA, cbData, isWide) => {
      const path = _regHandles[hKey >>> 0];
      if (!path) {
        if (_traceReg()) console.log(`[reg] set    <invalid handle 0x${(hKey>>>0).toString(16)}>`);
        return 2;
      }
      const name = nameWA ? readStr(nameWA, isWide) : '';
      const entry = _regGet(path);

      if (type === 4) { // REG_DWORD
        entry.values[name] = { type: 4, data: gl32(dataGA) };
      } else { // REG_SZ, REG_EXPAND_SZ, etc.
        const str = isWide ? readStrW(dataGA, cbData / 2) : readStrA(dataGA, cbData);
        entry.values[name] = { type: type || 1, data: str };
      }
      _regPut(path, entry);
      if (_traceReg()) console.log(`[reg] set    ${path}\\${name} (type=${type}) = ${JSON.stringify(entry.values[name].data)}`);
      return 0; // ERROR_SUCCESS
    },

    reg_enum_key: (hKey, dwIndex, lpNameWA, cchName, isWide) => {
      const path = _regHandles[hKey >>> 0];
      const rootName = ROOT_NAMES[hKey >>> 0];
      const keyPath = path || rootName;
      if (!keyPath) return 259; // ERROR_NO_MORE_ITEMS

      // Find immediate subkeys by scanning all reg: entries
      const prefix = 'reg:' + keyPath + '\\';
      const subkeys = new Set();
      for (const k of _store.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const child = rest.split('\\')[0];
          if (child) subkeys.add(child);
        }
      }
      const sorted = [...subkeys].sort();
      if (dwIndex >= sorted.length) {
        if (_traceReg()) console.log(`[reg] enum   ${keyPath}[${dwIndex}] -> no more`);
        return 259; // ERROR_NO_MORE_ITEMS
      }
      const name = sorted[dwIndex];
      if (isWide) {
        writeStrW(lpNameWA, name, Math.min(name.length + 1, cchName));
      } else {
        writeStrA(lpNameWA, name, Math.min(name.length + 1, cchName));
      }
      if (_traceReg()) console.log(`[reg] enum   ${keyPath}[${dwIndex}] -> ${name}`);
      return 0; // ERROR_SUCCESS
    },

    reg_close_key: (hKey) => {
      const path = _regHandles[hKey >>> 0];
      delete _regHandles[hKey >>> 0];
      if (_traceReg()) console.log(`[reg] close  ${path || '<unknown>'}`);
      return 0;
    },

    // ---- INI Files ----
    ini_get_string: (appNameWA, keyNameWA, defaultWA, bufGA, bufSize, fileNameWA, isWide) => {
      const fileName = readStr(fileNameWA, isWide);
      const ini = _iniResolve(ctx.vfs, fileName);
      if (ctx.trace && ctx.trace.has('ini')) {
        const app = appNameWA ? readStr(appNameWA, isWide) : '<ALL>';
        const key = keyNameWA ? readStr(keyNameWA, isWide) : '<ALL>';
        const sec = ini.sections[app];
        const val = (keyNameWA && sec && sec[key] !== undefined) ? sec[key] : '(default)';
        console.log(`[ini] GetString("${fileName}", [${app}], ${key}) → "${val}"`);
      }

      // If appName is 0/NULL, enumerate section names
      if (!appNameWA) {
        const names = Object.keys(ini.sections);
        const result = names.join('\0') + '\0';
        return writeStr(bufGA, result, bufSize, isWide);
      }

      const appName = readStr(appNameWA, isWide);
      const section = ini.sections[appName];

      // If keyName is 0/NULL, enumerate keys in section
      if (!keyNameWA) {
        const keys = section ? Object.keys(section) : [];
        const result = keys.join('\0') + '\0';
        return writeStr(bufGA, result, bufSize, isWide);
      }

      const keyName = readStr(keyNameWA, isWide);
      const value = section && section[keyName] !== undefined ? section[keyName] : null;

      if (value !== null) {
        return writeStr(bufGA, value, bufSize, isWide);
      }
      // Return default
      const def = defaultWA ? readStr(defaultWA, isWide) : '';
      return writeStr(bufGA, def, bufSize, isWide);
    },

    ini_get_int: (appNameWA, keyNameWA, nDefault, fileNameWA, isWide) => {
      const fileName = readStr(fileNameWA, isWide);
      const appName = readStr(appNameWA, isWide);
      const keyName = readStr(keyNameWA, isWide);
      const ini = _iniResolve(ctx.vfs, fileName);
      const section = ini.sections[appName];
      if (section && section[keyName] !== undefined) {
        const v = parseInt(section[keyName], 10);
        return isNaN(v) ? nDefault : v;
      }
      return nDefault;
    },

    ini_write_string: (appNameWA, keyNameWA, valueWA, fileNameWA, isWide) => {
      const fileName = readStr(fileNameWA, isWide);
      const appName = readStr(appNameWA, isWide);
      const ini = _iniGet(fileName);

      if (!keyNameWA) {
        // Delete entire section
        delete ini.sections[appName];
      } else {
        const keyName = readStr(keyNameWA, isWide);
        if (!ini.sections[appName]) ini.sections[appName] = {};
        if (!valueWA) {
          // Delete key
          delete ini.sections[appName][keyName];
        } else {
          ini.sections[appName][keyName] = readStr(valueWA, isWide);
        }
      }
      _iniPut(fileName, ini);
      return 1; // TRUE
    },
  };
}

// Export for both Node.js and browser
if (typeof module !== 'undefined') {
  module.exports = { createStorageImports };
}
if (typeof window !== 'undefined') {
  window.StorageImports = { createStorageImports };
}
