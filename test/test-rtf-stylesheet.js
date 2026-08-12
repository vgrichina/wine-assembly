#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { expandRtfStylesheet } = require('../lib/filesystem');

const source = '{\\rtf1\\ansi{\\stylesheet{\\s0\\ql\\f1\\fs20 Normal;}{\\s1\\sbasedon0\\qc\\f0\\fs32\\b Heading;}}\\pard\\s1 Styled\\par\\pard\\s0 Plain\\par}';
const expanded = expandRtfStylesheet(source);

assert(expanded.includes('{\\stylesheet'), 'stylesheet declaration must remain in the stream');
assert(expanded.includes('\\s1\\plain\\ql\\f1\\fs20\\qc\\f0\\fs32\\b Styled'), 'derived style must reset and receive inherited/direct controls');
assert(expanded.includes('\\s0\\plain\\ql\\f1\\fs20 Plain'), 'base style must reset and receive direct controls');
assert.strictEqual(expandRtfStylesheet('{\\rtf1 plain}'), '{\\rtf1 plain}', 'RTF without a stylesheet must remain byte-equivalent');
assert.strictEqual(expandRtfStylesheet('plain'), 'plain', 'non-RTF input must remain unchanged');

console.log('PASS  RTF stylesheet inheritance expands to direct controls');
