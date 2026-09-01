# Reverse-engineering notes

One file per guest binary we have dug into, holding the facts that are expensive
to re-derive and cheap to write down: module load bases, container/asset layout,
which Win32 or COM paths the app actually uses, the function addresses we have
already disassembled, and the hypotheses that have been *ruled out*.

These notes exist because the same disassembly keeps getting redone. Before
starting an investigation on an app that has a file here, read it. When you
finish one, add what you learned.

## What belongs here

- **Load bases and address arithmetic.** Runtime VA ↔ original VA per module.
- **Asset/container layout** — archive formats, offsets, how the app reads them.
- **Traced API profile** — which APIs the app calls and how often, especially
  when the answer is surprising (Diablo never calls `Blt` or `Flip`).
- **Named addresses.** Every function entry we have identified, with what it does.
- **Reproduction commands** that reach a given screen headlessly.
- **Dead ends, explicitly.** A hypothesis someone spent an hour disproving is
  worth as much as a positive finding, and it only stays worth that if it is
  written down. Mark withdrawn conclusions rather than deleting them, so nobody
  re-derives them from an old transcript.

## What does not belong here

- Emulator-side design (that is `docs/*.md` proper) or the memory map of our own
  linear memory (`docs/memory-map.md`).
- Anything a tool prints on demand. Record the *command*, not a stale dump.

## Ground rules

- **Say how each number was obtained.** A VA with no provenance is a rumor.
  Prefer a one-line command the reader can re-run.
- **Runtime bases shift.** They depend on load order and on every preceding
  module's `sizeOfImage`, so they change when the app's DLL set changes. Use the
  `module+0xORIG_VA` syntax in `--trace-at` / `--count` / `--break` instead of
  hand-computing a delta, and treat any base written here as a fact to re-check
  rather than one to trust.
- Disassembly addresses in these files are **original VAs** (what
  `tools/disasm_fn.js` prints for the file on disk) unless a line says otherwise.

## Index

| App | File |
|---|---|
| Abe's Oddysee demo | [abes-oddysee-demo.md](abes-oddysee-demo.md) |
| DX-Ball | [dxball.md](dxball.md) |
| Diablo II Shareware demo | [diablo2-demo.md](diablo2-demo.md) |
| Diablo Shareware | [diablo-shareware.md](diablo-shareware.md) |
| Diablo retail CD | [diablo-retail.md](diablo-retail.md) |
| Grand Theft Auto 2 Wild Demo | [gta2-demo.md](gta2-demo.md) |
| Half-Life: Uplink | [half-life-uplink.md](half-life-uplink.md) |
| Heroes of Might and Magic III (demo) | [heroes3-demo.md](heroes3-demo.md) |
| Heroes of Might and Magic II (demo) | [heroes2-demo.md](heroes2-demo.md) |
| Liquid War 5.6.2 | [liquid-war.md](liquid-war.md) |
| The Elder Scrolls: Arena (GOG) | [elder-scrolls-arena-gog.md](elder-scrolls-arena-gog.md) |
| Ultima IV: Quest of the Avatar (GOG) | [ultima4-gog.md](ultima4-gog.md) |
| Quake II (demo) | [quake2-demo.md](quake2-demo.md) |
| Rodent's Revenge (Win16) | [wep16-rodent.md](wep16-rodent.md) |
