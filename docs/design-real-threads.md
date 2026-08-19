# Design: real OS threads for guest threads

**Status:** phase 0 answered, phase 1 working, **phase 2 implemented** on branch
`worktree-real-threads`. Written 2026-08-16, updated 2026-08-17.

Notepad, Calculator and Paint boot and render with the guest's main thread
executing inside a Web Worker and all 179 host imports running on the main
thread. `test/test-worker-guest.js` asserts window-count and window-title parity
against single-threaded runs, plus the COM server-load round trip.

**Phase 2: each guest `CreateThread` is its own Worker, and they all run at the
same time.** Winamp presses Play, spawns its decode thread, output thread and
visualizer helper as three Workers over the one shared memory, plays audio, and
shuts all three down cleanly — with the UI thread doing nothing but serving host
imports and compositing. `ThreadManager.backend` reads `'worker'`; without
isolation it reads `'cooperative'` and the round-robin scheduler runs instead,
permanently (§3.6).

Two bugs that phase 2 uncovered, both older than phase 2:

- **A parked wait had to be COMPLETED, not cleared.** Worker mode answered yield 1
  with `clear_yield()`. `$run` pops the saved return address whenever a handler
  leaves EIP alone, so by then the guest is already past the call with its stdcall
  arguments still on the stack; only completing the wait drops them. It leaked 12
  bytes of guest stack per wait and killed Winamp at `EIP=0xffffffff` six seconds
  into playback. Invisible until guest threads ran, because until then nothing
  ever satisfied a wait.
- **The RPC control block was inside the DIB arena.** `lib/guest-rpc.js` used
  `0x1F000000`, 48MB into the `CreateDIBSection` pool. A big enough DIB would have
  overwritten a worker's status word and parked it forever. The blocks now live in
  `$THREAD_RPC` at the top of memory, declared in the WAT, one 256-byte block per
  thread — which is what N threads needed anyway.

**Every yield the WAT actually raises is now handled in worker mode** — 1 wait,
2 exit, 3 com_load_dll, 5 load_library, 6 modal_dialog, 7 message_wait, 8
net_wait. Reason 4 was listed as `help_load` in `thread-manager.js` and is set by
nothing in the codebase; the help engine fetches through host imports rather than
parking the guest. It has been dropped from the map, because leaving it there
made worker mode look like it had two async yields left to port when it had one.

Not done: cross-thread `SendMessage` still runs the target's wndproc on the
calling thread rather than blocking the sender on the owner's queue, and the
window/class/timer tables are unlocked on a single-owner argument nothing enforces
(§3.1b). Off by default, behind the Threads switch and cross-origin isolation.

### What the implementation actually looks like

```
  MAIN THREAD                          WORKER slot 0        WORKER slot 1..N
  ───────────────────────────────      ─────────────────    ─────────────────
  createHostImports()  ← unchanged     guest main thread    one per CreateThread
  broker.serveRpc(slot) ←── Atomics.wait ── host call ───── host call
  broker.serveCall()    ←── postMessage ─── void call ───── void call
  publish(tick, inputPending) ── shared ──▶ read locally ─▶ read locally
  resolve DLL bytes ──────────────────▶ loadDll + DllMain
  drive slices ───────────────────────▶ run(steps) ────────▶ run(steps)
        └─ Promise.all: slot 0 and every thread run AT THE SAME TIME
  resolve waits vs the sync table ────▶ completeWait ──────▶ completeWait
  composite, input, audio, registry     own code cache       own code cache
        └──────────── one shared WebAssembly.Memory ────────────┘
```

Four rules fell out of getting it to work, and each came from a failure:

1. **Guest execution belongs wherever the instance is.** DLL loading looked like
   host work and is not — it sets EIP/ESP and calls `run()` for DllMain. Left on
   the main thread it produced "Offset is outside the bounds of the DataView".
2. **Main-side writes to guest globals must be routed.** `set_winver` written to
   the idle main instance succeeded and did nothing, so `GetVersion` still said
   Win98 and MFC42U refused to load. `wine.callGuest()` now reaches the running
   instance; `set_hwnd_base` and `set_extra_cmdline` had the same bug.
3. **Yield handling must be local.** Clearing yield 7 and retrying leaves the
   guest re-entering its message wait forever: the frame paints, the caption and
   scrollbars never do. The resume sequence is three instance calls, so it moved
   into the worker.
4. **Void does not mean fire-and-forget.** A void import taking a pointer is read
   after the guest has run on, by which time the buffer may be reused —
   `log(ptr, len)` exactly. Only value-argument void calls may skip the trip.
5. **A parked yield is not idle state — the guest has already moved.** `$run`
   pops the return address whenever a handler leaves EIP alone, so answering a
   wait yield with `clear_yield()` resumes the guest past the call with the
   stdcall arguments still on its stack. Twelve bytes a wait, and the app dies
   later, somewhere else, at `EIP=0xffffffff`.

**Goal:** each guest thread runs on its own Web Worker, executing at the same
time as the others, with the UI thread doing nothing but input and compositing.

**Non-goal:** making a single-threaded app faster. Nothing here raises the
~10-20M x86 steps/sec a single guest thread gets. This is about *concurrency*
and about the UI never being hostage to guest execution.

**Hard constraint:** the emulator must stay fully functional with no threads at
all. Isolation is unavailable in Safari private browsing, in a cross-origin
iframe, on a first visit before the service worker takes over, and in the CLI —
so today's cooperative scheduler is a permanent second mode, not scaffolding.
See §3.6.

---

## 1. Why this is worth doing

The immediate cause is a bug that took a day to find (`b7b4d4e`). Guest threads
and the browser's input handling share one JS thread, so the scheduler had to
choose between them, and it chose input:

```js
// host.js, before the fix
const threadBudget = windowCount ? (recentInputWake ? 0 : activeStepsPerSlice) : ...
```

A mouse-driven game therefore stopped whenever the mouse moved — pointer events
arrive every ~16ms, the input window is 120ms, so the thread running the game
got zero steps for as long as a human was playing. The fix reserves a quarter
slice instead of nothing, which is a better compromise, but it is still a
compromise between two things that should not be competing at all.

Everything downstream of that shared thread has the same shape:

| Symptom | Cause |
|---|---|
| Guest stalls while the pointer moves | input and guest share a thread |
| Page GC pause becomes a guest stall | same heap, same thread |
| Audio underruns under UI load | `waveOut` worker competes with paint |
| Worker quantum tuning (`maxWallMs` 4/6/8/12/16) | hand-balancing one thread |
| Guest threads never actually overlap | cooperative round-robin |

Four of those five are not bugs to fix; they are properties of running an
operating system's threads inside one event loop.

### Measured benefit

`threads-probe.html` runs an identical paint workload three ways and measures
what the page feels. The workload is calibrated to a 14ms uninterrupted chunk,
because that is Blobby's measured step p50 — a workload that yields every 2ms
cannot block input on any thread, and measuring one proves nothing.

