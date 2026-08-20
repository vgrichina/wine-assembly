#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

function usage() {
  console.error("usage: node tools/font-render-compare.js OURS.png WIN98.png OUTPUT_DIR");
  process.exit(2);
}

const [, , oursPath, referencePath, outputDir] = process.argv;
if (!oursPath || !referencePath || !outputDir) usage();

const ours = PNG.sync.read(fs.readFileSync(oursPath));
const reference = PNG.sync.read(fs.readFileSync(referencePath));
if (ours.width !== reference.width || ours.height !== reference.height) {
  throw new Error(`capture dimensions differ: ${ours.width}x${ours.height} vs ` +
    `${reference.width}x${reference.height}`);
}

const faces = ["Arial", "Times New Roman", "Courier New", "MS Sans Serif"];
const sizes = [12, 18, 26, 36];
const sampleBands = [
  { y0: 81, y1: 108 },
  { y0: 167, y1: 205 },
  { y0: 263, y1: 312 },
  { y0: 367, y1: 425 },
];

function pixel(image, x, y) {
  return (y * image.width + x) * 4;
}

function isInk(image, offset) {
  return image.data[offset] < 128 &&
    image.data[offset + 1] < 128 &&
    image.data[offset + 2] < 128 &&
    image.data[offset + 3] >= 128;
}

function cellStats(column, row) {
  const x0 = column * 160 + 3;
  const x1 = column * 160 + 158;
  const { y0, y1 } = sampleBands[row];
  const maxShift = Math.max(2, Math.ceil(sizes[row] / 6));
  let oursInk = 0;
  let referenceInk = 0;
  let intersection = 0;
  let union = 0;
  const oursPoints = [];
  const referencePoints = new Set();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const oi = isInk(ours, pixel(ours, x, y));
      const ri = isInk(reference, pixel(reference, x, y));
      if (oi) { oursInk++; oursPoints.push([x, y]); }
      if (ri) { referenceInk++; referencePoints.add(`${x},${y}`); }
      if (oi && ri) intersection++;
      if (oi || ri) union++;
    }
  }
  let alignedIntersection = 0;
  let bestShift = { x: 0, y: 0 };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let shiftedIntersection = 0;
      for (const [x, y] of oursPoints) {
        if (referencePoints.has(`${x + dx},${y + dy}`)) shiftedIntersection++;
      }
      if (shiftedIntersection > alignedIntersection) {
        alignedIntersection = shiftedIntersection;
        bestShift = { x: dx, y: dy };
      }
    }
  }
  const alignedUnion = oursInk + referenceInk - alignedIntersection;
  return {
    face: faces[column],
    size: sizes[row],
    oursInk,
    referenceInk,
    intersection,
    union,
    inkIoU: union ? Number((intersection / union).toFixed(4)) : 1,
    bestShift,
    maxShift,
    alignedIntersection,
    alignedUnion,
    alignedInkIoU: alignedUnion ? Number((alignedIntersection / alignedUnion).toFixed(4)) : 1,
  };
}

let differingPixels = 0;
let absoluteRgbError = 0;
const pixelCount = ours.width * ours.height;
for (let offset = 0; offset < ours.data.length; offset += 4) {
  let differs = false;
  for (let channel = 0; channel < 3; channel++) {
    const error = Math.abs(ours.data[offset + channel] - reference.data[offset + channel]);
    absoluteRgbError += error;
    if (error) differs = true;
  }
  if (differs) differingPixels++;
}

const cells = [];
for (let row = 0; row < sizes.length; row++) {
  for (let column = 0; column < faces.length; column++) {
    cells.push(cellStats(column, row));
  }
}
const totalIntersection = cells.reduce((sum, cell) => sum + cell.intersection, 0);
const totalUnion = cells.reduce((sum, cell) => sum + cell.union, 0);
const totalAlignedIntersection = cells.reduce((sum, cell) => sum + cell.alignedIntersection, 0);
const totalAlignedUnion = cells.reduce((sum, cell) => sum + cell.alignedUnion, 0);

const overlay = new PNG({ width: ours.width, height: ours.height });
for (let y = 0; y < ours.height; y++) {
  for (let x = 0; x < ours.width; x++) {
    const sourceOffset = pixel(ours, x, y);
    const outputOffset = pixel(overlay, x, y);
    const oi = isInk(ours, sourceOffset);
    const ri = isInk(reference, sourceOffset);
    let color;
    if (oi && ri) color = [0, 0, 0];
    else if (oi) color = [215, 0, 170];
    else if (ri) color = [0, 150, 220];
    else color = [255, 255, 255];
    overlay.data[outputOffset] = color[0];
    overlay.data[outputOffset + 1] = color[1];
    overlay.data[outputOffset + 2] = color[2];
    overlay.data[outputOffset + 3] = 255;
  }
}

