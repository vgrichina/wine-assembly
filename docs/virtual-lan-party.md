# Virtual LAN party design

## Status

This document specifies a virtual LAN for unmodified Win32 games running in
Wine-Assembly. Liquid War 5.6.2 is the first target. The client already reaches
its 640x480 DirectDraw menu with its original assets; networking is not yet
implemented.

The product promise is:

> One friend creates a room and runs the original game server. Everyone else
> follows an invite and the unmodified game sees an ordinary private LAN.

There is no authoritative Internet game service. For Liquid War,
`lwwinsrv.exe` remains the authoritative server and runs inside the host's
browser. Authenticated Berrry public-data records introduce browsers, and an
encrypted relay may carry opaque bytes when a direct path is impossible.
Neither Berrry nor the relay understands or simulates Liquid War.

## TL;DR

```text
                           VIRTUAL LAN PARTY

  ┌────────────── Alice / room host ──────────────┐
  │                                                │
  │  lwwin.exe ─┐                                  │
  │              ├─ virtual switch ─ lwwinsrv.exe │
  │  10.77.0.1 ─┘                    TCP :8035    │
  └──────────────────────┬─────────────────────────┘
                         │
               encrypted peer connections
                WebRTC direct when possible
                  TURN relay when required
                         │
              ┌──────────┴───────────┐
              │                      │
  ┌───────────┴──────────┐  ┌────────┴─────────────┐
  │ Bob                  │  │ Carol                │
  │ lwwin.exe            │  │ lwwin.exe            │
  │ virtual IP 10.77.0.2 │  │ virtual IP 10.77.0.3 │
  └──────────────────────┘  └──────────────────────┘

  All clients connect to 10.77.0.1:8035.
  The game believes this is a physical LAN.
```

Wine-Assembly intercepts guest Winsock calls at the existing Win32 API
boundary. A room-scoped socket switch implements familiar TCP semantics and
multiplexes the byte streams over browser peer connections. The browser never
needs a raw TCP socket, TAP device, privileged extension, or port-forwarding
rule.

## Goals and non-goals

### Goals

- Run the original, unmodified `lwwin.exe` and `lwwinsrv.exe` binaries.
- Make one host browser and up to five friends behave like one private LAN.
- Work through ordinary home NAT without asking players to forward ports.
- Prefer direct encrypted browser-to-browser paths and fall back gracefully to
  a relay.
- Preserve the Winsock behavior the game can observe: handles, byte order,
  partial reads and writes, blocking/nonblocking behavior, `select`, shutdown,
  close, and useful WSA errors.
- Isolate rooms from one another and from every player's real LAN.
- Keep the first implementation narrow enough to test end to end.
- Leave a clean path to UDP, broadcast discovery, DirectPlay, and other corpus
  games.

### Non-goals for version 1

- A general-purpose VPN, Ethernet device, or full TCP/IP stack.
- Exposing a guest port to the public Internet.
- Replacing the historical game server with a cloud implementation.
- Seamless host migration or restoration of a match after a transport loss.
- Cheat prevention. The original game protocol and host authority remain
  unchanged.
- Public matchmaking, persistent accounts, voice chat, spectators, or saved
  replays.
- UDP, multicast, broadcast, IPv6, raw sockets, or arbitrary Internet access.

## Player experience

### Host

```text
Choose Liquid War
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Create LAN party                                            │
│                                                              │
│ Room name        MOLTEN-MOON                                 │
│ Teams            6                                          │
│ Room type        (●) Private link   ( ) Public listing      │
│ Public joining   (●) Open           ( ) Approval required   │
│                                                              │
│                    [ Create room ]                           │
└──────────────────────────────────────────────────────────────┘
       │
       ├─ starts lwwinsrv.exe -private -6 -nobeep
       ├─ assigns this browser 10.77.0.1
       └─ copies an invite link
```

`-private` prevents registration with Liquid War's historical public
metaserver. Room membership replaces metaserver discovery. `-nobeep` avoids a
server-console notification sound; the room UI provides a better notification.
The `Public joining` control is enabled only when `Public listing` is selected.

### Friend

```text
PRIVATE                              PUBLIC

Open secret link                     Open public rooms
      │                                    │
Verify capability                    Choose room
      │                                    │
      │                         ┌───────────┴────────────┐
      │                         │ open                  │ approval required
      │                         ▼                       ▼
      │                    join immediately       request → host accepts
      │                         │                       │
      └─────────────────────────┴───────────────────────┘
                                │
                         receive 10.77.0.x
                                │
                         [ Launch game ]
```

The launcher should prefill the host address and port when a safe configuration
path is available. Until then, the game UI can use `10.77.0.1` and `8035`.

### Room types and admission

There are exactly two room types:

| Room type | Discovery | Initial admission |
|---|---|---|
| Private | Unlisted; opened through a secret link | Possession of the capability secret |
| Public | Listed for logged-in Berrry users | Immediate unless the host enables pre-approval |

All network play requires a Berrry login. Login supplies a stable moderation
identity; it does not replace the private-room capability. A private link holder
is admitted without a separate approval queue unless that Berrry user is banned
or the room is full. A public room has one `approvalRequired` switch: when off,
eligible users enter immediately; when on, they remain pending until the host
accepts them.

There is no third `locked public`, password, friends-list, or invite-only public
mode in version 1. A host who wants capability-gated access creates a private
room; a host who wants discoverability creates a public room.

### Moderation

The host is the sole moderator in version 1. Both private and public rooms
support:

- kick, which closes the member's peer link and all virtual sockets;
- room-lifetime ban by Berrry user ID, which also rejects later joins;
- capacity enforcement before assigning a virtual IP;
- closing the room for everyone; and
- rotating a leaked private capability, invalidating unused old links.

Public rooms additionally support accepting or rejecting pending join requests
when pre-approval is enabled. Changing the switch affects future requests; it
does not silently admit or remove existing pending users.

```text
PRIVATE              PUBLIC / OPEN            PUBLIC / APPROVAL

valid secret         logged in                logged in
     │                    │                        │
     ▼                    ▼                        ▼
 ADMITTED              ADMITTED                  PENDING
     │                    │                    ┌────┴─────┐
     ▼                    ▼                 Accept     Reject
 CONNECTED             CONNECTED                │          │
                                               ▼          ▼
                                            ADMITTED   REJECTED
                                               │
                                               ▼
                                            CONNECTED

Any ADMITTED or CONNECTED member ── kick/ban ──▶ REMOVED
```

