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
    (if (i32.lt_u (local.get $n) (global.get $DDE_HDR)) (then (return)))
    (local.set $type     (i32.load offset=4  (local.get $wa)))
    (local.set $tag      (i32.load offset=8  (local.get $wa)))
    (local.set $src_conv (i32.load offset=12 (local.get $wa)))
    (local.set $dst_conv (i32.load offset=16 (local.get $wa)))
    ;; Our own broadcast coming back to us. A room is a broadcast segment, so
    ;; this is normal and not an error.
    (if (i32.eq (local.get $tag) (call $win16_dde_tag)) (then (return)))

    ;; A client is looking for a service. Answer only if some instance here
    ;; has registered exactly that name.
    (if (i32.eq (local.get $type) (i32.const 1))
      (then
        (block $answered (loop $scan
          (br_if $answered (i32.ge_u (local.get $i) (i32.const 8)))
          (local.set $svc (i32.load (call $win16_dde_service_slot (local.get $i))))
          (if (i32.and
                (i32.ne (i32.load (call $win16_dde_inst (local.get $i))) (i32.const 0))
                (call $win16_dde_hsz_is (local.get $svc)
                  (i32.add (local.get $wa) (global.get $DDE_HDR))))
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
  ;; How long to wait is measured in milliseconds, not in passes. A count of
  ;; passes looks like a timeout and is not one: a parked task runs nothing, so
  ;; sixty-four passes is sixty-four batch boundaries and can be under a
  ;; millisecond of wall clock — long enough for another instance sharing this
  ;; process's run loop to answer, and nowhere near long enough for one in
  ;; another OS process, whose reply has to cross child IPC. DDEML's own
  ;; DdeConnect is bounded by time for the same reason.
  (global $DDE_CONNECT_TIMEOUT_MS i32 (i32.const 3000))

  (func $win16_DdeConnect
    (local $inst i32) (local $svc i32) (local $topic i32)
    (local $pend i32) (local $conv i32) (local $wa i32) (local $len i32)
    (local.set $pend (call $win16_dde_pending_slot))
    (local.set $inst (call $win16_arg32 (i32.const 6)))

    ;; First entry: take a conversation slot and put the request on the wire.
    (if (i32.eqz (i32.load (local.get $pend)))
      (then
        (local.set $conv (call $win16_dde_conv_alloc (local.get $inst) (i32.const 0)))
        (if (i32.eqz (local.get $conv))
          (then
            (call $win16_dde_set_error (i32.const 0x4001))   ;; DMLERR_LOW_MEMORY
            (global.set $edx (i32.const 0))
            (global.set $eax (i32.const 0))
            (call $win16_api_return (i32.const 16))
            (return)))
        (i32.store (local.get $pend) (i32.const 1))
        (i32.store offset=4  (local.get $pend) (call $host_get_ticks))
        (i32.store offset=8  (local.get $pend) (local.get $conv))
        (i32.store offset=12 (local.get $pend) (i32.const 0))
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
              (i32.sub (local.get $len) (global.get $DDE_HDR))))))))

    (call $win16_dde_pump)
    (local.set $conv (i32.load offset=8 (local.get $pend)))

    ;; Answered: the conversation is live and the handle is the caller's.
    (if (i32.load offset=12 (local.get $pend))
      (then
        (i32.store (local.get $pend) (i32.const 0))
        (call $win16_dde_set_error (i32.const 0))
        (global.set $edx (i32.const 0))
        (global.set $eax (local.get $conv))
        (call $win16_api_return (i32.const 16))
        (return)))

    ;; Still waiting. Give the room another pass until the time is up.
    (if (i32.lt_u (i32.sub (call $host_get_ticks) (i32.load offset=4 (local.get $pend)))
                  (global.get $DDE_CONNECT_TIMEOUT_MS))
      (then
        ;; End the batch without returning, so the host runs everyone else —
        ;; including the instance that has to answer — and re-enters here.
        ;;
        ;; $yield_flag ONLY. Raising $yield_reason as well says "a blocking API
        ;; is waiting", and the host answers that by resuming the 32-bit way:
        ;; it pops a stdcall frame and takes a linear return address off the
        ;; task's own stack. For a 16-bit task there is no such frame, so EIP
        ;; came back as two words of whatever was there — out of the selector
        ;; arena, which is the trap $run raises as 0xCA165E21. It is the same
        ;; hazard that stops GetMessage being bridged; the difference is that
        ;; nothing here needs the host's help to resume, only its permission to
        ;; end the batch.
        (global.set $yield_flag (i32.const 1))
        (return)))

    (i32.store (local.get $pend) (i32.const 0))
    (i32.store (call $win16_dde_conv_slot (i32.sub (local.get $conv) (i32.const 1)))
               (i32.const 0))
    (call $win16_dde_set_error (i32.const 0x400A))       ;; DMLERR_NO_CONV_ESTABLISHED
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 16)))

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
  ;; There is no conversation to carry it, so it fails the way a transaction on
  ;; a dead conversation fails.
  (func $win16_DdeClientTransaction
    (local $result i32)
    (local.set $result (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (if (call $win16_arg16 (i32.const 1))
      (then (call $gs32 (local.get $result) (i32.const 0))))
    (call $win16_dde_set_error (i32.const 0x400A))       ;; DMLERR_NO_CONV_ESTABLISHED
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
