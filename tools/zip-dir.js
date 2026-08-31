#!/usr/bin/env node
// List what a zip actually contains, straight from lib/zip-mount.js's parser —
// the host-side ground truth for any "the guest can't see this file" question.
//
//   node tools/zip-dir.js <file.zip>            names, sizes, method, offsets
//   node tools/zip-dir.js <file.zip> --json     the same as JSON
//   node tools/zip-dir.js <file.zip> --check    inflate every entry, verify
//                                               uncompressed size and CRC32
//   node tools/zip-dir.js <file.zip> --mount    show the guest paths a mount
//                                               would create (--root=DIR)

const fs = require('fs');
const zip = require('../lib/zip-mount');

function main(argv) {
  const args = argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/zip-dir.js <file.zip> [--json] [--check] [--mount] [--root=DIR]');
    return 2;
  }
  const json = args.includes('--json');
  const check = args.includes('--check');
  const mount = args.includes('--mount');
  const rootArg = args.find(a => a.startsWith('--root='));

  const bytes = new Uint8Array(fs.readFileSync(file));
  const entries = zip.readCatalogSync(bytes);

  const rows = entries.map(entry => {
    const row = {
      name: entry.name,
      directory: entry.isDirectory,
      size: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      method: entry.method,
      methodName: entry.methodName,
      localHeaderOffset: entry.localHeaderOffset,
      crc: entry.crc,
      fileTime: entry.fileTime,
    };
    if (check && !entry.isDirectory) {
      // A failure here is the interesting result, so report it per entry
      // rather than letting one bad member abort the whole listing.
      try {
        const data = zip.extractSync(bytes, entry);
        row.checkedSize = data.length;
        row.checkedCrc = zip.crc32(data);
        row.ok = data.length === entry.uncompressedSize && row.checkedCrc === entry.crc;
        if (!row.ok) row.error = 'size/CRC mismatch';
      } catch (e) {
        row.ok = false;
        row.error = e.message;
      }
    }
    return row;
  });

  let plan = null;
  if (mount) {
    plan = zip.mountPlan(entries, { zipPath: file, root: rootArg ? rootArg.slice(7) : undefined });
  }

  if (json) {
    console.log(JSON.stringify({
      file,
      entries: rows,
      mount: plan ? { root: plan.root, strip: plan.strip, paths: plan.mapped.map(m => m.path) } : undefined,
    }, null, 2));
  } else {
    console.log(`${file}: ${rows.length} entries`);
    for (const row of rows) {
      const flag = check && !row.directory ? (row.ok ? ' OK' : ` FAIL (${row.error})`) : '';
      console.log(
        `  ${String(row.size).padStart(10)}  ${String(row.compressedSize).padStart(10)}  ` +
        `${row.methodName.padEnd(8)}  @${String(row.localHeaderOffset).padStart(9)}  ` +
        `${row.name}${row.directory ? '/' : ''}${flag}`);
    }
    if (plan) {
      console.log(`mount root: ${plan.root}${plan.strip ? `  (unwrapping "${plan.strip}/")` : ''}`);
      for (const m of plan.mapped) console.log(`  ${m.path}`);
    }
  }

  const failed = rows.filter(r => r.ok === false).length;
  if (failed) {
    console.error(`${failed} entr${failed === 1 ? 'y' : 'ies'} failed verification`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    console.error(`zip-dir: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { main };
