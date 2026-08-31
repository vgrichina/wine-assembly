// Mixed-mode CUE/BIN support shared by the CLI and browser hosts.
//
// The ISO 9660 data track is mounted separately by lib/iso9660.js. This file
// owns the disc table of contents and raw CD-DA tracks: one 2352-byte sector is
// 588 stereo PCM frames at 44.1 kHz. Track bytes remain lazy until MCI asks to
// play them.

(function () {
  'use strict';

  const SECTOR_BYTES = 2352;
  const SECTORS_PER_SECOND = 75;
  const PCM_FRAMES_PER_SECTOR = 588;
  const SAMPLE_RATE = 44100;

  function msfToSector(value) {
    const match = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(String(value || '').trim());
    if (!match) throw new Error(`cdrom: invalid MSF value "${value}"`);
    const minute = Number(match[1]);
    const second = Number(match[2]);
    const frame = Number(match[3]);
    if (second >= 60 || frame >= SECTORS_PER_SECOND) {
      throw new Error(`cdrom: invalid MSF value "${value}"`);
    }
    return (minute * 60 + second) * SECTORS_PER_SECOND + frame;
  }

  function safeTrackFile(value) {
    const name = String(value || '').replace(/\\/g, '/');
    if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
        name.split('/').some(part => part === '..')) {
      throw new Error(`cdrom: unsafe CUE track path "${value}"`);
    }
    return name;
  }

  function parseCue(text) {
    let currentFile = '';
    let currentFileIndex = -1;
    let currentTrack = null;
    const files = [];
    const tracks = [];
    for (const [lineIndex, raw] of String(text || '').split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line || /^REM(?:\s|$)/i.test(line)) continue;
      let match = /^FILE\s+(?:"([^"]+)"|(\S+))\s+(\S+)$/i.exec(line);
      if (match) {
        currentFile = safeTrackFile(match[1] != null ? match[1] : match[2]);
        currentFileIndex = files.length;
        files.push({ name: currentFile, type: match[3].toUpperCase(), index: currentFileIndex });
        currentTrack = null;
        continue;
      }
      match = /^TRACK\s+(\d{1,2})\s+(\S+)$/i.exec(line);
      if (match) {
        if (!currentFile) throw new Error(`cdrom: TRACK before FILE at line ${lineIndex + 1}`);
        const number = Number(match[1]);
        if (!number || number > 99 || tracks.some(track => track.number === number)) {
          throw new Error(`cdrom: invalid or duplicate track ${match[1]}`);
        }
        currentTrack = {
          number,
          type: match[2].toUpperCase(),
          file: currentFile,
          fileIndex: currentFileIndex,
          indexes: new Map(),
          pregapSectors: 0,
        };
        tracks.push(currentTrack);
        continue;
      }
      match = /^INDEX\s+(\d{1,2})\s+(\d+:\d{1,2}:\d{1,2})$/i.exec(line);
      if (match) {
        if (!currentTrack) throw new Error(`cdrom: INDEX before TRACK at line ${lineIndex + 1}`);
        currentTrack.indexes.set(Number(match[1]), msfToSector(match[2]));
        continue;
      }
      match = /^PREGAP\s+(\d+:\d{1,2}:\d{1,2})$/i.exec(line);
      if (match) {
        if (!currentTrack) throw new Error(`cdrom: PREGAP before TRACK at line ${lineIndex + 1}`);
        currentTrack.pregapSectors = msfToSector(match[1]);
      }
    }
    if (!tracks.length) throw new Error('cdrom: CUE has no tracks');
    tracks.sort((a, b) => a.number - b.number);
    for (let i = 0; i < tracks.length; i++) {
      if (i && tracks[i].number !== tracks[i - 1].number + 1) {
        throw new Error('cdrom: track numbers must be continuous');
      }
      if (!tracks[i].indexes.has(1)) {
        throw new Error(`cdrom: track ${tracks[i].number} has no INDEX 01`);
      }
      tracks[i].index0Sector = tracks[i].indexes.get(0) ?? tracks[i].indexes.get(1);
      tracks[i].index1Sector = tracks[i].indexes.get(1);
      tracks[i].isAudio = tracks[i].type === 'AUDIO';
    }
    return { files, tracks };
  }

  function normalizeSize(size, file) {
    const value = Number(size);
    if (!Number.isSafeInteger(value) || value <= 0 || value % SECTOR_BYTES) {
      throw new Error(`cdrom: "${file}" size must be a positive multiple of ${SECTOR_BYTES}`);
    }
    return value;
  }

  // ISO 9660 sees the 2048-byte user-data portion of a raw MODE1/2352 track.
  // A CUE/BIN dump stores each sector as sync (12), header (4), payload
  // (2048), EDC/ECC (288). Expose a byte-provider-shaped window over only the
  // payload so lib/iso9660.js can parse and mount it without rewriting a
  // 700MB BIN into a second in-memory image.
  function mode1RawProvider(source, opts = {}) {
    if (!source || typeof source.readRange !== 'function') {
      throw new Error('cdrom: MODE1 source must be a byte provider');
    }
    const rawOffset = Number(opts.rawOffset || 0);
    const sectors = Number(opts.sectors);
    if (!Number.isSafeInteger(rawOffset) || rawOffset < 0 || rawOffset % SECTOR_BYTES) {
      throw new Error('cdrom: MODE1 raw offset must be a sector-aligned non-negative integer');
    }
    if (!Number.isSafeInteger(sectors) || sectors <= 0) {
      throw new Error('cdrom: MODE1 track must contain at least one sector');
    }
    if (rawOffset + sectors * SECTOR_BYTES > source.size) {
      throw new Error('cdrom: MODE1 track extends past its BIN file');
    }
    const size = sectors * 2048;
    return {
      size,
      name: opts.name || source.name || 'MODE1/2352',
      async readRange(offset, length) {
        const start = Number(offset);
        const count = Number(length);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) ||
            start < 0 || count < 0 || start + count > size) {
          throw new RangeError(`cdrom: MODE1 read ${offset}+${length} is outside ${size} bytes`);
        }
        if (!count) return new Uint8Array(0);
        const firstSector = Math.floor(start / 2048);
        const lastSector = Math.floor((start + count - 1) / 2048);
        const rawStart = rawOffset + firstSector * SECTOR_BYTES;
        const rawLength = (lastSector - firstSector + 1) * SECTOR_BYTES;
        const raw = new Uint8Array(await source.readRange(rawStart, rawLength));
        if (raw.length !== rawLength) {
          throw new Error(`cdrom: short MODE1 BIN read (${raw.length} of ${rawLength} bytes)`);
        }
        const out = new Uint8Array(count);
        let written = 0;
        let virtual = start;
        while (written < count) {
          const sector = Math.floor(virtual / 2048);
          const within = virtual % 2048;
          const take = Math.min(count - written, 2048 - within);
          const rawWithin = (sector - firstSector) * SECTOR_BYTES + 16 + within;
          out.set(raw.subarray(rawWithin, rawWithin + take), written);
          written += take;
          virtual += take;
        }
        return out;
      },
    };
  }

  // The raw sector range occupied by one parsed track in its backing file.
  // INDEX 01 is the first sector visible to the program; INDEX 00 belongs to
  // the preceding track. This is shared by the ISO provider and mountCue so
  // their view of a mixed-mode disc cannot drift apart.
  function trackFileRange(parsed, track, byteLength) {
    const size = normalizeSize(byteLength, track.file);
    const fileSectors = size / SECTOR_BYTES;
    const fileTracks = parsed.tracks.filter(item => item.fileIndex === track.fileIndex);
    const position = fileTracks.indexOf(track);
    if (position < 0) throw new Error('cdrom: track is not part of this CUE');
    const next = fileTracks[position + 1];
    const startSector = track.index1Sector;
    const endSector = next ? (next.indexes.get(0) ?? next.index1Sector) : fileSectors;
    if (startSector < 0 || startSector >= fileSectors ||
        endSector <= startSector || endSector > fileSectors) {
      throw new Error(`cdrom: invalid track ${track.number} range in "${track.file}"`);
    }
    return {
      startSector,
      endSector,
      sectors: endSector - startSector,
      rawOffset: startSector * SECTOR_BYTES,
      byteLength: (endSector - startSector) * SECTOR_BYTES,
      fileSectors,
    };
  }

  // Attach one CUE table of contents to a VFS drive. `trackSize` must return a
  // byte size synchronously so MCI status calls work before any audio is read;
  // `loadTrack` may return bytes or a Promise and is called only on playback.
  function mountCue(vfs, cueText, opts = {}) {
    if (!vfs) throw new Error('cdrom: a VFS is required');
    if (typeof opts.trackSize !== 'function') throw new Error('cdrom: trackSize is required');
    if (typeof opts.loadTrack !== 'function') throw new Error('cdrom: loadTrack is required');
    const drive = String(opts.drive || 'D').replace(/:$/, '').toUpperCase();
    if (!/^[A-Z]$/.test(drive)) throw new Error(`cdrom: invalid drive letter "${opts.drive}"`);
    const parsed = parseCue(cueText);
    const files = parsed.files.map(file => {
      const byteLength = normalizeSize(opts.trackSize(file.name), file.name);
      let loaded = null;
      return {
        ...file,
        byteLength,
        fileSectors: byteLength / SECTOR_BYTES,
        load() {
          if (!loaded) {
            loaded = Promise.resolve(opts.loadTrack(file.name)).then(value => {
              const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
              if (bytes.byteLength !== byteLength) {
                throw new Error(`cdrom: "${file.name}" loaded ${bytes.byteLength} bytes, expected ${byteLength}`);
              }
              return bytes;
            }).catch(error => {
              loaded = null;
              throw error;
            });
          }
          return loaded;
        },
      };
    });
    let cursor = 0;
    const tracks = [];
    for (const file of files) {
      const fileTracks = parsed.tracks.filter(track => track.fileIndex === file.index);
      const discFileStartSector = cursor;
      let insertedPregap = 0;
      for (let i = 0; i < fileTracks.length; i++) {
        const track = fileTracks[i];
        if (track.index1Sector >= file.fileSectors) {
          throw new Error(`cdrom: track ${track.number} INDEX 01 is outside "${track.file}"`);
        }
        const next = fileTracks[i + 1];
        const rawEndSector = next
          ? (next.indexes.get(0) ?? next.index1Sector)
          : file.fileSectors;
        if (rawEndSector < track.index1Sector || rawEndSector > file.fileSectors) {
          throw new Error(`cdrom: invalid index order in "${track.file}"`);
        }
        insertedPregap += track.pregapSectors;
        const discStartSector = discFileStartSector + insertedPregap + track.index1Sector;
        const playableSectors = rawEndSector - track.index1Sector;
        tracks.push({
          ...track,
          byteLength: file.byteLength,
          fileSectors: file.fileSectors,
          discFileStartSector,
          discStartSector,
          playableSectors,
          discEndSector: discStartSector + playableSectors,
          load: file.load,
        });
      }
      cursor += file.fileSectors + fileTracks.reduce((sum, track) => sum + track.pregapSectors, 0);
    }
    const disc = {
      drive,
      root: drive + ':\\',
      tracks,
      firstTrack: tracks[0].number,
      lastTrack: tracks[tracks.length - 1].number,
      leadOutSector: cursor,
      volumeLabel: String(opts.volumeLabel || 'AUDIO_CD'),
    };
    disc.track = number => tracks.find(track => track.number === Number(number)) || null;
    disc.audioTracks = tracks.filter(track => track.isAudio);

    if (!vfs.cdAudioDrives) vfs.cdAudioDrives = new Map();
    vfs.cdAudioDrives.set(drive.toLowerCase(), disc);
    if (!vfs.driveTypes) vfs.driveTypes = new Map();
    vfs.driveTypes.set(drive.toLowerCase(), 5); // DRIVE_CDROM
    if (!vfs.volumeLabels) vfs.volumeLabels = new Map();
    if (!vfs.volumeLabels.has(drive.toLowerCase())) {
      vfs.volumeLabels.set(drive.toLowerCase(), disc.volumeLabel);
    }
    if (vfs.dirs) vfs.dirs.add(disc.root.toLowerCase());
    return disc;
  }

  const api = {
    SECTOR_BYTES,
    SECTORS_PER_SECOND,
    PCM_FRAMES_PER_SECTOR,
    SAMPLE_RATE,
    msfToSector,
    parseCue,
    trackFileRange,
    mode1RawProvider,
    mountCue,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CdRom = api;
})();
