// api-format.js — typed argument & return formatter for --trace-api.
//
// Drives off optional `args:[{name,type}]` and `ret:type` fields on
// api_table.json entries. APIs without typed metadata fall back to
// the legacy hex dump (handled by the caller).
//
// Types recognized:
//   LPCSTR LPSTR LPCWSTR LPWSTR  (string deref, quoted + truncated)
//   LPCSTR_N LPCWSTR_N           (string deref, length from arg metadata)
//   LPOLESTRARRAY DISPPARAMS     (Automation helper structs)
//   WASM_LPCSTR_N WASM_LPCWSTR_N (same, pointer already in WASM space)
//   WASM_TEXT_N                  (host text pointer, width from metadata arg)
//   HWND HDC HMENU HANDLE        (hex tag, hwnd may add #N)
//   UINT INT DWORD COLORREF ROP  (decimal/hex/symbolic)
//   BOOL                         (TRUE/FALSE/<n>)
//   LPRECT LPPOINT LPSIZE LPMSG LPSCROLLINFO LPLOGFONTA LPLOGFONTW
//   LPTEXTMETRICA LPTEXTMETRICW LPWNDCLASSA  (struct field dump)
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
  DT: {
    0x0000: 'DT_LEFT|DT_TOP',
    0x0001: 'DT_CENTER',
    0x0002: 'DT_RIGHT',
    0x0004: 'DT_VCENTER',
    0x0008: 'DT_BOTTOM',
    0x0010: 'DT_WORDBREAK',
    0x0020: 'DT_SINGLELINE',
    0x0040: 'DT_EXPANDTABS',
    0x0080: 'DT_TABSTOP',
    0x0100: 'DT_NOCLIP',
    0x0200: 'DT_EXTERNALLEADING',
    0x0400: 'DT_CALCRECT',
    0x0800: 'DT_NOPREFIX',
    0x1000: 'DT_INTERNAL',
    0x2000: 'DT_EDITCONTROL',
    0x4000: 'DT_PATH_ELLIPSIS',
    0x8000: 'DT_END_ELLIPSIS',
    0x10000: 'DT_MODIFYSTRING',
    0x20000: 'DT_RTLREADING',
    0x40000: 'DT_WORD_ELLIPSIS',
  },
};

const ROP_NAMES = {
  0x00000042: 'BLACKNESS',
  0x00010289: 'DPSOON',
  0x00020c89: 'DPSONA',
  0x000300aa: 'PSON',
  0x00040c88: 'SDPONA',
  0x000500a9: 'DPON',
  0x00060865: 'PDSXNON',
  0x000702c5: 'PDSAON',
  0x00080f08: 'SDPNA',
  0x00090245: 'PDSXON',
  0x000a0329: 'DPNA',
  0x000b0b2a: 'PSDAN',
  0x000c0324: 'SPNA',
  0x000d0b25: 'PDSAN',
  0x000e08a5: 'PDSXNO',
  0x000f0001: 'PN',
  0x00550009: 'DSTINVERT',
  0x00660046: 'SRCINVERT',
  0x008800c6: 'SRCAND',
  0x00aa0029: 'MERGEPAINT',
  0x00bb0226: 'MERGECOPY',
  0x00c000ca: 'SRCCOPY',
  0x00cc0020: 'SRCCOPY',
  0x00ee0086: 'SRCPAINT',
  0x00f00021: 'PATCOPY',
  0x00fb0a09: 'PATPAINT',
  0x00ff0062: 'WHITENESS',
};

