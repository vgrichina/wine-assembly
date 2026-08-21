// ThreadManager: multi-instance threading for wine-assembly
// Each WASM instance = one thread, sharing the same linear memory.

// 4 was 'help_load' and is not in this map because no WAT or JS path ever sets
// it — the help engine fetches through host imports instead of parking the
// guest. Leaving it listed made worker mode look like it had two async yields
// left to port when it had one.
const YIELD_NAMES = { 1: 'wait', 2: 'exit', 3: 'com_load_dll', 5: 'load_library', 6: 'modal_dialog', 7: 'message_wait', 8: 'net_wait', 9: 'critical_section', 10: 'send_message' };

class ThreadManager {
  constructor(wasmModule, memory, mainInstance, makeImports, opts) {
    this.module = wasmModule;
    this.memory = memory;
    this.mainInstance = mainInstance;
    this.makeImports = makeImports; // (threadId) => imports object

    this.threads = new Map(); // handle → { instance, state, startAddr, param, stackSize }
    this._nextHandle = 0xE1000;
    this._pendingThreads = []; // threads awaiting spawn
    // Set when a worker parks on net_wait; the caller clears it after
    // yielding to the host event loop so inbound frames can land.
    this.netWaitPending = false;
    this._spawnedCount = 0; // total threads ever spawned
    this._maxWorkerThreads = 7; // fixed decoded-cache layout reserves worker slots 1..7
    this._log = (typeof console !== 'undefined') ? console.log.bind(console) : () => {};
    this._quietTM = (typeof process !== 'undefined' && process.env && process.env.QUIET_TM) ? true : false;
    opts = opts || {};
    this._traceThread = !!opts.traceThread;
    this._traceYield = !!opts.traceYield;
    this._onThreadEvent = typeof opts.onThreadEvent === 'function' ? opts.onThreadEvent : null;
    this._recordThreadEvents = !!(opts.recordThreadEvents || this._traceThread || this._onThreadEvent);
    this._threadEventSequence = 0;
    this._threadEvents = [];
    this._onThreadExit = typeof opts.onThreadExit === 'function' ? opts.onThreadExit : null;
    this._breakThreadFilter = (opts.breakThreadFilter == null) ? null : opts.breakThreadFilter|0;
    this._traceCallstack = !!opts.traceCallstack;
    this._traceCallstackDepth = opts.traceCallstackDepth || 16;
    this._traceEipRange = opts.traceEipRange || null;
    this._hasMessage = typeof opts.hasMessage === 'function' ? opts.hasMessage : null;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._profileThreadRun = typeof opts.profileThreadRun === 'function' ? opts.profileThreadRun : null;
    this._resolveThreadSendExternalYield = typeof opts.resolveThreadSendExternalYield === 'function'
      ? opts.resolveThreadSendExternalYield : null;
    this._audioThreadHotUntil = new Map();
    this._audioPriorityNextHotFirst = true;

    // Which scheduler is actually in charge, and it is a readout rather than a
    // promise: a UI switch that says "threads on" while this reads 'cooperative'
    // would be reporting a lie.
    //
    //   'cooperative'  guest threads are separate WASM instances round-robined
    //                  on this JS thread. Permanent — it is the CLI default and
    //                  the fallback wherever isolation is unavailable (§3.6).
    //   'worker'       one Worker per guest thread, all running at once. Needs
    //                  a GuestThreadHost, which needs cross-origin isolation.
    this.workerBackend = opts.workerBackend || null;
    this.serialSlices = !!opts.serialSlices;   // debug: never run two guest threads at once
    this.csStealAfter = opts.csStealAfter | 0;  // 0 = keep the WAT's own default
    this.backend = this.workerBackend ? 'worker' : 'cooperative';
    // RPC slot → thread handle. ExitThread takes no arguments: the cooperative
    // backend knows who called it because it called run() on that instance a
    // moment ago, and the worker backend has to be told, because the caller is
    // not on this thread at all.
    this._slotToHandle = new Map();
    if (this.workerBackend) {
      this.workerBackend.threadManager = this;
      this.workerBackend.onRpcSlot = slot => {
        this._runningThreadHandle = this._slotToHandle.get(slot | 0) || 0;
      };
      this.workerBackend.onRpcSlotEnd = () => { this._runningThreadHandle = 0; };
    }
    this.threadsRequested = !!opts.threadsRequested;
    // addr => "0x… (module+0x…)". A trapped worker reports a raw EIP, and in a
    // DLL that number depends on load order, so it differs run to run and lines
    // up with no disassembly. Falls back to plain hex when the host has no map.
    this._describeAddr = opts.describeAddr || (addr => `0x${(addr >>> 0).toString(16)}`);
    if (this.threadsRequested && !this.workerBackend) {
      this._log('[ThreadManager] real threads requested but no worker backend was supplied; '
        + 'running the cooperative scheduler.');
    }
    // Set by the worker backend once per launch, because in worker mode the
    // main-thread instance never loaded the PE and cannot answer for it.
    this._peMeta = null;

    // Synchronization table (SharedArrayBuffer backed)
    this.syncTableAddr = mainInstance.exports.get_sync_table();
    this.syncView = new Int32Array(memory.buffer, this.syncTableAddr, 64 * 4); // 64 objects, 4 ints each
    // Names and reference counts are process metadata rather than guest-visible
    // synchronization state. Every cooperative WASM instance shares this one
    // manager, matching Win32's process-local named-object namespace.
    this._syncRefs = new Uint32Array(64);
    this._syncNames = new Array(64).fill(null);
    this._namedEvents = new Map();
  }

  _emitThreadEvent(type, details) {
    const event = Object.assign({
      sequence: ++this._threadEventSequence,
      type: String(type || ''),
    }, details || {});
    if (this._recordThreadEvents) this._threadEvents.push(event);
    if (this._traceThread) this._log(`[thread-event] ${JSON.stringify(event)}`);
    if (this._onThreadEvent) {
      try {
        this._onThreadEvent(Object.assign({}, event));
      } catch (err) {
        this._log(`[ThreadManager] onThreadEvent failed: ${err && err.message ? err.message : err}`);
      }
    }
    return event;
  }

  getThreadEvents() {
    return this._threadEvents.map(event => Object.assign({}, event));
  }

  markAudioThread(tid, hotMs) {
    tid = tid | 0;
    if (tid <= 0) return;
    const ms = Math.max(250, (hotMs | 0) || 1000);
    this._audioThreadHotUntil.set(tid, this._now() + ms);
  }

  _threadEntries(options) {
    const entries = Array.from(this.threads.entries());
    const preferTarget = ordered => {
      const preferred = options && (options.preferredThreadHandle >>> 0);
      if (!preferred) return ordered;
      const index = ordered.findIndex(([handle]) => (handle >>> 0) === preferred);
      if (index > 0) ordered.unshift(ordered.splice(index, 1)[0]);
      return ordered;
    };
    if (!options || !options.prioritizeAudioThreads || !this._audioThreadHotUntil.size) {
      return preferTarget(entries);
    }
    const now = this._now();
    for (const [tid, until] of Array.from(this._audioThreadHotUntil.entries())) {
      if (until <= now) this._audioThreadHotUntil.delete(tid);
    }
    if (!this._audioThreadHotUntil.size) return preferTarget(entries);
    return preferTarget(entries.sort((a, b) => {
      const aHot = this._audioThreadHotUntil.has((a[1] && a[1].tid) | 0) ? 1 : 0;
      const bHot = this._audioThreadHotUntil.has((b[1] && b[1].tid) | 0) ? 1 : 0;
      return bHot - aHot;
    }));
  }

  _hasHotAudioThreads() {
    if (!this._audioThreadHotUntil.size) return false;
    const now = this._now();
    for (const [tid, until] of Array.from(this._audioThreadHotUntil.entries())) {
      if (until <= now) this._audioThreadHotUntil.delete(tid);
    }
    return this._audioThreadHotUntil.size > 0;
  }

  _hasPendingMessage(exports) {
    if (exports && exports.has_pending_message) {
      try {
        if (exports.has_pending_message() | 0) return true;
      } catch (_) {}
    }
    if (this._hasMessage) {
      try {
        if (this._hasMessage()) return true;
      } catch (_) {}
    }
    return false;
  }

  _readWaitReturnAddress(exports) {
    let retAddr = exports.guest_read32(exports.get_esp()) >>> 0;
    const codeStart = exports.get_code_start ? (exports.get_code_start() >>> 0) : 0;
    const codeEnd = exports.get_code_end ? (exports.get_code_end() >>> 0) : 0;
    if (codeStart && codeEnd && (retAddr < codeStart || retAddr >= codeEnd) && exports.get_dbg_prev_eip) {
      const prev = exports.get_dbg_prev_eip() >>> 0;
      const imageBase = exports.get_image_base ? (exports.get_image_base() >>> 0) : 0;
      if (prev >= codeStart && prev < codeEnd && imageBase) {
        const mem8 = new Uint8Array(this.memory.buffer);
        const start = (prev - imageBase + 0x12000) >>> 0;
        for (let off = 0; off < 16 && start + off + 5 < mem8.length; off++) {
          if (mem8[start + off] === 0xFF && mem8[start + off + 1] === 0x15) {
            retAddr = (prev + off + 6) >>> 0;
            break;
          }
          if (mem8[start + off] === 0xE8) {
            retAddr = (prev + off + 5) >>> 0;
            break;
          }
        }
      }
    }
    return retAddr;
  }

  _completeWait(exports, result, waitStackBytes) {
    const retAddr = this._readWaitReturnAddress(exports);
    exports.clear_yield();
    exports.set_eax(result);
    exports.set_esp(exports.get_esp() + waitStackBytes);
    exports.set_eip(retAddr);
    return retAddr;
  }

  // Get index into sync table from handle
  _getSyncIdx(handle) {
    if (handle >= 0xE0000 && handle < 0xE0000 + 64) return handle - 0xE0000;
    return -1;
  }

  // Called from WASM host import
  createThread(startAddr, param, stackSize, creationFlags) {
    creationFlags = creationFlags >>> 0;
    const tid = this._allocWorkerSlot();
    if (!tid) {
      this._log(`[ThreadManager] CreateThread failed: no decoded-cache slot for start=0x${startAddr.toString(16)}`);
      return 0;
    }
    const handle = this._nextHandle++;
    this._dropExitedSlotHandles(tid);
    const suspendCount = (creationFlags & 0x4) ? 1 : 0;
    const resolvedStackSize = stackSize || 0x10000;
    this._pendingThreads.push({
      handle, tid, startAddr, param, stackSize: resolvedStackSize,
      creationFlags, suspendCount,
    });
    this._log(`[ThreadManager] CreateThread handle=0x${handle.toString(16)} start=0x${startAddr.toString(16)} param=0x${param.toString(16)} flags=0x${creationFlags.toString(16)} suspendCount=${suspendCount}`);
    this._emitThreadEvent('create', {
      handle: handle >>> 0,
      tid: tid | 0,
      startAddr: startAddr >>> 0,
      param: param >>> 0,
      stackSize: resolvedStackSize >>> 0,
      creationFlags,
      suspendCount,
    });
    return handle;
  }