**Safari, run by hand, 2026-08-17** — the measurement that counts, since the
guest is played in a real browser and this is the engine half the jank reports
come from:

```
                       page fps   frame p50/p99   input latency p50/p99/max   paint fps
  idle baseline          60.2      16.7 / 24.7     0.2 / 11.6 / 32 ms            —
  paint on MAIN          60.5      15.3 / 24.9     0.4 / 18.7 / 29 ms          83.0
  same work, 2 WORKERS   60.0      16.7 / 18.7     0.2 /  1.7 /  2 ms         160.3
```

Read it with the machine in mind — it was under heavy load, and **the idle row
proves it**: an 11.6ms latency p99 and a 24.7ms frame p99 with *no work at all*
is not a floor, it is contention. The worker row even beats idle on latency
(1.7ms vs 11.6ms), which is impossible as a causal claim and is simply the noise
moving between samples. So the absolute deltas are lower bounds, not values.

What survives that, because each is a ratio measured inside the same seconds:

1. **Input latency p99: 18.7ms → 1.7ms, an order of magnitude.** Even against
   the inflated idle baseline, the main-thread version adds ≥7ms of queueing to
   every input before a handler can run.
2. **Frame p99: 24.9ms → 18.7ms**, while idle sat at 24.7ms — the worker version
   is the only one that beat the ambient noise.
3. **Throughput 1.93× on two workers** (83.0 → 160.3), near-linear. This is the
   most load-robust number here and the one the rejected single-worker variant
   cannot deliver at all.
4. **Safari renders from a worker at all.** `transferControlToOffscreen` plus
   `putImageData` inside the worker was the last untested dependency of phase 1,
   and it sustained 160 blits/sec.

An earlier Chrome run (headless, load ~4) gave the same shape — latency p99
12.4ms → 0.1ms and 1.69× throughput. Treat that one as evidence the mechanism
works rather than as a measurement: see the note on measuring perf headlessly in
§6.

And a fourth, which matters for how any of this gets reported: **page fps reads
60.0 in all three rows.** The number most likely to be quoted is the one number
that cannot detect the problem — the same trap that hid the mouse-starvation
bug (§6).

---

## 2. Where we actually are

The name is misleading: `lib/thread-manager.js` does not create OS threads.

```
        MAIN JS THREAD
  ┌───────────────────────────────────────────────────────┐
  │ host.js run(): setTimeout(step, 0) chain              │
  │   ├─ main instance   .run(steps)                      │
  │   ├─ T1..T7 instances .run(steps)   ← round-robin,    │
  │   │                                   same JS thread  │
  │   └─ flushRepaint → canvas                            │
  └───────────────────────────────────────────────────────┘
   one WebAssembly.Module, N Instances, ONE shared memory
```

- `host.js:708` — `new WebAssembly.Memory({initial: 8192, maximum: 8192, shared: true})`.
  **The memory is already shared.**
- `thread-manager.js:501` — every thread is `WebAssembly.instantiate(this.module, imports)`
  against that same memory. **The module is already instance-per-thread.**
- `thread-manager.js:41` — the sync table (events, semaphores) is already an
  `Int32Array` over that memory driven by `Atomics.store/notify/wait`.
  **The synchronisation primitives are already atomic.**
- `13-exports.wat:1914 init_thread` — per-thread decoded-code cache
  (`THREAD_BASE = 0x05000000 + tid*4MB`) and per-thread cache index
  (`CACHE_INDEX = 0x07152000 + tid*0x8000`). **The hottest mutable emulator
  structure is already partitioned per thread.**

That is most of the hard part of a threaded design, built for reasons that had
nothing to do with threads. What is missing is not the memory model — it is
that nobody has ever run two of these instances *at the same instant*, so
everything shared has been protected by accident, by there being one thread.

---

## 3. What actually blocks parallel execution

### 3.1 Emulator-private mutable state (the real work)

Guest memory races are the guest's problem — Win98 had them too, and an app
that corrupts its own heap from two threads is behaving authentically. What we
cannot allow is *our own* bookkeeping racing, because that corrupts the
emulator rather than the emulated program.

```
  SHARED, MUTABLE, TOUCHED BY ANY THREAD          strategy
  ───────────────────────────────────────────────────────────────
  low heap bump           $heap_ptr/$heap_end     → per-thread arenas ✅ DONE
  free-list allocator     $free_list (global!)    → per-instance, correct
                                                    once arenas are disjoint ✅
  sparse heap bump        $heap_sparse_ptr        → per-thread arenas ✅ already
  VirtualAlloc top        $virtual_alloc_top      → shared cell ✅, lock ✗
  virtual map table       VIRTUAL_MAP_TABLE       → append-only publish (§3.1a)
  window table            WND_RECORDS  0x7000     → main-thread-only (§3.3)
  class table             CLASS_RECORDS           → main-thread-only
  timer table             TIMER_TABLE             → main-thread-only
  post queue              0x400 ring              → lock-free SPSC per thread
  DX objects / COM        0x07FF0000              → lock, coarse
  socket table            09d-winsock.wat         → lock, coarse
  DLL table               0x04462000              → immutable after load
  decoded-code cache      per-tid partition       → already safe
```

### 3.1a What the heap actually did, and what replaced it

An earlier draft of this section claimed `$free_list` and `$virtual_alloc_top`
were live corruption bugs. Both claims were wrong, and how they were wrong is
the useful part:

- **`$virtual_alloc_top` already keeps its authoritative cursor in shared
  memory** at `VIRTUAL_MAP_STATE+8` (`10-helpers.wat` `$virtual_reserve_down`);
  the global is only a cache. Divergence was handled. What remains is that the
  read-modify-write is plain rather than atomic — harmless while instances
  interleave only at slice boundaries, unsound under real parallelism.
- **`$free_list` on its own cannot cause an overlap.** A private free list only
  means a block freed by one instance is never reused by another: fragmentation,
  not corruption. Two instances can only hand out the *same* block if their bump
  cursors overlap. It stays per-instance, deliberately.
- **`$heap_ptr` was the real one**, and it was mitigated in a way worth
  understanding, because that mitigation is what phase 2 deletes:

```
  thread-manager.js, per slice, per thread — the OLD protocol
  ─────────────────────────────────────────────────────────────
     e.set_heap_ptr(main.get_heap_ptr())     ← sync IN   (was line 863)
     e.run(sliceSize)
     main.set_heap_ptr(e.get_heap_ptr())     ← sync OUT  (was line 944)

  This makes a per-instance global behave like shared state, and it is
  CORRECT — but only because exactly one instance runs at a time and JS gets
  to run in between. It has two failure modes:

   1. worker mode (phase 1): ThreadManager's `main` is the main-thread
      instance, which in worker mode is IDLE — the guest runs elsewhere. So
      threads sync against a stale cursor and allocate over the live heap.
   2. phase 2: there is no "in between" to marshal in. Slices overlap.
```

