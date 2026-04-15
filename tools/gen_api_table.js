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

// Load existing table
let existing = [];
if (fs.existsSync(jsonPath)) {
  existing = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}
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
  // APIs with multi-name comments (not caught by single-name regex)
  { name: 'RegisterClassExA', nargs: 1 },
  { name: 'RegisterClassA', nargs: 1 },
  { name: 'BeginPaint', nargs: 2 },
  { name: 'OpenClipboard', nargs: 1 },
  { name: 'CloseClipboard', nargs: 0 },
  { name: 'IsClipboardFormatAvailable', nargs: 1 },
  { name: 'GetEnvironmentStringsW', nargs: 0 },
  { name: 'GetSaveFileNameA', nargs: 1 },
  { name: 'SetViewportExtEx', nargs: 4 },
  { name: 'lstrcmpiA', nargs: 2 },
  { name: 'FreeEnvironmentStringsA', nargs: 1 },
  { name: 'FreeEnvironmentStringsW', nargs: 1 },
  { name: 'GetVersion', nargs: 0 },
  { name: 'GetTextExtentPoint32A', nargs: 4 },
  { name: 'wsprintfA', nargs: -1 },  // varargs, handled specially
  { name: 'GetPrivateProfileStringA', nargs: 6 },
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
  { name: 'SetWindowLongW', nargs: 3 },
  { name: 'GetWindowLongW', nargs: 2 },
  { name: 'InitCommonControlsEx', nargs: 1 },
  // OLE32 minimal stubs
  { name: 'OleInitialize', nargs: 1 },
  { name: 'CoTaskMemFree', nargs: 1 },
  // GDI extras
  { name: 'SaveDC', nargs: 1 },
  { name: 'RestoreDC', nargs: 2 },
  { name: 'SetMapMode', nargs: 2 },
  { name: 'GetTextMetricsW', nargs: 2 },
  { name: 'CreateFontIndirectW', nargs: 1 },
  { name: 'SetStretchBltMode', nargs: 2 },
  { name: 'GetPixel', nargs: 3 },
  { name: 'SetPixel', nargs: 4 },
  { name: 'SetROP2', nargs: 2 },
  // String W-suffix
  { name: 'lstrlenW', nargs: 1 },
  { name: 'lstrcpyW', nargs: 2 },
  { name: 'lstrcpynW', nargs: 3 },
  { name: 'lstrcmpW', nargs: 2 },
  { name: 'lstrcmpiW', nargs: 2 },
  { name: 'CharNextW', nargs: 1 },
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
  // ADVAPI32 — returns a constant "user" string
  { name: 'GetUserNameA', nargs: 2 },
  // KERNEL32 — returns a constant "PC" string
  { name: 'GetComputerNameA', nargs: 2 },
  // DPLAYX — all return DPERR_UNAVAILABLE (0x80004005 E_FAIL); apps fall back to single-player.
  { name: 'DirectPlayCreate', nargs: 4 },
  { name: 'DirectPlayEnumerate', nargs: 2 },
  { name: 'DirectPlayEnumerateA', nargs: 2 },
  { name: 'DirectPlayLobbyCreateA', nargs: 5 },
  // DSOUND — enumerate = no-op (returns DS_OK with no callback invocations)
  { name: 'DirectSoundEnumerateA', nargs: 2 },
  // WINMM — MCI command string interface (MIDI/CDAudio). Stub returns MCIERR_NO_ERROR (0).
  { name: 'mciSendStringA', nargs: 4 },
];
for (const api of extra) {
  if (!seen.has(api.name)) {
    existing.push({ id: existing.length, name: api.name, nargs: api.nargs, convention: 'stdcall', hash: 0 });
    seen.add(api.name);
  }
}

// Reassign IDs and recompute hashes
const table = existing.map((api, id) => ({
  id,
  name: api.name,
  nargs: api.nargs,
  convention: api.convention || 'stdcall',
  hash: fnv1a(api.name),
}));

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
