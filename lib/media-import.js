// From dropped bytes to a launchable app, with no UI in it.
//
// Phase ④ of docs/design-byo-media.md. The dialog (lib/media-import-ui.js)
// asks the questions; this file does the work, and is deliberately separate so
// that "what happens when you drop an ISO" can be reasoned about — and driven
// by a test — without a click.
//
// Two steps, and the split between them is the point:
//
//   analyze(source)   read the catalog, decide the container, list the exe
//                     candidates. Mounts NOTHING. This is what the dialog
//                     needs in order to have something to say, and it must be
//                     cheap: a 638MB ISO is analyzed by reading its
//                     descriptors and directory tree, a few dozen KB.
//
//   makeAppEntry()    turn the analysis plus the visitor's choice into an
//                     entry for the same registry lib/apps.js fills, so a
//                     dropped game launches through the identical path as a
//                     built-in one — same shell, same DLL graph, same run
//                     slice. The only difference is where its bytes come from.
//
// ---- why the app entry carries functions, not URLs ----------------------
//
// A registered app is `{exe: 'binaries/notepad.exe', files: [...]}` — URLs the
// launch fetches. An imported app has no URL and never will: its bytes are a
// File the visitor picked, or an OPFS copy, and its data files are inside a
// container that has not been mounted yet at registry time. So a dynamic entry
// carries `mounts` (applied to the VFS right after the guest instance exists)
// and `exeBytes` (resolved from the mounted VFS afterwards). lib/browser-shell
// honours both; everything else about the launch is untouched.

