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
  { name: 'GlobalSize', nargs: 1 },
  { name: 'GlobalCompact', nargs: 1 },
  { name: 'RegOpenKeyA', nargs: 3 },
  { name: 'RegOpenKeyExA', nargs: 5 },
  { name: 'MessageBeep', nargs: 1 },
  { name: 'SetMenuItemInfoA', nargs: 4 },
  { name: 'GetMenuItemInfoA', nargs: 4 },
  { name: 'CascadeWindows', nargs: 5 },
  { name: 'TileWindows', nargs: 5 },
  { name: 'ArrangeIconicWindows', nargs: 1 },
  // APIs with multi-name comments (not caught by single-name regex)
  { name: 'RegisterClassExA', nargs: 1 },
  { name: 'RegisterClassA', nargs: 1 },
  { name: 'BeginPaint', nargs: 2 },
  { name: 'OpenClipboard', nargs: 1 },
  { name: 'CloseClipboard', nargs: 0 },
  { name: 'EmptyClipboard', nargs: 0 },
  { name: 'SetClipboardData', nargs: 2 },
  { name: 'GetClipboardOwner', nargs: 0 },
  { name: 'IsClipboardFormatAvailable', nargs: 1 },
  { name: 'GetEnvironmentStringsW', nargs: 0 },
  { name: 'GetSaveFileNameA', nargs: 1 },
  { name: 'ReplaceTextA', nargs: 1 },
  { name: 'EnumDateFormatsA', nargs: 3 },
  { name: 'EnumTimeFormatsA', nargs: 3 },
  { name: 'EnumResourceLanguagesW', nargs: 5 },
  { name: 'CreateDialogIndirectParamA', nargs: 5 },
  { name: 'SetViewportExtEx', nargs: 4 },
  { name: 'lstrcmpiA', nargs: 2 },
  { name: 'FreeEnvironmentStringsA', nargs: 1 },
  { name: 'FreeEnvironmentStringsW', nargs: 1 },
  { name: 'GetVersion', nargs: 0 },
  { name: 'GetTextExtentPoint32A', nargs: 4 },
  { name: 'EnumFontFamiliesExA', nargs: 5 },
  { name: 'EnumFontFamiliesA', nargs: 4 },
  { name: 'wsprintfA', nargs: -1, convention: 'cdecl', args: [
    { name: 'buffer', type: 'LPSTR' },
    { name: 'format', type: 'LPCSTR' },
  ] },  // varargs, handled specially
  { name: 'GetPrivateProfileStringA', nargs: 6 },
  { name: 'GetProfileStringW', nargs: 5 },
  { name: 'GetProfileSectionA', nargs: 3 },
  { name: 'PaintRgn', nargs: 2 },
  { name: 'FrameRgn', nargs: 5 },
  { name: 'CharUpperA', nargs: 1 },
  { name: 'CharLowerA', nargs: 1 },
  { name: 'CharLowerBuffA', nargs: 2 },
  { name: 'ImmAssociateContext', nargs: 2 },
  { name: 'ImmNotifyIME', nargs: 4 },
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
  { name: '_strupr', nargs: 1, convention: 'cdecl' },
  { name: '_fullpath', nargs: 3, convention: 'cdecl' },
  { name: 'qsort', nargs: 4, convention: 'cdecl' },
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
  { name: 'LoadImageW', nargs: 6 },
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
  { name: 'GetOpenFileNameW', nargs: 1 },
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
  { name: 'GetRunningObjectTable', nargs: 2 },
  { name: 'CreateBindCtx', nargs: 2 },
  { name: 'CreateFileMoniker', nargs: 2 },
  { name: 'CreateILockBytesOnHGlobal', nargs: 3 },
  { name: 'StgIsStorageFile', nargs: 1 },
  { name: 'StgOpenStorage', nargs: 6 },
  { name: 'StgCreateDocfile', nargs: 4 },
  { name: 'StgOpenStorageOnILockBytes', nargs: 6 },
  { name: 'StgCreateDocfileOnILockBytes', nargs: 4 },
  { name: 'ReadClassStg', nargs: 2 },
  { name: 'ReleaseStgMedium', nargs: 1 },
  { name: 'OleSetClipboard', nargs: 1 },
  { name: 'OleGetClipboard', nargs: 1 },
  { name: 'OleFlushClipboard', nargs: 0 },
  { name: 'OleIsCurrentClipboard', nargs: 1 },
  { name: 'CoDisconnectObject', nargs: 2 },
  { name: 'CreateStreamOnHGlobal', nargs: 3 },
  { name: 'GetHGlobalFromStream', nargs: 2 },
  { name: 'GetHGlobalFromILockBytes', nargs: 2 },
  { name: 'OleCreateDefaultHandler', nargs: 4 },
  { name: 'OleCreateStaticFromData', nargs: 7 },
  { name: 'OleSetContainedObject', nargs: 2 },
  { name: 'OleRegGetUserType', nargs: 3 },
  { name: 'OleRegGetMiscStatus', nargs: 3 },
  { name: 'OleUIUpdateLinksA', nargs: 4 },
  { name: 'OleDraw', nargs: 4 },
  { name: 'CreateMetaFileA', nargs: 1 },
  { name: 'CopyMetaFileA', nargs: 2 },
  { name: 'IRunningObjectTable_QueryInterface', nargs: 3 },
  { name: 'IRunningObjectTable_AddRef', nargs: 1 },
  { name: 'IRunningObjectTable_Release', nargs: 1 },
  { name: 'IRunningObjectTable_Register', nargs: 5 },
  { name: 'IRunningObjectTable_Revoke', nargs: 2 },
  { name: 'IRunningObjectTable_IsRunning', nargs: 2 },
  { name: 'IRunningObjectTable_GetObject', nargs: 3 },
  { name: 'IRunningObjectTable_NoteChangeTime', nargs: 3 },
  { name: 'IRunningObjectTable_GetTimeOfLastChange', nargs: 3 },
  { name: 'IRunningObjectTable_EnumRunning', nargs: 2 },
  // IEnumMoniker is a stable snapshot of ROT registrations.
  { name: 'IEnumMoniker_QueryInterface', nargs: 3 },
  { name: 'IEnumMoniker_AddRef', nargs: 1 },
  { name: 'IEnumMoniker_Release', nargs: 1 },
  { name: 'IEnumMoniker_Next', nargs: 4 },
  { name: 'IEnumMoniker_Skip', nargs: 2 },
  { name: 'IEnumMoniker_Reset', nargs: 1 },
  { name: 'IEnumMoniker_Clone', nargs: 2 },
  // IMoniker inherits IUnknown, IPersist and IPersistStream. Keep this block
  // in exact COM vtable order; gen_dispatch.js consumes the contiguous IDs.
  { name: 'IMoniker_QueryInterface', nargs: 3 },
  { name: 'IMoniker_AddRef', nargs: 1 },
  { name: 'IMoniker_Release', nargs: 1 },
  { name: 'IMoniker_GetClassID', nargs: 2 },
  { name: 'IMoniker_IsDirty', nargs: 1 },
  { name: 'IMoniker_Load', nargs: 2 },
  { name: 'IMoniker_Save', nargs: 3 },
  { name: 'IMoniker_GetSizeMax', nargs: 2 },
  { name: 'IMoniker_BindToObject', nargs: 5 },
  { name: 'IMoniker_BindToStorage', nargs: 5 },
  { name: 'IMoniker_Reduce', nargs: 5 },
  { name: 'IMoniker_ComposeWith', nargs: 4 },
  { name: 'IMoniker_Enum', nargs: 3 },
  { name: 'IMoniker_IsEqual', nargs: 2 },
  { name: 'IMoniker_Hash', nargs: 2 },
  { name: 'IMoniker_IsRunning', nargs: 4 },
  { name: 'IMoniker_GetTimeOfLastChange', nargs: 4 },
  { name: 'IMoniker_Inverse', nargs: 2 },
  { name: 'IMoniker_CommonPrefixWith', nargs: 3 },
  { name: 'IMoniker_RelativePathTo', nargs: 3 },
  { name: 'IMoniker_GetDisplayName', nargs: 4 },
  { name: 'IMoniker_ParseDisplayName', nargs: 6 },
  { name: 'IMoniker_IsSystemMoniker', nargs: 2 },
  // IBindCtx and its string-key enumerator. Keep each interface contiguous in
  // exact COM vtable order; gen_dispatch.js builds callable guest vtables.
  { name: 'IBindCtx_QueryInterface', nargs: 3 },
  { name: 'IBindCtx_AddRef', nargs: 1 },
  { name: 'IBindCtx_Release', nargs: 1 },
  { name: 'IBindCtx_RegisterObjectBound', nargs: 2 },
  { name: 'IBindCtx_RevokeObjectBound', nargs: 2 },
  { name: 'IBindCtx_ReleaseBoundObjects', nargs: 1 },
  { name: 'IBindCtx_SetBindOptions', nargs: 2 },
  { name: 'IBindCtx_GetBindOptions', nargs: 2 },
  { name: 'IBindCtx_GetRunningObjectTable', nargs: 2 },
  { name: 'IBindCtx_RegisterObjectParam', nargs: 3 },
  { name: 'IBindCtx_GetObjectParam', nargs: 3 },
  { name: 'IBindCtx_EnumObjectParam', nargs: 2 },
  { name: 'IBindCtx_RevokeObjectParam', nargs: 2 },
  { name: 'IEnumString_QueryInterface', nargs: 3 },
  { name: 'IEnumString_AddRef', nargs: 1 },
  { name: 'IEnumString_Release', nargs: 1 },
  { name: 'IEnumString_Next', nargs: 4 },
  { name: 'IEnumString_Skip', nargs: 2 },
  { name: 'IEnumString_Reset', nargs: 1 },
  { name: 'IEnumString_Clone', nargs: 2 },
  // GDI extras
  { name: 'AbortPath', nargs: 1 },
  { name: 'BeginPath', nargs: 1 },
  { name: 'CloseFigure', nargs: 1 },
  { name: 'EndPath', nargs: 1 },
  { name: 'GetPath', nargs: 4 },
  { name: 'PathToRegion', nargs: 1 },
  { name: 'FlattenPath', nargs: 1 },
  { name: 'FillPath', nargs: 1 },
  { name: 'StrokePath', nargs: 1 },
  { name: 'StrokeAndFillPath', nargs: 1 },
  { name: 'WidenPath', nargs: 1, args: [
    { name: 'hdc', type: 'HDC' },
  ], ret: 'BOOL' },
  { name: 'AngleArc', nargs: 6, args: [
    { name: 'hdc', type: 'HDC' },
    { name: 'x', type: 'INT' },
    { name: 'y', type: 'INT' },
    { name: 'radius', type: 'DWORD' },
    { name: 'startAngle', type: 'FLOAT' },
    { name: 'sweepAngle', type: 'FLOAT' },
  ], ret: 'BOOL' },
  { name: 'Chord', nargs: 9, args: [
    { name: 'hdc', type: 'HDC' },
    { name: 'left', type: 'INT' }, { name: 'top', type: 'INT' },
    { name: 'right', type: 'INT' }, { name: 'bottom', type: 'INT' },
    { name: 'xRadial1', type: 'INT' }, { name: 'yRadial1', type: 'INT' },
    { name: 'xRadial2', type: 'INT' }, { name: 'yRadial2', type: 'INT' },
  ], ret: 'BOOL' },
  { name: 'Pie', nargs: 9, args: [
    { name: 'hdc', type: 'HDC' },
    { name: 'left', type: 'INT' }, { name: 'top', type: 'INT' },
    { name: 'right', type: 'INT' }, { name: 'bottom', type: 'INT' },
    { name: 'xRadial1', type: 'INT' }, { name: 'yRadial1', type: 'INT' },
    { name: 'xRadial2', type: 'INT' }, { name: 'yRadial2', type: 'INT' },
  ], ret: 'BOOL' },
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
  { name: 'wsprintfW', nargs: -1, convention: 'cdecl', args: [
    { name: 'buffer', type: 'LPWSTR' },
    { name: 'format', type: 'LPCWSTR' },
  ] },
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
  { name: 'IDirectInputDevice_EnumObjects', nargs: 4 },
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
  { name: 'midiStreamPause', nargs: 1 },
  { name: 'midiOutUnprepareHeader', nargs: 3 },
  { name: 'midiStreamClose', nargs: 1 },
  { name: 'midiStreamOpen', nargs: 6 },
  { name: 'midiStreamProperty', nargs: 3 },
  { name: 'midiOutPrepareHeader', nargs: 3 },
  { name: 'midiStreamOut', nargs: 3 },
  { name: 'midiStreamRestart', nargs: 1 },
  { name: 'OpenMutexA', nargs: 3 },
  { name: 'CreateMutexA', nargs: 3 },
  { name: 'OpenSemaphoreA', nargs: 3 },
  { name: 'joyGetPos', nargs: 2 },
  { name: 'joyGetNumDevs', nargs: 0 },
  { name: 'CoInitializeEx', nargs: 2 },
  { name: 'joyGetDevCapsA', nargs: 3 },
  { name: 'joySetCapture', nargs: 4 },
  { name: 'joyReleaseCapture', nargs: 1 },
  { name: 'SetProcessWorkingSetSize', nargs: 3 },
  { name: 'WaitMessage', nargs: 0 },
  // VERSION.DLL APIs
  { name: 'GetFileVersionInfoSizeA', nargs: 2 },
  { name: 'GetFileVersionInfoA', nargs: 4 },
  { name: 'VerQueryValueA', nargs: 4 },
  // DirectDraw enumeration
  { name: 'DirectDrawEnumerateA', nargs: 2 },
  { name: 'EnumWindows', nargs: 2 },
  { name: 'EnumThreadWindows', nargs: 3 },
  { name: 'EnumSystemCodePagesA', nargs: 2 },
  { name: 'LocalSize', nargs: 1 },
  { name: 'LoadLibraryExA', nargs: 3 },
  { name: 'DdeInitializeA', nargs: 4 },
  { name: 'DdeCreateStringHandleA', nargs: 3 },
  { name: 'DdeNameService', nargs: 4 },
  { name: 'DdeFreeStringHandle', nargs: 2 },
  { name: 'DdeUninitialize', nargs: 1 },
  { name: 'DosDateTimeToFileTime', nargs: 3 },
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
  // OLE compound-document foundations. Keep each interface contiguous: the
  // generated COM vtable builder relies on method order matching the ABI.
  { name: 'ILockBytes_QueryInterface', nargs: 3 },
  { name: 'ILockBytes_AddRef', nargs: 1 },
  { name: 'ILockBytes_Release', nargs: 1 },
  { name: 'ILockBytes_ReadAt', nargs: 6 },
  { name: 'ILockBytes_WriteAt', nargs: 6 },
  { name: 'ILockBytes_Flush', nargs: 1 },
  { name: 'ILockBytes_SetSize', nargs: 3 },
  { name: 'ILockBytes_LockRegion', nargs: 6 },
  { name: 'ILockBytes_UnlockRegion', nargs: 6 },
  { name: 'ILockBytes_Stat', nargs: 3 },
  { name: 'IStream_QueryInterface', nargs: 3 },
  { name: 'IStream_AddRef', nargs: 1 },
  { name: 'IStream_Release', nargs: 1 },
  { name: 'IStream_Read', nargs: 4 },
  { name: 'IStream_Write', nargs: 4 },
  { name: 'IStream_Seek', nargs: 5 },
  { name: 'IStream_SetSize', nargs: 3 },
  { name: 'IStream_CopyTo', nargs: 6 },
  { name: 'IStream_Commit', nargs: 2 },
  { name: 'IStream_Revert', nargs: 1 },
  { name: 'IStream_LockRegion', nargs: 6 },
  { name: 'IStream_UnlockRegion', nargs: 6 },
  { name: 'IStream_Stat', nargs: 3 },
  { name: 'IStream_Clone', nargs: 2 },
  { name: 'IStorage_QueryInterface', nargs: 3 },
  { name: 'IStorage_AddRef', nargs: 1 },
  { name: 'IStorage_Release', nargs: 1 },
  { name: 'IStorage_CreateStream', nargs: 6 },
  { name: 'IStorage_OpenStream', nargs: 6 },
  { name: 'IStorage_CreateStorage', nargs: 6 },
  { name: 'IStorage_OpenStorage', nargs: 7 },
  { name: 'IStorage_CopyTo', nargs: 5 },
  { name: 'IStorage_MoveElementTo', nargs: 5 },
  { name: 'IStorage_Commit', nargs: 2 },
  { name: 'IStorage_Revert', nargs: 1 },
  { name: 'IStorage_EnumElements', nargs: 5 },
  { name: 'IStorage_DestroyElement', nargs: 2 },
  { name: 'IStorage_RenameElement', nargs: 3 },
  { name: 'IStorage_SetElementTimes', nargs: 5 },
  { name: 'IStorage_SetClass', nargs: 2 },
  { name: 'IStorage_SetStateBits', nargs: 3 },
  { name: 'IStorage_Stat', nargs: 3 },
  { name: 'IDataObject_QueryInterface', nargs: 3 },
  { name: 'IDataObject_AddRef', nargs: 1 },
  { name: 'IDataObject_Release', nargs: 1 },
  { name: 'IDataObject_GetData', nargs: 3 },
  { name: 'IDataObject_GetDataHere', nargs: 3 },
  { name: 'IDataObject_QueryGetData', nargs: 2 },
  { name: 'IDataObject_GetCanonicalFormatEtc', nargs: 3 },
  { name: 'IDataObject_SetData', nargs: 4 },
  { name: 'IDataObject_EnumFormatEtc', nargs: 3 },
  { name: 'IDataObject_DAdvise', nargs: 5 },
  { name: 'IDataObject_DUnadvise', nargs: 2 },
  { name: 'IDataObject_EnumDAdvise', nargs: 2 },
  { name: 'IEnumFORMATETC_QueryInterface', nargs: 3 },
  { name: 'IEnumFORMATETC_AddRef', nargs: 1 },
  { name: 'IEnumFORMATETC_Release', nargs: 1 },
  { name: 'IEnumFORMATETC_Next', nargs: 4 },
  { name: 'IEnumFORMATETC_Skip', nargs: 2 },
  { name: 'IEnumFORMATETC_Reset', nargs: 1 },
  { name: 'IEnumFORMATETC_Clone', nargs: 2 },
  { name: 'IOleObject_QueryInterface', nargs: 3 },
  { name: 'IOleObject_AddRef', nargs: 1 },
  { name: 'IOleObject_Release', nargs: 1 },
  { name: 'IOleObject_SetClientSite', nargs: 2 },
  { name: 'IOleObject_GetClientSite', nargs: 2 },
  { name: 'IOleObject_SetHostNames', nargs: 3 },
  { name: 'IOleObject_Close', nargs: 2 },
  { name: 'IOleObject_SetMoniker', nargs: 3 },
  { name: 'IOleObject_GetMoniker', nargs: 4 },
  { name: 'IOleObject_InitFromData', nargs: 4 },
  { name: 'IOleObject_GetClipboardData', nargs: 3 },
  { name: 'IOleObject_DoVerb', nargs: 7 },
  { name: 'IOleObject_EnumVerbs', nargs: 2 },
  { name: 'IOleObject_Update', nargs: 1 },
  { name: 'IOleObject_IsUpToDate', nargs: 1 },
  { name: 'IOleObject_GetUserClassID', nargs: 2 },
  { name: 'IOleObject_GetUserType', nargs: 3 },
  { name: 'IOleObject_SetExtent', nargs: 3 },
  { name: 'IOleObject_GetExtent', nargs: 3 },
  { name: 'IOleObject_Advise', nargs: 3 },
  { name: 'IOleObject_Unadvise', nargs: 2 },
  { name: 'IOleObject_EnumAdvise', nargs: 2 },
  { name: 'IOleObject_GetMiscStatus', nargs: 3 },
  { name: 'IOleObject_SetColorScheme', nargs: 2 },
  { name: 'IPersistStorage_QueryInterface', nargs: 3 },
  { name: 'IPersistStorage_AddRef', nargs: 1 },
  { name: 'IPersistStorage_Release', nargs: 1 },
  { name: 'IPersistStorage_GetClassID', nargs: 2 },
  { name: 'IPersistStorage_IsDirty', nargs: 1 },
  { name: 'IPersistStorage_InitNew', nargs: 2 },
  { name: 'IPersistStorage_Load', nargs: 2 },
  { name: 'IPersistStorage_Save', nargs: 3 },
  { name: 'IPersistStorage_SaveCompleted', nargs: 2 },
  { name: 'IPersistStorage_HandsOffStorage', nargs: 1 },
  { name: 'IOleCache_QueryInterface', nargs: 3 },
  { name: 'IOleCache_AddRef', nargs: 1 },
  { name: 'IOleCache_Release', nargs: 1 },
  { name: 'IOleCache_Cache', nargs: 4 },
  { name: 'IOleCache_Uncache', nargs: 2 },
  { name: 'IOleCache_EnumCache', nargs: 2 },
  { name: 'IOleCache_InitCache', nargs: 2 },
  { name: 'IOleCache_SetData', nargs: 4 },
  { name: 'IViewObject_QueryInterface', nargs: 3 },
  { name: 'IViewObject_AddRef', nargs: 1 },
  { name: 'IViewObject_Release', nargs: 1 },
  { name: 'IViewObject_Draw', nargs: 11 },
  { name: 'IViewObject_GetColorSet', nargs: 7 },
  { name: 'IViewObject_Freeze', nargs: 5 },
  { name: 'IViewObject_Unfreeze', nargs: 2 },
  { name: 'IViewObject_SetAdvise', nargs: 4 },
  { name: 'IViewObject_GetAdvise', nargs: 4 },
  { name: 'IViewObject2_GetExtent', nargs: 5 },
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
  { name: 'DirectPlayCreate', nargs: 3 },
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
  { name: 'mciSendStringW', nargs: 4, args: [
    { name: 'command', type: 'LPCWSTR' },
    { name: 'returnBuffer', type: 'LPWSTR' },
    { name: 'returnLength', type: 'UINT' },
    { name: 'callback', type: 'HWND' },
  ], ret: 'DWORD' },
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
  // USER32 — Task Manager filters renderer-wide task windows by class.
  { name: 'GetClassNameA', nargs: 3 },
  // USER32 — Task Manager's Switch To command activates the selected task.
  { name: 'SwitchToThisWindow', nargs: 2 },
  // USER32 — Task Manager minimizes itself after switching when configured.
  { name: 'CloseWindow', nargs: 1 },
  // KERNEL32 — Task Manager interns each enumerated window class.
  { name: 'AddAtomA', nargs: 1 },
  { name: 'DeleteAtom', nargs: 1 },
  // USER32 — cosmetic selection animation used by Win98 RegEdit.
  { name: 'DrawAnimatedRects', nargs: 4 },
  { name: 'RegEnumValueA', nargs: 8 },
  { name: 'RegEnumValueW', nargs: 8 },
  { name: 'RegQueryInfoKeyA', nargs: 12 },
  { name: 'RegQueryInfoKeyW', nargs: 12 },
  // USER32 — keyboard layout lookup (Tetravex asks before GetKeyState dispatch)
  { name: 'GetKeyboardLayout', nargs: 1 },
  // USER32 — ANSI/Unicode window probe. Win9x/VCL ANSI windows expect FALSE.
  { name: 'IsWindowUnicode', nargs: 1 },
  // KERNEL32 — Telnet sets thread locale at startup; accept & ignore
  { name: 'SetThreadLocale', nargs: 1 },
  // GDI32 — region builders + queries (exact polygon clip + GetRgnBox).
  { name: 'CreateEllipticRgn', nargs: 4 },
  { name: 'GetRgnBox', nargs: 2 },
  // GDI32 — callback/state APIs. LineDDA historically had the wrong five-
  // argument metadata; keep its six-argument ABI explicit here.
  { name: 'LineDDA', nargs: 6 },
  { name: 'GetColorAdjustment', nargs: 2 },
  // GDI32 public bitmap/region surface imported by the checked-in PE corpus.
  { name: 'CreateBitmapIndirect', nargs: 1 },
  { name: 'CreatePolyPolygonRgn', nargs: 4 },
  { name: 'CreateRoundRectRgn', nargs: 6 },
  { name: 'GetBitmapBits', nargs: 3 },
  { name: 'GetBitmapDimensionEx', nargs: 2 },
  { name: 'GetBrushOrgEx', nargs: 2 },
  { name: 'GetRegionData', nargs: 3 },
  { name: 'MaskBlt', nargs: 12 },
  { name: 'PtInRegion', nargs: 3 },
  { name: 'SetBitmapBits', nargs: 3 },
  // GDI32 public state/palette/pixel-format surface.
  { name: 'AnimatePalette', nargs: 4 },
  { name: 'ChoosePixelFormat', nargs: 2 },
  { name: 'DescribePixelFormat', nargs: 4 },
  { name: 'GdiSetBatchLimit', nargs: 1 },
  { name: 'GetGraphicsMode', nargs: 1 },
  { name: 'GetPixelFormat', nargs: 1 },
  { name: 'GetSystemPaletteUse', nargs: 1 },
  { name: 'SetDeviceGammaRamp', nargs: 2 },
  { name: 'SetGraphicsMode', nargs: 2 },
  { name: 'SetPixelFormat', nargs: 3 },
  { name: 'SwapBuffers', nargs: 1 },
  // GDI32 text/font compatibility implemented around the Canvas text policy.
  { name: 'AddFontResourceA', nargs: 1 },
  { name: 'EnumFontsA', nargs: 4 },
  { name: 'GetCharABCWidthsA', nargs: 4 },
  { name: 'GetFontData', nargs: 5 },
  { name: 'GetGlyphOutlineA', nargs: 7 },
  { name: 'GetTextExtentExPointA', nargs: 7 },
  { name: 'GetTextExtentExPointW', nargs: 7 },
  { name: 'RemoveFontResourceA', nargs: 1 },
  // GDI32 metafile transport, ICM profile, and DC reset compatibility.
  { name: 'CopyEnhMetaFileA', nargs: 2 },
  { name: 'DeleteEnhMetaFile', nargs: 1 },
  { name: 'GetEnhMetaFileBits', nargs: 3 },
  { name: 'GetEnhMetaFileHeader', nargs: 3 },
  { name: 'GetEnhMetaFilePaletteEntries', nargs: 3 },
  { name: 'GetICMProfileA', nargs: 3 },
  { name: 'GetMetaFileBitsEx', nargs: 3 },
  { name: 'GetWinMetaFileBits', nargs: 5 },
  { name: 'PlayEnhMetaFile', nargs: 3 },
  { name: 'ResetDCA', nargs: 2 },
  { name: 'SetEnhMetaFileBits', nargs: 2 },
  { name: 'SetMetaFileBitsEx', nargs: 2 },
  { name: 'SetWinMetaFileBits', nargs: 4 },
  // OLE32 — structured-storage element enumerator.
  { name: 'IEnumSTATSTG_QueryInterface', nargs: 3 },
  { name: 'IEnumSTATSTG_AddRef', nargs: 1 },
  { name: 'IEnumSTATSTG_Release', nargs: 1 },
  { name: 'IEnumSTATSTG_Next', nargs: 4 },
  { name: 'IEnumSTATSTG_Skip', nargs: 2 },
  { name: 'IEnumSTATSTG_Reset', nargs: 1 },
  { name: 'IEnumSTATSTG_Clone', nargs: 2 },
  // MSVCRT — binary search with guest-callback comparator (CACA000C continuation).
  { name: 'bsearch', nargs: 5 },
  // LZ32 — transparent reads of ordinary (non-SZDD) files.
  { name: 'LZOpenFileA', nargs: 3 },
  { name: 'LZRead', nargs: 3 },
  { name: 'LZSeek', nargs: 3 },
  { name: 'LZClose', nargs: 1 },
  // WINMM — RIFF file seek used by RCT after the 16-bit POP decoder fix.
  { name: 'mmioSeek', nargs: 3 },
  // KERNEL32/USER32 — the halves of the atom API that had no entry at all.
  // Delphi's VCL calls GlobalFindAtomA on every window activation, so a
  // missing entry resolved to api_id 0xFFFF and trapped (Tetravex).
  { name: 'GlobalFindAtomA', nargs: 1 },
  { name: 'GlobalGetAtomNameA', nargs: 3 },
  { name: 'AddAtomW', nargs: 1 },
  { name: 'GetAtomNameA', nargs: 3 },
  { name: 'GetAtomNameW', nargs: 3 },
  // nargs corrections found by tools/check-handler-esp.js — the handlers pop
  // the right frame, the table was under-counting, which mis-decodes traces.
  { name: 'SetDIBits', nargs: 7 },
  { name: 'DirectDrawEnumerateExA', nargs: 3 },
  // OLEAUT32 — Kodak Imaging imports these by ordinal.
  { name: 'VariantInit', nargs: 1 },
  { name: 'VariantCopy', nargs: 2 },
  // MSVCRT — Kodak Preview asks where it is running from.
  { name: '_getcwd', nargs: 2, convention: 'cdecl' },
  // MSVCRT — integer to string. Kodak Preview formats its page numbers with it.
  { name: '_itoa', nargs: 3, convention: 'cdecl' },
  { name: '_ltoa', nargs: 3, convention: 'cdecl' },
  // KERNEL32 — named shared sections. Kodak Imaging and Preview use one to
  // discover each other; without OpenFileMapping the lookup traps.
  { name: 'OpenFileMappingA', nargs: 3 },
  { name: 'OpenFileMappingW', nargs: 3 },
  // MSVCRT — cdplayer.exe parses its disc database with sscanf.
  { name: 'sscanf', nargs: 2, convention: 'cdecl' },
  // USER32 — Win95-era menu item insertion; winamp.exe calls it while
  // building its playlist menu.
  { name: 'InsertMenuItemA', nargs: 4 },
  { name: 'InsertMenuItemW', nargs: 4 },
  // MSVCRT — C++ operator new/delete, scalar and array forms. winamp.exe
  // imports ??2/??3 directly; the NSIS installers reach them through a DLL.
  { name: '??2@YAPAXI@Z', nargs: 1, convention: 'cdecl' },
  { name: '??3@YAXPAX@Z', nargs: 1, convention: 'cdecl' },
  { name: '??_U@YAPAXI@Z', nargs: 1, convention: 'cdecl' },
  { name: '??_V@YAXPAX@Z', nargs: 1, convention: 'cdecl' },
];
for (const api of extra) {
  if (!seen.has(api.name)) {
    existing.push({ id: existing.length, ...api, convention: api.convention || 'stdcall', hash: 0 });
    seen.add(api.name);
  } else if (api.nargs !== undefined || api.args || api.ret || api.convention) {
    const current = existing.find(entry => entry.name === api.name);
    if (api.nargs !== undefined) current.nargs = api.nargs;
    if (api.args) current.args = api.args;
    if (api.ret) current.ret = api.ret;
    if (api.convention) current.convention = api.convention;
  }
}

