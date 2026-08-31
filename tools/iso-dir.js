#!/usr/bin/env node
// List an ISO 9660 image the way the emulator's mount sees it, and extract one
// file byte-exactly. This is the host-side ground truth for "what is actually
// on the disc" — an emulator run that reads the wrong bytes gets compared
// against this, with no emulator in the loop.
//
//   node tools/iso-dir.js <file.iso>                       volume info + listing
//   node tools/iso-dir.js <file.iso> --json                machine-readable
//   node tools/iso-dir.js <file.iso> --primary             ignore Joliet names
//   node tools/iso-dir.js <file.iso> --joliet              force Joliet (default)
//   node tools/iso-dir.js <file.iso> --extract='DIR\F.EXE' --out=f.exe

'use strict';

const fs = require('fs');
const path = require('path');
const iso9660 = require(path.join(__dirname, '..', 'lib', 'iso9660.js'));

function usage(msg) {
  if (msg) console.error(`iso-dir: ${msg}`);
  console.error('usage: node tools/iso-dir.js <file.iso> [--json] [--joliet|--primary]');
  console.error('       node tools/iso-dir.js <file.iso> --extract=PATH --out=FILE');
  process.exit(msg ? 2 : 0);
}

// A file-descriptor byte provider: the point of the ISO format is that nothing
// but the requested extent needs to be read, so do not slurp the image.
function fdProvider(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    readRange(offset, length) {
      const start = Math.min(Math.max(0, offset), size);
      const len = Math.max(0, Math.min(length, size - start));
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, got);
    },
    close() { fs.closeSync(fd); },
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) usage();

  let file = null;
  let json = false;
  let prefer = 'joliet';
  let extract = null;
  let out = null;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--joliet') prefer = 'joliet';
    else if (arg === '--primary') prefer = 'primary';
    else if (arg.startsWith('--extract=')) extract = arg.slice('--extract='.length);
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else if (file === null) file = arg;
    else usage('more than one image given');
  }
  if (!file) usage('no image given');
  if (!fs.existsSync(file)) usage(`no such file: ${file}`);

  const provider = fdProvider(file);
  let image;
  try {
    image = iso9660.parseIso(provider, { prefer });
  } catch (e) {
    console.error(`iso-dir: ${e.message}`);
    process.exit(1);
  }

  if (extract) {
    const entry = iso9660.findEntry(image, extract);
    if (!entry) {
      console.error(`iso-dir: no such entry on the image: ${extract}`);
      process.exit(1);
    }
    const bytes = iso9660.readEntry(image, entry);
    if (out) {
      fs.writeFileSync(out, Buffer.from(bytes));
      console.log(`${entry.path}  ${bytes.length} bytes  →  ${out}`);
    } else {
      process.stdout.write(Buffer.from(bytes));
    }
    provider.close();
    return;
  }

  const files = image.files.filter((f) => !f.isDirectory);
  const dirs = image.files.filter((f) => f.isDirectory);

  if (json) {
    console.log(JSON.stringify({
      volumeLabel: image.volumeLabel,
      volumeSerial: image.volumeSerial,
      volumeCreated: image.volumeCreated,
      joliet: image.joliet,
      hasJoliet: image.hasJoliet,
      blockSize: image.blockSize,
      volumeSpaceSize: image.volumeSpaceSize,
      imageSize: image.size,
      files: image.files.map((f) => ({
        path: f.path,
        lba: f.lba,
        offset: f.offset,
        length: f.length,
        flags: f.flags,
        isDirectory: f.isDirectory,
      })),
    }, null, 2));
    provider.close();
    return;
  }

  const total = files.reduce((n, f) => n + f.length, 0);
  console.log(`image        ${file}  (${image.size} bytes)`);
  console.log(`volume       "${image.volumeLabel}"  serial ` +
    `${(image.volumeSerial >>> 0).toString(16).toUpperCase().padStart(8, '0')}` +
    `  created ${image.volumeCreated}`);
  console.log(`names        ${image.joliet ? 'Joliet (UCS-2)' : 'ISO 9660 primary'}` +
    `${image.hasJoliet && !image.joliet ? '  [Joliet present but not selected]' : ''}`);
  console.log(`block size   ${image.blockSize}`);
  console.log(`contents     ${files.length} files, ${dirs.length} directories, ${total} bytes`);
  console.log('');
  console.log('       LBA       LENGTH  PATH');
  for (const f of image.files) {
    const lba = String(f.lba).padStart(10);
    const len = f.isDirectory ? '     <DIR>' : String(f.length).padStart(10);
    console.log(`${lba}  ${len}  ${f.path}${f.isDirectory ? '\\' : ''}`);
  }
  provider.close();
}

main(process.argv);
