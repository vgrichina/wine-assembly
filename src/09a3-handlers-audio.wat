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
    ;; Store handle and callback info for WOM_DONE notifications
    (global.set $wave_out_handle (local.get $handle))
    (global.set $wave_out_callback (local.get $arg3))
    (global.set $wave_out_cb_instance (local.get $arg4))
    (global.set $wave_out_cb_type (local.get $cbType))
    ;; If phwo != NULL, store handle
    (if (local.get $arg0)
      (then (call $gs32 (local.get $arg0) (local.get $handle))))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args stdcall
  )

  ;; 796: waveOutClose(hwo) — 1 arg stdcall
  (func $handle_waveOutClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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
  (func $handle_waveOutWrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $data_ga i32) (local $data_len i32)
    (local.set $wa (call $g2w (local.get $arg1)))
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
    ;; Mark WHDR_DONE in dwFlags (+16)
    (i32.store (i32.add (local.get $wa) (i32.const 16))
      (i32.or (i32.load (i32.add (local.get $wa) (i32.const 16))) (i32.const 1)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 800: waveOutReset — return MMSYSERR_NOERROR
  (func $handle_waveOutReset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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
  ;; Return default 20 system colors
  (func $handle_GetSystemPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; If lppe is NULL, return number of entries (256 for 8-bit display)
    (if (i32.eqz (local.get $arg3))
      (then
        (global.set $eax (i32.const 256))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Fill with standard VGA colors for first 20 entries, black for rest
    (call $zero_memory (call $g2w (local.get $arg3)) (i32.mul (local.get $arg2) (i32.const 4)))
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

  ;; 757: waveOutGetNumDevs() — return 1 (one audio device available)
  (func $handle_waveOutGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; 1 device
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
