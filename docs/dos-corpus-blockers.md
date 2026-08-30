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

**Keep the corpus out of `/tmp`.** macOS runs a periodic cleaner that deletes
files under `/tmp` by age, and it does not care that a sweep is reading them:
on 2026-08-30 at 00:00 it took `/tmp/demos` from 199 programs to 37 files and
146 empty directories **mid-sweep**, which silently turned every row captured
after that point into a photograph of `ENOENT`. A sweep that suddenly starts
producing blank rows in alphabetical order is this, not a regression. The
corpus now lives in `~/dos-demos` and `/tmp/demos` is a symlink to it, so every
command in this file still reads the same; `tools/toyvm/fetch-demos.js`
re-fetches it (`--dirs=1993/a,…,1995/c --max=1000 --max-kb=80`, plus one
`--max-kb=400` pass over `1994/c` for `cw2`, whose archive is over the 80K
cutoff). The row files under `/tmp/rows-*` are just as perishable — a sweep
worth resuming wants them somewhere the cleaner does not reach either.

This file is the work list: one entry per program that still does not show what
it meant to, with the *measured* cause rather than a guess. Read the entry
before starting on one — several of these have already cost a session each, and
two of them are not bugs at all.

**Where the corpus stands (2026-08-29, sweep v17):** 194 of 199 rows show what
the program meant to show — 165 graphics, 29 text art. The five that do not are
`001.EXE`, `002.EXE` and `rage.exe`, all three behaving correctly (below), and
**ANGEL.EXE + its SETUP.EXE**, the one real blocker left.

AQUAPHOB.EXE moved `blank` → `demo` in this sweep and is the whole difference
between v16 and v17: nothing else moved in either direction, which is what
prices the VESA support added for it over the other 198 programs. What the
sweep photographs is its setup screen; the demo behind it needs a mouse click.
See its entry.

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

**A generic ROM header is not enough, measured.** Writing the option-ROM header
every adapter has had since 1984 at C000:0000 — `55 AA`, a size byte, a `retf`
init entry and an "IBM COMPATIBLE VGA BIOS" identification at C000:001E — leaves
`[87f:2448]` at 0 and `[87f:1e02]` at 0, and SETUP ends at the same instruction
after the same 803.9M dispatches. The vendor-stamp probe wants `77 .. 99 66`
four bytes into whatever `C000:37` points at, and an honest header does not
carry that. So the header on its own has no beneficiary and is not shipped; a
fix here has to come from the classifier's own default-id path, or from SETUP
never reaching the trampoline with id 0 in the first place.

Note that any fix which puts a vendor signature at C000 claims chipset registers
we do not emulate — the same mistake as a default `BLASTER=`/`ULTRASND=` — so it
must be measured over a full sweep before it is kept. **Reading `[87f:256e]`'s
writer is the cheaper route and does not claim any hardware.**

**Reading it is now cheap.** `dos-disasm.js --image=FILE@SEG:OFF` lays a
`run-dos --dump=` hexdump into the memory image after the static load, so the
overlays can be read as the machine ran them:

```bash
node tools/toyvm/run-dos.js SETUP.EXE --dispatches=850m --dump=0100:0000:98304 > d.log
node tools/toyvm/dos-disasm.js SETUP.EXE --image=d.log@100:0 773:0b44 --to=773:0b70
```

Three things measured with it, all of them narrowing the fix rather than
supplying one:

*Both id-indexed tables have a null slot 0.* `87f:20b0` is
`00 00 | 0b64 0b66 0b68 0b6a 0cf4 | 00 00 | 0bc5 …` and `87f:1fe8` is
`00 00 | 0805 0807 0809 …`. So id 0 is not "standard VGA", it is *no answer* —
SETUP indexes both tables with it unconditionally and requires the id to be
nonzero. `773:07d9` (into `[0x1e0a]`) and `773:0b44` (into `[0x1e0c]`) are the
two indexers, and `773:056e` calls both between its `int 10h AX=0013` and the
first bank switch.

*Twelve of the thirteen detectors read the video BIOS ROM.* `3c9:37c0`-`37f0`
calls them in a row, each setting its own flag byte; the first, `3c9:0e19`,
compares five bytes at `C000:0025` against a literal. With C000-F000 zeroed
every one of them declines, which is the same finding as before from the other
end.

