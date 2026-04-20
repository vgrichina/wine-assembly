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

/**
 * Walk a call stack from ESP, looking for dwords that plausibly look like
 * return addresses — i.e. code in [codeLo, codeHi) preceded by a valid call
 * opcode (E8 rel32 or FF /r indirect call).
 *
 * @param {ArrayBuffer|Uint8Array} mem - WASM linear memory
 * @param {number} espGuest - ESP in guest (x86) virtual address space
 * @param {number} imageBase - PE image base (typically 0x400000)
 * @param {object} [opts]
 * @param {number} [opts.depth=64] - dwords to scan from ESP
 * @param {number} [opts.codeLo=0x74400000] - inclusive lower bound for code VAs
 * @param {number} [opts.codeHi=0x76000000] - exclusive upper bound for code VAs
 * @returns {Array<{off:number, val:number, tag:string}>} validated frames
 *   - off: offset from ESP in bytes
 *   - val: the candidate return address
 *   - tag: '*R' = preceded by E8 rel32, '*i' = preceded by FF /r indirect
 */
function walkStackFrame(mem, espGuest, imageBase, opts = {}) {
  const depth = opts.depth || 64;
  const codeLo = (opts.codeLo != null) ? opts.codeLo >>> 0 : 0x74400000;
  const codeHi = (opts.codeHi != null) ? opts.codeHi >>> 0 : 0x76000000;
  const bytes = mem instanceof Uint8Array ? mem : new Uint8Array(mem instanceof ArrayBuffer ? mem : mem.buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stackBase = espGuest - imageBase + GUEST_BASE;
  const frames = [];
  for (let i = 0; i < depth; i++) {
    const off = i * 4;
    if (stackBase + off + 4 > bytes.length) break;
    const w = dv.getUint32(stackBase + off, true) >>> 0;
    if (w < codeLo || w >= codeHi) continue;
    const wOff = w - imageBase + GUEST_BASE;
    if (wOff < 6 || wOff >= bytes.length) continue;
    const b5 = bytes[wOff - 5];
    const b2 = bytes[wOff - 2];
    const b6 = bytes[wOff - 6];
    let tag = '';
    if (b5 === 0xE8) tag = '*R';                     // E8 rel32 direct call
    else if (b2 === 0xFF || b6 === 0xFF) tag = '*i'; // FF /r indirect (2- or 6-byte)
    if (tag) frames.push({ off, val: w, tag });
  }
  return frames;
}

/**
 * Format walkStackFrame() output as a compact one-liner:
 *   "frame=[+0:0x744a901d*i,+44:0x744995a6*R,+68:0x7448ef14*R,...]"
 */
function formatFrames(frames, max = 16) {
  if (!frames.length) return '';
  return 'frame=[' + frames.slice(0, max)
    .map(f => `+${f.off.toString(16)}:0x${f.val.toString(16)}${f.tag}`)
    .join(',') + ']';
}

/**
 * Try to decode a packed MFC-style CString at the given guest address.
 * Layout observed in practice: 1-byte refcount at +0, null-terminated ASCII
 * string data at +1 (the common "refcounted-prefix" style). Returns null if
 * it doesn't look like one.
 *
 * @param {ArrayBuffer|Uint8Array} mem
 * @param {number} guestAddr - guest VA pointing at the REFCOUNT byte
 * @param {number} imageBase
 * @returns {null | {refcount:number, text:string, len:number}}
 */
function decodeMfcCString(mem, guestAddr, imageBase) {
  const bytes = mem instanceof Uint8Array ? mem : new Uint8Array(mem instanceof ArrayBuffer ? mem : mem.buffer);
  const wa = guestAddr - imageBase + GUEST_BASE;
  if (wa < 0 || wa + 2 > bytes.length) return null;
  const rc = bytes[wa];
  // Heuristic: refcount is typically small (<64) or 0xff ("locked"/static).
  if (rc !== 0xff && rc > 64) return null;
  let text = '';
  let len = -1;
  for (let i = 0; i < 256; i++) {
    if (wa + 1 + i >= bytes.length) return null;
    const c = bytes[wa + 1 + i];
    if (c === 0) { len = i; break; }
    if (c < 0x20 || c >= 0x7f) return null;
    text += String.fromCharCode(c);
  }
  if (len < 0) return null;
  return { refcount: rc, text, len };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { readStrA, readStrW, g2w, walkStackFrame, formatFrames, decodeMfcCString, GUEST_BASE };
} else if (typeof window !== 'undefined') {
  window.memUtils = { readStrA, readStrW, g2w, walkStackFrame, formatFrames, decodeMfcCString, GUEST_BASE };
}
