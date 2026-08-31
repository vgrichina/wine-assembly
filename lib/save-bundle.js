// Save bundles — the "memory card" for a wine-assembly app.
//
// A bundle is an ordinary zip holding everything a single app's *state*
// consists of, which today is two unrelated stores:
//
//   vfs/…            the files matching the app's `persistFiles` globs in
//                    lib/apps.js — the same set lib/vfs-persistence.js mirrors
//                    into localStorage, with their Win32 attributes and the
//                    three FILETIMEs
//   registry.json    the `reg:` slice of lib/storage.js's backing store
//   ini.json         the `ini:` slice of the same store
//   manifest.json    version, appId, createdAt, the emulator commit, the globs
//                    the export used, and a SHA-256 for every other member
//
// Two properties this file exists to guarantee:
//
// **Deterministic.** Given the same inputs (including `createdAt`) the writer
// emits byte-identical output: entries are sorted, everything is stored
// (method 0, so no zlib level can drift under us), and the DOS timestamp is
// derived from `createdAt` in UTC rather than from the local clock. That is
// what makes "export, wipe, import, export again" a byte comparison instead of
// a semantic one, and a byte comparison is the only kind that cannot quietly
// pass while dropping a field.
//
// **Untrusted on the way in.** A bundle arrives from a download folder or from
// a sync endpoint, so `importBundle` verifies every hash before it touches the
// VFS, sanitizes each entry name the way lib/zip-mount.js does (no absolute
// paths, no `..`, no device names), and then *additionally* requires that the
// guest path each entry reconstructs to still matches the app's own
// `persistFiles` globs. A bundle cannot write outside the set of paths the app
// was already allowed to persist, whatever its manifest claims.
//
// Reading reuses lib/zip-mount.js (catalog parse, CRC verification, Zip64 and
// encryption refusal); only the writer is new here.