const HOST_TRACE_TABLE = {
  gdi_patblt: {
    name: 'PatBlt',
    args: [
      { name: 'hdc', type: 'HDC' },
      { name: 'x', type: 'INT' },
      { name: 'y', type: 'INT' },
      { name: 'w', type: 'INT' },
      { name: 'h', type: 'INT' },
      { name: 'rop', type: 'ROP' },
    ],
    ret: 'BOOL',
  },
  gdi_fill_rect: {
    name: 'FillRect',
    args: [
      { name: 'hdc', type: 'HDC' },
      { name: 'left', type: 'INT' },
      { name: 'top', type: 'INT' },
      { name: 'right', type: 'INT' },
      { name: 'bottom', type: 'INT' },
      { name: 'hbrush', type: 'HBRUSH' },
    ],
    ret: 'INT',
  },
  gdi_rectangle: {
    name: 'Rectangle',
    args: [
      { name: 'hdc', type: 'HDC' },
      { name: 'left', type: 'INT' },
      { name: 'top', type: 'INT' },
      { name: 'right', type: 'INT' },
      { name: 'bottom', type: 'INT' },
    ],
    ret: 'BOOL',
  },
  gdi_set_text_color: {
    name: 'SetTextColor',
    args: [{ name: 'hdc', type: 'HDC' }, { name: 'color', type: 'COLORREF' }],
    ret: 'COLORREF',
  },
  gdi_set_bk_color: {
    name: 'SetBkColor',
    args: [{ name: 'hdc', type: 'HDC' }, { name: 'color', type: 'COLORREF' }],
    ret: 'COLORREF',
  },
  gdi_set_bk_mode: {
    name: 'SetBkMode',
    args: [{ name: 'hdc', type: 'HDC' }, { name: 'mode', type: 'BKMODE' }],
    ret: 'INT',
  },
  gdi_draw_text: {
    name: 'DrawText',
    args: [
      { name: 'hdc', type: 'HDC' },
      { name: 'text', type: 'WASM_TEXT_N', lengthFrom: 'nCount', wideFrom: 'isWide' },
      { name: 'nCount', type: 'INT' },
      { name: 'rect', type: 'WASM_LPRECT' },
      { name: 'format', type: 'flags:DT' },
      { name: 'isWide', type: 'BOOL' },
    ],
    ret: 'INT',
  },
  gdi_text_out: {
    name: 'TextOut',
    args: [
      { name: 'hdc', type: 'HDC' },
      { name: 'x', type: 'INT' },
      { name: 'y', type: 'INT' },
      { name: 'text', type: 'WASM_TEXT_N', lengthFrom: 'nCount', wideFrom: 'isWide' },
      { name: 'nCount', type: 'INT' },
      { name: 'isWide', type: 'BOOL' },
    ],
    ret: 'BOOL',
  },
  gdi_create_solid_brush: {
    name: 'CreateSolidBrush',
    args: [{ name: 'color', type: 'COLORREF' }],
    ret: 'HBRUSH',
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

function ptrToWasm(ctx, ptr, ptrSpace) {
  if (!ptr) return 0;
  if (ptrSpace === 'wasm' || ctx.ptrSpace === 'wasm') return ptr >>> 0;
  return ctx.g2w ? ctx.g2w(ptr >>> 0) : (ptr >>> 0);
}

function readStrSafe(readStr, g2w, ptr, max = 80) {
  if (!ptr) return '';
  try { return readStr(g2w(ptr), max); } catch { return ''; }
}

function readStrN(ctx, ptr, len, wide, ptrSpace) {
  if (!ptr || !ctx.memory) return '';
  try {
    const wa = ptrToWasm(ctx, ptr, ptrSpace);
    const bytes = new Uint8Array(ctx.memory);
    const maxChars = len < 0 ? 120 : Math.min(len, 120);
    let s = '';
    if (wide) {
      const dv = ctx.dv || new DataView(ctx.memory);
      for (let i = 0; i < maxChars && wa + i * 2 + 1 < bytes.length; i++) {
        const c = dv.getUint16(wa + i * 2, true);
        if (!c) break;
        s += String.fromCharCode(c);
      }
    } else {
      for (let i = 0; i < maxChars && wa + i < bytes.length; i++) {
        const c = bytes[wa + i];
        if (!c) break;
        s += String.fromCharCode(c);
      }
    }
    return s;
  } catch {
    return '';
  }
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

function getArgValue(ref, argVals, argSpecs) {
  if (ref === undefined || ref === null) return undefined;
  if (typeof ref === 'number') return argVals[ref];
  const idx = argSpecs.findIndex(a => a && a.name === ref);
  return idx >= 0 ? argVals[idx] : undefined;
}

function fmtColorRef(v) {
  const b = v & 0xff;
  const g = (v >>> 8) & 0xff;
  const r = (v >>> 16) & 0xff;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')} (${hexPlain(v)})`;
}

function hexPlain(v) {
  return '0x' + (v >>> 0).toString(16);
}

function fmtPtrOrAtom(val, label, str) {
  if (val === 0) return '0';
  if (val < 0x10000) return `MAKEINTRESOURCE(${val})`;
  return str ? `"${str}" (0x${val.toString(16)})` : `0x${val.toString(16)}`;
}

function fmtArg(type, val, ctx, meta = {}, argVals = [], argSpecs = []) {
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
    case 'LPCSTR_N': {
      if (v === 0) return 'NULL';
      if (v < 0x10000) return `MAKEINTRESOURCE(${v})`;
      const n = getArgValue(meta.lengthFrom ?? meta.lenArg, argVals, argSpecs);
      const s = readStrN(ctx, v, (n === undefined ? -1 : n | 0), false, 'guest');
      return s ? `"${s}"` : ctx.hex(v);
    }
    case 'LPCWSTR':
    case 'LPWSTR': {
      if (v === 0) return 'NULL';
      if (v < 0x10000) return `MAKEINTRESOURCE(${v})`;
      const s = readWStr(ctx.memory, ctx.g2w, v, 120);
      return s ? `L"${s}"` : ctx.hex(v);
    }
    case 'LPCWSTR_N': {
      if (v === 0) return 'NULL';
      if (v < 0x10000) return `MAKEINTRESOURCE(${v})`;
      const n = getArgValue(meta.lengthFrom ?? meta.lenArg, argVals, argSpecs);
      const s = readStrN(ctx, v, (n === undefined ? -1 : n | 0), true, 'guest');
      return s ? `L"${s}"` : ctx.hex(v);
    }
    case 'WASM_LPCSTR_N': {
      if (v === 0) return 'NULL';
      const n = getArgValue(meta.lengthFrom ?? meta.lenArg, argVals, argSpecs);
      const s = readStrN(ctx, v, (n === undefined ? -1 : n | 0), false, 'wasm');
      return s ? `"${s}"` : ctx.hex(v);
    }
    case 'WASM_LPCWSTR_N': {
      if (v === 0) return 'NULL';
      const n = getArgValue(meta.lengthFrom ?? meta.lenArg, argVals, argSpecs);
      const s = readStrN(ctx, v, (n === undefined ? -1 : n | 0), true, 'wasm');
      return s ? `L"${s}"` : ctx.hex(v);
    }
    case 'WASM_TEXT_N': {
      if (v === 0) return 'NULL';
      const n = getArgValue(meta.lengthFrom ?? meta.lenArg, argVals, argSpecs);
      const wide = !!getArgValue(meta.wideFrom, argVals, argSpecs);
      const s = readStrN(ctx, v, (n === undefined ? -1 : n | 0), wide, 'wasm');
      return s ? `${wide ? 'L' : ''}"${s}"` : ctx.hex(v);
    }
    case 'LPOLESTRARRAY': {
      if (v === 0) return 'NULL';
      try {
        const namePtr = ctx.dv.getUint32(ctx.g2w(v), true);
        const s = readWStr(ctx.memory, ctx.g2w, namePtr, 80);
        return s ? `&[L"${s}"]` : ctx.hex(v);
      } catch {
        return ctx.hex(v);
      }
    }
    case 'DISPPARAMS': {
      if (v === 0) return 'NULL';
      try {
        const wa = ctx.g2w(v);
        const rgvarg = ctx.dv.getUint32(wa, true);
        const cArgs = ctx.dv.getUint32(wa + 8, true);
        const cNamedArgs = ctx.dv.getUint32(wa + 12, true);
        let first = '';
        if (rgvarg && cArgs) {
          const va = ctx.g2w(rgvarg);
          const vt = ctx.dv.getUint16(va, true);
          const val = ctx.dv.getUint32(va + 8, true);
          first = ` first={vt=${vt} val=${ctx.hex(val)}}`;
        }
        return `&{cArgs=${cArgs} cNamedArgs=${cNamedArgs} rgvarg=${ctx.hex(rgvarg)}${first}}`;
      } catch {
        return ctx.hex(v);
      }
    }
    case 'BOOL': return v === 0 ? 'FALSE' : v === 1 ? 'TRUE' : ctx.hex(v);
    case 'INT': {
      const i = v | 0;
      return (i >= -0x100 && i <= 0xFFFF) ? String(i) : ctx.hex(v);
    }
    case 'UINT':
    case 'DWORD':
      return v < 0x10000 ? String(v) : ctx.hex(v);
    case 'COLORREF':
      return fmtColorRef(v);
    case 'ROP':
      return ROP_NAMES[v] ? `${ROP_NAMES[v]} (${ctx.hex(v)})` : ctx.hex(v);
    case 'BKMODE':
      return v === 1 ? 'TRANSPARENT' : v === 2 ? 'OPAQUE' : ctx.hex(v);
    case 'HWND':
      return v ? `hwnd:${ctx.hex(v)}` : '0';
    case 'HDC':
      return v ? `hdc:${ctx.hex(v)}` : '0';
    case 'HMENU':
      return v ? `hmenu:${ctx.hex(v)}` : '0';
    case 'HBRUSH':
      return v ? `hbrush:${ctx.hex(v)}` : '0';
    case 'HANDLE':
      return v ? `h:${ctx.hex(v)}` : '0';
    case 'LPRECT':
    case 'LPPOINT':
    case 'LPSIZE':
    case 'LPMSG':
    case 'LPSCROLLINFO':
    case 'LPLOGFONTA':
    case 'LPLOGFONTW':
    case 'LPTEXTMETRICA':
    case 'LPTEXTMETRICW':
    case 'LPWNDCLASSA':
      return fmtStruct(type, v, ctx);
    case 'WASM_LPRECT':
      return fmtStruct(type, v, { ...ctx, g2w: x => x });
    default:
      return ctx.hex(v);
  }
}

function fmtStruct(type, ptr, ctx) {
  if (!ptr) return 'NULL';
  const { dv, g2w } = ctx;
  try {
    switch (type) {
      case 'LPRECT':
      case 'WASM_LPRECT': {
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
      case 'LPSCROLLINFO': {
        const w = g2w(ptr);
        const cbSize = dv.getUint32(w, true);
        const fMask = dv.getUint32(w + 4, true);
        const nMin = dv.getInt32(w + 8, true);
        const nMax = dv.getInt32(w + 12, true);
        const nPage = dv.getUint32(w + 16, true);
        const nPos = dv.getInt32(w + 20, true);
        const nTrackPos = dv.getInt32(w + 24, true);
        const maskBits = [];
        if (fMask & 0x01) maskBits.push('SIF_RANGE');
        if (fMask & 0x02) maskBits.push('SIF_PAGE');
        if (fMask & 0x04) maskBits.push('SIF_POS');
        if (fMask & 0x08) maskBits.push('SIF_DISABLENOSCROLL');
        if (fMask & 0x10) maskBits.push('SIF_TRACKPOS');
        const mask = maskBits.length ? `${maskBits.join('|')} (${ctx.hex(fMask)})` : ctx.hex(fMask);
        return `&{cbSize=${cbSize} fMask=${mask} nMin=${nMin} nMax=${nMax} nPage=${nPage} nPos=${nPos} nTrackPos=${nTrackPos}}`;
      }
      case 'LPLOGFONTA':
      case 'LPLOGFONTW': {
        const w = g2w(ptr);
        const h = dv.getInt32(w, true);
        const width = dv.getInt32(w + 4, true);
        const escapement = dv.getInt32(w + 8, true);
        const orientation = dv.getInt32(w + 12, true);
        const weight = dv.getInt32(w + 16, true);
        const italic = dv.getUint8(w + 20);
        const charset = dv.getUint8(w + 23);
        const pitch = dv.getUint8(w + 27);
        let face = '';
        if (type === 'LPLOGFONTW') {
          for (let off = w + 28; off < w + 28 + 64; off += 2) {
            const ch = dv.getUint16(off, true);
            if (!ch) break;
            face += String.fromCharCode(ch);
          }
        } else {
          face = readStrSafe(ctx.readStr, x => x, w + 28, 32);
        }
        return `&{height=${h} width=${width} esc=${escapement} orient=${orientation} weight=${weight} italic=${italic} charset=${charset} pitch=${pitch} face="${face}"}`;
      }
      case 'LPTEXTMETRICA':
      case 'LPTEXTMETRICW': {
        const w = g2w(ptr);
        const h = dv.getInt32(w, true);
        const ascent = dv.getInt32(w + 4, true);
        const descent = dv.getInt32(w + 8, true);
        const intLead = dv.getInt32(w + 12, true);
        const extLead = dv.getInt32(w + 16, true);
        const aveW = dv.getInt32(w + 20, true);
        const maxW = dv.getInt32(w + 24, true);
        const weight = dv.getInt32(w + 28, true);
        const aspectX = dv.getInt32(w + 36, true);
        const aspectY = dv.getInt32(w + 40, true);
        return `&{height=${h} ascent=${ascent} descent=${descent} intLead=${intLead} extLead=${extLead} aveW=${aveW} maxW=${maxW} weight=${weight} aspect=${aspectX}x${aspectY}}`;
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
  const argVals = [];
  for (let i = 0; i < entry.args.length; i++) {
    try { argVals.push(dv.getUint32(g2w(esp + 4 + i * 4), true)); } catch { argVals.push(0); }
  }
  for (let i = 0; i < entry.args.length; i++) {
    const a = entry.args[i];
    const formatted = fmtArg(a.type, argVals[i], ctx, a, argVals, entry.args);
    parts.push(a.name ? `${a.name}=${formatted}` : formatted);
  }
  return `${entry.name}(${parts.join(', ')})`;
}

function formatArgArray(entry, argVals, ctx) {
  if (!entry || !Array.isArray(entry.args)) return null;
  const parts = [];
  for (let i = 0; i < entry.args.length; i++) {
    const a = entry.args[i];
    const formatted = fmtArg(a.type, argVals[i] >>> 0, ctx, a, argVals, entry.args);
    parts.push(a.name ? `${a.name}=${formatted}` : formatted);
  }
  return `${entry.name}(${parts.join(', ')})`;
}

function formatHostCall(name, args, ret, ctx) {
  const entry = HOST_TRACE_TABLE[name];
  if (!entry) return null;
  const call = formatArgArray(entry, args, ctx);
  const retText = entry.ret ? ' => ' + fmtArg(entry.ret, ret >>> 0, ctx) : '';
  return call + retText;
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

module.exports = {
  formatCall,
  formatRet,
  formatOutParams,
  formatHostCall,
  formatArgArray,
  walkFrames,
  fmtArg,
  HOST_TRACE_TABLE,
};
