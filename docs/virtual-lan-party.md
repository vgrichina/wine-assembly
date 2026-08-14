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
browser. A lightweight rendezvous service introduces browsers, and an
encrypted relay may carry opaque bytes when a direct path is impossible.
Neither understands or simulates Liquid War.

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
│ Passphrase       optional                                   │
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

### Friend

```text
Open invite ──▶ verify room ──▶ choose display name ──▶ join
                                                        │
                                                        ▼
                                               receive 10.77.0.x
                                                        │
                                                        ▼
                                                [ Launch game ]
```

The launcher should prefill the host address and port when a safe configuration
path is available. Until then, the game UI can use `10.77.0.1` and `8035`.

### Room screen

```text
┌─ MOLTEN-MOON ────────────────────────────────────────────────┐
│ Liquid War 5.6.2                              [Copy invite] │
│                                                              │
│  ● You (host)   10.77.0.1   local        0 ms   SERVER ✓   │
│  ● Maya         10.77.0.2   direct      28 ms          ✓   │
│  ● Leo          10.77.0.3   relayed     61 ms          ✓   │
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

             HTTPS invite + signaling WebSocket
                              │
                    ┌─────────▼─────────┐
                    │ Rendezvous service│
                    │                   │
                    │ room membership   │
                    │ SDP/ICE exchange  │
                    │ short-lived state │
                    └─────────┬─────────┘
                              │
                 optional STUN/TURN service
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
| Control | Room ID, membership, public keys, SDP, ICE candidates, presence | Game packets, guest memory, room secret, game authority |
| Data | Encrypted virtual-socket frames and health probes | Account tokens, arbitrary host-network access |

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
vln/1 frame header (24 bytes before authentication tag)

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
 |             encrypted payload ...             | AES-GCM tag   |
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

The counter is monotonic per direction and participates in the AES-GCM nonce
and authenticated data. Counter reuse closes the peer link. Frames larger than
the negotiated limit are rejected before allocation.

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

### Invite

An invite contains a random room identifier and a high-entropy room secret.
The secret belongs in the URL fragment so it is not sent in the HTTP request:

```text
https://example.invalid/lan/#room=<room-id>.<room-secret>
```

The rendezvous service knows the room ID but not the secret. An optional human
passphrase is an additional admission check; it must not replace the random
secret or be used directly as an encryption key.

### Join handshake

```text
Friend                         Rendezvous                         Host
   │ register room ID + nonce       │                              │
   ├───────────────────────────────▶│                              │
   │                                ├─ membership request ────────▶│
   │                                │                              │
   │◀──────── host public key + WebRTC offer/candidates ──────────┤
   │                                                              │
   ├──── public key + room-secret proof + answer/candidates ─────▶│
   │                                                              │
   ╞════════════ authenticated encrypted DataChannel ═════════════╡
   │ HELLO / capability negotiation                               │
   │◀──────────────── assigned peer ID + 10.77.0.x ────────────────┤
```

Signaling messages are short-lived, schema-validated, rate-limited, and scoped
to one room. A monotonically increasing membership epoch prevents a removed
peer from reusing stale signaling messages.

### Service-free and self-hosted modes

An online room normally needs some Internet bootstrap infrastructure even
though it has no Internet game server:

- rendezvous exchanges WebRTC offers and ICE candidates;
- STUN discovers viable public mappings; and
- TURN relays encrypted traffic when NAT traversal fails.

All three can be self-hosted. A zero-rendezvous mode can exchange offers and
answers by copy/paste or QR code, but it is less friendly and cannot guarantee
NAT traversal without STUN/TURN. The distinction shown to users should be
`game hosted by Alice`, not the misleading claim that no supporting service is
ever contacted.

## Security and privacy

### Trust model

- The room host controls admission and is authoritative because it runs the
  original game server.
- Admitted members are allowed to exchange game traffic only inside the room.
- Rendezvous and relay infrastructure are honest-but-curious and may be
  unavailable or abusive; they are not trusted with plaintext game traffic.
- The original game protocol is not assumed to be safe to expose directly to
  the public Internet.

### Link protection

WebRTC DataChannels are encrypted in transit. In addition, `vln/1` should use
application-level authenticated encryption so that TURN and any future
WebSocket relay have the same privacy properties:

1. each browser creates an ephemeral ECDH key pair;
2. peers authenticate the public keys with a proof derived from the room
   secret;
3. ECDH output and the room secret feed HKDF with room/link identities;
4. each direction receives a separate AES-GCM key and nonce prefix; and
5. frame headers are authenticated, counters are never reused, and replayed or
   malformed frames close the link.

Do not place the room secret, derived keys, game bytes, full SDP, or guest
memory in telemetry. Clipboard copies and invite displays should make the
secret nature of the URL clear.

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
- Application encryption hides bytes, not traffic volume and timing.

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
  VLN1 framing, validation, counters, flow-control messages, encryption
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
- DirectDraw reaches a colorful 640x480 menu.
- Obsolete OLE/DCOM startup warnings are removed through compatibility work.
- No network success is claimed yet.

### Slice 1: deterministic socket core

- Add complete socket records and non-colliding handle allocation.
- Implement address parsing, byte-order functions, WSA error state, and close.
- Implement `bind`, `listen`, `connect`, `accept`, `send`, `recv`, `shutdown`,
  `FIONBIO`, and `select` against an in-memory switch.
- Add all WSOCK32 ordinal resolution required by both Liquid War binaries.
- Test invalid handles, illegal state transitions, partial I/O, EOF/reset,
  backlog limits, timeouts, and cleanup.

Exit gate: a synthetic client and server exchange fragmented bidirectional byte
streams through public Winsock handlers with blocking and nonblocking modes.

### Slice 2: Liquid War local loopback

- Run `lwwinsrv.exe -private -6 -nobeep` as its own emulator process.
- Run one `lwwin.exe` client in another process sharing the room switch.
- Prove the listener becomes ready on `10.77.0.1:8035`.
- Connect a team, reach the waiting-room state, exchange chat/readiness, start a
  match, complete a round, and reconnect for a second game.

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

- Add room creation, invite parsing, signaling, authentication, IP allocation,
  and one host/friend WebRTC connection.
- Expose clear direct-path diagnostics.
- Run two real browsers on separate networks with no manual port forwarding.

Exit gate: both clients connect to the host's original `lwwinsrv.exe` at
`10.77.0.1:8035` and complete a match over a direct path.

### Slice 5: relay-quality rooms

- Configure TURN and enforce application-level frame encryption.
- Add reconnect status, admission denial, capacity limits, rate limits, and
  stable failure messages.
- Exercise symmetric/restrictive NAT cases and deliberate direct-path failure.

Exit gate: the same complete-match test passes through a forced relay, while
the relay observes only encrypted frame traffic.

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
- frame encoding/decoding, version rejection, authentication failure, replay,
  length limits, credit accounting, and counter exhaustion.

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
| Rejection | bad secret/full room | no game launch or virtual route |
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
- Add application encryption above WebRTC for uniform relay privacy.
- Use room-only addresses and deny arbitrary Internet/LAN egress.
- Implement genuine byte-stream and wait semantics before connecting WebRTC.
- Treat loss of a live peer link as reset of its existing virtual sockets.

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
