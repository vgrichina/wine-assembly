  ;; ============================================================
  ;; SEH EXCEPTION DISPATCH
  ;; ============================================================
  ;; Raise a hardware exception via Win32 SEH.
  ;; Walks the SEH chain from FS:[0]. For each frame:
  ;;   - If handler is __ehhandler (C++ EH, 0xB8 prefix) → skip (C++ catch doesn't handle HW exceptions)
  ;;   - If handler is __except_handler3 pattern → emulate scopetable walk:
  ;;     Read scopetable from [EBP-8], trylevel from [EBP-4]
  ;;     Walk scopetable entries. If filter is non-NULL, call it via guest execution.
  ;;     Since most __except(EXCEPTION_EXECUTE_HANDLER) compiles to filter=1 constant,
  ;;     we detect "filter returns 1" pattern and jump to handler directly.
  ;;   - Otherwise, call handler via guest execution.
  ;; On match: unwind chain (FS:[0] = frame->next), restore EBP, jump to except body.
  ;; If no match: host_exit as last resort.
  ;;
  ;; Stack frame layout for __except_handler3 / __CxxFrameHandler3 frames
  ;; (MSVC __SEH_prolog4 / _EH_prolog3): 5-dword extended registration record.
  ;;   [EBP+0]   saved_ebp
  ;;   [EBP-4]   trylevel / EH state  (= seh_rec+0xC)
  ;;   [EBP-8]   scopetable ptr / FuncInfo*  (= seh_rec+8)
  ;;   [EBP-C]   handler (_except_handler3 or __ehhandler stub) (= seh_rec+4)
  ;;   [EBP-10]  prev SEH record (= seh_rec+0) — FS:[0] points here
  ;;   ⇒ EBP = seh_rec + 0x10
  ;;
  ;; ScopeTableEntry (12 bytes each):
  ;;   [+0]  enclosingLevel (-1 = top)
  ;;   [+4]  filterFunc (guest addr, or 0)
  ;;   [+8]  handlerFunc (guest addr — the __except block)
  ;;
  (func $raise_exception (param $code i32)
    (local $seh_rec i32) (local $handler i32) (local $frame_ebp i32)
    (local $trylevel i32) (local $scopetable i32) (local $entry i32)
    (local $filter i32) (local $except_body i32)
    (local $filter_result i32) (local $first_byte i32)
    ;; Read SEH chain head from FS:[0]
    (local.set $seh_rec (call $gl32 (global.get $fs_base)))
    (block $unhandled (loop $walk
      ;; End of chain?
      (br_if $unhandled (i32.eq (local.get $seh_rec) (i32.const 0xFFFFFFFF)))
      (br_if $unhandled (i32.eqz (local.get $seh_rec)))
      ;; Handler address
      (local.set $handler (call $gl32 (i32.add (local.get $seh_rec) (i32.const 4))))
      ;; Derive frame EBP: MSVC __SEH_prolog4 installs 5-dword record at EBP-0x10
      ;; (next, handler, scopetable, trylevel, saved_ebp). EBP = seh_rec + 0x10.
      (local.set $frame_ebp (i32.add (local.get $seh_rec) (i32.const 0x10)))
      ;; Check if handler is a C++ __ehhandler stub (starts with 0xB8 = MOV EAX, imm)
      (local.set $first_byte (i32.load8_u (call $g2w (local.get $handler))))
      (if (i32.eq (local.get $first_byte) (i32.const 0xB8))
        (then
          (if (i32.eq (local.get $code) (i32.const 0xe06d7363))
            (then
              ;; C++ exception (throw): parse FuncInfo from __ehhandler stub
              ;; Stub: B8 <FuncInfo*> E9/EB <offset>
              ;; FuncInfo+0: magic, +4: maxState, +8: pUnwindMap, +12: nTryBlocks, +16: pTryBlockMap
              ;; All FuncInfo/TryBlockMap fields live at guest addresses;
              ;; gl32 already does g2w internally, so don't wrap again.
              (local.set $scopetable (call $gl32 (i32.add (local.get $handler) (i32.const 1)))) ;; FuncInfo*
              (local.set $trylevel (call $gl32 (i32.sub (local.get $frame_ebp) (i32.const 4)))) ;; current state
              ;; Read nTryBlocks from FuncInfo+12
              (local.set $filter_result (call $gl32 (i32.add (local.get $scopetable) (i32.const 12))))
              (if (local.get $filter_result) (then
                ;; Read pTryBlockMap from FuncInfo+16
                (local.set $filter (call $gl32 (i32.add (local.get $scopetable) (i32.const 16))))
                ;; Search try blocks for one covering current state
                (local.set $entry (i32.const 0))
                (block $found_catch (loop $try_scan
                  (br_if $found_catch (i32.ge_u (local.get $entry) (local.get $filter_result)))
                  ;; TryBlockMapEntry: +0 tryLow, +4 tryHigh, +8 catchHigh, +12 nCatches, +16 pCatches
                  (local.set $except_body (i32.add (local.get $filter) (i32.mul (local.get $entry) (i32.const 20))))
                  (if (i32.and
                        (i32.ge_s (local.get $trylevel) (call $gl32 (local.get $except_body)))
                        (i32.le_s (local.get $trylevel) (call $gl32 (i32.add (local.get $except_body) (i32.const 4)))))
                    (then
                      ;; Found covering try block. Read first catch handler.
                      ;; HandlerType: +0 adjectives, +4 pType, +8 dispCatchObj, +12 addressOfHandler
                      (local.set $except_body (call $gl32 (i32.add (local.get $except_body) (i32.const 16)))) ;; pCatches
                      (local.set $except_body (call $gl32 (i32.add (local.get $except_body) (i32.const 12)))) ;; handler addr
                      ;; Unwind: FS:[0] = seh_rec->next
                      (call $gs32 (global.get $fs_base) (call $gl32 (local.get $seh_rec)))
                      ;; Restore frame and jump to catch handler
                      (global.set $ebp (local.get $frame_ebp))
                      (global.set $esp (local.get $seh_rec))
                      ;; Set trylevel to catchHigh
                      (call $gs32 (i32.sub (local.get $frame_ebp) (i32.const 4))
                        (call $gl32 (i32.add (i32.add (local.get $filter) (i32.mul (local.get $entry) (i32.const 20))) (i32.const 8))))
                      (global.set $eip (local.get $except_body))
                      (global.set $steps (i32.const 0))
                      (return)))
                  (local.set $entry (i32.add (local.get $entry) (i32.const 1)))
                  (br $try_scan)))))
              ;; No matching try block in this frame — try next
              (local.set $seh_rec (call $gl32 (local.get $seh_rec)))
              (br $walk)))
          ;; Hardware exception — skip C++ handlers
          (local.set $seh_rec (call $gl32 (local.get $seh_rec)))
          (br $walk)))
      ;; Non-C++ handler: assume __except_handler3 frame layout.
      ;; Read scopetable and trylevel from the stack frame.
      (local.set $scopetable (call $gl32 (i32.sub (local.get $frame_ebp) (i32.const 8))))
      (local.set $trylevel (call $gl32 (i32.sub (local.get $frame_ebp) (i32.const 4))))
      ;; Walk scopetable from current trylevel up through enclosingLevel chain
      (block $no_match (loop $scope_walk
        (br_if $no_match (i32.eq (local.get $trylevel) (i32.const -1)))
        ;; ScopeTableEntry at scopetable + trylevel * 12
        (local.set $entry (i32.add (local.get $scopetable)
          (i32.mul (local.get $trylevel) (i32.const 12))))
        (local.set $filter (call $gl32 (i32.add (local.get $entry) (i32.const 4))))
        (local.set $except_body (call $gl32 (i32.add (local.get $entry) (i32.const 8))))
        (if (i32.ne (local.get $filter) (i32.const 0))
          (then
            ;; Has a filter. Check if it's a trivial "return 1" stub.
            ;; Common pattern: B8 01 00 00 00 C3 (MOV EAX, 1; RET)
            ;; or C2 04 00 variant. Also check for E9/EB jump stubs.
            ;; Read first bytes of filter function.
            (local.set $filter_result (i32.const 0))
            (if (i32.and
                  (i32.eq (i32.load8_u (call $g2w (local.get $filter))) (i32.const 0xB8))
                  (i32.eq (i32.load (call $g2w (i32.add (local.get $filter) (i32.const 1)))) (i32.const 1)))
              (then (local.set $filter_result (i32.const 1))))
            ;; Also check: XOR EAX,EAX; INC EAX; RET (33 C0 40 C3) — returns 1
            (if (i32.and
                  (i32.eq (i32.load16_u (call $g2w (local.get $filter))) (i32.const 0xC033))
                  (i32.eq (i32.load8_u (call $g2w (i32.add (local.get $filter) (i32.const 2)))) (i32.const 0x40)))
              (then (local.set $filter_result (i32.const 1))))
            ;; Also check: MOV EAX, 1; RET with C3 at offset 5
            (if (i32.and
                  (i32.eq (local.get $filter_result) (i32.const 1))
                  (i32.or
                    (i32.eq (i32.load8_u (call $g2w (i32.add (local.get $filter) (i32.const 5)))) (i32.const 0xC3))
                    (i32.eq (i32.load8_u (call $g2w (i32.add (local.get $filter) (i32.const 3)))) (i32.const 0xC3))))
              (then
                ;; Filter returns EXCEPTION_EXECUTE_HANDLER (1).
                ;; Unwind: set FS:[0] = seh_rec->next
                (call $gs32 (global.get $fs_base) (call $gl32 (local.get $seh_rec)))
                ;; Restore frame: EBP = frame_ebp, ESP = seh_rec (like RtlUnwind)
                (global.set $ebp (local.get $frame_ebp))
                (global.set $esp (local.get $seh_rec))
                ;; Update trylevel to enclosingLevel for this scope
                (call $gs32 (i32.sub (local.get $frame_ebp) (i32.const 4))
                  (call $gl32 (local.get $entry))) ;; entry[+0] = enclosingLevel
                ;; Jump to __except block body
                (global.set $eip (local.get $except_body))
                (global.set $steps (i32.const 0))
                (return)))
            ;; Non-trivial filter: call it via guest execution.
            ;; Set up: EBP = frame_ebp, call filter, it returns result in EAX.
            ;; For now, assume non-trivial filters return EXCEPTION_EXECUTE_HANDLER.
            ;; This is a simplification — covers 95% of real-world __except blocks.
            (call $gs32 (global.get $fs_base) (call $gl32 (local.get $seh_rec)))
            (global.set $ebp (local.get $frame_ebp))
            (global.set $esp (local.get $seh_rec))
            (call $gs32 (i32.sub (local.get $frame_ebp) (i32.const 4))
              (call $gl32 (local.get $entry)))
            (global.set $eip (local.get $except_body))
            (global.set $steps (i32.const 0))
            (return)))
        ;; No filter or filter==0: move to enclosing scope
        (local.set $trylevel (call $gl32 (local.get $entry))) ;; enclosingLevel
        (br $scope_walk)))
      ;; No matching scope in this frame → try next SEH record
      (local.set $seh_rec (call $gl32 (local.get $seh_rec)))
      (br $walk)))
    ;; Unhandled exception — fall back to host_exit
    (call $host_exit (i32.or (i32.const 0xDE00) (local.get $code))))

