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

What it does next is the open question. `773:0501` hooks INT 0Ah, sets CRTC
register 0x11 to 0x90 (vertical-retrace interrupt enabled), waits twice and
reads a flag its own handler at `773:055b` would have set — a vertical-retrace
IRQ probe. We never raise IRQ2 for retrace, so the flag stays 0. Then
`773:056e` sets mode 13h and `773:0589`-`773:05e5` sizes VRAM by writing a
`bx+0x1001` pattern into bank `bx` through a bank-switch call at `773:068a` and
checking whether bank 0 still reads zero. With no chipset there is no bank
switching, bank 0 aliases immediately, and it correctly concludes plain VGA.
And then main returns: no INT 16h, no INT 33h, no file ever opened, exit code 0.

So SETUP decides not to write DRIVERS.VGA. Whether that is the retrace probe,
the unknown chipset, or something between has not been established. Note that
any fix which puts a vendor signature at C000 claims chipset registers we do not
emulate — the same mistake as a default `BLASTER=`/`ULTRASND=` — so it must be
measured over a full sweep before it is kept.

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
