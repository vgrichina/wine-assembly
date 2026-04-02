# Winamp NSIS Installer — Annotated Disassembly

Disassembled from `winamp295.exe` (NSIS 2.x exehead). Entry point: `0x404046`.

## Global Variables

| Address      | Name             | Purpose                                        |
|--------------|------------------|-------------------------------------------------|
| `0x422030`   | error_msg_ptr    | Pointer to error message string (0 = no error)  |
| `0x422038`   | read_buf         | 512-byte file read buffer                       |
| `0x422238`   | crc_enabled      | Byte flag: 1 if CRC checking active             |
| `0x422640`   | running_crc      | Accumulated CRC32 value                         |
| `0x422688`   | progress_dlg     | HWND of progress dialog (or 0)                  |
| `0x422e90`   | silent_flag      | Byte flag: /S (silent install)                  |
| `0x422e91`   | ncrc_flag        | Byte flag: /NCRC (skip CRC check)               |
| `0x40a6b8`   | crc_table        | CRC32 lookup table (256 dwords)                 |
| `0x42cbd4`   | exe_handle       | File handle for self-EXE                        |
| `0x42cbcc`   | file_size        | Total EXE file size from GetFileSize             |
| `0x42cbc0`   | bytes_read       | Running count of bytes read from file            |
| `0x42cbc4`   | overlay_pos      | File offset where NSIS overlay was found         |

## Entry Point — Command Line Parsing (0x404046)

```asm
; --- Prologue ---
00404046  sub esp, 0xc
00404049  push ebx / push ebp / push esi / push edi

; --- Get tick count for progress dialog timeout ---
0040404d  call GetTickCount
00404059  add eax, 0x3e8              ; timeout = now + 1000ms
0040405e  mov [esp+0x14], eax         ; save deadline

; --- Get temp path and command line ---
00404075  call GetTempPathA(0x400, 0x42bf60)
0040407c  call GetCommandLineA
00404082  push eax                     ; cmdline ptr
00404083  push [0x409290]              ; dest buf (global)
00404089  call lstrcpynA               ; copy cmdline to buffer

; --- Skip program name in command line ---
;     esi = start of cmdline copy
;     bl = delimiter: 0x20 (space), or 0x22 if quoted
0040408f  cmp byte [esi], 0x22        ; starts with quote?
00404092  jnz short 0x404098
00404094  add bl, 0x2                 ; bl = '"' (0x22)
00404097  inc esi                     ; skip opening quote

; --- Walk past program name using CharNextA ---
00404098  mov ebp, [CharNextA]
004040a9  mov al, [esi]              ; get char
004040ab  test al, al                ; end of string?
004040ad  jnz short 0x4040a0
004040a0  cmp al, bl                 ; hit delimiter?
004040a2  jz short 0x4040af
004040a4  push esi / call CharNextA  ; advance
004040a7  mov esi, eax
;     loop until NUL or delimiter found

; --- Skip spaces after program name ---
004040af  push esi / call CharNextA  ; skip delimiter
004040b2  mov ebx, eax               ; ebx = start of arguments
004040bf  cmp byte [ebx], 0x20       ; skip leading spaces
004040c2  jz short 0x4040ba          ; (loop via CharNextA)

; --- Check /S flag (silent) ---
004040c4  cmp byte [ebx], 0x2f       ; starts with '/'?
004040c7  jnz short 0x404114         ; no → skip flag parsing
004040c9  inc ebx                    ; skip '/'
004040ca  cmp byte [ebx], 0x53       ; 'S'?
004040cd  jnz short 0x4040de
004040cf  mov al, [ebx+1]
004040d2  or al, 0x20                ; to lowercase
004040d4  cmp al, 0x20               ; next char is space or NUL?
004040d6  jnz short 0x4040de
004040d8  inc byte [0x422e90]        ; silent_flag = 1

; --- Check /NCRC flag ---
004040de  cmp dword [ebx], 0x4352434e  ; "NCRC" (little-endian)
004040e4  jnz short 0x4040f5
004040e6  mov al, [ebx+4]
004040e9  or al, 0x20                ; to lowercase
004040eb  cmp al, 0x20               ; followed by space/NUL?
004040ed  jnz short 0x4040f5
004040ef  inc byte [0x422e91]        ; ncrc_flag = 1
```

## Open Self-EXE and Get File Size (0x404114)

