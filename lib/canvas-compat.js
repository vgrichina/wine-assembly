// node-canvas-style createCanvas/loadImage/registerFont for headless runs.
//
// Backed by lib/raster-canvas.js -- pure JavaScript plus pngjs. There is no
// native canvas dependency in this project any more: the browser supplies its
// own canvas, the web tests drive real Chrome through puppeteer, and everything
// headless goes through here.
//
// See the header in raster-canvas.js for why that is enough. Short version:
// WAT owns GDI rasterization and hands over finished pixels, clipping arrives
// as rectangle bands rather than paths, and the presenter's whole job is to
// blit and clip rectangles.
//
// IMPORTANT: anything that creates an offscreen surface must come through this
// module. The compositor blits those surfaces onto the screen canvas, and a
// surface from a different canvas implementation is not a valid drawImage
// source -- that mismatch renders a blank screen while every draw call reports
// success.
module.exports = require('./raster-canvas');
