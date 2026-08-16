#!/usr/bin/env node
// ne-exports.js — dump a 16-bit NE module's exports: ordinal, name, target.
//
// The NE analogue of tools/pe-exports.js, and it exists for the same reason.
// Every Win16 import is by ordinal — all 269 distinct imports across our four
// NE apps are IMPORTORDINAL, not one is IMPORTNAME — so `USER.#113` names
// nothing until the real USER.EXE says what ordinal 113 is called.
//
// An NE keeps its exported names in two tables, both sequences of
// {u8 length, name bytes, u16 ordinal} terminated by a zero length:
//
//   Resident name table     at NE + u16(NE+0x26). Stays in memory; this is
//                           where the frequently-called entry points live.
//                           Its first record is the module's own name with
//                           ordinal 0, which is not an export.
//   Non-resident name table at the absolute file offset u32(NE+0x2C), for
//                           u16(NE+0x20) bytes. Its first record is the
//                           module description, again ordinal 0.
//
// Neither table has to name every ordinal: an export can be ordinal-only, in
// which case it appears in the entry table with nothing pointing at it. The
// entry table (NE+0x04, length NE+0x06) is what actually defines an ordinal,
// as a segment and offset, so this reads that too and reports names and
// targets together. An ordinal with a target but no name is a real export
// that was simply never given one.
//
// usage:
//   node tools/ne-exports.js <ne>                  list every export
//   node tools/ne-exports.js <ne> --ordinal=1,91   just these ordinals
//   node tools/ne-exports.js <ne> --name=Message   substring match on name
//   node tools/ne-exports.js <ne> --named          only ordinals that have a name
//   node tools/ne-exports.js <ne> --json           machine-readable, for table generation

const fs = require('fs');

// {u8 len, name, u16 ordinal}* terminated by a zero length. `limit` bounds the
// walk for the non-resident table, whose length the header states outright.
function readNameTable(buf, off, limit) {
  const out = [];
  if (off <= 0 || off >= buf.length) return out;
  const end = limit === undefined ? buf.length : Math.min(buf.length, off + limit);
  let p = off;
  while (p < end) {
    const len = buf[p];
    if (len === 0) break;
    if (p + 1 + len + 2 > end) break;
    out.push({
      name: buf.toString('latin1', p + 1, p + 1 + len),
      ordinal: buf.readUInt16LE(p + 1 + len),
    });
    p += 1 + len + 2;
  }
  return out;
}

// Ordinal -> {segment, offset, moveable, flags}. Bundles are runs of entries
// sharing a segment; indicator 0 is a gap that consumes ordinals without
// defining any, and 0xFF marks a moveable bundle whose entries carry an
// INT 3Fh thunk ahead of the real segment and offset.
function readEntryTable(buf, off, len) {
  const out = new Map();
  let p = off;
  const end = off + len;
  let ordinal = 1;
  while (p < end) {
    const count = buf[p];
    const indicator = buf[p + 1];
    if (count === 0) break;
    p += 2;
    if (indicator === 0) { ordinal += count; continue; }
    for (let i = 0; i < count && p < end; i++, ordinal++) {
      if (indicator === 0xff) {
        out.set(ordinal, {
          segment: buf[p + 3], offset: buf.readUInt16LE(p + 4),
          moveable: true, flags: buf[p],
        });
        p += 6;
      } else {
        out.set(ordinal, {
          segment: indicator, offset: buf.readUInt16LE(p + 1),
          moveable: false, flags: buf[p],
        });
        p += 3;
      }
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: ne-exports.js <ne> [--ordinal=N,...] [--name=SUBSTR] [--named] [--json]');
    process.exit(2);
  }
  const ordArg = args.find(a => a.startsWith('--ordinal='));
  const nameArg = args.find(a => a.startsWith('--name='));
  const onlyNamed = args.includes('--named');
  const asJson = args.includes('--json');
  const wantOrdinals = ordArg
    ? new Set(ordArg.slice('--ordinal='.length).split(',').map(s => parseInt(s, 10)))
    : null;
  const wantName = nameArg ? nameArg.slice('--name='.length).toLowerCase() : null;

  const buf = fs.readFileSync(file);
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    console.error(`${file}: not an MZ image`);
    process.exit(1);
  }
  const ne = buf.readUInt32LE(0x3c);
  if (ne + 0x40 > buf.length || buf[ne] !== 0x4e || buf[ne + 1] !== 0x45) {
    console.error(`${file}: not an NE image (no NE signature at 0x${ne.toString(16)})`);
    process.exit(1);
  }

  const resident = readNameTable(buf, ne + buf.readUInt16LE(ne + 0x26));
  const nonResident = readNameTable(buf, buf.readUInt32LE(ne + 0x2c), buf.readUInt16LE(ne + 0x20));
  const entries = readEntryTable(buf, ne + buf.readUInt16LE(ne + 0x04), buf.readUInt16LE(ne + 0x06));

  // Ordinal 0 in either table is the module's own name or description, not an
  // export. Resident names win: a name can appear in both, and the resident
  // table is the one the loader itself consults.
  const moduleName = resident.length ? resident[0].name : '';
  const description = nonResident.length ? nonResident[0].name : '';
  const named = new Map();
  for (const r of nonResident) if (r.ordinal !== 0) named.set(r.ordinal, { name: r.name, resident: false });
  for (const r of resident) if (r.ordinal !== 0) named.set(r.ordinal, { name: r.name, resident: true });

  const ordinals = [...new Set([...named.keys(), ...entries.keys()])].sort((a, b) => a - b);
  const rows = [];
  for (const ordinal of ordinals) {
    const n = named.get(ordinal);
    const e = entries.get(ordinal);
    if (wantOrdinals && !wantOrdinals.has(ordinal)) continue;
    if (wantName && !(n && n.name.toLowerCase().includes(wantName))) continue;
    if (onlyNamed && !n) continue;
    rows.push({
      ordinal,
      name: n ? n.name : null,
      resident: n ? n.resident : false,
      segment: e ? e.segment : null,
      offset: e ? e.offset : null,
      moveable: e ? e.moveable : null,
      // Bit 0 is EXPORTED and bit 1 marks the shared data segment. The upper
      // bits are reported raw rather than decoded: they are not needed here
      // and guessing at them would put an unverified claim in the output.
      flags: e ? e.flags : null,
      exported: e ? !!(e.flags & 1) : null,
    });
  }

  if (asJson) {
    console.log(JSON.stringify({
      file, module: moduleName, description,
      residentNames: resident.length - 1,
      nonResidentNames: Math.max(0, nonResident.length - 1),
      entryPoints: entries.size,
      exports: rows,
    }, null, 2));
    return;
  }

  console.log(`${file}  ${moduleName}  ${entries.size} entry point(s), ` +
    `${resident.length - 1} resident + ${Math.max(0, nonResident.length - 1)} non-resident name(s)`);
  if (description) console.log(`  "${description}"`);
  for (const r of rows) {
    const target = r.segment === null
      ? '(no entry-table record)'
      : `seg ${r.segment}:0x${r.offset.toString(16)}${r.moveable ? ' MOVEABLE' : ''}` +
        `${r.exported ? '' : ' NOT-EXPORTED'}`;
    console.log(`  #${String(r.ordinal).padStart(5)}  ${(r.name || '(ordinal only)').padEnd(32)}` +
      `${r.resident ? 'R' : ' '} ${target}`);
  }
  if (!rows.length) console.log('  (no export matched)');
}

main();
