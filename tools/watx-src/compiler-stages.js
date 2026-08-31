// ═══════════════════════════════════════════════════════════════
// WATX COMPILER — Stages 2-4: Include, Macro, Type Checker
// ═══════════════════════════════════════════════════════════════

// --- Stage 2: Include Resolver ---
function resolveIncludes(forms, vfs, included = new Set(), filename = '<main>', parseContext = null) {
  const result = [];
  for (const form of forms) {
    if (Array.isArray(form) && form.length >= 3 && watxValue(form[1]) === 'include') {
      const path = watxValue(form[2])?.replace(/"/g, '') || '';
      if (included.has(path)) continue;
      if (!vfs.has(path)) {
        const e = new Error(`Missing include '${path}' referenced from ${filename}`);
        e.line = watxNodeLine(form);
        e.col = watxNodeCol(form);
        e.file = filename;
        throw e;
      }
      included.add(path);
      const src = vfs.get(path);
      const subForms = parseSource(src, path, parseContext);
      const resolved = resolveIncludes(subForms, vfs, included, path, parseContext);
      // Avoid passing every included top-level form as a call argument. Large
      // projects can exceed browser/Node argument-stack limits here.
      for (const resolvedForm of resolved) result.push(resolvedForm);
    } else {
      result.push(form);
    }
  }
  return result;
}

// --- Stage 3: Macro Expander ---
function expandMacros(forms) {
  const macros = new Map();
  let gensymCounter = 0;

  function gensym(base) { return `$__gs_${base}_${gensymCounter++}`; }

  function collectMacros(formList) {
    const out = [];
    for (const form of formList) {
      if (Array.isArray(form) && watxValue(form[1]) === 'defmacro') {
        const sig = form[2];
        if (Array.isArray(sig)) {
          const name = watxValue(sig[1]) || sig[1];
          const params = sig.slice(2).map(p => watxValue(p) || p);
          const body = form.slice(3);
          macros.set(typeof name === 'string' ? name : name, { params, body });
        }
      } else {
        out.push(form);
      }
    }
    return out;
  }

  function interpolateName(template, bindings) {
    let result = template;
    for (const [k, v] of Object.entries(bindings)) {
      const val = watxValue(v) || String(v);
      result = result.replace(new RegExp(`\\{[^}]*${k.replace('$', '\\$')}[^}]*\\}`, 'g'), (match) => {
        let r = match.slice(1, -1);
        for (const [bk, bv] of Object.entries(bindings)) {
          const bval = watxValue(bv) || String(bv);
          r = r.replace(bk, bval.replace('$', ''));
        }
        return '$' + r;
      });
    }
    return result;
  }

  function substitute(template, bindings) {
    if (Array.isArray(template)) {
      if (watxValue(template[1]) === 'begin') {
        return template.slice(2).flatMap(t => {
          const r = substitute(t, bindings);
          return Array.isArray(r) && r._isBegin ? r : [r];
        });
      }
      const result = [template[0]];
      for (let i = 1; i < template.length; i++) {
        result.push(substitute(template[i], bindings));
      }
      return result;
    }
    if (watxType(template) === 'symbol') {
      const val = watxValue(template);
      if (bindings[val] !== undefined) return bindings[val];
      if (val.includes('{')) {
        const newVal = interpolateName(val, bindings);
        return cloneWatxAtomValue(template, newVal);
      }
      return template;
    }
    return template;
  }

  function expandForm(form) {
    if (!Array.isArray(form)) return form;
    const head = watxValue(form[1]);
    if (head && macros.has(head)) {
      const macro = macros.get(head);
      const args = form.slice(2);
      const bindings = {};
      macro.params.forEach((p, i) => { bindings[p] = args[i]; });
      const expanded = macro.body.map(b => substitute(b, bindings));
      if (expanded.length === 1) return expandForm(expanded[0]);
      const result = expanded.flatMap(e => Array.isArray(e) && e._isBegin ? e : [expandForm(e)]);
      result._isBegin = true;
      return result;
    }
    let result = null;
    for (let i = 1; i < form.length; i++) {
      const child = form[i];
      const expandedChild = expandForm(child);
      if (result) {
        result.push(expandedChild);
      } else if (expandedChild !== child) {
        result = form.slice(0, i);
        result.push(expandedChild);
      }
    }
    if (!result) return form;
    return result;
  }

  let expanded = collectMacros(forms);
  expanded = expanded.flatMap(f => {
    const r = expandForm(f);
    return Array.isArray(r) && r._isBegin ? r : [r];
  });
  return expanded;
}

// --- Stage 4: Bidirectional Type/Region Checker ---
// Valid scalar/vector type tokens for a layout field, `let` annotation, `if` block type, etc.
// v128 (WASM SIMD) added by the SIMD track 2026-08-12 (shared host-SIMD substrate).
var VALTYPE_TOKENS = ["i32","i64","f32","f64","v128","u8","ptr","weak"];
function checkTypes(forms, options = {}) {
  var V = watxValue, T = watxType;
  var A = watxAt, N = watxFormLength, SL = watxFormSlice;
  const collectWarnings = options.collectWarnings !== false;
  var errors = [], warnings = [];
  var layouts = new Map(), fieldsByLayout = new Map(), functions = new Map(), regions = new Set(["static"]), importSigs = new Map();
  var functionDecls = [], inlineExportDecls = [], anonymousFuncId = 0;
  // Source order of the two declaration kinds that own a function signature.
  // The emitter needs the *interleaving* of imports and functions to number the
  // type section the way lib/compile-wat.js does, and by the time it runs the
  // (func ...) forms are no longer top-level forms it can see. This single pass
  // is the last place both are visible together, so record the sequence here.
  var declOrder = [];
  function fieldKey(layoutName, fieldName) { return layoutName + "\u0000" + fieldName; }
  function loc(form) {
    if (form && (watxFormLoc(form) !== undefined || form.line)) return { line: watxNodeLine(form), col: watxNodeCol(form) };
    return { line: 0, col: 0 };
  }
  function addError(msg, form) { var l = loc(form); errors.push({ msg: msg, line: l.line, col: l.col }); }
  function addWarning(msg, form) { if (!collectWarnings) return; var l = loc(form); warnings.push({ msg: msg, line: l.line, col: l.col }); }
  for (var fi = 0; fi < forms.length; fi++) { var form = forms[fi];
    if (!Array.isArray(form)) continue; var head = V(A(form,0));
    if (head === "layout") { var name = V(A(form,1)); if (name) { var fields = [];
      for (var i = 2; i < N(form); i++) { var fieldForm=A(form,i); if (Array.isArray(fieldForm) && V(A(fieldForm,0)) === "field") {
        var fname = V(A(fieldForm,1)), ftype = V(A(fieldForm,2)) || "i32";
        if (fname) { if (VALTYPE_TOKENS.indexOf(ftype)===-1) addWarning("Layout "+name+": field "+fname+" has unknown type "+ftype, fieldForm); var field={ name: fname, type: ftype }; fields.push(field); fieldsByLayout.set(fieldKey(name,fname),field); } } }
      if (layouts.has(name)) addWarning("Duplicate layout: "+name, form); layouts.set(name, fields); } }
    if (head === "func") {
      var cursor = 1;
      var explicitName = V(A(form,cursor)) && V(A(form,cursor)).charAt(0) === "$" ? V(A(form,cursor++)) : null;
      var name = explicitName || "$__anonymous_" + (anonymousFuncId++);
      var params = [], results = [], body = [], effectsClause = null;
      for (var i = cursor; i < N(form); i++) {
        var part=A(form,i);
        if (Array.isArray(part)) {
          var kind = V(A(part,0));
          if (kind === "param") {
            var pending = null;
            for (var pj = 1; pj < N(part); pj++) {
              var pv = V(A(part,pj));
              if (pv && pv.charAt(0) === "$") pending = pv;
              else if (pv) { params.push({name:pending,type:pv}); pending = null; }
            }
          } else if (kind === "result") {
            for (var j = 1; j < N(part); j++) results.push(V(A(part,j)) || "i32");
          } else if (kind === "effects") {
            effectsClause = part;
          } else if (kind === "export") {
            inlineExportDecls.push({exportName:(V(A(part,1)) || "").replace(/"/g, ""),kind:"func",ref:name,formIndex:fi});
          } else {
            body.push(part);
          }
        } else {
          body.push(part);
        }
      }
      var fd = {name:name,params:params,results:results,locals:[],body:body,effectsClause:effectsClause,form:form,hasEffects:!!effectsClause};
      functionDecls.push(fd);
      declOrder.push("func");
      if (!fd.hasEffects && name.indexOf("$__")!==0) addWarning("Function "+name+" missing (effects ...) clause", form);
      functions.set(name, fd);
    }
    if (head === "wasm-import" || head === "import") { var sig = A(form,3);
      if (Array.isArray(sig) && V(A(sig,0)) === "func") { var funcName=V(A(sig,1))||"",ip=[],ir=[];
        for (var i=2;i<N(sig);i++) { var sigPart=A(sig,i); if (Array.isArray(sigPart)) { var k2=V(A(sigPart,0));
          if (k2==="param") { for (var j=1;j<N(sigPart);j++){var iv=V(A(sigPart,j))||"i32";if(iv.charAt(0)!=="$")ip.push(iv);} }
          else if (k2==="result") { for (var j=1;j<N(sigPart);j++) ir.push(V(A(sigPart,j))||"i32"); } } }
        importSigs.set(funcName, {params:ip,results:ir}); declOrder.push("import"); } }
    if (head === "with-region") { var rn = V(A(form,1)); if(rn) regions.add(rn); }
  }
  function stackType(t) { if(typeof t==="number"){if(t===0x7f)return"i32";if(t===0x7e)return"i64";if(t===0x7d)return"f32";if(t===0x7c)return"f64";if(t===0x7b)return"v128";}
    if(t==="ptr"||t==="weak"||t==="u8"||t==="region-handle")return"i32"; return t||"i32"; }
  // SIMD (0xFD-prefix) op-name shape prefixes — used to identify v128-producing ops
  // without enumerating every opcode name. Scalar-returning SIMD ops (extract_lane_*,
  // any_true, all_true) are handled explicitly BEFORE this fallback returns 'v128'.
  function isSimdShapeHead(hd) {
    return typeof hd === "string" && (
      hd.indexOf("v128.")===0 || hd.indexOf("i8x16.")===0 || hd.indexOf("i16x8.")===0 ||
      hd.indexOf("i32x4.")===0 || hd.indexOf("i64x2.")===0 || hd.indexOf("f32x4.")===0 ||
      hd.indexOf("f64x2.")===0);
  }
  function checkFuncBody(funcInfo) { var form=funcInfo.form,params=funcInfo.params,results=funcInfo.results;
    var localEnv = new Map(); for(var pi=0;pi<params.length;pi++) if(params[pi].name) localEnv.set(params[pi].name,stackType(params[pi].type));
    var bodyExprs = []; for(var i=2;i<N(form);i++){var part=A(form,i);if(Array.isArray(part)){var k=V(A(part,0));if(k==="param"||k==="result"||k==="effects"||k==="export")continue;}bodyExprs.push(part);}
    function synthesize(expr) { if(!Array.isArray(expr)){if(T(expr)==="number")return String(V(expr)).indexOf(".")>=0?"f32":"i32";if(T(expr)==="symbol")return localEnv.has(V(expr))?localEnv.get(V(expr)):"i32";return"i32";}
      var hd=V(A(expr,0));if(!hd)return"i32";
      // SIMD (v128) first — scalar-returning extracts/reductions BEFORE the shape-prefix
      // fallback, so `(let $x (i32x4.extract_lane v 0))` types $x as i32, not v128.
      if(hd==="v128.any_true"||hd==="i8x16.all_true"||hd==="i16x8.all_true"||hd==="i32x4.all_true"||hd==="i64x2.all_true") return"i32";
      // bitmask reduces a vector to a scalar mask (migration gap G2) -- must be checked
      // before the shape-prefix fallback below, exactly like all_true/extract_lane.
      if(hd==="i8x16.bitmask"||hd==="i16x8.bitmask"||hd==="i32x4.bitmask"||hd==="i64x2.bitmask") return"i32";
      if(hd==="i8x16.extract_lane_s"||hd==="i8x16.extract_lane_u"||hd==="i16x8.extract_lane_s"||hd==="i16x8.extract_lane_u"||hd==="i32x4.extract_lane") return"i32";
      if(hd==="i64x2.extract_lane") return"i64";
      if(hd==="f32x4.extract_lane") return"f32";
      if(hd==="f64x2.extract_lane") return"f64";
      if(isSimdShapeHead(hd)) return"v128";
      if(hd.indexOf("i32.")===0)return"i32";if(hd.indexOf("i64.")===0)return"i64";if(hd.indexOf("f32.")===0)return"f32";if(hd.indexOf("f64.")===0)return"f64";
      if(["f32.convert_i32_s","f32.convert_i32_u","f32.demote_f64","f32.reinterpret_i32"].indexOf(hd)>=0)return"f32";
      if(["i32.trunc_f32_s","i32.trunc_f32_u","i32.reinterpret_f32","i32.wrap_i64"].indexOf(hd)>=0)return"i32";
      if(hd==="i64.extend_i32_s")return"i64";if(hd==="f64.promote_f32")return"f64";
      if(hd==="call"){var fn=V(A(expr,1));var im=importSigs.get(fn);if(im&&im.results.length>0)return stackType(im.results[0]);var uf=functions.get(fn);if(uf&&uf.results.length>0)return stackType(uf.results[0]);return"i32";}
      if(hd==="local.get"){var n=V(A(expr,1));return(n&&localEnv.has(n))?localEnv.get(n):"i32";}
      if(hd==="load.field"||hd==="load.elem"||hd==="load.field-elem"){var ln=V(A(expr,1)),fn=V(A(expr,2)),lo=layouts.get(ln);if(lo){var f=fieldsByLayout.get(fieldKey(ln,fn));if(f)return stackType(f.type);}return"i32";}
      if(hd==="let"){var nm=V(A(expr,1));if(N(expr)>=4&&T(A(expr,2))==="symbol"&&VALTYPE_TOKENS.indexOf(V(A(expr,2)))>=0){var dt=stackType(V(A(expr,2)));if(nm)localEnv.set(nm,dt);return dt;}if(nm&&A(expr,2)){var it=synthesize(A(expr,2));localEnv.set(nm,it);return it;}return"i32";}
      if(hd==="if"){if(T(A(expr,1))==="symbol"&&["i32","i64","f32","f64","v128"].indexOf(V(A(expr,1)))>=0)return stackType(V(A(expr,1)));return"i32";}
      if(hd==="select")return N(expr)>=3?synthesize(A(expr,1)):"i32";
      if(hd==="region.alloc"||hd==="region.addr"||hd==="region.size"||hd==="region.end"||hd==="set!"||hd==="local.set"||hd==="store.field"||hd==="store.elem"||hd==="store.field-elem")return"i32";
      // block/loop may carry a standard (result T) signature (migration gap G4); it wins
      // over the "type of the last body expression" guess.
      if(hd==="block"||hd==="loop"){
        var lb=T(A(expr,1))==="symbol"&&V(A(expr,1))&&V(A(expr,1)).charAt(0)==="$";
        var sig=A(expr,lb?2:1);
        if(Array.isArray(sig)&&V(A(sig,0))==="result") return stackType(V(A(sig,1))||"i32");
        if(sig&&!Array.isArray(sig)&&T(sig)==="symbol"&&VALTYPE_TOKENS.indexOf(V(sig))>=0) return stackType(V(sig));
        return N(expr)>=2?synthesize(A(expr,N(expr)-1)):"i32";
      }
      if(hd==="begin"||hd==="with-region")return N(expr)>=2?synthesize(A(expr,N(expr)-1)):"i32";
      if(["nop","drop","br","br_if","return"].indexOf(hd)>=0)return"i32";return"i32";}
    function checkExpr(expr,expected,context){var actual=synthesize(expr);if(actual!==expected)addWarning("Type mismatch in "+context+": expected "+expected+", got "+actual,expr);}
    function walkExpr(expr){if(!Array.isArray(expr))return;var hd=V(A(expr,0));if(!hd)return;
      if(hd==="let"){var nm=V(A(expr,1));if(N(expr)>=4&&T(A(expr,2))==="symbol"&&VALTYPE_TOKENS.indexOf(V(A(expr,2)))>=0){var dt=stackType(V(A(expr,2)));if(nm)localEnv.set(nm,dt);checkExpr(A(expr,3),dt,"let "+nm+" init");walkExpr(A(expr,3));}else if(nm&&A(expr,2)){localEnv.set(nm,synthesize(A(expr,2)));walkExpr(A(expr,2));}return;}
      if(hd==="set!"||hd==="local.set"){var nm=V(A(expr,1));if(nm&&localEnv.has(nm)&&A(expr,2)){checkExpr(A(expr,2),localEnv.get(nm),"set! "+nm);walkExpr(A(expr,2));}return;}
      if(hd==="call"){var fn=V(A(expr,1));var ep=null;var im=importSigs.get(fn);if(im)ep=im.params;else{var uf=functions.get(fn);if(uf)ep=uf.params.map(function(p){return p.type});}if(ep){var args=SL(expr,2);for(var ai=0;ai<Math.min(args.length,ep.length);ai++)checkExpr(args[ai],stackType(ep[ai]),"call "+fn+" arg "+ai);if(args.length!==ep.length)addError("call "+fn+": expected "+ep.length+" args, got "+args.length+" (wrong number of arguments)",expr);}for(var i=2;i<N(expr);i++)walkExpr(A(expr,i));return;}
      if(hd==="store.field"){var ln=V(A(expr,1)),fn=V(A(expr,2)),lo=layouts.get(ln);if(lo){var f=fieldsByLayout.get(fieldKey(ln,fn));if(f&&A(expr,4))checkExpr(A(expr,4),stackType(f.type),"store.field "+ln+"."+fn);if(!f)addWarning("Unknown field "+fn+" in layout "+ln,expr);}else if(ln)addWarning("Unknown layout "+ln,expr);for(var i=3;i<N(expr);i++)walkExpr(A(expr,i));return;}
      if(hd==="store.elem"){var ln=V(A(expr,1)),fn=V(A(expr,2)),lo=layouts.get(ln);if(lo){var f=fieldsByLayout.get(fieldKey(ln,fn));if(f&&A(expr,5))checkExpr(A(expr,5),stackType(f.type),"store.elem "+ln+"."+fn);}for(var i=3;i<N(expr);i++)walkExpr(A(expr,i));return;}
      if(hd==="load.field"){var ln=V(A(expr,1)),fn=V(A(expr,2)),lo=layouts.get(ln);if(!lo&&ln)addWarning("Unknown layout "+ln,expr);else if(lo&&fn&&!fieldsByLayout.has(fieldKey(ln,fn)))addWarning("Unknown field "+fn+" in layout "+ln,expr);for(var i=3;i<N(expr);i++)walkExpr(A(expr,i));return;}
      if(hd==="store.field-elem"){var ln=V(A(expr,1)),fn=V(A(expr,2)),lo=layouts.get(ln);if(lo){var f=fieldsByLayout.get(fieldKey(ln,fn));if(f&&A(expr,5))checkExpr(A(expr,5),stackType(f.type),"store.field-elem "+ln+"."+fn);if(!f)addWarning("Unknown field "+fn+" in layout "+ln,expr);}else if(ln)addWarning("Unknown layout "+ln,expr);for(var i=3;i<N(expr);i++)walkExpr(A(expr,i));return;}
      if(hd==="load.field-elem"){var ln=V(A(expr,1)),fn=V(A(expr,2)),lo=layouts.get(ln);if(!lo&&ln)addWarning("Unknown layout "+ln,expr);else if(lo&&fn&&!fieldsByLayout.has(fieldKey(ln,fn)))addWarning("Unknown field "+fn+" in layout "+ln,expr);for(var i=3;i<N(expr);i++)walkExpr(A(expr,i));return;}
      if(hd==="if"){var ci=1;if(T(A(expr,1))==="symbol"&&["i32","i64","f32","f64","v128"].indexOf(V(A(expr,1)))>=0)ci=2;if(A(expr,ci)){checkExpr(A(expr,ci),"i32","if condition");walkExpr(A(expr,ci));}for(var i=ci+1;i<N(expr);i++)if(Array.isArray(A(expr,i)))walkExpr(A(expr,i));return;}
      if(hd==="with-region"){for(var i=3;i<N(expr);i++)if(Array.isArray(A(expr,i)))walkExpr(A(expr,i));return;}
      if(hd==="begin"||hd==="block"){for(var i=1;i<N(expr);i++)walkExpr(A(expr,i));return;}
      if(hd==="loop"){for(var i=2;i<N(expr);i++)walkExpr(A(expr,i));return;}
      // br_if: the CONDITION is always the last operand. The standard folded form for a
      // typed target block carries a branch value before it (migration gap G4), so
      // reading argument 2 unconditionally would type-check the wrong expression.
      if(hd==="br_if"){var hl=T(A(expr,1))==="symbol"&&V(A(expr,1))&&V(A(expr,1)).charAt(0)==="$";
        var cond=hl?A(expr,N(expr)-1):A(expr,1);
        if(hl&&N(expr)<3)cond=null;
        if(cond){checkExpr(cond,"i32","br_if condition");walkExpr(cond);}
        if(hl&&N(expr)>3)walkExpr(A(expr,2));
        return;}
      // br_table accepts both standard folded WAT and the explicit WATX labels group:
      //   (br_table $l0 $l1 ... $default <i32-idx-expr>)
      //   (br_table (labels $l0 $l1 ...) $default <i32-idx-expr>)
      if(hd==="br_table"){
        var first=A(expr,1), grouped=Array.isArray(first)&&V(A(first,0))==="labels";
        var defaultLabel=grouped?A(expr,2):A(expr,N(expr)-2);
        var indexExpr=grouped?A(expr,3):A(expr,N(expr)-1);
        if(!grouped&&N(expr)<3) addError("br_table: expected default label and index expression",expr);
        if(!defaultLabel) addError("br_table: missing default label",expr);
        if(!indexExpr) addError("br_table: missing index expression",expr);
        else { checkExpr(indexExpr,"i32","br_table index"); walkExpr(indexExpr); }
        return;
      }
      if(hd==="return"){if(A(expr,1)&&results.length>0){checkExpr(A(expr,1),stackType(results[0]),"return value");walkExpr(A(expr,1));}return;}
      // Bulk-memory: (memory.copy dst src len) / (memory.fill dst val len) -- all args i32, pushes NOTHING.
      // Arity + i32 check here; the emitter treats these as void (exprProducesValue returns false).
      if(hd==="memory.copy"||hd==="memory.fill"){
        if(N(expr)!==4) addError(hd+": expected 3 args (dst,"+(hd==="memory.copy"?"src":"val")+",len), got "+(N(expr)-1),expr);
        for(var i=1;i<Math.min(N(expr),4);i++){ checkExpr(A(expr,i),"i32",hd+" arg "+(i-1)); walkExpr(A(expr,i)); }
        return;
      }
      for(var i=1;i<N(expr);i++)if(Array.isArray(A(expr,i)))walkExpr(A(expr,i));}
    if(results.length>0&&bodyExprs.length>0){var lastExpr=bodyExprs[bodyExprs.length-1],lastType=synthesize(lastExpr),expectedResult=stackType(results[0]);
      if(lastType!==expectedResult)addWarning("Function "+(funcInfo.params.length?V(A(form,1)):"??")+": body produces "+lastType+", declared result is "+expectedResult,lastExpr);}
    for(var bi=0;bi<bodyExprs.length;bi++)walkExpr(bodyExprs[bi]);
  }
  // Required production diagnostics are emitted by codegen with exact opcode
  // context. Advisory type warnings are disabled there, so avoid a duplicate
  // full-module body walk.
  if(options.requiredOnly)return {errors:errors,warnings:warnings,layouts:layouts,functions:functions,regions:regions,importSigs:importSigs,functionDecls:functionDecls,inlineExportDecls:inlineExportDecls,declOrder:declOrder};
  for(var entry of functions){var name=entry[0],funcInfo=entry[1];
    try{checkFuncBody(funcInfo);}catch(e){console.warn("[WATX checker] Error checking "+name+":",e.message);addWarning("Type checker internal error in "+name+": "+e.message,funcInfo.form);}}
  if(errors.length>0)console.log("[WATX checker] "+errors.length+" error(s), "+warnings.length+" warning(s)");
  var foldedWarnings=errors.map(function(e){var r={};for(var k in e)r[k]=e[k];r.msg="[TYPE ERROR] "+e.msg;r.isTypeError=true;return r;}).concat(warnings);
  return {errors:errors,warnings:foldedWarnings,layouts:layouts,functions:functions,regions:regions,importSigs:importSigs,functionDecls:functionDecls,inlineExportDecls:inlineExportDecls,declOrder:declOrder};
}