*The one that does not is a Trident register probe, and it is the only path to
a nonzero id that needs no ROM.* It writes `0xEA` to sequencer index 6 through
`0x3C4`, reads sequencer index `0x0E` back, restores it with `0xAE`, and turns
the value read into the id directly:

```
0x80..0xFE -> 1     0x70..0x7E -> 2     0x50..0x59 -> 3     0x41..0x49 -> 4
```

That is a TVGA revision number, and answering it with anything in those ranges
claims a Trident 8800/8900 — including its bank-switch registers, which are
what `[0x1e0c]` would then be installed to write. So it is a way to make SETUP
finish, not a way to make it right; the warning above applies to it exactly.

One trap this cost an hour: **segment 773 is a Turbo Pascal overlay, and
`--disasm` fires at exit.** Disassembling `773:0573` mid-run and at exit happens
to agree here, but the code at other 773 offsets does not, and a confident
reading of the wrong overlay is indistinguishable from a reading of the right
one.

The `--pre=SETUP.EXE` rung in `shot-sweep.js` already runs SETUP before ANGEL
and carries its `tempFiles` across, so a SETUP that writes the stamp lands both
rows with no further harness work.

#### SETUP is finished, and so is the CRC gate (2026-08-29)

Three fixes, in the order they came off:

**1. `--svga=trident` (`ba53f5dd`).** The warning above — that a vendor
signature at C000 claims chipset registers we do not emulate — is answered by
emulating them. `--svga=trident` gives the machine a TVGA8900: CRTC index 0x1F
reads back CRTC 0x0C XOR 0xEA (write 0x55, read 0xBF), sequencer index 0x0E
carries the version in its high nibble and the bank in its low nibble and is
written XORed with 2, SR6 = 0xEA unlocks and 0xAE locks, and that bank selector
really moves a 64KB window over a 1MB framebuffer. With the registers real, the
`Trident TVGA8900 VGA BIOS` string at C000 is a description rather than a claim.
SETUP then finishes in **2.1M dispatches** where it used to spend 717.8M and
write nothing:

```
· 80386 detected..            · A Vesa bios is in memory..
· The Irq 2 is on..           · I can see a Trident Vga card..
· With an unknown chip..      · Amount of Video Memory: 1024k..
SETUP DONE ! Now you can run the demo.
```

The default is `none`, deliberately: a program that finds a chipset uses its
modes, so this is a machine configuration and not an improvement.

**2. Writes into a file that was already there (`ba53f5dd`).** SETUP still did
not land the stamp, because it does not *create* `DRIVERS.VGA` — it opens the
one that shipped with the demo and patches the ten bytes at its end in place.
`createFile` gave a guest-created file somewhere to live; a write into a
host-backed handle was simply dropped, so ANGEL kept reading the author's 1995
CRC32 over his own ROM. A write now copies the file into the in-memory file
system first and every later read of that name sees the copy. Nothing reaches
the host disk; the corpus directory stays read-only. The trailer moves
`00 c0 00 80 | da 9a 95 1a` → `00 c0 00 80 | fc ab a6 26`, and the demo clears
its gate. `--save-files=DIR` is how those bytes were read at all.

**3. AH=4Dh reports how, not just what (`994c6f15`).** ANGEL then stalled at
`23d:00f1`, two dispatches per handback, inside an instruction. That address is
the INT FCh vector its own resident protected-mode helper installs. The demo's
loader runs each part by hand — allocate, read, `AH=50h` set PSP, jump — and on
the way back asks `AH=4Dh` how the part ended, freeing the block only when the
answer is not 3 (terminate-and-stay-resident). We answered AL and left AH as
found, so the loader freed the resident and loaded the next part on top of it.

**What is left is ANGEL's own protected-mode kernel.** With all three in, the
demo gets 3.0M dispatches further: it builds a GDT at `23d:0008`
(`ff ff d0 23 00 9a` and `ff ff c0 28 00 9a cf 00`), `lgdt`s, `mov cr0,eax`es,
and runs its own 32-bit code — `--trace-entry` shows `entry 8:10f base=21de0 pm`
and `entry c:8 base=232e0 pm` before control reaches a selector we resolve to
base 0 and the run walks the IVT. That is a DOS extender, not a missing service,
and it is a different size of job from everything above.

