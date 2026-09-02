// ═══════════════════════════════════════════════════════════════
// WATX COMPILER — Pipeline Orchestrator
// Compiles WATX → Real WebAssembly Binary
// ═══════════════════════════════════════════════════════════════
//
// DESIGN: Zero implicit coercion.
// All type conversions must be explicit in WATX source.
// The compiler never inserts i32.trunc_f32_s or f32.convert_i32_s
// on behalf of the programmer. If types don't match, the Wasm
// validator will reject the binary — which is correct behavior.
//
// Modules:
//   compiler-parser.js   — Stage 1: tokenize, parseSexpr, ParseError
//   compiler-stages.js   — Stages 2-4: resolveIncludes, expandMacros, checkTypes
//   compiler-codegen.js  — Stages 5-6: lowerIR, generateWasm, disassembleWasm
//   compiler.js (this)   — Pipeline glue: compile(), formatSexpr(), formatLowered()
//

function parseStreamingDescriptor(descriptor, parseContext = null) {
  const forms = parseSource(
    descriptor.source, descriptor.filename, parseContext,
    descriptor.start, descriptor.end);
  if (forms.length !== 1) throw new Error(`Expected one top-level form in ${descriptor.filename}`);
  return forms[0];
}

function watxFunctionHeader(form) {
  const header = [form[0], 'func'];
  let i = 2;
  if (typeof form[i] === 'string' && form[i].startsWith('$')) header.push(form[i++]);
  for (; i < form.length; i++) {
    const part = form[i];
    const head = Array.isArray(part) ? watxValue(part[1]) : null;
    if (head === 'param' || head === 'result' || head === 'effects' || head === 'export') header.push(part);
  }
  return header;
}

function watxFunctionBody(form) {
  const body = [];
  let i = 2;
  if (typeof form[i] === 'string' && form[i].startsWith('$')) i++;
  for (; i < form.length; i++) {
    const part = form[i];
    const head = Array.isArray(part) ? watxValue(part[1]) : null;
    if (head !== 'param' && head !== 'result' && head !== 'effects' && head !== 'export') body.push(part);
  }
  return body;
}

function watxIndirectTypeForms(form) {
  const found = [];
  const pending = [form];
  while (pending.length) {
    const expr = pending.pop();
    if (!Array.isArray(expr)) continue;
    const head = watxValue(expr[1]);
    if ((head === 'call_indirect' || head === 'return_call_indirect') && Array.isArray(expr[2])) {
      found.push(expr[2]);
    }
    for (let i = expr.length - 1; i >= 1; i--) if (Array.isArray(expr[i])) pending.push(expr[i]);
  }
  return found;
}

// Resolve include order and retain only source ranges. Pass 1 parses function
// headers and nested type annotations only; pass 2 reparses one complete body
// at a time when it is emitted.
function prepareStreamingModule(source, vfs) {
  const descriptors = [];
  const included = new Set();
  let headerContext = createParseContext();
  // Function bodies are reparsed one at a time. Keep their small, heavily
  // repeated symbol vocabulary (`local.get`, `$x`, `i32.const`, ...) but not
  // number or string literals: this lowers nursery churn without retaining
  // every distinct literal until the module is done.
  const bodyContext = createParseContext({ internValues: false, internSymbols: true, reuseLists: true });

  function indexSource(text, filename) {
    for (const range of scanWatxTopLevelForms(text, filename)) {
      const head = watxTopLevelHead(text, range.start, range.end);
      const descriptor = { source: text, filename, start: range.start, end: range.end, head };
      if (head !== 'include') {
        descriptors.push(descriptor);
        continue;
      }
      const includeForm = parseStreamingDescriptor(descriptor);
      const path = (watxValue(includeForm[2]) || '').replace(/"/g, '');
      if (included.has(path)) continue;
      if (!vfs.has(path)) {
        const e = new Error(`Missing include '${path}' referenced from ${filename}`);
        e.line = watxNodeLine(includeForm);
        e.col = watxNodeCol(includeForm);
        e.file = filename;
        throw e;
      }
      included.add(path);
      indexSource(vfs.get(path), path);
    }
  }

  indexSource(source, '<main>');

  // WATX macros have module scope today, including forward uses. They are tiny
  // compared with function bodies, so retaining their templates is deliberate.
  const macroForms = [];
  for (const descriptor of descriptors) {
    if (descriptor.head === 'defmacro') macroForms.push(parseStreamingDescriptor(descriptor, headerContext));
  }
  const macroInfo = new Map();
  function producesHeaderClause(node) {
    if (!Array.isArray(node)) return false;
    const head = watxValue(node[1]);
    if (head === 'param' || head === 'result' || head === 'effects' || head === 'export') return true;
    return head === 'begin' && node.slice(2).some(producesHeaderClause);
  }
  for (const form of macroForms) {
    const signature = form[2];
    const name = Array.isArray(signature) ? watxValue(signature[1]) : '';
    const producesHeader = form.slice(3).some(producesHeaderClause);
    if (name) macroInfo.set(name, {
      form, typeForms: watxIndirectTypeForms(form), dependencies: [], producesHeader,
    });
  }
  for (const info of macroInfo.values()) {
    const pending = [info.form];
    const dependencies = new Set();
    while (pending.length) {
      const node = pending.pop();
      if (!Array.isArray(node)) continue;
      const head = watxValue(node[1]);
      if (macroInfo.has(head) && head !== watxValue(info.form[2]?.[1])) dependencies.add(head);
      for (let i = 1; i < node.length; i++) if (Array.isArray(node[i])) pending.push(node[i]);
    }
    info.dependencies = [...dependencies];
  }
  const indirectTypeMacros = new Set(
    [...macroInfo].filter(([, info]) => info.typeForms.length).map(([name]) => name));
  const headerMacros = new Set(
    [...macroInfo].filter(([, info]) => info.producesHeader).map(([name]) => name));
  let addedIndirectDependency = true;
  let addedHeaderDependency = true;
  while (addedIndirectDependency || addedHeaderDependency) {
    addedIndirectDependency = false;
    addedHeaderDependency = false;
    for (const [name, info] of macroInfo) {
      if (!indirectTypeMacros.has(name) && info.dependencies.some(dependency => indirectTypeMacros.has(dependency))) {
        indirectTypeMacros.add(name);
        addedIndirectDependency = true;
      }
      if (!headerMacros.has(name) && info.dependencies.some(dependency => headerMacros.has(dependency))) {
        headerMacros.add(name);
        addedHeaderDependency = true;
      }
    }
  }

  function usedMacroTypeForms(descriptor) {
    if (!indirectTypeMacros.size) return [];
    const used = new Set();
    const pending = scanWatxListHeads(
      descriptor.source, descriptor.start, descriptor.end).filter(head => indirectTypeMacros.has(head));
    while (pending.length) {
      const name = pending.pop();
      if (used.has(name)) continue;
      used.add(name);
      pending.push(...macroInfo.get(name).dependencies);
    }
    return [...used].flatMap(name => macroInfo.get(name).typeForms);
  }

  const forms = [];
  const streamByHeader = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.head === 'defmacro') continue;
    if (descriptor.head === 'func') {
      const header = scanWatxFunctionHeader(
        descriptor.source, descriptor.filename, descriptor.start, descriptor.end,
        headerContext, macroForms, headerMacros);
      const streamInfo = {
        descriptor,
        functionOrdinal: 0,
        indirectTypeForms: [
          ...scanWatxTypeForms(
            descriptor.source, descriptor.filename, descriptor.start, descriptor.end, headerContext),
          ...usedMacroTypeForms(descriptor),
        ],
      };
      forms.push(header);
      streamByHeader.set(header, streamInfo);
      continue;
    }
    const raw = parseStreamingDescriptor(descriptor, headerContext);
    const expandedForms = expandMacros([...macroForms, raw]);
    let functionOrdinal = 0;
    for (const form of expandedForms) {
      if (!Array.isArray(form) || watxValue(form[1]) !== 'func') {
        forms.push(form);
        continue;
      }
      const header = watxFunctionHeader(form);
      const streamInfo = {
        descriptor,
        functionOrdinal: functionOrdinal++,
        indirectTypeForms: watxIndirectTypeForms(form),
      };
      forms.push(header);
      streamByHeader.set(header, streamInfo);
    }
  }

  function bindFunctionDeclarations(checkResult) {
    for (const fd of checkResult.functionDecls || []) {
      const streamInfo = streamByHeader.get(fd.form);
      if (!streamInfo) continue;
      fd.streamInfo = streamInfo;
      fd.indirectTypeForms = streamInfo.indirectTypeForms;
      fd.form = null;
    }
    streamByHeader.clear();
    headerContext = null;
  }

  function loadFunctionBody(fd) {
    const streamInfo = fd.streamInfo;
    if (!streamInfo) return fd.body;
    // The body is discarded immediately after emission. Reuse its dense list
    // storage for the next function and do not retain a module-wide atom pool.
    const raw = parseStreamingDescriptor(streamInfo.descriptor, bodyContext);
    const expandedForms = expandMacros([...macroForms, raw]);
    const functions = expandedForms.filter(form => Array.isArray(form) && watxValue(form[1]) === 'func');
    const form = functions[streamInfo.functionOrdinal];
    if (!form) throw new Error(`Streaming pass mismatch while loading ${fd.name}`);
    return {
      body: watxFunctionBody(form),
      release() { recycleWatxTree(form, bodyContext); },
    };
  }

  return { forms, bindFunctionDeclarations, loadFunctionBody };
}