The replacement is a process cursor in memory (`HEAP_SHARED`) from which each
instance reserves a 1MB chunk, then bump-allocates privately inside it:

```
  shared, in memory:  HEAP_SHARED+0  next unreserved chunk   (cold: ~1 write/MB)
                      HEAP_SHARED+4  heap_base, immutable after load
  private globals:    $heap_ptr, $heap_end, $free_list       (hot: every alloc)
```

Measured frequency justifies the split: MSPaint's entire MFC boot is 215
`HeapAlloc` calls and Blobby's steady state is zero, against 10–28M x86 steps
per second. Atomicity on the reservation is therefore free; what is *not* free is
a lock on the fast path, and — more decisively — the main thread is not allowed
to `Atomics.wait`, so any lock it can contend has to spin the UI thread. Hence
partitioning rather than locking, even though both cost nothing measurable.

One non-obvious consumer: `08b-dll-loader.wat` used `$heap_ptr` as the
*process-wide* high-water mark, both to push the heap past a freshly loaded DLL
and, in `$next_dll_addr`, to place the next image clear of the heap. Once
`$heap_ptr` bounds one instance's arena that is no longer the right number, and
using it puts heap blocks on top of `mfc42`'s code — WordPad crashes at
`0x011341c4` in a zeroed page. Those two sites now call `$heap_reserve_below`
and `$heap_low_watermark`, which operate on the shared cursor.

`test/test-heap-partition.js` pins the invariant with two instances over one
shared memory and no marshalling at all — the phase-2 shape, testable today
without a browser or a worker.

### 3.1b What phase 2 had to fix first, and what is still open

✅ **Atomic opcodes.** `lib/compile-wat.js` now emits all 67 atomic mnemonics.
This was not a missing feature so much as a trap: `tools/build.sh` compiles with
that file rather than `wat2wasm`, and `emitOp` answers an unknown mnemonic with a
`console.warn` and a `0x00` (unreachable) byte. A mutex written in instructions
the compiler did not know would have compiled, instantiated, and trapped the first
time it was taken. Each op's required alignment is carried in the table because
atomic memargs must declare EXACTLY natural alignment, and the obvious substring
heuristic reads `i64.atomic.rmw32.add_u` as a 64-bit access.
`test/test-wat-atomics.js` runs two OS threads through `cmpxchg`.

✅ **`VIRTUAL_MAP_STATE` / `VIRTUAL_MAP_TABLE`.** Writers take
`$LOCK_VIRTUAL_MAP`; readers never do. `$virtual_map_commit` fills the record and
zeroes its backing, then publishes the count — or the extended size — with
`i32.atomic.store` LAST, so `$g2w` either sees the new entry or behaves as it did
a microsecond earlier. `$g2w` stays lock-free, which is the point: it runs on
every guest access that misses the direct window.

✅ **`DX_OBJECTS` and the socket table.** `$dx_alloc`,
`$dx_get_wrapper_for_vtbl`, `$vsock_alloc` and `$vsock_alloc_port` were all
scan-then-claim. They are serialised now, and `$vsock_alloc` claims its record
*before* releasing the lock rather than leaving it free until the caller sets a
state.

✅ **Locks get their own 64-byte line** (`$LOCK_TABLE`, one per line), and two
rules that fell out of building them:

1. **Never hold one across a host import.** A worker blocks in `Atomics.wait` for
   the main thread to serve an import; if the main thread is spinning for the lock
   that worker holds, neither ever moves. So the critical sections are pure table
   arithmetic — slot allocation — and nothing else. This is also why the mutex
   spins instead of parking: a browser main thread may not `Atomics.wait`.
2. **Never take two at once**, so there is no order to get wrong.

✅ **Two more replicated globals moved into shared memory**, both the same bug
shape as `$heap_ptr`: `$com_aux_next` (two threads hand out the same aux COM
wrapper) and `$vsock_next_port` (two threads pick the same ephemeral port, and
`$vsock_port_taken` then rejects the second bind — a connect that fails for no
visible reason).

✅ **The thunk cursor.** `$num_thunks` is both the count and the next free index,
and it was per-instance — two threads in `GetProcAddress` read the same value and
were handed the same thunk address for two different functions. The three sites
that can run on any thread (GetProcAddress and the DLL loader's two import-patching
paths) now take their index from `$thunk_reserve`, an atomic bump of a cell in
shared memory. The PE loader's ~30 sites keep bumping the local global: they run
once, before any thread exists, and reach the shared cursor through
`$update_thunk_end` — which now **adopts** the process-wide count as well as
publishing to it, because a thunk another instance allocated sits inside the zone
but past a local count, and `$run` bounds-checks EIP against `$thunk_guest_end`
before dispatching it. The slice-boundary reconciliation through the main instance
stays, but correctness no longer rests on it.

❌ **`WND_RECORDS`, `CLASS_RECORDS`, `TIMER_TABLE` are unlocked**, on the §3.3
argument that windows belong to the thread that created them. Nothing enforces
it: a guest thread that creates a window touches those tables concurrently with
the UI thread. It has not bitten in the corpus — Winamp's three threads do not
create windows — and enforcing it properly means the coarse USER/GDI lock real
Win9x had, which cannot be a spinlock under rule 1 above.

### 3.2 Host imports are the surface that must be brokered

`lib/host-imports.js` is ~4,270 lines and 111 sites touch a canvas or the
renderer. Workers cannot touch the DOM, and two of the things it needs do not
exist off the main thread at all:

| Import family | In a worker | Plan |
|---|---|---|
| GDI draw (`gdi_*`) | ✅ OffscreenCanvas | surfaces already offscreen; one per top-level hwnd, owned by whichever worker draws it |
| memory / string / CRT | ✅ pure | no change |
| `get_ticks`, timers | ✅ `performance.now()` | no change |
| file I/O, DLL fetch, help | ✅ `fetch` works in workers | no change |
| **registry / INI** (`storage.js`) | ❌ **no `localStorage`** | broker with `Atomics.wait`, or snapshot into memory at load and write back asynchronously |
| **audio** (`waveOut*`, MIDI) | ❌ `AudioContext` is main-thread | broker; ring buffer in shared memory, main thread drains |
| input (`check_input`) | ❌ events land on main | main thread writes into a shared ring; worker polls |
| screen composite | ❌ | main thread composites offscreen surfaces in z-order |

The registry is the awkward one, because WAT calls it **synchronously**:
`RegQueryValueEx` expects an answer before the instruction retires. Options,
in order of preference:

1. **Snapshot at process start** into shared memory; treat writes as
   fire-and-forget to the main thread. Registry contents are small (INI-scale).
2. `Atomics.wait` round-trip to the main thread. Correct, simple, and blocks a
   worker for a full main-thread turn — acceptable for registry, unacceptable
   for anything per-frame.