Where to start on it, measured. The last honest block is the resident's
protected-mode entry, reached as `entry c:8 base=232e0 pm` and running at
`232e:0017`; it is 16-bit protected mode using 0x66/0x67 prefixes throughout,
not a 32-bit segment (`--trace-entry` never reports `32-bit code` and the run
is never `blockedOn32`). By the time control reaches the `int 21h` at
`232e:0053` the machine is already wrong: AX should be `0x3f11` — `mov ah,0x3f`
over the `0x0011` it came in with — and is `0xff0d`, which is why the trace
shows `int 21h ax=ff0d ... UNHANDLED`, and SP has moved `0x0bee` → `0xfffe`
with SS unchanged.

The bytes at `232e:17` — confirmed by `--dump-at=1103330:232e:0:112`, i.e. at
the dispatch count the resident is actually running, not at exit — are

```
2e 0f 01 1d 00 00 00 00  fb  33 c0  8e c0  67 8b 0e 06 04  0b c9
0f 84 78 01 00 00  81 f9 00 80 00 00  72 05  b9 00 80 00 00
67 29 0e 06 04  b4 3f  66 67 8b 1e 04 04  1e  0f a0  1f  33 d2  cd 21
```

and as 32-bit code every one of them is a sensible instruction:

```
cs: lidt [eax] / sti / xor eax,eax / mov es,ax
mov ecx,[0x0406]        ; 67 8b 0e 06 04 -- 16-bit ADDRESSING in a 32-bit segment
or ecx,ecx / jz +0x178  ; 0f 84 rel32
cmp ecx,0x8000 / jb +5 / mov ecx,0x8000
sub [0x0406],ecx / mov ah,0x3f / mov bx,[0x0404] / push ds / push fs / pop ds
xor edx,edx / int 21h   ; AH=3Fh, read ECX bytes
```

Read as 16-bit, the same `67 8b 0e` is `mov cx,[esi]` in three bytes and the
stream desynchronises into `push es / add al,0x0b / leave` — and that `leave`
is exactly the SP the trace reports, with `add al,0x0b` explaining the low byte
of the AX it carries into the INT. So the corruption is one mis-sized decode,
not a missing service.

`$segd32` does honour the descriptor's D/B bit and `$d32` is set every time CS
is loaded, so the question is what D should be *after the jump that got here*.
`--dump=232e:0:32` shows what precedes it:

```
0000  ff 03 a8 1f 02 00 00 00      ; a pseudo-descriptor: limit 0x03ff, base 0x00021fa8
0008  0f 20 c0                     ; mov eax,cr0
000b  24 fe                        ; and al,0xfe          <-- clears PE
000d  0f 22 c0                     ; mov cr0,eax
0010  ea 17 00 00 00 2e 23         ; jmp far 0x232e:0x00000017
```

The run enters this stub as `entry c:8 base=232e0 pm` — 32-bit, which is why
the `ea` was read as `off32 sel16` and the trace's next entry is `232e:17` at
all. Two readings of the jump are self-consistent and they differ in exactly
the bit that breaks the next block: entered 32-bit it is
`jmp far 0x232e:0x00000017` and the target should keep 32-bit sizes, entered
16-bit it is `jmp far 0x0000:0x0017` and five bytes shorter. The `cs: lidt [0]`
that opens the target settles it: with the `cs` override it loads the six bytes
at `232e:0` — `ff 03 a8 1f 02 00`, limit `0x03ff`, base `0x00021fa8` — and a
`0x3ff` limit is a 256-entry real-mode IVT and nothing else. Reloading the
real-mode IDT is exactly what the first instruction after leaving protected
mode should do, and only the 32-bit reading produces it. So the D bit has to
survive the far jump, and forcing it to 0 is what broke the block.

An aside worth keeping, because it cost a session: **on a program that loads
code at run time, an at-exit dump is evidence about the end of the run and
nothing else** — the resident's memory at exit holds something else entirely,
and the listing above briefly stood withdrawn on the strength of a `--dump-at=`
aimed at 1.05M dispatches when the resident does not run until 1.1033M. Use
`--dump-at=` at a count *inside* the window, `--pre-dispatches=` so cutting the
main run short does not also starve the prerequisite, and `--trace-int`, which
now prints the dispatch count of every call and is where that count comes from.

