// ═══════════════════════════════════════════════════════════════
// WATX COMPILER — Stage 1: Parser
// S-expression reader with position tracking
// ═══════════════════════════════════════════════════════════════

class ParseError extends Error {
  constructor(msg, line, col, file) {
    super(msg);
    this.line = line;
    this.col = col;
    this.file = file || '<main>';
  }
}

const WATX_DIGIT_RE = /[0-9]/;
const WATX_NUMBER_RE = /[0-9.\-xXa-fA-F]/;
const WATX_SYMBOL_START_RE = /[a-zA-Z_$\-\.{}\+\*\/\<\>\=\!\&\|\^\~\%\?\@\#]/;
const WATX_SYMBOL_RE = /[a-zA-Z0-9_$\-\.{}\+\*\/\<\>\=\!\&\|\^\~\%\?\@\#]/;

// Production parsing classifies ASCII with one table lookup instead of running
// a RegExp for nearly every source character.
const WATX_CHAR_DIGIT = 1;
const WATX_CHAR_NUMBER = 2;
const WATX_CHAR_SYMBOL_START = 4;
const WATX_CHAR_SYMBOL = 8;
const WATX_CHAR_FLAGS = new Uint8Array(128);
for (let code = 48; code <= 57; code++) WATX_CHAR_FLAGS[code] |= WATX_CHAR_DIGIT | WATX_CHAR_NUMBER | WATX_CHAR_SYMBOL;
for (let code = 65; code <= 90; code++) WATX_CHAR_FLAGS[code] |= WATX_CHAR_SYMBOL_START | WATX_CHAR_SYMBOL;
for (let code = 97; code <= 122; code++) WATX_CHAR_FLAGS[code] |= WATX_CHAR_SYMBOL_START | WATX_CHAR_SYMBOL;
for (const ch of '_$-.{}+*/<>=!&|^~%?@#') WATX_CHAR_FLAGS[ch.charCodeAt(0)] |= WATX_CHAR_SYMBOL_START | WATX_CHAR_SYMBOL;
for (const ch of '.-xXabcdefABCDEF') WATX_CHAR_FLAGS[ch.charCodeAt(0)] |= WATX_CHAR_NUMBER;

// Successful production builds used to allocate a separate { line, col, file }
// object for every list and repeat those three properties on every atom. The
// Android tree has ~310k lists and ~540k atoms, so source locations alone
// accounted for hundreds of thousands of objects. Pack file/line/column into a
// single safe integer and decode it only on diagnostic paths.
// Six file bits plus a 24-bit source offset fit in V8's non-negative 30-bit
// Smi range. Locations therefore stay inline in tagged slots instead of
// allocating one HeapNumber per expression. Line/column are resolved lazily
// only when a diagnostic is produced.
const WATX_LOC_FILE_BASE = 0x1000000;
const WATX_LOCATION_FILES = [];
const WATX_LOCATION_SOURCES = [];
const WATX_LOCATION_FILE_IDS = new Map();

function watxFileId(filename, source = '') {
  let id = WATX_LOCATION_FILE_IDS.get(filename);
  if (id === undefined) {
    id = WATX_LOCATION_FILES.length;
    if (id >= 64) throw new Error('WATX location encoding supports at most 64 source files');
    WATX_LOCATION_FILES.push(filename);
    WATX_LOCATION_FILE_IDS.set(filename, id);
  }
  if (source.length >= WATX_LOC_FILE_BASE) {
    throw new Error(`WATX source '${filename}' exceeds the 16 MB location-offset limit`);
  }
  WATX_LOCATION_SOURCES[id] = source;
  return id;
}

function packWatxLocBase(fileBase, offset) {
  return fileBase + offset;
}

function watxLocFile(loc) {
  return WATX_LOCATION_FILES[Math.floor(loc / WATX_LOC_FILE_BASE)] || '<main>';
}

function watxLocLine(loc) {
  const source = WATX_LOCATION_SOURCES[Math.floor(loc / WATX_LOC_FILE_BASE)] || '';
  const offset = loc % WATX_LOC_FILE_BASE;
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function watxLocCol(loc) {
  const source = WATX_LOCATION_SOURCES[Math.floor(loc / WATX_LOC_FILE_BASE)] || '';
  const offset = loc % WATX_LOC_FILE_BASE;
  let lineStart = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (source.charCodeAt(i) === 10) { lineStart = i + 1; break; }
  }
  return offset - lineStart + 1;
}

function watxAt(form, index) {
  return form?.[index + 1];
}

function watxFormLength(form) {
  return form.length - 1;
}

function watxFormSlice(form, start, end) {
  return form.slice(start + 1, end === undefined ? undefined : end + 1);
}

function watxFormLoc(form) {
  return Array.isArray(form) ? form[0] : undefined;
}

// Atoms are interned primitive strings, so they intentionally carry no source
// metadata. On the rare diagnostic path, recover an atom's packed location by
// scanning forward from its containing form instead of retaining an object per
// token for every successful build.
function watxTokenLoc(form, value) {
  const formLoc = watxFormLoc(form);
  if (formLoc === undefined || typeof value !== 'string') return formLoc;
  const fileId = Math.floor(formLoc / WATX_LOC_FILE_BASE);
  const source = WATX_LOCATION_SOURCES[fileId] || '';
  const formOffset = formLoc % WATX_LOC_FILE_BASE;
  const tokenOffset = source.indexOf(value, formOffset);
  return tokenOffset < 0 ? formLoc : fileId * WATX_LOC_FILE_BASE + tokenOffset;
}

function watxNodeLine(node) {
  const loc = typeof node === 'number' ? node : watxFormLoc(node);
  return loc !== undefined ? watxLocLine(loc) : (node?.line || 0);
}

function watxNodeCol(node) {
  const loc = typeof node === 'number' ? node : watxFormLoc(node);
  return loc !== undefined ? watxLocCol(loc) : (node?.col || 0);
}

function watxNodeFile(node) {
  const loc = typeof node === 'number' ? node : watxFormLoc(node);
  return loc !== undefined ? watxLocFile(loc) : node?.file;
}

function watxValue(node) {
  return typeof node === 'string' ? node : node?.value;
}

function watxType(node) {
  if (typeof node !== 'string') return node?.type;
  if (node.charCodeAt(0) === 34) return 'string';
  const first = node.charCodeAt(0);
  const second = node.charCodeAt(1);
  if ((first >= 48 && first <= 57) ||
      (first === 45 && second >= 48 && second <= 57)) return 'number';
  return 'symbol';
}

function makeWatxAtom(type, value, loc) {
  return value;
}

function cloneWatxAtomValue(atom, value) {
  return value;
}

function createParseContext(options = {}) {
  const internValues = options.internValues !== false;
  return {
    symbols: internValues ? new Map() : null,
    numbers: internValues ? new Map() : null,
    strings: internValues ? new Map() : null,
    listPool: options.reuseLists ? [] : null,
    recyclePending: options.reuseLists ? [] : null,
  };
}

function internWatxValue(parseContext, type, value) {
  if (!parseContext) return value;
  const pool = type === 'symbol' ? parseContext.symbols :
    type === 'number' ? parseContext.numbers : parseContext.strings;
  if (!pool) return value;
  const existing = pool.get(value);
  if (existing !== undefined) return existing;
  pool.set(value, value);
  return value;
}

function tokenize(source, filename) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line++; col = 1; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { col++; i++; continue; }
    if (ch === ';' && source[i+1] === ';') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(', line, col, file: filename }); i++; col++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')', line, col, file: filename }); i++; col++; continue; }
    if (ch === '"') {
      const start = i;
      const startCol = col;
      i++; col++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') { i++; col++; }
        i++; col++;
      }
      if (i < source.length) { i++; col++; }
      tokens.push({ type: 'string', value: source.slice(start, i), line, col: startCol, file: filename });
      continue;
    }
    if (WATX_DIGIT_RE.test(ch) || (ch === '-' && WATX_DIGIT_RE.test(source[i+1]))) {
      const start = i;
      const startCol = col;
      while (i < source.length && WATX_NUMBER_RE.test(source[i])) { i++; col++; }
      tokens.push({ type: 'number', value: source.slice(start, i), line, col: startCol, file: filename });
      continue;
    }
    if (WATX_SYMBOL_START_RE.test(ch)) {
      const start = i;
      const startCol = col;
      while (i < source.length && WATX_SYMBOL_RE.test(source[i])) { i++; col++; }
      tokens.push({ type: 'symbol', value: source.slice(start, i), line, col: startCol, file: filename });
      continue;
    }
    i++; col++;
  }
  return tokens;
}

