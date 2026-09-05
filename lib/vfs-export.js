const fs = require('fs');
const path = require('path');

function normalizeGuestPath(value) {
  return String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function guestParents(guestPath) {
  const parts = normalizeGuestPath(guestPath).split('\\');
  const parents = [];
  while (parts.length > 1) {
    parts.pop();
    parents.push(parts.join('\\'));
  }
  return parents;
}

/**
 * Export a VirtualFS snapshot to a host directory.
 *
 * A Windows guest can contain a file and a directory at the same normalized
 * path when a buggy installer creates both. Host filesystems cannot represent
 * that namespace. Preserve the directory tree and write the colliding file
 * beside it with a deterministic suffix instead of aborting the whole export.
 */
function saveVfsToHost(vfs, outputRoot, options = {}) {
  const suffix = options.suffix ? String(options.suffix).toLowerCase() : '';
  const skipPaths = new Set((options.skipPaths || []).map(normalizeGuestPath));
  const log = options.log || (() => {});
  const directoryKeys = new Set([...vfs.dirs].map(normalizeGuestPath));
  const occupiedKeys = new Set(directoryKeys);

  for (const key of vfs.files.keys()) {
    const normalized = normalizeGuestPath(key);
    occupiedKeys.add(normalized);
    for (const parent of guestParents(normalized)) directoryKeys.add(parent);
  }

  const written = [];
  for (const [key, value] of vfs.files.entries()) {
    const normalized = normalizeGuestPath(key);
    if (skipPaths.has(normalized)) continue;
    if (suffix && !normalized.endsWith(suffix)) continue;
    // Mounted ISO/CUE/ZIP entries deliberately stay provider-backed until a
    // guest reads them. A snapshot is the writable machine state, not a copy
    // of the source disc, and touching `.data` on one of these entries either
    // duplicates the whole medium or raises VfsPendingError. Installed files
    // are resident entries, so omit lazy source-media files from the export.
    if (value && value._provider) {
      log(`[save-vfs] skip lazy media file ${key}`);
      continue;
    }

    const rel = String(key).replace(/^c:\\/i, '');
    let exportRel = rel;
    if (directoryKeys.has(normalized)) {
      let counter = 1;
      do {
        const tag = counter === 1 ? '.__vfs_file__' : `.__vfs_file__${counter}`;
        exportRel = rel + tag;
        counter++;
      } while (occupiedKeys.has(normalizeGuestPath('c:\\' + exportRel)));
      log(`[save-vfs] file/directory collision: ${key} -> ${exportRel}`);
    }

    const outputPath = path.join(outputRoot, ...exportRel.split('\\'));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(value.data));
    log(`[save-vfs] ${outputPath} (${value.data.length} bytes)`);
    written.push({ guestPath: key, outputPath, collision: exportRel !== rel });
  }
  return written;
}

module.exports = { saveVfsToHost };
