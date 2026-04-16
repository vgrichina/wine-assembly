# Abe's Oddysee (demo) — Progress

## Binaries

| File | Size | Description |
|------|------|-------------|
| `test/binaries/shareware/abe/Abes_Oddysee_demo/ABEODD.EXE` | 32MB | Self-extracting archive (includes `_winzip_` section). **Cannot load** — overflows WASM memory layout. |
| `test/binaries/shareware/abe/ex/AbeDemo.exe` | 914KB | Extracted game binary. **Primary test target.** |

**Image base:** 0x00400000
**Window:** 640×480, title "Oddworld Abe's Oddysee 2.0"

### PE file offset note
`.text` section: RVA=0x1000, file offset=0x400. Delta = 0xC00. To read bytes at VA X: `fileOffset = X - 0x400000 - 0x1000 + 0x400 = X - 0x400C00`.

**Status (2026-04-16):** Game initializes DDraw/DSound, creates audio thread, loads level data, enters main loop. Timer callback fires and posts WM_USER to thread 1 which reads level files. Main loop does DDraw Lock/Unlock pixel blitting. **Crashes to EIP=0** due to dual timer dispatch bug.

## What works

- DDraw init: DirectDrawCreate → SetCooperativeLevel → SetDisplayMode(640×480×16) → GetCaps → CreateSurface (primary + offscreen 1024×512 16bpp)
- File enumeration: FindFirstFile/FindNextFile for `.\*.*` finds all data files (9 files: .ddv videos, .lvl levels, readme)
- Secondary thread created (handle 0xe0001, entry 0x49b4f0) — runs GetMessageA loop
- `timeSetEvent` periodic timer (4ms, callback 0x498be0 → 0x487470) fires via MM_TIMER message
- **Cross-thread PostThreadMessageA** delivers WM_USER to Thread 1 via shared-memory queue (0xB400)
- Thread 1 receives WM_USER, opens `.\s1.lvl`, seeks to offset 0x50000+, reads data
- Main loop: PeekMessageA → TranslateMessage → DispatchMessageA → timeGetTime → DDraw Lock/Unlock
- Level data loading: Thread 1 does SetFilePointer + ReadFile for multiple chunks, main thread blits pixels
- DSound: DirectSoundCreate, CreateSoundBuffer, Lock/Unlock for audio buffers
- **With timer disabled (`--no-timer`): reaches 6853 API calls**, progresses through full level loading sequence

## Current blocker: dual timer dispatch causes stack corruption → EIP=0

**Symptom:** Game crashes at batch ~208, 660 API calls. EIP=0x00000000, prev_eip=0x0048757e. The instruction at 0x48757e is `add esp,0x10; xor eax,eax; add esp,0x8; ret` — the `ret` pops 0 from the stack.

**Root cause:** The multimedia timer callback fires via TWO independent paths:

1. **`fire_mm_timer` (JS-side, `src/13-exports.wat`)**: Called between batches in `test/run.js`. Directly injects a callback frame (5 args + ret addr = 24 bytes) onto the stack and redirects EIP to the callback.

2. **`$check_timer` in GetMessageA/PeekMessageA (`src/09a-handlers.wat:119-134`)**: When the game calls PeekMessageA, the timer check sees the MM timer is due and delivers a 0x7FF0 message. `$handle_DispatchMessageA` (`src/09a5-handlers-window.wat:925-945`) then sets up ANOTHER callback frame.

Both paths fire the same callback at 0x498be0. The `fire_mm_timer` re-entrancy guard only tracks its own ESP-based state — it has no knowledge of the message-queue dispatch path. This causes the callback to run twice for a single timer tick, corrupting the stack.

**Evidence:**
- Timer fires at batch 16, 66, 67 (via `fire_mm_timer`)
- The 0x7FF0 message path also fires via PeekMessageA → DispatchMessageA
- With `--no-timer` flag (disables `fire_mm_timer`), game reaches 6853 API calls without crashing

**Fix approach:** Remove the `fire_mm_timer` JS-side injection entirely. The WAT-side `$check_timer` in PeekMessageA/GetMessageA already handles MM timer dispatch correctly through the message queue, which is the proper Win32 behavior.

**Timer callback chain:**
```
0x498be0  Timer entry: if [0xa5a058] != 0, call it
0x487470  Actual tick: set [0xab1220]=1, inc [0xa54908], if counter & 3 == 0 call [0xaa1560]
          [0xaa1560] = 0x440130 = engine tick function
0x440130  Engine tick: calls PostThreadMessageA(T1, WM_USER, ...)
```

