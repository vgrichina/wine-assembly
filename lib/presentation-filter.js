// Retina-aware final presentation and optional GPU filters.
// Exclusive games provide their native framebuffer composite directly; the
// logical desktop canvas remains the fallback source outside exclusive mode.
// This module only derives pixels for the browser display.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.presentationFilter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERTEX_SHADER = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // Andrea Mazzoleni's published Scale2x rules, evaluated as four virtual
  // subpixels for each source pixel.
  const SCALE2X_FRAGMENT_SHADER = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec2 u_source_size;
    varying vec2 v_uv;

    vec4 sample_pixel(vec2 pixel) {
      vec2 p = clamp(pixel, vec2(0.0), u_source_size - vec2(1.0));
      return texture2D(u_texture, (p + vec2(0.5)) / u_source_size);
    }
    bool same_color(vec4 a, vec4 b) {
      return all(lessThan(abs(a - b), vec4(0.001)));
    }
    void main() {
      vec2 source = v_uv * u_source_size;
      vec2 pixel = floor(source);
      vec2 quadrant = step(vec2(0.5), fract(source));
      vec4 B = sample_pixel(pixel + vec2( 0.0,  1.0));
      vec4 D = sample_pixel(pixel + vec2(-1.0,  0.0));
      vec4 E = sample_pixel(pixel);
      vec4 F = sample_pixel(pixel + vec2( 1.0,  0.0));
      vec4 H = sample_pixel(pixel + vec2( 0.0, -1.0));
      vec4 out_color = E;
      if (!same_color(B, H) && !same_color(D, F)) {
        if (quadrant.x < 0.5 && quadrant.y < 0.5 && same_color(D, H)) out_color = D;
        if (quadrant.x >= 0.5 && quadrant.y < 0.5 && same_color(H, F)) out_color = F;
        if (quadrant.x < 0.5 && quadrant.y >= 0.5 && same_color(D, B)) out_color = D;
        if (quadrant.x >= 0.5 && quadrant.y >= 0.5 && same_color(B, F)) out_color = F;
      }
      gl_FragColor = out_color;
    }
  `;

  // Scale3x resolves nine virtual subpixels. Rows are selected bottom-to-top
  // because WebGL's framebuffer origin is inverted when copied to Canvas2D.
  const SCALE3X_FRAGMENT_SHADER = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec2 u_source_size;
    varying vec2 v_uv;

    vec4 sample_pixel(vec2 pixel) {
      vec2 p = clamp(pixel, vec2(0.0), u_source_size - vec2(1.0));
      return texture2D(u_texture, (p + vec2(0.5)) / u_source_size);
    }
    bool same_color(vec4 a, vec4 b) {
      return all(lessThan(abs(a - b), vec4(0.001)));
    }
    void main() {
      vec2 source = v_uv * u_source_size;
      vec2 pixel = floor(source);
      vec2 cell = floor(fract(source) * 3.0);
      vec4 A = sample_pixel(pixel + vec2(-1.0,  1.0));
      vec4 B = sample_pixel(pixel + vec2( 0.0,  1.0));
      vec4 C = sample_pixel(pixel + vec2( 1.0,  1.0));
      vec4 D = sample_pixel(pixel + vec2(-1.0,  0.0));
      vec4 E = sample_pixel(pixel);
      vec4 F = sample_pixel(pixel + vec2( 1.0,  0.0));
      vec4 G = sample_pixel(pixel + vec2(-1.0, -1.0));
      vec4 H = sample_pixel(pixel + vec2( 0.0, -1.0));
      vec4 I = sample_pixel(pixel + vec2( 1.0, -1.0));
      vec4 out_color = E;
      if (!same_color(B, H) && !same_color(D, F)) {
        if (cell.y > 1.5) {
          if (cell.x < 0.5 && same_color(D, B)) out_color = D;
          if (cell.x > 1.5 && same_color(B, F)) out_color = F;
          if (cell.x > 0.5 && cell.x < 1.5 &&
              ((same_color(D, B) && !same_color(E, C)) ||
               (same_color(B, F) && !same_color(E, A)))) out_color = B;
        } else if (cell.y > 0.5) {
          if (cell.x < 0.5 &&
              ((same_color(D, B) && !same_color(E, G)) ||
               (same_color(D, H) && !same_color(E, A)))) out_color = D;
          if (cell.x > 1.5 &&
              ((same_color(B, F) && !same_color(E, I)) ||
               (same_color(H, F) && !same_color(E, C)))) out_color = F;
        } else {
          if (cell.x < 0.5 && same_color(D, H)) out_color = D;
          if (cell.x > 1.5 && same_color(H, F)) out_color = F;
          if (cell.x > 0.5 && cell.x < 1.5 &&
              ((same_color(D, H) && !same_color(E, I)) ||
               (same_color(H, F) && !same_color(E, G)))) out_color = H;
        }
      }
      gl_FragColor = out_color;
    }
  `;

  // Conservative two-colour checkerboard reconstruction. Requiring the four
  // diagonal pixels to match the centre and the four cardinal pixels to match
  // each other avoids treating ordinary one-pixel edges as dither.
  const DEDITHER_CHECKERBOARD_FRAGMENT_SHADER = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec2 u_source_size;
    varying vec2 v_uv;

    vec4 sample_pixel(vec2 pixel) {
      vec2 p = clamp(pixel, vec2(0.0), u_source_size - vec2(1.0));
      return texture2D(u_texture, (p + vec2(0.5)) / u_source_size);
    }
    bool same_color(vec4 a, vec4 b) {
      return distance(a.rgb, b.rgb) < 0.012 && abs(a.a - b.a) < 0.012;
    }
    void main() {
      vec2 p = floor(v_uv * u_source_size);
      vec4 c = sample_pixel(p);
      vec4 n = sample_pixel(p + vec2( 0.0,  1.0));
      vec4 s = sample_pixel(p + vec2( 0.0, -1.0));
      vec4 w = sample_pixel(p + vec2(-1.0,  0.0));
      vec4 e = sample_pixel(p + vec2( 1.0,  0.0));
      vec4 nw = sample_pixel(p + vec2(-1.0,  1.0));
      vec4 ne = sample_pixel(p + vec2( 1.0,  1.0));
      vec4 sw = sample_pixel(p + vec2(-1.0, -1.0));
      vec4 se = sample_pixel(p + vec2( 1.0, -1.0));
      vec4 opposite = 0.25 * (n + s + w + e);
      bool cross_pair = same_color(n, s) && same_color(n, w) && same_color(n, e);
      bool diagonal_pair = same_color(c, nw) && same_color(c, ne) &&
        same_color(c, sw) && same_color(c, se);
      bool interior = p.x > 0.5 && p.y > 0.5 &&
        p.x < u_source_size.x - 1.5 && p.y < u_source_size.y - 1.5;
      float separation = distance(c.rgb, opposite.rgb);
      if (interior && cross_pair && diagonal_pair && separation > 0.035) {
        gl_FragColor = vec4(0.5 * (c.rgb + opposite.rgb), c.a);
      } else {
        gl_FragColor = c;
      }
    }
  `;

  // Reconstruct a stable two-colour ordered 2x2 tile. Unlike the strict
  // checkerboard pass, this also handles 25% and 75% palette mixtures. Every
  // phase is verified in the four neighbouring tiles before the tile average
  // is used, which protects isolated texture and shape boundaries.
  const DEDITHER_ORDERED2_FRAGMENT_SHADER = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec2 u_source_size;
    varying vec2 v_uv;

    vec4 sample_pixel(vec2 pixel) {
      vec2 p = clamp(pixel, vec2(0.0), u_source_size - vec2(1.0));
      return texture2D(u_texture, (p + vec2(0.5)) / u_source_size);
    }
    bool same_color(vec4 a, vec4 b) {
      return distance(a.rgb, b.rgb) < 0.012 && abs(a.a - b.a) < 0.012;
    }
    bool stable_phase(vec2 p, vec4 color) {
      return same_color(color, sample_pixel(p + vec2(-2.0,  0.0))) &&
        same_color(color, sample_pixel(p + vec2( 2.0,  0.0))) &&
        same_color(color, sample_pixel(p + vec2( 0.0, -2.0))) &&
        same_color(color, sample_pixel(p + vec2( 0.0,  2.0)));
    }
    bool one_of_two(vec4 color, vec4 a, vec4 b) {
      return same_color(color, a) || same_color(color, b);
    }
    void main() {
      vec2 p = floor(v_uv * u_source_size);
      vec2 base = floor(p * 0.5) * 2.0;
      vec4 a = sample_pixel(base);
      vec4 b0 = sample_pixel(base + vec2(1.0, 0.0));
      vec4 c = sample_pixel(base + vec2(0.0, 1.0));
      vec4 d = sample_pixel(base + vec2(1.0, 1.0));
      vec4 b = b0;
      if (same_color(a, b)) b = c;
      if (same_color(a, b)) b = d;
      bool interior = base.x > 1.5 && base.y > 1.5 &&
        base.x < u_source_size.x - 3.5 && base.y < u_source_size.y - 3.5;
      bool two_color = !same_color(a, b) && one_of_two(b0, a, b) &&
        one_of_two(c, a, b) && one_of_two(d, a, b);
      bool stable = stable_phase(base, a) &&
        stable_phase(base + vec2(1.0, 0.0), b0) &&
        stable_phase(base + vec2(0.0, 1.0), c) &&
        stable_phase(base + vec2(1.0, 1.0), d);
      if (interior && two_color && stable && distance(a.rgb, b.rgb) > 0.035) {
        vec4 average = 0.25 * (a + b0 + c + d);
        gl_FragColor = vec4(average.rgb, sample_pixel(p).a);
      } else {
        gl_FragColor = sample_pixel(p);
      }
    }
  `;

  // The EASU and RCAS math below is adapted from AMD FidelityFX Super
  // Resolution 1.0. Copyright (c) 2021 Advanced Micro Devices, Inc. The
  // upstream implementation is distributed under the MIT License:
  // https://github.com/GPUOpen-Effects/FidelityFX-FSR
  // Permission is hereby granted, free of charge, to any person obtaining a
  // copy of this software and associated documentation files (the "Software"),
  // to deal in the Software without restriction, including without limitation
  // the rights to use, copy, modify, merge, publish, distribute, sublicense,
  // and/or sell copies of the Software, and to permit persons to whom the
  // Software is furnished to do so, subject to the following conditions:
  // The above copyright notice and this permission notice shall be included in
  // all copies or substantial portions of the Software. THE SOFTWARE IS
  // PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
  // INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
  // FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
  // OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
  // WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF
  // OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  // SOFTWARE.
  // WebGL 1 has no textureGather, so the 12 EASU taps are fetched explicitly.
  const FSR_EASU_FRAGMENT_SHADER = `
    precision highp float;
    uniform sampler2D u_texture;
    uniform vec2 u_source_size;
    varying vec2 v_uv;

    vec3 sample_pixel(vec2 pixel) {
      vec2 p = clamp(pixel, vec2(0.0), u_source_size - vec2(1.0));
      return texture2D(u_texture, (p + vec2(0.5)) / u_source_size).rgb;
    }
    float luma2(vec3 color) { return color.g + 0.5 * (color.r + color.b); }

    void easu_set(inout vec2 dir, inout float len, float weight,
                  float lA, float lB, float lC, float lD, float lE) {
      float dc = lD - lC;
      float cb = lC - lB;
      float lenX = max(abs(dc), abs(cb));
      float dirX = lD - lB;
      dir.x += dirX * weight;
      lenX = clamp(abs(dirX) / max(lenX, 0.0001), 0.0, 1.0);
      len += lenX * lenX * weight;
      float ec = lE - lC;
      float ca = lC - lA;
      float lenY = max(abs(ec), abs(ca));
      float dirY = lE - lA;
      dir.y += dirY * weight;
      lenY = clamp(abs(dirY) / max(lenY, 0.0001), 0.0, 1.0);
      len += lenY * lenY * weight;
    }

    void easu_tap(inout vec3 color, inout float weight, vec2 offset,
                  vec2 dir, vec2 anisotropic_len, float lobe, float clip_point,
                  vec3 tap) {
      vec2 v = vec2(
        offset.x * dir.x + offset.y * dir.y,
        offset.x * -dir.y + offset.y * dir.x
      ) * anisotropic_len;
      float distance2 = min(dot(v, v), clip_point);
      float window = 0.4 * distance2 - 1.0;
      float lobe_window = lobe * distance2 - 1.0;
      window *= window;
      lobe_window *= lobe_window;
      window = (25.0 / 16.0) * window - (25.0 / 16.0 - 1.0);
      float tap_weight = window * lobe_window;
      color += tap * tap_weight;
      weight += tap_weight;
    }

    void main() {
      vec2 pp = v_uv * u_source_size - vec2(0.5);
      vec2 fp = floor(pp);
      pp -= fp;
      vec3 b = sample_pixel(fp + vec2( 0.0, -1.0));
      vec3 c = sample_pixel(fp + vec2( 1.0, -1.0));
      vec3 e = sample_pixel(fp + vec2(-1.0,  0.0));
      vec3 f = sample_pixel(fp + vec2( 0.0,  0.0));
      vec3 g = sample_pixel(fp + vec2( 1.0,  0.0));
      vec3 h = sample_pixel(fp + vec2( 2.0,  0.0));
      vec3 i = sample_pixel(fp + vec2(-1.0,  1.0));
      vec3 j = sample_pixel(fp + vec2( 0.0,  1.0));
      vec3 k = sample_pixel(fp + vec2( 1.0,  1.0));
      vec3 l = sample_pixel(fp + vec2( 2.0,  1.0));
      vec3 n = sample_pixel(fp + vec2( 0.0,  2.0));
      vec3 o = sample_pixel(fp + vec2( 1.0,  2.0));

      float bL = luma2(b), cL = luma2(c), eL = luma2(e), fL = luma2(f);
      float gL = luma2(g), hL = luma2(h), iL = luma2(i), jL = luma2(j);
      float kL = luma2(k), lL = luma2(l), nL = luma2(n), oL = luma2(o);
      vec2 dir = vec2(0.0);
      float len = 0.0;
      easu_set(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
      easu_set(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
      easu_set(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
      easu_set(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

      float dirLength2 = dot(dir, dir);
      if (dirLength2 < (1.0 / 32768.0)) dir = vec2(1.0, 0.0);
      else dir *= inversesqrt(dirLength2);
      len = 0.5 * len;
      len *= len;
      float stretch = 1.0 / max(abs(dir.x), abs(dir.y));
      vec2 anisotropic_len = vec2(mix(1.0, stretch, len), mix(1.0, 0.5, len));
      float lobe = mix(0.5, 0.21, len);
      float clip_point = 1.0 / lobe;

      vec3 min4 = min(min(f, g), min(j, k));
      vec3 max4 = max(max(f, g), max(j, k));
      vec3 color = vec3(0.0);
      float weight = 0.0;
      easu_tap(color, weight, vec2( 0.0, -1.0) - pp, dir, anisotropic_len, lobe, clip_point, b);
      easu_tap(color, weight, vec2( 1.0, -1.0) - pp, dir, anisotropic_len, lobe, clip_point, c);
      easu_tap(color, weight, vec2(-1.0,  1.0) - pp, dir, anisotropic_len, lobe, clip_point, i);
      easu_tap(color, weight, vec2( 0.0,  1.0) - pp, dir, anisotropic_len, lobe, clip_point, j);
      easu_tap(color, weight, vec2( 0.0,  0.0) - pp, dir, anisotropic_len, lobe, clip_point, f);
      easu_tap(color, weight, vec2(-1.0,  0.0) - pp, dir, anisotropic_len, lobe, clip_point, e);
      easu_tap(color, weight, vec2( 1.0,  1.0) - pp, dir, anisotropic_len, lobe, clip_point, k);
      easu_tap(color, weight, vec2( 2.0,  1.0) - pp, dir, anisotropic_len, lobe, clip_point, l);
      easu_tap(color, weight, vec2( 2.0,  0.0) - pp, dir, anisotropic_len, lobe, clip_point, h);
      easu_tap(color, weight, vec2( 1.0,  0.0) - pp, dir, anisotropic_len, lobe, clip_point, g);
      easu_tap(color, weight, vec2( 1.0,  2.0) - pp, dir, anisotropic_len, lobe, clip_point, o);
      easu_tap(color, weight, vec2( 0.0,  2.0) - pp, dir, anisotropic_len, lobe, clip_point, n);
      color = clamp(color / max(weight, 0.0001), min4, max4);
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  // RCAS is the final composition pass. Independent flags let scanlines,
  // phosphor mask, and glow follow any scaler without changing geometry.
  const POST_FRAGMENT_SHADER = `
    precision highp float;
    uniform sampler2D u_texture;
    uniform vec2 u_texture_size;
    uniform vec2 u_logical_size;
    uniform float u_apply_rcas;
    uniform float u_sharpness;
    uniform vec3 u_crt_flags;
    uniform vec4 u_content_rect;
    varying vec2 v_uv;

    vec4 sample_pixel(vec2 pixel) {
      vec2 p = clamp(pixel, vec2(0.0), u_texture_size - vec2(1.0));
      return texture2D(u_texture, (p + vec2(0.5)) / u_texture_size);
    }
    vec3 rcas(vec2 pixel, out vec3 neighbours) {
      vec3 b = sample_pixel(pixel + vec2( 0.0,  1.0)).rgb;
      vec3 d = sample_pixel(pixel + vec2(-1.0,  0.0)).rgb;
      vec3 e = sample_pixel(pixel).rgb;
      vec3 f = sample_pixel(pixel + vec2( 1.0,  0.0)).rgb;
      vec3 h = sample_pixel(pixel + vec2( 0.0, -1.0)).rgb;
      neighbours = 0.25 * (b + d + f + h);
      vec3 mn4 = min(min(b, d), min(f, h));
      vec3 mx4 = max(max(b, d), max(f, h));
      vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(0.0001));
      vec3 hitMax = (vec3(1.0) - max(mx4, e)) /
        min(4.0 * mn4 - vec3(4.0), vec3(-0.0001));
      vec3 lobes = max(-hitMin, hitMax);
      float lobe = max(-0.1875, min(max(max(lobes.r, lobes.g), lobes.b), 0.0));
      lobe *= u_sharpness;
      return (lobe * (b + d + f + h) + e) / max(4.0 * lobe + 1.0, 0.0001);
    }
    void main() {
      vec2 pixel = floor(v_uv * u_texture_size);
      vec3 neighbours;
      vec4 center = sample_pixel(pixel);
      vec3 color = u_apply_rcas > 0.5 ? rcas(pixel, neighbours) : center.rgb;
      if (u_apply_rcas <= 0.5) {
        neighbours = 0.25 * (
          sample_pixel(pixel + vec2( 0.0,  1.0)).rgb +
          sample_pixel(pixel + vec2(-1.0,  0.0)).rgb +
          sample_pixel(pixel + vec2( 1.0,  0.0)).rgb +
          sample_pixel(pixel + vec2( 0.0, -1.0)).rgb);
      }
      if (u_crt_flags.z > 0.5) color += max(neighbours - color, vec3(0.0)) * 0.20;
      if (u_crt_flags.x > 0.5) {
        float contentY = (v_uv.y - u_content_rect.y) / max(u_content_rect.w, 0.0001);
        float phase = fract(contentY * u_logical_size.y);
        float scan = 0.84 + 0.16 * pow(max(sin(3.14159265 * phase), 0.0), 1.5);
        color *= scan;
      }
      if (u_crt_flags.y > 0.5) {
        float triad = mod(floor(gl_FragCoord.x), 3.0);
        vec3 mask = triad < 1.0 ? vec3(1.0, 0.94, 0.94) :
          (triad < 2.0 ? vec3(0.94, 1.0, 0.94) : vec3(0.94, 0.94, 1.0));
        color *= mask;
      }
      gl_FragColor = vec4(clamp(color, 0.0, 1.0), center.a);
    }
  `;

  const SHADERS = {
    scale2x: SCALE2X_FRAGMENT_SHADER,
    scale3x: SCALE3X_FRAGMENT_SHADER,
    deditherCheckerboard: DEDITHER_CHECKERBOARD_FRAGMENT_SHADER,
    deditherOrdered2: DEDITHER_ORDERED2_FRAGMENT_SHADER,
    fsrEasu: FSR_EASU_FRAGMENT_SHADER,
    post: POST_FRAGMENT_SHADER,
  };

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

  function createProgram(gl, fragmentSource) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'shader link failed';
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  function normalizeEffects(effects) {
    effects = effects || {};
    return { scanlines: !!effects.scanlines, mask: !!effects.mask, glow: !!effects.glow };
  }
  function hasEffects(effects) { return effects.scanlines || effects.mask || effects.glow; }
  function normalizeDeditherMode(mode) {
    return mode === 'checkerboard' || mode === 'ordered2' ? mode : 'off';
  }

  class PresentationFilter {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
      this._createCanvas = options.createCanvas || (() => {
        if (typeof document === 'undefined') return null;
        return document.createElement('canvas');
      });
      this._gpu = null;
      this._gpuFailed = false;
      this.lastBackend = 'none';
      this.lastEffects = normalizeEffects();
      this.lastError = null;
      this.lastIntegerMultiplier = 0;
      this.lastPixelScaleMultiplier = 0;
      this.lastPixelScalePasses = [];
      this.lastPixelScaleStage = null;
      this.lastDeditherMode = 'off';
      this.lastDeditherBackend = 'off';
      this._sharpStage = null;
      this._deditherStage = null;
    }

    resize(width, height) {
      if (!this.canvas) return;
      width = Math.max(1, width | 0);
      height = Math.max(1, height | 0);
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      if (this._gpu && this._gpu.canvas) {
        if (this._gpu.canvas.width !== width) this._gpu.canvas.width = width;
        if (this._gpu.canvas.height !== height) this._gpu.canvas.height = height;
      }
    }

    present(source, mode, effects, options) {
      if (!source || !this.ctx || !this.canvas.width || !this.canvas.height) return false;
      effects = normalizeEffects(effects);
      const viewport = options && options.viewport ? options.viewport : null;
      const deditherMode = normalizeDeditherMode(options && options.dedither);
      this.lastEffects = effects;
      this.lastIntegerMultiplier = viewport ? viewport.multiplier : 0;
      this.lastPixelScaleMultiplier = 0;
      this.lastPixelScalePasses = [];
      this.lastPixelScaleStage = null;
      this.lastDeditherMode = deditherMode;
      this.lastDeditherBackend = 'off';
      if (deditherMode !== 'off') {
        source = this._prepareDeditherSource(source, deditherMode) || source;
      }
      if ((mode === 'sharp-bilinear' || mode === 'sharp-hq') && viewport) {
        return this._presentSharpViewport(source, mode, effects, viewport);
      }
      if (mode === 'fsr1' && this._presentFsr1(source, effects, viewport)) return true;
      if (mode === 'scale-auto' &&
          this._presentAutoPixelScaler(source, effects, viewport)) return true;

      return this._presentCanvas(source, mode, effects, viewport);
    }

    _prepareDeditherSource(source, mode) {
      const gpu = this._ensureGpu();
      if (!gpu) {
        this.lastDeditherBackend = 'unavailable';
        return null;
      }
      const shaderName = mode === 'ordered2'
        ? 'deditherOrdered2' : 'deditherCheckerboard';
      const program = this._program(gpu, shaderName);
      if (!program) {
        this.lastDeditherBackend = 'unavailable';
        return null;
      }
      try {
        const width = Math.max(1, source.width | 0);
        const height = Math.max(1, source.height | 0);
        const sourceTexture = this._uploadSource(gpu, source);
        if (gpu.canvas.width !== width) gpu.canvas.width = width;
        if (gpu.canvas.height !== height) gpu.canvas.height = height;
        this._draw(gpu, program, sourceTexture, null,
          { u_source_size: [width, height] });

        let stage = this._deditherStage;
        if (!stage || stage.width !== width || stage.height !== height) {
          stage = this._createCanvas();
          if (stage) {
            stage.width = width;
            stage.height = height;
          }
          this._deditherStage = stage;
        }
        const ctx = stage && stage.getContext ? stage.getContext('2d') : null;
        if (!ctx) {
          this.lastDeditherBackend = 'unavailable';
          return null;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(gpu.canvas, 0, 0);
        this.lastDeditherBackend = `webgl-${mode}`;
        return stage;
      } catch (error) {
        this.lastError = error;
        this.lastDeditherBackend = 'unavailable';
        return null;
      }
    }

    _presentCanvas(source, mode, effects, viewport) {
      const smooth = mode === 'sharp-bilinear' || mode === 'browser-hq' ||
        mode === 'sharp-hq' || mode === 'scale-auto' || mode === 'fsr1';
      const previousSmoothing = this.ctx.imageSmoothingEnabled;
      const hasQuality = 'imageSmoothingQuality' in this.ctx;
      const previousQuality = hasQuality ? this.ctx.imageSmoothingQuality : null;
      const previousFill = this.ctx.fillStyle;
      try {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (viewport && typeof this.ctx.fillRect === 'function') {
          this.ctx.fillStyle = '#000000';
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
        this.ctx.imageSmoothingEnabled = smooth;
        if (hasQuality) this.ctx.imageSmoothingQuality = smooth ? 'high' : 'low';
        this.ctx.drawImage(source,
          viewport ? viewport.cropX : 0,
          viewport ? viewport.cropY : 0,
          viewport ? viewport.cropW : source.width,
          viewport ? viewport.cropH : source.height,
          viewport ? viewport.dstX : 0,
          viewport ? viewport.dstY : 0,
          viewport ? viewport.dstW : this.canvas.width,
          viewport ? viewport.dstH : this.canvas.height);
      } finally {
        this.ctx.imageSmoothingEnabled = previousSmoothing;
        if (hasQuality) this.ctx.imageSmoothingQuality = previousQuality;
        if (previousFill !== undefined) this.ctx.fillStyle = previousFill;
      }
      this.lastBackend = smooth ? 'canvas-hq' : 'canvas-nearest';
      const logicalSource = viewport
        ? { width: viewport.nativeW, height: viewport.nativeH }
        : source;
      if (hasEffects(effects) && this._presentCrtFromCanvas(logicalSource, effects, viewport)) {
        this.lastBackend += '+webgl-crt';
      }
      return true;
    }

    _presentSharpViewport(source, mode, effects, viewport) {
      const quality = mode === 'sharp-hq' ? 'high' : 'low';
      const previousSmoothing = this.ctx.imageSmoothingEnabled;
      const hasQuality = 'imageSmoothingQuality' in this.ctx;
      const previousQuality = hasQuality ? this.ctx.imageSmoothingQuality : null;
      const previousFill = this.ctx.fillStyle;
      try {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (typeof this.ctx.fillRect === 'function') {
          this.ctx.fillStyle = '#000000';
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
        const stageW = viewport.multiplier > 0
          ? viewport.nativeW * viewport.multiplier : 0;
        const stageH = viewport.multiplier > 0
          ? viewport.nativeH * viewport.multiplier : 0;
        if (stageW === viewport.dstW && stageH === viewport.dstH) {
          this.ctx.imageSmoothingEnabled = false;
          this.ctx.drawImage(source, viewport.cropX, viewport.cropY,
            viewport.cropW, viewport.cropH, viewport.dstX, viewport.dstY,
            viewport.dstW, viewport.dstH);
        } else if (stageW > 0 && stageH > 0) {
          let stage = this._sharpStage;
          if (!stage || stage.width !== stageW || stage.height !== stageH) {
            stage = this._createCanvas();
            if (stage) {
              stage.width = stageW;
              stage.height = stageH;
            }
            this._sharpStage = stage;
          }
          const stageCtx = stage && stage.getContext ? stage.getContext('2d') : null;
          if (stageCtx) {
            stageCtx.clearRect(0, 0, stageW, stageH);
            stageCtx.imageSmoothingEnabled = false;
            stageCtx.drawImage(source, viewport.cropX, viewport.cropY,
              viewport.cropW, viewport.cropH, 0, 0, stageW, stageH);
            this.ctx.imageSmoothingEnabled = true;
            if (hasQuality) this.ctx.imageSmoothingQuality = quality;
            this.ctx.drawImage(stage, 0, 0, stageW, stageH,
              viewport.dstX, viewport.dstY, viewport.dstW, viewport.dstH);
          } else {
            this.ctx.imageSmoothingEnabled = true;
            if (hasQuality) this.ctx.imageSmoothingQuality = quality;
            this.ctx.drawImage(source, viewport.cropX, viewport.cropY,
              viewport.cropW, viewport.cropH, viewport.dstX, viewport.dstY,
              viewport.dstW, viewport.dstH);
          }
        } else {
          this.ctx.imageSmoothingEnabled = true;
          if (hasQuality) this.ctx.imageSmoothingQuality = quality;
          this.ctx.drawImage(source, viewport.cropX, viewport.cropY,
            viewport.cropW, viewport.cropH, viewport.dstX, viewport.dstY,
            viewport.dstW, viewport.dstH);
        }
      } finally {
        this.ctx.imageSmoothingEnabled = previousSmoothing;
        if (hasQuality) this.ctx.imageSmoothingQuality = previousQuality;
        if (previousFill !== undefined) this.ctx.fillStyle = previousFill;
      }
      this.lastBackend = `canvas-${mode}`;
      if (hasEffects(effects) && this._presentCrtFromCanvas(
        { width: viewport.nativeW, height: viewport.nativeH }, effects, viewport)) {
        this.lastBackend += '+webgl-crt';
      }
      return true;
    }

    _ensureGpu() {
      if (this._gpu || this._gpuFailed) return this._gpu;
      const canvas = this._createCanvas();
      if (!canvas || !canvas.getContext) { this._gpuFailed = true; return null; }
      canvas.width = Math.max(1, this.canvas.width | 0);
      canvas.height = Math.max(1, this.canvas.height | 0);
      const gl = canvas.getContext('webgl', {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: true, preserveDrawingBuffer: true,
      });
      if (!gl) { this._gpuFailed = true; return null; }
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1, 1, 1,
      ]), gl.STATIC_DRAW);
      const sourceTexture = this._makeTexture(gl);
      this._gpu = { canvas, gl, buffer, sourceTexture, programs: Object.create(null), intermediate: null };
      return this._gpu;
    }

    _makeTexture(gl) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    }

    _program(gpu, name) {
      if (Object.prototype.hasOwnProperty.call(gpu.programs, name)) return gpu.programs[name];
      try {
        const program = createProgram(gpu.gl, SHADERS[name]);
        const entry = {
          program,
          position: gpu.gl.getAttribLocation(program, 'a_position'),
          uniforms: Object.create(null),
        };
        gpu.programs[name] = entry;
        return entry;
      } catch (error) {
        this.lastError = error;
        gpu.programs[name] = null;
        return null;
      }
    }

    _uniform(gl, entry, name) {
      if (!(name in entry.uniforms)) entry.uniforms[name] = gl.getUniformLocation(entry.program, name);
      return entry.uniforms[name];
    }

    _uploadSource(gpu, source) {
      const gl = gpu.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gpu.sourceTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return gpu.sourceTexture;
    }

    _ensureIntermediate(gpu, requestedWidth, requestedHeight) {
      const gl = gpu.gl;
      const width = Math.max(1,
        requestedWidth === undefined ? this.canvas.width | 0 : requestedWidth | 0);
      const height = Math.max(1,
        requestedHeight === undefined ? this.canvas.height | 0 : requestedHeight | 0);
      let stage = gpu.intermediate;
      if (!stage) {
        stage = { texture: this._makeTexture(gl), framebuffer: gl.createFramebuffer(), width: 0, height: 0 };
        gpu.intermediate = stage;
      }
      if (stage.width !== width || stage.height !== height) {
        stage.width = width;
        stage.height = height;
        gl.bindTexture(gl.TEXTURE_2D, stage.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, stage.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D, stage.texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('presentation intermediate framebuffer is incomplete');
        }
      }
      return stage;
    }

    _draw(gpu, entry, texture, framebuffer, uniforms, viewport, targetSize) {
      const gl = gpu.gl;
      const targetWidth = Math.max(1,
        targetSize ? targetSize.width | 0 : gpu.canvas.width | 0);
      const targetHeight = Math.max(1,
        targetSize ? targetSize.height | 0 : gpu.canvas.height | 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, targetWidth, targetHeight);
      gl.clearColor(0, 0, 0, viewport ? 1 : 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (viewport) {
        gl.viewport(
          viewport.dstX,
          targetHeight - viewport.dstY - viewport.dstH,
          viewport.dstW,
          viewport.dstH);
      }
      gl.useProgram(entry.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.buffer);
      gl.enableVertexAttribArray(entry.position);
      gl.vertexAttribPointer(entry.position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const sampler = this._uniform(gl, entry, 'u_texture');
      if (sampler !== null) gl.uniform1i(sampler, 0);
      for (const [name, value] of Object.entries(uniforms || {})) {
        const location = this._uniform(gl, entry, name);
        if (location === null) continue;
        if (Array.isArray(value) && value.length === 2) gl.uniform2f(location, value[0], value[1]);
        else if (Array.isArray(value) && value.length === 3) gl.uniform3f(location, value[0], value[1], value[2]);
        else if (Array.isArray(value) && value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3]);
        else gl.uniform1f(location, value);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _drawPost(gpu, texture, source, effects, applyRcas, viewport) {
      const post = this._program(gpu, 'post');
      if (!post) return false;
      this._draw(gpu, post, texture, null, {
        u_texture_size: [this.canvas.width, this.canvas.height],
        u_logical_size: [source.width, source.height],
        u_apply_rcas: applyRcas ? 1 : 0,
        u_sharpness: Math.pow(2, -0.35),
        u_crt_flags: [effects.scanlines ? 1 : 0, effects.mask ? 1 : 0, effects.glow ? 1 : 0],
        u_content_rect: viewport
          ? [viewport.dstX / this.canvas.width,
            (this.canvas.height - viewport.dstY - viewport.dstH) / this.canvas.height,
            viewport.dstW / this.canvas.width, viewport.dstH / this.canvas.height]
          : [0, 0, 1, 1],
      });
      return true;
    }

    _presentAutoPixelScaler(source, effects, viewport) {
      const nativeWidth = Math.max(1, source.width | 0);
      const nativeHeight = Math.max(1, source.height | 0);
      const targetWidth = viewport ? viewport.dstW : this.canvas.width;
      const targetHeight = viewport ? viewport.dstH : this.canvas.height;
      const fit = Math.floor(Math.min(targetWidth / nativeWidth, targetHeight / nativeHeight));
      const multiplier = fit >= 4 ? 4 : (fit >= 3 ? 3 : (fit >= 2 ? 2 : 1));
      this.lastPixelScaleMultiplier = multiplier;
      if (multiplier < 2) return false;

      const gpu = this._ensureGpu();
      if (!gpu) return false;
      const scale2x = multiplier === 2 || multiplier === 4
        ? this._program(gpu, 'scale2x') : null;
      const scale3x = multiplier === 3 ? this._program(gpu, 'scale3x') : null;
      if ((multiplier === 3 && !scale3x) || (multiplier !== 3 && !scale2x)) return false;
      try {
        const sourceTexture = this._uploadSource(gpu, source);
        const stageWidth = nativeWidth * multiplier;
        const stageHeight = nativeHeight * multiplier;
        if (gpu.canvas.width !== stageWidth) gpu.canvas.width = stageWidth;
        if (gpu.canvas.height !== stageHeight) gpu.canvas.height = stageHeight;

        if (multiplier === 4) {
          const firstWidth = nativeWidth * 2;
          const firstHeight = nativeHeight * 2;
          const first = this._ensureIntermediate(gpu, firstWidth, firstHeight);
          this._draw(gpu, scale2x, sourceTexture, first.framebuffer,
            { u_source_size: [nativeWidth, nativeHeight] }, null,
            { width: firstWidth, height: firstHeight });
          this._draw(gpu, scale2x, first.texture, null,
            { u_source_size: [firstWidth, firstHeight] });
          this.lastPixelScalePasses = ['scale2x', 'scale2x'];
        } else {
          const program = multiplier === 3 ? scale3x : scale2x;
          this._draw(gpu, program, sourceTexture, null,
            { u_source_size: [nativeWidth, nativeHeight] });
          this.lastPixelScalePasses = [multiplier === 3 ? 'scale3x' : 'scale2x'];
        }

        const corrected = stageWidth !== targetWidth || stageHeight !== targetHeight;
        this._blitPixelScaleStage(gpu.canvas, viewport);
        this.lastPixelScaleStage = {
          width: stageWidth,
          height: stageHeight,
          targetWidth,
          targetHeight,
          corrected,
        };
        if (hasEffects(effects) && !this._presentCrtFromCanvas(
          { width: nativeWidth, height: nativeHeight }, effects, viewport)) return false;
        this.lastBackend = `webgl-scale${multiplier}x${corrected ? '+canvas-hq' : ''}` +
          `${hasEffects(effects) ? '+crt' : ''}`;
        return true;
      } catch (error) {
        this.lastError = error;
        return false;
      }
    }

    _blitPixelScaleStage(stage, viewport) {
      const dstX = viewport ? viewport.dstX : 0;
      const dstY = viewport ? viewport.dstY : 0;
      const dstW = viewport ? viewport.dstW : this.canvas.width;
      const dstH = viewport ? viewport.dstH : this.canvas.height;
      const exact = stage.width === dstW && stage.height === dstH;
      const previousSmoothing = this.ctx.imageSmoothingEnabled;
      const hasQuality = 'imageSmoothingQuality' in this.ctx;
      const previousQuality = hasQuality ? this.ctx.imageSmoothingQuality : null;
      const previousFill = this.ctx.fillStyle;
      try {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (viewport && typeof this.ctx.fillRect === 'function') {
          this.ctx.fillStyle = '#000000';
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
        this.ctx.imageSmoothingEnabled = !exact;
        if (hasQuality) this.ctx.imageSmoothingQuality = 'high';
        this.ctx.drawImage(stage, 0, 0, stage.width, stage.height,
          dstX, dstY, dstW, dstH);
      } finally {
        this.ctx.imageSmoothingEnabled = previousSmoothing;
        if (hasQuality) this.ctx.imageSmoothingQuality = previousQuality;
        if (previousFill !== undefined) this.ctx.fillStyle = previousFill;
      }
    }

    _presentFsr1(source, effects, viewport) {
      // EASU is an upscaler. Small DPR1 viewports can make the physical
      // presentation smaller than the logical canvas; browser HQ is the
      // correct fallback for that downsampling case.
      const targetW = viewport ? viewport.dstW : this.canvas.width;
      const targetH = viewport ? viewport.dstH : this.canvas.height;
      if (targetW < source.width || targetH < source.height) return false;
      const gpu = this._ensureGpu();
      if (!gpu) return false;
      const easu = this._program(gpu, 'fsrEasu');
      if (!easu) return false;
      try {
        if (gpu.canvas.width !== this.canvas.width) gpu.canvas.width = this.canvas.width;
        if (gpu.canvas.height !== this.canvas.height) gpu.canvas.height = this.canvas.height;
        const sourceTexture = this._uploadSource(gpu, source);
        const stage = this._ensureIntermediate(gpu);
        this._draw(gpu, easu, sourceTexture, stage.framebuffer,
          { u_source_size: [source.width, source.height] }, viewport);
        if (!this._drawPost(gpu, stage.texture, source, effects, true, viewport)) return false;
        this._blitGpu(gpu);
        this.lastBackend = `webgl-fsr1${hasEffects(effects) ? '+crt' : ''}`;
        return true;
      } catch (error) {
        this.lastError = error;
        return false;
      }
    }

    _presentCrtFromCanvas(source, effects, viewport) {
      const gpu = this._ensureGpu();
      if (!gpu) return false;
      try {
        if (gpu.canvas.width !== this.canvas.width) gpu.canvas.width = this.canvas.width;
        if (gpu.canvas.height !== this.canvas.height) gpu.canvas.height = this.canvas.height;
        const texture = this._uploadSource(gpu, this.canvas);
        if (!this._drawPost(gpu, texture, source, effects, false, viewport)) return false;
        this._blitGpu(gpu);
        return true;
      } catch (error) {
        this.lastError = error;
        return false;
      }
    }

    _blitGpu(gpu) {
      const previousSmoothing = this.ctx.imageSmoothingEnabled;
      try {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.drawImage(gpu.canvas, 0, 0);
      } finally {
        this.ctx.imageSmoothingEnabled = previousSmoothing;
      }
    }
  }

  return {
    PresentationFilter,
    SCALE2X_FRAGMENT_SHADER,
    SCALE3X_FRAGMENT_SHADER,
    DEDITHER_CHECKERBOARD_FRAGMENT_SHADER,
    DEDITHER_ORDERED2_FRAGMENT_SHADER,
    FSR_EASU_FRAGMENT_SHADER,
    POST_FRAGMENT_SHADER,
  };
});