  suspendThread(handle) {
    handle = handle >>> 0;
    const thread = this.threads.get(handle) || this._pendingThreads.find(pending => (pending.handle >>> 0) === handle);
    if (!thread || thread.state === 'exited') return 0xFFFFFFFF;
    const previous = (thread.suspendCount || 0) >>> 0;
    // Win32 exposes MAXIMUM_SUSPEND_COUNT as 0x7f. Refuse the increment at
    // the limit instead of wrapping and accidentally making the thread run.
    if (previous >= 0x7f) return 0xFFFFFFFF;
    thread.suspendCount = previous + 1;
    this._log(`[ThreadManager] SuspendThread handle=0x${handle.toString(16)} previous=${previous} current=${thread.suspendCount}`);
    this._emitThreadEvent('suspend', {
      handle,
      tid: (thread.tid || 0) | 0,
      previousSuspendCount: previous,
      suspendCount: thread.suspendCount >>> 0,
    });
    return previous;
  }

  resumeThread(handle) {
    handle = handle >>> 0;
    const thread = this.threads.get(handle) || this._pendingThreads.find(pending => (pending.handle >>> 0) === handle);
    if (!thread || thread.state === 'exited') return 0xFFFFFFFF;
    const previous = (thread.suspendCount || 0) >>> 0;
    if (previous > 0) thread.suspendCount = previous - 1;
    this._log(`[ThreadManager] ResumeThread handle=0x${handle.toString(16)} previous=${previous} current=${thread.suspendCount || 0}`);
    this._emitThreadEvent('resume', {
      handle,
      tid: (thread.tid || 0) | 0,
      previousSuspendCount: previous,
      suspendCount: (thread.suspendCount || 0) >>> 0,
    });
    return previous;
  }

  _allocWorkerSlot() {
    const used = new Set();
    for (const [, thread] of this.threads) {
      if (thread.state !== 'exited') used.add(thread.tid);
    }
    for (const pending of this._pendingThreads) {
      if (pending.tid) used.add(pending.tid);
    }
    for (let tid = 1; tid <= this._maxWorkerThreads; tid++) {
      if (!used.has(tid)) return tid;
    }
    return 0;
  }

  _dropExitedSlotHandles(tid) {
    // Thread cache slots are reusable once a thread exits. Our Win32 handle
    // model already treats unknown thread handles as signaled, so dropping the
    // old bookkeeping here frees the slot without changing wait behavior.
    for (const [handle, thread] of this.threads) {
      if (thread.tid === tid && thread.state === 'exited') {
        this.threads.delete(handle);
      }
    }
  }

  _clearWorkerCacheSlot(tid) {
    // WAT partitions decoded-block indexes by worker slot:
    //   0x07152000 + tid * 0x8000, 4096 entries * 8 bytes.
    // Reusing a slot with a stale index can jump a fresh worker instance into
    // decoded blocks emitted for the prior thread's execution path.
    const cacheIndex = 0x07152000 + tid * 0x8000;
    const cacheBytes = 0x8000;
    if (cacheIndex + cacheBytes <= this.memory.buffer.byteLength) {
      new Uint8Array(this.memory.buffer, cacheIndex, cacheBytes).fill(0);
    }
  }

  exitThread(exitCode) {
    // The WASM side sets yield_reason=2/eip=0 after this host call, but guest
    // code on another thread can query the handle before the scheduler sees
    // that yield. Record the exit synchronously so GetExitCodeThread and waits
    // observe the same state Windows would expose after ExitThread.
    const handle = this._runningThreadHandle;
    const t = handle ? this.threads.get(handle) : null;
    if (t) {
      this._markThreadExited(handle, t, exitCode, 'ExitThread');
    }
  }

  _markThreadExited(handle, thread, exitCode, reason) {
    if (!thread) return;
    const wasExited = thread.state === 'exited';
    thread.state = 'exited';
    thread.exitCode = exitCode == null ? ((thread.exitCode || 0) >>> 0) : (exitCode >>> 0);
    this._audioThreadHotUntil.delete((thread.tid || 0) | 0);
    if (!wasExited) {
      // A critical section this thread still owns is not held, it is lost, and
      // every waiter parks on it forever. This is the one moment when the owner
      // is KNOWN to be gone, which is what makes releasing here defensible where
      // guessing from a timeout was not. It covers the case no guest can clean up
      // after either: a thread that ended by trapping.
      //
      // Runs on whichever instance is to hand — the registry holds WASM
      // addresses, so no image-base translation is involved — and takes
      // $current_thread_id, which for a spawned thread is tid+1.
      const ex = this.mainInstance && this.mainInstance.exports;
      if (ex && ex.release_cs_owned_by) {
        const freed = ex.release_cs_owned_by(((thread.tid || 0) | 0) + 1) | 0;
        if (freed) {
          this._log(`[ThreadManager] thread ${thread.tid} ended owning ${freed} `
            + `critical section(s) (${reason || 'exit'}); released`);
        }
      }
      this._emitThreadEvent('exit', {
        handle: handle >>> 0,
        tid: (thread.tid || 0) | 0,
        startAddr: (thread.startAddr || 0) >>> 0,
        exitCode: thread.exitCode >>> 0,
        reason: reason || 'exit',
      });
    }
    if (!thread._exitNotified && this._onThreadExit) {
      thread._exitNotified = true;
      try {
        this._onThreadExit({
          handle: handle >>> 0,
          tid: thread.tid | 0,
          startAddr: thread.startAddr >>> 0,
          param: thread.param >>> 0,
          exitCode: thread.exitCode >>> 0,
          reason: reason || 'exit',
        });
      } catch (err) {
        this._log(`[ThreadManager] onThreadExit failed: ${err && err.message ? err.message : err}`);
      }
    }
  }

  getExitCodeThread(handle) {
    const t = this.threads.get(handle) || this._pendingThreads.find(pending => (pending.handle >>> 0) === (handle >>> 0));
    if (!t) return 0;
    return t.state === 'exited' ? (t.exitCode >>> 0) : 0x103; // STILL_ACTIVE
  }

  createEvent(manualReset, initialState, name) {
    name = name ? String(name) : '';
    if (name) {
      const existing = this._namedEvents.get(name);
      const existingIdx = existing == null ? -1 : this._getSyncIdx(existing);
      if (existingIdx >= 0 && Atomics.load(this.syncView, existingIdx * 4 + 1) === 1) {
        this._syncRefs[existingIdx]++;
        return existing >>> 0;
      }
      // A freed table slot must never leave a stale name behind.
      this._namedEvents.delete(name);
    }
    // Find free slot in sync table
    let idx = -1;
    for (let i = 0; i < 64; i++) {
      if (this.syncView[i * 4 + 1] === 0) { // Type=0 (Free)
        idx = i;
        break;
      }
    }
    if (idx === -1) return 0;

    const handle = 0xE0000 | idx;
    this.syncView[idx * 4 + 0] = 0; // Lock
    this.syncView[idx * 4 + 1] = 1; // Type=1 (Event)
    this.syncView[idx * 4 + 2] = initialState ? 1 : 0; // State
    this.syncView[idx * 4 + 3] = manualReset ? 1 : 0; // ManualReset
    this._syncRefs[idx] = 1;
    this._syncNames[idx] = name || null;
    if (name) this._namedEvents.set(name, handle);

    this._log(`[ThreadManager] CreateEvent handle=0x${handle.toString(16)} idx=${idx} manual=${!!manualReset} initial=${!!initialState}${name ? ` name=${name}` : ''}`);
    return handle;
  }

  openEvent(name) {
    name = name ? String(name) : '';
    if (!name) return 0;
    const handle = this._namedEvents.get(name);
    const idx = handle == null ? -1 : this._getSyncIdx(handle);
    if (idx < 0 || Atomics.load(this.syncView, idx * 4 + 1) !== 1) {
      this._namedEvents.delete(name);
      return 0;
    }
    this._syncRefs[idx]++;
    return handle >>> 0;
  }

  // CloseHandle releases the caller's reference to a kernel synchronization
  // object. Storm creates short-lived event triplets while streaming Diablo's
  // MPQ, so the final close must recycle the fixed table slot. Named opens can
  // add references; an intermediate close must leave their shared object live.
  closeSyncHandle(handle) {
    const idx = this._getSyncIdx(handle >>> 0);
    if (idx < 0 || Atomics.load(this.syncView, idx * 4 + 1) === 0) return false;
    if (this._syncRefs[idx] > 1) {
      this._syncRefs[idx]--;
      return true;
    }
    const name = this._syncNames[idx];
    if (name && this._namedEvents.get(name) === (handle >>> 0)) {
      this._namedEvents.delete(name);
    }
    this._syncRefs[idx] = 0;
    this._syncNames[idx] = null;
    Atomics.store(this.syncView, idx * 4 + 0, 0); // lock
    Atomics.store(this.syncView, idx * 4 + 2, 0); // event state / semaphore count
    Atomics.store(this.syncView, idx * 4 + 3, 0); // manual reset / maximum count
    // Publish Type=Free last so an allocator cannot observe a half-cleared slot.
    Atomics.store(this.syncView, idx * 4 + 1, 0);
    return true;
  }

  setEvent(handle) {
    const idx = this._getSyncIdx(handle);
    if (idx >= 0 && this.syncView[idx * 4 + 1] === 1) {
      // Set state to signaled (1) and wake up any waiters
      Atomics.store(this.syncView, idx * 4 + 2, 1);
      Atomics.notify(this.syncView, idx * 4 + 2);
      if (!this._quietTM) this._log(`[ThreadManager] SetEvent 0x${handle.toString(16)}`);
    }
    return 1;
  }

  resetEvent(handle) {
    const idx = this._getSyncIdx(handle);
    if (idx >= 0 && this.syncView[idx * 4 + 1] === 1) {
      Atomics.store(this.syncView, idx * 4 + 2, 0);
    }
    return 1;
  }

  // Semaphore: Type=2, slot[2]=current count, slot[3]=max count.
  // Wait succeeds by atomically decrementing count when count > 0.
  createSemaphore(initialCount, maxCount) {
    let idx = -1;
    for (let i = 0; i < 64; i++) {
      if (this.syncView[i * 4 + 1] === 0) { idx = i; break; }
    }
    if (idx === -1) return 0;
    const handle = 0xE0000 | idx;
    this.syncView[idx * 4 + 0] = 0;
    this.syncView[idx * 4 + 1] = 2;                          // Type=Semaphore
    this.syncView[idx * 4 + 2] = initialCount | 0;           // count
    this.syncView[idx * 4 + 3] = (maxCount | 0) || 0x7FFFFFFF; // max
    this._log(`[ThreadManager] CreateSemaphore handle=0x${handle.toString(16)} init=${initialCount} max=${maxCount}`);
    return handle;
  }

  releaseSemaphore(handle, releaseCount, lpPrevCountWA) {
    const idx = this._getSyncIdx(handle);
    if (idx < 0 || this.syncView[idx * 4 + 1] !== 2) return 0;
    const max = this.syncView[idx * 4 + 3];
    while (true) {
      const cur = Atomics.load(this.syncView, idx * 4 + 2);
      const next = cur + releaseCount;
      if (next > max) return 0;                              // would overflow → fail
      if (Atomics.compareExchange(this.syncView, idx * 4 + 2, cur, next) === cur) {
        if (lpPrevCountWA) {
          new Int32Array(this.memory.buffer)[lpPrevCountWA >>> 2] = cur;
        }
        Atomics.notify(this.syncView, idx * 4 + 2, releaseCount);
        return 1;
      }
    }
  }

