#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [, , input, outputDir] = process.argv;
if (!input || !outputDir) {
  console.error("usage: node tools/v86-reference/extract-font-dump.js SERIAL.bin OUTPUT_DIR");
  process.exit(2);
}

const data = fs.readFileSync(input);
const begin = Buffer.from("FONT_FILE_DUMP_V1\r\n", "ascii");
let cursor = data.indexOf(begin);
if (cursor < 0) throw new Error("font dump marker not found");
cursor += begin.length;
fs.mkdirSync(outputDir, { recursive: true });

const allowed = new Set(["ARIAL.TTF", "TIMES.TTF", "COUR.TTF", "SSERIFE.FON"]);
const extracted = [];
while (cursor < data.length) {
  const lineEnd = data.indexOf(Buffer.from("\r\n"), cursor);
  if (lineEnd < 0) throw new Error("truncated font dump header");
  const line = data.subarray(cursor, lineEnd).toString("ascii");
  cursor = lineEnd + 2;
  if (line === "FONT_FILE_DUMP_DONE") break;
  if (line.startsWith("MISSING ")) throw new Error(`Win98 font unavailable: ${line.slice(8)}`);
  const match = /^FILE ([A-Z0-9.]+) ([0-9]+)$/.exec(line);
  if (!match) throw new Error(`unexpected font dump record: ${JSON.stringify(line)}`);
  const [, name, sizeText] = match;
  if (!allowed.has(name)) throw new Error(`refusing unexpected output filename: ${name}`);
  const size = Number(sizeText);
  const end = cursor + size;
  if (!Number.isSafeInteger(size) || size <= 0 || end > data.length)
    throw new Error(`invalid ${name} byte count: ${sizeText}`);
  const bytes = data.subarray(cursor, end);
  cursor = end;
  const trailer = Buffer.from("\r\nEND_FILE\r\n", "ascii");
  if (!data.subarray(cursor, cursor + trailer.length).equals(trailer))
    throw new Error(`bad ${name} trailer`);
  cursor += trailer.length;
  if (name.endsWith(".TTF") && bytes.readUInt32BE(0) !== 0x00010000)
    throw new Error(`${name} is not a TrueType sfnt`);
  if (name.endsWith(".FON") && bytes.subarray(0, 2).toString("ascii") !== "MZ")
    throw new Error(`${name} is not an NE font library`);
  const destination = path.join(outputDir, name.toLowerCase());
  fs.writeFileSync(destination, bytes);
  extracted.push({
    name,
    bytes: size,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
}

if (extracted.length !== allowed.size)
  throw new Error(`expected ${allowed.size} fonts, extracted ${extracted.length}`);
fs.writeFileSync(path.join(outputDir, "metadata.json"), `${JSON.stringify({
  schemaVersion: 1,
  source: "user's local Windows 98 v86 image via COM1",
  redistribution: "Do not commit extracted Microsoft font binaries",
  fonts: extracted,
}, null, 2)}\n`);
for (const font of extracted)
  console.log(`${font.name.padEnd(12)} ${String(font.bytes).padStart(7)}  ${font.sha256}`);
