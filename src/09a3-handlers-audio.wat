  ;; ============================================================
  ;; AUDIO/WAVE API HANDLERS
  ;; ============================================================

  ;; 794: waveOutGetDevCapsA(uDeviceID, lpCaps, cbCaps) — 3 args stdcall
  ;; Fill WAVEOUTCAPSA struct with basic PCM support
  (func $handle_waveOutGetDevCapsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (call $zero_memory (local.get $wa) (local.get $arg2))
    ;; wMid=1 (Microsoft), wPid=1
    (i32.store16 (local.get $wa) (i32.const 1))
    (i32.store16 (i32.add (local.get $wa) (i32.const 2)) (i32.const 1))
    ;; vDriverVersion = 4.0
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x0400))
    ;; szPname = "Audio" at offset 8, 32 bytes
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 0x64755741))  ;; "Audi"
    (i32.store8 (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x6F))      ;; "o"
    ;; dwFormats at offset 40: support common formats (44.1k 16-bit stereo etc.)
    (i32.store (i32.add (local.get $wa) (i32.const 40)) (i32.const 0x00000FFF))
    ;; wChannels at offset 44: 2 (stereo)
    (i32.store16 (i32.add (local.get $wa) (i32.const 44)) (i32.const 2))
    ;; dwSupport at offset 48: WAVECAPS_VOLUME|WAVECAPS_LRVOLUME
    (i32.store (i32.add (local.get $wa) (i32.const 48)) (i32.const 0x0C))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args stdcall
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
    ;; Callback type from fdwOpen bits 16-17: 0=none, 1=window, 2=thread, 3=function, 4=event
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
    ;; Store callback info in shared memory at 0xD160 (cross-thread accessible)
    ;; +0: handle, +4: callback, +8: instance, +12: cb_type
    (global.set $wave_out_handle (local.get $handle))
    (i32.store (i32.const 0xD160) (local.get $handle))
    (i32.store (i32.const 0xD164) (local.get $arg3))
    (i32.store (i32.const 0xD168) (local.get $arg4))
    (i32.store (i32.const 0xD16C) (local.get $cbType))
    ;; If phwo != NULL, store handle
    (if (local.get $arg0)
      (then (call $gs32 (local.get $arg0) (local.get $handle))))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args stdcall
  )

  ;; 796: waveOutClose(hwo) — 1 arg stdcall
  (func $handle_waveOutClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Flush deferred WHDR_DONE slot
    (i32.store (i32.const 0xAD98) (i32.const 0))
    (drop (call $host_wave_out_close (local.get $arg0)))
    (global.set $wave_out_handle (i32.const 0))
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

  ;; 798: waveOutUnprepareHeader — return MMSYSERR_NOERROR, clear WHDR_PREPARED
  (func $handle_waveOutUnprepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (i32.add (local.get $wa) (i32.const 16))
      (i32.and (i32.load (i32.add (local.get $wa) (i32.const 16))) (i32.const 0xFFFFFFFD)))
    ;; Set WHDR_DONE flag
    (i32.store (i32.add (local.get $wa) (i32.const 16))
      (i32.or (i32.load (i32.add (local.get $wa) (i32.const 16))) (i32.const 1)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 799: waveOutWrite(hwo, lpWaveHdr, cbWaveHdr) — 3 args stdcall
  ;; WAVEHDR: +0 lpData(4), +4 dwBufferLength(4), +8 dwBytesRecorded(4),
  ;;   +12 dwUser(4), +16 dwFlags(4), +20 dwLoops(4), +24 lpNext(4), +28 reserved(4)
  ;;
  ;; Deferred WHDR_DONE: real Windows marks WHDR_DONE only after the buffer
  ;; finishes playing (async). We defer: each waveOutWrite marks the PREVIOUS
  ;; buffer as done, keeping ≥1 buffer outstanding. Lets out_wave.dll's
  ;; threshold logic use the small-write path instead of waiting for 11KB chunks.
  ;; Previous WAVEHDR guest address stored at shared memory 0xAD98.
  (func $handle_waveOutWrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $data_ga i32) (local $data_len i32) (local $prev_ga i32) (local $prev_wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; Complete the PREVIOUS buffer first (deferred WHDR_DONE)
    (local.set $prev_ga (i32.load (i32.const 0xAD98)))
    (if (local.get $prev_ga)
      (then
        (local.set $prev_wa (call $g2w (local.get $prev_ga)))
        (i32.store (i32.add (local.get $prev_wa) (i32.const 16))
          (i32.or (i32.load (i32.add (local.get $prev_wa) (i32.const 16))) (i32.const 1)))
        (if (i32.eq (i32.load (i32.const 0xD16C)) (i32.const 5))
          (then (drop (call $host_set_event (i32.load (i32.const 0xD164))))))))
    ;; Read lpData and dwBufferLength from WAVEHDR
    (local.set $data_ga (i32.load (local.get $wa)))
    (local.set $data_len (i32.load (i32.add (local.get $wa) (i32.const 4))))
    ;; Send PCM data to host for playback
    (if (i32.and (local.get $data_ga) (local.get $data_len))
      (then
        (drop (call $host_wave_out_write
          (local.get $arg0)
          (call $g2w (local.get $data_ga))
          (local.get $data_len)))))
    ;; Save this buffer's guest address as pending (deferred done)
    (i32.store (i32.const 0xAD98) (local.get $arg1))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 800: waveOutReset — flush deferred WHDR_DONE, return MMSYSERR_NOERROR
  (func $handle_waveOutReset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $prev_ga i32) (local $prev_wa i32)
    (local.set $prev_ga (i32.load (i32.const 0xAD98)))
    (if (local.get $prev_ga)
      (then
        (local.set $prev_wa (call $g2w (local.get $prev_ga)))
        (i32.store (i32.add (local.get $prev_wa) (i32.const 16))
          (i32.or (i32.load (i32.add (local.get $prev_wa) (i32.const 16))) (i32.const 1)))
        (if (i32.eq (i32.load (i32.const 0xD16C)) (i32.const 5))
          (then (drop (call $host_set_event (i32.load (i32.const 0xD164))))))
        (i32.store (i32.const 0xAD98) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 801: waveOutPause — return MMSYSERR_NOERROR
  (func $handle_waveOutPause (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 802: waveOutRestart — return MMSYSERR_NOERROR
  (func $handle_waveOutRestart (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
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
    (drop (call $host_fs_close_handle (local.get $arg0)))
    (global.set $eax (i32.const 0))
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
    (local $data_offset i32)
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
        (local.set $end_pos (i32.add
          (i32.load (i32.add (call $g2w (local.get $arg2)) (i32.const 12)))  ;; parent dwDataOffset
          (i32.load (i32.add (call $g2w (local.get $arg2)) (i32.const 4)))))))  ;; + parent cksize
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
        ;; For RIFF and LIST chunks, read 4 more bytes for fccType
        (local.set $fcc_type (i32.const 0))
        (local.set $data_offset (call $host_fs_set_file_pointer (local.get $arg0) (i32.const 0) (i32.const 1)))
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
            (local.set $data_offset (call $host_fs_set_file_pointer (local.get $arg0) (i32.const 0) (i32.const 1)))
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
    (local $bytes_read_ga i32) (local $bytes_read_wa i32)
    (local.set $bytes_read_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_read_wa (call $g2w (local.get $bytes_read_ga)))
    (i32.store (local.get $bytes_read_wa) (i32.const 0))
    (drop (call $host_fs_read_file
      (local.get $arg0)    ;; handle
      (local.get $arg1)    ;; buffer (guest address)
      (local.get $arg2)    ;; count
      (local.get $bytes_read_ga)))
    (global.set $eax (i32.load (local.get $bytes_read_wa)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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

  ;; 809: mciSendCommandA — return 0 (success)
  (func $handle_mciSendCommandA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 855: mciSendCommandW — wide version, same behavior
  (func $handle_mciSendCommandW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
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
    (global.set $eax (i32.const 1))  ;; SYSPAL_NOSTATIC
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 812: ChangeDisplaySettingsA(lpDevMode, dwFlags) — 2 args stdcall
  (func $handle_ChangeDisplaySettingsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; DISP_CHANGE_SUCCESSFUL
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; EnumDisplaySettingsA(lpszDeviceName, iModeNum, lpDevMode) — 3 args stdcall.
  ;; Report current desktop mode for ENUM_CURRENT_SETTINGS (-1) and mode 0; FALSE otherwise.
  ;; dmFields bits: PELSWIDTH=0x80000, PELSHEIGHT=0x100000, BITSPERPEL=0x40000, DISPLAYFREQUENCY=0x400000.
  (func $handle_EnumDisplaySettingsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $screen i32)
    (if (i32.and
          (i32.ne (local.get $arg1) (i32.const -1))
          (i32.ne (local.get $arg1) (i32.const 0)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eqz (local.get $arg2))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $buf (call $g2w (local.get $arg2)))
    (local.set $screen (call $host_get_screen_size))
    (i32.store offset=40 (local.get $buf) (i32.const 0x5C0000))  ;; dmFields
    (i32.store offset=104 (local.get $buf) (i32.const 32))       ;; dmBitsPerPel
    (i32.store offset=108 (local.get $buf) (i32.and (local.get $screen) (i32.const 0xFFFF)))  ;; dmPelsWidth
    (i32.store offset=112 (local.get $buf) (i32.shr_u (local.get $screen) (i32.const 16)))   ;; dmPelsHeight
    (i32.store offset=120 (local.get $buf) (i32.const 60))       ;; dmDisplayFrequency
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 757: waveOutGetNumDevs() — return 1 (one audio device available)
  (func $handle_waveOutGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; 1 device
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; midiOutGetNumDevs() — 0 args, return 1 (one MIDI device)
  (func $handle_midiOutGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; 1 device
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
    (local.set $caps (call $g2w (local.get $arg1)))
    ;; Zero out the struct
    (memory.fill (local.get $caps) (i32.const 0) (local.get $arg2))
    ;; wMid (manufacturer ID) = 1 (MM_MICROSOFT)
    (i32.store16 (local.get $caps) (i32.const 1))
    ;; wPid = 1
    (i32.store16 (i32.add (local.get $caps) (i32.const 2)) (i32.const 1))
    ;; wTechnology at offset 36 = MOD_MIDIPORT (1)
    (i32.store16 (i32.add (local.get $caps) (i32.const 36)) (i32.const 1))
    ;; dwSupport at offset 44 = 0
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; midiOutOpen(lphmo, uDeviceID, dwCallback, dwCallbackInstance, dwFlags) — 5 args
  (func $handle_midiOutOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Write fake handle to *lphmo
    (if (local.get $arg0)
      (then (call $gs32 (local.get $arg0) (i32.const 0x50010001))))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; midiOutClose(hmo) — 1 arg
  (func $handle_midiOutClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; midiOutShortMsg(hmo, dwMsg) — 2 args
  (func $handle_midiOutShortMsg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; midiOutReset(hmo) — 1 arg
  (func $handle_midiOutReset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; midiOutGetVolume(hmo, lpdwVolume) — 2 args; report max volume both channels
  (func $handle_midiOutGetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 0xFFFFFFFF))))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; midiOutSetVolume(hmo, dwVolume) — 2 args; accept silently
  (func $handle_midiOutSetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; joyGetPos(uJoyID, lpInfo) — 2 args, return JOYERR_UNPLUGGED (167)
  (func $handle_joyGetPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 167))  ;; JOYERR_UNPLUGGED
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; joyGetNumDevs() — 0 args, return 0 (no joysticks)
  (func $handle_joyGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 853: waveInOpen — return MMSYSERR_NOERROR (0), fill handle
  (func $handle_waveInOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; waveInOpen(lphWaveIn, uDeviceID, lpFormatex, dwCallback, dwInstance, fdwOpen)
    ;; If lphWaveIn != NULL, write a fake handle
    (if (local.get $arg0)
      (then (call $gs32 (local.get $arg0) (i32.const 0x000A0001))))  ;; fake waveIn handle
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; 854: waveInClose — return MMSYSERR_NOERROR
  (func $handle_waveInClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 855: waveInStart — return MMSYSERR_NOERROR
  (func $handle_waveInStart (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 856: waveInStop — return MMSYSERR_NOERROR
  (func $handle_waveInStop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 857: waveInReset — return MMSYSERR_NOERROR
  (func $handle_waveInReset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 858: waveInPrepareHeader — return MMSYSERR_NOERROR
  (func $handle_waveInPrepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 859: waveInUnprepareHeader — return MMSYSERR_NOERROR
  (func $handle_waveInUnprepareHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 860: waveInAddBuffer — return MMSYSERR_NOERROR
  (func $handle_waveInAddBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 861: waveInGetNumDevs — return 1 (one input device)
  (func $handle_waveInGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 1246: timeSetEvent(uDelay, uResolution, lpTimeProc, dwUser, fuEvent)
  ;; Returns timer ID (non-zero) on success, 0 on error
  (func $handle_timeSetEvent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tid i32)
    (local.set $tid (global.get $mm_timer_next_id))
    (global.set $mm_timer_next_id (i32.add (local.get $tid) (i32.const 1)))
    (global.set $mm_timer_id (local.get $tid))
    (global.set $mm_timer_interval (local.get $arg0))
    (global.set $mm_timer_callback (local.get $arg2))
    (global.set $mm_timer_dwuser (local.get $arg3))
    (global.set $mm_timer_last_tick (call $host_get_ticks))
    (global.set $mm_timer_oneshot (i32.eqz (i32.and (local.get $arg4) (i32.const 1))))
    (global.set $eax (local.get $tid))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 1247: timeKillEvent(uTimerID)
  ;; Returns TIMERR_NOERROR (0) if found, MMSYSERR_INVALPARAM (11) if not
  (func $handle_timeKillEvent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (local.get $arg0) (global.get $mm_timer_id))
      (then
        (global.set $mm_timer_id (i32.const 0))
        (global.set $eax (i32.const 0)))
      (else
        (global.set $eax (i32.const 11))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )
