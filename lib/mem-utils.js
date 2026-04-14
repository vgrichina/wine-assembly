// Shared memory utilities for reading strings and address translation

const GUEST_BASE = 0x12000;

/**
 * Read a null-terminated ASCII string from WASM memory.
 * @param {ArrayBuffer|Uint8Array} mem - WASM memory (ArrayBuffer or Uint8Array)
 * @param {number} wasmAddr - address in WASM linear memory
 * @param {number} [maxLen=512] - maximum characters to read
 * @returns {string}
 */
function readStrA(mem, wasmAddr, maxLen = 512) {
  const bytes = mem instanceof Uint8Array ? mem : new Uint8Array(mem);
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const c = bytes[wasmAddr + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Read a null-terminated wide (UTF-16LE) string from WASM memory.
 * @param {ArrayBuffer|DataView} mem - WASM memory (ArrayBuffer or DataView)
 * @param {number} wasmAddr - address in WASM linear memory
 * @param {number} [maxLen=512] - maximum characters to read
 * @returns {string}
 */
function readStrW(mem, wasmAddr, maxLen = 512) {
  const dv = mem instanceof DataView ? mem : new DataView((mem instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && mem instanceof SharedArrayBuffer)) ? mem : mem.buffer);
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const c = dv.getUint16(wasmAddr + i * 2, true);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Convert guest (x86) address to WASM linear memory address.
 * @param {number} guestAddr - x86 virtual address
 * @param {number} imageBase - PE image base (typically 0x400000)
 * @returns {number} WASM linear memory offset
 */
function g2w(guestAddr, imageBase) {
  return guestAddr - imageBase + GUEST_BASE;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { readStrA, readStrW, g2w, GUEST_BASE };
} else if (typeof window !== 'undefined') {
  window.memUtils = { readStrA, readStrW, g2w, GUEST_BASE };
}