// Production parser: scan directly into an AST without materializing comment or
// parenthesis tokens. An explicit list stack also removes parser call-stack use.
// `startOffset`/`endOffset` let the production compiler parse one indexed
// top-level form without slicing or losing source locations.
function parseSource(source, filename = '<main>', parseContext = null, startOffset = 0, endOffset = source.length) {
  const forms = [];
  const stack = [];
  const fileBase = watxFileId(filename, source) * WATX_LOC_FILE_BASE;
  let i = startOffset;

  function errorAt(message, offset) {
    const loc = packWatxLocBase(fileBase, offset);
    return new ParseError(message, watxLocLine(loc), watxLocCol(loc), filename);
  }

  function append(node) {
    if (stack.length) stack[stack.length - 1].push(node);
    else forms.push(node);
  }

  while (i < endOffset) {
    const ch = source[i];
    const flags = WATX_CHAR_FLAGS[source.charCodeAt(i)] || 0;
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === ';' && source[i + 1] === ';') {
      while (i < endOffset && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') {
      const list = parseContext?.listPool?.pop() || [];
      if (parseContext?.listPool) list._watxInPool = false;
      list.push(packWatxLocBase(fileBase, i));
      append(list);
      stack.push(list);
      i++;
      continue;
    }
    if (ch === ')') {
      if (!stack.length) throw errorAt('Unexpected ) — extra closing paren', i);
      stack.pop();
      i++;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      while (i < endOffset && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < endOffset) { i += 2; continue; }
        i++;
      }
      if (i >= endOffset) throw errorAt('Unterminated string literal', start);
      i++;
      const value = internWatxValue(parseContext, 'string', source.slice(start, i));
      append(makeWatxAtom('string', value, packWatxLocBase(fileBase, start)));
      continue;
    }

    const start = i;
    const isNumber = (flags & WATX_CHAR_DIGIT) !== 0 ||
      (ch === '-' && ((WATX_CHAR_FLAGS[source.charCodeAt(i + 1)] || 0) & WATX_CHAR_DIGIT) !== 0);
    if (isNumber) {
      while (i < endOffset && ((WATX_CHAR_FLAGS[source.charCodeAt(i)] || 0) & WATX_CHAR_NUMBER) !== 0) i++;
      const value = internWatxValue(parseContext, 'number', source.slice(start, i));
      append(makeWatxAtom('number', value, packWatxLocBase(fileBase, start)));
      continue;
    }
    if ((flags & WATX_CHAR_SYMBOL_START) !== 0) {
      while (i < endOffset && ((WATX_CHAR_FLAGS[source.charCodeAt(i)] || 0) & WATX_CHAR_SYMBOL) !== 0) i++;
      const value = internWatxValue(parseContext, 'symbol', source.slice(start, i));
      append(makeWatxAtom('symbol', value, packWatxLocBase(fileBase, start)));
      continue;
    }
    // Preserve the legacy reader's treatment of punctuation outside its atom
    // alphabet. Strict-token diagnostics can be added as an explicit mode once
    // the existing WATX tree has been normalized.
    i++;
  }

  if (stack.length) {
    const loc = stack[stack.length - 1][0];
    const meta = { line: watxLocLine(loc), col: watxLocCol(loc) };
    const scan = preScanParenBalance(source, filename);
    throw new ParseError(
      `Unmatched ( at line ${meta.line}, col ${meta.col}; ${scan.depth} unclosed paren(s) at EOF`,
      meta.line, meta.col, filename);
  }
  return forms;
}

