# Memory Map — wine-assembly vs Windows 98

## WASM Linear Memory Layout (128 MB)

```
0x07FF2800 ┌────────────────────────┐
           │  COM_WRAPPERS (2KB)    │  256 x 8-byte COM dispatch slots
0x07FF0000 ├────────────────────────┤
           │  DX_OBJECTS (8KB)      │  256 x 32-byte DirectX object records
           │                        │  (high memory — outside g2w bounds)
           ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤
           │       ...gap...        │
0x04462200 ├────────────────────────┤
           │  File mapping zone     │  MapViewOfFile allocations (high region)
0x04462000 ├────────────────────────┤
           │  DLL table (512B)      │  16 DLL slots x 32 bytes
0x04262000 ├────────────────────────┤
           │  PE staging (2MB)      │  Temp buffer for PE/DLL loading
0x04252000 ├────────────────────────┤
           │  Cache index (64KB)    │  4096 decoded-block lookup slots
0x03E52000 ├────────────────────────┤
           │  Thread cache (4MB)    │  Decoded x86 -> threaded code pairs
0x03E12000 ├────────────────────────┤
           │  Thunk zone (256KB)    │  API import trampolines (8 bytes each)
0x03D12000 ├────────────────────────┤
           │  Heap (1MB)            │  HeapAlloc / malloc bump allocator
0x03C12000 ├────────────────────────┤
           │  Stack (1MB, grows ↓)  │  Single guest ESP
           ├────────────────────────┤
           │                        │
           │  Guest address space   │  PE .text/.data/.rsrc/.rdata + DLLs
           │  (60MB)                │  g2w(addr) = addr - ImageBase + 0x12000
           │                        │
0x00012000 ├────────────────────────┤  <- GUEST_BASE
           │  TEXT_SCRATCH (1KB)    │  Unicode conversion buffer
0x00011B00 ├────────────────────────┤
           │  HIT_COUNT_BASE        │  Block execution frequency counters
0x00011F00 ├────────────────────────┤
           │  SYNC_TABLE            │  Critical section / event objects
0x0000F000 ├────────────────────────┤
           │  SCROLL_TABLE (6KB)    │  256 x 24-byte scroll state
           │  FLASH_TABLE (256B)    │  Per-window flash state
0x0000D170 ├────────────────────────┤
           │  WAVE_OUT_STATE (16B)  │  Cross-thread waveOut callback info
0x0000D160 ├────────────────────────┤
           │  WND_DLG_RECORDS (8KB) │  256 x 32-byte dialog header state
0x0000B160 ├────────────────────────┤
           │  PAINT_QUEUE, PROPS    │  Paint queue, window property table
0x0000B000 ├────────────────────────┤
           │  MENU_DATA_TABLE (1KB) │  256 x 4-byte heap ptrs to menu blobs
0x0000AD60 ├────────────────────────┤
           │  PAINT_SCRATCH (16B)   │  One RECT for control WM_PAINT
0x0000AD40 ├────────────────────────┤
           │  TIMER_TABLE (320B)    │  16 x 20-byte timer entries
0x0000AC00 ├────────────────────────┤
           │  CLASS_RECORDS (3KB)   │  64 x 48-byte window class entries
0x0000A000 ├────────────────────────┤
           │  CONTROL_GEOM (2KB)    │  256 x 8-byte control geometry
0x00009800 ├────────────────────────┤
           │  CONTROL_TABLE (4KB)   │  256 x 16-byte control entries
0x00008800 ├────────────────────────┤
           │  WND_RECORDS (6KB)     │  256 x 24-byte window records
0x00007000 ├────────────────────────┤
           │  API hash table (12KB) │  FNV-1a name -> ID dispatch
0x00004000 ├────────────────────────┤
           │  Post queue (1KB)      │  64-slot ring of {hwnd,msg,wP,lP}
0x00000400 ├────────────────────────┤
           │  String constants      │  win.ini path, exe name buffer
0x00000100 ├────────────────────────┤
           │  NULL_SENTINEL (4B)    │  Sink for bad guest pointer access
0x000000F0 ├────────────────────────┤
           │  Reserved              │
0x00000000 └────────────────────────┘
```

## Real Windows 98 Memory Map (4 GB virtual)

```
0xFFFFFFFF ┌────────────────────────┐
           │  Kernel / VxD space    │  Ring-0 only, hardware enforced
           │  Page tables, VMM      │  (but Win9x famously had holes)
0xC0000000 ├────────────────────────┤
           │  Shared system DLLs    │  kernel32, user32, gdi32
           │  Memory-mapped files   │  Shared across all processes
0x80000000 ├────────────────────────┤
           │  Per-process user      │  App DLLs, memory maps,
           │  mappings              │  thread stacks, heaps
0x00400000 ├────────────────────────┤  <- typical PE ImageBase
           │  64KB null guard page  │  Unmapped, catches NULL derefs
0x00010000 ├────────────────────────┤
           │  DOS/BIOS legacy area  │
0x00000000 └────────────────────────┘
```

