// Shared memory utilities for reading strings and address translation

// Addresses come from the region map generated out of src/00-regions.wat
// (docs/watx-region-safety-design.md §6): every non-pinned region is placed by
// the allocator now, so a literal copy here is a stale address the moment a
// declaration changes size. In the browser the map arrives as the global
// lib/region-map.generated.js installs, which index.html loads before this file.
var _regionMap = typeof require !== 'undefined' ? require('./region-map.generated')
  : (typeof self !== 'undefined' ? self.RegionMap : globalThis.RegionMap);

const GUEST_BASE = _regionMap.GUEST_BASE;
// The limit of the $DIRECT_WINDOW span in src/00-regions.wat. A span is a named
// bound, not a placed region, so the generated mirror does not carry it — and
// this one is a hard ABI number anyway: it is where image-relative translation
// stops and the VirtualAlloc map takes over.
const DIRECT_GUEST_WINDOW = 0x08000000;
const NULL_SENTINEL = 0xF0;
const GUEST_PAGE_TABLE = _regionMap.BASE.GUEST_PAGE_TABLE;
const GUEST_PAGE_TABLE_SIZE = _regionMap.SIZE.GUEST_PAGE_TABLE;
const GUEST_PTE_PRESENT = 0x800;
const GUEST_PTE_BACKING_MASK = 0xFFFFF000;
// CreateDIBSection hands the guest pointers into a dedicated high range backed
// by the final 63MB before THREAD_RPC. Must match $DIB_GUEST_BASE /
// $DIB_GUEST_CAPACITY / $DIB_BACKING_BASE in src/01-header.wat.
const DIB_GUEST_BASE = 0x50000000;
const DIB_GUEST_CAPACITY = 0x03F00000;
const DIB_BACKING_BASE = 0x1C000000;

function memoryBufferOf(mem) {
  if (!mem) return mem;
  if (mem instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && mem instanceof SharedArrayBuffer)) {
    return mem;
  }
  return mem.buffer || mem;
}

// WebAssembly.Memory.buffer changes identity if a non-shared memory grows, so
// cache by the actual buffer rather than by the Memory wrapper. Shared browser
// instances publish/clear PTEs atomically; readers must pair with those writes
// instead of racing through an ordinary DataView load.
const _guestPageViews = new WeakMap();

function guestPageView(buffer) {
  if (!buffer || buffer.byteLength < GUEST_PAGE_TABLE + GUEST_PAGE_TABLE_SIZE) {
    return null;
  }
  let cached = _guestPageViews.get(buffer);
  if (!cached) {
    cached = {
      words: new Uint32Array(buffer, GUEST_PAGE_TABLE, GUEST_PAGE_TABLE_SIZE >>> 2),
      shared: typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer,
    };
    _guestPageViews.set(buffer, cached);
  }
  return cached;
}

function loadGuestPte(view, guestAddr) {
  const index = (guestAddr >>> 0) >>> 12;
  return view.shared ? Atomics.load(view.words, index) >>> 0 : view.words[index] >>> 0;
}

/**
 * Read a null-terminated ASCII string from WASM memory.
 * @param {ArrayBuffer|Uint8Array} mem - WASM memory (ArrayBuffer or Uint8Array)
 * @param {number} wasmAddr - address in WASM linear memory
 * @param {number} [maxLen=512] - maximum characters to read
 * @returns {string}
 */
function readStrA(mem, wasmAddr, maxLen = 512) {
  const bytes = mem instanceof Uint8Array ? mem : new Uint8Array(memoryBufferOf(mem));
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
  const dv = mem instanceof DataView ? mem : new DataView(memoryBufferOf(mem));
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const c = dv.getUint16(wasmAddr + i * 2, true);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Decode the optional name passed to the shared event/mutex host import.
 * Bit 0 selects UTF-16LE; other flag bits describe the object type and must
 * not affect decoding. Invalid or truncated guest ranges are treated as an
 * absent name, matching the host import's unnamed-object fallback.
 */
function readSyncObjectName(mem, wasmAddr, flags, maxLen = 512) {
  const address = wasmAddr >>> 0;
  if (!address) return '';
  const buffer = memoryBufferOf(mem);
  const valid = buffer instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer);
  if (!valid || address >= buffer.byteLength) return '';
  const wide = !!(flags & 1);
  const available = Math.floor((buffer.byteLength - address) / (wide ? 2 : 1));
  const bounded = Math.min(maxLen, available);
  if (bounded <= 0) return '';
  return wide ? readStrW(buffer, address, bounded) : readStrA(buffer, address, bounded);
}

/**
 * Convert guest (x86) address to WASM linear memory address.
 * @param {number} guestAddr - x86 virtual address
 * @param {number} imageBase - PE image base (typically 0x400000)
 * @param {ArrayBuffer|SharedArrayBuffer|WebAssembly.Memory} [memory] - optional memory containing packed sparse-page translations
 * @returns {number} WASM linear memory offset
 */