#### Both causes, measured (2026-08-30, branch `angel-pm`)

**1. Real mode keeps the cached CS D bit.** Clearing PE does not reload CS; the
far jump after it does, and a real-mode CS load rewrites the base and the limit
and leaves the size alone. `$segd32` returned 0 whenever PE was clear, so the
32-bit block above was decoded 16-bit — `--disasm` at the stop point shows the
whole desync, `add al,0xb` / `add al,0xb4` accumulating into the `0xff0d` the
trace reports and `leave` at `0x2a` producing the `0xfffe` stack pointer. A
program that never entered protected mode is unaffected: `$d32` starts at 0 and
only a descriptor can raise it.

**2. Selector 4 is LDT entry 0, not the null selector.** With the D bit fixed
the resident reads its whole file in `0x8000` chunks and then far-jumps to
`4:60`, which we resolved to base 0 and ran as the IVT. Its GDT (at `21de8`,
limit `0x37`) has an LDT descriptor at selector `0x28` with base `0x22df8`, and
the extender lives at LDT entries 0 and 1 — selectors `0x04` and `0x0c`. The
null test in `$segbase`/`$segd32`/`$descaddr` masked with `0xFFF8`, which throws
the table indicator away, so every LDT selector with index 0 came back null. The
mask is `0xFFFC`: only the GDT has a null slot.

With both, ANGEL goes from a wild jump into the IVT at 3.0M dispatches to
running its own loop for 300M — it reads the file, sets mode 13h and loads a
246-entry DAC palette. **It still writes nothing to A000**, spinning in its
extender at `22df:365`–`22df:3ee`, and that is the next question. Those three
blocks disassemble as a Huffman decoder — a code-length histogram, a
first-code-per-length table, then a bit-at-a-time `shr`/`rcl` walk — so the
loop is doing work rather than polling. 3000M dispatches (132s of wall clock)
end in the same place as 200M, with the DAC loaded and the screen black — but
"the same place" is not "no progress": handbacks go 2542 → 6274 over that 15x,
so it is advancing, just far too slowly to reach a frame. Whether that is a
budget problem or a decoder fed the wrong bytes is the open question. One
measurement is in: the table the loop builds at `234a:0437` is different at 40M
and at 80M dispatches and **identical at 80M and 120M**, so whatever it is
chewing through, it stopped producing new Huffman tables somewhere in between.
That is the thread to pull next — either the same block is being decoded over
and over, or the loop is past the tables and into a body that never ends. Two gaps
noticed on the way and not yet closed: there is no `$ldtl`, so an LDT
selector's limit is checked against the *GDT* limit, and past that limit it
falls back to reading the selector as a paragraph.

**The sweep is deliberately not given a `--svga` rung, and the reason is worth
keeping.** A rung was written and measured: a program that put nothing on either
surface — no pixels and not one non-blank cell, which in this corpus is
SETUP.EXE alone — gets one retry with `--svga=trident`. It works, in the sense
that SETUP then finishes and prints its 247-cell report. It photographs *worse*.
The best-frame tracker keeps the fullest frame, not the last, and on the way to
that report SETUP passes through mode 13h and leaves a 1000-pixel single-colour
strip there. `frameScore` bands a single-index fill at 1e6 and a full text page
at cells+4000 — any graphics beats any text, on purpose, priced across the whole
corpus — so the tile that wins is a black screen with a blue line, filed as a
picture. A blank row that is honestly blank beats a `demo` row that is a
detection artifact, so the rung was dropped rather than shipped.

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

**AQUAPHOB.EXE draws, and the two things that were stopping it were neither
DPMI nor speed.** Recorded above the older investigation because that
investigation's conclusion — "a DPMI host is a large piece of work for one
demo" — was not what stood between this program and its picture.

*It draws through VESA, not through the mode-13h window.* Its first video call
is `int 10h AX=4F00`, and answering nothing to that left it with no mode to draw
in. `dos.js` now carries a small VBE 1.2: controller info, mode info for the
four 8bpp modes a 1995 demo asks for, set/get mode and window control. The
picture lives outside the guest address space and the 64KB at A000 is a window
onto one bank of it, copied in and out as the guest switches banks. AQUAPHOB
takes `4F00 → 4F01 (CX=0x101) → 4F02 (BX=0x101)` and then bank-switches 0..4
through `4F05`, which is a 640x480x8 picture being painted a bank at a time.

