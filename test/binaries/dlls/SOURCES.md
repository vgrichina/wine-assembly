# DLL Sources

System DLLs used for testing Win32 PE emulation. A source entry is not proof
that a file may be redistributed. Before adding a DLL to a deployment, record
the original download URL, every archive member in the extraction path, the
local file size and SHA-256, and the applicable redistribution terms.

## Local fixture inventory

Files under `test/binaries/dlls/` are gitignored, so documentation changes do
not replace or verify a developer's local copy. The hashes below identify the
fixtures present when this inventory was updated. `Unverified` means that the
repository does not yet contain enough information to reproduce that exact
file; it must not be shipped based on this document.

| DLL | Size | SHA-256 | Source status |
|-----|-----:|---------|---------------|
| cabinet.dll | 56,080 | `cb535e27870708f94f46ecb75bf6a5dff17422c28b9f21c2c80ab7b1fcf1f715` | Windows Installer 2.0 path below |
| cards.dll | 148,528 | `07ed76ebed79520a92e2a2ad5dfdbb230929322e75ef85b053ff54d5a8be6a02` | See `../SOURCES.md` |
| comctl32.dll | 548,624 | `d8c8d415e28b24f544be3f53ec103353ebefc2aa3056380084d058ca13d0f6c5` | Reproduced from the IE6 SP1 path below |
| d3drm.dll | 437,008 | `fd80f3839a035b6b52362735b22eb8d2523d3434bf18afb3e0f1b5ace84357b0` | DirectX 6.0 path below |
| d3dxof.dll | 107,792 | `1f2d0683668b3039d451d88ed449fd9d49371fab3fadb991636cd6bfb0aa6eee` | DirectX 6.0 path below |
| imagehlp.dll | 106,013 | `a01ea2839b8b9676631cc7d5a9e8d6d64c2cae5cfba8d7e74d6e9f4b0e122331` | Windows Installer 2.0 path below |
| mfc42.dll | 940,304 | `590ee92bc1c9cf0d4a6b40e11c9272db243c59e709f940147c6085f07e297788` | Unverified |
| mfc42u.dll | 995,384 | `5b3b68bb88be968a0c7c24887b437fac6d9081671b8d8376482168383ca30b8b` | Unverified |
| msvcp60.dll | 401,462 | `2b6b93c2d66969eb00258e2b5ad6172decebada096e3b1b077a3380c80e4a072` | Unverified |
| msvcrt.dll | 278,581 | `887eb5ce93edb7192ca3e9220f07f9ca0f94db02af5862ebcbdfcb852db99fd1` | Unverified |
| oleaut32.dll | 598,288 | `baeb2f7c1b8be56738d34e1d1ddf8e0eebd3a633215dc1575e14656be38b939d` | IE6 SP1 `OAINST.CAB`; outer archive reproduction pending |
| riched20.dll | 431,133 | `1c2508fb55ddc459d0327f2017471545c87420443391567094e768fb34032da1` | Windows Installer 2.0 path below |
| shfolder.dll | 21,021 | `6f0443a62fd444c4254f902f668543b867a0577504915d22cd75328f73cd4472` | Windows Installer 2.0 path below |
| usp10.dll | 314,906 | `4d8ff1f53c3babf9bfd11b2ebcd44e2698cfe3bc80c6f0cbc64c0d191ea1fc1b` | Windows Installer 2.0 path below |

## Not redistributed: shell32.dll / shlwapi.dll / advapi32.dll

Previously extracted from the Win98SE ISO (`win98/BASE4.CAB`) but removed —
policy is to only ship DLLs from freely-redistributable updates / shareware,
not stock Windows install media. These DLLs are instead emulated as "fake
modules" by the WAT runtime: static imports resolve by name via the WAT API
hash table, and dynamic `LoadLibraryA` returns a stub handle that
`GetProcAddress` also resolves by name. No real PE body is needed.

## From IE6 SP1 (archive.org)

Source: `https://archive.org/details/windows-98systemfiles`
Extraction path: `Windows98systemfiles.iso` > `IE6 SP1.zip` >
`ie6sp1en/SETUPW95.CAB` > `comctl32.dll`

The 548,624-byte local `comctl32.dll` is the file recorded at this path when the
source ledger was introduced in commit `f6d0c6e9` on 2026-04-02. Its PE header
timestamp is 2002-08-29. Commit `00947c35` later documented a 577,808-byte IE5
replacement, but the ignored local binary was not replaced. That IE5 entry did
not describe the file currently present and has therefore been removed.

The extraction was reproduced byte-for-byte on 2026-08-12 with these hashes:

| Artifact | Size | SHA-256 |
|----------|-----:|---------|
| `Windows98systemfiles.iso` | 193,331,200 | `575d07ff2ffec72d042c38670e561a60c750c454c03ebc544e2167d1f0c0a36a` |
| `IE6 SP1.zip` | 81,236,575 | `00289ed84e09a28c114990a10369ac9ecf37dd61da22c33396cebdd7b8230b20` |
| `ie6sp1en/SETUPW95.CAB` | 928,786 | `315fd936b351e77eccb33a0d35b97151bf997dc1180e8be0e3312a82a29c611b` |
| `comctl32.dll` | 548,624 | `d8c8d415e28b24f544be3f53ec103353ebefc2aa3056380084d058ca13d0f6c5` |

The Internet Archive metadata reports SHA-1
`6050522f2456079d24c6ae8fc236e54abed3d9a1` for the ISO; the downloaded ISO
matched it. Reproduce the fixture with:

```bash
curl -L -o Windows98systemfiles.iso \
  https://archive.org/download/windows-98systemfiles/Windows98systemfiles.iso
7z e Windows98systemfiles.iso 'IE6 SP1.zip'
7z x 'IE6 SP1.zip' 'ie6sp1en/SETUPW95.CAB'
cabextract -F comctl32.dll ie6sp1en/SETUPW95.CAB
shasum -a 256 comctl32.dll
```

Redistribution-term verification remains pending. Do not include this DLL in a
public deployment until that is complete. Microsoft documents `Comctl32.dll`
as a Windows component whose versions were distributed with Windows and
Internet Explorer; that fact alone is not a redistribution grant.

## Other files previously extracted from IE6 SP1

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

## From DirectX 6.0 Runtime (archive.org)

Source: `https://archive.org/details/MS_DirectX`
File: `Microsoft_DirectX-6_1999Sep.7z` > `directx.cab`

| DLL | Size | Date | Notes |
|-----|------|------|-------|
| d3dxof.dll | 107,792 | 1999-01-08 | DirectX File (.x) parser, version 4.06.02.0436 — matches d3drm.dll same build. Required for d3drm `.x` mesh loading (Plus!98 Organic Art screensavers). |

`d3drm.dll` (version 4.06.02.0436, same date/build) ships in this same cab and predates this entry; future re-extractions can pull both from here.

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
