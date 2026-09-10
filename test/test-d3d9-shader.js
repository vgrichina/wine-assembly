#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { parse, compile } = require('../lib/d3d9-shader');
const u32 = values => new Uint32Array(values);
const vs = u32([0xfffe0101, 1, 0xc00f0000, 0x90e40000, 0xffff]);
const ps = u32([0xffff0101, 66, 0xb00f0000, 5, 0x800f0000,
  0xb0e40000, 0x90e40000, 0xffff]);
assert.strictEqual(parse(vs).length, 5);
assert.strictEqual(parse(ps).instructions.length, 2);
assert.deepStrictEqual(compile(vs).attributes, ['d3d_v0']);
assert.match(compile(vs).source, /position.z \* 2.0 - position.w/);
assert.match(compile(ps).source, /texture2D\(d3d_s0, d3d_tex0.xy\)/);
assert.match(compile(ps).source, /gl_FragColor = r0/);
assert.deepStrictEqual(compile(ps).uniforms, ['d3d_s0']);
const masked = compile(u32([0xffff0101, 1, 0x81130000, 0x91c60000, 0xffff]));
assert.match(masked.source, /d3d_color0.zyxw/);
assert.match(masked.source, /clamp\(/);
assert.match(masked.source, /\* 2.000/);
assert.match(masked.source, /r0.xy = result1.xy/);
const comment = u32([0xfffe0101, 0x0002fffe, 0xffffffff, 0xfffe0200, ...vs.slice(1)]);
assert.strictEqual(parse(comment).length, comment.length);
const floats = new Uint32Array(new Float32Array([0.25, 0.5, 0.75, 1]).buffer);
const def = compile(u32([0xffff0101, 1, 0x800f0000, 0xa0e40000,
  81, 0xa00f0000, ...floats, 0xffff]));
assert.match(def.source, /const vec4 d3d_ps_c0 = vec4\(0.25, 0.5, 0.75, 1.0\)/);
assert.deepStrictEqual(def.uniforms, []);
const pair = compile(u32([0xffff0101, 1, 0x80070000, 0x90e40000,
  0x40000001, 0x80080000, 0x80e40000, 0xffff])).source;
assert.ok(pair.indexOf('vec4 result4') < pair.indexOf('r0.xyz ='),
  'coissued alpha source reads registers before the RGB instruction writes');
const declaration = compile(u32([0xfffe0101, 31, 0x80000000, 0x900f0000,
  20, 0xc00f0000, 0x90e40000, 0xa0e40000, 0xffff]));
assert.deepStrictEqual(declaration.semantics[0], { usage: 0, index: 0 });
assert.deepStrictEqual(declaration.uniforms, ['d3d_vs_c0', 'd3d_vs_c1', 'd3d_vs_c2', 'd3d_vs_c3']);
const relative=compile(u32([0xfffe0101,1,0xb0010000,0x90550001,
  1,0xc00f0000,0x90e40000,1,0xd00f0000,0xa0e42002,0xffff]));
assert.match(relative.source,/a0.x = result1.x/);
assert.match(relative.source,/d3d_relative\(a0.x \+ 2.0\)/);
assert.strictEqual(relative.uniforms.length,96);
assert.match(relative.source,/return vec4\(0.0\)/);
for (const [words, pattern] of [
  [[], /version/], [[0xffff0200], /version/], [[0xffff0101], /missing END/],
  [[0xffff0101, 0x0002fffe, 1], /truncated comment/],
  [[0xffff0101, 1, 0x800f0000], /truncated operands/],
  [[0xffff0101, 1, 0x800f0000, 0x00e40000, 0xffff], /parameter token/],
  [[0xffff0101, 1, 0x800f0000, 0xa0e42000, 0xffff], /relative/],
  [[0xfffe0101, 1, 0xc00f0000, 0xa0e42000, 0xffff], /before a0 initialization/],
  [[0xffff0101, 0x40000001, 0x800f0000, 0x90e40000, 0xffff], /coissue/],
  [[0xffff0101, 254, 0xffff], /opcode 254/],
  [[0xffff0101, 1, 0x800f0002, 0x90e40000, 0xffff], /register/],
  [[0xfffe0101, 0xffff], /does not write position/],
]) assert.throws(() => compile(u32(words)), pattern);
console.log('PASS bounded D3D9 shader decoding, operands, masks, constants and GLSL lowering');
