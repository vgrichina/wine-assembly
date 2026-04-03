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

    const topicUsed = this.u32(topicOff);
    const topicData = topicOff + 9; // skip IFH

    // Get topic offsets from TTLBTREE
    const topicOffsets = this._parseTTLBTree();

    if (topicOffsets.length === 0) {
      // Fallback: treat entire topic as one block
      topicOffsets.push(0);
    }

    // For each topic region, extract text
    for (let t = 0; t < topicOffsets.length; t++) {
      const start = topicData + topicOffsets[t];
      const end = t + 1 < topicOffsets.length
        ? topicData + topicOffsets[t + 1]
        : topicData + topicUsed;

      const text = this._extractTopicText(start, end);
      // First topic is usually empty (dummy) — skip if no meaningful text
      if (text.length > 5) {
        this.topics.push({ title: '', text: text });
      }
    }

    // Try to assign titles from the first line of each topic
    for (const topic of this.topics) {
      const lines = topic.text.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        topic.title = lines[0].substring(0, 80);
      }
    }
  }

  _parseTTLBTree() {
    const ttlOff = this.directory['|TTLBTREE'];
    if (ttlOff === undefined) return [0];

    const ttlData = ttlOff + 9; // skip IFH
    if (this.u16(ttlData) !== 0x293B) return [0];
    const pageSize = this.u16(ttlData + 4);
    const totalPages = this.u16(ttlData + 30);
    const totalEntries = this.u32(ttlData + 34);

    const offsets = [];
    let pagePtr = ttlData + 38;
    for (let p = 0; p < totalPages; p++) {
      const nEntries = this.u16(pagePtr + 2);
      let ePtr = pagePtr + 8;
      for (let e = 0; e < nEntries; e++) {
        if (ePtr + 4 > pagePtr + pageSize) break;
        const topicOff = this.i32(ePtr);
        ePtr += 4;
        // Skip NUL-terminated title (may be empty)
        while (ePtr < pagePtr + pageSize && this.data[ePtr]) ePtr++;
        ePtr++; // skip NUL
        offsets.push(topicOff);
      }
      pagePtr += pageSize;
    }
    offsets.sort((a, b) => a - b);
    return offsets;
  }

  _decodePhraseText(start, end) {
    // Decode topic text that uses inline phrase compression.
    // Format: ASCII bytes >= 0x20 are literal text, small even bytes are phrase
    // references (ch/2 = phrase index), 0x07/0x17/0x27 etc are spaces,
    // 0x00 is a string separator, bytes >= 0x80 are formatting codes.
    const parts = [];
    let i = start;
    while (i < end && i < this.data.length) {
      const ch = this.data[i]; i++;

      // NUL: string separator (between interleaved LD2 strings)
      if (ch === 0) continue;

      // Formatting codes >= 0x80
      if (ch >= 0x80) {
        if (ch === 0x80 && i + 1 < end) { i += 2; continue; } // font change
        if (ch === 0x82) { parts.push('\n'); continue; } // paragraph end
        if (ch === 0x83) { parts.push('\t'); continue; } // tab
        if (ch >= 0x86 && ch <= 0x89) continue; // end hotspot
        if (ch >= 0xC8 && ch <= 0xCF && i + 3 < end) { i += 4; continue; }
        if (ch >= 0xE0 && ch <= 0xE7 && i + 3 < end) { i += 4; continue; }
        continue;
      }

      // Printable ASCII: literal text
      if (ch >= 0x20 && ch <= 0x7E) {
        parts.push(String.fromCharCode(ch));
        continue;
      }

      // Space codes: (ch & 0xF) === 7
      if ((ch & 0xF) === 7) {
        parts.push(' '.repeat((ch >> 4) + 1));
        continue;
      }

      // Phrase reference: even byte < 0x20 (but not 0x00)
      if ((ch & 1) === 0) {
        const idx = ch >> 1;
        if (idx < this.phrases.length) parts.push(this.phrases[idx]);
        continue;
      }

      // Old-style phrase: bytes 1-14 trigger 2-byte phrase lookup
      if (ch >= 1 && ch <= 14) {
        if (i >= end) break;
        const ch2 = this.data[i]; i++;
        const combined = ch * 256 + ch2 - 256;
        const phraseIdx = combined >> 1;
        if (phraseIdx >= 0 && phraseIdx < this.phrases.length) {
          parts.push(this.phrases[phraseIdx]);
          if (combined & 1) parts.push(' ');
        }
        continue;
      }

      // Other control bytes: skip
    }
    return parts.join('');
  }

  _extractTopicText(start, end) {
    // The topic region contains binary record headers (TopicLink + record headers)
    // mixed with phrase-compressed text. Record headers have lots of 0x00/0xFF bytes.
    // Text segments start after formatting markers (0x80, 0x82, 0xFF).
    //
    // Strategy: find text segments by looking for runs of bytes that contain
    // printable ASCII or valid phrase references, skipping binary header regions
    // (runs of 0x00/0xFF).

    // Find text segments: regions between runs of binary header data
    const segments = [];
    let i = start;
    let segStart = -1;
    let nullRun = 0;

    while (i < end && i < this.data.length) {
      const ch = this.data[i];

      if (ch === 0xFF || (ch === 0x00 && nullRun > 0)) {
        nullRun++;
        if (nullRun >= 3 && segStart >= 0) {
          segments.push({ start: segStart, end: i - nullRun + 1 });
          segStart = -1;
        }
      } else if (ch === 0x00) {
        nullRun = 1;
      } else {
        if (nullRun >= 3) {
          // Coming out of a binary header region
          segStart = i;
        } else if (segStart < 0) {
          segStart = i;
        }
        nullRun = 0;
      }
      i++;
    }
    if (segStart >= 0) {
      segments.push({ start: segStart, end: Math.min(end, this.data.length) });
    }

    // Decode each segment using phrase text decoder
    let result = '';
    for (const seg of segments) {
      const text = this._decodePhraseText(seg.start, seg.end);
      const clean = text.trim();
      if (clean.length > 3) {
        if (result) result += '\n';
        result += clean;
      }
    }

    return result
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{3,}/g, ' ')
      .trim();
  }
}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HlpParser };
}
