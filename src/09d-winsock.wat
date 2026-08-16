  ;; =====================================================================
  ;; Virtual LAN Winsock core — docs/virtual-lan-party.md, Slices 1-2
  ;;
  ;; A room-scoped socket switch. Guest AF_INET/SOCK_STREAM sockets are
  ;; genuine byte streams. Two sockets inside one process meet directly in
  ;; VSOCK_TABLE; a socket whose peer lives in another process meets it
  ;; over the frame wire further down this file. No host socket or TAP
  ;; device is involved either way, and addresses live only inside the
  ;; room, so a guest cannot reach the player's real LAN or the Internet
  ;; through these handlers.
  ;;
  ;; A blocking call that cannot complete parks the whole API call with the
  ;; net_wait yield (reason 8) instead of pretending it would block: EIP
  ;; still points at the thunk, so the host re-enters the same handler once
  ;; the wire has moved.
  ;;
  ;; Record layout (128 bytes at VSOCK_TABLE + index * 128):
  ;;   +0   state       0 free / 1 created / 2 bound / 3 listening
  ;;                    4 connected / 5 closed / 6 connecting (SYN sent,
  ;;                    waiting for the remote process to answer)
  ;;   +4   family      AF_INET
  ;;   +8   type        SOCK_STREAM
  ;;   +12  proto       0 or IPPROTO_TCP
  ;;   +16  local_ip    host byte order, 0 = INADDR_ANY
  ;;   +20  local_port  host byte order
  ;;   +24  remote_ip   host byte order
  ;;   +28  remote_port host byte order
  ;;   +32  peer        peer record index, -1 when unconnected,
  ;;                    -2 when the peer lives in another process (the
  ;;                    connection is then identified by remote_ip:port)
  ;;   +36  mode        0 blocking / 1 nonblocking (FIONBIO)
  ;;   +40  rx_buf      guest pointer to the receive ring, 0 when unallocated
  ;;   +44  rx_cap      ring capacity in bytes
  ;;   +48  rx_head     read offset into the ring
  ;;   +52  rx_len      bytes currently readable
  ;;   +56  flags       bit0 read half closed (FIN seen)
  ;;                    bit1 write half closed (FIN sent)
  ;;                    bit2 reset (peer aborted)
  ;;                    bit3 a connect is outstanding and its result has
  ;;                         not been reported to the guest yet
  ;;   +60  backlog     listener backlog, clamped to 1..15
  ;;   +64  acc_count   queued accepts
  ;;   +68  acc_queue   15 × i32 child record indexes (ends at +128)
  ;; =====================================================================

  (global $VSOCK_MAX i32 (i32.const 64))
  (global $VSOCK_REC_SIZE i32 (i32.const 128))
  (global $VSOCK_RX_CAP i32 (i32.const 16384))
  (global $VSOCK_HANDLE_TAG i32 (i32.const 0x53000000))

  ;; Room addressing. The host of the room owns 10.77.0.1; every record
  ;; created by this process binds there until multi-process rooms assign
  ;; per-member addresses.
  (global $vsock_local_ip (mut i32) (i32.const 0x0A4D0001))  ;; 10.77.0.1
  (global $vsock_next_port (mut i32) (i32.const 49152))
  (global $wsa_last_error (mut i32) (i32.const 0))
  (global $wsa_started (mut i32) (i32.const 0))
  (global $vsock_ntoa_buf (mut i32) (i32.const 0))
  (global $vsock_hostent (mut i32) (i32.const 0))
  (global $vsock_servent (mut i32) (i32.const 0))
  (global $vsock_protoent (mut i32) (i32.const 0))

  ;; ---- helpers --------------------------------------------------------

  (func $vsock_rec (param $idx i32) (result i32)
    (i32.add (global.get $VSOCK_TABLE)
      (i32.mul (local.get $idx) (global.get $VSOCK_REC_SIZE))))

  (func $vsock_set_error (param $err i32)
    (global.set $wsa_last_error (local.get $err)))

  ;; Guest SOCKET handle → record index, or -1 when the handle is not a
  ;; live socket. Handles are tagged so they cannot be confused with file,
  ;; thread, or GDI handles.
  (func $vsock_index (param $handle i32) (result i32)
    (local $idx i32)
    (if (i32.ne (i32.and (local.get $handle) (i32.const 0xFF000000))
                (global.get $VSOCK_HANDLE_TAG))
      (then (return (i32.const -1))))
    (local.set $idx (i32.and (local.get $handle) (i32.const 0xFFFFFF)))
    (if (i32.ge_u (local.get $idx) (global.get $VSOCK_MAX))
      (then (return (i32.const -1))))
    (if (i32.eqz (i32.load (call $vsock_rec (local.get $idx))))
      (then (return (i32.const -1))))
    (local.get $idx))

  (func $vsock_handle (param $idx i32) (result i32)
    (i32.or (global.get $VSOCK_HANDLE_TAG) (local.get $idx)))

  ;; Allocate a zeroed record. Returns the index, or -1 when the table is
  ;; full (WSAEMFILE).
  (func $vsock_alloc (result i32)
    (local $i i32) (local $rec i32) (local $j i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $VSOCK_MAX)))
      (local.set $rec (call $vsock_rec (local.get $i)))
      (if (i32.eqz (i32.load (local.get $rec)))
        (then
          (local.set $j (i32.const 0))
          (block $zdone (loop $zero
            (br_if $zdone (i32.ge_u (local.get $j) (global.get $VSOCK_REC_SIZE)))
            (i32.store (i32.add (local.get $rec) (local.get $j)) (i32.const 0))
            (local.set $j (i32.add (local.get $j) (i32.const 4)))
            (br $zero)))
          (i32.store (i32.add (local.get $rec) (i32.const 32)) (i32.const -1))
          (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  (func $bswap16 (param $v i32) (result i32)
    (i32.or
      (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 8))
      (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 0xFF))))

  (func $bswap32 (param $v i32) (result i32)
    (i32.or
      (i32.or
        (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 24))
        (i32.shl (i32.and (local.get $v) (i32.const 0xFF00)) (i32.const 8)))
      (i32.or
        (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 0xFF00))
        (i32.and (i32.shr_u (local.get $v) (i32.const 24)) (i32.const 0xFF)))))

  ;; A destination is inside the room when it is the room /24 or loopback.
  ;; Everything else is refused so the guest cannot reach the host LAN.
  (func $vsock_addr_in_room (param $ip i32) (result i32)
    (if (i32.eq (i32.and (local.get $ip) (i32.const 0xFFFFFF00))
                (i32.const 0x0A4D0000))
      (then (return (i32.const 1))))
    (if (i32.eq (i32.and (local.get $ip) (i32.const 0xFF000000))
                (i32.const 0x7F000000))
      (then (return (i32.const 1))))
    (i32.const 0))

  ;; Read a guest sockaddr_in into locals. Returns 1 on success, 0 when the
  ;; family is not AF_INET or the length is too small.
  ;; Results land in the caller-visible globals below to keep the WAT flat.
  (global $vsock_sa_ip (mut i32) (i32.const 0))
  (global $vsock_sa_port (mut i32) (i32.const 0))

  (func $vsock_read_sockaddr (param $addr_ga i32) (param $len i32) (result i32)
    (local $wa i32)
    (if (i32.eqz (local.get $addr_ga)) (then (return (i32.const 0))))
    (if (i32.lt_s (local.get $len) (i32.const 8)) (then (return (i32.const 0))))
    (local.set $wa (call $g2w (local.get $addr_ga)))
    (if (i32.ne (i32.load16_u (local.get $wa)) (i32.const 2))
      (then (return (i32.const 0))))
    (global.set $vsock_sa_port
      (call $bswap16 (i32.load16_u (i32.add (local.get $wa) (i32.const 2)))))
    (global.set $vsock_sa_ip
      (call $bswap32 (i32.load (i32.add (local.get $wa) (i32.const 4)))))
    (i32.const 1))

  ;; Write a sockaddr_in for accept/getpeername style out-parameters.
  (func $vsock_write_sockaddr (param $addr_ga i32) (param $len_ga i32)
                              (param $ip i32) (param $port i32)
    (local $wa i32) (local $cap i32) (local $i i32)
    (if (i32.eqz (local.get $addr_ga)) (then (return)))
    (local.set $cap (i32.const 16))
    (if (local.get $len_ga)
      (then (local.set $cap (i32.load (call $g2w (local.get $len_ga))))))
    (if (i32.lt_s (local.get $cap) (i32.const 16)) (then (return)))
    (local.set $wa (call $g2w (local.get $addr_ga)))
    (i32.store16 (local.get $wa) (i32.const 2))
    (i32.store16 (i32.add (local.get $wa) (i32.const 2))
      (call $bswap16 (local.get $port)))
    (i32.store (i32.add (local.get $wa) (i32.const 4))
      (call $bswap32 (local.get $ip)))
    (local.set $i (i32.const 8))
    (block $zd (loop $z
      (br_if $zd (i32.ge_u (local.get $i) (i32.const 16)))
      (i32.store8 (i32.add (local.get $wa) (local.get $i)) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $z)))
    (if (local.get $len_ga)
      (then (i32.store (call $g2w (local.get $len_ga)) (i32.const 16)))))

  ;; Is any live record already bound to this ip/port pair?
  (func $vsock_port_taken (param $ip i32) (param $port i32) (result i32)
    (local $i i32) (local $rec i32) (local $st i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $VSOCK_MAX)))
      (local.set $rec (call $vsock_rec (local.get $i)))
      (local.set $st (i32.load (local.get $rec)))
      ;; States 2..4 own their local port, and so does 6 (connecting).
      (if (i32.or (i32.and (i32.ge_u (local.get $st) (i32.const 2))
                           (i32.le_u (local.get $st) (i32.const 4)))
                  (i32.eq (local.get $st) (i32.const 6)))
        (then
          (if (i32.eq (i32.load (i32.add (local.get $rec) (i32.const 20)))
                      (local.get $port))
            (then
              ;; INADDR_ANY on either side collides with every address.
              (if (i32.or
                    (i32.or (i32.eqz (local.get $ip))
                            (i32.eqz (i32.load (i32.add (local.get $rec) (i32.const 16)))))
                    (i32.eq (i32.load (i32.add (local.get $rec) (i32.const 16)))
                            (local.get $ip)))
                (then (return (i32.const 1))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $vsock_alloc_port (result i32)
    (local $tries i32) (local $port i32)
    (local.set $tries (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $tries) (i32.const 16384)))
      (local.set $port (global.get $vsock_next_port))
      (global.set $vsock_next_port (i32.add (local.get $port) (i32.const 1)))
      (if (i32.gt_u (global.get $vsock_next_port) (i32.const 65535))
        (then (global.set $vsock_next_port (i32.const 49152))))
      (if (i32.eqz (call $vsock_port_taken (global.get $vsock_local_ip) (local.get $port)))
        (then (return (local.get $port))))
      (local.set $tries (i32.add (local.get $tries) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Find a listening record that would accept a connection to ip:port.
  (func $vsock_find_listener (param $ip i32) (param $port i32) (result i32)
    (local $i i32) (local $rec i32) (local $lip i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $VSOCK_MAX)))
      (local.set $rec (call $vsock_rec (local.get $i)))
      (if (i32.eq (i32.load (local.get $rec)) (i32.const 3))
        (then
          (if (i32.eq (i32.load (i32.add (local.get $rec) (i32.const 20))) (local.get $port))
            (then
              (local.set $lip (i32.load (i32.add (local.get $rec) (i32.const 16))))
              (if (i32.or (i32.eqz (local.get $lip)) (i32.eq (local.get $lip) (local.get $ip)))
                (then (return (local.get $i))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  (func $vsock_alloc_ring (param $idx i32) (result i32)
    (local $rec i32) (local $buf i32)
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (if (i32.load (i32.add (local.get $rec) (i32.const 40)))
      (then (return (i32.const 1))))
    (local.set $buf (call $heap_alloc (global.get $VSOCK_RX_CAP)))
    (if (i32.eqz (local.get $buf)) (then (return (i32.const 0))))
    (i32.store (i32.add (local.get $rec) (i32.const 40)) (local.get $buf))
    (i32.store (i32.add (local.get $rec) (i32.const 44)) (global.get $VSOCK_RX_CAP))
    (i32.store (i32.add (local.get $rec) (i32.const 48)) (i32.const 0))
    (i32.store (i32.add (local.get $rec) (i32.const 52)) (i32.const 0))
    (i32.const 1))

  ;; Bytes this record can still accept into its receive ring.
  (func $vsock_rx_space (param $idx i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (i32.sub (i32.load (i32.add (local.get $rec) (i32.const 44)))
             (i32.load (i32.add (local.get $rec) (i32.const 52)))))

  ;; Append n bytes of guest memory at src_ga into idx's receive ring.
  (func $vsock_ring_write (param $idx i32) (param $src_ga i32) (param $n i32)
    (local $rec i32) (local $buf i32) (local $cap i32) (local $head i32)
    (local $len i32) (local $pos i32) (local $i i32)
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (local.set $buf (call $g2w (i32.load (i32.add (local.get $rec) (i32.const 40)))))
    (local.set $cap (i32.load (i32.add (local.get $rec) (i32.const 44))))
    (local.set $head (i32.load (i32.add (local.get $rec) (i32.const 48))))
    (local.set $len (i32.load (i32.add (local.get $rec) (i32.const 52))))
    (local.set $i (i32.const 0))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $pos (i32.add (local.get $head) (i32.add (local.get $len) (local.get $i))))
      (local.set $pos (i32.rem_u (local.get $pos) (local.get $cap)))
      (i32.store8 (i32.add (local.get $buf) (local.get $pos))
        (i32.load8_u (call $g2w (i32.add (local.get $src_ga) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.store (i32.add (local.get $rec) (i32.const 52))
      (i32.add (local.get $len) (local.get $n))))

  ;; Remove up to n bytes from idx's ring into guest memory at dst_ga.
  (func $vsock_ring_read (param $idx i32) (param $dst_ga i32) (param $n i32) (result i32)
    (local $rec i32) (local $buf i32) (local $cap i32) (local $head i32)
    (local $len i32) (local $i i32)
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (local.set $len (i32.load (i32.add (local.get $rec) (i32.const 52))))
    (if (i32.lt_u (local.get $len) (local.get $n))
      (then (local.set $n (local.get $len))))
    (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
    (local.set $buf (call $g2w (i32.load (i32.add (local.get $rec) (i32.const 40)))))
    (local.set $cap (i32.load (i32.add (local.get $rec) (i32.const 44))))
    (local.set $head (i32.load (i32.add (local.get $rec) (i32.const 48))))
    (local.set $i (i32.const 0))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (i32.store8 (call $g2w (i32.add (local.get $dst_ga) (local.get $i)))
        (i32.load8_u (i32.add (local.get $buf)
          (i32.rem_u (i32.add (local.get $head) (local.get $i)) (local.get $cap)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.store (i32.add (local.get $rec) (i32.const 48))
      (i32.rem_u (i32.add (local.get $head) (local.get $n)) (local.get $cap)))
    (i32.store (i32.add (local.get $rec) (i32.const 52))
      (i32.sub (local.get $len) (local.get $n)))
    (local.get $n))

  ;; Release a record and notify its peer. graceful=0 delivers a reset.
  (func $vsock_destroy (param $idx i32) (param $graceful i32)
    (local $rec i32) (local $peer i32) (local $prec i32) (local $buf i32)
    (local $i i32) (local $child i32)
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (if (i32.eqz (i32.load (local.get $rec))) (then (return)))
    ;; A listener drops every connection still waiting in its backlog.
    (if (i32.eq (i32.load (local.get $rec)) (i32.const 3))
      (then
        (local.set $i (i32.const 0))
        (block $ad (loop $al
          (br_if $ad (i32.ge_u (local.get $i) (i32.load (i32.add (local.get $rec) (i32.const 64)))))
          (local.set $child (i32.load (i32.add (local.get $rec)
            (i32.add (i32.const 68) (i32.mul (local.get $i) (i32.const 4))))))
          (call $vsock_destroy (local.get $child) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $al)))
        (i32.store (i32.add (local.get $rec) (i32.const 64)) (i32.const 0))))
    (local.set $peer (i32.load (i32.add (local.get $rec) (i32.const 32))))
    ;; A peer in another process learns about the close from the wire. The
    ;; same graceful/abortive split applies: FIN after shutdown, RST when
    ;; the write half was still open.
    (if (i32.eq (local.get $peer) (i32.const -2))
      (then
        (drop (call $vsock_emit_from (local.get $idx)
          (if (result i32) (local.get $graceful) (then (i32.const 4)) (else (i32.const 5)))
          (i32.const 0) (i32.const 0)))))
    (if (i32.ge_s (local.get $peer) (i32.const 0))
      (then
        (local.set $prec (call $vsock_rec (local.get $peer)))
        (if (i32.load (local.get $prec))
          (then
            (i32.store (i32.add (local.get $prec) (i32.const 32)) (i32.const -1))
            (i32.store (i32.add (local.get $prec) (i32.const 56))
              (i32.or (i32.load (i32.add (local.get $prec) (i32.const 56)))
                (if (result i32) (local.get $graceful)
                  (then (i32.const 1))     ;; orderly EOF for the reader
                  (else (i32.const 5)))))))))  ;; read-closed + reset
    (local.set $buf (i32.load (i32.add (local.get $rec) (i32.const 40))))
    (if (local.get $buf) (then (call $heap_free (local.get $buf))))
    (i32.store (local.get $rec) (i32.const 0))
    (i32.store (i32.add (local.get $rec) (i32.const 40)) (i32.const 0))
    (i32.store (i32.add (local.get $rec) (i32.const 32)) (i32.const -1)))

  ;; ---- readiness ------------------------------------------------------

  ;; Read-ready: queued bytes, an orderly EOF, a reset, or a listener with
  ;; a nonempty accept queue.
  (func $vsock_read_ready (param $idx i32) (result i32)
    (local $rec i32) (local $st i32)
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (local.set $st (i32.load (local.get $rec)))
    (if (i32.eq (local.get $st) (i32.const 3))
      (then (return (i32.gt_u (i32.load (i32.add (local.get $rec) (i32.const 64))) (i32.const 0)))))
    (if (i32.gt_u (i32.load (i32.add (local.get $rec) (i32.const 52))) (i32.const 0))
      (then (return (i32.const 1))))
    (i32.ne (i32.and (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 5))
            (i32.const 0)))

  ;; Write-ready: a connected stream whose write half is open and whose
  ;; peer can still take bytes.
  (func $vsock_write_ready (param $idx i32) (result i32)
    (local $rec i32) (local $peer i32)
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (if (i32.ne (i32.load (local.get $rec)) (i32.const 4))
      (then (return (i32.const 0))))
    (if (i32.and (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 2))
      (then (return (i32.const 0))))
    (local.set $peer (i32.load (i32.add (local.get $rec) (i32.const 32))))
    ;; A remote peer has no visible ring here; the wire carries the bytes and
    ;; reports its own backpressure when the frame is handed over.
    (if (i32.eq (local.get $peer) (i32.const -2)) (then (return (i32.const 1))))
    (if (i32.lt_s (local.get $peer) (i32.const 0)) (then (return (i32.const 0))))
    (i32.gt_u (call $vsock_rx_space (local.get $peer)) (i32.const 0)))

  (func $vsock_except_ready (param $idx i32) (result i32)
    (i32.ne (i32.and (i32.load (i32.add (call $vsock_rec (local.get $idx)) (i32.const 56)))
                     (i32.const 4))
            (i32.const 0)))

  ;; ---- the wire -------------------------------------------------------
  ;;
  ;; Everything above is one process's half of the room. A second process
  ;; has its own table at its own address, so the two halves meet over a
  ;; frame wire that the host merely carries — the host never inspects a
  ;; port, tracks a connection, or decides a route. Frames are broadcast to
  ;; the room and each process keeps only what is addressed to it, which is
  ;; how a LAN segment behaves and keeps the routing decision in WAT.
  ;;
  ;; Frame layout (28-byte header, then payload):
  ;;   +0  magic 'VLN1'   +4  type   +8  src_ip   +12 src_port
  ;;   +16 dst_ip         +20 dst_port           +24 payload length
  ;;
  ;; Types: 1 SYN (open), 2 SYNACK (accepted), 3 DATA, 4 FIN (orderly write
  ;; close), 5 RST (refused or aborted).

  (global $VLN_MAGIC i32 (i32.const 0x314E4C56))
  (global $VLN_HDR i32 (i32.const 28))
  (global $VLN_MAX_PAYLOAD i32 (i32.const 4096))
  (global $vsock_frame_buf (mut i32) (i32.const 0))

  ;; Scratch frame buffer, allocated once. Returns its WASM address, or 0
  ;; when the heap is exhausted.
  (func $vsock_frame_wa (result i32)
    (if (i32.eqz (global.get $vsock_frame_buf))
      (then (global.set $vsock_frame_buf (call $heap_alloc
        (i32.add (global.get $VLN_HDR) (global.get $VLN_MAX_PAYLOAD))))))
    (if (i32.eqz (global.get $vsock_frame_buf)) (then (return (i32.const 0))))
    (call $g2w (global.get $vsock_frame_buf)))

  ;; An address this process answers for: its own room address, loopback,
  ;; or the unspecified address.
  (func $vsock_is_local_addr (param $ip i32) (result i32)
    (if (i32.eqz (local.get $ip)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $ip) (global.get $vsock_local_ip)) (then (return (i32.const 1))))
    (i32.eq (i32.and (local.get $ip) (i32.const 0xFF000000)) (i32.const 0x7F000000)))

  ;; Build a frame and hand it to the wire. Returns 1 when the wire took it,
  ;; 0 when its queue is full (the caller must retry, never drop).
  (func $vsock_emit (param $type i32) (param $src_ip i32) (param $src_port i32)
                    (param $dst_ip i32) (param $dst_port i32)
                    (param $payload_ga i32) (param $len i32) (result i32)
    (local $wa i32) (local $i i32)
    (local.set $wa (call $vsock_frame_wa))
    (if (i32.eqz (local.get $wa)) (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $len) (global.get $VLN_MAX_PAYLOAD))
      (then (local.set $len (global.get $VLN_MAX_PAYLOAD))))
    (i32.store (local.get $wa) (global.get $VLN_MAGIC))
    (i32.store (i32.add (local.get $wa) (i32.const 4))  (local.get $type))
    (i32.store (i32.add (local.get $wa) (i32.const 8))  (local.get $src_ip))
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (local.get $src_port))
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (local.get $dst_ip))
    (i32.store (i32.add (local.get $wa) (i32.const 20)) (local.get $dst_port))
    (i32.store (i32.add (local.get $wa) (i32.const 24)) (local.get $len))
    (local.set $i (i32.const 0))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $wa) (i32.add (global.get $VLN_HDR) (local.get $i)))
        (i32.load8_u (call $g2w (i32.add (local.get $payload_ga) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (call $host_net_frame_send (local.get $wa)
      (i32.add (global.get $VLN_HDR) (local.get $len))))

  ;; Emit a frame from a record's own endpoints.
  (func $vsock_emit_from (param $idx i32) (param $type i32)
                         (param $payload_ga i32) (param $len i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (call $vsock_emit (local.get $type)
      (i32.load (i32.add (local.get $rec) (i32.const 16)))
      (i32.load (i32.add (local.get $rec) (i32.const 20)))
      (i32.load (i32.add (local.get $rec) (i32.const 24)))
      (i32.load (i32.add (local.get $rec) (i32.const 28)))
      (local.get $payload_ga) (local.get $len)))

  ;; Find a record in the given state whose remote endpoint and local port
  ;; match an inbound frame. Only remote-peered records are candidates.
  (func $vsock_find_conn (param $state i32) (param $lport i32)
                         (param $rip i32) (param $rport i32) (result i32)
    (local $i i32) (local $rec i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $VSOCK_MAX)))
      (local.set $rec (call $vsock_rec (local.get $i)))
      (if (i32.and
            (i32.eq (i32.load (local.get $rec)) (local.get $state))
            (i32.eq (i32.load (i32.add (local.get $rec) (i32.const 32))) (i32.const -2)))
        (then
          (if (i32.and
                (i32.eq (i32.load (i32.add (local.get $rec) (i32.const 20))) (local.get $lport))
                (i32.and
                  (i32.eq (i32.load (i32.add (local.get $rec) (i32.const 24))) (local.get $rip))
                  (i32.eq (i32.load (i32.add (local.get $rec) (i32.const 28))) (local.get $rport))))
            (then (return (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Accept an inbound SYN into the matching listener's backlog.
  ;; Returns 1 once the frame has been consumed, either by opening a
  ;; connection or by refusing it.
  (func $vsock_deliver_syn (param $sip i32) (param $sport i32)
                           (param $dip i32) (param $dport i32) (result i32)
    (local $lis i32) (local $lrec i32) (local $child i32) (local $crec i32)
    (local.set $lis (call $vsock_find_listener (local.get $dip) (local.get $dport)))
    (if (i32.lt_s (local.get $lis) (i32.const 0))
      (then
        (drop (call $vsock_emit (i32.const 5) (local.get $dip) (local.get $dport)
                (local.get $sip) (local.get $sport) (i32.const 0) (i32.const 0)))
        (return (i32.const 1))))
    (local.set $lrec (call $vsock_rec (local.get $lis)))
    (if (i32.ge_u (i32.load (i32.add (local.get $lrec) (i32.const 64)))
                  (i32.load (i32.add (local.get $lrec) (i32.const 60))))
      (then
        ;; Backlog full. A real stack drops the SYN and lets the peer retry;
        ;; here the wire is lossless, so refuse explicitly instead.
        (drop (call $vsock_emit (i32.const 5) (local.get $dip) (local.get $dport)
                (local.get $sip) (local.get $sport) (i32.const 0) (i32.const 0)))
        (return (i32.const 1))))
    (local.set $child (call $vsock_alloc))
    (if (i32.lt_s (local.get $child) (i32.const 0))
      (then
        (drop (call $vsock_emit (i32.const 5) (local.get $dip) (local.get $dport)
                (local.get $sip) (local.get $sport) (i32.const 0) (i32.const 0)))
        (return (i32.const 1))))
    (local.set $crec (call $vsock_rec (local.get $child)))
    (i32.store (local.get $crec) (i32.const 4))
    (i32.store (i32.add (local.get $crec) (i32.const 4)) (i32.const 2))
    (i32.store (i32.add (local.get $crec) (i32.const 8)) (i32.const 1))
    (i32.store (i32.add (local.get $crec) (i32.const 16)) (local.get $dip))
    (i32.store (i32.add (local.get $crec) (i32.const 20)) (local.get $dport))
    (i32.store (i32.add (local.get $crec) (i32.const 24)) (local.get $sip))
    (i32.store (i32.add (local.get $crec) (i32.const 28)) (local.get $sport))
    (i32.store (i32.add (local.get $crec) (i32.const 32)) (i32.const -2))
    (if (i32.eqz (call $vsock_alloc_ring (local.get $child)))
      (then
        (i32.store (local.get $crec) (i32.const 0))
        (drop (call $vsock_emit (i32.const 5) (local.get $dip) (local.get $dport)
                (local.get $sip) (local.get $sport) (i32.const 0) (i32.const 0)))
        (return (i32.const 1))))
    (i32.store (i32.add (local.get $lrec)
      (i32.add (i32.const 68)
        (i32.mul (i32.load (i32.add (local.get $lrec) (i32.const 64))) (i32.const 4))))
      (local.get $child))
    (i32.store (i32.add (local.get $lrec) (i32.const 64))
      (i32.add (i32.load (i32.add (local.get $lrec) (i32.const 64))) (i32.const 1)))
    (drop (call $vsock_emit (i32.const 2) (local.get $dip) (local.get $dport)
            (local.get $sip) (local.get $sport) (i32.const 0) (i32.const 0)))
    (i32.const 1))

  ;; Apply one inbound frame. Returns 1 when the frame has been consumed and
  ;; 0 when it must stay queued because the destination ring is full — a
  ;; byte stream may reorder nothing and lose nothing.
  (func $vsock_deliver (param $type i32) (param $sip i32) (param $sport i32)
                       (param $dip i32) (param $dport i32) (param $plen i32) (result i32)
    (local $idx i32) (local $rec i32)
    ;; Not ours: the wire is a broadcast segment, so silently ignore.
    (if (i32.eqz (call $vsock_is_local_addr (local.get $dip)))
      (then (return (i32.const 1))))
    (if (i32.eq (local.get $type) (i32.const 1))
      (then (return (call $vsock_deliver_syn (local.get $sip) (local.get $sport)
                      (local.get $dip) (local.get $dport)))))
    (if (i32.eq (local.get $type) (i32.const 2))
      (then
        (local.set $idx (call $vsock_find_conn (i32.const 6) (local.get $dport)
                          (local.get $sip) (local.get $sport)))
        (if (i32.ge_s (local.get $idx) (i32.const 0))
          (then
            (i32.store (call $vsock_rec (local.get $idx)) (i32.const 4))
            ;; The connection completed. Winsock reports FD_WRITE alongside
            ;; FD_CONNECT, because a freshly connected socket is writable and
            ;; that first edge is the only one an app will ever get.
            (call $vsock_async_post (local.get $idx) (i32.const 0x10) (i32.const 0))
            (call $vsock_async_post (local.get $idx) (i32.const 0x02) (i32.const 0))))
        (return (i32.const 1))))
    ;; DATA/FIN/RST target an established connection. A refusal can also
    ;; arrive while the local half is still in the connecting state, which
    ;; is how `connect` learns it was rejected.
    (local.set $idx (call $vsock_find_conn (i32.const 4) (local.get $dport)
                      (local.get $sip) (local.get $sport)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then (local.set $idx (call $vsock_find_conn (i32.const 6) (local.get $dport)
                              (local.get $sip) (local.get $sport)))))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        ;; Unknown connection. A stray reset is already the terminal state;
        ;; anything else is addressed to a socket that no longer exists, and
        ;; TCP answers that with a reset rather than silence.
        (if (i32.ne (local.get $type) (i32.const 5))
          (then
            (drop (call $vsock_emit (i32.const 5) (local.get $dip) (local.get $dport)
                    (local.get $sip) (local.get $sport) (i32.const 0) (i32.const 0)))))
        (return (i32.const 1))))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (if (i32.eq (local.get $type) (i32.const 3))
      (then
        (if (i32.lt_u (call $vsock_rx_space (local.get $idx)) (local.get $plen))
          (then (return (i32.const 0))))
        (call $vsock_ring_write (local.get $idx)
          (i32.add (global.get $vsock_frame_buf) (global.get $VLN_HDR))
          (local.get $plen))
        (call $vsock_async_post (local.get $idx) (i32.const 0x01) (i32.const 0))
        (return (i32.const 1))))
    (if (i32.eq (local.get $type) (i32.const 4))
      (then
        (i32.store (i32.add (local.get $rec) (i32.const 56))
          (i32.or (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 1)))
        (call $vsock_async_post (local.get $idx) (i32.const 0x20) (i32.const 0))
        (return (i32.const 1))))
    (if (i32.eq (local.get $type) (i32.const 5))
      (then
        (i32.store (i32.add (local.get $rec) (i32.const 56))
          (i32.or (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 5)))
        (i32.store (i32.add (local.get $rec) (i32.const 32)) (i32.const -1))
        ;; A reset before the connection came up is a failed connect, and the
        ;; app learns the reason from the error half of lParam rather than
        ;; from a close it never opened.
        (if (i32.eq (i32.load (local.get $rec)) (i32.const 6))
          (then (call $vsock_async_post (local.get $idx) (i32.const 0x10) (i32.const 10061)))
          (else (call $vsock_async_post (local.get $idx) (i32.const 0x20) (i32.const 10054))))
        (return (i32.const 1))))
    (i32.const 1))

  ;; Drain the wire into this process's sockets. Safe to call on every
  ;; socket entry point: an empty wire costs one host call.
  (func $vsock_pump
    (local $wa i32) (local $n i32) (local $guard i32)
    (local.set $wa (call $vsock_frame_wa))
    (if (i32.eqz (local.get $wa)) (then (return)))
    (local.set $guard (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $guard) (i32.const 256)))
      (local.set $guard (i32.add (local.get $guard) (i32.const 1)))
      (local.set $n (call $host_net_frame_peek (local.get $wa)
        (i32.add (global.get $VLN_HDR) (global.get $VLN_MAX_PAYLOAD))))
      (br_if $done (i32.eqz (local.get $n)))
      ;; Fail closed on anything that is not a well-formed vln/1 frame:
      ;; too short, too long for the buffer, or wrong magic.
      (if (i32.or
            (i32.lt_s (local.get $n) (i32.const 0))
            (i32.or
              (i32.lt_u (local.get $n) (global.get $VLN_HDR))
              (i32.ne (i32.load (local.get $wa)) (global.get $VLN_MAGIC))))
        (then (call $host_net_frame_commit) (br $next)))
      (if (i32.ne (i32.load (i32.add (local.get $wa) (i32.const 24)))
                  (i32.sub (local.get $n) (global.get $VLN_HDR)))
        (then (call $host_net_frame_commit) (br $next)))
      (if (i32.eqz (call $vsock_deliver
            (i32.load (i32.add (local.get $wa) (i32.const 4)))
            (i32.load (i32.add (local.get $wa) (i32.const 8)))
            (i32.load (i32.add (local.get $wa) (i32.const 12)))
            (i32.load (i32.add (local.get $wa) (i32.const 16)))
            (i32.load (i32.add (local.get $wa) (i32.const 20)))
            (i32.load (i32.add (local.get $wa) (i32.const 24)))))
        ;; Undeliverable for now — leave it at the head of the wire so the
        ;; stream keeps its order once the reader drains its ring.
        (then (br $done)))
      (call $host_net_frame_commit)
      (br $next))))

  ;; Park the current API call. The handler has already dropped its stdcall
  ;; frame, so put those bytes back: EIP still points at the thunk, and the
  ;; host re-enters this same handler with the same arguments once the wire
  ;; has moved.
  (func $vsock_block (param $unpop i32)
    (global.set $esp (i32.sub (global.get $esp) (local.get $unpop)))
    (global.set $yield_reason (i32.const 8))
    (global.set $yield_flag (i32.const 1))
    (global.set $steps (i32.const 0)))

  ;; ---- handlers -------------------------------------------------------

  ;; socket(af, type, protocol)
  (func $handle_socket (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                       (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (if (i32.ne (local.get $arg0) (i32.const 2))          ;; AF_INET only
      (then
        (call $vsock_set_error (i32.const 10047))          ;; WSAEAFNOSUPPORT
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.ne (local.get $arg1) (i32.const 1))          ;; SOCK_STREAM only
      (then
        (call $vsock_set_error (i32.const 10044))          ;; WSAESOCKTNOSUPPORT
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.and (i32.ne (local.get $arg2) (i32.const 0))
                 (i32.ne (local.get $arg2) (i32.const 6))) ;; IPPROTO_TCP
      (then
        (call $vsock_set_error (i32.const 10043))          ;; WSAEPROTONOSUPPORT
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $idx (call $vsock_alloc))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10024))          ;; WSAEMFILE
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (i32.store (local.get $rec) (i32.const 1))
    (i32.store (i32.add (local.get $rec) (i32.const 4)) (local.get $arg0))
    (i32.store (i32.add (local.get $rec) (i32.const 8)) (local.get $arg1))
    (i32.store (i32.add (local.get $rec) (i32.const 12)) (local.get $arg2))
    (global.set $eax (call $vsock_handle (local.get $idx))))

  ;; bind(s, name, namelen)
  (func $handle_bind (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                     (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $ip i32) (local $port i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))          ;; WSAENOTSOCK
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (if (i32.ne (i32.load (local.get $rec)) (i32.const 1))
      (then
        (call $vsock_set_error (i32.const 10022))          ;; WSAEINVAL
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.eqz (call $vsock_read_sockaddr (local.get $arg1) (local.get $arg2)))
      (then
        (call $vsock_set_error (i32.const 10047))          ;; WSAEAFNOSUPPORT
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $ip (global.get $vsock_sa_ip))
    (local.set $port (global.get $vsock_sa_port))
    ;; INADDR_ANY binds the room address; anything else must be in-room.
    (if (i32.and (i32.ne (local.get $ip) (i32.const 0))
                 (i32.eqz (call $vsock_addr_in_room (local.get $ip))))
      (then
        (call $vsock_set_error (i32.const 10049))          ;; WSAEADDRNOTAVAIL
        (global.set $eax (i32.const -1))
        (return)))
    ;; Resolve INADDR_ANY now, not at send time. A process owns exactly one
    ;; room address, so "any" is that address — and every later step compares
    ;; against a concrete one: the port-in-use check, the destination match in
    ;; $vsock_deliver, and the source address of every frame this socket
    ;; emits. Leaving the 0 in place makes a listener unreachable and makes a
    ;; connector send from 0.0.0.0, which no peer can answer.
    (if (i32.eqz (local.get $ip))
      (then (local.set $ip (global.get $vsock_local_ip))))
    (if (i32.eqz (local.get $port))
      (then (local.set $port (call $vsock_alloc_port)))
      (else
        (if (call $vsock_port_taken (local.get $ip) (local.get $port))
          (then
            (call $vsock_set_error (i32.const 10048))      ;; WSAEADDRINUSE
            (global.set $eax (i32.const -1))
            (return)))))
    (i32.store (i32.add (local.get $rec) (i32.const 16)) (local.get $ip))
    (i32.store (i32.add (local.get $rec) (i32.const 20)) (local.get $port))
    (i32.store (local.get $rec) (i32.const 2))
    (global.set $eax (i32.const 0)))

  ;; listen(s, backlog)
  (func $handle_listen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                       (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $bl i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    ;; A listener must already own an address.
    (if (i32.ne (i32.load (local.get $rec)) (i32.const 2))
      (then
        (call $vsock_set_error (i32.const 10022))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $bl (local.get $arg1))
    (if (i32.lt_s (local.get $bl) (i32.const 1)) (then (local.set $bl (i32.const 1))))
    (if (i32.gt_s (local.get $bl) (i32.const 15)) (then (local.set $bl (i32.const 15))))
    (i32.store (i32.add (local.get $rec) (i32.const 60)) (local.get $bl))
    (i32.store (local.get $rec) (i32.const 3))
    (global.set $eax (i32.const 0)))

  ;; connect(s, name, namelen)
  (func $handle_connect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                        (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $ip i32) (local $port i32)
    (local $lis i32) (local $lrec i32) (local $child i32) (local $crec i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (call $vsock_pump)
    ;; Re-entry: a SYN is already outstanding for this socket, either
    ;; because a blocking connect parked here or because a nonblocking one
    ;; is being polled.
    (if (i32.and (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 8))
      (then
        (if (i32.eq (i32.load (local.get $rec)) (i32.const 4))
          (then
            (i32.store (i32.add (local.get $rec) (i32.const 56))
              (i32.and (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const -9)))
            (global.set $eax (i32.const 0))
            (return)))
        (if (i32.and (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 4))
          (then
            ;; Refused. Put the socket back where it was so the guest can
            ;; bind or connect it again.
            (i32.store (i32.add (local.get $rec) (i32.const 56)) (i32.const 0))
            (i32.store (i32.add (local.get $rec) (i32.const 32)) (i32.const -1))
            (i32.store (i32.add (local.get $rec) (i32.const 24)) (i32.const 0))
            (i32.store (i32.add (local.get $rec) (i32.const 28)) (i32.const 0))
            (i32.store (local.get $rec) (i32.const 2))
            (call $vsock_set_error (i32.const 10061))      ;; WSAECONNREFUSED
            (global.set $eax (i32.const -1))
            (return)))
        (if (i32.load (i32.add (local.get $rec) (i32.const 36)))
          (then
            (call $vsock_set_error (i32.const 10037))      ;; WSAEALREADY
            (global.set $eax (i32.const -1))
            (return)))
        (call $vsock_block (i32.const 16))
        (return)))
    (if (i32.eq (i32.load (local.get $rec)) (i32.const 4))
      (then
        (call $vsock_set_error (i32.const 10056))          ;; WSAEISCONN
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.gt_u (i32.load (local.get $rec)) (i32.const 2))
      (then
        (call $vsock_set_error (i32.const 10022))
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.eqz (call $vsock_read_sockaddr (local.get $arg1) (local.get $arg2)))
      (then
        (call $vsock_set_error (i32.const 10047))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $ip (global.get $vsock_sa_ip))
    (local.set $port (global.get $vsock_sa_port))
    ;; Isolation boundary: only room addresses are routable.
    (if (i32.eqz (call $vsock_addr_in_room (local.get $ip)))
      (then
        (call $vsock_set_error (i32.const 10051))          ;; WSAENETUNREACH
        (global.set $eax (i32.const -1))
        (return)))
    ;; An unbound connector picks up an ephemeral room address before the
    ;; route is chosen, because either path needs a source endpoint.
    (if (i32.eq (i32.load (local.get $rec)) (i32.const 1))
      (then
        (i32.store (i32.add (local.get $rec) (i32.const 16)) (global.get $vsock_local_ip))
        (i32.store (i32.add (local.get $rec) (i32.const 20)) (call $vsock_alloc_port))))
    ;; A destination this process does not answer for goes out on the wire.
    (if (i32.eqz (call $vsock_is_local_addr (local.get $ip)))
      (then
        (i32.store (i32.add (local.get $rec) (i32.const 24)) (local.get $ip))
        (i32.store (i32.add (local.get $rec) (i32.const 28)) (local.get $port))
        (i32.store (i32.add (local.get $rec) (i32.const 32)) (i32.const -2))
        (if (i32.eqz (call $vsock_alloc_ring (local.get $idx)))
          (then
            (i32.store (i32.add (local.get $rec) (i32.const 24)) (i32.const 0))
            (i32.store (i32.add (local.get $rec) (i32.const 28)) (i32.const 0))
            (i32.store (i32.add (local.get $rec) (i32.const 32)) (i32.const -1))
            (call $vsock_set_error (i32.const 10055))      ;; WSAENOBUFS
            (global.set $eax (i32.const -1))
            (return)))
        (if (i32.eqz (call $vsock_emit_from (local.get $idx) (i32.const 1)
                       (i32.const 0) (i32.const 0)))
          (then
            ;; The wire could not take the SYN. Roll the socket back so the
            ;; retry emits a fresh one rather than waiting on a lost frame.
            (i32.store (i32.add (local.get $rec) (i32.const 24)) (i32.const 0))
            (i32.store (i32.add (local.get $rec) (i32.const 28)) (i32.const 0))
            (i32.store (i32.add (local.get $rec) (i32.const 32)) (i32.const -1))
            (if (i32.load (i32.add (local.get $rec) (i32.const 36)))
              (then
                (call $vsock_set_error (i32.const 10035))  ;; WSAEWOULDBLOCK
                (global.set $eax (i32.const -1))
                (return)))
            (call $vsock_block (i32.const 16))
            (return)))
        (i32.store (local.get $rec) (i32.const 6))
        (i32.store (i32.add (local.get $rec) (i32.const 56))
          (i32.or (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 8)))
        (if (i32.load (i32.add (local.get $rec) (i32.const 36)))
          (then
            (call $vsock_set_error (i32.const 10035))      ;; WSAEWOULDBLOCK
            (global.set $eax (i32.const -1))
            (return)))
        (call $vsock_block (i32.const 16))
        (return)))
    (local.set $lis (call $vsock_find_listener (local.get $ip) (local.get $port)))
    (if (i32.lt_s (local.get $lis) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10061))          ;; WSAECONNREFUSED
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $lrec (call $vsock_rec (local.get $lis)))
    (if (i32.ge_u (i32.load (i32.add (local.get $lrec) (i32.const 64)))
                  (i32.load (i32.add (local.get $lrec) (i32.const 60))))
      (then
        (call $vsock_set_error (i32.const 10061))          ;; backlog full
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $child (call $vsock_alloc))
    (if (i32.lt_s (local.get $child) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10024))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $crec (call $vsock_rec (local.get $child)))
    ;; Server half: inherits the listener's address, points back at the
    ;; connector.
    (i32.store (local.get $crec) (i32.const 4))
    (i32.store (i32.add (local.get $crec) (i32.const 4)) (i32.const 2))
    (i32.store (i32.add (local.get $crec) (i32.const 8)) (i32.const 1))
    (i32.store (i32.add (local.get $crec) (i32.const 16)) (local.get $ip))
    (i32.store (i32.add (local.get $crec) (i32.const 20)) (local.get $port))
    (i32.store (i32.add (local.get $crec) (i32.const 24))
      (i32.load (i32.add (local.get $rec) (i32.const 16))))
    (i32.store (i32.add (local.get $crec) (i32.const 28))
      (i32.load (i32.add (local.get $rec) (i32.const 20))))
    (i32.store (i32.add (local.get $crec) (i32.const 32)) (local.get $idx))
    ;; Client half.
    (i32.store (i32.add (local.get $rec) (i32.const 24)) (local.get $ip))
    (i32.store (i32.add (local.get $rec) (i32.const 28)) (local.get $port))
    (i32.store (i32.add (local.get $rec) (i32.const 32)) (local.get $child))
    (i32.store (local.get $rec) (i32.const 4))
    (if (i32.eqz (i32.and (call $vsock_alloc_ring (local.get $idx))
                          (call $vsock_alloc_ring (local.get $child))))
      (then
        (call $vsock_destroy (local.get $child) (i32.const 0))
        (i32.store (i32.add (local.get $rec) (i32.const 32)) (i32.const -1))
        (i32.store (local.get $rec) (i32.const 2))
        (call $vsock_set_error (i32.const 10055))          ;; WSAENOBUFS
        (global.set $eax (i32.const -1))
        (return)))
    ;; OPEN_OK: the connection is in the backlog, not yet accepted.
    (i32.store (i32.add (local.get $lrec)
      (i32.add (i32.const 68)
        (i32.mul (i32.load (i32.add (local.get $lrec) (i32.const 64))) (i32.const 4))))
      (local.get $child))
    (i32.store (i32.add (local.get $lrec) (i32.const 64))
      (i32.add (i32.load (i32.add (local.get $lrec) (i32.const 64))) (i32.const 1)))
    (global.set $eax (i32.const 0)))

  ;; accept(s, addr, addrlen)
  (func $handle_accept (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                       (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $child i32) (local $crec i32)
    (local $i i32) (local $n i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (if (i32.ne (i32.load (local.get $rec)) (i32.const 3))
      (then
        (call $vsock_set_error (i32.const 10022))
        (global.set $eax (i32.const -1))
        (return)))
    (call $vsock_pump)
    (local.set $n (i32.load (i32.add (local.get $rec) (i32.const 64))))
    (if (i32.eqz (local.get $n))
      (then
        ;; A blocking accept parks until the wire delivers a SYN.
        (if (i32.eqz (i32.load (i32.add (local.get $rec) (i32.const 36))))
          (then (call $vsock_block (i32.const 16)) (return)))
        (call $vsock_set_error (i32.const 10035))          ;; WSAEWOULDBLOCK
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $child (i32.load (i32.add (local.get $rec) (i32.const 68))))
    ;; Shift the remaining backlog down one slot.
    (local.set $i (i32.const 1))
    (block $sd (loop $sh
      (br_if $sd (i32.ge_u (local.get $i) (local.get $n)))
      (i32.store (i32.add (local.get $rec)
        (i32.add (i32.const 68) (i32.mul (i32.sub (local.get $i) (i32.const 1)) (i32.const 4))))
        (i32.load (i32.add (local.get $rec)
          (i32.add (i32.const 68) (i32.mul (local.get $i) (i32.const 4))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sh)))
    (i32.store (i32.add (local.get $rec) (i32.const 64)) (i32.sub (local.get $n) (i32.const 1)))
    (local.set $crec (call $vsock_rec (local.get $child)))
    (call $vsock_write_sockaddr (local.get $arg1) (local.get $arg2)
      (i32.load (i32.add (local.get $crec) (i32.const 24)))
      (i32.load (i32.add (local.get $crec) (i32.const 28))))
    (global.set $eax (call $vsock_handle (local.get $child))))

  ;; send(s, buf, len, flags) — a partial count is a legal TCP result.
  (func $handle_send (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                     (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $peer i32) (local $space i32) (local $n i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (call $vsock_pump)
    (if (i32.ne (i32.load (local.get $rec)) (i32.const 4))
      (then
        (call $vsock_set_error (i32.const 10057))          ;; WSAENOTCONN
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.and (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 2))
      (then
        (call $vsock_set_error (i32.const 10058))          ;; WSAESHUTDOWN
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $peer (i32.load (i32.add (local.get $rec) (i32.const 32))))
    ;; A peer in another process takes bytes as wire frames. One send
    ;; produces at most one frame, so a large write returns a partial count
    ;; — which a stream socket is always allowed to do.
    (if (i32.eq (local.get $peer) (i32.const -2))
      (then
        (if (i32.eqz (local.get $arg2))
          (then (global.set $eax (i32.const 0)) (return)))
        (local.set $n (local.get $arg2))
        (if (i32.gt_u (local.get $n) (global.get $VLN_MAX_PAYLOAD))
          (then (local.set $n (global.get $VLN_MAX_PAYLOAD))))
        (if (i32.eqz (call $vsock_emit_from (local.get $idx) (i32.const 3)
                       (local.get $arg1) (local.get $n)))
          (then
            (if (i32.eqz (i32.load (i32.add (local.get $rec) (i32.const 36))))
              (then (call $vsock_block (i32.const 20)) (return)))
            (call $vsock_set_error (i32.const 10035))
            (global.set $eax (i32.const -1))
            (return)))
        (global.set $eax (local.get $n))
        (return)))
    (if (i32.lt_s (local.get $peer) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10054))          ;; WSAECONNRESET
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.eqz (local.get $arg2))
      (then
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $space (call $vsock_rx_space (local.get $peer)))
    (if (i32.eqz (local.get $space))
      (then
        ;; The peer's ring is full; a blocking send waits for it to drain.
        (if (i32.eqz (i32.load (i32.add (local.get $rec) (i32.const 36))))
          (then (call $vsock_block (i32.const 20)) (return)))
        (call $vsock_set_error (i32.const 10035))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $n (local.get $arg2))
    (if (i32.gt_u (local.get $n) (local.get $space)) (then (local.set $n (local.get $space))))
    (call $vsock_ring_write (local.get $peer) (local.get $arg1) (local.get $n))
    (global.set $eax (local.get $n)))

  ;; recv(s, buf, len, flags) — returns any available prefix, 0 at EOF.
  (func $handle_recv (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                     (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $flags i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (call $vsock_pump)
    (if (i32.ne (i32.load (local.get $rec)) (i32.const 4))
      (then
        (call $vsock_set_error (i32.const 10057))
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.gt_u (i32.load (i32.add (local.get $rec) (i32.const 52))) (i32.const 0))
      (then
        (global.set $eax (call $vsock_ring_read (local.get $idx) (local.get $arg1) (local.get $arg2)))
        (return)))
    (local.set $flags (i32.load (i32.add (local.get $rec) (i32.const 56))))
    ;; A reset outranks an orderly EOF once the buffer has drained.
    (if (i32.and (local.get $flags) (i32.const 4))
      (then
        (call $vsock_set_error (i32.const 10054))
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.and (local.get $flags) (i32.const 1))
      (then
        (global.set $eax (i32.const 0))
        (return)))
    ;; Nothing buffered and neither half closed: a blocking recv waits.
    (if (i32.eqz (i32.load (i32.add (local.get $rec) (i32.const 36))))
      (then (call $vsock_block (i32.const 20)) (return)))
    (call $vsock_set_error (i32.const 10035))
    (global.set $eax (i32.const -1)))

  ;; shutdown(s, how) — 0 SD_RECEIVE, 1 SD_SEND, 2 SD_BOTH
  (func $handle_shutdown (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                         (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $peer i32) (local $prec i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (if (i32.ne (i32.load (local.get $rec)) (i32.const 4))
      (then
        (call $vsock_set_error (i32.const 10057))
        (global.set $eax (i32.const -1))
        (return)))
    (if (i32.ne (local.get $arg1) (i32.const 0))
      (then
        ;; SD_SEND / SD_BOTH close the write half and deliver FIN.
        (i32.store (i32.add (local.get $rec) (i32.const 56))
          (i32.or (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 2)))
        (local.set $peer (i32.load (i32.add (local.get $rec) (i32.const 32))))
        (if (i32.eq (local.get $peer) (i32.const -2))
          (then (drop (call $vsock_emit_from (local.get $idx) (i32.const 4)
                        (i32.const 0) (i32.const 0)))))
        (if (i32.ge_s (local.get $peer) (i32.const 0))
          (then
            (local.set $prec (call $vsock_rec (local.get $peer)))
            (i32.store (i32.add (local.get $prec) (i32.const 56))
              (i32.or (i32.load (i32.add (local.get $prec) (i32.const 56))) (i32.const 1)))))))
    (if (i32.ne (local.get $arg1) (i32.const 1))
      (then
        (i32.store (i32.add (local.get $rec) (i32.const 56))
          (i32.or (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 1)))))
    (global.set $eax (i32.const 0)))

  ;; closesocket(s)
  (func $handle_closesocket (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                            (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $graceful i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    ;; Closing after shutdown(SD_SEND) is orderly; closing with the write
    ;; half still open aborts, matching TCP's RST-on-unread-close behavior.
    (local.set $graceful
      (i32.ne (i32.and (i32.load (i32.add (local.get $rec) (i32.const 56))) (i32.const 2))
              (i32.const 0)))
    (call $vsock_destroy (local.get $idx) (local.get $graceful))
    (global.set $eax (i32.const 0)))

  ;; select(nfds, readfds, writefds, exceptfds, timeout)
  ;;
  ;; Counting and rewriting are separate passes. A select that is about to
  ;; block must leave the guest's fd_sets untouched, because the same call
  ;; is re-entered after the yield and would otherwise find the sets it had
  ;; already emptied.
  (func $vsock_filter_set (param $set_ga i32) (param $kind i32) (param $apply i32) (result i32)
    (local $wa i32) (local $count i32) (local $i i32) (local $out i32)
    (local $h i32) (local $idx i32) (local $ready i32)
    (if (i32.eqz (local.get $set_ga)) (then (return (i32.const 0))))
    (local.set $wa (call $g2w (local.get $set_ga)))
    (local.set $count (i32.load (local.get $wa)))
    (if (i32.gt_u (local.get $count) (i32.const 64)) (then (local.set $count (i32.const 64))))
    (local.set $i (i32.const 0))
    (local.set $out (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $h (i32.load (i32.add (local.get $wa)
        (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 4))))))
      (local.set $idx (call $vsock_index (local.get $h)))
      (local.set $ready (i32.const 0))
      (if (i32.ge_s (local.get $idx) (i32.const 0))
        (then
          (if (i32.eqz (local.get $kind))
            (then (local.set $ready (call $vsock_read_ready (local.get $idx)))))
          (if (i32.eq (local.get $kind) (i32.const 1))
            (then (local.set $ready (call $vsock_write_ready (local.get $idx)))))
          (if (i32.eq (local.get $kind) (i32.const 2))
            (then (local.set $ready (call $vsock_except_ready (local.get $idx)))))))
      (if (local.get $ready)
        (then
          (if (local.get $apply)
            (then
              (i32.store (i32.add (local.get $wa)
                (i32.add (i32.const 4) (i32.mul (local.get $out) (i32.const 4))))
                (local.get $h))))
          (local.set $out (i32.add (local.get $out) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (local.get $apply) (then (i32.store (local.get $wa) (local.get $out))))
    (local.get $out))

  ;; Milliseconds in a guest timeval, clamped to a day.
  (func $vsock_timeval_ms (param $tv_ga i32) (result i32)
    (local $wa i32) (local $sec i32) (local $usec i32)
    (local.set $wa (call $g2w (local.get $tv_ga)))
    (local.set $sec (i32.load (local.get $wa)))
    (local.set $usec (i32.load (i32.add (local.get $wa) (i32.const 4))))
    (if (i32.lt_s (local.get $sec) (i32.const 0)) (then (local.set $sec (i32.const 0))))
    (if (i32.lt_s (local.get $usec) (i32.const 0)) (then (local.set $usec (i32.const 0))))
    (if (i32.gt_u (local.get $sec) (i32.const 86400)) (then (local.set $sec (i32.const 86400))))
    (i32.add (i32.mul (local.get $sec) (i32.const 1000))
             (i32.div_u (local.get $usec) (i32.const 1000))))

  ;; A select waiting out a finite timeout. Only one can be outstanding,
  ;; because the guest thread is inside the call while it waits.
  (global $vsock_sel_waiting (mut i32) (i32.const 0))
  (global $vsock_sel_deadline (mut i32) (i32.const 0))

  (func $handle_select (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                       (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $total i32) (local $ms i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (call $vsock_pump)
    (local.set $total (call $vsock_filter_set (local.get $arg1) (i32.const 0) (i32.const 0)))
    (local.set $total (i32.add (local.get $total)
      (call $vsock_filter_set (local.get $arg2) (i32.const 1) (i32.const 0))))
    (local.set $total (i32.add (local.get $total)
      (call $vsock_filter_set (local.get $arg3) (i32.const 2) (i32.const 0))))
    (if (i32.eqz (local.get $total))
      (then
        ;; A NULL timeval waits until something becomes ready.
        (if (i32.eqz (local.get $arg4))
          (then (call $vsock_block (i32.const 24)) (return)))
        (local.set $ms (call $vsock_timeval_ms (local.get $arg4)))
        (if (local.get $ms)
          (then
            (if (i32.eqz (global.get $vsock_sel_waiting))
              (then
                (global.set $vsock_sel_waiting (i32.const 1))
                (global.set $vsock_sel_deadline
                  (i32.add (call $host_get_ticks) (local.get $ms)))))
            ;; Signed difference so a tick counter that wraps still expires.
            (if (i32.lt_s (i32.sub (call $host_get_ticks) (global.get $vsock_sel_deadline))
                          (i32.const 0))
              (then (call $vsock_block (i32.const 24)) (return)))))))
    ;; Returning for real: rewrite the guest's fd_sets to the ready members,
    ;; which on a timeout means emptying all three.
    (global.set $vsock_sel_waiting (i32.const 0))
    (drop (call $vsock_filter_set (local.get $arg1) (i32.const 0) (i32.const 1)))
    (drop (call $vsock_filter_set (local.get $arg2) (i32.const 1) (i32.const 1)))
    (drop (call $vsock_filter_set (local.get $arg3) (i32.const 2) (i32.const 1)))
    (global.set $eax (local.get $total)))

  ;; __WSAFDIsSet(s, set)
  (func $handle___WSAFDIsSet (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                             (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $count i32) (local $i i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (global.set $eax (i32.const 0))
    (if (i32.eqz (local.get $arg1)) (then (return)))
    (local.set $wa (call $g2w (local.get $arg1)))
    (local.set $count (i32.load (local.get $wa)))
    (if (i32.gt_u (local.get $count) (i32.const 64)) (then (local.set $count (i32.const 64))))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (if (i32.eq (i32.load (i32.add (local.get $wa)
            (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 4)))))
          (local.get $arg0))
        (then
          (global.set $eax (i32.const 1))
          (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

  ;; ioctlsocket(s, cmd, argp)
  (func $handle_ioctlsocket (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                            (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_rec (local.get $idx)))
    (if (i32.eq (local.get $arg1) (i32.const 0x8004667E))  ;; FIONBIO
      (then
        (i32.store (i32.add (local.get $rec) (i32.const 36))
          (i32.ne (i32.load (call $g2w (local.get $arg2))) (i32.const 0)))
        (global.set $eax (i32.const 0))
        (return)))
    (if (i32.eq (local.get $arg1) (i32.const 0x4004667F))  ;; FIONREAD
      (then
        (i32.store (call $g2w (local.get $arg2))
          (i32.load (i32.add (local.get $rec) (i32.const 52))))
        (global.set $eax (i32.const 0))
        (return)))
    (call $vsock_set_error (i32.const 10022))
    (global.set $eax (i32.const -1)))

  ;; setsockopt(s, level, optname, optval, optlen)
  (func $handle_setsockopt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                           (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))
        (global.set $eax (i32.const -1))
        (return)))
    ;; SOL_SOCKET options the switch can honor by construction: the room
    ;; switch has no TIME_WAIT and no kernel buffers to resize.
    (if (i32.eq (local.get $arg1) (i32.const 0xFFFF))      ;; SOL_SOCKET
      (then
        (if (i32.or
              (i32.or (i32.eq (local.get $arg2) (i32.const 0x0004))   ;; SO_REUSEADDR
                      (i32.eq (local.get $arg2) (i32.const 0x1001)))  ;; SO_SNDBUF
              (i32.or (i32.eq (local.get $arg2) (i32.const 0x1002))   ;; SO_RCVBUF
                      (i32.eq (local.get $arg2) (i32.const 0x0080)))) ;; SO_LINGER
          (then
            (global.set $eax (i32.const 0))
            (return)))))
    (if (i32.eq (local.get $arg1) (i32.const 6))           ;; IPPROTO_TCP
      (then
        (if (i32.eq (local.get $arg2) (i32.const 1))       ;; TCP_NODELAY
          (then
            ;; The switch never coalesces, so Nagle is already off.
            (global.set $eax (i32.const 0))
            (return)))))
    (call $vsock_set_error (i32.const 10042))              ;; WSAENOPROTOOPT
    (global.set $eax (i32.const -1)))

  ;; htons / ntohs — identical 16-bit swap on a little-endian guest.
  (func $handle_htons (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                      (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $bswap16 (i32.and (local.get $arg0) (i32.const 0xFFFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_ntohs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                      (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $bswap16 (i32.and (local.get $arg0) (i32.const 0xFFFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_ntohl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                      (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $bswap32 (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; ---- WsControl: the Win95/98 TDI query interface -------------------------
  ;; winipcfg reads the whole adapter configuration through WSOCK32 ordinal
  ;; 1001, not through the registry: it asks for the entity list, then the type
  ;; of each entity, then the IP address table, interface entry and route
  ;; table. We answer for the one adapter the virtual LAN actually has, so what
  ;; the tool displays is the address $vsock_local_ip binds to.
  ;;
  ;; The request buffer is a TDIObjectID: tei_entity, tei_instance, toi_class,
  ;; toi_type, toi_id. Addresses in the responses are network byte order,
  ;; matching what the caller passes to inet_ntoa.
  ;; Store one response and set *pcbResponseInfoLen. Returns the WsControl
  ;; status: 0 when it fit, ERROR_INSUFFICIENT_BUFFER (122) when it did not.
  ;; The needed size is reported either way, which is how callers size a second
  ;; call.
  (func $wsctl_need (param $resp_len_ga i32) (param $cap i32) (param $need i32) (result i32)
    (if (local.get $resp_len_ga)
      (then (i32.store (call $g2w (local.get $resp_len_ga)) (local.get $need))))
    (if (i32.lt_u (local.get $cap) (local.get $need))
      (then (return (i32.const 122))))
    (i32.const 0))

  ;; Zero-fill a guest range.
  (func $wsctl_zero (param $ga i32) (param $len i32)
    (local $i i32)
    (block $done (loop $z
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (call $g2w (i32.add (local.get $ga) (local.get $i))) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $z))))

  ;; Copy a NUL-terminated linear-memory string into a guest buffer.
  (func $wsctl_copy_str (param $dest_ga i32) (param $src_wa i32)
    (local $i i32) (local $ch i32)
    (block $done (loop $c
      (local.set $ch (i32.load8_u (i32.add (local.get $src_wa) (local.get $i))))
      (i32.store8 (call $g2w (i32.add (local.get $dest_ga) (local.get $i))) (local.get $ch))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $c))))

  (func $handle_WsControl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                          (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $resp_len_ga i32) (local $cap i32) (local $need i32)
    (local $entity i32) (local $class i32) (local $id i32) (local $descr i32)
    ;; arg0=protocol arg1=action arg2=pRequestInfo arg3=pcbRequestInfoLen
    ;; arg4=pResponseInfo, and the sixth argument is still on the guest stack.
    (local.set $resp_len_ga (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $eax (i32.const 50))  ;; ERROR_NOT_SUPPORTED
    (block $done
      ;; Only WSCNTL_TCPIP_QUERY_INFORMATION is answered.
      (br_if $done (i32.ne (local.get $arg1) (i32.const 0)))
      (br_if $done (i32.eqz (local.get $arg2)))
      (local.set $entity (call $gl32 (local.get $arg2)))
      (local.set $class  (call $gl32 (i32.add (local.get $arg2) (i32.const 8))))
      (local.set $id     (call $gl32 (i32.add (local.get $arg2) (i32.const 16))))
      (if (local.get $resp_len_ga)
        (then (local.set $cap (call $gl32 (local.get $resp_len_ga)))))

      ;; INFO_CLASS_GENERIC / ENTITY_LIST_ID — which entities exist.
      (if (i32.and (i32.eq (local.get $class) (i32.const 0x100))
                   (i32.eqz (local.get $id)))
        (then
          (local.set $need (i32.const 16))
          (global.set $eax (call $wsctl_need
            (local.get $resp_len_ga) (local.get $cap) (local.get $need)))
          (if (i32.eqz (global.get $eax))
            (then
              ;; IF_ENTITY instance 0, then CL_NL_ENTITY instance 0.
              (i32.store (call $g2w (local.get $arg4)) (i32.const 0x200))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 4))) (i32.const 0))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 8))) (i32.const 0x301))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 12))) (i32.const 0))))
          (br $done)))

      ;; INFO_CLASS_GENERIC / ENTITY_TYPE_ID — what kind of entity this is.
      (if (i32.and (i32.eq (local.get $class) (i32.const 0x100))
                   (i32.eq (local.get $id) (i32.const 1)))
        (then
          (global.set $eax (call $wsctl_need
            (local.get $resp_len_ga) (local.get $cap) (i32.const 4)))
          (if (i32.eqz (global.get $eax))
            (then
              (local.set $need (i32.const 0))
              (if (i32.eq (local.get $entity) (i32.const 0x200))
                (then (local.set $need (i32.const 0x202))))   ;; IF_MIB
              (if (i32.eq (local.get $entity) (i32.const 0x301))
                (then (local.set $need (i32.const 0x303))))   ;; CL_NL_IP
              (i32.store (call $g2w (local.get $arg4)) (local.get $need))))
          (br $done)))

      ;; Everything below is INFO_CLASS_PROTOCOL.
      (br_if $done (i32.ne (local.get $class) (i32.const 0x200)))

      ;; IP entity: statistics — the counts that size the tables that follow.
      (if (i32.and (i32.eq (local.get $entity) (i32.const 0x301))
                   (i32.eq (local.get $id) (i32.const 1)))
        (then
          (global.set $eax (call $wsctl_need
            (local.get $resp_len_ga) (local.get $cap) (i32.const 92)))
          (if (i32.eqz (global.get $eax))
            (then
              (call $wsctl_zero (local.get $arg4) (i32.const 92))
              (i32.store (call $g2w (local.get $arg4)) (i32.const 2))          ;; not forwarding
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 4))) (i32.const 128)) ;; default TTL
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 80))) (i32.const 1))  ;; numif
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 84))) (i32.const 1))  ;; numaddr
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 88))) (i32.const 1))));; numroutes
          (br $done)))

      ;; IP entity: the address table — one IPAddrEntry for our adapter.
      (if (i32.and (i32.eq (local.get $entity) (i32.const 0x301))
                   (i32.eq (local.get $id) (i32.const 0x102)))
        (then
          (global.set $eax (call $wsctl_need
            (local.get $resp_len_ga) (local.get $cap) (i32.const 24)))
          (if (i32.eqz (global.get $eax))
            (then
              (call $wsctl_zero (local.get $arg4) (i32.const 24))
              (i32.store (call $g2w (local.get $arg4))
                (call $bswap32 (global.get $vsock_local_ip)))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 4))) (i32.const 1))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 8)))
                (call $bswap32 (global.get $wsctl_mask)))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 12))) (i32.const 1))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 16))) (i32.const 65535))))
          (br $done)))

      ;; IP entity: the route table — one default route through the room host.
      ;; The Win98 IPRouteEntry is 48 bytes, one ULONG shorter than the NT one:
      ;; winipcfg strides its route buffer by 0x30 (0x404ea8) and sizes it as
      ;; numroutes * 0x30 (0x404dde), so 52 here makes every query fail with
      ;; ERROR_INSUFFICIENT_BUFFER no matter how the caller reallocates.
      (if (i32.and (i32.eq (local.get $entity) (i32.const 0x301))
                   (i32.eq (local.get $id) (i32.const 0x101)))
        (then
          (global.set $eax (call $wsctl_need
            (local.get $resp_len_ga) (local.get $cap) (i32.const 48)))
          (if (i32.eqz (global.get $eax))
            (then
              (call $wsctl_zero (local.get $arg4) (i32.const 48))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 4))) (i32.const 1))  ;; index
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 8))) (i32.const 1))  ;; metric1
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 24)))
                (call $bswap32 (global.get $wsctl_gateway)))                                   ;; nexthop
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 28))) (i32.const 4)) ;; indirect
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 32))) (i32.const 3))));; proto
          (br $done)))

      ;; Interface entity: the adapter itself, ending in its description.
      (if (i32.and (i32.eq (local.get $entity) (i32.const 0x200))
                   (i32.eq (local.get $id) (i32.const 1)))
        (then
          (local.set $descr (call $strlen (i32.const 0x11D90)))
          (local.set $need (i32.add (i32.const 92) (i32.add (local.get $descr) (i32.const 1))))
          (global.set $eax (call $wsctl_need
            (local.get $resp_len_ga) (local.get $cap) (local.get $need)))
          (if (i32.eqz (global.get $eax))
            (then
              (call $wsctl_zero (local.get $arg4) (local.get $need))
              (i32.store (call $g2w (local.get $arg4)) (i32.const 1))            ;; if_index
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 4))) (i32.const 6))        ;; ethernet
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 8))) (i32.const 1500))     ;; mtu
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 12))) (i32.const 10000000));; speed
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 16))) (i32.const 6))       ;; physaddrlen
              ;; Locally-administered MAC, fixed so the tool shows the same
              ;; adapter address on every run.
              (i32.store8 (call $g2w (i32.add (local.get $arg4) (i32.const 20))) (i32.const 0x02))
              (i32.store8 (call $g2w (i32.add (local.get $arg4) (i32.const 21))) (i32.const 0x57))
              (i32.store8 (call $g2w (i32.add (local.get $arg4) (i32.const 22))) (i32.const 0x41))
              (i32.store8 (call $g2w (i32.add (local.get $arg4) (i32.const 23))) (i32.const 0x53))
              (i32.store8 (call $g2w (i32.add (local.get $arg4) (i32.const 24))) (i32.const 0x4D))
              (i32.store8 (call $g2w (i32.add (local.get $arg4) (i32.const 25))) (i32.const 0x01))
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 28))) (i32.const 1))  ;; admin up
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 32))) (i32.const 1))  ;; oper up
              (i32.store (call $g2w (i32.add (local.get $arg4) (i32.const 88))) (local.get $descr))
              (call $wsctl_copy_str
                (i32.add (local.get $arg4) (i32.const 92)) (i32.const 0x11D90))))
          (br $done)))
    )
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; Parse a dotted quad at a guest pointer. Returns host byte order, or -1
  ;; when the text is not four decimal octets.
  (func $vsock_parse_ipv4 (param $ga i32) (result i32)
    (local $wa i32) (local $ch i32) (local $val i32) (local $octet i32)
    (local $digits i32) (local $acc i32)
    (if (i32.eqz (local.get $ga)) (then (return (i32.const -1))))
    (local.set $wa (call $g2w (local.get $ga)))
    (local.set $octet (i32.const 0))
    (local.set $acc (i32.const 0))
    (local.set $val (i32.const 0))
    (local.set $digits (i32.const 0))
    (block $done (loop $scan
      (local.set $ch (i32.load8_u (local.get $wa)))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x30))
                   (i32.le_u (local.get $ch) (i32.const 0x39)))
        (then
          (local.set $val (i32.add (i32.mul (local.get $val) (i32.const 10))
            (i32.sub (local.get $ch) (i32.const 0x30))))
          (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
          (if (i32.gt_u (local.get $val) (i32.const 255)) (then (return (i32.const -1)))))
        (else
          (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2E)) (i32.eqz (local.get $ch)))
            (then
              (if (i32.eqz (local.get $digits)) (then (return (i32.const -1))))
              (local.set $acc (i32.or (i32.shl (local.get $acc) (i32.const 8)) (local.get $val)))
              (local.set $octet (i32.add (local.get $octet) (i32.const 1)))
              (local.set $val (i32.const 0))
              (local.set $digits (i32.const 0))
              (br_if $done (i32.eqz (local.get $ch))))
            (else (return (i32.const -1))))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $scan)))
    (if (i32.ne (local.get $octet) (i32.const 4)) (then (return (i32.const -1))))
    (local.get $acc))

  ;; inet_addr(cp) — returns network byte order, INADDR_NONE on failure.
  (func $handle_inet_addr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                          (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ip i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (local.set $ip (call $vsock_parse_ipv4 (local.get $arg0)))
    (if (i32.lt_s (local.get $ip) (i32.const 0))
      (then
        (global.set $eax (i32.const -1))                   ;; INADDR_NONE
        (return)))
    (global.set $eax (call $bswap32 (local.get $ip))))

  ;; Write "a.b.c.d" (host byte order input) at a guest pointer; returns the
  ;; byte count written, excluding the terminator.
  (func $vsock_format_ipv4 (param $ga i32) (param $ip i32) (result i32)
    (local $i i32) (local $b i32) (local $pos i32) (local $d i32) (local $started i32)
    (local.set $pos (i32.const 0))
    (local.set $i (i32.const 0))
    (block $od (loop $oct
      (br_if $od (i32.ge_u (local.get $i) (i32.const 4)))
      (local.set $b (i32.and
        (i32.shr_u (local.get $ip) (i32.mul (i32.sub (i32.const 3) (local.get $i)) (i32.const 8)))
        (i32.const 0xFF)))
      (local.set $started (i32.const 0))
      (local.set $d (i32.const 100))
      (block $dd (loop $dig
        (br_if $dd (i32.eqz (local.get $d)))
        (if (i32.or (local.get $started) (i32.or (i32.ge_u (local.get $b) (local.get $d))
                                                 (i32.eq (local.get $d) (i32.const 1))))
          (then
            (i32.store8 (call $g2w (i32.add (local.get $ga) (local.get $pos)))
              (i32.add (i32.const 0x30) (i32.div_u (local.get $b) (local.get $d))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $started (i32.const 1))
            (local.set $b (i32.rem_u (local.get $b) (local.get $d)))))
        (local.set $d (i32.div_u (local.get $d) (i32.const 10)))
        (br $dig)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (if (i32.lt_u (local.get $i) (i32.const 4))
        (then
          (i32.store8 (call $g2w (i32.add (local.get $ga) (local.get $pos))) (i32.const 0x2E))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
      (br $oct)))
    (i32.store8 (call $g2w (i32.add (local.get $ga) (local.get $pos))) (i32.const 0))
    (local.get $pos))

  ;; inet_ntoa(in) — takes a network-order in_addr by value, returns a
  ;; pointer to a per-process static buffer, as WinSock does.
  (func $handle_inet_ntoa (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                          (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (if (i32.eqz (global.get $vsock_ntoa_buf))
      (then (global.set $vsock_ntoa_buf (call $heap_alloc (i32.const 32)))))
    (if (i32.eqz (global.get $vsock_ntoa_buf))
      (then
        (global.set $eax (i32.const 0))
        (return)))
    (drop (call $vsock_format_ipv4 (global.get $vsock_ntoa_buf)
      (call $bswap32 (local.get $arg0))))
    (global.set $eax (global.get $vsock_ntoa_buf)))

  ;; gethostbyname(name) — version 1 resolves numeric room addresses only.
  ;; Layout: hostent at +0 (16 bytes), addr-list pointer array at +16,
  ;; the in_addr at +32, and the name copy at +40.
  (func $handle_gethostbyname (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                              (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ip i32) (local $base i32) (local $i i32) (local $ch i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (local.set $ip (call $vsock_parse_ipv4 (local.get $arg0)))
    (if (i32.lt_s (local.get $ip) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 11001))          ;; WSAHOST_NOT_FOUND
        (global.set $eax (i32.const 0))
        (return)))
    (if (i32.eqz (global.get $vsock_hostent))
      (then (global.set $vsock_hostent (call $heap_alloc (i32.const 128)))))
    (local.set $base (global.get $vsock_hostent))
    (if (i32.eqz (local.get $base))
      (then
        (call $vsock_set_error (i32.const 11001))
        (global.set $eax (i32.const 0))
        (return)))
    ;; Copy the queried name so h_name stays valid after the call.
    (local.set $i (i32.const 0))
    (block $nd (loop $nc
      (br_if $nd (i32.ge_u (local.get $i) (i32.const 63)))
      (local.set $ch (i32.load8_u (call $g2w (i32.add (local.get $arg0) (local.get $i)))))
      (i32.store8 (call $g2w (i32.add (local.get $base) (i32.add (i32.const 40) (local.get $i))))
        (local.get $ch))
      (br_if $nd (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $nc)))
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 32)))
      (call $bswap32 (local.get $ip)))
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 16)))
      (i32.add (local.get $base) (i32.const 32)))
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 20))) (i32.const 0))
    (i32.store (call $g2w (local.get $base))
      (i32.add (local.get $base) (i32.const 40)))          ;; h_name
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 4))) (i32.const 0)) ;; h_aliases
    (i32.store16 (call $g2w (i32.add (local.get $base) (i32.const 8))) (i32.const 2)) ;; AF_INET
    (i32.store16 (call $g2w (i32.add (local.get $base) (i32.const 10))) (i32.const 4))
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 12)))
      (i32.add (local.get $base) (i32.const 16)))          ;; h_addr_list
    (global.set $eax (local.get $base)))

  ;; Copy a NUL-terminated guest string into a guest buffer, bounded.
  (func $vsock_copy_cstr (param $dst i32) (param $src i32) (param $max i32)
    (local $i i32) (local $ch i32)
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $max)))
      (local.set $ch (i32.load8_u (call $g2w (i32.add (local.get $src) (local.get $i)))))
      (i32.store8 (call $g2w (i32.add (local.get $dst) (local.get $i))) (local.get $ch))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next))))

  ;; The TCP services a Win98 box knows without being told. Matched with the
  ;; lowercase-dword idiom used elsewhere; the trailing NUL becomes 0x20 under
  ;; the same OR, which is why the constants carry it.
  (func $vsock_service_port (param $name i32) (result i32)
    (local $d0 i32)
    (local.set $d0 (i32.or (i32.load (call $g2w (local.get $name))) (i32.const 0x20202020)))
    (if (i32.eq (local.get $d0) (i32.const 0x20707466)) (then (return (i32.const 21))))   ;; ftp
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x6e6c6574))
          (i32.and
            (i32.eq (i32.or (i32.load16_u offset=4 (call $g2w (local.get $name)))
                            (i32.const 0x2020)) (i32.const 0x7465))
            (i32.eqz (i32.load8_u offset=6 (call $g2w (local.get $name))))))
      (then (return (i32.const 23))))                                                     ;; telnet
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x706d7473))
                 (i32.eqz (i32.load8_u offset=4 (call $g2w (local.get $name)))))
      (then (return (i32.const 25))))                                                     ;; smtp
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x70747468))
                 (i32.eqz (i32.load8_u offset=4 (call $g2w (local.get $name)))))
      (then (return (i32.const 80))))                                                     ;; http
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x33706f70))
                 (i32.eqz (i32.load8_u offset=4 (call $g2w (local.get $name)))))
      (then (return (i32.const 110))))                                                    ;; pop3
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x70746e6e))
                 (i32.eqz (i32.load8_u offset=4 (call $g2w (local.get $name)))))
      (then (return (i32.const 119))))                                                    ;; nntp
    (i32.const 0))

  ;; getservbyname(name, proto) → struct servent* (NULL when unknown)
  ;;
  ;; A miss is the normal, correct answer for anything not in the services
  ;; file: an app that names its own protocol looks it up, gets NULL, and
  ;; falls back to its built-in port. TetriNET does exactly that on its way to
  ;; port 31457, so the value here is answering at all rather than trapping.
  (func $handle_getservbyname (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                              (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $port i32) (local $base i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (if (i32.eqz (local.get $arg0))
      (then
        (call $vsock_set_error (i32.const 11004))          ;; WSANO_DATA
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $port (call $vsock_service_port (local.get $arg0)))
    (if (i32.eqz (local.get $port))
      (then
        (call $vsock_set_error (i32.const 11004))
        (global.set $eax (i32.const 0))
        (return)))
    (if (i32.eqz (global.get $vsock_servent))
      (then (global.set $vsock_servent (call $heap_alloc (i32.const 96)))))
    (local.set $base (global.get $vsock_servent))
    (if (i32.eqz (local.get $base))
      (then
        (call $vsock_set_error (i32.const 11004))
        (global.set $eax (i32.const 0))
        (return)))
    ;; Keep our own copies: the caller's buffers may be stack temporaries.
    (call $vsock_copy_cstr (i32.add (local.get $base) (i32.const 16))
      (local.get $arg0) (i32.const 31))
    (if (local.get $arg1)
      (then (call $vsock_copy_cstr (i32.add (local.get $base) (i32.const 48))
              (local.get $arg1) (i32.const 31)))
      (else (i32.store8 (call $g2w (i32.add (local.get $base) (i32.const 48)))
              (i32.const 0))))
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 88))) (i32.const 0))
    (i32.store (call $g2w (local.get $base))
      (i32.add (local.get $base) (i32.const 16)))          ;; s_name
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 4)))
      (i32.add (local.get $base) (i32.const 88)))          ;; s_aliases → {NULL}
    ;; s_port is network byte order, unlike everything around it.
    (i32.store16 (call $g2w (i32.add (local.get $base) (i32.const 8)))
      (i32.or (i32.shl (i32.and (local.get $port) (i32.const 0xFF)) (i32.const 8))
              (i32.shr_u (local.get $port) (i32.const 8))))
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 12)))
      (i32.add (local.get $base) (i32.const 48)))          ;; s_proto
    (global.set $eax (local.get $base)))

  ;; ---- WSAAsyncSelect: sockets that report themselves as window messages --
  ;;
  ;; The other half of Winsock. select() asks "is anything ready yet"; this
  ;; says "tell my window when something happens" and then never polls. Apps
  ;; built around a message pump use it exclusively -- TetriNET and Win98's
  ;; own telnet both do -- so without it a socket connects and the app never
  ;; finds out.
  ;;
  ;; The registration lives beside the socket table rather than inside it:
  ;; VSOCK_TABLE is 64 records of exactly 128 bytes in an 8KB region with no
  ;; room left, and widening the record would mean moving a memory-map
  ;; boundary for three fields.
  (global $vsock_async (mut i32) (i32.const 0))
  (global $VSOCK_ASYNC_REC i32 (i32.const 12))

  (func $vsock_async_rec (param $idx i32) (result i32)
    (local $i i32) (local $base i32)
    (if (i32.ge_u (local.get $idx) (global.get $VSOCK_MAX)) (then (return (i32.const 0))))
    (if (i32.eqz (global.get $vsock_async))
      (then
        (local.set $base (call $heap_alloc
          (i32.mul (global.get $VSOCK_MAX) (global.get $VSOCK_ASYNC_REC))))
        (if (i32.eqz (local.get $base)) (then (return (i32.const 0))))
        (block $zdone (loop $z
          (br_if $zdone (i32.ge_u (local.get $i)
            (i32.mul (global.get $VSOCK_MAX) (global.get $VSOCK_ASYNC_REC))))
          (i32.store8 (call $g2w (i32.add (local.get $base) (local.get $i))) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $z)))
        (global.set $vsock_async (local.get $base))))
    (i32.add (global.get $vsock_async)
      (i32.mul (local.get $idx) (global.get $VSOCK_ASYNC_REC))))

  ;; Report one event to the window that asked for it. lParam packs the event
  ;; and the error the way WSAMAKESELECTREPLY does; wParam is the handle.
  (func $vsock_async_post (param $idx i32) (param $event i32) (param $error i32)
    (local $rec i32) (local $w i32)
    (local.set $rec (call $vsock_async_rec (local.get $idx)))
    (if (i32.eqz (local.get $rec)) (then (return)))
    (local.set $w (call $g2w (local.get $rec)))
    (if (i32.eqz (i32.load (local.get $w))) (then (return)))          ;; no window
    (if (i32.eqz (i32.and (i32.load offset=8 (local.get $w)) (local.get $event)))
      (then (return)))                                               ;; not requested
    (drop (call $post_queue_push
      (i32.load (local.get $w))
      (i32.load offset=4 (local.get $w))
      (call $vsock_handle (local.get $idx))
      (i32.or (i32.shl (local.get $error) (i32.const 16)) (local.get $event)))))

  ;; WSAAsyncSelect(s, hWnd, wMsg, lEvent) → 0 on success
  (func $handle_WSAAsyncSelect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                               (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $rec i32) (local $w i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (local.set $idx (call $vsock_index (local.get $arg0)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 10038))          ;; WSAENOTSOCK
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $rec (call $vsock_async_rec (local.get $idx)))
    (if (i32.eqz (local.get $rec))
      (then
        (call $vsock_set_error (i32.const 10055))          ;; WSAENOBUFS
        (global.set $eax (i32.const -1))
        (return)))
    (local.set $w (call $g2w (local.get $rec)))
    (i32.store        (local.get $w) (local.get $arg1))    ;; hWnd
    (i32.store offset=4 (local.get $w) (local.get $arg2))  ;; wMsg
    (i32.store offset=8 (local.get $w) (local.get $arg3))  ;; lEvent
    ;; Documented side effect: the socket becomes non-blocking, and stays that
    ;; way even if the registration is later cancelled with lEvent = 0.
    (i32.store (i32.add (call $vsock_rec (local.get $idx)) (i32.const 36)) (i32.const 1))
    (global.set $eax (i32.const 0)))

  ;; getprotobyname(name) → struct protoent* (NULL when unknown)
  ;;
  ;; Apps call this to turn "tcp" into the 6 they pass to socket(). The four
  ;; protocols below are the ones a Win98 protocol file lists that anything
  ;; here could ask for; anything else is genuinely unknown.
  (func $handle_getprotobyname (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                               (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $d0 i32) (local $proto i32) (local $base i32) (local $n i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (if (i32.eqz (local.get $arg0))
      (then
        (call $vsock_set_error (i32.const 11004))          ;; WSANO_DATA
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $n (call $g2w (local.get $arg0)))
    (local.set $d0 (i32.or (i32.load (local.get $n)) (i32.const 0x20202020)))
    (local.set $proto (i32.const -1))
    (if (i32.eq (local.get $d0) (i32.const 0x20706374))
      (then (local.set $proto (i32.const 6))))            ;; tcp
    (if (i32.eq (local.get $d0) (i32.const 0x20706475))
      (then (local.set $proto (i32.const 17))))           ;; udp
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x706d6369))
                 (i32.eqz (i32.load8_u offset=4 (local.get $n))))
      (then (local.set $proto (i32.const 1))))            ;; icmp
    (if (i32.and (i32.eq (i32.or (i32.load16_u (local.get $n)) (i32.const 0x2020))
                         (i32.const 0x7069))
                 (i32.eqz (i32.load8_u offset=2 (local.get $n))))
      (then (local.set $proto (i32.const 0))))            ;; ip
    (if (i32.lt_s (local.get $proto) (i32.const 0))
      (then
        (call $vsock_set_error (i32.const 11004))
        (global.set $eax (i32.const 0))
        (return)))
    (if (i32.eqz (global.get $vsock_protoent))
      (then (global.set $vsock_protoent (call $heap_alloc (i32.const 64)))))
    (local.set $base (global.get $vsock_protoent))
    (if (i32.eqz (local.get $base))
      (then
        (call $vsock_set_error (i32.const 11004))
        (global.set $eax (i32.const 0))
        (return)))
    (call $vsock_copy_cstr (i32.add (local.get $base) (i32.const 16))
      (local.get $arg0) (i32.const 31))
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 56))) (i32.const 0))
    (i32.store (call $g2w (local.get $base))
      (i32.add (local.get $base) (i32.const 16)))          ;; p_name
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 4)))
      (i32.add (local.get $base) (i32.const 56)))          ;; p_aliases → {NULL}
    ;; p_proto is a plain int, in host order — unlike servent's s_port.
    (i32.store (call $g2w (i32.add (local.get $base) (i32.const 8))) (local.get $proto))
    (global.set $eax (local.get $base)))

  ;; WSAStartup(wVersionRequested, lpWSAData)
  (func $handle_WSAStartup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                           (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; wVersion is the negotiated request; wHighVersion is the provider
    ;; ceiling. WinSock 1.1 clients reject a success that reports 2.2 here.
    (i32.store16 (local.get $wa) (i32.and (local.get $arg0) (i32.const 0xFFFF)))
    (i32.store16 (i32.add (local.get $wa) (i32.const 2)) (i32.const 0x0202))
    (global.set $wsa_started (i32.add (global.get $wsa_started) (i32.const 1)))
    (global.set $eax (i32.const 0)))

  ;; WSACleanup() — the last matching call tears the room switch down.
  (func $handle_WSACleanup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                           (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (if (i32.eqz (global.get $wsa_started))
      (then
        (call $vsock_set_error (i32.const 10093))          ;; WSANOTINITIALISED
        (global.set $eax (i32.const -1))
        (return)))
    (global.set $wsa_started (i32.sub (global.get $wsa_started) (i32.const 1)))
    (if (i32.eqz (global.get $wsa_started))
      (then
        (local.set $i (i32.const 0))
        (block $done (loop $scan
          (br_if $done (i32.ge_u (local.get $i) (global.get $VSOCK_MAX)))
          (call $vsock_destroy (local.get $i) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))))
    (global.set $eax (i32.const 0)))

  (func $handle_WSAGetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (global.set $eax (global.get $wsa_last_error)))

  (func $handle_WSASetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (global.set $wsa_last_error (local.get $arg0)))
