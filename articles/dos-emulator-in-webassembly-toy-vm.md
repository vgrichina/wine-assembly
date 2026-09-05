# A DOS emulator in WebAssembly built to answer interpreter-design questions

Alongside its Windows 98 emulator, Wine-Assembly contains a second, much smaller x86 machine: a real-mode DOS emulator, called the toy VM in the repository, that runs a corpus of 199 DOS programs and demos with VGA, PC speaker, Sound Blaster, OPL2 and GUS audio. It exists because the main emulator had become too large to A/B an interpreter design on, and it turned into the place where dispatch strategies, lazy flags, superinstructions, tracing JITs and a region JIT were tried with numbers. This article is about what it is and what it found.

## Why build a second emulator

By August 2026 the main interpreter was 200,000 lines of WebAssembly Text with a Win32 layer around it, and every dispatch experiment on it took a worktree, a build, and a benchmark on a machine that was usually running other agents' sweeps. The results in [interpreter-dispatch-perf.md](/docs/interpreter-dispatch-perf.md) show the problem: whole-app A/B runs varied by 24 to 42% between identical arms, so a 10% idea could not be seen.

A real-mode machine is small. 16-bit x86 has fewer addressing forms, no paging, and a DOS program's operating system is a handful of interrupts. The toy VM could be rebuilt around a different dispatch design in a day, and a corpus of DOS demos and games gives workloads that are all interpreter, with no API layer in the way. `docs/toyvm-*.md` is the set of experiments run on it.

## The corpus

The corpus is 199 DOS programs: demoscene productions, shareware games and utilities, each run headlessly to a frame hash and a screenshot. All 199 run; [dos-corpus-blockers.md](/docs/dos-corpus-blockers.md) records what each one needed. The ground truth for audio and timing is `dosbox-ref.js`, which drives DOSBox on the same programs, so a wrong OPL2 register or a VGA retrace that fires at the wrong time is caught by comparison rather than by ear.

Two devices needed more care than the CPU. The VGA status register's retrace bit is derived from the dispatch clock, and one demo polls the keyboard port rather than retrace, which took a while to see. Sound is four devices behind one mixer: the PC speaker, Sound Blaster DMA, an OPL2 FM synthesiser and a Gravis Ultrasound, and the page's audio budget "breathes" when a frame stalls so that a slow frame produces a late sample rather than a dropout.

## Three backends, one machine

The toy VM runs the same programs on three execution tiers, which is the whole point:

1. **A threaded-code interpreter**, the same design as the main emulator, as the baseline. [toyvm-dispatch-shootout.md](/docs/toyvm-dispatch-shootout.md) compares dispatch strategies on it.
2. **Micro-ops and superinstructions**: [toyvm-superinstructions.md](/docs/toyvm-superinstructions.md) folds common pairs, [toyvm-stream-loops.md](/docs/toyvm-stream-loops.md) and [toyvm-spin-loops.md](/docs/toyvm-spin-loops.md) fold the loop shapes demos are made of, and `REP` string operations widen to `memory.copy`/`memory.fill` under hoisted guards, a 9x on one copper-bar demo.
3. **A region JIT**: [toyvm-trace-jit.md](/docs/toyvm-trace-jit.md) and [toyvm-trace-blocks.md](/docs/toyvm-trace-blocks.md) describe compiling hot regions of guest code into fresh WebAssembly functions at runtime. Across the twenty-program benchmark in [toyvm-bench-20.md](/docs/toyvm-bench-20.md) the region JIT is about 36% faster than the interpreter on average, with detours around self-modifying code that the design had to learn to tolerate.

Self-modifying code is the DOS-specific complication. Demos patch their own inner loops, so a compiled region can be invalidated by the code it is running. The toy VM handles that with *operand repair*, re-reading the patched immediate rather than throwing the region away, and a plan cache so a region rebuilt after a patch is found again.

## What transferred back

The findings were written to be applied to the main emulator, and two already have been:

- **Dispatch is not a clock.** A region folds a whole loop into one dispatch, so anything paced by dispatch counts (timers, retrace, the batch clock) drifts under a JIT. Guest-visible time has to be re-derived from guest events. The main emulator's headless clock had the same defect in a different costume.
- **Profile attribution must be per block.** A profiler that credited a region's time to its arena span showed a winning region at 0.0%; the fix was to record extent and targets per block.

The next step, applying the region JIT design to the main emulator's threaded code, is being measured in [repl-tailcall-main-emu.md](/docs/repl-tailcall-main-emu.md), and is the item the story names as the likely next inflection point.

## Further reading

- [How the x86 interpreter is built](/articles/x86-interpreter-in-webassembly-text.html) for the main machine's dispatch design.
- [Lazy flags](/articles/lazy-flags-x86-emulator.html) for the toy VM's flag experiments.
- [The story](/story.html), Act XV, "A second machine".
