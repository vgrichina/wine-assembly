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

  ;; 795: waveOutOpen — return MMSYSERR_NOERROR, store fake handle
  (func $handle_waveOutOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg0=phwo, arg1=uDeviceID, arg2=lpFormat, arg3=dwCallback, arg4=dwInstance
    ;; [esp+24]=fdwOpen
    ;; If phwo != NULL, store fake handle
    (if (local.get $arg0)
      (then (call $gs32 (local.get $arg0) (i32.const 0x000B0001))))
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args stdcall
  )

  ;; 796: waveOutClose — return MMSYSERR_NOERROR
  (func $handle_waveOutClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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

  ;; 799: waveOutWrite — accept buffer, immediately mark done
  (func $handle_waveOutWrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Mark WHDR_DONE in WAVEHDR.dwFlags (+16)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
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
    ;; MMTIME.wType = TIME_BYTES (4), u.cb = 0
    (i32.store (local.get $wa) (i32.const 4))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 804: mmioOpenA — return 0 (failure, no file opened)
  (func $handle_mmioOpenA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; NULL = failure
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 805: mmioClose — return 0
  (func $handle_mmioClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 806: mmioDescend — return MMIOERR_CHUNKNOTFOUND
  (func $handle_mmioDescend (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 514))  ;; MMIOERR_CHUNKNOTFOUND
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 807: mmioRead — return 0 bytes read
  (func $handle_mmioRead (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 808: mmioAscend — return 0
  (func $handle_mmioAscend (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 809: mciSendCommandA — return 0 (success)
  (func $handle_mciSendCommandA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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
