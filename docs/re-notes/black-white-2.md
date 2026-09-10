# Black & White 2 demo

## Input and extraction (2026-09-09)

`test/binaries/win98-games-a-d/Black and White 2-DX9-D3D.exe` is the
647,216,200-byte Black & White **2 demo** InstallShield 11 self-extractor.
It is not the original Black & White game.

The outer payload starts at file offset `0x1c200`. Each entry is four
NUL-terminated ASCII fields (basename, `Disk1\\...` path, version, decimal
byte length), immediately followed by exactly that many uncompressed bytes.
Walking nine entries ends exactly at EOF. Measured with `xxd` and a bounded
field walker against the input, not guessed from cabinet signatures:

| Entry | Data offset | Bytes |
|---|---:|---:|
| data1.cab | 115243 | 36286822 |
| data1.hdr | 36402105 | 58374 |
| data2.cab | 36460523 | 609467787 |
| engine32.cab | 645928357 | 543481 |
| layout.bin | 646471878 | 559 |
| setup.exe | 646472483 | 121064 |
| setup.ibt | 646593588 | 395955 |
| setup.ini | 646989581 | 480 |
| setup.inx | 646990102 | 226098 |

`unshield l data1.cab` lists 416 files when its matching header is beside it.
Extraction also needs **data2.cab**. Earlier `/private/tmp/black-white-seed2`
emulator overlay contains data1.cab/hdr but **omits data2.cab**; it is therefore
not a complete installation source. `7z` cannot open the outer EXE.

The game EXE is `MainApp/BW2Demo.exe`, 20,656,128 bytes. The largest asset is
`MainApp/Data/Everything.stuff`, 432,577,472 bytes. Other file groups provide
English speech/text, splash textures, credits and the readme. DirectX support
includes `Apr2005_d3dx9_25_x86.cab`. Inspect actual imports with:

```
node tools/pe-imports.js PATH/MainApp/BW2Demo.exe --all
```

## Installer investigation

The direct extracted setup needs all three runner arguments:

```
--exe=PATH/setup.exe
--exe-guest-path=c:\windows\temp\byep1.tmp\disk1\setup.exe
--cwd=c:\windows\temp\byep1.tmp\disk1
--args=-deleter
```

Use `--quiet-api --quiet-blocks`. Positional EXE arguments are ignored by the
runner; omitting the guest path searches for engine32.cab in the wrong place.
Dialog control sequence: wait 710, click 1; wait 1000, click 1000 and 1;
wait 718, click 1; wait 711, click 1 (Install).

Loading `isprobe.tlb` imports stdole2. Registering and mounting its raw MSFT
type-library data removes the measured `TYPE_E_CANTLOADLIBRARY 0x80029C4A`.
This does **not** establish installer success. The following failure jumps
through zero at iuser original VA `0x10001d7c`: an AddRef indirect call where
EDI points to ASCII GUID-path data, not an object. Runtime iuser base in these
runs is `0x01d2f000`, original base `0x10000000`.

`iuser+0x10003391` receives the pointer and forwards it via `0x100010cb` to
the AddRef helper `0x10001d6f`. Cause is still unproved: argument marshalling,
pointer lifetime and unsupported COM behavior remain possibilities. Earlier
claims that the Win98 OLEAUT library lacks these standard automation helpers
were speculative and must not be used as evidence for native overrides.

## Direct executable startup

The complete extraction is currently `/private/tmp/black-white-full.ntZDCF`.
`unshield -d extracted x data1.cab` succeeded for all 416 files. The DirectX
cabinet's `d3dx9_25.dll` was extracted beside `MainApp/BW2Demo.exe` with `7z e`.
Game launches use `--vfs-include='**/*'` and explicit `--dll-seed=` paths for
d3dx9_25.dll, binkw32.dll and dbghelp.dll; the ordinary DLL graph supplies CRT
dependencies. English supplemental groups have provisionally been copied
into MainApp's Data, Audio and Data/Art/Textures folders (verify filesystem
traces before treating these destinations as established).

The executable enters real startup code. CPU gaps observed, in sequence:

- `0x00b65de8`: **F3** 0F59, MULSS (not MULPS).
- `0x0040b656`: UCOMISS followed by LAHF and parity tests.
- `0x006013e0`: scalar division during startup object construction.

The runner's crash EIP can point **after an instruction prefix**. Always
disassemble from a known preceding instruction/function entry: disassembling
at reported EIP `0x00b65de9` falsely labels the opcode MULPS. ADDPS/MULPS were
already implemented in dc7bc157. Scalar arithmetic and UCOMISS are being added
with `test/test-sse-scalar.js`; no SSE feature bit is advertised yet.