// --- Full Compiler Pipeline ---
function compile(source, vfs = new Map(), options = {}) {
  const stages = [];
  let currentStage = 'PARSE';
  const production = options.mode === 'production';
  const debugArtifacts = options.debugArtifacts ?? !production;
  const logFunctions = options.logFunctions ?? !production;
  const logSummary = options.logSummary ?? !production;
  const collectWarnings = options.collectWarnings ?? !production;
  const streaming = production && !debugArtifacts && options.streaming !== false;
  
  try {
    let expanded;
    let streamingModule = null;
    if (streaming) {
      currentStage = 'PARSE';
      streamingModule = prepareStreamingModule(source, vfs);
      stages.push({ name: 'PARSE', success: true });
      stages.push({ name: 'INCLUDE', success: true });
      stages.push({ name: 'EXPAND', success: true });
      expanded = streamingModule.forms;
    } else {
      const parseContext = createParseContext();
      // Stage 1: Parse
      currentStage = 'PARSE';
      const ast = parseSource(source, '<main>', parseContext);
      stages.push({ name: 'PARSE', success: true });

      // Stage 2: Include
      currentStage = 'INCLUDE';
      const included = resolveIncludes(ast, vfs, new Set(), '<main>', parseContext);
      stages.push({ name: 'INCLUDE', success: true });

      // Stage 3: Expand
      currentStage = 'EXPAND';
      expanded = expandMacros(included);
      stages.push({ name: 'EXPAND', success: true });
    }
    
    // Stage 4: Check
    currentStage = 'CHECK';
    const checkResult = checkTypes(expanded, { collectWarnings, requiredOnly: production });
    if (streamingModule) {
      streamingModule.bindFunctionDeclarations(checkResult);
      expanded = expanded.filter(form => !Array.isArray(form) || watxValue(form[1]) !== 'func');
    }
    // Hard type errors (checkResult.errors) FAIL the build — they are the
    // high-confidence, false-positive-free subset (e.g. call arg-count
    // mismatch). Approximate findings remain warnings and do not block.
    if (checkResult.errors && checkResult.errors.length > 0) {
      const first = checkResult.errors[0];
      const e = new Error(
        `${first.msg}` +
        (checkResult.errors.length > 1 ? ` (+${checkResult.errors.length - 1} more type error(s))` : ''));
      e.line = first.line || 0;
      e.col = first.col || 0;
      throw e;
    }
    stages.push(collectWarnings
      ? { name: 'CHECK', success: true, warnings: checkResult.warnings }
      : { name: 'CHECK', success: true });
    
    // Stage 5: Lower
    currentStage = 'LOWER';
    const lowered = lowerIR(expanded, checkResult, { layoutsOnly: !debugArtifacts });
    stages.push({ name: 'LOWER', success: true });
    
    // Stage 6: Emit WASM Binary
    currentStage = 'EMIT';
    const emitOptions = streamingModule
      ? { ...options, loadFunctionBody: streamingModule.loadFunctionBody }
      : options;
    const wasmResult = generateWasm(expanded, lowered, checkResult, emitOptions);
    stages.push({ name: 'EMIT', success: true });
    
    const wasmText = debugArtifacts ? disassembleWasm(wasmResult) : undefined;
    
    // Log compilation summary for debugging
    const builtinCount = wasmResult.runtimeBuiltins ? 3 : 0;
    const firstUser = wasmResult.importDecls.length + builtinCount;
    if (logSummary) {
      console.log(`[WATX] Compiled successfully: ${wasmResult.binary.length} bytes, ${wasmResult.importDecls.length} imports, ${wasmResult.funcDecls.length} user funcs`);
      console.log(`[WATX] Function index map: imports[0..${wasmResult.importDecls.length - 1}] builtins=${builtinCount} user[${firstUser}..${firstUser + wasmResult.funcDecls.length - 1}]`);
    }
    if (logFunctions) {
      console.log(`[WATX] User functions:`, wasmResult.funcDecls.map((name, i) => `  [${firstUser + i}] ${name}`).join('\n'));
    }
    
    const result = {
      success: true,
      wasmBinary: wasmResult.binary,
      importMeta: wasmResult.importDecls,
      stages,
      diagnostics: checkResult.warnings.map(w => ({ type: 'warning', ...w })),
      // The region layout (docs/watx-region-safety-design.md §4.1/§8): what the
      // allocator produced, and whether a shake permuted it. A caller that
      // writes an artifact prints this; a caller that does not, ignores it.
      regions: wasmResult.regions || null,
    };
    if (debugArtifacts) {
      result.wasmText = wasmText;
      result.expanded = formatSexpr(expanded);
      result.lowered = formatLowered(lowered);
    }
    return result;
  } catch (e) {
    console.error(`[WATX] Compilation failed at stage ${currentStage}:`, e.message);
    stages.push({ name: currentStage, success: false, error: e.message });
    return {
      success: false,
      error: e.message,
      errorLine: e.line || 0,
      errorCol: e.col || 0,
      stages,
      diagnostics: [{ type: 'error', msg: e.message, line: e.line || 0, col: e.col || 0 }],
    };
  }
}