Only `ADMITTED` members receive a virtual IP or WebRTC offer. Kick or ban moves
an admitted/connected member to `REMOVED`, revokes its route, closes its peer
link, and advances the membership epoch so stale signaling cannot reopen it.

### Room screen

```text
┌─ MOLTEN-MOON ────────────────────────────────────────────────┐
│ Liquid War 5.6.2                              [Copy invite] │
│                                                              │
│  ● You (host)   10.77.0.1   local        0 ms   SERVER ✓   │
│  ● Maya         10.77.0.2   direct      28 ms   [Kick] ✓   │
│  ● Leo          10.77.0.3   relayed     61 ms   [Kick] ✓   │
│  ◌ Sam          approval pending          [Accept] [Reject] │
│                                                              │
│  Game server       10.77.0.1:8035                            │
│  Players ready     3 / 6                                    │
│  Transport         healthy                                  │
│                                                              │
│  [ Launch game ]                         [ Leave room ]       │
└──────────────────────────────────────────────────────────────┘
```

Terms such as ICE, SDP, STUN, TURN, and NAT stay out of the default UI. A
failed direct route should read `Relayed — playable, +33 ms`, not present a
port-forwarding tutorial. An advanced disclosure may show assigned IPs,
transport type, round-trip time, loss, buffered bytes, and a redacted event
log.

## System architecture

```text
                         CONTROL PLANE

           Berrry login + public JSON signaling records
                              │
                  ┌───────────▼───────────┐
                  │ Berrry public-data API│
                  │                       │
                  │ public room directory │
                  │ join requests         │
                  │ encrypted SDP/ICE     │
                  └───────────┬───────────┘
                              │
                    STUN + TURN service
                              │
   ───────────────────────────┼──────────────────────────────
                              │
                           DATA PLANE

                 WebRTC DataChannel / vln/1
            direct peer path or encrypted TURN path
                              │
                    ┌─────────▼─────────┐
                    │ Virtual LAN room │
                    │ encrypted frames │
                    │ stream mux       │
                    │ flow control     │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │ Virtual socket   │
                    │ switch           │
                    │ 10.77.0.0/24     │
                    └─────────┬─────────┘
                              │
                  narrow host imports / yield
                              │
                    ┌─────────▼─────────┐
                    │ Winsock handlers │
                    │ socket/connect/  │
                    │ send/recv/select │
                    └─────────┬─────────┘
                              │
               unmodified x86 guest processes
```

The two planes have deliberately different trust and lifetime rules:

| Plane | Contains | Must not contain |
|---|---|---|
| Control | Room ID, Berrry user IDs, public keys, encrypted SDP/ICE envelopes, presence | Game packets, guest memory, room secret, game authority |
| Data | DTLS-protected virtual-socket frames and health probes | Account tokens, arbitrary host-network access |

### Topology

Version 1 uses a star centered on the room host. Each friend has one peer
connection to the host. This matches Liquid War's own client/server topology,
requires only `N - 1` browser connections, and avoids a full-mesh negotiation
storm.

```text
                   Bob / 10.77.0.2
                         │
                         │ one WebRTC peer connection
                         │
  Carol / 10.77.0.3 ── HOST SWITCH ── Dev / 10.77.0.4
                         │
                         │ local in-memory route
                         │
                   lwwinsrv.exe :8035
```

The virtual switch may forward peer-to-peer traffic through the host in a
future generic-LAN mode. A later optimization can establish direct friend to
friend links, but Liquid War does not need them.

### Browser processes

The host browser must run two independent guest process contexts:

```text
Browser tab
  ├─ EmulatorInstance A: lwwinsrv.exe
  ├─ EmulatorInstance B: lwwin.exe
  ├─ Process scheduler
  └─ one shared VirtualLanRoom / VirtualSocketSwitch
```

Each emulator retains its own CPU, memory, handles, threads, WSA startup count,
and last-error state. The socket switch is shared explicitly; guest memory is
not. The host client reaches the server through the same socket semantics but
uses an in-memory transport rather than serializing through WebRTC.

## Address and routing model

Each room owns an isolated virtual `/24`:

```text
10.77.0.0       reserved network identity
10.77.0.1       room host and game server
10.77.0.2-.254  members, allocated for the room lifetime
10.77.0.255     future broadcast address; rejected in version 1
```

These addresses exist only inside the room. They are never bound to a host
interface or routed to the real LAN. A destination is accepted only when all
of the following are true:

1. the address belongs to the current room;
2. the destination peer is an admitted room member;
3. the socket family and operation are enabled by room policy; and
4. a matching virtual listener exists.

Version 1 supports `AF_INET`, `SOCK_STREAM`, and protocol `0` or `IPPROTO_TCP`.
It rejects external IPs with `WSAENETUNREACH`, unsupported socket types with
`WSAESOCKTNOSUPPORT`, and broadcast with `WSAEACCES` or
`WSAEADDRNOTAVAIL`. This is an isolation boundary, not merely a missing feature.

The first game endpoint is fixed by convention:

```text
liquidwar-host.vlan  -> 10.77.0.1   (optional future room DNS)
Liquid War server   -> 10.77.0.1:8035/TCP
```

Ephemeral client ports are allocated from a room-local range such as
`49152..65535`, with collision checks against live and recently closed socket
tuples.

## Winsock compatibility boundary

Browsers cannot expose a raw TCP listener to an emulated Win32 process. The
correct seam is the existing WSOCK32 dispatch boundary in
`src/09a-handlers.wat`. Today, most network calls are explicit failure stubs;
`WSAStartup` and byte-order helpers provide only compatibility behavior.

The Liquid War client and server import WSOCK32 functions by ordinal. The first
slice must resolve and implement the paths they require, including ordinals
that are not yet in the API table:

