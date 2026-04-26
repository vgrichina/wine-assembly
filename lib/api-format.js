// api-format.js — typed argument & return formatter for --trace-api.
//
// Drives off optional `args:[{name,type}]` and `ret:type` fields on
// api_table.json entries. APIs without typed metadata fall back to
// the legacy hex dump (handled by the caller).
//
// Types recognized:
//   LPCSTR LPSTR LPCWSTR LPWSTR  (string deref, quoted + truncated)
//   HWND HDC HMENU HANDLE        (hex tag, hwnd may add #N)
//   UINT INT DWORD               (decimal/hex)
//   BOOL                         (TRUE/FALSE/<n>)
//   LPRECT LPPOINT LPSIZE LPMSG LPWNDCLASSA  (struct field dump)
//   flags:WS / flags:MB / flags:SW / flags:MF (symbolic OR)
//   anything else / missing       → hex
//
// Caller provides a `ctx` with: dv, g2w, memory, readStr, hex.

'use strict';

const FLAG_TABLES = {
  MB: {
    0x00000000: 'MB_OK',
    0x00000001: 'MB_OKCANCEL',
    0x00000002: 'MB_ABORTRETRYIGNORE',
    0x00000003: 'MB_YESNOCANCEL',
    0x00000004: 'MB_YESNO',
    0x00000005: 'MB_RETRYCANCEL',
    0x00000010: 'MB_ICONHAND',
    0x00000020: 'MB_ICONQUESTION',
    0x00000030: 'MB_ICONEXCLAMATION',
    0x00000040: 'MB_ICONINFORMATION',
    0x00000100: 'MB_DEFBUTTON2',
    0x00000200: 'MB_DEFBUTTON3',
    0x00001000: 'MB_SYSTEMMODAL',
    0x00002000: 'MB_TASKMODAL',
    0x00040000: 'MB_TOPMOST',
  },
  SW: {
    0: 'SW_HIDE', 1: 'SW_SHOWNORMAL', 2: 'SW_SHOWMINIMIZED', 3: 'SW_SHOWMAXIMIZED',
    4: 'SW_SHOWNOACTIVATE', 5: 'SW_SHOW', 6: 'SW_MINIMIZE', 7: 'SW_SHOWMINNOACTIVE',
    8: 'SW_SHOWNA', 9: 'SW_RESTORE', 10: 'SW_SHOWDEFAULT',
  },
  WS: {
    0x80000000: 'WS_POPUP',
    0x40000000: 'WS_CHILD',
    0x20000000: 'WS_MINIMIZE',
    0x10000000: 'WS_VISIBLE',
    0x08000000: 'WS_DISABLED',
    0x04000000: 'WS_CLIPSIBLINGS',
    0x02000000: 'WS_CLIPCHILDREN',
    0x01000000: 'WS_MAXIMIZE',
    0x00800000: 'WS_BORDER',
    0x00400000: 'WS_DLGFRAME',
    0x00200000: 'WS_VSCROLL',
    0x00100000: 'WS_HSCROLL',
    0x00080000: 'WS_SYSMENU',
    0x00040000: 'WS_THICKFRAME',
    0x00020000: 'WS_GROUP',
    0x00010000: 'WS_TABSTOP',
  },
  MF: {
    0x0000: 'MF_STRING',
    0x0001: 'MF_GRAYED',
    0x0002: 'MF_DISABLED',
    0x0008: 'MF_CHECKED',
    0x0010: 'MF_POPUP',
    0x0020: 'MF_MENUBARBREAK',
    0x0040: 'MF_MENUBREAK',
    0x0800: 'MF_SEPARATOR',
    0x1000: 'MF_BYPOSITION',
  },
};

