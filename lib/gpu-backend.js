// Backend-neutral GPU command target for accelerated guest graphics APIs.
//
// Frontends (OpenGL 1.x today, Direct3D later) own their API-specific state
// machines and lower them to this small WebGL/GLES-shaped contract: buffers,
// textures, programs, uniforms, fixed raster state, draw, readback, present.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GpuBackend = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'shader compilation failed';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  class WebGLBackend {
    constructor(canvas, options) {
      this.canvas = canvas;
      const opts = Object.assign({
        alpha: false,
        antialias: false,
        depth: true,
        stencil: false,
        preserveDrawingBuffer: true,
      }, options || {});
      const gl = canvas && (canvas.getContext('webgl', opts) ||
        canvas.getContext('experimental-webgl', opts));
      if (!gl) throw new Error('WebGL is unavailable');
      this.gl = gl;
      // WebGL draws directly into its context canvas. The guest may yield in
      // the middle of a frame, so exposing that canvas to the window
      // compositor would let an unrelated repaint display a half-built frame.
      // Keep presentation ownership in the generic backend and publish only a
      // snapshot copied by present()/SwapBuffers.
      this.presentationCanvas = null;
      this.presentationContext = null;
      const ownerDocument = canvas && canvas.ownerDocument;
      if (ownerDocument && typeof ownerDocument.createElement === 'function') {
        const presentationCanvas = ownerDocument.createElement('canvas');
        presentationCanvas.width = Math.max(1, canvas.width | 0);
        presentationCanvas.height = Math.max(1, canvas.height | 0);
        const presentationContext = presentationCanvas.getContext &&
          presentationCanvas.getContext('2d', { alpha: false });
        if (presentationContext) {
          presentationContext.imageSmoothingEnabled = false;
          this.presentationCanvas = presentationCanvas;
          this.presentationContext = presentationContext;
        }
      }
      this._buffers = new Set();
      this._textures = new Set();
      this._programs = new Set();
      this._boundBuffers = new Map();
      this._activeTextureUnit = -1;
      this._boundTextures = new Map();
      this._currentProgram = null;
      this._uniformValues = new WeakMap();
      this._attributeState = new Map();
      this._enabledAttributes = new Set();
      this._stateValues = new Map();
    }

    _bindBuffer(target, buffer) {
      if (this._boundBuffers.get(target) === buffer) return;
      this.gl.bindBuffer(target, buffer);
      this._boundBuffers.set(target, buffer);
    }

    _setState(name, values, apply) {
      const previous = this._stateValues.get(name);
      if (previous && previous.length === values.length
          && values.every((value, index) => Object.is(value, previous[index]))) return;
      apply();
      this._stateValues.set(name, values.slice());
    }

    createBuffer() {
      const value = this.gl.createBuffer();
      if (!value) throw new Error('WebGL buffer allocation failed');
      this._buffers.add(value);
      return value;
    }

    updateBuffer(buffer, target, data, usage) {
      const gl = this.gl;
      const actualTarget = target || gl.ARRAY_BUFFER;
      this._bindBuffer(actualTarget, buffer);
      gl.bufferData(actualTarget, data, usage || gl.STREAM_DRAW);
    }

    deleteBuffer(buffer) {
      if (!buffer) return;
      this.gl.deleteBuffer(buffer);
      this._buffers.delete(buffer);
      for (const [target, bound] of this._boundBuffers) {
        if (bound === buffer) this._boundBuffers.delete(target);
      }
      for (const [location, state] of this._attributeState) {
        if (state.buffer === buffer) this._attributeState.delete(location);
      }
    }

    createTexture() {
      const value = this.gl.createTexture();
      if (!value) throw new Error('WebGL texture allocation failed');
      this._textures.add(value);
      return value;
    }

    bindTexture(texture, unit) {
      const gl = this.gl;
      const index = unit || 0;
      if (this._activeTextureUnit !== index) {
        gl.activeTexture(gl.TEXTURE0 + index);
        this._activeTextureUnit = index;
      }
      const value = texture || null;
      if (this._boundTextures.get(index) === value) return;
      gl.bindTexture(gl.TEXTURE_2D, value);
      this._boundTextures.set(index, value);
    }

    uploadTexture2D(texture, image) {
      const gl = this.gl;
      this.bindTexture(texture, image.unit || 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, image.alignment || 1);
      gl.texImage2D(gl.TEXTURE_2D, image.level || 0, image.internalFormat,
        image.width, image.height, image.border || 0, image.format, image.type,
        image.pixels || null);
    }

    updateTexture2D(texture, image) {
      const gl = this.gl;
      this.bindTexture(texture, image.unit || 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, image.alignment || 1);
      gl.texSubImage2D(gl.TEXTURE_2D, image.level || 0, image.x || 0,
        image.y || 0, image.width, image.height, image.format, image.type,
        image.pixels);
    }

    setTextureParameter(texture, pname, value) {
      const gl = this.gl;
      this.bindTexture(texture, 0);
      gl.texParameteri(gl.TEXTURE_2D, pname, value);
    }

    deleteTexture(texture) {
      if (!texture) return;
      this.gl.deleteTexture(texture);
      this._textures.delete(texture);
      for (const [unit, bound] of this._boundTextures) {
        if (bound === texture) this._boundTextures.delete(unit);
      }
    }

    createProgram(vertexSource, fragmentSource, attributeNames, uniformNames) {
      const gl = this.gl;
      const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || 'program link failed';
        gl.deleteProgram(program);
        throw new Error(message);
      }
      const result = { handle: program, attributes: {}, uniforms: {} };
      for (const name of attributeNames || []) {
        result.attributes[name] = gl.getAttribLocation(program, name);
      }
      for (const name of uniformNames || []) {
        result.uniforms[name] = gl.getUniformLocation(program, name);
      }
      this._programs.add(program);
      return result;
    }

    useProgram(program) {
      const handle = program && program.handle || null;
      if (this._currentProgram === handle) return;
      this.gl.useProgram(handle);
      this._currentProgram = handle;
    }

    setUniform(program, name, kind, value) {
      const gl = this.gl;
      const location = program.uniforms[name];
      if (location == null) return;
      let cache = this._uniformValues.get(program);
      if (!cache) {
        cache = new Map();
        this._uniformValues.set(program, cache);
      }
      const values = kind === 'matrix4' || kind === '4f' ? Array.from(value)
        : [kind === '1i' ? value | 0 : +value];
      const previous = cache.get(name);
      if (previous && previous.kind === kind && previous.values.length === values.length
          && values.every((entry, index) => Object.is(entry, previous.values[index]))) return;
      this.useProgram(program);
      if (kind === 'matrix4') gl.uniformMatrix4fv(location, false, value);
      else if (kind === '1i') gl.uniform1i(location, value | 0);
      else if (kind === '1f') gl.uniform1f(location, +value);
      else if (kind === '4f') gl.uniform4fv(location, value);
      cache.set(name, { kind, values });
    }

    setCapability(capability, enabled) {
      this._setState(`cap:${capability}`, [!!enabled], () => {
        if (enabled) this.gl.enable(capability); else this.gl.disable(capability);
      });
    }

    setViewport(x, y, width, height) { this._setState('viewport', [x, y, width, height], () => this.gl.viewport(x, y, width, height)); }
    setScissor(x, y, width, height) { this._setState('scissor', [x, y, width, height], () => this.gl.scissor(x, y, width, height)); }
    setDepthFunc(value) { this._setState('depthFunc', [value], () => this.gl.depthFunc(value)); }
    setDepthMask(value) { this._setState('depthMask', [!!value], () => this.gl.depthMask(!!value)); }
    setDepthRange(nearValue, farValue) { this._setState('depthRange', [nearValue, farValue], () => this.gl.depthRange(nearValue, farValue)); }
    setBlendFunc(src, dst) { this._setState('blendFunc', [src, dst], () => this.gl.blendFunc(src, dst)); }
    setCullFace(value) { this._setState('cullFace', [value], () => this.gl.cullFace(value)); }
    setFrontFace(value) { this._setState('frontFace', [value], () => this.gl.frontFace(value)); }
    setLineWidth(value) { this._setState('lineWidth', [value], () => this.gl.lineWidth(value)); }

    clear(color, mask) {
      const gl = this.gl;
      if (color) this._setState('clearColor', color, () => gl.clearColor(color[0], color[1], color[2], color[3]));
      gl.clear(mask);
    }

    draw(command) {
      const gl = this.gl;
      const program = command.program;
      this.useProgram(program);
      this._bindBuffer(gl.ARRAY_BUFFER, command.vertexBuffer);
      const stride = command.stride;
      const used = new Set();
      for (const attribute of command.attributes) {
        const location = program.attributes[attribute.name];
        if (location < 0) continue;
        used.add(location);
        if (!this._enabledAttributes.has(location)) {
          gl.enableVertexAttribArray(location);
          this._enabledAttributes.add(location);
        }
        const type = attribute.type || gl.FLOAT;
        const normalized = !!attribute.normalized;
        const state = this._attributeState.get(location);
        if (!state || state.buffer !== command.vertexBuffer || state.size !== attribute.size
            || state.type !== type || state.normalized !== normalized
            || state.stride !== stride || state.offset !== attribute.offset) {
          gl.vertexAttribPointer(location, attribute.size, type,
            normalized, stride, attribute.offset);
          this._attributeState.set(location, {
            buffer: command.vertexBuffer, size: attribute.size, type,
            normalized, stride, offset: attribute.offset,
          });
        }
      }
      for (const location of this._enabledAttributes) {
        if (!used.has(location)) {
          gl.disableVertexAttribArray(location);
          this._enabledAttributes.delete(location);
        }
      }
      if (command.indexBuffer) {
        this._bindBuffer(gl.ELEMENT_ARRAY_BUFFER, command.indexBuffer);
        gl.drawElements(command.mode, command.count, command.indexType || gl.UNSIGNED_SHORT, 0);
      } else {
        gl.drawArrays(command.mode, 0, command.count);
      }
    }

    readPixels(x, y, width, height, format, type, output) {
      this.gl.readPixels(x, y, width, height, format, type, output);
      return output;
    }

    finish() { this.gl.finish(); }
    flush() { this.gl.flush(); }
    getParameter(name) { return this.gl.getParameter(name); }
    getError() { return this.gl.getError(); }

    getPresentationSurface() { return this.presentationCanvas || this.canvas; }

    present() {
      this.flush();
      const target = this.presentationCanvas;
      const context = this.presentationContext;
      if (target && context) {
        const width = Math.max(1, this.canvas.width | 0);
        const height = Math.max(1, this.canvas.height | 0);
        if (target.width !== width) target.width = width;
        if (target.height !== height) target.height = height;
        context.imageSmoothingEnabled = false;
        context.clearRect(0, 0, width, height);
        context.drawImage(this.canvas, 0, 0, width, height);
      }
      return this.getPresentationSurface();
    }

    destroy() {
      for (const value of this._buffers) this.gl.deleteBuffer(value);
      for (const value of this._textures) this.gl.deleteTexture(value);
      for (const value of this._programs) this.gl.deleteProgram(value);
      this._buffers.clear();
      this._textures.clear();
      this._programs.clear();
      this._boundBuffers.clear();
      this._boundTextures.clear();
      this._attributeState.clear();
      this._enabledAttributes.clear();
      this._stateValues.clear();
      this._currentProgram = null;
    }
  }

  return { WebGLBackend };
});