## Next steps

1. **Fix dual timer dispatch** — disable `fire_mm_timer` JS-side injection; let `$check_timer` in PeekMessageA/GetMessageA handle MM timer via 0x7FF0 messages exclusively
2. **After timer fix**: with `--no-timer` the game reaches 6853 API calls and gets stuck in a busy-wait loop at 0xa7c272 (dynamically loaded code) calling timeGetTime endlessly — this is the timing wait loop that relies on the timer callback to set [0xab1220]=1. With the message-queue dispatch working, this loop should proceed.
3. **Verify level loading completes** — Thread 1 should read all level chunks and the main thread should start rendering frames
4. **Check rendering** — DDraw surface Lock/Unlock pixel blitting happens but no PNG output has been captured yet

## Key addresses

| Address | Description |
|---------|-------------|
| 0x00498650 | WndProc |
| 0x00498be0 | timeSetEvent callback entry |
| 0x00487470 | Actual timer tick function |
| 0x00440130 | Engine tick (called every 4th tick from 0x487470) |
| 0x00483210 | DDraw blit function (bounds-checked pixel copy) |
| 0x0048757e | Crash site — `ret` to 0 after DDraw blit (stack corrupted by dual timer) |
| 0x00a5a058 | Timer function pointer (→ 0x487470) |
| 0x00a54908 | Timer tick counter |
| 0x00ab1220 | Timer "tick ready" flag |
| 0x00aa1560 | Engine tick function pointer (→ 0x440130) |
| 0x0049b4f0 | Secondary thread entry point |
| 0x00a7c272 | Busy-wait loop (timing, calls timeGetTime) — where game stalls with `--no-timer` |

## Bugs fixed

### VFS `_normPath` didn't collapse `.` components — FIXED
**File:** `lib/filesystem.js`
**Root cause:** `_normPath` converted slashes and lowercased but never removed `.` components. `FindFirstFileA(".\*.*")` resolved to `c:\.\*.*`, parent dir became `c:\.` which didn't match files stored under `c:\`.
**Fix:** Added `.`/`..` component collapsing in `_normPath`.
**Test:** `test/test-vfs.js`

### PostThreadMessageA unimplemented — FIXED
**File:** `src/09a-handlers.wat`
**Root cause:** `$handle_PostThreadMessageW` was a crash stub. PostThreadMessageA was missing from api_table.json entirely.
**Fix:** Implemented both A/W variants — posts to post_queue with hwnd=0. Added PostThreadMessageA to api_table (id=1248).

### PostThreadMessageA wrote to caller's own queue — FIXED
**File:** `src/09a-handlers.wat`
**Root cause:** PostThreadMessageA wrote to the caller's `$post_queue_count` global, which is per-instance. Thread 1 (separate WASM instance) never saw the messages.
**Fix:** When target is a thread handle (0xE0000 mask), write to shared-memory XTHREAD queue at 0xB400. Thread's GetMessageA checks this queue before returning WM_NULL.

### COM wrapper memory collision — FIXED
**File:** `src/09a8-handlers-directx.wat`, `src/01-header.wat`, `src/03-registers.wat`
**Root cause:** `DX_OBJECTS` (0x0000E970) and `COM_WRAPPERS` (0x00010A80) were at WASM addresses below GUEST_BASE (0x12000), mapping to guest addresses below image_base (0x400000). Game's pixel blitting buffers overwrote COM vtables.
**Fix:** Moved to high WASM memory: `DX_OBJECTS` → 0x07FF0000, `COM_WRAPPERS` → 0x07FF2000. Expanded g2w bounds check from 64MB to 128MB.

### timeSetEvent/timeKillEvent unimplemented — FIXED
**File:** `src/09a3-handlers-audio.wat`, `src/13-exports.wat`
**Fix:** Implemented `$handle_timeSetEvent` (stores callback, interval, flags in globals), `$handle_timeKillEvent`, and `fire_mm_timer` export for JS-side timer firing.

### TranslateAcceleratorA unimplemented — FIXED
**File:** `src/09a-handlers.wat`
**Fix:** Reads RT_ACCELERATOR table, matches key events, posts WM_COMMAND.

## Related

- `directx.md` — overall DX surface design
- `marbles.md` — Marbles uses same DDraw palette path