```asm
; --- Copy caption string, get module info ---
00404114  push 0x4091e0 / push 0x42c3c0
0040411e  call lstrcpyA               ; copy "NSIS Error" caption
00404125  call GetModuleHandleA(0)    ; get HINSTANCE
0040412c  mov [0x425358], eax

; --- GetModuleFileNameA → get path of running EXE ---
00404131  push [0x40929c]             ; max path len
00404137  push eax                    ; hModule
00404138  call GetModuleFileNameA

; --- Open the EXE file for reading ---
0040413e  push 0x3                    ; OPEN_EXISTING
00404140  push 0x80000000             ; GENERIC_READ
00404145  push [0x40929c]             ; filename buf
0040414b  call CreateFileA wrapper
00404150  cmp eax, -1                 ; INVALID_HANDLE_VALUE?
00404153  mov [0x42cbd4], eax         ; save handle
00404158  jnz short 0x40417b          ; ok → continue
0040415a  mov [0x422030], 0x40919c    ; error: "can't open self"
00404164  jmp error_exit

; --- CharPrevA walk to find directory separator (backslash) ---
0040417b  push [0x40929c]
00404181  call 0x406663               ; find_dir_separator

; --- Get file size ---
00404186  push 0x0                    ; lpFileSizeHigh = NULL
00404188  push [0x42cbd4]             ; handle
0040418e  call GetFileSize
00404194  mov esi, eax                ; esi = file_size (remaining bytes)
00404196  mov [0x42cbcc], eax         ; save file_size
0040419b  test esi, esi
0040419d  jle 0x4042df               ; empty file → skip to end
```

## Main CRC Loop (0x4041A3)

```asm
; --- Init ---
004041a3  mov ebp, 0x422e98           ; msg struct for PeekMessage
004041a8  mov eax, 0x200              ; 512 bytes per chunk

; --- Determine chunk size: edi = min(esi, 512) ---
004041ad  mov edi, esi
004041af  cmp esi, eax
004041b1  jbe short 0x4041b5
004041b3  mov edi, eax                ; edi = 512

; --- Read chunk from file ---
004041b5  push edi                    ; nBytesToRead
004041b6  push 0x422038               ; lpBuffer
004041bb  call ReadFile_wrapper(buf, len) ; returns 1 on success
004041c0  test eax, eax
004041c2  jz 0x4042bc                 ; read error → exit

; === FIRST TIME: Search for NSIS overlay header ===
004041c8  cmp dword [0x42cbc4], 0     ; overlay already found?
004041cf  jnz short 0x404234          ; yes → skip to progress/CRC

; --- Search this chunk for NSIS firstheader signature ---
004041d1  push 0x422038
004041d6  call find_header(buf)       ; returns length_of_all_following_data, or 0
004041db  test eax, eax
004041dd  jz 0x404271                 ; not found in this chunk → CRC & continue

; === HEADER FOUND ===
; eax = firstheader.length_of_all_following_data
; [0x42cbc0] = current file offset (before this chunk was counted)

004041e3  mov ecx, [0x42cbc0]
004041e9  cmp eax, esi                ; data_len > remaining file?
004041eb  mov [0x42cbc4], ecx         ; overlay_pos = current file offset
004041f1  jg 0x4042f9                 ; corrupt: data extends past file → error

; --- Check firstheader flags byte ---
004041f7  mov cl, [0x422038]          ; flags = first byte of overlay
004041fd  test cl, 0x4                ; FH_FLAGS_SILENT?
00404200  jz short 0x404208
00404202  inc byte [0x422e90]         ; force silent mode

; --- /NCRC handling ---
00404208  cmp byte [0x422e91], 0      ; /NCRC flag set?
0040420f  jz short 0x40421a           ; no → check CRC flag
00404211  test cl, 0x8                ; FH_FLAGS_FORCE_CRC?
00404214  jz 0x4042df                 ; no force-CRC → SKIP CRC entirely!

; --- Check if CRC is present in file ---
0040421a  test cl, 0x1                ; FH_FLAGS_CRC?
0040421d  jz 0x4042df                 ; no CRC in file → skip

; --- Enable CRC checking ---
00404223  inc byte [0x422238]         ; crc_enabled = 1
00404229  lea esi, [eax-4]            ; remaining = data_len - 4 (exclude stored CRC)
0040422c  cmp edi, esi                ; current chunk larger than remaining?
0040422e  jbe short 0x404271          ; no → CRC this full chunk
00404230  mov edi, esi                ; yes → truncate to remaining
00404232  jmp short 0x404271

; === SUBSEQUENT CHUNKS (overlay already found) ===
00404234  cmp byte [0x422e90], 0      ; silent mode?
0040423b  jnz short 0x404271          ; yes → skip progress UI

; --- Progress dialog: show after 1 second ---
0040423d  cmp dword [0x422688], 0     ; dialog already created?
00404244  jnz short 0x4042a8          ; yes → pump messages
00404246  call GetTickCount
0040424c  cmp eax, [esp+0x14]         ; past deadline?
00404250  jbe short 0x404271          ; no → skip
00404252  ...                         ; CreateDialogParamA (verifying progress)
0040426c  mov [0x422688], eax

; === CRC COMPUTATION ===
00404271  cmp esi, [0x42cbcc]         ; remaining >= file_size? (pre-overlay)
00404277  jge short 0x40428f          ; yes → don't CRC yet (haven't found header)
00404279  push edi                    ; len
0040427a  push 0x422038               ; buf
0040427f  push [0x422640]             ; running_crc
00404285  call CRC32(crc, buf, len)
0040428a  mov [0x422640], eax         ; update running_crc

; --- Advance counters ---
0040428f  add [0x42cbc0], edi         ; bytes_read += chunk_size
00404295  sub esi, edi                ; remaining -= chunk_size
00404297  test esi, esi
00404299  jg 0x4041a8                 ; more to read → loop
0040429f  jmp short 0x4042df          ; done → verify CRC

; --- Message pump for progress dialog ---
004042a8  ... PeekMessageA / DispatchMessageA loop ...
004042ba  jmp short 0x404271          ; back to CRC
```