3. Move the store to IndexedDB, which workers can reach — still async, so it
   only helps if combined with (1).

### 3.3 Win32 semantics constrain the partition, helpfully

Win32 is not symmetric about threads, and that is a gift here:

- **Window ownership is per-thread.** A window belongs to the thread that
  created it, its messages are delivered on that thread's queue, and its
  wndproc runs there. So `WND_RECORDS`, `CLASS_RECORDS` and `TIMER_TABLE` can
  stay single-owner instead of locked — they belong to the UI thread, which is
  the thread that created the windows in every app in the corpus.
- **`SendMessage` across threads blocks the sender** until the receiver's
  wndproc returns. That is exactly `Atomics.wait` on a request slot, and it is
  the *documented* behaviour, not an emulator compromise.
- **`PostMessage` is asynchronous** and per-target-thread — an SPSC ring per
  thread, no lock.
- **GDI objects are process-global** but per-object serialised. A coarse lock
  around the object table is authentic enough; real GDI serialised too.

The upshot: the interesting apps (a UI thread plus one or two compute/audio
workers) map onto this cleanly. What we must not promise is two threads
drawing to the same DC in parallel; real Windows didn't either.

### 3.4 Cross-origin isolation is a deployment gate

Handing a shared `WebAssembly.Memory` to a Worker requires
`crossOriginIsolated`, i.e. both headers on every response:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Neither is set anywhere today (`tools/dev-server.js` sets none; nothing in the
tree mentions COOP/COEP). Locally that is a two-line change. **On
wine-assembly.berrry.app it is unknown whether headers can be set at all**, and
if they cannot, this design ships to localhost only. `require-corp` also breaks
any cross-origin subresource that lacks CORP — worth auditing before starting.

Measured 2026-08-16, `curl -sI https://wine-assembly.berrry.app`:

```
HTTP/2 200      server: cloudflare      x-render-origin-server: Render
(no cross-origin-opener-policy, no cross-origin-embedder-policy)
```

So production is **not** isolated today. Two mitigating facts:

- The page has no cross-origin *subresources* — the only external URLs in
  `index.html` are two anchor `href`s (berrry remix link, GitHub). So
  `require-corp` would break nothing in the page itself.
- If the platform cannot set headers, a **service worker can synthesise them**
  (§3.5).

That downgrades the gate from "fatal" to "one of two known paths", but it still
has to be *proved* on the real host, in Safari as well as Chrome, before phase 1
is worth starting.

### 3.5 The service-worker route to isolation

A document's isolation is decided by the headers on the response that created
it — and nothing requires that response to come from the network. A service
worker that controls the page builds its own response, and the browser reads
those headers:

```
  WITHOUT SW (today)
   browser ──navigate──▶ Render/Cloudflare ──▶ 200, no COOP/COEP
                                         crossOriginIsolated = false

  WITH SW (controlling the page)
   browser ──navigate──▶ ┌ service worker ─────────────────┐
                         │  const r = await fetch(req)     │
                         │  return new Response(r.body, {  │
                         │    headers: {...r.headers,      │
                         │      COOP: 'same-origin',       │
                         │      COEP: 'require-corp' }})   │
                         └──────────────┬──────────────────┘
                                        ▼   browser treats this as
                                            the document's response
                                         crossOriginIsolated = TRUE
```

This is not a way around the security model: a worker can only do it within its
own origin's scope, and COEP still genuinely blocks foreign subresources
afterwards. The header states intent; enforcement happens downstream either way.
It is the `coi-serviceworker` pattern, and it is how projects on header-less
hosts (GitHub Pages) ship SharedArrayBuffer today.

**Why it costs one reload.** The first navigation cannot be intercepted, because
nothing is controlling the page yet. That document is committed un-isolated; the
page registers the worker, sees `crossOriginIsolated === false`, and reloads.
Every later visit is a single load. One reload per browser profile, or after a
cache clear.

```js
// sw.js — the whole mechanism, minus edge cases
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => e.respondWith((async () => {
  const r = await fetch(e.request);
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(r.body, { status: r.status, headers: h });
})()));
```

What it gets us, and where it stops:

```
  ✅ needs zero platform cooperation — Cloudflare/Render never see it
  ✅ our page has NO cross-origin subresources (the only external URLs in
     index.html are two anchor hrefs), so require-corp breaks nothing.
     This is usually what kills the approach; here it is free.
  ✅ the SW can also stamp Cross-Origin-Resource-Policy onto CORS-fetchable
     third-party responses, if we ever add any
  ────────────────────────────────────────────────────────────────────
  ❌ opaque (no-cors) responses cannot be laundered — their bodies are
     unreadable, so a plain CDN <script> stays blocked
  ❌ Safari private browsing refuses service-worker registration
     ⇒ no SW ⇒ no isolation ⇒ single-threaded, permanently, in that mode
  ❌ shift-reload bypasses the SW for that load
  ❌ cross-origin iframe: the TOP-LEVEL document must be isolated too, and
     our SW cannot fix a frame we do not own. Note this repo already ships
     safari-private-probe.html, which embeds the app in an iframe.
  ❌ one more moving part in caching. There is deliberately no service
     worker in this tree today, and cache-staleness bugs are miserable to
     diagnose — the SW must never cache, only re-header.
```

Two of those are load-bearing for this design: Safari private mode and the
cross-origin iframe case both leave us with no isolation at all. Isolation is
therefore a **runtime capability, never a build-time assumption** — see §3.6.

### 3.6 Single-threaded mode is a permanent, first-class mode

Not a test convenience and not a temporary scaffold. There are at least four
ways a real user ends up without isolation, and the emulator has to be fully
functional in all of them:

| Situation | Isolated? |
|---|---|
| Chrome/Safari, SW installed, second visit onward | ✅ |
| First visit, before the SW controls the page | ❌ (until reload) |
| Safari private browsing (no SW registration) | ❌ permanently |
| Embedded in a cross-origin iframe we do not own | ❌ permanently |
| `test/run.js` and the whole CLI corpus | ❌ by choice |

So the shape is one build with two schedulers behind a capability check:

```js
const threaded = (typeof crossOriginIsolated !== 'undefined') && crossOriginIsolated
                 && !FORCE_SINGLE_THREAD;
```

Design rules that follow, and they constrain phase 1 rather than phase 2:

1. **The broker interface is the seam, not the worker.** Every non-pure host
   import gets a broker method (`registry.query`, `audio.push`, `input.poll`,
   `composite.blit`). In threaded mode the broker marshals to the main thread;
   in single-threaded mode it calls the same code directly, in-process. Both
   paths share one implementation of the actual work.
2. **`ThreadManager` keeps its current cooperative implementation** as the
   single-threaded backend, and gains a Worker backend. `createThread`,
   `waitSingle`, `setEvent` and friends keep their signatures — they already
   sit on `Atomics` over shared memory, which works in both modes (the
   single-threaded path just never actually blocks).
