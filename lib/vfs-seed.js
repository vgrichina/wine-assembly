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
  const bases = [...new Set([name, name.toUpperCase(), name.toLowerCase()])];
  // Deliberately not .IW, IdleWild's screen-saver libraries: staging those
  // makes the app worse, not better. It loads all six, runs out of module
  // slots part way through and stops with "Cannot start IdleWild!", where
  // leaving them unfound costs only the previews.
  return bases.flatMap(base => [`${base}.DLL`, `${base}.dll`, `${base}.VBX`,
                                `${base}.vbx`, `${base}.EXE`]);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { seedExeImage, win16FileCandidates };
}
if (typeof window !== 'undefined') {
  window.VfsSeed = { seedExeImage, win16FileCandidates };
}
