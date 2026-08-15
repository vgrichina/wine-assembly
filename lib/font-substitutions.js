// Where the vendored open fonts get mounted so a guest can find them.
//
// WAT asks the VFS for the same filenames Win98 had — C:\WINDOWS\FONTS\
// ARIAL.TTF, TAHOMABD.TTF — and never learns which font actually answers.
// That keeps face substitution, and with it every licensing and vendoring
// decision, entirely on the host side, exactly like the bundled .FON strikes
// already work. fonts/substitutions.json is the single map both hosts read;
// this module turns it into the mount list each one applies its own way
// (readFileSync in the CLI harness, fetch in the browser).

const FONT_DIR = 'c:\\windows\\fonts\\';

// [{ vfsPath, file, face, style }] — `file` is relative to fonts/.
function fontMounts(manifest) {
  const mounts = [];
  for (const face of manifest.faces || []) {
    if (!face.win98Files) continue;
    for (const style of Object.keys(face.win98Files)) {
      const file = face.styles && face.styles[style];
      // test/test-font-substitutions.js already rejects a manifest that maps a
      // style with no substitute behind it. Skipping here too means a stale
      // deployed manifest degrades to "face unavailable" rather than mounting
      // `undefined` and failing later inside the parser.
      if (!file) continue;
      mounts.push({
        vfsPath: FONT_DIR + face.win98Files[style].toLowerCase(),
        file,
        face: face.win98,
        style,
      });
    }
  }
  return mounts;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fontMounts, FONT_DIR };
} else if (typeof window !== 'undefined') {
  window.fontMounts = fontMounts;
  window.fontSubstitutions = { fontMounts, FONT_DIR };
}