| Winsock operation | Required behavior |
|---|---|
| `WSAStartup`, `WSACleanup` | Per-process negotiated version and refcount |
| `WSAGetLastError`, `WSASetLastError` | Per-thread error state |
| `socket`, `closesocket`, `shutdown` | Handle lifecycle and half-close |
| `bind`, `listen`, `accept` | Server listener and bounded backlog |
| `connect` | Local or remote stream open with blocking/nonblocking completion |
| `send`, `recv` | Partial byte-stream I/O, EOF, flags, and error semantics |
| `select`, `__WSAFDIsSet` | Read/write/exception readiness and timeouts |
| `ioctlsocket` | At minimum `FIONBIO`; reject unsupported commands accurately |
| `setsockopt` | Accept or emulate only options observed in Liquid War |
| `inet_addr`, `inet_ntoa` | IPv4 conversion using guest byte order |
| `htons`, `ntohs` | Correct 16-bit conversion |
| `gethostbyname` | Room names and numeric addresses only in version 1 |

Do not silently return success for unsupported operations. Return the
documented result and set a meaningful WSA error. The existing fail-fast policy
still applies to genuinely unknown API paths.

### Socket records

Socket handles belong to the guest process, while the broker owns transport
state. A broker record needs at least:

```text
VirtualSocket
  handle             positive process-local SOCKET
  ownerProcessId     emulator process identity
  family/type/proto  AF_INET / SOCK_STREAM / TCP
  mode               blocking | nonblocking
  state              created | bound | listening | connecting |
                     connected | closing | closed | reset
  local              virtual IP + port
  remote             virtual IP + port
  streamId           peer-link multiplexing ID
  acceptQueue        pending connected children, listener only
  receiveQueue       ordered byte chunks
  receiveBytes       bounded byte count
  sendCredit         remote-advertised capacity
  readClosed         FIN received
  writeClosed        FIN sent
  lastActivity       monotonic timestamp
  waiters             blocked call continuations/select registrations
```

Handles must not collide with file, thread, GDI, or other emulator handle
families. Closing a process closes its sockets, cancels its waiters, and emits
`RST` for connections that were not closed gracefully.

### Blocking calls and the emulator scheduler

A JavaScript callback cannot synchronously wait for WebRTC. Blocking Winsock
must therefore be cooperative:

```text
guest connect/recv/accept/select
               │
               ▼
      operation ready now? ─── yes ──▶ complete API call
               │ no
               ▼
 save pending operation + guest continuation
 set a network-wait yield reason
 return control to the browser scheduler
               │
     frame / local event / timeout arrives
               │
               ▼
 mark process runnable and resume at continuation
```

The scheduler must never busy-spin a blocked process. It may continue running
the server process, another client process, rendering, audio, and browser
events. A process wakeup is level-triggered: if bytes or an accepted connection
remain queued, readiness remains true until consumed.

Nonblocking calls complete immediately or return `SOCKET_ERROR` with
`WSAEWOULDBLOCK`. A nonblocking `connect` reports progress through writable or
exception readiness in `select`. Timeout completion must follow the guest's
requested `timeval`, including a zero-time poll.

### `fd_set` and `select`

WinSock 1.x `fd_set` is a count followed by a bounded array of `SOCKET`
handles. The handler should:

1. copy and validate each input set from guest memory;
2. register interest without retaining guest pointers across a yield;
3. wake when any requested condition becomes true or the timeout expires;
4. rewrite each guest set to contain only ready handles; and
5. return the WinSock-compatible ready-handle count across the output sets.

Read readiness includes queued bytes, an orderly EOF, a reset/error, and a
listener with a nonempty accept queue. Write readiness includes a connected
stream with send credit and successful completion of a pending connect.
Exception readiness includes a failed pending connect and asynchronous socket
errors.

## Local socket lifecycle

The first implementation milestone stays entirely within one browser. It is a
real client/server path, not a special `connect()` success stub.

```text
lwwinsrv.exe                              lwwin.exe
     │                                        │
 socket()                                socket()
 bind(10.77.0.1:8035)                        │
 listen(backlog)                             │
 select(read listener)                       │
     │                              connect(10.77.0.1:8035)
     │                                        │
     ├── create connected socket pair ────────┤
     ├── enqueue server half                  │
     └── wake listener and connector          │
 accept()                                     │
     │                                        │
 recv() ◀════════ ordered byte stream ═════▶ send()
 send() ═══════════════════════════════════▶ recv()
```

The local route must deliberately fragment writes in tests. A one-call
`send`/one-call `recv` correspondence would hide bugs because TCP exposes a byte
stream, not message boundaries.

### Browser wiring

`index.html` already runs several apps at once, each its own `WineAssembly`
with its own `WebAssembly.Memory`, sharing one renderer — which is exactly the
two-processes-one-room shape. The server and the client are two entries in the
app table, joined by a `LoopbackSegment`, with no IPC and no service involved.
What the browser path still needs, all small:

- `lib/vlan-wire.js` ends with a bare `module.exports` and has no browser
  global shim like its neighbours, and no `<script>` tag in `index.html`;
- the host context built in `host.js` must carry `vlanWire`;
- each launched instance needs its room address through `set_vlan_local_ip`,
  and each worker instance inherits it through `lib/thread-manager.js`;
- the run loop in `host.js` must handle yield 8 alongside 3, 4 and 5. Loopback
  delivery is synchronous, so no `setImmediate` hop is needed there — unlike
  the child-IPC path in `test/run.js`;
- two app-table entries under `binaries/candidates/liquid-war/LW5/`, the server
  carrying `args: '-private -2 -nobeep'`.

Two things that a zero-latency loopback hides and a real transport will not:
the run loop reschedules with `setTimeout(step, 0)`, which busy-polls a parked
socket instead of backing off, and `--vlan-max-waits` is a harness bound rather
than a timeout, so the browser needs a real deadline on a park that never
completes.

## Remote connection lifecycle

One reliable, ordered WebRTC DataChannel named `vln/1` is established per
friend-to-host peer link. Virtual TCP streams are multiplexed over it.

```text
Bob guest              Bob switch          Host switch       Server guest
   │                        │                    │                  │
connect(10.77.0.1:8035)     │                    │                  │
   ├───────────────────────▶│                    │                  │
   │                        ├── OPEN ───────────▶│                  │
   │                        │                    ├─ find listener   │
   │                        │                    ├─ queue child     │
   │                        │◀── OPEN_OK ────────┤                  │
   │◀── connect success ────┤                    ├─ wake select ───▶│
   │                        │                    │                  │
send(bytes)                 │                    │                  │
   ├───────────────────────▶├── DATA ──────────▶├── queue bytes ──▶│
   │◀── partial count ──────┤                    │           recv() │
   │                        │                    │                  │
shutdown(SD_SEND)           │                    │                  │
   ├───────────────────────▶├── FIN ───────────▶├── EOF ready ────▶│
```

