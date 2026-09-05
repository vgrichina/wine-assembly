# A virtual LAN for Windows 98 multiplayer games in the browser

Two copies of a 1990s Windows game can play each other inside Wine-Assembly: Winsock is implemented in WebAssembly Text over a virtual LAN segment, and that segment can span browser tabs in one page or emulator processes on different machines. This article covers what the virtual LAN is, how frames move, and what Hearts and Liquid War needed from it.

## What "virtual LAN" means here

The emulator does not expose real sockets to the guest, and a browser could not offer them anyway. Instead `src/09d-winsock.wat` implements the Winsock 1.1 surface a game uses (`socket`, `bind`, `connect`, `listen`, `accept`, `send`, `recv`, `select`, `WSAAsyncSelect`, host and address helpers) over a WAT-owned socket table, and everything below the socket layer is a small Ethernet-like segment with its own addressing: each emulator instance gets an address in a `10.77.0.0/24` room, and a frame is opaque bytes plus source and destination.

The routing all lives in WAT. The JavaScript side, `lib/vlan-wire.js`, is a transport that carries opaque frames and knows nothing about ports or connections. There are two transports:

- **LoopbackSegment**: every emulator instance in one page shares a segment, so two desktop windows running the same game can find each other with no network at all.
- **The `vln/1` wire**: the headless CLI can run two emulator processes and join them across child IPC with `--vlan-wire`, each given its own `--vlan-ip`. `--trace-net` prints every frame decoded (`-> SYN 10.77.0.2:49152 -> 10.77.0.1:8035`), which is the tool for "who is not answering".

Keeping the transport opaque was deliberate: a routing decision in JavaScript would be a second implementation of Winsock state, and the project's rule is that guest-visible state lives in WAT once.

## Hearts: the DDE game

Microsoft Hearts from Windows 98 is a network game built on DDEML, the Dynamic Data Exchange library, which in a real Windows 98 is carried between machines by NetDDE over NetBIOS. Getting two Hearts instances to a dealt hand meant implementing enough DDEML for a conversation, then carrying it across the virtual LAN.

The bug that stalled it for a while is a good example of the class of mistakes that WAT makes easy: an advise message with an even-length payload arrived empty. The cause was a raw byte count combined with a boolean by `i32.and`, which in wasm is a bitwise operation, so an even count's clear low bit made the condition false. The project's rule since is that every operand of a logical `i32.and` is normalised to 0 or 1, and a build gate scans for the pattern. With that fixed, two Hearts processes deal and play over the wire, and the dead lobby buttons in the browser version were traced to the same segment bookkeeping.

## Liquid War: the Winsock game

Liquid War is a 1990s multiplayer game with a proper TCP protocol, which made it the test for connection semantics rather than message passing: `listen`/`accept` on one side, `connect` on the other, non-blocking `select` loops on both. Cross-process connect works in the headless twin, and the browser wiring follows the same path. The frame-level trace was what made it debuggable: a `SYN` that never gets a reply names the process that did not call `accept`.

## What it does not do

The segment is a LAN, not the Internet. There is no DNS beyond a hosts table, no routing between rooms, and no bridge to a real network, which is both a simplicity choice and a safety one: a browser page that could open TCP connections on a visitor's behalf would be a problem. Sharing a segment between two browsers on different machines would need a relay that the project has designed but not built.

## Further reading

- [virtual-lan-party.md](/docs/virtual-lan-party.md): the design note, including the frame format and room addressing.
- [Running 16-bit programs](/articles/running-16-bit-windows-apps-in-webassembly.html) for the Win16 DDEML that Hearts sits on.
- [The story](/story.html), Act XIII, for the week the wire landed.
