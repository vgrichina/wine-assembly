// ThreadManager: multi-instance threading for wine-assembly
// Each WASM instance = one thread, sharing the same linear memory.

const YIELD_NAMES = { 1: 'wait', 2: 'exit', 3: 'com_load_dll', 4: 'help_load', 5: 'load_library', 6: 'modal_dialog', 7: 'message_wait' };

class ThreadManager {
  constructor(wasmModule, memory, mainInstance, makeImports, opts) {
    this.module = wasmModule;
    this.memory = memory;
    this.mainInstance = mainInstance;
    this.makeImports = makeImports; // (threadId) => imports object

    this.threads = new Map(); // handle → { instance, state, startAddr, param, stackSize }
    this._nextHandle = 0xE1000;
    this._pendingThreads = []; // threads awaiting spawn
    this._spawnedCount = 0; // total threads ever spawned
    this._maxWorkerThreads = 7; // fixed decoded-cache layout reserves worker slots 1..7
    this._log = (typeof console !== 'undefined') ? console.log.bind(console) : () => {};
    this._quietTM = (typeof process !== 'undefined' && process.env && process.env.QUIET_TM) ? true : false;
    opts = opts || {};
    this._traceThread = !!opts.traceThread;
    this._traceYield = !!opts.traceYield;
    this._onThreadExit = typeof opts.onThreadExit === 'function' ? opts.onThreadExit : null;
    this._breakThreadFilter = (opts.breakThreadFilter == null) ? null : opts.breakThreadFilter|0;
    this._traceCallstack = !!opts.traceCallstack;
    this._traceCallstackDepth = opts.traceCallstackDepth || 16;
    this._traceEipRange = opts.traceEipRange || null;
    this._hasMessage = typeof opts.hasMessage === 'function' ? opts.hasMessage : null;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this._profileThreadRun = typeof opts.profileThreadRun === 'function' ? opts.profileThreadRun : null;
    this._audioThreadHotUntil = new Map();
    this._audioPriorityNextHotFirst = true;

    // Synchronization table (SharedArrayBuffer backed)
    this.syncTableAddr = mainInstance.exports.get_sync_table();
    this.syncView = new Int32Array(memory.buffer, this.syncTableAddr, 64 * 4); // 64 objects, 4 ints each
  }

  markAudioThread(tid, hotMs) {
    tid = tid | 0;
    if (tid <= 0) return;
    const ms = Math.max(250, (hotMs | 0) || 1000);
    this._audioThreadHotUntil.set(tid, this._now() + ms);
  }

  _threadEntries(options) {
    const entries = Array.from(this.threads.entries());
    if (!options || !options.prioritizeAudioThreads || !this._audioThreadHotUntil.size) {
      return entries;
    }
    const now = this._now();
    for (const [tid, until] of Array.from(this._audioThreadHotUntil.entries())) {
      if (until <= now) this._audioThreadHotUntil.delete(tid);
    }
    if (!this._audioThreadHotUntil.size) return entries;
    return entries.sort((a, b) => {
      const aHot = this._audioThreadHotUntil.has((a[1] && a[1].tid) | 0) ? 1 : 0;
      const bHot = this._audioThreadHotUntil.has((b[1] && b[1].tid) | 0) ? 1 : 0;
      return bHot - aHot;
    });
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

  // Get index into sync table from handle
  _getSyncIdx(handle) {
    if (handle >= 0xE0000 && handle < 0xE0000 + 64) return handle - 0xE0000;
    return -1;
  }

  // Called from WASM host import
  createThread(startAddr, param, stackSize) {
    const tid = this._allocWorkerSlot();
    if (!tid) {
      this._log(`[ThreadManager] CreateThread failed: no decoded-cache slot for start=0x${startAddr.toString(16)}`);
      return 0;
    }
    const handle = this._nextHandle++;
    this._dropExitedSlotHandles(tid);
    this._pendingThreads.push({ handle, tid, startAddr, param, stackSize: stackSize || 0x10000 });
    this._log(`[ThreadManager] CreateThread handle=0x${handle.toString(16)} start=0x${startAddr.toString(16)} param=0x${param.toString(16)}`);
    return handle;
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
    //   0x05E52000 + tid * 0x8000, 4096 entries * 8 bytes.
    // Reusing a slot with a stale index can jump a fresh worker instance into
    // decoded blocks emitted for the prior thread's execution path.
    const cacheIndex = 0x05E52000 + tid * 0x8000;
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
    thread.state = 'exited';
    thread.exitCode = exitCode == null ? ((thread.exitCode || 0) >>> 0) : (exitCode >>> 0);
    this._audioThreadHotUntil.delete((thread.tid || 0) | 0);
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
    const t = this.threads.get(handle);
    if (!t) return 0;
    return t.state === 'exited' ? (t.exitCode >>> 0) : 0x103; // STILL_ACTIVE
  }

  createEvent(manualReset, initialState) {
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

    this._log(`[ThreadManager] CreateEvent handle=0x${handle.toString(16)} idx=${idx} manual=${!!manualReset} initial=${!!initialState}`);
    return handle;
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
    return 0;
  }

  waitMultiple(nCount, lpHandlesWA, bWaitAll, timeout) {
    const mem = new Int32Array(this.memory.buffer);
    const wa = lpHandlesWA >>> 2;
    const handles = [];
    for (let i = 0; i < nCount; i++) {
      handles.push(mem[wa + i]);
    }

    if (bWaitAll) {
      // WaitForMultipleObjects(WaitAll=TRUE) is hard to do with Atomics.wait
      // since it can only wait on one address. Fall back to polling.
      let allReady = true;
      for (let i = 0; i < nCount; i++) {
        if (this.waitSingle(handles[i], 0) !== 0) {
          allReady = false;
          break;
        }
      }
      if (allReady) return 0;
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
  async spawnPending() {
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

      // Sync heap_ptr from main after all per-thread allocations above.
      instance.exports.set_heap_ptr(main.get_heap_ptr());

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
        fsBase: tib,
        sleepCount: 0,  // track consecutive Sleep yields for deprioritization
        sleepUntil: 0,
        waitPolls: 0,
        waitStartedAt: 0,
      });
      this._spawnedCount++;

      this._log(`[ThreadManager] Spawned thread ${tid} handle=0x${pending.handle.toString(16)} EIP=0x${pending.startAddr.toString(16)} ESP=0x${(stackTop - 8).toString(16)}`);
    }
    this._pendingThreads = [];
  }

