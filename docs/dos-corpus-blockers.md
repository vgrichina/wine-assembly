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

### BLINKY.EXE

Turbo Pascal, sound-device menu (`a` PC Speaker / `h` Sound Blaster / `p` No
sound); all three choices behave identically, so the menu is not the issue.

It used to look like a hang. It was not: BLINKY sets TF and never hooks INT 1,
and delivering an unobservable debug exception per instruction cost a compile
and a handback each — 180 seconds bought it 7,067,597 traps and 7% of the wall
clock in wasm. Fixed in `810b87a9`; it now runs at 26M dispatches/s, loads
`music.dat` and gets to `int 21h AH=35 AL=08` (get the timer vector, i.e. the
music player installing itself).

Where it stops now: `stuck at 110:135d`, and the decoder gives up there on
`c5 c0 bc be 0c d8 96 02` (`c5 c0` is `lds` with mod=11, invalid). There is also
one unhandled `int 3` in the run.

The bytes on disk at that address are different (`14 b2 3b d9`), which is *not*
a clue: BLINKY.EXE is PKLITE-compressed, so nothing at 110:xxxx on disk is the
code that runs, and the 127 self-modify breaks are the depacker. PKLITE itself
is fine — B-STEEL, AMANAMAN, DIZZY_FI and AKM-ZORL are all PKLITE-packed and all
reach full frames — so this is specific to BLINKY.

The last thing traced before the stop is `int 21h AH=35 AL=08` from `110:3d70`,
the music player fetching the old timer vector; the matching `AH=25` never
happens.

`--trace-entry=2000` (which prints the *first* N handbacks, not every Nth —
BLINKY only has 936, so that is all of them) gives the whole transfer:

```
entry 110:40af  x107 ...      ; a table-driven byte-range copier
entry 110:4099  ax=f018 bx=e3c0 cx=103d  ss:sp=0b86:8166
entry 998:04df  ax=0000 bx=e3c0 cx=103d  ss:sp=0b86:8158
entry 110:3640  ax=0032 bx=e3c0 cx=9046  ss:sp=0b86:815e
entry 5f6:02fd  ax=0032                  ss:sp=0b86:815a
entry 888:04df  ax=0004                  ss:sp=0b86:8154
entry 110:1346  ax=0000 bx=f706 cx=1346  ss:sp=0b86:0b4a
entry 110:135d  ax=ffff ...              (x202, stuck)
```

`998:04df` is Turbo Pascal's stack-overflow check — `add ax,0x200 / jb / sub
ax,sp / jnb / neg ax / cmp ax,[0x284] / jb / retf`, the guard TP emits at every
procedure entry. It runs correctly and `retf`s. **The address it returns to,
`110:3640`, is zeros for the entire run** (checked at 10M, 100M, 250M and
304.6M). Everything after is a runaway: `888:04df` is that same stack check
called with an unrelocated segment (`0x998 - 0x888 = 0x110`, exactly the load
segment), and the wild execution ends parked at `110:135d`.

**The copier at `110:40af` is not the bug, and neither is DS.** It is an
overlay swapper, and two hypotheses died on that:

* *"It runs with the wrong data segment."* A DS census over all 936 entries is
  455 `ds=0b05` against 449 `ds=0110`, and `0b05` is DGROUP, so `0110` looked
  like a dropped segment restore. It is not: with `DS=0110` the destination
  `si=0x486d` (set at `110:4092`) is linear `0x596D`, and `0x5970` is exactly
  `5f6:0000` — the copier is addressing segment `5f6` through the load segment
  on purpose. Writing over that code is the *point*.
* *"The source is garbage."* The source range (`bx=0xe3c0 cx=0x103d` on the
  last entry) holds a recognisable
  variant of the code being replaced — live `5f6:2c0` is
  `4b 75 fd 26 3a 05 e1 f5 c3 … b8 dd 34 ba 12 00 3b d3 73 1a`, source
  `110:e3ca` is `4b 75 fd 54 e1 f5 c3 … b8 dd 34 ba 12 00 3b d3 73 1a`. Same
  routine, different build. That is a second copy of the sound module, i.e. the
  swap is loading the variant the chosen device wants.

So the swap is intended and its inputs are plausible; what is not yet
established is whether it *completes*. The observed end state — `5f6` zeroed
from `0x5970` for 5968 bytes — is consistent with a copy whose source had
already scrolled off into zeros, which points at whatever picks the range
rather than at the byte loop itself.

One thing that read as a lead and is not: the word table at `110:3b00` is
`e4 00 d8 00 cb 00 c0 00 b5 00 ab 00 …` — 228, 216, 203, 192, 181, 171, 161,
152, 144, 136, 128, 121, 114, each ~1.059× the next. That is a chromatic
PC-speaker divisor table, i.e. music data, not a copy-range table.

And the thing worth knowing before spending another session here: **at 290M
dispatches, before any corruption, BLINKY is healthy and still in text mode** —
`cs:ip=5f6:2c0` (inside the speaker player), 368 of 2000 cells non-blank, 0 of
64000 pixels drawn. It sits on its own menu playing music and never switches to
a graphics mode, with `--auto-key` and with each device chosen explicitly. So
the 304M wreck is downstream of whatever keeps it on that menu, and the menu is
the thing to explain first.

Two traps that cost time here, both worth remembering:

* **`--disasm` and `--dump` fire at exit.** Disassembling `110:3640` at the end
  shows a tidy `call far 0x5f6:0x2fd / or al,al / jnz` and segment `5f6` shows
  zeros; both are pictures of the wreckage, and both are the exact opposite of
  the truth at the moment of the fault. Bisect with `--dispatches=N` and dump
  there instead — `5f6` holds live PC-speaker code until 304.6M and is zeroed
  by 304.9M.
* **`int 3` at `110:40e0` is not a clue.** It sits immediately before a `ret`,
  DOS's default INT 3 vector is an IRET, and our unhandled-vector path does the
  same thing, so it is a slow no-op on both.

It is not the code cache: `--no-cache` and `--smc-flush` both reproduce the
identical stop at `110:135d` after the identical 305.0M dispatches, so the 127
self-modify breaks are not being mishandled.

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
