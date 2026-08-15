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
assert.equal(workflow.postLaunch.length, 22);
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

assert.equal(clicks, 13, "workflow should select tools/options and park the cursor off the final stroke");
assert.equal(drags, 9, "workflow should draw four freehand endpoint masks and five line widths");
assert(captureSource.includes("moveGuestMouse(page, mouse.x, mouse.y)"));
assert(captureSource.includes("setGuestMouseButton(page, button, true)"));
assert(captureSource.includes("setGuestMouseButton(page, button, false)"));
assert(captureSource.includes('window.emulator.bus.send("mouse-delta"'));
assert(captureSource.includes('window.emulator.bus.send("mouse-click"'));
assert(captureSource.includes("await pause(2)"));
assert(!captureSource.includes("page.mouse.move(639, 479)"),
  "browser-edge synchronization is timing-dependent after restored-state startup");
assert(sources.includes("--manifest tools/v86-reference/paint-apps.json"));

console.log("PASS  v86 Paint workflow covers brush, airbrush, and five line widths");
console.log("PASS  v86 mouse capture synchronizes relative guest pointer coordinates");
