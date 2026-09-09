# VBE in the toy VM: what the corpus asks for, and what we answer

`tools/toyvm/dos.js` carries a small VBE 1.2 — the VESA BIOS Extension half of
`int 10h`. This file is the measurement behind it: which programs in
`/tmp/demos` call it, which modes they want, and which of those we serve.

The tool is **`tools/toyvm/vbe-census.js`**; read its header for how it runs. In
one line: one child process per program, 150M dispatches each with the sweep's
own flags (`--pit-clock --auto-key --sound-pref=sb`), recording every
`AX=4Fxx` call, the mode number in `CX`/`BX`, whether the linear-framebuffer bit
was set, whether we granted it, and what the program did next.

## Why the earlier number was wrong

[dos-corpus-blockers.md](dos-corpus-blockers.md) said "**How many rows want
VESA: three** — every program was run for 4 seconds with `--trace-int`". Four
seconds is not a budget, it is a stopwatch on a loaded box, and it undercounts
by construction. CHROME.EXE is the proof: its VBE query sits behind a
retrace-paced text scroller and does not happen until roughly 100M dispatches.
A run that stops before the question is asked reports that the program never
asks it.

At 150M dispatches the answer is **five**, not three, and the new name —
COUNTDWN.EXE — was already being served.

## The census, 199 programs

### The five that call VBE at all

| program | functions | mode info (4F01) | set mode (4F02) | LFB | outcome |
|---|---|---|---|---|---|
| AQUAPHOB.EXE | 4F00 4F01 4F02 4F05 | 101 | 101 | - | vesa+drew |
| CHROME.EXE | 4F01 4F02 4F07 | 112 | 112 | - | vesa+drew |
| COLORS.EXE | 4F01 4F02 | 101 | 10d | - | vesa+drew |
| COUNTDWN.EXE | 4F00 4F01 4F02 4F05 | 101 | 101 | - | vesa+drew |
| SETUP.EXE | 4F00 4F01 | 101 | - | - | blank |

(CHROME and COLORS read `exited blank` and refused-`10d` before this change;
the table is the state after it. SETUP.EXE — the Angel/Byetro installer — asks
4F00 and 4F01 for 0x101 and then never sets a mode; it is a setup program with
another blocker in front of it, and no mode we could add changes that row.)

### Modes asked for, by how many programs

| mode | what it is | served | programs | who |
|---|---|---|--:|---|
| 0x101 | 640x480x8 | yes | 4 | AQUAPHOB.EXE COLORS.EXE COUNTDWN.EXE SETUP.EXE |
| 0x10D | 320x200x15 | **new** | 1 | COLORS.EXE |
| 0x112 | 640x480x24 | **new** | 1 | CHROME.EXE |

**No program in the corpus asks for a linear framebuffer.** Not one 4F01 or
4F02 carried bit 0x4000. So the LFB path stays refused, and the refusal is
tested rather than assumed — see below.

### Functions used

| function | what it is | programs | calls |
|---|---|--:|--:|
| 4F01 | mode info | 5 | 5 |
| 4F02 | set mode | 4 | 4 |
| 4F00 | controller info | 3 | 4 |
| 4F05 | window control | 2 | 4705 |
| 4F07 | display start | 1 | 1 |

Nothing in the corpus calls 4F03, 4F04, 4F06, 4F08 or 4F09.

## What was implemented

Three things, and only the first is a mode.

**Direct colour, and two modes in it.** `VESA_MODES` carries a depth now, and
`framebuffer.js` reads 15/16/24/32bpp pictures as well as 8bpp: `readDirect`
widens 5-5-5 and 5-6-5 through lookup tables and reads 24bpp as BGR triples.
4F01 fills the VBE 1.2 direct-colour mask fields at 0x1F..0x26 and reports
memory model 6 rather than 4, because a program that reads model 4 on a 24bpp
mode goes looking for a palette that is not in the path. Mode **0x112**
(640x480x24) is CHROME's; mode **0x10D** (320x200x15) is COLORS's. Both were
added *with* their render path, and `test/test-toyvm-vbe.js` checks each one by
writing known pixels through the window and reading them back out of the frame.

