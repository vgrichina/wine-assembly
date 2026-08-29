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
makes the answer false. Measured on rage.exe: it sweeps all sixteen candidate
bases from 0x210 to 0x360 in steps of 0x10, writing the register-select/data
pair at `base+3`/`base+5` eleven times each — a GF1 DRAM peek-and-poke
autodetect, which only DRAM read-back semantics can satisfy. Emulating a GF1 is
the only fix, and it is a large one for two demos that are working correctly as
written: rage.exe says so itself (`requires GUS; buy one or miss this thing..`)
and exits 0.

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
handler at `773:055b` would have set — a vertical-retrace IRQ probe. **That one
is now satisfied** (be98db44): clearing bit 5 of CRTC 0x11 with vector 0x0A
hooked raises IRQ2, the handler runs and sets `[87f:18b0]`, so `773:0533`'s
`cmp word [0x18b0],0` falls through to `773:053a` and the detection result
`[87f:00e8]` is 1 where it used to be 0. It was not what stops SETUP, and the
dispatch count either side of the fix is identical — the chipset chain below is.
`773:056e` then sets mode 13h
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

**`[0x2448]` is never written at all. Zero is its initial value.** The branch
that looked like it wrote zero does the opposite — it is skipped in our run:

```
  push ds / push es / mov ax,0xc000 / mov ds,ax    ; the video BIOS ROM
  mov si,0x37 / xor ax,ax / mov al,[si] / mov si,ax
  lea di,[bp-4] / mov cx,4 / rep movsb             ; 4 bytes from C000:[C000:37]
  cmp byte [bp-4],0x77 / jnz .zero                 ; 'w'
  cmp byte [bp-2],0x99 / jnz .zero
  cmp byte [bp-1],0x66 / jnz .zero                 ; 'f'
  cmp byte [0xc4],1    / jnz .zero
  mov byte [0xc4],1 / jmp .test
.zero:
  mov byte [0xc4],0
.test:
  cmp byte [0xc4],0 / jz .out                      ; <-- taken here
  mov word [0x2448],0
.out:
  pop di / pop si / leave / retf
```

So the store is reached only when `[0xc4]` is *nonzero*, and `[0xc4]` is zero
because the signature test failed.

**The cause is that we present no video BIOS ROM.** C000-F000 is zeros, so this
probe reads `C000:0x37` as 0, copies four zero bytes, and misses `77 .. 99 66`;
every other probe in the classifier misses for the same reason; `[0x2448]` keeps
its initial zero; and zero indexes the null slot. The C000-F000 sweep landing on
the table's own `UnKnow` entry (DL=0x2d) is a separate mechanism and never
reaches `[0x2448]`.

That reframes the fix. A *generic* VGA BIOS image — the `55 AA` signature, the
size byte, and the plain IBM VGA identification — is not a vendor claim: every
real machine has one, and a program scanning for vendor strings would still find
none and conclude standard VGA. That is honest in a way that planting
`Trident`/`Tseng` at C000 is not. Whether SETUP has a branch that assigns a
nonzero id to a *generic* card is not established, so this may still not be
enough for ANGEL — but "no ROM at all" is a gap that reaches well past this one
demo, and it must be measured over a full sweep before it is kept.

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
is not the lever.

**The memory half is fixed.** The open question above — "whether real DOS reaches
the same wall", given it has *less* conventional memory than we offer — had the
answer that it does not, and for a reason that is not about how much memory
there is at all.

Every one of those blocks is `@100`, the loader's own PSP, and none of them ever
comes back. The loader's idiom is: allocate a header block and an image block,
`AH=55h` a PSP inside the image, run the subfile, and let the subfile's own
`AH=4Ch` give the image back. That last step works on real DOS because the
subfile **re-stamps the owner word of its image's MCB** onto itself first, and
DOS reads ownership out of the MCB. `--watch` catches it happening:

```
$ node tools/toyvm/run-dos.js BLIQ.EXE --seconds=8 --auto-key --watch=1673:0:16
   1  1684:4b wrote 16731-16732
```