// The Microsoft C runtime exports below use cdecl on x86: handlers pop only
// the return address and callers remove arguments. Keep this explicit because
// the table's historical default is stdcall (appropriate for Win32 APIs, but
// stack-corrupting for CRT calls such as _controlfp and _initterm).
const cdeclCrtApis = new Set([
  '?terminate@@YAXXZ',
  '??2@YAPAXI@Z', '??3@YAXPAX@Z', '??_U@YAPAXI@Z', '??_V@YAXPAX@Z',
  '_XcptFilter', '__CxxFrameHandler', '__GetMainArgs', '__dllonexit',
  '__getmainargs', '__p__acmdln', '__p__commode', '__p__fmode', '__p__wcmdln',
  '__set_app_type', '__setusermatherr', '__wgetmainargs', '_adjust_fdiv',
  '_controlfp', '_exit', '_ftol', '_fullpath', '_getcwd', '_getdcwd', '_global_unwind2', '_initterm',
  '_itoa', '_itow', '_ltoa', '_mbschr', '_mbsinc', '_mbsnbcmp', '_mbsrchr', '_onexit',
  '_purecall', '_splitpath', '_strdup', '_stricmp', '_strlwr', '_strrev',
  '_wcsicmp', '_wtoi',
  'atoi', 'atol', 'bsearch', 'calloc', 'exit', 'free', 'malloc', 'memcpy',
  'memmove', 'memset', 'rand', 'realloc', 'sprintf', 'sscanf', 'srand', 'strcat',
  'strchr', 'strcmp', 'strcpy', 'strlen', 'strncpy', 'strrchr', 'time', 'qsort',
  'toupper', 'wcscmp', 'wcslen', 'wcsncpy', 'wcsrchr', 'mbstowcs', 'wcstombs',
  'ceil', 'sqrt', 'sin', 'pow', '_CIpow',
]);
for (const api of existing) {
  if (cdeclCrtApis.has(api.name)) api.convention = 'cdecl';
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

const HASH_TABLE_ADDR = 0x07E00000; // must match $API_HASH_TABLE in 01-header.wat
const HASH_TABLE_SIZE = 0x00008000; // must match $API_HASH_TABLE_SIZE
if (table.length * 8 > HASH_TABLE_SIZE) {
  console.error(`API hash table needs ${table.length * 8} bytes, exceeds ${HASH_TABLE_SIZE}-byte region`);
  process.exit(1);
}

// Write api_table.json
fs.writeFileSync(jsonPath, JSON.stringify(table, null, 2) + '\n');
console.log(`Generated ${jsonPath} with ${table.length} APIs`);

// Generate WAT data segment
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
