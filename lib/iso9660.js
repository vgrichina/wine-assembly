// ISO 9660 reader and D:\ mount.
//
// Every file on an ISO is one contiguous run of sectors, so the directory tree
// alone is enough to describe the whole disc as (LBA, length) pairs — no
// decompression, and a mounted file costs nothing until the guest opens it.
// That is what makes this the friendliest container for the emulator: parse the
// Primary Volume Descriptor at sector 16, walk the directory records, and hand
// VirtualFS one lazy entry per file.
//
// Joliet (the supplementary descriptor carrying UCS-2 names) is preferred when
// present, because that is where the long file names live; the primary
// descriptor's 8.3 ISO names are the fallback.
//
// Out of scope, deliberately:
//   * Rock Ridge (POSIX names/permissions in the System Use area). Era Windows
//     discs do not carry it, and Joliet already answers the long-name question.
//   * Interleaved files (file unit size / interleave gap non-zero). Such an
//     extent is not contiguous, so a range read would silently return the wrong
//     bytes — those records are rejected loudly rather than guessed at.
//   * Multi-extent files (the "not final" flag), for the same reason.
//
// Dual environment: `module.exports` under node, `window.Iso9660` in the
// browser — same shape as lib/vfs-persistence.js.

(function () {
  const SECTOR = 2048;
  const VD_START_LBA = 16;
  const MAX_VOLUME_DESCRIPTORS = 64;

  const FLAG_HIDDEN = 0x01;
  const FLAG_DIRECTORY = 0x02;
  const FLAG_ASSOCIATED = 0x04;
  const FLAG_NOT_FINAL = 0x80;

  // ---------------------------------------------------------------- providers

  // Everything below reads through one narrow interface: `size` plus
  // `readRange(offset, length) -> Uint8Array`, synchronous. A Uint8Array source
  // is wrapped into one; a caller that already has a byte provider (a File
  // slice, an OPFS handle, a node fd) passes an object exposing the same two
  // members — see docs/design-byo-media.md.
  function toProvider(source) {
    if (!source) throw new Error('iso9660: no source');
    if (source instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(source))) {
      const bytes = source instanceof Uint8Array
        ? source
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      return {
        size: bytes.length,
        readRange(offset, length) {
          const start = Math.min(offset >>> 0, bytes.length);
          const end = Math.min(start + Math.max(0, length | 0), bytes.length);
          return bytes.subarray(start, end);
        },
      };
    }
    if (source instanceof ArrayBuffer) return toProvider(new Uint8Array(source));
    if (typeof source.readRange === 'function') {
      if (typeof source.size !== 'number') throw new Error('iso9660: provider has no size');
      return source;
    }
    if (typeof source.readRangeSync === 'function') {
      return { size: source.size, readRange: (o, l) => source.readRangeSync(o, l) };
    }
    throw new Error('iso9660: source is neither bytes nor a synchronous byte provider');
  }

  // ------------------------------------------------------------------ parsing

  function readU32LE(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  function readU16LE(b, o) {
    return (b[o] | (b[o + 1] << 8)) >>> 0;
  }

  // ECMA-119 stores its numbers twice, little-endian then big-endian. Reading
  // the LE half and checking it against the BE one costs nothing and catches a
  // truncated or misaligned image before its garbage LBAs are handed to a
  // range read — the failure mode otherwise is a file full of the wrong bytes.
  function bothEndianU32(b, o, what) {
    const le = readU32LE(b, o);
    const be = ((b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]) >>> 0;
    if (le !== be) {
      throw new Error(`iso9660: ${what} disagrees between its little-endian ` +
        `(${le}) and big-endian (${be}) halves — the image is corrupt`);
    }
    return le;
  }

  function bothEndianU16(b, o, what) {
    const le = readU16LE(b, o);
    const be = ((b[o + 2] << 8) | b[o + 3]) >>> 0;
    if (le !== be) {
      throw new Error(`iso9660: ${what} disagrees between its little-endian ` +
        `(${le}) and big-endian (${be}) halves — the image is corrupt`);
    }
    return le;
  }

  function asciiString(bytes, offset, length) {
    let out = '';
    for (let i = 0; i < length; i++) {
      const c = bytes[offset + i];
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out.replace(/\s+$/, '');
  }

  function ucs2String(bytes, offset, length) {
    let out = '';
    for (let i = 0; i + 1 < length; i += 2) {
      const c = (bytes[offset + i] << 8) | bytes[offset + i + 1];
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out.replace(/\s+$/, '');
  }

  // Escape sequences that mark a supplementary descriptor as Joliet: UCS-2
  // levels 1, 2 and 3 (ECMA-119 / Joliet spec).
  function jolietLevel(bytes) {
    const esc = bytes.subarray(88, 88 + 32);
    if (esc[0] !== 0x25 || esc[1] !== 0x2f) return 0;
    if (esc[2] === 0x40) return 1;
    if (esc[2] === 0x43) return 2;
    if (esc[2] === 0x45) return 3;
    return 0;
  }

  function parseDirectoryRecord(bytes, offset, joliet) {
    const length = bytes[offset];
    if (!length) return null;
    const extLen = bytes[offset + 1];
    const lba = bothEndianU32(bytes, offset + 2, 'a directory record extent LBA');
    const size = bothEndianU32(bytes, offset + 10, 'a directory record data length');
    const flags = bytes[offset + 25];
    const unitSize = bytes[offset + 26];
    const interleave = bytes[offset + 27];
    const idLen = bytes[offset + 32];
    const idOff = offset + 33;

    let name;
    let special = 0;
    if (idLen === 1 && bytes[idOff] === 0) { name = '.'; special = 1; }
    else if (idLen === 1 && bytes[idOff] === 1) { name = '..'; special = 2; }
    else name = joliet ? ucs2String(bytes, idOff, idLen) : asciiString(bytes, idOff, idLen);

    if (!special) {
      // Strip the ";1" version suffix and the bare trailing dot ISO leaves on
      // extension-less names ("SETUP." is SETUP).
      const semi = name.lastIndexOf(';');
      if (semi >= 0) name = name.slice(0, semi);
      if (name.endsWith('.')) name = name.slice(0, -1);
    }

    return {
      recordLength: length,
      extAttrLength: extLen,
      lba,
      length: size,
      flags,
      unitSize,
      interleave,
      name,
      special,
      isDirectory: (flags & FLAG_DIRECTORY) !== 0,
    };
  }

  function* directoryRecords(provider, lba, byteLength, joliet, blockSize) {
    // Records never straddle a sector boundary; a zero length byte means "the
    // rest of this sector is padding, resume at the next one".
    const sectors = Math.ceil(byteLength / blockSize);
    for (let s = 0; s < sectors; s++) {
      const chunk = provider.readRange((lba + s) * blockSize, blockSize);
      let off = 0;
      while (off < chunk.length) {
        const len = chunk[off];
        if (!len) break;
        if (off + len > chunk.length) break;
        const rec = parseDirectoryRecord(chunk, off, joliet);
        if (rec) yield rec;
        off += len;
      }
    }
  }

  function readVolumeDescriptors(provider) {
    const out = [];
    for (let i = 0; i < MAX_VOLUME_DESCRIPTORS; i++) {
      const off = (VD_START_LBA + i) * SECTOR;
      if (off + SECTOR > provider.size) break;
      const vd = provider.readRange(off, SECTOR);
      if (vd.length < 7) break;
      const magic = asciiString(vd, 1, 5);
      if (magic !== 'CD001') {
        if (i === 0) throw new Error('iso9660: no "CD001" signature at sector 16 — not an ISO 9660 image');
        break;
      }
      const type = vd[0];
      if (type === 255) break; // volume descriptor set terminator
      out.push({ type, bytes: vd });
    }
    if (!out.length) throw new Error('iso9660: no volume descriptors');
    return out;
  }

  function descriptorInfo(vd, joliet) {
    const b = vd.bytes;
    // Extents are counted in logical blocks, and a descriptor is entitled to
    // say they are not 2048 bytes; use the field, not the constant.
    const blockSize = bothEndianU16(b, 128, 'the logical block size') || SECTOR;
    const root = parseDirectoryRecord(b, 156, false);
    if (!root) throw new Error('iso9660: volume descriptor has no root directory record');
    return {
      joliet,
      blockSize,
      volumeLabel: (joliet ? ucs2String(b, 40, 32) : asciiString(b, 40, 32)).trim(),
      volumeSpaceSize: bothEndianU32(b, 80, 'the volume space size'),
      // "YYYYMMDDHHMMSShh" + GMT offset — the only per-image identity an ISO
      // carries, since ECMA-119 has no serial-number field at all.
      created: asciiString(b, 813, 16),
      root,
    };
  }

  // Windows shows a serial for a CD even though the format has none: it is
  // derived from the volume creation timestamp. Do the same — any stable,
  // image-specific 32-bit value satisfies a check that stored the serial it
  // saw at install time, and deriving it from the timestamp means two mounts
  // of one image agree while two different discs do not.
  function volumeSerial(created) {
    let hash = 0x811c9dc5 >>> 0; // FNV-1a, the hash this project already uses
    for (let i = 0; i < created.length; i++) {
      hash = (hash ^ created.charCodeAt(i)) >>> 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // Parse an ISO image into `{volumeLabel, joliet, blockSize, files}`.
  // `files[]` entries are `{path, name, lba, length, flags, isDirectory}` with
  // `path` in Win32 spelling relative to the volume root ("SETUP\\DATA.BIN").
  //
  // opts.prefer: 'joliet' (default), 'primary'.
  function parseIso(source, opts = {}) {
    const provider = toProvider(source);
    if (provider.size < (VD_START_LBA + 1) * SECTOR) {
      throw new Error(`iso9660: image is only ${provider.size} bytes — too small to hold a volume descriptor`);
    }
    const descriptors = readVolumeDescriptors(provider);
    const primary = descriptors.find((d) => d.type === 1);
    if (!primary) throw new Error('iso9660: no primary volume descriptor');
    const supplementary = descriptors.filter((d) => d.type === 2).find((d) => jolietLevel(d.bytes) > 0);

    const prefer = opts.prefer || 'joliet';
    const useJoliet = prefer !== 'primary' && !!supplementary;
    const info = useJoliet
      ? descriptorInfo(supplementary, true)
      : descriptorInfo(primary, false);
    // The label is an a-character field in both descriptors; the primary's is
    // the one Win32 reports for a Joliet disc too, and it is the one CD checks
    // compare against, so read it from the PVD either way.
    const primaryInfo = descriptorInfo(primary, false);
    const label = primaryInfo.volumeLabel || info.volumeLabel;

    const files = [];
    const seen = new Set();
    const walk = (lba, byteLength, prefix, depth) => {
      if (depth > 32) throw new Error(`iso9660: directory nesting deeper than 32 at "${prefix}"`);
      const key = `${lba}:${byteLength}`;
      if (seen.has(key)) return; // self-referential extent; stop rather than loop
      seen.add(key);
      const children = [];
      for (const rec of directoryRecords(provider, lba, byteLength, info.joliet, info.blockSize)) {
        if (rec.special) continue;
        if (rec.flags & FLAG_ASSOCIATED) continue;
        if (rec.flags & FLAG_NOT_FINAL) {
          throw new Error(`iso9660: multi-extent file "${prefix}${rec.name}" is not supported`);
        }
        if (rec.unitSize || rec.interleave) {
          throw new Error(`iso9660: interleaved file "${prefix}${rec.name}" is not supported`);
        }
        if (!rec.name) continue;
        const path = prefix + rec.name;
        files.push({
          path,
          name: rec.name,
          lba: rec.lba,
          offset: (rec.lba + rec.extAttrLength) * info.blockSize,
          length: rec.length,
          flags: rec.flags,
          hidden: (rec.flags & FLAG_HIDDEN) !== 0,
          isDirectory: rec.isDirectory,
        });
        if (rec.isDirectory) children.push({ rec, path });
      }
      for (const child of children) {
        walk(child.rec.lba + child.rec.extAttrLength, child.rec.length, child.path + '\\', depth + 1);
      }
    };
    walk(info.root.lba + info.root.extAttrLength, info.root.length, '', 0);

    return {
      volumeLabel: label,
      volumeCreated: primaryInfo.created,
      volumeSerial: volumeSerial(primaryInfo.created),
      joliet: info.joliet,
      hasJoliet: !!supplementary,
      blockSize: info.blockSize,
      volumeSpaceSize: info.volumeSpaceSize,
      size: provider.size,
      provider,
      files,
    };
  }

  // Read one parsed entry's bytes.
  function readEntry(iso, entry) {
    if (entry.isDirectory) throw new Error(`iso9660: "${entry.path}" is a directory`);
    const bytes = iso.provider.readRange(entry.offset, entry.length);
    if (bytes.length < entry.length) {
      throw new Error(`iso9660: "${entry.path}" extends past the end of the image ` +
        `(need ${entry.length} bytes at ${entry.offset}, image is ${iso.provider.size})`);
    }
    // subarray views alias the whole image; hand back an independent copy so a
    // caller cannot retain the entire ISO through one small file.
    return bytes.slice(0, entry.length);
  }

  function findEntry(iso, path) {
    const want = String(path || '').replace(/^[\\/]+/, '').replace(/\//g, '\\').toLowerCase();
    return iso.files.find((f) => f.path.toLowerCase() === want) || null;
  }

  // ----------------------------------------------------------- async parsing

  // Everything above is synchronous, because a directory walk that could
  // suspend at every record would be a different program. But a File dropped
  // on the page has no synchronous read at all, and reading a 638MB disc into
  // memory to look at its 32KB of descriptors is exactly the copy this whole
  // design exists to avoid.
  //
  // So the walk stays synchronous and the *bytes* are made to be there. A
  // ChunkCache (lib/byte-provider.js) can answer a read synchronously when the
  // chunk is resident and asynchronously when it is not; this wraps it in a
  // view whose first miss throws, fills that range, and runs the parse again.
  // Parsing is pure and deterministic over the image, so a retry re-walks the
  // same records and gets one chunk further each time — the same
  // park-fill-retry shape the guest's ReadFile uses, one level up.
  //
  // Cost is a re-walk per missed chunk, and a walk over descriptors already in
  // memory is microseconds; the round trips are what dominate either way.
  class NeedRange extends Error {
    constructor(offset, length) {
      super(`iso9660: need bytes ${offset}..${offset + length}`);
      this.offset = offset;
      this.length = length;
    }
  }

  // Generous: one attempt per chunk the parse touches. A real disc's
  // descriptors and directory tree are a few dozen chunks; the cap exists so a
  // provider that silently fails to cache cannot spin forever.
  const MAX_PARSE_ATTEMPTS = 4096;

  function syncViewOf(cache) {
    return {
      size: cache.size,
      readRange(offset, length) {
        const hit = cache.tryRead(offset, length);
        if (!hit) throw new NeedRange(offset, length);
        return hit;
      },
    };
  }

  function byteProviderModule() {
    if (typeof require === 'function') {
      try { return require('./byte-provider'); } catch (_) { /* optional */ }
    }
    if (typeof window !== 'undefined' && window.byteProvider) return window.byteProvider;
    return null;
  }

  // Parse an image behind an async provider. Resolves to
  // `{ iso, provider }` — the provider is the chunk cache the parse warmed,
  // and mountIso should be handed it so the file extents mount as windows on
  // the same cache rather than opening a second one.
  async function parseIsoAsync(source, opts = {}) {
    if (source instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(source))) {
      return { iso: parseIso(source, opts), provider: null };
    }
    const bp = byteProviderModule();
    const cache = (source && source.tryRead && source.fill) ? source
      : (bp ? bp.cached(source) : null);
    if (!cache) return { iso: parseIso(source, opts), provider: null };
    const view = syncViewOf(cache);
    for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt++) {
      try {
        return { iso: parseIso(view, opts), provider: cache };
      } catch (error) {
        if (!(error instanceof NeedRange)) throw error;
        await cache.fill(error.offset, error.length);
      }
    }
    throw new Error('iso9660: the image never finished parsing — its provider is not caching reads');
  }

  // ------------------------------------------------------------------- mount

  // Mount an ISO as a read-only drive (D:\ by default).
  //
  // VirtualFS normalizes any drive letter through the same `_normPath`, so a
  // `d:\` path is first-class with no aliasing: register the drive root and
  // every directory, then one lazy file entry per record. Bytes are pulled on
  // the first open, not at mount time.
  function mountIso(vfs, source, opts = {}) {
    const drive = String(opts.drive || 'D').replace(/:$/, '').toUpperCase();
    if (!/^[A-Z]$/.test(drive)) throw new Error(`iso9660: invalid drive letter "${opts.drive}"`);
    const iso = opts.parsed || parseIso(source, opts);
    const root = drive + ':\\';

    vfs.ensureParentDirs(root);
    vfs.dirs.add(root.toLowerCase());

    // An ISO file is one contiguous run of blocks, which is precisely what a
    // provider window expresses — so when the caller hands over an async
    // provider (a dropped File, an OPFS copy, a remote URL), each file mounts
    // as `readRange(offset, length)` on it and the guest's ReadFile parks on
    // the IO_WAIT path for whatever chunk it is missing. Nothing is ever
    // copied, and a 600MB disc costs its directory tree in memory.
    //
    // With a synchronous source there is no async to bridge and no reason to
    // pay the cache's indirection: those keep the eager lazy-load path, whose
    // `load()` reads the extent straight out of the image.
    const windowed = opts.provider && typeof vfs.setProviderFile === 'function';
    let fileCount = 0;
    for (const entry of iso.files) {
      const full = root + entry.path;
      if (entry.isDirectory) {
        vfs.dirs.add(vfs._normPath(full));
        continue;
      }
      vfs.ensureParentDirs(full);
      // FILE_ATTRIBUTE_READONLY (0x01), plus HIDDEN (0x02) when the record says so.
      const attrs = 0x01 | (entry.hidden ? 0x02 : 0);
      if (windowed) {
        vfs.setProviderFile(full, {
          provider: opts.provider,
          offset: entry.offset,
          length: entry.length,
          attrs,
        });
      } else {
        vfs.setLazyFile(full, {
          attrs,
          size: entry.length,
          load: () => readEntry(iso, entry),
        });
      }
      fileCount++;
    }

    if (opts.readOnly !== false) vfs.setDriveReadOnly(drive, true);
    if (!vfs.volumeLabels) vfs.volumeLabels = new Map();
    vfs.volumeLabels.set(drive.toLowerCase(), iso.volumeLabel);
    if (!vfs.volumeSerials) vfs.volumeSerials = new Map();
    vfs.volumeSerials.set(drive.toLowerCase(), iso.volumeSerial >>> 0);
    if (!vfs.driveTypes) vfs.driveTypes = new Map();
    vfs.driveTypes.set(drive.toLowerCase(), 5); // DRIVE_CDROM

    return { drive, root, iso, volumeLabel: iso.volumeLabel, fileCount };
  }

  const api = {
    SECTOR,
    parseIso,
    parseIsoAsync,
    NeedRange,
    readEntry,
    findEntry,
    mountIso,
    toProvider,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Iso9660 = api;
})();