`1673:0001` is the owner word of the block at `1674`. We kept ownership in a
`memOwner` map on the host side, so the write went nowhere we would ever read,
the six images stayed billed to PSP `100`, and the pool filled to `0x9F00`.

Worse, we had no header paragraph at all — blocks were handed out back to back —
so `1673` was the last paragraph of a *live block*, and the guest's owner write
was landing in another allocation's data. Modelling the arena header therefore
stops a corruption as well as a leak. Blocks now cost one paragraph more than
they hand out, the header carries `'M'`/owner/size at `seg-1`, and the owner is
read back out of guest memory on terminate. `memOwner` is gone: the MCB is the
only copy, which is the point. Not modelled: the *chain* — free regions carry no
header and there is no `AH=52h` to start a walk from, so nothing can walk it.

With that, the MIDAS error and the `[ERROR]: Executing internal subfile...` are
both gone and the program no longer exits.

**`Runtime error 200` — fixed in a5443f91.** It is *not* Borland's CRT
delay-calibration divide fault, which is the obvious reading and the wrong one.
Error 200 in Turbo Pascal is "division by zero" generally, and the calibration
bug is only one way to get there. That reading was ruled out by measurement
before the real cause was found:

| knob | values tried | errors |
|---|---|---|
| `--dispatches-per-tick` | 60k, 150k, 550k, 2M | 4 every time |
| `--sound` | `none`, `sb` | 4 every time |

A calibration overflow scales with the clock rate by construction, so a result
bit-identical across a 33x spread rules it out.

**It was ours.** Turbo Pascal's `Intr(IntNo, Regs)` executes the interrupt by
patching its own instruction stream: at offset `0x46` of the SYSTEM segment it
does `cs: mov [0x66], al` with the interrupt number, then falls through to the
`int nn` at `0x65` and pops the original word back afterwards. That store lands
`0x1f` bytes ahead — *past* the block boundary the store itself creates — so at
the instant it runs the target has usually not been compiled yet and `$smc`
comes back 1, "hit no compiled code". After `PATCH_MISSES` of those the site was
retired into `cache.benign` and the `int` stopped being re-decoded, so it ran
with whatever operand byte the last call left behind. A packed TP image ships
that byte as `$00`, so `Intr($F3, r)` executed `INT 0` and Turbo Pascal's own
divide-error handler printed the message.

Two bugs, both needed:

- the retirement counter and the `benign` set were keyed by the store's
  **offset**, so all four TP runtimes BLIQ loads (it runs its subfiles as
  separate programs) shared one verdict from whichever hit the counter first.
  Now keyed by linear address.
- a store landing within one block **ahead of the program counter** is an
  instruction patch whatever the compiled-code bitmap says at that instant, and
  is now never a retirement candidate (`PATCH_AHEAD`). `$smc=1` proves the
  target was not compiled *at that moment*, which for a patch that runs on the
  way into the block it patches is a race, not a verdict.

`COMPCODE.EXE` and `DOPE.EXE` — the storms retirement exists for — still retire
the same 1 and 3 sites and produce byte-identical frames.

**How it was found, and the tools that came out of it.** `--stop-on-text=STR`
(22b47015) ends a run on the last character of a message, so `--dump` and
`--disasm` photograph the failure instead of whatever reused its memory by exit.
`--trace-fault` now also prints the twelve words above SP and the `INT 0` vector:
an `INT` pushes flags/cs/ip, so the caller and its arguments are still on the
stack right behind the fault frame, and that is what named `Intr($F3)` here.
Read those two prints together —

    divide fault at 1aa9:67 (ax=1d dx=0 from 1aa9:36 at 19891934 dispatches)
      stack 20cb:3e56  0067 1aa9 7293 00cd 1ef2 3e6e 0171 1a90 19f8 1ef2 fff3 0000  int0=1b15:10c

— `00cd` is the word `Intr` saved from `cs:[0x65]` on the way in: `cd 00`, the
INT it was about to execute, with an operand byte of zero. `fff3` is the `IntNo`
argument it was *asked* for. The two disagreeing is the whole bug in one line.