## CRC Verification (0x4042DF)

```asm
; --- Destroy progress dialog if exists ---
004042df  mov eax, [0x422688]
004042e4  xor esi, esi
004042e8  jz short 0x4042f1
004042ea  push eax / call DestroyWindow

; --- Was overlay ever found? ---
004042f1  cmp [0x42cbc4], esi         ; overlay_pos == 0?
004042f7  jnz short 0x404308          ; found → verify CRC

; --- Overlay not found → error ---
004042f9  mov [0x422030], 0x4090d0    ; "Installer corrupted or incomplete..."
00404303  jmp error_exit

; === CRC COMPARISON ===
00404308  cmp byte [0x422238], 0      ; crc_enabled?
0040430f  jz short 0x404338           ; no → skip CRC check

; --- Seek to position after CRC'd data (where stored CRC is) ---
00404311  push esi                    ; 0 = FILE_BEGIN
00404312  push [0x42cbc0]             ; offset = total bytes CRC'd
00404318  call SetFilePointer(handle, offset, FILE_BEGIN)

; --- Read 4-byte stored CRC ---
0040431d  lea eax, [esp+0x14]         ; local var for stored CRC
00404321  push 0x4                    ; read 4 bytes
00404323  push eax                    ; into local
00404324  call ReadFile_wrapper
00404329  test eax, eax
0040432b  jz short 0x4042f9           ; read failed → error

; --- Compare accumulated CRC with stored CRC ---
0040432d  mov eax, [0x422640]         ; running_crc (accumulated)
00404332  cmp eax, [esp+0x14]         ; vs stored CRC from file
00404336  jnz short 0x4042f9          ; MISMATCH → "Installer corrupted" error

; === CRC PASSED (or skipped) — Load NSIS header ===
00404338  push esi                    ; 0 = FILE_BEGIN
00404339  push [0x42cbc4]             ; seek to overlay_pos
0040433f  call SetFilePointer
00404344  call load_nsis_header       ; parse firstheader + decompress
00404349  cmp eax, esi                ; 0 = success?
0040434b  mov [0x422030], eax
00404350  jnz error_exit
```

## CRC32 Function (0x402209)

Signature: `CRC32(crc, buf, len)` — stdcall, 3 args, returns updated CRC.
Standard CRC32 with polynomial 0xEDB88320, init=~crc, final=~result.

```asm
; --- Build lookup table on first call ---
00402209  cmp dword [0x40a6bc], 0     ; table built?
00402211  jnz short 0x402240          ; yes → skip
00402213  xor ecx, ecx               ; i = 0
00402215  push 0x8
00402217  mov eax, ecx               ; crc = i
00402219  pop esi                    ; j = 8
; --- inner loop: 8 iterations per byte value ---
0040221a  mov edx, eax
0040221c  and dl, 1                  ; test LSB
0040221f  neg dl                     ; CF = (was bit set)
00402221  sbb edx, edx              ; edx = bit_set ? -1 : 0
00402223  and edx, 0xedb88320       ; edx = bit_set ? POLY : 0
00402229  shr eax, 1                ; crc >>= 1
0040222b  xor eax, edx              ; crc ^= (bit_set ? POLY : 0)
0040222d  dec esi
0040222e  jnz short 0x40221a        ; 8 iterations
00402230  mov [0x40a6b8+ecx*4], eax  ; table[i] = crc
00402237  inc ecx
00402238  cmp ecx, 0x100
0040223e  jl short 0x402215          ; next i

; --- Main CRC computation ---
00402240  mov edx, [esp+0x10]        ; edx = len
00402244  mov eax, [esp+0x8]         ; eax = crc_in
00402248  test edx, edx              ; len == 0?
0040224a  not eax                    ; eax = ~crc_in
0040224c  jbe short 0x402271         ; len == 0 → return ~eax
0040224e  mov ecx, [esp+0xc]         ; ecx = buf ptr
00402252  push edi

; --- Per-byte CRC loop (table-based) ---
00402253  movzx edi, byte [ecx]      ; edi = *buf
00402256  mov esi, eax
00402258  and esi, 0xff              ; esi = crc & 0xFF
0040225e  xor esi, edi               ; esi = (crc ^ byte) & 0xFF = table index
00402260  shr eax, 0x8               ; crc >>= 8
00402263  mov esi, [0x40a6b8+esi*4]  ; esi = table[index]
0040226a  xor eax, esi               ; crc = (crc >> 8) ^ table[index]
0040226c  inc ecx                    ; buf++
0040226d  dec edx                    ; len--
0040226e  jnz short 0x402253         ; loop

00402270  pop edi
00402271  not eax                    ; return ~crc
00402273  pop esi
00402274  ret 0xc                    ; stdcall 3 args
```

