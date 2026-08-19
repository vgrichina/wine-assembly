const fs = require('fs');
const { HlpParser } = require('../lib/hlp-parser');

const file = process.argv[2] || 'test/binaries/help/sol.hlp';
const data = new Uint8Array(fs.readFileSync(file));
const dv = new DataView(data.buffer);
const hlp = new HlpParser(data);
hlp.parse();

const topicOff = hlp.directory['|TOPIC'];
const topicUsed = dv.getUint32(topicOff + 4, true);
const topicData = topicOff + 9;

// Decode the entire topic data through the phrase decoder
const fullText = hlp._decodePhraseText(topicData + 12, topicData + topicUsed);
console.log('=== Full decoded text ===');
console.log(fullText);

console.log('\n\n=== Clean version (remove runs of non-printable results) ===');
// Split into lines, keep only lines with >=50% printable ASCII
const lines = fullText.split('\n');
for (const line of lines) {
  const printable = [...line].filter(c => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7E).length;
  if (printable >= 5 && printable / line.length > 0.5) {
    console.log(line);
  }
}
