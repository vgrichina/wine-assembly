// HLP file parser for Windows Help files
// Extracts topic titles and text from Win98 .hlp files
// Handles Hall phrase compression and B+tree directory

class HlpParser {
  constructor(data) {
    this.data = data; // Uint8Array
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.phrases = [];
    this.topics = []; // [{title, text}]
    this.helpTitle = '';
    this.directory = {}; // name -> fileOffset
  }

  parse() {
    if (this.u32(0) !== 0x00035F3F) return false; // bad magic
    this._parseDirectory();
    this._parsePhrases();
    this._parseSystem();
    this._parseTopics();
    return true;
  }

  // --- Low-level readers ---
  u8(off) { return this.data[off]; }
  u16(off) { return this.dv.getUint16(off, true); }
  u32(off) { return this.dv.getUint32(off, true); }
  i32(off) { return this.dv.getInt32(off, true); }
  str(off, maxLen) {
    let s = '';
    for (let i = 0; i < (maxLen || 1024); i++) {
      const ch = this.data[off + i];
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    return s;
  }

  // --- B+tree directory ---
  _parseDirectory() {
    const dirOff = this.u32(4);
    // Internal file header (9 bytes) + B+tree header (38 bytes)
    const btOff = dirOff + 9;
    if (this.u16(btOff) !== 0x293B) return; // bad B+tree magic
    const pageSize = this.u16(btOff + 4);
    const totalPages = this.u16(btOff + 30);
    const nLevels = this.u16(btOff + 32);

    // Find leaf pages
    let pagePtr = btOff + 38;

    // Skip index pages if multi-level tree
    if (nLevels > 1) {
      // Index pages contain: nEntries(u16), then entries of (key, pageNum)
      // For simplicity, just scan all pages and try leaf format
      // A leaf page has prevPage/nextPage at offsets 4-7
      for (let p = 0; p < totalPages; p++) {
        const nEntries = this.u16(pagePtr + 2);
        if (nEntries > 0 && nEntries < 200) {
          this._parseLeafPage(pagePtr, nEntries, pageSize);
        }
        pagePtr += pageSize;
      }
    } else {
      for (let p = 0; p < totalPages; p++) {
        const nEntries = this.u16(pagePtr + 2);
        this._parseLeafPage(pagePtr, nEntries, pageSize);
        pagePtr += pageSize;
      }
    }
  }

  _parseLeafPage(pagePtr, nEntries, pageSize) {
    let ePtr = pagePtr + 8; // skip unused(2)+nEntries(2)+prev(2)+next(2)
    const pageEnd = pagePtr + pageSize;
    for (let e = 0; e < nEntries && ePtr < pageEnd - 4; e++) {
      const nameStart = ePtr;
      while (ePtr < pageEnd && this.data[ePtr]) ePtr++;
      const name = this.str(nameStart, ePtr - nameStart);
      ePtr++; // skip NUL
      if (ePtr + 4 > pageEnd) break;
      const off = this.u32(ePtr);
      ePtr += 4;
      this.directory[name] = off;
    }
  }

  // --- Phrase tables (Hall compression) ---
  _parsePhrases() {
    const phrIdxOff = this.directory['|PhrIndex'];
    const phrImgOff = this.directory['|PhrImage'];
    if (phrIdxOff === undefined || phrImgOff === undefined) {
      // Try old-style |Phrases
      this._parseOldPhrases();
      return;
    }

    // PhrIndex: IFH(9) + Hall header(28) + bit-packed offsets
    const idxData = phrIdxOff + 9;
    const magic = this.u32(idxData);
    if (magic !== 1) return;
    const nPhrases = this.u32(idxData + 4);
    const bitCount = this.u16(idxData + 24) & 0xF;

    // Decode bit-packed offsets
    const bitBase = idxData + 28;
    let bitPos = 0;
    const getBit = () => {
      const byteIdx = bitPos >> 3;
      const bitIdx = bitPos & 7;
      bitPos++;
      return (this.data[bitBase + byteIdx] >> bitIdx) & 1;
    };
    const offsets = [0];
    for (let i = 0; i < nPhrases; i++) {
      let n = 1;
      while (getBit()) n += (1 << bitCount);
      for (let b = 0; b < bitCount; b++) if (getBit()) n += (1 << b);
      offsets.push(offsets[i] + n);
    }

    // Extract phrases from PhrImage
    const imgData = phrImgOff + 9; // skip IFH
    for (let i = 0; i < nPhrases; i++) {
      let s = '';
      for (let j = offsets[i]; j < offsets[i + 1]; j++) {
        s += String.fromCharCode(this.data[imgData + j]);
      }
      this.phrases.push(s);
    }
  }

  _parseOldPhrases() {
    const phOff = this.directory['|Phrases'];
    if (phOff === undefined) return;
    const data = phOff + 9; // skip IFH
    const numPhrases = this.u16(data);
    // Old format: numPhrases(2) + oneHundred(2) + offsets(u16 * (numPhrases+1)) + data
    const offsetsStart = data + 4;
    const dataStart = offsetsStart + (numPhrases + 1) * 2;
    for (let i = 0; i < numPhrases; i++) {
      const start = this.u16(offsetsStart + i * 2);
      const end = this.u16(offsetsStart + (i + 1) * 2);
      let s = '';
      for (let j = start; j < end; j++) {
        s += String.fromCharCode(this.data[dataStart + j]);
      }
      this.phrases.push(s);
    }
  }

  // --- SYSTEM file ---
  _parseSystem() {
    const sysOff = this.directory['|SYSTEM'];
    if (sysOff === undefined) return;
    const sysData = sysOff + 9; // skip IFH
    if (this.u16(sysData) !== 0x036C) return;
    // minor(2) + flags(2) + GenDate(4) = 8 bytes after magic
    // Tagged records start at offset 10
    let recOff = sysData + 10;
    const recEnd = sysData + 300;
    while (recOff < recEnd && recOff + 4 < this.data.length) {
      const type = this.u16(recOff);
      const size = this.u16(recOff + 2);
      if (size === 0 || size > 300) break;
      if (type === 1) { // title
        this.helpTitle = this.str(recOff + 4, size);
      }
      recOff += 4 + size;
    }
  }

  // --- Topic extraction ---
  _parseTopics() {
    const topicOff = this.directory['|TOPIC'];
    if (topicOff === undefined) return;

    const topicUsed = this.u32(topicOff + 4); // UsedSpace
    const topicData = topicOff + 9; // skip IFH

    // Walk TopicLink records using separator-byte header format.
    // Header layout (24 bytes):
    //   sep(1) BS(4) DL2(4) sep(1) PrevBlock(4) NextBlock(4) sep(1) DL1(4) RT(1)
    // After header: LD1 (DL1-21 bytes formatting) + LD2 (BS-DL1 bytes text)
    const records = [];
    for (let off = 12; off < topicUsed - 24; off++) {
      const abs = topicData + off;
      if (abs + 24 > this.data.length) break;
      if (this.data[abs] !== 0 || this.data[abs + 9] !== 0 || this.data[abs + 18] !== 0) continue;
      const bs = this.i32(abs + 1);
      const dl2 = this.i32(abs + 5);
      const dl1 = this.i32(abs + 19);
      const rt = this.data[abs + 23];
      if (rt !== 0x02 && rt !== 0x20 && rt !== 0x23) continue;
      if (bs < 24 || bs > topicUsed) continue;
      if (dl1 < 21 || dl1 > bs + 10) continue;
      records.push({ off, bs, dl2, dl1, rt });
    }

    let curText = '';
    for (const rec of records) {
      if (rec.rt === 0x02) {
        // TopicHeader: start a new topic
        if (curText.length > 5) {
          this.topics.push({ title: '', text: curText.trim() });
        }
        curText = '';
      } else if (rec.rt === 0x20 || rec.rt === 0x23) {
        // Text record: extract LD2 phrase-compressed text
        const ld1Size = rec.dl1 - 21;
        const ld2Size = rec.bs - rec.dl1;
        const ld2Start = topicData + rec.off + 24 + ld1Size;
        if (ld2Size > 0 && ld2Start + ld2Size <= this.data.length) {
          const text = this._decodePhraseText(ld2Start, ld2Start + ld2Size);
          if (curText && text) curText += '\n';
          curText += text;
        }
      }
    }
    if (curText.length > 5) {
      this.topics.push({ title: '', text: curText.trim() });
    }

    for (const topic of this.topics) {
      const lines = topic.text.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        topic.title = lines[0].substring(0, 80);
      }
    }
  }

