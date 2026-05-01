// Node canvas compatibility shim over skia-canvas.
// Provides node-canvas-style createCanvas/loadImage/registerFont.
const sk = require('skia-canvas');

const createCanvas = (w, h) => new sk.Canvas(w, h);
const { loadImage, Image, ImageData, Path2D, Canvas } = sk;

function registerFont(filePath, opts) {
  const family = opts && opts.family;
  if (sk.FontLibrary && sk.FontLibrary.use) {
    try { sk.FontLibrary.use(family ? { [family]: [filePath] } : [filePath]); } catch (_) {}
  }
}

module.exports = { createCanvas, loadImage, registerFont, Image, ImageData, Path2D, Canvas };