function formatSexpr(forms, indent = 0) {
  const pad = '  '.repeat(indent);
  let out = '';
  for (const form of forms) {
    if (Array.isArray(form)) {
      const values = form.slice(1);
      if (values.length <= 4 && !values.some(f => Array.isArray(f))) {
        out += pad + '(' + values.map(f => watxValue(f) ?? String(f)).join(' ') + ')\n';
      } else {
        out += pad + '(' + (watxValue(form[1]) ?? '') + '\n';
        for (let i = 2; i < form.length; i++) {
          if (Array.isArray(form[i])) {
            out += formatSexpr([form[i]], indent + 1);
          } else {
            out += '  '.repeat(indent + 1) + (watxValue(form[i]) ?? String(form[i])) + '\n';
          }
        }
        out += pad + ')\n';
      }
    } else if (form?.type === 'layout-lowered') {
      out += pad + `; layout ${form.name} (${form.totalSize} bytes)\n`;
      for (const f of form.fields) {
        out += pad + `;   ${f.name}: ${f.type} @ offset ${f.offset}\n`;
      }
    } else {
      out += pad + (watxValue(form) ?? String(form)) + '\n';
    }
  }
  return out;
}

function formatLowered(forms) {
  let out = ';; === Lowered IR ===\n\n';
  for (const form of forms) {
    if (form?.type === 'layout-lowered') {
      out += `;; Layout: ${form.name} (total: ${form.totalSize} bytes)\n`;
      for (const f of form.fields) {
        out += `;;   .${f.name} : ${f.type} @ offset ${f.offset} (${f.size} bytes)\n`;
      }
      out += '\n';
    }
  }
  out += formatSexpr(forms.filter(f => !f?.type?.startsWith('layout')));
  return out;
}