## Firstheader Parser (0x403CCF)

Signature: `find_header(buf)` — stdcall, 1 arg. Returns `length_of_all_following_data` or 0.

```asm
00403ccf  mov eax, [esp+4]           ; eax = buf
00403cd3  test [eax], 0xfffffff0     ; flags & 0xF0 must be 0 (only low nibble used)
00403cd9  jnz short 0x403d04         ; fail
00403cdb  cmp [eax+4], 0xdeadbeef    ; siginfo magic
00403ce2  jnz short 0x403d04         ; fail
00403ce4  cmp [eax+0x10], 0x74736e49 ; "Inst"
00403ceb  jnz short 0x403d04
00403ced  cmp [eax+0x0c], 0x74666f73 ; "soft"
00403cf4  jnz short 0x403d04
00403cf6  cmp [eax+0x08], 0x6c6c754e ; "Null"
00403cfd  jnz short 0x403d04
00403cff  mov eax, [eax+0x18]        ; return firstheader.length_of_all_following_data
00403d02  jmp short 0x403d06
00403d04  xor eax, eax               ; return 0 (not found)
00403d06  ret 4
```

### NSIS Firstheader Layout (28 bytes at overlay start)

```
Offset  Size  Field
0x00    4     flags (FH_FLAGS_CRC=0x1, FH_FLAGS_SILENT=0x4, FH_FLAGS_FORCE_CRC=0x8)
0x04    4     siginfo = 0xDEADBEEF
0x08    12    magic = "NullsoftInst"
0x14    4     length_of_header (compressed header size)
0x18    4     length_of_all_following_data (everything after firstheader)
```

## CRC Algorithm Summary

1. File is read from offset 0 in 512-byte chunks
2. Each chunk is scanned for the NSIS firstheader signature (0xDEADBEEF + "NullsoftInst")
3. Once found, `remaining = length_of_all_following_data - 4` (exclude stored CRC)
4. CRC32 is accumulated **only** over overlay data (NOT the PE stub before it)
5. Total CRC'd = `length_of_all_following_data - 4` bytes (starting from the overlay chunk)
6. Stored CRC is at file offset `overlay_pos + length_of_all_following_data - 4`
7. Standard CRC32 (polynomial 0xEDB88320, init=0, chained per-chunk)
8. Comparison: `accumulated_crc == stored_4_bytes` (NOT checking for zero)

### /NCRC Flag

- Command line is parsed for `/NCRC` (case-sensitive "NCRC", followed by space or NUL)
- If `/NCRC` and the header does NOT have `FH_FLAGS_FORCE_CRC` (bit 3), CRC check is skipped entirely
- The skip happens at `0x404208-0x404214`: jumps to `0x4042DF` (post-CRC) without setting `crc_enabled`

### Important Detail: CRC is only computed AFTER overlay is found

The check at `0x404271`: `cmp esi, [0x42cbcc]` — when `esi >= file_size` (meaning we haven't found the overlay yet and are still decrementing from the original file_size), the CRC call is **skipped**. CRC only starts accumulating once `esi` has been reset to `data_len - 4` at `0x404229`, which is always less than file_size.

**This means: CRC does NOT cover the PE stub. It only covers the NSIS overlay data (minus last 4 bytes).**

Total CRC'd bytes = `length_of_all_following_data - 4` (NOT `file_size - 4`).
Stored CRC is at file offset `overlay_pos + length_of_all_following_data - 4`.
For typical NSIS installers where overlay extends to EOF, this equals `file_size - 4`.

### Verified

Both `Winamp291.exe` and `winamp295.exe` have **valid** CRC32 values when computed this way. The files are NOT corrupted — earlier failed checks were using the wrong byte range (including the PE stub).
