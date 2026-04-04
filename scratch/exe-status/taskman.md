# taskman.exe (Task Manager) - Win98

**Status:** FAIL
**Crashes on:** memory access out of bounds after SetWindowLongA (window subclass)
**Batch reached:** 0

## Crash Details

Taskman creates its dialog window (hwnd 0x10001), a child listbox (0x10002), then a listview child (0x10003). When subclassing the listview with SetWindowLongA(GWL_WNDPROC), the old wndproc is returned. The app continues execution and shortly after crashes with "memory access out of bounds".

EIP at crash: 0x004015e6 (within the dialog initialization code)
EIP before batch: 0x00403680 — `fs: mov eax, [0x0]` (SEH frame setup)
EAX=0xfffe0001 (suspicious return value from wnd_table_get)

The crash appears to happen during the threaded code execution of a large batch that includes SEH frame setup and dialog init code. The root cause is likely an address that maps outside WASM linear memory.

## API Call Sequence (256 calls before crash)

- DialogBoxParamA, DragAcceptFiles
- GetWindowLongA/SetWindowLongA (GWL_USERDATA, GWL_WNDPROC)
- CreateWindowExA x3 (dialog, listbox, listview child)
- GetDlgItem, GetWindowLongA(GWL_STYLE)
- SetWindowLongA(0x10003, GWL_WNDPROC, 0x0040150c) — subclass listview
- **CRASH** during continued execution

## Difficulty: Hard

Complex interaction between window subclassing, SEH frame setup, and the dialog initialization sequence. Needs careful debugging of the batch execution to find the exact OOB access.