**AX=4F07, display start.** CHROME calls it with (0,0) immediately after
setting its mode. It is not decoration: leaving `AX` unchanged there told the
program a call every VBE 1.2 card answers had been refused. It is implemented
as a real offset — the surface's `start` comes from it, so a program that pans
sees the picture move — and a start that would run the visible window off the
end of the 1MB picture is refused rather than clamped.

**The window-positioning far call, ModeInfoBlock+0x0C.** This is the one that
mattered most and was the least visible. A program may move the window by
`CALL FAR` through that pointer instead of `AX=4F05`; CHROME does, at
`100:0afd` (`call far cs:[0b7c]`, the pointer it copied out of the block). We
had been writing 0000:0000 there. That does not make a program fall back on the
interrupt — it far-calls the interrupt vector table and executes it. CHROME
ended up spinning at `0:18c` with its stack unwound. The fix is eight bytes of
real code below the PSP (`push ax / mov ax,4F05 / int 10h / pop ax / retf`),
which cannot live in the F000 stub segment because the run loop reads any CS of
F000 as "a vector was taken".

## What was declined, and why

**The linear framebuffer.** 4F01 with `CX & 0x4000` and 4F02 with `BX & 0x4000`
are refused, and `PhysBasePtr` is not offered. The picture lives at
`isa.VESA_FB`, outside the guest's address space, and there is no physical
address the guest could write it through — granting the bit would hand a program
an address it would then draw into nothing. **No program in this corpus wants
it**, so this costs a row nothing today.

**Modes 0x100, 0x103, 0x105 and everything else** stay as they are: nobody asks.
The rule the test enforces is the reason to keep the list short — 4F01 must
refuse a mode we cannot render (`test/test-toyvm-vbe.js` asks about 0x114 and
requires a failure), because a "supported" answer for a mode the frame reader
cannot read is a silent-success stub: the program sets it, draws into the
window, and the PNG, the frame hash and the live page all show nothing, with no
call anywhere saying otherwise.

## CHROME.EXE, before and after

Same command line (`--dispatches=150m --pit-clock --auto-key`):

| | before | after |
|---|---|---|
| ends | `exited=true code=0` at 100.4M | still running at 150M |
| video mode | `3h 320x200`, 0 non-black of 64000 | `112h VBE 640x480x24`, 89560 non-black of 307200 |
| on screen | the warning, then `To Be Continued...` | the raytraced CHROME logo |

At 20M and 60M dispatches both arms are still in the demo's own text intro
("WARNING! INTRO CONTAINS REALTIME RAYTRACING… RUNNING_"), which is the show,
not a refusal — the VBE question is not asked until about 100M.

COLORS.EXE goes from `exited blank` to its 15bpp title screen ("COLORS —
Wonders of the a-men").

## What did not move

AQUAPHOB.EXE and COUNTDWN.EXE, the two 0x101 users, are unchanged frame hash for
frame hash (`f9aaf10b` and `9fdddade` in both arms at `--dispatches=80m`). The
six witnesses DADEMO3 / RUNDEMO / BLIQ / ACME-BIG / CONTAGIO / CATWALK are
byte-identical, frame PNG and WAV, against a `main` base arm.

`sweep-dos.js --dir=/tmp/demos` on both arms, through `sweep-diff.js`, over 191
compared programs: **0 regressions, 0 went blank, 190 unchanged, 1 changed** —

```
COLORS.EXE: frame 38c165c5 -> 7eb1ed94, 2.5M -> 8.0M dispatches (x3.23), px 0 -> 28081
```

which is the whole intended effect: it stops exiting on the refusal and runs on
into its title screen, so it spends the sweep's full budget instead of 2.5M.

**CHROME.EXE is `unchanged` in that sweep and that is not a contradiction.** The
sweep photographs each program at 8.0M dispatches and CHROME does not ask its
VBE question until about 100M, so both arms are still in its text intro with 0
pixels lit. It is the same budget artefact that produced the "three programs"
figure in the first place — which is why the row that proves this change is the
150M run above, not the sweep.
