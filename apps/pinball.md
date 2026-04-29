# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Game initializes fully, renders table with correct colors and sprites, enters active PeekMessage game loop at 332 FPS. WaveMix sound init now succeeds (16-bit ALU decoder fix). Score panel fully working: title, score digits, BALL label, mission text, and "Player 1" label all render. PeekMessageA/GetMessageA input double-dispatch fixed (PM_NOREMOVE cache). Use `--batch-size=500000 --max-batches=500` for full game loop.

**Heap note:** `load_pe` sets `heap_ptr = image_base + SizeOfImage` (0x0104b000 for pinball), NOT the fixed 0x01D12000. DLL loading + DllMain + VirtualAlloc(4MB from msvcrt) push it to ~0x01519000. Total available heap before stack overlap is ~23MB.

## REGRESSION (2026-04-28): LEFT flipper (Z) does not move; RIGHT flipper (/) does

**Test status:** `test/test-pinball-playable.js` reports 8/9 — **right flipper rect signal=366px > noise=128px** (FAR above the +200 threshold), but **left flipper rect signal=0px**. Right works, left doesn't.

This is now narrowed to a key-specific bug, not a global gate3 / message-pump issue. Whatever path delivers '/' (VK_OEM_2 = 0xBF) all the way to the right-flipper component does NOT go through `process_key` at `0x01015072` — `--count` shows zero hits at process_key entry when only F2 + '/' are sent. So pinball has TWO key dispatch paths and Z is on the broken one.

The investigation below was originally framed around process_key being the only flipper handler — that turns out to be incomplete. Focus going forward: identify the working-path that '/' takes (probably TranslateAccelerator or a direct check in the wndproc before process_key), and figure out why Z misses it.

### Trace evidence

Same input (`F2 → Space-plunge → Z-hold`), counted with `--count` over the input-and-render chain:

| Address | Stage | Hits, no Z | Hits, Z held |
|---|---|---|---|
| `0x01007d1a` | WM_KEYDOWN handler | n/a | 6 (3× down, 3× up) |
| `0x01015072` | `process_key` entry | 6 | 6 |
| `0x010150bf` | `cmp esi, [0x1028238]` (wParam vs left-flipper key) | 3 | 3 |
| `0x010150e5` | not-equal fall-through to next slot | 3 | 3 |
| `0x010152d1` | post-handler jump target | 3 | 3 |
| `0x010175aa` | flipper angle update | 8 | 8 |
| `0x01013c89` | flipper bitmap-index pick | 16 | 16 |
| `0x01013d2d` | sprite group render | 3205 | 3204 |
| `0x01004870` | CopyBits8 (sprite blit to back-buf) | 1542 | 1542 |
| `0x010159a9` | flipper-component vtable[0] (per-frame Message) | 210 | 210 |

Conclusion: holding Z makes **zero** difference at every stage of the render chain. `[0x01028238]=0x5A` is correctly configured (post-run dump confirmed), and 3 wParam values reach the cmp (F2/Space/Z), but the cmp evidently never matches Z (otherwise downstream blit counts would diverge).

The match body `0x010150c7` and the vtable call at `0x010150de` could not be probed directly with `--count` because they sit in the same WAT-decoded basic block as `0x010150bf` (`--count` resolves to block-entries, not instructions).

### Blit-set diff is empty

Captured every `gdi_stretch_dib_bits` line, sorted/uniqued:
- no-Z run: 684 unique blit signatures, 6587 total
- Z-held run: 684 unique blit signatures, 6587 total
- `comm` diff: zero blits exclusive to either side

If the flipper sprite were rotating, the rotated frame would emit at least one new `(srcX,srcY,W,H,dstX,dstY)` tuple. None do. The render chain is running, but its output is identical with and without the flipper key — meaning the flipper object's `bitmap_index` never changes.

### Hypothesis ruled out: esi clobber across `0x100e1b0`

I suspected `0x100e1b0` (the call between `mov esi, wParam` and `cmp esi, [0x1028238]`) might trash esi. Disasm proves it doesn't — entry pushes esi (`0x100e1ba`), exit pops it back (`0x100e501`). Standard Win32 ABI preservation.

### Half of process_key entries fail an early-exit gate

| Probe | Hits |
|---|---|
| `0x01015072` (process_key entry) | 6 |
| `0x010150b5` (post-3-gates, push esi) | 3 |
| `0x010150bf` (key cmp) | 3 |
| `0x010152d2` (early-exit OR end-of-handler tail) | 3 |

3 of the 6 entries are blocked by one of the three early-exit gates: `[0x1024fd8]==0`, `[0x1025570]==0`, `[0x1025568]==1`. Likely process_key is called for both KEYDOWN and KEYUP and one path fails the gate. The 3 that reach the cmp should include F2 / Space / Z.

### Match body proven unreached

`0x010150c7` (fall-through after `jnz 0x10150e5`) and `0x010150e5` (taken target) ARE separate basic blocks in the WAT decoder — each is a branch outcome. `--count` confirms:

| Probe | Hits |
|---|---|
| `0x010150bf` cmp | 3 |
| `0x010150c7` match body | **0** |
| `0x010150e5` no-match path | 3 |
| `0x010150de` vtable call | 0 |

All 3 cmp executions take the no-match jnz. Match body never fires.

### Why: gate3 timing makes Z miss the window

`process_key` is called 12 times when spamming 5 Z keypresses after F2. Only **1** ever reaches the cmp body — the other 11 fail gate3 and take the inactive-key path at `0x010150a9` (`push 0xff; call 0x1014743`).

Disassembled gate logic (`0x01015072..0x010150b5`):

```
cmp [0x1024fd8], 0    ; gate1: 0=ok, else exit
cmp [0x1025570], 0    ; gate2: 0=ok, else exit
cmp [0x1025568], 1    ; gate3: 1=match-path, else inactive
```

Watching `[0x1025568]` shows transitions at batches 219, 3397, **5000** (precisely when F2 keydown injected). Z keydowns at batch 9000+ never line up with another transition. Apparently the F2 keypress flips gate3 to 1 only briefly — the single hit at `0x010150b5` likely IS F2's own keydown landing in that window, not Z.

Without F2 entirely (`--input='9000:keydown:90,9100:keyup:90'`): 2 process_key entries, **0** reach b5. Gate3 never opens.

### Real bug: gate3 (`[0x01025568]`) is a 0/1/2 state machine — flippers only work at 1

`--watch --watch-log` (already prints writer EIP) shows three transitions during a typical run:

| Batch | Writer EIP | Transition | Likely meaning |
|---|---|---|---|
| 219 | `0x010155ee` | 0 → 1 | initial demo idle armed |
| 3397 | `0x01011b54` | 1 → 2 | demo running |
| 5000 | `0x010d785f` (F2 keydown handled) | 2 → 1 | game requested |

After F2, gate3 stays at 1 — but spamming 5 Z keypresses afterward yields only 1 b5 hit total (out of 10 entries). The watch detects no further transitions, so the only way 11 calls miss b5 is gate3 momentarily flipping to ≠1 inside `process_key` itself (set-and-restore within a batch — invisible to the watchpoint). Smaller `--batch-size=100` doesn't surface them either.

### Fix landed: double-dispatch on WM_KEYDOWN (renderer-input.js:925-934)

**Status:** Patched 2026-04-28. Now only synchronously sends WM_KEYDOWN to focus when focus is an Edit control (class==2). Other apps (pinball, etc.) just queue.

Before: `process_key` entered 6× per F2+Space+Z run (3 keydowns × 2 deliveries). After: 3× (one per keydown). Confirms the double-dispatch theory — but did not fix flippers, which means the gate3 issue is independent.



`renderer-input.js` `handleKeyDown` delivers each keydown **twice** when WAT focus is set:

```
we.send_message(watFocus, 0x0100, vkCode, 0);   // synchronous send
this.inputQueue.push({...msg: 0x0100, wParam: vkCode...});  // queued
```

For pinball, `check_input_hwnd: keyboard → focus 0x10002` confirms watFocus is the main window. So each keydown reaches the wndproc twice.

This is consistent with our counts:
- 3 keydowns × 2 = 6 process_key entries (F2+Space+Z test) ✓
- 2 keydowns × 2 = 4 entries (F2+Z test) ✓
- Keyups don't go through process_key (the wndproc only dispatches WM_KEYDOWN to the bit-30 test at `0x01007d1a`)

**Why it's relevant to the flipper bug:** the immediate `send_message` runs BEFORE F2's gate3-flipping write at `0x010d785f` lands. So the dispatch is:

1. F2 keydown → immediate send_message → process_key with gate3==2 → inactive path
2. F2 keydown → process_key inside batch flips gate3 to 1 (via `0x010d785f` reached through inactive-path side-effects? need to verify)
3. F2 keydown → queued → process_key with gate3==1 → reaches b5, fails Z-cmp, takes no-match chain
4. Z keydown → immediate send_message → process_key with gate3=??? — if step 3 reset it to 2, inactive
5. Z keydown → queued → process_key with gate3 still 2 → inactive

The single `0x010150b5` hit observed in single-Z + F2 tests is most likely **F2's QUEUED dispatch** (step 3), not Z. To confirm, instrument the b5 path to print esi at that point.

Next concrete step: write a `--trace-instr=ADDR` or short-circuit by dumping `[ebp+8]` via an existing mechanism. The cleanest is probably to add a `--print-regs-at=ADDR` flag that, like `--count`, fires on every basic-block-equivalent EIP hit but prints registers. Alternatively, narrow further by setting a write-watchpoint on a memory location only the match-body touches (e.g. at `0x010150d4` we write fld result to `[esp]`, but [esp] varies — better target: the indirect call at `0x010150de` writes a return address to the new stack slot). 

### NEW: gate3 setter located + caller pattern

`tools/xrefs.js 0x01025568` shows ONE writer: `0x0101472f mov [0x1025568], esi`. It's the tail of a state-setter function `0x0101461a` (signature: `set_gate3_state(int)`); arg 1/2/3/4 dispatches through side effects then writes to gate3.

After the double-dispatch fix, watching gate3 over a fuller run (F2 + Space + 3× Z keydowns):

| Batch | Transition | Setter call |
|---|---|---|
| 219 | 0 → 1 | from `0x010155ee` (init) |
| 3397 | 1 → 2 | from `0x01011b54` (caller fn `0x01011987`) — demo enters running state |
| 5001 | 2 → 1 | from `0x010153c2` (F2 keydown handler) |
| **6226** | **1 → 2** | from `0x01011b54` again — **resets to demo before Z arrives at batch 7000** |

So **after F2 launches the game at batch 5001, the demo-state resetter at fn `0x01011987` re-fires at batch 6226 and pushes gate3 back to 2**. By the time Z keypress arrives at batch 7000, the gate is closed again.

`0x01011987` has no static xrefs (`tools/find-refs` returns 0) — it's reached via vtable indirection (likely a per-frame component callback). Its first arg `[ebp+8]` selects a sub-handler: `sub eax, 0x42; jz 0x1011b3b` then `dec eax; jnz 0x1011b84`. So the args are 0x42 ('B') and 0x43 ('C') — character-coded commands. The 0x42 path leads to the `set_gate3_state(2)` call.

**Hypothesis:** something is firing this component's "B" command on every animation tick OR after some "demo idle timeout" that is mis-firing in our emulator. Could be a missing message in the GetMessageA queue (e.g., a `WM_TIMER` that should advance demo state but instead resets it), or a component vtable[N] being mistakenly dispatched.

### Next steps

1. Find what's invoking the vtable that targets `0x01011987` — instrument with `--break=0x01011987` and inspect the call stack.
2. Compare against a no-F2 run (where gate3 stays 2 throughout demo) to see if the same vtable call site fires at the same cadence — that'd narrow whether it's a timer or a state-machine bug.
3. Long-term: if gate3==2 is "demo", the F2 handler should set a sticky "game running" flag elsewhere that prevents this resetter from firing. Look for a state field that pinball sets in F2 path (`0x010d785f`) but our emu may not be honoring.

### NEW (2026-04-28): gate3 setter caller census + asymmetry NOT real

**TranslateMessage trace confirms both Z (0x5A) and / (0xBF) reach the wndproc as WM_KEYDOWN/KEYUP.** Both go through the normal message pump — no TranslateAccelerator path. So the L vs R "asymmetry" in the playable test is almost certainly **noise**: signal=366 in the R rect is just ball physics + scoreboard text changing between settle.png (batch 8200) and right.png (batch 8400), not actual flipper movement. The `R flipper rect: noise=128px signal=366px` reading is misleading — we should re-baseline R-rect noise against the same time window where R is held but the flipper hypothetically isn't moving.

**process_key (0x01015072) hit count over full F2+Space+Z+/ run = 4.** That's exactly 4 keydowns reaching it (F2/Space/Z// — KEYUPs not dispatched), so all 4 keys reach process_key. process_key bails at the gate3 check `cmp dword [0x1025568], 0x1` (0x010150a0): if not 1, jumps to 0x10152d2 (exit). Both Z and / arrive while gate3==2, so **both are dropped at the same gate**.

**Caller census of gate3-setter `0x0101461a`** (6 static call sites, run with F2+Space+Z):

| Caller | Hits | Sets gate3 to | Notes |
|---|---|---|---|
| `0x010155ee` | 1 | 1 | one-shot init at batch 219 |
| `0x01011b4f` (in fn 0x01011987 'B' path) | 2 | 2 | demo-resetter — fires twice, batch 3397 and 6223 |
| `0x010147b3` (start of big "reset world" fn at 0x010147a0) | 2 | 2 | also pushes 2 — same demo-reset family |
| `0x010153bd` (F2 keydown handler) | 2 | 1 | F2 path — sets gate3=1 |
| `0x01018930` | 2 | ? | ? |
| `0x01014786` | 0 | 4 | unused in this run |

`0x01011987` and `0x010147a0` are BOTH gate3=2 setters and BOTH fire twice. Together they explain the 1→2 transitions at batches 3397 and 6223. The 2nd round is what kills gameplay.

**Curious `--count` artifact:** entry of fn `0x01011987` reports 0 hits, but inner blocks (0x010119a7, 0x01011a78, 0x01011b84) report dozens. Bytes upstream of 0x01011987 are `int3` padding (no fall-through), and no static pointer literals to 0x01011987 (or 0x010119a7) exist anywhere in the PE. Yet the fn clearly executes (0x01011b84 epilogue hits 29×, gate3-store fires from 0x01011b4f). Either `--count` slot for fn-entry-with-`mov edi,edi` prefix mishandles block-entry detection, or the cache decoder is fusing the entry block with a predecessor in a way that hides the entry address. **Not load-bearing for the bug investigation, but worth a tools note** — `--count` at fn entries with hot-patch prefixes may silently report 0 even when the fn runs.

### Cleaner next step

