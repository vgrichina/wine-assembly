  ;; =====================================================================
  ;; TAPI 2.0 line device API (TAPI32.DLL)
  ;;
  ;; The emulated machine has no telephony hardware, so this implements the
  ;; line side of TAPI for a system with **zero line devices** — the same
  ;; state a real Win98 box is in before a modem is installed. That is a
  ;; supported configuration, not a stub: lineInitialize succeeds and
  ;; reports dwNumDevs = 0, lineShutdown balances it, and every call that
  ;; names a device or a line handle returns the documented error for a
  ;; device that does not exist (LINEERR_BADDEVICEID /
  ;; LINEERR_INVALLINEHANDLE) rather than a silent success.
  ;;
  ;; This matters because apps resolve the whole TAPI entry-point set up
  ;; front and treat one missing export as a fatal error. HYPERTRM.DLL does
  ;; exactly that: LoadLibraryA("TAPI32.DLL") then GetProcAddress for each
  ;; of the 23 names below, and a single NULL there produces "HyperTerminal
  ;; has reported a general TAPI Error. Please close HyperTerminal and try
  ;; again." before any window is usable. With the set present it starts
  ;; normally and its non-modem connection types work.
  ;; =====================================================================

  ;; tapi.h error codes.
  (global $LINEERR_BADDEVICEID i32 (i32.const 0x80000002))
  (global $LINEERR_INVALAPPHANDLE i32 (i32.const 0x80000014))
  (global $LINEERR_INVALCALLHANDLE i32 (i32.const 0x80000018))
  (global $LINEERR_INVALCOUNTRYCODE i32 (i32.const 0x80000022))
  (global $LINEERR_INVALLINEHANDLE i32 (i32.const 0x8000002B))
  (global $LINEERR_INVALLOCATION i32 (i32.const 0x8000002D))
  (global $LINEERR_INVALPOINTER i32 (i32.const 0x80000035))
  (global $LINEERR_OPERATIONUNAVAIL i32 (i32.const 0x80000049))
  (global $LINEERR_STRUCTURETOOSMALL i32 (i32.const 0x8000004D))

  ;; Application handles are tagged so a stale one is recognisable rather
  ;; than mistaken for a small integer the app happened to keep around.
  (global $TAPI_APP_TAG i32 (i32.const 0x54410000))
  (global $tapi_app_count (mut i32) (i32.const 0))
  (global $tapi_next_app (mut i32) (i32.const 1))

  ;; A live hLineApp is any tagged handle this process has handed out and
  ;; not yet shut down. The count is what lineShutdown decrements, so an
  ;; unbalanced shutdown is reported as LINEERR_INVALAPPHANDLE.
  (func $tapi_app_valid (param $h i32) (result i32)
    (i32.and
      (i32.eq (i32.and (local.get $h) (i32.const 0xFFFF0000)) (global.get $TAPI_APP_TAG))
      (i32.gt_u (global.get $tapi_app_count) (i32.const 0))))

  ;; lineInitialize(lphLineApp, hInstance, lpfnCallback, lpszAppName, lpdwNumDevs)
  ;; Succeeds with no devices. dwNumDevs is the value every caller branches
  ;; on next, and it is genuinely zero here.
  (func $handle_lineInitialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                               (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $h i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg4)))
      (then
        (global.set $eax (global.get $LINEERR_INVALPOINTER))
        (return)))
    (local.set $h (i32.or (global.get $TAPI_APP_TAG) (global.get $tapi_next_app)))
    (global.set $tapi_next_app (i32.add (global.get $tapi_next_app) (i32.const 1)))
    (global.set $tapi_app_count (i32.add (global.get $tapi_app_count) (i32.const 1)))
    (i32.store (call $g2w (local.get $arg0)) (local.get $h))
    (i32.store (call $g2w (local.get $arg4)) (i32.const 0))
    (global.set $eax (i32.const 0)))

  ;; lineShutdown(hLineApp)
  (func $handle_lineShutdown (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                             (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (if (i32.eqz (call $tapi_app_valid (local.get $arg0)))
      (then
        (global.set $eax (global.get $LINEERR_INVALAPPHANDLE))
        (return)))
    (global.set $tapi_app_count (i32.sub (global.get $tapi_app_count) (i32.const 1)))
    (global.set $eax (i32.const 0)))

  ;; lineNegotiateAPIVersion(hLineApp, dwDeviceID, dwAPILowVersion,
  ;;                         dwAPIHighVersion, lpdwAPIVersion, lpExtensionID)
  ;; Every device ID is out of range while dwNumDevs is 0.
  (func $handle_lineNegotiateAPIVersion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                        (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
    (global.set $eax (select (global.get $LINEERR_BADDEVICEID) (global.get $LINEERR_INVALAPPHANDLE)
      (call $tapi_app_valid (local.get $arg0)))))

  ;; lineGetDevCaps(hLineApp, dwDeviceID, dwAPIVersion, dwExtVersion, lpLineDevCaps)
  (func $handle_lineGetDevCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                               (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (global.set $eax (select (global.get $LINEERR_BADDEVICEID) (global.get $LINEERR_INVALAPPHANDLE)
      (call $tapi_app_valid (local.get $arg0)))))

  ;; lineGetAddressCaps(hLineApp, dwDeviceID, dwAddressID, dwAPIVersion,
  ;;                    dwExtVersion, lpAddressCaps)
  (func $handle_lineGetAddressCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                   (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
    (global.set $eax (select (global.get $LINEERR_BADDEVICEID) (global.get $LINEERR_INVALAPPHANDLE)
      (call $tapi_app_valid (local.get $arg0)))))

  ;; lineGetTranslateCaps(hLineApp, dwAPIVersion, lpTranslateCaps)
  ;;
  ;; This one is not device-scoped — it describes the dialing locations and
  ;; calling cards in Telephony control panel, and callers use it to fill a
  ;; location combo box before they touch a device. With no telephony
  ;; configuration there are no locations and no cards, which is a valid
  ;; LINETRANSLATECAPS (11 DWORDs) rather than an error.
  (func $handle_lineGetTranslateCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                     (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $total i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (if (i32.eqz (call $tapi_app_valid (local.get $arg0)))
      (then
        (global.set $eax (global.get $LINEERR_INVALAPPHANDLE))
        (return)))
    (if (i32.eqz (local.get $arg2))
      (then
        (global.set $eax (global.get $LINEERR_INVALPOINTER))
        (return)))
    (local.set $wa (call $g2w (local.get $arg2)))
    (local.set $total (i32.load (local.get $wa)))
    ;; The caller supplies dwTotalSize; anything smaller than the fixed part
    ;; cannot even carry the needed-size answer back.
    (if (i32.lt_u (local.get $total) (i32.const 12))
      (then
        (global.set $eax (global.get $LINEERR_STRUCTURETOOSMALL))
        (return)))
    (i32.store offset=4 (local.get $wa) (i32.const 44))   ;; dwNeededSize
    (i32.store offset=8 (local.get $wa) (i32.const 44))   ;; dwUsedSize
    (if (i32.lt_u (local.get $total) (i32.const 44))
      (then
        (i32.store offset=8 (local.get $wa) (i32.const 12))
        (global.set $eax (i32.const 0))
        (return)))
    (i32.store offset=12 (local.get $wa) (i32.const 0))   ;; dwNumLocations
    (i32.store offset=16 (local.get $wa) (i32.const 0))   ;; dwLocationListSize
    (i32.store offset=20 (local.get $wa) (i32.const 0))   ;; dwLocationListOffset
    (i32.store offset=24 (local.get $wa) (i32.const 0))   ;; dwCurrentLocationID
    (i32.store offset=28 (local.get $wa) (i32.const 0))   ;; dwNumCards
    (i32.store offset=32 (local.get $wa) (i32.const 0))   ;; dwCardListSize
    (i32.store offset=36 (local.get $wa) (i32.const 0))   ;; dwCardListOffset
    (i32.store offset=40 (local.get $wa) (i32.const 0))   ;; dwCurrentPreferredCardID
    (global.set $eax (i32.const 0)))

  ;; lineGetCountry(dwCountryID, dwAPIVersion, lpLineCountryList)
  ;; No country table is installed, so no country ID resolves.
  (func $handle_lineGetCountry (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                               (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (global.set $eax (global.get $LINEERR_INVALCOUNTRYCODE)))

  ;; lineSetCurrentLocation(hLineApp, dwLocation)
  (func $handle_lineSetCurrentLocation (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                       (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (global.set $eax (select (global.get $LINEERR_INVALLOCATION) (global.get $LINEERR_INVALAPPHANDLE)
      (call $tapi_app_valid (local.get $arg0)))))

  ;; lineSetAppPriority(lpszAppName, dwMediaMode, lpExtensionID,
  ;;                    dwRequestMode, lpszExtensionName, dwPriority)
  ;; Priority is recorded per app name in the Telephony registry; with no
  ;; provider to hand incoming calls to there is nothing to arbitrate, and
  ;; the documented result of setting a priority nobody consults is success.
  (func $handle_lineSetAppPriority (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                   (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
    (global.set $eax (i32.const 0)))

  ;; lineTranslateAddress(hLineApp, dwDeviceID, dwAPIVersion, lpszAddressIn,
  ;;                      dwCard, dwTranslateOptions, lpTranslateOutput)
  (func $handle_lineTranslateAddress (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                     (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
    (global.set $eax (select (global.get $LINEERR_BADDEVICEID) (global.get $LINEERR_INVALAPPHANDLE)
      (call $tapi_app_valid (local.get $arg0)))))

  ;; lineTranslateDialog(hLineApp, dwDeviceID, dwAPIVersion, hwndOwner, lpszAddressIn)
  ;; The Dialing Properties sheet belongs to the Telephony control panel,
  ;; which is not installed.
  (func $handle_lineTranslateDialog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                    (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (global.set $eax (select (global.get $LINEERR_OPERATIONUNAVAIL) (global.get $LINEERR_INVALAPPHANDLE)
      (call $tapi_app_valid (local.get $arg0)))))

  ;; lineConfigDialog(dwDeviceID, hwndOwner, lpszDeviceClass)
  (func $handle_lineConfigDialog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                 (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (global.set $eax (global.get $LINEERR_BADDEVICEID)))

  ;; lineGetDevConfig(dwDeviceID, lpDeviceConfig, lpszDeviceClass)
  (func $handle_lineGetDevConfig (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                 (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (global.set $eax (global.get $LINEERR_BADDEVICEID)))

  ;; lineSetDevConfig(dwDeviceID, lpDeviceConfig, dwSize, lpszDeviceClass)
  (func $handle_lineSetDevConfig (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                 (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (global.set $eax (global.get $LINEERR_BADDEVICEID)))

  ;; lineOpen(hLineApp, dwDeviceID, lphLine, dwAPIVersion, dwExtVersion,
  ;;          dwCallbackInstance, dwPrivileges, dwMediaModes, lpCallParams)
  (func $handle_lineOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                         (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
    (global.set $eax (select (global.get $LINEERR_BADDEVICEID) (global.get $LINEERR_INVALAPPHANDLE)
      (call $tapi_app_valid (local.get $arg0)))))

  ;; lineClose(hLine) — no line can be open, so no handle is valid.
  (func $handle_lineClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                          (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (global.set $eax (global.get $LINEERR_INVALLINEHANDLE)))

  ;; lineGetID(hLine, dwAddressID, hCall, dwSelect, lpDeviceID, lpszDeviceClass)
  (func $handle_lineGetID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                          (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
    (global.set $eax (global.get $LINEERR_INVALLINEHANDLE)))

  ;; lineGetLineDevStatus(hLine, lpLineDevStatus)
  (func $handle_lineGetLineDevStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                     (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (global.set $eax (global.get $LINEERR_INVALLINEHANDLE)))

  ;; lineSetStatusMessages(hLine, dwLineStates, dwAddressStates)
  (func $handle_lineSetStatusMessages (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                                      (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (global.set $eax (global.get $LINEERR_INVALLINEHANDLE)))

  ;; lineMakeCall(hLine, lphCall, lpszDestAddress, dwCountryCode, lpCallParams)
  (func $handle_lineMakeCall (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                             (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (global.set $eax (global.get $LINEERR_INVALLINEHANDLE)))

  ;; lineAnswer(hCall, lpsUserUserInfo, dwSize)
  (func $handle_lineAnswer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                           (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (global.set $eax (global.get $LINEERR_INVALCALLHANDLE)))

  ;; lineDial(hCall, lpszDestAddress, dwCountryCode)
  (func $handle_lineDial (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                         (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (global.set $eax (global.get $LINEERR_INVALCALLHANDLE)))

  ;; lineDrop(hCall, lpsUserUserInfo, dwSize)
  (func $handle_lineDrop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
                         (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (global.set $eax (global.get $LINEERR_INVALCALLHANDLE)))