  waitSingle(handle, timeout) {
    timeout = timeout >>> 0;
    const idx = this._getSyncIdx(handle);
    if (idx >= 0 && this.syncView[idx * 4 + 1] === 2) {
      // Semaphore: try to decrement count; CAS loop tolerates other waiters racing.
      while (true) {
        const cur = Atomics.load(this.syncView, idx * 4 + 2);
        if (cur > 0) {
          if (Atomics.compareExchange(this.syncView, idx * 4 + 2, cur, cur - 1) === cur) {
            return 0; // WAIT_OBJECT_0
          }
          continue;
        }
        if (timeout === 0) return 0x102;
        return 0xFFFF; // cooperative scheduler will poll after other threads run
      }
    }
    if (idx >= 0 && this.syncView[idx * 4 + 1] === 1) {
      let state = Atomics.load(this.syncView, idx * 4 + 2);
      if (state === 1) {
        if (this.syncView[idx * 4 + 3] === 0) { // Auto-reset
          Atomics.store(this.syncView, idx * 4 + 2, 0);
        }
        return 0; // WAIT_OBJECT_0
      }
      if (timeout === 0) return 0x102; // WAIT_TIMEOUT

      return 0xFFFF; // blocking wait: yield to cooperative scheduler
    }
    // Handle might be a thread handle — wait for thread exit
    const thread = this.threads.get(handle);
    if (thread && thread.state === 'exited') return 0;
    if (thread) return 0xFFFF; // must wait
    // A CreateThread handle is valid before the asynchronous worker instance
    // has been spawned.  Treating that short pending interval as an unknown
    // (therefore signaled) handle makes WaitForMultipleObjects report a thread
    // exit before the thread has executed its first instruction.
    const pending = this._pendingThreads.find(item => (item.handle >>> 0) === (handle >>> 0));
    if (pending) return 0xFFFF;
    return 0;
  }

  // A synchronous guest callback (for example WM_DESTROY sent from
  // DestroyWindow) cannot preserve its call frame if WaitForSingleObject
  // yields out of the recursive interpreter run. When the main instance is
  // waiting for a guest worker thread, give that worker a bounded chance to
  // observe its shutdown flag and exit before returning control to WAT.
  waitSingleCooperative(handle, timeout) {
    let result = this.waitSingle(handle, timeout);
    if (result !== 0xFFFF || (timeout >>> 0) !== 0xFFFFFFFF) return result;
    // Never recursively enter a worker instance that is already executing.
    // The nested callback cannot yield safely, so report a Win32 wait failure
    // and let its cleanup path continue instead of returning our internal
    // cooperative-scheduler sentinel (0xFFFF).
    if (this._runningThreadHandle) return 0xFFFFFFFF;
    const target = this.threads.get(handle);
    if (!target || target.state !== 'active') return 0xFFFFFFFF;

    const startedAt = this._now();
    for (let round = 0; round < 8 && target.state === 'active'; round++) {
      // Stop flags are commonly set while the target is in Sleep. The
      // blocking waiter should not have to wait for browser wall time before
      // the worker can observe that flag.
      target.sleepUntil = 0;
      this.runSlice(100000, {
        quantumSteps: 50000,
        maxWallMs: 12,
        preferredThreadHandle: handle,
      });
      result = this.waitSingle(handle, 0);
      if (result === 0) return 0;
      if (this._now() - startedAt >= 48) break;
    }
    return 0xFFFFFFFF;
  }

  waitMultiple(nCount, lpHandlesWA, bWaitAll, timeout) {
    const mem = new Int32Array(this.memory.buffer);
    const wa = lpHandlesWA >>> 2;
    const handles = [];
    for (let i = 0; i < nCount; i++) {
      handles.push(mem[wa + i]);
    }

    if (bWaitAll) {
      // Observe every object before consuming any auto-reset event or
      // semaphore count. Calling waitSingle while probing used to reset the
      // first ready event even when a later object was not ready, making a
      // wait-all impossible to satisfy on a later scheduler poll.
      let allReady = true;
      for (let i = 0; i < nCount; i++) {
        const handle = handles[i] >>> 0;
        const idx = this._getSyncIdx(handle);
        let ready;
        if (idx >= 0 && this.syncView[idx * 4 + 1] === 1) {
          ready = Atomics.load(this.syncView, idx * 4 + 2) === 1;
        } else if (idx >= 0 && this.syncView[idx * 4 + 1] === 2) {
          ready = Atomics.load(this.syncView, idx * 4 + 2) > 0;
        } else {
          const thread = this.threads.get(handle);
          const pending = this._pendingThreads.find(item => (item.handle >>> 0) === handle);
          ready = thread ? thread.state === 'exited' : !pending;
        }
        if (!ready) {
          allReady = false;
          break;
        }
      }
      if (allReady) {
        // The current backend is cooperative, so no guest thread can change
        // these objects between the readiness pass and this consume pass.
        for (let i = 0; i < nCount; i++) {
          const idx = this._getSyncIdx(handles[i] >>> 0);
          if (idx < 0) continue;
          const type = this.syncView[idx * 4 + 1];
          if (type === 1 && this.syncView[idx * 4 + 3] === 0) {
            Atomics.store(this.syncView, idx * 4 + 2, 0); // auto-reset event
          } else if (type === 2) {
            Atomics.sub(this.syncView, idx * 4 + 2, 1); // semaphore
          }
        }
        return 0;
      }
    } else {
      for (let i = 0; i < nCount; i++) {
        if (this.waitSingle(handles[i], 0) === 0) {
          return i; // WAIT_OBJECT_0 + i
        }
      }
    }

    if (timeout === 0) return 0x102; // WAIT_TIMEOUT
    return 0xFFFF; // must wait — yield
  }

  // Instantiate pending threads (async)
  // ---- worker backend (docs/design-real-threads.md phase 2) -----------------
  //
  // The cooperative backend below and this one share everything that is
  // bookkeeping — handles, the sync table, exit codes, suspend counts — because
  // all of it lives in JS or in shared memory. What differs is where the guest's
  // instructions execute: there, in an instance on this thread; here, in a
  // Worker that runs while this thread is doing something else.
  //
  // waitSingle/waitMultiple therefore need no changes at all: they read the sync
  // table out of shared memory and consult `this.threads`, and a worker-backed
  // thread is a record in exactly the same map.

  // PE metadata comes from the guest's MAIN thread, not from this.mainInstance:
  // in worker mode the main-thread instance never loaded the image, so its
  // $image_base, $code_start and thunk globals are all zero. Reading them from
  // there produced addresses that looked plausible and pointed nowhere.
  async _workerPeMeta() {
    if (this._peMeta) return this._peMeta;
    const v = await this.workerBackend.readExports([
      'get_image_base', 'get_code_start', 'get_code_end',
      'get_thunk_base', 'get_thunk_end', 'get_num_thunks',
      'get_dll_count', 'get_vlan_local_ip', 'get_tls_next_index',
    ]);
    this._peMeta = {
      imageBase: v.get_image_base | 0,
      codeStart: v.get_code_start | 0,
      codeEnd: v.get_code_end | 0,
      thunkBase: v.get_thunk_base | 0,
      thunkEnd: v.get_thunk_end | 0,
      numThunks: v.get_num_thunks | 0,
      dllCount: v.get_dll_count | 0,
      vlanIp: v.get_vlan_local_ip | 0,
      tlsNextIndex: v.get_tls_next_index | 0,
    };
    return this._peMeta;
  }

  async _spawnPendingWorkers() {
    const main = this.mainInstance.exports;
    for (const pending of this._pendingThreads) {
      const meta = await this._workerPeMeta();
      // Same reason as the cooperative backend: a reused decoded-cache slot with
      // a stale index jumps a fresh thread into blocks emitted for the previous
      // one. The partition is in the WAT, so it applies to both backends.
      this._clearWorkerCacheSlot(pending.tid);
      let link = null;
      try {
        link = await this.workerBackend.spawnThread({
          tid: pending.tid,
          imageBase: meta.imageBase,
          codeStart: meta.codeStart,
          codeEnd: meta.codeEnd,
          thunkBase: meta.thunkBase,
          thunkEnd: meta.thunkEnd,
          numThunks: meta.numThunks,
          dllCount: meta.dllCount,
          vlanIp: meta.vlanIp,
          tlsNextIndex: meta.tlsNextIndex,
          stackSize: pending.stackSize,
          param: pending.param,
          startAddr: pending.startAddr,
          // Same per-thread hwnd partition the cooperative backend uses: without
          // it a worker's stub dialog hwnd collides with the main window and the
          // renderer entry gets clobbered.
          hwndBase: 0x10001 + (pending.tid * 0x10000),
          bp: main.get_bp_addr ? main.get_bp_addr() | 0 : 0,
          watch: main.get_watch_addr ? main.get_watch_addr() | 0 : 0,
          watchSize: main.get_watch_size ? main.get_watch_size() | 0 : 0,
          callstack: this._traceCallstack ? 1 : 0,
        });
      } catch (err) {
        this._log(`[ThreadManager] worker spawn for tid ${pending.tid} failed: ${err.message}`);
        continue;
      }
      this.threads.set(pending.handle, {
        link,
        state: 'active',
        tid: pending.tid,
        startAddr: pending.startAddr >>> 0,
        param: pending.param >>> 0,
        creationFlags: pending.creationFlags >>> 0,
        suspendCount: pending.suspendCount || 0,
        sleepCount: 0,
        sleepUntil: 0,
        waitPolls: 0,
        waitStartedAt: 0,
        inFlight: false,
      });
      this._slotToHandle.set(link.slot | 0, pending.handle);
      this._spawnedCount++;
      this._log(`[ThreadManager] spawned WORKER thread ${pending.tid} handle=0x${pending.handle.toString(16)} `
        + `slot=${link.slot} EIP=0x${pending.startAddr.toString(16)}`);
      this._emitThreadEvent('spawn', {
        handle: pending.handle >>> 0,
        tid: pending.tid | 0,
        startAddr: pending.startAddr >>> 0,
        creationFlags: pending.creationFlags >>> 0,
        suspendCount: (pending.suspendCount || 0) >>> 0,
        eip: link.startEip >>> 0,
        esp: link.startEsp >>> 0,
        backend: 'worker',
      });
    }
    this._pendingThreads = [];
  }

