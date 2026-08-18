  ;; ============================================================
  ;; WIN16 DDEML — dynamic data exchange management
  ;; ============================================================
  ;;
  ;; Hearts is a network game and DDEML is how it talks: one instance registers
  ;; the service name and deals, the others connect to it. This implements the
  ;; side of that which is true of a machine with no peers — the instance
  ;; initialises, its string handles and its service registration are real, and
  ;; every attempt to reach another player truthfully finds nobody there. That
  ;; is what lets Hearts get to its own table and fill the empty seats.
  ;;
  ;; Nothing here is a constant-returning stub: string handles intern and
  ;; compare, data handles hold the bytes written into them and hand them back,
  ;; and DdeGetLastError answers with what actually went wrong. Two emulator
  ;; instances in one room would need the conversation half as well, which is
  ;; the same shape of problem $win16_dispatch's virtual LAN already solves for
  ;; Winsock and is deliberately left for when there is a second player to test
  ;; it against.
  ;;
  ;; Every signature here was read off Hearts' own call sites rather than
  ;; assumed: a Win16 HSZ, HCONV and HDDEDATA are all DWORDs, and getting one of
  ;; them wrong by two bytes silently shifts the caller's frame.

  ;; The tables live above the DLL records in the arena slot past the last
  ;; usable selector, where nothing the task can address reaches them.
  (func $win16_dde_base (result i32)
    (call $g2w (i32.add (global.get $WIN16_ARENA)
                        (i32.mul (global.get $WIN16_SEG_MAX) (i32.const 0x10000)))))

  ;; 8 instances of {used, callback far pointer, afCmd}.
  (func $win16_dde_inst (param $i i32) (result i32)
    (i32.add (call $win16_dde_base)
             (i32.add (i32.const 0x9000) (i32.mul (local.get $i) (i32.const 12)))))

  (func $win16_dde_error_slot (result i32)
    (i32.add (call $win16_dde_base) (i32.const 0x9100)))

  ;; 64 strings of {refcount, 68 bytes of text}.
  (func $win16_dde_hsz_slot (param $i i32) (result i32)
    (i32.add (call $win16_dde_base)
             (i32.add (i32.const 0x9200) (i32.mul (local.get $i) (i32.const 72)))))

  ;; 16 data handles of {used, length, 512 bytes}.
  (func $win16_dde_data_slot (param $i i32) (result i32)
    (i32.add (call $win16_dde_base)
             (i32.add (i32.const 0xA400) (i32.mul (local.get $i) (i32.const 520)))))

  ;; ---- Conversations ----
  ;;
  ;; The service name each instance has registered, one HSZ per instance. Kept
  ;; beside the instance records rather than inside them so the record stride
  ;; stays what every existing offset here assumes.
  (func $win16_dde_service_slot (param $i i32) (result i32)
    (i32.add (call $win16_dde_base)
             (i32.add (i32.const 0x9140) (i32.mul (local.get $i) (i32.const 4)))))

  ;; 8 conversations of {used, inst, peer_tag, peer_conv, is_server}.
  (func $win16_dde_conv_slot (param $i i32) (result i32)
    (i32.add (call $win16_dde_base)
             (i32.add (i32.const 0xD000) (i32.mul (local.get $i) (i32.const 20)))))

  ;; The one connect this instance is waiting on:
  ;; {active, started_ticks, conv, answered}. DdeConnect is synchronous to its
  ;; caller and a task has exactly one such call outstanding, so one slot is
  ;; the whole of it.
  (func $win16_dde_pending_slot (result i32)
    (i32.add (call $win16_dde_base) (i32.const 0xD100)))

  (func $win16_dde_conv_alloc (param $inst i32) (param $is_server i32) (result i32)
    (local $i i32) (local $slot i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
      (local.set $slot (call $win16_dde_conv_slot (local.get $i)))
      (if (i32.eqz (i32.load (local.get $slot)))
        (then
          (i32.store (local.get $slot) (i32.const 1))
          (i32.store offset=4 (local.get $slot) (local.get $inst))
          (i32.store offset=8 (local.get $slot) (i32.const 0))
          (i32.store offset=12 (local.get $slot) (i32.const 0))
          (i32.store offset=16 (local.get $slot) (local.get $is_server))
          ;; Handles are 1-based: zero is "no conversation" to every caller.
          (return (i32.add (local.get $i) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; ---- The DDE wire ----
  ;;
  ;; Two instances in one room reach each other over the same broadcast frame
  ;; wire the virtual LAN uses, under their own magic so the two protocols
  ;; never read each other's frames. The host carries bytes and nothing else:
  ;; which conversation a frame belongs to is decided here.
  ;;
  ;;   +0 magic 'DDE1'  +4 type  +8 src_tag  +12 src_conv  +16 dst_conv
  ;;   +20 payload length
  ;;
  ;; Types: 1 CONNECT (payload is service\0topic\0), 2 CONNECT_ACK,
  ;;        3 DISCONNECT.
  ;;
  ;; `src_tag` names the instance, and comes from the same room address the
  ;; virtual LAN uses — so anything hosting two instances has to give them
  ;; distinct addresses, which it already must do for Winsock.
  (global $DDE_MAGIC i32 (i32.const 0x31454444))
  (global $DDE_HDR i32 (i32.const 24))
  (global $DDE_MAX_PAYLOAD i32 (i32.const 256))
  (global $dde_frame_buf (mut i32) (i32.const 0))

  (func $win16_dde_tag (result i32) (global.get $vsock_local_ip))

  (func $win16_dde_frame_wa (result i32)
    (if (i32.eqz (global.get $dde_frame_buf))
      (then (global.set $dde_frame_buf (call $heap_alloc
        (i32.add (global.get $DDE_HDR) (global.get $DDE_MAX_PAYLOAD))))))
    (if (i32.eqz (global.get $dde_frame_buf)) (then (return (i32.const 0))))
    (call $g2w (global.get $dde_frame_buf)))

  ;; Copy an interned string into the frame payload at `off`, NUL included.
  ;; Returns the offset just past it.
  (func $win16_dde_put_hsz (param $wa i32) (param $off i32) (param $hsz i32) (result i32)
    (local $slot i32) (local $i i32) (local $c i32)
    (if (i32.or (i32.eqz (local.get $hsz)) (i32.gt_u (local.get $hsz) (i32.const 64)))
      (then
        (i32.store8 (i32.add (local.get $wa) (local.get $off)) (i32.const 0))
        (return (i32.add (local.get $off) (i32.const 1)))))
    (local.set $slot (i32.add (call $win16_dde_hsz_slot
      (i32.sub (local.get $hsz) (i32.const 1))) (i32.const 4)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (i32.const 68)))
      (local.set $c (i32.load8_u (i32.add (local.get $slot) (local.get $i))))
      (i32.store8 (i32.add (local.get $wa) (i32.add (local.get $off) (local.get $i)))
                  (local.get $c))
      (br_if $done (i32.eqz (local.get $c)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.add (i32.add (local.get $off) (local.get $i)) (i32.const 1)))

  ;; Does an interned handle hold exactly this text? Comparing the payload
  ;; against our own registration is how a server recognises a request for
  ;; the service it offers.
  (func $win16_dde_hsz_is (param $hsz i32) (param $wa i32) (result i32)
    (local $slot i32) (local $i i32) (local $a i32) (local $b i32)
    (if (i32.or (i32.eqz (local.get $hsz)) (i32.gt_u (local.get $hsz) (i32.const 64)))
      (then (return (i32.const 0))))
    (local.set $slot (i32.add (call $win16_dde_hsz_slot
      (i32.sub (local.get $hsz) (i32.const 1))) (i32.const 4)))
    (block $done (loop $cmp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 68)))
      (local.set $a (i32.load8_u (i32.add (local.get $slot) (local.get $i))))
      (local.set $b (i32.load8_u (i32.add (local.get $wa) (local.get $i))))
      (if (i32.ne (local.get $a) (local.get $b)) (then (return (i32.const 0))))
      (br_if $done (i32.eqz (local.get $a)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cmp)))
    (i32.const 1))

  ;; ---- NetDDE shares ----
  ;;
  ;; A client on another machine does not name the server's application. It
  ;; connects to the NetDDE *agent* on the machine — service `\\HOST\NDDE$` —
  ;; and gives a DDE *share* as the topic, the trailing `$` being the share
  ;; marker. The agent resolves the share against the machine's share database
  ;; and makes the real connection locally. Hearts is exactly this: the dealer
  ;; registers ("MSHearts", "Hearts") and the client asks for
  ;; (`\\DEAL\NDDE$`, `Hearts$`), which is why no amount of string matching
  ;; between the two would ever have joined them.
  (func $win16_dde_str_len (param $wa i32) (result i32)
    (local $n i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $n) (i32.const 128)))
      (br_if $done (i32.eqz (i32.load8_u (i32.add (local.get $wa) (local.get $n)))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $scan)))
    (local.get $n))

  (func $win16_dde_bytes_eq (param $a i32) (param $b i32) (result i32)
    (local $i i32) (local $ca i32)
    (block $done (loop $cmp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 128)))
      (local.set $ca (i32.load8_u (i32.add (local.get $a) (local.get $i))))
      (if (i32.ne (local.get $ca) (i32.load8_u (i32.add (local.get $b) (local.get $i))))
        (then (return (i32.const 0))))
      (br_if $done (i32.eqz (local.get $ca)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cmp)))
    (i32.const 1))

  ;; Is this service name the NetDDE agent rather than an application? Every
  ;; such name ends in `\NDDE$`, whatever machine it names.
  (func $win16_dde_is_agent (param $wa i32) (result i32)
    (local $n i32)
    (local.set $n (call $win16_dde_str_len (local.get $wa)))
    (if (i32.lt_u (local.get $n) (i32.const 6)) (then (return (i32.const 0))))
    (local.set $wa (i32.add (local.get $wa) (i32.sub (local.get $n) (i32.const 6))))
    (i32.and
      (i32.and (i32.eq (i32.load8_u (local.get $wa)) (i32.const 0x5C))         ;; \
               (i32.eq (i32.load8_u offset=1 (local.get $wa)) (i32.const 0x4E)))  ;; N
      (i32.and
        (i32.and (i32.eq (i32.load8_u offset=2 (local.get $wa)) (i32.const 0x44))  ;; D
                 (i32.eq (i32.load8_u offset=3 (local.get $wa)) (i32.const 0x44))) ;; D
        (i32.and (i32.eq (i32.load8_u offset=4 (local.get $wa)) (i32.const 0x45))  ;; E
                 (i32.eq (i32.load8_u offset=5 (local.get $wa)) (i32.const 0x24)))))) ;; $

  ;; Resolve a share name to the local application that serves it, or 0.
  (func $win16_dde_share_app (param $share_wa i32) (result i32)
    (local $p i32) (local $app i32)
    (local.set $p (global.get $WIN16_DDE_SHARES))
    (block $done (loop $next
      (br_if $done (i32.eqz (i32.load8_u (local.get $p))))
      (local.set $app (i32.add (i32.add (local.get $p)
        (call $win16_dde_str_len (local.get $p))) (i32.const 1)))
      (if (call $win16_dde_bytes_eq (local.get $p) (local.get $share_wa))
        (then (return (local.get $app))))
      ;; Past the application and its topic to the next record.
      (local.set $p (i32.add (i32.add (local.get $app)
        (call $win16_dde_str_len (local.get $app))) (i32.const 1)))
      (local.set $p (i32.add (i32.add (local.get $p)
        (call $win16_dde_str_len (local.get $p))) (i32.const 1)))
      (br $next)))
    (i32.const 0))

  (func $win16_dde_emit (param $type i32) (param $src_conv i32) (param $dst_conv i32)
                        (param $len i32) (result i32)
    (local $wa i32)
    (local.set $wa (call $win16_dde_frame_wa))
    (if (i32.eqz (local.get $wa)) (then (return (i32.const 0))))
    (i32.store (local.get $wa) (global.get $DDE_MAGIC))
    (i32.store offset=4  (local.get $wa) (local.get $type))
    (i32.store offset=8  (local.get $wa) (call $win16_dde_tag))
    (i32.store offset=12 (local.get $wa) (local.get $src_conv))
    (i32.store offset=16 (local.get $wa) (local.get $dst_conv))
    (i32.store offset=20 (local.get $wa) (local.get $len))
    (call $host_net_frame_send (local.get $wa)
      (i32.add (global.get $DDE_HDR) (local.get $len))))

  ;; Apply one inbound DDE frame. Always consumes it: unlike a socket frame
  ;; there is no per-connection ring that can be full, so nothing here can
  ;; ask for the frame to be left on the wire.
  (func $win16_dde_deliver (param $wa i32) (param $n i32)
    (local $type i32)
    (local $tag i32) (local $src_conv i32) (local $dst_conv i32)
    (local $i i32) (local $slot i32) (local $conv i32) (local $svc i32)
    (local $want i32)
    (if (i32.lt_u (local.get $n) (global.get $DDE_HDR)) (then (return)))
    (local.set $type     (i32.load offset=4  (local.get $wa)))
    (local.set $tag      (i32.load offset=8  (local.get $wa)))
    (local.set $src_conv (i32.load offset=12 (local.get $wa)))
    (local.set $dst_conv (i32.load offset=16 (local.get $wa)))
    ;; Our own broadcast coming back to us. A room is a broadcast segment, so
    ;; this is normal and not an error.
    (if (i32.eq (local.get $tag) (call $win16_dde_tag)) (then (return)))

    ;; A client is looking for a service. Answer only if some instance here
    ;; has registered exactly that name — or, when the client is asking the
    ;; NetDDE agent, the name the requested share resolves to.
    (if (i32.eq (local.get $type) (i32.const 1))
      (then
        (local.set $want (i32.add (local.get $wa) (global.get $DDE_HDR)))
        (if (call $win16_dde_is_agent (local.get $want))
          (then
            ;; The topic follows the service in the payload, and it is the
            ;; share name. An unknown share is answered by nobody, which is
            ;; what a machine without that share in its database does.
            (local.set $want (call $win16_dde_share_app
              (i32.add (i32.add (local.get $want)
                (call $win16_dde_str_len (local.get $want))) (i32.const 1))))
            (if (i32.eqz (local.get $want)) (then (return)))))
        (block $answered (loop $scan
          (br_if $answered (i32.ge_u (local.get $i) (i32.const 8)))
          (local.set $svc (i32.load (call $win16_dde_service_slot (local.get $i))))
          (if (i32.and
                (i32.ne (i32.load (call $win16_dde_inst (local.get $i))) (i32.const 0))
                (call $win16_dde_hsz_is (local.get $svc) (local.get $want)))
            (then
              (local.set $conv (call $win16_dde_conv_alloc
                (i32.add (local.get $i) (i32.const 1)) (i32.const 1)))
              (if (local.get $conv)
                (then
                  (local.set $slot (call $win16_dde_conv_slot
                    (i32.sub (local.get $conv) (i32.const 1))))
                  (i32.store offset=8  (local.get $slot) (local.get $tag))
                  (i32.store offset=12 (local.get $slot) (local.get $src_conv))
                  (drop (call $win16_dde_emit (i32.const 2)
                    (local.get $conv) (local.get $src_conv) (i32.const 0)))))
              (br $answered)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))
        (return)))

    ;; The service answered the connect we are waiting on.
    (if (i32.eq (local.get $type) (i32.const 2))
      (then
        (local.set $slot (call $win16_dde_pending_slot))
        (if (i32.eqz (i32.load (local.get $slot))) (then (return)))
        (local.set $conv (i32.load offset=8 (local.get $slot)))
        (if (i32.ne (local.get $dst_conv) (local.get $conv)) (then (return)))
        (local.set $slot (call $win16_dde_conv_slot
          (i32.sub (local.get $conv) (i32.const 1))))
        (i32.store offset=8  (local.get $slot) (local.get $tag))
        (i32.store offset=12 (local.get $slot) (local.get $src_conv))
        ;; Marking the pending connect answered is what lets the parked
        ;; DdeConnect finish on its next entry.
        (i32.store (i32.add (call $win16_dde_pending_slot) (i32.const 12))
                   (i32.const 1))
        (return)))

    ;; The peer has gone. Close whichever conversation names it.
    (if (i32.eq (local.get $type) (i32.const 3))
      (then
        (local.set $i (i32.const 0))
        (block $done (loop $scan
          (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
          (local.set $slot (call $win16_dde_conv_slot (local.get $i)))
          (if (i32.and
                (i32.ne (i32.load (local.get $slot)) (i32.const 0))
                (i32.and (i32.eq (i32.load offset=8 (local.get $slot)) (local.get $tag))
                         (i32.eq (i32.load offset=12 (local.get $slot))
                                 (local.get $src_conv))))
            (then (i32.store (local.get $slot) (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan))))))

  (func $win16_dde_set_error (param $err i32)
    (i32.store (call $win16_dde_error_slot) (local.get $err)))

  ;; ---- String handles ----
  ;;
  ;; A DDEML string handle is interned: the same text always yields the same
  ;; handle, because DdeCmpStringHandles is how a server recognises its own
  ;; service and topic names coming back to it.
  (func $win16_dde_hsz_intern (param $src i32) (result i32)
    (local $i i32) (local $slot i32) (local $free i32) (local $n i32) (local $c i32)
    (local.set $free (i32.const -1))
    (block $found (loop $scan
      (br_if $found (i32.ge_u (local.get $i) (i32.const 64)))
      (local.set $slot (call $win16_dde_hsz_slot (local.get $i)))
      (if (i32.eqz (i32.load (local.get $slot)))
        (then
          (if (i32.eq (local.get $free) (i32.const -1))
            (then (local.set $free (local.get $i)))))
        (else
          (if (call $win16_dde_str_eq (i32.add (local.get $slot) (i32.const 4))
                                      (local.get $src))
            (then
              (i32.store (local.get $slot)
                (i32.add (i32.load (local.get $slot)) (i32.const 1)))
              (return (i32.add (local.get $i) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eq (local.get $free) (i32.const -1))
      (then
        (call $win16_dde_set_error (i32.const 0x4001))   ;; DMLERR_LOW_MEMORY
        (return (i32.const 0))))
    (local.set $slot (call $win16_dde_hsz_slot (local.get $free)))
    (i32.store (local.get $slot) (i32.const 1))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $n) (i32.const 67)))
      (local.set $c (call $gl8 (i32.add (local.get $src) (local.get $n))))
      (i32.store8 (i32.add (i32.add (local.get $slot) (i32.const 4)) (local.get $n))
                  (local.get $c))
      (br_if $done (i32.eqz (local.get $c)))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (i32.add (local.get $slot) (i32.const 4)) (i32.const 67))
                (i32.const 0))
    (i32.add (local.get $free) (i32.const 1)))

  ;; `a` is a WASM address in the table, `b` a guest address in the task.
  (func $win16_dde_str_eq (param $a i32) (param $b i32) (result i32)
    (local $i i32) (local $ca i32) (local $cb i32)
    (block $done (loop $cmp
      (local.set $ca (i32.load8_u (i32.add (local.get $a) (local.get $i))))
      (local.set $cb (call $gl8 (i32.add (local.get $b) (local.get $i))))
      (if (i32.ne (local.get $ca) (local.get $cb)) (then (return (i32.const 0))))
      (br_if $done (i32.eqz (local.get $ca)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cmp)))
    (i32.const 1))

  ;; ---- The calls ----

  ;; DDEML.2 DdeInitialize(LPDWORD pidInst, PFNCALLBACK pfnCallback, DWORD afCmd,
  ;;   DWORD ulRes) -> UINT, zero for success.
  (func $win16_DdeInitialize
    (local $pid i32) (local $i i32) (local $slot i32)
    (local.set $pid (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 7)) (call $win16_arg16 (i32.const 6))))
    (block $found (loop $scan
      (br_if $found (i32.ge_u (local.get $i) (i32.const 8)))
      (br_if $found (i32.eqz (i32.load (call $win16_dde_inst (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.ge_u (local.get $i) (i32.const 8))
      (then
        (global.set $eax (i32.const 0x4001))            ;; DMLERR_LOW_MEMORY
        (call $win16_api_return (i32.const 16))
        (return)))
    (local.set $slot (call $win16_dde_inst (local.get $i)))
    (i32.store (local.get $slot) (i32.const 1))
    (i32.store offset=4 (local.get $slot) (call $win16_arg32 (i32.const 4)))
    (i32.store offset=8 (local.get $slot) (call $win16_arg32 (i32.const 2)))
    ;; The instance id is what every other call identifies itself by, so it has
    ;; to be non-zero and has to come back unchanged.
    (call $gs32 (local.get $pid) (i32.add (local.get $i) (i32.const 1)))
    (call $win16_dde_set_error (i32.const 0))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 16)))

  ;; DDEML.3 DdeUninitialize(DWORD idInst) -> BOOL.
  (func $win16_DdeUninitialize
    (local $id i32)
    (local.set $id (call $win16_arg32 (i32.const 0)))
    (if (i32.and (i32.gt_u (local.get $id) (i32.const 0))
                 (i32.le_u (local.get $id) (i32.const 8)))
      (then (i32.store (call $win16_dde_inst (i32.sub (local.get $id) (i32.const 1)))
                       (i32.const 0))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; DDEML.21 DdeCreateStringHandle(DWORD idInst, LPCSTR psz, INT codepage)
  ;;   -> HSZ in DX:AX.
  (func $win16_DdeCreateStringHandle
    (local $hsz i32)
    (local.set $hsz (call $win16_dde_hsz_intern (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1)))))
    (global.set $edx (i32.const 0))
    (global.set $eax (local.get $hsz))
    (call $win16_api_return (i32.const 10)))

  ;; DDEML.22 DdeFreeStringHandle(DWORD idInst, HSZ hsz) -> BOOL.
  (func $win16_DdeFreeStringHandle
    (local $hsz i32) (local $slot i32)
    (local.set $hsz (call $win16_arg32 (i32.const 0)))
    (if (i32.and (i32.gt_u (local.get $hsz) (i32.const 0))
                 (i32.le_u (local.get $hsz) (i32.const 64)))
      (then
        (local.set $slot (call $win16_dde_hsz_slot (i32.sub (local.get $hsz) (i32.const 1))))
        (if (i32.load (local.get $slot))
          (then (i32.store (local.get $slot)
                  (i32.sub (i32.load (local.get $slot)) (i32.const 1)))))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 8)))

  ;; DDEML.27 DdeNameService(DWORD idInst, HSZ hsz1, HSZ hsz2, UINT afCmd)
  ;;   -> HDDEDATA in DX:AX, non-zero for success.
  ;;
  ;; Registering a service name always succeeds: the name is this instance's to
  ;; claim and nothing else in the room has taken it. The name is *kept*, since
  ;; it is what a peer's connect is matched against — a registration nobody
  ;; recorded is a server no client can find.
  ;;
  ;; afCmd is DNS_REGISTER (1) or DNS_UNREGISTER (2); unregistering with a null
  ;; name drops every name the instance holds, which here is the one.
  (func $win16_DdeNameService
    (local $inst i32) (local $hsz i32) (local $cmd i32)
    (local.set $inst (call $win16_arg32 (i32.const 5)))
    (local.set $hsz  (call $win16_arg32 (i32.const 3)))
    (local.set $cmd  (call $win16_arg16 (i32.const 0)))
    (if (i32.and (i32.gt_u (local.get $inst) (i32.const 0))
                 (i32.le_u (local.get $inst) (i32.const 8)))
      (then
        (i32.store (call $win16_dde_service_slot
                     (i32.sub (local.get $inst) (i32.const 1)))
          (select (i32.const 0) (local.get $hsz)
                  (i32.eq (local.get $cmd) (i32.const 2))))))
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.const 1))
    (call $win16_dde_set_error (i32.const 0))
    (call $win16_api_return (i32.const 14)))

  ;; DDEML.7 DdeConnect(DWORD idInst, HSZ hszService, HSZ hszTopic,
  ;;   LPCONVCONTEXT pCC) -> HCONV in DX:AX.
  ;;
  ;; Ask the room for the service, then wait for an answer.
  ;;
  ;; The waiting is the interesting part. A connect cannot be answered inside
  ;; the call: the peer is another instance with its own memory and it only
  ;; sees the request when *it* next drains the wire. But a Win16 API is
  ;; entered with its arguments still on the task's stack and its return
  ;; address still under them — nothing is popped until $win16_api_return —
  ;; so simply not returning re-enters this same call, with the same
  ;; arguments, on the next pass. That is the whole park: no continuation
  ;; slot, no saved frame, and nothing to unwind if the task is killed while
  ;; it waits.
  ;;
  ;; (This is why it is written here rather than bridged to a 32-bit handler.
  ;; $vsock_block does the equivalent for Winsock by pushing the popped bytes
  ;; back; across the Win16 bridge neither form survives, because the frame it
  ;; would park on belongs to a scratch stack about to be discarded.)
  ;;
  ;; When nobody answers, the tries run out and the answer is NULL with
  ;; DMLERR_NO_CONV_ESTABLISHED — which is what Windows says when no server is
  ;; in the room, and what sends Hearts to its own table.
  ;; The wait is bounded by how many CHANCES the room has had to answer, not
  ;; by a clock, and each retry below is exactly one such chance: yielding
  ;; under reason 8 makes the host turn its event loop and pump the wire
  ;; before re-entering, so a retry is a guaranteed opportunity for a frame to
  ;; arrive rather than a free spin.
  ;;
  ;; A clock was tried first and is wrong here. $host_get_ticks is not wall
  ;; time under the CLI harness — test/run.js synthesises it as
  ;; `batch * 200 + calls`, so "3000 ms" was fifteen batches and a real dealer,
  ;; alive and registered, was given 36 milliseconds to reply.
  ;;
  ;; Stay well under test/run.js's own VLAN_MAX_WAITS (20000 consecutive net
  ;; waits), which is the point at which it decides the wire has stalled.
  ;; How long to wait for the room to answer, in real milliseconds.
  ;;
  ;; It has to be real time. Counting passes is not load-proof: a pass costs
  ;; only an event-loop turn, tens of microseconds, so the whole budget burns
  ;; in under a second while the peer that has to answer is another emulator
  ;; that may not have been scheduled yet. Measured: the request crossed in
  ;; 32ms and a pass-counted client still gave up 505ms later, before the
  ;; dealer had drained it. And it cannot be $host_get_ticks either — that is
  ;; the guest clock, which test/run.js synthesises as batch*200, so "3000 ms"
  ;; of it was fifteen batches.
  (global $DDE_CONNECT_TIMEOUT_MS i32 (i32.const 10000))

  (func $win16_DdeConnect
    (local $inst i32) (local $svc i32) (local $topic i32)
    (local $pend i32) (local $conv i32) (local $wa i32) (local $len i32)
    (local $ip i32) (local $sel i32)
    (local.set $pend (call $win16_dde_pending_slot))
    (local.set $inst (call $win16_arg32 (i32.const 6)))
    (local.set $conv (call $win16_dde_conv_alloc (local.get $inst) (i32.const 0)))
    (if (i32.eqz (local.get $conv))
      (then
        (call $win16_dde_set_error (i32.const 0x4001))   ;; DMLERR_LOW_MEMORY
        (global.set $edx (i32.const 0))
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 16))
        (return)))
    (i32.store (local.get $pend) (i32.const 1))
    (i32.store offset=4  (local.get $pend) (call $host_real_time_ms))
    (i32.store offset=8  (local.get $pend) (local.get $conv))
    (i32.store offset=12 (local.get $pend) (i32.const 0))

    ;; Put the request on the wire before parking, so the room has something
    ;; to answer on the very first pass.
    (local.set $svc   (call $win16_arg32 (i32.const 4)))
    (local.set $topic (call $win16_arg32 (i32.const 2)))
    (local.set $wa (call $win16_dde_frame_wa))
    (if (local.get $wa)
      (then
        (local.set $len (call $win16_dde_put_hsz
          (local.get $wa) (global.get $DDE_HDR) (local.get $svc)))
        (local.set $len (call $win16_dde_put_hsz
          (local.get $wa) (local.get $len) (local.get $topic)))
        (drop (call $win16_dde_emit (i32.const 1) (local.get $conv) (i32.const 0)
          (i32.sub (local.get $len) (global.get $DDE_HDR))))))

    ;; Take the call apart the way the modal message box does: remember the far
    ;; return, drop the whole frame, and park EIP on a slot the run loop will
    ;; re-enter. Every pass then belongs to $win16_dde_pump_step, which splices
    ;; the call back together once the room has answered.
    ;;
    ;; It must be done this way round. A Win16 thunk call is dispatched from
    ;; $win16_far_transfer with EIP ALREADY past the call, so an API that
    ;; simply declines to return does not get re-entered — it falls through to
    ;; its caller with the arguments still on the stack. Hearts calls
    ;; DdeConnect from a retry loop, so that leaked twenty bytes per attempt
    ;; and the trace showed ESP walking down while nothing waited at all.
    (local.set $ip  (call $gl16 (global.get $esp)))
    (local.set $sel (call $gl16 (i32.add (global.get $esp) (i32.const 2))))
    (global.set $win16_dde_ret (i32.or (i32.shl (local.get $sel) (i32.const 16))
                                       (local.get $ip)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    ;; CS first, EIP second, and in that order: the slot offset is meaningless
    ;; on its own, and $seg_base_cs is read AFTER the selector load. Parking
    ;; without switching selector put EIP at offset 0xFF70 of whatever segment
    ;; the caller happened to be in — real memory holding no code, which the
    ;; decoder walked into and trapped on.
    (call $win16_set_sreg (i32.const 1) (global.get $WIN16_THUNK_SEL))
    (global.set $eip (i32.add (global.get $seg_base_cs) (global.get $WIN16_DDE_PUMP)))
    (global.set $yield_flag (i32.const 1))
    (global.set $yield_reason (i32.const 8))
    (global.set $steps (i32.const 0)))

  ;; One pass of a parked DdeConnect. Returns 1 while it is still waiting.
  ;;
  ;; Reason 8 is net_wait, and it is this contract already: the host clears the
  ;; yield, turns its event loop, and pumps the wire before re-entering. That
  ;; turn is the point — when the peer is in another OS process its frames
  ;; arrive over child IPC, and nothing is delivered while a synchronous batch
  ;; loop holds the thread. A real dealer, alive and registered, read its
  ;; client's request only after its own run had ended without it.
  ;;
  ;; The wait is bounded by passes rather than by a clock, and each pass is one
  ;; real chance for an answer because of that turn. $host_get_ticks would be
  ;; the wrong bound: test/run.js synthesises it as `batch * 200`, so a
  ;; "3000 ms" timeout was fifteen batches.
  (func $win16_dde_pump_step (result i32)
    (local $pend i32) (local $conv i32)
    (local.set $pend (call $win16_dde_pending_slot))
    (call $win16_dde_pump)
    (local.set $conv (i32.load offset=8 (local.get $pend)))
    (if (i32.load offset=12 (local.get $pend))
      (then
        (i32.store (local.get $pend) (i32.const 0))
        (call $win16_dde_set_error (i32.const 0))
        (global.set $edx (i32.const 0))
        (global.set $eax (local.get $conv))
        (return (i32.const 0))))
    (if (i32.lt_u (i32.sub (call $host_real_time_ms)
                           (i32.load offset=4 (local.get $pend)))
                  (global.get $DDE_CONNECT_TIMEOUT_MS))
      (then
        (global.set $yield_reason (i32.const 8))
        (global.set $yield_flag (i32.const 1))
        (return (i32.const 1))))
    ;; Nobody is there. That is the honest answer for a room of one, and it is
    ;; what sends Hearts to its own table rather than to an error box.
    (i32.store (local.get $pend) (i32.const 0))
    (i32.store (call $win16_dde_conv_slot (i32.sub (local.get $conv) (i32.const 1)))
               (i32.const 0))
    (call $win16_dde_set_error (i32.const 0x400A))       ;; DMLERR_NO_CONV_ESTABLISHED
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.const 0))
    (i32.const 0))

  ;; Drain the wire on this instance's behalf. $vsock_pump owns the reader and
  ;; hands us anything under our magic, so this is the same call — draining it
  ;; here would take socket frames off the queue with nowhere to put them.
  (func $win16_dde_pump (call $vsock_pump))

  ;; DDEML.8 DdeDisconnect(HCONV hConv) -> BOOL.
  ;;
  ;; Tell the peer before forgetting it: a conversation the other side still
  ;; believes in is a server holding a seat for a player who has gone.
  (func $win16_DdeDisconnect
    (local $conv i32) (local $slot i32)
    (local.set $conv (call $win16_arg32 (i32.const 0)))
    (if (i32.and (i32.gt_u (local.get $conv) (i32.const 0))
                 (i32.le_u (local.get $conv) (i32.const 8)))
      (then
        (local.set $slot (call $win16_dde_conv_slot
          (i32.sub (local.get $conv) (i32.const 1))))
        (if (i32.load (local.get $slot))
          (then
            (drop (call $win16_dde_emit (i32.const 3) (local.get $conv)
              (i32.load offset=12 (local.get $slot)) (i32.const 0)))
            (i32.store (local.get $slot) (i32.const 0))))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; DDEML.11 DdeClientTransaction(LPBYTE pData, DWORD cbData, HCONV hConv,
  ;;   HSZ hszItem, UINT wFmt, UINT wType, DWORD dwTimeout, LPDWORD pdwResult)
  ;;   -> HDDEDATA in DX:AX.
  ;;
  ;; Nothing carries a transaction yet — that needs the server's own callback,
  ;; since the data being asked for lives in the application and nowhere else.
  ;;
  ;; Which error it fails with is not a detail. Now that a conversation can
  ;; really be established, answering DMLERR_NO_CONV_ESTABLISHED on a live
  ;; conversation would be the emulator telling the app something untrue about
  ;; its own state. A live conversation whose transaction nobody served is
  ;; DMLERR_NOTPROCESSED, which is exactly what a server that ignores the
  ;; transaction produces on Windows; only a handle naming no conversation
  ;; gets the other error.
  (func $win16_DdeClientTransaction
    (local $result i32) (local $conv i32) (local $live i32)
    (local.set $result (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $conv (call $win16_arg32 (i32.const 8)))
    (if (i32.and (i32.gt_u (local.get $conv) (i32.const 0))
                 (i32.le_u (local.get $conv) (i32.const 8)))
      (then (local.set $live (i32.load (call $win16_dde_conv_slot
              (i32.sub (local.get $conv) (i32.const 1)))))))
    (if (call $win16_arg16 (i32.const 1))
      (then (call $gs32 (local.get $result) (i32.const 0))))
    (call $win16_dde_set_error
      (select (i32.const 0x4009) (i32.const 0x400A) (local.get $live)))
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 28)))

  ;; DDEML.13 DdePostAdvise(DWORD idInst, HSZ hszTopic, HSZ hszItem) -> BOOL.
  ;; Nothing has an advise loop open on this item, so there is nothing to send
  ;; and saying so succeeded is the truth.
  (func $win16_DdePostAdvise
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 12)))

  ;; DDEML.14 DdeCreateDataHandle(DWORD idInst, LPBYTE pSrc, DWORD cb,
  ;;   DWORD cbOff, HSZ hszItem, UINT wFmt, UINT afCmd) -> HDDEDATA in DX:AX.
  (func $win16_DdeCreateDataHandle
    (local $src i32) (local $cb i32) (local $off i32)
    (local $i i32) (local $slot i32) (local $n i32)
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 9)) (call $win16_arg16 (i32.const 8))))
    (if (i32.eqz (call $win16_arg16 (i32.const 9))) (then (local.set $src (i32.const 0))))
    (local.set $cb (call $win16_arg32 (i32.const 6)))
    (local.set $off (call $win16_arg32 (i32.const 4)))
    (block $found (loop $scan
      (br_if $found (i32.ge_u (local.get $i) (i32.const 16)))
      (br_if $found (i32.eqz (i32.load (call $win16_dde_data_slot (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.ge_u (local.get $i) (i32.const 16))
      (then
        (call $win16_dde_set_error (i32.const 0x4001))   ;; DMLERR_LOW_MEMORY
        (global.set $edx (i32.const 0))
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 24))
        (return)))
    ;; The block is fixed-size; a larger one would be a silent truncation, so it
    ;; is refused with the error the caller already tests for.
    (if (i32.gt_u (i32.add (local.get $cb) (local.get $off)) (i32.const 512))
      (then
        (call $win16_dde_set_error (i32.const 0x4001))
        (global.set $edx (i32.const 0))
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 24))
        (return)))
    (local.set $slot (call $win16_dde_data_slot (local.get $i)))
    (i32.store (local.get $slot) (i32.const 1))
    (i32.store offset=4 (local.get $slot) (i32.add (local.get $cb) (local.get $off)))
    (call $zero_memory (i32.add (local.get $slot) (i32.const 8)) (local.get $off))
    (if (i32.and (i32.ne (local.get $src) (i32.const 0)) (local.get $cb))
      (then
        (block $done (loop $copy
          (br_if $done (i32.ge_u (local.get $n) (local.get $cb)))
          (i32.store8
            (i32.add (i32.add (i32.add (local.get $slot) (i32.const 8)) (local.get $off))
                     (local.get $n))
            (call $gl8 (i32.add (local.get $src) (local.get $n))))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))
          (br $copy)))))
    (call $win16_dde_set_error (i32.const 0))
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.add (local.get $i) (i32.const 0x100)))
    (call $win16_api_return (i32.const 24)))

  ;; DDEML.16 DdeGetData(HDDEDATA hData, LPBYTE pDst, DWORD cbMax, DWORD cbOff)
  ;;   -> the byte count, in DX:AX. A NULL destination asks for the size, which
  ;;   is how Hearts uses it.
  (func $win16_DdeGetData
    (local $h i32) (local $dst i32) (local $max i32) (local $off i32)
    (local $slot i32) (local $len i32) (local $n i32)
    (local.set $h (call $win16_arg32 (i32.const 6)))
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (if (i32.eqz (call $win16_arg16 (i32.const 5))) (then (local.set $dst (i32.const 0))))
    (local.set $max (call $win16_arg32 (i32.const 2)))
    (local.set $off (call $win16_arg32 (i32.const 0)))
    (local.set $h (i32.sub (local.get $h) (i32.const 0x100)))
    (if (i32.ge_u (local.get $h) (i32.const 16))
      (then
        (call $win16_dde_set_error (i32.const 0x4004))   ;; DMLERR_INVALIDPARAMETER
        (global.set $edx (i32.const 0))
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 16))
        (return)))
    (local.set $slot (call $win16_dde_data_slot (local.get $h)))
    (local.set $len (i32.load offset=4 (local.get $slot)))
    (if (i32.eqz (local.get $dst))
      (then
        (global.set $edx (i32.shr_u (local.get $len) (i32.const 16)))
        (global.set $eax (i32.and (local.get $len) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 16))
        (return)))
    (if (i32.gt_u (local.get $off) (local.get $len))
      (then (local.set $off (local.get $len))))
    (local.set $len (i32.sub (local.get $len) (local.get $off)))
    (if (i32.gt_u (local.get $len) (local.get $max)) (then (local.set $len (local.get $max))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $n) (local.get $len)))
      (call $gs8 (i32.add (local.get $dst) (local.get $n))
        (i32.load8_u (i32.add (i32.add (i32.add (local.get $slot) (i32.const 8))
                                       (local.get $off))
                              (local.get $n))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $copy)))
    (global.set $edx (i32.shr_u (local.get $len) (i32.const 16)))
    (global.set $eax (i32.and (local.get $len) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 16)))

  ;; DDEML.20 DdeGetLastError(DWORD idInst) -> UINT, and clears it.
  (func $win16_DdeGetLastError
    (global.set $eax (i32.load (call $win16_dde_error_slot)))
    (i32.store (call $win16_dde_error_slot) (i32.const 0))
    (call $win16_api_return (i32.const 4)))

  (func $win16_ddeml (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 2))
      (then (call $win16_DdeInitialize) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 3))
      (then (call $win16_DdeUninitialize) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 7))
      (then (call $win16_DdeConnect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 8))
      (then (call $win16_DdeDisconnect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 11))
      (then (call $win16_DdeClientTransaction) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 13))
      (then (call $win16_DdePostAdvise) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 14))
      (then (call $win16_DdeCreateDataHandle) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 16))
      (then (call $win16_DdeGetData) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 20))
      (then (call $win16_DdeGetLastError) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 21))
      (then (call $win16_DdeCreateStringHandle) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 22))
      (then (call $win16_DdeFreeStringHandle) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 27))
      (then (call $win16_DdeNameService) (return (i32.const 1))))
    (i32.const 0))
