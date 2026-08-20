#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const [, , nativeWin98Path, nativeOursPath, substituteWin98Path,
  substituteOursPath, outputDir] = process.argv;
if (!nativeWin98Path || !nativeOursPath || !substituteWin98Path ||
    !substituteOursPath || !outputDir) {
  console.error("usage: node tools/font-render-2x2.js NATIVE_WIN98.png " +
    "NATIVE_OURS.png SUBSTITUTE_WIN98.png SUBSTITUTE_OURS.png OUTPUT_DIR");
  process.exit(2);
}

const inputs = {
  nativeWin98: nativeWin98Path,
  nativeOurs: nativeOursPath,
  substituteWin98: substituteWin98Path,
  substituteOurs: substituteOursPath,
};
const images = Object.fromEntries(Object.entries(inputs).map(([key, filename]) =>
  [key, PNG.sync.read(fs.readFileSync(filename))]));
const first = images.nativeWin98;
for (const [key, image] of Object.entries(images)) {
  if (image.width !== first.width || image.height !== first.height)
    throw new Error(`${key} dimensions differ from nativeWin98`);
}

fs.mkdirSync(outputDir, { recursive: true });
for (const [key, filename] of Object.entries(inputs))
  fs.copyFileSync(filename, path.join(outputDir, `${key}.png`));

const montage = new PNG({ width: first.width * 2, height: first.height * 2 });
const panels = [
  [images.nativeWin98, 0, 0],
  [images.nativeOurs, first.width, 0],
  [images.substituteWin98, 0, first.height],
  [images.substituteOurs, first.width, first.height],
];
for (const [image, ox, oy] of panels) {
  for (let y = 0; y < image.height; y++) {
    const source = y * image.width * 4;
    const target = ((y + oy) * montage.width + ox) * 4;
    image.data.copy(montage.data, target, source, source + image.width * 4);
  }
}
fs.writeFileSync(path.join(outputDir, "four-way.png"), PNG.sync.write(montage));

const compareTool = path.join(__dirname, "font-render-compare.js");
function compare(name, ours, reference) {
  const directory = path.join(outputDir, name);
  const result = childProcess.spawnSync(process.execPath,
    [compareTool, ours, reference, directory], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${name} comparison failed:\n${result.stdout}${result.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(directory, "report.json"), "utf8"));
}

const comparisons = {
  nativeRendererDelta: compare("native-renderers", nativeOursPath, nativeWin98Path),
  substituteRendererDelta: compare("substitute-renderers", substituteOursPath, substituteWin98Path),
  win98FontDelta: compare("win98-fonts", substituteWin98Path, nativeWin98Path),
  oursFontDelta: compare("wine-assembly-fonts", substituteOursPath, nativeOursPath),
};

function digest(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}
function percent(value) { return `${(value * 100).toFixed(1)}%`; }
function summary(report) {
  const scalable = report.cells.filter(cell => cell.face !== "MS Sans Serif");
  const scalableAlignedIntersection = scalable.reduce(
    (sum, cell) => sum + cell.alignedIntersection, 0);
  const scalableAlignedUnion = scalable.reduce((sum, cell) => sum + cell.alignedUnion, 0);
  return {
    differingPixels: report.wholeImage.differingPixels,
    differingFraction: report.wholeImage.differingFraction,
    sampleInkIoU: report.sampleInkIoU,
    sampleAlignedInkIoU: report.sampleAlignedInkIoU,
    scalableThreeAlignedInkIoU: Number(
      (scalableAlignedIntersection / scalableAlignedUnion).toFixed(4)),
  };
}