3. **No feature may exist only in threaded mode.** If an app runs threaded and
   not single-threaded, that is a bug, and the corpus will catch it because the
   corpus runs single-threaded.
4. **Both modes are tested.** CLI corpus covers single-threaded. Browser tests
   must assert both: `?threads=0` forces the fallback, so the same e2e case can
   run twice.
5. **The fallback must be silent to the user and visible to us.** No degraded
   banner; the perf HUD reports which mode it is in, since every timing number
   means something different between them.

The cost is real: two schedulers to keep honest, and every threading bug has to
be checked against "does it also happen single-threaded?". The alternative —
threaded-only — is not available, because Safari private mode alone would break
the app for a real fraction of visitors.

---

## 4. Target architecture

```
   MAIN THREAD (broker + compositor, never runs guest code)
  ┌──────────────────────────────────────────────────────────┐
  │ input events ──▶ input ring (shared memory)              │
  │ audio ring ◀── drained to AudioContext                   │
  │ registry/INI broker (Atomics.wait responder)             │
  │ composite: offscreen surfaces ──▶ screen canvas, z-order │
  │ window table / class table / timers  (single owner)      │
  └──────────────────────────────────────────────────────────┘
        │ postMessage: Module + Memory (once, at spawn)
        ▼
  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
  │ WORKER tid=0  │  │ WORKER tid=1  │  │ WORKER tid=2  │
  │ main guest    │  │ CreateThread  │  │ CreateThread  │
  │ thread        │  │               │  │               │
  │ instance+     │  │ instance+     │  │ instance+     │
  │ imports       │  │ imports       │  │ imports       │
  │ own 4MB code  │  │ own 4MB code  │  │ own 4MB code  │
  │ cache         │  │ cache         │  │ cache         │
  └───────────────┘  └───────────────┘  └───────────────┘
         └──────── one shared WebAssembly.Memory ─────────┘
              sync table (Atomics) ── unchanged
```

Each worker runs its own uninterrupted `run(steps)` loop. No wall-clock
budgets, no quantum tuning, no input-wake heuristics — those five scheduling
knobs in `host.js` all delete.

The guest's own thread is a real thread, so `Sleep`, `WaitForSingleObject` and
`SendMessage` become genuine blocking calls (`Atomics.wait`) instead of yields
that unwind to the JS event loop. That removes the yield-reason state machine
for the blocking cases, which is a simplification, not just a move.

---

## 5. Phases

Real threads from the start, as asked — but the first phase is one worker
because the *proof* is the second one.

### Phase 0 — prove isolation is reachable (a day)
- Add both headers to `tools/dev-server.js` (two lines) and assert
  `crossOriginIsolated` in a test.
- Add `sw.js` (§3.5) behind a flag, and measure the matrix that actually
  decides the plan. `threads-probe.html` + `sw-coi.js` do this; results so far,
  all on localhost:

```
                              isolated?   pipeline?   measured
  Chrome, server headers         ✅         6/6 PASS   2026-08-16 headless
  Chrome, service worker         ✅         6/6 PASS   2026-08-16 headless
  Safari, service worker         ✅         6/6 PASS   2026-08-17 by hand
  Safari, THE APP isolated       ✅         runs       2026-08-17 by hand
    (index.html + emulator under COEP require-corp: no subresource breakage,
     debug toolbar now reports "N threads in workers")
  ──────────────────────────────────────────────────────────────────────
  first visit, pre-reload        ✗ (as designed)       confirmed
  Safari private browsing        ✗ expected — no SW    NOT YET RUN
  inside safari-private-probe    ✗ expected — iframe   NOT YET RUN
  production (berrry.app)        ?  needs sw-coi.js deployed
```

  The three unmeasured rows are all *fallback* cases: what they must show is not
  isolation but that the emulator still runs. They are the reason §3.6 exists.

  The right-hand column is the real deliverable of phase 0: the capability
  check and fallback path exist and work *before* anything depends on
  isolation. That way the threading work can never strand a browser.
- Deliverable: `crossOriginIsolated` true in at least Chrome and Safari
  non-private on the real host, plus a documented single-threaded path
  everywhere else.

### Phase 1 — the guest main thread moves off the UI thread (the real work)
- Worker bootstrap: `postMessage({module, memory})`, instantiate in worker.
- **Broker interface first, both backends from day one** (§3.6 rule 1): every
  non-pure import goes through a broker whose direct in-process backend is
  today's behaviour. Land and ship that refactor *before* the worker exists —
  it is a no-op change that the corpus can validate on its own.
- Broker: input ring, audio ring, registry snapshot + writeback, log/trace
  forwarding.
- Compositor: main thread owns the screen canvas and blits offscreen surfaces;
  workers never touch the screen.
- ✅ Partition the low heap per instance and delete the per-slice cursor
  marshalling (§3.1a). Required for worker mode, not just for phase 2.
- ✅ Port every async yield the WAT raises. `com_load_dll` splits the same way
  `load_library` does: the name and the DLL bytes resolve on the main thread,
  the image load, DllMain and the guest resume happen in the worker. The success
  path must NOT advance ESP — clearing the yield re-enters the CoCreateInstance
  handler, which retries and now finds the class registered — while the miss path
  must return an HRESULT and drop the frame, or the guest parks forever.
  Unexercised by the corpus: no app registers a COM server in HKCR for a DLL we
  do not preload, so the test drives the worker message path directly.
- **Exit criterion:** corpus green in *both* modes, and the perf HUD shows
  `page fps` unchanged while `GAME fps` is unaffected by continuous mouse
  movement — the exact measurement that caught `b7b4d4e`.

### Phase 2 — N workers actually running at once  ✅ implemented
- ✅ **Atomic opcodes in `lib/compile-wat.js`** (§3.1b). Nothing else in this
  phase could be made correct without them.
- ✅ `CreateThread` spawns a Worker instead of an in-process instance.
  `ThreadManager` keeps both backends: the cooperative one is unchanged and stays
  the CLI default, and the worker one reuses all of its bookkeeping. Handles, the
  sync table, exit codes and suspend counts live in JS or shared memory, so
  `waitSingle`/`waitMultiple` needed no changes at all — a worker-backed thread is
  a record in the same map. What differs is only where the instructions run.
- ✅ Coarse locks on the shared tables; `VIRTUAL_MAP_TABLE` publish-ordered
  instead of locked, since `$g2w` reads it per access.
- ❌ Cross-thread `SendMessage` over `Atomics.wait`. Still runs the target's
  wndproc on the calling thread, as it did in the cooperative backend. Doing it
  properly means a per-thread message queue and blocking the sender until the
  owner's pump dispatches it — the authentic behaviour, and its own piece of work.

Three things the split had to get right, each learned from a failure:

