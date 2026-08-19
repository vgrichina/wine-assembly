# WAT Macro/Codegen Opportunities

Duplication patterns where function extraction would add unacceptable call overhead in hot paths. These are best addressed with a WAT preprocessor, codegen script, or macro system.

## High Value (~500+ duplicated lines total)

### 1. Shift ops — 3x identical dispatch (228 lines)
**`05-alu.wat` lines 66-297**: `do_shift32`, `do_shift8`, `do_shift16` each contain 7 if-branches (ROL/ROR/RCL/RCR/SHL/SHR/SAR) with ~95% identical logic. Only size constants differ (mask: 0xFF/0xFFFF/0xFFFFFFFF, bits: 8/16/32, rotate mod: 9/17/33).

**Macro shape**: `SHIFT_OPS(bits, mask, rotate_mod)` → generates all 7 shift handlers for one width.

### 2. 8-bit ALU dispatch — 2x identical br_table (111 lines)
**`05-alu.wat` lines 911-1023**: `th_alu_r8_r8` and `th_alu_r8_i8` have identical br_table with 8 ALU op blocks. Only the operand extraction differs (2 lines out of ~55).

**Macro shape**: `ALU_R8_DISPATCH(operand_expr)` → generates br_table with 8 op handlers.

### 3. ALU reg-imm / reg-reg handlers (102 lines)
**`05-alu.wat` lines 310-417**: 16 handlers (8 ops × 2 variants). Each ~6 lines, differing only in which ALU op and operand source.

**Macro shape**: `ALU_HANDLER(name, op, operand_source)` → generates one handler function.

### 4. String ops — rep/non-rep × byte/dword (69 lines)
**`05-alu.wat` lines 1055-1136**: 8 handlers: movsb/movsd/stosb/stosd × {single, rep}. Non-rep = body once, rep = same body in a loop. Byte vs dword differs only in constants (1 vs 4) and load/store width.

**Macro shape**: `STRING_OP(name, width, is_rep, is_stos)` → generates one handler.

## Medium Value (~50-90 duplicated lines)

### 5. Window table scan loops (28 lines)
**`09c-help.wat` lines 17-83**: 4 functions (`wnd_table_set/get/remove/find`) share identical loop boilerplate scanning the window table at base `0x2000` with entry size 8.

**Macro shape**: `WND_TABLE_SCAN(match_body)` → generates the scan loop with a pluggable match block.

### 6. Table address calculations (~45 lines across 15+ sites)
**`09c-help.wat` throughout**: Pattern `(i32.add (i32.const BASE) (i32.mul idx (i32.const SIZE)))` with various BASE/SIZE combos (0x2000/8, 0x2100/64, 0x2200/4, 0x2280/4, 0x2580/4).

**Macro shape**: Named constants `WINDOW_TABLE`, `CLASS_TABLE`, etc. + `TABLE_ADDR(base, idx, size)`.

### 7. Register get/set if-chains (20 lines)
**`03-registers.wat` lines 4-24**: `$get_reg` and `$set_reg` each have 7 sequential if-branches mapping register index to global. Could be a br_table but register globals can't be indirect-accessed in WASM.

**Macro shape**: `REG_DISPATCH(op, reg_list)` → generates the if-chain.

## Low Value (cosmetic, <15 lines)

### 8. Color bracket pattern
**`09c-help.wat`**: `set_text_color(BLUE) → text_out → set_text_color(BLACK)` repeated 4x. Only ~3 lines each — not worth a macro.

## Implementation Options

1. **WAT preprocessor** — A simple text macro expander (Python/Node) that runs before `build.sh` concatenation. Define macros in a header file, expand `$MACRO(args)` patterns.
2. **Codegen script** — Extend `tools/gen_dispatch.js` pattern: generate `05-alu.generated.wat` from a declarative table of ALU/shift/string ops.
3. **Build-time templating** — Use sed/m4/envsubst in `build.sh` to expand parameterized templates.

Option 2 (codegen script) is most consistent with the existing `gen_dispatch.js` / `gen_api_table.js` pattern.
