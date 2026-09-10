// D3D bytecode -> backend shader source. No guest state or COM ownership here.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.D3D9Shader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const OPS = {
    0: ['nop', 0], 1: ['mov', 2], 2: ['add', 3], 3: ['sub', 3],
    4: ['mad', 4], 5: ['mul', 3], 6: ['rcp', 2], 7: ['rsq', 2],
    8: ['dp3', 3], 9: ['dp4', 3], 10: ['min', 3], 11: ['max', 3],
    12: ['slt', 3], 13: ['sge', 3], 14: ['exp', 2], 15: ['log', 2],
    16: ['lit', 2], 17: ['dst', 3], 18: ['lrp', 4], 19: ['frc', 2],
    20: ['m4x4', 3], 21: ['m4x3', 3], 22: ['m3x4', 3],
    23: ['m3x3', 3], 24: ['m3x2', 3], 31: ['dcl', 2], 64: ['texcoord', 1],
    65: ['texkill', 1], 66: ['tex', 1], 69: ['texreg2ar', 2],
    78: ['expp', 2], 79: ['logp', 2], 80: ['cnd', 4], 81: ['def', 5],
  };
  function fail(message, offset) {
    throw new Error(`D3D shader DWORD ${offset}: ${message}`);
  }
  function parse(words) {
    if (!(words instanceof Uint32Array)) throw new TypeError('shader must be Uint32Array');
    const version = words[0] >>> 0;
    const stage = version >>> 16 === 0xfffe ? 'vertex'
      : version >>> 16 === 0xffff ? 'pixel' : null;
    if (!stage || (version & 0xffff) !== 0x0101) fail('unsupported shader version', 0);
    const instructions = [];
    let offset = 1;
    while (offset < words.length && offset < 65536) {
      const start = offset, token = words[offset++], opcode = token & 0xffff;
      if (token === 0x0000ffff) return { stage, version, instructions, length: offset };
      if (opcode === 0xfffe) {
        const size = (token >>> 16) & 0x7fff;
        if (offset + size > words.length) fail('truncated comment', start);
        offset += size;
        continue;
      }
      if ((token & 0xbfff0000) || ((token & 0x40000000) && stage !== 'pixel'))
        fail('unsupported instruction controls/coissue', start);
      const spec = OPS[opcode];
      if (!spec) fail(`unsupported opcode ${opcode}`, start);
      if (offset + spec[1] > words.length) fail('truncated operands', start);
      const args = Array.from(words.subarray(offset, offset + spec[1]));
      for (let i = 0; i < (opcode === 81 ? 1 : args.length); ++i) {
        if (!(args[i] & 0x80000000)) fail('invalid parameter token', offset + i);
        if ((args[i] & 0x2000) && (stage !== 'vertex' || i === 0 || opcode === 31
            || (((args[i] >>> 28) & 7) | ((args[i] >>> 8) & 24)) !== 2))
          fail('invalid relative addressing operand', offset + i);
      }
      instructions.push({ opcode, name: spec[0], args, offset: start, coissue: !!(token & 0x40000000) });
      offset += spec[1];
    }
    fail('missing END or token limit exceeded', offset);
  }

  function compile(words) {
    const shader = parse(words), pixel = shader.stage === 'pixel';
    const constantName = n => `d3d_${pixel ? 'ps' : 'vs'}_c${n}`;
    const declarations = new Map(), constants = new Map(), samplers = new Set();
    const inputs = new Set(), outputs = new Set(), lines = [];
    let current = 0, coissue = false, lastWrite = -1, relative = false, addressWritten = false;
    const semantics = {};
    const declare = (name, text) => { declarations.set(name, text); return name; };
    function reg(token, write = false) {
      const type = ((token >>> 28) & 7) | ((token >>> 8) & 24), n = token & 2047;
      if (type === 0 && n < (pixel ? 2 : 12))
        return declare(`r${n}`, `vec4 r${n} = vec4(0.0);`);
      if (type === 1 && n < (pixel ? 2 : 16) && !write) {
        inputs.add(n); return pixel ? `d3d_color${n}` : `d3d_v${n}`;
      }
      if (type === 2 && n < (pixel ? 8 : 96) && !write) {
        if(token&0x2000) {
          if(!addressWritten)fail('relative address used before a0 initialization',current);
          relative=true;
          for(let i=0;i<96;++i)constants.set(i,null);
          return `(d3d_relative(a0.x + ${n}.0))`;
        }
        constants.set(n, null); return constantName(n);
      }
      if (!pixel && type === 3 && n === 0 && write)
        return declare('a0', 'vec4 a0 = vec4(0.0);');
      if (pixel && type === 3 && n < 4) {
        inputs.add(16 + n);
        return declare(`t${n}`, `vec4 t${n} = d3d_tex${n};`);
      }
      if (!pixel && type === 4 && n === 0) {
        outputs.add('position'); return declare('position', 'vec4 position = vec4(0.0);');
      }
      if (!pixel && type === 5 && n < 2) {
        outputs.add(`color${n}`); return `d3d_color${n}`;
      }
      if (!pixel && type === 6 && n < 8) {
        outputs.add(`tex${n}`); return `d3d_tex${n}`;
      }
      fail(`unsupported ${write ? 'destination' : 'source'} register ${type}:${n}`, current);
    }
    function src(token) {
      const base = reg(token), swizzle = Array.from({ length: 4 }, (_, i) =>
        'xyzw'[(token >>> (16 + 2 * i)) & 3]).join('');
      const s = `(${base}.${swizzle})`, modifier = (token >>> 24) & 15;
      switch (modifier) {
        case 0: return s;
        case 1: return `(-${s})`;
        case 2: return `(${s} - vec4(0.5))`;
        case 3: return `(vec4(0.5) - ${s})`;
        case 4: return `(${s} * 2.0 - vec4(1.0))`;
        case 5: return `(vec4(1.0) - ${s} * 2.0)`;
        case 6: return `(vec4(1.0) - ${s})`;
        case 7: return `(${s} * 2.0)`;
        case 8: return `(${s} * -2.0)`;
        default: fail(`unsupported source modifier ${modifier}`, current);
      }
    }
    function assign(token, expression) {
      const target = reg(token, true), mask = (token >>> 16) & 15;
      const modifier = (token >>> 20) & 15, shift = (token >>> 24) & 15;
      if (!mask || modifier > 1) fail('invalid destination mask/modifier', current);
      if (![0, 1, 2, 3, 13, 14, 15].includes(shift)) fail('invalid result shift', current);
      if (shift) expression = `(${expression}) * ${Math.pow(2, shift > 8 ? shift - 16 : shift).toFixed(3)}`;
      if (modifier) expression = `clamp(${expression}, 0.0, 1.0)`;
      const components = 'xyzw'.split('').filter((_, i) => mask & (1 << i)).join('');
      // Evaluate all sources before the masked write, including aliased r0.
      const resultName = `result${current}`;
      let deferred;
      if (coissue) {
        if (lastWrite !== lines.length - 1 || lastWrite < 0) fail('invalid coissue pair', current);
        deferred = lines.pop();
      }
      lines.push(`vec4 ${resultName} = ${expression};`);
      if (deferred) lines.push(deferred);
      lines.push(`${target}.${components} = ${resultName}.${components};`);
      lastWrite = coissue ? -1 : lines.length - 1;
    }
    for (const ins of shader.instructions) {
      current = ins.offset;
      coissue = ins.coissue;
      const [d, ...args] = ins.args;
      if (ins.name === 'dcl') {
        if (pixel || ins.coissue || ((args[0] >>> 28) & 7) !== 1)
          fail('unsupported declaration', current);
        const register = args[0] & 2047;
        reg(args[0]);
        semantics[register] = { usage: d & 15, index: (d >>> 16) & 15 };
        lastWrite = -1;
        continue;
      }
      if (ins.name === 'nop') continue;
      if (ins.name === 'def') {
        if (((d >>> 28) & 7) !== 2 || (d & 2047) >= (pixel ? 8 : 96)) fail('invalid DEF register', current);
        const values = new Float32Array(new Uint32Array(args).buffer);
        if (!values.every(Number.isFinite)) fail('non-finite DEF value', current);
        // Set after source collection below: DEF applies regardless of location.
        continue;
      }
      if (['tex', 'texcoord', 'texkill'].includes(ins.name)) {
        if (!pixel || ((d >>> 28) & 7) !== 3 || (d & 2047) >= 4)
          fail('invalid texture instruction destination', current);
        const t = reg(d, true), n = d & 2047;
        if (ins.name === 'texkill') lines.push(`if (any(lessThan(${t}.xyz, vec3(0.0)))) discard;`);
        else if (ins.name === 'texcoord') assign(d, `clamp(d3d_tex${n}, 0.0, 1.0)`);
        else { samplers.add(n); assign(d, `texture2D(d3d_s${n}, d3d_tex${n}.xy)`); }
        continue;
      }
      if (ins.name === 'texreg2ar') {
        if (!pixel || ((d >>> 28) & 7) !== 3 || (d & 2047) >= 4)
          fail('invalid dependent texture destination', current);
        const n = d & 2047; samplers.add(n);
        assign(d, `texture2D(d3d_s${n}, ${src(args[0])}.wx)`);
        continue;
      }
      const [a, b, c] = args.map(src);
      if(!pixel && ((d>>>28)&7)===3) {
        if(ins.name!=='mov' || ((d>>>16)&15)!==1 || (d&2047)!==0)
          fail('only mov a0.x can write the vs1.1 address register',current);
        // The legacy VS1.1 MOV path uses floor (Wine shader_glsl_mov);
        // later MOVA round-to-nearest is a different instruction/profile.
        assign(d,`floor(${a})`);addressWritten=true;continue;
      }
      const expressions = {
        mov: () => a, add: () => `${a} + ${b}`, sub: () => `${a} - ${b}`,
        mad: () => `${a} * ${b} + ${c}`, mul: () => `${a} * ${b}`,
        rcp: () => `vec4(1.0 / ${a}.x)`, rsq: () => `vec4(inversesqrt(abs(${a}.x)))`,
        dp3: () => `vec4(dot(${a}.xyz, ${b}.xyz))`, dp4: () => `vec4(dot(${a}, ${b}))`,
        min: () => `min(${a}, ${b})`, max: () => `max(${a}, ${b})`,
        slt: () => `vec4(lessThan(${a}, ${b}))`, sge: () => `vec4(greaterThanEqual(${a}, ${b}))`,
        exp: () => `vec4(exp2(${a}.x))`, log: () => `vec4(log2(abs(${a}.x)))`,
        expp: () => `vec4(exp2(floor(${a}.x)), fract(${a}.x), exp2(${a}.x), 1.0)`,
        logp: () => `vec4(${a}.x == 0.0 ? -3.402823466e+38 : log2(abs(${a}.x)))`,
        frc: () => `fract(${a})`, lrp: () => `${a} * ${b} + (vec4(1.0) - ${a}) * ${c}`,
        dst: () => `vec4(1.0, ${a}.y * ${b}.y, ${a}.z, ${b}.w)`,
        cnd: () => `(${a}.w > 0.5 ? ${b} : ${c})`,
        lit: () => `vec4(1.0, max(${a}.x, 0.0), ${a}.x > 0.0 ? pow(max(${a}.y, 0.0), clamp(${a}.w, -128.0, 128.0)) : 0.0, 1.0)`,
      };
      if (ins.name[0] === 'm' && /^m[34]x[234]$/.test(ins.name)) {
        if (pixel) fail('vertex matrix instruction in pixel shader', current);
        const size = +ins.name[1], rows = +ins.name[3];
        const terms = [];
        for (let row = 0; row < rows; ++row) {
          const rowToken = (args[1] + row) >>> 0;
          terms.push(`dot(${a}${size === 3 ? '.xyz' : ''}, ${src(rowToken)}${size === 3 ? '.xyz' : ''})`);
        }
        while (terms.length < 4) terms.push('0.0');
        assign(d, `vec4(${terms.join(', ')})`);
        continue;
      }
      if (!expressions[ins.name]) fail(`lowering not implemented: ${ins.name}`, current);
      assign(d, expressions[ins.name]());
    }
    for (const ins of shader.instructions.filter(i => i.name === 'def')) {
      const values = new Float32Array(new Uint32Array(ins.args.slice(1)).buffer);
      constants.set(ins.args[0] & 2047, Array.from(values, v => {
        const s = String(v); return /[.e]/i.test(s) ? s : `${s}.0`;
      }));
    }
    const header = ['precision highp float;'];
    for (const [n, value] of constants) header.push(value
      ? `const vec4 ${constantName(n)} = vec4(${value.join(', ')});` : `uniform vec4 ${constantName(n)};`);
    for (const n of samplers) header.push(`uniform sampler2D d3d_s${n};`);
    for (const n of inputs) header.push(pixel
      ? `varying vec4 d3d_${n >= 16 ? `tex${n - 16}` : `color${n}`};`
      : `attribute vec4 d3d_v${n};`);
    for (const name of outputs) if (name !== 'position') header.push(`varying vec4 d3d_${name};`);
    if(relative)header.push('vec4 d3d_relative(float index) {',
      ...Array.from({length:96},(_,i)=>`if (index == ${i}.0) return ${constantName(i)};`),
      'return vec4(0.0);','}');
    if (pixel) reg(0x800f0000, true);
    else if (!outputs.has('position')) fail('vertex shader does not write position', current);
    const epilogue = pixel ? 'gl_FragColor = r0;'
      : 'gl_Position = vec4(position.xy, position.z * 2.0 - position.w, position.w);';
    return { ...shader, source: [...header, 'void main() {', ...declarations.values(),
      ...lines, epilogue, '}'].join('\n'), semantics,
    attributes: Array.from(inputs).filter(() => !pixel).map(n => `d3d_v${n}`),
    uniforms: [...Array.from(constants).filter(([, v]) => !v).map(([n]) => constantName(n)),
      ...Array.from(samplers, n => `d3d_s${n}`)] };
  }
  function validateMemory(memory, address, version) {
    address >>>= 0;
    if (!address || address % 4 || address + 4 > memory.byteLength) return 0;
    const words = new Uint32Array(memory, address,
      Math.min(65536, Math.floor((memory.byteLength - address) / 4)));
    if (words[0] !== (version >>> 0)) return 0;
    try { return compile(words).length * 4; } catch (_) { return 0; }
  }
  return { parse, compile, validateMemory };
});