Two traps to avoid re-walking. `--slice=2000` makes the errors disappear, which
looks like a granularity result; it is not, the run dies early at `fe5:7b` and
never reaches the erroring code. And the reported address is the *return* address
of the `int`, so disassembling at it lands on the instruction after the fault,
not the fault.

**BLIQ draws its logo — a second bug was hiding behind the first.** With the
message gone the run stopped at `168b:0263` instead, and that one was ours too.
The loop there is `inc word [0x5a]` / four pushes / `push cs` + near `call
168b:324f` (`out 3c8` then three `out 3c9`) / `cmp word [0x5a], 0xff` / `jnz` —
a 255-iteration DAC clear. It terminates on its own. What stopped it was the
progress detector, which hashes ten registers plus the console, IRQs and file
bytes: outside mode 3 the console term never moves, the loop counter lives in
memory nothing hashes, and the callee returns with `ax` and `dx` at the same
values every iteration. So 200 handbacks inside a loop that was driving the
palette read as wedged. Folding a DAC-write counter and the sequencer mask
writes into that signature (8ae811ff) fixes it.

It then needs **~1000M dispatches** to get there — at 300M it is still in mode X
at 4877 of 128000 pixels, and at 500M the screen is full but two colours wide.
At 1000M: `320x200`, 63999 non-black pixels, 40 indexes, the BLIQ logo over a red
plasma. The sweep's `DISPATCHES=300m` therefore photographs an early frame of it,
which is a picture and not an error, but not the one the demo is about.

### INTRO.EXE (`1995-c-cda_tp5i`) — two blockers cleared, a third open

Was "32-bit protected-mode code the decoder will not read". That reading was
wrong twice over: the code is 16-bit protected mode, and the decoder reads it
fine. Two real bugs were underneath it.

**Cleared: the far-pointer selector address.** `call far [0x28da4]` under a
0x67 prefix had its selector read from `0x8da8`, because the four `FF /3` and
`FF /5` memory forms masked the selector's effective address to 16 bits by
hand. The word that happened to sit there was `0x0002` — a valid descriptor
with base 0 — so protected mode carried on for another handback and died at
`2:1a43`, far enough from the transfer to look like anything but a bad far
pointer. `$off_add` (which wraps the low 16 bits and keeps the high half) is
what every other address computation here uses; these four now use it too.
INTRO keeps `cs=0x238 base=0x1100` and reaches its audio menu.

**Cleared: no interrupts in protected mode.** With the menu answered
(`--keys=1`) it set mode 13h, loaded 246 DAC entries and spun forever at
`238:3f08` on `fs: cmp eax,[0x4]` — a tick counter only its own IDT gate
increments. The host's `raise()` built the interrupt frame itself, could only
build the real-mode shape, and so refused to deliver to a protected-mode guest
at all. `$fault` already knew all three cases (386/286 gate through the IDT,
the V86 hand-off, the real-mode vector table); `raise()` now calls it through a
`raise_irq` export. The gate at `240:518` runs, 451 vectors land, the spin ends.

**Open: it reaches mode 13h and draws nothing.** It passes through 13h and
returns to text without putting a pixel down, so the best frame is still the
console menu. It is a music player ("LousyPlayer v0.9"), so a thin visual is
plausible, but that is a guess and not a measurement. `int 2Fh AH=16` is still
answered "no DPMI host". JULTRO.EXE, its neighbour, stopped separately at
`5ab:6e`; since the SMC-coverage fix (14d5c1a2) it gets past that and stops at
`5ab:8c` instead, with `Divide overflow at 5ab:1ff` and INT 00h unhandled.

**The cause, measured 2026-08-29.** An earlier note here read the four "decoder
gave up" sites as the program executing its own jump tables "having got there
with a bad index -- most likely because the 62 self-modify breaks are not
producing the plaintext it expects". The jump-table half is right and the cause
is not: `--no-cache` reproduces the stall exactly (20552 fresh traces, same
`5ab:8c`), so no stale compiled block is involved, and the 62 breaks are fine.