Forget tracing the indirect caller. Instead: check whether `0x010d785f` (the suspected sticky "game-running" flag write in F2 path) actually fires in our emulator. If it doesn't, the bug is upstream of gate3 — F2 sets gate3=1 but fails to set the OTHER flag that disables the demo-state resetter, so the ticker walks back into demo on its next pass. `tools/xrefs.js` on whatever address F2 writes via 0x010d785f will tell us who reads it (i.e., the resetter caller's gate condition).

### NEW (2026-04-28 evening): full call chain captured via `--trace-at + --trace-callstack`

Combining `--trace-at=0x01011b3b --trace-callstack=12` printed the EBP-walked stack at every gate3=2 store. Both 1→2 transitions (batches 3397 + 6223) showed an **identical 9-frame stack**:

```
ret=0x01011e30  (in fn 0x01011bb7 — case 0x20 of jump table)
ret=0x01012d6c  (in fn ~0x010128be — calls 0x01011bb7 with arg=0x42)
ret=0x01011f05
ret=0x010185a3
ret=0x0101c809
ret=0x01014a19
ret=0x01014b95
ret=0x01014c4f
ret=0x01008a32  (top: tick / message-pump driver)
```

**Hot-patch entry off-by-2:** call site at 0x01011e2b targets `0x01011985`, NOT `0x01011987`. The real fn entry has the `8b ff` (mov edi, edi) hot-patch prefix at 0x01011985; the `push ebp` prologue is at +2 (0x01011987). `tools/find-refs.js` on 0x01011987 returned 0; on 0x01011985 returned 1 — every find-refs sweep should be tried at both `entry` and `entry-2` for compiler hot-patch ABI.

**The dispatch chain:**

| Fn | Role |
|---|---|
| `0x01011985` (=`0x01011987`+(-2 hot-patch)) | message handler — `[ebp+8]==0x42` ('B') → call vtable[0x14], call `set_gate3_state(2)` |
| `0x01011bb7` | jump-table dispatcher — `ebx = [0x1023bbc][0x6]`, case `ebx==0x20` (offset 32 in table at 0x01011e40) lands at `0x01011e29` which calls `0x01011985(edi, esi)` |
| `~0x010128be` | sets `[0x1023bbc][0x6] = 0x20`, pushes `0x42` ('B') as edi, calls `0x01011bb7` |

