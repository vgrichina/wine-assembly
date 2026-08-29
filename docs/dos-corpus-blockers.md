# DOS corpus: what is still not drawing, and why

The 199-program demo corpus in `/tmp/demos` is swept with

```bash
node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=SHOTS --rows=ROWS --list > list.txt
SECS=1500 xargs -P 4 -L 1 tools/toyvm/capture-one.sh < list.txt
node tools/toyvm/shot-sweep.js --merge=ROWS --json=OUT.json
node tools/toyvm/demo-status.js OUT.json [OLD.json]        # prints the moved(N) diff
```

One row file per program, so re-taking a single flaked row is cheap and a killed
sweep resumes losing nothing.

This file is the work list: one entry per program that still does not show what
it meant to, with the *measured* cause rather than a guess. Read the entry
before starting on one — several of these have already cost a session each, and
two of them are not bugs at all.

## Not work items

**001.EXE / 002.EXE** print `Type CYANIDE to run this demo.` and `Please run
CYANIDE.EXE.` They are launcher stubs telling the truth; CYANIDE.EXE itself
runs. Nothing to fix.

**rage.exe / CULT.EXE** print `GUS not found!` and `Do YOU have a sound card
Called Gravis Ultra Sound? Well that's your problem! Not mine!` Both probe the
GF1 ports directly rather than reading `ULTRASND=`, so the per-program GUS
environment rung in `shot-sweep.js` cannot reach them and no environment string
makes the answer false. Emulating a GF1 is the only fix, and it is a large one
for two demos that are working correctly as written.

## Real work items

### ANGEL.EXE + its SETUP.EXE (2 rows)

ANGEL prints `Please run setup.exe on your computer ! The demo can't run
without this !` The check is exact and cheap to watch:

```
int 21h ax=3d00 dx=7d4 -> ax=7          ; open drivers.vga
int 21h ax=4202 bx=7 cx=ffff dx=fff4    ; LSEEK from END, -12
int 21h ax=3fdc bx=7 cx=a  -> ax=a      ; read the last 10 of those 12 bytes
```

`DRIVERS.VGA` ships with the demo (7400 bytes) and its tail is
`00 c0 00 80 da 9a 95 1a 22 00 7d 3d` — not the stamp ANGEL wants. SETUP is
supposed to write it.

SETUP **runs to completion and exits(0)**, it just takes ~810M dispatches to do
it: `773:03a0`-`773:03f9` sweeps ES from C000 to F000 comparing a 995-byte
pattern table at `87f:135a` (`Paradise`, `Video Seven`, `Ati`, `Chips`,
`Genoa`, `Trident`, `Tseng`, `Acumos` … `UnKnow`) against ES:DI for DI in
0x20..0x300. Our C000-F000 is zeros, so every group misses and DL lands on
0x2d — the table's own `UnKnow` entry, which SETUP handles. It is not stuck and
it is not blocked on VESA: the one `int 10h AX=4F00` at `773:043d` is followed
by `cmp ax,0x4f / jnz`, so the no-VESA path is correct.

**It does not "run to completion" — it dies on a null pointer, and exits 0 on
the way out.** `773:0501` hooks INT 0Ah, sets CRTC register 0x11 to 0x90
(vertical-retrace interrupt enabled), waits twice and reads a flag its own
handler at `773:055b` would have set — a vertical-retrace IRQ probe we never
satisfy, since we do not raise IRQ2 for retrace. `773:056e` then sets mode 13h
and `773:0573` starts the VRAM sizing routine, which never finishes: no
`int 10h ax=0003` is ever traced, and that routine's every path ends at
`773:0604` `pop ds / pop es / mov ax,3 / int 10h / retf`.

Where it goes instead, from `--trace-entry` (mind that those lines are
*handbacks*, not consecutive blocks — many blocks run between two of them):

```
entry 773:573  ax=0013 ...      ; back from the mode-13h int
entry 773:0    ax=0000 ...      ; <-- offset zero
entry 110:15a  ...              ; unwound into the Turbo Pascal runtime
... 110:1fa/205/210/21b          ; restore INT 00/04/05/06
... int 21h ax=4c00              ; Halt(0)
```

`773:0000` is a segment header (`10 01 59 c9 cb …`, the `10 01` being the load
segment) followed by a CPU-type probe. Executing it happens to `retf`, which is
why this unwinds quietly instead of crashing.

It arrives there through an indirect dispatch. `773:0583` calls the installer at
`773:0b44`, and `773:05a7` calls the trampoline at `773:0b5a`:

```
773:0b44  mov ax,[0x1e02]   ; chipset index      773:0b5a  mov dx,0xb63
          shl ax,1                                         push dx      ; return
          mov si,0x20b0     ; routine table                mov dx,[0x1e0c]
          add si,ax                                        push dx
          mov ax,[si]                                      ret          ; jump
          mov [0x1e0c],ax   ; install
```

