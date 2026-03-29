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
  { name: 'lstrcmpW', nargs: 2 },
  { name: 'lstrcmpiW', nargs: 2 },
  { name: 'CharNextW', nargs: 1 },
  { name: 'wsprintfW', nargs: -1 },
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
let watData = `  ;; Static API hash table: ${table.length} entries at 0x00E62000\n`;
watData += `  ;; Generated by tools/gen_api_table.js — do not edit by hand\n`;
watData += `  (data (i32.const 0x00E62000)\n`;
for (const entry of table) {
  const hBytes = Buffer.alloc(4); hBytes.writeUInt32LE(entry.hash);
  const iBytes = Buffer.alloc(4); iBytes.writeUInt32LE(entry.id);
  const hHex = [...hBytes].map(b => '\\' + b.toString(16).padStart(2, '0')).join('');
  const iHex = [...iBytes].map(b => '\\' + b.toString(16).padStart(2, '0')).join('');
  watData += `    "${hHex}${iHex}"  ;; ${entry.id}: ${entry.name}\n`;
}
watData += `  )\n`;

const watPath = path.join(__dirname, '..', 'src', 'parts', '01b-api-hashes.wat');
fs.writeFileSync(watPath, watData);
console.log(`Generated ${watPath}`);
console.log(`Hash collisions: 0`);
console.log(`Data segment size: ${table.length * 8} bytes`);
