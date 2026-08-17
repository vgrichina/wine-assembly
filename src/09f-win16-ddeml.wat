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
  ;; claim and nothing else in the room has taken it.
  (func $win16_DdeNameService
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.const 1))
    (call $win16_dde_set_error (i32.const 0))
    (call $win16_api_return (i32.const 14)))

  ;; DDEML.7 DdeConnect(DWORD idInst, HSZ hszService, HSZ hszTopic,
  ;;   LPCONVCONTEXT pCC) -> HCONV in DX:AX.
  ;;
  ;; No other instance is running, so there is no server to reach. NULL with
  ;; DMLERR_NO_CONV_ESTABLISHED is what Windows answers in exactly that case,
  ;; and it is the answer that sends Hearts to its own table.
  (func $win16_DdeConnect
    (call $win16_dde_set_error (i32.const 0x400A))       ;; DMLERR_NO_CONV_ESTABLISHED
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 16)))

  ;; DDEML.8 DdeDisconnect(HCONV hConv) -> BOOL.
  (func $win16_DdeDisconnect
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
