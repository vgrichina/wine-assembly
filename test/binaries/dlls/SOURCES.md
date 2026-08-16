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
| mfc30.dll | 335,872 | `07eeb7e8d7b2fdba0a250e0f19a2d5336a0ff83ae70b7b0f8623fb86e066041a` | Windows 98 SE OEM path below; local-only |
| mfc42.dll | 940,304 | `590ee92bc1c9cf0d4a6b40e11c9272db243c59e709f940147c6085f07e297788` | Unverified |
| mfc42u.dll | 995,384 | `5b3b68bb88be968a0c7c24887b437fac6d9081671b8d8376482168383ca30b8b` | Unverified |
| msvcp60.dll | 401,462 | `2b6b93c2d66969eb00258e2b5ad6172decebada096e3b1b077a3380c80e4a072` | Unverified |
| msvcrt20.dll | 274,432 | `9446a83656e24ebf303a2c8c046ef0cce252a789c1becfde3580e9ab614b4316` | Windows 98 SE OEM path below; local-only |
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

## Font Viewer local fixtures from Windows 98 SE OEM

Source: `https://archive.org/details/microsoft-windows-98-second-edition-oem-x05-29232`

Extraction path: `Microsoft Windows 98 Second Edition OEM [X05-29232].iso` >
`WIN98/BASE4.CAB` (a continued cabinet set) > `mfc30.dll`, `msvcrt20.dll`, and
`vgasys.fon`.

The ISO downloaded on 2026-08-13 was 655,591,424 bytes. Its SHA-1
`fa040cd3f7fd472e9612b1721bc72d7b82538450` matched the Internet Archive
metadata. The extracted fixtures are:

| File | Local path | Size | SHA-256 |
|------|------------|-----:|---------|
| `mfc30.dll` | `test/binaries/dlls/mfc30.dll` | 335,872 | `07eeb7e8d7b2fdba0a250e0f19a2d5336a0ff83ae70b7b0f8623fb86e066041a` |
| `msvcrt20.dll` | `test/binaries/dlls/msvcrt20.dll` | 274,432 | `9446a83656e24ebf303a2c8c046ef0cce252a789c1becfde3580e9ab614b4316` |
| `vgasys.fon` | `test/binaries/win98-apps/vgasys.fon` | 7,296 | `8e20e26fa8ee83caa5ba660c38deca1f4ac11186f7724d96d4988917f3c15e2a` |

Reproduce after mounting or extracting the ISO:

```bash
cabextract -F mfc30.dll -F msvcrt20.dll -F vgasys.fon WIN98/BASE4.CAB
shasum -a 256 mfc30.dll msvcrt20.dll vgasys.fon
```

These are stock Windows installation files, not redistributable runtime
packages. They are gitignored local fixtures and must not be added to public
deployment manifests unless redistribution permission is established.

## Win16 system modules from Windows 98 SE OEM (ordinal resolution)

Same ISO as the section above, verified again on 2026-08-16: 655,591,424 bytes,
SHA-1 `fa040cd3f7fd472e9612b1721bc72d7b82538450`.

Every Win16 import is by ordinal — all 269 distinct imports across the four NE
apps in `test/binaries/win98-16bit/` are IMPORTORDINAL, not one is IMPORTNAME —
so `USER.#113` names nothing until the module that exports it says what ordinal
113 is called. These are the modules that say so. They are read by
`tools/ne-exports.js` to produce an ordinal-to-name map; only the *names* end up
in the repository, never these files.

Extraction path: `WIN98/BASE4.CAB` (a continued cabinet set spanning
`WIN98_21.CAB` … `WIN98_74.CAB`; all of them must be present).

| File | Local path | Size | SHA-256 |
|------|------------|-----:|---------|
| `krnl386.exe` | `scratch/win16-system/krnl386.exe` | 127,040 | `fd48ebe1cc8c6558ab26c1c0e7b5492aa8f3a0dc54a2da801ec82ef093a662e7` |
| `user.exe` | `scratch/win16-system/user.exe` | 549,664 | `fe4bedde380982f81e12d73de6a87d65fb21e9dba76f714c74bbd4d4e8bfad53` |
| `gdi.exe` | `scratch/win16-system/gdi.exe` | 345,584 | `cc6c5c227108e7ace5ce72b42f810f718ce8c2413acda9edfe5a6c946678a16f` |
| `ddeml.dll` | `scratch/win16-system/ddeml.dll` | 32,240 | `1452b614c5cdc1ff95436f5ac6d8ec0405b0e0d2abdf2ce0276c5d59280738b4` |
| `mmsystem.dll` | `scratch/win16-system/mmsystem.dll` | 108,528 | `be30ae3d04785a31c71acb4113ebf7d3875d20cb8409adb4c74f166720f89557` |
| `commdlg.dll` | `scratch/win16-system/commdlg.dll` | 97,936 | `b962e6787daaa2afb14dc56c854c00159410ac50e2d5ba902b9052ee3080000d` |
| `keyboard.drv` | `scratch/win16-system/keyboard.drv` | 12,688 | `d50964b1e31373f161081227a435deeeca22143b1d0bfde0310a85468e892628` |
| `shell.dll` | `scratch/win16-system/shell.dll` | 41,600 | `667422428e0934d947c9b56d622cffe6acd576f8014ca3692d7639d5457044d6` |

Reproduce after mounting the ISO, from its `win98` directory:

```bash
for f in krnl386.exe user.exe gdi.exe ddeml.dll mmsystem.dll \
         keyboard.drv commdlg.dll shell.dll; do
  cabextract -q -d "$DEST" -F "$f" BASE4.CAB
done
shasum -a 256 "$DEST"/*
```

**One `-F` per invocation.** `cabextract` honours only the last `-F` it is
given, so the multi-`-F` recipe in the section above silently extracts just
`vgasys.fon` — it needs the same loop.

`SOUND.DRV` is deliberately absent: Windows 98 SE does not ship it, MMSYSTEM
having taken over. That leaves six ordinals (`SOUND.#1 #2 #4 #5 #9 #10`, all
from WINMINE) with no module to resolve them against; they need a Windows 3.1
`SOUND.DRV` or per-call-site reverse engineering.

`scratch/` is gitignored, so these are local-only fixtures under the same policy
as the rest of this file: stock Windows installation files, not redistributable.

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
