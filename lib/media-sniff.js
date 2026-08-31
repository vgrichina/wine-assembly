// What did the visitor just drop on the desktop?
//
// The import flow starts here, and it is deliberately the dullest file in the
// feature: a pure function over bytes, no DOM, no async, no I/O. Everything
// else in phase ④ (docs/design-byo-media.md) branches on what this returns, so
// it is the one piece that can be tested without a browser at all —
// test/test-media-sniff.js runs it in node.
//
// Why magic bytes and not the file name: the extension is whatever the visitor
// last renamed it to. A CD image arrives as .iso, .ISO, .bin, .img, or with no
// extension at all after a trip through iCloud; a shareware download is .zip
// today and was .ZIP with a DOS name before that. The bytes do not lie, and
// every container we accept is identified by a fixed signature at a fixed
// offset:
//
//   ISO 9660   "CD001" at 0x8001   the primary volume descriptor's identifier.
//                                  0x8000 is sector 16 (16 * 2048), where the
//                                  volume-descriptor *sequence* starts; byte 0
//                                  of the sector is the descriptor type, so the
//                                  identifier begins one byte in. A boot record
//                                  may occupy sector 16 instead of the PVD, but
//                                  every descriptor in the sequence carries the
//                                  same "CD001", so the tag holds either way.
//   ZIP        "PK\x03\x04"        a local file header: any archive with at
//                                  least one member starts with one.
//              "PK\x05\x06"        an end-of-central-directory record with
//                                  nothing before it: the empty archive.
//   PE/MZ      "MZ"                the DOS stub every Windows executable still
//                                  carries. Says nothing about 16 vs 32 bit —
//                                  the PE loader decides that later.
//
// Order matters. An ISO's first bytes are the reserved system area, usually
// zeros but free to hold anything at all — including a boot sector that starts
// with "MZ" — so the ISO tag is tested first and wins. A zip's signature is at
// offset 0, where an ISO has its reserved area, so those two cannot collide.
//
// The NSIS hint is advisory and changes no behavior: an installer is still a
// bare exe to us. It exists so the dialog can say "looks like an installer"
// instead of pretending every MZ is a game.

(function () {
  'use strict';

  // Where the volume descriptor sequence's identifier sits.
  const ISO_TAG_OFFSET = 0x8001;
  const ISO_TAG = 'CD001';
  // Enough of the head to hold the ISO tag, so one read answers everything.
  const HEAD_BYTES = ISO_TAG_OFFSET + ISO_TAG.length;

  function ascii(bytes, offset, length) {
    if (!bytes || bytes.length < offset + length) return null;
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
    return out;
  }

  function startsWith(bytes, sig) {
    if (!bytes || bytes.length < sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
    return true;
  }

  // NSIS puts "NullsoftInst" in its first data block, well past the PE header
  // but comfortably inside the first 64KB of every build we have. Absence
  // proves nothing (a compressed or unusual build can hide it), which is why
  // this only ever decorates the label.
  function looksLikeNsis(bytes) {
    if (!bytes) return false;
    const needle = 'NullsoftInst';
    const limit = Math.min(bytes.length, 0x10000);
    for (let i = 0; i + needle.length <= limit; i++) {
      if (bytes[i] !== 0x4E /* N */) continue;
      let hit = true;
      for (let j = 1; j < needle.length; j++) {
        if (bytes[i + j] !== needle.charCodeAt(j)) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  }

  // The whole decision, over as many leading bytes as the caller could get.
  //
  //   bytes  a Uint8Array of the file's head. Anything shorter than
  //          HEAD_BYTES simply cannot answer the ISO question, and says so
  //          rather than guessing.
  //   opts   { name, size } — used only for the human-readable label.
  //
  // Returns { kind, label, flavor, isoTagVisible }:
  //   kind          'iso' | 'zip' | 'exe' | 'unknown'
  //   label         a short description for the insert dialog
  //   flavor        'nsis' for an MZ that smells like an installer, else null
  //   isoTagVisible false when the head was too short to check 0x8001, so a
  //                 caller can tell "not an ISO" from "could not look"
  function sniffBytes(bytes, opts) {
    const options = opts || {};
    const head = bytes || new Uint8Array(0);
    const isoTagVisible = head.length >= HEAD_BYTES;

    if (isoTagVisible && ascii(head, ISO_TAG_OFFSET, ISO_TAG.length) === ISO_TAG) {
      return { kind: 'iso', label: 'ISO 9660 CD image', flavor: null, isoTagVisible };
    }
    if (startsWith(head, [0x50, 0x4B, 0x03, 0x04]) ||
        startsWith(head, [0x50, 0x4B, 0x05, 0x06])) {
      const empty = startsWith(head, [0x50, 0x4B, 0x05, 0x06]);
      return {
        kind: 'zip',
        label: empty ? 'ZIP archive (empty)' : 'ZIP archive',
        flavor: null,
        isoTagVisible,
      };
    }
    if (startsWith(head, [0x4D, 0x5A])) {
      const nsis = looksLikeNsis(head);
      return {
        kind: 'exe',
        label: nsis ? 'Windows program (looks like an installer)' : 'Windows program',
        flavor: nsis ? 'nsis' : null,
        isoTagVisible,
      };
    }
    return {
      kind: 'unknown',
      label: options.name ? `unrecognized file (${options.name})` : 'unrecognized file',
      flavor: null,
      isoTagVisible,
    };
  }

  // Same answer, from anything that can hand over its first bytes: a File/Blob,
  // a byte provider (lib/byte-provider.js), or a Uint8Array we already hold.
  // Reads exactly one head — an ISO's tag is 32KB in, and reading 32KB of a
  // 600MB File is free, so there is never a reason to read twice.
  async function sniffSource(source, opts) {
    const options = opts || {};
    if (source instanceof Uint8Array) return sniffBytes(source, options);
    let head = null;
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      const want = Math.min(source.size, HEAD_BYTES);
      head = new Uint8Array(await source.slice(0, want).arrayBuffer());
    } else if (source && typeof source.readRange === 'function') {
      const want = Math.min(source.size === undefined ? HEAD_BYTES : source.size, HEAD_BYTES);
      head = new Uint8Array(await source.readRange(0, want));
    } else {
      throw new Error('sniffSource: not a Blob, a byte provider, or a Uint8Array');
    }
    return sniffBytes(head, options);
  }

  // "638 MB", the way the insert dialog says it. Decimal units, because that is
  // what every disc and download was ever labelled with.
  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1000) return `${n} bytes`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = n / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  const api = {
    ISO_TAG_OFFSET,
    ISO_TAG,
    HEAD_BYTES,
    sniffBytes,
    sniffSource,
    humanSize,
    looksLikeNsis,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.mediaSniff = api;
})();
