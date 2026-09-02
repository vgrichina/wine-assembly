// Read-only ZIP mount — phase 2 of docs/design-byo-media.md.
//
// A zip is read tail-first: the End Of Central Directory record is the last
// structure in the file, and it points at the central directory, which is the
// whole catalog (names, sizes, methods, offsets). Two reads mount an archive —
// the tail, then the directory it names — and entry bytes are only touched
// when the guest opens the file. The directory usually lands inside the tail
// read, which makes it one read, but that is an optimization and not the
// contract: a big archive's directory sits far outside the tail window.
//
// Sources are either a plain `Uint8Array` (everything already in memory — the
// CLI case and today's browser fetch) or a byte provider exposing
// `{ size, readRange(off, len) }`, the interface docs/design-byo-media.md
// defines for File slices, HTTP Range reads and OPFS handles.
//
// Compression: methods 0 (stored) and 8 (deflate) only. Anything else throws —
// guessing at an unknown method would hand the guest silent garbage.
//
// **An archive is untrusted input**, so this refuses rather than copes:
// Zip64 sentinels, encrypted or otherwise unreadable general-purpose flags, a
// CRC that does not match what inflated, an entry that inflates past its own
// declared size or past the materialization budget, and any name that could
// escape the mount root (`..`, a drive letter, UNC, a DOS device name) or
// collide with another entry after Win32 case-folding.
//
// Dual-environment like lib/vfs-persistence.js: Node gets
// `zlib.inflateRawSync`, the browser gets `DecompressionStream('deflate-raw')`.