(function () {
  'use strict';

  const BUNDLE_VERSION = 1;
  const MANIFEST_NAME = 'manifest.json';
  const REGISTRY_NAME = 'registry.json';
  const INI_NAME = 'ini.json';
  const VFS_PREFIX = 'vfs/';

  // Saves are KB..1MB by design (see docs/design-byo-media.md). These caps are
  // deliberately close to that: a "save bundle" the size of a CD image is not a
  // save bundle, and refusing early is cheaper than discovering it at write.
  const DEFAULT_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
  const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
  const DEFAULT_MAX_FILES = 4096;

  // Win32 reserved device names, same list lib/zip-mount.js refuses.
  const RESERVED = new Set([
    'con', 'prn', 'aux', 'nul', 'clock$',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  ]);

  const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

  function zipMountModule() {
    if (typeof require === 'function') return require('./zip-mount');
    if (typeof window !== 'undefined' && window.ZipMount) return window.ZipMount;
    throw new Error('save-bundle needs lib/zip-mount.js (load it before this script)');
  }

  function storageModule(injected) {
    if (injected) return injected;
    if (typeof require === 'function') return require('./storage');
    if (typeof window !== 'undefined' && window.StorageImports) return window.StorageImports;
    throw new Error('save-bundle needs lib/storage.js (load it before this script)');
  }

  // ------------------------------------------------------------------ sha256
  //
  // Pure JS on purpose. Node's crypto is synchronous but browser-side SHA-256
  // is only available through SubtleCrypto, which is async — and an async hash
  // would make the whole export/import API async for no gain on a few hundred
  // KB. This is ~40 lines and identical in both environments.

  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256(bytes) {
    const msg = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const bitLen = msg.length * 8;
    const withPad = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
    withPad.set(msg);
    withPad[msg.length] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(withPad.length - 4, bitLen >>> 0, false);

    const h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let base = 0; base < withPad.length; base += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(base + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    let out = '';
    for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
    return out;
  }

  // ------------------------------------------------------------------- text

  function encodeUtf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  // ------------------------------------------------------------------ paths

  // Same normalization lib/vfs-persistence.js applies, so the glob that decided
  // a file was persistable is the glob that decides it is bundlable.
  function normalizePath(path) {
    return String(path || '').toLowerCase().replace(/\//g, '\\');
  }

  function patternRegex(pattern) {
    const escaped = normalizePath(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp('^' + escaped + '$');
  }

  function compilePatterns(patterns) {
    return (patterns || []).map(patternRegex);
  }

  function matchesAny(regexes, path) {
    return regexes.some(re => re.test(path));
  }

  // guest path -> zip member name. `c:\save\game.sav` becomes
  // `vfs/c/save/game.sav`: the drive letter survives as its own path component
  // so the mapping is total and reversible, and the member name is a plain
  // relative path that any zip tool can list.
  function guestPathToMember(guestPath) {
    const norm = normalizePath(guestPath);
    const drive = /^([a-z]):\\(.*)$/.exec(norm);
    if (!drive) throw new Error(`save bundle: cannot encode guest path ${guestPath}`);
    return VFS_PREFIX + drive[1] + '/' + drive[2].split('\\').join('/');
  }

  // The reverse, with the whole sanitizer attached. Everything here is a
  // refusal, never a repair: a bundle that wants to write outside the guest's
  // C:\ is not a bundle with a typo in it.
  function memberToGuestPath(name) {
    const raw = String(name || '');
    if (!raw.startsWith(VFS_PREFIX)) {
      throw new Error(`save bundle: file entry outside vfs/: ${raw}`);
    }
    const rel = raw.slice(VFS_PREFIX.length);
    if (rel.includes('\\')) throw new Error(`save bundle: backslash in entry name: ${raw}`);
    if (rel.startsWith('/')) throw new Error(`save bundle: absolute entry name: ${raw}`);
    const parts = rel.split('/');
    if (parts.length < 2) throw new Error(`save bundle: entry has no drive component: ${raw}`);
    if (!/^[a-z]$/.test(parts[0])) {
      throw new Error(`save bundle: entry drive must be one letter: ${raw}`);
    }
    for (const part of parts.slice(1)) {
      if (part === '' || part === '.' || part === '..') {
        throw new Error(`save bundle: unsafe path segment in ${raw}`);
      }
      if (part.includes(':')) throw new Error(`save bundle: drive marker inside ${raw}`);
      if (/[\x00-\x1f]/.test(part)) throw new Error(`save bundle: control character in ${raw}`);
      const stem = part.replace(/\..*$/, '').toLowerCase();
      if (RESERVED.has(stem)) throw new Error(`save bundle: reserved device name in ${raw}`);
    }
    return parts[0] + ':\\' + parts.slice(1).join('\\');
  }

  // ------------------------------------------------------------ zip writing

  function u16(view, off, value) { view.setUint16(off, value & 0xFFFF, true); }
  function u32(view, off, value) { view.setUint32(off, value >>> 0, true); }

  // MS-DOS date/time from an epoch millisecond count, in UTC. Local time would
  // make the same bundle differ between two machines that exported it from the
  // same state, which is exactly what determinism is for.
  function dosStamp(ms) {
    const d = new Date(Number.isFinite(ms) ? ms : 0);
    const year = Math.max(1980, d.getUTCFullYear());
    const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    return { date: date & 0xFFFF, time: time & 0xFFFF };
  }

  // Store-only zip writer. `members` is [{name, data}] and is written in the
  // order given; the caller sorts.
  function writeZip(members, stampMs) {
    const { crc32 } = zipMountModule();
    const stamp = dosStamp(stampMs);
    const encoded = members.map(m => ({
      name: encodeUtf8(m.name),
      data: m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data),
    }));

    let total = 0;
    for (const m of encoded) total += 30 + m.name.length + m.data.length;
    const localEnd = total;
    for (const m of encoded) total += 46 + m.name.length;
    total += 22;

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let p = 0;
    const offsets = [];
    const crcs = [];
    for (const m of encoded) {
      offsets.push(p);
      const crc = crc32(m.data);
      crcs.push(crc);
      u32(dv, p, 0x04034b50);
      u16(dv, p + 4, 20);
      u16(dv, p + 6, 0x0800);          // general purpose bit 11: names are UTF-8
      u16(dv, p + 8, 0);               // method 0 = stored
      u16(dv, p + 10, stamp.time);
      u16(dv, p + 12, stamp.date);
      u32(dv, p + 14, crc);
      u32(dv, p + 18, m.data.length);
      u32(dv, p + 22, m.data.length);
      u16(dv, p + 26, m.name.length);
      u16(dv, p + 28, 0);
      out.set(m.name, p + 30);
      out.set(m.data, p + 30 + m.name.length);
      p += 30 + m.name.length + m.data.length;
    }
    const cdStart = p;
    for (let i = 0; i < encoded.length; i++) {
      const m = encoded[i];
      u32(dv, p, 0x02014b50);
      u16(dv, p + 4, 20);
      u16(dv, p + 6, 20);
      u16(dv, p + 8, 0x0800);
      u16(dv, p + 10, 0);
      u16(dv, p + 12, stamp.time);
      u16(dv, p + 14, stamp.date);
      u32(dv, p + 16, crcs[i]);
      u32(dv, p + 20, m.data.length);
      u32(dv, p + 24, m.data.length);
      u16(dv, p + 28, m.name.length);
      u16(dv, p + 30, 0);              // extra
      u16(dv, p + 32, 0);              // comment
      u16(dv, p + 34, 0);              // disk
      u16(dv, p + 36, 0);              // internal attrs
      u32(dv, p + 38, 0);              // external attrs
      u32(dv, p + 42, offsets[i]);
      out.set(m.name, p + 46);
      p += 46 + m.name.length;
    }
    u32(dv, p, 0x06054b50);
    u16(dv, p + 4, 0);
    u16(dv, p + 6, 0);
    u16(dv, p + 8, encoded.length);
    u16(dv, p + 10, encoded.length);
    u32(dv, p + 12, p - cdStart);
    u32(dv, p + 16, cdStart);
    u16(dv, p + 20, 0);
    if (localEnd !== cdStart) throw new Error('save bundle: internal zip layout error');
    return out;
  }

  // ------------------------------------------------------------- collecting

  function fileTime(value) {
    if (!value || !Number.isFinite(value.lo) || !Number.isFinite(value.hi)) return null;
    return { lo: value.lo >>> 0, hi: value.hi >>> 0 };
  }

  // The save files an app currently has, in the same terms vfs-persistence
  // uses. Lazy entries (a zip/ISO mount that was never materialized) are not
  // saves and are skipped: a file the guest never wrote is content, not state.
  function collectSaveFiles(vfs, patterns, options) {
    options = options || {};
    const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
    const regexes = compilePatterns(patterns);
    if (!vfs || !vfs.files || !regexes.length) return [];
    const out = [];
    for (const [rawPath, entry] of vfs.files.entries()) {
      const path = normalizePath(rawPath);
      if (!matchesAny(regexes, path)) continue;
      if (!entry || !(entry.data instanceof Uint8Array)) continue;
      if (entry.data.length > maxFileBytes) {
        throw new Error(
          `save bundle: ${path} is ${entry.data.length} bytes, over the ` +
          `${maxFileBytes}-byte per-file limit`);
      }
      out.push({
        path,
        data: entry.data,
        attrs: entry.attrs >>> 0,
        creationTime: fileTime(entry.creationTime),
        lastAccessTime: fileTime(entry.lastAccessTime),
        lastWriteTime: fileTime(entry.lastWriteTime),
      });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  // Split lib/storage.js's flat snapshot into its two halves. The store is not
  // namespaced per app today — registry keys are machine-wide, exactly as they
  // are on a real Windows box — so a bundle carries the whole `reg:`/`ini:`
  // slice and says so, rather than pretending to a per-app split it cannot make.
  function splitStore(snapshot) {
    const registry = {};
    const ini = {};
    for (const key of Object.keys(snapshot || {})) {
      if (key.startsWith('reg:')) registry[key] = snapshot[key];
      else if (key.startsWith('ini:')) ini[key] = snapshot[key];
    }
    return { registry, ini };
  }

  // The commit the bundle was made by, read straight out of .git rather than
  // shelled out for — a library must not spawn a process. Null when unknown,
  // which is the honest answer for a deployed browser build.
  function detectCommit(root) {
    if (!isNode || typeof require !== 'function') return null;
    try {
      const fs = require('fs');
      const path = require('path');
      const base = root || path.join(__dirname, '..');
      const head = fs.readFileSync(path.join(base, '.git', 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*(.+)$/.exec(head);
      if (!ref) return /^[0-9a-f]{40}$/.test(head) ? head : null;
      const refPath = path.join(base, '.git', ...ref[1].split('/'));
      if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf8').trim();
      const packed = fs.readFileSync(path.join(base, '.git', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find(l => l.endsWith(' ' + ref[1]));
      return line ? line.split(' ')[0] : null;
    } catch (_) {
      return null;
    }
  }

  // ----------------------------------------------------------------- export

  //  exportBundle({ appId, vfs, patterns, store?, commit?, createdAt? })
  //
  // `patterns` is the app's `persistFiles` array. `store` defaults to
  // lib/storage.js's live snapshot; pass one to bundle a state you hold.
  function exportBundle(options) {
    options = options || {};
    const appId = String(options.appId || '').trim();
    if (!appId) throw new Error('save bundle: appId is required');
    const patterns = options.patterns || [];
    const createdAt = options.createdAt || new Date().toISOString();
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs)) {
      throw new Error(`save bundle: createdAt is not a date: ${createdAt}`);
    }

    const files = collectSaveFiles(options.vfs, patterns, options);
    if (files.length > (options.maxFiles || DEFAULT_MAX_FILES)) {
      throw new Error(`save bundle: ${files.length} files exceeds the bundle limit`);
    }

    const snapshot = options.store !== undefined
      ? options.store
      : storageModule(options.storageModule).exportStore();
    const split = splitStore(snapshot);
    const registryBytes = encodeUtf8(JSON.stringify(split.registry, null, 2) + '\n');
    const iniBytes = encodeUtf8(JSON.stringify(split.ini, null, 2) + '\n');

    const manifest = {
      version: BUNDLE_VERSION,
      appId,
      createdAt,
      emulator: { commit: options.commit !== undefined ? options.commit : detectCommit() },
      patterns: patterns.slice(),
      files: files.map(f => ({
        name: guestPathToMember(f.path),
        path: f.path,
        size: f.data.length,
        sha256: sha256(f.data),
        attrs: f.attrs,
        creationTime: f.creationTime,
        lastAccessTime: f.lastAccessTime,
        lastWriteTime: f.lastWriteTime,
      })),
      state: {
        registry: { name: REGISTRY_NAME, size: registryBytes.length, sha256: sha256(registryBytes) },
        ini: { name: INI_NAME, size: iniBytes.length, sha256: sha256(iniBytes) },
      },
    };

    const members = [
      { name: MANIFEST_NAME, data: encodeUtf8(JSON.stringify(manifest, null, 2) + '\n') },
      { name: REGISTRY_NAME, data: registryBytes },
      { name: INI_NAME, data: iniBytes },
    ];
    for (let i = 0; i < files.length; i++) {
      members.push({ name: manifest.files[i].name, data: files[i].data });
    }

    const bytes = writeZip(members, createdMs);
    const cap = options.maxBundleBytes || DEFAULT_MAX_BUNDLE_BYTES;
    if (bytes.length > cap) {
      throw new Error(`save bundle: ${bytes.length} bytes exceeds the ${cap}-byte cap`);
    }
    return bytes;
  }

  // ------------------------------------------------------------------- read

  // Parse and fully verify a bundle without applying anything. Returns
  // { manifest, files: [{path, member, data, ...meta}], registry, ini, bytes }.
  function readBundle(bytes, options) {
    options = options || {};
    const zip = zipMountModule();
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const cap = options.maxBundleBytes || DEFAULT_MAX_BUNDLE_BYTES;
    if (u8.length > cap) {
      throw new Error(`save bundle: ${u8.length} bytes exceeds the ${cap}-byte cap`);
    }
    const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;

    // zip-mount does the structural work and refuses Zip64, encryption and
    // unknown methods; it also CRC-checks every extraction.
    const catalog = zip.readCatalogSync(u8);
    const byName = new Map();
    for (const entry of catalog) {
      if (entry.isDirectory) continue;
      if (byName.has(entry.name)) {
        throw new Error(`save bundle: duplicate entry ${entry.name}`);
      }
      byName.set(entry.name, entry);
    }
    const extract = name => {
      const entry = byName.get(name);
      if (!entry) throw new Error(`save bundle: missing entry ${name}`);
      return zip.extractSync(u8, entry, { maxEntryBytes: maxFileBytes });
    };

    let manifest;
    try {
      manifest = JSON.parse(decodeUtf8(extract(MANIFEST_NAME)));
    } catch (e) {
      throw new Error(`save bundle: manifest.json is not readable (${e.message})`);
    }
    if (!manifest || manifest.version !== BUNDLE_VERSION) {
      throw new Error(
        `save bundle: unsupported bundle version ${manifest && manifest.version} ` +
        `(this build reads version ${BUNDLE_VERSION})`);
    }
    if (!manifest.appId) throw new Error('save bundle: manifest names no appId');
    if (!Array.isArray(manifest.files)) throw new Error('save bundle: manifest lists no files');
    if (manifest.files.length > (options.maxFiles || DEFAULT_MAX_FILES)) {
      throw new Error(`save bundle: manifest lists ${manifest.files.length} files, over the limit`);
    }

    const verified = new Set([MANIFEST_NAME]);
    const readState = (spec, label) => {
      if (!spec || !spec.name) return {};
      const data = extract(spec.name);
      const actual = sha256(data);
      if (actual !== spec.sha256) {
        throw new Error(
          `save bundle: ${label} hash mismatch (${actual} vs manifest ${spec.sha256})`);
      }
      verified.add(spec.name);
      const parsed = JSON.parse(decodeUtf8(data));
      return parsed && typeof parsed === 'object' ? parsed : {};
    };
    const state = manifest.state || {};
    const registry = readState(state.registry, 'registry.json');
    const ini = readState(state.ini, 'ini.json');

    const files = [];
    for (const spec of manifest.files) {
      const member = String(spec.name || '');
      const guestPath = memberToGuestPath(member);
      if (spec.path && normalizePath(spec.path) !== guestPath) {
        throw new Error(
          `save bundle: entry ${member} claims guest path ${spec.path}, which it does not encode`);
      }
      const data = extract(member);
      if (data.length > maxFileBytes) {
        throw new Error(`save bundle: ${member} is over the ${maxFileBytes}-byte per-file limit`);
      }
      if (Number.isFinite(spec.size) && spec.size !== data.length) {
        throw new Error(
          `save bundle: ${member} is ${data.length} bytes, the manifest declares ${spec.size}`);
      }
      const actual = sha256(data);
      if (actual !== spec.sha256) {
        throw new Error(
          `save bundle: ${member} hash mismatch (${actual} vs manifest ${spec.sha256})`);
      }
      verified.add(member);
      files.push({
        path: guestPath,
        member,
        data,
        attrs: spec.attrs >>> 0,
        creationTime: fileTime(spec.creationTime),
        lastAccessTime: fileTime(spec.lastAccessTime),
        lastWriteTime: fileTime(spec.lastWriteTime),
      });
    }

    // An entry the manifest does not cover has no hash behind it, so it is not
    // part of what was signed off — refuse rather than carry it silently.
    for (const name of byName.keys()) {
      if (!verified.has(name)) throw new Error(`save bundle: unlisted entry ${name}`);
    }

    return { manifest, files, registry, ini, bytes: u8 };
  }

  // ----------------------------------------------------------------- import

  //  importBundle(bytes, { vfs, patterns, appId, mode, allowAppMismatch, ... })
  //
  // mode 'merge'   (default) — bundle files land on top of what is there; the
  //                registry/INI keys in the bundle replace their namesakes and
  //                leave every other key alone.
  // mode 'replace' — the app's persistable paths are emptied first and the
  //                whole reg:/ini: slice is cleared before the bundle's keys go
  //                back, so nothing from the old state survives underneath.
  function importBundle(bytes, options) {
    options = options || {};
    const bundle = readBundle(bytes, options);
    const mode = options.mode || 'merge';
    if (mode !== 'merge' && mode !== 'replace') {
      throw new Error(`save bundle: unknown import mode ${mode}`);
    }
    const wantApp = options.appId ? String(options.appId) : null;
    if (wantApp && wantApp !== bundle.manifest.appId && !options.allowAppMismatch) {
      throw new Error(
        `save bundle: bundle is for app "${bundle.manifest.appId}" but "${wantApp}" is running ` +
        `(pass allowAppMismatch to load it anyway)`);
    }

    // The allow-list is the running app's globs, never the bundle's own claim:
    // a bundle that names its own patterns could name `c:\*`.
    const patterns = options.patterns || [];
    const regexes = compilePatterns(patterns);
    if (!regexes.length) {
      throw new Error(
        `save bundle: no persistFiles globs for "${wantApp || bundle.manifest.appId}", so there ` +
        `is no path this bundle is allowed to write`);
    }
    for (const file of bundle.files) {
      if (!matchesAny(regexes, file.path)) {
        throw new Error(
          `save bundle: ${file.path} is outside the app's persistFiles globs and was refused`);
      }
    }

    const vfs = options.vfs;
    const applied = [];
    if (vfs && vfs.files) {
      if (mode === 'replace') {
        for (const path of Array.from(vfs.files.keys())) {
          if (matchesAny(regexes, normalizePath(path))) vfs.files.delete(path);
        }
      }
      for (const file of bundle.files) {
        const entry = { data: file.data, attrs: file.attrs || 0x80 };
        if (file.creationTime) entry.creationTime = file.creationTime;
        if (file.lastAccessTime) entry.lastAccessTime = file.lastAccessTime;
        if (file.lastWriteTime) entry.lastWriteTime = file.lastWriteTime;
        vfs.files.set(file.path, entry);
        if (typeof vfs.ensureParentDirs === 'function') vfs.ensureParentDirs(file.path);
        else if (vfs.dirs && typeof vfs._parentDir === 'function') {
          vfs.dirs.add(vfs._parentDir(file.path));
        }
        applied.push(file.path);
      }
    }

    let storeKeys = 0;
    if (options.applyStore !== false) {
      const store = storageModule(options.storageModule);
      if (mode === 'replace') {
        if (typeof store.clearStore !== 'function') {
          throw new Error('save bundle: replace mode needs lib/storage.js clearStore()');
        }
        store.clearStore();
      }
      storeKeys = store.importStore(Object.assign({}, bundle.registry, bundle.ini));
    }

    return {
      manifest: bundle.manifest,
      files: applied,
      storeKeys,
      mode,
    };
  }

  // A human-readable summary, shared by tools/save-bundle.js and any UI.
  function inspectBundle(bytes, options) {
    const bundle = readBundle(bytes, options);
    return {
      version: bundle.manifest.version,
      appId: bundle.manifest.appId,
      createdAt: bundle.manifest.createdAt,
      commit: (bundle.manifest.emulator || {}).commit || null,
      patterns: bundle.manifest.patterns || [],
      files: bundle.files.map(f => ({ path: f.path, member: f.member, size: f.data.length })),
      totalFileBytes: bundle.files.reduce((n, f) => n + f.data.length, 0),
      registryKeys: Object.keys(bundle.registry).length,
      iniKeys: Object.keys(bundle.ini).length,
      bundleBytes: bundle.bytes.length,
    };
  }

  const api = {
    BUNDLE_VERSION,
    DEFAULT_MAX_BUNDLE_BYTES,
    DEFAULT_MAX_FILE_BYTES,
    exportBundle,
    importBundle,
    readBundle,
    inspectBundle,
    collectSaveFiles,
    detectCommit,
    guestPathToMember,
    memberToGuestPath,
    normalizePath,
    patternRegex,
    sha256,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SaveBundle = api;
})();