`OPEN_OK` means the connection has entered the listener's backlog, not that the
server application has already called `accept`. If no listener exists, the
host returns `RST(WSAECONNREFUSED)`. If the host is unreachable, the connector
eventually completes with `WSAETIMEDOUT` or `WSAENETUNREACH`.

## Peer wire protocol

The protocol is binary, versioned, length-delimited, and independent of guest
pointer sizes or structure packing. Multi-byte header fields use network byte
order.

```text
vln/1 frame header (24 bytes)

  0               1               2               3
  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 |                    magic = "VLN1"                            |
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 | version = 1   | frame type    |             flags             |
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 |                         stream ID                             |
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 |                       payload length                          |
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 |                    direction-local counter                    |
 |                                                               |
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 |   payload ...                 | reserved for AEAD tag         |
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

The counter is monotonic per direction. In version 1 it serves replay
detection, ordering assertions, and diagnostics; it is also the intended nonce
input should the deferred record layer be enabled (see `Link protection`).
Counter reuse closes the peer link. Frames larger than the negotiated limit are
rejected before allocation.

Initial frame types are:

| Type | Purpose | Important payload fields |
|---|---|---|
| `HELLO` | Protocol/capability negotiation | version range, peer ID, virtual IP, limits |
| `OPEN` | Start a TCP stream | family, type, protocol, source port, destination IP/port |
| `OPEN_OK` | Listener queued the connection | assigned source port, initial receive credit |
| `DATA` | Ordered stream bytes | raw bytes, bounded to 16 KiB initially |
| `WINDOW` | Return receive capacity | cumulative available byte credit |
| `FIN` | Close sender's write half | optional final byte count |
| `RST` | Abort or reject a stream | stable virtual error code |
| `PING` / `PONG` | Health and RTT | opaque timestamp/token |
| `GOAWAY` | Peer link is closing | reason and retry guidance |

WebRTC already supplies reliable ordering for DataChannel messages. The virtual
protocol does not reimplement TCP retransmission or congestion control. Its
stream IDs, counters, explicit close frames, and credit are for multiplexing,
bounded memory, validation, and diagnostics.

### Flow control and limits

Initial conservative limits:

- maximum `DATA` payload: 16 KiB;
- maximum queued receive data: 256 KiB per virtual socket;
- maximum queued receive data: 1 MiB per peer;
- maximum simultaneous streams: 64 per peer;
- maximum pending accepts: listener backlog clamped to `1..16`;
- pause frame production at the DataChannel high-water mark and resume on
  `bufferedamountlow`;
- disconnect a peer that repeatedly exceeds negotiated limits.

`send` may accept fewer bytes than requested when credit or transport capacity
is limited. The sender must preserve the accepted prefix exactly and never
report bytes it did not enqueue. `recv` returns any available prefix up to the
requested length; it must not wait for the original `send` boundary.

Liquid War's own documentation says it rarely needs more than roughly 2 KiB/s,
so correctness and latency matter more than bulk throughput for the first
slice.

## Room and signaling protocol

### Room lifecycle

```text
       create
         │
         ▼
     FORMING ── first peer links healthy ──▶ READY
         │                                      │
         │ host launches server                 │ launch clients
         ▼                                      ▼
     SERVER_STARTING ── listener :8035 ──▶ PLAYABLE
         │                                      │
         │ failure                              │ host leaves / fatal link loss
         ▼                                      ▼
       ERROR ◀─────────────────────────────── CLOSED
```

Membership readiness and game readiness are separate. A peer can have a
healthy encrypted transport while its game is still at the menu. The room UI
must not claim `SERVER READY` until the virtual listener is actually bound and
listening on `10.77.0.1:8035`.

### Berrry records

The MVP uses authenticated, per-user Berrry public-data records as a polling
signaling channel. It does not require a separate WebSocket rendezvous service.
Every record is owned by the logged-in Berrry user who publishes it.
The required storage, public lookup, and authentication operations are the
documented [Berrry backend APIs](https://berrry.app/api/nomcp/docs/backend).

```text
vln-public-rooms-v1
  host-owned list of live public room descriptors

vln-room-<room-id>
  one host descriptor plus one join/presence record per interested user

vln-link-<room-id>-<joining-user-id>
  host offer and that user's answer/candidates, each in its owner's namespace
```

The public room browser lists users publishing `vln-public-rooms-v1`, fetches
their room arrays, and discards expired descriptors. A private room is never
written to that directory. Each public descriptor includes the room ID, name,
game, host user ID, capacity, current member count, whether approval is
required, host ephemeral public key, membership epoch, and expiry.

All signaling payloads carry a schema version, monotonically increasing
sequence, and expiry. Clients delete them after connection and ignore stale
records even when cleanup fails. Since the storage API does not document
server-enforced TTL or atomic message queues, each user only updates records in
their own namespace; the protocol never depends on two users updating one JSON
value.

### Private invite

A private invite contains a random room identifier and a 256-bit capability
secret. The secret belongs in the URL fragment so it is not sent in the HTTP
request or used as a Berrry storage key:

```text
https://example.invalid/lan/#room=<room-id>.<capability-secret>
```

The joining user publishes an encrypted join record and a proof of possession.
The host verifies the proof, checks the user's room-lifetime ban and capacity,
then creates the per-peer offer. Possession of the capability is the initial
admission decision; there is no second private-room approval queue.

The secret itself is never published, since Berrry public data is readable by
anyone. The joiner proves possession instead:

```text
K_cap = HKDF(capability, room-id ‖ epoch ‖ "vln1/cap")
proof = MAC(K_cap, joiner-user-id ‖ joiner-ephemeral-public-key ‖ epoch ‖ nonce)
```

The joiner's ephemeral public key must be inside the MAC input. Without it, any
reader of the join record could replay the proof under a key of their own and
receive an offer sealed to them. The epoch input is what makes rotation take
effect.

```text
Friend                       Berrry public data                    Host
   │ encrypted JOIN + proof         │                               │
   ├───────────────────────────────▶│◀────────── poll room key ─────┤
   │                                │                               │
   │◀──────── encrypted OFFER ──────┤◀──────── publish offer ───────┤
   ├──────── encrypted ANSWER ─────▶│                               │
   │                                                                │
   ╞════════════ authenticated encrypted DataChannel ═══════════════╡
   │◀──────────── assigned peer ID and 10.77.0.x ────────────────────┤