Both measured with DS=`0x87f`: `[87f:1e02]` is **0**, and the table's slot 0 at
`87f:20b0` is **`00 00`** (slot 6 is the only other null; 1-5 and 7+ are real
offsets `0b64`, `0b66`, `0b68`, `0b6a`, `0cf4`, `0bc5` …). So the installed
bank-switch routine is the null pointer, the `ret` jumps to offset 0, and the
sizing loop takes the program out through offset zero on its first iteration.

The whole chain, each link measured:

```
3c9:1734   the chipset detection routine        -> leaves [87f:2448] = 0000
3c9:37f3   mov ax,[0x2448] / mov [0x256e],ax    -> [87f:256e] = 0000
773:057a   mov ax,[0x256e] / mov [0x1e02],ax    -> [87f:1e02] = 0000
773:0b44   [0x1e0c] = word[0x20b0 + 2*0]        -> slot 0 is 00 00
773:0b5a   push/push/ret through [0x1e0c]       -> jumps to offset 0
```

`3c9:37f0` (`e8 41 df`) calls only one vendor probe — `3c9:1734`, a
Paradise/WD unlock test that saves port 0x3BF, writes 3 then 0xAC to it and
reads sequencer index 6 through 0x3C4, setting flag `[87f:00d9]` and always
returning AL=0. The id itself is written by a large classification function
around `3c9:32b0`-`3c9:36a0`, which assigns `[0x2448]` values 1-4, 7, 9-0x13,
0x4f-0x58 and the negatives 0xffa8 and 0xfff4. Negative ids are legal: `773:07d9`
negates `[0x1e02]` *in place* before indexing, so `773:0b44` afterwards sees the
positive value.

**Zero is a value that function writes on purpose**, at `3c9:3460`:
`cmp byte [0xc4],0 / jz +0x1a / mov word [0x2448],0` — so the store happens when
flag `[87f:00c4]` is nonzero. That is the thread to pull: which probe sets
`[87f:00c4]`, and what it reads off our VGA that a real one answers differently.
Note also that a real plain-VGA machine reaching index 0 would jump through the
same null, so SETUP is not expected to see 0 — it is expected to classify
*something*, which makes this a question about what our ports return rather than
about SETUP's error handling.

The C000-F000 sweep landing on the table's own `UnKnow` entry (DL=0x2d) is a
separate thing and not this value — 0x2d would index a live slot well past the
nulls.

To find these: `--dump=0100:0000:98304` covers the entire loaded image in one
go, and grepping the hexdump for the operand bytes (`6e 25` for `[0x256e]`)
finds both the reader and the writer. Two hits, one of them the trampoline. The
dump's offsets are linear from `0100:0000`, so `linear = 0x1000 + offset` and
any segment's offset is `linear - (seg << 4)`.

Two things ruled out along the way. `SETUP /NOBANKS`, which the NFO offers for
exactly this ("we don't recognise correctly your video chip"), changes nothing —
and the command tail does reach the guest, `100:0080` reading
`09 20 2f 4e 4f 42 41 4e 4b 53 0d`, so that is SETUP ignoring the switch on this
path rather than our harness dropping it. `/REPORT` likewise writes no
`DEBUGNFO.DAT`. And `int 10h AH=1A` is answered correctly (AL=0x1A, BL=0x08,
VGA colour); the 0x08 visible at `87f:1e07` is that answer landing.

Note that any fix which puts a vendor signature at C000 claims chipset registers
we do not emulate — the same mistake as a default `BLASTER=`/`ULTRASND=` — so it
must be measured over a full sweep before it is kept. **Reading `[87f:256e]`'s
writer is the cheaper route and does not claim any hardware.**

One trap this cost an hour: **segment 773 is a Turbo Pascal overlay, and
`--disasm` fires at exit.** Disassembling `773:0573` mid-run and at exit happens
to agree here, but the code at other 773 offsets does not, and a confident
reading of the wrong overlay is indistinguishable from a reading of the right
one.

The `--pre=SETUP.EXE` rung in `shot-sweep.js` already runs SETUP before ANGEL
and carries its `tempFiles` across, so a SETUP that writes the stamp lands both
rows with no further harness work.

### BLINKY.EXE — fixed

Two bugs stacked, and each hid the next.

**1. An unobservable single-step trap per instruction.** BLINKY sets TF and
never hooks INT 1, so every instruction owed a debug exception that pushed a
frame and IRETed back with nothing changed — a compile and a handback each. 180
seconds bought it 7,067,597 traps and 7% of the wall clock in wasm. Fixed in
`810b87a9` by testing the INT 1 vector before honouring TF: a protector hooks
INT 1 *before* it raises TF, so the vector is the honest test of whether the
trap is observable. It now runs at 26M dispatches/s.

**2. Mode 13h loaded no palette.** `Machine.palette` was 768 zero bytes that
only a program setting its own colours ever wrote, so BLINKY — which draws in
the default DAC the BIOS is supposed to leave behind — filled the screen with
non-zero indices that all mapped to black. Fixed in `03a39be7`.