  // Run one slice on every runnable worker-backed thread, all at once. There is
  // no quantum, no wall-clock budget and no round-robin here on purpose: those
  // exist in the cooperative backend because one JS thread has to be shared, and
  // that is the constraint this backend removes.
  //
  // Returns how many threads were given a slice, so a caller can tell "nothing
  // to run" from "everything is parked".
  async runWorkerSlices(sliceSize) {
    if (!this.workerBackend) return 0;
    if (this._pendingThreads.length) await this._spawnPendingWorkers();
    const now = this._now();
    const runnable = [];
    const skipped = [];
    for (const [handle, thread] of this.threads) {
      // "Why did this thread not get a slice?" is the first question in worker
      // mode and the hardest to answer from the outside, so the filter reports
      // its own decision rather than leaving a silent thread to be inferred from
      // a slice count at the end of the run.
      const reason = (thread.state !== 'active' || !thread.link) ? thread.state
        : thread.inFlight ? 'inflight'             // still executing its last slice
        : thread.suspendCount > 0 ? 'suspended'
        : (thread.sleepUntil && now < thread.sleepUntil)
          ? `sleep(${thread.sleepUntil - now}ms)`
          : null;
      if (reason) { skipped.push(`T${thread.tid}:${reason}`); continue; }
      runnable.push([handle, thread]);
    }
    if (this._traceThread && skipped.length) {
      const sig = skipped.join(' ');
      if (sig !== this._lastSkipSig) {
        this._lastSkipSig = sig;
        this._log(`[ThreadManager] no slice this batch: ${sig}`);
      }
    }
    if (!runnable.length) return 0;
    const sync = this.workerSyncState();
    if (this.serialSlices) {
      // One thread at a time — the same switch the browser has as
      // `?threads-serial`. It exists to answer one question and answer it fast:
      // a symptom that survives serialisation is per-thread state (an instance
      // global that was never propagated), and one that disappears is a race
      // (usually the guest's own, since EnterCriticalSection excludes nothing).
      for (const [handle, thread] of runnable) {
        await this._runWorkerThread(handle, thread, sliceSize, sync);
      }
      return runnable.length;
    }
    await Promise.all(runnable.map(([handle, thread]) =>
      this._runWorkerThread(handle, thread, sliceSize, sync)));
    return runnable.length;
  }

  // Process-wide state that the WAT keeps in per-instance globals. The main
  // instance is the rendezvous point in both backends: everyone publishes their
  // high-water mark to it after a slice and reads it back before the next one.
  //
  // This is a slice-boundary rendezvous, not a lock, so two instances that both
  // allocate a thunk inside the SAME slice can still collide. The real fix is a
  // process cursor in shared memory, the way the heap got one — it needs the ~30
  // `global.set $num_thunks (+1)` sites reworked to reserve an index first, which
  // is a mechanical change worth doing on its own. Recorded in
  // docs/design-real-threads.md rather than left as a surprise.
  workerSyncState() {
    const main = this.mainInstance.exports;
    return {
      // Per-instance like everything else here, so a threshold set on main means
      // nothing to the threads that actually park unless it rides along.
      csStealAfter: this.csStealAfter || 0,
      dllCount: main.get_dll_count ? main.get_dll_count() | 0 : 0,
      thunkEnd: main.get_thunk_end ? main.get_thunk_end() >>> 0 : 0,
      numThunks: main.get_num_thunks ? main.get_num_thunks() >>> 0 : 0,
    };
  }

  // Fold a slice result's thunk high-water mark back into the main instance, so
  // the next slice hands it to everyone else.
  publishWorkerThunkState(r) {
    if (!r || !r.numThunks) return;
    const main = this.mainInstance.exports;
    if (!main.sync_thunk_state || !main.get_num_thunks) return;
    if ((r.numThunks >>> 0) > (main.get_num_thunks() >>> 0)) {
      main.sync_thunk_state(r.thunkEnd >>> 0, r.numThunks >>> 0);
    }
  }

  async _runWorkerThread(handle, thread, sliceSize, sync) {
    // Same event the cooperative backend emits, for the same reason: it is what
    // proves a CREATE_SUSPENDED thread did not execute before its ResumeThread.
    // Emitting it in only one backend would mean the test that checks that can
    // only be run against one of them.
    if (!thread._firstRunEmitted) {
      thread._firstRunEmitted = true;
      this._emitThreadEvent('first_run', {
        handle: handle >>> 0,
        tid: thread.tid | 0,
        startAddr: thread.startAddr >>> 0,
        creationFlags: (thread.creationFlags || 0) >>> 0,
        suspendCount: (thread.suspendCount || 0) >>> 0,
        eip: (thread.lastEip !== undefined ? thread.lastEip : (thread.link.startEip || 0)) >>> 0,
      });
    }
    thread.inFlight = true;
    let r = null;
    try {
      r = await thread.link.slice(sliceSize, sync || this.workerSyncState());
    } catch (err) {
      this._log(`[ThreadManager] worker thread ${thread.tid} slice failed: ${err.message}`);
      this._markThreadExited(handle, thread, 1, 'worker-error');
      this.workerBackend.dropThread(thread.link);
      return;
    } finally {
      thread.inFlight = false;
    }
    // Where this thread got to, kept on the record so --trace-sched can describe
    // a worker-backed thread without a round trip into another OS thread. Without
    // it the scheduler trace shows only the main thread, which on a hang report is
    // worse than showing nothing — it reads as "no threads are running".
    if (r) {
      thread.lastEip = r.eip >>> 0;
      thread.lastYield = r.yield | 0;
      thread.csWaits = r.csWaits | 0;
      thread.csSteals = r.csSteals | 0;
      thread.csWaitAddr = r.csWaitAddr | 0;
      thread.csWaitOwner = r.csWaitOwner | 0;
      thread.csBadLeaves = r.csBadLeaves | 0;
      thread.csBarges = r.csBarges | 0;
      // --esp-audit: a handler that left ESP somewhere other than 4*(nargs+1)
      // above where it found it. Reported the first time each API offends,
      // because one bad handler is called thousands of times and the name is
      // the whole finding.
      if (r.espAudit) thread.espAudit = r.espAudit;
      if (r.espAudit && r.espAudit.bad && r.espAudit.bad.length) {
        for (const b of r.espAudit.bad) {
          const key = `${thread.tid}:${b.name}`;
          if (!this._espAuditSeen) this._espAuditSeen = new Set();
          if (this._espAuditSeen.has(key)) continue;
          this._espAuditSeen.add(key);
          this._log(`[esp-audit] T${thread.tid} ${b.name} moved ESP by ${b.delta}, `
            + `expected ${b.expected} (esp=0x${(b.esp >>> 0).toString(16)} `
            + `eip=0x${(b.eip >>> 0).toString(16)})`);
        }
      }
      thread.csBadLeaveAddr = r.csBadLeaveAddr | 0;
      thread.csBadLeaveOwner = r.csBadLeaveOwner | 0;
    }

    if (thread.state !== 'active') return;         // exited under us (ExitThread)

    if (r.trapped) {
      // The slice reply already carries the registers on a trap; printing only
      // EIP throws away the one thing that matters when EIP is the symptom.
      // Where it jumped FROM is prev_eip, and the section counters say whether
      // the thread had been fighting for a lock on its way here.
      const g = r.regs || {};
      const h = v => `0x${(v >>> 0).toString(16)}`;
      this._log(`[ThreadManager] worker thread ${thread.tid} trapped at EIP=${this._describeAddr(r.eip)}: ${r.trapped}`
        + (r.regs ? `\n  prev_eip=${this._describeAddr(g.prevEip)} prev2_eip=${this._describeAddr(g.prev2Eip)} esp=${h(g.esp)} ebp=${h(g.ebp)} eax=${h(g.eax)} `
          + `ebx=${h(g.ebx)} ecx=${h(g.ecx)} edx=${h(g.edx)} esi=${h(g.esi)} edi=${h(g.edi)}` : '')
        + `\n  csPark=${r.csWaits | 0} csSteal=${r.csSteals | 0}`
        // Where the thread was born. A thread executing blank memory either
        // started at a bad address or called through a bad pointer, and this is
        // the one line that tells the two apart.
        + `\n  startEip=${this._describeAddr(thread.link.startEip || 0)}`
        // Where ESP sits relative to the stack this thread was given. Below it
        // is an overflow: the thread has been writing over whatever is under its
        // stack, and its own return addresses are the first casualties. That
        // reads as a corrupted return with no bad pointer anywhere near the
        // crash, so it is worth one comparison here.
        + (thread.link.stackBase
          ? `\n  stack=0x${(thread.link.stackBase >>> 0).toString(16)}-`
            + `0x${(thread.link.stackTop >>> 0).toString(16)} `
            + `esp is ${(g.esp >>> 0) < (thread.link.stackBase >>> 0) ? 'BELOW IT (overflow)'
              : (g.esp >>> 0) > (thread.link.stackTop >>> 0) ? 'above it'
              : `inside, ${((g.esp >>> 0) - (thread.link.stackBase >>> 0))} bytes of headroom left`}`
          : ''));
      this._markThreadExited(handle, thread, 1, 'trap');
      this.workerBackend.dropThread(thread.link);
      return;
    }

    // A thread that allocated thunks moved the end of a zone every instance
    // shares. Publish it so the next slice hands the new mark to everyone.
    this.publishWorkerThunkState(r);

    if (r.yield === 2 || !r.eip) {
      this._markThreadExited(handle, thread, thread.exitCode, r.yield === 2 ? 'yield=2' : 'eip=0');
      this._log(`[ThreadManager] worker thread ${thread.tid} exited (${r.yield === 2 ? 'yield=2' : 'eip=0'})`);
      this.workerBackend.dropThread(thread.link);
      return;
    }

    if (r.yield === 1) {
      await this._resolveWorkerWait(thread, r);
      return;
    }
    if (r.yield === 7) {
      // The message-wait resume runs inside the worker at the top of each slice;
      // clearing it here lets the guest re-poll rather than sit on a wait this
      // thread's queue will never satisfy.
      await thread.link.callExport('clear_yield');
      return;
    }
    if (r.yield === 9) {
      // Critical section held elsewhere. Clearing re-enters the same call; the
      // other threads in this round get their slice either way.
      await thread.link.callExport('clear_yield');
      return;
    }
    if (r.yield === 8) {
      // net_wait: EIP is still on the thunk, so clearing the yield re-enters the
      // same call once the wire has moved. Frames arrive on the host event loop,
      // so the caller has to give it a turn — that is what netWaitPending says.
      await thread.link.callExport('clear_yield');
      try { await thread.link.callExport('vlan_pump'); } catch (_) {}
      this.netWaitPending = true;
      return;
    }
    if (r.yield === 10) {
      await this.workerBackend.resolveThreadSend(thread.link, {
        targetTid: r.sendTargetTid | 0,
        hwnd: r.sendHwnd | 0, msg: r.sendMsg | 0,
        wparam: r.sendWparam | 0, lparam: r.sendLparam | 0,
        postKind: r.sendPostKind | 0,
      });
      return;
    }
    if (r.sleepYielded) {
      thread.sleepUntil = r.sleepMs ? this._now() + r.sleepMs : 0;
      thread.sleepCount++;
    } else {
      thread.sleepUntil = 0;
      thread.sleepCount = 0;
    }
  }