  // Run one batch across all active threads, interleaved in small slices.
  // Threads that repeatedly yield via Sleep (idle loops like timer/monitor
  // threads) are deprioritized: they run only every Nth slice, freeing
  // instruction budget for compute-heavy threads (MP3 decode, audio output).
  runSlice(batchSize, options) {
    options = options || {};
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
      if (t.state === 'active') activeCount++;
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
          const waitTimeout = e.get_wait_timeout ? (e.get_wait_timeout() >>> 0) : 0xFFFFFFFF;
          const waitStackBytes = e.get_wait_stack_bytes ? (e.get_wait_stack_bytes() | 0) : (waitHandlesPtr ? 20 : 12);
          let result;
          if (waitStackBytes === 24 && !waitHandlesPtr) {
            result = this._hasPendingMessage(e) ? waitHandle : 0xFFFF;
          } else if (waitHandlesPtr) {
            result = this.waitMultiple(waitHandle, waitHandlesPtr, false, 0); // nCount is in waitHandle
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
          e.clear_yield();
          const retAddr = this._readWaitReturnAddress(e);
          e.set_eax(result);
          // Stack depends on which API yielded.
          // WaitForSingleObject: ret + 2 args = 12 bytes
          // WaitForMultipleObjects: ret + 4 args = 20 bytes
          // MsgWaitForMultipleObjects: ret + 5 args = 24 bytes
          e.set_esp(e.get_esp() + waitStackBytes);
          e.set_eip(retAddr);
          this._log(`[ThreadManager] Thread ${thread.tid} resumed from wait, handle=0x${waitHandle.toString(16)} ret=0x${retAddr.toString(16)}`);
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

        e.set_heap_ptr(main.get_heap_ptr());
        if (main.get_dll_count) {
          const dllCount = main.get_dll_count() | 0;
          if (e.set_dll_count) e.set_dll_count(dllCount);
          else if (e.test_set_dll_count) e.test_set_dll_count(dllCount);
        }
        const eipBeforeRun = e.get_eip();
        this._runningThreadHandle = handle;
        const profileStartedAt = this._profileThreadRun ? this._now() : 0;
        let eipAfterRun = 0;
        let yieldReasonAfterRun = 0;
        let sleepYielded = false;
        let sleepMs = 0;
        let runError = null;
        try { e.run(sliceSize); } catch (err) {
          runError = err;
          this._log(`[ThreadManager] Thread ${thread.tid} crashed at EIP=0x${e.get_eip().toString(16)} ESP=0x${e.get_esp().toString(16)}: ${err.message}`);
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
        main.set_heap_ptr(e.get_heap_ptr());
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
              this._log(`[ThreadManager] T${thread.tid} WATCH 0x${wa.toString(16)} 0x${mainVal.toString(16)} -> 0x${newVal.toString(16)} eip=0x${e.get_eip().toString(16)} prev_eip=0x${prev.toString(16)} esi=0x${e.get_esi().toString(16)} ecx=0x${e.get_ecx().toString(16)}`);
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
  checkMainYield() {
    const e = this.mainInstance.exports;
    const yr = e.get_yield_reason();
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
    if (yr !== 1) return false; // not waiting

    const waitHandle = e.get_wait_handle();
    const waitHandlesPtr = e.get_wait_handles_ptr ? e.get_wait_handles_ptr() : 0;
    const waitTimeout = e.get_wait_timeout ? (e.get_wait_timeout() >>> 0) : 0xFFFFFFFF;
    const waitStackBytes = e.get_wait_stack_bytes ? (e.get_wait_stack_bytes() | 0) : (waitHandlesPtr ? 20 : 12);
    let result;
    if (waitStackBytes === 24 && !waitHandlesPtr) {
      result = this._hasMessage && this._hasMessage() ? waitHandle : 0xFFFF;
    } else if (waitHandlesPtr && this._hasMessage && this._hasMessage()) {
      result = waitHandle; // MsgWaitForMultipleObjects returns WAIT_OBJECT_0 + nCount.
    } else if (waitHandlesPtr) {
      result = this.waitMultiple(waitHandle, waitHandlesPtr, false, 0);
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
    e.clear_yield();
    const retAddr = this._readWaitReturnAddress(e);
    e.set_eax(result);
    e.set_esp(e.get_esp() + waitStackBytes);
    e.set_eip(retAddr);
    this._log(`[ThreadManager] Main thread resumed from wait, handle=0x${waitHandle.toString(16)} ret=0x${retAddr.toString(16)}`);
    return false;
  }

  hasActiveThreads() {
    for (const [, t] of this.threads) {
      if (t.state === 'active') return true;
    }
    return this._pendingThreads.length > 0;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ThreadManager };
} else if (typeof window !== 'undefined') {
  window.ThreadManager = ThreadManager;
}
