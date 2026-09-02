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
  const cdrom = () => mod('./cdrom', 'CdRom');

  const DEFAULT_ISO_DRIVE = 'D';
  const RAW_MODE1_SECTOR_BYTES = 2352;
  const RAW_MODE1_PAYLOAD_OFFSET = 16;
  const ISO_VOLUME_DESCRIPTOR_LBA = 16;

  function isRawMode1Header(bytes) {
    if (!bytes || bytes.length < RAW_MODE1_PAYLOAD_OFFSET ||
        bytes[0] !== 0 || bytes[11] !== 0 || bytes[15] !== 1) return false;
    for (let i = 1; i < 11; i++) if (bytes[i] !== 0xff) return false;
    return true;
  }

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

  // CD-DA is headerless signed 16-bit stereo PCM. It cannot tell us where
  // tracks begin, but music is usually much smoother sample-to-sample than
  // compressed/random bytes. Raw Mode 1 headers are a stronger data signal.
  // This remains advisory and never fabricates a disc TOC.
  async function classifyRawTail(provider, byteOffset, byteLength) {
    const sectors = Math.floor(byteLength / RAW_MODE1_SECTOR_BYTES);
    if (!sectors) return 'none';
    const windowSectors = Math.min(4, sectors);
    const starts = [...new Set([0, Math.floor((sectors - windowSectors) / 2),
      sectors - windowSectors])];
    let sampledSectors = 0, mode1Headers = 0;
    let sampleCount = 0, zeroCount = 0, absSum = 0, deltaSum = 0, deltaCount = 0;
    try {
      for (const start of starts) {
        const bytes = new Uint8Array(await provider.readRange(
          byteOffset + start * RAW_MODE1_SECTOR_BYTES,
          windowSectors * RAW_MODE1_SECTOR_BYTES));
        for (let sector = 0; sector < windowSectors; sector++) {
          const at = sector * RAW_MODE1_SECTOR_BYTES;
          if (at + RAW_MODE1_SECTOR_BYTES > bytes.length) break;
          sampledSectors++;
          if (isRawMode1Header(bytes.subarray(at, at + RAW_MODE1_PAYLOAD_OFFSET))) {
            mode1Headers++;
          }
        }
        let prevLeft = null, prevRight = null;
        for (let at = 0; at + 3 < bytes.length; at += 4) {
          let left = bytes[at] | (bytes[at + 1] << 8);
          let right = bytes[at + 2] | (bytes[at + 3] << 8);
          if (left & 0x8000) left -= 0x10000;
          if (right & 0x8000) right -= 0x10000;
          absSum += Math.abs(left) + Math.abs(right);
          zeroCount += (left === 0 ? 1 : 0) + (right === 0 ? 1 : 0);
          sampleCount += 2;
          if (prevLeft !== null) {
            deltaSum += Math.abs(left - prevLeft) + Math.abs(right - prevRight);
            deltaCount += 2;
          }
          prevLeft = left;
          prevRight = right;
        }
      }
    } catch (_) {
      return 'unknown';
    }
    if (sampledSectors && mode1Headers * 2 >= sampledSectors) return 'mode1-data';
    if (!sampleCount || zeroCount / sampleCount > 0.98) return 'silence-or-padding';
    const meanAbs = absSum / sampleCount;
    const meanDelta = deltaCount ? deltaSum / deltaCount : Infinity;
    return meanAbs >= 128 && meanDelta / meanAbs < 0.9 ? 'likely-audio' : 'unknown';
  }

  // Kept bundles come back from OPFS as `{name, source}` descriptors so their
  // original CUE names survive opaque storage filenames. A freshly selected
  // File is already the same shape conceptually; normalize both here.
  function sourcePart(value) {
    const source = value && value.source ? value.source : value;
    const rawSize = value && value.size !== undefined ? value.size :
      source && source.size !== undefined ? source.size :
      source && source.length !== undefined ? source.length : 0;
    return {
      source,
      name: String((value && value.name) || (source && source.name) || 'media'),
      relativePath: String((value && value.relativePath) ||
        (source && source.webkitRelativePath) || (value && value.name) ||
        (source && source.name) || 'media').replace(/\\/g, '/'),
      size: Number(rawSize) || 0,
    };
  }

  function cuePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  }

  function findCuePart(parts, wanted) {
    const key = cuePath(wanted);
    const exact = parts.filter(part => cuePath(part.relativePath) === key || cuePath(part.name) === key);
    if (exact.length === 1) return exact[0];
    const leaf = key.split('/').pop();
    const byLeaf = parts.filter(part => cuePath(part.name).split('/').pop() === leaf);
    if (byLeaf.length === 1) return byLeaf[0];
    if (exact.length > 1 || byLeaf.length > 1) {
      throw new Error(`media import: CUE file "${wanted}" is ambiguous in this selection`);
    }
    throw new Error(`media import: CUE references missing file "${wanted}"; select the .cue and all of its .bin files together`);
  }

  async function readCueText(part) {
    if (part.size > 1024 * 1024) throw new Error('media import: CUE sheet is unexpectedly larger than 1 MB');
    let bytes;
    if (typeof Blob !== 'undefined' && part.source instanceof Blob) {
      bytes = new Uint8Array(await part.source.arrayBuffer());
    } else {
      bytes = await readAll(providerFor(part.source, part.name));
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Rank exe candidates the way a person would scan a folder: a name that
  // matches the media (KEEN4.EXE inside keen4.zip) first, then shallow before
  // deep, then alphabetically. Setup/install programs sink, because an
  // archive holding both a game and its installer almost always means to run
  // the game — but they are never hidden, only ordered.
  function rankCandidates(candidates, mediaName) {
    const stem = String(mediaName || '').replace(/\.[^.]*$/, '').toLowerCase();
    const compactStem = stem.replace(/[^a-z0-9]/g, '');
    const score = (c) => {
      const name = c.name.toLowerCase().replace(/\.exe$/, '');
      let s = 0;
      if (stem && name === stem) s -= 100;
      else if (name.length >= 4 && compactStem.includes(name.replace(/[^a-z0-9]/g, ''))) s -= 80;
      if (/^(setup|install|unwise|uninst|_?isdel|autorun|dxsetup|ddhelp)/.test(name)) s += 50;
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

  // What Win98 itself would launch on insert: the [autorun] section's open=
  // line (shellexecute= as the fallback), value possibly quoted and possibly
  // carrying arguments. Returns the bare program path or null.
  function autorunInfTarget(text) {
    let section = null;
    let open = null, shellExecute = null;
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(';')) continue;
      const header = line.match(/^\[([^\]]+)\]$/);
      if (header) { section = header[1].trim().toLowerCase(); continue; }
      if (section !== 'autorun') continue;
      const kv = line.match(/^(open|shellexecute)\s*=\s*(.+)$/i);
      if (!kv) continue;
      const quoted = kv[2].trim().match(/^"([^"]*)"/);
      const value = (quoted ? quoted[1] : kv[2].trim().split(/\s+/)[0])
        .replace(/\//g, '\\').replace(/^\.?\\+/, '').trim();
      if (!value) continue;
      if (kv[1].toLowerCase() === 'open') { if (!open) open = value; }
      else if (!shellExecute) shellExecute = value;
    }
    return open || shellExecute;
  }

  // ---- analysis -----------------------------------------------------------

  // What is this, and what could it launch? Reads only what it must.
  //
  // `source` is a File (drag-drop, <input type=file>, or an OPFS copy from the
  // library), a Uint8Array, or a byte provider. `name` defaults to the File's.
  async function analyze(source, opts) {
    const options = opts || {};
    const part = sourcePart(source);
    source = part.source;
    const name = options.name || part.name;
    const size = part.size;
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
      storageFiles: [part],
      volumeLabel: null,
      exeCandidates: [],
      entryCount: 0,
      mountRoot: null,
    };

    if (detected.kind === 'zip') return analyzeZip(base, options);
    if (detected.kind === 'iso') return analyzeIso(base, options);
    if (detected.kind === 'exe') return analyzeExe(base, options);
    const rawMode1 = await analyzeRawMode1(base, options);
    if (rawMode1) return rawMode1;
    return {
      ...base,
      id: idFor(name, 'file'),
      // A data file has nowhere obvious to go and no exe to run, so it mounts
      // beside a chosen folder rather than guessing. Until the visitor picks
      // one there is nothing to do but say what it is.
      mount: null,
    };
  }

  // A BIN can contain an ISO 9660 byte stream wrapped in raw 2352-byte Mode 1
  // sectors. The CUE normally tells us that wrapping and the real track map;
  // without one, expose the validated ISO data volume but explicitly leave
  // any remaining sectors alone. They may be padding, pregap, or CD audio,
  // and no byte statistic can recover trustworthy audio-track boundaries.
  async function analyzeRawMode1(base, options) {
    const C = cdrom();
    const size = Number(base.provider && base.provider.size);
    if (!C || !Number.isSafeInteger(size) || size <= 0 ||
        size % RAW_MODE1_SECTOR_BYTES !== 0) return null;

    const sectorOffset = ISO_VOLUME_DESCRIPTOR_LBA * RAW_MODE1_SECTOR_BYTES;
    if (sectorOffset + RAW_MODE1_PAYLOAD_OFFSET + 7 > size) return null;
    const probe = new Uint8Array(await base.provider.readRange(
      sectorOffset, RAW_MODE1_PAYLOAD_OFFSET + 7));
    const descriptor = probe.subarray(RAW_MODE1_PAYLOAD_OFFSET);
    if (!isRawMode1Header(probe) || descriptor.length < 7 ||
        descriptor[1] !== 0x43 || descriptor[2] !== 0x44 ||
        descriptor[3] !== 0x30 || descriptor[4] !== 0x30 || descriptor[5] !== 0x31 ||
        descriptor[6] !== 1) return null;

    const mode1 = C.mode1Provider(base.provider, {
      type: 'MODE1/2352',
      byteOffset: 0,
      sectors: size / RAW_MODE1_SECTOR_BYTES,
      name: `${base.name}:raw-mode1`,
    });
    let parsed;
    try {
      parsed = await iso().parseIsoAsync(mode1, options.isoOptions);
    } catch (_) {
      return null;
    }
    const volumeBytes = parsed.iso.volumeSpaceSize * parsed.iso.blockSize;
    if (!Number.isSafeInteger(volumeBytes) || volumeBytes <= 0 ||
        volumeBytes > mode1.size || volumeBytes % C.COOKED_SECTOR_BYTES !== 0) return null;
    const dataSectors = volumeBytes / C.COOKED_SECTOR_BYTES;
    const trailingSectors = (mode1.size - volumeBytes) / C.COOKED_SECTOR_BYTES;
    const dataProvider = dataSectors === size / RAW_MODE1_SECTOR_BYTES ? mode1 :
      C.mode1Provider(base.provider, {
        type: 'MODE1/2352',
        byteOffset: 0,
        sectors: dataSectors,
        name: `${base.name}:inferred-data-track`,
      });

    // Re-parse the bounded provider when the raw file has a tail. That keeps
    // the parsed image and the provider used by mounted file extents identical
    // instead of retaining a view that also spans guessed-at non-data sectors.
    if (dataProvider !== mode1) parsed = await iso().parseIsoAsync(dataProvider, options.isoOptions);
    const trailingBytes = trailingSectors * RAW_MODE1_SECTOR_BYTES;
    const trailingGuess = trailingSectors
      ? await classifyRawTail(base.provider, dataSectors * RAW_MODE1_SECTOR_BYTES, trailingBytes)
      : 'none';
    const trailingNote = trailingSectors
      ? trailingGuess === 'likely-audio'
        ? ` ${trailingBytes.toLocaleString()} trailing bytes look like CD audio, but ` +
          'their track boundaries cannot be recovered without the CUE.'
        : ` ${trailingBytes.toLocaleString()} trailing bytes were not interpreted; ` +
          'they may contain CD audio or padding.'
      : '';

    return analyzeIso({
      ...base,
      kind: 'iso',
      label: 'Raw Mode 1 ISO 9660 CD image (best effort)',
      flavor: 'mode1/2352',
      provider: dataProvider,
      inferredTrackLayout: true,
      unparsedTrailingBytes: trailingBytes,
      trailingSectorGuess: trailingGuess,
      warning: 'A matching .cue file is required for the correct track layout, ' +
        `pregaps, and CD audio. Only the detected ISO data track will be mounted.${trailingNote}`,
    }, options, parsed);
  }

  // Analyze one mixed-mode CUE plus the files it names as one piece of media.
  // The data track is a provider window over either a cooked MODE1/2048 image
  // or the payload bytes within raw MODE1/2352 sectors; audio files remain
  // unopened until MCI plays a track.
  async function analyzeCueBundle(values, opts) {
    const options = opts || {};
    const parts = Array.from(values || []).map(sourcePart);
    const cuePart = options.cuePart ? sourcePart(options.cuePart) :
      parts.find(part => /\.cue$/i.test(part.name));
    if (!cuePart) throw new Error('media import: a CUE bundle needs a .cue file');
    const C = cdrom();
    if (!C) throw new Error('lib/cdrom.js is not loaded');
    const cueText = await readCueText(cuePart);
    const parsedCue = C.parseCue(cueText);
    const resolved = new Map();
    for (const file of parsedCue.files) {
      resolved.set(file.name, findCuePart(parts, file.name));
    }
    const storageFiles = [cuePart];
    for (const part of resolved.values()) if (!storageFiles.includes(part)) storageFiles.push(part);

    const providers = new Map();
    for (const [name, part] of resolved) providers.set(name, providerFor(part.source, part.name));
    const dataTracks = parsedCue.tracks.filter(track => !track.isAudio);
    if (dataTracks.length > 1) {
      throw new Error('media import: CUEs with more than one data track are not supported');
    }
    if (dataTracks.length && dataTracks[0].type !== 'MODE1/2352' &&
        dataTracks[0].type !== 'MODE1/2048') {
      throw new Error(`media import: data track type ${dataTracks[0].type} is not supported ` +
        '(expected MODE1/2048 or MODE1/2352)');
    }

    const drive = String(options.drive || DEFAULT_ISO_DRIVE).toUpperCase();
    let parsedIso = null;
    let isoProvider = null;
    let paths = [];
    if (dataTracks.length) {
      const track = dataTracks[0];
      const raw = providers.get(track.file);
      const range = C.trackFileRange(parsedCue, track, raw.size);
      const mode1 = C.mode1Provider(raw, {
        type: track.type,
        byteOffset: range.byteOffset,
        sectors: range.sectors,
        name: `${cuePart.name}:track-${track.number}`,
      });
      const parsed = await iso().parseIsoAsync(mode1, options.isoOptions);
      parsedIso = parsed.iso;
      isoProvider = parsed.provider || mode1;
      paths = parsedIso.files.filter(file => !file.isDirectory)
        .map(file => `${drive}:\\${file.path}`);
    }

    const volumeLabel = parsedIso ? parsedIso.volumeLabel : 'AUDIO_CD';
    const audioCount = parsedCue.tracks.filter(track => track.isAudio).length;
    return {
      id: idFor(cuePart.name, 'cue'),
      name: cuePart.name,
      size: storageFiles.reduce((sum, part) => sum + part.size, 0),
      kind: 'cue',
      label: dataTracks.length
        ? `Mixed-mode CD image (${audioCount} audio track${audioCount === 1 ? '' : 's'})`
        : `Audio CD image (${audioCount} track${audioCount === 1 ? '' : 's'})`,
      flavor: 'cue-bin',
      provider: null,
      source: cuePart.source,
      storageFiles,
      volumeLabel,
      entryCount: paths.length,
      mountRoot: `${drive}:\\`,
      exeCandidates: exeCandidatesFromPaths(paths, volumeLabel || cuePart.name),
      cueText,
      parsedCue,
      async mount(vfs) {
        let mounted = null;
        if (parsedIso) {
          mounted = iso().mountIso(vfs, isoProvider, {
            drive,
            parsed: parsedIso,
            provider: isoProvider,
            ...options.isoOptions,
          });
        }
        const disc = C.mountCue(vfs, cueText, {
          drive,
          volumeLabel,
          trackSize(name) { return providers.get(name).size; },
          loadTrack(name) { return readAll(providers.get(name)); },
        });
        return { ...(mounted || { drive, root: `${drive}:\\`, fileCount: 0 }), disc };
      },
    };
  }

  // A picker/drop is one operation, not N unrelated files. Each CUE consumes
  // the files it references; everything left over follows the existing
  // single-file import path. This keeps selecting several ZIPs useful while
  // making `.cue + track01.bin + track02.bin` one disc and one dialog.
  async function analyzeFiles(values, opts) {
    const options = opts || {};
    const parts = Array.from(values || []).map(sourcePart);
    const cues = parts.filter(part => /\.cue$/i.test(part.name));
    const consumed = new Set();
    const plans = [];
    for (const cue of cues) {
      const text = await readCueText(cue);
      const parsed = cdrom().parseCue(text);
      const members = [cue];
      for (const file of parsed.files) {
        const part = findCuePart(parts, file.name);
        if (!members.includes(part)) members.push(part);
      }
      members.forEach(part => consumed.add(part));
      plans.push(await analyzeCueBundle(members, { ...options, cuePart: cue }));
    }
    // GOG-style offline installers are an exe plus numbered .bin sidecars.
    // Group only a sidecar whose basename starts with the full setup-exe stem;
    // unrelated BINs keep following the ordinary unknown-file path.
    for (const exePart of parts.filter(part => !consumed.has(part) && /\.exe$/i.test(part.name))) {
      const stem = cuePath(exePart.name).replace(/\.exe$/, '');
      const sidecars = parts.filter(part => !consumed.has(part) && /\.bin$/i.test(part.name) &&
        cuePath(part.name).startsWith(stem + '-'));
      if (!sidecars.length) continue;
      const plan = await analyze(exePart, { ...options, name: exePart.name, sidecars });
      if (plan.kind !== 'exe') continue; // extension lied; magic still wins
      consumed.add(exePart);
      sidecars.forEach(part => consumed.add(part));
      plans.push(plan);
    }
    for (const part of parts) {
      if (!consumed.has(part)) plans.push(await analyze(part, { ...options, name: part.name }));
    }
    return plans;
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

  async function analyzeIso(base, options, prepared) {
    const I = iso();
    const drive = String(options.drive || DEFAULT_ISO_DRIVE).toUpperCase();
    // parseIsoAsync warms the same chunk cache the mount then reads through,
    // so the descriptors and directory tree are read exactly once between
    // analysis and mount.
    const { iso: parsed, provider } = prepared ||
      await I.parseIsoAsync(base.provider, options.isoOptions);
    const root = `${drive}:\\`;
    const paths = parsed.files.filter(f => !f.isDirectory).map(f => root + f.path);
    let exeCandidates = exeCandidatesFromPaths(paths, parsed.volumeLabel || base.name);
    // A CD names its own program: Win98 runs whatever the disc's AUTORUN.INF
    // open= line points at, so that exe outranks every filename heuristic —
    // the generic ranking deliberately sinks "autorun"-named files, which is
    // right for a zip of a game and exactly wrong for a disc that says so.
    const inf = parsed.files.find(f => !f.isDirectory && f.path.toUpperCase() === 'AUTORUN.INF');
    if (inf && inf.length > 0 && inf.length <= 64 * 1024) {
      try {
        const raw = await Promise.resolve(
          (provider || base.provider).readRange(inf.offset, inf.length));
        const target = autorunInfTarget(new TextDecoder('latin1').decode(raw));
        if (target) {
          const wanted = (root + target).toUpperCase();
          const hit = exeCandidates.find(c => c.path.toUpperCase() === wanted);
          if (hit) {
            hit.autorun = true;
            exeCandidates = [hit, ...exeCandidates.filter(c => c !== hit)];
          }
        }
      } catch (_) { /* an unreadable INF falls back to the ranking */ }
    }
    return {
      ...base,
      id: idFor(base.name, 'iso'),
      volumeLabel: parsed.volumeLabel,
      entryCount: paths.length,
      mountRoot: root,
      exeCandidates,
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

  async function analyzeExe(base, options = {}) {
    // A bare program is mounted at the root of C:, which is where today's
    // registered apps already put their exe — so a dropped game and a built-in
    // one look identical to the guest, including its own argv[0].
    const path = `C:\\${baseName(base.name).toUpperCase()}`;
    const sidecars = Array.from(options.sidecars || []).map(sourcePart);
    const sidecarMounts = sidecars.map(part => ({
      part,
      path: `C:\\${baseName(part.name).toUpperCase()}`,
      provider: providerFor(part.source, part.name),
    }));
    return {
      ...base,
      storageFiles: base.storageFiles.concat(sidecars),
      label: sidecars.length
        ? `${base.label} with ${sidecars.length} installer data file${sidecars.length === 1 ? '' : 's'}`
        : base.label,
      id: idFor(base.name, 'exe'),
      entryCount: 1 + sidecars.length,
      mountRoot: 'C:\\',
      exeCandidates: [{ path, name: baseName(path) }],
      async mount(vfs) {
        // Small by definition next to the containers, and the PE loader needs
        // every byte of it immediately, so this is the one import that copies.
        const bytes = await readAll(base.provider);
        vfs.files.set(vfs._normPath(path), { data: bytes, attrs: 0x20 });
        vfs.ensureParentDirs(path);
        const mounted = [path];
        for (const sidecar of sidecarMounts) {
          vfs.ensureParentDirs(sidecar.path);
          if (typeof vfs.setProviderFile === 'function') {
            vfs.setProviderFile(sidecar.path, {
              provider: sidecar.provider,
              offset: 0,
              length: sidecar.provider.size,
              attrs: 0x20,
            });
          } else {
            vfs.files.set(vfs._normPath(sidecar.path), {
              data: await readAll(sidecar.provider), attrs: 0x20,
            });
          }
          mounted.push(sidecar.path);
        }
        return { root: 'C:\\', mounted };
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
    analyzeFiles,
    analyzeCueBundle,
    makeAppEntry,
    exeCandidatesFromPaths,
    rankCandidates,
    autorunInfTarget,
    idFor,
    baseName,
    providerFor,
    sourcePart,
    readAll,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.mediaImport = api;
})();
