# Memory Map — wine-assembly vs Windows 98

## WASM Linear Memory Layout (512 MB)

The shared memory is fixed at 8192 WebAssembly pages. This diagram shows the
current major regions; the memory-map comment and sized globals in
`src/01-header.wat` are authoritative for the smaller WAT-private tables.

```
0x20000000 ┌────────────────────────┐  End of shared linear memory
           │  DIB pixel arena (64MB)│  Fixed CreateDIBSection backing
0x1C000000 ├────────────────────────┤
           │                        │
           │  VirtualAlloc backing │  320MB for sparse high guest maps
           │  pool (320MB)          │
           │                        │
0x08000000 ├────────────────────────┤  End of direct g2w window
           │  High private tables   │  API hashes, regions, COM/DX state
0x07E00000 ├────────────────────────┤
           │  File mapping zone     │  MapViewOfFile allocations
0x07392400 ├────────────────────────┤
           │  DLL metadata          │  DLL and resource tables
0x07392000 ├────────────────────────┤
           │  PE staging (2MB)      │  Temporary PE/DLL load buffer
0x07192000 ├────────────────────────┤
           │  Cache indexes (256KB) │  8 x 4096 decoded-block indexes
0x07152000 ├────────────────────────┤
           │  IAT thunk zone (256KB)│  API import trampolines
0x07112000 ├────────────────────────┤
           │  Main stack (1MB)      │  Guest ESP starts at 0x07112000
0x07012000 ├────────────────────────┤
           │  Thread cache (32MB)   │  8 x 4MB decoded-thread arenas
0x05000000 ├────────────────────────┤
           │  Heap (1MB initial)    │  Reusing HeapAlloc/malloc arena
0x03D12000 ├────────────────────────┤
           │  Guest address space   │  PE sections and large image data
           │  (60MB)                │
0x00012000 ├────────────────────────┤  GUEST_BASE
           │  WAT-owned state       │  Window, control, and helper tables
0x00001000 ├────────────────────────┤
           │  Decoder scratch       │  ModRM result area
0x000000F0 ├────────────────────────┤
           │  NULL_SENTINEL (4B)    │  Sink for invalid guest pointers
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

All guest (x86) memory access goes through `g2w`. It tries three translation
classes in order:

```
1. direct: guest_addr - image_base + GUEST_BASE, when result < 0x08000000
2. DIB:    0x50000000..0x53FFFFFF -> 0x1C000000..0x1FFFFFFF
3. sparse: scan VIRTUAL_MAP_TABLE for VirtualAlloc guest reservations
```

An address that matches none of these returns the `NULL_SENTINEL` sink. The
128 MB limit applies only to the hot direct image-relative translation, not to
the total 512 MB memory or to the DIB/sparse mappings.

Important translation classes are:

| Guest address | WASM address | Purpose |
|---|---|---|
| `image_base` | `0x00012000` | PE image start |
| image-relative direct window | `< 0x08000000` | PE, heap, stack, DLLs, and thunks |
| `0x50000000..0x53FFFFFF` | `0x1C000000..0x1FFFFFFF` | DIB section pixels |
| sparse reservation | `0x08000000..0x1BFFFFFF` allocation | VirtualAlloc backing |
| invalid/uncommitted | `0x000000F0` | zeroed read/write sink |

## What's Private vs What's Not

### Win98: hardware-enforced rings

| Region | Access from user code |
|---|---|
| 0x00000000-0x0000FFFF | Unmapped -- access violation |
| 0x00010000-0x7FFFFFFF | User space -- full read/write/execute |
| 0x80000000-0xBFFFFFFF | Shared DLLs -- readable, mostly not writable |
| 0xC0000000-0xFFFFFFFF | Kernel -- GP fault from ring 3 (in theory; Win9x had known holes) |

### wine-assembly: no privilege rings

**Everything below GUEST_BASE (0x0 - 0x12000)** -- emulator window, control,
timer, and helper state. The guest *can* reach these by forming pointers below
its ImageBase. This is not protected by hardware and is only safe by convention.

**Guest address space (0x12000 - 0x3C12000)** -- PE sections and large data.
The main stack, heap, thunks, DLLs, and decoded-thread regions occupy the
additional direct-window ranges shown above.

**Above guest space** -- thread cache, main stack, thunk zone, block indexes,
PE staging, DLL metadata, and WAT-private tables. Some are reachable through
image-relative pointers; this emulator does not implement hardware privilege
separation.

**High WAT-private tables near 0x07E00000** -- close to the edge of the direct
window. Guest APIs receive translated wrapper pointers where necessary; these
tables are emulator state rather than general guest allocations.

The software-GDI migration reserves `0x07E1C000..0x07EEBFFF` for 256 region
slots of 208 canonical band rectangles each, followed by four 3.25KB work
buffers at `0x07EEC000..0x07EEF3FF`. The preceding
`0x07E10000..0x07E1BFFF` range stores the DIB arena allocation bitmap and run
lengths. It tracks ownership/reuse only, never write dirtiness. Sized WAT
globals and `test/test-wat-memory-map.js` enforce that these regions do not
overlap other emulator tables.

Explicit HDC clip ownership uses `0x07EF0000..0x07EF07FF`, a 256-entry table
mapping synthetic HDC values to private canonical HRGNs.

Per-HDC raster state uses `0x07EF0800..0x07EF0FFF` for 256 `{HDC, ROP2}`
entries. A fixed 80-byte line-descriptor scratch record begins at `0x07EF1000`.
Two adjacent 80-byte blit descriptors occupy `0x07EF1100..0x07EF119F` for
destination/source surface resolution without per-pixel host calls.
Extended per-DC state occupies `0x07EFC800..0x07EFE7FF` as 256 32-byte
records for arc direction, brush origin, mapper flags, and text spacing.

The Win16/Win9x bitmap-font backend uses `0x07F0A420..0x07F0A46F` for its
file-I/O counter and 80-byte surface descriptor. Its default-font VFS path,
shared install state, and Win9x UI face aliases occupy
`0x07F0A490..0x07F0A527`, followed by
`0x07F0A800..0x07F0ABFF` for sixteen 64-byte installed-strike records. The
validated FNT byte payloads themselves are owned allocations in the DIB arena;
the static table stores their WAT backing addresses and parsed metrics.

### Comparison

| Concept | Win98 | wine-assembly |
|---|---|---|
| Kernel/user boundary | Ring 0/3 hardware enforcement | None -- convention only |
| NULL dereference | Unmapped page -> access violation | `NULL_SENTINEL` at 0xF0 returns zeros |
| Syscall gate | `INT 2E` / `SYSENTER` | Thunk zone EIP detection |
| Page protection (R/W/X) | Per-page via page tables | SMC detection in `$gs32` only (invalidates code cache) |
| Shared system DLLs | 0x80000000+ memory-mapped | DLLs loaded directly into guest space |
| Per-process isolation | Separate page tables per process | Single flat space, one "process" |
| Stack guard | Guard pages, auto-grow | Fixed 1MB main stack, no guard |
| Heap | Demand-paged, growable | Reusing direct-arena allocator plus sparse VirtualAlloc mappings |

## The Thunk Zone as Syscall Boundary

The thunk zone is the closest analogy to a kernel entry point. When the guest calls a Win32 API:

```
Guest:  CALL [IAT_entry]        ;  IAT points to thunk zone address
        |
        v
EIP lands in thunk zone (0x07112000 - 0x07152000 WASM)
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

A malicious program could deliberately form translated pointers to reachable
emulator state and corrupt it. Normal Win98 applications do not do that, and
Win98 itself relied heavily on similar process conventions.