It now renders its wireframe vector intro (`Our First Intro!!`) and **runs to
completion, exiting 0** at ~660M dispatches.

Three things this cost a session to learn, all worth keeping:

* **A black PNG is two different bugs.** "N non-black pixels" counts non-zero
  *indices*; an index is only a colour after the DAC. The exit line now reports
  `dac N/256 entries set; frame uses N index(es), N pixel(s) through a black
  entry` for 8bpp, which separates them at a glance. The 4bpp `attr palette`
  line always answered this one level down; there was no 13h equivalent.
* **`--auto-key` can be worse than one key.** With `--auto-key` BLINKY wrecked
  itself at ~305M dispatches and parked at `110:135d`; with `--keys=a` it runs
  clean to exit. The extra keys are consumed somewhere they should not be —
  BLINKY takes exactly one `int 16h ah=0`, at `110:2b92`.
* **`--disasm` and `--dump` fire at exit.** Disassembling `110:3640` at the end
  showed a tidy `call far 0x5f6:0x2fd / or al,al / jnz` and segment `5f6` full
  of zeros; both were pictures of the wreckage and the exact opposite of the
  truth at the fault. Bisect with `--dispatches=N` and dump there instead.

Two leads that looked strong and were wrong, recorded so they are not re-run:
the copier at `110:40af` running with `DS=0110` instead of DGROUP `0b05` is
*correct* — `DS:0x486d` is linear `0x596D` and `0x5970` is `5f6:0000`, so it is
addressing that segment through the load segment on purpose and overwriting the
code there is the point. And the word table at `110:3b00` (`e4 00 d8 00 cb 00
c0 00 …` — 228, 216, 203, 192, each ~1.059x the next) is a chromatic
PC-speaker divisor table, not a copy-range table.

### BLIQ.EXE (2 rows — `1994-b-bliq` and `1994-b-black` are the same program)

Reaches mode 13h **unchained** (Mode X, 202,978 planar writes, display start
32000) and uses EMS (398 page maps), then prints:

```
MIDAS Error: Out of conventional memory
Runtime error 200 at CB90:0067.
[ERROR]: Executing internal subfile...
```

The allocation map at the failure (`--trace-int` prints it on every refusal) is
unambiguous and shows no fragmentation:

```
alloc 38 refused; top=9f00 free=[]
held=[1cd+39 206+37 23d+40 27d+37 2b4+12a5 163c+38 1674+2d89
      43fd+39 4436+2289 66bf+39 66f8+3808]  (all @100)
```

The four big blocks are 76KB, 186KB, 138KB and 229KB — ~629KB, the whole pool.
The program asked for 0x4c79 paragraphs (312KB), was refused, read the largest
free block out of BX and took all 229KB of it, and then MIDAS wanted 896 bytes
more. `xms 0 block(s)`: it never touched extended memory, so the 8MB we offer
is not the lever. A self-extracting loader EXECs the real demo (child PSP
0x1674) and the child's blocks are released correctly on exit, so this is not a
leak in EXEC either. Open question is whether real DOS reaches the same wall —
it has *less* conventional memory than we offer, not more, so the arithmetic
does not obviously work out, and the order in which MIDAS initialises relative
to the big grabs is worth checking before touching the allocator.

`Runtime error 200` is Borland's CRT delay-calibration divide fault. The clock
is `dispatched / 550e3` BIOS ticks (`--dispatches-per-tick`), i.e. ~10M
dispatches per guest second; that knob is the A/B if the RTE turns out to be a
cause rather than a consequence of the MIDAS failure.

### JULTRO.EXE, INTRO.EXE (`1995-c-cda_tp5i`)

32-bit protected-mode code the decoder will not read. JULTRO takes zero
interrupts and stops at `5ab:6e` with `eb fa dc 33 c0 8e d8 89`; the decoder
also gives up at `5ab:56` on `f5 81 c6 c9 00 b9 63 01`. INT 1/3/21h hooking and
the single-step path (`dos-loop.js`) were added for this program and did move it
along, but it is still short of its own decryptor.

### BLIQ's neighbours in the blank bucket

**AQUAPHOB.EXE** prints `DPMI v0.90 - Paging:1 RM:1 CPU:80386` — its own
extender's banner. We implement no DPMI (INT 31h) and answer INT 2Fh AX=1687
with "not present". A DPMI host is a large piece of work for one demo.

**BLAND.EXE** answers both its menus and then prints `failed to load MSE`. The
MSE file is read fully (0x28be, the exact file size, correct EOF), loads, hooks
IRQ vectors 0x0A/0x0D/0x0F/0x72 and unhooks them, and issues exactly one DSP
command. All six device choices and all three `--sound` settings behave
identically. The failure is inside MIDAS's own loader at `231:119`, which
returns nonzero to `110:12d`.
