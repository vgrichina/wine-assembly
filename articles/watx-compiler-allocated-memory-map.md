# Letting the compiler own the memory map: WATX, an extended WebAssembly Text

A program written directly in WebAssembly Text has no linker. Every table, arena and buffer in a 512 MB linear memory is a hand-chosen hex address, and a 200,000-line project accumulates more than a thousand of them. Wine-Assembly replaced that with WATX, a small superset of WAT compiled by a vendored compiler, in which regions are declared by size and the compiler places them. This article explains why the hand-placed map became untenable, what WATX adds, and how the migration was verified.

## The problem with hand-placed addresses

By mid-2026 the emulator's memory map held about 170 regions: the guest window, the DIB backing store, the threaded-code cache partitions, window records, GDI object tables, DirectX object tables, the API hash table, and dozens of smaller ones. Each was a literal base address in `src/01-header.wat`, repeated wherever code needed it, and mirrored into JavaScript for the host side.

Three things went wrong repeatedly:

- **Overlaps.** Growing one region silently ran into the next. A build gate checked for overlaps, but only among the regions it knew about.
- **Stale copies.** A base moved in WAT and a JavaScript file still held the old number, which meant the host read from memory the guest no longer used, with nothing to say so.
- **Fear.** Every layout change had to be reasoned about globally, so tables were oversized to avoid moving them, and the map filled its 512 MB with padding.

## What WATX adds

WATX keeps everything WAT has and adds a few forms the compiler expands:

- `(include "NN-name.wat")`: `src/main.watx` is the one list of source parts, in order. There is no second list to keep in sync.
- `region.declare`: a name and a *size*. The compiler places the region. Of the 174 regions today, 166 are declared this way, and their bases are not written down anywhere; `tools/region-layout.js` asks the compiler where they landed.
- `region.declare-fixed`: for the seven addresses that are an ABI rather than a placement (the guest base every `g2w` resolves through, the heap and stack windows the guest can see, the DIB and thread-RPC backing windows), pinned explicitly.
- `region.declare-derived`: a base expressed as an offset from another region, for the guest-visible addresses that must stay in a fixed relationship.
- Typed pointers ([watx-typed-pointers-design.md](/docs/watx-typed-pointers-design.md)): struct layouts declared once, field accesses by name, so that a record's offsets stop being magic numbers repeated at each use site. About 1,260 layout sites were converted.

The compiler, `tools/build-compile-wat.js`, is the project's own WAT-to-wasm compiler with these extensions, vendored with a sealed changelog and SHA-256 provenance check so a build cannot pick up an unreviewed compiler change. `wat2wasm` is not used at all.

## How the migration was verified

Moving the map is exactly the kind of change that can look fine and be wrong, so the verification was designed before the cutover. The record is in [watx-migration-plan.md](/docs/watx-migration-plan.md) and the design in [watx-region-safety-design.md](/docs/watx-region-safety-design.md):

- **An encoder oracle.** The new compiler's output was compared instruction by instruction against the previous pipeline on the same source. It found six real miscompiles before any of them reached a run.
- **Shake modes.** The build can place regions in several deliberately different orders. Every registered app was run under each placement and its screenshots compared with `tools/png-diff.js`; a frame that changes with placement is a hidden absolute address. They are all pixel-identical.
- **Five region gates** around the memory-map check: region declarations match the globals the code reads, the JavaScript mirror (`lib/region-map.generated.js`) is fresh, no JavaScript file holds a copy of an allocated base, no bare address appears in a WAT fragment embedded in JavaScript, and a ratchet on raw address literals that only goes down.

The cutover happened on August 31, 2026, the busiest day in the project's history, and the legacy build path was deleted the same day rather than kept as a fallback. [watx-migration-gaps.md](/docs/watx-migration-gaps.md) lists what the migration deliberately left for later.

## Why it matters beyond this project

Writing a large program in WebAssembly Text is unusual, and most advice assumes a compiler in front of it. The WATX experience is an argument that the missing piece is small: an include mechanism, a region allocator, and a struct-layout declaration recover most of what a linker and a type system provide for memory layout, and the verification methods (an encoder oracle, placement shaking) are cheap enough to keep as permanent build gates. The [memory map documentation](/docs/memory-map.md) shows the result, including which regions are guest-visible and which are emulator-private.

## Further reading

- [How the x86 interpreter is built](/articles/x86-interpreter-in-webassembly-text.html), the code this map serves.
- [The story](/story.html), Act XVI, "The compiler owns the memory map".