  _decodePhraseText(start, end) {
    const parts = [];
    let i = start;
    while (i < end && i < this.data.length) {
      const ch = this.data[i]; i++;

      if (ch === 0) continue;

      if (ch >= 0x80) {
        if (ch === 0x80 && i + 1 < end) { i += 2; continue; }
        if (ch === 0x82) { parts.push('\n'); continue; }
        if (ch === 0x83) { parts.push('\t'); continue; }
        if (ch >= 0x86 && ch <= 0x89) continue;
        if (ch >= 0xC8 && ch <= 0xCF && i + 3 < end) { i += 4; continue; }
        if (ch >= 0xE0 && ch <= 0xE7 && i + 3 < end) { i += 4; continue; }
        continue;
      }

      if (ch >= 0x20 && ch <= 0x7E) {
        parts.push(String.fromCharCode(ch));
        continue;
      }

      if ((ch & 0xF) === 7) {
        parts.push(' ');
        continue;
      }

      if ((ch & 1) === 0) {
        const idx = ch >> 1;
        if (idx < this.phrases.length) parts.push(this.phrases[idx]);
        continue;
      }

      // 2-byte phrase: only valid when ch=1 (higher ch values overflow for small tables)
      if (ch === 1 && i < end) {
        const ch2 = this.data[i]; i++;
        const phraseIdx = ch2 >> 1;
        if (phraseIdx < this.phrases.length) {
          parts.push(this.phrases[phraseIdx]);
          if (ch2 & 1) parts.push(' ');
        }
        continue;
      }
    }
    return parts.join('');
  }
}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HlpParser };
}
