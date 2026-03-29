  ;; ============================================================
  ;; WSPRINTF IMPLEMENTATION
  ;; ============================================================
  ;; Write unsigned int as decimal to guest buf, return chars written
  (func $write_uint (param $dst i32) (param $val i32) (result i32)
    (local $buf i32) (local $len i32) (local $i i32) (local $tmp i32)
    ;; Use a temporary 12-byte area on heap
    (local.set $buf (call $heap_alloc (i32.const 12)))
    ;; Write digits in reverse
    (if (i32.eqz (local.get $val))
      (then (call $gs8 (local.get $dst) (i32.const 48)) (return (i32.const 1))))
    (local.set $tmp (local.get $val))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $tmp)))
      (call $gs8 (i32.add (local.get $buf) (local.get $len))
        (i32.add (i32.const 48) (i32.rem_u (local.get $tmp) (i32.const 10))))
      (local.set $tmp (i32.div_u (local.get $tmp) (i32.const 10)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $l)))
    ;; Reverse into dst
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $len)))
      (call $gs8 (i32.add (local.get $dst) (local.get $i))
        (call $gl8 (i32.add (local.get $buf) (i32.sub (i32.sub (local.get $len) (i32.const 1)) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (local.get $len))

  ;; Write signed int as decimal
  (func $write_int (param $dst i32) (param $val i32) (result i32)
    (local $off i32)
    (if (i32.lt_s (local.get $val) (i32.const 0))
      (then
        (call $gs8 (local.get $dst) (i32.const 45)) ;; '-'
        (local.set $off (i32.const 1))
        (return (i32.add (local.get $off)
          (call $write_uint (i32.add (local.get $dst) (i32.const 1))
            (i32.sub (i32.const 0) (local.get $val)))))))
    (call $write_uint (local.get $dst) (local.get $val)))

  ;; Write hex
  (func $write_hex (param $dst i32) (param $val i32) (param $upper i32) (result i32)
    (local $len i32) (local $i i32) (local $nibble i32) (local $started i32) (local $base i32)
    (local.set $base (select (i32.const 65) (i32.const 97) (local.get $upper))) ;; 'A' or 'a'
    (if (i32.eqz (local.get $val))
      (then (call $gs8 (local.get $dst) (i32.const 48)) (return (i32.const 1))))
    (local.set $i (i32.const 28))
    (block $d (loop $l
      (br_if $d (i32.lt_s (local.get $i) (i32.const 0)))
      (local.set $nibble (i32.and (i32.shr_u (local.get $val) (local.get $i)) (i32.const 0xF)))
      (if (i32.or (local.get $started) (i32.ne (local.get $nibble) (i32.const 0)))
        (then
          (local.set $started (i32.const 1))
          (if (i32.lt_u (local.get $nibble) (i32.const 10))
            (then (call $gs8 (i32.add (local.get $dst) (local.get $len)) (i32.add (i32.const 48) (local.get $nibble))))
            (else (call $gs8 (i32.add (local.get $dst) (local.get $len)) (i32.add (local.get $base) (i32.sub (local.get $nibble) (i32.const 10))))))
          (local.set $len (i32.add (local.get $len) (i32.const 1)))))
      (local.set $i (i32.sub (local.get $i) (i32.const 4)))
      (br $l)))
    (local.get $len))

  ;; wsprintfA: lpOut (guest), lpFmt (guest), arg_ptr (guest stack ptr to first vararg)
  ;; Returns number of chars written (not counting NUL)
  (func $wsprintf_impl (param $out i32) (param $fmt i32) (param $arg_ptr i32) (result i32)
    (local $fi i32) (local $oi i32) (local $ch i32) (local $arg i32)
    (local $sptr i32) (local $sch i32) (local $written i32)
    (block $done (loop $loop
      (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.ne (local.get $ch) (i32.const 37)) ;; not '%'
        (then
          (call $gs8 (i32.add (local.get $out) (local.get $oi)) (local.get $ch))
          (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
          (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
          (br $loop)))
      ;; Got '%'
      (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
      (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
      ;; Skip flags: '-', '+', '0', ' ', '#'
      (block $skip_flags (loop $fl
        (br_if $skip_flags (i32.and (i32.ne (local.get $ch) (i32.const 45))
          (i32.and (i32.ne (local.get $ch) (i32.const 43))
          (i32.and (i32.ne (local.get $ch) (i32.const 48))
          (i32.and (i32.ne (local.get $ch) (i32.const 32))
                   (i32.ne (local.get $ch) (i32.const 35)))))))
        (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
        (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
        (br $fl)))
      ;; Skip width digits
      (block $skip_w (loop $wl
        (br_if $skip_w (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
        (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
        (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
        (br $wl)))
      ;; Skip precision (.digits)
      (if (i32.eq (local.get $ch) (i32.const 46))
        (then
          (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
          (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
          (block $skip_p (loop $pl
            (br_if $skip_p (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
            (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
            (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
            (br $pl)))))
      ;; Skip length modifier: 'l', 'h'
      (if (i32.or (i32.eq (local.get $ch) (i32.const 108)) (i32.eq (local.get $ch) (i32.const 104)))
        (then
          (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
          (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))))
      ;; Now ch is the conversion character
      (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
      ;; '%'
      (if (i32.eq (local.get $ch) (i32.const 37))
        (then
          (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 37))
          (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
          (br $loop)))
      ;; Read next arg
      (local.set $arg (call $gl32 (local.get $arg_ptr)))
      (local.set $arg_ptr (i32.add (local.get $arg_ptr) (i32.const 4)))
      ;; 'd' or 'i': signed decimal
      (if (i32.or (i32.eq (local.get $ch) (i32.const 100)) (i32.eq (local.get $ch) (i32.const 105)))
        (then
          (local.set $written (call $write_int (i32.add (local.get $out) (local.get $oi)) (local.get $arg)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'u': unsigned decimal
      (if (i32.eq (local.get $ch) (i32.const 117))
        (then
          (local.set $written (call $write_uint (i32.add (local.get $out) (local.get $oi)) (local.get $arg)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'x': lowercase hex
      (if (i32.eq (local.get $ch) (i32.const 120))
        (then
          (local.set $written (call $write_hex (i32.add (local.get $out) (local.get $oi)) (local.get $arg) (i32.const 0)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'X': uppercase hex
      (if (i32.eq (local.get $ch) (i32.const 88))
        (then
          (local.set $written (call $write_hex (i32.add (local.get $out) (local.get $oi)) (local.get $arg) (i32.const 1)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'c': character
      (if (i32.eq (local.get $ch) (i32.const 99))
        (then
          (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.and (local.get $arg) (i32.const 0xFF)))
          (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
          (br $loop)))
      ;; 's': string
      (if (i32.eq (local.get $ch) (i32.const 115))
        (then
          (if (i32.eqz (local.get $arg))
            (then
              ;; NULL string → write "(null)"
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 40))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 110))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 117))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 108))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 108))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 41))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1))))
            (else
              (local.set $sptr (local.get $arg))
              (block $sd (loop $sl
                (local.set $sch (call $gl8 (local.get $sptr)))
                (br_if $sd (i32.eqz (local.get $sch)))
                (call $gs8 (i32.add (local.get $out) (local.get $oi)) (local.get $sch))
                (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
                (local.set $sptr (i32.add (local.get $sptr) (i32.const 1)))
                (br $sl)))))
          (br $loop)))
      ;; Unknown specifier: just skip
      (br $loop)))
    ;; NUL-terminate
    (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 0))
    (local.get $oi))