function recycleWatxTree(root, parseContext) {
  const pool = parseContext?.listPool;
  if (!pool || !Array.isArray(root)) return;
  const pending = parseContext.recyclePending;
  pending.push(root);
  while (pending.length) {
    const form = pending.pop();
    // Macro substitution may put the same argument subtree in more than one
    // place. Keep a stable arena marker on parser arrays: changing its boolean
    // value avoids both an identity table and per-function hidden-class churn.
    if (form._watxInPool) continue;
    form._watxInPool = true;
    for (let i = 1; i < form.length; i++) if (Array.isArray(form[i])) pending.push(form[i]);
    form.length = 0;
    delete form._isBegin;
    pool.push(form);
  }
}

// Index balanced top-level forms without building their ASTs. This is the
// lightweight first half of production's two-pass compiler: sources stay in
// the VFS and function bodies are represented by byte ranges.
function scanWatxTopLevelForms(source, filename = '<main>') {
  const forms = [];
  let depth = 0;
  let start = -1;
  let i = 0;

  function fail(message, offset) {
    const fileBase = watxFileId(filename, source) * WATX_LOC_FILE_BASE;
    const loc = packWatxLocBase(fileBase, offset);
    throw new ParseError(message, watxLocLine(loc), watxLocCol(loc), filename);
  }

  while (i < source.length) {
    const ch = source[i];
    if (ch === ';' && source[i + 1] === ';') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      const stringStart = i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) i += 2;
        else i++;
      }
      if (i >= source.length) fail('Unterminated string literal', stringStart);
      i++;
      continue;
    }
    if (ch === '(') {
      if (depth++ === 0) start = i;
      i++;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) fail('Unexpected ) — extra closing paren', i);
      depth--;
      i++;
      if (depth === 0) forms.push({ start, end: i });
      continue;
    }
    i++;
  }
  if (depth !== 0) fail('Unmatched ( at end of input', start < 0 ? source.length : start);
  return forms;
}

