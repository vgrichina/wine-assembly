// OpenGL 1.x fixed-function frontend lowered to the generic GPU backend.
(function (root, factory) {
  const backendApi = typeof module !== 'undefined' && module.exports
    ? require('./gpu-backend') : root.GpuBackend;
  const commandApi = typeof module !== 'undefined' && module.exports
    ? require('./gl-command-stream') : root.GLCommandStream;
  // The fixed memory map, generated from src/00-regions.wat's declarations
  // (docs/watx-region-safety-design.md §6); the fallback g2w below reads
  // $GUEST_BASE from it instead of keeping its own copy.
  const regionMap = typeof module !== 'undefined' && module.exports
    ? require('./region-map.generated') : root.RegionMap;
  const api = factory(backendApi, commandApi, regionMap);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OpenGLCompat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (GpuBackend, GLCommandStream, RegionMap) {
  'use strict';

  const GL_CALLS = [
    'glAlphaFunc', 'glBlendFunc', 'glClear', 'glClearColor', 'glCullFace',
    'glDepthFunc', 'glDepthMask', 'glDepthRange', 'glDisable', 'glDrawBuffer',
    'glEnable', 'glFinish', 'glGetError', 'glGetFloatv', 'glGetString',
    'glPointSize', 'glPolygonMode', 'glReadPixels', 'glScissor', 'glShadeModel',
    'glViewport', 'glBegin', 'glEnd', 'glColor3f', 'glColor3fv', 'glColor4f',
    'glColor4fv', 'glColor4ubv', 'glTexCoord2f', 'glVertex2f', 'glVertex3f',
    'glVertex3fv', 'glFrustum', 'glLoadIdentity', 'glLoadMatrixf', 'glMatrixMode',
    'glOrtho', 'glPopMatrix', 'glPushMatrix', 'glRotatef', 'glScalef',
    'glTranslatef', 'glBindTexture', 'glDeleteTextures', 'glTexEnvf',
    'glTexImage2D', 'glTexParameterf', 'glTexSubImage2D',
  ];
  const WGL_CALLS = [
    'wglCreateContext', 'wglDeleteContext', 'wglGetProcAddress',
    'wglMakeCurrent', 'wglChoosePixelFormat', 'wglDescribePixelFormat',
    'wglSetPixelFormat',
  ];
  // Opcode 55 is a backend presentation operation reached by authentic
  // GDI32!SwapBuffers and the legacy wglSwapBuffers spelling dynamically
  // requested by Quake II's 1998 ref_gl.dll.
  // Keep additions after gpuPresent so the long-lived GL/WGL opcode ABI used
  // by the Worker command stream does not shift. GoldSrc calls the scalar
  // colour form while drawing its software-generated lightmap polygons.
  const GPU_CALLS = ['gpuPresent', 'glColor4ub', 'glPolygonOffset', 'glColor3ubv'];
  const CALLS = GL_CALLS.concat(WGL_CALLS, GPU_CALLS);
  const CALL_INDEX = Object.fromEntries(CALLS.map((name, index) => [name, index]));

  const C = {
    FALSE: 0, TRUE: 1,
    POINTS: 0x0000, LINES: 0x0001, LINE_LOOP: 0x0002, LINE_STRIP: 0x0003,
    TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005, TRIANGLE_FAN: 0x0006,
    QUADS: 0x0007, QUAD_STRIP: 0x0008, POLYGON: 0x0009,
    MODELVIEW: 0x1700, PROJECTION: 0x1701, TEXTURE: 0x1702,
    MODELVIEW_MATRIX: 0x0BA6, PROJECTION_MATRIX: 0x0BA7, TEXTURE_MATRIX: 0x0BA8,
    MAX_TEXTURE_SIZE: 0x0D33,
    TEXTURE_2D: 0x0DE1, ALPHA_TEST: 0x0BC0, BLEND: 0x0BE2,
    DEPTH_TEST: 0x0B71, CULL_FACE: 0x0B44, SCISSOR_TEST: 0x0C11,
    POLYGON_OFFSET_FILL: 0x8037,
    SMOOTH: 0x1D01, FLAT: 0x1D00,
    TEXTURE_ENV: 0x2300, TEXTURE_ENV_MODE: 0x2200,
    MODULATE: 0x2100, REPLACE: 0x1E01,
    CLAMP: 0x2900, CLAMP_TO_EDGE: 0x812F,
    RGB: 0x1907, RGBA: 0x1908, ALPHA: 0x1906, LUMINANCE: 0x1909,
    UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406,
    NO_ERROR: 0,
  };

  function identity() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }

  function stackTop(stack) {
    return stack[stack.length - 1];
  }

  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[col * 4 + row] =
          a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] +
          a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
      }
    }
    return out;
  }

  function translation(x, y, z) {
    const out = identity(); out[12] = x; out[13] = y; out[14] = z; return out;
  }
  function scale(x, y, z) {
    const out = identity(); out[0] = x; out[5] = y; out[10] = z; return out;
  }
  function rotation(angle, x, y, z) {
    const length = Math.hypot(x, y, z) || 1;
    x /= length; y /= length; z /= length;
    const r = angle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), t = 1 - c;
    return new Float32Array([
      x * x * t + c, y * x * t + z * s, z * x * t - y * s, 0,
      x * y * t - z * s, y * y * t + c, z * y * t + x * s, 0,
      x * z * t + y * s, y * z * t - x * s, z * z * t + c, 0,
      0, 0, 0, 1,
    ]);
  }
  function frustum(l, r, b, t, n, f) {
    const out = new Float32Array(16);
    out[0] = 2 * n / (r - l); out[5] = 2 * n / (t - b);
    out[8] = (r + l) / (r - l); out[9] = (t + b) / (t - b);
    out[10] = -(f + n) / (f - n); out[11] = -1;
    out[14] = -(2 * f * n) / (f - n);
    return out;
  }
  function ortho(l, r, b, t, n, f) {
    const out = identity();
    out[0] = 2 / (r - l); out[5] = 2 / (t - b); out[10] = -2 / (f - n);
    out[12] = -(r + l) / (r - l); out[13] = -(t + b) / (t - b);
    out[14] = -(f + n) / (f - n);
    return out;
  }

  const VERTEX_SHADER = `
    attribute vec3 aPosition;
    attribute vec4 aColor;
    attribute vec2 aTexCoord;
    uniform mat4 uModelView;
    uniform mat4 uProjection;
    uniform mat4 uTextureMatrix;
    uniform float uPointSize;
    varying vec4 vColor;
    varying vec2 vTexCoord;
    void main() {
      gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
      vColor = aColor;
      vTexCoord = (uTextureMatrix * vec4(aTexCoord, 0.0, 1.0)).xy;
      gl_PointSize = uPointSize;
    }`;
  const FRAGMENT_SHADER = `
    precision mediump float;
    uniform sampler2D uTexture;
    uniform int uTextureEnabled;
    uniform int uTextureMode;
    uniform int uAlphaEnabled;
    uniform int uAlphaFunc;
    uniform float uAlphaRef;
    varying vec4 vColor;
    varying vec2 vTexCoord;
    bool alphaPass(float a) {
      if (uAlphaFunc == 0) return false;
      if (uAlphaFunc == 1) return a < uAlphaRef;
      if (uAlphaFunc == 2) return abs(a - uAlphaRef) < 0.00392157;
      if (uAlphaFunc == 3) return a <= uAlphaRef;
      if (uAlphaFunc == 4) return a > uAlphaRef;
      if (uAlphaFunc == 5) return abs(a - uAlphaRef) >= 0.00392157;
      if (uAlphaFunc == 6) return a >= uAlphaRef;
      return true;
    }
    void main() {
      vec4 color = vColor;
      if (uTextureEnabled != 0) {
        vec4 texel = texture2D(uTexture, vTexCoord);
        color = uTextureMode == 1 ? texel : texel * color;
      }
      if (uAlphaEnabled != 0 && !alphaPass(color.a)) discard;
      gl_FragColor = color;
    }`;

  class FixedFunctionGL {
    constructor(backend) {
      this.backend = backend;
      this.gl = backend.gl;
      this.program = backend.createProgram(VERTEX_SHADER, FRAGMENT_SHADER,
        ['aPosition', 'aColor', 'aTexCoord'],
        ['uModelView', 'uProjection', 'uTextureMatrix', 'uPointSize',
          'uTexture', 'uTextureEnabled', 'uTextureMode', 'uAlphaEnabled',
          'uAlphaFunc', 'uAlphaRef']);
      this.vertexBuffer = backend.createBuffer();
      this.indexBuffer = backend.createBuffer();
      this.matrixMode = C.MODELVIEW;
      this.matrices = {
        [C.MODELVIEW]: [identity()], [C.PROJECTION]: [identity()], [C.TEXTURE]: [identity()],
      };
      this.textures = new Map();
      this.boundTextureName = 0;
      // Desktop GL texture name zero is a real default object whose parameters
      // and image may be changed. WebGL's null binding is not mutable, so give
      // the GL1 frontend an owned backing texture for that default object.
      this.defaultTexture = backend.createTexture();
      this.enabled = new Set();
      this.clearColor = [0, 0, 0, 0];
      this.alphaFunc = 0x0207;
      this.alphaRef = 0;
      this.textureMode = C.MODULATE;
      this.pointSize = 1;
      this.depthRangeReversed = false;
      this.lastError = C.NO_ERROR;
      this.uniformDirty = new Set([
        'uModelView', 'uProjection', 'uTextureMatrix', 'uPointSize',
        'uTexture', 'uTextureEnabled', 'uTextureMode', 'uAlphaEnabled',
        'uAlphaFunc', 'uAlphaRef',
      ]);
      this.attributes = [
        { name: 'aPosition', size: 3, offset: 0 },
        { name: 'aColor', size: 4, offset: 12 },
        { name: 'aTexCoord', size: 2, offset: 28 },
      ];
      this.pendingDraw = null;
    }

    _stack() { return this.matrices[this.matrixMode]; }
    _matrix() { const s = this._stack(); return s[s.length - 1]; }
    _matrixUniform() {
      return this.matrixMode === C.MODELVIEW ? 'uModelView'
        : this.matrixMode === C.PROJECTION ? 'uProjection' : 'uTextureMatrix';
    }
    _replaceMatrix(value) {
      const s = this._stack();
      s[s.length - 1] = new Float32Array(value);
      this.uniformDirty.add(this._matrixUniform());
    }
    _multMatrix(value) { this._replaceMatrix(multiply(this._matrix(), value)); }

    enqueuePacked(mode, vertices) {
      if (!vertices.length) return;
      if (this.pendingDraw && this.pendingDraw.mode !== (mode | 0)) this.flushPendingDraw();
      if (!this.pendingDraw) this.pendingDraw = { mode: mode | 0, chunks: [], floats: 0 };
      this.pendingDraw.chunks.push(vertices);
      this.pendingDraw.floats += vertices.length;
    }

    flushPendingDraw() {
      const pending = this.pendingDraw;
      if (!pending) return;
      this.pendingDraw = null;
      let vertices = pending.chunks[0];
      if (pending.chunks.length > 1) {
        vertices = new Float32Array(pending.floats);
        let offset = 0;
        for (const chunk of pending.chunks) {
          vertices.set(chunk, offset);
          offset += chunk.length;
        }
      }
      this._drawGeometry({ mode: pending.mode, vertices });
    }

    _applyUniforms() {
      if (!this.uniformDirty.size) return;
      let projection = stackTop(this.matrices[C.PROJECTION]);
      if (this.depthRangeReversed) {
        projection = new Float32Array(projection);
        // Desktop OpenGL permits glDepthRange(near > far), which GoldSrc uses
        // for its z-trick. WebGL rejects that ordering. Negating clip-space Z
        // and submitting the sorted range is algebraically identical.
        for (const index of [2, 6, 10, 14]) projection[index] = -projection[index];
      }
      const values = {
        uModelView: ['matrix4', stackTop(this.matrices[C.MODELVIEW])],
        uProjection: ['matrix4', projection],
        uTextureMatrix: ['matrix4', stackTop(this.matrices[C.TEXTURE])],
        uPointSize: ['1f', this.pointSize],
        uTexture: ['1i', 0],
        uTextureEnabled: ['1i', this.enabled.has(C.TEXTURE_2D) ? 1 : 0],
        uTextureMode: ['1i', this.textureMode === C.REPLACE ? 1 : 0],
        uAlphaEnabled: ['1i', this.enabled.has(C.ALPHA_TEST) ? 1 : 0],
        uAlphaFunc: ['1i', Math.max(0, Math.min(7, this.alphaFunc - 0x0200))],
        uAlphaRef: ['1f', this.alphaRef],
      };
      for (const name of this.uniformDirty) {
        const entry = values[name];
        this.backend.setUniform(this.program, name, entry[0], entry[1]);
      }
      this.uniformDirty.clear();
    }

    setDepthRange(nearValue, farValue) {
      this.flushPendingDraw();
      const reversed = nearValue > farValue;
      if (reversed !== this.depthRangeReversed) {
        this.depthRangeReversed = reversed;
        this.uniformDirty.add('uProjection');
      }
      this.backend.setDepthRange(
        reversed ? farValue : nearValue,
        reversed ? nearValue : farValue);
    }

    _drawGeometry(geometry) {
      if (!geometry.vertices.length) return;
      const gl = this.gl;
      this.backend.updateBuffer(this.vertexBuffer, gl.ARRAY_BUFFER,
        geometry.vertices, gl.STREAM_DRAW);
      this.backend.useProgram(this.program);
      this._applyUniforms();
      this.backend.bindTexture(this._boundTexture(), 0);
      this.backend.draw({
        program: this.program, vertexBuffer: this.vertexBuffer,
        mode: geometry.mode, count: geometry.vertices.length / 9, stride: 36,
        attributes: this.attributes,
      });
    }

    setEnabled(capability, value) {
      const changed = this.enabled.has(capability) !== !!value;
      if (value) this.enabled.add(capability); else this.enabled.delete(capability);
      const gl = this.gl;
      if ([C.BLEND, C.DEPTH_TEST, C.CULL_FACE, C.SCISSOR_TEST,
        C.POLYGON_OFFSET_FILL].includes(capability)) {
        this.backend.setCapability(capability, value);
      }
      // TEXTURE_2D and ALPHA_TEST are shader state, not WebGL capabilities.
      if (changed && capability === C.TEXTURE_2D) this.uniformDirty.add('uTextureEnabled');
      if (changed && capability === C.ALPHA_TEST) this.uniformDirty.add('uAlphaEnabled');
      if (capability === C.TEXTURE_2D && value) this.backend.bindTexture(this._boundTexture(), 0);
      return gl;
    }

    setPointSize(value) {
      value = Math.max(1, +value);
      if (this.pointSize !== value) {
        this.pointSize = value;
        this.uniformDirty.add('uPointSize');
      }
    }

    setAlphaFunc(func, ref) {
      if (this.alphaFunc !== (func >>> 0)) this.uniformDirty.add('uAlphaFunc');
      if (this.alphaRef !== +ref) this.uniformDirty.add('uAlphaRef');
      this.alphaFunc = func >>> 0;
      this.alphaRef = +ref;
    }

    setTextureMode(value) {
      value |= 0;
      if (this.textureMode !== value) {
        this.textureMode = value;
        this.uniformDirty.add('uTextureMode');
      }
    }

    _boundTexture() {
      if (!this.boundTextureName) return this.defaultTexture;
      let texture = this.textures.get(this.boundTextureName);
      if (!texture) {
        texture = this.backend.createTexture();
        this.textures.set(this.boundTextureName, texture);
        this.backend.setTextureParameter(texture, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST_MIPMAP_LINEAR);
        this.backend.setTextureParameter(texture, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.backend.setTextureParameter(texture, this.gl.TEXTURE_WRAP_S, this.gl.REPEAT);
        this.backend.setTextureParameter(texture, this.gl.TEXTURE_WRAP_T, this.gl.REPEAT);
      }
      return texture;
    }

    bindTexture(name) { this.boundTextureName = name >>> 0; this.backend.bindTexture(this._boundTexture(), 0); }
    deleteTextures(names) {
      for (const name of names) {
        const texture = this.textures.get(name >>> 0);
        if (texture) this.backend.deleteTexture(texture);
        this.textures.delete(name >>> 0);
        if ((name >>> 0) === this.boundTextureName) this.boundTextureName = 0;
      }
    }

    _textureFormat(value) {
      if (value === C.RGB) return this.gl.RGB;
      if (value === C.ALPHA) return this.gl.ALPHA;
      if (value === C.LUMINANCE) return this.gl.LUMINANCE;
      return this.gl.RGBA;
    }

    texImage(level, internalFormat, width, height, border, format, type, pixels) {
      const mapped = this._textureFormat(format);
      this.backend.uploadTexture2D(this._boundTexture(), {
        level, internalFormat: mapped, width, height, border,
        format: mapped, type, pixels, alignment: 1,
      });
    }
    texSubImage(level, x, y, width, height, format, type, pixels) {
      this.backend.updateTexture2D(this._boundTexture(), {
        level, x, y, width, height, format: this._textureFormat(format),
        type, pixels, alignment: 1,
      });
    }
    texParameter(pname, value) {
      if (value === C.CLAMP) value = C.CLAMP_TO_EDGE;
      this.backend.setTextureParameter(this._boundTexture(), pname, value | 0);
    }

    destroy() {
      this.flushPendingDraw();
      for (const texture of this.textures.values()) this.backend.deleteTexture(texture);
      this.backend.deleteTexture(this.defaultTexture);
      this.backend.destroy();
    }
  }

  class OpenGLHostBridge {
    constructor(options) {
      this.options = options || {};
      this.contexts = new Map();
      this.nextContext = 1;
      this.current = 0;
      this.currentByOwner = new Map();
      this._owner = 0;
      this.lastError = 0;
      this._capture = null;
      this._memoryBuffer = null;
      this._memoryDataView = null;
      this._captureBuffer = null;
      this._captureDataView = null;
    }

    _exports() { return typeof this.options.exports === 'function' ? this.options.exports() : this.options.exports; }
    _memory() { return this.options.getMemory(); }
    _guestToWasm(pointer) {
      if (!pointer) return 0;
      const e = this._exports();
      // Pointer-bearing GL calls can reference the engine's sparse
      // VirtualAlloc arena (Quake world vertices do). Keep address-space
      // policy in the emulator and consume its canonical translator here.
      if (e && e.guest_to_wasm) return e.guest_to_wasm(pointer >>> 0) >>> 0;
      const imageBase = e && e.get_image_base ? e.get_image_base() >>> 0 : 0x400000;
      return ((pointer >>> 0) - imageBase + RegionMap.GUEST_BASE) >>> 0;
    }
    _dv() {
      const memory = this._memory();
      if (memory !== this._memoryBuffer) {
        this._memoryBuffer = memory;
        this._memoryDataView = new DataView(memory);
      }
      return this._memoryDataView;
    }
    _stackDv() {
      if (!this._capture) return this._dv();
      if (this._capture.buffer !== this._captureBuffer) {
        this._captureBuffer = this._capture.buffer;
        this._captureDataView = new DataView(this._captureBuffer);
      }
      return this._captureDataView;
    }
    _stackBase(stack) { return this._capture ? this._capture.stackOffset : stack; }
    _u32(stack, index) { return this._stackDv().getUint32(this._stackBase(stack) + 4 + index * 4, true); }
    _f32(stack, index) { return this._stackDv().getFloat32(this._stackBase(stack) + 4 + index * 4, true); }
    _f64(stack, dwordIndex) { return this._stackDv().getFloat64(this._stackBase(stack) + 4 + dwordIndex * 4, true); }
    _pointerBytes(pointer, length) {
      const capture = this._capture;
      if (capture && (pointer >>> 0) === capture.pointerGuest && length <= capture.pointerLength) {
        if (!capture.pointerBorrowed && capture.pointerOffset) {
          return new Uint8Array(capture.buffer, capture.pointerOffset, length);
        }
      }
      return new Uint8Array(this._memory(), this._guestToWasm(pointer), length);
    }
    _floatArray(pointer, count) {
      const bytes = this._pointerBytes(pointer, count * 4);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
      for (let i = 0; i < count; i++) out.push(dv.getFloat32(i * 4, true));
      return out;
    }
    _uintArray(pointer, count) {
      const bytes = this._pointerBytes(pointer, count * 4);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
      for (let i = 0; i < count; i++) out.push(dv.getUint32(i * 4, true));
      return out;
    }
    _bytes(pointer, length) {
      if (!pointer || !length) return null;
      return this._pointerBytes(pointer, length);
    }

    _renderer() { return this.options.renderer && (typeof this.options.renderer === 'function' ? this.options.renderer() : this.options.renderer); }
    createContext(hwnd) {
      const renderer = this._renderer();
      const win = renderer && renderer.windows && renderer.windows[hwnd >>> 0];
      if (!win || typeof document === 'undefined') return 0;
      const canvas = document.createElement('canvas');
      const client = win.clientRect || {};
      canvas.width = Math.max(1, client.w || win.w || 640);
      canvas.height = Math.max(1, client.h || win.h || 480);
      let backend;
      try { backend = new GpuBackend.WebGLBackend(canvas); }
      catch (_) { return 0; }
      const handle = this.nextContext++;
      const presentation = typeof backend.getPresentationSurface === 'function'
        ? backend.getPresentationSurface() : canvas;
      const layer = { canvas: presentation, backend, writeSeq: 0, kind: 'gpu' };
      win._gpuFrameLayer = layer;
      // Renderer compatibility while its compositor still calls the historical
      // accelerated layer `_dxFrameLayer`. The owned object remains generic.
      win._dxFrameLayer = layer;
      this.contexts.set(handle, { handle, hwnd: hwnd >>> 0, win, layer, backend,
        frontend: new FixedFunctionGL(backend) });
      if (typeof this.options.onContextCountChange === 'function') {
        this.options.onContextCountChange(this.contexts.size);
      }
      return handle;
    }

    deleteContext(handle) {
      const context = this.contexts.get(handle >>> 0);
      if (!context) return 0;
      context.frontend.destroy();
      if (context.win._gpuFrameLayer === context.layer) context.win._gpuFrameLayer = null;
      if (context.win._dxFrameLayer === context.layer) context.win._dxFrameLayer = null;
      this.contexts.delete(handle >>> 0);
      if (typeof this.options.onContextCountChange === 'function') {
        this.options.onContextCountChange(this.contexts.size);
      }
      if (this.current === (handle >>> 0)) this.current = 0;
      for (const [owner, current] of this.currentByOwner) {
        if (current === (handle >>> 0)) this.currentByOwner.set(owner, 0);
      }
      return 1;
    }

    makeCurrent(handle) {
      const current = this._current();
      if (current && current.frontend.flushPendingDraw) current.frontend.flushPendingDraw();
      if (!handle) {
        this.currentByOwner.set(this._owner, 0);
        if (this._owner === 0) this.current = 0;
        if (typeof this.options.onContextCountChange === 'function') {
          this.options.onContextCountChange(0);
        }
        return 1;
      }
      if (!this.contexts.has(handle >>> 0)) return 0;
      this.currentByOwner.set(this._owner, handle >>> 0);
      if (this._owner === 0) this.current = handle >>> 0;
      if (typeof this.options.onContextCountChange === 'function') {
        this.options.onContextCountChange(1);
      }
      return 1;
    }
    _current() {
      const handle = this.currentByOwner.has(this._owner)
        ? this.currentByOwner.get(this._owner) : this.current;
      return this.contexts.get(handle);
    }
    present() {
      const context = this._current();
      if (!context) return 0;
      if (context.frontend.flushPendingDraw) context.frontend.flushPendingDraw();
      const presentation = context.backend.present();
      if (presentation) context.layer.canvas = presentation;
      context.layer.writeSeq++;
      if (typeof this.options.onPresent === 'function') {
        this.options.onPresent(context.layer);
      }
      const renderer = this._renderer();
      if (renderer) {
        renderer.needsRepaint = true;
        if (typeof renderer.repaint === 'function') renderer.repaint();
      }
      return 1;
    }

    call(opcode, stack, aux, capture) {
      const previous = this._capture;
      this._capture = capture || null;
      try { return this._call(opcode, stack, aux); }
      finally { this._capture = previous; }
    }

    replay(batch, owner) {
      if (!GLCommandStream) return 0;
      const previous = this._owner;
      this._owner = (owner || 0) | 0;
      try {
        return GLCommandStream.replay(batch,
          (opcode, aux, capture) => this.call(opcode, 0, aux, capture));
      } finally {
        for (const context of this.contexts.values()) {
          if (context.frontend.flushPendingDraw) context.frontend.flushPendingDraw();
        }
        this._owner = previous;
      }
    }

    _call(opcode, stack, aux) {
      if (GLCommandStream && opcode === GLCommandStream.PACKED_DRAW_OPCODE) {
        const context = this._current();
        if (!context || !context.frontend.enqueuePacked || !this._capture) return 0;
        if ((this._capture.pointerLength % 36) !== 0 || !this._capture.pointerOffset) {
          throw new RangeError('invalid packed GL vertex payload');
        }
        const vertices = new Float32Array(this._capture.buffer,
          this._capture.pointerOffset, this._capture.pointerLength / 4);
        context.frontend.enqueuePacked(aux | 0, vertices);
        return 0;
      }
      const name = CALLS[opcode | 0];
      if (!name) return 0;
      // Current color/texcoord/shade state and glBegin/glEnd vertices are
      // compiled into PACKED_DRAW_OPCODE by GLCommandStream.Encoder in both
      // cooperative and Worker modes. Seeing one here means a caller bypassed
      // the mandatory ordering/state layer.
      if (opcode === CALL_INDEX.glShadeModel
          || (opcode >= CALL_INDEX.glBegin && opcode <= CALL_INDEX.glVertex3fv)
          || opcode === CALL_INDEX.glColor4ub || opcode === CALL_INDEX.glColor3ubv) {
        throw new Error(`${name} must pass through GLCommandStream.Encoder`);
      }
      if (name.startsWith('wgl')) {
        const current = this._current();
        if (current && current.frontend.flushPendingDraw) current.frontend.flushPendingDraw();
      }
      if (name === 'wglCreateContext') return this.createContext(aux >>> 0);
      if (name === 'wglDeleteContext') return this.deleteContext(this._u32(stack, 0));
      if (name === 'wglMakeCurrent') return this.makeCurrent(this._u32(stack, 1));
      if (name === 'wglGetProcAddress') return 0;
      if (name === 'wglChoosePixelFormat' || name === 'wglSetPixelFormat') return 1;
      if (name === 'wglDescribePixelFormat') return 1;
      if (name === 'gpuPresent') return this.present();
      const context = this._current();
      if (!context) return 0;
      const f = context.frontend, gl = f.gl;
      if (f.flushPendingDraw) f.flushPendingDraw();
      switch (name) {
        case 'glAlphaFunc': f.setAlphaFunc(this._u32(stack, 0), this._f32(stack, 1)); break;
        case 'glBlendFunc': f.backend.setBlendFunc(this._u32(stack, 0), this._u32(stack, 1)); break;
        case 'glClear': f.backend.clear(f.clearColor, this._u32(stack, 0)); break;
        case 'glClearColor': f.clearColor = [0, 1, 2, 3].map(i => this._f32(stack, i)); break;
        case 'glCullFace': f.backend.setCullFace(this._u32(stack, 0)); break;
        case 'glDepthFunc': f.backend.setDepthFunc(this._u32(stack, 0)); break;
        case 'glDepthMask': f.backend.setDepthMask(this._u32(stack, 0)); break;
        case 'glDepthRange': f.setDepthRange(this._f64(stack, 0), this._f64(stack, 2)); break;
        case 'glDisable': f.setEnabled(this._u32(stack, 0), false); break;
        case 'glDrawBuffer': break;
        case 'glEnable': f.setEnabled(this._u32(stack, 0), true); break;
        case 'glFinish': f.backend.finish(); break;
        case 'glGetError': return f.backend.getError();
        case 'glGetFloatv': this._getFloatv(f, this._u32(stack, 0), this._u32(stack, 1)); break;
        case 'glGetString': return 0; // WAT returns stable guest strings.
        case 'glPointSize': f.setPointSize(this._f32(stack, 0)); break;
        case 'glPolygonMode': break; // Filled rendering is the WebGL baseline.
        case 'glPolygonOffset': f.backend.setPolygonOffset(this._f32(stack, 0), this._f32(stack, 1)); break;
        case 'glReadPixels': this._readPixels(f, stack); break;
        case 'glScissor': f.backend.setScissor(this._u32(stack, 0), this._u32(stack, 1), this._u32(stack, 2), this._u32(stack, 3)); break;
        case 'glViewport': f.backend.setViewport(this._u32(stack, 0), this._u32(stack, 1), this._u32(stack, 2), this._u32(stack, 3)); break;
        case 'glFrustum': f._multMatrix(frustum(...[0, 2, 4, 6, 8, 10].map(i => this._f64(stack, i)))); break;
        case 'glLoadIdentity': f._replaceMatrix(identity()); break;
        case 'glLoadMatrixf': f._replaceMatrix(this._floatArray(this._u32(stack, 0), 16)); break;
        case 'glMatrixMode': if (f.matrices[this._u32(stack, 0)]) f.matrixMode = this._u32(stack, 0); break;
        case 'glOrtho': f._multMatrix(ortho(...[0, 2, 4, 6, 8, 10].map(i => this._f64(stack, i)))); break;
        case 'glPopMatrix': { const s = f._stack(); if (s.length > 1) { s.pop(); f.uniformDirty.add(f._matrixUniform()); } break; }
        case 'glPushMatrix': f._stack().push(new Float32Array(f._matrix())); break;
        case 'glRotatef': f._multMatrix(rotation(this._f32(stack, 0), this._f32(stack, 1), this._f32(stack, 2), this._f32(stack, 3))); break;
        case 'glScalef': f._multMatrix(scale(this._f32(stack, 0), this._f32(stack, 1), this._f32(stack, 2))); break;
        case 'glTranslatef': f._multMatrix(translation(this._f32(stack, 0), this._f32(stack, 1), this._f32(stack, 2))); break;
        case 'glBindTexture': f.bindTexture(this._u32(stack, 1)); break;
        case 'glDeleteTextures': f.deleteTextures(this._uintArray(this._u32(stack, 1), this._u32(stack, 0))); break;
        case 'glTexEnvf': if (this._u32(stack, 1) === C.TEXTURE_ENV_MODE) f.setTextureMode(Math.round(this._f32(stack, 2))); break;
        case 'glTexImage2D': this._texImage(f, stack, false); break;
        case 'glTexParameterf': f.texParameter(this._u32(stack, 1), Math.round(this._f32(stack, 2))); break;
        case 'glTexSubImage2D': this._texImage(f, stack, true); break;
      }
      return 0;
    }

    _getFloatv(frontend, pname, pointer) {
      const values = pname === C.MODELVIEW_MATRIX ? stackTop(frontend.matrices[C.MODELVIEW])
        : pname === C.PROJECTION_MATRIX ? stackTop(frontend.matrices[C.PROJECTION])
          : pname === C.TEXTURE_MATRIX ? stackTop(frontend.matrices[C.TEXTURE])
            : [pname === C.MAX_TEXTURE_SIZE ? frontend.backend.getParameter(frontend.gl.MAX_TEXTURE_SIZE) : 0];
      const dv = this._dv(), wa = this._guestToWasm(pointer);
      for (let i = 0; i < values.length; i++) dv.setFloat32(wa + i * 4, values[i], true);
    }
    _readPixels(frontend, stack) {
      const x = this._u32(stack, 0), y = this._u32(stack, 1);
      const width = this._u32(stack, 2), height = this._u32(stack, 3);
      const format = this._u32(stack, 4), type = this._u32(stack, 5);
      const pointer = this._u32(stack, 6);
      const channels = format === C.RGB ? 3 : format === C.ALPHA || format === C.LUMINANCE ? 1 : 4;
      const out = new Uint8Array(width * height * channels);
      frontend.backend.readPixels(x, y, width, height, frontend._textureFormat(format), type, out);
      new Uint8Array(this._memory(), this._guestToWasm(pointer), out.length).set(out);
    }
    _texImage(frontend, stack, sub) {
      const base = sub ? 0 : 0;
      const level = this._u32(stack, 1);
      let x = 0, y = 0, internal = 4, width, height, border = 0, format, type, pointer;
      if (sub) {
        x = this._u32(stack, 2); y = this._u32(stack, 3);
        width = this._u32(stack, 4); height = this._u32(stack, 5);
        format = this._u32(stack, 6); type = this._u32(stack, 7); pointer = this._u32(stack, 8);
      } else {
        internal = this._u32(stack, 2); width = this._u32(stack, 3); height = this._u32(stack, 4);
        border = this._u32(stack, 5); format = this._u32(stack, 6);
        type = this._u32(stack, 7); pointer = this._u32(stack, 8);
      }
      const channels = format === C.RGB ? 3 : format === C.ALPHA || format === C.LUMINANCE ? 1 : 4;
      const pixels = this._bytes(pointer, width * height * channels);
      if (sub) frontend.texSubImage(level, x, y, width, height, format, type, pixels);
      else frontend.texImage(level, internal, width, height, border, format, type, pixels);
      return base;
    }
  }

  return { GL_CALLS, WGL_CALLS, CALLS, CALL_INDEX, constants: C,
    FixedFunctionGL, OpenGLHostBridge, identity, multiply, frustum, ortho };
});
