# Running 16-bit Windows 3.x programs in the browser: an NE loader in WebAssembly

Windows 98 still ran 16-bit programs, and a lot of the shareware, entertainment packs and utilities of the era are NE (New Executable) files that use segmented addressing and call `KERNEL`, `USER` and `GDI` by ordinal through the Pascal calling convention. Wine-Assembly runs them on the same interpreter as its 32-bit programs by adding a second loader, a set of segmented-memory instruction handlers and a Win16 API dispatcher. This article explains the three pieces and what it took to get the 16-bit Entertainment Pack running.

## Why NE is a different machine

A 32-bit PE program lives in a flat address space and imports functions by name from DLLs. A 16-bit NE program is a table of *segments*, each up to 64 KB, referenced through selectors; a far pointer is a `segment:offset` pair, code calls across segments with `CALL FAR`, and the executable's imports are `(module, ordinal)` pairs fixed up per segment by a relocation list. Nothing in the 32-bit path can be reused as-is: there is no image base, the instruction encodings default to 16-bit operands and addresses, and the API convention pushes arguments left-to-right and has the *callee* pop them.

## The three pieces

**The NE loader** (`src/08c-ne-loader.wat`) reads the segment table and loads each segment into a 64 KB-strided arena, so a segment's selector maps to a base address by simple arithmetic. It walks each segment's relocation records and resolves them: internal references to other segments, and ordinal imports, which it points at a generated *thunk segment* whose entries the dispatcher recognises. `tools/ne-dump.js` prints all of this from a file (segments, module references, entry table, fixups resolved to `USER.#113` form) and is the starting point for any 16-bit investigation, since every other PE tool in the repository assumes a 32-bit image.

**Segmented execution** (`src/05c-seg16-ops.wat`) adds the instruction handlers the decoder emits when the CPU is in 16-bit code: segment-base arithmetic for `ES`, `CS`, `SS`, `DS` and `FS` overrides, far calls and returns, `LDS`/`LES`, and the 16-bit stack frame. The decoder already handled 16-bit operand sizes for 32-bit programs (the `0x66` prefix), so the work was in addressing, not in the ALU.

**Win16 dispatch** (`src/09e-win16-api.wat`) is the Pascal-convention twin of `$win32_dispatch`: it identifies the API by module and ordinal, reads arguments in the reversed order, and cleans the stack itself. Many handlers forward to the 32-bit implementation after widening the arguments, since `CreateWindow` is `CreateWindow` under either convention. Dialogs are the exception: 16-bit `RT_DIALOG` templates are a different format, so `src/09e2-win16-dialog.wat` rewrites each template into the 32-bit form and runs the same modal pump the 32-bit path uses. Win16 DDEML (`src/09f-win16-ddeml.wat`) interns string and data handles and answers service registration truthfully, which is what the networked Hearts client turned out to need.

## What runs

The 16-bit corpus is the Windows Entertainment Packs 1 to 4 and a set of shareware from [win16-app-sources.md](/docs/win16-app-sources.md). At the last sweep all 31 entries launched, and the majority drew their game screens; the ones that do not are catalogued with causes rather than left as a number. Microsoft Hearts is the case that pushed furthest, because its network mode drove the DDEML implementation and then the [virtual LAN](/articles/virtual-lan-multiplayer-in-the-browser.html).

A measurement trap worth knowing: a healthy 16-bit program reports **zero** API calls to the host-import census, because Win16 dispatch never leaves WAT. A 16-bit run showing a hundred host calls under load is the slow case, not the busy one. The [win16-v86-audit.md](/docs/win16-v86-audit.md) note lists the remaining differences between the emulator's flat model and what a V86-mode Windows 98 would have provided.

## Further reading

- [Loading real Windows DLLs](/articles/loading-real-windows-dlls-in-the-browser.html) for the 32-bit loader this one sits beside.
- [The story](/story.html), Act XIII, for the week the NE loader landed, and Act XV for the playability sweep.