Two readers had to learn the same thing, and both were caught by the same
symptom — a 320x200 photograph of a 640x480 screen. `screenSurface` answers with
the VESA geometry rather than the CRTC's, which describes the window and not the
screen; and `readFrame` took its non-planar geometry from `LINEAR` wholesale, so
the surface was read as the first 64KB at A000 whatever the caller passed.

*Its interface is drawn, and it ignores the keyboard.* What it puts up is a
640x480 setup screen — sound cards down the left, video modes down the right,
PORT/IRQ/DMA/KHZ along the bottom, `START DEMO` at the lower right — and it
hit-tests it against `int 33h` fn 03. `enter`, `space`, `esc` and `s` all leave
the frame hash unchanged. `--click=X:Y[@FRAC]` presses the left button at a
point in the guest's mouse coordinate space, holding it for a stretch of
handbacks because a press that is up again before the next poll never happened.
Mind that the coordinates are the ones `int 33h` reports and not always the
pixel grid: this program sets a 0..1278 horizontal range over 640 pixels (fn 07)
and a 0..479 vertical one (fn 08), so its x is doubled.

```
$ node tools/toyvm/run-dos.js AQUAPHOB.EXE --tick-scale=50 --dispatches=250m \
    --click=44:110@0.2,910:325@0.4 --png=OUT
```

— SILENCE, then START DEMO, and the demo runs: mode 13h, a lit "presents" over
spheres. Which is the last piece: a BIOS mode set now *leaves* the VESA mode.
Keeping it across one photographed the demo as the setup screen still sitting in
the banks, drawn in the demo's new palette — a convincing picture of a corrupt
framebuffer that was really a stale one.

**The sweep photographs the setup screen, not the demo**, and that is where this
stops for now. The screen is 307200 pixels of real content so the row is not a
blank, but the rungs in `shot-sweep.js` are all evidence-driven and there is no
evidence in a run that says *where* to click. A blind click rung would be as
likely to press `EXIT TO DOS`.

The older investigation, still accurate about what the demo costs:

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

**It was, twice over, and BLAND now runs** (fbb458e8). `--trace-io` — added in
the same commit, and the flag to reach for on any "the driver does not find the
card" — printed the whole 8237 conversation: MIDAS walks DMA channels 0, 1 and
3, programming mask/mode/address/count/page for each, and never reads a single
port back. So the probe is not measuring the DMA controller at all. The code at
`12ee:2669` says what it is measuring:

```
12ee:26b2  mov al, 0x14 ; out dx, al   ; single-cycle transfer, one byte
12ee:26c5  xor cx, cx                  ; 65536 rounds of
12ee:26c7  cs: cmp byte [0x243c], 0x1  ;   "has my IRQ handler run yet"
12ee:2707  loop 0x55a7
12ee:2709  call 0x56b0                 ; no -> reset the DSP, try the next channel
12ee:271c  cmp al, 0x4 ; jnz ...       ; ran out of channels -> [0x37e] = FFh
```

Two bugs, both about *when* the interrupt arrives:

1. **An interrupt armed by a port write waited for the next slice.** Interrupts
   are only injected between slices, where the guest `cs:ip` is a real
   instruction boundary — and that spin is ~1.1M dispatches, which fits inside
   one 2M-dispatch slice with room to spare. The IRQ landed one handback *after*
   the timeout every time, visible in `--trace-io` as the `in 22e` that follows
   the `out 226` reset rather than preceding it. `Machine.endSlice` now ends the
   current slice when a port write arms an interrupt.
2. **Block-done interrupts were paced at a fixed dispatch interval.** A driver
   that mixes a whole buffer inside its handler then gets asked for half a
   second of audio every ten milliseconds of guest time: BLAND found the card
   and spent 300M dispatches inside MIDAS's mixer, its own code never reached
   and the screen still in text mode. The card decides this rate, not us, so
   `40h`/`41h` now set the sample rate, the transfer commands record the length,
   and `sbInterval()` converts the block's duration into dispatches against the
   same clock the timer uses.

