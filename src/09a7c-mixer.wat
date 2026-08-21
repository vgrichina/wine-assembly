  ;; ============================================================
  ;; WINMM MIXER HANDLERS
  ;; mixerOpen/Close/GetDevCaps/GetLineInfo/GetLineControls/GetControlDetails and
  ;; their A/W pairs. Audio, filed next to 09a3-handlers-audio.wat's neighbours
  ;; rather than at the end of the dispatch file.
  ;; ============================================================

  ;; WINMM mixer model: speaker master with separate wave and MIDI sources.
  (func $fill_mixer_caps (param $p i32) (param $wide i32) (param $cb i32)
    (if (i32.eqz (local.get $p)) (then (return)))
    (if (local.get $cb)
      (then (call $zero_memory (local.get $p) (local.get $cb)))
      (else
        (if (local.get $wide)
          (then (call $zero_memory (local.get $p) (i32.const 80)))
          (else (call $zero_memory (local.get $p) (i32.const 48))))))
    (i32.store16 (local.get $p) (i32.const 1))                         ;; wMid
    (i32.store16 (i32.add (local.get $p) (i32.const 2)) (i32.const 1))  ;; wPid
    (i32.store (i32.add (local.get $p) (i32.const 4)) (i32.const 0x0400))
    (if (local.get $wide)
      (then
        (i32.store16 (i32.add (local.get $p) (i32.const 8)) (i32.const 0x57))  ;; W
        (i32.store16 (i32.add (local.get $p) (i32.const 10)) (i32.const 0x69)) ;; i
        (i32.store16 (i32.add (local.get $p) (i32.const 12)) (i32.const 0x6e)) ;; n
        (i32.store16 (i32.add (local.get $p) (i32.const 14)) (i32.const 0x65)) ;; e
        (i32.store (i32.add (local.get $p) (i32.const 76)) (i32.const 1)))     ;; cDestinations
      (else
        (i32.store (i32.add (local.get $p) (i32.const 8)) (i32.const 0x656e6957)) ;; Wine
        (i32.store (i32.add (local.get $p) (i32.const 44)) (i32.const 1)))))      ;; cDestinations

  (func $fill_mixer_name (param $short i32) (param $long i32) (param $wide i32) (param $line_id i32)
    (if (local.get $wide)
      (then
        (if (i32.eq (local.get $line_id) (i32.const 1))
          (then
            (i64.store (local.get $short) (i64.const 0x0065007600610057))
            (i64.store (local.get $long) (i64.const 0x0065007600610057))
            (return)))
        (if (i32.eq (local.get $line_id) (i32.const 2))
          (then
            (i64.store (local.get $short) (i64.const 0x004900440049004d))
            (i64.store (local.get $long) (i64.const 0x004900440049004d))
            (return)))
        (i64.store (local.get $short) (i64.const 0x0075006c006f0056))
        (i64.store offset=8 (local.get $short) (i64.const 0x000000000065006d))
        (i64.store (local.get $long) (i64.const 0x0075006c006f0056))
        (i64.store offset=8 (local.get $long) (i64.const 0x004300200065006d))
        (i64.store offset=16 (local.get $long) (i64.const 0x00720074006e006f))
        (i64.store offset=24 (local.get $long) (i64.const 0x00000000006c006f))
        (return)))
    (if (i32.eq (local.get $line_id) (i32.const 1))
      (then
        (i32.store (local.get $short) (i32.const 0x65766157))
        (i32.store (local.get $long) (i32.const 0x65766157))
        (return)))
    (if (i32.eq (local.get $line_id) (i32.const 2))
      (then
        (i32.store (local.get $short) (i32.const 0x4944494d))
        (i32.store (local.get $long) (i32.const 0x4944494d))
        (return)))
    (i32.store (local.get $short) (i32.const 0x756c6f56))
    (i32.store offset=4 (local.get $short) (i32.const 0x0000656d))
    (i64.store (local.get $long) (i64.const 0x4320656d756c6f56))
    (i64.store offset=8 (local.get $long) (i64.const 0x00006c6f72746e6f)))

  (func $fill_mixer_line (param $p i32) (param $wide i32) (param $line_id i32)
    (local $is_source i32) (local $size i32) (local $target i32) (local $component i32)
    (if (i32.eqz (local.get $p)) (then (return)))
    (local.set $is_source (i32.ne (local.get $line_id) (i32.const 0)))
    (local.set $component (i32.const 4))                                ;; DST_SPEAKERS
    (if (i32.eq (local.get $line_id) (i32.const 1))
      (then (local.set $component (i32.const 0x1008))))                 ;; SRC_WAVEOUT
    (if (i32.eq (local.get $line_id) (i32.const 2))
      (then (local.set $component (i32.const 0x1004))))                 ;; SRC_SYNTHESIZER
    (local.set $size (i32.const 168))
    (local.set $target (i32.add (local.get $p) (i32.const 120)))
    (if (local.get $wide)
      (then
        (local.set $size (i32.const 280))
        (local.set $target (i32.add (local.get $p) (i32.const 200)))))
    (call $zero_memory (local.get $p) (local.get $size))
    (i32.store offset=0 (local.get $p) (local.get $size))
    (i32.store offset=4 (local.get $p) (i32.const 0))                   ;; dwDestination
    (if (local.get $is_source)
      (then (i32.store offset=8 (local.get $p) (i32.sub (local.get $line_id) (i32.const 1)))))
    (i32.store offset=12 (local.get $p) (local.get $line_id))           ;; dwLineID
    (if (local.get $is_source)
      (then
        (i32.store offset=16 (local.get $p) (i32.const 0x80000001))      ;; SOURCE|ACTIVE
        (i32.store offset=24 (local.get $p) (local.get $component))
        (i32.store offset=28 (local.get $p) (i32.const 2))               ;; cChannels
        (i32.store offset=36 (local.get $p) (i32.const 3)))              ;; cControls
      (else
        (i32.store offset=16 (local.get $p) (i32.const 1))               ;; ACTIVE
        (i32.store offset=24 (local.get $p) (i32.const 4))               ;; DST_SPEAKERS
        (i32.store offset=28 (local.get $p) (i32.const 2))               ;; cChannels
        (i32.store offset=32 (local.get $p) (i32.const 2))               ;; cConnections
        (i32.store offset=36 (local.get $p) (i32.const 3))))             ;; cControls
    (if (local.get $wide)
      (then (call $fill_mixer_name (i32.add (local.get $p) (i32.const 40)) (i32.add (local.get $p) (i32.const 72)) (i32.const 1) (local.get $line_id)))
      (else (call $fill_mixer_name (i32.add (local.get $p) (i32.const 40)) (i32.add (local.get $p) (i32.const 56)) (i32.const 0) (local.get $line_id))))
    (i32.store offset=0 (local.get $target) (select (i32.const 3) (i32.const 1) (i32.eq (local.get $line_id) (i32.const 2))))
    (i32.store offset=4 (local.get $target) (i32.const 0))               ;; dwDeviceID
    (i32.store16 offset=8 (local.get $target) (i32.const 1))             ;; wMid
    (i32.store16 offset=10 (local.get $target) (i32.const 1))            ;; wPid
    (i32.store offset=12 (local.get $target) (i32.const 0x0400)))        ;; vDriverVersion

  ;; kind: 0=volume, 1=mute, 2=peak meter.
  (func $fill_mixer_control (param $p i32) (param $wide i32) (param $line_id i32) (param $kind i32)
    (local $size i32) (local $bounds i32) (local $metrics i32)
    (if (i32.eqz (local.get $p)) (then (return)))
    (local.set $size (i32.const 148))
    (local.set $bounds (i32.add (local.get $p) (i32.const 100)))
    (local.set $metrics (i32.add (local.get $p) (i32.const 124)))
    (if (local.get $wide)
      (then
        (local.set $size (i32.const 228))
        (local.set $bounds (i32.add (local.get $p) (i32.const 180)))
        (local.set $metrics (i32.add (local.get $p) (i32.const 204)))))
    (call $zero_memory (local.get $p) (local.get $size))
    (i32.store offset=0 (local.get $p) (local.get $size))
    (if (i32.eq (local.get $kind) (i32.const 1))
      (then
        (i32.store offset=4 (local.get $p) (i32.add (i32.const 0x2000) (local.get $line_id)))
        (i32.store offset=8 (local.get $p) (i32.const 0x20010002))       ;; BOOLEAN MUTE
        (i32.store offset=12 (local.get $p) (i32.const 1)))              ;; UNIFORM
      (else
        (if (i32.eq (local.get $kind) (i32.const 2))
          (then
            (i32.store offset=4 (local.get $p) (i32.add (i32.const 0x3000) (local.get $line_id)))
            (i32.store offset=8 (local.get $p) (i32.const 0x10020001))   ;; SIGNED PEAKMETER
            (i32.store offset=12 (local.get $p) (i32.const 1)))          ;; UNIFORM
          (else
            (i32.store offset=4 (local.get $p) (i32.add (i32.const 0x1000) (local.get $line_id)))
            (i32.store offset=8 (local.get $p) (i32.const 0x50030001)))))) ;; UNSIGNED VOLUME
    (if (local.get $wide)
      (then (call $fill_mixer_name (i32.add (local.get $p) (i32.const 20)) (i32.add (local.get $p) (i32.const 52)) (i32.const 1) (local.get $line_id)))
      (else (call $fill_mixer_name (i32.add (local.get $p) (i32.const 20)) (i32.add (local.get $p) (i32.const 36)) (i32.const 0) (local.get $line_id))))
    (i32.store offset=0 (local.get $bounds)
      (select (i32.const -32768) (i32.const 0) (i32.eq (local.get $kind) (i32.const 2)))) ;; min
    (i32.store offset=4 (local.get $bounds)
      (select (i32.const 1)
        (select (i32.const 32767) (i32.const 0xffff) (i32.eq (local.get $kind) (i32.const 2)))
        (i32.eq (local.get $kind) (i32.const 1))))
    (i32.store offset=0 (local.get $metrics)
      (select (i32.const 1) (i32.const 0xffff) (i32.eq (local.get $kind) (i32.const 1)))))

  (func $handle_mixerGetDevCapsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fill_mixer_caps (call $g2w (local.get $arg1)) (i32.const 0) (local.get $arg2))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_mixerGetDevCapsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fill_mixer_caps (call $g2w (local.get $arg1)) (i32.const 1) (local.get $arg2))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; mixerGetLineInfo{A,W}(hmxobj, pmxl, fdwInfo) -> MMRESULT. Picking the line
  ;; is the same walk in both spellings; $wide only decides how the names in
  ;; the MIXERLINE are written back.
  (func $mixer_get_line_info (param $pmxl_g i32) (param $fdw i32) (param $wide i32)
    (local $p i32) (local $component i32) (local $line_id i32)
    (local.set $p (call $g2w (local.get $pmxl_g)))
    (local.set $component (i32.load offset=24 (local.get $p)))
    (if (i32.eq (i32.and (local.get $fdw) (i32.const 0xf)) (i32.const 1))
      (then (local.set $line_id (i32.add (i32.load offset=8 (local.get $p)) (i32.const 1))))
      (else
        (if (i32.eq (i32.and (local.get $fdw) (i32.const 0xf)) (i32.const 2))
          (then (local.set $line_id (i32.load offset=12 (local.get $p))))
          (else
            (if (i32.eq (local.get $component) (i32.const 0x1008)) (then (local.set $line_id (i32.const 1))))
            (if (i32.eq (local.get $component) (i32.const 0x1004)) (then (local.set $line_id (i32.const 2))))))))
    (call $fill_mixer_line (local.get $p) (local.get $wide) (local.get $line_id)))

  (func $handle_mixerGetLineInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $mixer_get_line_info (local.get $arg1) (local.get $arg2) (i32.const 0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 825: mixerGetLineInfoW(hmxobj, pmxl, fdwInfo) -> MMRESULT
  (func $handle_mixerGetLineInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $mixer_get_line_info (local.get $arg1) (local.get $arg2) (i32.const 1))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; mixerGetLineControls{A,W}(hmxobj, pmxlc, fdwControls) -> MMRESULT. The only
  ;; difference between the spellings is the width of the names written into
  ;; each MIXERCONTROL, and hence its default size.
  (func $mixer_get_line_controls (param $pmxlc_g i32) (param $fdw i32) (param $wide i32) (result i32)
    (local $p i32) (local $ctrl i32) (local $line_id i32) (local $kind i32) (local $cb i32)
    (local.set $p (call $g2w (local.get $pmxlc_g)))
    (local.set $ctrl (call $g2w (i32.load offset=20 (local.get $p))))
    (if (i32.eqz (i32.load offset=16 (local.get $p)))
      (then (i32.store offset=16 (local.get $p) (select (i32.const 228) (i32.const 148) (local.get $wide)))))
    (local.set $cb (i32.load offset=16 (local.get $p)))
    (local.set $line_id (i32.load offset=4 (local.get $p)))
    (if (i32.eq (i32.and (local.get $fdw) (i32.const 0xf)) (i32.const 1))
      (then
        (local.set $line_id (i32.load offset=8 (local.get $p)))          ;; dwControlID
        (if (i32.ge_u (local.get $line_id) (i32.const 0x3000))
          (then
            (local.set $kind (i32.const 2))
            (local.set $line_id (i32.sub (local.get $line_id) (i32.const 0x3000))))
          (else
            (if (i32.ge_u (local.get $line_id) (i32.const 0x2000))
              (then
                (local.set $kind (i32.const 1))
                (local.set $line_id (i32.sub (local.get $line_id) (i32.const 0x2000))))
              (else
                (local.set $kind (i32.const 0))
                (local.set $line_id (i32.sub (local.get $line_id) (i32.const 0x1000)))))))))
    (if (i32.eq (i32.and (local.get $fdw) (i32.const 0xf)) (i32.const 2))
      (then
        (if (i32.eq (i32.load offset=8 (local.get $p)) (i32.const 0x50030001))
          (then (local.set $kind (i32.const 0)))
          (else
            (if (i32.eq (i32.load offset=8 (local.get $p)) (i32.const 0x20010002))
              (then (local.set $kind (i32.const 1)))
              (else
                (if (i32.eq (i32.load offset=8 (local.get $p)) (i32.const 0x10020001))
                  (then (local.set $kind (i32.const 2)))
                  (else (return (i32.const 1025))))))))))               ;; MIXERR_INVALCONTROL
    (if (i32.eqz (i32.and (local.get $fdw) (i32.const 0xf)))
      (then
        (i32.store offset=12 (local.get $p) (i32.const 3))
        (call $fill_mixer_control (local.get $ctrl) (local.get $wide) (local.get $line_id) (i32.const 0))
        (call $fill_mixer_control (i32.add (local.get $ctrl) (local.get $cb)) (local.get $wide) (local.get $line_id) (i32.const 1))
        (call $fill_mixer_control (i32.add (local.get $ctrl) (i32.mul (local.get $cb) (i32.const 2))) (local.get $wide) (local.get $line_id) (i32.const 2)))
      (else
        (i32.store offset=12 (local.get $p) (i32.const 1))
        (call $fill_mixer_control (local.get $ctrl) (local.get $wide) (local.get $line_id) (local.get $kind))))
    (i32.const 0))

  (func $handle_mixerGetLineControlsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $mixer_get_line_controls (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_mixerGetLineControlsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $mixer_get_line_controls (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_mixerGetControlDetailsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $details i32) (local $channels i32) (local $volume i32) (local $control i32)
    (local.set $p (call $g2w (local.get $arg1)))
    (local.set $channels (i32.load offset=8 (local.get $p)))
    (local.set $details (call $g2w (i32.load offset=20 (local.get $p))))
    (local.set $control (i32.load offset=4 (local.get $p)))
    (if (i32.ge_u (local.get $control) (i32.const 0x3000))
      (then (local.set $volume (call $host_audio_mixer_get_peak (i32.sub (local.get $control) (i32.const 0x3000)))))
      (else
        (if (i32.ge_u (local.get $control) (i32.const 0x2000))
          (then (local.set $volume (call $host_audio_mixer_get_mute (i32.sub (local.get $control) (i32.const 0x2000)))))
          (else (local.set $volume (call $host_audio_mixer_get_volume (i32.sub (local.get $control) (i32.const 0x1000))))))))
    (if (local.get $details)
      (then
        (i32.store offset=0 (local.get $details) (i32.and (local.get $volume) (i32.const 0xffff)))
        (if (i32.gt_u (local.get $channels) (i32.const 1))
          (then (i32.store offset=4 (local.get $details)
            (select (local.get $volume) (i32.shr_u (local.get $volume) (i32.const 16))
              (i32.ge_u (local.get $control) (i32.const 0x3000))))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_mixerGetControlDetailsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $details i32) (local $channels i32) (local $volume i32) (local $control i32)
    (local.set $p (call $g2w (local.get $arg1)))
    (local.set $channels (i32.load offset=8 (local.get $p)))
    (local.set $details (call $g2w (i32.load offset=20 (local.get $p))))
    (local.set $control (i32.load offset=4 (local.get $p)))
    (if (i32.ge_u (local.get $control) (i32.const 0x3000))
      (then (local.set $volume (call $host_audio_mixer_get_peak (i32.sub (local.get $control) (i32.const 0x3000)))))
      (else
        (if (i32.ge_u (local.get $control) (i32.const 0x2000))
          (then (local.set $volume (call $host_audio_mixer_get_mute (i32.sub (local.get $control) (i32.const 0x2000)))))
          (else (local.set $volume (call $host_audio_mixer_get_volume (i32.sub (local.get $control) (i32.const 0x1000))))))))
    (if (local.get $details)
      (then
        (i32.store offset=0 (local.get $details) (i32.and (local.get $volume) (i32.const 0xffff)))
        (if (i32.gt_u (local.get $channels) (i32.const 1))
          (then (i32.store offset=4 (local.get $details)
            (select (local.get $volume) (i32.shr_u (local.get $volume) (i32.const 16))
              (i32.ge_u (local.get $control) (i32.const 0x3000))))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_mixerSetControlDetails (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $details i32) (local $channels i32) (local $left i32) (local $right i32) (local $control i32)
    (local.set $p (call $g2w (local.get $arg1)))
    (local.set $channels (i32.load offset=8 (local.get $p)))
    (local.set $details (call $g2w (i32.load offset=20 (local.get $p))))
    (local.set $control (i32.load offset=4 (local.get $p)))
    (if (i32.ge_u (local.get $control) (i32.const 0x3000))
      (then
        (global.set $eax (i32.const 8))                                ;; MMSYSERR_NOTSUPPORTED
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (if (local.get $details)
      (then
        (local.set $left (i32.and (i32.load (local.get $details)) (i32.const 0xffff)))
        (local.set $right (local.get $left))
        (if (i32.gt_u (local.get $channels) (i32.const 1))
          (then (local.set $right (i32.and (i32.load offset=4 (local.get $details)) (i32.const 0xffff)))))
        (if (i32.ge_u (local.get $control) (i32.const 0x2000))
          (then (call $host_audio_mixer_set_mute
            (i32.sub (local.get $control) (i32.const 0x2000)) (local.get $left)))
          (else (call $host_audio_mixer_set_volume
            (i32.sub (local.get $control) (i32.const 0x1000))
            (i32.or (local.get $left) (i32.shl (local.get $right) (i32.const 16))))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_mixerOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (i32.store (call $g2w (local.get $arg0)) (i32.const 0x00090001))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  (func $handle_mixerClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_mixerMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
