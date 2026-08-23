(function initUnditherAlgorithms(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UnditherAlgorithms = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  'use strict';

  const priorArt = typeof module === 'object' && module.exports
    ? require('./prior-art')
    : globalThis.PriorArtUndither;

  const linearLut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    linearLut[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }

  const algorithmInfo = {
    original: {
      label: 'Original (exact)',
      description: 'Pixel-exact bypass. This is the required reference and low-confidence behavior.',
    },
    box: {
      label: 'Box low-pass',
      description: 'Uniform local averaging in linear light. Useful as a deliberately blunt baseline.',
    },
    gaussian: {
      label: 'Gaussian low-pass',
      description: 'Separable Gaussian reconstruction. Smoother than a box filter, but still crosses edges.',
    },
    bilateral: {
      label: 'Bilateral',
      description: 'Low-pass filtering weighted by spatial distance and palette-color distance.',
    },
    anisotropic: {
      label: 'Anisotropic diffusion',
      description: 'Iterative Perona–Malik-style diffusion: smooth flat regions while resisting strong color edges.',
    },
    adaptiveFir: {
      label: 'Multiscale adaptive FIR',
      description: 'Correlates gradients at two scales, then varies an edge-aware FIR cutoff per pixel.',
    },
    paletteMix: {
      label: 'Palette-pair mixer',
      description: 'Finds locally alternating pairs of exact displayed palette colors and reconstructs their area mixture.',
    },
    orderedCell: {
      label: 'Ordered-cell mixer',
      description: 'Reconstructs two-color 2×2 or 4×4 cells at a fixed matrix phase. Intentionally narrow and easy to falsify.',
    },
    kornelski: {
      label: 'Kornelski undither',
      description: 'GPL prior art for Floyd–Steinberg: palette-aware 3×3 accumulation with Prewitt edge protection and pair-specific weights.',
    },
    sgenpt: {
      label: 'Libretro SGENPT-MIX',
      description: 'MIT prior art for horizontal alternation used as checker/vertical-line pseudo-transparency, using power-2 gamma and anti-ringing bounds.',
    },
    waMdapt: {
      label: 'WineAssembly MDAPT',
      description: 'The browser lab runs WineAssembly’s current five-pass native-resolution MDAPT shader directly; Node tests use a CPU reference port.',
    },
    waJinc2: {
      label: 'WineAssembly Jinc2',
      description: 'The browser lab runs WineAssembly’s current 16-tap, two-lobe windowed-Jinc shader directly; Node tests use a CPU reference port.',
    },
  };

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function normalizeOptions(options) {
    const source = options || {};
    return {
      radius: clamp(Math.round(Number(source.radius) || 2), 1, 4),
      strength: clamp(Number(source.strength) || 0, 0, 1),
      threshold: clamp(Number(source.threshold) || 36, 2, 160),
      iterations: clamp(Math.round(Number(source.iterations) || 4), 1, 10),
      matrixSize: Number(source.matrixSize) === 4 ? 4 : 2,
    };
  }

  function assertImage(image) {
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
        !image.data || image.data.length !== image.width * image.height * 4) {
      throw new TypeError('Expected { width, height, data: RGBA array }');
    }
  }

  function copyImage(image) {
    return {
      width: image.width,
      height: image.height,
      data: new Uint8ClampedArray(image.data),
    };
  }

  function srgbEncode(value) {
    const v = clamp(value, 0, 1);
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * (v ** (1 / 2.4)) - 0.055;
    return Math.round(encoded * 255);
  }

  function decodeLinear(image) {
    const pixelCount = image.width * image.height;
    const result = new Float32Array(pixelCount * 3);
    for (let p = 0; p < pixelCount; p++) {
      const s = p * 4;
      const d = p * 3;
      result[d] = linearLut[image.data[s]];
      result[d + 1] = linearLut[image.data[s + 1]];
      result[d + 2] = linearLut[image.data[s + 2]];
    }
    return result;
  }

  function encodeBlended(image, originalLinear, candidateLinear, amount) {
    const out = new Uint8ClampedArray(image.data.length);
    const pixelCount = image.width * image.height;
    for (let p = 0; p < pixelCount; p++) {
      const s = p * 4;
      const d = p * 3;
      const localAmount = typeof amount === 'number' ? amount : amount[p];
      if (localAmount <= 0 ||
          (candidateLinear[d] === originalLinear[d] &&
           candidateLinear[d + 1] === originalLinear[d + 1] &&
           candidateLinear[d + 2] === originalLinear[d + 2])) {
        out[s] = image.data[s];
        out[s + 1] = image.data[s + 1];
        out[s + 2] = image.data[s + 2];
      } else {
        out[s] = srgbEncode(originalLinear[d] + (candidateLinear[d] - originalLinear[d]) * localAmount);
        out[s + 1] = srgbEncode(originalLinear[d + 1] + (candidateLinear[d + 1] - originalLinear[d + 1]) * localAmount);
        out[s + 2] = srgbEncode(originalLinear[d + 2] + (candidateLinear[d + 2] - originalLinear[d + 2]) * localAmount);
      }
      out[s + 3] = image.data[s + 3];
    }
    return { width: image.width, height: image.height, data: out };
  }

  function makeGaussianKernel(radius) {
    const sigma = Math.max(0.7, radius * 0.72);
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const value = Math.exp(-(i * i) / (2 * sigma * sigma));
      kernel[i + radius] = value;
      sum += value;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    return kernel;
  }

  function makeBoxKernel(radius) {
    const size = radius * 2 + 1;
    const kernel = new Float32Array(size);
    kernel.fill(1 / size);
    return kernel;
  }

  function convolveLinear(source, width, height, kernel) {
    const radius = (kernel.length - 1) >> 1;
    const horizontal = new Float32Array(source.length);
    const output = new Float32Array(source.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dst = (y * width + x) * 3;
        for (let k = -radius; k <= radius; k++) {
          const sx = clamp(x + k, 0, width - 1);
          const src = (y * width + sx) * 3;
          const weight = kernel[k + radius];
          horizontal[dst] += source[src] * weight;
          horizontal[dst + 1] += source[src + 1] * weight;
          horizontal[dst + 2] += source[src + 2] * weight;
        }
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dst = (y * width + x) * 3;
        for (let k = -radius; k <= radius; k++) {
          const sy = clamp(y + k, 0, height - 1);
          const src = (sy * width + x) * 3;
          const weight = kernel[k + radius];
          output[dst] += horizontal[src] * weight;
          output[dst + 1] += horizontal[src + 1] * weight;
          output[dst + 2] += horizontal[src + 2] * weight;
        }
      }
    }
    return output;
  }

  function convolveScalar(source, width, height, kernel) {
    const radius = (kernel.length - 1) >> 1;
    const horizontal = new Float32Array(source.length);
    const output = new Float32Array(source.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let value = 0;
        for (let k = -radius; k <= radius; k++) {
          value += source[y * width + clamp(x + k, 0, width - 1)] * kernel[k + radius];
        }
        horizontal[y * width + x] = value;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let value = 0;
        for (let k = -radius; k <= radius; k++) {
          value += horizontal[clamp(y + k, 0, height - 1) * width + x] * kernel[k + radius];
        }
        output[y * width + x] = value;
      }
    }
    return output;
  }

  function lowPass(image, options, kind) {
    const opts = normalizeOptions(options);
    const source = decodeLinear(image);
    const kernel = kind === 'box' ? makeBoxKernel(opts.radius) : makeGaussianKernel(opts.radius);
    const filtered = convolveLinear(source, image.width, image.height, kernel);
    return encodeBlended(image, source, filtered, opts.strength);
  }

  function bilateral(image, options) {
    const opts = normalizeOptions(options);
    const { width, height } = image;
    const source = decodeLinear(image);
    const filtered = new Float32Array(source.length);
    const radius = opts.radius;
    const spatialSigma = Math.max(0.8, radius * 0.8);
    const colorSigma = Math.max(0.01, opts.threshold / 255);
    const invSpatial = 1 / (2 * spatialSigma * spatialSigma);
    const invColor = 1 / (2 * colorSigma * colorSigma);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const center = (y * width + x) * 3;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumW = 0;
        for (let oy = -radius; oy <= radius; oy++) {
          const sy = clamp(y + oy, 0, height - 1);
          for (let ox = -radius; ox <= radius; ox++) {
            const sx = clamp(x + ox, 0, width - 1);
            const sample = (sy * width + sx) * 3;
            const dr = source[sample] - source[center];
            const dg = source[sample + 1] - source[center + 1];
            const db = source[sample + 2] - source[center + 2];
            const spatial = ox * ox + oy * oy;
            const color = (dr * dr + dg * dg + db * db) / 3;
            const weight = Math.exp(-spatial * invSpatial - color * invColor);
            sumR += source[sample] * weight;
            sumG += source[sample + 1] * weight;
            sumB += source[sample + 2] * weight;
            sumW += weight;
          }
        }
        filtered[center] = sumR / sumW;
        filtered[center + 1] = sumG / sumW;
        filtered[center + 2] = sumB / sumW;
      }
    }
    return encodeBlended(image, source, filtered, opts.strength);
  }

  function anisotropic(image, options) {
    const opts = normalizeOptions(options);
    const { width, height } = image;
    const original = decodeLinear(image);
    let current = new Float32Array(original);
    const kappa = Math.max(0.008, opts.threshold / 255);
    const lambda = 0.2;
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let iteration = 0; iteration < opts.iterations; iteration++) {
      const next = new Float32Array(current);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const center = (y * width + x) * 3;
          let flowR = 0;
          let flowG = 0;
          let flowB = 0;
          for (const [ox, oy] of neighbors) {
            const sx = clamp(x + ox, 0, width - 1);
            const sy = clamp(y + oy, 0, height - 1);
            const sample = (sy * width + sx) * 3;
            const dr = current[sample] - current[center];
            const dg = current[sample + 1] - current[center + 1];
            const db = current[sample + 2] - current[center + 2];
            const magnitude = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
            const conductance = Math.exp(-((magnitude / kappa) ** 2));
            flowR += conductance * dr;
            flowG += conductance * dg;
            flowB += conductance * db;
          }
          next[center] += lambda * flowR;
          next[center + 1] += lambda * flowG;
          next[center + 2] += lambda * flowB;
        }
      }
      current = next;
    }
    return encodeBlended(image, original, current, opts.strength);
  }

  function adaptiveFir(image, options) {
    const opts = normalizeOptions(options);
    const { width, height } = image;
    const source = decodeLinear(image);
    const luminance = new Float32Array(width * height);
    for (let p = 0; p < luminance.length; p++) {
      const i = p * 3;
      luminance[p] = source[i] * 0.2126 + source[i + 1] * 0.7152 + source[i + 2] * 0.0722;
    }
    const small = convolveScalar(luminance, width, height, makeGaussianKernel(1));
    const large = convolveScalar(luminance, width, height, makeGaussianKernel(Math.max(2, opts.radius)));
    const filtered = new Float32Array(source.length);
    const amount = new Float32Array(width * height);
    const spatialSigma = Math.max(0.8, opts.radius * 0.8);
    const invSpatial = 1 / (2 * spatialSigma * spatialSigma);
    const rangeK = Math.max(0.012, opts.threshold / 128);
    const edgeK = Math.max(0.006, opts.threshold / 720);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const center = p * 3;
        const xm = y * width + Math.max(0, x - 1);
        const xp = y * width + Math.min(width - 1, x + 1);
        const ym = Math.max(0, y - 1) * width + x;
        const yp = Math.min(height - 1, y + 1) * width + x;
        const gxSmall = (small[xp] - small[xm]) * 0.5;
        const gySmall = (small[yp] - small[ym]) * 0.5;
        const gxLarge = (large[xp] - large[xm]) * 0.5;
        const gyLarge = (large[yp] - large[ym]) * 0.5;
        const coherentEdge = Math.sqrt(Math.abs(gxSmall * gxLarge) + Math.abs(gySmall * gyLarge));
        const flatness = Math.exp(-((coherentEdge / edgeK) ** 2));
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumW = 0;
        for (let oy = -opts.radius; oy <= opts.radius; oy++) {
          const sy = clamp(y + oy, 0, height - 1);
          for (let ox = -opts.radius; ox <= opts.radius; ox++) {
            const sx = clamp(x + ox, 0, width - 1);
            const sample = (sy * width + sx) * 3;
            const dr = source[sample] - source[center];
            const dg = source[sample + 1] - source[center + 1];
            const db = source[sample + 2] - source[center + 2];
            const colorDistance = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
            const weight = Math.exp(-(ox * ox + oy * oy) * invSpatial) *
              Math.exp(-((colorDistance / rangeK) ** 2));
            sumR += source[sample] * weight;
            sumG += source[sample + 1] * weight;
            sumB += source[sample + 2] * weight;
            sumW += weight;
          }
        }
        filtered[center] = sumR / sumW;
        filtered[center + 1] = sumG / sumW;
        filtered[center + 2] = sumB / sumW;
        amount[p] = opts.strength * flatness;
      }
    }
    return encodeBlended(image, source, filtered, amount);
  }

  function extractPalette(image) {
    const map = new Map();
    const colors = [];
    const counts = [];
    const ids = new Int32Array(image.width * image.height);
    for (let p = 0; p < ids.length; p++) {
      const i = p * 4;
      const packed = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
      let id = map.get(packed);
      if (id === undefined) {
        id = colors.length;
        map.set(packed, id);
        colors.push([image.data[i], image.data[i + 1], image.data[i + 2]]);
        counts.push(0);
      }
      ids[p] = id;
      counts[id]++;
    }
    return { colors, counts, ids };
  }

  function paletteLinear(palette) {
    return palette.colors.map(color => [linearLut[color[0]], linearLut[color[1]], linearLut[color[2]]]);
  }

  function paletteMix(image, options) {
    const opts = normalizeOptions(options);
    const { width, height } = image;
    const source = decodeLinear(image);
    const candidate = new Float32Array(source);
    const amount = new Float32Array(width * height);
    const palette = extractPalette(image);
    const colors = paletteLinear(palette);
    const histogram = new Uint16Array(colors.length);
    const minConfidence = clamp(opts.threshold / 160, 0.08, 0.85);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const touched = [];
        let samples = 0;
        for (let oy = -opts.radius; oy <= opts.radius; oy++) {
          const sy = clamp(y + oy, 0, height - 1);
          for (let ox = -opts.radius; ox <= opts.radius; ox++) {
            const sx = clamp(x + ox, 0, width - 1);
            const id = palette.ids[sy * width + sx];
            if (histogram[id]++ === 0) touched.push(id);
            samples++;
          }
        }
        let first = -1;
        let second = -1;
        for (const id of touched) {
          if (first < 0 || histogram[id] > histogram[first]) {
            second = first;
            first = id;
          } else if (second < 0 || histogram[id] > histogram[second]) {
            second = id;
          }
        }
        if (second >= 0 && touched.length <= 6) {
          const pairSamples = histogram[first] + histogram[second];
          const coverage = pairSamples / samples;
          const balance = 2 * Math.min(histogram[first], histogram[second]) / pairSamples;
          let pairEdges = 0;
          let transitions = 0;
          const minX = Math.max(0, x - opts.radius);
          const maxX = Math.min(width - 1, x + opts.radius);
          const minY = Math.max(0, y - opts.radius);
          const maxY = Math.min(height - 1, y + opts.radius);
          for (let sy = minY; sy <= maxY; sy++) {
            for (let sx = minX; sx <= maxX; sx++) {
              const here = palette.ids[sy * width + sx];
              if (sx < maxX) {
                const right = palette.ids[sy * width + sx + 1];
                if ((here === first || here === second) && (right === first || right === second)) {
                  pairEdges++;
                  if (here !== right) transitions++;
                }
              }
              if (sy < maxY) {
                const down = palette.ids[(sy + 1) * width + sx];
                if ((here === first || here === second) && (down === first || down === second)) {
                  pairEdges++;
                  if (here !== down) transitions++;
                }
              }
            }
          }
          const alternation = pairEdges ? transitions / pairEdges : 0;
          const confidence = coverage * Math.min(1, balance / 0.45) * alternation;
          if (coverage >= 0.78 && confidence >= minConfidence) {
            const mix = histogram[second] / pairSamples;
            const p = y * width + x;
            const d = p * 3;
            candidate[d] = colors[first][0] * (1 - mix) + colors[second][0] * mix;
            candidate[d + 1] = colors[first][1] * (1 - mix) + colors[second][1] * mix;
            candidate[d + 2] = colors[first][2] * (1 - mix) + colors[second][2] * mix;
            amount[p] = opts.strength * clamp((confidence - minConfidence) / Math.max(0.05, 1 - minConfidence), 0, 1);
          }
        }
        for (const id of touched) histogram[id] = 0;
      }
    }
    return encodeBlended(image, source, candidate, amount);
  }

  function orderedCell(image, options) {
    const opts = normalizeOptions(options);
    const { width, height } = image;
    const source = decodeLinear(image);
    const candidate = new Float32Array(source);
    const amount = new Float32Array(width * height);
    const palette = extractPalette(image);
    const colors = paletteLinear(palette);
    const size = opts.matrixSize;
    const requiredAlternation = clamp(opts.threshold / 160, 0.08, 0.8);
    for (let by = 0; by < height; by += size) {
      for (let bx = 0; bx < width; bx += size) {
        const counts = new Map();
        const maxX = Math.min(width, bx + size);
        const maxY = Math.min(height, by + size);
        for (let y = by; y < maxY; y++) {
          for (let x = bx; x < maxX; x++) {
            const id = palette.ids[y * width + x];
            counts.set(id, (counts.get(id) || 0) + 1);
          }
        }
        if (counts.size !== 2) continue;
        const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        const total = entries[0][1] + entries[1][1];
        const balance = 2 * entries[1][1] / total;
        let edges = 0;
        let transitions = 0;
        for (let y = by; y < maxY; y++) {
          for (let x = bx; x < maxX; x++) {
            const here = palette.ids[y * width + x];
            if (x + 1 < maxX) {
              edges++;
              if (here !== palette.ids[y * width + x + 1]) transitions++;
            }
            if (y + 1 < maxY) {
              edges++;
              if (here !== palette.ids[(y + 1) * width + x]) transitions++;
            }
          }
        }
        const alternation = edges ? transitions / edges : 0;
        if (balance < 0.35 || alternation < requiredAlternation) continue;
        const mix = entries[1][1] / total;
        const mixed = [
          colors[entries[0][0]][0] * (1 - mix) + colors[entries[1][0]][0] * mix,
          colors[entries[0][0]][1] * (1 - mix) + colors[entries[1][0]][1] * mix,
          colors[entries[0][0]][2] * (1 - mix) + colors[entries[1][0]][2] * mix,
        ];
        const confidence = clamp((alternation - requiredAlternation) / Math.max(0.05, 1 - requiredAlternation), 0, 1);
        for (let y = by; y < maxY; y++) {
          for (let x = bx; x < maxX; x++) {
            const p = y * width + x;
            const d = p * 3;
            candidate[d] = mixed[0];
            candidate[d + 1] = mixed[1];
            candidate[d + 2] = mixed[2];
            amount[p] = opts.strength * confidence;
          }
        }
      }
    }
    return encodeBlended(image, source, candidate, amount);
  }

  function shaderClamp(value) {
    return Math.max(0, Math.min(1, value));
  }

  function shaderQuantize(value) {
    return Math.round(shaderClamp(value) * 255) / 255;
  }

  function shaderSmoothstep(edge0, edge1, value) {
    const t = shaderClamp((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  function shaderSource(image) {
    const source = new Float32Array(image.width * image.height * 4);
    for (let i = 0; i < source.length; i++) source[i] = image.data[i] / 255;
    return source;
  }

  function shaderPixel(buffer, width, height, x, y, channel) {
    const sx = clamp(x, 0, width - 1);
    const sy = clamp(y, 0, height - 1);
    return buffer[(sy * width + sx) * 4 + channel];
  }

  function shaderRgb(buffer, width, height, x, y) {
    const offset = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
    return [buffer[offset], buffer[offset + 1], buffer[offset + 2]];
  }

  function rgbEqual(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] ? 1 : 0;
  }

  function normalizedDifference(a, b) {
    const x = a[0] - b[0];
    const y = a[1] - b[1];
    const z = a[2] - b[2];
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    return magnitude === 0 ? [0, 0, 0] : [x / magnitude, y / magnitude, z / magnitude];
  }

  function dotFixed(a, b) {
    return Math.max(0, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  }

  function mdaptColorDistance(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    const redAverage = 0.5 * (a[0] + b[0]);
    const distance = Math.sqrt(dr * dr * (2 + redAverage) + dg * dg * 4 + db * db * (3 - redAverage));
    return shaderSmoothstep(3, 0, distance) ** 2;
  }

  function wineAssemblyMdapt(image) {
    const { width, height } = image;
    const source = shaderSource(image);
    const pass0 = new Float32Array(source.length);
    const pass1 = new Float32Array(source.length);
    const pass2 = new Float32Array(source.length);
    const pass3 = new Float32Array(source.length);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const c = shaderRgb(source, width, height, x, y);
        const l = shaderRgb(source, width, height, x - 1, y);
        const r = shaderRgb(source, width, height, x + 1, y);
        const u = shaderRgb(source, width, height, x, y - 1);
        const d = shaderRgb(source, width, height, x, y + 1);
        const dcl = normalizedDifference(c, l);
        const dcr = normalizedDifference(c, r);
        const dcd = normalizedDifference(c, d);
        const dcu = normalizedDifference(c, u);
        const signalX = dotFixed(dcl, dcr) * mdaptColorDistance(l, r);
        const signalY = dotFixed(dcu, dcd) * mdaptColorDistance(u, d);
        const signalZ = Math.min(signalX, signalY,
          dotFixed(dcl, dcu) * mdaptColorDistance(l, u),
          dotFixed(dcl, dcd) * mdaptColorDistance(l, d),
          dotFixed(dcr, dcu) * mdaptColorDistance(r, u),
          dotFixed(dcr, dcd) * mdaptColorDistance(r, d));
        pass0[offset] = shaderQuantize(signalX);
        pass0[offset + 1] = shaderQuantize(signalY);
        pass0[offset + 2] = shaderQuantize(signalZ);
        pass0[offset + 3] = 1;
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const c0 = shaderPixel(pass0, width, height, x, y, 0);
        const c2 = shaderPixel(pass0, width, height, x, y, 2);
        const lx = shaderPixel(pass0, width, height, x - 1, y, 0);
        const ly = shaderPixel(pass0, width, height, x - 1, y, 1);
        const lz = shaderPixel(pass0, width, height, x - 1, y, 2);
        const rx = shaderPixel(pass0, width, height, x + 1, y, 0);
        const ry = shaderPixel(pass0, width, height, x + 1, y, 1);
        const rz = shaderPixel(pass0, width, height, x + 1, y, 2);
        const ux = shaderPixel(pass0, width, height, x, y - 1, 0);
        const uz = shaderPixel(pass0, width, height, x, y - 1, 2);
        const dx = shaderPixel(pass0, width, height, x, y + 1, 0);
        const dz = shaderPixel(pass0, width, height, x, y + 1, 2);
        const ul = shaderPixel(pass0, width, height, x - 1, y - 1, 2);
        const ur = shaderPixel(pass0, width, height, x + 1, y - 1, 2);
        const dl = shaderPixel(pass0, width, height, x - 1, y + 1, 2);
        const dr = shaderPixel(pass0, width, height, x + 1, y + 1, 2);
        const checker = Math.max(c2,
          Math.min(Math.min(lz, rz), Math.max(ux, dx)),
          Math.min(Math.min(uz, dz), Math.max(ly, ry)),
          Math.min(c0, Math.max(Math.min(ul, ur), Math.min(dl, dr))),
          Math.min(shaderPixel(pass0, width, height, x, y, 1),
            Math.max(Math.min(ul, dl), Math.min(ur, dr))));
        pass1[offset] = shaderQuantize(c0);
        pass1[offset + 1] = shaderQuantize(checker);
      }
    }

    function pair(buffer, x, y) {
      return [shaderPixel(buffer, width, height, x, y, 0), shaderPixel(buffer, width, height, x, y, 1)];
    }
    function pairMin(a, b) { return [Math.min(a[0], b[0]), Math.min(a[1], b[1])]; }
    function pairMax(a, b) { return [Math.max(a[0], b[0]), Math.max(a[1], b[1])]; }
    function pairAdd(a, b) { a[0] += b[0]; a[1] += b[1]; return a; }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const c = pair(pass0, x, y);
        const l1 = pair(pass1, x - 1, y), r1 = pair(pass1, x + 1, y);
        const u1 = pair(pass1, x, y - 1), d1 = pair(pass1, x, y + 1);
        const l2 = pairMin(pair(pass1, x - 2, y), l1), r2 = pairMin(pair(pass1, x + 2, y), r1);
        const u2 = pairMin(pair(pass1, x, y - 2), u1), d2 = pairMin(pair(pass1, x, y + 2), d1);
        const ul = pairMin(pair(pass1, x - 1, y - 1), pairMax(l1, u1));
        const ur = pairMin(pair(pass1, x + 1, y - 1), pairMax(r1, u1));
        const dl = pairMin(pair(pass1, x - 1, y + 1), pairMax(l1, d1));
        const dr = pairMin(pair(pass1, x + 1, y + 1), pairMax(r1, d1));
        const ull = pairMin(pair(pass1, x - 2, y - 1), pairMax(l2, ul));
        const urr = pairMin(pair(pass1, x + 2, y - 1), pairMax(r2, ur));
        const drr = pairMin(pair(pass1, x + 2, y + 1), pairMax(r2, dr));
        const dll = pairMin(pair(pass1, x - 2, y + 1), pairMax(l2, dl));
        const uul = pairMin(pair(pass1, x - 1, y - 2), pairMax(u2, ul));
        const uur = pairMin(pair(pass1, x + 1, y - 2), pairMax(u2, ur));
        const ddr = pairMin(pair(pass1, x + 1, y + 2), pairMax(d2, dr));
        const ddl = pairMin(pair(pass1, x - 1, y + 2), pairMax(d2, dl));
        const hits = [0, 0];
        for (const value of [
          pairMin(pair(pass1, x - 2, y - 2), pairMax(uul, ull)),
          pairMin(pair(pass1, x + 2, y - 2), pairMax(uur, urr)),
          pairMin(pair(pass1, x - 2, y + 2), pairMax(ddl, dll)),
          pairMin(pair(pass1, x + 2, y + 2), pairMax(ddr, drr)),
          ull, urr, drr, dll, l2, r2,
        ]) pairAdd(hits, value);
        for (const value of [c, u1, u2, d1, d2, l1, r1, ul, ur, dl, dr, uul, uur, ddr, ddl]) {
          hits[1] += value[1];
        }
        pass2[offset] = shaderQuantize(c[0] * shaderSmoothstep(1.25, 1.75, hits[0]));
        pass2[offset + 1] = shaderQuantize(c[1] * shaderSmoothstep(5.25, 5.75, hits[1]));
        pass2[offset + 2] = shaderQuantize(c[0]);
        pass2[offset + 3] = shaderQuantize(c[1]);
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const m = [pass2[offset], pass2[offset + 1], pass2[offset + 2], pass2[offset + 3]];
        const l = pair(pass2, x - 1, y), r = pair(pass2, x + 1, y);
        const u = pair(pass2, x, y - 1), d = pair(pass2, x, y + 1);
        const c = shaderRgb(source, width, height, x, y);
        const propagated = pairMin([m[2], m[3]], pairMax(pairMax(l, r), pairMax(u, d)));
        m[0] = Math.max(m[0], propagated[0]);
        m[1] = Math.max(m[1], propagated[1]);
        const equalMask = (sx, sy) => rgbEqual(c, shaderRgb(source, width, height, sx, sy));
        m[1] = Math.max(m[1],
          Math.min(u[1], equalMask(x, y - 1)), Math.min(d[1], equalMask(x, y + 1)),
          Math.min(l[1], equalMask(x - 1, y)), Math.min(r[1], equalMask(x + 1, y)),
          Math.min(shaderPixel(pass2, width, height, x - 1, y - 1, 1), equalMask(x - 1, y - 1)),
          Math.min(shaderPixel(pass2, width, height, x + 1, y - 1, 1), equalMask(x + 1, y - 1)),
          Math.min(shaderPixel(pass2, width, height, x - 1, y + 1, 1), equalMask(x - 1, y + 1)),
          Math.min(shaderPixel(pass2, width, height, x + 1, y + 1, 1), equalMask(x + 1, y + 1)));
        for (let channel = 0; channel < 4; channel++) pass3[offset + channel] = shaderQuantize(m[channel]);
      }
    }

    const out = new Uint8ClampedArray(image.data.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const m = [pass3[offset], pass3[offset + 1], pass3[offset + 2], pass3[offset + 3]];
        const lm = pair(pass3, x - 1, y), rm = pair(pass3, x + 1, y);
        const um = pair(pass3, x, y - 1), dm = pair(pass3, x, y + 1);
        const c = shaderRgb(source, width, height, x, y);
        const l = shaderRgb(source, width, height, x - 1, y);
        const r = shaderRgb(source, width, height, x + 1, y);
        const u = shaderRgb(source, width, height, x, y - 1);
        const d = shaderRgb(source, width, height, x, y + 1);
        const propagated = pairMin([m[2], m[3]], pairMax(pairMax(lm, rm), pairMax(um, dm)));
        m[0] = Math.max(m[0], propagated[0]);
        m[1] = Math.max(m[1], propagated[1]);
        const eql = rgbEqual(c, l), eqr = rgbEqual(c, r), equ = rgbEqual(c, u), eqd = rgbEqual(c, d);
        const pu = Math.max(um[1], equ), pd = Math.max(dm[1], eqd);
        const pl = Math.max(lm[1], eql), pr = Math.max(rm[1], eqr);
        const sum = pu + pd + pl + pr;
        const largest = Math.max(pl, pr, pu, pd);
        const centerWeight = largest === 0 ? 1 : sum / largest;
        const denominator = centerWeight + sum;
        const filtered = [0, 1, 2].map(channel =>
          (centerWeight * c[channel] + pu * u[channel] + pd * d[channel] + pl * l[channel] + pr * r[channel]) /
          denominator);
        const equalMask = (sx, sy) => rgbEqual(c, shaderRgb(source, width, height, sx, sy));
        const checker = Math.max(m[1], Math.min(lm[1], eql), Math.min(rm[1], eqr),
          Math.min(um[1], equ), Math.min(dm[1], eqd),
          Math.min(shaderPixel(pass3, width, height, x - 1, y - 1, 1), equalMask(x - 1, y - 1)),
          Math.min(shaderPixel(pass3, width, height, x + 1, y - 1, 1), equalMask(x + 1, y - 1)),
          Math.min(shaderPixel(pass3, width, height, x - 1, y + 1, 1), equalMask(x - 1, y + 1)),
          Math.min(shaderPixel(pass3, width, height, x + 1, y + 1, 1), equalMask(x + 1, y + 1)));
        out[offset] = Math.round(shaderClamp(c[0] + (filtered[0] - c[0]) * checker) * 255);
        out[offset + 1] = Math.round(shaderClamp(c[1] + (filtered[1] - c[1]) * checker) * 255);
        out[offset + 2] = Math.round(shaderClamp(c[2] + (filtered[2] - c[2]) * checker) * 255);
        out[offset + 3] = image.data[offset + 3];
      }
    }
    return { width, height, data: out };
  }

  function wineAssemblyJinc2(image) {
    const { width, height } = image;
    const source = shaderSource(image);
    const out = new Uint8ClampedArray(image.data.length);
    const pi = Math.PI;
    const weight = radius => radius === 0
      ? 0.405 * pi * 0.79 * pi
      : Math.sin(radius * 0.405 * pi) * Math.sin(radius * 0.79 * pi) / (radius * radius);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const filtered = [0, 0, 0];
        let total = 0;
        for (let oy = -1; oy <= 2; oy++) {
          for (let ox = -1; ox <= 2; ox++) {
            const tap = weight(Math.sqrt(ox * ox + oy * oy));
            const sample = shaderRgb(source, width, height, x + ox, y + oy);
            filtered[0] += sample[0] * tap;
            filtered[1] += sample[1] * tap;
            filtered[2] += sample[2] * tap;
            total += tap;
          }
        }
        for (let channel = 0; channel < 3; channel++) filtered[channel] /= total;
        const neighborhood = [
          shaderRgb(source, width, height, x, y),
          shaderRgb(source, width, height, x + 1, y),
          shaderRgb(source, width, height, x, y + 1),
          shaderRgb(source, width, height, x + 1, y + 1),
        ];
        for (let channel = 0; channel < 3; channel++) {
          const minimum = Math.min(...neighborhood.map(color => color[channel]));
          const maximum = Math.max(...neighborhood.map(color => color[channel]));
          const clamped = clamp(filtered[channel], minimum, maximum);
          out[offset + channel] = Math.round(shaderClamp(filtered[channel] * 0.2 + clamped * 0.8) * 255);
        }
        out[offset + 3] = image.data[offset + 3];
      }
    }
    return { width, height, data: out };
  }

  const implementations = {
    original: copyImage,
    box: (image, options) => lowPass(image, options, 'box'),
    gaussian: (image, options) => lowPass(image, options, 'gaussian'),
    bilateral,
    anisotropic,
    adaptiveFir,
    paletteMix,
    orderedCell,
    kornelski: priorArt.kornelskiUndither,
    sgenpt: priorArt.sgenptMix,
    waMdapt: wineAssemblyMdapt,
    waJinc2: wineAssemblyJinc2,
  };

  function run(name, image, options) {
    assertImage(image);
    const implementation = implementations[name];
    if (!implementation) throw new RangeError(`Unknown algorithm: ${name}`);
    return implementation(image, options || {});
  }

  return {
    algorithmInfo,
    extractPalette,
    normalizeOptions,
    run,
  };
}));
