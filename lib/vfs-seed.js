// The parts of VFS seeding that are policy rather than mechanism.
//
// The two hosts fill the guest filesystem from different worlds — the CLI
// reads a directory, the page fetches URLs — so most of seeding cannot be one
// function. But two of the rules are not about where the bytes come from at
// all, and those had drifted into two copies each:
//
//   * where a running image can find itself, and
//   * which filenames a Win16 module name can live under.
//
// Both are things the guest believes, so both must be the same in both hosts
// or an app works in one and not the other for no reason a test would name.

// GetModuleFileNameA answers "C:\APP.EXE" no matter what the file was really
// called, so an app that opens its own path (to read a resource, to check its
// own size, to re-exec) must find it there. An app that instead remembers the
// name it was launched under — or that another file names it, as an installer
// does — must find it under that too. Seeding both is cheaper than deciding
// which kind of app this is.
function seedExeImage(vfs, exeBytes, exeName) {
  if (!vfs || !vfs.files || !exeBytes) return null;
  const data = exeBytes instanceof Uint8Array ? exeBytes : new Uint8Array(exeBytes);
  const base = String(exeName || 'app.exe').split(/[\\/]/).pop().toLowerCase();
  const paths = ['c:\\app.exe'];
  if (base && base !== 'app.exe') paths.push('c:\\' + base);
  for (const p of paths) vfs.files.set(p, { data, attrs: 0x20 });
  return { data, base, paths };
}

// A Win16 module name is not a filename — it is an uppercase name out of the
// module-reference table — and the file it came from can be spelled any of
// these. The CLI checks a directory for each and the page fetches each, but
// both must try the same three: a name we skip here is a DLL the guest asks
// for and does not get, and the failure surfaces as "Cannot find cards.dll"
// rather than as anything about spelling.
// A Win16 module named without an extension can be any of these files. A .VBX
// is a DLL with a different suffix — Visual Basic's custom controls ship as
// GAUGE.VBX, CMDIALOG.VBX — and looking only for .DLL left Go Figure! and Tic
// Tac Drop reporting "Can't load Custom Control DLL" about a file sitting
// right beside them.
// The base name is spelled every way too, because the name in the table is
// the linker's spelling and the file on disk is the installer's: TETRIS
// imports "Abouttet" from ABOUTTET.DLL. A case-insensitive filesystem hides
// that; an HTTP server does not.
function win16FileCandidates(name) {
  // Static NE import tables normally name a module without its suffix, while
  // LoadLibrary hands us exactly what the application typed (often
  // "cards.dll").  Normalize both forms to the module stem before adding the
  // on-disk suffixes; otherwise a dynamic request becomes cards.dll.DLL and a
  // perfectly ordinary sibling DLL can never be found.
  const leaf = String(name).replace(/^.*[\\/]/, '');
  const stem = leaf.replace(/\.(?:dll|vbx|exe)$/i, '');
  const bases = [...new Set([stem, stem.toUpperCase(), stem.toLowerCase()])];
  // Deliberately not .IW, IdleWild's screen-saver libraries: staging those
  // makes the app worse, not better. It loads all six, runs out of module
  // slots part way through and stops with "Cannot start IdleWild!", where
  // leaving them unfound costs only the previews.
  return bases.flatMap(base => [`${base}.DLL`, `${base}.dll`, `${base}.VBX`,
                                `${base}.vbx`, `${base}.EXE`]);
}

// A Win16 bootstrapper may unpack its real loader DLL to a temporary file and
// immediately call LoadLibrary on it. The host import that stages the module
// is synchronous, so only fully resident VFS entries are eligible here; a
// provider-backed CD/ZIP file must go through the normal async preload path.
// Match by module stem because the Win16 dispatcher intentionally strips both
// the path and suffix before assigning an app-local module id.
function residentWin16Module(vfs, name) {
  if (!vfs || !(vfs.files instanceof Map)) return null;
  const wanted = String(name || '').replace(/^.*[\\/]/, '')
    .replace(/\.[^.]*$/, '').toLowerCase();
  if (!wanted) return null;
  for (const [path, entry] of vfs.files) {
    const leaf = String(path).replace(/^.*[\\/]/, '');
    if (leaf.replace(/\.[^.]*$/, '').toLowerCase() !== wanted) continue;
    if (!entry || entry._provider || !(entry.data instanceof Uint8Array)) continue;
    const bytes = entry.data;
    if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) continue;
    const ne = bytes[0x3c] | (bytes[0x3d] << 8) |
      (bytes[0x3e] << 16) | (bytes[0x3f] << 24);
    if (ne < 0 || ne + 2 > bytes.length) continue;
    if (bytes[ne] === 0x4e && bytes[ne + 1] === 0x45) return { path, bytes, format: 'ne' };
    // Win9x WISE installers extract their 32-bit shell/service helper under a
    // random GLF*.tmp filename, then pass it to Win16 LoadLibrary. KERNEL's
    // WOW loader accepts that PE and runs its DllMain. Recognize only the
    // helper's own export-module name; arbitrary PE files are not Win16 DLLs.
    if (bytes[ne] === 0x50 && bytes[ne + 1] === 0x45) {
      const signature = 'W32INST.dll';
      outer: for (let i = 0; i + signature.length <= bytes.length; i++) {
        for (let j = 0; j < signature.length; j++) {
          if (bytes[i + j] !== signature.charCodeAt(j)) continue outer;
        }
        return { path, bytes, format: 'w32inst' };
      }
    }
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { seedExeImage, win16FileCandidates, residentWin16Module };
}
if (typeof window !== 'undefined') {
  window.VfsSeed = { seedExeImage, win16FileCandidates, residentWin16Module };
}