- **PE metadata comes from the guest's main thread, not `this.mainInstance`.** In
  worker mode the main-thread instance never loaded the image, so its
  `$image_base`, `$code_start` and thunk globals answer with plausible-looking
  zeros.
- **The stack, TIB and TLS block are allocated inside the new worker**, not on the
  main thread, for the same reason: `g2w` is image-base relative, so addresses
  computed against the idle instance point nowhere. The shared heap cursor means
  the allocation is safe from either side; the *translation* is not.
- **`ExitThread` takes no handle.** The cooperative backend knows who called it
  because it just called `run()` on that instance. The worker backend has to be
  told, so the RPC slot of the thread currently inside a host import is published
  while it is served.

- **Exit criterion, partially met:** a three-thread app (Winamp playing an MP3)
  runs with every thread in its own Worker and the UI thread only brokering —
  asserted in `test/test-worker-guest.js`. The *throughput* half is unmeasured:
  fps and steps/sec must come from a real browser on an unloaded box, never from
  headless Chrome, and this box has been at load 20-70 all session.

### Phase 3 — cleanup
- Delete the scheduling heuristics **from the threaded path only**: the
  input-wake gate, `runBudgeted`'s wall-clock caps, and the
  `_isAudioHot`/`_hasOpenMenu` priority hacks all still earn their keep in the
  single-threaded fallback, which remains the CLI default and the Safari-private
  path. This is the one place where "delete the hack" does not apply.
- ~~`test/run.js` stays single-threaded by default; add `--threads` to opt in.~~
  **Done.** `node test/run.js --exe=… --threads` gives every guest thread a node
  `worker_thread` over the one shared `WebAssembly.Memory`. `--threads-serial`
  runs them one at a time (the CLI twin of `?threads-serial`), and
  `--thread-batch-size=N` sets the steps per worker slice.

  **What it covers, and what it deliberately does not.** The guest's *main*
  thread stays in-process: 237 sites in `run.js` call `instance.exports` directly,
  and putting them behind an async proxy is a different change. So this is not the
  browser's shape, where slot 0 is a Worker too. What it does buy, on every run and
  headlessly: the WAT's shared-memory locks and publish ordering under genuine
  parallelism, the per-thread RPC blocks, the worker scheduler, and the
  wait-completion path — plus one thing the browser cannot check, that no WAT lock
  is ever held across a host import, because here the main thread both runs guest
  code and serves the workers' RPC (get that wrong and the run hangs instead of
  failing, which is what the test's timeout is for).

  `test/test-cli-worker-threads.js` runs WordPad on both backends and compares:
  13 checks, including that the same thread lifecycle happened, that an event
  signalled in one OS thread woke a wait parked in another in both directions, and
  that both backends did the same amount of guest-visible work (11958 API calls
  each, exactly). `test-wordpad-thread-startup.js` and `test-winamp-audio.js` now
  accept `--threads` and run their own assertions against either backend.

  **Two sizing traps, both found by this, both about wakeups rather than steps.**
  A worker's slice size is only the granularity of its round trip — nothing on the
  host is blocked while it runs — so it must not be `BATCH_SIZE`, which apps set as
  low as 100. But the number of *rounds* per batch matters more: Winamp's decoder
  does one buffer's worth of work and parks on its event again, so its slice ends on
  the yield however large the slice was. One round per batch gave it a quarter of the
  cooperative backend's wakeups and the captured PCM came out 4x behind. The worker
  branch therefore mirrors the cooperative one: `THREAD_SLICES` rounds per batch,
  main running between them.

### Critical sections that actually exclude

`EnterCriticalSection` used to bump the counters and write `OwningThread = 1`,
excluding nobody. That is survivable when one instance runs at a time and is not
a basis for real threads: two threads inside one section corrupt whatever it was
protecting, and the damage surfaces far away as bad data. It is what Winamp's
worker-mode audio was — samples decoded at 1/500 amplitude, or none.

`OwningThread` is now the lock word, claimed with `i32.atomic.rmw.cmpxchg`. It
holds `$current_thread_id`, which is exactly what `GetCurrentThreadId` returns,
because guest CRT and MFC lock code reads this field and compares it against that
— it has to be the same number, not a private one. 0 is free, and no thread id is
ever 0 (main is 1, a spawned thread is tid+1).

Four things this had to get right:

- **It cannot spin.** The holder is another guest thread, and on the browser's
  main thread — or the CLI's, which both runs guest code and serves the workers'
  host imports — spinning is the deadlock: the holder is parked in `Atomics.wait`
  for an import that only the spinning thread would have served. So a contended
  Enter parks the whole API call with a new yield reason (9), the way a blocking
  socket call does: EIP stays on the thunk and clearing the yield re-enters the
  same call. All four schedulers clear it — cooperative threads, worker threads,
  `checkMainYield`, and host.js.
- **`$cs_block` must not touch ESP.** The winsock equivalent subtracts, because
  those handlers pop their frame on entry and have to put it back; this one parks
  before popping. Subtracting dropped ESP by 8 per park, and WordPad's thread
  trapped after three of them.
- **A section can be lost rather than held.** A thread that traps or exits inside
  one never releases it, so waiting forever turns a bug into a hang with no
  output. After 2000 fruitless rounds the section is taken, and `$cs_steals`
  counts it so the run can say so.
- **Only spawned threads park; the guest's main thread barges.** This is a
  measured limit, not a preference. The main thread is the one that runs
  wndprocs, dialogs and JS-driven message sends, and several of those nest an
  interpreter run *without* raising `$sync_msg_depth` — parking out of one
  unwinds a frame nobody can rebuild, and browser Winamp died at `EIP=0x113` (a
  message id executed as code) every time it happened. A spawned thread owns its
  stack from its first instruction and parks safely, which is where the exclusion
  was needed anyway: worker threads excluding each other is what took worker-mode
  audio from near-silence to full scale. `$cs_barges` counts every entry that
  therefore was not excluded, including the `$sync_msg_depth` cases on any thread.
- **Nothing is taken by force, by default.** The first version took a section
  after 2000 fruitless rounds so that a lost section could not hang the app. It
  hangs nothing and corrupts instead: a steal rewrites `LockCount` and
  `RecursionCount` under a thread that still believes it owns the section, guest
  CRT lock code reads those fields, and two of Winamp's worker threads ended up
  jumping into a heap structure — `EIP` = out_wave's thread parameter + 0xc — and
  trapping. Controlled: the same 6000-batch run traps **twice** with a 2000-round
  steal and **zero** times with stealing off. So the default is effectively never,
  `--cs-steal-after=N` sets it, and a waiter that cannot proceed parks with a
  climbing `$cs_waits` — a stuck thread rather than damage somewhere else.