**BLAND is a textmode intro** (its own .NFO: "It uses the 80x25 and 80x50 text
modes for all effects"), so mode 3h is the finish line, not a symptom. It now
loads `sb1x.mse`, `warmchip.gdm` and `bland.dat`, turns the speaker on and runs
its starfield and credits.

The pacing change is a general one and was A/B'd over eight demos at fixed work:
ATTIC, brainbug, COMPCODE, IHANMUU, DHADREN and BLIQ render byte-identical
frames — ATTIC on 25 DSP commands instead of 412 — BLACK gets *further* (it
reaches unchained 320x400 and its own sound init), and BTW differs only in the
way any timing change moves an animation.

### The `art` bucket hides three more work items

`demo-status.js` calls any text screen with 40 or more non-blank cells `art`,
and counts it as "showing something they meant to". For a BBS ANSI file
(`a-note.exe`, `STARPORT.COM`, `NFO.EXE`, `ANTARES.EXE`, `README!.COM`) that is
exactly right. For three of the thirty it is not — the text on screen is a menu
or a warning, and the demo behind it never ran. Each was read with `--trace-int`
in a few minutes, and none of them is a text demo:

**CHROME.EXE — VESA.** It prints its "INTRO CONTAINS REALTIME RAYTRACING / CODE
IS FULLY PENTIUM OPTIMIZED" warning, asks for `int 10h AX=4F01` (VBE mode info)
for **mode 0x112, 640x480 24bpp**, gets no answer, and terminates through
`int 21h AH=4Ch` — 0.4M dispatches, start to finish. The CPU level is not the
issue: `--cpu=486/586/686` all end at the same instruction. We answer no VBE
call at all, so `AX` comes back unchanged rather than `0x004F`, and the demo
takes its own no-VESA path. **How many other rows want VBE has not been
measured, and that number is what decides whether this is worth building.**

**COCAHOLC.EXE — a protected-mode extender that gives up.** It answers its own
sound menu (autoKey reads "0", and the choice makes no difference: 1, 2 and 3
all end at the same instruction after the same 16.2M dispatches), probes DPMI
(`int 2Fh AX=1687`, unhandled), finds no VCPI, takes the XMS route instead —
allocates a 2561KB EMB, locks it, and gets a good linear address back — then
runs a long way in protected mode (`base=129d0`, 32-bit) before unwinding to
real mode, setting mode 13h and terminating with `int 20h`. It opens none of
its own files (`COCAHOLC.INF`, `SB.DRV`, `SBP.DRV`) on the way. So the XMS half
is fine and the extender is where it dies; where exactly is not yet established.

**DINO.EXE and DINO386.EXE — an arrow-key menu.** Their setup screen is a
three-column grid (device / port / IRQ) with the current row marked by a `>`,
and it says so: "Use ARROW keys to move around, ENTER selects highlighted
option." The menu reader in `Machine.menuKey` only recognises menus with a
single-character selector per option, so it finds nothing to pick — "Silence"
is right there in the list and matches `SILENT_LABEL`, but it has no letter or
digit in front of it. Both rows otherwise run: they reach protected mode
(`cr0=11`, 32-bit code at base 20a0) and sit on the menu for the whole
300M-dispatch budget.

**Teaching the reader to count rows is not on its own enough, and it is worth
knowing why before starting.** DINO masks IRQ1 (`out 0x21, 0x02`) and polls port
0x60 directly — visible in `--trace-io=20,21,a0,a1,60,64` as one `out 021 <- 2`
followed by an unbroken run of `in 060`. That path is real and keys *do* reach
it: `--auto-key --keys=down,down,down,enter` moves the marker. It moves **one
row in 775M dispatches**, though, for four keys. `Machine.kbFill` is only
consulted from the port-0x60 read on `(kbReads++ & 0xFFF) === 0`, and
`keyboardIrq` cannot help because `hookedVector` reads the real-mode IVT and a
protected-mode program's IRQ1 handler is an IDT gate — so every interrupt rung
in the run loop, keyboard and timer and retrace and Sound Blaster alike, sees a
program in protected mode as one that has hooked nothing. Whatever else is
throttling the polled path, that is the general gap underneath it, and it is
shared with COCAHOLC and AQUAPHOB.

**Reading the IDT there was tried and reverted** (`04aefe57`, undone in
`a2e19dec`), and the reason is worth keeping. Consulting `$idtgate` from
`hookedVector` did make a pmode demo look "hooked" — but every caller passes
0x08, 0x09, 0x0A, 0x0F or 0x1C, and in protected mode those are the CPU's own
exception numbers (8 is `#DF`), so an extender has a present gate at all of them
whatever it thinks of hardware interrupts. It was not a way to see a hooked
interrupt; it was a way to send a double fault every tick. cd2.exe, daretro.exe
and AMBIENT.EXE each went from a full screen to a printed "Exception fault."
Restricting the read to vectors above 0x20 makes it inert, since no caller
passes one, so the gap is still open: **where a pmode program remaps its PIC to
is not something we track, and until it is there is nothing to read.**

**DINO renders** (`94fe23b0`): 64000 of 64000 pixels of mode 13h at the sweep's
own budget, with `dino.s3m` and `dino.dat` open. Two steps got it there.

First, `arrowMenuKeys` reads a marker column off the text page and counts rows
to a silent option, on the strength of the screen having said the marker moves
("Use ARROW keys to move around"). That selects Silence and gets no further:
the grid's other three fields are committed by a cursor **whose position is a
colour**, and `screenText` throws attributes away, so to a text reader every
column looks equally selected. Blind walks were tried and measured, and both
fail for reasons worth keeping: nine Enters move nothing, and three Rights from
the fourth row of a four-row column land in the IRQ column and set the IRQ,
because Right keeps its row and the command column is two rows tall.

So `screenHighlight` reads the attribute plane and takes the **rarest**
attribute on the page — DINO writes its text in 0x07, its title bar in 0x4f,
its headings in 0x0f, and exactly one label in 0x3f. With the cursor visible the
walk becomes one key at a time with the screen as the feedback, and the poll
gate now counts the cursor as part of "what is on the screen", so a key that
moves only a colour is still seen to have landed. It is self-limiting in the
right way: a key that changes nothing ends the walk.

One trap, which cost a wrapping loop: aim at the **nearest** matching row, not
the first. A column includes its own heading, and DINO's command column is
headed "and I AM READY TO", which matches the go-label pattern on "READY" as
surely as "Rock'n'roll" does.

**How many rows want VESA: three.** Every program in the corpus was run for 4
seconds with `--trace-int` and its `int 10h AX=4Fxx` calls counted, and only
COLORS.EXE, SETUP.EXE and CHROME.EXE make one. VBE is a three-row lever, and
two of those three rows have another blocker in front of it — so it stays below
the extender and the video-BIOS ROM on the list.

### A row can say `error` because of how the sweep chose its picture

BLAND.EXE spent a version in the `error` bucket *after* its actual bug was
fixed, and the reason was the frame chooser. It is a textmode intro: its
starfield is a few dozen lit cells, and the sound-card menu it prints on the way
in is 192. Both choosers — `keepBest` inside a run, `score` between runs —
ranked text screens by cell count alone, so the fullest screen was the question,
and the run that won the row was the no-sound-card retry whose caption read
"failed to load MSE". A demo that works, photographed at its menu, described by
a refusal.

Both now band a screen the program is *asking* or *refusing* on below one it is
not (`ecd35d57`), sharing `demo-status.js`'s own definition of both rather than
keeping a second copy of the words. The band sits under `frameScore`'s, so "any
graphics frame beats any text frame" is unchanged. **The lesson generalises: a
row in `error` or `prompt` whose program is known to run is a claim about the
chooser, not about the program.**

Two guards on that band, each of which cost a demo its picture before it was
added, and both found only by sweeping the whole corpus:

- **An empty screen gets no band** (`02e8bf3b`). Zero has to keep meaning
  "nothing on screen": `capture` decides a program never started with
  `score(row) <= 0`, and a blank page scoring 10000 cost AMBIENT, daretro and
  cd2 their auto-key retry. A program whose only output *is* a refusal must also
  still be photographed saying it — an empty frame outranking rage.exe's own
  "GUS not found!" turned an honest `error` row into a `blank` one.
- **What a run said is kept apart from what it showed** (`a2e19dec`). The band
  is right for the photograph and wrong for the diagnosis: AMBIENT's
  `USE "AMBIENT /NO_SND" FOR SILENT MODE` is the input to a retry rung, and
  demoting the frame that carried it lost the rung its switch and the demo its
  64000 pixels. Rows now carry a `says` field with any refusal the run printed,
  whatever that frame scored, and the rungs read it alongside the kept screen.