```

Rotating the capability increments the room epoch and rejects new proofs made
with the old secret. Existing admitted links may remain connected; reconnecting
members need the new link. A banned user stays rejected even if they still know
the capability.

### Public join

A public room has no room-wide secret. Its directory descriptor and join key
are intentionally discoverable. The joining user publishes an ephemeral ECDH
public key in a Berrry-owned join record. The host checks login identity, ban,
capacity, and the room's approval policy before publishing an offer encrypted
for that peer.

```text
Friend                       Berrry public data                    Host
   │ JOIN + ephemeral public key    │                               │
   ├───────────────────────────────▶│◀────────── poll room key ─────┤
   │                                │                               │
   │                   open room: admit immediately                 │
   │                approval room: wait for host Accept             │
   │                                │                               │
   │◀──── peer-encrypted OFFER ─────┤◀──────── publish offer ───────┤
   ├──── peer-encrypted ANSWER ────▶│                               │
   │                                                                │
   ╞════════════ authenticated encrypted DataChannel ═══════════════╡
```

The authenticated Berrry namespace identifies who published each signaling
record. ECDH supplies per-peer signaling and data keys. Public-room moderation
does not rely on hiding the room ID.

### STUN and TURN

Berrry public data replaces only signaling. STUN still discovers viable public
mappings, and TURN still relays encrypted traffic when direct traversal fails.
TURN and its short-lived credential issuer therefore remain the only separate
server-side networking infrastructure required for reliable production rooms.

The distinction shown to users is `game hosted by Alice`: Berrry introduces
the peers, STUN/TURN helps connect them, and Alice's original `lwwinsrv.exe`
remains the game server.

## Security and privacy

### Trust model

- The room host controls admission and is authoritative because it runs the
  original game server.
- Admitted members are allowed to exchange game traffic only inside the room.
- Berrry signaling and relay infrastructure are honest-but-curious and may be
  unavailable or abusive; they are not trusted with plaintext game traffic.
- The original game protocol is not assumed to be safe to expose directly to
  the public Internet.

### Link protection

Version 1 places its cryptography at the signaling layer and relies on WebRTC's
own DTLS for the data plane. WebRTC authenticates a peer by comparing the
certificate fingerprint carried in its SDP — and here that SDP travels through
Berrry public data, so anyone able to write that record could substitute a
fingerprint and terminate DTLS themselves. Sealing the envelope is therefore
what protects the data plane:

1. each browser creates an ephemeral ECDH key pair;
2. a private join authenticates its key with the capability proof, while a
   public join binds its key to the authenticated Berrry record owner and the
   host's acceptance decision;
3. ECDH output feeds HKDF with room, link, peer, and membership-epoch context;
   private links include the capability secret as additional key material;
4. the derived AEAD key seals the entire offer/answer envelope, DTLS
   fingerprint and ICE candidates included; and
5. because that fingerprint can be neither read nor forged by the signaling
   infrastructure, the resulting DTLS session is authenticated end to end with
   the intended peer.

Membership binding is then an ordinary application check over an already
authenticated channel rather than a key-derivation trick: the first `HELLO`
carries room ID, assigned virtual IP, and membership epoch, and any mismatch
closes the link. A host at a newer epoch simply never publishes an offer for a
revoked member.

#### Deferred record layer

An additional AEAD layer over `vln/1` frames is specified but not required for
version 1. TURN forwards packets without terminating DTLS, so a relay learns
nothing extra from it — the common justification for double encryption does not
apply here. The record layer becomes necessary only if a transport that
terminates at a server is introduced, a WebSocket relay being the likely case,
since such a server would otherwise observe plaintext frames. The frame header,
per-direction counters, and length limits are specified as they are so the tag
can be added without a wire-format break.

Do not place private capability secrets, derived keys, game bytes, plaintext
SDP, or guest memory in telemetry. Clipboard copies and invite displays should
make the secret nature of a private URL clear.

### Isolation and validation

Before a frame reaches a guest socket, validate:

- protocol version, type, flags, declared length, and authentication tag;
- stream ownership and legal state transition;
- source peer identity and assigned virtual IP;
- destination room membership and allowed port policy;
- per-frame, per-stream, and per-peer memory limits; and
- monotonically increasing direction counter.

There is no bridge to `fetch`, WebSocket, localhost, the player's private IP
ranges, or arbitrary host sockets. A compromised or malformed guest can affect
its admitted game room, not scan the host LAN through this feature.

### Known limitations

- A malicious admitted player can still send malicious or invalid bytes to the
  old game server. Protocol isolation limits reach; it does not sandbox the
  guest beyond Wine-Assembly's existing process boundary.
- The host can observe and manipulate game state by definition.
- Signaling infrastructure learns room timing and network metadata. Depending
  on browser behavior and ICE policy, it may learn candidate addresses.
- Transport encryption hides bytes, not traffic volume and timing.
- The private capability is a shared secret. Its proof establishes that a
  joiner holds the link, never which friend they are; kick and ban rely on the
  authenticated Berrry identity instead.

## Failure behavior

Failures should map predictably to both guest Winsock and room UX:

| Condition | Guest result | Player-facing state |
|---|---|---|
| No listener on `:8035` | `WSAECONNREFUSED` | `Game server is not ready` |
| Host peer link unavailable | `WSAENETUNREACH` | `Reconnecting to host…` |
| Connect deadline expires | `WSAETIMEDOUT` | `Host did not answer` |
| Peer link dies during stream | `WSAECONNRESET` | `Connection lost; match ended` |
| Receive buffer empty, nonblocking | `WSAEWOULDBLOCK` | no alert |
| Address outside room | `WSAENETUNREACH` | advanced log only |
| Room capacity reached | connection rejected | `Room is full` |
| Private capability is invalid or rotated | no socket created | `This invite is no longer valid` |
| Public pre-approval is pending | no socket created | `Waiting for host approval` |
| Host rejects or user is banned | no socket created, or active sockets reset on kick | `Host denied access` or `Removed by host` |
| Direct ICE path fails, TURN works | no guest error | `Relayed — playable` |
| Host closes room | orderly close where possible, then reset | `Host ended the room` |

Version 1 may rebuild the peer link after a transient failure, but existing
virtual TCP streams are reset. Liquid War can return to its network lobby and
start a new game; it cannot safely resume an in-progress byte stream without
support from the original protocol.

The host leaving closes the room. Host migration is deferred because moving
the peer switch is easy compared with moving the authoritative
`lwwinsrv.exe` process and its live connections.

## Observability

Diagnostics must explain transport behavior without logging payloads.

Recommended structured events:

```text
room.created
peer.join.requested
peer.admitted
peer.transport.direct
peer.transport.relayed
peer.transport.closed
socket.created
socket.bound
socket.listening
socket.open.requested
socket.open.accepted
socket.open.rejected
socket.bytes.sent
socket.bytes.received
socket.fin
socket.reset
socket.wait.started
socket.wait.completed
room.closed
```

Each event may contain room-local peer ID, virtual endpoint, stream ID,
direction, byte count, duration, route type, stable error code, and buffer
levels. It must not contain payload bytes, room secrets, encryption keys,
passwords, chat contents, player input, or raw invite URLs.

A network trace category should follow the repository's existing tracing
model. Useful filters include API name, process, socket handle, peer, and
stream. Automated tests should be able to assert the lifecycle without
scraping ad-hoc `console.log` output.

## Implementation boundaries

A likely module split is:

```text
src/09a-handlers.wat
  guest ABI, sockaddr/fd_set marshaling, stdcall cleanup, WSA errors
             │
             ▼
