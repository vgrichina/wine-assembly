#!/usr/bin/env node
'use strict';
const assert = require('assert');
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs');
const { compile } = require('../lib/d3d9-shader');

(async () => {
  const browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    const page = await browser.newPage();
    for (const file of ['gpu-backend.js', 'd3d9-shader.js'])
      await page.addScriptTag({ path: path.join(__dirname, '../lib', file) });
    if (process.env.D3D9_SHADER_CORPUS) {
      const shaders = [];
      for (const file of fs.readdirSync(process.env.D3D9_SHADER_CORPUS)) {
        if (!file.endsWith('.sdv')) continue;
        const bytes = fs.readFileSync(path.join(process.env.D3D9_SHADER_CORPUS, file));
        for (let offset = 0; offset + 4 <= bytes.length; ++offset) {
          const version = bytes.readUInt32LE(offset);
          if (version !== 0xffff0101 && version !== 0xfffe0101) continue;
          const words = new Uint32Array(Math.floor((bytes.length - offset) / 4));
          for (let i = 0; i < words.length; ++i) words[i] = bytes.readUInt32LE(offset + i * 4);
          try {
            const shader = compile(words);
            shaders.push({ name: `${file}+${offset.toString(16)}`, stage: shader.stage, source: shader.source });
            offset += shader.length * 4 - 1;
          } catch (_) { /* Header candidates inside metadata are not shaders. */ }
        }
      }
      assert.ok(shaders.length > 0, 'corpus must contain supported shader streams');
      const errors = await page.evaluate(shaders => {
        const gl = document.createElement('canvas').getContext('webgl');
        const errors = [];
        for (const s of shaders) {
          const shader = gl.createShader(s.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
          gl.shaderSource(shader, s.source); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) errors.push(`${s.name}: ${gl.getShaderInfoLog(shader)}`);
          gl.deleteShader(shader);
        }
        return errors;
      }, shaders);
      assert.deepStrictEqual(errors, []);
      console.log(`PASS ${shaders.length} translated corpus shaders compile on GPU (not gameplay coverage)`);
    }
    const result = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const gpu = new GpuBackend.WebGLBackend(canvas), gl = gpu.gl;
      const vs = D3D9Shader.compile(new Uint32Array([0xfffe0101,
        1, 0xc00f0000, 0x90e40000, // mov oPos, v0
        1, 0xd00f0000, 0x90e40001, // mov oD0, v1
        1, 0xe00f0000, 0x90e40002, // mov oT0, v2
        0xffff]));
      const ps = D3D9Shader.compile(new Uint32Array([0xffff0101,
        66, 0xb00f0000, // tex t0
        5, 0x800f0000, 0xb0e40000, 0x90e40000, // mul r0, t0, v0
        0xffff]));
      const program = gpu.createProgram(vs.source, ps.source, vs.attributes, ps.uniforms);
      const buffer = gpu.createBuffer();
      const vertices = [];
      for (const [x, y] of [[-1,-1], [3,-1], [-1,3]])
        vertices.push(x, y, 0.5, 1, 0.5, 0.25, 1, 1, 0.5, 0.5, 0, 1);
      gpu.updateBuffer(buffer, gl.ARRAY_BUFFER, new Float32Array(vertices));
      const texture = gpu.createTexture();
      gpu.uploadTexture2D(texture, { width: 1, height: 1, internalFormat: gl.RGBA,
        format: gl.RGBA, type: gl.UNSIGNED_BYTE, pixels: new Uint8Array([200, 160, 80, 255]) });
      gpu.setTextureParameter(texture, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gpu.setTextureParameter(texture, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gpu.bindTexture(texture, 0); gpu.setUniform(program, 'd3d_s0', '1i', 0);
      gpu.setViewport(0, 0, 16, 16);
      gpu.clear([0, 0, 0, 1], gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gpu.draw({ program, vertexBuffer: buffer, mode: gl.TRIANGLES, count: 3, stride: 48,
        attributes: vs.attributes.map((name, index) => ({ name, size: 4, offset: index * 16 })) });
      const pixels = new Uint8Array(4);
      gpu.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const error = gpu.getError(); gpu.destroy();
      return { pixels: Array.from(pixels), error };
    });
    assert.strictEqual(result.error, 0);
    for (const [i, value] of [100, 40, 80, 255].entries())
      assert.ok(Math.abs(result.pixels[i] - value) <= 1, `channel ${i}: ${result.pixels}`);
    console.log('PASS D3D9 VS/PS 1.1 bytecode: real GPU textured/modulated triangle', result.pixels);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