So **the demo-resetter is invoked deliberately** by SOME state machine in `~0x010128be` that decides "switch component X to mode 0x20 and send it message 'B'." The mystery is which call in our message-pump chain (frames #3-#8) is reaching that branch when it shouldn't.

**Tool note:** `--trace-at=ADDR --trace-callstack=N` is the recipe for capturing a call site without static pointer literals. No need to add a new flag — it already works for arbitrary addresses, not just APIs. Just remember to enable `--trace-callstack` (the WAT side maintains call-stack metadata via `set_callstack_enabled`).

### NEXT (2026-04-28, late): the predicate is `[0x1023d0c+0x6]`

Disasm of the actual call site at 0x01012d49–0x01012d67 (inside fn ~0x010128be, the "ball-end handler"):

```
01012d49  mov eax, [0x1023d0c]      ; OBJ_D0C — game-state object
01012d4e  cmp [eax+0x6], ebx        ; predicate (ebx == 0)
01012d51  mov eax, [0x1023bbc]      ; OBJ_BBC — dispatcher target
01012d56  push ebx                  ; arg2
01012d57  push 0x42                 ; arg1 = 'B'
01012d59  jz short 0x1012d64        ; predicate==0 → "no demo reset" branch
01012d5b  mov [eax+0x6], 0x20       ; predicate!=0 → arm OBJ_BBC.field=0x20 (demo resetter)
01012d62  jmp short 0x1012d67
01012d64  mov [eax+0x6], ebx        ; predicate==0 → arm OBJ_BBC.field=0 (no reset)
01012d67  call 0x1011bb5            ; dispatch on OBJ_BBC.field
```

So **`[0x1023d0c + 0x6]` is the gate**. When nonzero at ball-end time, the demo-resetter is invoked. When zero, the case-0 branch runs (normal "next ball" flow). This is the inverse of what we want during gameplay — that field should be 0 throughout play.

**Plan:**
1. `--watch-byte=0x01023d12 --watch-log` over a full session to log every transition of `[0x1023d0c+0x6]` and correlate against gate3 transitions. (`0x1023d0c+6 = 0x01023d12`.)
2. If the byte goes nonzero just before batch 6223, that's the smoking gun — `find-refs.js` / `find_field.js --reg=eax --op=write` at offset 0x6 will name the writer.
3. If it's zero throughout, the gate3=2 firing at 6223 is benign and the visible regression has another root.

Also: `find_fn.js` reports `entry=0x010128be (-0)` but the preceding `c3` is the ModRM of `2b c3 sub eax,ebx`, not a real ret — the heuristic was fooled. The actual entry is upstream of 0x010127c0 (desynced byte stream there suggests an embedded jump table). Not needed for the predicate watch.

### CONFIRMED (2026-04-28, late evening): bug is in ball_index/ball_count, not the gate

OBJ_D0C lives on the heap (initialised at batch 1459 to 0x0143562c in our run; pointer slot 0x01023d0c is BSS-zero at boot, set indirectly with no static-disasm xref). Gate byte = `0x0143562c + 0x6 = 0x01435632`.

`--watch-byte=0x01435632 --watch-log` over a full F2+Space session:

| Batch | Old→New | EIP (writer) | Meaning |
|---|---|---|---|
| 637  | 0→0x42 | 0x010e56f4 | startup |
| 640  | 0x42→0 | 0x010d75f2 | startup |
| 3383 | 0→1    | 0x0101293d | demo's last-ball end (expected) |
| 5006 | 1→0    | 0x01009f29 (prev=0x01009a10) | F2 "new game" clears it ✓ |
| 6256 | 0→1    | 0x0101293d | **gameplay end-of-game fires too early** ✗ |

Writer at 0x0101291d only reaches if all three hold:
```
[OBJ_5040 + 0xda] + 1 == [OBJ_5040 + 0xd6]    ; ball_index+1 == ball_count
[OBJ_5040 + 0x146] == 0                        ; tilt/extra-ball guard
```

So either ball_count was set to 1 by F2 (instead of 3) or ball_index is initialised at ball_count-1 — both make the very first plunge register as game-over, which then triggers the demo-resetter via the gate.

**CONFIRMED at firing batch 6258:** `--trace-at=0x01012918 --trace-at-dump=0x012696ee:0x40` showed both fires (#1 demo end, #2 gameplay end) with **identical** OBJ_5040 layout. Decoded:

- `[OBJ+0xd6] = 1` (ball_count) ❌ should be 3
- `[OBJ+0xda] = 0` (ball_index)

So ball_count is **permanently 1**. The first plunge legitimately registers as "last ball ended" and triggers demo restoration.

**ball_count writers** (`tools/find_field.js 0xd6 --op=write`): only at 0x010189a2 / 0x010189aa / 0x010189b9 — three branches of one clamp `clamp(ftol(floor([ebp+0xc])), 0, 4)`. The float arg comes from `[ebp+0xc]` of fn 0x010187d6 (caller's stack). Code path ID at this site is `push 0x3f5; call 0x10187d6` (msg_id 1013 = "set ball_count from float").

`tools/find-refs.js 0x010187d6` finds: 2 internal recursions + **one data-ref at 0x01002790 → vtable**. Bytes around: `..."table"\0\0\0  d6 87 01 01 ...` — vtable for the `table` class at 0x01002790, slot[0] = 0x010187d6. That's the same object whose pointer lives at 0x01025040 (=OBJ_5040). So ball_count is set via `vtable[0](0x3f5, float_arg)`.

**Watch on slot itself** (`--watch=0x0126970a --watch-log`): three writes total, all in pre-game:
- batch 6: `0 → 0x4f433030` (string-init, irrelevant offset overlap)
- batch 220: cleared
- batch 2122: `0 → 1` from the writer at 0x010189a2 (the only "real" ball_count set)

**No write happens during F2.** The F2 path runs a "soft reset" fn ending at 0x01009a1f (`mov [esi+0x6], edi` clears the gate byte + zeros many other [esi+...] fields) but never re-runs vtable[0](0x3f5, ...). And even at batch 2122, the float arg already floors to 1 — so even if F2 re-fired the setter, it would set 1 again.

**Origin of float=1.0 — TRACED (2026-04-28, second pass):**

Correction to earlier note: writer is in case body for msg=**0x3f6** (not 0x3f5). Idx-byte table `[0x1018f3d]` maps `msg-0x3e8 = 0xe → idx 8 → case at 0x01018916`. Inside that body:

```
01018935  mov eax, [esi+0x5a]          ; existing slot ptr
01018938  cmp eax, ebx                 ; ebx = 0
0101893a  jz 0x101895c                 ; if no existing slot, jump to fresh-init
... [recursive call branch] ...
0101895c  push ecx                     ; jz target — fresh-init branch
0101895d  fldz; fstp [esp]             ; push 0.0
01018962  mov ecx, esi
01018964  push 0x400; mov [esi+0x3e],ebx; call 0x10187d6  ; recurse with msg=0x400 (init scene)
01018971  fldz; ... lots of float setup ...
0101898d  fld dword [ebp+0xc]          ; load caller's float arg
01018990  fstp qword [esp]
01018993  call [0x1001310]             ; floor() (msvcrt import)
0101899b  call 0x1021166               ; ftol() (internal)
010189a0  cmp eax, edi
010189a2  mov [esi+0xd6], eax          ; ← the writer
```

Caller (verified by --break=0x0101895c, ESP+0x20 = 0x3f800000 = 1.0f):

```
010153b0 (fn entry)
...
010153d8  fild dword [0x1028234]       ; load INT from global → float
010153de  mov eax, [ecx]               ; vtable
010153e0  push ecx; fstp [esp]         ; push float
010153e4  push 0x3f6                   ; msg
010153e9  call [eax]                   ; vtable[0](0x3f6, float)
```

So the float = `(float)int_at_0x01028234`. The int there is **1**, hence float=1.0, hence ball_count=1.

**Origin of int at 0x01028234:** It's the registry value `HKCU\Software\Microsoft\Plus!\Pinball\Players`. Settings-init fn at 0x01005f6b:

1. Hardcoded preset: `inc esi; mov [0x1028234], esi` (0x01005f80, 0x0100607c) sets it to **1**.
2. Read overlay: `push [0x1028234]` (default), `push "Players"`, `push 0`, `call 0x1003588`, `mov [0x1028234], eax` (0x010060e4..0x01006100). When registry is missing, the storage helper falls through to default → eax=1.

`--trace-reg` confirms: `query HKCU\Software\Microsoft\Plus!\Pinball\Players -> not found`. Never written by the app.

**Diagnosis:** The misread is calling `[obj+0xd6]` "ball_count", but the registry source name is **"Players"** — i.e. the player count (1-4). With Players=1, the gate `ball_index+1 == ball_count` becoming `current_player+1 == num_players` evaluates true at end-of-ball-1 → demo trigger. The actual *ball count per game* must live in another field that we haven't located, or the gate semantics aren't what we think.

**REVISED (2026-04-28, third pass) — gate full disasm + ball_count theory invalidated:**

Disasm of the firing site at 0x010128fb–0x0101291d (entry of the fn is 0x010128be):

```
010128ec  mov eax, [esi+0x146]      ; live balls_remaining
010128f2  dec eax
010128f3  push eax
010128f4  mov ecx, esi
010128f6  call set_balls_remaining(eax)  ; 0x010175aa — also stores back to [esi+0x146]
010128fb  mov ecx, [0x1025040]
01012901  mov eax, [ecx+0xda]       ; curr_player
01012907  inc eax
01012908  cmp eax, [ecx+0xd6]       ; num_players
0101290e  jnz next_ball              ; not last player → continue
01012910  cmp [ecx+0x146], ebx (0)
01012916  jnz next_ball              ; balls_remaining still > 0 → continue
01012918  mov eax, [0x1023d0c]
0101291d  mov [eax+0x6], 1           ; GAME OVER → arm demo-resetter
```

So the gate is the **legitimate** game-over: last player + 0 balls left. Both halves are needed.

**Empirical state at runtime (verified by --dump after 5500 batches with F2+Space):**

```
OBJ_5040 = [0x01025040] = 0x01269634
[obj+0xd6]  = 0x00000001   ; num_players = 1 (from registry "Players" default)
[obj+0xda]  = 0x00000000   ; curr_player = 0
[obj+0x146] = 0x00000003   ; balls_remaining = 3 ✓
[obj+0x14a] = 0x00000003   ; balls_per_game template = 3 ✓
```

So [esi+0x146] **is** correctly initialized to 3 at game start. Source: case body for msg=0x3f6 at 0x01018a2f does `mov eax, [esi+0x14a]; mov [esi+0x146], eax; call set_balls_remaining` — copies the template into the live counter. The constructor at 0x0101ab67 (entry is the table-class ctor) hardcodes `[esi+0x14a] = 3` and `[esi+0xda] = 0` (0x0101abeb..0x0101abf2).

**Verdict: the "ball_count permanently 1" framing was wrong.** The 1 is `num_players` (Players=1, single-player default), and 3 is the real balls-per-game (correctly initialized).

**Verified with --count=0x01012918 under F2+Space+Z+/ over 9000 batches: zero hits.** The demo-resetter does not fire on the first plunge. The earlier "first plunge → game over" theory was a misread — that pattern only fires during the **demo's** own ball cycle, which is correct demo behavior.

### Real playability bug (2026-04-28, third pass)

`test/test-pinball-playable.js` shows 8/9 pass:
- ✓ Game reaches gameplay; F2 + Space-plunge works
- ✓ RIGHT flipper (/, VK_OEM_2 = 0xBF): signal 366px ≫ noise 128px
- ✗ LEFT flipper (Z, VK_Z = 0x5A): signal **0px**, noise 0px — Z press has no effect at all

So the bug is asymmetric **per-key**: / works, Z doesn't. Both keys share the same MapVirtualKeyA scan↔VK tables (0x380 forward, 0x3A0 reverse, in `09a7-handlers-dispatch.wat`):
- VK_Z (0x5A) → scan 0x2C ✓ (table at 0x380 byte 0x19)
- VK_OEM_2 (0xBF) → scan 0x35 ✓ (explicit case)
- Reverse: scan 0x2C → 0x5A ✓; scan 0x35 → 0xBF ✓

So tables are clean. The asymmetry must be downstream of the table — either in pinball's runtime dispatch (different code path for left vs right flipper), or in our key-delivery (host_check_input / WM_KEYDOWN injection) treating one key differently.

The earlier note from line 14 said "the path that delivers / does NOT go through process_key at 0x01015072". The recent combobox/popup zorder fix (commit 46f0178) likely fixed `/` via that path. Z is still on whatever broken path was there originally.

**--count=0x01015072 under F2+Space+Z and F2+Space+/ both = 0**, so neither key reaches what we previously called "process_key". Either that fn was renamed/inlined, or both keys flow through a different dispatcher now. Need to identify the actual runtime key-dispatch entry first.

**REVISED (2026-04-28, fourth pass) — both flippers broken; Z vs / asymmetry was a test artifact:**

Visual inspection of `scratch/pinball_play_{rest,left,right}.png` shows **no flipper animation in any frame**. The 8/9-pass result for `/` was a false positive: changes in the bottom quadrant (ball motion, light flicker, sidebar text transitioning from "F2 Starts New Game" → "Player 1's Score") happen to clear the noise+200 threshold for the right rect but not the left. Neither key actually swings a flipper.

**Root cause located at 0x01015072 (the keydown dispatcher):**

The game wndproc (`1c7c22a0-9576-11ce-bf80-44455354`, wndProc=0x01007a3e) dispatches WM_KEYDOWN at 0x01007d1a:
```
01007d1a  test edi, 0x40000000   ; lParam bit 30 (prev key state)
01007d20  jnz 0x1007d28          ; skip if repeat
01007d22  push ebx               ; ebx = wParam
01007d23  call 0x01015072        ; key dispatcher
```

`call 0x01015072` IS reached for every keydown (verified `--count=0x01015072` = 3 for F2+Space+/). But the dispatcher exits early without dispatching:
```
01015074  push ebp; mov ebp,esp; sub esp,0xe0
01015085  cmp [0x1024fd8], 0     ; demo flag — must be 0
0101508e  jnz exit
01015094  cmp [0x1025570], 0     ; pause flag — must be 0
0101509a  jnz exit
010150a0  cmp dword [0x1025568], 0x1
010150a7  jz  body                ; only enters body if state == 1
010150a9  push 0xff; call 0x1014743; jmp exit
```

**Verified runtime state mid-gameplay** (after F2+Space, batch 7900):
- `[0x1024fd8] = 0` ✓
- `[0x1025570] = 0` ✓
- `[0x1025568] = 2` ✗ — dispatcher requires 1, gets 2 → keypresses dropped

So during ball-in-play, `[0x1025568]` holds value 2, causing every key (Z, /, etc.) to fall into the `push 0xff; call 0x1014743` path which doesn't fire flippers. The `--count=0x010150bf=1` reading earlier was the body running ONCE, probably for Space (plunger) before ball deploy when `[0x1025568]` was still 1.

**State machine writers** (xrefs to 0x1025568):
- 0x0101472f: `mov [0x1025568], esi` — generic setter, takes new state as arg
- 0x01014748: read-side dispatcher in `0x01014743` — handles values 0/1/2/3/4 with different sub-behaviors
- 0x010150a0 / 0x010152e9: keydown / keyup dispatch gate (require ==1)
- 0x01015771: `cmp [0x1025568], 0x2`

So the state values mean different game phases. State 1 = "interactive input accepted" (likely between plunger ready and ball-in-play). State 2 = "ball in play" (current observed mid-gameplay). The keydown dispatcher's `== 1` check is wrong for state 2 — but that's how the real binary is written, so on real Win98 flippers must work via a *different* path that doesn't gate on state==1, OR the value 2 we observe is itself wrong.

**Disasm of 0x01014743 (the read-side dispatcher) — state==2 branch:**
```
01014748  mov eax, [0x1025568]
0101474d  test eax, eax
0101474f  jz   0x101478b      ; state 0 → fall through to ret
01014751  jle  0x101478b      ; (signed; same)
01014753  cmp eax, 0x2
01014756  jle  0x1014792      ; state 1 or 2 → jmp 0x101478e (return)
                              ; ⇒ STATE 2 IS A NO-OP HERE
01014758  cmp eax, 0x3
0101475b  jz   0x1014775      ; state 3 path
0101475d  cmp eax, 0x4
01014760  jnz  0x101478b      ; default
01014762  ...                 ; state 4 path: subtract arg from [0x1025574] counter
```
0x01014792 just `xor eax,eax; jmp ret`. So the fallback dispatcher does NOTHING for state 2 either — there's no hidden flipper path here.

**State transition map (verified runtime via --watch-byte=0x1025568 --watch-log):**
- batch 109: 0 → 3 (set from 0x01015771-area on game start)
- batch 1061: 3 → 1 (during F2/Space sequence — "ball ready in plunger")
- batch 2123: 1 → 2 (call site at 0x01011b4d: `push 2; call 0x101461a`) — "ball launched, in play"

State 2 is established by EXPLICIT code at 0x01011b4d (inside fn 0x01011987) immediately after the spring releases. So the binary really does enter state 2 during normal play.

**This is the contradiction:** the binary unambiguously transitions to state 2 during gameplay, AND the keydown/keyup dispatchers (0x01015072 / 0x010152e4) both gate on state==1, AND the read-side dispatcher 0x01014743 has no flipper handler for state 2. Either:
1. There's a SECOND keyboard input path we haven't found (some other window's wndproc, an accelerator table, or a DirectInput poll loop). WM_KEYDOWN is referenced at 23 sites in `.text` (per `tools/find_bytes.js --imm32=0x100`) — only one of which is in the main game wndproc at 0x01007a3e. Worth auditing the others.
2. State 2 should NOT be entered yet — maybe `[0x1024ff8]` (a flag tested at 0x01015106 right before the post-flipper code) gates further state advancement on real hardware, and our emulator sets it too eagerly.
3. There's a separate input-polling thread that reads the keyboard state directly (GetAsyncKeyState / DirectInput) bypassing the message pump.

**Option 3 ruled out:** `node tools/pe-imports.js test/binaries/pinball/pinball.exe --all | grep -iE "asynckey|getkey|directinput|dinput"` reports only `GetKeyNameTextA` (formatting helper), no `GetAsyncKeyState`/`GetKeyState`/DirectInput imports. Pinball is purely WM_KEYDOWN driven.

**Option 1 also ruled out:** `node tools/find_bytes.js test/binaries/pinball/pinball.exe --imm32=0x01007a3e` returns exactly 1 hit (the RegisterClass call at 0x01008654). I checked all 23 `imm32=0x100` sites in `.text`, found their enclosing functions, and searched for pointer literals to each. None of the candidate functions appear as a wndproc pointer. The 0x100 references in those functions are unrelated subtractions (e.g. SC_MAXIMIZE/SC_MINIMIZE switch in WM_SYSCOMMAND code, generic `sub eax, 0x100` arithmetic). **Pinball has exactly one wndproc.**

**Verified flipper key codes at runtime** (dump of 0x01028230):
```
0x01028238  5a 00 00 00   ; right flipper = 0x5A = 'Z'
0x0102823c  bf 00 00 00   ; left flipper  = 0xBF = VK_OEM_2 ('/')
```
So the keycode comparisons at 0x010150bf and 0x010150e5 ARE correctly initialized. The gate state==1 at 0x010150a0 is the only thing blocking input.

**So we're at a real impasse:** the binary genuinely transitions to state 2 during play, the keydown/keyup dispatchers and the read-side dispatcher all gate flipper handling on state==1, there's no second wndproc, and there's no key-polling. The only remaining possibilities:

(a) **State 2 should NOT be entered yet.** The transition `1 → 2` at 0x01011b4d happens inside fn 0x01011987 — likely a WM_TIMER tick or a "ball plunger released" event. If our emulator delivers this trigger too eagerly (e.g. a timer firing before the game expects, or a phantom plunger-release WM_KEYUP), state advances prematurely. Check via `--break=0x01011b4d` and inspect what triggered the call (caller chain via `--trace-stack`).

(b) **State 2 → 1 demotion is missing.** Real pinball may temporarily flip back to state 1 when a key arrives, or there's a "wait for ball-settled" path that demotes 2→1 that we don't reach. The watch log shows state stays at 2 across 20000 batches with no reverse transition — so either the real game also stays at 2 forever (and (a) is the real bug) or there's a path our emulator doesn't trigger.

(c) **The dispatcher has been mis-disassembled.** I read `74 0c` at 0x010150a7 as `jz 0x10150b5` (state==1 → flipper body). That's standard Intel encoding. Confirmed by following both branches (flipper body vs `push 0xff; call 0x1014743`). No mis-decode.

**Most likely root cause: option (a).** Pre-launch (state 1), our emulator sees the spring-release trigger fire correctly. But the post-launch event handler at 0x01011987 may not be matched by the right "ball settled" demotion event that real Win98 would deliver.

**Call chain confirmed:**
- fn 0x01011985 (hot-patch entry of 0x01011987) is reached via exactly ONE caller: 0x01011e2b inside fn 0x01011bb5.
- fn 0x01011bb5 is THE game-event dispatcher: 51 callers all push event ids (0x42, 0x43, 0x2f, etc.) and call it. It routes via `cmp edi, 0x2f / cmp edi, ...` switch.
- At 0x01011e2b the dispatch is `push esi; push edi; call 0x01011985` — so 0x01011985 receives 2 args (event id + game object). At watch hit time, this is the path that pushes state 1→2.
- Major call site: 0x010118f5 inside the spring-release routine: `push 0x42; call 0x1011bb5` — pushing event 0x42 routes through the dispatcher to 0x01011985 which sets state=2.

**No state==2 flipper handler exists anywhere in pinball.exe.** Confirmed by:
- xrefs to [0x1025568]: only 7 sites total, all read-or-write the variable but none branch on state==2 to fire flippers.
- The keydown dispatcher 0x01015072 calls helper 0x100e1b0 BEFORE the state-1 gate — but 0x100e1b0 is a UI shortcut switch (M/D/Space etc., handles game commands like New Ball / Show Score, not flipper firing), and it ALSO early-exits if `[[0x1023bbc]+6] != 0`.

**Conclusion:** the binary really has only state==1 as the input-accepting state, and our emulator is leaving state==2 stuck on. Either the real game spends most of its time in state 1 (with brief 1→2→1 transitions per ball-launch that we're not completing), or there's an external trigger we're missing that demotes state back to 1.

**State-1 setters identified.** Seven callers of state setter 0x0101461a (pushes new state value):
| Site | Pushes | Purpose |
|---|---|---|
| 0x01011b4f | 2 | "ball launched" handler (called via game-event dispatcher 0x1011bb5 with event 0x42 from spring-release) |
| 0x010147b3 | 2 | another state→2 path |
| 0x01015829 | 2 | another state→2 path |
| 0x01014786 | 4 | state→4 (counter-decrement path) |
| 0x010155e9 | 1 or 3 | state→1 OR state→3 depending on flag |
| 0x010153bd | 1 | **state→1** ("ready new ball") — fn 0x010153b0, takes pause-flag arg, posts msg 0x3f6. Called from 4 sites: 0x01007999 (main wndproc), 0x01008812 (main wndproc), 0x0101585b, 0x01016ef5. |
| 0x01018930 | ? | TBD |

So state→1 demotion exists (via 0x010153b0). It's called from the main wndproc, presumably WM_COMMAND handlers for "New Ball" / F2 / Space — i.e. the player has to MANUALLY launch a new ball after each ball drains, and during the launch period state==1 lets flippers test.

**This means:** there's no "ball is in play but flippers should still work" code path in this binary at all. **Real-Win98 pinball ALSO has flippers gated on state==1.** So players can only press flippers while the ball is in the plunger lane (state 1), not after launch (state 2)?? That contradicts how the game obviously plays. So either:
1. The "flipper fire" path I identified (0x010150c7 / 0x010150ed at msg 0x3e8/0x3ea) is NOT actually flipper-fire, but some other thing (maybe "table tilt" / "nudge"). The actual flipper fire might be at one of the OTHER `push 0x3e8` sites: 0x01016ea1, 0x0101f67b, 0x0101faaf, 0x0101ffc5.
2. The state machine is more nuanced — perhaps state 2 transitions to state 1 mid-play in a way I haven't captured because my test never actually let the ball settle.

**Strong candidate for real flipper-fire:** 0x01016ea1 / 0x01016e24 dispatch msg 0x3e8/0x3ea inside fns 0x01016df5 (left flipper actuator) / 0x01016e72 (right). These are stored as callbacks via `push 0x1016df3; push edi; call [0x1001304]` at 0x01016fe5 — looks like a deferred-execution scheduler (push float-time arg, push object, push callback fn, call dispatch). So flippers are SCHEDULED actions, not directly fired from the keyboard dispatcher. That means the keyboard dispatcher's msg 0x3e8/0x3ea sends are upstream of the actuator — the gate at state==1 still applies and we're back to the same wall.

**Verdict:** further investigation needs hands-on patching (e.g. write 1 to [0x1025568] before the keypress arrives) to verify whether the state gate is THE problem or just A problem. That's the cleanest experiment but requires either a `--poke ADDR=VAL@BATCH` flag in test/run.js or a binary patch.

### 2026-04-29 — DEEPER FINDINGS: gate is real, but cause is BALL PHYSICS

Avoiding the need for `--poke`: a second F2 keypress mid-test forces state 2→1 transitively (state setter wrapper 0x010153b0 unconditionally sets state=1). Test schedule:
```
5000:F2,5500:Space,5700:Space-up,7000:F2,7100:Z,7300:Z-up,8000:/,8100:/-up
```

State watch log:
- batch 109: 0→3 (init)
- batch 1061: 3→1 (auto, demo loop)
- batch 2123: 1→2 (auto, demo continues)
- batch 5015: 2→1 (F2 #1)
- batch 6161: 1→2 (~1100 batches after, even though Space was held only 200 batches)
- batch 7001: 2→1 (F2 #2)
- batch 8051: 1→2 (~1050 batches later)

`--count` results during this run (Z at 7100 when state==1, / at 8000 when state==1):
| Probe | Hits | Meaning |
|---|---|---|
| 0x010150c7 | 1 | RIGHT flipper match in dispatcher (Z) |
| 0x010150ed | 1 | LEFT flipper match in dispatcher (/) |
| 0x010187d6 | 32 | runtime obj msg-router entry |
| 0x01018e12 | 1 | msg 0x3e8 (right flipper) handler entry |
| 0x01018ef4 | 29 | "no handler" exit branch |
| 0x01018e68 | 3 | post-gate continuation |
| 0x01016c24 | **0** | static vtable @ 0x010026e0 slot 0 (the "expected" handler) |

**The keyboard dispatcher reaches the right flipper handler** (msg 0x3e8 → 0x01018e12). It does NOT route through 0x01016c24. At runtime, `[0x1025658] = 0x01269624` (the GAME object), whose vtable@0x01002790 has slot 0 = 0x010187d6 — a totally different class than the static vtable I'd been examining. So the static vtable I dumped earlier (0x010026e0) is for a DIFFERENT class instance (probably one of the static flipper-component vtables); the runtime receiver is the "TableInfo" or game-aggregator object.

**The gate inside the msg handler:**
```
01018e12  cmp dword [esi+0x172], 0x0
01018e19  jnz 0x01018ef4         ; bail if [esi+0x172] != 0
01018e1f  mov esi, [esi+0x2a]    ; else delegate to child object
```

At trace-at hit (Z keypress, state==1): **`[0x01269624 + 0x172] = 0x00000001`** — i.e. the "ball deployed" flag is already set, so the handler bails. PNG inspection confirms: dispatcher reaches handler, but no flipper animation visually.

**Single writer of `[obj+0x172] = 1`:**
```
01017868  mov dword [esi+0x172], 0x1
```
inside fn 0x01017793. That fn's prologue is `cmp [esi+0x172], edi (0); jnz exit`, then it does ball-launch work (pushes msg 0x23 to a child, schedules msg 0x3f3 deferred), and finally sets `[esi+0x172]=1` as a "done" guard so it doesn't re-run.

So `[esi+0x172]` = "ball already deployed" once-only flag. **Flipper msg 0x3e8 only fires when this is 0** — i.e. ONLY during pre-deployment. Combined with the state==1 dispatcher gate, the binary genuinely refuses flipper input both before and after ball deployment in this code path.

### Resolution: the keyboard handler at 0x010150c7 is a PRE-DEPLOYMENT path (plunger-area control)

The ONLY way real Win98 pinball can have working flippers during play is if there's a SECOND flipper-fire entry point that I haven't found, OR the runtime object reassignment we observed is wrong.

Hypotheses ranked:
1. **`[0x1025658]` is reassigned during play** — pre-deployment it's the "ball-trough/plunger" object with msg 0x3e8 = "deploy"; post-deployment it should be reassigned to the "play-table" object with msg 0x3e8 = "fire right flipper". Our emulator may not be performing this reassignment because some init/handler isn't running.
2. **The state==1 gate is real-but-narrow** — state 1 might genuinely mean "between balls / pre-launch" and there's a separate state==2 input path I missed despite four passes. Worth re-grepping the disasm with new lenses (look for any code that reads `[0x1025658]` during state 2).
3. **Physics: ball drains too fast.** State stays at 1 in real pinball during play because the ball is bouncing around. Our emulator transitions 1→2 about 1000 batches after entering 1 — even if no Space was pressed (e.g. the auto-cycle 1061→2123 with no input). That's suspicious; suggests the game enters state 2 whenever an internal event ID (0x42 from 0x010118f5) fires, and that event might fire too eagerly.

**Decisive next experiment:** trace the call stack into 0x01011987 (event 0x42 handler that sets state=2). If the caller is the spring-release routine, state→2 is "ball launched" and we need to find the post-launch flipper path. If the caller is a timer or "ball drained" handler, state→2 means "ball drained" and the bug is upstream physics.

```bash
node test/run.js --exe=test/binaries/pinball/pinball.exe \
  --break-once=0x01011987 --trace-stack=0x01011987:12 \
  --input='5000:keydown:0x71,5010:keyup:0x71,5500:keydown:0x20,5700:keyup:0x20' \
  --max-batches=8000
```

Look at the stack frame chain to identify what triggered the state transition. If it's a physics tick / drain event, the bug is much deeper than keyboard input — it's the entire ball-physics chain.

### 2026-04-29 — Caller of state-2 setter identified: spring-release event 0x42

Disasm of fn 0x01011985 (the event handler whose internal call site 0x01011b4f writes state=2):
```
01011998  mov eax, [ebp+0x8]      ; event id arg
0101199b  sub eax, 0x42
010119a1  jz  0x01011b3b           ; event 0x42 → "ball launched"
010119a7  dec eax
010119a8  jnz default              ; default for non-0x42, non-0x43

01011b3b: ; event 0x42 handler (ball launched)
01011b3b  mov ecx, [0x1023eec]
01011b41  fldz
01011b43  mov eax, [ecx]
01011b45  push ecx; fstp; push 0x14; call [eax]    ; vtable[0]: msg 0x14 (with float 0)
01011b4d  push 0x2
01011b4f  call 0x101461a                            ; setState(2) ← OUR TRANSITION
01011b54  ; then notify ball-physics objects via msg 0x3fe (1022)
```

So **state→2 happens immediately on spring-release (event 0x42)**, dispatched from the spring-release routine at 0x010118f5. The state machine is intentional: state 2 = "ball launched, physics simulation running."

### 2026-04-29 — Both KEYDOWN and KEYUP dispatchers state==1 gated; no second path

Re-examined WM_KEYUP dispatcher 0x010152e4: identical state==1 gate at 0x010152e9. KEYUP dispatches msg 0x3e9 (right release) / 0x3eb (left release) instead of 0x3e8/0x3ea. So 4 flipper messages total (fire/release × left/right), all gated on state==1, all routed to runtime obj at [0x1025658]. No alternate state==2 path.

### 2026-04-29 — Default message handler 0x100c0be drops flipper msgs

When msg 0x3e8 reaches the game object's dispatch table at 0x010187d6, post-launch [esi+0x172]=1 forces it to the no-handler exit at 0x01018ef6, which is `push [ebp+0x8]; call 0x100c0be; xor eax,eax; ret 0x8`. fn 0x100c0be only handles msg 0x3f3 — for msg 0x3e8/0x3ea/0x3e9/0x3eb it falls through to `pop ebp; ret 0x4` without doing anything. So after launch, flipper msgs are SILENTLY DROPPED at every layer.

### 2026-04-29 — Conclusive observation: this binary version has no post-launch flipper input

After exhaustive analysis:
- Keyboard dispatcher gates flipper firing on state==1 (pre-launch only).
- Game object's msg dispatcher gates flipper handling on `[obj+0x172]==0` (pre-deployment only).
- After ball launch (event 0x42), state goes to 2 AND `[obj+0x172]` goes to 1, both permanently for the rest of the ball.
- No alternate input path exists for state 2: keyup/keydown dispatchers are the only WM_KEYDOWN/WM_KEYUP handlers in the only wndproc; no key-polling APIs imported; no msg-broadcast or state-2-specific msg id discovered for flipper firing.

**Possibilities at this point:**
- (i) The binary `test/binaries/pinball/pinball.exe` is a stripped/demo build that genuinely has flippers disabled in-play. Compare against a known-good Win98 SE pinball.exe SHA256.
- (ii) The "real" flipper input flows through an utterly different mechanism we missed (e.g. accelerator table lookup before the wndproc gets WM_KEYDOWN, or a TranslateMessage-side hook). Worth dumping the accelerator table at runtime via `--break-api=TranslateAcceleratorA`.
- (iii) Real Win98 pinball assigns flipper keys to LEFT-SHIFT (VK_LSHIFT=0xA0) and RIGHT-SHIFT (VK_RSHIFT=0xA1), not Z/`/`. Our `[0x01028238]=0x5A (Z)` and `[0x0102823c]=0xBF (/)` may be uninitialized garbage or a custom keymap from a default INI we're not reading correctly. Check what initializes these — search for stores into 0x01028238/0x0102823c.

**Cheap next experiment:** sha256 the binary, then probe the keymap initialization:
```bash
shasum -a 256 test/binaries/pinball/pinball.exe
node tools/find_field.js test/binaries/pinball/pinball.exe 0x28238 --op=write
node tools/find_field.js test/binaries/pinball/pinball.exe 0x28238 --base=ds  # if base=ds wasn't covered
```
If keys are loaded from .ini, check what file/section: `--trace-api=GetPrivateProfileStringA --trace-fs`. If the user customized keymap file says LEFT-SHIFT, that might be the correct entry — and our test using Z/`/` is exercising a degenerate "menu only" path.

### 2026-04-29 — INI keymap strings located, msg-id assignments corrected

Binary identity: `sha256 = 2bbc8234685fe2f6324040af6ea20123cf00c4a56882ce0d9074f0beefac67bc`. (Match this against any clean Win98 SE pinball.exe to confirm we have an unmodified binary.)

INI key-name strings located in `.text`:
- 0x010014ac: `"Plunger key"`
- 0x010014b8: `"Right Flipper key"`
- 0x010014cc: `"Left Flippper key"`  ← original binary has a 3-p typo!
- 0x010014e0: `"Players"`
- 0x010014e8: `"FullScreen"`

WritePrivateProfileString sequence at 0x01005620 pairs values with names:
| Slot | Key name | Runtime value |
|---|---|---|
| 0x01028234 | (preceding) | — |
| 0x01028238 | "Left Flippper key" (typo'd) | 0x5A = **'Z'** |
| 0x0102823c | "Right Flipper key" | 0xBF = **'/'** (VK_OEM_2) |
| 0x01028240 | "Plunger key" | 0x20 = Space |
| 0x01028244 | ... | 0x58 = X |

So the keymap is **standard Win98 pinball: Z = left flipper, / = right flipper, Space = plunger**, exactly as the test assumes. Earlier in this doc I had RIGHT/LEFT swapped — corrected mapping:
- **msg 0x3e8** = LEFT flipper FIRE (paired with [0x01028238] = Z)
- **msg 0x3ea** = RIGHT flipper FIRE (paired with [0x0102823c] = /)
- msg 0x3e9 = LEFT flipper RELEASE (keyup of Z)
- msg 0x3eb = RIGHT flipper RELEASE (keyup of /)

The state==1 gate behavior and post-launch silent-drop conclusion are unchanged — only the L/R labels were inverted.

### Summary of where to look next

1. **Compare binary sha256** against a known-good Win98 SE pinball.exe. If our binary is correct, the runtime behavior we're observing must be reproducible on real Win98 — meaning the "post-launch flippers don't work via WM_KEYDOWN" conclusion has to be wrong, and we're missing a path.
2. **Check the accelerator table** — Pinball might use `TranslateAcceleratorA` to convert keys to WM_COMMAND messages BEFORE the wndproc sees WM_KEYDOWN. Run with `--trace-api=TranslateAcceleratorA,LoadAcceleratorsA` to see if the game ever loads/uses one. If yes, the dispatch path is not WM_KEYDOWN at all post-launch.
3. **Reassignment of [0x1025658]** — search for stores to that address; if it's reassigned during play to a different game-object (e.g. a "physics-active flipper bank" object), the runtime msg dispatch path changes. `node tools/find_field.js test/binaries/pinball/pinball.exe 0x25658 --op=write` (if not already done with raw-VA find).
4. **Audit `[obj+0x172]` logic** — 33 read sites, 2 zero-writers, 1 one-writer (0x01017868). The 33 sites might include test-and-set patterns that demote the flag mid-play. Worth tracing reads vs writes during a full simulated game.

### 2026-04-29 — Two ruled out: accelerator dispatch, runtime obj reassignment

Probed both:
- **TranslateAcceleratorA / LoadAcceleratorsA**: never called (verified via `--trace-api=TranslateAcceleratorA,LoadAcceleratorsA` over 2000 batches). Pinball does not use Win32 accelerator tables. So all input must flow through WM_KEYDOWN/WM_KEYUP and the dispatcher we already analyzed.
- **[0x01025658] reassignment during play**: only 3 stores in code (all in fn 0x010155c0, the game-init routine). Runtime watch confirms it's set ONCE at batch 762 (0 → 0x01269624) and never reassigned, despite multiple F2 presses. So the runtime msg receiver is stable.

This eliminates the "second input path" hypothesis. There is genuinely only ONE WM_KEYDOWN dispatch path in pinball, and only ONE message receiver, and both are gated as documented.

**At this point, only two possibilities remain credible:**
1. The binary is broken/stripped/different from a known-good Win98 pinball.exe. Compare sha256 `2bbc8234685fe2f6324040af6ea20123cf00c4a56882ce0d9074f0beefac67bc` against a Win98 SE install reference.
2. Real-Win98 pinball really IS gated this way, and the implication is that flippers genuinely don't fire post-launch. That contradicts decades of player experience and is implausible.

The contradiction is unresolvable from static analysis alone. A definitive answer requires either:
- A working Win98 emulator (e.g. 86Box) running the same binary, with kbd input recorded and the dispatcher's state==1 gate observed at the EXACT instant a flipper press is processed mid-play.
- Comparison against a binary known to work in the wine-assembly emulator (an alternate pinball.exe).
- Examining the state-machine in much greater detail — there may be a transient state==1 window post-each-flipper-fire that demotes back to 2, allowing flippers to fire one-shot via brief state==1 windows.

This investigation has reached its natural end pending external reference data.

### 2026-04-29 — Quantified the dispatch chain: case-handler reached, gate at [+0x172] always blocks

Used `--count` (basic-block-entry probes only) to measure each step of the WM_KEYDOWN → flipper dispatch chain over 10000 batches with input `F2 → Z → / → Space → F2 → Z → /`:

| Probe | Hits | Meaning |
|---|---|---|
| `0x010150c7` | 2 | Z key matched `[0x01028238]` (left flipper key) — twice (within state==1 windows) |
| `0x01018e12` | 2 | Jump-table case 0 (msg 0x3e8 LEFT flipper) entered — exactly matches Z presses ✓ |
| `0x01018e4f` | **0** | Post-gate path (chain to child + broadcast) — NEVER FIRES |
| `0x01018ef4` | 32 | Bail/return path — fires constantly |
| `0x01018e3f` | 2 | Jump-table case 2 (msg 0x3ea RIGHT flipper) — fires twice too (probably from internal cleanup, not user input — `/` key never even reached its dispatcher cmp) |

**This means:**
- The dispatcher chain is structurally correct: `WM_KEYDOWN(Z) → vkey-to-internal-key → cmp [0x01028238] → call vtable[0]([0x01025658]) → jump table[msg-0x3e8] → case 0 at 0x01018e12`. Two Z presses produced two case-0 entries.
- At `0x01018e12`, the gate `cmp [esi+0x172], 0x0 ; jnz 0x1018ef4` ALWAYS bails. The fall-through to the child broadcast at `0x01018e4f` never fires.
- esi at this point = `0x01269624` (root game obj, set once at batch 762 and never reassigned).
- So `[0x01269796] != 0` at every dispatcher invocation.

### Disassembly of the case-0 handler (msg 0x3e8 LEFT flipper)

```
01018e12  cmp dword [esi+0x172], 0x0   ; gate
01018e19  jnz 0x1018ef4                ; bail if non-zero
01018e1f  mov esi, [esi+0x2a]          ; chain to child[0x2a]
01018e22  jmp short 0x1018e4f          ; → broadcast msg=1 to child's vtable[0]
01018e4f  fld dword [ebp+0xc]
01018e52  push ecx; fstp [esp]
01018e56  push 0x1                     ; msg=1
01018e58  jmp short 0x1018e68          ; → call [eax]
```

Root vtable[0] at `0x010187d6` is a switch-by-msg dispatcher with jump table at `0x01018f05` (14 entries) and case-index table at `0x01018f3d` (msg-0x3e8 → idx).

### [esi+0x172] toggle behavior

Watchpoint on `0x01269796` (= root obj + 0x172) over 8000 batches with F2+Space input shows it changes **15+ times** — not a one-shot flag, it's actively toggled during gameplay. Static analysis: 3 writers (`0x010188d2 mov [esi+0x172],ebx`, `0x0101ab45 mov [esi+0x172],ebx`, `0x01017868 mov dword [esi+0x172],0x1`). The two ebx-writers must be running mid-game, since the field returns to non-zero each time we sample it during a dispatcher hit.

Hypothesis: `[esi+0x172]` is a "input lock" that's set whenever physics is busy/animating, briefly cleared between frames. Our keydown happens to land during the locked window every time — which would mean a frame-rate / scheduling mismatch in our emulator: physics runs continuously without yielding back the input-clear window that would let WM_KEYDOWN through.

If that's right, the fix isn't in input handling — it's in the timer/scheduler that calls `0x010188d2` (which clears [+0x172]). If that timer fires too rarely (or never), the gate stays set forever.

### Next concrete steps

1. **Trace WHEN [esi+0x172] is non-zero vs. zero** during a full F2→Space→Z sequence: log every change with batch number AND the value (0 vs 1). The watchpoint logs detect changes but don't print new value — extend the watch to print value, or use --break-once on each writer.
2. **Look at fn enclosing 0x010188d2** (entry 0x0101884d) and 0x0101ab45 (entry 0x0101aaf5) — these clear the gate. What event triggers them? If they're physics-step callbacks, the question becomes whether our scheduler ever calls them.
3. **Caller census on the [+0x172] writers**: `node tools/caller_census.js --exe=test/binaries/pinball/pinball.exe --module=exe --callee=0x0101884d` — count how often each caller fires during gameplay.
4. **Compare timer/scheduler tick rate**: `--trace-api=SetTimer,timeGetTime,GetTickCount` to see how often the game expects the physics tick.

### Original "next concrete step" (kept for reference)

check the other 22 WM_KEYDOWN references — sort the call sites by enclosing function and look for one that ISN'T gated by state==1. Particularly suspect: any wndproc registered for a child HWND, or anything dispatched from a worker thread. Also check for `GetAsyncKeyState` / `GetKeyState` imports in pinball.exe — pinball was a fast-path game and may poll keys directly.

For now, the pixel-rect playable test (`test/test-pinball-playable.js`) reports 8/9 but the "PASS" for `/` is **not** real flipper movement. The test needs tighter bounding boxes (just the flipper triangles ±5px) to be a true regression detector.

### Test

`test/test-pinball-playable.js` exercises both flippers (Z and `/`) with tighter bounding-box diffs: left flipper rect `[40,270]→[100,310]`, right flipper rect `[105,270]→[165,310]`. Currently fails by design — it's the regression target.

## Open Tasks

### 1. Re-add pinball flag pokes — DONE
**Files:** `src/09a5-handlers-window.wat` ($handle_PeekMessageA)
Poke code in PeekMessageA's "no message" return path. Conditional on `wndproc_addr == 0x01055db1` and `msg_phase >= 3`. Sets game-active (0x1024fe0) and commands-enabled (0x1024ff8) to 1. Debug logging (FACE/BEEF/DEAD markers) cleaned up.

### 2. Fix WM_KEYDOWN double-dispatch — DONE (2026-04-11)
**Files:** `src/01-header.wat` (new globals), `src/09a5-handlers-window.wat` ($handle_PeekMessageA, $handle_GetMessageA)

**Root cause:** PeekMessageA's input path called `host_check_input` which dequeued from JS every time, but didn't differentiate PM_REMOVE vs PM_NOREMOVE. When app called PeekMessageA(PM_NOREMOVE) then GetMessageA (or PeekMessageA(PM_REMOVE)), it dequeued the same event from JS twice.

**Fix:** Added three globals: `$pending_input_packed`, `$pending_input_lparam`, `$pending_input_hwnd`. When `host_check_input` dequeues from JS, cache the event. If PM_NOREMOVE is set, also cache the packed event so the next PM_REMOVE call consumes from cache instead of dequeuing again. GetMessageA also consumes from cache if one exists. F2 key now dispatches exactly once.

### 3. Score panel text rendering — MOSTLY FIXED
**Priority: LOW** — Most text now renders after WaveMix fix (task 4).
After the 16-bit ALU fix, sound init succeeds and the attract mode initializes text rendering objects. Score panel now shows: title ("3D Pinball Space Cadet"), score digits, BALL label with number, mission text ("Careful..."). Only "Player 1" label still missing — see task 7.

### 7. "Player 1" label missing — FIXED (2026-04-12)
**Priority: MEDIUM** — Score panel text box never gets DrawTextA call.

**Root cause investigation (2026-04-11/12):**

**Finding 1:** Only 1 CreateCompatibleDC call, zero DrawTextA calls in the entire run.

**Finding 2:** MoveWindow didn't dispatch WM_SIZE. Fixed with `movewindow_pending_hwnd/size` globals.

**Finding 3-4 (FIXED 2026-04-12):** wndproc scan used hardcoded `0x80000` range, capturing comctl32 wndproc `0x01055db1` instead of EXE wndprocs. **Fix:** replaced all `0x80000` bounds with `$exe_size_of_image` in 7 locations across `09a5-handlers-window.wat` and `09a-handlers.wat` (CreateWindowExA/W scans, RegisterClassExA, RegisterClassA, RegisterClassW, class table fallback). Now `$wndproc_addr = 0x01007264` (correct EXE-space).

**Finding 5 (2026-04-12):** WM_SIZE IS now delivered to hwnd=0x10002 via the correct wndproc `0x01007a3e`. Confirmed: `DefWindowProcA(0x10002, 5, 0, 0x01b30258)` in trace. But disasm of `0x01007a3e` shows the main frame wndproc **does not handle WM_SIZE** — it only handles WM_CREATE(1), WM_DESTROY(2), WM_MOVE(3), WM_SETFOCUS(7), WM_KILLFOCUS(8), WM_PAINT(0xF), WM_CLOSE(0x10), WM_ERASEBKGND(0x14), WM_ACTIVATEAPP(0x1C), and higher messages.

**Finding 6 (2026-04-12):** `render::recreate()` at `0x1006fcb` is the only call site for CreateCompatibleDC. It's called only from `render::init()` at `0x10073ea`, which is called once from `0x10086b1`. This creates the main back buffer DC — NOT text box DCs.

**Finding 7 (2026-04-12):** DrawTextA has exactly one call site at `0x10038cd` in `render_sprite::paint()` at `0x1003803`. This function is called from text box paint at `0x1014269`, which is called by game component paint functions via `0x10144b7`. The text box object ("player_number1") IS created (HeapAlloc + lstrlenA at API #11857), but its paint path never reaches DrawTextA.

**Root cause found (2026-04-12):**

The text box uses a **bitmap font** for character rendering, NOT DrawTextA. The field `[+0x42]` points to a font table at `[0x10253c4]` = `0x0134afa0`. When `[+0x42]` is non-zero (which it always is for score panel text), the paint function at `0x1014269` takes the character-by-character blit path at `0x1014394` instead of the DrawTextA path at `0x101438a`.

The **actual blocker** is that `render::process_regions()` at `0x100758d` only runs twice (batch 6 and 7 during init) and then never again. This function processes deferred paint callbacks by iterating the render region list at `[0x1024f70]`. Without it running, the text box's deferred paint callback (`0x10141e1`) never fires.

**Deferred paint mechanism:**
1. `set_text` (`0x10144b7`) creates a render_sprite and stores at `[textbox+0x46]`
2. Paint function at `0x1014269` enters sprite loop, calls `render::paint_component` (`0x10074b7`)
3. `render::paint_component` creates a render region with end_time and callback, inserts into sorted list at `[0x1024f70]`
4. `render::process_regions` (`0x100758d`) checks `[0x1024f84]` (frame counter) >= region end_time, calls callback
5. Callback at `0x10141e1` reads sprite list from `[textbox+0x46]`, renders bitmap font chars via CopyBits8

**Why `render::process_regions` stops:** It is called from the per-frame physics tick at `0x1014bf9` (specifically at `0x1014cb3`). The physics tick also increments `[0x1024f84]` at `0x1014c5c: add [0x1024f84], eax`. This tick function runs during init (batch 6-7) but then stops. The tick is gated by `[0x1024fe0]` (game-active) and called via message 0x3F6 from the game table. Need to verify the tick is running in the active game loop — if `[0x1024f84]` isn't advancing, no render regions get processed.

**Key addresses for text box rendering:**

| Address | Purpose |
|---|---|
| `0x0149af64` | "player_number1" TTextBox object |
| `0x012689a4` | Another text box (score/mission, works) |
| `0x010144b7` | `TTextBox::set_text(string, float)` — creates render sprite |
| `0x01014269` | `TTextBox::paint()` — bitmap blit + sprite loop |
| `0x01014092` | `TTextBox::TTextBox()` constructor — zeroes `[+0x3a]`, `[+0x46]` |
| `0x0101421c` | `TTextBox::~TTextBox()` destructor |
| `0x010141e1` | Paint callback — renders bitmap font chars from sprite list |
| `0x01014143` | Cleanup function — frees sprite list, clears `[+0x3a]` |
| `0x0100758d` | `render::process_regions()` — iterates region list, calls callbacks |
| `0x010074b7` | `render::paint_component(float, textbox, callback)` — creates render region |
| `0x01003803` | `render_sprite::paint()` — DrawTextA path (NOT used for score panel) |
| `0x01014c5c` | `add [0x1024f84], eax` — frame counter increment in physics tick |
| `0x1014cb3` | Call to `render::process_regions` from physics tick |
| `0x1014d03` | Call to `set_text` for player_number1 (loads string resource 0x19) |

**TTextBox struct layout (at +0x3a region):**

| Offset | Type | Purpose |
|---|---|---|
| +0x2a | dword | X position |
| +0x2e | dword | Y position |
| +0x32 | dword | Width |
| +0x36 | dword | Height |
| +0x3a | dword | Render region handle (0=none, -1=needs cleanup, other=active region ID) |
| +0x3e | dword | Sprite type flag (non-zero → CopyBits8 with alpha) |
| +0x42 | dword | Font object ptr (non-zero → bitmap font, zero → DrawTextA) |
| +0x46 | dword | Render sprite linked list head |
| +0x4a | dword | Render sprite linked list tail |

**Render region struct (20 bytes, pool at `[0x1024f7c]`, list at `[0x1024f70]`):**

| Offset | Type | Purpose |
|---|---|---|
| +0x00 | dword | End time (frame counter value when callback should fire) |
| +0x04 | dword | Object ptr (textbox) |
| +0x08 | dword | Callback function ptr |
| +0x0c | dword | Next pointer in sorted list |
| +0x10 | dword | Unique ID (returned to caller, stored in `[textbox+0x3a]`) |

**Render system globals:**

| Address | Purpose |
|---|---|
| `[0x1024f70]` | Render region list head (sorted by end_time ascending) |
| `[0x1024f74]` | Max render regions (150) |
| `[0x1024f78]` | Current render region count |
| `[0x1024f7c]` | Free region pool head |
| `[0x1024f84]` | Frame counter (incremented by physics tick delta) |
| `[0x10253b4]` | Font rendering mode flag |
| `[0x10253c4]` | Default font object ptr (`0x0134afa0`) |

**Font object at `0x0134afa0`:**
- `[+0x00]` = 2 (base char advance)
- `[+0x04]` = 0x16 (line height = 22px)
- `[+0x08 + char*4]` = bitmap ptr for each ASCII char (0x20+ are populated, 0x00-0x1f are null)

**Constants (from .rdata):**

| Address | Value | Used for |
|---|---|---|
| `[0x1001598]` | -1000.0 (qword) | Time multiplier: float → ticks |
| `[0x10015a0]` | 0.001 (qword) | Inverse: ticks → float |
| `[0x10015ac]` | -1.0 (float) | Sprite deletion sentinel |
| `[0x10023c8]` | 0.25 (qword) | Callback path threshold |
| `[0x10023d0]` | -2.0 (qword) | Sprite expiry threshold |
| `[0x1002374]` | 2.0 (float) | Float param for "Player 1" set_text |

**Fix (2026-04-12):** Two issues found and fixed:

1. **Flag poke wndproc check was stale.** The `exe_size_of_image` fix (finding 3-4) changed `$wndproc_addr` from `0x01055db1` (comctl32) to `0x01007264` (correct EXE wndproc), but the flag poke in PeekMessageA still checked for the old address. Updated the check to `0x01007264`. Without this, `game-active` and `commands-enabled` were never set, so the physics tick didn't run properly.

2. **Attract mode text overwriting "Player 1".** Both "Careful..." (resource 0x19) and "Player 1" (resource 0x1A) use the SAME textbox at `[0x1025650]`. The physics tick at `0x1014cd5` checks `[table+0x172]` (ball-in-play flag): if 0, it sets "Careful..." text every frame, overwriting "Player 1". Since we poke `game-active` but never deploy a ball, `[table+0x172]` stays 0 and "Careful..." always wins. **Fix:** Added a separate poke in PeekMessageA that sets `[table+0x172]` = 1 once the table object at `[0x1025658]` exists. This prevents the attract mode text path from overwriting "Player 1". After the fix, sending F2 (New Game) shows "Player 1's Score 0" correctly. Note: needed `i32.ne` to coerce the pointer to boolean before `i32.and` — raw `i32.and` of 1 with a pointer whose bit 0 is 0 produces 0.

### 4. WaveMixOpenWave fails — FIXED
**Priority: HIGH** — Was root cause of attract mode failure, flag poke need, and missing text.
**Files:** `src/07-decoder.wat` ($emit_alu_m16_i), `src/06-fpu.wat` ($th_alu_m16_i_ro), `src/04-cache.wat` ($next)

**Root cause (2026-04-11):** Two bugs, both in the x86 decoder/cache layer:

1. **`$emit_alu_m16_i` used 32-bit handler for simple-base addressing.** When the modrm byte indicated a simple `[reg]` or `[reg+disp]` address, the decoder emitted handler 131 (`$th_alu_m32_i_ro`) which did `$gl32` (32-bit load) and no `flag_sign_shift` adjustment. For `cmp word [edi], 0x1` (encoding `66 83 3f 01`), this loaded 4 bytes from `[edi]`, where the upper 2 bytes were non-zero garbage, making the 32-bit compare against 1 always fail.

2. **Off-by-one in cache handler bounds check.** `$next` in `04-cache.wat` rejected handler indices >= 219, but the table had 220 entries (0-219). Handler 219 (`$th_xchg_r8_r8`) was always treated as cache corruption, causing infinite decode/clear loops for any code using 8-bit `xchg`. This pre-existing bug masked many test results.

**Fix:** Added handler 220 (`$th_alu_m16_i_ro`) for 16-bit ALU [base+disp] with immediate, using `$gl16`/`$gs16` and `flag_sign_shift=15`. Updated `$emit_alu_m16_i` to emit handler 220 instead of 131. Fixed cache bounds check to >= 221.

**Result:** WaveMixOpenWave's `cmp word [edi], 0x1` WAVE_FORMAT_PCM check now passes. Sound initialization completes (waveOutOpen, waveOutPrepareHeader all succeed). Test suite improved from 13 to 48 PASS.

### 5. Fix restoreWatThunks crash (uncommitted)
**Priority: LOW** — Only affects uncommitted DLL loader changes.
**Files:** `lib/dll-loader.js` (restoreWatThunks), `src/08b-dll-loader.wat`
The uncommitted `restoreWatThunks` function + WAT-side DLL loader change cause pinball to crash at init (EIP=0, 211 API calls). The WAT change inverts the condition for storing DLL-resolved imports, leaving stale IAT entries for functions that have WAT handlers. Both changes were reverted for now.

### 6. Clarification: game-active vs hidden test mode
`game-active` (0x1024fe0) and `commands-enabled` (0x1024ff8) are NOT hidden-test-only flags as previously theorized. While they CAN be toggled via the hidden test cheat code, they are ALSO set by the attract mode state machine during normal initialization. The per-frame tick counter at `[ebp-0xf8]` only decrements in the physics tick path when game-active=1 — without it, the counter reaches 0, resets to 300, but the per-frame tick body (Message 0x3F6 to the table) is skipped. This prevents ball physics, sprite updates, and score panel rendering from running properly.

## Fix (2026-04-10): DestroyWindow focus transfer + remove pinball flag poke

**Problem:** Pinball creates a 1x1 splash window (hwnd 0x10001), calls `SetFocus(splash)`, then `DestroyWindow(splash)`. The main game window (0x10002) never received `WM_SETFOCUS` because:
1. `SetFocus` only delivered WM_SETFOCUS to WAT-native wndprocs, not x86 ones
2. `DestroyWindow` cleared `focus_hwnd` but didn't transfer focus to the promoted `main_hwnd`

**Fix (2 parts):**
- `SetFocus`: now delivers WM_SETFOCUS synchronously to x86 wndprocs via EIP redirect (same technique as ShowWindow → WM_SIZE)
- `DestroyWindow`: when the focused window is destroyed and `main_hwnd` is promoted to a different window, delivers WM_SETFOCUS to the new `main_hwnd` via EIP redirect

This sets `game_running=1` BEFORE the message pump function (`0x10082a9`) is entered, so it takes the PeekMessage path naturally. Removed the pinball-specific flag poke hack from PeekMessageA that hardcoded `wndproc_addr == 0x01055db1`.

**Remaining:** The `game-active` and `commands-enabled` flags still need the attract mode state machine to advance. The idle callback slots at `[game_obj+0xf4..0x134]` are all 0/-1 because the function that populates them (`0x0101df3d`, called via vtable from `0x01006c26`) is never reached. The WM_USER (0x400) PostMessage that would trigger it requires these callbacks to be non-null — chicken and egg. See "Attract Mode" section below.

**Also added:** `tools/find-refs.js` — cross-reference finder for PE binaries (call/jmp/jcc + data refs).

## Fix (2026-04-09): WM_SETFOCUS phase added to GetMessageA startup sequence

Found by reading the game wndproc dispatch (`0x01007a3e`):

- `01007ac7..01007ae3`: when `uMsg == WM_SETFOCUS (0x07)`, the game writes `[0x1024fec] = 1` and `[0x1024ff4] = 1` and runs three init calls.
- `01007bdf..01007bf0`: when `uMsg == WM_KILLFOCUS (0x08)`, it clears `[0x1024fec]`.

The outer game loop (`0x01008940`) checks `[0x1024fec]` and `[0x1024fd8]` to decide between two message-loop functions:
- `0x010082a9` — modal `GetMessageA`-only loop (used when `[0x1024fec] == 0`)
- inline peek loop at `0x010087c0..0x010087f3` — `PeekMessageA(PM_REMOVE)` polled with a 2-second `timeGetTime` budget (used when `[0x1024fec] != 0`)

Without ever receiving `WM_SETFOCUS`, the game stayed in the modal `GetMessageA` branch forever and the active gameplay code paths (`0x01004beb`+ inner functions, sprite blits, ball physics) were never reached.

Fix in `src/09a5-handlers-window.wat`: bumped the `$msg_phase` state machine from a 3-step (WM_ACTIVATE → WM_ERASEBKGND → WM_PAINT) startup sequence to a 4-step one with `WM_SETFOCUS (0x07)` inserted as phase 1. Phase indices renumbered 0..4. This matches what real Windows does: when a top-level window is shown and activated, it gets a focus message before its first paint.

### Verification

Before the fix (`--max-batches=10000`):
- 733 PeekMessageA calls (early attract burst), then 7637 GetMessageA calls (modal idle).
- ~61K API calls total.
- Final EIP `0x0100830f` — sitting in the modal message-loop function.

After the fix:
- 3026 PeekMessageA calls, only 2 GetMessageA calls.
- 8944 StretchDIBits calls (sprites animating continuously).
- ~76K API calls total.
- Final EIP `0x01004c02` — inside the inner game tick code (not the message loop).
- Watchpoint on `0x01024fec` confirms the flag flips 0→1 at batch 2372 (when WM_SETFOCUS gets dispatched).

Regression-checked notepad, calc, freecell, ski32 — all still reach clean exit.

## Flipper input chain works — render is the only failure (2026-04-09)

User reported flippers don't move. End-to-end trace with breakpoints + watchpoints proved every stage of the input → flipper-update path works:

| Stage | Verification |
|---|---|
| `check_input` returns Z | trace shows `msg=0x100 wParam=0x5a` |
| `PeekMessageA` yields it | `DispatchMessageA` API call with msg=0x100 wParam=0x5a |
| Wndproc `0x01007a3e` reached | `--break=0x01007d1a` (WM_KEYDOWN case) fires for Z |
| `process_key` `0x01015072` called | break fires for Z |
| Three early-exit gates pass | `[0x1024fd8]` and `[0x1025570]` watchpoints never fire (stay 0); `[0x1025568]` set to 1 at batch 292 by `set_game_state(1)` and never reverts |
| Flipper-key cmp at `0x010150bf` | hit with `esi=0x5a` |
| Match body at `0x010150c7` | reached — Z matches `[0x1028238]` (left-flipper key var, set to `0x5a` at batch 1759) |
| Vtable call `[0x1025658]->vtable[0](float, 1000)` at `0x010150de` | executes — game state advances (score 2000 → 3000 from bumper hits while ball is in play) |

So pinball receives the keypress, dispatches it, accepts it, calls the flipper method, and the ball physics responds. **The flipper sprite renders as missing/erased instead of rotated.** Confirmed by Gemini visual analysis of the snapshots in `scratch/f_*.png` / `scratch/run*.png`: every Z-held frame shows `flipper=missing/erased`. This is the same StretchDIBits sub-rect bug below — when pinball blits the rotated flipper sprite, the destination at the flipper coords gets overwritten but the source pixels read are stale, so the at-rest flipper is erased instead of being replaced with the rotated sprite.

### Test gotcha: ball must be plunged for flippers to react

`test/test-pinball-flipper.js` originally only sent F2 then Z. F2 starts a *game* but the table sits in "Awaiting Deployment" until the user holds Space to plunge the ball. The flipper game-state object's update path silently no-ops while there is no ball in play, so the test was indistinguishable from a broken input chain. Fixed: the test now sends `keydown:32 ... keyup:32` (VK_SPACE = plunger) between F2 and the Z press.

### Test gotcha: `test/run.js` `get_ticks` was wall-clock and non-deterministic

While debugging the plunger, three back-to-back runs of the same input sequence produced API counts 50561 / 48911 / 48311 / 50543 — the plunger sometimes deployed the ball, sometimes didn't, and `pinball.md`'s "rand loop ~30K iterations" termination drifted between runs. Root cause: `test/run.js` had

```js
const tickStart = Date.now();
h.get_ticks = () => ((tickStart + (Date.now() - tickStart) * 200) & 0x7FFFFFFF);
```

so simulated time was tied to host wall-clock through `Date.now()`. Each batch took a jittery amount of wall-time (GC, FS I/O, system load), so the simulated ms between API calls varied per run. A 500-batch Space hold gave pinball anywhere from a few hundred ms to several seconds of perceived plunger duration.

**Fix** (`test/run.js:340-345`): drive `get_ticks` from the batch counter, `tick = batch * 200`. Three back-to-back runs now produce identical 50543-API-call traces. Anything that uses `timeGetTime` / `GetTickCount` in CLI tests is now reproducible. (The browser/`lib/host-imports.js` path still uses `Date.now()`, which is fine — interactive sessions don't need determinism.)

## RESOLVED (2026-04-09): StretchDIBits sub-rect blits now work

Sub-rect blits produce identical output to SDB_FULL_BLIT. The rendering is correct.

## Fix (2026-04-10): Auto-set game flags in PeekMessageA startup

### Root cause: three-level chicken-and-egg

The game's main loop at `0x01008940` has a physics-tick path gated by `[0x1024fe0]` (game-active) and a WM_COMMAND path gated by `[0x1024ff8]` (commands-enabled). Detailed analysis found:

1. **Init state machine unreachable**: The handler at `0x0100e1b0` (which sets `[0x1025050]` → eventually sets `[0x1024ff8]`) is only called from `process_key` at `0x010150ba`. Without keyboard input, it never fires and the state stays at 0 (needs 30).

2. **Per-frame tick runs only once**: The tick at `0x010153ae` is throttled by a 300-iteration counter at `[ebp-0xf8]`. The counter decrement at `0x01008a78` is only reached through the physics tick path (`0x01008a2d`), which requires `[0x1024fe0]=1`. After the first tick, counter=300 and never decrements.

3. **New Game via 'Y' key, not F2**: The game-active toggle at `0x01007e03` (`cmp [0x1024fe0], esi; setz al`) requires `esi=0`. This is set in the WM_KEYDOWN handler at `0x01007d2d`. The cmd check at `0x01007dbd` matches `ebx=0x59` (VK_Y='Y'). F2 (`0x71`) goes to the per-frame tick wrapper at `0x01007976` instead.

4. **`strstr("-demo")` guards per-frame tick**: At `0x010087f3`, `strstr(cmd_line, "-demo")` determines whether to call the per-frame tick or a demo function. The variable at `[ebp-0xfc]` used as the haystack gets overwritten with a time delta at `0x0100885c`, but this only matters if the physics path runs.

### Fix

In `src/09a5-handlers-window.wat`, PeekMessageA's phase 1 (after WM_ACTIVATE delivery), when `$wndproc_addr == 0x01055db1` (pinball), write both flags:
- `[0x1024ff8] = 1` (commands-enabled) — allows Y key to toggle game-active
- `[0x1024fe0] = 1` (game-active) — enables per-frame tick counter decrement and physics

This replaces the previous `--input poke` workaround. CLI to start a game:
```
node test/run.js --exe=test/binaries/pinball/pinball.exe --stuck-after=5000
```
Then press Y to toggle New Game, Space to plunge ball.

### timeGetTime fix for physics tick timing

The physics tick at `0x01008a2a` compares two `timeGetTime()` results: one stored from the previous iteration and one fresh. If they're equal, it sleeps instead of ticking. Our deterministic `get_ticks = batch * 200` returned the same value for all calls within a batch. Fixed by adding a per-call counter: `get_ticks = batch * 200 + callsInBatch++`. This ensures consecutive timeGetTime calls within the same batch return different values.

### Flipper rendering chain (verified working)

The full flipper animation chain works when flags are set:

| Stage | Function | Status |
|---|---|---|
| Key input → flipper object | vtable[0] at 0x10159a9 | ✓ Works |
| Per-frame tick → table Message(0x3F6) | vtable[0] at 0x10187d6 | ✓ Works (with flag poke) |
| Physics tick → collision engine | 0x1014bf9 → 0x1014a68 | ✓ Works (with flag poke) |
| Flipper angle update → bitmap index | 0x10175aa → 0x01013c89 | ✓ Works |
| Sprite group render → CopyBits8 | 0x01013d2d → 0x01004870 | ✓ Works |
| StretchDIBits → screen | Sub-rect blits | ✓ Works |

### Key addresses

| Address | Purpose |
|---|---|
| `[0x1024fe0]` | Game-active flag (gates physics tick in main loop) |
| `[0x1024fec]` | Game-running flag (set by WM_SETFOCUS, gates PeekMessageA vs GetMessageA) |
| `[0x1024ff8]` | Commands-enabled flag (gates WM_COMMAND processing in wndproc) |
| `[0x1025050]` | Init state machine (needs to reach 30 to set 0x1024ff8) |
| `[0x1025658]` | Game table object (TPinballTable, vtable 0x01002790) |
| `0x01007a3e` | Game wndproc |
| `0x010082a9` | Inner PeekMessageA message pump |
| `0x01014bf9` | Physics tick function (takes time delta) |
| `0x10153ae` | Per-frame game tick (sends msg 0x3F6) |
| `0x01007dbd` | WM_COMMAND handler: cmd 0x59 (89) = New Game toggle |

## Previous investigation: StretchDIBits sub-rect blits (resolved)

After the WM_SETFOCUS fix above, pinball reaches active gameplay and issues ~8900 `StretchDIBits` calls per 10K batches. Investigation proved blits now work correctly:

### What we proved correct
- **Single source bitmap.** All 8934 calls use the same `bits=0x63020c`, `bmi=0x62fde4`, `biW=600 biH=416` (bottom-up), `bpp=8`, `colorUse=DIB_PAL_COLORS`, `pal2`. Same `rop=SRCCOPY`. Same window DC `hdc=0x50002`. No `BitBlt`/`CreateDIBSection`/secondary DC anywhere.
- **Source decode is correct.** When we re-decode the entire 600×416 source DIB from WASM memory, the resulting image is recognizable: at startup it's the bare table backdrop; later snapshots show pinball CPU-composing extra content into it ("Player 1", "Awaiting Deployment", score digits, ball graphics) at their visible screen positions. So the source pointer is right, the bottom-up Y handling is right, the palette (mirrored at WASM 0x6020 by `SelectPalette`) is right.
- **The pixel buffer that the per-blit code generates is correct.** Dumping the per-call `pixels` array for the first 30 sub-rect blits gives recognizable sprites: "BALL 1" at 165×44, the "3D Pinball Space Cadet" header at 165×88, individual purple/orange/blue bumper sprites at 21×21, etc.
- **Forcing every blit to copy the entire 600×416 buffer renders correctly.** Added `SDB_FULL_BLIT=1` env override in `lib/host-imports.js` (gdi_stretch_dib_bits) that, after the normal sub-rect draw, additionally re-blits the whole back-buffer to the window canvas. With this on, the screen looks correct end-to-end (table + score panel text + sprites). With it off, only the table backdrop is right and everything else is mangled.

### Diagnostic infrastructure added
- `test/run.js --dump-sdb=DIR` (new flag) — writes one PNG per call's source sub-rect (`sdb_subrect_NNN_srcXxY_WxH_dstXxY.png`), full-DIB snapshots at call indices `[0, 1, 5, 6, 100, 1000, 5000]` (`sdb_*_at<N>.png`), and a `calls.log` with every blit's parameters. Implemented in `lib/host-imports.js` `gdi_stretch_dib_bits` under `if (ctx.dumpSdb)`.
- `test/run.js --png=...` now ALSO dumps each window's `_backCanvas` to `<png>_back_<hwnd>.png` so we can see the offscreen canvas independent of the compositor.
- `SDB_FULL_BLIT=1` env var — debug-only override that overpaints the full back-buffer on every StretchDIBits call. Useful for confirming "is the bug in the small blits or in pixel decoding".
- `SDB_DEBUG=1` env var — logs `bmi/bits/biW/biH/bpp/rowBytes/src/dst/canvas` for the first 12 blits.

### What's still wrong
With `SDB_FULL_BLIT` off, dumping `_backCanvas` directly (bypassing the compositor) shows:
- Table backdrop is laid down correctly (from the 2 startup full-screen blits at calls #4/#5).
- Right-side score panel area shows TWO stacked copies of the static "Space Cadet" panel, not the live score/text.
- General visible content matches what you'd get if many sub-rect blits were copying *static portions of the source DIB* rather than the *current sprite content* pinball is supposed to have written into those positions.

So the sub-rect blits ARE landing in `_backCanvas` (no canvas-clearing bug, no compositor bug), but they're reading **stale or wrong source pixels** at the moment of the blit — even though the snapshot we take at higher call indices clearly shows pinball does eventually write the right content into the buffer.

### Top theories (untested)
1. **Pinball uses two buffers and we're conflating them.** The `bits` pointer in StretchDIBits points to a sprite-cell scratch buffer; pinball CPU-renders the visible game state into a *different* framebuffer (which is what our snapshots are picking up because both addresses happen to land in the same WASM memory range). Need to add a heap-trace to see what allocator returns 0x63020c and whether pinball touches another nearby allocation.
2. **Address-translation skew between CPU writes and StretchDIBits reads.** Pinball's CPU writes go through one address translation, our `gdi_stretch_dib_bits` reads through `g2w`-translated `bitsWA`. If the two land at different WASM offsets we'd read stale-ish bytes that drift over time.
3. **`hdc=0x50002` isn't actually the window DC.** If our `_getDrawTarget` resolves it to the wrong target (e.g., a memory DC selected into something), the sub-rect blits paint to the right canvas but pinball *thinks* it painted somewhere else and never re-issues them. Less likely because the SDB_FULL_BLIT override hits the same `t.ctx` and looks correct.

### Observed sub-rect call pattern
First 12 calls (from `--dump-sdb` log):
```
#0  src=(553,242 15x22)  dst=(553,152 15x22)
#1  src=(403,197 15x22)  dst=(403,197 15x22)   ← src == dst
#2  src=(405,133 165x44) dst=(405,239 165x44)  ← src != dst, large rect
#3  src=(405,25  165x88) dst=(405,303 165x88)  ← src != dst, large rect
#4  src=(0,0    600x416) dst=(0,0   600x416)   ← full-screen
#5  src=(0,0    600x416) dst=(0,0   600x416)   ← full-screen
#6  src=(51,166  21x21)  dst=(51,229 21x21)
#7  src=(41,190  21x20)  dst=(41,206 21x20)
...
```
Mix of identity blits and src≠dst blits. Whatever architecture pinball is using, it's NOT a simple "compose at final coords + push changed regions" — there's at least one level of scratch-cell indirection, which is why the source DIB position read for a blit is *not* the visible-screen position pinball expects to update.

### Files touched in this investigation
- `lib/host-imports.js` — `gdi_stretch_dib_bits`: added `--dump-sdb` instrumentation, `SDB_DEBUG`/`SDB_FULL_BLIT` env hooks, fixed `SelectPalette` to mirror palette index at WASM 0x6020 so DIB_PAL_COLORS resolves the right table per blit.
- `src/09a-handlers.wat` — `$handle_SelectPalette` writes resolved palette index (0..3) to memory 0x6020.
- `test/run.js` — `--dump-sdb=DIR` flag, `_backCanvas` dump alongside `--png`.

### Next steps to try
1. Heap-trace to identify what allocator returns the 0x63020c region and whether pinball calls it once or twice (single buffer vs two buffers theory).
2. Add a memory watchpoint on a few bytes inside 0x63020c+(553*600+242) (the source position of blit #0) and see whether pinball CPU-writes to that exact address before blit #0 fires. If yes, our address translation is fine and the bug is elsewhere. If no, pinball is writing somewhere else and we're reading the wrong place.
3. If theories 1-2 don't pan out, hand-disasm the pinball routine that calls StretchDIBits (the EIP at the time of the call; visible in the trace) to see where it gets `lpBits` and `xSrc/ySrc` from.

## What Works

- PE loading + DLL loading (comctl32.dll, msvcrt.dll)
- DllMain calls succeed for both DLLs
- msvcrt CRT init (TLS, heap, environment, command line, codepage)
- comctl32 class registration (10+ window classes)
- Registry reads/writes from `Software\Microsoft\Plus!\Pinball\SpaceCadet`
- MapVirtualKeyA scan (0x00–0xFF keyboard mapping)
- Window class registration + CreateWindowExA (640x480 main window)
- **WM_CREATE delivered to pinball's game WndProc**
- **Nested CreateWindowExA**: 4 windows created during init
- CreatePalette, SelectPalette, RealizePalette — palette stored in WASM memory
- GetDesktopWindow, GetWindowRect, SetCursor
- WaveMix initialization: wavemix.inf loaded via CreateFileA/fopen
- waveOutGetDevCapsA, waveOutGetNumDevs, waveOutOpen, waveOutPrepareHeader — audio device enumeration + init
- **PINBALL.DAT fully loaded** — table data parsed, structures initialized
- **WAV sound files loaded** — mmioOpenA/mmioDescend/mmioRead/mmioAscend/mmioClose fully implemented
- **ShowWindow + UpdateWindow for main game window (hwnd=0x10002)**
- **Game loop reached** — PeekMessageA polling active
- **StretchDIBits rendering** — game draws sprites and table elements
- **Clean exit** — ExitProcess(0) after game loop

## Fixes Applied (This Session — mmio + heap_free guard)

1. **mmioOpenA real implementation** (`09a3-handlers-audio.wat`): Previously returned 0 (failure stub). Now opens WAV files via `host_fs_create_file`, returning a real file handle. Supports MMIO_READ and MMIO_CREATE flags.

2. **mmioDescend real implementation** (`09a3-handlers-audio.wat`): Previously returned MMIOERR_CHUNKNOTFOUND. Now properly parses RIFF/LIST chunk headers, reads 8-byte chunk header (ckid + cksize), handles RIFF/LIST fccType reading, supports MMIO_FINDCHUNK/MMIO_FINDRIFF/MMIO_FINDLIST search flags, fills MMCKINFO struct (ckid, cksize, fccType, dwDataOffset, dwFlags).

3. **mmioRead real implementation** (`09a3-handlers-audio.wat`): Previously returned 0. Now reads bytes via `host_fs_read_file`, returns actual bytes read.

4. **mmioAscend real implementation** (`09a3-handlers-audio.wat`): Previously was a no-op. Now seeks past remaining chunk data (word-aligned) using `host_fs_set_file_pointer`.

5. **mmioClose real implementation** (`09a3-handlers-audio.wat`): Previously was a no-op. Now calls `host_fs_close_handle`.

6. **heap_free guard for non-heap addresses** (`10-helpers.wat`): The root cause of the previous crash (HeapReAlloc with corrupted pointer 0x2c2c2c28). msvcrt's Small Block Heap (sbh) manages small allocations (<1KB) internally. When sbh-managed blocks were freed through our HeapFree thunk, `heap_free` would add these foreign addresses (below 0x01D12000) to our free list, corrupting it. Later `heap_alloc` would return these non-heap addresses, leading to cascading corruption. Fix: `heap_free` now silently ignores addresses below `0x01D12000` (our heap base).

7. **msvcrt sbh_threshold patch** (`dll-loader.js`): After DllMain, finds `_set_sbh_threshold` export in msvcrt, extracts `__sbh_threshold` variable address from its code, and sets it to 0 to prevent new sbh allocations. Combined with the heap_free guard, this prevents all sbh-related corruption.

## Previous Fixes (Summary)

- _lread/_hread double g2w fix
- _initterm double g2w fix
- SEH trylevel update double g2w fix
- CACA0001 nested CreateWindowExA stack-based return
- DestroyWindow main_hwnd promotion
- CREATESTRUCT address fix for non-0x400000 imageBase
- StretchDIBits implementation (host import + JS renderer)
- VFS pre-loading of companion files
- Class table expanded (16→32 slots)
- Palette APIs, WINMM audio APIs

## Current State

Title screen renders correctly (table bitmap, palette, menu chrome) in both CLI and browser. F2 (New Game) is received and game state advances (1 ball → 2 balls in score panel), but no physics/animation: ball can't bounce because the wall collision data fails to load for 4 visuals.

Blocker: **`# walls doesn't match data size`** fires 4× during PINBALL.DAT loading from a `loader_query_visual()` context. File reads return correct byte counts — the bug is somewhere subtler (struct size mismatch, alignment, or arithmetic on values read from the file).

### Re-verification (2026-04-09): wall-error path is NOT exercised in current CLI run

Re-ran CLI baseline (`node test/run.js --exe=test/binaries/pinball/pinball.exe --max-batches=10000 --stuck-after=5000`). Findings that contradict the notes above:

- **Zero MessageBoxA calls.** Filtered the entire `--trace-api` log: no "walls doesn't match data size" fires.
- **`loader_query_visual` (0x0100950c) is never reached.** `--break=0x0100950c` → no hit in 10K batches.
- **`loader::loadfrom` root (0x01015426) is never reached.** `--break=0x01015426` → no hit either.
- **Wall-loader sub-call (0x01009349) and the count-mismatch site (0x0100974f) both never hit.**

So whatever path was producing the 4 wall errors in the previous session is no longer being executed at all. PINBALL.DAT *is* still being opened (CreateFileA + many `_lopen`/`_lread` calls trace through), but via a different loader entry that does not call `loader_query_visual`. The "wall validation" investigation in the sections below is operating on a code path the runtime no longer enters — chase this with fresh instrumentation before trusting any of the prior conclusions.

### New blocker (2026-04-09): game switches from PeekMessageA loop to GetMessageA modal loop

Trace shape after the title screen renders:

1. PeekMessageA polling loop runs from API #25013..#27263 (~750 polls — this is the active game loop).
2. At #27266 the game calls `EnableMenuItem(menu=0x80001, id=0x67)`, `EnableMenuItem(id=0x191)`, `CheckMenuItem(id=0x194)` — game-state menu sync, suggesting it just left an attract/intro state.
3. Several rounds of `GetDC → SelectPalette → RealizePalette → StretchDIBits → ReleaseDC` paint sprites (score panel digits).
4. Then a long, hot loop calls `GetLastError → TlsGetValue → SetLastError` ~30 000 times. The code site is `0x0100a482..0x0100a4d4`:
   ```
   0100a482  mov ebx, [0x1001304]   ; IAT slot — almost certainly msvcrt!rand
   0100a488  call ebx               ; rand()
   0100a48a  push 0x64; cdq; pop ecx; idiv ecx   ; eax % 100
   0100a490  cmp edx, 0x46          ; <= 70 ? skip : do FPU branch
   ...
   0100a4a3  call ebx               ; rand() again on the "do" branch
   0100a4d1  dec [ebp-0xc]; jnz 0x100a482   ; loop counter
   0100a4d6  jmp 0x100a297          ; outer loop continuation
   ```
   The `db 0xdb 45 ec` / `db 0xdc` bytes the disassembler is choking on are FPU ops (`fild`/`fmul` etc.), so this loop is the game's randomized sound/animation pump. Each `call rand` expands to the GetLastError/TlsGetValue/SetLastError triple because msvcrt's `rand` touches `_errno`. Not necessarily wrong, but it's where the run spends most of its budget.
5. Once the rand loop exits, pinball receives `WM_ACTIVATE` (DefWindowProcA msg=0x06 wParam=1), does one BeginPaint/EndPaint, and **switches to `GetMessageA` blocking loop** (#27810 onward, 7 600+ calls). It never returns to PeekMessageA.

`GetMessageA` instead of `PeekMessageA` means the game's main loop branch decided "not currently running" and is now blocked waiting for input. In CLI we never deliver any, so it sits forever. This is the *current* blocker, not the wall-loader. To make progress: figure out what set the "not running" flag during the menu-sync transition (#27266) and whether the rand loop is supposed to terminate via a different exit (it currently runs ~30 K iterations before falling through).

Suggested next steps:
- Re-verify in browser whether the title screen still renders the same way and whether F2 → game start still works there. The browser path may behave differently because input is delivered.
- Instrument `EnableMenuItem` / `CheckMenuItem` callers around #27266 to find which game-state setter ran. The id 0x191 = 401 is a menu cmd, not a wall tag — coincidence.
- Add a one-shot host log around eip 0x0100a297 (outer loop head) to confirm the rand loop exits cleanly and to count outer iterations.
- Inject `WM_KEYDOWN VK_F2` *after* the GetMessageA loop is reached and see if the game can start from there (CLI input injection at a fixed batch via `--input=`).

### Version-mismatch hypothesis DISPROVED (2026-04-08)

Staged the original Microsoft Plus! 95 (1996) version under `test/binaries/pinball-plus95/` from `https://archive.org/details/SpaceCadet_Plus95`. This is a fully matched 1996 exe + DAT pair (different content from the XP set: PINBALL.EXE 351,744 vs 281,088, PINBALL.DAT same 928,700 size but different bytes). After implementing trivial stubs for `GetProcessAffinityMask` and `SetThreadAffinityMask` (Plus! 95's older statically-linked CRT calls them during init), the Plus! 95 build runs and **hits the exact same `# walls doesn't match data size` error from `loader_query_visual()`** — 5 occurrences instead of XP's 4.

**Conclusion:** Two independent Microsoft pinball binaries (1996 and 2008), each with their own matched DAT, fail in the same wall-loader. The bug is in our emulator, not in any version skew. The previous "tags 407/408 unhandled" theory is wrong — Plus! 95 binary almost certainly handles different tag ranges than XP's, yet still fails. Focus future investigation on emulator-side bugs in the FPU path or integer arithmetic used by the wall sub-loader at `0x01009349` (XP) / equivalent in Plus! 95.

### msvcrt `floor` traced (this session)

Hand-decoded `msvcrt.dll!floor` (file 0x2c7a1, RVA 0x2b7a1, default load 0x7802b7a1) — the disasm tool was mangling FPU bytes so I read raw bytes:

- `floor()` prologue: saves FPU CW, calls a helper that does `fnstcw + or RC=01 + fldcw` (sets round-down mode)
- Loads input via `fld qword [ebp+8]`, checks high word for NaN/Inf via `and ax, 0x7ff0; cmp ax, 0x7ff0`
- Normal path: `call 0x7802e20e` — and **this helper is exactly**:
  ```
  7802e20e  55              push ebp
  7802e20f  8b ec           mov ebp, esp
  7802e211  51 51           push ecx; push ecx     ; reserve [ebp-8]
  7802e213  dd 45 08        fld qword [ebp+8]
  7802e216  d9 fc           frndint                ; ← rounds per current CW
  7802e218  dd 5d f8        fstp qword [ebp-8]
  7802e21b  dd 45 f8        fld qword [ebp-8]
  7802e21e  c9              leave
  7802e21f  c3              ret
  ```

So `floor()` **does** depend on `frndint` honoring the FPU control word's RC bits — which is exactly the bug I fixed in `06-fpu.wat`.

Verified the fix is being exercised: instrumented `$fpu_round` with `host_log_i32` to log `(fpu_cw, value*1000)`. Saw consistent CW = `0x173F` (RC = 01 = round-down) and many distinct values flowing through. All tag-range floats appearing in `floor` inputs are exact integers: 401.0, 402.0, 403.0, 404.0, 405.0, 406.0, **407.0**, **408.0**.

**New mystery**: the wall sub-loader at `0x01009349` only handles tags `0x191..0x196` (401..406). Tags 407 and 408 fall through the `dec eax` chain to the unknown-tag error path at `0x01009478`. But:
- 407 appears in `floor` inputs as early as batch ~752 (before the first wall error at batch 755)
- 4 wall errors fire total but values 401-407 appear repeatedly throughout the run
- So either 407 is being processed by a *different* function (one of the 44 `floor` call sites in pinball.exe, not just the wall sub-loader), or our pinball.exe simply doesn't handle tags 407/408 at all and the failing visuals contain them

The fix to `frndint` is **correct** but **does not** resolve pinball — `floor` was already working correctly in our emulator for integer-valued floats (which it produces correctly with any rounding mode). The wall errors have a different root cause: probably pinball.exe + PINBALL.DAT version mismatch where the data uses tags 407/408 not in the binary's switch table, OR there's a different code path that handles 407+ via a function I haven't yet identified.

### FPU `frndint` correctness fix (this session)

While investigating the wall hypothesis, found and fixed a real x87 bug in `src/06-fpu.wat`: `frndint` (`D9 FC`) was hardcoded to `f64.nearest`, ignoring the FPU control word's RC bits. Added a `$fpu_round` helper that switches on `(fpu_cw >> 10) & 3` → `f64.nearest` / `f64.floor` / `f64.ceil` / `f64.trunc`, and routed `frndint` through it. **This is a correctness fix but did NOT resolve the pinball wall errors** — msvcrt's `floor()` evidently doesn't reach `frndint` in our run, so the wall-decode failure has another root cause (still TBD; see below). `fistp` paths still use `i32.trunc_sat_f64_s` unconditionally; that's correct for `_ftol` (which sets RC=11 truncate before calling) but wrong for direct `fist`/`fistp` from generic code. Left for a follow-up.

### Wall error site is a SHARED CALL — not the JZ fall-through (2026-04-08)

Spent a session chasing a phantom decoder bug. Decisive instrumentation:

- Hooked `$th_jcc` to log the JZ at `0x010095fa`. It fires **112 times, taken every single time**. The fall-through path to `0x01009600` (`push 0x12; push 0x0e; call 0x01008f7a`) is **never executed in our run**.
- Hooked the `$run` loop to log eip transitions into `0x01009604`. The 4 wall-error fires all come from `prev_eip = 0x0100974f`.
- Disasm of `0x0100974f`:
  ```
  0100973c  cmp ax, 0x1
  01009740  jnz short 0x1009747
  01009742  mov [edi+0x8], ebx
  01009745  jmp short 0x1009727        ; success
  01009747  movsx eax, ax
  0100974a  cmp eax, [edi+0x8]
  0100974d  jz short 0x1009727         ; success
  0100974f  push 0x12
  01009751  push 0x8                   ; ← msg_id=8 = "# walls doesn't match data size"
  01009753  jmp 0x1009604              ; jumps INTO the previous error_reporter call site
  ```
- The compiler emitted a JMP into the middle of the previous (`0x01009600..0x01009609`) error sequence, **reusing only its `call 0x01008f7a; jmp 0x0100972c` tail**. So the disasm of `0x01009600` (`push 0x12; push 0x0e`) is the source-level error site for tag 400, but the **runtime error site is `0x0100974f`** with msg_id=8 (a count-mismatch check unrelated to the tag-400 path).
- Earlier "msg_id mismatch" finding (push trace showed `last_push0=8, last_push1=0x12`) was correct — those are pushed at `0x0100974f-51` by the shared-call site. There is no decoder bug. The decoder, cache, JCC fall-through, and call_rel emit are all correct.

So the **real bug** is in the count-mismatch check at `0x0100974a`: `eax (movsx ax)` does not equal `[edi+8]`. One side is wrong.

Context for `[edi+8]` and `ax`:
- The block lives in some loader function around `0x010096a4..0x01009753`. It calls `0x0100905b` (a sub-loader) at `0x01009612` and processes results in a loop that ends at `0x0100971b: test ax, ax / jnz 0x0100973c`.
- `[edi+8]` is the **expected wall count** stored on the visual record by an earlier code path.
- `ax` is the **actual count** returned/computed somewhere.
- They mismatch in 4 visuals.

**Next investigation step**: instrument around `0x0100974a` to log `eax` and `[edi+8]` for each of the 4 failures, then trace back which load wrote each side wrong. The previous wall sub-loader (`0x01009349`) is **not** the failing function — it returns success on this path; the failure is in a different sub-loader (probably `0x0100905b`) or the count comparison itself.

### Investigation so far (wall validation)

- All 4 MessageBoxA calls share return address `0x01008fd2` → single error-reporter helper at `0x01008f7a`. The helper does `or eax, -1` before returning, so it always returns -1 to its caller.
- Disasm of helper confirms it takes `(msg_id, caption_id)`, looks up text/caption pointers in a table at `0x010235f8` (entries `{key, ptr}` terminated by negative key). Caption=0x12 maps to "loader_query_visual()".
- Disasm of `loader::query_visual` at `0x0100950c`: it's a switch on visual-tag values read as 16-bit words from `[esi]`. Cases for tags 100, 300, 304, 400, 406. The case for **tag 400 (`0x190` = RECTLIST)** is the only place that pushes `(msg_id=0xe, caption=0x12)`:
  ```
  010095eb  lea eax, [edi+0x14]      ; &visual->walls
  010095ee  push eax
  010095ef  movsx eax, word [esi]    ; sub-visual index
  010095f2  push eax
  010095f3  call 0x1009349           ; sub-loader
  010095f8  test eax, eax
  010095fa  jz .ok
  01009600  push 0x12; push 0x0e     ; "# walls doesn't match data size"
  01009604  call 0x1008f7a
  ```
- **Sub-loader `0x01009349`** (~250 bytes): Loads two group-data blobs by index — type-0 (must start with `word 0x190`) and type-0xb (a list of records). Each record's tag is decoded as: `fld dword [esi]; sub esp,8; fstp qword [esp]; call [floor]; call _ftol; movsx eax, ax`. So tags are stored as **single-precision floats** (e.g. 401.0..406.0) and converted via msvcrt's `floor` + `_ftol`. Switch jumps on tags `0x191..0x196`; unknown → inner error path which **also** calls the same helper (caption 0x14, msg_id varies).
- **Mystery**: Trace shows exactly **4** MessageBoxA calls, all caption=0x010017ec, all msg_id=0xe (text "# walls doesn't match data size"). Inner error paths in `0x01009349` should fire MessageBox with caption=0x14 BEFORE the outer fires with 0x12, but no such inner messages are observed. So either: (a) the inner function returns -1 via some path I haven't found that doesn't fire MessageBox; (b) the table lookup degenerates and the helper's caption arg actually maps both 0x12 and 0x14 to the same pointer 0x010017ec, hiding the inner errors as duplicates of the outer text — but text is selected by msg_id and only id=0xe gives "walls doesn't match"; (c) some path I'm not seeing.
- `--break` is unreliable here: it only fires at WASM batch boundaries, so most in-block addresses report "0 hits" even when executed. This invalidated my earlier confidence in "inner error sites are not hit". Need a different debugging mechanism (host_log injection or deeper instrumentation) to actually trace the path through `0x01009349`.
- EBP chain (12 deep) from each MessageBoxA call shows 3 distinct loader entry points hitting it:
  - `0x01017c6f` — 1× failure (first)
  - `0x010190b5` — 3× failures, via `0x0101c59f` / `0x01019bd7` / `0x0101a2d1` (different visual-loader sub-paths)
  - All under `0x0101aaf5` → `0x01015426` (loader-root, likely `loader::loadfrom`)
- Tooling improvement: `test/run.js` `--trace-api` now prints MessageBoxA return address + 12-deep EBP frame chain. This is what made it possible to localize the failures in one run.

### Next Steps
1. **Trace the actual path through `0x01009349`** — `--break` is unreliable for in-block addresses; need either (a) `$host_log_i32` injection at the inner function's tag-switch, (b) a temporary x87-op trace in `06-fpu.wat` to log values returned by `floor`/`_ftol` during PINBALL.DAT loading, or (c) a `--trace-block` mode in run.js that logs every block-decode boundary by EIP.
2. **Verify `getGroup_data` returns the right pointer** for the failing indices — could be a PINBALL.DAT parsing issue rather than FPU. The data format ("PARTOUT(4.0)RESOURCE.3D-Pinball" header) needs to be cross-referenced with the SpaceCadetPinball decomp.
3. **Cross-reference msvcrt `floor` disassembly** — the disasm tool mangles FPU opcodes; need to hand-decode the bytes at `msvcrt.dll!floor` (file offset 0x2c7a1, RVA 0x2b7a1, runtime VA depends on load) to confirm whether it actually uses `frndint` or some other mechanism. `_ftol` is already confirmed to be `fstcw + or RC=11 + fldcw + fistp m64 + restore`, which works correctly with our truncate-always `fistp`.
2. **STUCK detection default** — Pinball has a long row-by-row blit loop at `0x010048c2` (~0xCB × 0x18A bytes) that false-trips `--stuck-after=10`. Need `--stuck-after=2000` and ~5000 batches to reach the message loop now. Bump default, or count instructions instead of batches.
3. **Perf regression?** — `pinball.md` previously said "~54K API calls across 500 batches"; current run needs ~5000 batches for ~45K calls. Worth investigating whether init genuinely got longer or block-cache/decoder regressed.
4. **Sound playback** — WAV files loaded but `waveOutWrite` just marks buffers done. Could add Web Audio playback.
5. **Input handling** — Mouse/keyboard events past F2 need to reach the game's PeekMessageA loop reliably.

## Attract Mode State Machine (open investigation)

The attract mode requires a chain of callbacks to advance the init state to 30, which sets `commands-enabled`, which lets the Y key set `game-active`, which enables the physics counter decrement. Currently the game works because of flag pokes, but the natural attract mode path is broken.

### Key data structures
| Address | Name | Value at runtime |
|---------|------|-----------------|
| `[0x1025798]` | game object ptr | `0x0151dec4` (set during init) |
| `[0x1027be0]` | game obj copy (timer dispatch) | same ptr |
| `[0x1027bec]` | timer linked list head | 0 (always empty) |
| `[game+0xf4..0x134]` | 16 idle callback slots | all 0 or -1 |
| `[game+0x1a4]` | pending-work flag | 0 |
| `[0x102506c]` / `[0x1025070]` | primary object array / count | 1 object |
| `[0x1025084]` / `[0x10250b4]` | secondary object array / count | 195 objects |

### Timer dispatch flow (`0x1006bb8` → `0x101dd5d`)
Called every main loop iteration regardless of game-active:
1. Walk timer linked list at `[0x1027bec]` — execute due callbacks via PostMessageA(0x3BD)
2. If list empty AND `[game+0x1a4]==0`: scan idle callback slots `[game+0xf4..0x134]`
3. If any slot is non-null/non-(-1): PostMessageA(hwnd, WM_USER, *, game_obj)
4. WM_USER in wndproc calls `0x01009896` → `0x01006c26` → `0x0101df3d` (populate slots)
5. **Chicken-and-egg**: step 4 populates the slots that step 3 needs to fire step 4

### Call chain to populate slots
```
0x0101df3d  — writes object ptrs into [game+0xf4+i*4] at 0x101e21d/0x101e24e
  ↑ called from 0x01006c24 (attract mode dispatch, stdcall(6))
  ↑ called from 0x010098b6 (small wrapper, via vtable)
  ↑ called via WM_USER dispatch in wndproc
  ↑ posted by timer dispatch idle check at 0x0101dd3c
  ↑ needs [game+0xf4] to be non-null to fire the PostMessage ← STUCK HERE
```

### How to advance
The slots at `[game+0xf4]` should be set during table initialization (PINBALL.DAT loading). The game object is allocated at `0x1020ed1` with slots initialized to -1 (`rep stosd`). Something in the table loader should write real object pointers there, but it doesn't happen.

**Open questions:**
1. Does `0x1020ed1` (game object alloc) set up the initial callback? Disasm shows it fills with -1, then what?
2. Is the game object's "new game" function supposed to write the first callback? On real Windows, the attract mode might be triggered by a menu command or timer that we're not delivering.
3. Could a missing `WM_COMMAND` (e.g. ID_NEW_GAME from the menu accelerator) be the trigger that starts attract mode?

## Architecture Notes

- Pinball imports from KERNEL32, USER32, GDI32, ADVAPI32, WINMM, COMCTL32, MSVCRT
- comctl32.dll and msvcrt.dll loaded as real PE DLLs; other DLLs handled via API thunks
- **Game WndProc (0x01007a3e)**: Large message dispatch. WM_CREATE does table init.
- Game uses PeekMessageA(PM_REMOVE) + timeGetTime polling game loop
- Table data in proprietary PINBALL.DAT format (928KB)
- Audio via WaveMix library (wavemix.inf config, waveOut* APIs, mmio* for WAV loading)
- Registry key: `HKCU\Software\Microsoft\Plus!\Pinball\SpaceCadet`
- **Init flow**: WinMain → RegisterClassA → CreateWindowExA (frame) → CreateWindowExA (game) → WM_CREATE → table init → PINBALL.DAT load → WAV load → ShowWindow → DestroyWindow(frame) → PeekMessageA game loop

## Memory Layout for Palette Storage

- `0x2800`: Palette table (4 entries × 8 bytes: handle + count)
- `0x2830`: Palette data (4 × 1024 bytes, 256 RGBX entries each)
- Handles: 0x000A0001–0x000A0004