  // Resolve a wait a worker parked on, from the wait parameters its slice result
  // carried. Runs here, on the main thread, because the sync table bookkeeping
  // (auto-reset events, semaphore counts, thread-exit handles) is shared and
  // single-owner. Returns null while the wait is unsatisfied.
  //
  // NOT COMPLETING A PARKED WAIT IS NOT A NO-OP, which is the trap this exists to
  // avoid. $run pops the saved return address whenever a handler leaves EIP
  // alone, so by the time the yield is visible the guest's EIP is already past
  // the call — with the stdcall arguments still on the stack. Completing the wait
  // is what drops them. "Just clear the yield and let it re-poll" leaks 12 bytes
  // of guest stack per wait, and the app dies later, somewhere else, at
  // EIP=0xffffffff.
  resolveWait(r, state, opts) {
    opts = opts || {};
    const waitStackBytes = r.waitStackBytes || (r.waitHandlesPtr ? 20 : 12);
    const hasMessage = () => (this._hasMessage ? !!this._hasMessage() : false);
    let result;
    if (waitStackBytes === 24 && !r.waitHandlesPtr) {
      // MsgWaitForMultipleObjects: input satisfies it as well as the object does.
      result = hasMessage() ? r.waitHandle : 0xFFFF;
    } else if (r.waitHandlesPtr && opts.main && hasMessage()) {
      result = r.waitHandle;   // WAIT_OBJECT_0 + nCount
    } else if (r.waitHandlesPtr) {
      result = this.waitMultiple(r.waitHandle, r.waitHandlesPtr, !!r.waitAll, 0);
    } else {
      result = this.waitSingle(r.waitHandle, 0);
    }
    if (result === 0xFFFF || result === 0x102) {
      const timeout = r.waitTimeout >>> 0;
      const syncIdx = r.waitHandlesPtr ? -1 : this._getSyncIdx(r.waitHandle);
      if (opts.main && !this.hasActiveThreads() && timeout === 0xFFFFFFFF
          && syncIdx >= 0 && this.syncView[syncIdx * 4 + 1] === 1) {
        // Nobody is left who could signal this event, so waiting forever is a
        // hang rather than a wait. Same escape the cooperative main path takes.
        result = 0;
      } else if (timeout !== 0 && timeout !== 0xFFFFFFFF) {
        const now = opts.wallClock ? Date.now() : this._now();
        if (!state.waitStartedAt) state.waitStartedAt = now;
        if ((now - state.waitStartedAt) < timeout) { state.waitPolls++; return null; }
        result = 0x102;                            // WAIT_TIMEOUT
      } else {
        state.waitPolls++;
        return null;                               // still waiting; re-poll next slice
      }
    }
    state.waitPolls = 0;
    state.waitStartedAt = 0;
    return { result, waitStackBytes };
  }

  // The guest MAIN thread's wait, in worker mode. host.js drives slot 0, so it
  // asks for the decision and applies it to that worker.
  resolveMainWorkerWait(r) {
    if (!this._mainWaitState) this._mainWaitState = { waitPolls: 0, waitStartedAt: 0 };
    return this.resolveWait(r, this._mainWaitState, { main: true });
  }

  async _resolveWorkerWait(thread, r) {
    const done = this.resolveWait(r, thread, {});
    if (!done) return;
    const { result, waitStackBytes } = done;
    const woke = await thread.link.completeWait(result, waitStackBytes);
    if (woke && woke.rewrote) {
      // See the note in guest-worker.js: the stack's return address was
      // rejected and guessed at. Rare and load-bearing, so it is never silent.
      this._log(`[wait-resume] T${thread.tid} return address rewritten `
        + `${this._describeAddr(woke.rewrote.from)} -> ${this._describeAddr(woke.rewrote.to)}`);
    }
    if (this._traceThread) {
      this._log(`[ThreadManager] worker thread ${thread.tid} resumed from wait, `
        + `handle=0x${(r.waitHandle >>> 0).toString(16)} result=0x${(result >>> 0).toString(16)}`);
    }
  }

  async _pumpWorkersForThreadSend(activeLinks) {
    if (!this.workerBackend) return 0;
    const work = [];
    const sync = this.workerSyncState();
    for (const [handle, thread] of this.threads) {
      if (thread.state !== 'active' || thread.suspendCount > 0 || thread.inFlight) continue;
      if (activeLinks && activeLinks.has(thread.link)) continue;
      work.push(this._runWorkerThread(handle, thread, 20000, sync));
    }
    if (work.length) await Promise.all(work);
    return work.length;
  }

  // A WndProc entered for cross-thread SendMessage can block just like ordinary
  // guest code. Resolve the same yield protocol without abandoning the nested
  // interpreter frame; while an object/message wait is unsatisfied, give every
  // unrelated Worker a slice so a third thread can signal it.
  async resolveThreadSendYield(link, r, state, activeLinks) {
    const isMain = !!(this.workerBackend
      && (link === this.workerBackend.link || link === this.workerBackend._localLink));
    if (r.yield === 1) {
      const done = this.resolveWait(r, state, { main: isMain, wallClock: true });
      if (done) {
        await link.completeWait(done.result, done.waitStackBytes);
        return 'resume';
      }
      await this._pumpWorkersForThreadSend(activeLinks);
      return 'pending';
    }
    if (r.yield === 7) {
      const resumed = await link.resumeThreadSendMessageWait(this._hasPendingMessage(null));
      if (resumed && resumed.resumed) return 'resume';
      state.waitPolls++;
      await this._pumpWorkersForThreadSend(activeLinks);
      return 'pending';
    }
    if (r.yield === 8) {
      await link.callExport('clear_yield');
      try { await link.callExport('vlan_pump'); } catch (_) {}
      this.netWaitPending = true;
      await this._pumpWorkersForThreadSend(activeLinks);
      await new Promise(resolve => setTimeout(resolve, 0));
      return 'resume';
    }
    if (r.yield === 9) {
      await link.callExport('clear_yield');
      await this._pumpWorkersForThreadSend(activeLinks);
      return 'resume';
    }
    if (r.yield === 6) {
      await this._pumpWorkersForThreadSend(activeLinks);
      await new Promise(resolve => setTimeout(resolve, 0));
      return 'resume';
    }
    if ((r.yield === 3 || r.yield === 5) && this._resolveThreadSendExternalYield) {
      return (await this._resolveThreadSendExternalYield(link, r)) === false ? 'abort' : 'resume';
    }
    return 'abort';
  }

  async spawnPending() {
    if (this.workerBackend) return this._spawnPendingWorkers();
    for (const pending of this._pendingThreads) {
      const tid = pending.tid;
      this._clearWorkerCacheSlot(tid);
      const imports = this.makeImports(tid);
      // When instantiating from a compiled Module, instantiate returns Instance directly
      const result = await WebAssembly.instantiate(this.module, imports);
      const instance = result.exports ? result : result.instance || result;
      if (imports && typeof imports.__setInstance === 'function') {
        imports.__setInstance(instance);
      }

      // Get PE metadata from main instance
      const main = this.mainInstance.exports;
      instance.exports.init_thread(
        tid,
        main.get_image_base(),
        main.get_code_start(),
        main.get_code_end(),
        main.get_thunk_base(),
        main.get_thunk_end(),
        main.get_num_thunks()
      );
      // DLL metadata lives in shared memory, but dll_count is a per-instance
      // global. Worker LoadLibrary/GetProcAddress must see the main thread's
      // loaded DLL table, especially for Winamp visualization plug-ins.
      if (main.get_dll_count) {
        const dllCount = main.get_dll_count() | 0;
        if (instance.exports.set_dll_count) instance.exports.set_dll_count(dllCount);
        else if (instance.exports.test_set_dll_count) instance.exports.test_set_dll_count(dllCount);
      }
      // The virtual LAN room address is a property of the process, not of one
      // thread. The socket table itself lives in shared memory, but the local
      // address is a per-instance global, so a worker that opens a socket
      // would otherwise send frames from address 0. Liquid War connects to its
      // server on a worker thread, so this is the normal case, not a corner.
      if (main.get_vlan_local_ip && instance.exports.set_vlan_local_ip) {
        instance.exports.set_vlan_local_ip(main.get_vlan_local_ip() | 0);
      }

      // Set up thread stack in shared memory
      // Allocate stack space from main heap (guest addresses)
      const stackSize = pending.stackSize;
      const stackBase = main.guest_alloc(stackSize);
      const stackTop = stackBase + stackSize;

      // Zero the stack — Windows zero-fills new stack pages
      const imageBase = main.get_image_base();
      const wasmOffset = stackBase - imageBase + 0x12000;
      new Uint8Array(this.memory.buffer, wasmOffset, stackSize).fill(0);

      // Set ESP to top of stack
      instance.exports.set_esp(stackTop);

      // Push parameter and return address (ExitThread thunk) onto stack
      // Push parameter
      instance.exports.set_esp(stackTop - 4);
      instance.exports.guest_write32(stackTop - 4, pending.param);
      // Push return address = 0 (will halt thread when it returns)
      instance.exports.set_esp(stackTop - 8);
      instance.exports.guest_write32(stackTop - 8, 0);

      // Set EIP to thread start function
      instance.exports.set_eip(pending.startAddr);

      // Partition hwnd allocator per-thread. Without this, T1 reuses main's
      // 0x10001+ range — when a worker thread calls e.g. PrintDlgA the stub
      // dialog hwnd collides with the main window and the renderer entry
      // gets clobbered (size, title). Same shape as the thread-cache fix:
      // each tid owns 0x10000..0x1FFFF of the hwnd space.
      instance.exports.set_hwnd_base(0x10001 + (tid * 0x10000));

      // Allocate TIB/FS base and a per-thread TLS slot block. Real Win32 gives
      // each thread its own TIB and TLS values while sharing TLS indexes across
      // the process. Worker WASM instances have their own globals, so make the
      // WAT-visible fs_base/tls_slots point at the blocks allocated here.
      const tib = main.guest_alloc(0x30);
      const tlsSlots = main.guest_alloc(0x100);
      const tlsWasmOffset = tlsSlots - imageBase + 0x12000;
      new Uint8Array(this.memory.buffer, tlsWasmOffset, 0x100).fill(0);
      instance.exports.guest_write32(tib, 0xFFFFFFFF); // SEH head = -1
      instance.exports.guest_write32(tib + 4, stackTop);  // stack top
      instance.exports.guest_write32(tib + 8, stackBase);  // stack bottom
      instance.exports.guest_write32(tib + 0x18, tib);     // self pointer
      instance.exports.guest_write32(tib + 0x2c, tlsSlots); // ThreadLocalStoragePointer
      if (instance.exports.set_fs_base) instance.exports.set_fs_base(tib);
      if (instance.exports.set_tls_slots) instance.exports.set_tls_slots(tlsSlots);
      if (instance.exports.set_tls_next_index && main.get_tls_next_index) {
        instance.exports.set_tls_next_index(main.get_tls_next_index());
      }

      // Deliberately NOT copying heap_ptr / heap_sparse_ptr / virtual_alloc_top
      // from main. Those cursors used to be marshalled in before each slice and
      // out after it, which made a per-instance global behave like shared state
      // — but only because exactly one instance ran at a time and JS got to run
      // in between. It breaks in worker mode, where `main` is the idle
      // main-thread instance and the guest actually runs somewhere else, and it
      // cannot work at all once two instances run concurrently. The WAT now
      // reserves a private arena per instance from a cursor in shared memory
      // (see $heap_low_reserve), so init_thread's zeroing is the correct state.

      // Propagate breakpoint from main instance so per-thread code is
      // catchable by --break/--trace-at (otherwise the bp only fires for
      // main's own EIP and worker threads run blind).
      if (main.get_bp_addr && instance.exports.set_bp) {
        const bp = main.get_bp_addr();
        if (bp) {
          instance.exports.set_bp(bp);
          this._log(`[ThreadManager] propagate bp=0x${bp.toString(16)} to T${tid}`);
        }
      }

      if (this.csStealAfter && instance.exports.set_cs_steal_after) {
        instance.exports.set_cs_steal_after(this.csStealAfter | 0);
      }

      // Propagate shadow callstack enable so worker traces also accumulate.
      if (this._traceCallstack && instance.exports.set_callstack_enabled) {
        instance.exports.set_callstack_enabled(1);
      }
      if (this._traceEipRange && instance.exports.set_trace_eip_range) {
        instance.exports.set_trace_eip_range(1, this._traceEipRange.lo >>> 0, this._traceEipRange.hi >>> 0);
      }

      // Propagate watchpoint too — without this, a worker-thread store to
      // the watched address fires on the worker's instance but main never
      // sees it, so --watch silently misses thread writes.
      if (main.get_watch_addr && instance.exports.set_watchpoint) {
        const wa = main.get_watch_addr();
        if (wa) {
          if (instance.exports.set_watchpoint_size && main.get_watch_size) {
            instance.exports.set_watchpoint_size(main.get_watch_size());
          }
          instance.exports.set_watchpoint(wa);
          this._log(`[ThreadManager] propagate watch=0x${wa.toString(16)} to T${tid}`);
        }
      }

      this.threads.set(pending.handle, {
        instance,
        state: 'active',
        tid,
        startAddr: pending.startAddr >>> 0,
        param: pending.param >>> 0,
        creationFlags: pending.creationFlags >>> 0,
        suspendCount: pending.suspendCount || 0,
        fsBase: tib,
        sleepCount: 0,  // track consecutive Sleep yields for deprioritization
        sleepUntil: 0,
        waitPolls: 0,
        waitStartedAt: 0,
      });
      this._spawnedCount++;

      this._log(`[ThreadManager] Spawned thread ${tid} handle=0x${pending.handle.toString(16)} EIP=0x${pending.startAddr.toString(16)} ESP=0x${(stackTop - 8).toString(16)}`);
      this._emitThreadEvent('spawn', {
        handle: pending.handle >>> 0,
        tid: tid | 0,
        startAddr: pending.startAddr >>> 0,
        creationFlags: pending.creationFlags >>> 0,
        suspendCount: pending.suspendCount >>> 0,
        eip: pending.startAddr >>> 0,
        esp: (stackTop - 8) >>> 0,
      });
    }
    this._pendingThreads = [];
  }

