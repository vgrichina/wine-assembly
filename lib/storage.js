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
  const parent = _regHandles[hKey];
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
  const h = 0xBEEF0000 + (_nextRegHandle++);
  _regHandles[h] = path;
  return h;
}

// ---- INI Files ----
// Stored as: "ini:<filename lowercase>" → JSON { sections: { "SectionName": { "Key": "Value" } } }

function _iniGet(fileName) {
  const norm = fileName.toLowerCase().replace(/\\/g, '/').split('/').pop();
  const raw = _store.get('ini:' + norm);
  return raw ? JSON.parse(raw) : { sections: {} };
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
function createStorageImports(ctx) {
  const readStrA = (wasmAddr, maxLen = 260) => {
    const mem = new Uint8Array(ctx.getMemory());
    let s = '';
    for (let i = 0; i < maxLen; i++) {
      const c = mem[wasmAddr + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const readStrW = (wasmAddr, maxLen = 260) => {
    const dv = new DataView(ctx.getMemory());
    let s = '';
    for (let i = 0; i < maxLen; i++) {
      const c = dv.getUint16(wasmAddr + i * 2, true);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const readStr = (wasmAddr, isWide, maxLen) => isWide ? readStrW(wasmAddr, maxLen) : readStrA(wasmAddr, maxLen);

  const writeStrA = (guestAddr, str, maxLen) => {
    const mem = new Uint8Array(ctx.getMemory());
    const exports = ctx.exports;
    const g2w = exports ? (addr => addr - exports.get_image_base() + 0x12000) : (addr => addr);
    const wa = g2w(guestAddr);
    const len = Math.min(str.length, maxLen - 1);
    for (let i = 0; i < len; i++) mem[wa + i] = str.charCodeAt(i) & 0xFF;
    mem[wa + len] = 0;
    return len;
  };

  const writeStrW = (guestAddr, str, maxLen) => {
    const dv = new DataView(ctx.getMemory());
    const exports = ctx.exports;
    const g2w = exports ? (addr => addr - exports.get_image_base() + 0x12000) : (addr => addr);
    const wa = g2w(guestAddr);
    const len = Math.min(str.length, maxLen - 1);
    for (let i = 0; i < len; i++) dv.setUint16(wa + i * 2, str.charCodeAt(i), true);
    dv.setUint16(wa + len * 2, 0, true);
    return len;
  };

  const writeStr = (guestAddr, str, maxLen, isWide) => isWide ? writeStrW(guestAddr, str, maxLen) : writeStrA(guestAddr, str, maxLen);

  const gs32 = (guestAddr, val) => {
    const exports = ctx.exports;
    const g2w = exports ? (addr => addr - exports.get_image_base() + 0x12000) : (addr => addr);
    new DataView(ctx.getMemory()).setUint32(g2w(guestAddr), val, true);
  };

  const gl32 = (guestAddr) => {
    const exports = ctx.exports;
    const g2w = exports ? (addr => addr - exports.get_image_base() + 0x12000) : (addr => addr);
    return new DataView(ctx.getMemory()).getUint32(g2w(guestAddr), true);
  };

  return {
    // ---- Registry ----
    reg_open_key: (hKey, subKeyWA, isWide) => {
      const subKey = readStr(subKeyWA, isWide);
      const path = _regKeyPath(hKey, subKey);
      // Check if key exists in storage
      const raw = _store.get('reg:' + path);
      if (raw !== null) return _allocRegHandle(path);
      // Key doesn't exist — return 0 (failure)
      return 0;
    },

    reg_create_key: (hKey, subKeyWA, phkResultGA, isWide) => {
      const subKey = readStr(subKeyWA, isWide);
      const path = _regKeyPath(hKey, subKey);
      // Create key if it doesn't exist
      const existing = _store.get('reg:' + path);
      if (existing === null) _regPut(path, { values: {} });
      const h = _allocRegHandle(path);
      if (phkResultGA) gs32(phkResultGA, h);
      return 0; // ERROR_SUCCESS
    },

    reg_query_value: (hKey, nameWA, typeGA, dataGA, cbDataGA, isWide) => {
      const path = _regHandles[hKey];
      if (!path) return 2; // ERROR_FILE_NOT_FOUND
      const name = nameWA ? readStr(nameWA, isWide) : '';
      const entry = _regGet(path);
      const val = entry.values[name];
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
      const path = _regHandles[hKey];
      if (!path) return 2;
      const name = nameWA ? readStr(nameWA, isWide) : '';
      const entry = _regGet(path);

      if (type === 4) { // REG_DWORD
        entry.values[name] = { type: 4, data: gl32(dataGA) };
      } else { // REG_SZ, REG_EXPAND_SZ, etc.
        const str = isWide ? readStrW(dataGA, cbData / 2) : readStrA(dataGA, cbData);
        entry.values[name] = { type: type || 1, data: str };
      }
      _regPut(path, entry);
      return 0; // ERROR_SUCCESS
    },

    reg_close_key: (hKey) => {
      delete _regHandles[hKey];
      return 0;
    },

    // ---- INI Files ----
    ini_get_string: (appNameWA, keyNameWA, defaultWA, bufGA, bufSize, fileNameWA, isWide) => {
      const fileName = readStr(fileNameWA, isWide);
      const ini = _iniGet(fileName);

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
      const ini = _iniGet(fileName);
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
