#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { generate } = require("../tools/v86-reference/iso9660");
const manifest = require("../tools/v86-reference/apps.json");
const packageJson = require("../package.json");

const root = path.resolve(__dirname, "..");
const harnessRoot = path.join(root, "tools/v86-reference");
const forbiddenExtensions = new Set([".bin", ".exe", ".img", ".iso", ".wasm", ".zst"]);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(filename) : [filename];
  });
}

for (const filename of walk(harnessRoot)) {
  assert(!forbiddenExtensions.has(path.extname(filename).toLowerCase()), `binary checked into harness: ${filename}`);
}

assert.equal(packageJson.devDependencies.v86, "0.5.432");
assert.equal(packageJson.devDependencies.puppeteer, "25.7.0");
assert.equal(manifest.schemaVersion, 1);
assert(Object.keys(manifest.apps).length >= 15, "expected the tracked desktop app set");

for (const [id, app] of Object.entries(manifest.apps)) {
  assert(app.title && app.launch, `${id} needs title and launch`);
  if (app.skip) assert.equal(typeof app.skip, "string", `${id} skip reason must be text`);
  for (const action of app.postLaunch || []) {
    assert(Array.isArray(action.scancodes), `${id} post-launch action needs scancodes`);
  }
  if (app.probeSource) assert(fs.existsSync(path.join(root, app.probeSource)), `${id} probe source is missing`);
  for (const specification of app.files) {
    const relative = typeof specification === "string" ? specification : specification.path;
    assert(fs.existsSync(path.join(root, relative)), `${id} payload is missing: ${relative}`);
  }
}

const iso = generate([
  { name: "PROBE.EXE", contents: Buffer.from("probe") },
  { name: "WINMINE.EXE", contents: Buffer.from("mine") },
]);
assert.equal(iso.subarray(16 * 2048 + 1, 16 * 2048 + 6).toString("ascii"), "CD001");
assert.equal(iso.subarray(17 * 2048 + 1, 17 * 2048 + 6).toString("ascii"), "CD001");
assert(iso.includes(Buffer.from("PROBE.EXE;1")));
assert(iso.includes(Buffer.from("WINMINE.EXE;1")));

const sources = fs.readFileSync(path.join(harnessRoot, "SOURCES.md"), "utf8");
for (const required of [
  "f3d4472a9c934b9ad78a311f5849ba711a296d23",
  "0.5.432+gf3d4472",
  "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98",
  "a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880",
  "windows98_state-v2.bin.zst",
]) {
  assert(sources.includes(required), `SOURCES.md is missing ${required}`);
}

console.log(`v86 reference harness: ${Object.keys(manifest.apps).length} apps, source-only invariant PASS`);
