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
  // Internal command produced by the encoder. It is intentionally outside the
  // guest-visible gl*/wgl* opcode range.
  const PACKED_DRAW_OPCODE = 0x10000;
  const VERTEX_FLOATS = 9;

  const GL = {
    POINTS: 0x0000, LINES: 0x0001, LINE_LOOP: 0x0002, LINE_STRIP: 0x0003,
    TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005, TRIANGLE_FAN: 0x0006,
    QUADS: 0x0007, QUAD_STRIP: 0x0008, POLYGON: 0x0009,
    SMOOTH: 0x1D01, FLAT: 0x1D00,
  };

  // Physical 32-bit stack words consumed by src/09a8b-handlers-opengl.wat.
  // Doubles occupy two words.  Keeping this beside the command format makes a
  // captured stack only as large as the command needs instead of copying an
  // arbitrary fixed window for every vertex.
  const ARG_WORDS = [
    2, 2, 1, 4, 1, 1, 1, 4, 1, 1, 1, 0, 0, 2, 1, 1,
    2, 7, 4, 1, 4, 1, 0, 3, 1, 4, 1, 1, 2, 2, 3, 1,
    12, 0, 1, 1, 12, 0, 0, 4, 3, 3, 2, 2, 3, 9, 3, 9,
    1, 1, 1, 2, 2, 4, 3, 1, 4, 2, 1,
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

  function u32At(view, stackWa, index) {
    return view.getUint32((stackWa >>> 0) + 4 + index * 4, true) >>> 0;
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

  function appendVertex(out, vertices, index, colorStart) {
    const start = index * VERTEX_FLOATS;
    for (let i = 0; i < VERTEX_FLOATS; i++) {
      out.push(colorStart >= 0 && i >= 3 && i < 7
        ? vertices[colorStart + i - 3] : vertices[start + i]);
    }
  }

  function appendTriangle(out, vertices, a, b, c, flat, provoking = c) {
    const colorStart = flat ? provoking * VERTEX_FLOATS + 3 : -1;
    appendVertex(out, vertices, a, colorStart);
    appendVertex(out, vertices, b, colorStart);
    appendVertex(out, vertices, c, colorStart);
  }

  function appendLine(out, vertices, a, b, flat, provoking = b) {
    const colorStart = flat ? provoking * VERTEX_FLOATS + 3 : -1;
    appendVertex(out, vertices, a, colorStart);
    appendVertex(out, vertices, b, colorStart);
  }

  // Turn boundary-sensitive desktop primitives into independent WebGL
  // primitives. Independent triangles/lines can subsequently be concatenated
  // without accidentally joining adjacent glBegin/glEnd blocks.
  function normalizeImmediate(mode, vertices, shadeModel) {
    const count = vertices.length / VERTEX_FLOATS;
    const out = [];
    const flat = shadeModel === GL.FLAT;
    if (mode === GL.TRIANGLES && flat) {
      for (let i = 0; i + 2 < count; i += 3) {
        appendTriangle(out, vertices, i, i + 1, i + 2, true);
      }
    } else if (mode === GL.LINES && flat) {
      for (let i = 0; i + 1 < count; i += 2) appendLine(out, vertices, i, i + 1, true);
    } else if (mode === GL.QUADS) {
      for (let i = 0; i + 3 < count; i += 4) {
        // An independent quad's fourth vertex shades both lowered triangles.
        appendTriangle(out, vertices, i, i + 1, i + 2, flat, i + 3);
        appendTriangle(out, vertices, i, i + 2, i + 3, flat, i + 3);
      }
      mode = GL.TRIANGLES;
    } else if (mode === GL.QUAD_STRIP) {
      for (let i = 0; i + 3 < count; i += 2) {
        // GL_QUAD_STRIP uses the last vertex of each logical quad, not the
        // last vertex of each triangle produced for WebGL.
        appendTriangle(out, vertices, i, i + 1, i + 3, flat, i + 3);
        appendTriangle(out, vertices, i, i + 3, i + 2, flat, i + 3);
      }
      mode = GL.TRIANGLES;
    } else if (mode === GL.POLYGON) {
      // A single polygon is shaded by its first vertex in legacy OpenGL.
      for (let i = 1; i + 1 < count; i++) {
        appendTriangle(out, vertices, 0, i, i + 1, flat, 0);
      }
      mode = GL.TRIANGLES;
    } else if (mode === GL.TRIANGLE_FAN) {
      for (let i = 1; i + 1 < count; i++) {
        appendTriangle(out, vertices, 0, i, i + 1, flat, i + 1);
      }
      mode = GL.TRIANGLES;
    } else if (mode === GL.TRIANGLE_STRIP) {
      for (let i = 0; i + 2 < count; i++) {
        if (i & 1) appendTriangle(out, vertices, i + 1, i, i + 2, flat);
        else appendTriangle(out, vertices, i, i + 1, i + 2, flat);
      }
      mode = GL.TRIANGLES;
    } else if (mode === GL.LINE_LOOP || mode === GL.LINE_STRIP) {
      const edges = mode === GL.LINE_LOOP ? count : Math.max(0, count - 1);
      for (let i = 0; i < edges; i++) {
        const end = (i + 1) % count;
        appendLine(out, vertices, i, end, flat, end);
      }
      mode = GL.LINES;
    } else {
      return { mode, vertices: new Float32Array(vertices) };
    }
    return { mode, vertices: new Float32Array(out) };
  }

  function pointerSpec(opcode, view, stackWa) {
    let arg = -1, length = 0, borrow = false;
    switch (opcode | 0) {
      case 34: arg = 0; length = 64; break; // glLoadMatrixf
      case 43: // glDeleteTextures(count, names)
        arg = 1; length = u32At(view, stackWa, 0) * 4; break;
      case 45: { // glTexImage2D
        arg = 8;
        const width = u32At(view, stackWa, 3);
        const height = u32At(view, stackWa, 4);
        const format = u32At(view, stackWa, 6);
        const type = u32At(view, stackWa, 7);
        length = checkedImageBytes(width, height, format, type);
        borrow = true;
        break;
      }
      case 47: { // glTexSubImage2D
        arg = 8;
        const width = u32At(view, stackWa, 4);
        const height = u32At(view, stackWa, 5);
        const format = u32At(view, stackWa, 6);
        const type = u32At(view, stackWa, 7);
        length = checkedImageBytes(width, height, format, type);
        borrow = true;
        break;
      }
      default:
        return null;
    }
    const pointer = u32At(view, stackWa, arg);
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
      this.currentContext = 0;
      this.immediateStates = new Map();
      this.immediate = null;
      this.memoryBuffer = null;
      this.memoryView = null;
    }

    _state() {
      let state = this.immediateStates.get(this.currentContext);
      if (!state) {
        state = { color: [1, 1, 1, 1], texCoord: [0, 0], shadeModel: GL.SMOOTH };
        this.immediateStates.set(this.currentContext, state);
      }
      return state;
    }

    _f32(stackWa, index) {
      return this._memoryView().getFloat32((stackWa >>> 0) + 4 + index * 4, true);
    }

    _memoryView() {
      const memory = this.getMemory();
      if (memory !== this.memoryBuffer) {
        this.memoryBuffer = memory;
        this.memoryView = new DataView(memory);
      }
      return this.memoryView;
    }

    _pointerFloats(stackWa, count) {
      const pointer = u32At(this._memoryView(), stackWa, 0);
      const wa = this.guestToWasm(pointer) >>> 0;
      const view = this._memoryView();
      const out = [];
      for (let i = 0; i < count; i++) out.push(view.getFloat32(wa + i * 4, true));
      return out;
    }

    _setColor(opcode, stackWa) {
      const state = this._state();
      if (opcode === 23) state.color = [this._f32(stackWa, 0), this._f32(stackWa, 1), this._f32(stackWa, 2), 1];
      else if (opcode === 24) state.color = this._pointerFloats(stackWa, 3).concat(1);
      else if (opcode === 25) state.color = [0, 1, 2, 3].map(i => this._f32(stackWa, i));
      else if (opcode === 26) state.color = this._pointerFloats(stackWa, 4);
      else {
        const pointer = u32At(this._memoryView(), stackWa, 0);
        const wa = this.guestToWasm(pointer) >>> 0;
        const bytes = new Uint8Array(this.getMemory(), wa, 4);
        state.color = Array.from(bytes, value => value / 255);
      }
    }

    _appendVertex(opcode, stackWa) {
      if (!this.immediate) return false;
      let x, y, z;
      if (opcode === 29) {
        x = this._f32(stackWa, 0); y = this._f32(stackWa, 1); z = 0;
      } else if (opcode === 30) {
        x = this._f32(stackWa, 0); y = this._f32(stackWa, 1); z = this._f32(stackWa, 2);
      } else {
        [x, y, z] = this._pointerFloats(stackWa, 3);
      }
      const state = this._state();
      this.immediate.vertices.push(x, y, z, ...state.color, ...state.texCoord);
      return true;
    }

    _capturePacked(mode, vertices) {
      const groupVertices = mode === GL.TRIANGLES ? 3 : mode === GL.LINES ? 2 : 1;
      const maxFloats = Math.floor((this.capacity - HEADER_BYTES) / 4 / VERTEX_FLOATS)
        * VERTEX_FLOATS;
      const chunkFloats = Math.floor(maxFloats / (groupVertices * VERTEX_FLOATS))
        * groupVertices * VERTEX_FLOATS;
      if (!chunkFloats) throw new RangeError('GL command buffer cannot hold one packed primitive');
      for (let base = 0; base < vertices.length; base += chunkFloats) {
        const length = Math.min(chunkFloats, vertices.length - base);
        const recordBytes = align4(HEADER_BYTES + length * 4);
        if (this.used + recordBytes > this.capacity) this.flush();
        const start = this.used;
        const pointerOffset = start + HEADER_BYTES;
        this.view.setUint32(start, recordBytes, true);
        this.view.setUint32(start + 4, PACKED_DRAW_OPCODE, true);
        this.view.setUint32(start + 8, mode >>> 0, true);
        this.view.setUint32(start + 12, 0, true);
        this.view.setUint32(start + 16, 0, true);
        this.view.setUint32(start + 20, length * 4, true);
        this.view.setUint32(start + 24, pointerOffset, true);
        this.view.setUint32(start + 28, FLAG_POINTER_COPY, true);
        new Float32Array(this.buffer, pointerOffset, length).set(vertices.subarray(base, base + length));
        this.used += recordBytes;
        this.commands++;
      }
    }

    _finishImmediate() {
      const immediate = this.immediate;
      this.immediate = null;
      if (!immediate || !immediate.vertices.length) return;
      const geometry = normalizeImmediate(immediate.mode, immediate.vertices, this._state().shadeModel);
      if (geometry.vertices.length) this._capturePacked(geometry.mode, geometry.vertices);
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
      const memoryView = this._memoryView();

      // Immediate-mode state and vertices never enter the generic command
      // stream. Compile their final interleaved representation at glEnd.
      if (opcode >= 23 && opcode <= 27) {
        this._setColor(opcode, stackWa);
        return 0;
      }
      if (opcode === 56) {
        this._state().color = [0, 1, 2, 3]
          .map(i => (u32At(memoryView, stackWa, i) & 0xFF) / 255);
        return 0;
      }
      if (opcode === 58) {
        const pointer = u32At(memoryView, stackWa, 0);
        const wa = this.guestToWasm(pointer) >>> 0;
        const bytes = new Uint8Array(memory, wa, 3);
        this._state().color = Array.from(bytes, value => value / 255).concat(1);
        return 0;
      }
      if (opcode === 28) {
        this._state().texCoord = [this._f32(stackWa, 0), this._f32(stackWa, 1)];
        return 0;
      }
      if (opcode === 19) {
        if (this.immediate) throw new RangeError(`GL opcode ${opcode} inside glBegin/glEnd`);
        this._state().shadeModel = u32At(memoryView, stackWa, 0);
        return 0;
      }
      if (opcode === 21) {
        if (this.immediate) throw new RangeError('nested glBegin is unsupported');
        this.immediate = { mode: u32At(memoryView, stackWa, 0), vertices: [] };
        return 0;
      }
      if (opcode >= 29 && opcode <= 31) {
        this._appendVertex(opcode, stackWa);
        return 0;
      }
      if (opcode === 22) {
        if (this.immediate) this._finishImmediate();
        return 0;
      }
      if (this.immediate) throw new RangeError(`GL opcode ${opcode} inside glBegin/glEnd`);
      const pointer = pointerSpec(opcode, memoryView, stackWa);

      // OpenGL promises that client pixels have been consumed when a texture
      // upload returns. Preserve that contract without a staging copy: append
      // the borrowed range to the pending stream, then keep the guest blocked
      // until the single ordered submission has replayed it.
      if (pointer && pointer.borrow) {
        if (!this._capture(opcode, stackWa, aux, pointer, true)) {
          throw new RangeError(`GL command ${opcode} does not fit empty buffer`);
        }
        return this.flush();
      }

      // An unexpectedly large pointer input follows the same safe borrowed
      // path.  This remains a batch submission, never a per-call host fallback.
      if (pointer && HEADER_BYTES + 4 + (ARG_WORDS[opcode] * 4) + pointer.length > this.capacity) {
        if (!this._capture(opcode, stackWa, aux, pointer, true)) {
          throw new RangeError(`GL borrowed command ${opcode} does not fit empty buffer`);
        }
        return this.flush();
      }

      if (!this._capture(opcode, stackWa, aux, pointer, false)) {
        throw new RangeError(`GL command ${opcode} does not fit command buffer`);
      }
      const result = BARRIERS.has(opcode) ? this.flush() : 0;
      if (opcode === 51 && result) this.currentContext = u32At(memoryView, stackWa, 1);
      if (opcode === 49 && result) {
        const deleted = u32At(memoryView, stackWa, 0);
        this.immediateStates.delete(deleted);
        if (this.currentContext === deleted) this.currentContext = 0;
      }
      return result;
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
    PACKED_DRAW_OPCODE, ARG_WORDS, BARRIERS, Encoder, pointerSpec,
    normalizeImmediate, replay,
  };
});
