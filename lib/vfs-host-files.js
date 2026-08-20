const fs = require('fs');
const path = require('path');

function normalizePattern(pattern) {
  const raw = String(pattern || '').trim().replace(/\\/g, '/');
  if (!raw) throw new Error('empty VFS include pattern');
  if (path.posix.isAbsolute(raw) || /^[a-z]:/i.test(raw)) {
    throw new Error(`VFS include patterns must be relative to the EXE directory: ${pattern}`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (normalized === '.' || normalized.endsWith('/')) {
    throw new Error(`VFS include pattern must name files: ${pattern}`);
  }
  return normalized;
}

function globRegex(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(source + '$', 'i');
}

function staticRoot(pattern) {
  const parts = pattern.split('/');
  const wildcard = parts.findIndex(part => /[*?]/.test(part));
  if (wildcard < 0) return null;
  return parts.slice(0, wildcard).join('/') || '.';
}

function guestRelativePath(relativePath) {
  const parts = relativePath.split('/');
  while (parts[0] === '..' || parts[0] === '.') parts.shift();
  if (!parts.length) throw new Error(`VFS include has no guest-relative path: ${relativePath}`);
  return parts.join('/');
}

function expandIncludePatterns(exeDir, rawPatterns, fsImpl = fs) {
  const base = path.resolve(exeDir);
  const results = new Map();

  for (const rawPattern of rawPatterns || []) {
    const pattern = normalizePattern(rawPattern);
    const root = staticRoot(pattern);
    const matches = [];

    if (root === null) {
      const hostPath = path.resolve(base, pattern);
      let stat;
      try { stat = fsImpl.statSync(hostPath); } catch (_) { stat = null; }
      if (stat && stat.isFile()) matches.push(hostPath);
    } else {
      const hostRoot = path.resolve(base, root);
      const matcher = globRegex(pattern);
      const walk = directory => {
        let entries;
        try { entries = fsImpl.readdirSync(directory, { withFileTypes: true }); }
        catch (_) { return; }
        for (const entry of entries) {
          const hostPath = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(hostPath);
          else if (entry.isFile()) {
            const relative = path.relative(base, hostPath).replace(/\\/g, '/');
            if (matcher.test(relative)) matches.push(hostPath);
          }
        }
      };
      walk(hostRoot);
    }

    if (!matches.length) {
      throw new Error(`VFS include pattern matched no files: ${rawPattern}`);
    }
    for (const hostPath of matches) {
      const relativePath = path.relative(base, hostPath).replace(/\\/g, '/');
      results.set(hostPath, {
        hostPath,
        relativePath,
        guestPath: guestRelativePath(relativePath),
      });
    }
  }

  return [...results.values()].sort((a, b) => a.guestPath.localeCompare(b.guestPath));
}

module.exports = { expandIncludePatterns, globRegex, normalizePattern };