  // Run one batch across all active threads, interleaved in small slices.
  // Threads that repeatedly yield via Sleep (idle loops like timer/monitor
  // threads) are deprioritized: they run only every Nth slice, freeing
  // instruction budget for compute-heavy threads (MP3 decode, audio output).
  runSlice(batchSize, options) {
    options = options || {};
    // The cooperative backend only. Worker-backed threads keep a Worker where
    // this expects an instance, and calling e.run() on them would throw halfway
    // through the loop — better to say so than to half-run a batch.
    if (this.workerBackend) {
      throw new Error('ThreadManager.runSlice is the cooperative backend; use runWorkerSlices()');
    }
    const main = this.mainInstance.exports;
    const stats = {
      elapsedMs: 0,
      steps: 0,
      threadsRun: 0,
      hitDeadline: false,
      stoppedForMessage: false,
    };
    const startedAt = this._now();
    const maxWallMs = Number.isFinite(options.maxWallMs) ? Math.max(0, options.maxWallMs) : 0;
    const deadline = maxWallMs > 0 ? startedAt + maxWallMs : 0;
    const finishStats = () => {
      stats.elapsedMs = Math.max(0, this._now() - startedAt);
      return stats;
    };
    const shouldStop = () => {
      if (deadline && this._now() >= deadline) {
        stats.hitDeadline = true;
        return true;
      }
      if (options.stopIfMessagePending && this._hasPendingMessage(main)) {
        stats.stoppedForMessage = true;
        return true;
      }
      return false;
    };
    // Count active non-idle threads to divide budget
    let activeCount = 0;
    for (const [, t] of this.threads) {
      if (t.state === 'active' && !(t.suspendCount > 0)) activeCount++;
    }
    if (!activeCount) return finishStats();
    const requestedQuantum = (options.quantumSteps | 0) > 0 ? (options.quantumSteps | 0) : 0;
    const sliceSize = requestedQuantum || Math.max(1000, Math.floor(batchSize / Math.min(activeCount, 4)));
    const numSlices = Math.ceil(Math.max(0, batchSize | 0) / Math.max(1, sliceSize));
    // Hot waveOut workers still lead often enough to keep buffers filled, but
    // alternating prevents them from consuming every small wall-clock budget.
    const audioPriorityActive = !!(options.prioritizeAudioThreads && this._hasHotAudioThreads());
    const hotFirst = !!(audioPriorityActive && this._audioPriorityNextHotFirst);
    const threadOrderOptions = Object.assign({}, options, { prioritizeAudioThreads: hotFirst });
    if (audioPriorityActive) {
      this._audioPriorityNextHotFirst = !hotFirst;
    } else {
      this._audioPriorityNextHotFirst = true;
    }

    for (let slice = 0; slice < numSlices; slice++) {
      if (shouldStop()) return finishStats();
      for (const [handle, thread] of this._threadEntries(threadOrderOptions)) {
        if (shouldStop()) return finishStats();
        if (thread.state !== 'active') continue;
        if (thread.suspendCount > 0) continue;
        if (thread.sleepUntil && this._now() < thread.sleepUntil) continue;
        // Deprioritize idle threads: if a thread has called Sleep 3+ times
        // consecutively, only run it every 8th slice to save budget for
        // compute-heavy threads.
        if (thread.sleepCount >= 3 && (slice & 7) !== 0) continue;

        const e = thread.instance.exports;

        // Track state transitions for --trace-thread / --trace-yield
        if (this._traceThread || this._traceYield) {
          const curState = thread.state;
          const yr = e.get_yield_reason();
          const eipNow = e.get_eip();
          const sig = `${curState}|${yr}`;
          if (thread._lastSig !== sig) {
            if (this._traceThread) {
              const desc = yr === 1 ? `wait(h=0x${e.get_wait_handle().toString(16)})` :
                           yr === 2 ? 'exited' :
                           yr === 3 ? 'com_load_dll' :
                           yr === 4 ? 'help_load' :
                           curState;
              this._log(`[thread] T${thread.tid} ${thread._lastSig || 'init'} → ${desc} eip=0x${eipNow.toString(16)}`);
            }
            if (this._traceYield && yr) {
              const name = YIELD_NAMES[yr] || '?';
              const extra = yr === 1 ? ` h=0x${e.get_wait_handle().toString(16)}` : '';
              this._log(`[yield] T${thread.tid} reason=${yr} (${name})${extra} eip=0x${eipNow.toString(16)}`);
            }
            thread._lastSig = sig;
          }
        }

        // Check if thread is waiting
        const yieldReason = e.get_yield_reason();
        if (yieldReason === 7) {
          if (!this._hasPendingMessage(e)) {
            thread.waitPolls++;
            continue;
          }
          thread.waitPolls = 0;
          const retAddr = e.guest_read32 ? e.guest_read32(e.get_esp()) : 0;
          if (e.resume_message_wait && (e.resume_message_wait() | 0)) {
            e.set_eip(retAddr);
          } else {
            continue;
          }
        } else if (yieldReason === 1) {
          const waitHandle = e.get_wait_handle();
          const waitHandlesPtr = e.get_wait_handles_ptr ? e.get_wait_handles_ptr() : 0;
          const waitAll = e.get_wait_all ? !!e.get_wait_all() : false;
          const waitTimeout = e.get_wait_timeout ? (e.get_wait_timeout() >>> 0) : 0xFFFFFFFF;
          const waitStackBytes = e.get_wait_stack_bytes ? (e.get_wait_stack_bytes() | 0) : (waitHandlesPtr ? 20 : 12);
          let result;
          if (waitStackBytes === 24 && !waitHandlesPtr) {
            result = this._hasPendingMessage(e) ? waitHandle : 0xFFFF;
          } else if (waitHandlesPtr) {
            result = this.waitMultiple(waitHandle, waitHandlesPtr, waitAll, 0); // nCount is in waitHandle
          } else {
            result = this.waitSingle(waitHandle, 0);
          }
          if (result === 0xFFFF || result === 0x102) {
            if (waitTimeout !== 0 && waitTimeout !== 0xFFFFFFFF) {
              const now = this._now();
              if (!thread.waitStartedAt) thread.waitStartedAt = now;
              if ((now - thread.waitStartedAt) >= waitTimeout) {
                result = 0x102;
              } else {
                thread.waitPolls++;
                continue;
              }
            } else {
              thread.waitPolls++;
              continue; // still waiting
            }
          }
          thread.waitPolls = 0;
          thread.waitStartedAt = 0;
          // Signaled — resume thread
          // Stack depends on which API yielded: 12/20/24 bytes for the
          // single/multiple/message-aware wait variants respectively.
          const retAddr = this._completeWait(e, result, waitStackBytes);
          // Unlike the lifecycle lines around it, this one fires on every
          // satisfied wait — a game loop signalling a worker each frame logs
          // it hundreds of thousands of times. It belongs behind the thread
          // trace, not in the default output.
          if (this._traceThread) {
            this._log(`[ThreadManager] Thread ${thread.tid} resumed from wait, handle=0x${waitHandle.toString(16)} ret=0x${retAddr.toString(16)}`);
          }
        } else if (yieldReason === 8) {
          // net_wait: a blocking socket call parked itself. EIP is still on the
          // thunk, so clearing the yield re-enters the same handler with the
          // same arguments once the wire has moved. Give up the slice rather
          // than spinning here — frames arrive on the host event loop.
          e.clear_yield();
          if (e.vlan_pump) e.vlan_pump();
          // Frames arrive on the host event loop, and runSlice is synchronous:
          // spinning here would poll a wire that nothing can refill. Record
          // that a thread is parked so the caller gives the event loop a turn
          // before the next slice — without that, a worker blocked in connect
          // starves the very delivery it is waiting for.
          this.netWaitPending = true;
          thread.waitPolls++;
          continue;
        } else if (yieldReason === 9) {
          // EnterCriticalSection left EIP/ESP on the import thunk. Clear only
          // the yield and retry after another scheduler turn; the owner lives
          // in shared guest memory and LeaveCriticalSection will release it.
          if (this._traceThread && thread.waitPolls < 3) {
            const cs = e.get_wait_handle() >>> 0;
            const esp = e.get_esp() >>> 0;
            this._log(`[ThreadManager] T${thread.tid} critical wait cs=0x${cs.toString(16)} ` +
              `lock=${e.guest_read32((cs + 4) >>> 0) | 0} recursion=${e.guest_read32((cs + 8) >>> 0) >>> 0} ` +
              `owner=${e.guest_read32((cs + 12) >>> 0) >>> 0} tid=${e.get_current_thread_id() >>> 0} ` +
              `eip=0x${e.get_eip().toString(16)} esp=0x${esp.toString(16)} ` +
              `stack=[0x${(e.guest_read32(esp) >>> 0).toString(16)},0x${(e.guest_read32((esp + 4) >>> 0) >>> 0).toString(16)},0x${(e.guest_read32((esp + 8) >>> 0) >>> 0).toString(16)}]`);
          }
          e.clear_yield();
          thread.waitPolls++;
          continue;
        } else if (yieldReason === 2) {
          const prev = e.get_dbg_prev_eip ? e.get_dbg_prev_eip() : 0;
          this._markThreadExited(handle, thread, thread.exitCode, 'yield=2');
          this._log(`[ThreadManager] Thread ${thread.tid} exited (yield=2) prev_eip=0x${prev.toString(16)} esp=0x${e.get_esp().toString(16)}`);
          continue;
        }

        if (!e.get_eip()) {
          const prev = e.get_dbg_prev_eip ? e.get_dbg_prev_eip() : 0;
          this._log(`[ThreadManager] Thread ${thread.tid} EIP=0 (likely call/jmp to NULL), prev_eip=0x${prev.toString(16)} esp=0x${e.get_esp().toString(16)} eax=0x${e.get_eax().toString(16)} ebx=0x${e.get_ebx().toString(16)} ecx=0x${e.get_ecx().toString(16)} edx=0x${e.get_edx().toString(16)} esi=0x${e.get_esi().toString(16)} edi=0x${e.get_edi().toString(16)}`);
          // Dump near-stack so we can see where the threadproc ret popped 0 from
          try {
            const espNow = e.get_esp() >>> 0;
            const mem32 = new Uint32Array(e.memory.buffer);
            const g2wOff = 0x12000 - e.get_image_base();
            const wEsp = (espNow + g2wOff) >>> 0;
            let stk = '';
            for (let i = -8; i < 16; i++) {
              const v = mem32[(wEsp >> 2) + i] >>> 0;
              stk += `[esp${i>=0?'+':''}${i*4}]=0x${v.toString(16)} `;
            }
            this._log(`[ThreadManager]   stack: ${stk}`);
          } catch (_) {}
          this._markThreadExited(handle, thread, 0, 'eip=0');
          continue;
        }

        // No heap-cursor sync-in here — see the note in the spawn path. The
        // allocator's shared state lives in memory, which this instance already
        // sees; its own arena bounds must survive across slices.
        if (main.get_dll_count) {
          const dllCount = main.get_dll_count() | 0;
          if (e.set_dll_count) e.set_dll_count(dllCount);
          else if (e.test_set_dll_count) e.test_set_dll_count(dllCount);
        }
        if (main.get_thunk_end && main.get_num_thunks && e.get_thunk_end && e.get_num_thunks && e.sync_thunk_state) {
          const mainThunkEnd = main.get_thunk_end() >>> 0;
          const mainThunkCount = main.get_num_thunks() >>> 0;
          const workerThunkEnd = e.get_thunk_end() >>> 0;
          const workerThunkCount = e.get_num_thunks() >>> 0;
          if (workerThunkEnd !== mainThunkEnd || workerThunkCount !== mainThunkCount) {
            e.sync_thunk_state(mainThunkEnd, mainThunkCount);
          }
        }
        const eipBeforeRun = e.get_eip();
        if (!thread._firstRunEmitted) {
          thread._firstRunEmitted = true;
          this._emitThreadEvent('first_run', {
            handle: handle >>> 0,
            tid: thread.tid | 0,
            startAddr: thread.startAddr >>> 0,
            creationFlags: (thread.creationFlags || 0) >>> 0,
            suspendCount: (thread.suspendCount || 0) >>> 0,
            eip: eipBeforeRun >>> 0,
          });
        }
        this._runningThreadHandle = handle;
        const profileStartedAt = this._profileThreadRun ? this._now() : 0;
        let eipAfterRun = 0;
        let yieldReasonAfterRun = 0;
        let sleepYielded = false;
        let sleepMs = 0;
        let runError = null;
        try { e.run(sliceSize); } catch (err) {
          runError = err;
          // Every CS counter is a per-instance global and this thread has its own
          // instance, so the crash has to read them here — the process-wide
          // summary in test/run.js sees the main instance's copy, which is 0.
          const cs = (name) => (e[name] ? e[name]() | 0 : 0);
          const abandoned = cs('get_cs_abandoned');
          const prev = e.get_dbg_prev_eip ? e.get_dbg_prev_eip() >>> 0 : 0;
          const prev2 = e.get_dbg_prev2_eip ? e.get_dbg_prev2_eip() >>> 0 : 0;
          const reason = e.get_yield_reason ? e.get_yield_reason() >>> 0 : 0;
          this._log(`[ThreadManager] Thread ${thread.tid} crashed at `
            + `EIP=${this._describeAddr(e.get_eip())} ESP=0x${e.get_esp().toString(16)}: ${err.message}`
            + `\n  prev_eip=${this._describeAddr(prev)} prev2_eip=${this._describeAddr(prev2)} yield=${reason} `
            + `csPark=${cs('get_cs_waits')} csBarge=${cs('get_cs_barges')} `
            + `csAbandoned=${abandoned}`
            + (abandoned ? ` (last dispatched at ${this._describeAddr(cs('get_cs_abandoned_eip'))})` : '')
            + ` espDeltaAcrossPark=${cs('get_cs_resume_esp_delta')}`
            + ` parkEip=${this._describeAddr(cs('get_cs_park_eip'))}`);
          this._markThreadExited(handle, thread, 1, 'crash');
        } finally {
          this._runningThreadHandle = 0;
          try {
            eipAfterRun = e.get_eip ? (e.get_eip() >>> 0) : 0;
            yieldReasonAfterRun = e.get_yield_reason ? (e.get_yield_reason() >>> 0) : 0;
            if (!runError && e.get_sleep_yielded) {
              sleepYielded = !!e.get_sleep_yielded();
              if (sleepYielded && e.get_sleep_timeout) sleepMs = e.get_sleep_timeout() >>> 0;
            }
          } catch (_) {}
          if (this._profileThreadRun && profileStartedAt) {
            try {
              this._profileThreadRun({
                handle: handle >>> 0,
                tid: thread.tid | 0,
                startAddr: thread.startAddr >>> 0,
                param: thread.param >>> 0,
                steps: sliceSize | 0,
                eipBefore: eipBeforeRun >>> 0,
                eipAfter: eipAfterRun >>> 0,
                yieldReason: yieldReasonAfterRun >>> 0,
                sleepYielded,
                sleepMs: sleepMs >>> 0,
                hotAudio: this._audioThreadHotUntil.has((thread.tid || 0) | 0),
                state: thread.state || '',
                elapsedMs: Math.max(0, this._now() - profileStartedAt),
                crashed: !!runError,
              });
            } catch (_) {}
          }
        }
        if (runError) continue;
        stats.threadsRun++;
        stats.steps += sliceSize;
        // ...and no sync-out. What this thread allocated is recorded in the
        // shared cursor, not in main's copy of a global.
        if (main.sync_thunk_state && main.get_num_thunks && e.get_num_thunks && e.get_thunk_end) {
          const mainThunkCount = main.get_num_thunks() >>> 0;
          const workerThunkCount = e.get_num_thunks() >>> 0;
          if (workerThunkCount > mainThunkCount) {
            main.sync_thunk_state(e.get_thunk_end() >>> 0, workerThunkCount);
          }
        }
        // Surface bp halts on this thread's instance.
        if (e.get_bp_addr) {
          const bp = e.get_bp_addr();
          const eipNow = e.get_eip();
          if (bp && eipNow === bp) {
            // --break-thread filter: only surface bp if tid matches
            if (this._breakThreadFilter !== null && this._breakThreadFilter !== thread.tid) {
              if (e.set_bp) e.set_bp(bp); // re-arm and continue silently
            } else {
              const prev = e.get_dbg_prev_eip ? e.get_dbg_prev_eip() : 0;
              this._log(`[ThreadManager] T${thread.tid} BP hit at 0x${eipNow.toString(16)} prev_eip=0x${prev.toString(16)} esp=0x${e.get_esp().toString(16)} eax=0x${e.get_eax().toString(16)} ebx=0x${e.get_ebx().toString(16)} ecx=0x${e.get_ecx().toString(16)} edx=0x${e.get_edx().toString(16)} esi=0x${e.get_esi().toString(16)} edi=0x${e.get_edi().toString(16)}`);
              if (this._traceCallstack && e.get_callstack_depth) {
                const d = e.get_callstack_depth() | 0;
                const n = Math.min(d, this._traceCallstackDepth);
                this._log(`  [stack T${thread.tid} depth=${d}]`);
                for (let i = 0; i < n; i++) {
                  this._log(`    #${i} ret=0x${(e.get_callstack_entry(i) >>> 0).toString(16)}`);
                }
              }
            }
          }
        }
        // Surface watchpoint halts on this thread's instance. WAT halts the
        // run loop when the watched memory changes; main's watch_val won't
        // see the new value, so we resync main here and report the change.
        if (e.get_watch_addr && main.get_watch_addr) {
          const wa = e.get_watch_addr();
          if (wa) {
            const newVal = e.get_watch_val();
            const mainVal = main.get_watch_val();
            if (newVal !== mainVal) {
              const prev = e.get_dbg_prev_eip ? e.get_dbg_prev_eip() : 0;
              this._log(`[ThreadManager] T${thread.tid} WATCH 0x${wa.toString(16)} 0x${mainVal.toString(16)} -> 0x${newVal.toString(16)} eip=0x${e.get_eip().toString(16)} prev_eip=0x${prev.toString(16)} esp=0x${e.get_esp().toString(16)} ebp=0x${e.get_ebp().toString(16)} eax=0x${e.get_eax().toString(16)} ebx=0x${e.get_ebx().toString(16)} ecx=0x${e.get_ecx().toString(16)} edx=0x${e.get_edx().toString(16)} esi=0x${e.get_esi().toString(16)} edi=0x${e.get_edi().toString(16)}`);
              if (main.set_watchpoint) main.set_watchpoint(wa); // resync to suppress dup log on next slice
            }
          }
        }

        // Track Sleep yielding: get_sleep_yielded atomically reads and clears
        // the flag. Threads that repeatedly call Sleep (idle polling loops)
        // get deprioritized so compute-heavy threads get more budget.
        const postYield = yieldReasonAfterRun;
        if (postYield === 2) {
          const prev = e.get_dbg_prev_eip ? e.get_dbg_prev_eip() : 0;
          this._markThreadExited(handle, thread, thread.exitCode, 'postYield=2');
          this._log(`[ThreadManager] Thread ${thread.tid} exited (postYield=2) prev_eip=0x${prev.toString(16)} esp=0x${e.get_esp().toString(16)}`);
        } else if (postYield === 9) {
          // Blocked on a critical section another thread holds. EIP is still on
          // the thunk, so clearing the yield re-enters EnterCriticalSection; the
          // point of parking was to let the holder run, and it just did (or is
          // about to, later in this same round).
          if (this._traceThread && thread.waitPolls < 3) {
            const csWa = e.get_cs_wait_addr ? e.get_cs_wait_addr() >>> 0 : 0;
            const cs = csWa && e.get_image_base
              ? (csWa - 0x12000 + (e.get_image_base() >>> 0)) >>> 0 : 0;
            const esp = e.get_esp() >>> 0;
            this._log(`[ThreadManager] T${thread.tid} critical park cs=0x${cs.toString(16)} ` +
              `lock=${e.guest_read32((cs + 4) >>> 0) | 0} recursion=${e.guest_read32((cs + 8) >>> 0) >>> 0} ` +
              `owner=${e.guest_read32((cs + 12) >>> 0) >>> 0} tid=${e.get_current_thread_id() >>> 0} ` +
              `eip=0x${e.get_eip().toString(16)} esp=0x${esp.toString(16)} ` +
              `stack=[0x${(e.guest_read32(esp) >>> 0).toString(16)},0x${(e.guest_read32((esp + 4) >>> 0) >>> 0).toString(16)},0x${(e.guest_read32((esp + 8) >>> 0) >>> 0).toString(16)}]`);
          }
          e.clear_yield();
          thread.waitPolls++;
        } else if (postYield === 10) {
          this.resolveCooperativeThreadSend(e);
        } else if (sleepYielded) {
          thread.sleepUntil = sleepMs ? this._now() + sleepMs : 0;
          thread.sleepCount++;
        } else {
          thread.sleepUntil = 0;
          thread.sleepCount = 0;
        }
      }
    }
    return finishStats();
  }