function fmtFlags(name, val) {
  const tbl = FLAG_TABLES[name];
  if (!tbl) return '0x' + (val >>> 0).toString(16);
  const v = val >>> 0;
  if (v === 0 && tbl[0]) return tbl[0];
  const parts = [];
  let rem = v;
  // singletons (zero-keyed) only used when val==0
  for (const k of Object.keys(tbl).map(n => +n).sort((a, b) => b - a)) {
    if (k === 0) continue;
    if ((rem & k) === k) { parts.push(tbl[k]); rem &= ~k; }
  }
  if (rem) parts.push('0x' + rem.toString(16));
  return parts.length ? parts.join('|') : '0';
}

function readStrSafe(readStr, g2w, ptr, max = 80) {
  if (!ptr) return '';
  try { return readStr(g2w(ptr), max); } catch { return ''; }
}

function readWStr(memory, g2w, ptr, max = 80) {
  if (!ptr || !memory) return '';
  try {
    const u16 = new Uint16Array(memory, g2w(ptr), max);
    let s = '';
    for (let i = 0; i < u16.length && u16[i]; i++) s += String.fromCharCode(u16[i]);
    return s;
  } catch { return ''; }
}

function fmtPtrOrAtom(val, label, str) {
  if (val === 0) return '0';
  if (val < 0x10000) return `MAKEINTRESOURCE(${val})`;
  return str ? `"${str}" (0x${val.toString(16)})` : `0x${val.toString(16)}`;
}

function fmtArg(type, val, ctx) {
  const v = val >>> 0;
  if (!type) return ctx.hex(v);
  // flags:NAME
  if (type.startsWith('flags:')) return fmtFlags(type.slice(6), v);
  switch (type) {
    case 'LPCSTR':
    case 'LPSTR': {
      if (v === 0) return 'NULL';
      if (v < 0x10000) return `MAKEINTRESOURCE(${v})`;
      const s = readStrSafe(ctx.readStr, ctx.g2w, v, 120);
      return s ? `"${s}"` : ctx.hex(v);
    }
    case 'LPCWSTR':
    case 'LPWSTR': {
      if (v === 0) return 'NULL';
      if (v < 0x10000) return `MAKEINTRESOURCE(${v})`;
      const s = readWStr(ctx.memory, ctx.g2w, v, 120);
      return s ? `L"${s}"` : ctx.hex(v);
    }
    case 'BOOL': return v === 0 ? 'FALSE' : v === 1 ? 'TRUE' : ctx.hex(v);
    case 'INT': {
      const i = v | 0;
      return (i >= -0x100 && i <= 0xFFFF) ? String(i) : ctx.hex(v);
    }
    case 'UINT':
    case 'DWORD':
      return v < 0x10000 ? String(v) : ctx.hex(v);
    case 'HWND':
      return v ? `hwnd:${ctx.hex(v)}` : '0';
    case 'HDC':
      return v ? `hdc:${ctx.hex(v)}` : '0';
    case 'HMENU':
      return v ? `hmenu:${ctx.hex(v)}` : '0';
    case 'HANDLE':
      return v ? `h:${ctx.hex(v)}` : '0';
    case 'LPRECT':
    case 'LPPOINT':
    case 'LPSIZE':
    case 'LPMSG':
    case 'LPWNDCLASSA':
      return fmtStruct(type, v, ctx);
    default:
      return ctx.hex(v);
  }
}

