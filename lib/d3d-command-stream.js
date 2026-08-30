// Ordered Direct3D immediate-mode draw transport for the experimental render
// Worker. The producer is the guest-main Worker; the consumer owns a second
// Wasm instance over the same shared WebAssembly.Memory.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.D3DCommandStream = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DRAW_OPCODE = 0x20000;
  const FENCE_OPCODE = 0x20001;
  const STATE_BYTES = 4096;
  const HEADER_BYTES = 32;
  const DEFAULT_BYTES = 2 * 1024 * 1024;
  const DEFAULT_BUFFERS = 3;
  const CTRL = {
    READY: 0, COMPLETED: 1, ERROR: 2, SUBMITTED: 3,
    BATCHES: 4, COMMANDS: 5, REPLAY_US: 6,
  };
  const align4 = value => (value + 3) & ~3;
  const nowMs = () => (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();

  class Encoder {
    constructor(options) {
      options = options || {};
      this.memory = options.memory;
      this.module = options.module;
      this.sigs = options.sigs || {};
      this.guestToWasm = options.guestToWasm;
      this.getImageBase = options.getImageBase;
      this.capacity = Math.max(STATE_BYTES + HEADER_BYTES + 32,
        options.capacity || DEFAULT_BYTES);
      this.controlBuffer = new SharedArrayBuffer(64);
      this.control = new Int32Array(this.controlBuffer);
      this.buffers = Array.from({ length: options.bufferCount || DEFAULT_BUFFERS }, () => {
        const buffer = new SharedArrayBuffer(this.capacity);
        return {
          buffer, view: new DataView(buffer), bytes: new Uint8Array(buffer),
          used: 0, commands: 0, seq: 0,
        };
      });
      this._memoryBuffer = null;
      this._memoryView = null;
      this._memoryBytes = null;
      this.current = 0;
      this.lastSubmitted = 0;
      this.stats = {
        queued: 0, submissions: 0, fences: 0, waits: 0, fallbacks: 0,
        bytes: 0, waitMs: 0, maxBatchBytes: 0,
      };
      this.worker = options.workerFactory
        ? options.workerFactory()
        : new Worker(options.workerUrl || 'd3d-render-worker.js?v=1');
      this.worker.onerror = () => {
        Atomics.store(this.control, CTRL.ERROR, 1);
        Atomics.notify(this.control, CTRL.COMPLETED);
      };
      this.worker.onmessage = event => {
        const message = event && event.data ? event.data : event;
        if (message && message.t === 'error') {
          Atomics.store(this.control, CTRL.ERROR, 1);
          Atomics.notify(this.control, CTRL.COMPLETED);
        }
      };
      this.worker.postMessage({
        t: 'init', module: this.module, memory: this.memory, sigs: this.sigs,
        control: this.controlBuffer, buffers: this.buffers.map(item => item.buffer),
      });
    }

    ready() {
      return Atomics.load(this.control, CTRL.READY) === 1
        && Atomics.load(this.control, CTRL.ERROR) === 0;
    }

    _refreshMemoryViews() {
      const buffer = this.memory.buffer;
      if (buffer !== this._memoryBuffer) {
        this._memoryBuffer = buffer;
        this._memoryView = new DataView(buffer);
        this._memoryBytes = new Uint8Array(buffer);
      }
      return buffer;
    }

    _waitFor(seq) {
      seq >>>= 0;
      const started = nowMs();
      let waited = false;
      while ((Atomics.load(this.control, CTRL.COMPLETED) >>> 0) < seq) {
        if (Atomics.load(this.control, CTRL.ERROR)) return false;
        const seen = Atomics.load(this.control, CTRL.COMPLETED);
        this.stats.waits++;
        waited = true;
        Atomics.wait(this.control, CTRL.COMPLETED, seen, 1000);
      }
      if (waited) this.stats.waitMs += nowMs() - started;
      return !Atomics.load(this.control, CTRL.ERROR);
    }

    _acquire() {
      const item = this.buffers[this.current];
      if (item.seq && (Atomics.load(this.control, CTRL.COMPLETED) >>> 0) < item.seq) {
        if (!this._waitFor(item.seq)) return null;
      }
      item.seq = 0;
      item.used = 0;
      item.commands = 0;
      return item;
    }

    _submit() {
      const item = this.buffers[this.current];
      // A rotated-to slot keeps its old bytes until _acquire resets it. Its
      // non-zero sequence means those bytes were already published; an idle
      // fence must wait for lastSubmitted, never replay this stale batch.
      if (item.seq) return this.lastSubmitted;
      if (!item.used) return this.lastSubmitted;
      const seq = (Atomics.add(this.control, CTRL.SUBMITTED, 1) + 1) >>> 0;
      item.seq = seq;
      this.lastSubmitted = seq;
      this.stats.submissions++;
      if (item.used > this.stats.maxBatchBytes) this.stats.maxBatchBytes = item.used;
      this.worker.postMessage({
        t: 'batch', index: this.current, bytes: item.used,
        commands: item.commands, seq,
        imageBase: this.getImageBase() >>> 0,
      });
      this.current = (this.current + 1) % this.buffers.length;
      return seq;
    }

    enqueue(descriptorWa) {
      if (!this.ready()) { this.stats.fallbacks++; return 0; }
      const memory = this._refreshMemoryViews();
      descriptorWa >>>= 0;
      if (descriptorWa + 24 > memory.byteLength) { this.stats.fallbacks++; return 0; }
      const descriptor = this._memoryView;
      const thisGuest = descriptor.getUint32(descriptorWa, true);
      const primitive = descriptor.getUint32(descriptorWa + 4, true);
      const vertexType = descriptor.getUint32(descriptorWa + 8, true);
      const verticesGuest = descriptor.getUint32(descriptorWa + 12, true);
      const count = descriptor.getUint32(descriptorWa + 16, true);
      const stateGuest = descriptor.getUint32(descriptorWa + 20, true);
      const vertexBytes = Number(count) * 32;
      const recordBytes = align4(HEADER_BYTES + STATE_BYTES + vertexBytes);
      if (!thisGuest || !verticesGuest || !stateGuest || !count || vertexType < 1
          || vertexType > 3 || !Number.isSafeInteger(vertexBytes)
          || vertexBytes > 0x400000 || recordBytes > this.capacity) {
        this.stats.fallbacks++;
        return 0;
      }

      let item = this.buffers[this.current];
      if (item.used + recordBytes > this.capacity) {
        this._submit();
        item = this._acquire();
        if (!item) { this.stats.fallbacks++; return 0; }
      } else if (item.seq) {
        item = this._acquire();
        if (!item) { this.stats.fallbacks++; return 0; }
      }

      const stateWa = this.guestToWasm(stateGuest) >>> 0;
      const verticesWa = this.guestToWasm(verticesGuest) >>> 0;
      if (stateWa + STATE_BYTES > memory.byteLength
          || verticesWa + vertexBytes > memory.byteLength) {
        this.stats.fallbacks++;
        return 0;
      }
      const start = item.used;
      const view = item.view;
      view.setUint32(start, recordBytes, true);
      view.setUint32(start + 4, thisGuest, true);
      view.setUint32(start + 8, primitive, true);
      view.setUint32(start + 12, vertexType, true);
      view.setUint32(start + 16, count, true);
      view.setUint32(start + 20, STATE_BYTES, true);
      view.setUint32(start + 24, vertexBytes, true);
      view.setUint32(start + 28, 0, true);
      const bytes = item.bytes;
      bytes.set(this._memoryBytes.subarray(stateWa, stateWa + STATE_BYTES), start + HEADER_BYTES);
      bytes.set(this._memoryBytes.subarray(verticesWa, verticesWa + vertexBytes),
        start + HEADER_BYTES + STATE_BYTES);
      item.used += recordBytes;
      item.commands++;
      this.stats.queued++;
      this.stats.bytes += STATE_BYTES + vertexBytes;
      // Start the consumer before the frame fence rather than accumulating a
      // whole frame and serializing simulation after rasterization.
      if (item.used >= this.capacity * 3 / 4) this._submit();
      return 1;
    }

    fence() {
      if (!this.ready()) return 0;
      this.stats.fences++;
      const target = this._submit();
      return target ? (this._waitFor(target) ? 1 : 0) : 1;
    }

    call(opcode, descriptorWa) {
      opcode |= 0;
      if (opcode === DRAW_OPCODE) return this.enqueue(descriptorWa);
      if (opcode === FENCE_OPCODE) return this.fence();
      return -1;
    }

    snapshot() {
      return Object.assign({}, this.stats, {
        replayBatches: Atomics.load(this.control, CTRL.BATCHES) >>> 0,
        replayCommands: Atomics.load(this.control, CTRL.COMMANDS) >>> 0,
        replayMs: (Atomics.load(this.control, CTRL.REPLAY_US) >>> 0) / 1000,
        ready: this.ready(),
      });
    }

    stop() {
      try { this.fence(); } catch (_) {}
      if (this.worker) this.worker.terminate();
      this.worker = null;
    }
  }

  return { DRAW_OPCODE, FENCE_OPCODE, STATE_BYTES, HEADER_BYTES, CTRL, Encoder };
});