lib/virtual-socket-provider.js
  socket records, bind/listen/connect, stream buffers, select readiness,
  blocking wait registration, process cleanup
             │
             ▼
lib/virtual-lan-room.js
  membership, IP allocation, routing, local switch, peer-link lifecycle
             │
             ▼
lib/virtual-lan-protocol.js
  VLN1 framing, validation, counters, flow-control messages
             │
             ▼
lib/webrtc-peer-link.js
  signaling adapter, RTCPeerConnection, DataChannel, ICE/TURN diagnostics
```

Names are illustrative; responsibilities are the important boundary. WAT owns
the exact Win32 ABI. JavaScript owns asynchronous browser transport and bounded
queues. Protocol encoding must not depend on renderer state, guest addresses,
or Liquid War-specific packet knowledge.

The first implementation should add the smallest possible host-import surface,
using primitives such as create, operate, copy bytes, poll readiness, register
wait, and close. It should not add one host import per product-level room
action, nor embed WebRTC concepts in WAT.

## Delivery plan

### Slice 0: runnable game client — complete

- Original Liquid War 5.6.2 client loads its packed and custom assets.
- DirectDraw reaches a colorful 640x480 menu with its `Net game` entry. The
  client needs roughly 400k batches to get there; a shorter run stops during
  asset loading and renders an empty screen.
- Obsolete OLE/DCOM startup warnings are removed through compatibility work.
- No network success is claimed yet.

### Slice 1: deterministic socket core — complete

- `src/09d-winsock.wat` owns a 64-entry socket table and the room switch.
  Handles are tagged `0x53xxxxxx` so they cannot collide with file, thread, or
  GDI handles.
- `socket`, `bind`, `listen`, `connect`, `accept`, `send`, `recv`, `shutdown`,
  `closesocket`, `select`, `__WSAFDIsSet`, `ioctlsocket` (`FIONBIO`,
  `FIONREAD`), `setsockopt`, `htons`/`ntohs`, `inet_addr`/`inet_ntoa`,
  `gethostbyname`, and the `WSA*` lifecycle run against that switch.
- All 21 WSOCK32 ordinals both Liquid War binaries import now resolve.
- Isolation is enforced at `bind` and `connect`: only `10.77.0.0/24` and
  loopback are routable, everything else is `WSAENETUNREACH`.
- `test/test-wat-winsock.js` — 37 checks covering invalid handles, illegal
  state transitions, partial send, fragmented recv, orderly EOF versus reset,
  backlog limits, ephemeral ports, readiness in all three `select` sets, and
  table exhaustion.

Exit gate met: a synthetic client and server exchange fragmented bidirectional
byte streams through the public Winsock handlers, and `lwwinsrv.exe -private -6
-nobeep` now reaches its real accept loop — `bind(&0.0.0.0:8035)`,
`listen(backlog=10)`, then `select` on the listener with a 1s timeout — where
it previously failed at `socket()` and exited 1.

Blocking calls, the finite `select` timeout, and the asynchronous `connect`
path were deferred here and are implemented in Slice 2 below.

Tracing: `--trace-api` decodes `sockaddr_in`, `fd_set`, and `timeval` through
the `LPSOCKADDR`, `LPFDSET`, and `LPTIMEVAL` types in `lib/api-format.js`, so a
network trace reads `bind(name=&0.0.0.0:8035)` rather than a bare pointer.

### Slice 2: Liquid War local loopback — transport complete, game pending

The wire, the blocking model, and two-process rooms are in place. Driving the
client through its `Net game` menu is the remaining half.

Done:

- A socket whose peer lives in another process is marked with `peer = -2` and
  reaches that peer over a frame wire. Frames are 28 bytes of header —
  magic, type, source and destination endpoints, length — followed by at most
  4096 payload bytes, with types `SYN`, `SYNACK`, `DATA`, `FIN`, and `RST`.
- The host carries frames and nothing else. Its whole surface is
  `net_frame_send`, `net_frame_peek`, and `net_frame_commit`; it never reads a
  port, tracks a connection, or picks a route. Peek and commit are separate so
  a frame whose destination ring is full stays queued rather than being
  dropped, which a byte stream may never do.
- The wire is a broadcast segment and each process keeps only what is
  addressed to it, so routing stays in WAT. Malformed frames — bad magic,
  short header, a declared length that disagrees with the frame size — are
  dropped without stalling the stream behind them.
- Each process has its own room address (`set_vlan_local_ip`, `--vlan-ip=`).
  A destination the process does not answer for goes out on the wire; its own
  address and loopback still meet inside its own table.
- Blocking calls no longer crash. `accept`, `recv`, `send`, `connect`, and
  `select` park the whole API call on the net_wait yield (reason 8): the
  handler puts back the stdcall frame it had already dropped, EIP stays on the
  thunk, and the host re-enters the same handler once the wire has moved.
- `select` honours a finite `timeval` against the tick counter, and counts
  readiness without rewriting the guest's `fd_set`s until it actually
  returns — a set emptied before a yield would be gone when the call resumed.
- Ordinal-only imports now resolve through the WAT table first for both the
  EXE and DLL loaders. They previously had separate answers, so `__WSAFDIsSet`
  was reachable from a DLL but not from an EXE, and the server crashed the
  first time `select` reported a ready socket.

Gates met:

- `test/test-vlan-wire.js` — 20 checks. Two emulator instances with separate
  memories and separate tables complete a TCP conversation across the wire:
  connect handshake, ordered delivery through 40 small writes, partial send at
  the frame limit, orderly EOF, abortive reset, refusal, foreign and malformed
  frames, and the three parking paths.
- `test/test-vlan-loopback.js` — 5 checks, two operating-system processes.
  `lwwinsrv.exe -private -6 -nobeep` runs at `10.77.0.1` and a second process
  at `10.77.0.2` opens a connection to port 8035. The server's own trace shows
  it calling `accept()`, then reading the peer's bytes one at a time through
  its protocol parser, then `closesocket` when the peer goes away.

#### Reaching the client's own Net game menu

Driving the client turned out to be blocked on input rather than on anything
network-related. Allegro reads the keyboard **only** through buffered
DirectInput — it sets `DIPROP_BUFFERSIZE`, registers an event with
`SetEventNotification`, and drains `GetDeviceData` — and never calls
`GetDeviceState`. `GetDeviceData` reported mouse button transitions but
deliberately kept the keyboard buffer empty, so no keystroke had ever reached
any Allegro-based game. The menu rendered correctly and then ignored every key,
which reads as a rendering or timing bug and is neither.

`src/09a8-handlers-directx.wat` now reports keyboard edges:

- a 256-byte DIK-to-VK table, declared with a `_SIZE` global so
  `test-wat-memory-map.js` covers it. `$di_dik_to_vk` became a table lookup
  rather than a comparison chain because `GetDeviceData` walks all 256 scan
  codes on every poll, and an Allegro input thread polls continuously;
- `$di_dik_to_vk_strict`, which returns 0 for an unmapped scan code. The
  original mapper falls back to the raw index for VK-shaped callers, and that
  fallback would otherwise make DIK 0x28 (apostrophe) alias VK 0x28 (VK_DOWN)
  and report a phantom key on every arrow press;
- the last state reported to the guest as a 256-bit map across eight globals,
  which `GetDeviceData` diffs to emit one `DIDEVICEOBJECTDATA` per edge. A
  count query (`rgdod == NULL`) never consumes, and `DIGDD_PEEK` leaves the map
  in place;
- the right-hand duplicates that share a VK with their left-hand twin — RSHIFT,
  RCONTROL, RMENU, NUMPADENTER — are skipped, so one Shift press is not
  delivered twice.

With that in place the client is fully keyboard-drivable: Down selects
`Net game`, Enter opens it, an arrow focuses the `Server addr` field, and text
entry replaces the default `127.0.0.1` with a room address.

#### The room is per process, and threads are part of the process

`lwwin.exe` does not connect on its main thread. It allocates a context, hands
a callback to a worker, and its main thread sits in a progress loop polling a
done flag — so the socket, bind, htons, inet_addr and connect calls all happen
on a worker instance.

Worker instances share linear memory, so the socket table itself was already
shared, but the room address is a WAT *global* and therefore per instance. A
worker would have emitted every frame from address 0, and its host context
carried no wire at all. Three fixes, matching the existing `dll_count`
precedent:

- `lib/thread-manager.js` copies `vlan_local_ip` from the main instance to each
  new thread instance;
- the worker host context carries the same `vlanWire`, since a wire belongs to
  the process, not to one thread;
- yield 8 (`net_wait`) is handled per thread: clear the yield, pump, and give up
  the slice rather than spinning, since frames arrive on the host event loop.

This also exposed a diagnostic gap worth remembering: `--count`, `--break` and
`--watch` are main-instance only, so a worker thread reads as *never executed*.
Worse, worker-thread API calls log ordinal-only imports as `[API T3] <ord>`
with no name, so the client's own socket calls are invisible in its own trace.
The two-process gate therefore asserts on the **server's** `accept`, which is
the far end of the same connection and is named properly.

Remaining for the exit gate: frames are not yet crossing — the client reaches
its connect and the server is still in `select`. After that, the waiting room
and a completed match.

Exit gate: the original client and server complete a game in one browser with
no network-specific binary patch or fake successful call.

### Slice 3: transport-independent two-peer test

- Add `vln/1` framing and a deterministic in-memory/fault-injection peer link.
- Route a client through serialization instead of the local fast path.
- Fragment guest writes, coalesce deliveries, vary delivery timing while
  preserving channel order, drop peer links, and apply backpressure.
- Verify malformed and over-limit frames fail closed.

Exit gate: the Liquid War path survives arbitrary `DATA` fragmentation and
bounded delay, reports resets accurately, and never exceeds queue limits.

### Slice 4: direct online room

- Require Berrry login and add public-data polling for room/signaling records.
- Add private capability links and the public room directory.
- Add public open/pre-approval admission plus shared kick/ban moderation.
- Add IP allocation and one host/friend WebRTC connection.
- Expose clear direct-path diagnostics.
- Run two real browsers on separate networks with no manual port forwarding.

Exit gate: both clients connect to the host's original `lwwinsrv.exe` at
`10.77.0.1:8035` and complete a match over a direct path.

#### Backend surface and the local development server

Signaling needs no new service. The Berrry backend already provides
authenticated per-user JSON records, which is exactly the shape a poll-based
SDP exchange needs:

```text
POST   /api/data/:key?visibility=public     publish a record in your namespace
GET    /api/public-data/users/:key          who has published this key  <- discovery
GET    /api/public-data/:userId/:key        read one user's record
PUT    /api/data/:key                       update
DELETE /api/data/:key                       clean up after the channel opens
GET    /api/auth/user  (401 -> /api/auth/login)   identity, and the moderation handle
```

There is no push or socket, so signaling polls. That is acceptable for the few
seconds an offer/answer exchange takes, and game bytes never touch it — they go
over the DataChannel. Both players therefore need Berrry accounts, since
`/api/data` writes are application-user authenticated. The `brry_rw_*`
deployment token used by `tools/deploy-berrry.js` is a deploy-time secret and
must never reach browser code; the in-page path uses the viewer's own session.

Public records are readable by anyone, so the SDP is encrypted under a room
secret carried in the invite fragment and never published. Otherwise the room
ID alone would let a stranger answer the offer.

For local development, `tools/dev-server.js` serves the repository over HTTP
**and** implements those same routes in memory with no login, so two browsers
on one machine can find each other before any Berrry account exists. It is the
same server that serves the page, so a demo needs one command. The in-memory
store is deliberately not persisted: a restart is the reset.

### Slice 5: relay-quality rooms

- Configure TURN and confirm sealed signaling envelopes hold across relayed
  paths, including rejection of a substituted DTLS fingerprint.
- Add reconnect status, admission denial, capacity limits, rate limits, and
  stable failure messages.
- Exercise symmetric/restrictive NAT cases and deliberate direct-path failure.

Exit gate: the same complete-match test passes through a forced relay, while
the relay observes only DTLS traffic it cannot decrypt.

### Slice 6: broader virtual LAN

- Add UDP datagrams with explicit size and queue limits.
- Add subnet broadcast/multicast policy and discovery fan-out.
- Add room-local DNS and hostname APIs.
- Add DirectPlay compatibility only when a selected corpus game requires it.
- Evaluate host-forwarded versus direct peer-to-peer traffic for non-server
  games.

## Test strategy

### Unit tests

- `sockaddr_in`, `fd_set`, and `timeval` guest-memory marshaling;
- WSOCK32 name and ordinal resolution;
- handle namespace and process/thread WSA error ownership;
- socket state-machine transitions and illegal-call errors;
- receive fragmentation, send partials, EOF, reset, and half-close;
- listener backlog and ephemeral-port allocation;
- `select` readiness, unique result counts, zero timeout, finite timeout, and
  cancellation on process exit;
- frame encoding/decoding, version rejection, replay, length limits, credit
  accounting, and counter exhaustion;
- signaling envelope sealing and unsealing, rejection of a substituted DTLS
  fingerprint, and `HELLO` room/IP/epoch mismatch;
- private capability proof/rotation, including rejection of a proof replayed
  under a different ephemeral public key; and
- public listing expiry, public open versus pre-approval admission, capacity,
  kick, ban, and membership-epoch rejection.

### Deterministic integration tests

```text
client process ─ virtual link with fault controls ─ server process
                    │
                    ├─ split every write at 1..N bytes
                    ├─ delay frames under a seeded clock
                    ├─ force send-credit exhaustion
                    ├─ reset before/after FIN
                    └─ close process with pending select/accept/recv