(function () {
  const SIG_EOCD = 0x06054b50;
  const SIG_CD = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;
  // 22-byte EOCD + a comment field whose length is 16 bits. Not "64KB": the
  // extra 21 bytes are exactly what an archive with a maximal comment needs.
  const EOCD_MAX = 22 + 0xFFFF;
  const ZIP64_U32 = 0xFFFFFFFF;
  const ZIP64_U16 = 0xFFFF;
  const METHOD_STORED = 0;
  const METHOD_DEFLATE = 8;
  const FLAG_ENCRYPTED = 0x0001;
  const FLAG_PATCHED = 0x0020;        // compressed patched data
  const FLAG_STRONG_ENCRYPTION = 0x0040;
  const FLAG_UTF8 = 0x0800;
  // Bit 13 masks the local header's name/sizes; the catalog is then the only
  // copy, and a local-header read cannot be trusted to find the payload.
  const FLAG_MASKED_LOCAL = 0x2000;
  const EXTRA_UNICODE_PATH = 0x7075;  // Info-ZIP Unicode Path
  const FILETIME_UNIX_EPOCH = 116444736000000000n;

  // Zip-bomb guards. Nothing is allocated before these are checked: a declared
  // size over the per-entry cap is refused from the catalog alone, and the
  // inflater is given a hard output ceiling so a lying header cannot turn into
  // an OOM that reads as an emulator crash.
  const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
  const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

  // Win32 reserves these names in every directory, with or without an
  // extension: an entry called `CON.txt` is not a file the guest can open.
  const DOS_DEVICES = new Set([
    'con', 'prn', 'aux', 'nul', 'clock$',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  ]);

  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  const nodeZlib = isNode && typeof require === 'function' ? require('zlib') : null;

  // CP437 high half. The zip spec's default name encoding predates Unicode;
  // without this, an accented DOS filename decodes to the wrong glyph and the
  // guest never finds the file it was told about.
  const CP437_HIGH =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
    'áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
    'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0';

  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
    return CRC_TABLE;
  }

  function crc32(bytes) {
    const table = crcTable();
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function u16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
  function u32(buf, off) {
    return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
  }

  // Only some producers set the UTF-8 flag; macOS Info-ZIP writes UTF-8 name
  // bytes without it. Well-formed UTF-8 with a high byte in it is not a
  // plausible CP437 name, so validating strictly (not guessing) and preferring
  // UTF-8 when it holds is the difference between "lisämäärä.txt" and mojibake
  // the guest can never open.
  function looksUtf8(bytes) {
    let sawHigh = false;
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i];
      let need;
      if (b < 0x80) { i++; continue; }
      sawHigh = true;
      if (b >= 0xC2 && b <= 0xDF) need = 1;
      else if (b >= 0xE0 && b <= 0xEF) need = 2;
      else if (b >= 0xF0 && b <= 0xF4) need = 3;
      else return false;
      if (i + need > bytes.length - 1) return false;
      for (let k = 1; k <= need; k++) {
        const c = bytes[i + k];
        if (c < 0x80 || c > 0xBF) return false;
      }
      i += need + 1;
    }
    return sawHigh;
  }

  function decodeName(bytes, utf8) {
    if (!utf8 && looksUtf8(bytes)) utf8 = true;
    if (utf8) {
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8').decode(bytes);
      }
      return Buffer.from(bytes).toString('utf8');
    }
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
    }
    return out;
  }

  // MS-DOS date/time (the only timestamp every zip carries) -> Win32 FILETIME
  // halves, the shape lib/filesystem.js stores. DOS time is local time with
  // 2-second resolution and no zone, so it is interpreted as local time here,
  // exactly as Windows does when extracting.
  function dosTimeToFileTime(dosTime, dosDate) {
    const year = 1980 + ((dosDate >> 9) & 0x7F);
    const month = ((dosDate >> 5) & 0x0F) || 1;
    const day = (dosDate & 0x1F) || 1;
    const hour = (dosTime >> 11) & 0x1F;
    const minute = (dosTime >> 5) & 0x3F;
    const second = (dosTime & 0x1F) * 2;
    const ms = new Date(year, month - 1, day, hour, minute, second, 0).getTime();
    const ticks = FILETIME_UNIX_EPOCH + BigInt(Number.isFinite(ms) ? ms : 0) * 10000n;
    return { lo: Number(ticks & 0xFFFFFFFFn) >>> 0, hi: Number(ticks >> 32n) >>> 0 };
  }

  function methodName(method) {
    if (method === METHOD_STORED) return 'stored';
    if (method === METHOD_DEFLATE) return 'deflate';
    return `method ${method}`;
  }

  function assertSupported(entry, options) {
    if (entry.flags & FLAG_ENCRYPTED) {
      throw new Error(`encrypted zip entry is not supported: ${entry.name}`);
    }
    if (entry.flags & FLAG_STRONG_ENCRYPTION) {
      throw new Error(`strongly encrypted zip entry is not supported: ${entry.name}`);
    }
    if (entry.flags & FLAG_MASKED_LOCAL) {
      throw new Error(
        `zip entry ${entry.name} masks its local header (general-purpose bit 13), ` +
        `which this reader cannot follow`);
    }
    if (entry.flags & FLAG_PATCHED) {
      throw new Error(`patched zip entry is not supported: ${entry.name}`);
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      throw new Error(
        `unsupported compression method ${entry.method} in zip entry ${entry.name} ` +
        `(only 0=stored and 8=deflate are supported)`);
    }
    const cap = (options && options.maxEntryBytes) || DEFAULT_MAX_ENTRY_BYTES;
    if (entry.uncompressedSize > cap) {
      throw new Error(
        `zip entry ${entry.name} declares ${entry.uncompressedSize} bytes, over the ` +
        `${cap}-byte per-entry limit (pass maxEntryBytes to raise it)`);
    }
  }

  // ---------------------------------------------------------------- readers

  function bytesSource(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return {
      size: u8.length,
      sync: true,
      read(off, len) {
        if (off < 0 || off + len > u8.length) {
          throw new Error(`zip read out of range: ${off}+${len} of ${u8.length}`);
        }
        return u8.subarray(off, off + len);
      },
    };
  }

  function providerSource(provider) {
    if (!provider || typeof provider.readRange !== 'function') {
      throw new Error('zip source must be bytes or a provider with readRange(off, len)');
    }
    const size = provider.size;
    if (!Number.isFinite(size)) throw new Error('zip byte provider must expose a numeric size');
    return {
      size,
      sync: false,
      async read(off, len) {
        const chunk = await provider.readRange(off, len);
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (u8.length < len) throw new Error(`short zip read at ${off}: want ${len}, got ${u8.length}`);
        return u8;
      },
    };
  }

  function toSource(source) {
    if (!source) throw new Error('zip source is required');
    if (source.sync !== undefined && typeof source.read === 'function') return source;
    if (source instanceof Uint8Array || source instanceof ArrayBuffer) return bytesSource(source);
    if (typeof source.readRange === 'function') return providerSource(source);
    throw new Error('zip source must be a Uint8Array/ArrayBuffer or a byte provider');
  }

  // ------------------------------------------------------------ cd parsing

  function findEocd(tail, tailStart) {
    for (let i = tail.length - 22; i >= 0; i--) {
      if (u32(tail, i) !== SIG_EOCD) continue;
      const commentLen = u16(tail, i + 20);
      if (i + 22 + commentLen !== tail.length) continue;
      const diskEntries = u16(tail, i + 8);
      const count = u16(tail, i + 10);
      const cdSize = u32(tail, i + 12);
      const cdOffset = u32(tail, i + 16);
      // Any sentinel means the real value lives in a Zip64 record. So does a
      // Zip64 EOCD locator sitting just in front of this record.
      if (count === ZIP64_U16 || diskEntries === ZIP64_U16 ||
          cdSize === ZIP64_U32 || cdOffset === ZIP64_U32 ||
          (i >= 20 && u32(tail, i - 20) === 0x07064b50)) {
        throw new Error('Zip64 unsupported: this archive uses Zip64 records');
      }
      if (cdOffset + cdSize > tailStart + tail.length) {
        throw new Error('corrupt zip: the central directory runs past the end of the file');
      }
      return { count, cdSize, cdOffset, eocdAt: tailStart + i };
    }
    throw new Error('not a zip archive: no end-of-central-directory record in the last 64KB');
  }

  // Walk the extra-field blocks (id, len, payload). Two things live there that
  // matter: the Zip64 extended-information block, whose presence means the
  // 32-bit fields are placeholders, and the Info-ZIP Unicode Path block, which
  // is the only correct name when a producer wrote UTF-8 without setting the
  // UTF-8 flag.
  function eachExtraBlock(extra, visit) {
    let p = 0;
    while (p + 4 <= extra.length) {
      const id = u16(extra, p);
      const len = u16(extra, p + 2);
      if (p + 4 + len > extra.length) return;   // malformed tail: stop, don't guess
      visit(id, extra.subarray(p + 4, p + 4 + len));
      p += 4 + len;
    }
  }

  function assertNoZip64Extra(extra, index) {
    let found = false;
    eachExtraBlock(extra, id => { if (id === 0x0001) found = true; });
    if (found) throw new Error(`Zip64 unsupported: entry ${index} carries a Zip64 extra field`);
  }

  // The Unicode Path block carries a CRC of the *original* name bytes so a
  // reader can tell whether the pair still belongs together after an archive
  // was edited. A mismatch means the block is stale, and the header name wins.
  function unicodePathFromExtra(extra, nameBytes) {
    let name = null;
    eachExtraBlock(extra, (id, payload) => {
      if (id !== EXTRA_UNICODE_PATH || payload.length < 5) return;
      if (payload[0] !== 1) return;
      if (u32(payload, 1) !== crc32(nameBytes)) return;
      name = decodeName(payload.subarray(5), true);
    });
    return name;
  }

  function parseCentralDirectory(cd, count) {
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length) throw new Error('truncated zip central directory');
      if (u32(cd, p) !== SIG_CD) {
        throw new Error(`bad zip central directory signature at entry ${i}`);
      }
      const flags = u16(cd, p + 8);
      const method = u16(cd, p + 10);
      const dosTime = u16(cd, p + 12);
      const dosDate = u16(cd, p + 14);
      const crc = u32(cd, p + 16);
      const compressedSize = u32(cd, p + 20);
      const uncompressedSize = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      const externalAttrs = u32(cd, p + 38);
      const localHeaderOffset = u32(cd, p + 42);
      if (compressedSize === ZIP64_U32 || uncompressedSize === ZIP64_U32 ||
          localHeaderOffset === ZIP64_U32) {
        throw new Error(`Zip64 unsupported: entry ${i} uses a Zip64 sentinel size or offset`);
      }
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) {
        throw new Error(`truncated zip central directory at entry ${i}`);
      }
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      assertNoZip64Extra(extra, i);
      const name = unicodePathFromExtra(extra, nameBytes)
        || decodeName(nameBytes, (flags & FLAG_UTF8) !== 0);
      entries.push({
        name,
        flags,
        method,
        methodName: methodName(method),
        crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        externalAttrs,
        isDirectory: name.endsWith('/') || name.endsWith('\\'),
        fileTime: dosTimeToFileTime(dosTime, dosDate),
        dosTime,
        dosDate,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // The central directory's offset points at the LOCAL header, whose own
  // name/extra fields are frequently a different length from the catalog's.
  // Data starts after them, so the local header must be read to find it.
  function dataOffsetFromLocalHeader(header, entry, size) {
    if (u32(header, 0) !== SIG_LOCAL) {
      throw new Error(`bad local header for zip entry ${entry.name}`);
    }
    const at = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28);
    // Bounds-check against the archive itself: a truncated download or a
    // hostile catalog can point an entry past the end of the file.
    if (size !== undefined && at + entry.compressedSize > size) {
      throw new Error(
        `corrupt zip: entry ${entry.name} claims ${entry.compressedSize} bytes at ${at}, ` +
        `past the ${size}-byte archive`);
    }
    return at;
  }

  function readCatalogSync(source) {
    const src = toSource(source);
    if (!src.sync) throw new Error('readCatalogSync needs in-memory bytes; use readCatalogAsync');
    const tailLen = Math.min(src.size, EOCD_MAX);
    const tailStart = src.size - tailLen;
    const tail = src.read(tailStart, tailLen);
    const eocd = findEocd(tail, tailStart);
    return parseCentralDirectory(src.read(eocd.cdOffset, eocd.cdSize), eocd.count);
  }

  async function readCatalogAsync(source) {
    const src = toSource(source);
    const tailLen = Math.min(src.size, EOCD_MAX);
    const tailStart = src.size - tailLen;
    const tail = await src.read(tailStart, tailLen);
    const eocd = findEocd(tail, tailStart);
    const cd = (eocd.cdOffset >= tailStart)
      ? tail.subarray(eocd.cdOffset - tailStart, eocd.cdOffset - tailStart + eocd.cdSize)
      : await src.read(eocd.cdOffset, eocd.cdSize);
    return parseCentralDirectory(cd, eocd.count);
  }

  // ------------------------------------------------------------- inflation

  function checkInflated(out, entry) {
    if (out.length !== entry.uncompressedSize) {
      throw new Error(
        `corrupt zip entry ${entry.name}: inflated ${out.length} bytes, ` +
        `the catalog declares ${entry.uncompressedSize}`);
    }
    return out;
  }

  // Untrusted input: verify what came out, always. A CRC mismatch here is the
  // difference between a clear "corrupt archive" and a guest that reads
  // plausible-looking garbage and blames its own decoder a million
  // instructions later.
  function checkCrc(out, entry) {
    const actual = crc32(out);
    if (actual !== entry.crc) {
      throw new Error(
        `corrupt zip entry ${entry.name}: CRC32 ${actual.toString(16)} ` +
        `does not match the catalog's ${entry.crc.toString(16)}`);
    }
    return out;
  }

  function inflateRawSync(bytes, entry) {
    if (!nodeZlib) {
      throw new Error(
        `cannot inflate ${entry.name} synchronously: no zlib in this environment ` +
        `(the browser path is async — use mountZip())`);
    }
    // maxOutputLength refuses *before* allocating, so a header that lies about
    // its uncompressed size cannot turn into an out-of-memory kill.
    const out = new Uint8Array(nodeZlib.inflateRawSync(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { maxOutputLength: entry.uncompressedSize + 1 }));
    return checkInflated(out, entry);
  }

  async function inflateRawAsync(bytes, entry) {
    if (nodeZlib) return inflateRawSync(bytes, entry);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(`cannot inflate ${entry.name}: no DecompressionStream and no zlib`);
    }
    // Read the decompressed stream in chunks and stop the moment it exceeds
    // the declared size — the browser's equivalent of maxOutputLength.
    const limit = entry.uncompressedSize;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const out = new Uint8Array(limit);
    let filled = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (filled + value.length > limit) {
        await reader.cancel();
        throw new Error(
          `corrupt zip entry ${entry.name}: inflates past its declared ${limit} bytes`);
      }
      out.set(value, filled);
      filled += value.length;
    }
    return checkInflated(out.subarray(0, filled), entry);
  }

  function extractSync(source, entry, options) {
    const src = toSource(source);
    assertSupported(entry, options);
    const header = src.read(entry.localHeaderOffset, 30);
    const at = dataOffsetFromLocalHeader(header, entry, src.size);
    const raw = src.read(at, entry.compressedSize);
    const out = entry.method === METHOD_STORED
      ? checkInflated(raw.slice(), entry)
      : inflateRawSync(raw, entry);
    return checkCrc(out, entry);
  }

  async function extractAsync(source, entry, options) {
    const src = toSource(source);
    assertSupported(entry, options);
    const header = await src.read(entry.localHeaderOffset, 30);
    const at = dataOffsetFromLocalHeader(header, entry, src.size);
    const raw = await src.read(at, entry.compressedSize);
    const out = entry.method === METHOD_STORED
      ? checkInflated(raw.slice(), entry)
      : await inflateRawAsync(raw, entry);
    return checkCrc(out, entry);
  }

  // ---------------------------------------------------------------- naming

  function zipBaseName(nameOrPath) {
    const base = String(nameOrPath || 'archive').replace(/^.*[\\/]/, '');
    return base.replace(/\.zip$/i, '') || 'archive';
  }

  // A zip made by "right-click > Compress" wraps everything in one folder; a
  // zip made by "cd game && zip -r" does not. Mounting the wrapper would give
  // C:\Program Files\keen4\keen4\KEEN4.EXE, so unwrap a single common prefix.
  function commonTopFolder(entries) {
    let top = null;
    for (const e of entries) {
      const name = e.name.replace(/\\/g, '/');
      const slash = name.indexOf('/');
      if (slash <= 0) return null;              // a file at the root: no wrapper
      const head = name.slice(0, slash);
      if (top === null) top = head;
      else if (top !== head) return null;
    }
    return top;
  }

  // "Zip Slip" and friends. A name is data, not a path: it may claim to be
  // absolute, to sit on another drive, to be a UNC share, to climb out of the
  // mount with `..`, or to be a DOS device. Every one of those is refused by
  // name rather than sanitized into something else, so a hostile archive is a
  // loud failure and never a surprise write outside the mount.
  function guestPathComponent(part, context) {
    const label = context || `archive entry "${part}"`;
    if (!part || part === '.' || part === '..') {
      throw new Error(`${label} has an unsafe path component`);
    }
    if (/[\\/]/.test(part)) throw new Error(`${label} is not one path component`);
    if (/[\x00-\x1f<>:"|?*]/.test(part)) {
      throw new Error(`${label} contains a character Win32 cannot use in a file name`);
    }
    if (/[ .]$/.test(part)) {
      throw new Error(`${label} ends in a dot or space that Win32 aliases away`);
    }
    const stem = part.split('.')[0].toLowerCase();
    if (DOS_DEVICES.has(stem)) {
      throw new Error(`${label} uses the reserved device name "${part}"`);
    }
    return part;
  }

  function guestRelative(name) {
    const slashed = name.replace(/\\/g, '/');
    if (slashed.startsWith('//')) throw new Error(`zip entry is a UNC path: ${name}`);
    if (slashed.startsWith('/')) throw new Error(`zip entry is an absolute path: ${name}`);
    if (/^[a-zA-Z]:/.test(slashed)) throw new Error(`zip entry has a drive letter: ${name}`);
    const parts = slashed.split('/').filter(p => p !== '' && p !== '.');
    for (const part of parts) {
      if (part === '..') throw new Error(`zip entry escapes its mount root: ${name}`);
      if (/^[a-zA-Z]:$/.test(part)) throw new Error(`zip entry has a drive letter: ${name}`);
      guestPathComponent(part, `zip entry "${name}"`);
    }
    return parts.join('\\');
  }

  function normalizeRoot(root) {
    let r = String(root).replace(/\//g, '\\');
    if (!/^[a-zA-Z]:/.test(r)) r = 'c:\\' + r.replace(/^\\+/, '');
    if (!r.endsWith('\\')) r += '\\';
    return r.toLowerCase();
  }

  // ---------------------------------------------------------------- mounts

  function mountPlan(entries, options) {
    const opts = options || {};
    const name = opts.name || zipBaseName(opts.zipPath || 'archive');
    const root = normalizeRoot(opts.root || `c:\\program files\\${name}`);
    // Validate the archive spelling before deciding whether a common wrapper
    // directory can be removed. Otherwise an archive whose every member starts
    // with `../` makes that hostile component look like an innocuous wrapper
    // and strips it before guestRelative ever sees it.
    for (const entry of entries) guestRelative(entry.name);
    const files = entries.filter(e => !e.isDirectory);
    const strip = opts.unwrap === false ? null : commonTopFolder(entries);
    const mapped = [];
    // Win32 paths are case-insensitive, so two entries that differ only in
    // case are one file to the guest. Unwrapping a common folder can collide
    // two names as well. Either way, refusing is the only answer that cannot
    // silently mount the wrong bytes.
    const seen = new Map();
    for (const entry of files) {
      let rel = entry.name.replace(/\\/g, '/');
      if (strip) rel = rel.slice(strip.length + 1);
      if (!rel) continue;
      const tail = guestRelative(rel);
      if (!tail) continue;
      const guestPath = root + tail.toLowerCase();
      if (seen.has(guestPath)) {
        throw new Error(
          `zip entries "${seen.get(guestPath)}" and "${entry.name}" both mount at ` +
          `${guestPath}; Win32 paths are case-insensitive, so this archive is ambiguous`);
      }
      seen.set(guestPath, entry.name);
      mapped.push({ entry, path: guestPath, rel: tail });
    }
    return { root, strip, mapped };
  }

  function applyEntryTimes(vfsEntry, zipEntry) {
    const t = zipEntry.fileTime;
    vfsEntry.creationTime = { lo: t.lo, hi: t.hi };
    vfsEntry.lastAccessTime = { lo: t.lo, hi: t.hi };
    vfsEntry.lastWriteTime = { lo: t.lo, hi: t.hi };
    return vfsEntry;
  }

  const ATTR_READONLY_ARCHIVE = 0x21;

  // One materialization budget per mount. Lazy entries are inflated over the
  // whole life of the process, so the cap has to be charged where the bytes
  // are actually produced, not summed from the catalog up front.
  function makeBudget(options) {
    const limit = (options && options.maxTotalBytes) || DEFAULT_MAX_TOTAL_BYTES;
    let used = 0;
    return {
      charge(bytes, name) {
        used += bytes.length;
        if (used > limit) {
          throw new Error(
            `zip mount exceeded its ${limit}-byte materialization budget at ${name} ` +
            `(pass maxTotalBytes to raise it)`);
        }
        return bytes;
      },
      get used() { return used; },
    };
  }

  function mountDirs(vfs, root, mapped) {
    vfs.ensureParentDirs(root + 'x');
    vfs.dirs.add(root.replace(/\\$/, ''));
    for (const m of mapped) vfs.ensureParentDirs(m.path);
  }

  function byteProviderModule() {
    if (typeof require === 'function') {
      try { return require('./byte-provider'); } catch (_) { /* optional */ }
    }
    if (typeof window !== 'undefined' && window.byteProvider) return window.byteProvider;
    return null;
  }

  // A stored entry is a contiguous run of bytes inside the archive — exactly
  // what a byte provider expresses — so it mounts as a window on the archive's
  // own provider and is never copied. Callers fall back to a lazy whole-entry
  // read when lib/byte-provider.js is unavailable.
  //
  // The one thing this trades away: a windowed entry is served range by range,
  // so its CRC is never computed. `verifyStored: true` gives up the window and
  // materializes stored entries through extract(), CRC check included.
  function mountStored(vfs, path, zipEntry, cache) {
    return vfs.setProviderFile(path, {
      provider: cache,
      offset: zipEntry.dataOffset,
      length: zipEntry.uncompressedSize,
      attrs: ATTR_READONLY_ARCHIVE,
    });
  }

  // Synchronous mount over in-memory bytes. Nothing is decompressed here: the
  // catalog supplies every size, so FindFirstFile can list a whole archive
  // without touching a compressed byte, and a deflated entry is inflated the
  // first time the guest opens it.
  function mountZipSync(vfs, bytes, options) {
    const src = bytesSource(bytes);
    const entries = readCatalogSync(src);
    for (const e of entries) if (!e.isDirectory) assertSupported(e, options);
    const { root, mapped } = mountPlan(entries, options);
    mountDirs(vfs, root, mapped);
    const budget = makeBudget(options);
    const bp = byteProviderModule();
    let cache = null;
    if (bp && !(options && options.verifyStored) && typeof vfs.setProviderFile === 'function') {
      cache = bp.cached(options && options.provider
        ? options.provider
        : new bp.BytesProvider(src.read(0, src.size), (options && options.zipPath) || 'zip'));
    }
    for (const m of mapped) {
      const zipEntry = m.entry;
      zipEntry.dataOffset = dataOffsetFromLocalHeader(
        src.read(zipEntry.localHeaderOffset, 30), zipEntry, src.size);
      const vfsEntry = (cache && zipEntry.method === METHOD_STORED)
        ? mountStored(vfs, m.path, zipEntry, cache)
        : vfs.setLazyFile(m.path, {
          attrs: ATTR_READONLY_ARCHIVE,
          size: zipEntry.uncompressedSize,
          load: () => budget.charge(extractSync(src, zipEntry, options), zipEntry.name),
        });
      applyEntryTimes(vfsEntry, zipEntry);
    }
    return { root, entries, mounted: mapped.map(m => m.path), budget };
  }

  // Async mount, for a byte provider (File slice, HTTP Range, OPFS) or for
  // plain bytes in a browser, where inflate is async. Stored entries stay lazy
  // as provider windows; deflated ones are materialized here, which is the
  // trade docs/design-byo-media.md picks — a deflate stream cannot be
  // range-read, and era files are small.
  async function mountZip(vfs, source, options) {
    const src = toSource(source);
    if (src.sync && nodeZlib) return mountZipSync(vfs, src.read(0, src.size), options);
    const entries = await readCatalogAsync(src);
    for (const e of entries) if (!e.isDirectory) assertSupported(e, options);
    const { root, mapped } = mountPlan(entries, options);
    mountDirs(vfs, root, mapped);
    const budget = makeBudget(options);
    const bp = byteProviderModule();
    const cache = (bp && !src.sync && !(options && options.verifyStored) &&
      typeof vfs.setProviderFile === 'function') ? bp.cached(source) : null;
    for (const m of mapped) {
      const zipEntry = m.entry;
      zipEntry.dataOffset = dataOffsetFromLocalHeader(
        await src.read(zipEntry.localHeaderOffset, 30), zipEntry, src.size);
      let vfsEntry;
      if (cache && zipEntry.method === METHOD_STORED) {
        vfsEntry = mountStored(vfs, m.path, zipEntry, cache);
      } else {
        const raw = await src.read(zipEntry.dataOffset, zipEntry.compressedSize);
        const out = zipEntry.method === METHOD_STORED
          ? checkInflated(raw.slice(), zipEntry)
          : await inflateRawAsync(raw, zipEntry);
        const data = budget.charge(checkCrc(out, zipEntry), zipEntry.name);
        vfsEntry = { data, attrs: ATTR_READONLY_ARCHIVE };
        vfs.files.set(vfs._normPath(m.path), vfsEntry);
      }
      applyEntryTimes(vfsEntry, zipEntry);
    }
    return { root, entries, mounted: mapped.map(m => m.path), budget };
  }

  const api = {
    mountZip,
    mountZipSync,
    // Exported so the import flow can read an archive's catalog *before*
    // deciding to mount it — the insert dialog has to list the exe candidates
    // it is offering, and readCatalog* take an already-converted source.
    toSource,
    readCatalogSync,
    readCatalogAsync,
    extractSync,
    extractAsync,
    crc32,
    zipBaseName,
    commonTopFolder,
    mountPlan,
    guestRelative,
    guestPathComponent,
    dosTimeToFileTime,
    METHOD_STORED,
    METHOD_DEFLATE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ZipMount = api;
})();
