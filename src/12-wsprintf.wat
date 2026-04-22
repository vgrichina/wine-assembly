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
    (call $heap_free (local.get $buf))
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

  ;; Right-justify $written bytes within $width at $dst, pad-front with $pad.
  ;; Returns the padded width (i.e. final byte count). No-op if width<=written.
  (func $apply_pad (param $dst i32) (param $written i32) (param $width i32) (param $pad i32) (result i32)
    (local $n i32) (local $i i32)
    (if (i32.le_u (local.get $width) (local.get $written))
      (then (return (local.get $written))))
    (local.set $n (i32.sub (local.get $width) (local.get $written)))
    ;; Shift bytes right by $n: copy from end to start
    (local.set $i (local.get $written))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (call $gs8 (i32.add (local.get $dst) (i32.add (local.get $i) (local.get $n)))
        (call $gl8 (i32.add (local.get $dst) (local.get $i))))
      (br $l)))
    ;; Fill prefix with $pad
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $n)))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (local.get $pad))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (local.get $width))

  ;; wsprintfA: lpOut (guest), lpFmt (guest), arg_ptr (guest stack ptr to first vararg)
  ;; Returns number of chars written (not counting NUL)
  (func $wsprintf_impl (param $out i32) (param $fmt i32) (param $arg_ptr i32) (result i32)
    (local $fi i32) (local $oi i32) (local $ch i32) (local $arg i32)
    (local $sptr i32) (local $sch i32) (local $written i32)
    (local $pad_zero i32) (local $width i32)
    (block $done (loop $loop
      (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.ne (local.get $ch) (i32.const 37)) ;; not '%'
        (then
          (call $gs8 (i32.add (local.get $out) (local.get $oi)) (local.get $ch))
          (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
          (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
          (br $loop)))
      ;; Got '%' — reset per-conversion state
      (local.set $pad_zero (i32.const 0))
      (local.set $width (i32.const 0))
      (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
      (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
      ;; Parse flags: '-', '+', '0', ' ', '#'  (only '0' affects output here)
      (block $skip_flags (loop $fl
        (br_if $skip_flags (i32.and (i32.ne (local.get $ch) (i32.const 45))
          (i32.and (i32.ne (local.get $ch) (i32.const 43))
          (i32.and (i32.ne (local.get $ch) (i32.const 48))
          (i32.and (i32.ne (local.get $ch) (i32.const 32))
                   (i32.ne (local.get $ch) (i32.const 35)))))))
        (if (i32.eq (local.get $ch) (i32.const 48))
          (then (local.set $pad_zero (i32.const 1))))
        (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
        (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
        (br $fl)))
      ;; Parse width digits
      (block $skip_w (loop $wl
        (br_if $skip_w (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
        (local.set $width (i32.add (i32.mul (local.get $width) (i32.const 10))
                                   (i32.sub (local.get $ch) (i32.const 48))))
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
          (local.set $oi (i32.add (local.get $oi)
            (call $apply_pad (i32.add (local.get $out) (local.get $oi)) (local.get $written) (local.get $width)
              (select (i32.const 48) (i32.const 32) (local.get $pad_zero)))))
          (br $loop)))
      ;; 'u': unsigned decimal
      (if (i32.eq (local.get $ch) (i32.const 117))
        (then
          (local.set $written (call $write_uint (i32.add (local.get $out) (local.get $oi)) (local.get $arg)))
          (local.set $oi (i32.add (local.get $oi)
            (call $apply_pad (i32.add (local.get $out) (local.get $oi)) (local.get $written) (local.get $width)
              (select (i32.const 48) (i32.const 32) (local.get $pad_zero)))))
          (br $loop)))
      ;; 'x': lowercase hex
      (if (i32.eq (local.get $ch) (i32.const 120))
        (then
          (local.set $written (call $write_hex (i32.add (local.get $out) (local.get $oi)) (local.get $arg) (i32.const 0)))
          (local.set $oi (i32.add (local.get $oi)
            (call $apply_pad (i32.add (local.get $out) (local.get $oi)) (local.get $written) (local.get $width)
              (select (i32.const 48) (i32.const 32) (local.get $pad_zero)))))
          (br $loop)))
      ;; 'X': uppercase hex
      (if (i32.eq (local.get $ch) (i32.const 88))
        (then
          (local.set $written (call $write_hex (i32.add (local.get $out) (local.get $oi)) (local.get $arg) (i32.const 1)))
          (local.set $oi (i32.add (local.get $oi)
            (call $apply_pad (i32.add (local.get $out) (local.get $oi)) (local.get $written) (local.get $width)
              (select (i32.const 48) (i32.const 32) (local.get $pad_zero)))))
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

  ;; Write unsigned int as decimal to guest buf (wide), return BYTES written
  (func $write_uint_w (param $dst i32) (param $val i32) (result i32)
    (local $buf i32) (local $len i32) (local $i i32) (local $tmp i32)
    (local.set $buf (call $heap_alloc (i32.const 24)))
    (if (i32.eqz (local.get $val))
      (then (call $gs16 (local.get $dst) (i32.const 48)) (return (i32.const 2))))
    (local.set $tmp (local.get $val))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $tmp)))
      (call $gs16 (i32.add (local.get $buf) (i32.mul (local.get $len) (i32.const 2)))
        (i32.add (i32.const 48) (i32.rem_u (local.get $tmp) (i32.const 10))))
      (local.set $tmp (i32.div_u (local.get $tmp) (i32.const 10)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $l)))
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $len)))
      (call $gs16 (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 2)))
        (call $gl16 (i32.add (local.get $buf) (i32.mul (i32.sub (i32.sub (local.get $len) (i32.const 1)) (local.get $i)) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $heap_free (local.get $buf))
    (i32.mul (local.get $len) (i32.const 2)))

  (func $write_int_w (param $dst i32) (param $val i32) (result i32)
    (local $written i32)
    (if (result i32) (i32.lt_s (local.get $val) (i32.const 0))
      (then
        (call $gs16 (local.get $dst) (i32.const 45))
        (local.set $written (call $write_uint_w (i32.add (local.get $dst) (i32.const 2))
          (i32.sub (i32.const 0) (local.get $val))))
        (i32.add (local.get $written) (i32.const 2)))
      (else (call $write_uint_w (local.get $dst) (local.get $val)))))

  (func $write_hex_w (param $dst i32) (param $val i32) (param $upper i32) (result i32)
    (local $i i32) (local $nib i32) (local $started i32) (local $oi i32)
    (if (i32.eqz (local.get $val))
      (then (call $gs16 (local.get $dst) (i32.const 48)) (return (i32.const 2))))
    (local.set $i (i32.const 28))
    (block $done (loop $loop
      (br_if $done (i32.lt_s (local.get $i) (i32.const 0)))
      (local.set $nib (i32.and (i32.shr_u (local.get $val) (local.get $i)) (i32.const 15)))
      (if (i32.or (local.get $started) (i32.ne (local.get $nib) (i32.const 0)))
        (then
          (local.set $started (i32.const 1))
          (call $gs16 (i32.add (local.get $dst) (local.get $oi))
            (if (result i32) (i32.lt_u (local.get $nib) (i32.const 10))
              (then (i32.add (i32.const 48) (local.get $nib)))
              (else (i32.add (select (i32.const 55) (i32.const 87) (local.get $upper)) (local.get $nib)))))
          (local.set $oi (i32.add (local.get $oi) (i32.const 2)))))
      (local.set $i (i32.sub (local.get $i) (i32.const 4)))
      (br $loop)))
    (local.get $oi))

  ;; Wide sprintf: reads UTF-16 format, writes UTF-16 output
  ;; $oi tracks byte offset (not char offset)
  (func $wsprintf_impl_w (param $out i32) (param $fmt i32) (param $arg_ptr i32) (result i32)
    (local $fi i32) (local $oi i32) (local $ch i32) (local $arg i32)
    (local $sptr i32) (local $sch i32) (local $written i32)
    (block $done (loop $loop
      (local.set $ch (call $gl16 (i32.add (local.get $fmt) (local.get $fi))))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.ne (local.get $ch) (i32.const 37)) ;; not '%'
        (then
          (call $gs16 (i32.add (local.get $out) (local.get $oi)) (local.get $ch))
          (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
          (local.set $fi (i32.add (local.get $fi) (i32.const 2)))
          (br $loop)))
      ;; Got '%'
      (local.set $fi (i32.add (local.get $fi) (i32.const 2)))
      (local.set $ch (call $gl16 (i32.add (local.get $fmt) (local.get $fi))))
      ;; Skip flags
      (block $skip_flags (loop $fl
        (br_if $skip_flags (i32.and (i32.ne (local.get $ch) (i32.const 45))
          (i32.and (i32.ne (local.get $ch) (i32.const 43))
          (i32.and (i32.ne (local.get $ch) (i32.const 48))
          (i32.and (i32.ne (local.get $ch) (i32.const 32))
                   (i32.ne (local.get $ch) (i32.const 35)))))))
        (local.set $fi (i32.add (local.get $fi) (i32.const 2)))
        (local.set $ch (call $gl16 (i32.add (local.get $fmt) (local.get $fi))))
        (br $fl)))
      ;; Skip width digits
      (block $skip_w (loop $wl
        (br_if $skip_w (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
        (local.set $fi (i32.add (local.get $fi) (i32.const 2)))
        (local.set $ch (call $gl16 (i32.add (local.get $fmt) (local.get $fi))))
        (br $wl)))
      ;; Skip precision
      (if (i32.eq (local.get $ch) (i32.const 46))
        (then
          (local.set $fi (i32.add (local.get $fi) (i32.const 2)))
          (local.set $ch (call $gl16 (i32.add (local.get $fmt) (local.get $fi))))
          (block $skip_p (loop $pl
            (br_if $skip_p (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
            (local.set $fi (i32.add (local.get $fi) (i32.const 2)))
            (local.set $ch (call $gl16 (i32.add (local.get $fmt) (local.get $fi))))
            (br $pl)))))
      ;; Skip length modifier: 'l', 'h'
      (if (i32.or (i32.eq (local.get $ch) (i32.const 108)) (i32.eq (local.get $ch) (i32.const 104)))
        (then
          (local.set $fi (i32.add (local.get $fi) (i32.const 2)))
          (local.set $ch (call $gl16 (i32.add (local.get $fmt) (local.get $fi))))))
      ;; Conversion character
      (local.set $fi (i32.add (local.get $fi) (i32.const 2)))
      ;; '%%'
      (if (i32.eq (local.get $ch) (i32.const 37))
        (then
          (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.const 37))
          (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
          (br $loop)))
      ;; Read next arg
      (local.set $arg (call $gl32 (local.get $arg_ptr)))
      (local.set $arg_ptr (i32.add (local.get $arg_ptr) (i32.const 4)))
      ;; 'd'/'i': signed decimal
      (if (i32.or (i32.eq (local.get $ch) (i32.const 100)) (i32.eq (local.get $ch) (i32.const 105)))
        (then
          (local.set $written (call $write_int_w (i32.add (local.get $out) (local.get $oi)) (local.get $arg)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'u': unsigned decimal
      (if (i32.eq (local.get $ch) (i32.const 117))
        (then
          (local.set $written (call $write_uint_w (i32.add (local.get $out) (local.get $oi)) (local.get $arg)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'x': lowercase hex
      (if (i32.eq (local.get $ch) (i32.const 120))
        (then
          (local.set $written (call $write_hex_w (i32.add (local.get $out) (local.get $oi)) (local.get $arg) (i32.const 0)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'X': uppercase hex
      (if (i32.eq (local.get $ch) (i32.const 88))
        (then
          (local.set $written (call $write_hex_w (i32.add (local.get $out) (local.get $oi)) (local.get $arg) (i32.const 1)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'c': character
      (if (i32.eq (local.get $ch) (i32.const 99))
        (then
          (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.and (local.get $arg) (i32.const 0xFFFF)))
          (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
          (br $loop)))
      ;; 's': wide string
      (if (i32.eq (local.get $ch) (i32.const 115))
        (then
          (if (i32.eqz (local.get $arg))
            (then
              ;; NULL → "(null)" as wide
              (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.const 40))
              (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
              (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.const 110))
              (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
              (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.const 117))
              (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
              (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.const 108))
              (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
              (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.const 108))
              (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
              (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.const 41))
              (local.set $oi (i32.add (local.get $oi) (i32.const 2))))
            (else
              (local.set $sptr (local.get $arg))
              (block $sd (loop $sl
                (local.set $sch (call $gl16 (local.get $sptr)))
                (br_if $sd (i32.eqz (local.get $sch)))
                (call $gs16 (i32.add (local.get $out) (local.get $oi)) (local.get $sch))
                (local.set $oi (i32.add (local.get $oi) (i32.const 2)))
                (local.set $sptr (i32.add (local.get $sptr) (i32.const 2)))
                (br $sl)))))
          (br $loop)))
      ;; Unknown: skip
      (br $loop)))
    ;; NUL-terminate (wide)
    (call $gs16 (i32.add (local.get $out) (local.get $oi)) (i32.const 0))
    ;; Return char count (not byte count)
    (i32.div_u (local.get $oi) (i32.const 2)))

