  ;; ============================================================
  ;; WSPRINTF IMPLEMENTATION
  ;; ============================================================
  ;; One formatter, parameterized on $wide, the way $crt_itoa already is.
  ;; This file used to be the same ~220-line formatter twice — $write_uint /
  ;; $write_int / $write_hex / $apply_pad / $wsprintf_impl and a `_w` twin of
  ;; each, differing only in store width and stride — so every fix to a
  ;; conversion, a flag, or a padding rule had to be made in two places.
  ;;
  ;; Byte counts, not character counts, flow through the helpers: $written is
  ;; always bytes, and the wide path divides by two only where a *character*
  ;; count is what the caller means (field width, and wsprintfW's return value).
  ;;
  ;; The public entry points keep their names and signatures.

  ;; One character out / in, at the width in force.
  (func $fmt_put (param $dst i32) (param $wide i32) (param $ch i32)
    (if (local.get $wide)
      (then (call $gs16 (local.get $dst) (local.get $ch)))
      (else (call $gs8 (local.get $dst) (local.get $ch)))))

  (func $fmt_get (param $src i32) (param $wide i32) (result i32)
    (if (result i32) (local.get $wide)
      (then (call $gl16 (local.get $src)))
      (else (call $gl8 (local.get $src)))))

  (func $fmt_unit (param $wide i32) (result i32)
    (select (i32.const 2) (i32.const 1) (local.get $wide)))

  ;; Unsigned decimal at $dst. Returns BYTES written.
  (func $write_uint_x (param $dst i32) (param $val i32) (param $wide i32) (result i32)
    (local $buf i32) (local $len i32) (local $i i32) (local $tmp i32) (local $unit i32)
    (local.set $unit (call $fmt_unit (local.get $wide)))
    ;; A scratch area for the digits, which come out least-significant first.
    (local.set $buf (call $heap_alloc (i32.mul (i32.const 12) (local.get $unit))))
    (if (i32.eqz (local.get $val))
      (then
        (call $fmt_put (local.get $dst) (local.get $wide) (i32.const 48))
        (call $heap_free (local.get $buf))
        (return (local.get $unit))))
    (local.set $tmp (local.get $val))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $tmp)))
      (call $fmt_put
        (i32.add (local.get $buf) (i32.mul (local.get $len) (local.get $unit)))
        (local.get $wide)
        (i32.add (i32.const 48) (i32.rem_u (local.get $tmp) (i32.const 10))))
      (local.set $tmp (i32.div_u (local.get $tmp) (i32.const 10)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $l)))
    ;; Reverse into dst
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $len)))
      (call $fmt_put
        (i32.add (local.get $dst) (i32.mul (local.get $i) (local.get $unit)))
        (local.get $wide)
        (call $fmt_get
          (i32.add (local.get $buf)
            (i32.mul (i32.sub (i32.sub (local.get $len) (i32.const 1)) (local.get $i))
                     (local.get $unit)))
          (local.get $wide)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $heap_free (local.get $buf))
    (i32.mul (local.get $len) (local.get $unit)))

  ;; Signed decimal. Returns BYTES written.
  (func $write_int_x (param $dst i32) (param $val i32) (param $wide i32) (result i32)
    (local $unit i32) (local $written i32)
    (local.set $unit (call $fmt_unit (local.get $wide)))
    (if (result i32) (i32.lt_s (local.get $val) (i32.const 0))
      (then
        (call $fmt_put (local.get $dst) (local.get $wide) (i32.const 45)) ;; '-'
        (local.set $written (call $write_uint_x
          (i32.add (local.get $dst) (local.get $unit))
          (i32.sub (i32.const 0) (local.get $val)) (local.get $wide)))
        (i32.add (local.get $written) (local.get $unit)))
      (else (call $write_uint_x (local.get $dst) (local.get $val) (local.get $wide)))))

  ;; Hex, no leading zeros. Returns BYTES written.
  (func $write_hex_x (param $dst i32) (param $val i32) (param $upper i32) (param $wide i32) (result i32)
    (local $i i32) (local $nib i32) (local $started i32) (local $oi i32) (local $unit i32)
    (local.set $unit (call $fmt_unit (local.get $wide)))
    (if (i32.eqz (local.get $val))
      (then
        (call $fmt_put (local.get $dst) (local.get $wide) (i32.const 48))
        (return (local.get $unit))))
    (local.set $i (i32.const 28))
    (block $done (loop $loop
      (br_if $done (i32.lt_s (local.get $i) (i32.const 0)))
      (local.set $nib (i32.and (i32.shr_u (local.get $val) (local.get $i)) (i32.const 15)))
      (if (i32.or (local.get $started) (i32.ne (local.get $nib) (i32.const 0)))
        (then
          (local.set $started (i32.const 1))
          (call $fmt_put (i32.add (local.get $dst) (local.get $oi)) (local.get $wide)
            (if (result i32) (i32.lt_u (local.get $nib) (i32.const 10))
              (then (i32.add (i32.const 48) (local.get $nib)))
              (else (i32.add (select (i32.const 55) (i32.const 87) (local.get $upper)) (local.get $nib)))))
          (local.set $oi (i32.add (local.get $oi) (local.get $unit)))))
      (local.set $i (i32.sub (local.get $i) (i32.const 4)))
      (br $loop)))
    (local.get $oi))

  ;; Right-justify $written BYTES within $width CHARACTERS at $dst, padding the
  ;; front with $pad. Returns the final byte count. No-op if width <= chars.
  (func $apply_pad_x (param $dst i32) (param $written i32) (param $width i32)
        (param $pad i32) (param $wide i32) (result i32)
    (local $n i32) (local $i i32) (local $unit i32) (local $chars i32)
    (local.set $unit (call $fmt_unit (local.get $wide)))
    (local.set $chars (i32.div_u (local.get $written) (local.get $unit)))
    (if (i32.le_u (local.get $width) (local.get $chars))
      (then (return (local.get $written))))
    (local.set $n (i32.sub (local.get $width) (local.get $chars)))
    ;; Shift right by $n characters, from the end so overlap is safe.
    (local.set $i (local.get $chars))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (call $fmt_put
        (i32.add (local.get $dst) (i32.mul (i32.add (local.get $i) (local.get $n)) (local.get $unit)))
        (local.get $wide)
        (call $fmt_get (i32.add (local.get $dst) (i32.mul (local.get $i) (local.get $unit)))
          (local.get $wide)))
      (br $l)))
    ;; Fill the prefix.
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $n)))
      (call $fmt_put (i32.add (local.get $dst) (i32.mul (local.get $i) (local.get $unit)))
        (local.get $wide) (local.get $pad))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (i32.mul (local.get $width) (local.get $unit)))

  ;; wsprintf{A,W}: lpOut (guest), lpFmt (guest), arg_ptr (guest stack pointer to
  ;; the first vararg). Returns the character count written, excluding the NUL.
  (func $wsprintf_core (param $out i32) (param $fmt i32) (param $arg_ptr i32)
        (param $wide i32) (result i32)
    (local $fi i32) (local $oi i32) (local $ch i32) (local $arg i32)
    (local $sptr i32) (local $sch i32) (local $written i32)
    (local $pad_zero i32) (local $width i32) (local $length i32)
    (local $unit i32) (local $src_wide i32) (local $src_unit i32)
    (local.set $unit (call $fmt_unit (local.get $wide)))
    (block $done (loop $loop
      (local.set $ch (call $fmt_get (i32.add (local.get $fmt) (local.get $fi)) (local.get $wide)))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.ne (local.get $ch) (i32.const 37)) ;; not '%'
        (then
          (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (local.get $ch))
          (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
          (local.set $fi (i32.add (local.get $fi) (local.get $unit)))
          (br $loop)))
      ;; Got '%' — reset per-conversion state.
      (local.set $pad_zero (i32.const 0))
      (local.set $width (i32.const 0))
      (local.set $length (i32.const 0))
      (local.set $fi (i32.add (local.get $fi) (local.get $unit)))
      (local.set $ch (call $fmt_get (i32.add (local.get $fmt) (local.get $fi)) (local.get $wide)))
      ;; Flags: '-', '+', '0', ' ', '#'. Only '0' affects the output here.
      (block $skip_flags (loop $fl
        (br_if $skip_flags (i32.and (i32.ne (local.get $ch) (i32.const 45))
          (i32.and (i32.ne (local.get $ch) (i32.const 43))
          (i32.and (i32.ne (local.get $ch) (i32.const 48))
          (i32.and (i32.ne (local.get $ch) (i32.const 32))
                   (i32.ne (local.get $ch) (i32.const 35)))))))
        (if (i32.eq (local.get $ch) (i32.const 48))
          (then (local.set $pad_zero (i32.const 1))))
        (local.set $fi (i32.add (local.get $fi) (local.get $unit)))
        (local.set $ch (call $fmt_get (i32.add (local.get $fmt) (local.get $fi)) (local.get $wide)))
        (br $fl)))
      ;; Width digits.
      (block $skip_w (loop $wl
        (br_if $skip_w (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
        (local.set $width (i32.add (i32.mul (local.get $width) (i32.const 10))
                                   (i32.sub (local.get $ch) (i32.const 48))))
        (local.set $fi (i32.add (local.get $fi) (local.get $unit)))
        (local.set $ch (call $fmt_get (i32.add (local.get $fmt) (local.get $fi)) (local.get $wide)))
        (br $wl)))
      ;; Precision (.digits) is parsed and ignored.
      (if (i32.eq (local.get $ch) (i32.const 46))
        (then
          (local.set $fi (i32.add (local.get $fi) (local.get $unit)))
          (local.set $ch (call $fmt_get (i32.add (local.get $fmt) (local.get $fi)) (local.get $wide)))
          (block $skip_p (loop $pl
            (br_if $skip_p (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
            (local.set $fi (i32.add (local.get $fi) (local.get $unit)))
            (local.set $ch (call $fmt_get (i32.add (local.get $fmt) (local.get $fi)) (local.get $wide)))
            (br $pl)))))
      ;; Length modifier: Win32 wsprintf accepts h/l/w. It only changes anything
      ;; on the W side, where %hs names an ANSI source string (Media Player uses
      ;; %ws); the A side has always read 8-bit sources regardless.
      (if (i32.or (i32.eq (local.get $ch) (i32.const 108))
          (i32.or (i32.eq (local.get $ch) (i32.const 104)) (i32.eq (local.get $ch) (i32.const 119))))
        (then
          (local.set $length (local.get $ch))
          (local.set $fi (i32.add (local.get $fi) (local.get $unit)))
          (local.set $ch (call $fmt_get (i32.add (local.get $fmt) (local.get $fi)) (local.get $wide)))))
      ;; Conversion character.
      (local.set $fi (i32.add (local.get $fi) (local.get $unit)))
      ;; '%%'
      (if (i32.eq (local.get $ch) (i32.const 37))
        (then
          (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (i32.const 37))
          (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
          (br $loop)))
      ;; Read the next argument.
      (local.set $arg (call $gl32 (local.get $arg_ptr)))
      (local.set $arg_ptr (i32.add (local.get $arg_ptr) (i32.const 4)))
      ;; 'd' or 'i': signed decimal
      (if (i32.or (i32.eq (local.get $ch) (i32.const 100)) (i32.eq (local.get $ch) (i32.const 105)))
        (then
          (local.set $written (call $write_int_x (i32.add (local.get $out) (local.get $oi))
            (local.get $arg) (local.get $wide)))
          (local.set $oi (i32.add (local.get $oi)
            (call $apply_pad_x (i32.add (local.get $out) (local.get $oi)) (local.get $written) (local.get $width)
              (select (i32.const 48) (i32.const 32) (local.get $pad_zero)) (local.get $wide))))
          (br $loop)))
      ;; 'u': unsigned decimal
      (if (i32.eq (local.get $ch) (i32.const 117))
        (then
          (local.set $written (call $write_uint_x (i32.add (local.get $out) (local.get $oi))
            (local.get $arg) (local.get $wide)))
          (local.set $oi (i32.add (local.get $oi)
            (call $apply_pad_x (i32.add (local.get $out) (local.get $oi)) (local.get $written) (local.get $width)
              (select (i32.const 48) (i32.const 32) (local.get $pad_zero)) (local.get $wide))))
          (br $loop)))
      ;; 'x' / 'X': hex
      (if (i32.or (i32.eq (local.get $ch) (i32.const 120)) (i32.eq (local.get $ch) (i32.const 88)))
        (then
          (local.set $written (call $write_hex_x (i32.add (local.get $out) (local.get $oi))
            (local.get $arg) (i32.eq (local.get $ch) (i32.const 88)) (local.get $wide)))
          (local.set $oi (i32.add (local.get $oi)
            (call $apply_pad_x (i32.add (local.get $out) (local.get $oi)) (local.get $written) (local.get $width)
              (select (i32.const 48) (i32.const 32) (local.get $pad_zero)) (local.get $wide))))
          (br $loop)))
      ;; 'c': character
      (if (i32.eq (local.get $ch) (i32.const 99))
        (then
          (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide)
            (i32.and (local.get $arg)
              (select (i32.const 0xFFFF) (i32.const 0xFF) (local.get $wide))))
          (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
          (br $loop)))
      ;; 's': string. On the W side %hs reads an ANSI source; the A side always
      ;; reads bytes.
      (if (i32.eq (local.get $ch) (i32.const 115))
        (then
          (if (i32.eqz (local.get $arg))
            (then
              ;; NULL string -> "(null)"
              (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (i32.const 40))
              (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
              (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (i32.const 110))
              (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
              (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (i32.const 117))
              (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
              (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (i32.const 108))
              (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
              (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (i32.const 108))
              (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
              (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (i32.const 41))
              (local.set $oi (i32.add (local.get $oi) (local.get $unit))))
            (else
              (local.set $src_wide
                (i32.and (local.get $wide)
                         (i32.ne (local.get $length) (i32.const 104)))) ;; 'h'
              (local.set $src_unit (call $fmt_unit (local.get $src_wide)))
              (local.set $sptr (local.get $arg))
              (block $sd (loop $sl
                (local.set $sch (call $fmt_get (local.get $sptr) (local.get $src_wide)))
                (br_if $sd (i32.eqz (local.get $sch)))
                (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (local.get $sch))
                (local.set $oi (i32.add (local.get $oi) (local.get $unit)))
                (local.set $sptr (i32.add (local.get $sptr) (local.get $src_unit)))
                (br $sl)))))
          (br $loop)))
      ;; Unknown specifier: skip it.
      (br $loop)))
    (call $fmt_put (i32.add (local.get $out) (local.get $oi)) (local.get $wide) (i32.const 0))
    (i32.div_u (local.get $oi) (local.get $unit)))

  ;; ---- Public entry points (names and signatures unchanged) ----

  (func $write_uint (param $dst i32) (param $val i32) (result i32)
    (call $write_uint_x (local.get $dst) (local.get $val) (i32.const 0)))
  (func $write_int (param $dst i32) (param $val i32) (result i32)
    (call $write_int_x (local.get $dst) (local.get $val) (i32.const 0)))
  (func $write_hex (param $dst i32) (param $val i32) (param $upper i32) (result i32)
    (call $write_hex_x (local.get $dst) (local.get $val) (local.get $upper) (i32.const 0)))
  (func $apply_pad (param $dst i32) (param $written i32) (param $width i32) (param $pad i32) (result i32)
    (call $apply_pad_x (local.get $dst) (local.get $written) (local.get $width)
      (local.get $pad) (i32.const 0)))
  (func $wsprintf_impl (param $out i32) (param $fmt i32) (param $arg_ptr i32) (result i32)
    (call $wsprintf_core (local.get $out) (local.get $fmt) (local.get $arg_ptr) (i32.const 0)))

  (func $write_uint_w (param $dst i32) (param $val i32) (result i32)
    (call $write_uint_x (local.get $dst) (local.get $val) (i32.const 1)))
  (func $write_int_w (param $dst i32) (param $val i32) (result i32)
    (call $write_int_x (local.get $dst) (local.get $val) (i32.const 1)))
  (func $write_hex_w (param $dst i32) (param $val i32) (param $upper i32) (result i32)
    (call $write_hex_x (local.get $dst) (local.get $val) (local.get $upper) (i32.const 1)))
  (func $apply_pad_w (param $dst i32) (param $written i32) (param $width i32) (param $pad i32) (result i32)
    (call $apply_pad_x (local.get $dst) (local.get $written) (local.get $width)
      (local.get $pad) (i32.const 1)))
  (func $wsprintf_impl_w (param $out i32) (param $fmt i32) (param $arg_ptr i32) (result i32)
    (call $wsprintf_core (local.get $out) (local.get $fmt) (local.get $arg_ptr) (i32.const 1)))
