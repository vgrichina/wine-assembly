"use strict";

// Adapted from copy/v86 src/iso9660.js at f3d4472a9c934b9ad78a311f5849ba711a296d23.
// v86 is BSD-2-Clause licensed; see SOURCES.md.

const assert = require("node:assert/strict");

const BLOCK_SIZE = 2048;
const FILE_FLAGS_DIRECTORY = 1 << 1;

function generate(inputFiles) {
  const encoder = new TextEncoder();
  const date = new Date();
  const files = inputFiles.map(file => ({
    name: toDosFilename(file.name),
    contents: new Uint8Array(file.contents),
  }));

  let nextFileLba = 24;
  for (const file of files) {
    file.lba = nextFileLba;
    nextFileLba += blocksFor(file.contents.length);
  }

  const output = new Uint8Array(nextFileLba * BLOCK_SIZE);
  const cursor = { output, offset: 16 * BLOCK_SIZE };
  const write8 = value => { output[cursor.offset++] = value; };
  const writeLe16 = value => { write8(value); write8(value >> 8); };
  const writeBe16 = value => { write8(value >> 8); write8(value); };
  const writeLe32 = value => {
    write8(value); write8(value >> 8); write8(value >> 16); write8(value >> 24);
  };
  const writeBe32 = value => {
    write8(value >> 24); write8(value >> 16); write8(value >> 8); write8(value);
  };
  const writeBoth16 = value => { writeLe16(value); writeBe16(value); };
  const writeBoth32 = value => { writeLe32(value); writeBe32(value); };
  const skip = length => { cursor.offset += length; };
  const fill = (length, value) => {
    output.fill(value, cursor.offset, cursor.offset + length);
    cursor.offset += length;
  };
  const writeAscii = value => {
    cursor.offset += encoder.encodeInto(value, output.subarray(cursor.offset)).written;
  };
  const writePaddedAscii = (length, value) => writeAscii(value.padEnd(length));
  const writeCompactDate = () => {
    write8(date.getUTCFullYear() - 1900);
    write8(date.getUTCMonth() + 1);
    write8(date.getUTCDate());
    write8(date.getUTCHours());
    write8(date.getUTCMinutes());
    write8(date.getUTCSeconds());
    write8(0);
  };
  const writeRecord = (name, flags, special, lba, length) => {
    if (!special) name = `${sanitizeFilename(name)};1`;
    const start = cursor.offset;
    const nameOffset = 33;
    const nameLength = encoder.encodeInto(name, output.subarray(start + nameOffset)).written;
    const padding = (nameLength & 1) ? 0 : 1;
    const recordLength = nameOffset + nameLength + padding;
    assert(recordLength < 256);
    write8(recordLength);
    write8(0);
    writeBoth32(lba);
    writeBoth32(length);
    writeCompactDate();
    write8(flags);
    write8(0);
    write8(0);
    writeBoth16(1);
    write8(nameLength);
    skip(nameLength + padding);
    assert.equal(cursor.offset, start + recordLength);
  };
  const writeDirectory = (name, lba, length) =>
    writeRecord(name, FILE_FLAGS_DIRECTORY, true, lba, length);

  write8(1);
  writeAscii("CD001");
  write8(1);
  write8(0);
  writePaddedAscii(32, "V86");
  writePaddedAscii(32, "REFERENCE");
  skip(8);
  writeBoth32(nextFileLba);
  skip(32);
  writeBoth16(1);
  writeBoth16(1);
  writeBoth16(BLOCK_SIZE);
  writeBoth32(10);
  writeLe32(19);
  writeLe32(0);
  writeBe32(21);
  writeBe32(0);
  writeDirectory("\x00", 23, BLOCK_SIZE);
  fill(128 * 4 + 37 * 3, 0x20);
  for (let index = 0; index < 4; index++) {
    fill(16, 0x20);
    write8(0);
  }
  write8(1);
  write8(0);
  skip(512 + 653);

  assert.equal(cursor.offset, 17 * BLOCK_SIZE);
  write8(0xFF);
  writeAscii("CD001");
  write8(1);

  cursor.offset = 19 * BLOCK_SIZE;
  write8(1);
  write8(0);
  writeLe32(23);
  writeLe16(1);
  writeAscii("\x00");

  cursor.offset = 21 * BLOCK_SIZE;
  write8(1);
  write8(0);
  writeBe32(23);
  writeBe16(1);
  writeAscii("\x00");

  cursor.offset = 23 * BLOCK_SIZE;
  writeDirectory("\x00", 23, BLOCK_SIZE);
  writeDirectory("\x01", 23, BLOCK_SIZE);
  for (const file of files) {
    writeRecord(file.name, 0, false, file.lba, file.contents.length);
  }
  assert(cursor.offset < 24 * BLOCK_SIZE, "ISO root directory overflow");

  for (const file of files) {
    output.set(file.contents, file.lba * BLOCK_SIZE);
  }
  return Buffer.from(output.buffer);
}

function blocksFor(length) {
  return length ? Math.ceil(length / BLOCK_SIZE) : 0;
}

function toDosFilename(name) {
  const clean = name.toUpperCase().replace(/[^A-Z0-9_.]/g, "");
  const dot = clean.lastIndexOf(".");
  return dot === -1
    ? clean.slice(0, 8)
    : `${clean.slice(0, Math.min(8, dot))}.${clean.slice(dot + 1, dot + 4)}`;
}

function sanitizeFilename(name) {
  return toDosFilename(name);
}

module.exports = { generate, toDosFilename };