```

Tests should use a virtual clock and seeded transport so timeouts and faults do
not depend on wall-clock races.

### Browser end-to-end matrix

| Route | Host/client placement | Required result |
|---|---|---|
| Local | two processes, one browser | complete match and second-game reconnect |
| Direct | two browsers, direct DataChannel | complete match, direct badge |
| Relayed | two browsers, forced TURN | complete match, relayed badge |
| Loss | drop active peer link | guest reset and understandable room state |
| Private rejection | bad/rotated secret, banned user, or full room | no game launch or virtual route |
| Public open | logged-in eligible user | admission without host interaction |
| Public approval | require approval, then accept/reject | no IP before accept; no route after reject |
| Moderation | kick and ban connected user | sockets reset; same Berrry user cannot rejoin |
| Isolation | guest targets real/private IP | deterministic rejection, no host request |

The decisive acceptance test is concrete: two browsers, zero port forwarding,
the host runs the bundled original server, both clients connect to
`10.77.0.1:8035`, and a complete match succeeds over both a direct and a forced
relay route.

## Decisions and open questions

### Decisions

- Intercept Winsock; do not emulate Ethernet for the first game.
- Keep Liquid War's original server authoritative.
- Use a host-centered star topology for version 1.
- Use reliable ordered WebRTC DataChannels and multiplex virtual streams.
- Seal signaling envelopes so the DTLS fingerprint authenticates the peer, and
  defer a record layer above WebRTC until a transport that terminates at a
  server exists.
- Use room-only addresses and deny arbitrary Internet/LAN egress.
- Implement genuine byte-stream and wait semantics before connecting WebRTC.
- Treat loss of a live peer link as reset of its existing virtual sockets.
- Support exactly two room types: private secret-link and public listed.
- Require Berrry login for both room types.
- Make both room types host-moderatable with kick and room-lifetime ban.
- Allow optional pre-approval only for public rooms; private capability holders
  are admitted unless banned or full.
- Use Berrry public-data polling for MVP signaling and public-room discovery;
  retain STUN/TURN as separate connectivity infrastructure.

### Open questions to resolve during Slice 1 or 2

- Which socket options and exact blocking patterns are reached by the original
  binaries after their network menu is exercised?
- Does `lwwinsrv.exe` require a console-input automation seam for team count, or
  are command-line arguments sufficient for every desired room configuration?
- Should all local streams traverse the serializer in development builds to
  prevent the in-memory fast path from hiding wire-protocol bugs?
- What queue caps preserve smooth rendering on mobile Safari under memory
  pressure?
- Does the browser process scheduler need a general wait-token abstraction, or
  can the first network yield reuse and then cleanly generalize an existing
  yield mechanism?
- Should room policy allow arbitrary room-local ports immediately, or only the
  selected game's declared ports until UDP/broadcast support lands?

These questions do not change the architecture. The next useful engineering
step remains the same: build real loopback Winsock semantics, launch the
bundled server beside the client, and make `10.77.0.1:8035` work before adding
an Internet transport.