*(Fixed in 81e0f54e -- the chain below is the diagnosis that got there, kept
because every step of it is a reusable measurement. Skip to "JULTRO now runs".)*

JULTRO.EXE is two wrappers around the demo. Its MZ header says so in clear text
at offset 0x22: `Protect! v.5.0/MarkEXE v.2.0`. Layer 1 is that protector,
encrypted on disk -- disassembling the file at `5ab:0000` gets nothing, and even
at runtime it is obfuscated with jump-over-a-junk-byte (`eb 01 / ea`), so a
linear disassembly desyncs within two instructions. Layer 2 is LZEXE: it copies
itself up to `0afb` and unpacks the real demo over segment `0x110` upward. The
demo's own entry is `3bc:000c`, and it is a menu -- `int 21h AH=09` prints a
string, `AH=08` waits for a key, and `'0'`-`'9'` indexes a table. So JULTRO
belongs to the goal's "stuck in a user prompt" class once it gets that far.

It does not get that far, and `--watch` (added for this) says why:

```
$ node tools/toyvm/run-dos.js JULTRO.EXE --seconds=3 --watch=0:0:1024
   1  5ab:82  wrote c-d       1  5ab:ca  wrote 4-5
   1  5ab:92  wrote e-f       1  5ab:de  wrote 6-f
   1  5ab:10c wrote 4-7       1  5ab:186 wrote 4-87
```

Six writes into the interrupt vector table, all from layer 1, **and not one of
them a restore** -- every count is 1. The protector hooks INT 01h, INT 03h and
INT 21h (an anti-debugging set: single-step, breakpoint, DOS) and leaves them
hooked. The IVT at exit confirms the targets:

```
vec 01 -> 05ab:0240     vec 03 -> 05ab:0263     vec 21 -> 05ab:0191
```

every other vector still pointing at our `f000:01xx` stubs. Then layer 2 unpacks
straight over them -- `afb:65 wrote 5c40-5c41` is `5ab:0190-0191`, the INT 21h
handler itself. By the time the demo executes its first DOS call, the `int 21h`
at `3bc:0017`, the vector is inside what is now the demo's 12.4 fixed-point
lookup table (`0fbd 0fb0 0fc2 0fc4 ...` -- ascending, saturating at `0x0fff`).
It executes table bytes, wanders, and parks at `5ab:8c`.

That also settles the other three symptoms filed here separately: `5ab:56`,
`6e`, `8c`, `a7` and the divide are all *downstream* of the dangling vector, and
none of them is a decoder bug.

