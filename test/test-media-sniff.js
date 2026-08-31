#!/usr/bin/env node
// The import flow's first decision, tested without a browser.
//
// lib/media-sniff.js is pure so that this test can exist: everything the drop
// handler does afterwards — which container to mount, which dialog to show,
// which drive letter to use — hangs off `kind`, and getting it wrong is a
// silent misroute (an ISO parsed as a zip fails with a confusing zip error,
// not with "that is not a zip").
//
// The interesting cases are all about *where* the signature is, not what it
// says: an ISO's tag is 32KB in, so a short read cannot see it, and a caller
// must be able to tell "not an ISO" from "could not look". A file that is both
// plausibly-MZ at 0 and CD001 at 0x8001 is an ISO with a bootable system area,
// and the order of the checks is the only thing that decides that correctly.

'use strict';

const assert = require('assert');
const { sniffBytes, humanSize, ISO_TAG_OFFSET, HEAD_BYTES } = require('../lib/media-sniff');

function bytesOf(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

// A head long enough to hold the ISO tag, with `lead` at offset 0 and
// optionally "CD001" at 0x8001 — the two positions that decide everything.
function makeHead({ lead = '', iso = false, extra = null } = {}) {
  const head = new Uint8Array(HEAD_BYTES + 16);
  head.set(bytesOf(lead), 0);
  if (iso) head.set(bytesOf('CD001'), ISO_TAG_OFFSET);
  if (extra) head.set(bytesOf(extra.text), extra.at);
  return head;
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

check('an ISO is recognized by CD001 at 0x8001', () => {
  const r = sniffBytes(makeHead({ iso: true }));
  assert.strictEqual(r.kind, 'iso');
  assert.strictEqual(r.isoTagVisible, true);
});

check('the ISO tag one byte off is not an ISO', () => {
  // 0x8000 is the descriptor *type* byte; CD001 starts at 0x8001. A parser
  // that scanned for the string anywhere in the sector would accept this.
  const head = new Uint8Array(HEAD_BYTES + 16);
  head.set(bytesOf('CD001'), ISO_TAG_OFFSET - 1);
  assert.strictEqual(sniffBytes(head).kind, 'unknown');
});

check('an ISO whose system area starts with MZ is still an ISO', () => {
  // The reserved area at offset 0 can hold a boot image. ISO is tested first
  // precisely so this cannot be misread as a bare executable.
  const r = sniffBytes(makeHead({ lead: 'MZ\x90\x00', iso: true }));
  assert.strictEqual(r.kind, 'iso');
});

check('a zip is recognized by its local file header', () => {
  const r = sniffBytes(bytesOf('PK\x03\x04rest of an archive'));
  assert.strictEqual(r.kind, 'zip');
  assert.strictEqual(r.label, 'ZIP archive');
});

check('an empty zip is a zip, and says so', () => {
  const r = sniffBytes(bytesOf('PK\x05\x06' + '\0'.repeat(18)));
  assert.strictEqual(r.kind, 'zip');
  assert.match(r.label, /empty/);
});

check('a spanned-archive marker is not accepted as a zip', () => {
  // PK\x07\x08 is a data descriptor / spanned marker, not a mountable archive
  // start. Accepting it would hand zip-mount a stream it cannot parse.
  assert.strictEqual(sniffBytes(bytesOf('PK\x07\x08junk')).kind, 'unknown');
});

check('an MZ is an executable', () => {
  const r = sniffBytes(bytesOf('MZ\x90\x00\x03\x00\x00\x00'));
  assert.strictEqual(r.kind, 'exe');
  assert.strictEqual(r.flavor, null);
});

check('an NSIS installer is flagged, but is still an exe', () => {
  const r = sniffBytes(makeHead({ lead: 'MZ\x90\x00', extra: { text: 'NullsoftInst', at: 0x400 } }));
  assert.strictEqual(r.kind, 'exe');
  assert.strictEqual(r.flavor, 'nsis');
  assert.match(r.label, /installer/);
});

check('a short head cannot see the ISO tag and admits it', () => {
  // The distinction the import flow needs: a 4KB read that found no zip and no
  // MZ has NOT ruled out an ISO, and must go back for more bytes rather than
  // report "unrecognized".
  const r = sniffBytes(new Uint8Array(4096));
  assert.strictEqual(r.kind, 'unknown');
  assert.strictEqual(r.isoTagVisible, false);
});

check('a full-length head that is none of them rules the ISO out for real', () => {
  const r = sniffBytes(makeHead({ lead: 'RIFF' }));
  assert.strictEqual(r.kind, 'unknown');
  assert.strictEqual(r.isoTagVisible, true);
});

check('empty input does not throw', () => {
  assert.strictEqual(sniffBytes(new Uint8Array(0)).kind, 'unknown');
  assert.strictEqual(sniffBytes(null).kind, 'unknown');
});

check('sizes read the way a disc was labelled', () => {
  assert.strictEqual(humanSize(0), '0 bytes');
  assert.strictEqual(humanSize(999), '999 bytes');
  assert.strictEqual(humanSize(1500), '1.5 KB');
  assert.strictEqual(humanSize(638 * 1000 * 1000), '638 MB');
});

if (failures) {
  console.log(`FAIL  media sniff: ${failures} case(s)`);
  process.exit(1);
}
console.log('PASS  media sniff: magic bytes decide the container, at the right offsets');