The stale region-owner anchors were resolved by the shared integration lane.
Use paired current artifacts: `tools/build-compile-wat.js --out=...
--compat-out=...`, then `--no-build --wasm=...`; do not mistake an older
build/wine-assembly.wasm for current sources. No gameplay has been verified.

## Programmable renderer implementation

The direct game reaches a fatal pixel-shader 1.1 capability check after
creating its LIONHEAD window in the default profile. The experimental
`?d3d9-programmable` profile enables real shader/texture/buffer rendering after
a GPU pixel probe. No game patch or capability-only bypass is used.
See `apps/direct3d9.md` for the extension to the existing graphics design.

Real WAT shader objects/constants, guest texture mip storage/level surfaces,
vertex/index buffers, locking/binding/lifetime and programmable UP/buffer
draws now lower through the shared GPU backend. `test-d3d9-pipeline-web.js`
checks completed canonical BGRA frames, INDEX16 rebasing, INDEX32 above65535,
signed base-vertex offsets and locked/range rejection. These synthetic
rendering passes do not establish game menu or gameplay compatibility.

The genuine browser run with that profile gets past the shader check and
traps at `0x009343b4`: the following call at `0x009343c4` is
`[device-vtable+0xf4]`, **EndStateBlock** (slot61). Return address is
`0x009343ca`; device pointer `0x07f07030` in the measured run. The immediately
preceding sequence records render states via slot57 (`+0xe4`). Logs label
these COM thunks `<ord>`; disassemble the caller to identify the actual slot.
Selective render-state block recording/Capture/Apply is now implemented and
unit-tested; other recording categories fail explicitly until implemented.

Subsequent genuine browser runs advanced through these measured gaps:

- `0x0093459e`, slot69 `+0x114`: SetSamplerState during recording.
- `0x00934664`, slot65 `+0x104`: SetTexture during recording (initial null bindings).
- `0x0093468f`, slot44 `+0xb0`: SetTransform, texture matrices16..23.
- `0x00936a09`, slot22 `+0x58`: GetGammaRamp for implicit chain0.

Selective sampler, internally retained texture bindings and immutable matrix
copies now Capture/Apply without changing live state during recording. Tests
cover replacement/release, caller-memory reuse and independent matrix slots.
Gamma has copied per-device API data, with display capability still disabled.
The initial WORD ramp is0..255 per Microsoft's "Using gamma correction" note,
not0..65535; the game's following loop multiplies each WORD by255.
No menu or gameplay has yet been reached. Probe logs live under
`/private/tmp/black-white-*-probe.log`; the probe uses the genuine extracted
assets and only the opt-in real GPU capability profile.

Native D3DX then records vertex declarations at original`0x0051b0a1`
(`+0x15c`,slot87) and vertex float constants at`0x005121be`
(`+0x178`,slot94). Measured DLL base`0x02528000`, original`0x00400000`;
runtime failures`0x02643099`/`0x0263a1ac`. Declaration/shader references and
per-register float constant state blocks now have lifetime/overlap tests.

The next real failure was ReadFileEx at`0x00b532be`. It reads175104 bytes
from Everything.stuff offset102306304 into`0x4c550000`; OVERLAPPED at
`0x4fda0300`, callback`0x00b53100`. The callback uses hEvent as a private
context pointer, which must remain untouched. Positional VFS reads now preserve
the shared file cursor and queue completion on the calling WAT instance for
SleepEx/WaitForSingleObjectEx alertable delivery. Lazy residency currently parks
submission through existing IO_WAIT before queueing; this is not fully
asynchronous provider scheduling. Other APC/cancellation APIs remain unsupported.

First integration hung at`0x00938963` in the texture-loader polling loop.
Passive callback count stayed0 despite SleepEx(0,TRUE) and completed bytes.
Cause: inline CALL-reg dispatch overwrites redirected EIP unless steps=0;
handler_set_eip only protects the outer thunk-zone path. The APC continuation
now sets both, and test-read-file-ex includes an actual x86 CALL-reg regression
(the original direct-handler callback test did not exercise that path).

WIP checkpoint: the genuine browser run now advances beyond that callback to
native D3DX at runtime `0x025f6e12` (original `0x004cee12`), with `EDX=0x31545844`
(`DXT1`). This next texture-loading failure is not yet diagnosed. No menu or
gameplay has been verified.