const report = {
  schemaVersion: 1,
  experiment: "font bytes x GDI renderer",
  inputs: Object.fromEntries(Object.entries(inputs).map(([key, filename]) =>
    [key, { sha256: digest(filename), source: path.resolve(filename) }])),
  comparisons: Object.fromEntries(Object.entries(comparisons).map(([key, value]) =>
    [key, summary(value)])),
  caveats: [
    "Native Microsoft font binaries and generated captures remain local and uncommitted.",
    "The fourth substitute column repeats Liberation Sans for the Microsoft Sans outline alias.",
    "Aligned ink IoU permits a size-relative baseline translation of at most one-sixth em and measures glyph occupancy, not grayscale intensity.",
  ],
};
fs.writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const metricRows = [
  ["Same native bytes: our renderer vs Win98", "nativeRendererDelta", "native-renderers/index.html"],
  ["Same substitute bytes: our renderer vs Win98", "substituteRendererDelta", "substitute-renderers/index.html"],
  ["Win98 renderer: substitutes vs native fonts", "win98FontDelta", "win98-fonts/index.html"],
  ["Our renderer: substitutes vs native fonts", "oursFontDelta", "wine-assembly-fonts/index.html"],
].map(([label, key, href]) => {
  const value = report.comparisons[key];
  return `<tr><td><a href="${href}">${label}</a></td>` +
    `<td>${value.differingPixels.toLocaleString()}</td>` +
    `<td>${percent(value.differingFraction)}</td>` +
    `<td>${percent(value.sampleInkIoU)}</td>` +
    `<td>${percent(value.sampleAlignedInkIoU)}</td>` +
    `<td>${percent(value.scalableThreeAlignedInkIoU)}</td></tr>`;
}).join("\n");

const html = `<!doctype html>
<meta charset="utf-8">
<title>Win98 font bytes × renderer experiment</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 24px; max-width: 1400px; }
  .matrix { display: grid; grid-template-columns: 150px repeat(2, minmax(320px, 640px)); gap: 10px; align-items: start; }
  .axis { font-weight: 700; align-self: center; }
  figure { margin: 0; } figcaption { font-weight: 700; margin-bottom: 5px; }
  img { width: 100%; display: block; image-rendering: pixelated; border: 1px solid #777; background: white; }
  table { border-collapse: collapse; margin-top: 24px; }
  th, td { border: 1px solid #888; padding: 6px 9px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  code { font-size: 0.9em; }
</style>
<h1>Win98 font bytes × GDI renderer</h1>
<p>Each row holds font bytes constant; each column changes only the renderer.
The native Microsoft files were copied locally from the same Win98 VM and are not committed.</p>
<div class="matrix">
  <div></div><div class="axis">Native Win98 / v86 renderer</div><div class="axis">Wine-assembly renderer</div>
  <div class="axis">Native Win98 font bytes</div>
  <figure><img src="nativeWin98.png"><figcaption>Gold reference</figcaption></figure>
  <figure><img src="nativeOurs.png"><figcaption>Rasterizer isolation</figcaption></figure>
  <div class="axis">Open substitute font bytes</div>
  <figure><img src="substituteWin98.png"><figcaption>Substitutes inside real Win98</figcaption></figure>
  <figure><img src="substituteOurs.png"><figcaption>Current shipped scalable path</figcaption></figure>
</div>
<table><thead><tr><th>Comparison</th><th>Different pixels</th><th>Screen</th><th>Ink IoU</th><th>Aligned ≤1/6 em</th><th>Scalable three aligned</th></tr></thead>
<tbody>${metricRows}</tbody></table>
<p>The substitute subsets deliberately contain no TrueType bytecode. Their high aligned overlap therefore measures the two outline scan converters directly. The native files retain Win98 hinting programs; Win98 executes them and wine-assembly currently does not.</p>
<p>The fourth substitute column repeats Liberation Sans for the manifest's Microsoft Sans outline alias. The separately visible MS Sans Serif bitmap-strike mismatch remains a font-selection issue.</p>
`;
fs.writeFileSync(path.join(outputDir, "index.html"), html);

console.log(`Wrote ${path.join(outputDir, "index.html")}`);
for (const [key, value] of Object.entries(report.comparisons))
  console.log(`${key.padEnd(24)} diff ${percent(value.differingFraction).padStart(6)}  ` +
    `aligned ${percent(value.sampleAlignedInkIoU).padStart(6)}`);
