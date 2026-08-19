const fs = require('fs');
const { HlpParser } = require('../lib/hlp-parser');

const file = process.argv[2] || 'test/binaries/help/freecell.hlp';
const rawData = new Uint8Array(fs.readFileSync(file));
const dv = new DataView(rawData.buffer);
const hlp = new HlpParser(rawData);
hlp.parse();

const topicOff = hlp.directory['|TOPIC'];
const topicUsed = dv.getUint32(topicOff + 4, true);
const topicData = topicOff + 9;

console.log(`Phrases (${hlp.phrases.length}): ${hlp.phrases.join(', ')}`);

function findRecords() {
  const records = [];
  for (let off = 12; off < topicUsed - 24; off++) {
    const abs = topicData + off;
    if (rawData[abs] !== 0 || rawData[abs + 9] !== 0 || rawData[abs + 18] !== 0) continue;
    const bs = dv.getInt32(abs + 1, true);
    const dl2 = dv.getInt32(abs + 5, true);
    const pb = dv.getInt32(abs + 10, true);
    const nb = dv.getInt32(abs + 14, true);
    const dl1 = dv.getInt32(abs + 19, true);
    const rt = rawData[abs + 23];
    if (rt !== 0x02 && rt !== 0x20 && rt !== 0x23) continue;
    if (bs < 24 || bs > topicUsed) continue;
    if (dl1 < 21 || dl1 > bs + 10) continue;
    records.push({ off, bs, dl2, pb, nb, dl1, rt });
  }
  return records;
}

function decodePhraseText(bytes, phrases) {
  const parts = [];
  let i = 0;
  while (i < bytes.length) {
    const ch = bytes[i]; i++;
    if (ch === 0) continue;
    if (ch >= 0x80) {
      if (ch === 0x80 && i + 1 < bytes.length) { i += 2; continue; }
      if (ch === 0x82) { parts.push('\n'); continue; }
      if (ch === 0x83) { parts.push('\t'); continue; }
      if (ch >= 0x86 && ch <= 0x89) continue;
      if (ch >= 0xC8 && ch <= 0xCF && i + 3 < bytes.length) { i += 4; continue; }
      if (ch >= 0xE0 && ch <= 0xE7 && i + 3 < bytes.length) { i += 4; continue; }
      continue;
    }
    if ((ch & 0xF) === 7) { parts.push(' '); continue; }
    if ((ch & 1) === 0 && ch > 0 && ch < 0x20) {
      const idx = ch >> 1;
      if (idx < phrases.length) parts.push(phrases[idx]);
      continue;
    }
    if (ch >= 0x20 && ch <= 0x7E) {
      parts.push(String.fromCharCode(ch));
      continue;
    }
    // 2-byte phrase ref: only use ch=1 (higher values give indices > 127)
    if (ch >= 1 && ch <= 14 && (ch & 1) === 1 && (ch & 0xF) !== 7) {
      if (i < bytes.length) {
        const ch2 = bytes[i]; i++;
        const combined = ch * 256 + ch2 - 256;
        const phraseIdx = combined >> 1;
        if (phraseIdx >= 0 && phraseIdx < phrases.length) {
          parts.push(phrases[phraseIdx]);
          if (combined & 1) parts.push(' ');
        }
      }
      continue;
    }
  }
  return parts.join('');
}

const records = findRecords();
console.log(`Records: ${records.length}`);

for (const r of records) {
  if (r.rt !== 0x20 && r.rt !== 0x23) continue;
  const recStart = topicData + r.off;

  // Header = 24 bytes (with 3 separator bytes at positions 0, 9, 18)
  // Data starts at recStart + 24, NO separator stripping
  // LD1 = DL1 - 21 bytes of formatting data
  // LD2 = BS - DL1 bytes of phrase-compressed text

  const ld1Size = r.dl1 - 21;
  const ld2Size = r.bs - r.dl1;
  const ld2Start = recStart + 24 + ld1Size;

  console.log(`\n=== Record @${r.off} BS=${r.bs} DL1=${r.dl1} DL2=${r.dl2} LD1=${ld1Size}b LD2=${ld2Size}b ===`);

  // Extract LD2 raw bytes
  const ld2Bytes = new Uint8Array(ld2Size);
  for (let j = 0; j < ld2Size; j++) {
    ld2Bytes[j] = rawData[ld2Start + j];
  }

  console.log('LD2 hex:', Array.from(ld2Bytes.slice(0, 80)).map(b => b.toString(16).padStart(2, '0')).join(' '));

  const text = decodePhraseText(ld2Bytes, hlp.phrases);
  console.log('Text:', text);
}
