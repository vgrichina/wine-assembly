  ;; ============================================================
  ;; NE (New Executable) LOADER — 16-bit Windows images
  ;; ============================================================
  ;;
  ;; An NE image is a list of segments rather than a flat mapping. Each one is
  ;; loaded somewhere and referred to by a selector, and every cross-segment or
  ;; imported reference is patched afterwards from the segment's own relocation
  ;; table. There is no image base to slide: the fixups ARE the linking step.
  ;;
  ;; Address space. Selector N is laid out at WIN16_ARENA + (N-1) * 64KB, so a
  ;; selector is just an index and its base is arithmetic rather than a lookup
  ;; when that helps. The selector value written into guest memory follows the
  ;; protected-mode convention — (index << 3) | 7 — because guest code compares
  ;; and increments selectors and expects the low three bits to be the RPL and
  ;; table bit. WIN16_SEG_TABLE keeps base/limit/flags per index.
  ;;
  ;; Imports. A far reference to USER.#113 cannot be resolved to real code, so
  ;; it is patched to point into one synthetic segment of thunks:
  ;; WIN16_THUNK_SEL:(slot * 4). WIN16_THUNK_TABLE records the module and
  ;; ordinal behind each slot. This is the same shape as the 32-bit loader's
  ;; THUNK_BASE, which lets the existing "EIP landed in the thunk zone" check
  ;; stay the single place that recognises an API call.

  ;; Selector <-> index. Index 0 is the null selector and is never allocated.
  (func $win16_sel_to_index (param $sel i32) (result i32)
    (i32.shr_u (local.get $sel) (i32.const 3)))

  (func $win16_index_to_sel (param $index i32) (result i32)
    (i32.or (i32.shl (local.get $index) (i32.const 3)) (i32.const 7)))

  ;; Guest base address of a selector index, from the table so a future
  ;; loader can place a segment somewhere other than its arena slot.
  (func $win16_seg_base (export "win16_seg_base") (param $index i32) (result i32)
    (if (i32.or (i32.eqz (local.get $index))
                (i32.ge_u (local.get $index) (global.get $WIN16_SEG_MAX)))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $WIN16_SEG_TABLE)
                       (i32.mul (local.get $index) (i32.const 16)))))

  (func $win16_seg_limit (export "win16_seg_limit") (param $index i32) (result i32)
    (if (i32.ge_u (local.get $index) (global.get $WIN16_SEG_MAX))
      (then (return (i32.const 0))))
    (i32.load offset=4 (i32.add (global.get $WIN16_SEG_TABLE)
                                (i32.mul (local.get $index) (i32.const 16)))))

  (func $win16_seg_set (param $index i32) (param $base i32) (param $limit i32)
        (param $flags i32) (param $ne_seg i32)
    (local $e i32)
    (local.set $e (i32.add (global.get $WIN16_SEG_TABLE)
                           (i32.mul (local.get $index) (i32.const 16))))
    (i32.store          (local.get $e) (local.get $base))
    (i32.store offset=4 (local.get $e) (local.get $limit))
    (i32.store offset=8 (local.get $e) (local.get $flags))
    (i32.store offset=12 (local.get $e) (local.get $ne_seg)))

  ;; Translate a far pointer (selector:offset) to a guest linear address.
  (func $win16_far_to_guest (export "win16_far_to_guest") (param $sel i32) (param $off i32) (result i32)
    (i32.add (call $win16_seg_base (call $win16_sel_to_index (local.get $sel)))
             (i32.and (local.get $off) (i32.const 0xFFFF))))

  ;; ---- Module names ----
  ;;
  ;; The imported-name table stores Pascal strings. Compare one against a
  ;; NUL-terminated ASCII constant, case-sensitively: NE name tables are
  ;; always upper case.
  ;; A mismatch has to `return 0`, not branch out of the compare loop: falling
  ;; out of the block lands on the same "the literal ends here" expression the
  ;; success path uses, which makes every equal-length pair compare equal.
  ;; DDEML matched SOUND that way.
  (func $win16_pstr_eq (param $p i32) (param $lit i32) (result i32)
    (local $n i32) (local $i i32)
    (local.set $n (i32.load8_u (local.get $p)))
    ;; No module name is this long; refuse rather than read past the table.
    (if (i32.gt_u (local.get $n) (i32.const 16)) (then (return (i32.const 0))))
    (if (i32.ne (i32.load8_u (i32.add (local.get $lit) (local.get $n))) (i32.const 0))
      (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (if (i32.ne (i32.load8_u (i32.add (i32.add (local.get $p) (i32.const 1)) (local.get $i)))
                  (i32.load8_u (i32.add (local.get $lit) (local.get $i))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 1))

  ;; Address of module reference `index`'s name, as a Pascal string. $ne_off is
  ;; the absolute address of the NE header in the staged file.
  (func $win16_module_name (param $ne_off i32) (param $index i32) (result i32)
    (i32.add
      (i32.add (local.get $ne_off) (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x2A))))
      (i32.load16_u
        (i32.add
          (i32.add (local.get $ne_off) (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x28))))
          (i32.shl (i32.sub (local.get $index) (i32.const 1)) (i32.const 1))))))

  ;; Map a module name to the small id the API dispatcher uses. Unknown
  ;; modules get 0, which makes every call through them fail loudly rather
  ;; than silently returning into nothing.
  (func $win16_module_id (param $pstr i32) (result i32)
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_KERNEL))   (then (return (i32.const 1))))
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_USER))     (then (return (i32.const 2))))
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_GDI))      (then (return (i32.const 3))))
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_KEYBOARD)) (then (return (i32.const 4))))
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_SOUND))    (then (return (i32.const 5))))
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_SHELL))    (then (return (i32.const 6))))
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_MMSYSTEM)) (then (return (i32.const 7))))
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_COMMDLG))  (then (return (i32.const 8))))
    (if (call $win16_pstr_eq (local.get $pstr) (global.get $WIN16_NAME_CARDS))    (then (return (i32.const 9))))
    (i32.const 0))

  ;; ---- Import thunks ----
  ;;
  ;; One slot per distinct (module, ordinal). Reusing a slot keeps the thunk
  ;; segment small enough to stay inside one selector and makes a trace of
  ;; thunk hits readable.
  ;; `is_name` distinguishes the two ways an import can be written down. Most
  ;; are IMPORTORDINAL and `value` is the ordinal; an IMPORTNAME says the name
  ;; instead, and `value` is its offset in the imported-name table. FREECELL
  ;; imports CARDS.CDTINIT and SHELL.SHELLABOUT that way and MSHEARTS one more,
  ;; so this is not a corner worth deferring: without the flag they all land on
  ;; module 0 and the trap cannot say what was wanted.
  (func $win16_thunk_for (param $module_id i32) (param $value i32) (param $is_name i32) (result i32)
    (local $i i32) (local $key i32) (local $e i32)
    (local.set $key (i32.or
      (i32.or (i32.shl (local.get $module_id) (i32.const 16))
              (i32.and (local.get $value) (i32.const 0xFFFF)))
      (i32.shl (i32.ne (local.get $is_name) (i32.const 0)) (i32.const 31))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $win16_thunk_count)))
      (if (i32.eq (i32.load (i32.add (global.get $WIN16_THUNK_TABLE)
                                     (i32.shl (local.get $i) (i32.const 2))))
                  (local.get $key))
        (then (return (i32.mul (local.get $i) (i32.const 4)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.ge_u (global.get $win16_thunk_count) (global.get $WIN16_THUNK_MAX))
      (then
        (call $host_log_i32 (i32.const 0xCA16F017))  ;; thunk table full
        (unreachable)))
    (local.set $i (global.get $win16_thunk_count))
    (i32.store (i32.add (global.get $WIN16_THUNK_TABLE) (i32.shl (local.get $i) (i32.const 2)))
               (local.get $key))
    (global.set $win16_thunk_count (i32.add (local.get $i) (i32.const 1)))
    (i32.mul (local.get $i) (i32.const 4)))

  ;; Module id, ordinal and import kind behind a thunk offset, for the
  ;; dispatcher. The module id masks off the name flag in bit 31.
  (func $win16_thunk_module (export "win16_thunk_module") (param $off i32) (result i32)
    (i32.and
      (i32.shr_u (i32.load (i32.add (global.get $WIN16_THUNK_TABLE)
                                    (i32.and (local.get $off) (i32.const 0xFFFC))))
                 (i32.const 16))
      (i32.const 0x7FFF)))

  (func $win16_thunk_is_name (export "win16_thunk_is_name") (param $off i32) (result i32)
    (i32.shr_u (i32.load (i32.add (global.get $WIN16_THUNK_TABLE)
                                  (i32.and (local.get $off) (i32.const 0xFFFC))))
               (i32.const 31)))

  ;; Where the imported name behind a name-import thunk lives, as a linear
  ;; memory address in the staged file: a Pascal string the host can read.
  (func $win16_thunk_name_addr (export "win16_thunk_name_addr") (param $off i32) (result i32)
    (i32.add
      (i32.add (global.get $win16_ne_off)
               (i32.load16_u (i32.add (global.get $win16_ne_off) (i32.const 0x2A))))
      (call $win16_thunk_ordinal (local.get $off))))

  (func $win16_thunk_ordinal (export "win16_thunk_ordinal") (param $off i32) (result i32)
    (i32.and (i32.load (i32.add (global.get $WIN16_THUNK_TABLE)
                                (i32.and (local.get $off) (i32.const 0xFFFC))))
             (i32.const 0xFFFF)))

  ;; ---- Entry table ----
  ;;
  ;; Ordinal -> (segment, offset). Bundles are runs of entries that share a
  ;; segment; a bundle with segment indicator 0 is a gap that consumes
  ;; ordinals without defining any. 0xFF marks a moveable bundle, whose
  ;; entries carry an INT 3Fh thunk ahead of the real segment/offset.
  (func $win16_entry_lookup (param $ne_off i32) (param $ordinal i32)
        (param $out_seg i32) (result i32)
    (local $p i32) (local $end i32) (local $count i32) (local $ind i32)
    (local $cur i32) (local $i i32)
    (local.set $p (i32.add (local.get $ne_off)
                    (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x04)))))
    (local.set $end (i32.add (local.get $p)
                      (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x06)))))
    (local.set $cur (i32.const 1))
    (block $done (loop $bundles
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (local.set $count (i32.load8_u (local.get $p)))
      (local.set $ind (i32.load8_u (i32.add (local.get $p) (i32.const 1))))
      (br_if $done (i32.eqz (local.get $count)))
      (local.set $p (i32.add (local.get $p) (i32.const 2)))
      (if (i32.eqz (local.get $ind))
        (then
          (local.set $cur (i32.add (local.get $cur) (local.get $count)))
          (br $bundles)))
      (local.set $i (i32.const 0))
      (block $bd (loop $bl
        (br_if $bd (i32.ge_u (local.get $i) (local.get $count)))
        (if (i32.eq (local.get $ind) (i32.const 0xFF))
          (then
            (if (i32.eq (local.get $cur) (local.get $ordinal))
              (then
                (i32.store (local.get $out_seg) (i32.load8_u (i32.add (local.get $p) (i32.const 3))))
                (return (i32.load16_u (i32.add (local.get $p) (i32.const 4))))))
            (local.set $p (i32.add (local.get $p) (i32.const 6))))
          (else
            (if (i32.eq (local.get $cur) (local.get $ordinal))
              (then
                (i32.store (local.get $out_seg) (local.get $ind))
                (return (i32.load16_u (i32.add (local.get $p) (i32.const 1))))))
            (local.set $p (i32.add (local.get $p) (i32.const 3)))))
        (local.set $cur (i32.add (local.get $cur) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $bl)))
      (br $bundles)))
    (i32.store (local.get $out_seg) (i32.const 0))
    (i32.const 0))

  ;; ---- Relocations ----
  ;;
  ;; Every record names one target and the head of a chain of places to write
  ;; it. For a non-additive record the word already sitting at each site is
  ;; the offset of the next site, 0xFFFF ending the chain; for an additive one
  ;; there is no chain and the target is added to what is there.
  ;; $seg_wa is where the segment was placed and is written; $rec_wa is where
  ;; its relocation records live in the staged file. They are not the same
  ;; place: the records sit past the segment's own length, and only `seg_len`
  ;; bytes were copied out.
  (func $win16_apply_relocs (param $seg_wa i32) (param $seg_len i32) (param $rec_wa i32)
        (param $ne_off i32)
    (local $p i32) (local $count i32) (local $i i32)
    (local $addr_type i32) (local $rel_type i32) (local $additive i32)
    (local $site i32) (local $a i32) (local $c i32)
    (local $tgt_sel i32) (local $tgt_off i32) (local $next i32) (local $seg_out i32)
    (local.set $p (local.get $rec_wa))
    (local.set $count (i32.load16_u (local.get $p)))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (local.set $seg_out (i32.add (global.get $WIN16_SEG_TABLE)
                                 (i32.mul (global.get $WIN16_SEG_MAX) (i32.const 16))))
    (block $done (loop $records
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $addr_type (i32.and (i32.load8_u (local.get $p)) (i32.const 0x0F)))
      (local.set $rel_type  (i32.and (i32.load8_u (i32.add (local.get $p) (i32.const 1))) (i32.const 0x03)))
      (local.set $additive  (i32.ne (i32.and (i32.load8_u (i32.add (local.get $p) (i32.const 1)))
                                             (i32.const 0x04)) (i32.const 0)))
      (local.set $site (i32.load16_u (i32.add (local.get $p) (i32.const 2))))
      (local.set $a    (i32.load16_u (i32.add (local.get $p) (i32.const 4))))
      (local.set $c    (i32.load16_u (i32.add (local.get $p) (i32.const 6))))

      ;; Resolve the target to selector:offset.
      (if (i32.eqz (local.get $rel_type))
        (then
          ;; INTERNALREF. Segment 0xFF means "look the ordinal up in the entry
          ;; table" — the linker did not know the segment at link time.
          (if (i32.eq (local.get $a) (i32.const 0xFF))
            (then
              (local.set $tgt_off (call $win16_entry_lookup (local.get $ne_off) (local.get $c) (local.get $seg_out)))
              (local.set $tgt_sel (call $win16_index_to_sel (i32.load (local.get $seg_out)))))
            (else
              (local.set $tgt_sel (call $win16_index_to_sel (local.get $a)))
              (local.set $tgt_off (local.get $c)))))
        (else
          (if (i32.eq (local.get $rel_type) (i32.const 1))
            (then
              ;; IMPORTORDINAL. `a` indexes the module-reference table, whose
              ;; entries are offsets into the imported-name table, where the
              ;; module's Pascal-string name lives.
              (local.set $tgt_sel (global.get $WIN16_THUNK_SEL))
              (local.set $tgt_off (call $win16_thunk_for
                (call $win16_module_id (call $win16_module_name (local.get $ne_off) (local.get $a)))
                (local.get $c) (i32.const 0))))
            (else
              ;; IMPORTNAME (2) names the entry point instead of numbering it,
              ;; with `c` an offset into the imported-name table. The module is
              ;; still named the same way, so record both and let the
              ;; dispatcher report `CARDS.CDTINIT` rather than a bare number.
              ;; OSFIXUP (3) is a floating-point emulator patch, which is not
              ;; an import at all; it lands here with module 0 and says so.
              (local.set $tgt_sel (global.get $WIN16_THUNK_SEL))
              (local.set $tgt_off (call $win16_thunk_for
                (if (result i32) (i32.eq (local.get $rel_type) (i32.const 2))
                  (then (call $win16_module_id (call $win16_module_name (local.get $ne_off) (local.get $a))))
                  (else (i32.const 0)))
                (local.get $c)
                (i32.eq (local.get $rel_type) (i32.const 2))))))))

      ;; Walk the chain and write every site.
      (block $chain_done (loop $chain
        (br_if $chain_done (i32.ge_u (local.get $site) (i32.const 0xFFFF)))
        (br_if $chain_done (i32.ge_u (local.get $site) (local.get $seg_len)))
        (local.set $next (i32.load16_u (i32.add (local.get $seg_wa) (local.get $site))))
        (if (i32.eq (local.get $addr_type) (i32.const 2))
          (then
            ;; SEGMENT: selector only
            (i32.store16 (i32.add (local.get $seg_wa) (local.get $site)) (local.get $tgt_sel)))
          (else
            (if (i32.eq (local.get $addr_type) (i32.const 5))
              (then
                ;; OFFSET: 16-bit offset only
                (i32.store16 (i32.add (local.get $seg_wa) (local.get $site))
                  (i32.add (local.get $tgt_off)
                           (select (local.get $next) (i32.const 0) (local.get $additive)))))
              (else
                (if (i32.eqz (local.get $addr_type))
                  (then
                    ;; LOBYTE
                    (i32.store8 (i32.add (local.get $seg_wa) (local.get $site)) (local.get $tgt_off)))
                  (else
                    ;; FAR_ADDR (3) and anything else pointer-shaped: off:sel
                    (i32.store16 (i32.add (local.get $seg_wa) (local.get $site)) (local.get $tgt_off))
                    (i32.store16 (i32.add (i32.add (local.get $seg_wa) (local.get $site)) (i32.const 2))
                                 (local.get $tgt_sel))))))))
        ;; Additive records patch one site and stop; chained ones follow the
        ;; link that was sitting in the low word before the write.
        (br_if $chain_done (local.get $additive))
        (local.set $site (local.get $next))
        (br $chain)))

      (local.set $p (i32.add (local.get $p) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $records))))

  ;; ---- Loader ----
  ;;
  ;; Returns the entry point as a far address (selector << 16) | offset, or a
  ;; negative error: -1 not MZ, -2 not NE, -3 too many segments.
  (func $load_ne (export "load_ne") (param $size i32) (result i32)
    (local $ne_off i32) (local $seg_tab i32) (local $seg_count i32)
    (local $shift i32) (local $i i32) (local $e i32)
    (local $file_pos i32) (local $len i32) (local $flags i32) (local $alloc i32)
    (local $base i32) (local $dst i32) (local $auto_data i32)

    (if (i32.ne (i32.load16_u (global.get $PE_STAGING)) (i32.const 0x5A4D))
      (then (return (i32.const -1))))
    (local.set $ne_off (i32.load (i32.add (global.get $PE_STAGING) (i32.const 0x3C))))
    (if (i32.ne (i32.load16_u (i32.add (global.get $PE_STAGING) (local.get $ne_off)))
                (i32.const 0x454E))
      (then (return (i32.const -2))))
    (local.set $ne_off (i32.add (global.get $PE_STAGING) (local.get $ne_off)))
    ;; Kept so a thunk can find the imported-name table again at dispatch time,
    ;; and the resource walk knows where the staged file ends.
    (global.set $win16_ne_off (local.get $ne_off))
    (global.set $win16_file_size (local.get $size))

    (local.set $seg_count (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x1C))))
    (if (i32.ge_u (i32.add (local.get $seg_count) (i32.const 2)) (global.get $WIN16_SEG_MAX))
      (then (return (i32.const -3))))
    (local.set $shift (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x32))))
    (if (i32.eqz (local.get $shift)) (then (local.set $shift (i32.const 9))))
    (local.set $seg_tab (i32.add (local.get $ne_off)
                          (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x22)))))

    ;; A 16-bit image has no base to relocate to, so guest linear addresses
    ;; start at zero and every segment lives in its own 64KB arena slot.
    (global.set $image_base (i32.const 0))
    (global.set $win16_thunk_count (i32.const 0))
    (call $zero_memory (global.get $WIN16_SEG_TABLE)
      (i32.mul (i32.add (global.get $WIN16_SEG_MAX) (i32.const 1)) (i32.const 16)))
    (call $zero_memory (global.get $WIN16_THUNK_TABLE)
      (i32.mul (global.get $WIN16_THUNK_MAX) (i32.const 4)))

    ;; Pass 1: place and copy every segment. Relocations come after, because a
    ;; fixup in segment 1 can name segment 3.
    (local.set $i (i32.const 0))
    (block $place_done (loop $place
      (br_if $place_done (i32.ge_u (local.get $i) (local.get $seg_count)))
      (local.set $e (i32.add (local.get $seg_tab) (i32.mul (local.get $i) (i32.const 8))))
      (local.set $file_pos (i32.shl (i32.load16_u (local.get $e)) (local.get $shift)))
      (local.set $len   (i32.load16_u (i32.add (local.get $e) (i32.const 2))))
      (local.set $flags (i32.load16_u (i32.add (local.get $e) (i32.const 4))))
      (local.set $alloc (i32.load16_u (i32.add (local.get $e) (i32.const 6))))
      ;; A zero length or allocation means the full 64KB, not an empty segment.
      (if (i32.and (i32.eqz (local.get $len)) (i32.ne (local.get $file_pos) (i32.const 0)))
        (then (local.set $len (i32.const 0x10000))))
      (if (i32.eqz (local.get $alloc)) (then (local.set $alloc (i32.const 0x10000))))
      (if (i32.lt_u (local.get $alloc) (local.get $len)) (then (local.set $alloc (local.get $len))))
      (local.set $base (i32.add (global.get $WIN16_ARENA)
                                (i32.mul (local.get $i) (i32.const 0x10000))))
      (call $win16_seg_set (i32.add (local.get $i) (i32.const 1))
        (local.get $base) (local.get $alloc) (local.get $flags) (i32.add (local.get $i) (i32.const 1)))
      (local.set $dst (call $g2w (local.get $base)))
      (call $zero_memory (local.get $dst) (i32.const 0x10000))
      (if (i32.and (i32.ne (local.get $file_pos) (i32.const 0))
                   (i32.le_u (i32.add (local.get $file_pos) (local.get $len)) (local.get $size)))
        (then
          (call $memcpy (local.get $dst)
            (i32.add (global.get $PE_STAGING) (local.get $file_pos))
            (local.get $len))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $place)))

    ;; The thunk segment sits one slot past the last real segment. Nothing is
    ;; ever executed from it: EIP landing inside is the signal to dispatch.
    (global.set $win16_thunk_index (i32.add (local.get $seg_count) (i32.const 1)))
    (global.set $WIN16_THUNK_SEL (call $win16_index_to_sel (global.get $win16_thunk_index)))
    (call $win16_seg_set (global.get $win16_thunk_index)
      (i32.add (global.get $WIN16_ARENA) (i32.mul (local.get $seg_count) (i32.const 0x10000)))
      (i32.const 0x10000) (i32.const 0) (i32.const 0))
    ;; Anything allocated from here on takes the slot after the thunks.
    (global.set $win16_next_seg (i32.add (global.get $win16_thunk_index) (i32.const 1)))
    (global.set $win16_psp_sel (i32.const 0))

    ;; Pass 2: relocations.
    (local.set $i (i32.const 0))
    (block $fix_done (loop $fix
      (br_if $fix_done (i32.ge_u (local.get $i) (local.get $seg_count)))
      (local.set $e (i32.add (local.get $seg_tab) (i32.mul (local.get $i) (i32.const 8))))
      (local.set $flags (i32.load16_u (i32.add (local.get $e) (i32.const 4))))
      (local.set $file_pos (i32.shl (i32.load16_u (local.get $e)) (local.get $shift)))
      (local.set $len (i32.load16_u (i32.add (local.get $e) (i32.const 2))))
      (if (i32.and (i32.eqz (local.get $len)) (i32.ne (local.get $file_pos) (i32.const 0)))
        (then (local.set $len (i32.const 0x10000))))
      ;; RELOCINFO is bit 8, so it must be reduced to 0/1 before being combined
      ;; with another predicate: 0x100 AND 1 is 0.
      (if (i32.and (i32.ne (i32.and (local.get $flags) (i32.const 0x0100)) (i32.const 0))
                   (i32.ne (local.get $file_pos) (i32.const 0)))
        (then
          (call $win16_apply_relocs
            (call $g2w (call $win16_seg_base (i32.add (local.get $i) (i32.const 1))))
            (local.get $len)
            (i32.add (i32.add (global.get $PE_STAGING) (local.get $file_pos)) (local.get $len))
            (local.get $ne_off))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fix)))

    ;; Auto-data segment: DS for the whole task, and where the local heap and
    ;; stack live. SS = DS is the small/medium model every one of these images
    ;; is built with.
    (local.set $auto_data (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x0E))))
    (global.set $win16_auto_data (local.get $auto_data))
    (global.set $win16_seg_count (local.get $seg_count))
    (global.set $win16_entry_cs
      (call $win16_index_to_sel (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x16)))))
    (global.set $win16_entry_ip (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x14))))
    (global.set $win16_stack_size (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x12))))
    (global.set $win16_heap_size (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x10))))
    (global.set $is_win16 (i32.const 1))

    (call $win16_start_task (local.get $ne_off))

    (i32.or (i32.shl (global.get $win16_entry_cs) (i32.const 16))
            (global.get $win16_entry_ip)))

  ;; ---- Resources ----
  ;;
  ;; An NE resource table is a flat list of types, each with a run of records
  ;; naming one resource. Nothing about it resembles the PE resource tree, so
  ;; none of the 32-bit resource walker applies.
  ;;
  ;;   u16 align shift           — offsets and lengths below are in these units
  ;;   TYPEINFO, repeating until a type id of 0:
  ;;     u16 type id             — bit 15 set means an integer id, else a name
  ;;     u16 count
  ;;     u32 reserved
  ;;     NAMEINFO x count, 12 bytes each:
  ;;       u16 offset  u16 length  u16 flags  u16 id  u16 handle  u16 usage
  ;;
  ;; Offsets are from the start of the file, not from the NE header. Returns a
  ;; linear address into the staged image, or 0, and leaves the byte length in
  ;; $win16_res_len.
  (func $win16_find_resource (export "win16_find_resource")
        (param $type_id i32) (param $res_id i32) (result i32)
    (local $p i32) (local $shift i32) (local $type i32) (local $count i32)
    (local $q i32) (local $i i32) (local $end i32)
    (global.set $win16_res_len (i32.const 0))
    (local.set $p (i32.load16_u (i32.add (global.get $win16_ne_off) (i32.const 0x24))))
    ;; A resource table offset of zero means the module has no resources at all.
    (if (i32.eqz (local.get $p)) (then (return (i32.const 0))))
    (local.set $p (i32.add (global.get $win16_ne_off) (local.get $p)))
    (local.set $shift (i32.load16_u (local.get $p)))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    ;; The table lives inside the staged file; refuse to walk past it rather
    ;; than read whatever follows as if it were another TYPEINFO.
    (local.set $end (i32.add (global.get $PE_STAGING) (global.get $win16_file_size)))

    (block $done (loop $types
      (br_if $done (i32.ge_u (i32.add (local.get $p) (i32.const 8)) (local.get $end)))
      (local.set $type (i32.load16_u (local.get $p)))
      (br_if $done (i32.eqz (local.get $type)))
      (local.set $count (i32.load16_u (i32.add (local.get $p) (i32.const 2))))
      (local.set $q (i32.add (local.get $p) (i32.const 8)))
      ;; Only integer type ids are matched. A named type is a custom resource
      ;; and nothing asks for one by number.
      (if (i32.eq (local.get $type) (i32.or (local.get $type_id) (i32.const 0x8000)))
        (then
          (local.set $i (i32.const 0))
          (block $scanned (loop $names
            (br_if $scanned (i32.ge_u (local.get $i) (local.get $count)))
            (if (i32.eq (i32.load16_u (i32.add (local.get $q) (i32.const 6)))
                        (i32.or (local.get $res_id) (i32.const 0x8000)))
              (then
                (global.set $win16_res_len
                  (i32.shl (i32.load16_u (i32.add (local.get $q) (i32.const 2))) (local.get $shift)))
                (return (i32.add (global.get $PE_STAGING)
                  (i32.shl (i32.load16_u (local.get $q)) (local.get $shift))))))
            (local.set $q (i32.add (local.get $q) (i32.const 12)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $names)))))
      (local.set $p (i32.add (i32.add (local.get $p) (i32.const 8))
                             (i32.mul (local.get $count) (i32.const 12))))
      (br $types)))
    (i32.const 0))

  ;; ---- Segment allocation ----
  ;;
  ;; Everything a running task creates that needs a selector — the PSP, and
  ;; later every GlobalAlloc block — takes the next free arena slot. One slot
  ;; is one selector and one 64KB span, which keeps the "every base is 64KB
  ;; aligned" invariant the whole 16-bit execution core rests on.
  (func $win16_alloc_segment (result i32)
    (local $index i32) (local $base i32)
    (local.set $index (global.get $win16_next_seg))
    (if (i32.ge_u (local.get $index) (global.get $WIN16_SEG_MAX))
      (then
        (call $host_log_i32 (i32.const 0xCA165E5A))  ;; selector arena exhausted
        (call $host_log_i32 (local.get $index))
        (unreachable)))
    (global.set $win16_next_seg (i32.add (local.get $index) (i32.const 1)))
    (local.set $base (i32.add (global.get $WIN16_ARENA)
                              (i32.mul (i32.sub (local.get $index) (i32.const 1)) (i32.const 0x10000))))
    (call $win16_seg_set (local.get $index) (local.get $base) (i32.const 0x10000)
      (i32.const 0) (i32.const 0))
    (call $zero_memory (call $g2w (local.get $base)) (i32.const 0x10000))
    (local.get $index))

  ;; ---- Task startup ----
  ;;
  ;; The auto-data segment is DGROUP: static data at the bottom, then the local
  ;; heap, then the stack growing down from the top. Only the static part is in
  ;; the file, so the segment has to be grown by the heap and stack sizes the
  ;; header asks for before SP can point above them.
  ;;
  ;; SS:SP in the header names the initial stack. An SP of zero means "the top
  ;; of the segment", which after the growth above is the whole DGROUP.
  (func $win16_start_task (param $ne_off i32)
    (local $ss_index i32) (local $sp i32) (local $ds_index i32) (local $limit i32)

    (local.set $ds_index (global.get $win16_auto_data))
    (local.set $ss_index (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x1A))))
    (local.set $sp       (i32.load16_u (i32.add (local.get $ne_off) (i32.const 0x18))))
    (if (i32.eqz (local.get $ss_index)) (then (local.set $ss_index (local.get $ds_index))))

    ;; Grow DGROUP for heap + stack. A 64KB segment is the ceiling; asking for
    ;; more than that is what the real loader clamps too.
    (if (local.get $ds_index)
      (then
        (local.set $limit (i32.add
          (i32.add (call $win16_seg_limit (local.get $ds_index)) (global.get $win16_heap_size))
          (global.get $win16_stack_size)))
        (if (i32.gt_u (local.get $limit) (i32.const 0x10000))
          (then (local.set $limit (i32.const 0x10000))))
        (i32.store offset=4
          (i32.add (global.get $WIN16_SEG_TABLE) (i32.mul (local.get $ds_index) (i32.const 16)))
          (local.get $limit))))

    (if (i32.eqz (local.get $sp))
      (then (local.set $sp (call $win16_seg_limit (local.get $ss_index)))))
    ;; SP addresses the last usable word, and the arena slot is exactly 64KB,
    ;; so a limit of 0x10000 has to come back inside it.
    (if (i32.gt_u (local.get $sp) (i32.const 0xFFFE)) (then (local.set $sp (i32.const 0xFFFE))))

    ;; $esp is a linear address; because every segment base is 64KB aligned its
    ;; low word stays SP for as long as the task runs.
    (global.set $esp (i32.add (call $win16_seg_base (local.get $ss_index)) (local.get $sp)))

    ;; ES starts equal to DS. Real Windows hands the task its PSP selector in
    ;; ES, which nothing here reads yet, and a DS-equal ES is the safer of the
    ;; two wrong answers: it addresses real memory.
    (call $win16_set_sreg (i32.const 3) (call $win16_index_to_sel (local.get $ds_index)))
    (call $win16_set_sreg (i32.const 0) (call $win16_index_to_sel (local.get $ds_index)))
    (call $win16_set_sreg (i32.const 2) (call $win16_index_to_sel (local.get $ss_index)))
    (call $win16_set_sreg (i32.const 1) (global.get $win16_entry_cs))

    (global.set $eip (i32.add (global.get $seg_base_cs) (global.get $win16_entry_ip)))
    ;; Win16 hands the entry point CX = heap size, DI = hInstance, SI = previous
    ;; hInstance (0 for the first copy), ES = PSP, DS = DGROUP. The startup code
    ;; in every one of these images reads DI to store its own instance handle.
    (global.set $eax (i32.const 0))
    (global.set $ecx (global.get $win16_heap_size))
    (global.set $edx (i32.const 0))
    (global.set $ebx (i32.const 0))
    (global.set $ebp (i32.const 0))
    (global.set $esi (i32.const 0))
    (global.set $edi (global.get $sreg_ds))
    (global.set $df (i32.const 0))
    (global.set $code16 (i32.const 1)))

  ;; ---- Inspection exports (used by test/test-ne-loader.js) ----
  (func (export "win16_seg_count") (result i32) (global.get $win16_seg_count))
  (func (export "win16_entry_cs") (result i32) (global.get $win16_entry_cs))
  (func (export "win16_entry_ip") (result i32) (global.get $win16_entry_ip))
  (func (export "win16_auto_data") (result i32) (global.get $win16_auto_data))
  (func (export "win16_thunk_count") (result i32) (global.get $win16_thunk_count))
  (func (export "win16_thunk_sel") (result i32) (global.get $WIN16_THUNK_SEL))
  (func (export "is_win16") (result i32) (global.get $is_win16))
