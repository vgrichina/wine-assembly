// Byte providers — one interface for "where the bytes actually live".
//
// Phase ① of docs/design-byo-media.md. A container mount (zip, iso9660) or a
// bare imported file names its bytes through a *provider*, and the VFS stores
// a lazy entry pointing at one instead of a materialized Uint8Array. That is
// what lets a 638MB ISO be a drive letter without a 638MB allocation.
//
// A provider is the smallest thing that can answer "give me these bytes":
//
//   {
//     size: Number,                                  // total bytes
//     readRange(off, len) -> Promise<Uint8Array>,    // always present
//     readRangeSync(off, len) -> Uint8Array | null,  // optional fast path
//   }
//
// `readRangeSync` is what a Node fd or an already-resident buffer can do and a
// `fetch` cannot. Callers must treat its absence — and a null return — as
// "ask asynchronously", never as "no bytes": the guest's ReadFile is
// synchronous WAT, so a miss has to surface as a distinguishable *pending*
// result that parks the guest, not as a silent short read.
//
// `ChunkCache` is the piece that makes that affordable. It slices a provider
// into fixed 256KB chunks with an LRU bound and read-ahead, so an app reading
// a file front to back pays one async round trip per chunk rather than one per
// ReadFile. Its `tryRead` is the synchronous cache-hit path the guest takes
// almost always; `fill` is the async miss path the host runs while the guest
// is parked.
//
// Dual-environment on purpose (module.exports + window.byteProvider, same as
// lib/vfs-persistence.js): the CLI harness and the browser mount identical
// containers, which is what keeps `test/run.js --zip=`/`--iso=` honest
// coverage of the browser path.
(function () {
  'use strict';

  const DEFAULT_CHUNK_SIZE = 256 * 1024;
  // 64 chunks of 256KB = 16MB resident per open container. Era media reads in
  // long forward runs, so the bound is about not pinning a whole ISO, not
  // about hit rate.
  const DEFAULT_MAX_CHUNKS = 64;

  function safeInteger(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new RangeError(`${label} must be a safe integer (got ${value})`);
    }
    return number;
  }

  function safeSize(value, label) {
    const number = safeInteger(value, label);
    if (number < 0) throw new RangeError(`${label} must be non-negative (got ${value})`);
    return number;
  }

  function clampRange(size, off, len) {
    const bound = safeSize(size, 'provider size');
    const requestedStart = safeInteger(off, 'range offset');
    const requestedLength = safeInteger(len, 'range length');
    const start = Math.max(0, Math.min(bound, requestedStart));
    const count = Math.min(Math.max(0, requestedLength), bound - start);
    return { start, end: start + count, len: count };
  }

  // ---- providers ---------------------------------------------------------

  // Bytes already in memory. The degenerate provider: every read is a hit, so
  // a mount backed by one never yields. Useful for small entries (an inflated
  // zip member), for archives nested inside an already-resident buffer, and as
  // the control arm in tests.
  class BytesProvider {
    constructor(bytes, name) {
      this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.size = this.bytes.length;
      this.name = name || '<bytes>';
    }
    readRangeSync(off, len) {
      const r = clampRange(this.size, off, len);
      return this.bytes.subarray(r.start, r.end);
    }
    readRange(off, len) {
      return Promise.resolve(this.readRangeSync(off, len));
    }
    close() {}
  }

  // A sub-range of another provider, presented as a provider in its own right.
  // An ISO file is (LBA*2048, length) inside the image; a stored zip member is
  // (localHeaderEnd, compressedSize) inside the archive. Both are this.
  class SliceProvider {
    constructor(parent, offset, length, name) {
      this.parent = parent;
      const parentSize = safeSize(parent.size, 'SliceProvider parent size');
      this.offset = Math.max(0, safeInteger(offset, 'SliceProvider offset'));
      const avail = Math.max(0, parentSize - this.offset);
      this.size = length === undefined ? avail
        : Math.min(avail, Math.max(0, safeInteger(length, 'SliceProvider length')));
      this.name = name || ((parent.name || '<slice>') + '+' + this.offset);
    }
    readRangeSync(off, len) {
      if (!this.parent.readRangeSync) return null;
      const r = clampRange(this.size, off, len);
      return this.parent.readRangeSync(this.offset + r.start, r.len);
    }
    readRange(off, len) {
      const r = clampRange(this.size, off, len);
      return this.parent.readRange(this.offset + r.start, r.len);
    }
    close() {}
  }

  // Node fs, positional reads off one fd. The CLI fast path: `readRangeSync`
  // is a real `fs.readSync`, so a headless run of a lazily-mounted container
  // never parks the guest at all.
  //
  // `{sync: false}` suppresses that fast path so the *async* machinery — the
  // pending result, the IO_WAIT yield, the retried read — runs in the CLI too.
  // Without it the yield path would ship untested, since the browser is the
  // only place it would ever fire.
  class NodeFileProvider {
    constructor(path, opts) {
      const options = opts || {};
      // Required lazily so this file stays loadable in the browser, where
      // there is no fs to read from.
      const fs = require('fs');
      this._fs = fs;
      this.path = path;
      this.name = path;
      this.fd = fs.openSync(path, 'r');
      this.size = safeSize(fs.fstatSync(this.fd).size, 'Node file size');
      this._sync = options.sync !== false;
    }
    _readAt(off, len) {
      const r = clampRange(this.size, off, len);
      const out = new Uint8Array(r.len);
      let got = 0;
      while (got < r.len) {
        const n = this._fs.readSync(this.fd, out, got, r.len - got, r.start + got);
        if (n <= 0) break;
        got += n;
      }
      return got === r.len ? out : out.subarray(0, got);
    }
    readRangeSync(off, len) {
      if (!this._sync) return null;
      return this._readAt(off, len);
    }
    readRange(off, len) {
      // Still one readSync under the hood — the point of the promise is the
      // event-loop turn, which is what the yield path needs to exercise.
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try { resolve(this._readAt(off, len)); } catch (e) { reject(e); }
        }, 0);
      });
    }
    close() {
      if (this.fd !== null && this.fd !== undefined) {
        try { this._fs.closeSync(this.fd); } catch (_) {}
        this.fd = null;
      }
    }
  }

  // A browser File/Blob. `slice()` is zero-copy until `arrayBuffer()` is
  // awaited, so a dropped 638MB ISO costs nothing until something reads it —
  // this is the "session only" import in the design doc.
  class BlobProvider {
    constructor(blob, name) {
      this.blob = blob;
      this.size = safeSize(blob.size, 'Blob size');
      this.name = name || blob.name || '<blob>';
    }
    readRangeSync() { return null; }
    readRange(off, len) {
      const r = clampRange(this.size, off, len);
      if (!r.len) return Promise.resolve(new Uint8Array(0));
      return this.blob.slice(r.start, r.end).arrayBuffer()
        .then(ab => new Uint8Array(ab));
    }
    close() {}
  }

  // HTTP Range. `open()` is async because the size comes from the server:
  // a HEAD, or a one-byte GET when HEAD is not allowed. A server without
  // `Accept-Ranges: bytes` is rejected loudly rather than silently degraded to
  // whole-file downloads — a 600MB surprise download is worse than an error.
  class HttpRangeProvider {
    constructor(url, size, opts) {
      const options = opts || {};
      this.url = url;
      this.size = safeSize(size, 'HTTP resource size');
      this.name = options.name || url.replace(/^.*\//, '') || url;
      this._fetch = options.fetch ||
        (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      if (!this._fetch) throw new Error('HttpRangeProvider: no fetch available');
    }
    static open(url, opts) {
      const options = opts || {};
      const doFetch = options.fetch ||
        (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      if (!doFetch) return Promise.reject(new Error('HttpRangeProvider: no fetch available'));
      return doFetch(url, { method: 'HEAD' }).then(res => {
        if (!res.ok) throw new Error(`HttpRangeProvider: HEAD ${url} → ${res.status}`);
        const ranges = res.headers.get('accept-ranges');
        if (!ranges || ranges.toLowerCase() === 'none') {
          throw new Error(`HttpRangeProvider: ${url} does not advertise Accept-Ranges`);
        }
        const len = parseInt(res.headers.get('content-length') || '', 10);
        if (!(len >= 0)) throw new Error(`HttpRangeProvider: ${url} has no Content-Length`);
        return new HttpRangeProvider(url, len, options);
      });
    }
    readRangeSync() { return null; }
    readRange(off, len) {
      const r = clampRange(this.size, off, len);
      if (!r.len) return Promise.resolve(new Uint8Array(0));
      return this._fetch(this.url, {
        headers: { Range: `bytes=${r.start}-${r.end - 1}` },
      }).then(res => {
        // 206 is the contract. A 200 means the server ignored the header and
        // is sending the whole file; say so instead of quietly mis-slicing.
        if (res.status !== 206) {
          throw new Error(`HttpRangeProvider: ${this.url} answered ${res.status}, expected 206`);
        }
        return res.arrayBuffer();
      }).then(ab => new Uint8Array(ab));
    }
    close() {}
  }

  // ---- chunk cache -------------------------------------------------------

  // Fixed-size chunks with an LRU bound and forward read-ahead. Presents the
  // same provider shape as what it wraps, plus the two methods the VFS read
  // path actually wants:
  //
  //   tryRead(off, len) -> Uint8Array | null    null == miss, go ask
  //   fill(off, len)    -> Promise              satisfy that miss
  //
  // `tryRead` returns a fresh Uint8Array when a read straddles two chunks, and
  // a subarray view when it does not — callers must not retain it across a
  // later `fill`, which is fine because every caller copies into guest memory
  // immediately.
  class ChunkCache {
    constructor(provider, opts) {
      const options = opts || {};
      this.provider = provider;
      this.size = safeSize(provider.size, 'ChunkCache provider size');
      this.name = provider.name;
      this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
      this.maxChunks = options.maxChunks || DEFAULT_MAX_CHUNKS;
      // How many chunks past the requested one to pull in the same round trip.
      // Era media is read front to back; one extra chunk halves the yields on
      // a linear scan for one extra chunk of latency-free bytes.
      this.readAhead = options.readAhead === undefined ? 1 : options.readAhead;
      this._chunks = new Map();  // index → Uint8Array (Map iteration order = LRU)
      this._inflight = new Map(); // index → Promise
      this.stats = { hits: 0, misses: 0, fetches: 0, bytesFetched: 0 };
    }

    _touch(idx, bytes) {
      // Re-insert to move to the young end of the Map's insertion order.
      if (this._chunks.has(idx)) this._chunks.delete(idx);
      this._chunks.set(idx, bytes);
      while (this._chunks.size > this.maxChunks) {
        const oldest = this._chunks.keys().next();
        if (oldest.done) break;
        this._chunks.delete(oldest.value);
      }
    }

    _get(idx) {
      const bytes = this._chunks.get(idx);
      if (bytes === undefined) return undefined;
      this._touch(idx, bytes);
      return bytes;
    }

    _chunkSync(idx) {
      if (!this.provider.readRangeSync) return null;
      const start = idx * this.chunkSize;
      const bytes = this.provider.readRangeSync(start, Math.min(this.chunkSize, this.size - start));
      if (!bytes) return null;
      // Copy: a provider may hand back a view of a buffer it will reuse.
      const owned = new Uint8Array(bytes);
      this._touch(idx, owned);
      this.stats.fetches++;
      this.stats.bytesFetched += owned.length;
      return owned;
    }

    // Synchronous read. Returns null on a miss — never a short read, so a
    // caller can never mistake "not here yet" for "end of file".
    tryRead(off, len) {
      const r = clampRange(this.size, off, len);
      if (!r.len) return new Uint8Array(0);
      const first = Math.floor(r.start / this.chunkSize);
      const last = Math.floor((r.end - 1) / this.chunkSize);
      const parts = [];
      for (let idx = first; idx <= last; idx++) {
        let bytes = this._get(idx);
        if (bytes === undefined) bytes = this._chunkSync(idx);
        if (!bytes) { this.stats.misses++; return null; }
        parts.push(bytes);
      }
      this.stats.hits++;
      if (first === last) {
        const base = first * this.chunkSize;
        return parts[0].subarray(r.start - base, r.end - base);
      }
      const out = new Uint8Array(r.len);
      let written = 0;
      for (let idx = first; idx <= last; idx++) {
        const base = idx * this.chunkSize;
        const from = Math.max(r.start, base) - base;
        const to = Math.min(r.end, base + this.chunkSize) - base;
        out.set(parts[idx - first].subarray(from, to), written);
        written += to - from;
      }
      return out;
    }

    _fetchChunk(idx) {
      const existing = this._inflight.get(idx);
      if (existing) return existing;
      const start = idx * this.chunkSize;
      const want = Math.min(this.chunkSize, Math.max(0, this.size - start));
      const p = Promise.resolve(this.provider.readRange(start, want)).then(bytes => {
        const owned = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes || 0);
        this._touch(idx, owned);
        this._inflight.delete(idx);
        this.stats.fetches++;
        this.stats.bytesFetched += owned.length;
        return owned;
      }, err => {
        this._inflight.delete(idx);
        throw err;
      });
      this._inflight.set(idx, p);
      return p;
    }

    // Asynchronously make `tryRead(off, len)` succeed. Pulls `readAhead`
    // extra chunks in the same turn.
    fill(off, len) {
      const r = clampRange(this.size, off, len);
      if (!r.len) return Promise.resolve();
      const first = Math.floor(r.start / this.chunkSize);
      const last = Math.floor((r.end - 1) / this.chunkSize);
      const lastPossible = this.size ? Math.floor((this.size - 1) / this.chunkSize) : 0;
      const stop = Math.min(lastPossible, last + this.readAhead);
      const pending = [];
      for (let idx = first; idx <= stop; idx++) {
        if (this._chunks.has(idx)) continue;
        pending.push(this._fetchChunk(idx));
      }
      return Promise.all(pending).then(() => undefined);
    }

    // Provider shape, so a ChunkCache can itself back a mount or be sliced.
    readRangeSync(off, len) { return this.tryRead(off, len); }
    readRange(off, len) {
      const hit = this.tryRead(off, len);
      if (hit) return Promise.resolve(hit);
      return this.fill(off, len).then(() => {
        const bytes = this.tryRead(off, len);
        if (!bytes) throw new Error('ChunkCache: fill did not satisfy read');
        return bytes;
      });
    }
    close() { if (this.provider.close) this.provider.close(); }
  }

  // Wrap anything provider-shaped in a cache unless it already is one.
  function cached(provider, opts) {
    if (provider instanceof ChunkCache) return provider;
    return new ChunkCache(provider, opts);
  }

  const api = {
    DEFAULT_CHUNK_SIZE,
    DEFAULT_MAX_CHUNKS,
    BytesProvider,
    SliceProvider,
    NodeFileProvider,
    BlobProvider,
    HttpRangeProvider,
    ChunkCache,
    cached,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.byteProvider = api;
})();
