# DLL Sources

System DLLs used for testing Win32 PE emulation. All extracted from publicly archived Microsoft redistributables on archive.org.

## Not redistributed: shell32.dll / shlwapi.dll / advapi32.dll

Previously extracted from the Win98SE ISO (`win98/BASE4.CAB`) but removed —
policy is to only ship DLLs from freely-redistributable updates / shareware,
not stock Windows install media. These DLLs are instead emulated as "fake
modules" by the WAT runtime: static imports resolve by name via the WAT API
hash table, and dynamic `LoadLibraryA` returns a stub handle that
`GetProcAddress` also resolves by name. No real PE body is needed.

## From IE5 for Win95/Win98 (archive.org)

Source: `https://archive.org/details/ie5_20231127`
File: `ie5.zip` > `SETUPW95.CAB`

| DLL | Size | Date | Notes |
|-----|------|------|-------|
| comctl32.dll | 577,808 | 1999-03-18 | IE5 updated version |

## From IE6 SP1 (archive.org) — NT versions, replaced by Win98 native above

Source: `https://archive.org/details/windows-98systemfiles`
File: `Windows98systemfiles.iso` > `IE6 SP1.zip`

Previously had NT-based shell32.dll (1,720,080 bytes) from `IE4SHLNT.CAB` which imports ntdll.dll — incompatible with Win9x emulation. Replaced with stock Win98SE versions above.

## From Windows Installer 2.0 (archive.org)

Source: `https://archive.org/details/windows-98systemfiles`
File: `Windows98systemfiles.iso` > `Windows Installer 2.0/instmsi.exe`

| DLL | Size | Date | Notes |
|-----|------|------|-------|
| riched20.dll | 431,133 | 2001-08-17 | Rich Edit 2.0 control |
| shfolder.dll | 21,021 | 2001-08-17 | SHGetFolderPath redirector |
| cabinet.dll | 56,080 | 2001-07-21 | Cabinet file extraction |
| imagehlp.dll | 106,013 | 2001-08-17 | PE image helpers |
| usp10.dll | 314,906 | 2001-08-17 | Uniscribe (text shaping) |

## Previously collected

| DLL | Notes |
|-----|-------|
| msvcrt.dll | Microsoft Visual C++ runtime |
| msvcp60.dll | MSVC++ STL library |
| oleaut32.dll | OLE Automation (from `ie6sp1en/OAINST.CAB`) |
| mfc42.dll | MFC 4.2 (ANSI) |
| mfc42u.dll | MFC 4.2 (Unicode) |

## Still needed

| DLL | Notes |
|-----|-------|
| ole32.dll | COM runtime — only in Windows install media (not in any redistributable) |
| rpcrt4.dll | RPC runtime — same |
| gdi32.dll | GDI — core OS, not redistributed |
| user32.dll | USER — core OS, not redistributed |
| kernel32.dll | Kernel — core OS, not redistributed |
| ntdll.dll | NT layer — core OS |

Core OS DLLs (kernel32, user32, gdi32, ntdll) are handled by our WAT emulator directly rather than loaded as real DLLs. ole32.dll (COM) would need to come from a full Windows 98/NT4 installation ISO.