function g2w(guestAddr, imageBase, memory) {
  const addr = guestAddr >>> 0;
  const wa = (addr - (imageBase >>> 0) + GUEST_BASE) >>> 0;
  if (wa < DIRECT_GUEST_WINDOW) return wa;
  // Same order as WAT's $g2w: the DIB arena is tested only after the direct
  // window misses, and before the sparse packed-PTE lookup.
  const dibOff = (addr - DIB_GUEST_BASE) >>> 0;
  if (dibOff < DIB_GUEST_CAPACITY) return (DIB_BACKING_BASE + dibOff) >>> 0;
  const pages = guestPageView(memoryBufferOf(memory));
  if (pages) {
    const pte = loadGuestPte(pages, addr);
    if (pte & GUEST_PTE_PRESENT) {
      return ((pte & GUEST_PTE_BACKING_MASK) | (addr & 0xFFF)) >>> 0;
    }
    return NULL_SENTINEL;
  }
  return wa;
}

/**
 * Resolve a guest pointer through an instance when possible, or through the
 * shared JavaScript translator for hosts that are still assembling one.
 *
 * This is the one host-boundary entry point: callers no longer need to choose
 * between the WAT export, direct-window arithmetic, DIB handling, and packed
 * sparse PTEs themselves.
 */
function guestToWasm(guestAddr, exports, memory, fallbackImageBase = 0x400000) {
  const addr = guestAddr >>> 0;
  if (exports && typeof exports.guest_to_wasm === 'function') {
    return exports.guest_to_wasm(addr) >>> 0;
  }
  const imageBase = exports && typeof exports.get_image_base === 'function'
    ? exports.get_image_base() >>> 0
    : fallbackImageBase >>> 0;
  return g2w(addr, imageBase, memory);
}

/**
 * How many bytes from `guestAddr` are contiguous in linear memory.
 *
 * Guest addresses inside a sparse VirtualAlloc region are contiguous to the
 * guest but their backings are not: consecutive mappings get consecutive
 * slabs in allocation order, not in guest-address order, so two adjacent
 * guest regions can have unrelated backings with a third region's slab
 * between them. Any bulk copy that translates once and then walks `n` bytes
 * will scribble straight through that neighbour.
 *
 * Returns the largest run starting at guestAddr, capped at `max`. Callers do
 * one translation per run and loop.
 */
function g2wSpan(guestAddr, max, imageBase, memory) {
  const addr = guestAddr >>> 0;
  const wa = (addr - (imageBase >>> 0) + GUEST_BASE) >>> 0;
  if (wa < DIRECT_GUEST_WINDOW) {
    // The direct window is one flat block; it ends at DIRECT_GUEST_WINDOW.
    return Math.min(max, (DIRECT_GUEST_WINDOW - wa) >>> 0);
  }
  // The DIB arena is flat too: guest offset maps straight onto backing offset,
  // so a run is contiguous up to the end of the arena.
  const dibOff = (addr - DIB_GUEST_BASE) >>> 0;
  if (dibOff < DIB_GUEST_CAPACITY) return Math.min(max, DIB_GUEST_CAPACITY - dibOff);
  const pages = guestPageView(memoryBufferOf(memory));
  if (!pages) return max;
  const first = loadGuestPte(pages, addr);
  if (!(first & GUEST_PTE_PRESENT)) return Math.min(max, 4);

  // The first partial page is always affine. Extend the run one full page at
  // a time only while each PTE names the next physical backing page. Adjacent
  // guest VirtualAlloc regions can have unrelated backings, so map-record
  // containment alone is not sufficient evidence for a linear JS view.
  const boundedMax = Math.min(max, 0x100000000 - addr);
  let span = Math.min(boundedMax, 0x1000 - (addr & 0xFFF));
  let nextGuest = (addr - (addr & 0xFFF)) + 0x1000;
  let nextBacking = (first & GUEST_PTE_BACKING_MASK) + 0x1000;
  while (span < boundedMax && nextGuest < 0x100000000) {
    const pte = loadGuestPte(pages, nextGuest);
    if (!(pte & GUEST_PTE_PRESENT) ||
        (pte & GUEST_PTE_BACKING_MASK) !== (nextBacking >>> 0)) break;
    span += Math.min(boundedMax - span, 0x1000);
    nextGuest += 0x1000;
    nextBacking += 0x1000;
  }
  return span;
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
  const buffer = memoryBufferOf(mem);
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const stackBase = g2w(espGuest, imageBase, buffer);
  const frames = [];
  if (stackBase === NULL_SENTINEL) return frames;
  for (let i = 0; i < depth; i++) {
    const off = i * 4;
    if (stackBase + off + 4 > bytes.length) break;
    const w = dv.getUint32(stackBase + off, true) >>> 0;
    if (w < codeLo || w >= codeHi) continue;
    const wOff = g2w(w, imageBase, buffer);
    if (wOff === NULL_SENTINEL || wOff < 6 || wOff >= bytes.length) continue;
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
  const buffer = memoryBufferOf(mem);
  const bytes = new Uint8Array(buffer);
  const wa = g2w(guestAddr, imageBase, buffer);
  if (wa === NULL_SENTINEL || wa + 2 > bytes.length) return null;
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

const memUtilsApi = {
  memoryBufferOf, readStrA, readStrW, readSyncObjectName,
  g2w, g2wSpan, guestToWasm, walkStackFrame, formatFrames,
  decodeMfcCString, GUEST_BASE,
  DIB_GUEST_BASE, DIB_GUEST_CAPACITY, DIB_BACKING_BASE,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = memUtilsApi;
} else if (typeof globalThis !== 'undefined') {
  // Classic browser scripts and importScripts() Workers share the same API.
  globalThis.memUtils = memUtilsApi;
}
