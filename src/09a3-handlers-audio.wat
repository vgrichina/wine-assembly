  ;; ============================================================
  ;; AUDIO/WAVE API HANDLERS
  ;; ============================================================

  ;; acmMetrics(hao, uMetric, pMetric) reports Audio Compression Manager
  ;; inventory and sizing information.  The emulator exposes one built-in
  ;; PCM converter and no installable codecs or filters.  In particular,
  ;; ACM_METRIC_MAX_SIZE_FORMAT (50) must include the cbSize word: callers use
  ;; this result to allocate a WAVEFORMATEX before enumerating formats.
  (func $acm_metrics (param $hao i32) (param $metric i32) (param $out i32) (result i32)
    (local $value i32)
    (if (i32.eqz (local.get $out))
      (then (return (i32.const 11))))                       ;; MMSYSERR_INVALPARAM
    (if (i32.eq (local.get $metric) (i32.const 50))
      (then (call $gs32 (local.get $out) (i32.const 18))    ;; sizeof WAVEFORMATEX
            (return (i32.const 0))))
    (if (i32.eq (local.get $metric) (i32.const 51))
      (then (call $gs32 (local.get $out) (i32.const 0))     ;; no ACM filters
            (return (i32.const 0))))
    (if (i32.or
          (i32.eq (local.get $metric) (i32.const 1))        ;; COUNT_DRIVERS
          (i32.eq (local.get $metric) (i32.const 20)))      ;; COUNT_LOCAL_DRIVERS
      (then (call $gs32 (local.get $out) (i32.const 1))
            (return (i32.const 0))))
    (if (i32.or
          (i32.eq (local.get $metric) (i32.const 3))        ;; COUNT_CONVERTERS
          (i32.eq (local.get $metric) (i32.const 22)))      ;; COUNT_LOCAL_CONVERTERS
      (then (call $gs32 (local.get $out) (i32.const 1))
            (return (i32.const 0))))
    (if (i32.or
          (i32.le_u (local.get $metric) (i32.const 6))
          (i32.or
            (i32.and (i32.ge_u (local.get $metric) (i32.const 20))
                     (i32.le_u (local.get $metric) (i32.const 25)))
            (i32.and (i32.ge_u (local.get $metric) (i32.const 30))
                     (i32.le_u (local.get $metric) (i32.const 34)))))
      (then (call $gs32 (local.get $out) (i32.const 0))
            (return (i32.const 0))))
    (i32.const 10))                                         ;; MMSYSERR_INVALFLAG

  (func $handle_acmMetrics (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $acm_metrics
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) ;; 3 args stdcall
  )

  ;; acmFormatTagDetailsA(had, paftd, fdwDetails) — describe one format tag.
  ;;
  ;; ACMFORMATTAGDETAILS is 24 bytes of fields then a 48-byte name:
  ;;   +0  cbStruct   +4  dwFormatTagIndex   +8  dwFormatTag
  ;;   +12 cbFormatSize   +16 fdwSupport   +20 cStandardFormats
  ;;   +24 szFormatTag[48]
  ;;
  ;; The low nibble of fdwDetails selects what identifies the tag: INDEX(0)
  ;; means dwFormatTagIndex, FORMATTAG(1) means dwFormatTag. This emulator
  ;; converts nothing, so there is exactly one tag to describe -- PCM -- and
  ;; anything else is ACMERR_NOTPOSSIBLE, which is the same answer a machine
  ;; with no codecs installed gives. cbFormatSize 16 is sizeof(WAVEFORMATEX)
  ;; without the cbSize word, which is what PCM uses.
  ;;
  ;; Sound Recorder asks this to name the format in its About box, and used to
  ;; crash there.
  ;; The A and W entry points differ only in whether the name at the end of the
  ;; struct is written as ASCII or as UTF-16, so both call this. XP's Sound
  ;; Recorder is the W caller; Win98's is the A caller.
  (func $acm_format_tag_details (param $paftd i32) (param $fdw i32) (param $wide i32) (result i32)
    (local $wa i32) (local $query i32)
    (if (i32.eqz (local.get $paftd))
      (then (return (i32.const 0x00000057))))     ;; MMSYSERR_INVALPARAM
    (local.set $wa (call $g2w (local.get $paftd)))
    (local.set $query (i32.and (local.get $fdw) (i32.const 0x0000000F)))
    ;; INDEX asks for the n-th tag and PCM is the only one; FORMATTAG asks for
    ;; a named tag and PCM (1) is the only one we have.
    (if (i32.eqz
          (i32.or
            (i32.and (i32.eqz (local.get $query))
                     (i32.eqz (i32.load offset=4 (local.get $wa))))
            (i32.and (i32.eq (local.get $query) (i32.const 1))
                     (i32.eq (i32.load offset=8 (local.get $wa)) (i32.const 1)))))
      (then (return (i32.const 512))))            ;; ACMERR_NOTPOSSIBLE
    ;; Keep the caller's cbStruct — it declares the size it allocated. The
    ;; name field is 48 chars, so a wide one runs to +24+96.
    (call $zero_memory (i32.add (local.get $wa) (i32.const 4))
      (select (i32.const 116) (i32.const 68) (local.get $wide)))
    (i32.store offset=8  (local.get $wa) (i32.const 1))    ;; WAVE_FORMAT_PCM
    (i32.store offset=12 (local.get $wa) (i32.const 16))   ;; PCM WAVEFORMATEX
    (i32.store offset=16 (local.get $wa) (i32.const 0x04)) ;; SUPPORTF_CONVERTER
    ;; 4 sample rates x 8/16 bit x mono/stereo, the set waveOutGetDevCaps
    ;; below reports as supported.
    (i32.store offset=20 (local.get $wa) (i32.const 16))
    (i32.store offset=24 (local.get $wa) (i32.const 0x004D4350))  ;; "PCM\0"
    (if (local.get $wide)
      (then (call $acm_widen_in_place
              (i32.add (local.get $paftd) (i32.const 24)) (i32.const 3))))
    (i32.const 0))                                 ;; MMSYSERR_NOERROR

  (func $handle_acmFormatTagDetailsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $acm_format_tag_details
      (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args stdcall
  )

  (func $handle_acmFormatTagDetailsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $acm_format_tag_details
      (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; The standard PCM formats this emulator offers, in the order ACM
  ;; enumerates them: sample rate slowest first, then 8 before 16 bit, then
  ;; mono before stereo. 4 x 2 x 2 = the 16 that acmFormatTagDetailsA reports
  ;; as cStandardFormats, and the same set waveOutGetDevCaps advertises.
  (func $acm_pcm_rate (param $index i32) (result i32)
    (local $slot i32)
    (local.set $slot (i32.shr_u (local.get $index) (i32.const 2)))
    (if (i32.eqz (local.get $slot)) (then (return (i32.const 8000))))
    (if (i32.eq (local.get $slot) (i32.const 1)) (then (return (i32.const 11025))))
    (if (i32.eq (local.get $slot) (i32.const 2)) (then (return (i32.const 22050))))
    (i32.const 44100))
  (func $acm_pcm_bits (param $index i32) (result i32)
    (select (i32.const 16) (i32.const 8)
      (i32.and (i32.shr_u (local.get $index) (i32.const 1)) (i32.const 1))))
  (func $acm_pcm_channels (param $index i32) (result i32)
    (i32.add (i32.and (local.get $index) (i32.const 1)) (i32.const 1)))

  ;; "22.050 kHz, 16 Bit, Stereo" — how Windows names a PCM format in Sound
  ;; Recorder's format list. The rate is written as kHz with three decimals,
  ;; which for these rates is the sample rate with a dot after the thousands.
  ;; $dst is a GUEST address: this writes through $gs8/$gs32 because
  ;; $write_uint does, and mixing the two address spaces in one buffer reads a
  ;; WASM offset as a guest one and lands outside memory entirely.
  (func $acm_pcm_format_name (param $dst i32) (param $index i32) (result i32)
    (local $p i32) (local $rate i32)
    (local.set $p (local.get $dst))
    (local.set $rate (call $acm_pcm_rate (local.get $index)))
    (local.set $p (i32.add (local.get $p)
      (call $write_uint (local.get $p) (i32.div_u (local.get $rate) (i32.const 1000)))))
    (call $gs8 (local.get $p) (i32.const 0x2E))                  ;; '.'
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    ;; three digits, zero padded — 8000 is ".000", 11025 is ".025"
    (call $gs8 (local.get $p)
      (i32.add (i32.const 0x30)
        (i32.rem_u (i32.div_u (local.get $rate) (i32.const 100)) (i32.const 10))))
    (call $gs8 (i32.add (local.get $p) (i32.const 1))
      (i32.add (i32.const 0x30)
        (i32.rem_u (i32.div_u (local.get $rate) (i32.const 10)) (i32.const 10))))
    (call $gs8 (i32.add (local.get $p) (i32.const 2))
      (i32.add (i32.const 0x30) (i32.rem_u (local.get $rate) (i32.const 10))))
    (local.set $p (i32.add (local.get $p) (i32.const 3)))
    ;; " kHz, " and " Bit, " written as their bytes rather than as data
    ;; segments: the ordinal-import tables address 01-header's segment by
    ;; absolute offset, so adding a string there shifts every later entry.
    (call $gs32 (local.get $p) (i32.const 0x7A486B20))                     ;; " kHz"
    (call $gs16 (i32.add (local.get $p) (i32.const 4)) (i32.const 0x202C)) ;; ", "
    (local.set $p (i32.add (local.get $p) (i32.const 6)))
    (local.set $p (i32.add (local.get $p)
      (call $write_uint (local.get $p) (call $acm_pcm_bits (local.get $index)))))
    (call $gs32 (local.get $p) (i32.const 0x74694220))                     ;; " Bit"
    (call $gs16 (i32.add (local.get $p) (i32.const 4)) (i32.const 0x202C)) ;; ", "
    (local.set $p (i32.add (local.get $p) (i32.const 6)))
    (if (i32.eq (call $acm_pcm_channels (local.get $index)) (i32.const 2))
      (then
        (call $gs32 (local.get $p) (i32.const 0x72657453))                     ;; "Ster"
        (call $gs16 (i32.add (local.get $p) (i32.const 4)) (i32.const 0x6F65)) ;; "eo"
        (local.set $p (i32.add (local.get $p) (i32.const 6))))
      (else
        (call $gs32 (local.get $p) (i32.const 0x6F6E6F4D))                     ;; "Mono"
        (local.set $p (i32.add (local.get $p) (i32.const 4)))))
    (call $gs8 (local.get $p) (i32.const 0))
    (i32.sub (local.get $p) (local.get $dst)))

  ;; Expand an ASCII string already written at $dst into UTF-16 in place.
  ;; Walking backwards means each character is read before the wide character
  ;; that will sit on top of it is written, so no copy buffer is needed -- and
  ;; the wide field these land in is always at least twice the ASCII length.
  (func $acm_widen_in_place (param $dst i32) (param $len i32)
    (local $i i32)
    (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $len) (i32.const 1)))
      (i32.const 0))
    (local.set $i (local.get $len))
    (block $done (loop $back
      (br_if $done (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1)))
        (call $gl8 (i32.add (local.get $dst) (local.get $i))))
      (br $back))))

  ;; acmFormatDetailsA(had, pafd, fdwDetails) — describe one format.
  ;;
  ;; ACMFORMATDETAILS is 24 bytes then a 128-byte name:
  ;;   +0  cbStruct   +4  dwFormatIndex   +8  dwFormatTag   +12 fdwSupport
  ;;   +16 pwfx (caller's WAVEFORMATEX buffer)   +20 cbwfx   +24 szFormat[128]
  ;;
  ;; INDEX(0) means "fill in the n-th format of dwFormatTag"; FORMAT(1) means
  ;; the caller already put a WAVEFORMATEX in pwfx and wants it named. Both
  ;; write szFormat, which is the part an app puts in front of a user.
  (func $acm_format_details (param $pafd i32) (param $fdw i32) (param $wide i32) (result i32)
    (local $wa i32) (local $query i32) (local $index i32)
    (local $pwfx i32) (local $cbwfx i32) (local $rate i32) (local $bits i32) (local $ch i32)
    (if (i32.eqz (local.get $pafd))
      (then (return (i32.const 0x00000057))))     ;; MMSYSERR_INVALPARAM
    (local.set $wa (call $g2w (local.get $pafd)))
    (local.set $query (i32.and (local.get $fdw) (i32.const 0x0000000F)))
    (local.set $index (i32.load offset=4 (local.get $wa)))
    (local.set $pwfx (i32.load offset=16 (local.get $wa)))
    (local.set $cbwfx (i32.load offset=20 (local.get $wa)))
    ;; PCM is the only tag; tag 0 (WAVE_FORMAT_UNKNOWN) means "any".
    (if (i32.and
          (i32.ne (i32.load offset=8 (local.get $wa)) (i32.const 1))
          (i32.ne (i32.load offset=8 (local.get $wa)) (i32.const 0)))
      (then (return (i32.const 512))))            ;; ACMERR_NOTPOSSIBLE
    (if (i32.eqz (local.get $query))
      (then
        (if (i32.ge_u (local.get $index) (i32.const 16))
          (then (return (i32.const 512))))        ;; past the last format
        (local.set $rate (call $acm_pcm_rate (local.get $index)))
        (local.set $bits (call $acm_pcm_bits (local.get $index)))
        (local.set $ch   (call $acm_pcm_channels (local.get $index)))
        (if (i32.and (i32.ne (local.get $pwfx) (i32.const 0))
              (i32.ge_u (local.get $cbwfx) (i32.const 16)))
          (then
            (local.set $pwfx (call $g2w (local.get $pwfx)))
            (i32.store16 (local.get $pwfx) (i32.const 1))              ;; WAVE_FORMAT_PCM
            (i32.store16 offset=2 (local.get $pwfx) (local.get $ch))
            (i32.store offset=4 (local.get $pwfx) (local.get $rate))
            (i32.store offset=8 (local.get $pwfx)                       ;; nAvgBytesPerSec
              (i32.mul (local.get $rate)
                (i32.mul (local.get $ch) (i32.shr_u (local.get $bits) (i32.const 3)))))
            (i32.store16 offset=12 (local.get $pwfx)                    ;; nBlockAlign
              (i32.mul (local.get $ch) (i32.shr_u (local.get $bits) (i32.const 3))))
            (i32.store16 offset=14 (local.get $pwfx) (local.get $bits))
            (if (i32.ge_u (local.get $cbwfx) (i32.const 18))
              (then (i32.store16 offset=16 (local.get $pwfx) (i32.const 0))))))
        (i32.store offset=8 (local.get $wa) (i32.const 1)))
      (else
        ;; Name the caller's own format. Read it back rather than trusting the
        ;; index, and find the matching standard entry for the name.
        (if (i32.eqz (local.get $pwfx))
          (then (return (i32.const 0x00000057))))
        (local.set $pwfx (call $g2w (local.get $pwfx)))
        (local.set $rate (i32.load offset=4 (local.get $pwfx)))
        (local.set $bits (i32.load16_u offset=14 (local.get $pwfx)))
        (local.set $ch   (i32.load16_u offset=2 (local.get $pwfx)))
        (local.set $index
          (i32.or
            (i32.shl
              (select (i32.const 3)
                (select (i32.const 2)
                  (select (i32.const 1) (i32.const 0)
                    (i32.ge_u (local.get $rate) (i32.const 11025)))
                  (i32.ge_u (local.get $rate) (i32.const 22050)))
                (i32.ge_u (local.get $rate) (i32.const 44100)))
              (i32.const 2))
            (i32.or
              (i32.shl (select (i32.const 1) (i32.const 0)
                (i32.ge_u (local.get $bits) (i32.const 16))) (i32.const 1))
              (select (i32.const 1) (i32.const 0)
                (i32.ge_u (local.get $ch) (i32.const 2))))))))
    (i32.store offset=12 (local.get $wa) (i32.const 0x04))   ;; SUPPORTF_CONVERTER
    (local.set $index (call $acm_pcm_format_name
      (i32.add (local.get $pafd) (i32.const 24)) (local.get $index)))
    (if (local.get $wide)
      (then (call $acm_widen_in_place
              (i32.add (local.get $pafd) (i32.const 24)) (local.get $index))))
    (i32.const 0))                                           ;; MMSYSERR_NOERROR

  (func $handle_acmFormatDetailsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $acm_format_details
      (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args stdcall
  )

  (func $handle_acmFormatDetailsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $acm_format_details
      (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 794: waveOutGetDevCapsA(uDeviceID, lpCaps, cbCaps) — 3 args stdcall
  ;; Fill WAVEOUTCAPSA struct with basic PCM support
  ;; waveOutGetDevCaps{A,W}(uDeviceID, lpCaps, cbCaps). WAVEOUTCAPSA and
  ;; WAVEOUTCAPSW differ only in szPname[32] being CHAR vs WCHAR, so everything
  ;; after that field sits 32 bytes further along in the wide struct.
  (func $wave_out_dev_caps (param $caps_g i32) (param $cb i32) (param $wide i32)
    (local $wa i32) (local $i i32) (local $tail i32)
    (local.set $wa (call $g2w (local.get $caps_g)))
    (call $zero_memory (local.get $wa) (local.get $cb))
    ;; wMid=1 (Microsoft), wPid=1, vDriverVersion = 4.0
    (i32.store16 (local.get $wa) (i32.const 1))
    (i32.store16 (i32.add (local.get $wa) (i32.const 2)) (i32.const 1))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x0400))
    ;; szPname = "Audio" at offset 8
    (call $store_char (i32.add (local.get $caps_g) (i32.const 8)) (i32.const 0x41) (local.get $wide))
    (local.set $i (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (local.get $i))) (i32.const 0x75) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $i) (i32.const 2)))) (i32.const 0x64) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $i) (i32.const 3)))) (i32.const 0x69) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $i) (i32.const 4)))) (i32.const 0x6F) (local.get $wide))
    ;; dwFormats / wChannels / dwSupport: 40/44/48 (A), 72/76/80 (W)
    (local.set $tail (i32.add (local.get $wa) (select (i32.const 72) (i32.const 40) (local.get $wide))))
    (i32.store (local.get $tail) (i32.const 0x00000FFF))                ;; common PCM formats
    (i32.store16 (i32.add (local.get $tail) (i32.const 4)) (i32.const 2))  ;; stereo
    (i32.store (i32.add (local.get $tail) (i32.const 8)) (i32.const 0x0C))) ;; VOLUME|LRVOLUME

  (func $handle_waveOutGetDevCapsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $wave_out_dev_caps (local.get $arg1) (local.get $arg2) (i32.const 0))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args stdcall
  )

  ;; waveOutGetDevCapsW(uDeviceID, lpCaps, cbCaps) — wide-char variant
  (func $handle_waveOutGetDevCapsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $wave_out_dev_caps (local.get $arg1) (local.get $arg2) (i32.const 1))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; waveOutGetID(hwo, puDeviceID) — this runtime exposes one waveOut device.
  ;; The current handle lives in shared memory because a worker-owned Miles
  ;; callback can query the handle opened by the main instance.
  (func $handle_waveOutGetID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const 11)) ;; MMSYSERR_INVALPARAM
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (i32.or (i32.eqz (local.get $arg0))
                (i32.ne (local.get $arg0) (i32.load (region.addr $WAVE_OUT_SHARED 0))))
      (then
        (global.set $eax (i32.const 5)) ;; MMSYSERR_INVALHANDLE
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (call $gs32 (local.get $arg1) (i32.const 0)) ;; sole device ID
    (global.set $eax (i32.const 0)) ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 795: waveOutOpen(phwo, uDeviceID, lpFormat, dwCallback, dwInstance, fdwOpen)
  ;; WAVEFORMATEX: +0 wFormatTag(2), +2 nChannels(2), +4 nSamplesPerSec(4),
  ;;   +8 nAvgBytesPerSec(4), +12 nBlockAlign(2), +14 wBitsPerSample(2)
  (func $handle_waveOutOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $fmt_wa i32) (local $rate i32) (local $ch i32) (local $bits i32)
    (local $handle i32) (local $fdwOpen i32) (local $cbType i32)
    ;; arg0=phwo, arg1=uDeviceID, arg2=lpFormat, arg3=dwCallback, arg4=dwInstance
    ;; fdwOpen is 6th arg at [esp+24]
    (local.set $fdwOpen (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    ;; Read WAVEFORMATEX
    (local.set $fmt_wa (call $g2w (local.get $arg2)))
    (local.set $rate (i32.load (i32.add (local.get $fmt_wa) (i32.const 4))))
    (local.set $ch (i32.load16_u (i32.add (local.get $fmt_wa) (i32.const 2))))
    (local.set $bits (i32.load16_u (i32.add (local.get $fmt_wa) (i32.const 14))))
    ;; Callback type from fdwOpen bits 16-18:
    ;; 0=none, 1=window, 2=thread, 3=function, 5=event
    (local.set $cbType (i32.and (i32.shr_u (local.get $fdwOpen) (i32.const 16)) (i32.const 7)))
    ;; If WAVE_FORMAT_QUERY (0x01), just check support, don't open
    (if (i32.and (local.get $fdwOpen) (i32.const 1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
        (return)))
    ;; Open via host
    (local.set $handle (call $host_wave_out_open
      (local.get $rate) (local.get $ch) (local.get $bits) (local.get $cbType)))
    ;; Store callback info in WAVE_OUT_SHARED (cross-thread accessible)
    ;; +0: handle, +4: callback, +8: instance, +12: cb_type
    (global.set $wave_out_handle (local.get $handle))
    (i32.store (region.addr $WAVE_OUT_SHARED 0) (local.get $handle))
    (i32.store (region.addr $WAVE_OUT_SHARED 4) (local.get $arg3))
    (i32.store (region.addr $WAVE_OUT_SHARED 8) (local.get $arg4))
    (i32.store (region.addr $WAVE_OUT_SHARED 12) (local.get $cbType))
    ;; If phwo != NULL, store handle
    (if (local.get $arg0)
      (then (call $gs32 (local.get $arg0) (local.get $handle))))
    (if (i32.eq (local.get $cbType) (i32.const 1))
      (then
        ;; CALLBACK_WINDOW: MM_WOM_OPEN(hwnd, hwo, 0)
        (drop (call $post_queue_push
          (local.get $arg3)
          (i32.const 0x03BB)
          (local.get $handle)
          (i32.const 0)))))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args stdcall
  )

  ;; 796: waveOutClose(hwo) — 1 arg stdcall
  (func $handle_waveOutClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Flush deferred WHDR_DONE slot
    (i32.store (i32.const 0xAD98) (i32.const 0))
    (if (i32.eq (i32.load (region.addr $WAVE_OUT_SHARED 12)) (i32.const 1))
      (then
        ;; CALLBACK_WINDOW: MM_WOM_CLOSE(hwnd, hwo, 0)
        (drop (call $post_queue_push
          (i32.load (region.addr $WAVE_OUT_SHARED 4))
          (i32.const 0x03BC)
          (local.get $arg0)
          (i32.const 0)))))
    (drop (call $host_wave_out_close (local.get $arg0)))
    (global.set $wave_out_handle (i32.const 0))
    ;; Invalidate the cross-instance handle too.  waveOutGetID may execute in
    ;; a native Miles worker whose own mutable global is not the opener's.
    (i32.store (region.addr $WAVE_OUT_SHARED 0) (i32.const 0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 797: waveOutPrepareHeader — return MMSYSERR_NOERROR, set WHDR_PREPARED flag
  (func $handle_waveOutPrepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Set dwFlags |= WHDR_PREPARED (0x02) in WAVEHDR at arg1+16
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (i32.add (local.get $wa) (i32.const 16))
      (i32.or (i32.load (i32.add (local.get $wa) (i32.const 16))) (i32.const 2)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 798: waveOutUnprepareHeader — return MMSYSERR_NOERROR, clear WHDR_PREPARED/INQUEUE and mark DONE
  (func $handle_waveOutUnprepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (i32.add (local.get $wa) (i32.const 16))
      (i32.and
        (i32.or
          (i32.and (i32.load (i32.add (local.get $wa) (i32.const 16))) (i32.const 0xFFFFFFFD))
          (i32.const 1))
        (i32.const 0xFFFFFFEF)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 799: waveOutWrite(hwo, lpWaveHdr, cbWaveHdr) — 3 args stdcall
  ;; WAVEHDR: +0 lpData(4), +4 dwBufferLength(4), +8 dwBytesRecorded(4),
  ;;   +12 dwUser(4), +16 dwFlags(4), +20 dwLoops(4), +24 lpNext(4), +28 reserved(4)
  ;;
  ;; Async WHDR_DONE: real Windows marks WHDR_DONE only after the buffer
  ;; finishes playing. The host schedules that completion against the audio
  ;; clock; 0xAD98 keeps the last WAVEHDR available for Reset/Close flushes.
  (func $handle_waveOutWrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $data_ga i32) (local $data_len i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; Read lpData and dwBufferLength from WAVEHDR
    (local.set $data_ga (i32.load (local.get $wa)))
    (local.set $data_len (i32.load (i32.add (local.get $wa) (i32.const 4))))
    ;; Send PCM data to host for playback. Use logical-and (coerce both to 0/1)
    ;; — bare i32.and is BITWISE and silently drops calls where data_ga and
    ;; data_len happen not to share any 1-bits (e.g. lpData=0x78521c & len=0x2d00 = 0).
    (if (i32.and (i32.ne (local.get $data_ga) (i32.const 0))
                 (i32.ne (local.get $data_len) (i32.const 0)))
      (then
        ;; Submitted buffers are no longer DONE and remain INQUEUE until the
        ;; scheduled audio-clock completion fires.
        (i32.store (i32.add (local.get $wa) (i32.const 16))
          (i32.or
            (i32.and (i32.load (i32.add (local.get $wa) (i32.const 16))) (i32.const 0xFFFFFFFE))
            (i32.const 0x10)))
        (drop (call $host_wave_out_write
          (local.get $arg0)
          (call $g2w (local.get $data_ga))
          (local.get $data_len)))
        (drop (call $host_wave_out_schedule_done
          (local.get $arg0)
          (local.get $wa)
          (local.get $arg1)
          (local.get $data_len)))))
    ;; Save this buffer's guest address so Reset/Close can flush if needed.
    (i32.store (i32.const 0xAD98) (local.get $arg1))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 800: waveOutReset — cancel queued host playback, flush WHDR_DONE, return MMSYSERR_NOERROR
  (func $handle_waveOutReset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_wave_out_reset (local.get $arg0)))
    (i32.store (i32.const 0xAD98) (i32.const 0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; waveOutPause freezes queued playback, its byte cursor and WOM_DONE timing.
  (func $handle_waveOutPause (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_wave_out_pause (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; waveOutRestart resumes the unplayed tail of every queued buffer.
  (func $handle_waveOutRestart (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_wave_out_restart (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 840: waveOutGetVolume(hwo, lpdwVolume) — 2 args stdcall
  ;; dwVolume: low word = left channel, high word = right channel (0x0000–0xFFFF)
  (func $handle_waveOutGetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (global.get $wave_out_volume))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 841: waveOutSetVolume(hwo, dwVolume) — 2 args stdcall
  (func $handle_waveOutSetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $wave_out_volume (local.get $arg1))
    ;; Pass max of left/right channel to host (0–65535)
    (call $host_wave_out_set_volume (local.get $arg0)
      (if (result i32) (i32.gt_u
        (i32.and (local.get $arg1) (i32.const 0xFFFF))
        (i32.shr_u (local.get $arg1) (i32.const 16)))
        (then (i32.and (local.get $arg1) (i32.const 0xFFFF)))
        (else (i32.shr_u (local.get $arg1) (i32.const 16)))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 803: waveOutGetPosition(hwo, lpInfo, cbInfo) — fill MMTIME struct
  (func $handle_waveOutGetPosition (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; MMTIME.wType = TIME_BYTES (4), u.cb = bytes played
    (i32.store (local.get $wa) (i32.const 4))
    (i32.store (i32.add (local.get $wa) (i32.const 4))
      (call $host_wave_out_get_pos (local.get $arg0)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 804: mmioOpenA(lpszFileName, lpmmioinfo, dwOpenFlags) — 3 args stdcall
  ;; Opens a file for RIFF I/O. Returns HMMIO (file handle) or 0 on failure.
  ;; dwOpenFlags: MMIO_READ=0x0000, MMIO_WRITE=0x0001, MMIO_CREATE=0x1000,
  ;;              MMIO_ALLOCBUF=0x10000, MMIO_DELETE=0x0200
  (func $handle_mmioOpenA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32)
    (local $creation i32)
    ;; arg0 = filename (guest ptr to string)
    ;; arg1 = lpmmioinfo (can be NULL)
    ;; arg2 = dwOpenFlags
    ;; Determine creation disposition from flags
    ;; MMIO_CREATE (0x1000) → CREATE_ALWAYS (2), else OPEN_EXISTING (3)
    (local.set $creation (i32.const 3))  ;; OPEN_EXISTING
    (if (i32.and (local.get $arg2) (i32.const 0x1000))
      (then (local.set $creation (i32.const 2))))  ;; CREATE_ALWAYS
    ;; Open via host filesystem
    (local.set $handle (call $host_fs_create_file
      (call $g2w (local.get $arg0))  ;; pathWA
      (i32.const 0x80000000)          ;; GENERIC_READ
      (local.get $creation)
      (i32.const 0x80)                ;; FILE_ATTRIBUTE_NORMAL
      (i32.const 0)))                 ;; isWide=0
    ;; If lpmmioinfo is non-NULL, store error code at offset +64 (wErrorRet)
    (if (local.get $arg1)
      (then
        (if (local.get $handle)
          (then (call $gs32 (local.get $arg1) (i32.const 0)))  ;; wErrorRet = 0 (no error) — but actually at +64
          (else (call $gs32 (local.get $arg1) (i32.const 256)))))) ;; MMIOERR_FILENOTFOUND
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 805: mmioClose(hmmio, wFlags) — 2 args stdcall
  (func $handle_mmioClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $mmio_buf_release (local.get $arg0))
    (drop (call $host_fs_close_handle (local.get $arg0)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; mmioStringToFOURCCA(sz, uFlags) — pack four bytes, padding with spaces.
  ;; MMIO_TOUPPER (0x10) applies ASCII case folding before packing.
  (func $handle_mmioStringToFOURCCA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $i i32) (local $ch i32)
    (local $fourcc i32) (local $ended i32)
    (if (local.get $arg0)
      (then (local.set $src (call $g2w (local.get $arg0))))
      (else (local.set $ended (i32.const 1))))
    (block $done
      (loop $pack
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
        (local.set $ch (i32.const 0x20))
        (if (i32.eqz (local.get $ended))
          (then
            (local.set $ch (i32.load8_u
              (i32.add (local.get $src) (local.get $i))))
            (if (i32.eqz (local.get $ch))
              (then
                (local.set $ended (i32.const 1))
                (local.set $ch (i32.const 0x20)))
              (else
                (if (i32.and
                      (i32.ne (i32.and (local.get $arg1) (i32.const 0x10))
                              (i32.const 0))
                      (i32.and
                        (i32.ge_u (local.get $ch) (i32.const 0x61))
                        (i32.le_u (local.get $ch) (i32.const 0x7A))))
                  (then
                    (local.set $ch
                      (i32.sub (local.get $ch) (i32.const 0x20)))))))))
        (local.set $fourcc
          (i32.or (local.get $fourcc)
            (i32.shl (local.get $ch)
              (i32.mul (local.get $i) (i32.const 8)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $pack)))
    (global.set $eax (local.get $fourcc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 806: mmioDescend(hmmio, lpck, lpckParent, wFlags) — 4 args stdcall
  ;; Descends into a RIFF chunk. Reads 8-byte chunk header (ckid + cksize).
  ;; MMCKINFO struct: +0 ckid, +4 cksize, +8 fccType, +12 dwDataOffset, +16 dwFlags
  ;; wFlags: MMIO_FINDCHUNK=0x10, MMIO_FINDRIFF=0x20, MMIO_FINDLIST=0x40
  (func $handle_mmioDescend (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ck_wa i32) (local $pos i32) (local $ckid i32) (local $cksize i32)
    (local $search_id i32) (local $search_type i32) (local $fcc_type i32)
    (local $end_pos i32) (local $bytes_read_ga i32) (local $bytes_read_wa i32)
    (local $data_offset i32) (local $parent_wa i32)
    (local.set $ck_wa (call $g2w (local.get $arg1)))
    ;; arg3 = wFlags (passed as 5th stack arg), read from [esp+24] in caller
    ;; Actually arg3 = wFlags since dispatcher reads 5 args
    ;; Save search criteria if FIND flags are set
    (if (local.get $arg3)
      (then
        ;; For FINDCHUNK/FINDRIFF/FINDLIST, save the target ckid/fccType
        (local.set $search_id (i32.load (local.get $ck_wa)))       ;; ckid to find
        (local.set $search_type (i32.load (i32.add (local.get $ck_wa) (i32.const 8)))) ;; fccType to find
      ))
    ;; Determine end position from parent chunk (if present)
    (local.set $end_pos (i32.const 0x7FFFFFFF))  ;; no limit if no parent
    (if (local.get $arg2)
      (then
        (local.set $parent_wa (call $g2w (local.get $arg2)))
        (local.set $end_pos (i32.add
          (i32.load offset=12 (local.get $parent_wa))  ;; parent dwDataOffset
          (i32.load offset=4 (local.get $parent_wa))))))  ;; + parent cksize
    ;; Scratch area for bytesRead on stack
    (local.set $bytes_read_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_read_wa (call $g2w (local.get $bytes_read_ga)))
    ;; Search loop: read chunk headers until we find the target or EOF
    (block $done
      (loop $search
        ;; Get current file position
        (local.set $pos (call $host_fs_set_file_pointer (local.get $arg0) (i32.const 0) (i32.const 1)))
        ;; Check if past end of parent chunk
        (br_if $done (i32.ge_u (local.get $pos) (local.get $end_pos)))
        ;; Read 8 bytes: ckid (4) + cksize (4) into the MMCKINFO struct
        (i32.store (local.get $bytes_read_wa) (i32.const 0))
        (drop (call $host_fs_read_file
          (local.get $arg0)
          (local.get $arg1)  ;; write directly into MMCKINFO (guest addr)
          (i32.const 8)
          (local.get $bytes_read_ga)))
        ;; Check if we read 8 bytes
        (br_if $done (i32.lt_u (i32.load (local.get $bytes_read_wa)) (i32.const 8)))
        (local.set $ckid (i32.load (local.get $ck_wa)))
        (local.set $cksize (i32.load (i32.add (local.get $ck_wa) (i32.const 4))))
        ;; For RIFF and LIST chunks, read 4 more bytes for fccType.
        ;; dwDataOffset is always the byte after cksize (pos+8) — for a RIFF/LIST
        ;; chunk the data area *starts with* the form type, so it is not skipped
        ;; here even though the file pointer is left past it. Apps rely on both
        ;; halves of that: the MSDN idiom seeks to `dwDataOffset + sizeof(FOURCC)`
        ;; to reach the first subchunk, and mmioAscend adds cksize (which counts
        ;; the form type) to dwDataOffset to find the chunk end.
        (local.set $fcc_type (i32.const 0))
        (local.set $data_offset (i32.add (local.get $pos) (i32.const 8)))
        (if (i32.or
              (i32.eq (local.get $ckid) (i32.const 0x46464952))  ;; "RIFF"
              (i32.eq (local.get $ckid) (i32.const 0x5453494C))) ;; "LIST"
          (then
            ;; Read fccType (4 bytes) into MMCKINFO+8
            (i32.store (local.get $bytes_read_wa) (i32.const 0))
            (drop (call $host_fs_read_file
              (local.get $arg0)
              (i32.add (local.get $arg1) (i32.const 8))  ;; fccType field (guest addr)
              (i32.const 4)
              (local.get $bytes_read_ga)))
            (local.set $fcc_type (i32.load (i32.add (local.get $ck_wa) (i32.const 8))))
          ))
        ;; Store dwDataOffset
        (i32.store (i32.add (local.get $ck_wa) (i32.const 12)) (local.get $data_offset))
        ;; Store dwFlags = 0
        (i32.store (i32.add (local.get $ck_wa) (i32.const 16)) (i32.const 0))
        ;; If no FIND flags, accept first chunk
        (if (i32.eqz (local.get $arg3))
          (then
            (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        ;; MMIO_FINDRIFF (0x20): match fccType
        (if (i32.and (local.get $arg3) (i32.const 0x20))
          (then
            (if (i32.and
                  (i32.eq (local.get $ckid) (i32.const 0x46464952))  ;; "RIFF"
                  (i32.eq (local.get $fcc_type) (local.get $search_type)))
              (then
                (global.set $eax (i32.const 0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
                (return)))))
        ;; MMIO_FINDLIST (0x40): match fccType in LIST
        (if (i32.and (local.get $arg3) (i32.const 0x40))
          (then
            (if (i32.and
                  (i32.eq (local.get $ckid) (i32.const 0x5453494C))  ;; "LIST"
                  (i32.eq (local.get $fcc_type) (local.get $search_type)))
              (then
                (global.set $eax (i32.const 0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
                (return)))))
        ;; MMIO_FINDCHUNK (0x10): match ckid
        (if (i32.and (local.get $arg3) (i32.const 0x10))
          (then
            (if (i32.eq (local.get $ckid) (local.get $search_id))
              (then
                (global.set $eax (i32.const 0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
                (return)))))
        ;; Not found — skip this chunk's data and try next
        ;; Seek past cksize bytes (word-aligned)
        (drop (call $host_fs_set_file_pointer
          (local.get $arg0)
          (i32.add (local.get $pos) (i32.add (i32.const 8)
            (i32.and (i32.add (local.get $cksize) (i32.const 1)) (i32.const 0xFFFFFFFE))))
          (i32.const 0)))  ;; SEEK_SET
        (br $search)
      )
    )
    ;; Not found
    (global.set $eax (i32.const 514))  ;; MMIOERR_CHUNKNOTFOUND
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 807: mmioRead(hmmio, pch, cch) — 3 args stdcall
  ;; Reads cch bytes into buffer pch. Returns number of bytes read.
  (func $handle_mmioRead (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $bytes_read_ga i32) (local $bytes_read_wa i32) (local $ok i32) (local $lazy i32)
    (local.set $bytes_read_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_read_wa (call $g2w (local.get $bytes_read_ga)))
    (i32.store (local.get $bytes_read_wa) (i32.const 0))
    (local.set $ok (call $host_fs_read_file
      (local.get $arg0)    ;; handle
      (local.get $arg1)    ;; buffer (guest address)
      (local.get $arg2)    ;; count
      (local.get $bytes_read_ga)))
    (global.set $eax (i32.load (local.get $bytes_read_wa)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    ;; ISO-backed files are filled asynchronously. A zero BOOL can therefore
    ;; mean "retry after the provider chunk arrives", not EOF. Preserve the
    ;; complete stdcall frame and re-enter this thunk exactly as ReadFile does;
    ;; otherwise movie players see a zero-byte header and abandon the stream.
    (if (i32.eqz (local.get $ok))
      (then
        (local.set $lazy (call $host_fs_read_pending))
        (if (i32.eq (local.get $lazy) (i32.const 1))
          (then (call $io_block (i32.const 16))))))
  )

  ;; 808: mmioAscend(hmmio, lpck, wFlags) — 3 args stdcall
  ;; Ascends out of a chunk — seeks past remaining chunk data
  (func $handle_mmioAscend (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ck_wa i32) (local $end_pos i32)
    (local.set $ck_wa (call $g2w (local.get $arg1)))
    ;; End of chunk = dwDataOffset + cksize, word-aligned
    (local.set $end_pos
      (i32.and
        (i32.add
          (i32.add
            (i32.load (i32.add (local.get $ck_wa) (i32.const 12)))  ;; dwDataOffset
            (i32.load (i32.add (local.get $ck_wa) (i32.const 4))))  ;; cksize
          (i32.const 1))
        (i32.const 0xFFFFFFFE)))
    (drop (call $host_fs_set_file_pointer (local.get $arg0) (local.get $end_pos) (i32.const 0)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; mmioSeek(hmmio, lOffset, iOrigin) — 3 args stdcall
  ;; Returns the new file position, or -1 on failure.
  (func $handle_mmioSeek (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_set_file_pointer
      (local.get $arg0)
      (local.get $arg1)
      (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; --- MMIO buffered I/O ------------------------------------------------
  ;; MMIOINFO: +0 dwFlags, +4 fccIOProc, +8 pIOProc, +12 wErrorRet, +16 htask,
  ;;   +20 cchBuffer, +24 pchBuffer, +28 pchNext, +32 pchEndRead,
  ;;   +36 pchEndWrite, +40 lBufOffset, +44 lDiskOffset, +48 adwInfo[3],
  ;;   +60 dwReserved1, +64 dwReserved2, +68 hmmio.
  ;; The app reads straight out of pchBuffer and calls mmioAdvance to refill,
  ;; so the buffer must be a real guest block that stays put for the life of
  ;; the handle. $mmio_buf_for binds a default 8KB block per HMMIO unless
  ;; mmioSetBuffer has selected a caller-owned or differently-sized buffer.
  (func $mmio_slot_addr (param $slot i32) (result i32)
    (i32.add (global.get $mmio_buf_table) (i32.mul (local.get $slot) (i32.const 16))))

  ;; Returns the slot for $h, optionally allocating a new binding.
  (func $mmio_slot_for (param $h i32) (param $create i32) (result i32)
    (local $i i32) (local $addr i32) (local $free i32)
    (if (i32.eqz (global.get $mmio_buf_table))
      (then
        (if (i32.eqz (local.get $create)) (then (return (i32.const 0))))
        (global.set $mmio_buf_table
          (call $heap_alloc (i32.mul (global.get $MMIO_BUF_SLOTS) (i32.const 16))))
        (if (i32.eqz (global.get $mmio_buf_table)) (then (return (i32.const 0))))
        (call $zero_memory (call $g2w (global.get $mmio_buf_table))
          (i32.mul (global.get $MMIO_BUF_SLOTS) (i32.const 16)))))
    (local.set $free (i32.const 0))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MMIO_BUF_SLOTS)))
      (local.set $addr (call $mmio_slot_addr (local.get $i)))
      (if (i32.eq (call $gl32 (local.get $addr)) (local.get $h))
        (then (return (local.get $addr))))
      (if (i32.and (i32.eqz (local.get $free)) (i32.eqz (call $gl32 (local.get $addr))))
        (then (local.set $free (local.get $addr))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ne (local.get $create) (i32.const 0))
                 (i32.ne (local.get $free) (i32.const 0)))
      (then
        (call $gs32 (local.get $free) (local.get $h))
        (return (local.get $free))))
    (i32.const 0))

  ;; Returns the guest buffer bound to $h, binding a default internal buffer on
  ;; first use. 0 if the slot table or heap is exhausted.
  (func $mmio_buf_for (param $h i32) (result i32)
    (local $addr i32) (local $buf i32)
    (local.set $addr (call $mmio_slot_for (local.get $h) (i32.const 1)))
    (if (i32.eqz (local.get $addr)) (then (return (i32.const 0))))
    (local.set $buf (call $gl32 (i32.add (local.get $addr) (i32.const 4))))
    (if (i32.eqz (local.get $buf))
      (then
        (local.set $buf (call $heap_alloc (global.get $MMIO_BUF_SIZE)))
        (if (i32.eqz (local.get $buf)) (then (return (i32.const 0))))
        (call $gs32 (i32.add (local.get $addr) (i32.const 4)) (local.get $buf))
        (call $gs32 (i32.add (local.get $addr) (i32.const 8)) (global.get $MMIO_BUF_SIZE))
        (call $gs32 (i32.add (local.get $addr) (i32.const 12)) (i32.const 1))))
    (local.get $buf))

  ;; Drops the handle→buffer binding and releases an internally-owned block.
  (func $mmio_buf_release (param $h i32)
    (local $addr i32)
    (local.set $addr (call $mmio_slot_for (local.get $h) (i32.const 0)))
    (if (i32.eqz (local.get $addr)) (then (return)))
    (if (i32.and
          (i32.ne (call $gl32 (i32.add (local.get $addr) (i32.const 12))) (i32.const 0))
          (i32.ne (call $gl32 (i32.add (local.get $addr) (i32.const 4))) (i32.const 0)))
      (then (call $heap_free (call $gl32 (i32.add (local.get $addr) (i32.const 4))))))
    (call $zero_memory (call $g2w (local.get $addr)) (i32.const 16)))

  ;; Refills lpmmioinfo's buffer from the file. The app's own pchNext says how
  ;; much of the previous fill it consumed, so the next disk read starts there.
  (func $mmio_refill (param $h i32) (param $info i32) (result i32)
    (local $info_wa i32) (local $buf i32) (local $pos i32)
    (local $read_ga i32) (local $read_wa i32) (local $got i32)
    (local.set $info_wa (call $g2w (local.get $info)))
    (local.set $buf (i32.load (i32.add (local.get $info_wa) (i32.const 24))))
    (if (i32.eqz (local.get $buf)) (then (return (i32.const 259))))  ;; MMIOERR_UNBUFFERED
    (local.set $pos (i32.add
      (i32.load (i32.add (local.get $info_wa) (i32.const 40)))       ;; lBufOffset
      (i32.sub (i32.load (i32.add (local.get $info_wa) (i32.const 28)))  ;; pchNext
               (local.get $buf))))
    (drop (call $host_fs_set_file_pointer (local.get $h) (local.get $pos) (i32.const 0)))
    (local.set $read_ga (i32.sub (global.get $esp) (i32.const 8)))
    (local.set $read_wa (call $g2w (local.get $read_ga)))
    (i32.store (local.get $read_wa) (i32.const 0))
    (drop (call $host_fs_read_file
      (local.get $h)
      (local.get $buf)
      (i32.load (i32.add (local.get $info_wa) (i32.const 20)))       ;; cchBuffer
      (local.get $read_ga)))
    (local.set $got (i32.load (local.get $read_wa)))
    (i32.store (i32.add (local.get $info_wa) (i32.const 28)) (local.get $buf))          ;; pchNext
    (i32.store (i32.add (local.get $info_wa) (i32.const 32))
      (i32.add (local.get $buf) (local.get $got)))                                      ;; pchEndRead
    (i32.store (i32.add (local.get $info_wa) (i32.const 40)) (local.get $pos))          ;; lBufOffset
    (i32.store (i32.add (local.get $info_wa) (i32.const 44))
      (i32.add (local.get $pos) (local.get $got)))                                      ;; lDiskOffset
    (i32.const 0))

  ;; mmioGetInfo(hmmio, lpmmioinfo, wFlags) — 3 args stdcall
  (func $handle_mmioGetInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $info_wa i32) (local $buf i32) (local $pos i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (if (i32.eqz (local.get $arg1))
      (then (global.set $eax (i32.const 5)) (return)))                ;; MMSYSERR_INVALPARAM
    (local.set $buf (call $mmio_buf_for (local.get $arg0)))
    (if (i32.eqz (local.get $buf))
      (then (global.set $eax (i32.const 7)) (return)))                ;; MMSYSERR_NOMEM
    (local.set $pos (call $host_fs_set_file_pointer (local.get $arg0) (i32.const 0) (i32.const 1)))
    (local.set $info_wa (call $g2w (local.get $arg1)))
    (call $zero_memory (local.get $info_wa) (i32.const 72))
    (i32.store (local.get $info_wa) (i32.const 0x00010000))           ;; dwFlags = MMIO_ALLOCBUF
    (i32.store (i32.add (local.get $info_wa) (i32.const 4)) (i32.const 0x454C4946))  ;; fccIOProc "FILE"
    (i32.store (i32.add (local.get $info_wa) (i32.const 20))
      (call $gl32 (i32.add (call $mmio_slot_for (local.get $arg0) (i32.const 0)) (i32.const 8))))
    (i32.store (i32.add (local.get $info_wa) (i32.const 24)) (local.get $buf))       ;; pchBuffer
    ;; Buffer starts empty: pchNext == pchEndRead makes the app call mmioAdvance.
    (i32.store (i32.add (local.get $info_wa) (i32.const 28)) (local.get $buf))       ;; pchNext
    (i32.store (i32.add (local.get $info_wa) (i32.const 32)) (local.get $buf))       ;; pchEndRead
    (i32.store (i32.add (local.get $info_wa) (i32.const 36))
      (i32.add (local.get $buf) (i32.load (i32.add (local.get $info_wa) (i32.const 20))))) ;; pchEndWrite
    (i32.store (i32.add (local.get $info_wa) (i32.const 40)) (local.get $pos))       ;; lBufOffset
    (i32.store (i32.add (local.get $info_wa) (i32.const 44)) (local.get $pos))       ;; lDiskOffset
    (i32.store (i32.add (local.get $info_wa) (i32.const 68)) (local.get $arg0))      ;; hmmio
    (global.set $eax (i32.const 0)))

  ;; mmioAdvance(hmmio, lpmmioinfo, fuAdvance) — 3 args stdcall
  (func $handle_mmioAdvance (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $result i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (if (i32.eqz (local.get $arg1))
      (then (global.set $eax (i32.const 5)) (return)))                ;; MMSYSERR_INVALPARAM
    (local.set $result (call $mmio_refill (local.get $arg0) (local.get $arg1)))
    (global.set $eax (local.get $result))
    ;; Buffered ISO input has the same asynchronous provider boundary as
    ;; mmioRead. A successful MMIO refill with no resident bytes may mean the
    ;; provider is fetching the next extent, not end-of-file. Retry the whole
    ;; API thunk after IO_WAIT so a transient empty buffer cannot terminate a
    ;; movie at the first lazy chunk boundary.
    (if (i32.and
          (i32.eqz (local.get $result))
          (i32.eq (call $host_fs_read_pending) (i32.const 1)))
      (then (call $io_block (i32.const 16))))
  )

  ;; mmioSetInfo(hmmio, lpmmioinfo, wFlags) — 3 args stdcall
  ;; Hands buffered I/O back. The file pointer has to end up where the app's
  ;; pchNext left off, or a following mmioRead/mmioSeek reads from the wrong
  ;; place — mmioAdvance leaves it a whole buffer ahead.
  (func $handle_mmioSetInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $info_wa i32) (local $buf i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (if (i32.eqz (local.get $arg1))
      (then (global.set $eax (i32.const 5)) (return)))                ;; MMSYSERR_INVALPARAM
    (local.set $info_wa (call $g2w (local.get $arg1)))
    (local.set $buf (i32.load (i32.add (local.get $info_wa) (i32.const 24))))
    (if (local.get $buf)
      (then
        (drop (call $host_fs_set_file_pointer (local.get $arg0)
          (i32.add
            (i32.load (i32.add (local.get $info_wa) (i32.const 40)))  ;; lBufOffset
            (i32.sub (i32.load (i32.add (local.get $info_wa) (i32.const 28)))
                     (local.get $buf)))                               ;; + consumed
          (i32.const 0)))))
    (global.set $eax (i32.const 0)))

  ;; mmioSetBuffer(hmmio, pchBuffer, cchBuffer, fuBuffer) — 4 args stdcall.
  ;; Bind caller storage, allocate internal storage for NULL+size, or disable
  ;; buffering for NULL+zero. Alpha Centauri requests a 16 KiB internal buffer.
  (func $handle_mmioSetBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $buf i32) (local $owned i32) (local $old i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (if (i32.or (local.get $arg3) (i32.lt_s (local.get $arg2) (i32.const 0)))
      (then (global.set $eax (i32.const 5)) (return)))               ;; MMSYSERR_INVALPARAM
    (if (i32.eqz (local.get $arg2))
      (then
        (call $mmio_buf_release (local.get $arg0))
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $slot (call $mmio_slot_for (local.get $arg0) (i32.const 1)))
    (if (i32.eqz (local.get $slot))
      (then (global.set $eax (i32.const 258)) (return)))             ;; MMIOERR_OUTOFMEMORY
    (local.set $buf (local.get $arg1))
    (if (i32.eqz (local.get $buf))
      (then
        (local.set $buf (call $heap_alloc (local.get $arg2)))
        (if (i32.eqz (local.get $buf))
          (then (global.set $eax (i32.const 258)) (return)))         ;; MMIOERR_OUTOFMEMORY
        (local.set $owned (i32.const 1))))
    (local.set $old (call $gl32 (i32.add (local.get $slot) (i32.const 4))))
    (if (i32.and
          (i32.ne (call $gl32 (i32.add (local.get $slot) (i32.const 12))) (i32.const 0))
          (i32.and (i32.ne (local.get $old) (i32.const 0))
                   (i32.ne (local.get $old) (local.get $buf))))
      (then (call $heap_free (local.get $old))))
    (call $gs32 (i32.add (local.get $slot) (i32.const 4)) (local.get $buf))
    (call $gs32 (i32.add (local.get $slot) (i32.const 8)) (local.get $arg2))
    (call $gs32 (i32.add (local.get $slot) (i32.const 12)) (local.get $owned))
    (global.set $eax (i32.const 0)))

  (func $mci_slot_addr (param $slot i32) (result i32)
    (i32.add (global.get $MCI_DEVICE_TABLE)
      (i32.mul (local.get $slot) (i32.const 16))))

  (func $mci_alloc_slot (result i32)
    (local $slot i32)
    (local.set $slot (i32.const 1))
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $slot) (i32.const 16)))
        (if (i32.eqz (i32.load (call $mci_slot_addr (local.get $slot))))
          (then (return (local.get $slot))))
        (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
        (br $scan)))
    (i32.const 0))

  ;; mciGetDeviceIDA(alias) returns the MCI device opened by a prior
  ;; mciSendStringA "open ... alias ..." command. String-command aliases live
  ;; in the host MCI backend, so resolve them at that same boundary.
  (func $handle_mciGetDeviceIDA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (local.get $arg0)
        (then (call $host_mci_get_device_id (call $g2w (local.get $arg0))))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 809: mciSendCommandA(mciId, uMsg, fdwCommand, dwParam)
  (func $handle_mciSendCommandA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $params_wa i32)
    (local $slot i32)
    (local $slot_addr i32)
    (local $host_id i32)
    (local $type_val i32)
    (local $type_arg i32)
    (local $element_wa i32)
    (local $err i32)
    ;; MCI_SYSINFO is handled by MCI itself and accepts MCI_ALL_DEVICE_ID (-1),
    ;; so it must run before the per-open-device validation below. Advertise
    ;; exactly the two device classes backed by the host audio implementation.
    (if (i32.eq (local.get $arg1) (i32.const 0x0810))
      (then
        (if (i32.eqz (local.get $arg3))
          (then
            (global.set $eax (i32.const 0x105)) ;; MCIERR_MISSING_PARAMETER
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (local.set $params_wa (call $g2w (local.get $arg3)))
        (local.set $element_wa (call $g2w (i32.load offset=4 (local.get $params_wa))))
        (if (i32.and (local.get $arg2) (i32.const 0x100)) ;; MCI_SYSINFO_QUANTITY
          (then
            (i32.store (local.get $element_wa)
              (if (result i32) (i32.and (local.get $arg2) (i32.const 0x200))
                (then (i32.const 0)) ;; no devices are open during discovery
                (else (i32.const 2))))
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (if (i32.and (local.get $arg2) (i32.const 0x400)) ;; MCI_SYSINFO_NAME
          (then
            (if (i32.eq (i32.load offset=12 (local.get $params_wa)) (i32.const 1))
              (then
                (i32.store (local.get $element_wa) (i32.const 0x65766177)) ;; wave
                (i32.store offset=4 (local.get $element_wa) (i32.const 0x69647561)) ;; audi
                (i32.store offset=8 (local.get $element_wa) (i32.const 0x0000006f))) ;; o
              (else
                (i32.store (local.get $element_wa) (i32.const 0x75716573)) ;; sequ
                (i32.store offset=4 (local.get $element_wa) (i32.const 0x65636e65)) ;; ence
                (i32.store offset=8 (local.get $element_wa) (i32.const 0x00000072)))) ;; r
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (global.set $eax (i32.const 0x105))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; MCI_OPEN = 0x0803. MCI_OPEN_PARMSA: +4 wDeviceID, +8 lpstrDeviceType,
    ;; +12 lpstrElementName.
    (if (i32.eq (local.get $arg1) (i32.const 0x0803))
      (then
        (if (i32.eqz (local.get $arg3))
          (then
            (global.set $eax (i32.const 0x106)) ;; MCIERR_INVALID_DEVICE_ID
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (local.set $params_wa (call $g2w (local.get $arg3)))
        (local.set $type_val (i32.load (i32.add (local.get $params_wa) (i32.const 8))))
        (local.set $type_arg
          (if (result i32)
            (i32.and (local.get $arg2) (i32.const 0x1000)) ;; MCI_OPEN_TYPE_ID
            (then (local.get $type_val))
            (else
              (if (result i32) (local.get $type_val)
                (then (call $g2w (local.get $type_val)))
                (else (i32.const 0))))))
        (local.set $element_wa
          (if (result i32) (i32.load (i32.add (local.get $params_wa) (i32.const 12)))
            (then (call $g2w (i32.load (i32.add (local.get $params_wa) (i32.const 12)))))
            (else (i32.const 0))))
        (local.set $host_id (call $host_mci_open
          (local.get $type_arg)
          (local.get $element_wa)
          (local.get $arg2)))
        (if (i32.eqz (local.get $host_id))
          (then
            (global.set $eax (i32.const 0x107)) ;; MCIERR_UNRECOGNIZED_KEYWORD / generic open failure
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (local.set $slot (call $mci_alloc_slot))
        (if (i32.eqz (local.get $slot))
          (then
            (drop (call $host_mci_command (local.get $host_id) (i32.const 0x0804) (i32.const 0) (i32.const 0)))
            (global.set $eax (i32.const 0x109)) ;; MCIERR_OUT_OF_MEMORY-ish
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (local.set $slot_addr (call $mci_slot_addr (local.get $slot)))
        (i32.store (local.get $slot_addr) (local.get $host_id))
        (i32.store (i32.add (local.get $params_wa) (i32.const 4)) (local.get $slot))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $slot (local.get $arg0))
    (if (i32.or (i32.eqz (local.get $slot)) (i32.ge_u (local.get $slot) (i32.const 16)))
      (then
        (global.set $eax (i32.const 0x106)) ;; MCIERR_INVALID_DEVICE_ID
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $slot_addr (call $mci_slot_addr (local.get $slot)))
    (local.set $host_id (i32.load (local.get $slot_addr)))
    (if (i32.eqz (local.get $host_id))
      (then
        (global.set $eax (i32.const 0x106))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $params_wa
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3)))
        (else (i32.const 0))))
    (local.set $err (call $host_mci_command
      (local.get $host_id)
      (local.get $arg1)
      (local.get $arg2)
      (local.get $params_wa)))
    (if (i32.eq (local.get $arg1) (i32.const 0x0804)) ;; MCI_CLOSE
      (then (i32.store (local.get $slot_addr) (i32.const 0))))
    (global.set $eax (local.get $err))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 855: mciSendCommandW — wide version, same behavior
  (func $handle_mciSendCommandW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $params_wa i32)
    (local $slot i32)
    (local $slot_addr i32)
    (local $host_id i32)
    (local $type_val i32)
    (local $type_arg i32)
    (local $element_wa i32)
    (local $err i32)
    (if (i32.eq (local.get $arg1) (i32.const 0x0810)) ;; MCI_SYSINFO
      (then
        (if (i32.eqz (local.get $arg3))
          (then
            (global.set $eax (i32.const 0x105))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (local.set $params_wa (call $g2w (local.get $arg3)))
        (local.set $element_wa (call $g2w (i32.load offset=4 (local.get $params_wa))))
        (if (i32.and (local.get $arg2) (i32.const 0x100)) ;; MCI_SYSINFO_QUANTITY
          (then
            (i32.store (local.get $element_wa)
              (if (result i32) (i32.and (local.get $arg2) (i32.const 0x200))
                (then (i32.const 0))
                (else (i32.const 2))))
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (if (i32.and (local.get $arg2) (i32.const 0x400)) ;; MCI_SYSINFO_NAME
          (then
            (if (i32.eq (i32.load offset=12 (local.get $params_wa)) (i32.const 1))
              (then
                (i32.store16 (local.get $element_wa) (i32.const 0x77)) ;; waveaudio
                (i32.store16 offset=2 (local.get $element_wa) (i32.const 0x61))
                (i32.store16 offset=4 (local.get $element_wa) (i32.const 0x76))
                (i32.store16 offset=6 (local.get $element_wa) (i32.const 0x65))
                (i32.store16 offset=8 (local.get $element_wa) (i32.const 0x61))
                (i32.store16 offset=10 (local.get $element_wa) (i32.const 0x75))
                (i32.store16 offset=12 (local.get $element_wa) (i32.const 0x64))
                (i32.store16 offset=14 (local.get $element_wa) (i32.const 0x69))
                (i32.store16 offset=16 (local.get $element_wa) (i32.const 0x6f))
                (i32.store16 offset=18 (local.get $element_wa) (i32.const 0)))
              (else
                (i32.store16 (local.get $element_wa) (i32.const 0x73)) ;; sequencer
                (i32.store16 offset=2 (local.get $element_wa) (i32.const 0x65))
                (i32.store16 offset=4 (local.get $element_wa) (i32.const 0x71))
                (i32.store16 offset=6 (local.get $element_wa) (i32.const 0x75))
                (i32.store16 offset=8 (local.get $element_wa) (i32.const 0x65))
                (i32.store16 offset=10 (local.get $element_wa) (i32.const 0x6e))
                (i32.store16 offset=12 (local.get $element_wa) (i32.const 0x63))
                (i32.store16 offset=14 (local.get $element_wa) (i32.const 0x65))
                (i32.store16 offset=16 (local.get $element_wa) (i32.const 0x72))
                (i32.store16 offset=18 (local.get $element_wa) (i32.const 0))))
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (global.set $eax (i32.const 0x105))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (if (i32.eq (local.get $arg1) (i32.const 0x0803))
      (then
        (if (i32.eqz (local.get $arg3))
          (then
            (global.set $eax (i32.const 0x106))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (local.set $params_wa (call $g2w (local.get $arg3)))
        (local.set $type_val (i32.load (i32.add (local.get $params_wa) (i32.const 8))))
        (local.set $type_arg
          (if (result i32)
            (i32.and (local.get $arg2) (i32.const 0x1000))
            (then (local.get $type_val))
            (else
              (if (result i32) (local.get $type_val)
                (then (call $g2w (local.get $type_val)))
                (else (i32.const 0))))))
        (local.set $element_wa
          (if (result i32) (i32.load (i32.add (local.get $params_wa) (i32.const 12)))
            (then (call $g2w (i32.load (i32.add (local.get $params_wa) (i32.const 12)))))
            (else (i32.const 0))))
        (local.set $host_id (call $host_mci_open_w
          (local.get $type_arg)
          (local.get $element_wa)
          (local.get $arg2)))
        (if (i32.eqz (local.get $host_id))
          (then
            (global.set $eax (i32.const 0x107))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (local.set $slot (call $mci_alloc_slot))
        (if (i32.eqz (local.get $slot))
          (then
            (drop (call $host_mci_command (local.get $host_id) (i32.const 0x0804) (i32.const 0) (i32.const 0)))
            (global.set $eax (i32.const 0x109))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        (local.set $slot_addr (call $mci_slot_addr (local.get $slot)))
        (i32.store (local.get $slot_addr) (local.get $host_id))
        (i32.store (i32.add (local.get $params_wa) (i32.const 4)) (local.get $slot))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $slot (local.get $arg0))
    (if (i32.or (i32.eqz (local.get $slot)) (i32.ge_u (local.get $slot) (i32.const 16)))
      (then
        (global.set $eax (i32.const 0x106))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $slot_addr (call $mci_slot_addr (local.get $slot)))
    (local.set $host_id (i32.load (local.get $slot_addr)))
    (if (i32.eqz (local.get $host_id))
      (then
        (global.set $eax (i32.const 0x106))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $params_wa
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3)))
        (else (i32.const 0))))
    (local.set $err (call $host_mci_command
      (local.get $host_id)
      (local.get $arg1)
      (local.get $arg2)
      (local.get $params_wa)))
    (if (i32.eq (local.get $arg1) (i32.const 0x0804))
      (then (i32.store (local.get $slot_addr) (i32.const 0))))
    (global.set $eax (local.get $err))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 810: GetSystemPaletteEntries(hdc, iStart, nEntries, lppe) — 4 args stdcall
  ;; Fill the 20 reserved Windows system-palette entries (indices 0-9 and 246-255)
  ;; with the standard Win98 colors, zero elsewhere. Apps (e.g. RCT) use these to
  ;; confirm we're on a palettized display; returning all zeros makes them quit.
  (func $handle_GetSystemPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)      ;; wasm addr of caller buffer
    (local $i i32)        ;; index inside buffer (0..nEntries)
    (local $pal i32)      ;; palette index (iStart + i)
    (local $rgb i32)      ;; packed 0x00BBGGRR
    (if (i32.eqz (local.get $arg3))
      (then
        (global.set $eax (i32.const 256))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $buf (call $g2w (local.get $arg3)))
    (call $zero_memory (local.get $buf) (i32.mul (local.get $arg2) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $pal (i32.add (local.get $arg1) (local.get $i)))
      (local.set $rgb (i32.const 0))
      (if (i32.lt_u (local.get $pal) (i32.const 10))
        (then
          (block $f
            (if (i32.eq (local.get $pal) (i32.const 0)) (then (local.set $rgb (i32.const 0x000000)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 1)) (then (local.set $rgb (i32.const 0x000080)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 2)) (then (local.set $rgb (i32.const 0x008000)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 3)) (then (local.set $rgb (i32.const 0x008080)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 4)) (then (local.set $rgb (i32.const 0x800000)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 5)) (then (local.set $rgb (i32.const 0x800080)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 6)) (then (local.set $rgb (i32.const 0x808000)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 7)) (then (local.set $rgb (i32.const 0xC0C0C0)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 8)) (then (local.set $rgb (i32.const 0xC0DCC0)) (br $f)))
            (if (i32.eq (local.get $pal) (i32.const 9)) (then (local.set $rgb (i32.const 0xF0CAA6)) (br $f)))
          )))
      (if (i32.ge_u (local.get $pal) (i32.const 246))
        (then
          (block $g
            (if (i32.eq (local.get $pal) (i32.const 246)) (then (local.set $rgb (i32.const 0xF0FBFF)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 247)) (then (local.set $rgb (i32.const 0xA4A0A0)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 248)) (then (local.set $rgb (i32.const 0x808080)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 249)) (then (local.set $rgb (i32.const 0x0000FF)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 250)) (then (local.set $rgb (i32.const 0x00FF00)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 251)) (then (local.set $rgb (i32.const 0x00FFFF)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 252)) (then (local.set $rgb (i32.const 0xFF0000)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 253)) (then (local.set $rgb (i32.const 0xFF00FF)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 254)) (then (local.set $rgb (i32.const 0xFFFF00)) (br $g)))
            (if (i32.eq (local.get $pal) (i32.const 255)) (then (local.set $rgb (i32.const 0xFFFFFF)) (br $g)))
          )))
      (call $gs32 (i32.add (local.get $arg3) (i32.mul (local.get $i) (i32.const 4))) (local.get $rgb))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.set $eax (local.get $arg2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 811: SetSystemPaletteUse(hdc, uUsage) — 2 args stdcall
  (func $handle_SetSystemPaletteUse (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or (i32.lt_u (local.get $arg1) (i32.const 1))
          (i32.gt_u (local.get $arg1) (i32.const 3)))
      (then (global.set $eax (i32.const 0)))
      (else (global.set $eax (call $gdi_dc_meta_set
        (local.get $arg0) (i32.const 12) (local.get $arg1) (i32.const 1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 812: ChangeDisplaySettingsA(lpDevMode, dwFlags) — 2 args stdcall.
  ;; The mode itself is not honoured (the guest screen size is fixed), but the
  ;; *intent* is recorded: CDS_FULLSCREEN (0x4) with a mode is an app taking
  ;; the display, and a NULL lpDevMode is the documented "go back to the
  ;; registry mode" call that ends it. That flag is the only explicit
  ;; fullscreen signal a non-DirectDraw app gives, so the compositor uses it
  ;; instead of guessing from window geometry.
  (func $handle_ChangeDisplaySettingsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $display_fullscreen
      (i32.and (i32.ne (local.get $arg0) (i32.const 0))
               (i32.ne (i32.and (local.get $arg1) (i32.const 0x4)) (i32.const 0))))
    (global.set $eax (i32.const 0))  ;; DISP_CHANGE_SUCCESSFUL
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; EnumDisplaySettingsA(lpszDeviceName, iModeNum, lpDevMode) — 3 args stdcall.
  ;; ENUM_CURRENT_SETTINGS (-1) reports the host canvas at 32bpp. iModeNum >= 0
  ;; walks the *same* mode table IDirectDraw::EnumDisplayModes enumerates —
  ;; `$enum_mode_res_w` / `$enum_mode_res_h` / `$enum_mode_raw_bpp` in
  ;; `09a8-handlers-directx.wat`, reached through the dense index there, since a
  ;; caller of this API loops until FALSE and a hole would truncate the list.
  ;; There is deliberately no second copy of the resolutions here: two lists
  ;; drift, and a display an app can set through one API but not find through
  ;; the other is exactly the failure that produces.
  ;; dmFields bits: PELSWIDTH=0x80000, PELSHEIGHT=0x100000, BITSPERPEL=0x40000, DISPLAYFREQUENCY=0x400000.
  (func $handle_EnumDisplaySettingsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $screen i32) (local $size i32)
    (local $legacy i32) (local $w i32) (local $h i32) (local $bpp i32) (local $raw i32)
    (if (i32.eqz (local.get $arg2))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $buf (call $g2w (local.get $arg2)))
    (local.set $size (i32.load16_u offset=36 (local.get $buf)))
    ;; Win9x accepts a zero-initialized DEVMODE. Compact intros including PTCT
    ;; depend on that leniency while still walking the complete mode list.
    ;; An unset stack structure can contain a return address in dmSize rather
    ;; than literal zero.  No Win32 DEVMODEA layout exceeds 220 bytes, so treat
    ;; larger values as the same undeclared legacy buffer instead of clearing
    ;; through adjacent stack locals.
    (local.set $legacy
      (i32.or (i32.eqz (local.get $size))
              (i32.gt_u (local.get $size) (i32.const 220))))
    (if (local.get $legacy)
      (then (local.set $size (i32.const 156))))
    (if (i32.eq (local.get $arg1) (i32.const -1))
      (then
        (local.set $screen (call $host_get_screen_size))
        (local.set $w (i32.and (local.get $screen) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $screen) (i32.const 16)))
        (local.set $bpp (i32.const 32)))
      (else
        ;; Any other negative index (ENUM_REGISTRY_SETTINGS, -2) is unsigned-large
        ;; here and ends the enumeration, as it did before.
        (if (i32.ge_u (local.get $arg1) (call $enum_mode_dense_count))
          (then (global.set $eax (i32.const 0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
        (local.set $raw (call $enum_mode_dense_to_raw (local.get $arg1)))
        (local.set $w (call $enum_mode_res_w (i32.div_u (local.get $raw) (i32.const 3))))
        (local.set $h (call $enum_mode_res_h (i32.div_u (local.get $raw) (i32.const 3))))
        (local.set $bpp (call $enum_mode_raw_bpp (local.get $raw)))))
    ;; Windows accepts the 124-byte Win95 DEVMODEA as well as today's
    ;; 156-byte layout. All display fields we return fit in that old prefix.
    (if (i32.lt_u (local.get $size) (i32.const 124))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; A zero-size legacy buffer has no declared extent.  Populate only the
    ;; display fields below; clearing a guessed 156 bytes can overwrite the
    ;; caller's stack immediately past its shorter Win95-era structure.
    (if (i32.eqz (local.get $legacy))
      (then
        (memory.fill (local.get $buf) (i32.const 0)
          (select (local.get $size) (i32.const 156)
            (i32.lt_u (local.get $size) (i32.const 156))))))
    ;; Keep zero as the caller's compatibility marker across an enumeration
    ;; loop; promoting it in the output would turn the second call into the
    ;; modern multi-row contract and overflow old intros' one-entry storage.
    (i32.store16 offset=36 (local.get $buf)
      (select (i32.const 0) (local.get $size) (local.get $legacy)))
    (i32.store offset=40 (local.get $buf) (i32.const 0x5C0000))  ;; dmFields
    (i32.store offset=104 (local.get $buf) (local.get $bpp))     ;; dmBitsPerPel
    (i32.store offset=108 (local.get $buf) (local.get $w))       ;; dmPelsWidth
    (i32.store offset=112 (local.get $buf) (local.get $h))       ;; dmPelsHeight
    (i32.store offset=120 (local.get $buf) (i32.const 60))       ;; dmDisplayFrequency
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; EnumDisplaySettingsW has the same enumeration policy as the ANSI API — the
  ;; same shared mode table, the same dense index — but the 32-WCHAR device name
  ;; moves DEVMODEW's display fields 32 bytes.
  (func $handle_EnumDisplaySettingsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $screen i32) (local $size i32)
    (local $legacy i32) (local $w i32) (local $h i32) (local $bpp i32) (local $raw i32)
    (if (i32.eqz (local.get $arg2))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $buf (call $g2w (local.get $arg2)))
    (local.set $size (i32.load16_u offset=68 (local.get $buf)))
    (local.set $legacy
      (i32.or (i32.eqz (local.get $size))
              (i32.gt_u (local.get $size) (i32.const 220))))
    (if (local.get $legacy)
      (then (local.set $size (i32.const 220))))
    (if (i32.eq (local.get $arg1) (i32.const -1))
      (then
        (local.set $screen (call $host_get_screen_size))
        (local.set $w (i32.and (local.get $screen) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $screen) (i32.const 16)))
        (local.set $bpp (i32.const 32)))
      (else
        (if (i32.ge_u (local.get $arg1) (call $enum_mode_dense_count))
          (then (global.set $eax (i32.const 0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
        (local.set $raw (call $enum_mode_dense_to_raw (local.get $arg1)))
        (local.set $w (call $enum_mode_res_w (i32.div_u (local.get $raw) (i32.const 3))))
        (local.set $h (call $enum_mode_res_h (i32.div_u (local.get $raw) (i32.const 3))))
        (local.set $bpp (call $enum_mode_raw_bpp (local.get $raw)))))
    ;; The Win95 DEVMODEW prefix is 156 bytes; later versions grew to 188
    ;; and 220 bytes. The current-mode fields exist in every one of them.
    (if (i32.lt_u (local.get $size) (i32.const 156))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eqz (local.get $legacy))
      (then
        (memory.fill (local.get $buf) (i32.const 0)
          (select (local.get $size) (i32.const 220)
            (i32.lt_u (local.get $size) (i32.const 220))))))
    (i32.store16 offset=68 (local.get $buf)
      (select (i32.const 0) (local.get $size) (local.get $legacy)))
    (i32.store offset=72 (local.get $buf) (i32.const 0x5C0000)) ;; dmFields
    (i32.store offset=136 (local.get $buf) (local.get $bpp))    ;; dmBitsPerPel
    (i32.store offset=140 (local.get $buf) (local.get $w))      ;; dmPelsWidth
    (i32.store offset=144 (local.get $buf) (local.get $h))      ;; dmPelsHeight
    (i32.store offset=152 (local.get $buf) (i32.const 60))      ;; dmDisplayFrequency
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; EnumDisplayDevicesW(lpDevice, iDevNum, lpDisplayDevice, dwFlags).
  ;; Expose the fixed host surface as one primary desktop adapter and one
  ;; active monitor. DISPLAY_DEVICEW is 0x348 bytes on 32-bit Windows:
  ;; cb, DeviceName[32], DeviceString[128], StateFlags, DeviceID[128],
  ;; DeviceKey[128]. SDL2 uses both enumeration levels during video startup.
  (func $handle_EnumDisplayDevicesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32)
    (if (i32.or
          (i32.ne (local.get $arg1) (i32.const 0))
          (i32.eqz (local.get $arg2)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $dst (call $g2w (local.get $arg2)))
    (if (i32.lt_u (i32.load (local.get $dst)) (i32.const 0x348))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (memory.fill (local.get $dst) (i32.const 0) (i32.const 0x348))
    (i32.store (local.get $dst) (i32.const 0x348))
    (if (i32.eqz (local.get $arg0))
      (then
        ;; DeviceName = L"\\\\.\\DISPLAY1"
        (i32.store offset=4  (local.get $dst) (i32.const 0x005c005c))
        (i32.store offset=8  (local.get $dst) (i32.const 0x005c002e))
        (i32.store offset=12 (local.get $dst) (i32.const 0x00490044))
        (i32.store offset=16 (local.get $dst) (i32.const 0x00500053))
        (i32.store offset=20 (local.get $dst) (i32.const 0x0041004c))
        (i32.store offset=24 (local.get $dst) (i32.const 0x00310059))
        ;; DeviceString = L"Wine-Assembly Display"
        (i32.store offset=68  (local.get $dst) (i32.const 0x00690057))
        (i32.store offset=72  (local.get $dst) (i32.const 0x0065006e))
        (i32.store offset=76  (local.get $dst) (i32.const 0x0041002d))
        (i32.store offset=80  (local.get $dst) (i32.const 0x00730073))
        (i32.store offset=84  (local.get $dst) (i32.const 0x006d0065))
        (i32.store offset=88  (local.get $dst) (i32.const 0x006c0062))
        (i32.store offset=92  (local.get $dst) (i32.const 0x00200079))
        (i32.store offset=96  (local.get $dst) (i32.const 0x00690044))
        (i32.store offset=100 (local.get $dst) (i32.const 0x00700073))
        (i32.store offset=104 (local.get $dst) (i32.const 0x0061006c))
        (i32.store offset=108 (local.get $dst) (i32.const 0x00000079))
        ;; DISPLAY_DEVICE_ATTACHED_TO_DESKTOP | PRIMARY_DEVICE.
        (i32.store offset=324 (local.get $dst) (i32.const 0x5)))
      (else
        ;; DeviceName = L"\\\\.\\DISPLAY1\\Monitor0"
        (i32.store offset=4  (local.get $dst) (i32.const 0x005c005c))
        (i32.store offset=8  (local.get $dst) (i32.const 0x005c002e))
        (i32.store offset=12 (local.get $dst) (i32.const 0x00490044))
        (i32.store offset=16 (local.get $dst) (i32.const 0x00500053))
        (i32.store offset=20 (local.get $dst) (i32.const 0x0041004c))
        (i32.store offset=24 (local.get $dst) (i32.const 0x00310059))
        (i32.store offset=28 (local.get $dst) (i32.const 0x004d005c))
        (i32.store offset=32 (local.get $dst) (i32.const 0x006e006f))
        (i32.store offset=36 (local.get $dst) (i32.const 0x00740069))
        (i32.store offset=40 (local.get $dst) (i32.const 0x0072006f))
        (i32.store offset=44 (local.get $dst) (i32.const 0x00000030))
        ;; DeviceString = L"Default Monitor"
        (i32.store offset=68 (local.get $dst) (i32.const 0x00650044))
        (i32.store offset=72 (local.get $dst) (i32.const 0x00610066))
        (i32.store offset=76 (local.get $dst) (i32.const 0x006c0075))
        (i32.store offset=80 (local.get $dst) (i32.const 0x00200074))
        (i32.store offset=84 (local.get $dst) (i32.const 0x006f004d))
        (i32.store offset=88 (local.get $dst) (i32.const 0x0069006e))
        (i32.store offset=92 (local.get $dst) (i32.const 0x006f0074))
        (i32.store offset=96 (local.get $dst) (i32.const 0x00000072))
        ;; DISPLAY_DEVICE_ACTIVE (same bit value as ATTACHED_TO_DESKTOP).
        (i32.store offset=324 (local.get $dst) (i32.const 0x1))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 757: waveOutGetNumDevs() — return 1 (one audio device available)
  (func $handle_waveOutGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; 1 device
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; midiOutGetNumDevs() — 0 args, return 1 (one MIDI device)
  (func $handle_midiOutGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_midi_num_devs))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; auxGetNumDevs() — 0 args. Report zero aux devices (no line-in/CD volume).
  (func $handle_auxGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; auxGetDevCapsA(uDeviceID, lpCaps, cbCaps) — 3 args. MMSYSERR_BADDEVICEID (2).
  (func $handle_auxGetDevCapsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))  ;; MMSYSERR_BADDEVICEID — consistent with NumDevs=0
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; auxGetVolume(uDeviceID, lpdwVolume) — 2 args. Write 0 volume, return NOERROR.
  ;; (MCM probes device 0 even after NumDevs=0; silent success keeps it moving.)
  (func $handle_auxGetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; auxSetVolume(uDeviceID, dwVolume) — 2 args. No-op, return NOERROR.
  (func $handle_auxSetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; auxOutMessage(uDeviceID, uMsg, dw1, dw2) — 4 args. No-op, return NOERROR.
  (func $handle_auxOutMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; midiOutGetDevCapsA(uDeviceID, lpMidiOutCaps, cbMidiOutCaps) — 3 args
  ;; Fill MIDIOUTCAPSA struct with basic info, return MMSYSERR_NOERROR (0)
  (func $handle_midiOutGetDevCapsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $caps i32)
    (local $n i32)
    (local.set $n (call $host_midi_num_devs))
    (if (i32.or
          (i32.eqz (local.get $arg1))
          (i32.and
            (i32.ne (local.get $arg0) (i32.const -1))
            (i32.ge_u (local.get $arg0) (local.get $n))))
      (then
        (global.set $eax (i32.const 2)) ;; MMSYSERR_BADDEVICEID
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $caps (call $g2w (local.get $arg1)))
    ;; Zero out the struct
    (memory.fill (local.get $caps) (i32.const 0) (local.get $arg2))
    ;; wMid (manufacturer ID) = 1 (MM_MICROSOFT)
    (i32.store16 (local.get $caps) (i32.const 1))
    ;; wPid = 1
    (i32.store16 (i32.add (local.get $caps) (i32.const 2)) (i32.const 1))
    ;; wTechnology at offset 40 = MOD_MIDIPORT (1)
    ;; (szPname[MAXPNAMELEN=32] runs from +8 through +39)
    (i32.store16 (i32.add (local.get $caps) (i32.const 40)) (i32.const 1))
    ;; dwSupport at offset 48 = 0
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; midiOutOpen(lphmo, uDeviceID, dwCallback, dwCallbackInstance, dwFlags) — 5 args
  (func $handle_midiOutOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hmo i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 11)) ;; MMSYSERR_INVALPARAM
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (local.set $hmo (call $host_midi_out_open
      (local.get $arg1)
      (local.get $arg2)
      (local.get $arg3)
      (local.get $arg4)))
    (if (i32.eqz (local.get $hmo))
      (then
        (global.set $eax (i32.const 2)) ;; MMSYSERR_BADDEVICEID
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (if (local.get $arg0)
      (then (call $gs32 (local.get $arg0) (local.get $hmo))))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; midiOutClose(hmo) — 1 arg
  (func $handle_midiOutClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_midi_out_close (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; midiOutShortMsg(hmo, dwMsg) — 2 args
  (func $handle_midiOutShortMsg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_midi_out_short_msg (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; midiOutLongMsg(hmo, lpMidiHdr, cbMidiHdr) — submit a system-exclusive
  ;; message. The browser synth consumes channel messages through ShortMsg but
  ;; has no SysEx transport, so complete a correctly prepared MIDIHDR
  ;; immediately. Clients such as ScummVM use this for GM/MT-32 reset packets
  ;; and then continue ordinary note traffic through midiOutShortMsg.
  (func $handle_midiOutLongMsg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hdr i32) (local $flags i32)
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const 11)) ;; MMSYSERR_INVALPARAM
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $hdr (call $g2w (local.get $arg1)))
    (local.set $flags (i32.load offset=16 (local.get $hdr)))
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 2))) ;; MHDR_PREPARED
      (then
        (global.set $eax (i32.const 64)) ;; MIDIERR_UNPREPARED
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; Immediate completion: retain PREPARED/other flags, clear INQUEUE, set DONE.
    (i32.store offset=16 (local.get $hdr)
      (i32.or (i32.and (local.get $flags) (i32.const 0xffffffef)) (i32.const 1)))
    (global.set $eax (i32.const 0)) ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; midiOutReset(hmo) — 1 arg
  (func $handle_midiOutReset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_midi_out_reset (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; midiOutGetVolume(hmo, lpdwVolume) — 2 args; report max volume both channels
  (func $handle_midiOutGetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const 11)) ;; MMSYSERR_INVALPARAM
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (global.set $eax (call $host_midi_out_get_volume (local.get $arg0) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; midiOutSetVolume(hmo, dwVolume) — 2 args; accept silently
  (func $handle_midiOutSetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_midi_out_set_volume (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; MIDI streaming uses the same host synth handles as midiOut*. Old WinMM
  ;; clients submit arrays of MIDIEVENT records through MIDIHDR buffers. Keep
  ;; the small stream queue on the guest heap instead of stealing a fixed
  ;; low-memory address (0xD170 is the first SCROLL_TABLE record).
  (global $midi_stream_handle (mut i32) (i32.const 0))
  (global $midi_stream_tempo (mut i32) (i32.const 500000))
  (global $midi_stream_division (mut i32) (i32.const 480))
  (global $midi_stream_queue_wa (mut i32) (i32.const 0))
  (global $midi_stream_queue_head (mut i32) (i32.const 0))
  (global $midi_stream_queue_tail (mut i32) (i32.const 0))
  (global $midi_stream_running (mut i32) (i32.const 0))
  (global $midi_stream_due_ms (mut i32) (i32.const 0))
  (global $midi_stream_event_pending (mut i32) (i32.const 0))
  (global $midi_stream_paused_at (mut i32) (i32.const 0))

  ;; Advance queued MIDIEVENTs up to `now`. timeGetTime calls this once per
  ;; game frame, preserving delta-time/tempo ordering without blocking WAT or
  ;; dumping an entire song into the synth at midiStreamOut time.
  (func $midi_stream_service (param $now i32)
    (local $entry i32) (local $hdr i32) (local $data i32)
    (local $length i32) (local $pos i32) (local $event_ptr i32)
    (local $delta i32) (local $event i32) (local $event_type i32)
    (local $long_len i32) (local $delay i32) (local $processed i32)
    (if (i32.or
          (i32.eqz (global.get $midi_stream_running))
          (i32.eq (global.get $midi_stream_queue_head) (global.get $midi_stream_queue_tail)))
      (then (return)))
    (if (i32.eqz (global.get $midi_stream_due_ms))
      (then (global.set $midi_stream_due_ms (local.get $now))))
    (block $done
      (loop $events
        ;; A long run of zero-delta controller events must yield back to the
        ;; guest periodically; the next timeGetTime continues immediately.
        (br_if $done (i32.ge_u (local.get $processed) (i32.const 128)))
        (br_if $done
          (i32.eq (global.get $midi_stream_queue_head) (global.get $midi_stream_queue_tail)))
        (local.set $entry (i32.add (global.get $midi_stream_queue_wa)
          (i32.shl (global.get $midi_stream_queue_head) (i32.const 3))))
        (local.set $hdr (i32.load (local.get $entry)))
        (local.set $pos (i32.load offset=4 (local.get $entry)))
        (local.set $data (call $g2w (i32.load (local.get $hdr))))
        (local.set $length (i32.load offset=8 (local.get $hdr)))
        (if (i32.eqz (local.get $length))
          (then (local.set $length (i32.load offset=4 (local.get $hdr)))))
        (if (i32.gt_u (i32.add (local.get $pos) (i32.const 12)) (local.get $length))
          (then
            ;; MHDR_DONE and no longer MHDR_INQUEUE.
            (i32.store offset=16 (local.get $hdr)
              (i32.and
                (i32.or (i32.load offset=16 (local.get $hdr)) (i32.const 1))
                (i32.const 0xFFFFFFEF)))
            (global.set $midi_stream_queue_head
              (i32.and (i32.add (global.get $midi_stream_queue_head) (i32.const 1)) (i32.const 31)))
            (global.set $midi_stream_event_pending (i32.const 0))
            (br $events)))
        (local.set $event_ptr (i32.add (local.get $data) (local.get $pos)))
        (local.set $delta (i32.load (local.get $event_ptr)))
        (local.set $event (i32.load offset=8 (local.get $event_ptr)))
        (if (i32.eqz (global.get $midi_stream_event_pending))
          (then
            ;; milliseconds = ticks * microseconds/quarter / (division * 1000)
            (local.set $delay (i32.wrap_i64 (i64.div_u
              (i64.mul
                (i64.extend_i32_u (local.get $delta))
                (i64.extend_i32_u (global.get $midi_stream_tempo)))
              (i64.extend_i32_u
                (i32.mul (global.get $midi_stream_division) (i32.const 1000))))))
            (global.set $midi_stream_due_ms
              (i32.add (global.get $midi_stream_due_ms) (local.get $delay)))
            (global.set $midi_stream_event_pending (i32.const 1))))
        (br_if $done (i32.gt_u (global.get $midi_stream_due_ms) (local.get $now)))
        ;; The callback flag occupies bit 30; it is not part of MEVT_EVENTTYPE.
        (local.set $event_type
          (i32.and (i32.shr_u (local.get $event) (i32.const 24)) (i32.const 0x3F)))
        (if (i32.eqz (local.get $event_type))
          (then (drop (call $host_midi_out_short_msg
            (global.get $midi_stream_handle)
            (i32.and (local.get $event) (i32.const 0x00FFFFFF)))))
          (else (if (i32.eq (local.get $event_type) (i32.const 1)) ;; MEVT_TEMPO
            (then
              (local.set $delay (i32.and (local.get $event) (i32.const 0x00FFFFFF)))
              (if (local.get $delay)
                (then (global.set $midi_stream_tempo (local.get $delay))))))))
        (local.set $pos (i32.add (local.get $pos) (i32.const 12)))
        (if (i32.and (local.get $event) (i32.const 0x80000000))
          (then
            (local.set $long_len (i32.and (local.get $event) (i32.const 0x00FFFFFF)))
            (local.set $pos (i32.add (local.get $pos)
              (i32.and (i32.add (local.get $long_len) (i32.const 3)) (i32.const 0xFFFFFFFC))))))
        (i32.store offset=4 (local.get $entry) (local.get $pos))
        (global.set $midi_stream_event_pending (i32.const 0))
        (local.set $processed (i32.add (local.get $processed) (i32.const 1)))
        (br $events)))
  )

  (func $handle_midiStreamOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $flags i32) (local $device i32) (local $handle i32)
    ;; arg5=fdwOpen is the sixth stack argument.
    (local.set $flags (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const 11)) ;; MMSYSERR_INVALPARAM
        (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
        (return)))
    (local.set $device (call $gl32 (local.get $arg1)))
    (local.set $handle (call $host_midi_out_open
      (local.get $device) (local.get $arg3) (local.get $arg4) (local.get $flags)))
    (if (i32.eqz (local.get $handle))
      (then (global.set $eax (i32.const 2))) ;; MMSYSERR_BADDEVICEID
      (else
        (call $gs32 (local.get $arg0) (local.get $handle))
        ;; One process-local stream is sufficient for the Win98-era clients
        ;; supported here. Queue 32 header pointers (31 usable ring slots).
        (if (i32.eqz (global.get $midi_stream_queue_wa))
          (then
            (global.set $midi_stream_queue_wa
              (call $g2w (call $heap_alloc (i32.const 256))))
            (call $zero_memory (global.get $midi_stream_queue_wa) (i32.const 256))))
        (global.set $midi_stream_handle (local.get $handle))
        (global.set $midi_stream_tempo (i32.const 500000)) ;; 120 BPM
        (global.set $midi_stream_division (i32.const 480))
        (global.set $midi_stream_queue_head (i32.const 0))
        (global.set $midi_stream_queue_tail (i32.const 0))
        (global.set $midi_stream_running (i32.const 0))
        (global.set $midi_stream_due_ms (i32.const 0))
        (global.set $midi_stream_event_pending (i32.const 0))
        (global.set $midi_stream_paused_at (i32.const 0))
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  (func $handle_midiStreamClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_midi_out_close (local.get $arg0)))
    (if (i32.eq (local.get $arg0) (global.get $midi_stream_handle))
      (then
        (global.set $midi_stream_handle (i32.const 0))
        (global.set $midi_stream_running (i32.const 0))
        (global.set $midi_stream_queue_head (i32.const 0))
        (global.set $midi_stream_queue_tail (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_midiStreamPause (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (local.get $arg0) (global.get $midi_stream_handle))
      (then
        (global.set $midi_stream_running (i32.const 0))
        (global.set $midi_stream_paused_at (call $host_get_ticks))
        (drop (call $host_midi_out_reset (local.get $arg0)))
        (global.set $eax (i32.const 0)))
      (else (global.set $eax (i32.const 5)))) ;; MMSYSERR_INVALHANDLE
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_midiStreamRestart (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $now i32)
    (if (i32.eq (local.get $arg0) (global.get $midi_stream_handle))
      (then
        (local.set $now (call $host_get_ticks))
        (if (global.get $midi_stream_paused_at)
          (then
            (global.set $midi_stream_due_ms
              (i32.add (global.get $midi_stream_due_ms)
                (i32.sub (local.get $now) (global.get $midi_stream_paused_at))))
            (global.set $midi_stream_paused_at (i32.const 0)))
          (else (if (i32.eqz (global.get $midi_stream_due_ms))
            (then (global.set $midi_stream_due_ms (local.get $now))))))
        (global.set $midi_stream_running (i32.const 1))
        (global.set $eax (i32.const 0)))
      (else (global.set $eax (i32.const 5))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; midiStreamProperty(hms, lppropdata, dwProperty). Support the tempo and
  ;; time-division GET/SET properties used by standard MIDI stream players.
  (func $handle_midiStreamProperty (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $prop i32) (local $slot i32)
    (if (i32.or
          (i32.ne (local.get $arg0) (global.get $midi_stream_handle))
          (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const 5))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $prop (call $g2w (local.get $arg1)))
    (if (i32.and (local.get $arg2) (i32.const 1))
      (then (local.set $slot (i32.const 1)))
      (else (if (i32.and (local.get $arg2) (i32.const 2))
        (then (local.set $slot (i32.const 2)))
        (else
          (global.set $eax (i32.const 11))
          (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
          (return)))))
    (if (i32.and (local.get $arg2) (i32.const 0x80000000)) ;; MIDIPROP_SET
      (then
        (if (i32.eq (local.get $slot) (i32.const 1))
          (then (global.set $midi_stream_division (i32.load offset=4 (local.get $prop))))
          (else (global.set $midi_stream_tempo (i32.load offset=4 (local.get $prop))))))
      (else (if (i32.and (local.get $arg2) (i32.const 0x40000000)) ;; GET
        (then
          (if (i32.eq (local.get $slot) (i32.const 1))
            (then (i32.store offset=4 (local.get $prop) (global.get $midi_stream_division)))
            (else (i32.store offset=4 (local.get $prop) (global.get $midi_stream_tempo))))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_midiOutPrepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hdr i32)
    (if (i32.eqz (local.get $arg1))
      (then (global.set $eax (i32.const 11)))
      (else
        (local.set $hdr (call $g2w (local.get $arg1)))
        (i32.store offset=16 (local.get $hdr)
          (i32.or (i32.load offset=16 (local.get $hdr)) (i32.const 2)))
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_midiOutUnprepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hdr i32)
    (if (i32.eqz (local.get $arg1))
      (then (global.set $eax (i32.const 11)))
      (else
        (local.set $hdr (call $g2w (local.get $arg1)))
        (if (i32.and (i32.load offset=16 (local.get $hdr)) (i32.const 0x10))
          (then (global.set $eax (i32.const 65))) ;; MIDIERR_STILLPLAYING
          (else
            (i32.store offset=16 (local.get $hdr)
              (i32.and
                (i32.or (i32.load offset=16 (local.get $hdr)) (i32.const 1))
                (i32.const 0xFFFFFFFD))) ;; clear PREPARED
            (global.set $eax (i32.const 0))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; midiStreamOut(hms, lpMidiHdr, cbMidiHdr). Queue prepared MIDIHDRs; the
  ;; timeGetTime service above consumes their MIDIEVENT records at real tempo.
  (func $handle_midiStreamOut (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hdr i32) (local $next i32) (local $entry i32)
    (if (i32.or
          (i32.ne (local.get $arg0) (global.get $midi_stream_handle))
          (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const 5))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $hdr (call $g2w (local.get $arg1)))
    (if (i32.eqz (i32.and (i32.load offset=16 (local.get $hdr)) (i32.const 2)))
      (then
        (global.set $eax (i32.const 64)) ;; MIDIERR_UNPREPARED
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $next
      (i32.and (i32.add (global.get $midi_stream_queue_tail) (i32.const 1)) (i32.const 31)))
    (if (i32.eq (local.get $next) (global.get $midi_stream_queue_head))
      (then
        (global.set $eax (i32.const 4)) ;; MMSYSERR_ALLOCATED / queue full
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $entry (i32.add (global.get $midi_stream_queue_wa)
      (i32.shl (global.get $midi_stream_queue_tail) (i32.const 3))))
    (i32.store (local.get $entry) (local.get $hdr))
    (i32.store offset=4 (local.get $entry) (i32.const 0))
    (global.set $midi_stream_queue_tail (local.get $next))
    ;; Clear DONE and set INQUEUE while the service owns this header.
    (i32.store offset=16 (local.get $hdr)
      (i32.or
        (i32.and (i32.load offset=16 (local.get $hdr)) (i32.const 0xFFFFFFFE))
        (i32.const 0x10)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; joyGetPos(uJoyID, lpInfo) — 2 args, return JOYERR_UNPLUGGED (167)
  (func $handle_joyGetPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 167))  ;; JOYERR_UNPLUGGED
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; joyGetPosEx(uJoyID, lpInfo) — same no-joystick result as joyGetPos.
  (func $handle_joyGetPosEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 167))  ;; JOYERR_UNPLUGGED
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; joyGetNumDevs() — 0 args, return 0 (no joysticks)
  (func $handle_joyGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; joyGetDevCapsA(uJoyID, lpCaps, cbCaps) — no joystick driver installed.
  ;; Returning MMSYSERR_NODRIVER lets legacy games retain keyboard/mouse input.
  (func $handle_joyGetDevCapsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 6))  ;; MMSYSERR_NODRIVER
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; joySetCapture(hwnd, uJoyID, period, changed) — 4 args.
  (func $handle_joySetCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 167))  ;; JOYERR_UNPLUGGED
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; joyReleaseCapture(uJoyID) is harmless when no capture exists.
  (func $handle_joyReleaseCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; SetProcessWorkingSetSize(hProcess, min, max) — fixed WASM memory cannot
  ;; be trimmed by the host OS, so accept the advisory request as a no-op.
  (func $handle_SetProcessWorkingSetSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; TRUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; GetProcessWorkingSetSize(hProcess, *min, *max) — report the fixed guest
  ;; address-space budget. The values are advisory; callers such as Unreal 1
  ;; only use them for startup diagnostics before requesting their own limits.
  (func $handle_GetProcessWorkingSetSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (i32.store (call $g2w (local.get $arg1)) (i32.const 0x00100000))))
    (if (local.get $arg2)
      (then (i32.store (call $g2w (local.get $arg2)) (i32.const 0x10000000))))
    (global.set $eax (i32.const 1))  ;; TRUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 853: waveInOpen(lphWaveIn, device, format, callback, instance, flags)
  (func $handle_waveInOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $fmt_wa i32) (local $rate i32) (local $ch i32) (local $bits i32)
    (local $flags i32) (local $cbType i32) (local $handle i32)
    (local.set $flags (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    ;; WAVE_FORMAT_QUERY validates only and must not acquire microphone access.
    (if (i32.and (local.get $flags) (i32.const 1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
        (return)))
    (local.set $fmt_wa (call $g2w (local.get $arg2)))
    (local.set $rate (i32.load offset=4 (local.get $fmt_wa)))
    (local.set $ch (i32.load16_u offset=2 (local.get $fmt_wa)))
    (local.set $bits (i32.load16_u offset=14 (local.get $fmt_wa)))
    (local.set $cbType (i32.and (i32.shr_u (local.get $flags) (i32.const 16)) (i32.const 7)))
    (local.set $handle (call $host_wave_in_open
      (local.get $rate) (local.get $ch) (local.get $bits)
      (local.get $arg3) (local.get $arg4) (local.get $cbType)))
    (if (local.get $arg0)
      (then (call $gs32 (local.get $arg0) (local.get $handle))))
    (if (i32.eq (local.get $cbType) (i32.const 1))
      (then
        (drop (call $post_queue_push
          (local.get $arg3) (i32.const 0x03BE) (local.get $handle) (i32.const 0)))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; 854: waveInClose
  (func $handle_waveInClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_wave_in_close (local.get $arg0)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 855: waveInStart
  (func $handle_waveInStart (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_wave_in_start (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 856: waveInStop
  (func $handle_waveInStop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_wave_in_stop (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 857: waveInReset
  (func $handle_waveInReset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_wave_in_reset (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 858: waveInPrepareHeader — set WHDR_PREPARED
  (func $handle_waveInPrepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store offset=16 (local.get $wa)
      (i32.or (i32.load offset=16 (local.get $wa)) (i32.const 2)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 859: waveInUnprepareHeader — clear PREPARED/INQUEUE, retain DONE
  (func $handle_waveInUnprepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store offset=16 (local.get $wa)
      (i32.and (i32.load offset=16 (local.get $wa)) (i32.const 0xFFFFFFED)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 860: waveInAddBuffer — queue the guest WAVEHDR for capture
  (func $handle_waveInAddBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $data_ga i32) (local $length i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (local.set $data_ga (i32.load (local.get $wa)))
    (local.set $length (i32.load offset=4 (local.get $wa)))
    (i32.store offset=8 (local.get $wa) (i32.const 0))
    (i32.store offset=16 (local.get $wa)
      (i32.or
        (i32.and (i32.load offset=16 (local.get $wa)) (i32.const 0xFFFFFFFE))
        (i32.const 0x12))) ;; PREPARED | INQUEUE
    (global.set $eax (call $host_wave_in_add_buffer
      (local.get $arg0) (local.get $wa) (local.get $arg1)
      (call $g2w (local.get $data_ga)) (local.get $length)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 861: waveInGetNumDevs — return 1 (one input device)
  (func $handle_waveInGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; waveInGetDevCaps{A,W}(uDeviceID, lpCaps, cbCaps). The capture backend
  ;; exposes one stereo PCM device, matching waveInGetNumDevs/waveInOpen.
  ;; WAVEINCAPS differs only in the width of szPname[32]: its dwFormats and
  ;; wChannels fields begin at 40/44 (A) and 72/76 (W), respectively.
  (func $wave_in_dev_caps (param $device i32) (param $caps_g i32) (param $cb i32) (param $wide i32) (result i32)
    (local $wa i32) (local $stride i32) (local $tail i32) (local $size i32)
    (if (local.get $device)
      (then (return (i32.const 2)))) ;; MMSYSERR_BADDEVICEID
    (local.set $size (select (i32.const 80) (i32.const 48) (local.get $wide)))
    (if (i32.or (i32.eqz (local.get $caps_g))
                (i32.lt_u (local.get $cb) (local.get $size)))
      (then (return (i32.const 11)))) ;; MMSYSERR_INVALPARAM
    (local.set $wa (call $g2w (local.get $caps_g)))
    (call $zero_memory (local.get $wa) (local.get $size))
    (i32.store16 (local.get $wa) (i32.const 1))      ;; wMid
    (i32.store16 offset=2 (local.get $wa) (i32.const 1)) ;; wPid
    (i32.store offset=4 (local.get $wa) (i32.const 0x0400))
    (local.set $stride (select (i32.const 2) (i32.const 1) (local.get $wide)))
    ;; szPname = "Microphone"
    (call $store_char (i32.add (local.get $caps_g) (i32.const 8)) (i32.const 0x4D) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (local.get $stride))) (i32.const 0x69) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $stride) (i32.const 2)))) (i32.const 0x63) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $stride) (i32.const 3)))) (i32.const 0x72) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $stride) (i32.const 4)))) (i32.const 0x6F) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $stride) (i32.const 5)))) (i32.const 0x70) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $stride) (i32.const 6)))) (i32.const 0x68) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $stride) (i32.const 7)))) (i32.const 0x6F) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $stride) (i32.const 8)))) (i32.const 0x6E) (local.get $wide))
    (call $store_char (i32.add (local.get $caps_g) (i32.add (i32.const 8) (i32.mul (local.get $stride) (i32.const 9)))) (i32.const 0x65) (local.get $wide))
    (local.set $tail (i32.add (local.get $wa)
      (select (i32.const 72) (i32.const 40) (local.get $wide))))
    (i32.store (local.get $tail) (i32.const 0x00000FFF)) ;; common PCM formats
    (i32.store16 offset=4 (local.get $tail) (i32.const 2)) ;; stereo
    (i32.const 0))

  (func $handle_waveInGetDevCapsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wave_in_dev_caps
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_waveInGetDevCapsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wave_in_dev_caps
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 1246: timeSetEvent(uDelay, uResolution, lpTimeProc, dwUser, fuEvent)
  ;; Returns timer ID (non-zero) on success, 0 on error
  (func $handle_timeSetEvent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tid i32) (local $i i32) (local $slot i32)
    ;; Take the first free slot. Windows lets a client hold several timers at
    ;; once and Smacker relies on it (periodic mixer + one-shot per buffer),
    ;; so evicting an existing timer here would silently kill a live one.
    (block $found (loop $scan
      (if (i32.ge_u (local.get $i) (global.get $MM_TIMER_MAX))
        (then
          ;; Out of slots — TIMERR_NOCANDO, reported as a 0 timer id.
          (global.set $eax (i32.const 0))
          (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
          (return)))
      (local.set $slot (call $mm_timer_slot (local.get $i)))
      (br_if $found (i32.eqz (i32.load (local.get $slot))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.set $tid (i32.load (global.get $MM_TIMER_NEXT_ID)))
    (if (i32.eqz (local.get $tid)) (then (local.set $tid (i32.const 1))))
    (i32.store (global.get $MM_TIMER_NEXT_ID) (i32.add (local.get $tid) (i32.const 1)))
    (i32.store          (local.get $slot) (local.get $tid))
    (i32.store offset=4 (local.get $slot) (local.get $arg0))
    (i32.store offset=8 (local.get $slot) (local.get $arg2))
    (i32.store offset=12 (local.get $slot) (local.get $arg3))
    (i32.store offset=16 (local.get $slot) (call $host_get_ticks))
    (i32.store offset=20 (local.get $slot)
      (i32.eqz (i32.and (local.get $arg4) (i32.const 1))))
    (global.set $eax (local.get $tid))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 1247: timeKillEvent(uTimerID)
  ;; Returns TIMERR_NOERROR (0) if found, MMSYSERR_INVALPARAM (11) if not
  (func $handle_timeKillEvent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32)
    (local.set $slot (call $mm_timer_find (local.get $arg0)))
    (if (local.get $slot)
      (then
        (i32.store (local.get $slot) (i32.const 0))
        (global.set $eax (i32.const 0)))
      (else
        (global.set $eax (i32.const 11))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; BASS_Init(device, freq, flags, hwnd, clsid) -> BOOL
  ;; No-op success for games that can run without the bundled BASS mixer.
  (func $handle_BASS_Init (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; BASS_PluginLoad(file, flags) -> HPLUGIN
  ;; No BASS plugin loader is present. Return failure, not an invented handle.
  (func $handle_BASS_PluginLoad (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; BASS_Start() -> BOOL
  (func $handle_BASS_Start (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; BASS_SetConfig(option, value) -> BOOL
  (func $handle_BASS_SetConfig (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; Minimal no-audio BASS shim. Handles are dummy nonzero tokens because many
  ;; games treat a failed load as fatal even when the sound is nonessential.
  (global $BASS_DUMMY_HANDLE i32 (i32.const 0x0BA55001))

  ;; BASS_SampleLoad(filetype, file, offset:QWORD, length, max, flags) -> HSAMPLE
  (func $handle_BASS_SampleLoad (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $BASS_DUMMY_HANDLE))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; BASS_SampleGetChannel(handle, onlynew) -> HCHANNEL
  (func $handle_BASS_SampleGetChannel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $BASS_DUMMY_HANDLE))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; BASS_StreamCreateFile(filetype, file, offset:QWORD, length:QWORD, flags) -> HSTREAM
  (func $handle_BASS_StreamCreateFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $BASS_DUMMY_HANDLE))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; BASS_MusicLoad(filetype, file, offset:QWORD, length, flags, freq) -> HMUSIC
  (func $handle_BASS_MusicLoad (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $BASS_DUMMY_HANDLE))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; BASS_ChannelPlay(handle, restart), BASS_ChannelSetAttribute(handle, attrib, value)
  ;; and BASS_ChannelSetPosition(handle, pos:QWORD, mode) -> BOOL
  (func $handle_BASS_ChannelPlay (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )
  (func $handle_BASS_ChannelSetAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )
  (func $handle_BASS_ChannelSetPosition (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; One-arg BASS free/stop calls -> BOOL.
  (func $handle_BASS_SampleFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )
  (func $handle_BASS_StreamFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )
  (func $handle_BASS_MusicFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )
  (func $handle_BASS_ChannelStop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )
  (func $handle_BASS_ChannelPause (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; BASS_ErrorGetCode() -> 0, BASS_Free() -> BOOL
  (func $handle_BASS_ErrorGetCode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )
  (func $handle_BASS_Free (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )
