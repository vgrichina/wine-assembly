#!/usr/bin/env node
// gen_api_table.js — Maintain api_table.json and generate the static hash data segment.
// Reads existing api_table.json, adds any missing sub-dispatcher APIs, recomputes hashes.

const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, '..', 'src', 'api_table.json');

// FNV-1a hash
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
    h = h >>> 0;
  }
  return h;
}

function daBase(prefix) {
  return [
    { name: `${prefix}_QueryInterface`, nargs: 3 },
    { name: `${prefix}_AddRef`, nargs: 1 },
    { name: `${prefix}_Release`, nargs: 1 },
    { name: `${prefix}_GetTypeInfoCount`, nargs: 2 },
    { name: `${prefix}_GetTypeInfo`, nargs: 4 },
    { name: `${prefix}_GetIDsOfNames`, nargs: 6 },
    { name: `${prefix}_Invoke`, nargs: 9 },
  ];
}

function daSlots(prefix, maxSlot, nargsBySlot) {
  const out = daBase(prefix);
  for (let slot = 7; slot <= maxSlot; slot++) {
    out.push({
      name: `${prefix}_DirectSlot${String(slot).padStart(3, '0')}`,
      nargs: nargsBySlot[slot] || 1,
    });
  }
  return out;
}

// Plus!98 MFC screensavers use DirectAnimation dual interfaces. These vtables
// are intentionally regenerated as contiguous blocks because gen_dispatch.js
// builds COM vtables from contiguous API ids.
const daViewApis = daSlots('IDirectAnimationDAView', 21, {
  8: 4,
  9: 1,
  12: 5,
  15: 2,
  17: 2,
  21: 2,
});
const daStaticsApis = daSlots('IDirectAnimationDAStatics', 347, {
  18: 3,
  19: 4,
  32: 3,
  65: 4,
  67: 4,
  95: 4,
  106: 2,
  111: 4,
  252: 2,
  347: 4,
});
const daBehaviorApis = daSlots('IDirectAnimationDABehavior', 19, {
  7: 2,
  12: 2,
  16: 4,
  19: 2,
});

function normalizeDirectAnimationApis(table) {
  let insertAt = table.findIndex(api =>
    api.name.startsWith('IDirectAnimationDAView_') ||
    api.name.startsWith('IDirectAnimationDAStatics_') ||
    api.name.startsWith('IDirectAnimationDABehavior_'));
  if (insertAt < 0) insertAt = table.length;
  const kept = table.filter(api =>
    !api.name.startsWith('IDirectAnimationDAView_') &&
    !api.name.startsWith('IDirectAnimationDAStatics_') &&
    !api.name.startsWith('IDirectAnimationDABehavior_'));
  kept.splice(insertAt, 0, ...daViewApis, ...daStaticsApis, ...daBehaviorApis);
  return kept;
}

// Load existing table
let existing = [];
if (fs.existsSync(jsonPath)) {
  existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}
existing = normalizeDirectAnimationApis(existing);
const seen = new Set(existing.map(e => e.name));

// APIs from sub-dispatchers (not in main dispatch comment pattern)
const extra = [
  { name: 'LocalAlloc', nargs: 2 },
  { name: 'LocalFree', nargs: 1 },
  { name: 'LocalLock', nargs: 1 },
  { name: 'LocalUnlock', nargs: 1 },
  { name: 'LocalReAlloc', nargs: 3 },
  { name: 'GlobalAlloc', nargs: 2 },
  { name: 'GlobalFree', nargs: 1 },
  { name: 'GlobalLock', nargs: 1 },
  { name: 'GlobalUnlock', nargs: 1 },
  { name: 'GlobalReAlloc', nargs: 3 },
  { name: 'GlobalSize', nargs: 2 },
  { name: 'GlobalCompact', nargs: 1 },
  { name: 'RegOpenKeyA', nargs: 3 },
  { name: 'RegOpenKeyExA', nargs: 5 },
  { name: 'MessageBeep', nargs: 1 },
  { name: 'SetMenuItemInfoA', nargs: 4 },
  { name: 'GetMenuItemInfoA', nargs: 4 },
  // APIs with multi-name comments (not caught by single-name regex)
  { name: 'RegisterClassExA', nargs: 1 },
  { name: 'RegisterClassA', nargs: 1 },
  { name: 'BeginPaint', nargs: 2 },
  { name: 'OpenClipboard', nargs: 1 },
  { name: 'CloseClipboard', nargs: 0 },
  { name: 'IsClipboardFormatAvailable', nargs: 1 },
  { name: 'GetEnvironmentStringsW', nargs: 0 },
  { name: 'GetSaveFileNameA', nargs: 1 },
  { name: 'CreateDialogIndirectParamA', nargs: 5 },
  { name: 'SetViewportExtEx', nargs: 4 },
  { name: 'lstrcmpiA', nargs: 2 },
  { name: 'FreeEnvironmentStringsA', nargs: 1 },
  { name: 'FreeEnvironmentStringsW', nargs: 1 },
  { name: 'GetVersion', nargs: 0 },
  { name: 'GetTextExtentPoint32A', nargs: 4 },
  { name: 'wsprintfA', nargs: -1 },  // varargs, handled specially
  { name: 'GetPrivateProfileStringA', nargs: 6 },
  { name: 'PaintRgn', nargs: 2 },
  { name: 'CharUpperA', nargs: 1 },
  { name: 'CharLowerA', nargs: 1 },
  { name: 'CharLowerBuffA', nargs: 2 },
  { name: 'ImmAssociateContext', nargs: 2 },
  { name: 'ImmGetContext', nargs: 1 },
  { name: 'ImmReleaseContext', nargs: 2 },
  { name: 'VkKeyScanW', nargs: 1 },
  { name: 'MapVirtualKeyW', nargs: 2 },
  { name: 'MapVirtualKeyExA', nargs: 3 },
  { name: 'GetKeyboardState', nargs: 1 },
  { name: 'ToAsciiEx', nargs: 6 },
  { name: 'GetStringTypeExA', nargs: 5 },
  { name: 'VirtualQuery', nargs: 3 },
  // Wide-char CRT APIs
  { name: '__wgetmainargs', nargs: 5 },
  { name: '__p__wcmdln', nargs: 0 },
  { name: '__p__acmdln', nargs: 0 },
  { name: '__set_app_type', nargs: 1 },
  { name: '__setusermatherr', nargs: 1 },
  { name: '_adjust_fdiv', nargs: 0 },
  { name: 'free', nargs: 1 },
  { name: 'malloc', nargs: 1 },
  { name: 'calloc', nargs: 2 },
  { name: 'rand', nargs: 0 },
  { name: 'srand', nargs: 1 },
  { name: '_purecall', nargs: 0 },
  { name: '_onexit', nargs: 1 },
  { name: '__dllonexit', nargs: 3 },
  { name: '_splitpath', nargs: 5 },
  { name: '_wcsicmp', nargs: 2 },
  { name: '_wtoi', nargs: 1 },
  { name: '_itow', nargs: 3 },
  { name: 'wcscmp', nargs: 2 },
  { name: 'wcsncpy', nargs: 3 },
  { name: 'wcslen', nargs: 1 },
  { name: 'mbstowcs', nargs: 3, convention: 'cdecl' },
  { name: 'wcstombs', nargs: 3, convention: 'cdecl' },
  { name: 'ceil', nargs: 1, convention: 'cdecl' },
  { name: 'sqrt', nargs: 1, convention: 'cdecl' },
  { name: 'sin', nargs: 1, convention: 'cdecl' },
  { name: 'pow', nargs: 2, convention: 'cdecl' },
  { name: '_CIpow', nargs: 0, convention: 'cdecl' },
  { name: 'memset', nargs: 3 },
  { name: 'memcpy', nargs: 3 },
  { name: '_XcptFilter', nargs: 2 },
  { name: '__CxxFrameHandler', nargs: 4 },
  { name: '_global_unwind2', nargs: 1 },
  { name: '_getdcwd', nargs: 3 },
  // W-suffix Win32 APIs
  { name: 'GetModuleHandleW', nargs: 1 },
  { name: 'GetModuleFileNameW', nargs: 3 },
  { name: 'GetCommandLineW', nargs: 0 },
  { name: 'CreateWindowExW', nargs: 12 },
  { name: 'RegisterClassW', nargs: 1 },
  { name: 'RegisterClassExW', nargs: 1 },
  { name: 'DefWindowProcW', nargs: 4 },
  { name: 'LoadCursorW', nargs: 2 },
  { name: 'LoadIconW', nargs: 2 },
  { name: 'LoadMenuW', nargs: 2 },
  { name: 'MessageBoxW', nargs: 4 },
  { name: 'SetWindowTextW', nargs: 2 },
  { name: 'SetWindowsHookA', nargs: 2 },
  { name: 'GetWindowTextW', nargs: 3 },
  { name: 'SendMessageW', nargs: 4 },
  { name: 'PostMessageW', nargs: 4 },
  { name: 'GetLastError', nargs: 0 },
  { name: 'SetErrorMode', nargs: 1 },
  { name: 'GetTickCount', nargs: 0 },
  { name: 'MulDiv', nargs: 3 },
  { name: 'GetCurrentThreadId', nargs: 0 },
  { name: 'LoadLibraryW', nargs: 1 },
  { name: 'FreeLibrary', nargs: 1 },
  { name: 'GetProcAddress', nargs: 2 },
  { name: 'GetStartupInfoW', nargs: 1 },
  { name: 'SetTimer', nargs: 4 },
  { name: 'KillTimer', nargs: 2 },
  { name: 'GetClientRect', nargs: 2 },
  { name: 'GetWindowRect', nargs: 2 },
  { name: 'GetDC', nargs: 1 },
  { name: 'ReleaseDC', nargs: 2 },
  { name: 'GetDeviceCaps', nargs: 2 },
  { name: 'GetSystemMetrics', nargs: 1 },
  { name: 'GetSysColor', nargs: 1 },
  { name: 'GetStockObject', nargs: 1 },
  { name: 'SetBkMode', nargs: 2 },
  { name: 'SetBkColor', nargs: 2 },
  { name: 'SetTextColor', nargs: 2 },
  { name: 'GetKeyState', nargs: 1 },
  { name: 'GetCursorPos', nargs: 1 },
  { name: 'SetCursor', nargs: 1 },
  { name: 'EnableWindow', nargs: 2 },
  { name: 'GetParent', nargs: 1 },
  { name: 'GetWindow', nargs: 2 },
  { name: 'IsWindow', nargs: 1 },
  { name: 'DestroyWindow', nargs: 1 },
  { name: 'InvalidateRect', nargs: 3 },
  { name: 'UpdateWindow', nargs: 1 },
  { name: 'GetClassInfoW', nargs: 3 },
  { name: 'SetClassLongW', nargs: 3 },
  { name: 'GetClassLongW', nargs: 2 },
  { name: 'SetWindowLongW', nargs: 3 },
  { name: 'GetWindowLongW', nargs: 2 },
  { name: 'InitCommonControlsEx', nargs: 1 },
  // OLE32 minimal stubs
  { name: 'OleInitialize', nargs: 1 },
  { name: 'OleRun', nargs: 1 },
  { name: 'OleIsRunning', nargs: 1 },
  { name: 'OleLockRunning', nargs: 3 },
  { name: 'CoGetMalloc', nargs: 2 },
  { name: 'CoSetState', nargs: 1 },
  { name: 'CoGetState', nargs: 1 },
  { name: 'CoTaskMemFree', nargs: 1 },
  // GDI extras
  { name: 'SaveDC', nargs: 1 },
  { name: 'RestoreDC', nargs: 2 },
  { name: 'SetMapMode', nargs: 2 },
  { name: 'GetTextMetricsW', nargs: 2 },
  { name: 'CreateFontIndirectW', nargs: 1 },
  { name: 'CreatePenIndirect', nargs: 1 },
  { name: 'DrawTextExA', nargs: 6 },
  { name: 'DrawTextExW', nargs: 6 },
  { name: 'SetStretchBltMode', nargs: 2 },
  { name: 'GetPixel', nargs: 3 },
  { name: 'SetPixel', nargs: 4 },
  { name: 'SetROP2', nargs: 2 },
  { name: 'ExtEscape', nargs: 6 },
  { name: 'UpdateColors', nargs: 1 },
  // String W-suffix
  { name: 'lstrlenW', nargs: 1 },
  { name: 'lstrcpyW', nargs: 2 },
  { name: 'lstrcpynW', nargs: 3 },
  { name: 'lstrcmpW', nargs: 2 },
  { name: 'lstrcmpiW', nargs: 2 },
  { name: 'CharNextW', nargs: 1 },
  { name: 'CharPrevW', nargs: 2 },
  { name: 'wsprintfW', nargs: -1 },
  // TLS and synchronization
  { name: 'TlsAlloc', nargs: 0 },
  { name: 'TlsGetValue', nargs: 1 },
  { name: 'TlsSetValue', nargs: 2 },
  { name: 'TlsFree', nargs: 1 },
  { name: 'InitializeCriticalSection', nargs: 1 },
  { name: 'EnterCriticalSection', nargs: 1 },
  { name: 'LeaveCriticalSection', nargs: 1 },
  { name: 'DeleteCriticalSection', nargs: 1 },
  // Heap
  { name: 'HeapCreate', nargs: 3 },
  { name: 'HeapDestroy', nargs: 1 },
  // Misc KERNEL32 used by msvcrt
  { name: 'GetCurrentThread', nargs: 0 },
  { name: 'GetCurrentProcess', nargs: 0 },
  { name: 'GetProcessHeap', nargs: 0 },
  { name: 'SetHandleCount', nargs: 1 },
  { name: 'GetStdHandle', nargs: 1 },
  { name: 'GetFileType', nargs: 1 },
  { name: 'SetStdHandle', nargs: 2 },
  { name: 'FlushFileBuffers', nargs: 1 },
  { name: 'WriteFile', nargs: 5 },
  { name: 'WinExec', nargs: 2 },
  { name: 'GetACP', nargs: 0 },
  { name: 'GetOEMCP', nargs: 0 },
  { name: 'GetCPInfo', nargs: 2 },
  { name: 'IsValidCodePage', nargs: 1 },
  { name: 'GetEnvironmentStringsA', nargs: 0 },
  { name: 'GetStringTypeW', nargs: 4 },
  { name: 'LCMapStringW', nargs: 6 },
  { name: 'InterlockedIncrement', nargs: 1 },
  { name: 'InterlockedDecrement', nargs: 1 },
  { name: 'InterlockedExchange', nargs: 2 },
  { name: 'VirtualAlloc', nargs: 4 },
  { name: 'VirtualFree', nargs: 3 },
  { name: 'IsBadReadPtr', nargs: 2 },
  { name: 'IsBadWritePtr', nargs: 2 },
  { name: 'RtlUnwind', nargs: 4 },
  { name: 'UnhandledExceptionFilter', nargs: 1 },
  { name: 'SetUnhandledExceptionFilter', nargs: 1 },
  { name: 'IsDebuggerPresent', nargs: 0 },
  { name: 'ChooseColorA', nargs: 1 },
  { name: 'CreateBrushIndirect', nargs: 1 },
  { name: 'AppendMenuA', nargs: 4 },
  { name: 'InsertMenuA', nargs: 5 },
  { name: 'ModifyMenuA', nargs: 5 },
  { name: 'RegisterDragDrop', nargs: 2 },
  { name: 'RevokeDragDrop', nargs: 1 },
  // DirectX creators
  { name: 'DirectDrawCreate', nargs: 3 },
  { name: 'DirectSoundCreate', nargs: 3 },
  { name: 'DirectInputCreateA', nargs: 4 },
  // IDirectDraw vtable (23 methods)
  { name: 'IDirectDraw_QueryInterface', nargs: 3 },
  { name: 'IDirectDraw_AddRef', nargs: 1 },
  { name: 'IDirectDraw_Release', nargs: 1 },
  { name: 'IDirectDraw_Compact', nargs: 1 },
  { name: 'IDirectDraw_CreateClipper', nargs: 3 },
  { name: 'IDirectDraw_CreatePalette', nargs: 4 },
  { name: 'IDirectDraw_CreateSurface', nargs: 4 },
  { name: 'IDirectDraw_DuplicateSurface', nargs: 3 },
  { name: 'IDirectDraw_EnumDisplayModes', nargs: 5 },
  { name: 'IDirectDraw_EnumSurfaces', nargs: 5 },
  { name: 'IDirectDraw_FlipToGDISurface', nargs: 1 },
  { name: 'IDirectDraw_GetCaps', nargs: 3 },
  { name: 'IDirectDraw_GetDisplayMode', nargs: 2 },
  { name: 'IDirectDraw_GetFourCCCodes', nargs: 3 },
  { name: 'IDirectDraw_GetGDISurface', nargs: 2 },
  { name: 'IDirectDraw_GetMonitorFrequency', nargs: 2 },
  { name: 'IDirectDraw_GetScanLine', nargs: 2 },
  { name: 'IDirectDraw_GetVerticalBlankStatus', nargs: 2 },
  { name: 'IDirectDraw_Initialize', nargs: 2 },
  { name: 'IDirectDraw_RestoreDisplayMode', nargs: 1 },
  { name: 'IDirectDraw_SetCooperativeLevel', nargs: 3 },
  { name: 'IDirectDraw_SetDisplayMode', nargs: 4 },
  { name: 'IDirectDraw_WaitForVerticalBlank', nargs: 3 },
  // IDirectDrawSurface vtable (36 methods)
  { name: 'IDirectDrawSurface_QueryInterface', nargs: 3 },
  { name: 'IDirectDrawSurface_AddRef', nargs: 1 },
  { name: 'IDirectDrawSurface_Release', nargs: 1 },
  { name: 'IDirectDrawSurface_AddAttachedSurface', nargs: 2 },
  { name: 'IDirectDrawSurface_AddOverlayDirtyRect', nargs: 2 },
  { name: 'IDirectDrawSurface_Blt', nargs: 5 },
  { name: 'IDirectDrawSurface_BltBatch', nargs: 3 },
  { name: 'IDirectDrawSurface_BltFast', nargs: 5 },
  { name: 'IDirectDrawSurface_DeleteAttachedSurface', nargs: 3 },
  { name: 'IDirectDrawSurface_EnumAttachedSurfaces', nargs: 3 },
  { name: 'IDirectDrawSurface_EnumOverlayZOrders', nargs: 4 },
  { name: 'IDirectDrawSurface_Flip', nargs: 3 },
  { name: 'IDirectDrawSurface_GetAttachedSurface', nargs: 3 },
  { name: 'IDirectDrawSurface_GetBltStatus', nargs: 2 },
  { name: 'IDirectDrawSurface_GetCaps', nargs: 2 },
  { name: 'IDirectDrawSurface_GetClipper', nargs: 2 },
  { name: 'IDirectDrawSurface_GetColorKey', nargs: 3 },
  { name: 'IDirectDrawSurface_GetDC', nargs: 2 },
  { name: 'IDirectDrawSurface_GetFlipStatus', nargs: 2 },
  { name: 'IDirectDrawSurface_GetOverlayPosition', nargs: 3 },
  { name: 'IDirectDrawSurface_GetPalette', nargs: 2 },
  { name: 'IDirectDrawSurface_GetPixelFormat', nargs: 2 },
  { name: 'IDirectDrawSurface_GetSurfaceDesc', nargs: 2 },
  { name: 'IDirectDrawSurface_Initialize', nargs: 3 },
  { name: 'IDirectDrawSurface_IsLost', nargs: 1 },
  { name: 'IDirectDrawSurface_Lock', nargs: 5 },
  { name: 'IDirectDrawSurface_ReleaseDC', nargs: 2 },
  { name: 'IDirectDrawSurface_Restore', nargs: 1 },
  { name: 'IDirectDrawSurface_SetClipper', nargs: 2 },
  { name: 'IDirectDrawSurface_SetColorKey', nargs: 3 },
  { name: 'IDirectDrawSurface_SetOverlayPosition', nargs: 3 },
  { name: 'IDirectDrawSurface_SetPalette', nargs: 2 },
  { name: 'IDirectDrawSurface_Unlock', nargs: 2 },
  { name: 'IDirectDrawSurface_UpdateOverlay', nargs: 5 },
  { name: 'IDirectDrawSurface_UpdateOverlayDisplay', nargs: 2 },
  { name: 'IDirectDrawSurface_UpdateOverlayZOrder', nargs: 3 },
  // IDirectDrawSurface2 extensions (slots 36-38 atop IDirectDrawSurface)
  { name: 'IDirectDrawSurface2_GetDDInterface', nargs: 2 },
  { name: 'IDirectDrawSurface2_PageLock', nargs: 2 },
  { name: 'IDirectDrawSurface2_PageUnlock', nargs: 2 },
  // IDirectDrawPalette vtable (6 methods)
  { name: 'IDirectDrawPalette_QueryInterface', nargs: 3 },
  { name: 'IDirectDrawPalette_AddRef', nargs: 1 },
  { name: 'IDirectDrawPalette_Release', nargs: 1 },
  { name: 'IDirectDrawPalette_GetCaps', nargs: 2 },
  { name: 'IDirectDrawPalette_GetEntries', nargs: 5 },
  { name: 'IDirectDrawPalette_SetEntries', nargs: 5 },
  // IDirectSound vtable (11 methods)
  { name: 'IDirectSound_QueryInterface', nargs: 3 },
  { name: 'IDirectSound_AddRef', nargs: 1 },
  { name: 'IDirectSound_Release', nargs: 1 },
  { name: 'IDirectSound_CreateSoundBuffer', nargs: 4 },
  { name: 'IDirectSound_GetCaps', nargs: 2 },
  { name: 'IDirectSound_DuplicateSoundBuffer', nargs: 3 },
  { name: 'IDirectSound_SetCooperativeLevel', nargs: 3 },
  { name: 'IDirectSound_Compact', nargs: 1 },
  { name: 'IDirectSound_GetSpeakerConfig', nargs: 2 },
  { name: 'IDirectSound_SetSpeakerConfig', nargs: 2 },
  { name: 'IDirectSound_Initialize', nargs: 2 },
  // IDirectSoundBuffer vtable (21 methods)
  { name: 'IDirectSoundBuffer_QueryInterface', nargs: 3 },
  { name: 'IDirectSoundBuffer_AddRef', nargs: 1 },
  { name: 'IDirectSoundBuffer_Release', nargs: 1 },
  { name: 'IDirectSoundBuffer_GetCaps', nargs: 2 },
  { name: 'IDirectSoundBuffer_GetCurrentPosition', nargs: 3 },
  { name: 'IDirectSoundBuffer_GetFormat', nargs: 4 },
  { name: 'IDirectSoundBuffer_GetVolume', nargs: 2 },
  { name: 'IDirectSoundBuffer_GetPan', nargs: 2 },
  { name: 'IDirectSoundBuffer_GetFrequency', nargs: 2 },
  { name: 'IDirectSoundBuffer_GetStatus', nargs: 2 },
  { name: 'IDirectSoundBuffer_Initialize', nargs: 3 },
  { name: 'IDirectSoundBuffer_Lock', nargs: 5 },
  { name: 'IDirectSoundBuffer_Play', nargs: 4 },
  { name: 'IDirectSoundBuffer_SetCurrentPosition', nargs: 2 },
  { name: 'IDirectSoundBuffer_SetFormat', nargs: 2 },
  { name: 'IDirectSoundBuffer_SetVolume', nargs: 2 },
  { name: 'IDirectSoundBuffer_SetPan', nargs: 2 },
  { name: 'IDirectSoundBuffer_SetFrequency', nargs: 2 },
  { name: 'IDirectSoundBuffer_Stop', nargs: 1 },
  { name: 'IDirectSoundBuffer_Unlock', nargs: 5 },
  { name: 'IDirectSoundBuffer_Restore', nargs: 1 },
  // IDirectInputA vtable (8 methods)
  { name: 'IDirectInput_QueryInterface', nargs: 3 },
  { name: 'IDirectInput_AddRef', nargs: 1 },
  { name: 'IDirectInput_Release', nargs: 1 },
  { name: 'IDirectInput_CreateDevice', nargs: 4 },
  { name: 'IDirectInput_EnumDevices', nargs: 5 },
  { name: 'IDirectInput_GetDeviceStatus', nargs: 2 },
  { name: 'IDirectInput_RunControlPanel', nargs: 3 },
  { name: 'IDirectInput_Initialize', nargs: 4 },
  // IDirectInputDeviceA vtable (18 methods)
  { name: 'IDirectInputDevice_QueryInterface', nargs: 3 },
  { name: 'IDirectInputDevice_AddRef', nargs: 1 },
  { name: 'IDirectInputDevice_Release', nargs: 1 },
  { name: 'IDirectInputDevice_GetCapabilities', nargs: 2 },
  { name: 'IDirectInputDevice_EnumObjects', nargs: 5 },
  { name: 'IDirectInputDevice_GetProperty', nargs: 3 },
  { name: 'IDirectInputDevice_SetProperty', nargs: 3 },
  { name: 'IDirectInputDevice_Acquire', nargs: 1 },
  { name: 'IDirectInputDevice_Unacquire', nargs: 1 },
  { name: 'IDirectInputDevice_GetDeviceState', nargs: 3 },
  { name: 'IDirectInputDevice_GetDeviceData', nargs: 5 },
  { name: 'IDirectInputDevice_SetDataFormat', nargs: 2 },
  { name: 'IDirectInputDevice_SetEventNotification', nargs: 2 },
  { name: 'IDirectInputDevice_SetCooperativeLevel', nargs: 3 },
  { name: 'IDirectInputDevice_GetObjectInfo', nargs: 4 },
  { name: 'IDirectInputDevice_GetDeviceInfo', nargs: 2 },
  { name: 'IDirectInputDevice_RunControlPanel', nargs: 3 },
  { name: 'IDirectInputDevice_Initialize', nargs: 5 },
  { name: 'EnumDisplayMonitors', nargs: 4 },
  { name: 'auxGetNumDevs', nargs: 0 },
  { name: 'auxGetDevCapsA', nargs: 3 },
  { name: 'auxGetVolume', nargs: 2 },
  { name: 'auxSetVolume', nargs: 2 },
  { name: 'auxOutMessage', nargs: 4 },
  { name: 'midiOutGetNumDevs', nargs: 0 },
  { name: 'midiOutGetDevCapsA', nargs: 3 },
  { name: 'midiOutOpen', nargs: 5 },
  { name: 'midiOutClose', nargs: 1 },
  { name: 'midiOutShortMsg', nargs: 2 },
  { name: 'midiOutReset', nargs: 1 },
  { name: 'midiOutGetVolume', nargs: 2 },
  { name: 'midiOutSetVolume', nargs: 2 },
  { name: 'OpenMutexA', nargs: 3 },
  { name: 'CreateMutexA', nargs: 3 },
  { name: 'joyGetPos', nargs: 2 },
  { name: 'joyGetNumDevs', nargs: 0 },
  { name: 'WaitMessage', nargs: 0 },
  // VERSION.DLL APIs
  { name: 'GetFileVersionInfoSizeA', nargs: 2 },
  { name: 'GetFileVersionInfoA', nargs: 4 },
  { name: 'VerQueryValueA', nargs: 4 },
  // DirectDraw enumeration
  { name: 'DirectDrawEnumerateA', nargs: 2 },
  { name: 'EnumWindows', nargs: 2 },
  { name: 'PlaySoundA', nargs: 3 },
  // IDirectDrawFactory vtable (5 methods) — CLSID_DirectDrawFactory from ddrawex.dll,
  // used by CORBIS/FASHION/HORROR/WOTRAVEL screensavers via CoCreateInstance.
  { name: 'IDirectDrawFactory_QueryInterface', nargs: 3 },
  { name: 'IDirectDrawFactory_AddRef', nargs: 1 },
  { name: 'IDirectDrawFactory_Release', nargs: 1 },
  { name: 'IDirectDrawFactory_CreateDirectDraw', nargs: 6 },
  { name: 'IDirectDrawFactory_DirectDrawEnumerate', nargs: 2 },
  // DirectAnimation Automation placeholders for Plus!98 MFC screensavers.
  { name: 'IDirectAnimationDAView_QueryInterface', nargs: 3 },
  { name: 'IDirectAnimationDAView_AddRef', nargs: 1 },
  { name: 'IDirectAnimationDAView_Release', nargs: 1 },
  { name: 'IDirectAnimationDAView_GetTypeInfoCount', nargs: 2 },
  { name: 'IDirectAnimationDAView_GetTypeInfo', nargs: 4 },
  { name: 'IDirectAnimationDAView_GetIDsOfNames', nargs: 6 },
  { name: 'IDirectAnimationDAView_Invoke', nargs: 9 },
  { name: 'IDirectAnimationDAStatics_QueryInterface', nargs: 3 },
  { name: 'IDirectAnimationDAStatics_AddRef', nargs: 1 },
  { name: 'IDirectAnimationDAStatics_Release', nargs: 1 },
  { name: 'IDirectAnimationDAStatics_GetTypeInfoCount', nargs: 2 },
  { name: 'IDirectAnimationDAStatics_GetTypeInfo', nargs: 4 },
  { name: 'IDirectAnimationDAStatics_GetIDsOfNames', nargs: 6 },
  { name: 'IDirectAnimationDAStatics_Invoke', nargs: 9 },
  // OLE IMalloc returned by CoGetMalloc; oleaut32 uses this for Automation buffers.
  { name: 'IMalloc_QueryInterface', nargs: 3 },
  { name: 'IMalloc_AddRef', nargs: 1 },
  { name: 'IMalloc_Release', nargs: 1 },
  { name: 'IMalloc_Alloc', nargs: 2 },
  { name: 'IMalloc_Realloc', nargs: 3 },
  { name: 'IMalloc_Free', nargs: 2 },
  { name: 'IMalloc_GetSize', nargs: 2 },
  { name: 'IMalloc_DidAlloc', nargs: 2 },
  { name: 'IMalloc_HeapMinimize', nargs: 1 },
  // WINMM — timer device capabilities
  { name: 'timeGetDevCaps', nargs: 2 },
  // KERNEL32 — drive enumeration
  { name: 'GetLogicalDriveStringsA', nargs: 2 },
  // KERNEL32 — locale persistence stub
  { name: 'SetLocaleInfoA', nargs: 3 },
  // USER32 — keyboard identification (trivial stub: enhanced 101/102-key)
  { name: 'GetKeyboardType', nargs: 1 },
  // GDI32 — inter-character spacing (trivial stub: 0 = default spacing)
  { name: 'GetTextCharacterExtra', nargs: 1 },
  // KERNEL32 — fills SYSTEM_INFO struct (CPU count, arch, page size, etc.)
  { name: 'GetSystemInfo', nargs: 1 },
  // KERNEL32 — default process/system locale (US English).
  { name: 'GetSystemDefaultLCID', nargs: 0 },
  // ADVAPI32 — returns a constant "user" string
  { name: 'GetUserNameA', nargs: 2 },
  // KERNEL32 — returns a constant "PC" string
  { name: 'GetComputerNameA', nargs: 2 },
  // DPLAYX — all return DPERR_UNAVAILABLE (0x80004005 E_FAIL); apps fall back to single-player.
  { name: 'DirectPlayCreate', nargs: 4 },
  { name: 'DirectPlayEnumerate', nargs: 2 },
  { name: 'DirectPlayEnumerateA', nargs: 2 },
  { name: 'DirectPlayLobbyCreateA', nargs: 5 },
  // IDirectPlay3A COM object used by DX SDK samples via CoCreateInstance(CLSID_DirectPlay).
  { name: 'IDirectPlay3_QueryInterface', nargs: 3 },
  { name: 'IDirectPlay3_AddRef', nargs: 1 },
  { name: 'IDirectPlay3_Release', nargs: 1 },
  { name: 'IDirectPlay3_AddPlayerToGroup', nargs: 3 },
  { name: 'IDirectPlay3_Close', nargs: 1 },
  { name: 'IDirectPlay3_CreateGroup', nargs: 6 },
  { name: 'IDirectPlay3_CreatePlayer', nargs: 7 },
  { name: 'IDirectPlay3_DeletePlayerFromGroup', nargs: 3 },
  { name: 'IDirectPlay3_DestroyGroup', nargs: 2 },
  { name: 'IDirectPlay3_DestroyPlayer', nargs: 2 },
  { name: 'IDirectPlay3_EnumGroupPlayers', nargs: 6 },
  { name: 'IDirectPlay3_EnumGroups', nargs: 5 },
  { name: 'IDirectPlay3_EnumPlayers', nargs: 5 },
  { name: 'IDirectPlay3_EnumSessions', nargs: 6 },
  { name: 'IDirectPlay3_GetCaps', nargs: 3 },
  { name: 'IDirectPlay3_GetGroupData', nargs: 5 },
  { name: 'IDirectPlay3_GetGroupName', nargs: 4 },
  { name: 'IDirectPlay3_GetMessageCount', nargs: 3 },
  { name: 'IDirectPlay3_GetPlayerAddress', nargs: 4 },
  { name: 'IDirectPlay3_GetPlayerCaps', nargs: 4 },
  { name: 'IDirectPlay3_GetPlayerData', nargs: 5 },
  { name: 'IDirectPlay3_GetPlayerName', nargs: 4 },
  { name: 'IDirectPlay3_GetSessionDesc', nargs: 3 },
  { name: 'IDirectPlay3_Initialize', nargs: 2 },
  { name: 'IDirectPlay3_Open', nargs: 3 },
  { name: 'IDirectPlay3_Receive', nargs: 6 },
  { name: 'IDirectPlay3_Send', nargs: 6 },
  { name: 'IDirectPlay3_SetGroupData', nargs: 5 },
  { name: 'IDirectPlay3_SetGroupName', nargs: 4 },
  { name: 'IDirectPlay3_SetPlayerData', nargs: 5 },
  { name: 'IDirectPlay3_SetPlayerName', nargs: 4 },
  { name: 'IDirectPlay3_SetSessionDesc', nargs: 3 },
  { name: 'IDirectPlay3_AddGroupToGroup', nargs: 3 },
  { name: 'IDirectPlay3_CreateGroupInGroup', nargs: 7 },
  { name: 'IDirectPlay3_DeleteGroupFromGroup', nargs: 3 },
  { name: 'IDirectPlay3_EnumConnections', nargs: 5 },
  { name: 'IDirectPlay3_EnumGroupsInGroup', nargs: 6 },
  { name: 'IDirectPlay3_GetGroupConnectionSettings', nargs: 5 },
  { name: 'IDirectPlay3_InitializeConnection', nargs: 3 },
  { name: 'IDirectPlay3_SecureOpen', nargs: 5 },
  { name: 'IDirectPlay3_SendChatMessage', nargs: 5 },
  { name: 'IDirectPlay3_SetGroupConnectionSettings', nargs: 4 },
  { name: 'IDirectPlay3_StartSession', nargs: 3 },
  { name: 'IDirectPlay3_GetGroupFlags', nargs: 3 },
  { name: 'IDirectPlay3_GetGroupParent', nargs: 3 },
  { name: 'IDirectPlay3_GetPlayerAccount', nargs: 5 },
  { name: 'IDirectPlay3_GetPlayerFlags', nargs: 3 },
  // IDirectPlayLobby2A COM object used alongside DirectPlay3 by DX SDK samples.
  { name: 'IDirectPlayLobby2_QueryInterface', nargs: 3 },
  { name: 'IDirectPlayLobby2_AddRef', nargs: 1 },
  { name: 'IDirectPlayLobby2_Release', nargs: 1 },
  { name: 'IDirectPlayLobby2_Connect', nargs: 4 },
  { name: 'IDirectPlayLobby2_CreateAddress', nargs: 7 },
  { name: 'IDirectPlayLobby2_EnumAddress', nargs: 5 },
  { name: 'IDirectPlayLobby2_EnumAddressTypes', nargs: 5 },
  { name: 'IDirectPlayLobby2_EnumLocalApplications', nargs: 4 },
  { name: 'IDirectPlayLobby2_GetConnectionSettings', nargs: 4 },
  { name: 'IDirectPlayLobby2_ReceiveLobbyMessage', nargs: 6 },
  { name: 'IDirectPlayLobby2_RunApplication', nargs: 5 },
  { name: 'IDirectPlayLobby2_SendLobbyMessage', nargs: 5 },
  { name: 'IDirectPlayLobby2_SetConnectionSettings', nargs: 4 },
  { name: 'IDirectPlayLobby2_SetLobbyMessageEvent', nargs: 4 },
  { name: 'IDirectPlayLobby2_CreateCompoundAddress', nargs: 5 },
  // DSOUND — enumerate = no-op (returns DS_OK with no callback invocations)
  { name: 'DirectSoundEnumerateA', nargs: 2 },
  // DDRAW — standalone clipper factory (DX SDK globe.exe uses this instead of IDirectDraw_CreateClipper)
  { name: 'DirectDrawCreateClipper', nargs: 3 },
  // WINMM — MCI command string interface (MIDI/CDAudio). Sequencer commands route to host MIDI.
  { name: 'mciSendStringA', nargs: 4 },
  // WINMM — minimal mixer device/control surface for Volume Control.
  { name: 'mixerClose', nargs: 1 },
  { name: 'mixerGetControlDetailsA', nargs: 3 },
  { name: 'mixerGetControlDetailsW', nargs: 3 },
  { name: 'mixerGetDevCapsA', nargs: 3 },
  { name: 'mixerGetDevCapsW', nargs: 3 },
  { name: 'mixerGetLineControlsA', nargs: 3 },
  { name: 'mixerGetLineControlsW', nargs: 3 },
  { name: 'mixerGetLineInfoA', nargs: 3 },
  { name: 'mixerMessage', nargs: 4 },
  { name: 'mixerOpen', nargs: 5 },
  { name: 'mixerSetControlDetails', nargs: 3 },
  { name: 'waveOutGetDevCapsW', nargs: 3 },
  // SETUPAPI / USER32 device notification probes used by XP sndvol32.
  { name: 'SetupDiCreateDeviceInfoList', nargs: 2 },
  { name: 'SetupDiDestroyDeviceInfoList', nargs: 1 },
  { name: 'SetupDiGetDeviceInterfaceDetailW', nargs: 6 },
  { name: 'SetupDiOpenDevRegKey', nargs: 6 },
  { name: 'SetupDiOpenDeviceInterfaceW', nargs: 4 },
  { name: 'RegisterDeviceNotificationW', nargs: 3 },
  { name: 'UnregisterDeviceNotification', nargs: 1 },
  // USER32 — rect subtraction used by Task Manager update-region math
  { name: 'SubtractRect', nargs: 3 },
  // USER32 — keyboard layout lookup (Tetravex asks before GetKeyState dispatch)
  { name: 'GetKeyboardLayout', nargs: 1 },
  // USER32 — ANSI/Unicode window probe. Win9x/VCL ANSI windows expect FALSE.
  { name: 'IsWindowUnicode', nargs: 1 },
  // KERNEL32 — Telnet sets thread locale at startup; accept & ignore
  { name: 'SetThreadLocale', nargs: 1 },
  // GDI32 — region builders + queries (exact polygon clip + GetRgnBox).
  { name: 'CreateEllipticRgn', nargs: 4 },
  { name: 'GetRgnBox', nargs: 2 },
  // MSVCRT — binary search with guest-callback comparator (CACA000C continuation).
  { name: 'bsearch', nargs: 5 },
  // WINMM — RIFF file seek used by RCT after the 16-bit POP decoder fix.
  { name: 'mmioSeek', nargs: 3 },
];
for (const api of extra) {
  if (!seen.has(api.name)) {
    existing.push({ id: existing.length, name: api.name, nargs: api.nargs, convention: api.convention || 'stdcall', hash: 0 });
    seen.add(api.name);
  }
}

// Pull Direct3D Immediate Mode methods from shared spec (used by gen_d3dim_stubs.js too)
const { interfaces: d3dimIfaces } = require('./d3dim-methods');
for (const iface of d3dimIfaces) {
  for (const m of iface.methods) {
    const fullName = iface.prefix + '_' + m.name;
    if (!seen.has(fullName)) {
      // Use 5 here to match the existing IDirect3D{,3,Device3,Viewport3,...}
      // convention — handlers are wired with 5-arg + name_ptr signature.
      existing.push({ id: existing.length, name: fullName, nargs: 5, convention: 'stdcall', hash: 0 });
      seen.add(fullName);
    }
  }
}

// Reassign IDs and recompute hashes; preserve args/ret/any other metadata.
const table = existing.map((api, id) => {
  const out = {
    id,
    name: api.name,
    nargs: api.nargs,
    convention: api.convention || 'stdcall',
    hash: fnv1a(api.name),
  };
  if (api.args) out.args = api.args;
  if (api.ret) out.ret = api.ret;
  return out;
});

// Check for hash collisions
const hashMap = new Map();
for (const entry of table) {
  if (hashMap.has(entry.hash)) {
    console.error(`COLLISION: ${entry.name} and ${hashMap.get(entry.hash)} have same hash 0x${entry.hash.toString(16)}`);
    process.exit(1);
  }
  hashMap.set(entry.hash, entry.name);
}

// Write api_table.json
fs.writeFileSync(jsonPath, JSON.stringify(table, null, 2) + '\n');
console.log(`Generated ${jsonPath} with ${table.length} APIs`);

// Generate WAT data segment
const HASH_TABLE_ADDR = 0x00004000; // must match $API_HASH_TABLE in 01-header.wat
let watData = `  ;; Static API hash table: ${table.length} entries at 0x${HASH_TABLE_ADDR.toString(16).padStart(8,'0')}\n`;
watData += `  ;; Generated by tools/gen_api_table.js — do not edit by hand\n`;
watData += `  (data (i32.const 0x${HASH_TABLE_ADDR.toString(16).padStart(8,'0')})\n`;
for (const entry of table) {
  const hBytes = Buffer.alloc(4); hBytes.writeUInt32LE(entry.hash);
  const iBytes = Buffer.alloc(4); iBytes.writeUInt32LE(entry.id);
  const hHex = [...hBytes].map(b => '\\' + b.toString(16).padStart(2, '0')).join('');
  const iHex = [...iBytes].map(b => '\\' + b.toString(16).padStart(2, '0')).join('');
  watData += `    "${hHex}${iHex}"  ;; ${entry.id}: ${entry.name}\n`;
}
watData += `  )\n`;
watData += `  (global $API_HASH_COUNT i32 (i32.const ${table.length}))\n`;

const watPath = path.join(__dirname, '..', 'src', '01b-api-hashes.generated.wat');
fs.writeFileSync(watPath, watData);
console.log(`Generated ${watPath}`);
console.log(`Hash collisions: 0`);
console.log(`Data segment size: ${table.length * 8} bytes`);