- **A non-owner `Leave` still releases.** NT would refuse, and refusing is the
  wrong trade here: this emulator still runs some guest callbacks on the calling
  thread rather than the owning one (cross-thread `SendMessage` is not
  implemented), so Enter-here-Leave-there is reachable through no fault of the
  guest. A section never released is a hang; one released early is the race we
  already had. Win9x did not check either. `$cs_bad_leaves` counts it. It frees the
  section **without touching the counters** — decrementing on behalf of a thread
  that never entered is what walked `RecursionCount` past zero and cost a whole
  session; see "It was the non-owner `Leave`" below.

One more trap, worth recording because it is not specific to this handler:
`$run`'s thunk-zone auto-pop fires whenever a handler leaves EIP alone — yield or
no yield — and sets `EIP = [ESP]`, splicing the call out entirely. A parking
handler must raise `$handler_set_eip`, the way every `CACA000x` continuation
does. Without it the guest resumed past the call without the section and with its
argument still on the stack: four bytes per park, and a dead thread later at a
garbage EIP. **`$vsock_block` in `src/09d-winsock.wat` had the same defect** — a
parked blocking socket call was spliced out too, resuming past its own `connect`
or `recv` having never made it, and drifting ESP by the frame size on every park.
Fixed, and verified where it can actually be seen: `test-vlan-tetrinet.js` runs
two real emulator processes through a blocking accept and recv round trip
(`test-vlan-wire.js` asserts the *yield* by calling the handler directly, which
never goes through `$run` and so cannot see the auto-pop at all).

`$cs_waits` / `$cs_steals` / `$cs_barges` / `$cs_bad_leaves` are exported, printed by
`test/run.js` when nonzero, and carried per-thread in the worker slice reply, so
contention is reportable instead of inferred. Cooperative runs show 0/0/0 — one
instance at a time never contends — which is also why this change is invisible to
the single-threaded path.

Contended Enter also spins before it parks — a few thousand CAS attempts, which
is what `SpinCount` is for on a multiprocessor, since the holder is on another OS
thread and running right now. **It did not help Winamp at all** (parks per thread
stayed at ~1900-2300), and that is the useful measurement: its contention is not
brief.

### Releasing what a thread still owns when it ends

A section held by a thread that has ended is not held, it is **lost**, and every
waiter parks on it forever. Windows has the same hazard and no answer; we do have
one, because we know exactly when a guest thread ends — including when it ends by
trapping, which no guest can clean up after.

`InitializeCriticalSection` records the section in `CS_TABLE` (256 entries at
0x07F0CA40), and `ThreadManager._markThreadExited` — the single funnel both
backends already use — calls `release_cs_owned_by(tid + 1)` and logs whatever it
frees. Two details that are load-bearing:

- The table holds **WASM addresses, not guest ones**. The release runs from
  whichever instance noticed the exit, and in worker mode that instance never
  loaded the PE: its `$image_base` is 0, so `g2w` would answer nonsense.
- The argument is `$current_thread_id` (main 1, spawned tid+1), not the tid,
  because that is what the guest's `OwningThread` field holds — `GetCurrentThreadId`
  returns the same number, which is the whole reason the field is that value.

`DeleteCriticalSection` unregisters, so a stale entry cannot have a later thread's
exit writing zeroes into whatever got that memory next.

### The next bug, and it is now named rather than guessed at

"A thread is blocked" is not a diagnosis. So a parked thread now records which
section it parked on and who held it — `$cs_wait_addr` / `$cs_wait_owner`, carried
in the worker slice reply and printed per thread. The first run with it says
everything:

```
T1 exited  csPark=1      waitingOnCS=0x00ad8540 heldBy=T2
T2 active  csPark=1      waitingOnCS=0x00d33b78 heldBy=T3   sleepCount=5402
T3 active  csPark=21677  waitingOnCS=0x00d33b78 heldBy=T2
```

**T2 and T3 fight over one section** — WASM `0x00d33b78`, guest `0x1121B78`, which
is out_wave's thread-parameter struct + 0xc, i.e. a `CRITICAL_SECTION` embedded at
the head of the plugin's own state. T3 parks on it 21677 times while T2 holds it,
and T2's own single park was on the same section while T3 held it. T2 is not busy
while holding it either: `sleepCount=5402` out of 5503 slices, so it holds the
section and *sleeps*, thousands of times.

That is the shape of a producer waiting for room that only the consumer can make,
with the consumer locked out of the section it needs to make it. On real Windows a
decoder does not hold a section across a `Sleep` loop — so the release was being
lost, and the loss was ours.

#### It was the non-owner `Leave`, and specifically its arithmetic

Two runs found it without a single new line of tracing.

`--threads-serial` — one guest thread at a time, everything else identical — parked
**zero** times and produced *more* audio than the parallel run. Zero contention
means the guest's own lock order is fine, so the inversion was a race we
introduced rather than a discipline the guest lacks.

Then printing the registry at exit said what state the sections were actually in:

```
held critical sections at exit (3):
    0x00061d4c owner=main lock=0  recursion=1
    0x00ad8540 owner=T1   lock=0  recursion=1
    0x00d33b78 owner=T2   lock=-2 recursion=-1      <- below the init state
```

`RecursionCount = -1`. `LockCount = -2`. The section had been **left more times
than it was entered**, and `Leave` released only on `RecursionCount == 0` — a test
those counters had already stepped past. So `OwningThread` stayed set on a section
nobody was inside, forever, and every waiter parked forever. The per-thread
`csBadLeave` column (also new: the counters are per-instance globals, so main's
copy reads 0 for anything a worker did) named the source: **70** Leaves from T2 on
sections it did not own.

The fix is two lines of arithmetic and one of judgement:

- An **unowned** `Leave` frees the section outright and touches no counters. It
  still releases — see the trade above — but it no longer decrements on behalf of
  a thread that never entered.
- An **owned** `Leave` releases at `<= 0` rather than `== 0`, and clamps
  `LockCount`/`RecursionCount` back to the values `InitializeCriticalSection`
  writes. A section can now only ever be free-and-initialised or held.

| Winamp, CLI `--threads`, same 1200 batches | before | after |
|---|---|---|
| parks (T1/T2/T3) | 2344 / 2345 / 2477 | 0 / 4 / 0 |
| bad Leaves | 70 | 3 |
| PCM captured | 55296 B, then deadlocked | **78336 B**, hit the capture target |
| wall clock to 64KB of audio | never | 6.0 s |

`test/test-wat-critical-section.js` is the regression: 16 assertions on the struct
itself, driven through `test_cs_enter` / `test_cs_leave` / `test_cs_delete` exports
so the semantics are asserted rather than inferred from an app that hangs. Against
the old `Leave` it fails four of them, and it fails them with exactly the Winamp
signature — `lock=-2 recursion=-1 owner=2`.

The browser side moved too, without being touched: `test-worker-guest.js` went from
20 of 21 to **27 of 27**, both worker traps gone. Guest `0x1121B78` — the address
in both of them — is the same section, which is what the earlier note suspected:
one bug, wearing three faces.

