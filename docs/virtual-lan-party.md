# Virtual LAN party: experience and network TL;DR

The promise is: one friend hosts the game, everyone else follows an invite,
and the unmodified game sees an ordinary private LAN. There is no hosted,
authoritative Liquid War service. The bundled `lwwinsrv.exe` remains the game
server and runs on the host's machine.

```text
┌─ MOLTEN-MOON ────────────────────────────────────────────────┐
│ Liquid War 5.6.2                              [Copy invite] │
│                                                              │
│  ● You (host)   10.77.0.1   direct       0 ms   SERVER ✓    │
│  ● Maya         10.77.0.2   direct      28 ms            ✓  │
│  ● Leo          10.77.0.3   relayed     61 ms            ✓  │
│                                                              │
│  Liquid War server   10.77.0.1:8035   private   2/6 teams   │
│                                                              │
│  [ Launch game ]                         [ Leave room ]       │
└──────────────────────────────────────────────────────────────┘

                    encrypted room overlay

  You + lwwinsrv.exe  ◀════ WebRTC direct ════▶  Maya
           ▲          ◀── relay fallback ─────▶  Leo
           │
           └── Liquid War clients connect to 10.77.0.1:8035
```

## Player flow

```text
HOST                                      FRIEND
Choose Liquid War                         Open invite
      │                                         │
Create room ───── copy link / room code ───────▶ Join room
      │                                         │
Start lwwinsrv.exe -private -6 -nobeep          │
      │                                         │
Launch client                            Launch client
      └──────── both see 10.77.0.1:8035 ────────┘
                         │
                       Play
```

The advanced details stay behind a disclosure: assigned room IP, direct versus
relayed route, latency, packet loss, and a connection log. A failed direct
route should read “Relayed — playable, +33 ms” rather than presenting NAT or
port-forwarding instructions.

## Network model

```text
                      CONTROL PLANE
 invite + membership + authenticated WebRTC signaling
                 (never sees game state)
                              │
        ┌─────────────────────┴─────────────────────┐
        │                  DATA PLANE               │
        │ reliable ordered peer channels, E2E keys │
        │ direct when possible; relay when required│
        └─────────────────────┬─────────────────────┘
                              │
                 VIRTUAL SOCKET SWITCH
       10.77.0.x addresses, ports, streams, backpressure
                              │
          guest Winsock calls: socket/connect/send/recv/select
                              │
               unmodified lwwin.exe / lwwinsrv.exe
```

Browsers cannot expose a raw TCP listener to an emulated Win32 process. The
right seam is therefore the existing Winsock handler boundary: implement
`socket`, `bind`, `listen`, `accept`, `connect`, `send`, `recv`, and `select`
against a room-scoped virtual socket switch. A reliable ordered WebRTC data
channel carries framed byte streams between peers. The switch provides TCP-like
ordering, half-close, buffering, backpressure, and wakeups while the guest still
believes it owns a normal Winsock socket.

Liquid War is a deliberately narrow first slice: it uses TCP, a single server,
and port 8035. After that works, general LAN compatibility can add UDP datagrams,
broadcast/multicast discovery, per-room DNS names, and DirectPlay adapters. A
full emulated Ethernet/IP stack is not required for the first game.

## Room rules

- The host owns the game process and authoritative game state. If the host
  leaves, the room ends; host migration is a later feature.
- Every room gets an isolated subnet and fresh encryption keys. Peers cannot
  address other rooms or the host's real LAN.
- Invite capability plus an optional passphrase controls admission. The room
  enforces Liquid War's six-team limit before launching clients.
- A small rendezvous service makes invites and NAT traversal usable. It is not
  a game server. A relay may carry encrypted bytes when peer-to-peer traversal
  fails, but cannot inspect or author game messages.
- The bundled metaserver feature stays disabled (`-private`). Discovery happens
  through the room invite, not the historical public Liquid War directory.

## Delivery slices

1. **Liquid War local loopback:** real Winsock lifecycle with client and
   `lwwinsrv.exe` in one runtime, including `select` and partial reads/writes.
2. **Two peers, direct:** fixed room IPs and one reliable ordered data channel;
   no discovery protocol and no relay.
3. **Invite-quality rooms:** signaling, authentication, reconnect status,
   diagnostics, and relay fallback.
4. **Virtual-LAN breadth:** UDP, broadcast discovery, DirectPlay, and more games
   from the corpus.

Success for the first online slice is intentionally concrete: two browsers,
zero port forwarding, host runs the bundled server, both clients connect to
`10.77.0.1:8035`, and a complete match survives a direct and a relayed route.