## Address Translation

All guest (x86) memory access goes through `g2w`:

```
g2w(guest_addr) = guest_addr - image_base + GUEST_BASE
                = guest_addr - 0x400000   + 0x12000
```

With bounds checking: rejects results < 0 or >= 0x8000000 (128 MB), returning a `NULL_SENTINEL` sink address instead.

This means the guest's reachable WASM range is:

| Guest address | WASM address | What's there |
|---|---|---|
| 0x3EE000 | 0x000000 | Bottom of WASM memory |
| 0x3F2000 | 0x004000 | API hash table |
| 0x3F5000 | 0x007000 | WND_RECORDS |
| 0x400000 | 0x012000 | PE ImageBase (normal territory) |
| ~0x2000000 | 0x1C12000 | Top of guest space / stack |
| 0x83DE000 | 0x7FF0000 | DX_OBJECTS (rejected: >= 128MB) |

## What's Private vs What's Not

### Win98: hardware-enforced rings

| Region | Access from user code |
|---|---|
| 0x00000000-0x0000FFFF | Unmapped -- access violation |
| 0x00010000-0x7FFFFFFF | User space -- full read/write/execute |
| 0x80000000-0xBFFFFFFF | Shared DLLs -- readable, mostly not writable |
| 0xC0000000-0xFFFFFFFF | Kernel -- GP fault from ring 3 (in theory; Win9x had known holes) |

### wine-assembly: no privilege rings

**Everything below GUEST_BASE (0x0 - 0x12000)** -- emulator tables, API hashes, window records, timer state. The guest *can* reach these by forming pointers below its ImageBase (guest 0x3EE000-0x3FFFFF). Not protected by hardware. Only "safe" because Win32 apps don't normally allocate in that range.

**Guest address space (0x12000 - 0x1C12000)** -- PE sections, stack, heap. Normal guest territory.

**Above guest space (0x1E12000+)** -- thunk zone, thread cache, block cache, PE staging. Guest can reach these too via g2w if it forms high enough addresses.

**DX_OBJECTS at 0x7FF0000** -- the one actually protected region. Guest address 0x83DE000 maps to WASM 0x8000000, which hits the g2w bounds check. But the guest *does* hold pointers to these objects -- they're handed back by COM QueryInterface/CreateSurface. The emulator hands out guest-translated pointers that the guest can read but that happen to be in the valid range (the objects straddle the boundary carefully).

### Comparison

| Concept | Win98 | wine-assembly |
|---|---|---|
| Kernel/user boundary | Ring 0/3 hardware enforcement | None -- convention only |
| NULL dereference | Unmapped page -> access violation | `NULL_SENTINEL` at 0xF0 returns zeros |
| Syscall gate | `INT 2E` / `SYSENTER` | Thunk zone EIP detection |
| Page protection (R/W/X) | Per-page via page tables | SMC detection in `$gs32` only (invalidates code cache) |
| Shared system DLLs | 0x80000000+ memory-mapped | DLLs loaded directly into guest space |
| Per-process isolation | Separate page tables per process | Single flat space, one "process" |
| Stack guard | Guard pages, auto-grow | Fixed 1MB, no guard |
| Heap | Demand-paged, growable | Fixed 1MB bump allocator |

## The Thunk Zone as Syscall Boundary

The thunk zone is the closest analogy to a kernel entry point. When the guest calls a Win32 API:

```
Guest:  CALL [IAT_entry]        ;  IAT points to thunk zone address
        |
        v
EIP lands in thunk zone (0x1E12000 - 0x1E52000 WASM)
        |
        v
Emulator detects: eip >= thunk_guest_base && eip < thunk_guest_end
        |
        v
$win32_dispatch(thunk_idx)      ;  reads api_id from thunk slot
        |
        v
br_table dispatch -> $handle_CreateWindowExA (or whichever)
        |
        v
WAT handler executes, adjusts ESP, sets EAX return value
        |
        v
Execution resumes at guest return address
```

This is analogous to how `INT 2E` (Win9x) or `SYSENTER` (NT) transitions from user mode to kernel mode. The difference: in Win98 the CPU changes privilege levels. Here the emulator just checks an address range.

## Why It Mostly Works

Win32 executables are well-behaved by convention:

1. They allocate via `HeapAlloc`/`VirtualAlloc` (mapped to our bump allocator), not by computing arbitrary addresses
2. They access DLL functions via IAT indirection (mapped to thunks), not by probing system memory
3. They don't write below their ImageBase
4. Stack access stays within the allocated stack region

A malicious program could easily corrupt emulator state (write to guest addr 0x3F2000 to trash the API hash table). But real Win98 shareware doesn't do that -- and Win98 itself was similarly vulnerable to misbehaving programs poking the upper 2 GB.