**Where this leaves worker mode.** The state, being exact about it:

| | before real sections | now |
|---|---|---|
| cooperative (default, everywhere) | works | **unchanged** — 0 parks, 0 barges, 0 steals; one instance at a time never contends |
| CLI `--threads` audio | peak 40 of 32768 | 76032 B of non-silent PCM in 6.0 s; `test-winamp-audio --threads` 7/7 |
| browser worker (`?threads`) | `test-worker-guest.js` green, threads mostly starved (16854 slices) | **27 of 27** checks; threads run 16x further and no longer trap |

Both of the worker traps that the parks were hiding — `EIP=0x1` with a thunk-slot
address in `edi`, and a loop at `0xc18bbf` — are gone with the `Leave` fix. They
were downstream of the same permanently-owned section, which is why neither ever
reproduced in the CLI while the deadlock did.

### What a worker thread was actually spending its life on

The audio above was intermittent — 2 runs in 4 came back as pure silence, with
the same input and the same byte count. That is not a decode bug: `_CIpow` was
called exactly 9,919 times in both the silent and the audible run, so the
decoder did the same work; it simply never got far enough to emit samples inside
the captured window.

`--rpc-census` (new) says why, per thread. A blocking host import in worker mode
is a `postMessage` plus an `Atomics.wait` — the guest thread stops until the main
thread takes a turn — and Winamp's decode thread was making **20,317** of them
per run:

```
10346  T2  log              <- twice per Win32 API dispatch, discarded by --quiet-api
 9909  T2  math_pow         <- the MP3 dequantiser
```

Neither needs the main thread at all:

- **`math_pow` and friends are pure functions.** `lib/host-imports.js` implements
  them as the bare `Math.*`, and a worker has its own JS. They are computed
  locally now — the same fast path as the published clock, minus the publishing.
- **`log` carries a pointer, which is why it blocked**, but all three of its
  callers pass something immutable (a name in the PE import table, the fixed
  ordinal placeholder, or a scratch buffer whose thread crashes immediately
  after). Checked rather than assumed, then moved to `ASYNC_SAFE`.

And separately, from `--host-census`: **87,596 of 105,637 host calls** in a run
were `get_window_client_size`, from the clip helpers on the drawing path. The JS
implementation of that import *begins by calling back into the WAT* for the same
answer — so the round trip existed to be told what WAT already knew. Asking
locally first (`$wnd_client_size_packed`, host import kept as the fallback it
always was) removed 83% of all host calls.

| Winamp, CLI `--threads`, 1200 batches | before | after |
|---|---|---|
| T2 blocking RPCs | 20,317 | **57** |
| T2 guest time | 6,244 ms | **773 ms** |
| host calls, whole process | 105,637 | 17,882 |
| `test-winamp-audio --threads` | 2 of 4 runs silent | **4 of 4 pass** |

The silence was a throughput symptom all along, which is why nothing about the
decoder looked wrong.

What remains open in worker mode is the rest of the throughput story, and that
number has to come from a real browser (see §6).

---

## 6. How we know it works

The instrumentation for this already exists, which is the one piece of luck in
this plan:

- `lib/perf-hud.js` reports `GAME fps` (guest-presented frames) separately from
  `page fps`, plus per-phase step timing and x86 throughput. Phase 1's whole
  claim is "GAME fps stops depending on what the UI thread is doing", and that
  is directly the graph.
- `?debug&perf&perf-stream` (or Ctrl+Alt+S) streams a real session to
  `tools/dev-server.js`. Every threading change should be A/B'd against a
  recorded human session, not only against scripted runs — the starvation bug
  was invisible to every headless test precisely because no script moves a
  mouse for 30 seconds.
- **Do not take timing numbers from a headless browser.** Functional headless
  checks are fine — does it load, does a worker instantiate, does a check pass —
  but every fps/latency figure should come from a real browser, and `uptime`
  should be read before believing it. This project's box regularly sits at load
  20-70 with agent sessions sweeping, which has already invalidated one published
  conclusion and inflated an "idle floor" to 11.6ms.
- `--trace-sched` already prints one line per change in the set of thread
  states. Under real threads it becomes the primary debugging tool for lock
  contention and lost wakeups.
- `test/run-all.sh` + the 107-app corpus is the regression gate. Threading bugs
  are probabilistic, so the corpus needs to run repeatedly, not once.

**Determinism is the thing we lose.** Today a run is reproducible; with real
threads it is not, and a flaky corpus failure becomes "which interleaving".
Mitigation is §3.6: single-threaded stays the CLI default, so the corpus keeps
its reproducibility, and threading is the browser's opt-in. Also report the mode
in the perf HUD — a timing number means something different in each, and a
comparison across modes without saying so is how a session gets misread.

---

## 7. Risks

| Risk | Severity | Note |
|---|---|---|
| Isolation unreachable in production | **low** | SW route proven on localhost in Chrome (headless, 6/6) and Safari (by hand, 2026-08-17). Remaining: deploy `sw-coi.js` to berrry.app and click the probe there |
| Safari: worker + shared memory + module transfer + canvas | **low** | probe passes in Safari via the service worker, including `transferControlToOffscreen` + `putImageData` from the worker at 160 blits/sec (§1). No known Safari blocker remains for phase 1 |
| **Two schedulers, forever** | high | §3.6 — single-threaded is permanent (Safari private, iframes, CLI). Every threading bug needs "does it also happen single-threaded?" |
| Registry synchronicity | medium | snapshot approach (§3.2) avoids blocking, but INI writeback ordering needs care |
| Service worker in the cache path | medium | none in the tree today; must re-header only, never cache, or every future "my fix did nothing" starts here |
| Non-determinism in tests | medium | CLI stays single-threaded (§3.6 rule 4) |
| Debugger/tracing regressions | medium | `--break`, `--trace-at`, memory dumps all assume synchronous access to instance state |
| Guest memory races surfacing | low | authentic; apps that break were broken on Win98 too |
| Effort | high | phase 1 is a broker for every non-pure import — weeks, not days |

---

## 8. Rejected alternatives

- **Keep everything on the main thread and tune the scheduler.** That is what
  `b7b4d4e` did. It works, and it will keep producing bugs of the same family:
  every new app is a new balance between input latency and guest throughput.
- **One worker for everything, guest threads still cooperative** (previously
  labelled "stage 1"). Cheaper, and captures the UI-immunity win, but it does
  not make guest threads concurrent, so audio-under-load and multi-core stay
  unfixed. It is a strict subset of phase 1 here, so nothing is wasted by
  aiming at the full design and stopping early if needed.
- **`wasm` threads with a single instance and `pthread`-style stacks.** Would
  mean one instance executing on many threads, which the interpreter's
  per-instance globals (registers, EIP, flags) fundamentally cannot do: those
  globals *are* the CPU state, and there is one CPU per guest thread.
