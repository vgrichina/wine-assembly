#!/usr/bin/env node
// annotate_api_types.js — apply typed argument metadata to api_table.json.
//
// Idempotent: re-running with no spec changes is a no-op.
// Only entries listed in TYPED below get `args` / `ret` populated.
// Untyped entries in api_table.json are left alone, so --trace-api falls
// back to the legacy hex dump for them.

const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, '..', 'src', 'api_table.json');

// Each: name -> { args:[{name,type}], ret }
// Keep the list short and high-traffic; expand opportunistically.
const TYPED = {
  // — string / CRT —
  lstrlenA:        { args: [{ name: 'str', type: 'LPCSTR' }], ret: 'INT' },
  lstrlenW:        { args: [{ name: 'str', type: 'LPCWSTR' }], ret: 'INT' },
  lstrcpyA:        { args: [{ name: 'dst', type: 'LPSTR' }, { name: 'src', type: 'LPCSTR' }], ret: 'LPSTR' },
  lstrcpynA:       { args: [{ name: 'dst', type: 'LPSTR' }, { name: 'src', type: 'LPCSTR' }, { name: 'n', type: 'INT' }], ret: 'LPSTR' },
  lstrcatA:        { args: [{ name: 'dst', type: 'LPSTR' }, { name: 'src', type: 'LPCSTR' }], ret: 'LPSTR' },
  lstrcmpA:        { args: [{ name: 'a', type: 'LPCSTR' }, { name: 'b', type: 'LPCSTR' }], ret: 'INT' },
  lstrcmpiA:       { args: [{ name: 'a', type: 'LPCSTR' }, { name: 'b', type: 'LPCSTR' }], ret: 'INT' },
  OutputDebugStringA: { args: [{ name: 'str', type: 'LPCSTR' }] },

  // — module / library —
  LoadLibraryA:    { args: [{ name: 'name', type: 'LPCSTR' }], ret: 'HANDLE' },
  LoadLibraryExA:  { args: [{ name: 'name', type: 'LPCSTR' }, { name: 'file', type: 'HANDLE' }, { name: 'flags', type: 'DWORD' }], ret: 'HANDLE' },
  GetModuleHandleA:{ args: [{ name: 'name', type: 'LPCSTR' }], ret: 'HANDLE' },
  GetModuleFileNameA: { args: [{ name: 'mod', type: 'HANDLE' }, { name: 'buf', type: 'LPSTR', out: true }, { name: 'size', type: 'DWORD' }], ret: 'DWORD' },
  GetProcAddress:  { args: [{ name: 'mod', type: 'HANDLE' }, { name: 'name', type: 'LPCSTR' }], ret: 'HANDLE' },
  FreeLibrary:     { args: [{ name: 'mod', type: 'HANDLE' }], ret: 'BOOL' },

  // — file I/O —
  CreateFileA:     { args: [{ name: 'path', type: 'LPCSTR' }, { name: 'access', type: 'DWORD' }, { name: 'share', type: 'DWORD' }, { name: 'sa', type: 'DWORD' }, { name: 'creation', type: 'DWORD' }, { name: 'flags', type: 'DWORD' }, { name: 'tmpl', type: 'HANDLE' }], ret: 'HANDLE' },
  OpenFile:        { args: [{ name: 'path', type: 'LPCSTR' }, { name: 'ofs', type: 'DWORD' }, { name: 'flags', type: 'DWORD' }], ret: 'HANDLE' },
  DeleteFileA:     { args: [{ name: 'path', type: 'LPCSTR' }], ret: 'BOOL' },
  FindFirstFileA:  { args: [{ name: 'pattern', type: 'LPCSTR' }, { name: 'data', type: 'DWORD' }], ret: 'HANDLE' },
  GetFileAttributesA: { args: [{ name: 'path', type: 'LPCSTR' }], ret: 'DWORD' },
  SetFileAttributesA: { args: [{ name: 'path', type: 'LPCSTR' }, { name: 'attrs', type: 'DWORD' }], ret: 'BOOL' },
  MoveFileA:       { args: [{ name: 'src', type: 'LPCSTR' }, { name: 'dst', type: 'LPCSTR' }], ret: 'BOOL' },
  CopyFileA:       { args: [{ name: 'src', type: 'LPCSTR' }, { name: 'dst', type: 'LPCSTR' }, { name: 'failIfExists', type: 'BOOL' }], ret: 'BOOL' },
  CreateDirectoryA:{ args: [{ name: 'path', type: 'LPCSTR' }, { name: 'sa', type: 'DWORD' }], ret: 'BOOL' },
  RemoveDirectoryA:{ args: [{ name: 'path', type: 'LPCSTR' }], ret: 'BOOL' },

  // — windows / messages —
  RegisterClassA:  { args: [{ name: 'wc', type: 'LPWNDCLASSA' }], ret: 'UINT' },
  RegisterClassExA:{ args: [{ name: 'wcx', type: 'LPWNDCLASSA' }], ret: 'UINT' },
  CreateWindowExA: { args: [{ name: 'exStyle', type: 'DWORD' }, { name: 'class', type: 'LPCSTR' }, { name: 'title', type: 'LPCSTR' }, { name: 'style', type: 'flags:WS' }, { name: 'x', type: 'INT' }, { name: 'y', type: 'INT' }, { name: 'w', type: 'INT' }, { name: 'h', type: 'INT' }, { name: 'parent', type: 'HWND' }, { name: 'menu', type: 'HMENU' }, { name: 'hInst', type: 'HANDLE' }, { name: 'param', type: 'DWORD' }], ret: 'HWND' },
  ShowWindow:      { args: [{ name: 'hwnd', type: 'HWND' }, { name: 'cmd', type: 'flags:SW' }], ret: 'BOOL' },
  DestroyWindow:   { args: [{ name: 'hwnd', type: 'HWND' }], ret: 'BOOL' },
  GetMessageA:     { args: [{ name: 'msg', type: 'LPMSG', out: true }, { name: 'hwnd', type: 'HWND' }, { name: 'min', type: 'UINT' }, { name: 'max', type: 'UINT' }], ret: 'BOOL' },
  PeekMessageA:    { args: [{ name: 'msg', type: 'LPMSG', out: true }, { name: 'hwnd', type: 'HWND' }, { name: 'min', type: 'UINT' }, { name: 'max', type: 'UINT' }, { name: 'remove', type: 'UINT' }], ret: 'BOOL' },
  DispatchMessageA:{ args: [{ name: 'msg', type: 'LPMSG' }], ret: 'DWORD' },
  TranslateMessage:{ args: [{ name: 'msg', type: 'LPMSG' }], ret: 'BOOL' },
  SendMessageA:    { args: [{ name: 'hwnd', type: 'HWND' }, { name: 'msg', type: 'UINT' }, { name: 'wP', type: 'DWORD' }, { name: 'lP', type: 'DWORD' }], ret: 'DWORD' },
  PostMessageA:    { args: [{ name: 'hwnd', type: 'HWND' }, { name: 'msg', type: 'UINT' }, { name: 'wP', type: 'DWORD' }, { name: 'lP', type: 'DWORD' }], ret: 'BOOL' },
  GetWindowTextA:  { args: [{ name: 'hwnd', type: 'HWND' }, { name: 'buf', type: 'LPSTR', out: true }, { name: 'max', type: 'INT' }], ret: 'INT' },
  SetWindowTextA:  { args: [{ name: 'hwnd', type: 'HWND' }, { name: 'text', type: 'LPCSTR' }], ret: 'BOOL' },
  SetDlgItemTextA: { args: [{ name: 'hwnd', type: 'HWND' }, { name: 'id', type: 'INT' }, { name: 'text', type: 'LPCSTR' }], ret: 'BOOL' },
  LoadStringA:     { args: [{ name: 'hInst', type: 'HANDLE' }, { name: 'id', type: 'UINT' }, { name: 'buf', type: 'LPSTR', out: true }, { name: 'max', type: 'INT' }], ret: 'INT' },
  MessageBoxA:     { args: [{ name: 'hwnd', type: 'HWND' }, { name: 'text', type: 'LPCSTR' }, { name: 'caption', type: 'LPCSTR' }, { name: 'type', type: 'flags:MB' }], ret: 'INT' },

  // — ini / profile —
  GetPrivateProfileStringA: { args: [{ name: 'section', type: 'LPCSTR' }, { name: 'key', type: 'LPCSTR' }, { name: 'def', type: 'LPCSTR' }, { name: 'buf', type: 'LPSTR', out: true }, { name: 'size', type: 'DWORD' }, { name: 'file', type: 'LPCSTR' }], ret: 'DWORD' },
  WritePrivateProfileStringA: { args: [{ name: 'section', type: 'LPCSTR' }, { name: 'key', type: 'LPCSTR' }, { name: 'val', type: 'LPCSTR' }, { name: 'file', type: 'LPCSTR' }], ret: 'BOOL' },
  GetProfileStringA: { args: [{ name: 'section', type: 'LPCSTR' }, { name: 'key', type: 'LPCSTR' }, { name: 'def', type: 'LPCSTR' }, { name: 'buf', type: 'LPSTR', out: true }, { name: 'size', type: 'DWORD' }], ret: 'DWORD' },

  // — exceptions —
  RaiseException:  { args: [{ name: 'code', type: 'DWORD' }, { name: 'flags', type: 'DWORD' }, { name: 'nArgs', type: 'DWORD' }, { name: 'args', type: 'DWORD' }] },
};

const table = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let touched = 0, missing = 0;
const seen = new Set();
for (const e of table) {
  const spec = TYPED[e.name];
  if (!spec) continue;
  seen.add(e.name);
  // Sanity: arg count matches existing nargs (warn, don't fail; some may be wrong).
  if (spec.args && typeof e.nargs === 'number' && spec.args.length !== e.nargs) {
    console.error(`note: ${e.name} typed args (${spec.args.length}) != nargs (${e.nargs})`);
  }
  e.args = spec.args || [];
  if (spec.ret) e.ret = spec.ret; else delete e.ret;
  touched++;
}
for (const name of Object.keys(TYPED)) {
  if (!seen.has(name)) { console.error(`warn: TYPED entry not in api_table.json: ${name}`); missing++; }
}

fs.writeFileSync(jsonPath, JSON.stringify(table, null, 2) + '\n');
console.error(`annotated ${touched} entries (${missing} missing)`);
