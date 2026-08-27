// Buffered transport for the OpenGL compatibility frontend.
//
// Guest-visible gl*/wgl* functions still enter one WASM host import, but that
// import records a compact command locally.  Cooperative execution replays the
// same stream on its own thread; a guest Worker crosses to the browser thread
// only when the stream reaches a semantic barrier or fills up.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GLCommandStream = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_BYTES = 2 * 1024 * 1024;
  const HEADER_BYTES = 32;
  const FLAG_POINTER_COPY = 1;
  const FLAG_POINTER_BORROW = 2;

  // Physical 32-bit stack words consumed by src/09a8b-handlers-opengl.wat.
  // Doubles occupy two words.  Keeping this beside the command format makes a
  // captured stack only as large as the command needs instead of copying an
  // arbitrary fixed window for every vertex.
  const ARG_WORDS = [
    2, 2, 1, 4, 1, 1, 1, 4, 1, 1, 1, 0, 0, 2, 1, 1,
    2, 7, 4, 1, 4, 1, 0, 3, 1, 4, 1, 1, 2, 2, 3, 1,
    12, 0, 1, 1, 12, 0, 0, 4, 3, 3, 2, 2, 3, 9, 3, 9,
    1, 1, 1, 2, 2, 4, 2, 1,
  ];

  // Calls whose result, output memory, context transition, or presentation is
  // visible to the guest.  They terminate the current stream and return the
  // result of the last command in that submission.
  const BARRIERS = new Set([
    11, // glFinish
    12, // glGetError
    13, // glGetFloatv
    17, // glReadPixels
    48, 49, 50, 51, 52, 53, 54, // WGL lifecycle/pixel-format operations
    55, // gpuPresent / SwapBuffers
  ]);

  const align4 = value => (value + 3) & ~3;

  function u32At(memory, stackWa, index) {
    return new DataView(memory).getUint32((stackWa >>> 0) + 4 + index * 4, true) >>> 0;
  }

  function componentCount(format) {
    switch (format >>> 0) {
      case 0x1906: // GL_ALPHA
      case 0x1909: // GL_LUMINANCE
        return 1;
      case 0x190A: // GL_LUMINANCE_ALPHA
        return 2;
      case 0x1907: // GL_RGB
      case 0x80E0: // GL_BGR
        return 3;
      case 0x1908: // GL_RGBA
      case 0x80E1: // GL_BGRA
        return 4;
      default:
        return 4;
    }
  }

  function pixelBytes(format, type) {
    switch (type >>> 0) {
      case 0x1400: // GL_BYTE
      case 0x1401: // GL_UNSIGNED_BYTE
        return componentCount(format);
      case 0x1402: // GL_SHORT
      case 0x1403: // GL_UNSIGNED_SHORT
        return componentCount(format) * 2;
      case 0x8363: // GL_UNSIGNED_SHORT_5_6_5
      case 0x8033: // GL_UNSIGNED_SHORT_4_4_4_4
      case 0x8034: // GL_UNSIGNED_SHORT_5_5_5_1
        return 2;
      case 0x1404: // GL_INT
      case 0x1405: // GL_UNSIGNED_INT
      case 0x1406: // GL_FLOAT
        return componentCount(format) * 4;
      default:
        return componentCount(format);
    }
  }

  function checkedImageBytes(width, height, format, type) {
    const row = Number(width >>> 0) * pixelBytes(format, type);
    const total = row * Number(height >>> 0);
    if (!Number.isSafeInteger(total) || total > 0x7fffffff) {
      throw new RangeError('GL texture upload is too large');
    }
    return total;
  }

  function pointerSpec(opcode, memory, stackWa) {
    let arg = -1, length = 0, borrow = false;
    switch (opcode | 0) {
      case 24: arg = 0; length = 12; break; // glColor3fv
      case 26: arg = 0; length = 16; break; // glColor4fv
      case 27: arg = 0; length = 4; break;  // glColor4ubv
      case 31: arg = 0; length = 12; break; // glVertex3fv
      case 34: arg = 0; length = 64; break; // glLoadMatrixf
      case 43: // glDeleteTextures(count, names)
        arg = 1; length = u32At(memory, stackWa, 0) * 4; break;
      case 45: { // glTexImage2D
        arg = 8;
        const width = u32At(memory, stackWa, 3);
        const height = u32At(memory, stackWa, 4);
        const format = u32At(memory, stackWa, 6);
        const type = u32At(memory, stackWa, 7);
        length = checkedImageBytes(width, height, format, type);
        borrow = true;
        break;
      }
      case 47: { // glTexSubImage2D
        arg = 8;
        const width = u32At(memory, stackWa, 4);
        const height = u32At(memory, stackWa, 5);
        const format = u32At(memory, stackWa, 6);
        const type = u32At(memory, stackWa, 7);
        length = checkedImageBytes(width, height, format, type);
        borrow = true;
        break;
      }
      default:
        return null;
    }
    const pointer = u32At(memory, stackWa, arg);
    if (!pointer || !length) return null;
    if (!Number.isSafeInteger(length) || length > 0x7fffffff) {
      throw new RangeError('GL pointer input is too large');
    }
    return { arg, pointer, length, borrow };
  }

  class Encoder {
    constructor(options) {
      options = options || {};
      this.getMemory = options.getMemory;
      this.guestToWasm = options.guestToWasm;
      this.submit = options.submit;
      if (typeof this.getMemory !== 'function' || typeof this.guestToWasm !== 'function'
          || typeof this.submit !== 'function') {
        throw new TypeError('GL command encoder needs getMemory, guestToWasm, and submit');
      }
      this.capacity = Math.max(256, options.capacity || DEFAULT_BYTES);
      const BufferType = options.shared !== false && typeof SharedArrayBuffer === 'function'
        ? SharedArrayBuffer : ArrayBuffer;
      this.buffer = new BufferType(this.capacity);
      this.bytes = new Uint8Array(this.buffer);
      this.view = new DataView(this.buffer);
      this.used = 0;
      this.commands = 0;
      this.submissions = 0;
    }

    _capture(opcode, stackWa, aux, pointer, borrowed) {
      const memory = this.getMemory();
      const words = ARG_WORDS[opcode | 0];
      if (words === undefined) throw new RangeError(`unknown GL opcode ${opcode}`);
      const stackBytes = 4 + words * 4;
      const pointerBytes = pointer && !borrowed ? pointer.length : 0;
      const recordBytes = align4(HEADER_BYTES + stackBytes + pointerBytes);
      if (recordBytes > this.capacity) return false;
      if (this.used + recordBytes > this.capacity) this.flush();

      const start = this.used;
      const stackOffset = start + HEADER_BYTES;
      const pointerOffset = pointerBytes ? stackOffset + stackBytes : 0;
      this.view.setUint32(start, recordBytes, true);
      this.view.setUint32(start + 4, opcode >>> 0, true);
      this.view.setUint32(start + 8, aux >>> 0, true);
      this.view.setUint32(start + 12, stackBytes, true);
      this.view.setUint32(start + 16, pointer ? pointer.pointer >>> 0 : 0, true);
      this.view.setUint32(start + 20, pointer ? pointer.length >>> 0 : 0, true);
      this.view.setUint32(start + 24, pointerOffset >>> 0, true);
      this.view.setUint32(start + 28, pointer
        ? (borrowed ? FLAG_POINTER_BORROW : FLAG_POINTER_COPY) : 0, true);

      const source = new Uint8Array(memory, stackWa >>> 0, stackBytes);
      this.bytes.set(source, stackOffset);
      if (pointerBytes) {
        const wa = this.guestToWasm(pointer.pointer >>> 0) >>> 0;
        this.bytes.set(new Uint8Array(memory, wa, pointerBytes), pointerOffset);
      }
      this.used += recordBytes;
      this.commands++;
      return true;
    }

    call(opcode, stackWa, aux) {
      opcode |= 0; stackWa >>>= 0; aux >>>= 0;
      const memory = this.getMemory();
      const pointer = pointerSpec(opcode, memory, stackWa);

      // OpenGL promises that client pixels have been consumed when a texture
      // upload returns.  Preserve that contract without a staging copy: drain
      // older commands, borrow the shared guest range in a one-command batch,
      // and keep the guest blocked until replay acknowledges it.
      if (pointer && pointer.borrow) {
        this.flush();
        if (!this._capture(opcode, stackWa, aux, pointer, true)) {
          throw new RangeError(`GL command ${opcode} does not fit empty buffer`);
        }
        return this.flush();
      }

      // An unexpectedly large pointer input follows the same safe borrowed
      // path.  This remains a batch submission, never a per-call host fallback.
      if (pointer && HEADER_BYTES + 4 + (ARG_WORDS[opcode] * 4) + pointer.length > this.capacity) {
        this.flush();
        if (!this._capture(opcode, stackWa, aux, pointer, true)) {
          throw new RangeError(`GL borrowed command ${opcode} does not fit empty buffer`);
        }
        return this.flush();
      }

      if (!this._capture(opcode, stackWa, aux, pointer, false)) {
        throw new RangeError(`GL command ${opcode} does not fit command buffer`);
      }
      return BARRIERS.has(opcode) ? this.flush() : 0;
    }

    flush() {
      if (!this.used) return 0;
      const batch = { buffer: this.buffer, bytes: this.used, commands: this.commands };
      let result = 0;
      try {
        result = this.submit(batch) | 0;
        this.submissions++;
      } finally {
        this.used = 0;
        this.commands = 0;
      }
      return result;
    }
  }

  function replay(batch, execute) {
    if (!batch || !batch.buffer) return 0;
    const limit = Math.min(batch.bytes >>> 0, batch.buffer.byteLength >>> 0);
    const view = new DataView(batch.buffer);
    let offset = 0, count = 0, result = 0;
    while (offset < limit) {
      if (offset + HEADER_BYTES > limit) throw new RangeError('truncated GL command header');
      const recordBytes = view.getUint32(offset, true);
      if (recordBytes < HEADER_BYTES || offset + recordBytes > limit) {
        throw new RangeError('invalid GL command length');
      }
      const opcode = view.getUint32(offset + 4, true) | 0;
      const capture = {
        buffer: batch.buffer,
        stackOffset: offset + HEADER_BYTES,
        stackBytes: view.getUint32(offset + 12, true),
        pointerGuest: view.getUint32(offset + 16, true) >>> 0,
        pointerLength: view.getUint32(offset + 20, true) >>> 0,
        pointerOffset: view.getUint32(offset + 24, true) >>> 0,
        pointerBorrowed: !!(view.getUint32(offset + 28, true) & FLAG_POINTER_BORROW),
      };
      if (capture.stackBytes > recordBytes - HEADER_BYTES
          || (capture.pointerOffset && (capture.pointerOffset < offset + HEADER_BYTES
            || capture.pointerOffset + capture.pointerLength > offset + recordBytes))) {
        throw new RangeError('invalid GL command payload');
      }
      result = execute(opcode, view.getUint32(offset + 8, true) >>> 0, capture) | 0;
      offset += recordBytes;
      count++;
    }
    if (offset !== limit || (batch.commands !== undefined && count !== (batch.commands | 0))) {
      throw new RangeError('GL command batch count mismatch');
    }
    return result;
  }

  return {
    DEFAULT_BYTES, HEADER_BYTES, FLAG_POINTER_COPY, FLAG_POINTER_BORROW,
    ARG_WORDS, BARRIERS, Encoder, pointerSpec, replay,
  };
});