**The "Divide overflow at 5ab:1ff" is not a divide. It is the whole bug.** It
looks like the most alarming thing in the run, and an earlier revision of this
note dismissed it as a dead end ("this landmine decides nothing -- do not spend
time on it"). That was wrong, and it was wrong because the reading below stopped
one question short: it established *what* the byte was and never asked *who put
it there*. Hand-decoding the obfuscated stream -- the disassembler cannot, every
few bytes is a `jmp` over a junk byte -- gives this chain:

```
01d7  eb 17   jmp 01f0        01f0  eb e8   jmp 01da
01da  33 c0   xor ax,ax       01dc  eb 15   jmp 01f3
01f3  8e c0   mov es,ax       ; ES = 0
01f5  2e 3b 96 cb 01  cs: cmp dx,[bp+0x1cb]     ; a checksum against a constant
01fa  eb e3   jmp 01df        01df  75 29   jnz 020a   ; mismatch -> int 1
01e1  26 a0 6c 04     es: mov al,[0x046c]       ; BIOS tick low byte, 0040:006C
01e5  2e 88 86 e6 00  cs: mov [bp+0xe6],al      ; ...into the operand at 01fe
01ea  eb 01   jmp 01ed        01ed  eb 0e   jmp 01fd
01fd  cd ??   int <that byte>                   ; return address 01ff
```

So layer 1 reads a byte from `0000:046C` into an `int` operand and executes it.
`--watch=5ab:1fe:1` confirms the store (`5ab:1ea wrote 5cae`).

`0000:046C` is the BIOS tick counter, so this reads like an anti-emulator dice
roll -- dispatch through whatever vector the clock happens to name. It is not.
`--watch=0:46c:2` names the writer:

```
   1  5ab:186 wrote 46c-46c
```

`5ab:186` is the same block that installs the three hooks. **The protector plants
the byte itself**, and reads it back a decrypt-loop later to build the `int`. The
counter is being used as a mailbox, and the obfuscation only works because
`0040:006C` is ordinary writable RAM.

What it plants is `1`, and INT 01h is hooked to `5ab:0240` -- which, read past
the `020a` mismatch branch, is the cleanup routine:

```
0240  33 c0 8e c0     xor ax,ax / mov es,ax        ; ES = 0
0244  bf 04 00        mov di,4                     ; vector 01h
0247  0e 1f           push cs / pop ds
0249  8b f5           mov si,bp
024b  81 c6 d7 01     add si,0x1d7                 ; -> 5ab:02ef, saved originals
024f  a5 a5           movsw movsw                  ; restore INT 01h
0251  83 c7 04        add di,4                     ; vector 03h
0254  a5 a5           movsw movsw                  ; restore INT 03h
0258  bf 84 00        mov di,0x84                  ; vector 21h
025b  a5 a5           movsw movsw                  ; restore INT 21h
025e  2e 8b 86 d5 01  cs: mov ax,[bp+0x1d5]
0263  e6 21           out 0x21,al                  ; restore the PIC mask
0265  cf              iret
```

That answers the question this section used to end on. Nothing restores the
vector along a path we miss and the handler does not relocate: the restore is
`int 1`, dispatched through the protector's own hook, with the vector number
smuggled through the BIOS data area. The saved words at `5ab:02ef` are its
source, which is why they looked like chain targets.

We never ran it because `setTicks()` rewrote all four bytes of `0040:006C` from
an absolute counter on every slice, so the planted `1` was gone before the read
-- replaced by a count that was still 0. `int 00h`, no restore, and the stall
five stages downstream. Fixed in 81e0f54e by advancing that counter by the
elapsed delta the way a real BIOS ISR does, instead of recomputing it; a slice
spanning no whole tick now leaves it alone. The lesson is the general one: a
BIOS data area field is memory the guest may write, and a host that keeps its
own copy authoritative will eat those writes silently.

Two things were ruled out along the way and are worth not re-testing: the
trap-flag path (`stepping` is never armed -- TF is not set at any slice boundary
in the whole run, so the INT 1 trace-decryptor that dos-loop.js documents for
this program never fires here), and stale compiled code (`--no-cache` identical).

**JULTRO now runs.** Under the sweep's own flags it clears the protector, unpacks,
and puts up a `[ gusplay by cascada ]` GUS I/O port menu, which the auto-key
menu reader answers; behind it is mode 13h unchained, **59825 non-black pixels of
64000**, 246 DAC entries, `jultro.mod` open and playing. The picture is a
Christmas card -- "hyvvee jouluu", a postmark and a tree.

```
$ node tools/toyvm/run-dos.js JULTRO.EXE --seconds=15 --auto-key --png=OUT --no-close
```

### BLIQ's neighbours in the blank bucket

**AQUAPHOB.EXE** prints `DPMI v0.90 - Paging:1 RM:1 CPU:80386` — its own
extender's banner. We implement no DPMI (INT 31h) and answer INT 2Fh AX=1687
with "not present". A DPMI host is a large piece of work for one demo.

But the missing host is not what you watch it do. It switches to protected mode
on its own (`cr0=11 gdt=c660+86f cs=8 base=1100`, 16-bit code) and then runs,
crawling: **7-10% of wall time in wasm**, the other 90% in the host compiler.
`--smc-census` names one site for it —

```
23318  8:9c3 wrote 1e49-1e49        (of 23322 breaks in 5.5M dispatches)
    1  110:473 wrote 13ca-13e9 ...  (the other three, once each)
```

— a **single byte**, written once per `int 21h` out of protected mode, and each
write invalidates the region covering its paragraph. That is 70251 traces and
16MB of arena for 5.5M dispatches, and it is why 30 seconds of wall clock buys
1.8 seconds of guest time. The demo polls `int 21h AH=2C` (get time) 79564
times waiting for that guest time to pass, so the cost lands exactly where it
hurts.

**It is not false sharing, and that is measured.** Suppressing the invalidation
for exactly that one-byte store does not merely make the demo faster — it
changes what the demo does, leaving it spinning at `860:2686` after 506
handbacks instead of 455712. So `0x1e49` is genuinely executed code, the
invalidation is required, and there is no `benign`-style retirement to be had
here. The cost is structural instead: `compileProgram` walks a whole reachable
subgraph, so a region is large, and one rewritten byte throws all of it away.
Making this cheap means invalidating at block rather than region granularity.

**That design change was built and measured, and it is not worth shipping.**
Recording it so it is not built twice. The shape that works:

- `compileProgram` records a `spans` map (guest ip → decoded extent, arena
  address, word count) beside `blocks`.
- `invalidateRange` overwrites the head of each *overlapping block* with
  `end, blockIp` — two words, in place — instead of dropping the region. Every
  arrival at that arena address then hands back at the guest address, whether it
  came through the block map, the jump table, or a branch another block already
  resolved. This is sound only because a branch into the middle of a compiled
  block compiles the tail again as a block of its own, so every reachable arena
  address is a head.
- Regions then stop being dropped, so `entryFor`'s walk over the region list
  becomes O(regions) on the hottest path in the host. It has to be replaced by a
  `key → Map(ip → arena address)` index.
- Regions still accumulate — each recompiled block is a new region, and each
  joins the `byPara` lists every store walks — so a live-region cap per code
  base is needed, with a flush when it is hit. 64 measured best; 16 and 1024 are
  both worse.

Measured at fixed work (`--dispatches=`, user CPU, so box load cannot flatter
it), frames byte-identical throughout:

| program | before | after |
|---|---|---|
| AQUAPHOB.EXE (5M) | 4.64s, 62951 traces, 14.9MB | **3.52s**, 25223 traces, 3.9MB |
| BLIQ.EXE (300M) | 20.55s, 314029 traces, 69MB | **19.44s**, 196645 traces, 46MB |
| ASSAULT.EXE (100M) | 7.19s | **9.45s** |
| COMPCODE, DOPE, COROMER (100M) | — | within noise |

So it is a third off the compiler's work on the two programs it was designed
for, a third *on* to ASSAULT, and nothing anywhere else. And it does not reach
what AQUAPHOB needs: the demo is handback-bound, not compile-bound — 213440
handbacks for 5M dispatches, 23 dispatches each — so a budget it can finish in
is two orders of magnitude away, not 24%.

**BLAND.EXE** answers both its menus and then prints `failed to load MSE`. The
MSE file is read fully (0x28be, the exact file size, correct EOF), loads, hooks
IRQ vectors 0x0A/0x0D/0x0F/0x72 and unhooks them, and issues exactly one DSP
command. All six device choices and all three `--sound` settings behave
identically.

**That one DSP command was the tell, and it named two real bugs** (9a7c7939).
It is `F2h`, "force an 8-bit IRQ" — how a driver learns which IRQ the card is
on, since nothing about the card says. We ignored it, so nothing ever armed.
And the whole probe ran with **IF clear**, because the flags global started at
zero and DOS hands a program interrupts enabled; Turbo Pascal's startup issues
an STI, which is why every TP-built demo in the corpus hid this. MIDAS issues
none.

With both fixed the probe passes and the driver goes on to set a sample rate
(`40 a6`, 11111Hz) and complete three single-cycle transfers (`14 00 00`):
0 IRQs and 1 DSP command become 4 and 12, and the run goes from 0.2M
dispatches to 3.5M. It still ends at `failed to load MSE`, now from further in
— it installs its real IRQ7 handler at `12ed:2b52` and takes it back down at
`12ed:2b33`. What is left is DMA/IRQ *timing*: our completion IRQ arrives on
the loop's periodic cadence rather than at the rate the time constant implies,
and it is not established that this is what MIDAS is measuring.