(function () {
  'use strict';

  function mod(name, global) {
    if (typeof require === 'function') {
      try { return require(name); } catch (_) { /* browser */ }
    }
    return (typeof window !== 'undefined' ? window[global] : null) || null;
  }

  const sniff = () => mod('./media-sniff', 'mediaSniff');
  const zip = () => mod('./zip-mount', 'ZipMount');
  const iso = () => mod('./iso9660', 'Iso9660');
  const bp = () => mod('./byte-provider', 'byteProvider');

  const DEFAULT_ISO_DRIVE = 'D';

  function baseName(path) {
    return String(path || '').replace(/\\/g, '/').split('/').pop();
  }

  // A stable, filesystem-safe id for the app registry and the desktop icon.
  // Derived from the media's name so two imports of the same disc collide
  // rather than piling up two icons for one game.
  function idFor(name, prefix) {
    const stem = String(name || 'media').replace(/\.[^.]*$/, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${prefix || 'media'}:${stem || 'item'}`;
  }

  function providerFor(source, name) {
    const b = bp();
    if (!b) throw new Error('lib/byte-provider.js is not loaded');
    if (source && source.tryRead && source.fill) return source;
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      return b.cached(new b.BlobProvider(source, name));
    }
    if (source instanceof Uint8Array) return b.cached(new b.BytesProvider(source, name));
    if (source && typeof source.readRange === 'function') return b.cached(source);
    throw new Error('media import: source is not a File, a Uint8Array, or a byte provider');
  }

  // Rank exe candidates the way a person would scan a folder: a name that
  // matches the media (KEEN4.EXE inside keen4.zip) first, then shallow before
  // deep, then alphabetically. Setup/install programs sink, because an
  // archive holding both a game and its installer almost always means to run
  // the game — but they are never hidden, only ordered.
  function rankCandidates(candidates, mediaName) {
    const stem = String(mediaName || '').replace(/\.[^.]*$/, '').toLowerCase();
    const score = (c) => {
      const name = c.name.toLowerCase().replace(/\.exe$/, '');
      let s = 0;
      if (stem && name === stem) s -= 100;
      if (/^(setup|install|unwise|uninst)/.test(name)) s += 50;
      s += (c.path.match(/\\/g) || []).length;
      return s;
    };
    return candidates.slice().sort((a, b2) => score(a) - score(b2) ||
      a.path.localeCompare(b2.path));
  }

  function exeCandidatesFromPaths(paths, mediaName) {
    const out = [];
    for (const path of paths) {
      if (!/\.exe$/i.test(path)) continue;
      out.push({ path, name: baseName(path) });
    }
    return rankCandidates(out, mediaName);
  }

  // ---- analysis -----------------------------------------------------------

  // What is this, and what could it launch? Reads only what it must.
  //
  // `source` is a File (drag-drop, <input type=file>, or an OPFS copy from the
  // library), a Uint8Array, or a byte provider. `name` defaults to the File's.
  async function analyze(source, opts) {
    const options = opts || {};
    const name = options.name || (source && source.name) || 'media';
    const size = (source && (source.size !== undefined ? source.size : source.length)) || 0;
    const detected = await sniff().sniffSource(source, { name, size });
    const provider = providerFor(source, name);

    const base = {
      name,
      size,
      kind: detected.kind,
      label: detected.label,
      flavor: detected.flavor,
      provider,
      source,
      volumeLabel: null,
      exeCandidates: [],
      entryCount: 0,
      mountRoot: null,
    };

    if (detected.kind === 'zip') return analyzeZip(base, options);
    if (detected.kind === 'iso') return analyzeIso(base, options);
    if (detected.kind === 'exe') return analyzeExe(base, options);
    return {
      ...base,
      id: idFor(name, 'file'),
      // A data file has nowhere obvious to go and no exe to run, so it mounts
      // beside a chosen folder rather than guessing. Until the visitor picks
      // one there is nothing to do but say what it is.
      mount: null,
    };
  }

  async function analyzeZip(base, options) {
    const Z = zip();
    const src = Z.toSource(base.provider);
    const entries = await Z.readCatalogAsync(src);
    const plan = Z.mountPlan(entries, { zipPath: base.name, ...options.mountOptions });
    const paths = plan.mapped.map(m => m.path);
    return {
      ...base,
      id: idFor(base.name, 'zip'),
      entryCount: paths.length,
      mountRoot: plan.root,
      exeCandidates: exeCandidatesFromPaths(paths, base.name),
      async mount(vfs) {
        return Z.mountZip(vfs, base.provider, { zipPath: base.name, ...options.mountOptions });
      },
    };
  }

  async function analyzeIso(base, options) {
    const I = iso();
    const drive = String(options.drive || DEFAULT_ISO_DRIVE).toUpperCase();
    // parseIsoAsync warms the same chunk cache the mount then reads through,
    // so the descriptors and directory tree are read exactly once between
    // analysis and mount.
    const { iso: parsed, provider } = await I.parseIsoAsync(base.provider, options.isoOptions);
    const root = `${drive}:\\`;
    const paths = parsed.files.filter(f => !f.isDirectory).map(f => root + f.path);
    return {
      ...base,
      id: idFor(base.name, 'iso'),
      volumeLabel: parsed.volumeLabel,
      entryCount: paths.length,
      mountRoot: root,
      exeCandidates: exeCandidatesFromPaths(paths, parsed.volumeLabel || base.name),
      async mount(vfs) {
        return I.mountIso(vfs, base.provider, {
          drive,
          parsed,
          provider: provider || base.provider,
          ...options.isoOptions,
        });
      },
    };
  }

  async function analyzeExe(base) {
    // A bare program is mounted at the root of C:, which is where today's
    // registered apps already put their exe — so a dropped game and a built-in
    // one look identical to the guest, including its own argv[0].
    const path = `C:\\${baseName(base.name).toUpperCase()}`;
    return {
      ...base,
      id: idFor(base.name, 'exe'),
      entryCount: 1,
      mountRoot: 'C:\\',
      exeCandidates: [{ path, name: baseName(path) }],
      async mount(vfs) {
        // Small by definition next to the containers, and the PE loader needs
        // every byte of it immediately, so this is the one import that copies.
        const bytes = await readAll(base.provider);
        vfs.files.set(vfs._normPath(path), { data: bytes, attrs: 0x20 });
        vfs.ensureParentDirs(path);
        return { root: 'C:\\', mounted: [path] };
      },
    };
  }

  async function readAll(provider) {
    const size = provider.size;
    const out = new Uint8Array(size);
    const CHUNK = 4 * 1024 * 1024;
    for (let off = 0; off < size; off += CHUNK) {
      const want = Math.min(CHUNK, size - off);
      const bytes = await provider.readRange(off, want);
      out.set(bytes.subarray(0, want), off);
    }
    return out;
  }

  // ---- the app entry ------------------------------------------------------

  // The registry entry a dropped import launches through. Shape-compatible
  // with lib/apps.js on purpose: the desktop, the launch path and the CLI all
  // read the same table, so an import that needed a parallel launcher would be
  // a second code path to keep working forever.
  //
  //   exePath   which candidate the visitor chose
  //   badge     'session' (gone on reload) or 'kept' (in the OPFS library)
  //   mediaId   the library row, when kept — how a reload finds the bytes
  function makeAppEntry(plan, opts) {
    const options = opts || {};
    const exePath = options.exePath ||
      (plan.exeCandidates[0] && plan.exeCandidates[0].path);
    if (!exePath) throw new Error(`${plan.name} has no executable to launch`);
    return {
      exe: exePath,
      dynamic: true,
      badge: options.badge || 'session',
      mediaId: options.mediaId || null,
      mediaKind: plan.kind,
      label: options.label || baseName(exePath).replace(/\.exe$/i, ''),
      mediaName: plan.name,
      // Applied to the guest's VFS after init() and before the PE is loaded —
      // the exe itself lives inside these mounts.
      mounts: plan.mount ? [async (vfs) => plan.mount(vfs)] : [],
      // Resolved after the mounts, from the VFS they created. A provider-backed
      // entry is materialized here because the PE loader is not a parked-read
      // consumer (risk register item 1): it needs the whole image at once.
      exeBytes: async (vfs) => {
        const norm = vfs._normPath(exePath);
        if (!vfs.files.has(norm)) {
          throw new Error(`${exePath} is not in the mounted media`);
        }
        return vfs.materialize(exePath);
      },
    };
  }

  const api = {
    DEFAULT_ISO_DRIVE,
    analyze,
    makeAppEntry,
    exeCandidatesFromPaths,
    rankCandidates,
    idFor,
    baseName,
    providerFor,
    readAll,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.mediaImport = api;
})();
