/*
 * Prior-art reference ports for the undithering testbed.
 *
 * Kornel Lesiński's `undither` algorithm is adapted from undither 1.0.8,
 * licensed GPL-3.0-or-later:
 * https://github.com/kornelski/undither
 *
 * Hyllian's SGENPT-MIX v10 algorithm is adapted from the libretro shader,
 * licensed MIT:
 * https://github.com/libretro/slang-shaders/blob/master/dithering/shaders/sgenpt-mix.slang
 */
(function initPriorArt(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PriorArtUndither = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildPriorArt() {
  'use strict';

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function strengthOf(options) {
    const value = Number(options && options.strength);
    return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
  }

  function exactPalette(image) {
    const colors = [];
    const ids = new Int16Array(image.width * image.height);
    const byColor = new Map();
    for (let p = 0; p < ids.length; p++) {
      const offset = p * 4;
      const key = (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
      let id = byColor.get(key);
      if (id === undefined) {
        id = colors.length;
        if (id >= 256) {
          throw new RangeError('Kornelski undither requires a paletted image with at most 256 displayed colors');
        }
        byColor.set(key, id);
        colors.push([image.data[offset], image.data[offset + 1], image.data[offset + 2]]);
      }
      ids[p] = id;
    }
    return { colors, ids };
  }

  function colorDifferenceSquared(a, b) {
    const red = a[0] - b[0];
    const green = a[1] - b[1];
    const blue = a[2] - b[2];
    return red * red + green * green + blue * blue;
  }

  function makeSimilarity(palette) {
    const size = palette.length;
    const cache = new Int8Array(size * size);
    cache.fill(-1);
    for (let i = 0; i < size; i++) cache[i * size + i] = 7;
    return function similarity(index1, index2) {
      const low = Math.min(index1, index2);
      const high = Math.max(index1, index2);
      const key = low * size + high;
      if (cache[key] >= 0) return cache[key];
      const first = palette[index1];
      const second = palette[index2];
      const average = [
        Math.floor((first[0] + second[0]) / 2),
        Math.floor((first[1] + second[1]) / 2),
        Math.floor((first[2] + second[2]) / 2),
      ];
      const pairDistance = colorDifferenceSquared(average, first);
      let nearestOther = Infinity;
      for (let i = 0; i < size; i++) {
        if (i === index1 || i === index2) continue;
        nearestOther = Math.min(nearestOther, colorDifferenceSquared(average, palette[i]));
      }
      const result = nearestOther >= pairDistance * 2 ? 8
        : nearestOther >= pairDistance ? 6
          : nearestOther * 3 >= pairDistance * 2 ? 1 : 0;
      cache[key] = result;
      return result;
    };
  }

  function prewittField(image) {
    const { width, height } = image;
    const gray = new Int16Array(width * height);
    const result = new Uint32Array(width * height);
    for (let p = 0; p < gray.length; p++) {
      const offset = p * 4;
      gray[p] = image.data[offset] + image.data[offset + 1] * 2 + image.data[offset + 2];
    }
    const sample = (x, y) => gray[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const topLeft = sample(x - 1, y - 1);
        const top = sample(x, y - 1);
        const topRight = sample(x + 1, y - 1);
        const left = sample(x - 1, y);
        const right = sample(x + 1, y);
        const bottomLeft = sample(x - 1, y + 1);
        const bottom = sample(x, y + 1);
        const bottomRight = sample(x + 1, y + 1);
        const gx = topRight - topLeft + right - left + bottomRight - bottomLeft;
        const gy = bottomLeft + bottom + bottomRight - topLeft - top - topRight;
        result[y * width + x] = Math.floor((gx * gx + gy * gy) / 256);
      }
    }
    return result;
  }

  function kornelskiUndither(image, options) {
    const { width, height } = image;
    const strength = strengthOf(options);
    const palette = exactPalette(image);
    const similarity = makeSimilarity(palette.colors);
    const prewitt = prewittField(image);
    const output = new Uint8ClampedArray(image.data);
    const neighbors = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const offset = p * 4;
        if (image.data[offset + 3] === 0 || prewitt[p] > 256) continue;
        const centerIndex = palette.ids[p];
        const centerColor = palette.colors[centerIndex];
        let totalWeight = prewitt[p] > 160 ? 24 : 8;
        let red = centerColor[0] * totalWeight;
        let green = centerColor[1] * totalWeight;
        let blue = centerColor[2] * totalWeight;
        for (const [ox, oy] of neighbors) {
          const sx = clamp(x + ox, 0, width - 1);
          const sy = clamp(y + oy, 0, height - 1);
          const samplePixel = sy * width + sx;
          const sampleOffset = samplePixel * 4;
          if (image.data[sampleOffset + 3] === 0) continue;
          const sampleIndex = palette.ids[samplePixel];
          const weight = similarity(centerIndex, sampleIndex);
          if (!weight) continue;
          const color = palette.colors[sampleIndex];
          red += color[0] * weight;
          green += color[1] * weight;
          blue += color[2] * weight;
          totalWeight += weight;
        }
        const reconstructed = [
          Math.floor(red / totalWeight),
          Math.floor(green / totalWeight),
          Math.floor(blue / totalWeight),
        ];
        for (let channel = 0; channel < 3; channel++) {
          output[offset + channel] = Math.round(image.data[offset + channel] +
            (reconstructed[channel] - image.data[offset + channel]) * strength);
        }
      }
    }
    return { width, height, data: output };
  }

  function smoothstep(low, high, value) {
    const t = clamp((value - low) / (high - low), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function sgenptMix(image, options) {
    const { width, height } = image;
    const strength = strengthOf(options);
    const output = new Uint8ClampedArray(image.data.length);
    const source = image.data;
    const sample = (x, y) => {
      const offset = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
      return [
        (source[offset] / 255) ** 2,
        (source[offset + 1] / 255) ** 2,
        (source[offset + 2] / 255) ** 2,
      ];
    };
    const luminance = [0.299, 0.587, 0.114];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const center = sample(x, y);
        const left = sample(x - 1, y);
        const right = sample(x + 1, y);
        const minimum = center.map((value, channel) => Math.min(value, Math.max(left[channel], right[channel])));
        const maximum = center.map((value, channel) => Math.max(value, Math.min(left[channel], right[channel])));
        const spread = center.map((_, channel) =>
          Math.max(center[channel], left[channel], right[channel]) -
          Math.min(center[channel], left[channel], right[channel]));
        const contrast = smoothstep(0, 1, 0.15 *
          (spread[0] * luminance[0] + spread[1] * luminance[1] + spread[2] * luminance[2]));
        const candidateLeft = center.map((value, channel) =>
          0.5 * (value + left[channel] + contrast * (value - left[channel])));
        const candidateRight = center.map((value, channel) =>
          0.5 * (value + right[channel] + contrast * (value - right[channel])));
        const contrastLeft = center.reduce((sum, value, channel) =>
          sum + Math.abs(value - candidateLeft[channel]) * luminance[channel], 0);
        const contrastRight = center.reduce((sum, value, channel) =>
          sum + Math.abs(value - candidateRight[channel]) * luminance[channel], 0);
        const selected = contrastRight < contrastLeft ? candidateRight : candidateLeft;
        for (let channel = 0; channel < 3; channel++) {
          const filtered = Math.sqrt(clamp(selected[channel], minimum[channel], maximum[channel])) * 255;
          output[offset + channel] = Math.round(source[offset + channel] +
            (filtered - source[offset + channel]) * strength);
        }
        output[offset + 3] = source[offset + 3];
      }
    }
    return { width, height, data: output };
  }

  return { kornelskiUndither, sgenptMix };
}));