function watxTopLevelHead(source, start, end) {
  let i = start + 1;
  while (i < end) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    if (ch === ';' && source[i + 1] === ';') {
      while (i < end && source[i] !== '\n') i++;
      continue;
    }
    const tokenStart = i;
    while (i < end) {
      const code = source.charCodeAt(i);
      if (((WATX_CHAR_FLAGS[code] || 0) & WATX_CHAR_SYMBOL) === 0) break;
      i++;
    }
    return source.slice(tokenStart, i);
  }
  return '';
}

// Return the head atom of every list in a source range without materializing
// list bodies. Pass 1 uses this to find which macro templates a function can
// expand, including transitive macro calls.
function scanWatxListHeads(source, start = 0, end = source.length) {
  const heads = [];
  let i = start;
  while (i < end) {
    const ch = source[i];
    if (ch === ';' && source[i + 1] === ';') {
      while (i < end && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < end && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < end) i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (ch !== '(') { i++; continue; }
    i++;
    while (i < end) {
      const next = source[i];
      if (next === ' ' || next === '\t' || next === '\r' || next === '\n') { i++; continue; }
      if (next === ';' && source[i + 1] === ';') {
        while (i < end && source[i] !== '\n') i++;
        continue;
      }
      break;
    }
    while (i < end && ((WATX_CHAR_FLAGS[source.charCodeAt(i)] || 0) & WATX_CHAR_SYMBOL_START) === 0) i++;
    const headStart = i;
    while (i < end && ((WATX_CHAR_FLAGS[source.charCodeAt(i)] || 0) & WATX_CHAR_SYMBOL) !== 0) i++;
    if (i > headStart) heads.push(source.slice(headStart, i));
  }
  return heads;
}

function scanWatxFunctionHeader(source, filename, start, end, parseContext = null, macroForms = [], macroNames = null) {
  const fileBase = watxFileId(filename, source) * WATX_LOC_FILE_BASE;
  const header = [packWatxLocBase(fileBase, start), 'func'];
  let i = start + 1;
  let sawHead = false;
  let sawName = false;

  function skipSpaceAndComments() {
    while (i < end) {
      const ch = source[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
      if (ch === ';' && source[i + 1] === ';') {
        while (i < end && source[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  function findListEnd(listStart) {
    let depth = 0;
    let p = listStart;
    while (p < end) {
      const ch = source[p];
      if (ch === ';' && source[p + 1] === ';') {
        while (p < end && source[p] !== '\n') p++;
        continue;
      }
      if (ch === '"') {
        p++;
        while (p < end && source[p] !== '"') {
          if (source[p] === '\\' && p + 1 < end) p += 2;
          else p++;
        }
        p++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return p + 1;
      p++;
    }
    return end;
  }

  while (i < end - 1) {
    skipSpaceAndComments();
    if (i >= end - 1 || source[i] === ')') break;
    if (source[i] === '(') {
      const childStart = i;
      const childEnd = findListEnd(childStart);
      const childHead = watxTopLevelHead(source, childStart, childEnd);
      if (childHead === 'param' || childHead === 'result' || childHead === 'effects' || childHead === 'export') {
        const child = parseSource(source, filename, parseContext, childStart, childEnd)[0];
        header.push(child);
      } else if (macroNames?.has(childHead)) {
        // Header clauses may themselves come from a forward-defined macro.
        // Parse only the immediate invocation, then retain only header output.
        const child = parseSource(source, filename, parseContext, childStart, childEnd)[0];
        for (const expanded of expandMacros([...macroForms, child])) {
          const expandedHead = Array.isArray(expanded) ? watxValue(expanded[1]) : null;
          if (expandedHead === 'param' || expandedHead === 'result' ||
              expandedHead === 'effects' || expandedHead === 'export') header.push(expanded);
        }
      }
      i = childEnd;
      continue;
    }
    if (((WATX_CHAR_FLAGS[source.charCodeAt(i)] || 0) & WATX_CHAR_SYMBOL_START) === 0) {
      // Match parseSource's compatibility behavior: punctuation outside the
      // atom alphabet (notably legacy `\$name`) is ignored.
      i++;
      continue;
    }
    const tokenStart = i;
    while (i < end && ((WATX_CHAR_FLAGS[source.charCodeAt(i)] || 0) & WATX_CHAR_SYMBOL) !== 0) i++;
    const token = source.slice(tokenStart, i);
    if (!sawHead) {
      sawHead = true;
      if (token !== 'func') throw new Error(`Expected func at ${filename}:${watxLocLine(header[0])}`);
    } else if (!sawName && token.startsWith('$')) {
      header.push(internWatxValue(parseContext, 'symbol', token));
      sawName = true;
    }
  }
  return header;
}

// Collect only nested `(type ...)` annotations. Anonymous indirect-call types
// must be registered before the Wasm type section is written, but retaining the
// rest of the function body in pass 1 is unnecessary.
function scanWatxTypeForms(source, filename, start = 0, end = source.length, parseContext = null) {
  const found = [];
  const stack = [];
  let i = start;
  while (i < end) {
    const ch = source[i];
    if (ch === ';' && source[i + 1] === ';') {
      while (i < end && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < end && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < end) i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === '(') {
      stack.push(i++);
      continue;
    }
    if (ch === ')') {
      const listStart = stack.pop();
      i++;
      if (listStart !== undefined && watxTopLevelHead(source, listStart, i) === 'type') {
        const form = parseSource(source, filename, parseContext, listStart, i)[0];
        if (form) found.push(form);
      }
      continue;
    }
    i++;
  }
  return found;
}

// Pre-scan source for paren balance and return diagnostic info
function preScanParenBalance(source, filename) {
  let depth = 0;
  let maxDepth = 0;
  let maxDepthLine = 0;
  let i = 0, line = 1;
  let inComment = false;
  const lineInfo = [];
  let lineOpens = 0, lineCloses = 0, lineDepthStart = 0;
  
  lineDepthStart = 0;
  
  while (i < source.length) {
    const ch = source[i];
    
    if (ch === '\n') {
      lineInfo.push({ line, depthStart: lineDepthStart, depthEnd: depth, opens: lineOpens, closes: lineCloses });
      line++;
      lineOpens = 0;
      lineCloses = 0;
      lineDepthStart = depth;
      inComment = false;
      i++;
      continue;
    }
    
    if (inComment) { i++; continue; }
    
    if (ch === ';' && i + 1 < source.length && source[i + 1] === ';') {
      inComment = true;
      i++;
      continue;
    }
    
    if (ch === '"' && !inComment) {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++;
        i++;
      }
      if (i < source.length) i++;
      continue;
    }
    
    if (ch === '(') {
      depth++;
      lineOpens++;
      if (depth > maxDepth) { maxDepth = depth; maxDepthLine = line; }
    } else if (ch === ')') {
      depth--;
      lineCloses++;
      if (depth < 0) {
        return { balanced: false, extraClose: true, line, depth, lineInfo };
      }
    }
    
    i++;
  }
  lineInfo.push({ line, depthStart: lineDepthStart, depthEnd: depth, opens: lineOpens, closes: lineCloses });
  
  return { balanced: depth === 0, depth, maxDepth, maxDepthLine, lineInfo };
}

// originalSource is optional — pass it for better diagnostics on paren errors
function parseSexpr(tokens, originalSource) {
  let pos = 0;
  function parseOne() {
    if (pos >= tokens.length) throw new ParseError('Unexpected end of input', 0, 0);
    const tok = tokens[pos];
    if (tok.type === 'comment') { pos++; return parseOne(); }
    if (tok.type === 'lparen') {
      pos++;
      const list = [];
      list._meta = { line: tok.line, col: tok.col, file: tok.file };
      while (pos < tokens.length && tokens[pos].type !== 'rparen') {
        if (tokens[pos].type === 'comment') { pos++; continue; }
        list.push(parseOne());
      }
      if (pos >= tokens.length) {
        let diagMsg = 'Unmatched (';
        try {
          const errorLine = tok.line;
          if (originalSource) {
            const scan = preScanParenBalance(originalSource, tok.file || '<main>');
            const li = scan.lineInfo;
            const sourceLines = originalSource.split('\n');
            
            diagMsg += ' at line ' + errorLine + ', col ' + tok.col;
            diagMsg += '\n' + scan.depth + ' unclosed paren(s) at EOF';
            diagMsg += '\nMax nesting depth: ' + scan.maxDepth + ' at line ' + scan.maxDepthLine;
            
            const topLevelEnds = [];
            for (let j = 0; j < li.length; j++) {
              if (li[j].depthEnd === 0 && li[j].depthStart > 0) {
                topLevelEnds.push(li[j].line);
              }
            }
            const lastClosed = topLevelEnds.length > 0 ? topLevelEnds[topLevelEnds.length - 1] : 0;
            diagMsg += '\nLast closed top-level form ends at line: ' + lastClosed;
            
            diagMsg += '\n\n=== Paren depth trace (from line ' + errorLine + ') ===\n';
            diagMsg += 'D=depth_before → depth_after | Line# | Source\n\n';
            let shown = 0;
            for (let j = 0; j < li.length && shown < 100; j++) {
              if (li[j].line >= errorLine) {
                const srcLine = sourceLines[li[j].line - 1] || '';
                const truncSrc = srcLine.length > 70 ? srcLine.substring(0, 67) + '...' : srcLine;
                let flag = '';
                if (li[j].depthEnd === 0) flag = ' ◄◄ TOP-LEVEL (depth=0)';
                else if (li[j].depthEnd === 1 && li[j].depthStart > 1) flag = ' ◄ back to func-level';
                else if (li[j].opens > 0 && li[j].closes === 0 && li[j].opens > 1) flag = ' ⚠ opens only (+' + li[j].opens + ')';
                diagMsg += 'D' + String(li[j].depthStart).padStart(2) + '→' + String(li[j].depthEnd).padStart(2) + ' L' + String(li[j].line).padStart(5) + ' │ ' + truncSrc + flag + '\n';
                shown++;
              }
            }
            
            diagMsg += '\n=== Last 30 lines of file ===\n';
            const startIdx = Math.max(0, li.length - 30);
            for (let j = startIdx; j < li.length; j++) {
              const srcLine = sourceLines[li[j].line - 1] || '';
              const truncSrc = srcLine.length > 70 ? srcLine.substring(0, 67) + '...' : srcLine;
              let flag = '';
              if (li[j].depthEnd === 0) flag = ' ◄◄ TOP-LEVEL';
              diagMsg += 'D' + String(li[j].depthStart).padStart(2) + '→' + String(li[j].depthEnd).padStart(2) + ' L' + String(li[j].line).padStart(5) + ' │ ' + truncSrc + flag + '\n';
            }
            
            diagMsg += '\nFinal depth: ' + scan.depth + ' (need ' + scan.depth + ' more closing parens)\n';
          } else {
            diagMsg += ' (opened at line ' + errorLine + ', col ' + tok.col + ')';
            let d = 0;
            const allTokenLines = [];
            let curLine = 1, lineOpen = 0, lineClose = 0;
            for (let ti = 0; ti < tokens.length; ti++) {
              const t = tokens[ti];
              while (curLine < t.line) {
                allTokenLines.push({ line: curLine, open: lineOpen, close: lineClose, depth: d });
                curLine++; lineOpen = 0; lineClose = 0;
              }
              if (t.type === 'lparen') { d++; lineOpen++; }
              else if (t.type === 'rparen') { d--; lineClose++; }
            }
            allTokenLines.push({ line: curLine, open: lineOpen, close: lineClose, depth: d });
            
            diagMsg += '\n\n=== Last 100 lines with paren depth ===\n';
            const startShow = Math.max(0, allTokenLines.length - 100);
            for (let li = startShow; li < allTokenLines.length; li++) {
              const info = allTokenLines[li];
              const depthBefore = info.depth - info.open + info.close;
              const marker = (info.line === errorLine) ? ' <<<< UNMATCHED' : '';
              diagMsg += 'D=' + String(depthBefore).padStart(3) + ' →D' + String(info.depth).padStart(3) + ' | L' + String(info.line).padStart(5) + marker + '\n';
            }
            diagMsg += '\nFinal depth: ' + d + '\n';
          }
        } catch(diagErr) {
          diagMsg += ' (diagnostic generation failed: ' + diagErr.message + ')';
        }
        throw new ParseError(diagMsg, tok.line, tok.col);
      }
      pos++;
      return list;
    }
    if (tok.type === 'rparen') throw new ParseError('Unexpected ) — extra closing paren', tok.line, tok.col);
    pos++;
    return { type: tok.type, value: tok.value, line: tok.line, col: tok.col, file: tok.file };
  }
  const forms = [];
  while (pos < tokens.length) {
    if (tokens[pos].type === 'comment') { pos++; continue; }
    forms.push(parseOne());
  }
  return forms;
}