function fmtStruct(type, ptr, ctx) {
  if (!ptr) return 'NULL';
  const { dv, g2w } = ctx;
  try {
    switch (type) {
      case 'LPRECT': {
        const w = g2w(ptr);
        const l = dv.getInt32(w, true), t = dv.getInt32(w + 4, true);
        const r = dv.getInt32(w + 8, true), b = dv.getInt32(w + 12, true);
        return `&{l=${l} t=${t} r=${r} b=${b}}`;
      }
      case 'LPPOINT': {
        const w = g2w(ptr);
        return `&{x=${dv.getInt32(w, true)} y=${dv.getInt32(w + 4, true)}}`;
      }
      case 'LPSIZE': {
        const w = g2w(ptr);
        return `&{cx=${dv.getInt32(w, true)} cy=${dv.getInt32(w + 4, true)}}`;
      }
      case 'LPMSG': {
        const w = g2w(ptr);
        const hwnd = dv.getUint32(w, true);
        const msg = dv.getUint32(w + 4, true);
        const wp = dv.getUint32(w + 8, true);
        const lp = dv.getUint32(w + 12, true);
        return `&{hwnd=${ctx.hex(hwnd)} msg=${ctx.hex(msg)} wP=${ctx.hex(wp)} lP=${ctx.hex(lp)}}`;
      }
      case 'LPWNDCLASSA': {
        const w = g2w(ptr);
        const style = dv.getUint32(w, true);
        const wndProc = dv.getUint32(w + 4, true);
        const menuName = dv.getUint32(w + 32, true);
        const className = dv.getUint32(w + 36, true);
        const menuStr = (menuName > 0 && menuName < 0x10000)
          ? `MAKEINTRESOURCE(${menuName})`
          : (menuName ? `"${readStrSafe(ctx.readStr, g2w, menuName, 32)}"` : '0');
        const classStr = (className > 0 && className < 0x10000)
          ? `MAKEINTATOM(${className})`
          : (className ? `"${readStrSafe(ctx.readStr, g2w, className, 32)}"` : '0');
        return `&{style=${ctx.hex(style)} wndProc=${ctx.hex(wndProc)} class=${classStr} menu=${menuStr}}`;
      }
    }
  } catch {}
  return ctx.hex(ptr);
}

// Public: format a typed call. Returns null if entry has no `args` typing —
// caller should fall back to legacy hex dump.
function formatCall(entry, esp, ctx) {
  if (!entry || !Array.isArray(entry.args)) return null;
  const { dv, g2w, hex } = ctx;
  const parts = [];
  for (let i = 0; i < entry.args.length; i++) {
    let v = 0;
    try { v = dv.getUint32(g2w(esp + 4 + i * 4), true); } catch {}
    const a = entry.args[i];
    const formatted = fmtArg(a.type, v, ctx);
    parts.push(a.name ? `${a.name}=${formatted}` : formatted);
  }
  return `${entry.name}(${parts.join(', ')})`;
}

// Public: format a typed return. Returns null if no `ret` type — caller falls back.
function formatRet(entry, val, ctx) {
  if (!entry || !entry.ret) return null;
  return ' => ' + fmtArg(entry.ret, val, ctx);
}

// Public: format any out-params after the call returns.
// argVals is the array of raw dwords captured at entry (so we deref the same
// pointer the API was given, regardless of post-call esp/register state).
// Returns '' if entry has no out-params or formatting yields nothing.
function formatOutParams(entry, argVals, ctx) {
  if (!entry || !Array.isArray(entry.args)) return '';
  const parts = [];
  for (let i = 0; i < entry.args.length; i++) {
    const a = entry.args[i];
    if (!a.out) continue;
    const v = argVals[i] >>> 0;
    if (!v) { parts.push(`${a.name}=NULL`); continue; }
    const formatted = fmtArg(a.type, v, ctx);
    parts.push(`${a.name}=${formatted}`);
  }
  return parts.length ? '   out: ' + parts.join(', ') : '';
}

// Public: walk EBP chain, return array of caller VAs.
function walkFrames(getEbp, dv, g2w, maxDepth = 12) {
  const chain = [];
  let ebp = getEbp() >>> 0;
  for (let d = 0; d < maxDepth && ebp; d++) {
    try {
      const callerRet = dv.getUint32(g2w(ebp + 4), true);
      const prevEbp = dv.getUint32(g2w(ebp), true) >>> 0;
      chain.push(callerRet >>> 0);
      if (prevEbp <= ebp || prevEbp - ebp > 0x10000) break;
      ebp = prevEbp;
    } catch { break; }
  }
  return chain;
}

module.exports = { formatCall, formatRet, formatOutParams, walkFrames, fmtArg };
