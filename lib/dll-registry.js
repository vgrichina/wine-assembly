// Which DLLs ship as real PE files, and where they live.
//
// This list existed twice and the two copies disagreed: test/run.js knew about
// ~30 loadable DLLs and searched several directories for them, while
// index.html had a 14-entry name->URL map. An app whose imports needed
// SHELL32, SHDOCVW, HYPERTRM or the Kodak OI*400 set therefore loaded in the
// CLI and failed in the browser, for no reason either host stated.
//
// Anything not listed here is served by the WAT stub handlers instead, which
// is the right answer for the system DLLs we emulate rather than load.

'use strict';

// name (lowercase) -> repo-relative path, as served to the browser and as the
// last search directory for the CLI.
const DLL_PATHS = {
  // C runtimes and MFC. Old MFC builds import their matching CRT from
  // DllMain, so msvcrt20 has to be loadable before mfc30.
  'msvcrt.dll': 'binaries/dlls/msvcrt.dll',
  'msvcrt20.dll': 'binaries/dlls/msvcrt20.dll',
  'msvcp60.dll': 'binaries/dlls/msvcp60.dll',
  'mfc30.dll': 'binaries/dlls/mfc30.dll',
  'mfc42.dll': 'binaries/dlls/mfc42.dll',
  'mfc42u.dll': 'binaries/dlls/mfc42u.dll',

  // Common controls, rich edit, uniscribe.
  'comctl32.dll': 'binaries/dlls/comctl32.dll',
  'riched20.dll': 'binaries/dlls/riched20.dll',
  'usp10.dll': 'binaries/dlls/usp10.dll',
  'oleaut32.dll': 'binaries/dlls/oleaut32.dll',
  'cabinet.dll': 'binaries/dlls/cabinet.dll',

  // Games and 3D.
  'd3drm.dll': 'binaries/dlls/d3drm.dll',
  'cards.dll': 'binaries/entertainment-pack/cards.dll',

};

// Loadable, but shipped beside the app rather than in the repo: the CLI finds
// these in the exe's own directory, and the browser gets them from that app's
// `files` list. Listing them here is what says "load this as a real PE" rather
// than "let the WAT stubs answer for it".
const APP_LOCAL_DLLS = [
  'msvcp50.dll',
  // The Win98 shell: Explorer's window, desktop and taskbar live in SHELL32
  // (entered through ordinal 244) and SHDOCVW.
  'shell32.dll', 'shlwapi.dll', 'shdocvw.dll',
  'kvdd.dll', 'sdl.dll',
  // HyperTerminal's protocol engine, and the Kodak Imaging libraries.
  'hypertrm.dll', 'imgcmn.dll', 'sti.dll',
  // Kodak Imaging splits itself across ten OI*400 libraries that import each
  // other, so the whole set has to be loadable or the first cross-DLL ordinal
  // resolves to a system thunk and traps.
  'oiadm400.dll', 'oicom400.dll', 'oidis400.dll', 'oifil400.dll', 'oigfs400.dll',
  'oiprt400.dll', 'oislb400.dll', 'oissq400.dll', 'oitwa400.dll', 'oiui400.dll',
];

const LOADABLE_DLLS = new Set([...Object.keys(DLL_PATHS), ...APP_LOCAL_DLLS]);

function isLoadableDll(name) {
  return LOADABLE_DLLS.has(String(name || '').toLowerCase());
}

function dllPath(name) {
  return DLL_PATHS[String(name || '').toLowerCase()] || null;
}

// Old MFC builds import their matching CRT during DllMain, so a dependency-safe
// order matters even when the EXE's import directory lists MFC first.
function orderDlls(names) {
  const rank = (n) => (String(n).toLowerCase() === 'msvcrt20.dll' ? 0 : 1);
  return [...names].sort((a, b) => rank(a) - rank(b));
}

const api = { DLL_PATHS, APP_LOCAL_DLLS, LOADABLE_DLLS, isLoadableDll, dllPath, orderDlls };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.dllRegistry = api;