const sideBySide = new PNG({ width: ours.width * 3, height: ours.height });
for (let y = 0; y < ours.height; y++) {
  for (let x = 0; x < ours.width; x++) {
    const sourceOffset = pixel(ours, x, y);
    for (const [panel, image] of [[0, ours], [1, reference], [2, overlay]]) {
      const outputOffset = (y * sideBySide.width + x + panel * ours.width) * 4;
      image.data.copy(sideBySide.data, outputOffset, sourceOffset, sourceOffset + 4);
    }
  }
}

const report = {
  schemaVersion: 1,
  dimensions: { width: ours.width, height: ours.height },
  panels: ["wine-assembly", "win98-v86", "ink-overlay"],
  overlayLegend: {
    black: "ink in both captures",
    magenta: "wine-assembly ink only",
    cyan: "Win98/v86 ink only",
  },
  wholeImage: {
    differingPixels,
    differingFraction: Number((differingPixels / pixelCount).toFixed(6)),
    meanAbsoluteRgbError: Number((absoluteRgbError / (pixelCount * 3)).toFixed(4)),
  },
  sampleInkIoU: Number((totalIntersection / totalUnion).toFixed(4)),
  sampleAlignedInkIoU: Number((totalAlignedIntersection / totalAlignedUnion).toFixed(4)),
  cells,
};

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(oursPath, path.join(outputDir, "wine-assembly.png"));
fs.copyFileSync(referencePath, path.join(outputDir, "win98-v86.png"));
fs.writeFileSync(path.join(outputDir, "ink-overlay.png"), PNG.sync.write(overlay));
fs.writeFileSync(path.join(outputDir, "side-by-side.png"), PNG.sync.write(sideBySide));
fs.writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const rows = cells.map(cell => `
          <tr><td>${cell.face}</td><td>${cell.size}px</td><td>${cell.oursInk}</td>
          <td>${cell.referenceInk}</td><td>${(cell.inkIoU * 100).toFixed(1)}%</td>
          <td>${(cell.alignedInkIoU * 100).toFixed(1)}% (${cell.bestShift.x},${cell.bestShift.y}; ±${cell.maxShift})</td></tr>`).join("");
const html = `<!doctype html>
<meta charset="utf-8">
<title>Win98 font rendering comparison</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 24px; }
  .panels { display: grid; grid-template-columns: repeat(3, minmax(320px, 640px)); gap: 12px; }
  figure { margin: 0; }
  img { display: block; width: 100%; image-rendering: pixelated; border: 1px solid #777; background: white; }
  figcaption { margin: 0 0 6px; font-weight: 700; }
  .ours { color: #d700aa; } .reference { color: #0096dc; }
  table { border-collapse: collapse; margin-top: 20px; }
  th, td { border: 1px solid #888; padding: 5px 9px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
</style>
<h1>Win98 GDI font rendering comparison</h1>
<p>The identical probe executable rendered both images. Overlay: black = shared ink,
<span class="ours">magenta = wine-assembly only</span>,
<span class="reference">cyan = native Win98 only</span>.</p>
<div class="panels">
  <figure><figcaption>Wine-assembly</figcaption><img src="wine-assembly.png"></figure>
  <figure><figcaption>Native Win98 in v86</figcaption><img src="win98-v86.png"></figure>
  <figure><figcaption>Thresholded ink overlay</figcaption><img src="ink-overlay.png"></figure>
</div>
<p>Whole-image differing pixels: ${differingPixels.toLocaleString()} / ${pixelCount.toLocaleString()}
(${(report.wholeImage.differingFraction * 100).toFixed(2)}%). Weighted sample ink IoU:
${(report.sampleInkIoU * 100).toFixed(1)}%; baseline-aligned (≤1/6 em):
${(report.sampleAlignedInkIoU * 100).toFixed(1)}%.</p>
<table><thead><tr><th>Face</th><th>Request</th><th>Our ink</th><th>Win98 ink</th><th>Screen IoU</th><th>Baseline-aligned IoU (dx,dy; bound)</th></tr></thead>
<tbody>${rows}
</tbody></table>
`;
fs.writeFileSync(path.join(outputDir, "index.html"), html);

console.log(`Wrote ${path.join(outputDir, "index.html")}`);
console.log(`Whole-image differing pixels: ${differingPixels}/${pixelCount}`);
console.log(`Weighted sample ink IoU: ${(report.sampleInkIoU * 100).toFixed(1)}%`);
console.log(`Aligned sample ink IoU: ${(report.sampleAlignedInkIoU * 100).toFixed(1)}%`);
for (const cell of cells) {
  console.log(`${cell.face.padEnd(16)} ${String(cell.size).padStart(2)}px  ` +
    `ink ${String(cell.oursInk).padStart(4)}/${String(cell.referenceInk).padStart(4)}  ` +
    `IoU ${(cell.inkIoU * 100).toFixed(1).padStart(5)}%  ` +
    `aligned ${(cell.alignedInkIoU * 100).toFixed(1).padStart(5)}% ` +
    `(${cell.bestShift.x},${cell.bestShift.y})`);
}
