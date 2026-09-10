// Immutable D3D9 draw snapshots lowered to the shared GPU contract.
// Guest identity, COM refs and mutable device state stay outside this class.
(function (root, factory) {
  const node = typeof module !== 'undefined' && module.exports;
  const api = factory(node ? require('./gpu-backend') : root.GpuBackend,
    node ? require('./d3d9-shader') : root.D3D9Shader);
  if (node) module.exports = api; else root.D3D9Backend = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (GPU, Shader) {
  'use strict';
  const invalid = message => { throw new Error(`D3D9 draw: ${message}`); };
  const primitiveVertices = (type, count) => {
    if (!Number.isInteger(count) || count < 0) invalid('invalid primitive count');
    switch (type) {
      case 1: return count;
      case 2: return count * 2;
      case 3: return count ? count + 1 : 0;
      case 4: return count * 3;
      case 5: case 6: return count ? count + 2 : 0;
      default: invalid(`primitive type ${type}`);
    }
  };
  class Device {
    constructor(canvas) {
      this.gpu = new GPU.WebGLBackend(canvas);
      this.programs = new Map();
      this.vertices = this.gpu.createBuffer();
      this.indices = this.gpu.createBuffer();
      this.textures = new Map();
    }
    clear(color, flags) {
      if (flags & ~3) invalid('stencil clear is not implemented');
      const g = this.gpu, gl = g.gl;
      g.setDepthMask(true);
      g.setCapability(gl.SCISSOR_TEST, false);
      g.clear(color, (flags & 1 ? gl.COLOR_BUFFER_BIT : 0) | (flags & 2 ? gl.DEPTH_BUFFER_BIT : 0));
    }
    draw(draw) {
      const g = this.gpu, gl = g.gl;
      const count = primitiveVertices(draw.primitive, draw.primitiveCount);
      if (!count) return;
      const vs = Shader.compile(draw.vertexShader), ps = Shader.compile(draw.pixelShader);
      if (vs.stage !== 'vertex' || ps.stage !== 'pixel') invalid('shader stage mismatch');
      // A complete source key avoids hash collisions changing a guest program.
      const key = vs.source + '\n// PIXEL STAGE\n' + ps.source;
      let program = this.programs.get(key);
      if (!program) {
        program = g.createProgram(vs.source, ps.source, vs.attributes, [...vs.uniforms, ...ps.uniforms]);
        this.programs.set(key, program);
      }
      if (!(draw.vertices instanceof Uint8Array) || !Number.isInteger(draw.stride)
          || draw.stride <= 0 || draw.stride > 255) invalid('invalid vertex bytes/stride');
      const indices = draw.indices;
      if (indices && !(indices instanceof Uint16Array)) invalid('only INDEX16 is implemented');
      if (indices && indices.length < count) invalid('index buffer too short');
      let maxIndex = count - 1;
      if (indices) { maxIndex = 0; for (let i = 0; i < count; ++i) maxIndex = Math.max(maxIndex, indices[i]); }
      const attributes = vs.attributes.map(name => {
        const register = Number(name.slice(5));
        const semantic = vs.semantics[register];
        const input = draw.attributes.find(a => semantic
          ? a.usage === semantic.usage && a.usageIndex === semantic.index
          : a.register === register);
        if (!input) invalid(`missing vertex input v${register}`);
        const sizes = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 4 }; // FLOAT1..4 / normalized color
        const size = sizes[input.type];
        const byteSize = input.type === 4 ? 4 : size * 4;
        if (!size || !Number.isInteger(input.offset) || input.offset < 0 || input.offset % 4)
          invalid('unsupported vertex declaration element');
        if (input.offset + byteSize > draw.stride
            || maxIndex * draw.stride + input.offset + byteSize > draw.vertices.byteLength)
          invalid('vertex input outside buffer');
        return { name, size, offset: input.offset,
          type: input.type === 4 ? gl.UNSIGNED_BYTE : gl.FLOAT, normalized: input.type === 4 };
      });
      for (const shader of [vs, ps]) for (const name of shader.uniforms) {
        const match = /^d3d_(vs|ps)_c(\d+)$/.exec(name);
        if (match) {
          const values = match[1] === 'vs' ? draw.vertexConstants : draw.pixelConstants;
          const offset = Number(match[2]) * 4;
          if (!(values instanceof Float32Array) || values.length < offset + 4)
            invalid(`missing constants ${name}`);
          g.setUniform(program, name, '4f', values.subarray(offset, offset + 4));
        } else {
          const stage = Number(name.slice(5)), texture = draw.textures && draw.textures[stage];
          if (!texture) invalid(`missing sampler ${stage}`);
          this.uploadTexture(stage, texture);
          g.setUniform(program, name, '1i', stage);
        }
      }
      // Texture uploads temporarily bind unit 0; restore all sampled units only
      // after the final upload, otherwise sampling a second texture replaces s0.
      for (const name of ps.uniforms.filter(n => /^d3d_s\d+$/.test(n))) {
        const stage = Number(name.slice(5)); g.bindTexture(this.textures.get(stage), stage);
      }
      const state = draw.state || {};
      const compares = [0, gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS];
      const zfunc = state.zfunc === undefined ? 4 : state.zfunc;
      if (!compares[zfunc]) invalid('invalid depth comparison');
      const blends = [0, gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR,
        gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA,
        gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA_SATURATE];
      const source = state.srcblend === undefined ? 2 : state.srcblend;
      const dest = state.dstblend === undefined ? 1 : state.dstblend;
      if (source < 1 || source >= blends.length || dest < 1 || dest >= blends.length)
        invalid('unsupported blend function');
      const cull = state.cull === undefined ? 3 : state.cull;
      if (![1, 2, 3].includes(cull)) invalid('invalid cull mode');
      g.setCapability(gl.DEPTH_TEST, state.zenable !== false);
      g.setDepthFunc(compares[zfunc]); g.setDepthMask(state.zwrite !== false);
      g.setCapability(gl.BLEND, !!state.blend);
      g.setBlendFunc(blends[source], blends[dest]);
      g.setCapability(gl.CULL_FACE, cull !== 1);
      // D3D's screen-Y-down winding is opposite GL window-coordinate winding.
      g.setFrontFace(gl.CCW); g.setCullFace(cull === 2 ? gl.FRONT : gl.BACK);
      const vp = draw.viewport || { x: 0, y: 0, width: g.canvas.width, height: g.canvas.height, minZ: 0, maxZ: 1 };
      g.setViewport(vp.x, g.canvas.height - vp.y - vp.height, vp.width, vp.height);
      g.setDepthRange(vp.minZ, vp.maxZ);
      g.setCapability(gl.SCISSOR_TEST, false);
      g.updateBuffer(this.vertices, gl.ARRAY_BUFFER, draw.vertices);
      if (indices) g.updateBuffer(this.indices, gl.ELEMENT_ARRAY_BUFFER, indices.subarray(0, count));
      const modes = [0, gl.POINTS, gl.LINES, gl.LINE_STRIP, gl.TRIANGLES, gl.TRIANGLE_STRIP, gl.TRIANGLE_FAN];
      g.draw({ program, vertexBuffer: this.vertices, indexBuffer: indices ? this.indices : null,
        mode: modes[draw.primitive], count, stride: draw.stride, attributes });
    }
    uploadTexture(stage, image) {
      const g = this.gpu, gl = g.gl;
      if (!Number.isInteger(image.width) || image.width < 1 || !Number.isInteger(image.height) || image.height < 1
          || !(image.pixels instanceof Uint8Array) || image.pixels.length !== image.width * image.height * 4)
        invalid('invalid RGBA texture snapshot');
      const sampler = image.sampler || {};
      const addresses = [0, gl.REPEAT, gl.MIRRORED_REPEAT, gl.CLAMP_TO_EDGE];
      const u = sampler.addressU === undefined ? 1 : sampler.addressU;
      const v = sampler.addressV === undefined ? 1 : sampler.addressV;
      if (!addresses[u] || !addresses[v]) invalid('unsupported texture address mode');
      if ((image.width & (image.width - 1) || image.height & (image.height - 1)) && (u !== 3 || v !== 3))
        invalid('WebGL1 NPOT textures require clamp');
      const min = sampler.min === undefined ? 1 : sampler.min;
      const mag = sampler.mag === undefined ? 1 : sampler.mag;
      const mip = sampler.mip || 0;
      if (![1, 2].includes(min) || ![1, 2].includes(mag) || ![0,1,2].includes(mip))
        invalid('unsupported texture filter/mip chain');
      const levels = image.levels || [image];
      if (mip && (image.width & (image.width-1) || image.height & (image.height-1)))
        invalid('WebGL1 NPOT textures cannot use mip filters');
      let width=image.width,height=image.height;
      for(const level of levels) {
        if(level.width!==width || level.height!==height || !(level.pixels instanceof Uint8Array)
            || level.pixels.length!==width*height*4) invalid('invalid mip level');
        width=Math.max(1,width>>1);height=Math.max(1,height>>1);
      }
      if(mip && (levels.at(-1).width!==1 || levels.at(-1).height!==1)) invalid('incomplete mip chain');
      let texture = this.textures.get(stage);
      if (!texture) { texture = g.createTexture(); this.textures.set(stage, texture); }
      levels.forEach((level,index)=>g.uploadTexture2D(texture, {
        ...level, level:index, unit:0, internalFormat:gl.RGBA, format:gl.RGBA, type:gl.UNSIGNED_BYTE }));
      g.setTextureParameter(texture, gl.TEXTURE_WRAP_S, addresses[u]);
      g.setTextureParameter(texture, gl.TEXTURE_WRAP_T, addresses[v]);
      const minFilters=[[gl.NEAREST,gl.LINEAR],[gl.NEAREST_MIPMAP_NEAREST,gl.LINEAR_MIPMAP_NEAREST],
        [gl.NEAREST_MIPMAP_LINEAR,gl.LINEAR_MIPMAP_LINEAR]];
      g.setTextureParameter(texture, gl.TEXTURE_MIN_FILTER, minFilters[mip][min-1]);
      g.setTextureParameter(texture, gl.TEXTURE_MAG_FILTER, mag === 1 ? gl.NEAREST : gl.LINEAR);
    }
    present() { return this.gpu.present(); }
    destroy() { this.gpu.destroy(); this.programs.clear(); this.textures.clear(); }
  }
  // A capability probe exercises this frontend's compiler/draw/upload/readback
  // path, not just the presence of a WebGL constructor. Cached by the bridge.
  function probe(canvas) {
    let device;
    try {
      canvas.width=canvas.height=4;device=new Device(canvas);
      const gl=device.gpu.gl;
      if(gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS)<96
          || gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)<4
          || gl.getParameter(gl.MAX_TEXTURE_SIZE)<2048)return false;
      const vertexShader=new Uint32Array([0xfffe0101,1,0xc00f0000,0x90e40000,
        1,0xe00f0000,0xa0e40000,0xffff]);
      const pixelShader=new Uint32Array([0xffff0101,66,0xb00f0000,
        5,0x800f0000,0xb0e40000,0xa0e40000,0xffff]);
      device.clear([0,0,0,1],3);
      device.draw({vertexShader,pixelShader,primitive:4,primitiveCount:1,stride:16,
        vertices:new Uint8Array(new Float32Array([-1,-1,0.25,1,3,-1,0.25,1,-1,3,0.25,1]).buffer),
        indices:new Uint16Array([0,1,2]),attributes:[{register:0,type:3,offset:0}],
        vertexConstants:new Float32Array([0.5,0.5,0,1]),pixelConstants:new Float32Array([0.5,0.25,1,1]),
        textures:[{width:1,height:1,pixels:new Uint8Array([200,160,80,255])}],state:{cull:1}});
      const pixel=device.gpu.readPixels(1,1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
      return device.gpu.getError()===0 && [100,40,80,255].every((v,i)=>Math.abs(pixel[i]-v)<=1);
    } catch (_) {return false;} finally {if(device)device.destroy();}
  }
  return { Device, primitiveVertices, probe };
});