  runBudgeted(options) {
    options = options || {};
    const quantumSteps = Math.max(1, (options.quantumSteps | 0) || 1000);
    const maxTotalSteps = Math.max(quantumSteps, (options.maxTotalSteps | 0) || quantumSteps);
    return this.runSlice(maxTotalSteps, {
      quantumSteps,
      maxWallMs: Number.isFinite(options.maxWallMs) ? options.maxWallMs : 0,
      stopIfMessagePending: !!options.stopIfMessagePending,
      prioritizeAudioThreads: !!options.prioritizeAudioThreads,
    });
  }

  // Also check main thread for yield (WaitForSingleObject)
  async resolveMainThreadSend() {
    if (!this.workerBackend) return false;
    const e = this.mainInstance.exports;
    if (!e.get_yield_reason || (e.get_yield_reason() | 0) !== 10) return false;
    await this.workerBackend.resolveThreadSend(this.workerBackend._localLink, {
      targetTid: e.get_send_target_tid() | 0,
      hwnd: e.get_send_hwnd() | 0, msg: e.get_send_msg() | 0,
      wparam: e.get_send_wparam() | 0, lparam: e.get_send_lparam() | 0,
      postKind: e.get_send_post_kind ? e.get_send_post_kind() | 0 : 0,
    });
    return true;
  }

