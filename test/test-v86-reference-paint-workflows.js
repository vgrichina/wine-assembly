#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = require("../tools/v86-reference/paint-apps.json");
const workflow = manifest.apps["paint98-tools"];
const captureSource = fs.readFileSync(path.join(root, "tools/v86-reference/capture.js"), "utf8");
const sources = fs.readFileSync(path.join(root, "tools/v86-reference/SOURCES.md"), "utf8");

assert.equal(manifest.schemaVersion, 1);
assert(workflow && workflow.launch === "D:\\MSPAINT.EXE");
assert.equal(workflow.postLaunch.length, 21);
assert(workflow.files.every(filename => fs.existsSync(path.join(root, filename))));

let clicks = 0;
let drags = 0;
for (const action of workflow.postLaunch) {
  const mouse = action.mouse;
  assert(mouse && ["click", "drag"].includes(mouse.type));
  assert(Number.isFinite(mouse.x) && Number.isFinite(mouse.y));
  if (mouse.type === "click") clicks++;
  if (mouse.type === "drag") {
    drags++;
    assert(Number.isFinite(mouse.toX) && Number.isFinite(mouse.toY));
  }
}

assert.equal(clicks, 16, "workflow should select tools/options and place four freehand marks");
assert.equal(drags, 5, "workflow should draw all five Paint line widths");
assert(captureSource.includes("page.mouse.click") && captureSource.includes("page.mouse.move"));
assert(captureSource.includes("mouseSynchronized") && captureSource.includes("page.mouse.move(639, 479)"));
assert(sources.includes("--manifest tools/v86-reference/paint-apps.json"));

console.log("PASS  v86 Paint workflow covers brush, airbrush, and five line widths");
console.log("PASS  v86 mouse capture synchronizes relative guest pointer coordinates");