  _cooperativeTargetExports(win32Tid) {
    if ((win32Tid | 0) === 1) return this.mainInstance.exports;
    for (const [, thread] of this.threads) {
      if ((thread.tid | 0) === ((win32Tid | 0) - 1) && thread.state === 'active'
          && thread.instance) return thread.instance.exports;
    }
    return null;
  }

  _snapshotCooperativeSend(ex) {
    const g = name => ex[name] ? ex[name]() | 0 : 0;
    return {
      eip: g('get_eip'), esp: g('get_esp'), ebp: g('get_ebp'), eax: g('get_eax'),
      ebx: g('get_ebx'), ecx: g('get_ecx'), edx: g('get_edx'),
      esi: g('get_esi'), edi: g('get_edi'),
      handlerSetEip: g('get_handler_set_eip'), steps: g('get_steps'),
      yieldReason: g('get_yield_reason'), yieldFlag: g('get_yield_flag'),
    };
  }

  _restoreCooperativeSend(ex, s) {
    ex.set_esp(s.esp); ex.set_ebp(s.ebp); ex.set_eax(s.eax);
    ex.set_ebx(s.ebx); ex.set_ecx(s.ecx); ex.set_edx(s.edx);
    ex.set_esi(s.esi); ex.set_edi(s.edi);
    ex.set_handler_set_eip(s.handlerSetEip); ex.set_steps(s.steps);
    ex.set_yield_state(s.yieldReason, s.yieldFlag); ex.set_eip(s.eip);
  }

  _dispatchCooperativeSend(target, request, depth) {
    if (!target || depth > 64) return 0;
    const saved = this._snapshotCooperativeSend(target);
    if ((request.postKind | 0) === 1 && (!request.wparam || !request.lparam)) {
      const result = target.thread_send_post ? target.thread_send_post(
        request.hwnd | 0, request.msg | 0, request.wparam | 0, request.lparam | 0,
        request.postKind | 0, 0) | 0 : 0;
      this._restoreCooperativeSend(target, saved);
      return result;
    }
    const asyncDispatch = target.thread_send_begin(
      request.hwnd | 0, request.msg | 0, request.wparam | 0, request.lparam | 0) | 0;
    if (!asyncDispatch) {
      const result = target.get_eax() | 0;
      const finalResult = target.thread_send_post ? target.thread_send_post(
        request.hwnd | 0, request.msg | 0, request.wparam | 0, request.lparam | 0,
        request.postKind | 0, result | 0) | 0 : result;
      this._restoreCooperativeSend(target, saved);
      return finalResult;
    }
    let result = 0;
    for (let round = 0; round < 64; round++) {
      try { target.run(1000000); } catch (_) { break; }
      const y = target.get_yield_reason ? target.get_yield_reason() | 0 : 0;
      if (y === 10) {
        const nestedTarget = this._cooperativeTargetExports(target.get_send_target_tid() | 0);
        const nested = this._dispatchCooperativeSend(nestedTarget, {
          hwnd: target.get_send_hwnd() | 0, msg: target.get_send_msg() | 0,
          wparam: target.get_send_wparam() | 0, lparam: target.get_send_lparam() | 0,
          postKind: target.get_send_post_kind ? target.get_send_post_kind() | 0 : 0,
        }, depth + 1);
        target.complete_thread_send(nested | 0);
        continue;
      }
      if (y) break;
      if (!(target.get_eip() >>> 0)) {
        result = target.thread_send_end() | 0;
        if (target.thread_send_post) result = target.thread_send_post(
          request.hwnd | 0, request.msg | 0, request.wparam | 0, request.lparam | 0,
          request.postKind | 0, result | 0) | 0;
        break;
      }
    }
    // If a trap or unrelated blocking yield aborted this nested dispatch, keep
    // sync_msg_depth balanced before restoring the interrupted context.
    if (target.get_eip() >>> 0) target.thread_send_end();
    this._restoreCooperativeSend(target, saved);
    return result | 0;
  }

  resolveCooperativeThreadSend(sender) {
    if (!sender || !sender.get_yield_reason || (sender.get_yield_reason() | 0) !== 10) return false;
    const target = this._cooperativeTargetExports(sender.get_send_target_tid() | 0);
    const result = this._dispatchCooperativeSend(target, {
      hwnd: sender.get_send_hwnd() | 0, msg: sender.get_send_msg() | 0,
      wparam: sender.get_send_wparam() | 0, lparam: sender.get_send_lparam() | 0,
      postKind: sender.get_send_post_kind ? sender.get_send_post_kind() | 0 : 0,
    }, 0);
    sender.complete_thread_send(result | 0);
    return true;
  }

  checkMainYield() {
    const e = this.mainInstance.exports;
    const yr = e.get_yield_reason();
    if (yr === 10) {
      this.resolveCooperativeThreadSend(e);
      return false;
    }
    if (yr === 9) {
      // Blocked on a critical section another guest thread holds. Clear it so the
      // call is re-entered next batch, by which time the caller has given the
      // other threads a turn. Never spin in WAT for this: the holder may be
      // parked in Atomics.wait for a host import only this thread can serve.
      //
      // A safety net as things stand — the guest's main thread does not park
      // (see $handle_EnterCriticalSection) — and cheap enough to keep so that a
      // change to that rule degrades instead of hanging.
      e.clear_yield();
      return false;
    }
    if (yr === 7) {
      if (!this._hasPendingMessage(e)) {
        this._mainWaitPolls = (this._mainWaitPolls || 0) + 1;
        return true;
      }
      this._mainWaitPolls = 0;
      this._mainWaitStartedAt = 0;
      const retAddr = e.guest_read32 ? e.guest_read32(e.get_esp()) : 0;
      if (e.resume_message_wait && (e.resume_message_wait() | 0)) {
        e.set_eip(retAddr);
      } else {
        return true;
      }
      return false;
    }
    if (yr === 9) {
      // As with a worker, retry the same import thunk. Returning false lets
      // the caller execute one main slice; if still contended it immediately
      // yields again and workers get the rest of the scheduler turn.
      e.clear_yield();
      this._mainWaitPolls = (this._mainWaitPolls || 0) + 1;
      return false;
    }
    if (yr !== 1) return false; // not waiting

    const waitHandle = e.get_wait_handle();
    const waitHandlesPtr = e.get_wait_handles_ptr ? e.get_wait_handles_ptr() : 0;
    const waitAll = e.get_wait_all ? !!e.get_wait_all() : false;
    const waitTimeout = e.get_wait_timeout ? (e.get_wait_timeout() >>> 0) : 0xFFFFFFFF;
    const waitStackBytes = e.get_wait_stack_bytes ? (e.get_wait_stack_bytes() | 0) : (waitHandlesPtr ? 20 : 12);
    let result;
    if (waitStackBytes === 24 && !waitHandlesPtr) {
      result = this._hasMessage && this._hasMessage() ? waitHandle : 0xFFFF;
    } else if (waitHandlesPtr && this._hasMessage && this._hasMessage()) {
      result = waitHandle; // MsgWaitForMultipleObjects returns WAIT_OBJECT_0 + nCount.
    } else if (waitHandlesPtr) {
      result = this.waitMultiple(waitHandle, waitHandlesPtr, waitAll, 0);
    } else {
      result = this.waitSingle(waitHandle, 0);
    }
    if (result === 0xFFFF || result === 0x102) {
      const syncIdx = waitHandlesPtr ? -1 : this._getSyncIdx(waitHandle);
      if (
        !this.hasActiveThreads() &&
        waitTimeout === 0xFFFFFFFF &&
        syncIdx >= 0 &&
        this.syncView[syncIdx * 4 + 1] === 1
      ) {
        result = 0;
      } else if (waitTimeout !== 0 && waitTimeout !== 0xFFFFFFFF) {
        const now = Date.now();
        if (!this._mainWaitStartedAt) this._mainWaitStartedAt = now;
        if ((now - this._mainWaitStartedAt) >= waitTimeout) {
          result = 0x102;
        } else {
          this._mainWaitPolls = (this._mainWaitPolls || 0) + 1;
          return true;
        }
      } else {
        this._mainWaitPolls = (this._mainWaitPolls || 0) + 1;
        return true; // still waiting
      }
    }
    this._mainWaitPolls = 0;
    this._mainWaitStartedAt = 0;

    // Signaled — complete the wait call.
    const retAddr = this._completeWait(e, result, waitStackBytes);
    this._log(`[ThreadManager] Main thread resumed from wait, handle=0x${waitHandle.toString(16)} ret=0x${retAddr.toString(16)}`);
    return false;
  }

  hasActiveThreads() {
    for (const [, t] of this.threads) {
      if (t.state === 'active' && !(t.suspendCount > 0)) return true;
    }
    return this._pendingThreads.some(thread => !(thread.suspendCount > 0));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ThreadManager };
} else if (typeof window !== 'undefined') {
  window.ThreadManager = ThreadManager;
}
