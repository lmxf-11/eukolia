# Native PDF runtime (vendored)

Everything the native PDF worker needs at run time lives in this directory, so
Eukolia never reads from `References/` (Instructions.md §8).

| File | Origin | Notes |
|------|--------|-------|
| `eukolia-pdf.exe` | built from `src/native/pdf/` | the worker; ~0.9 MB, statically linked libstdc++/libgcc |
| `libmupdf.dll` | `References/light-pdf/out/dbg64/libmupdf.dll` | MuPDF 1.28.0, **debug** build (~20 MB) |
| `mupdf-COPYING.txt` | `References/light-pdf/mupdf/COPYING` | AGPL-3.0 |
| `light-pdf-COPYING.txt` | `References/light-pdf/COPYING` | GPL-3.0 |

Matching copies are kept in `vendor-licenses/` alongside the other reference
projects' licences.

## Rebuilding

```sh
npm run build:native          # or: node scripts/build-native-pdf.mjs
npm run build:native -- --clean --force
```

The build script:

1. vendors `libmupdf.dll` and the MuPDF headers (only with `--vendor`, or on a
   fresh checkout where they are missing) into
   `src/native/pdf/third_party/mupdf/include/` (85 headers, not the 11k-file
   MuPDF source tree);
2. generates a MinGW import library from the DLL with `gendef` + `dlltool`
   (the DLL is an MSVC build, so MinGW cannot link it directly);
3. compiles `src/native/pdf/src/*.cpp` with `g++ -std=c++17 -O2` and links it
   into `resources/native/eukolia-pdf.exe`.

`src/native/pdf/CMakeLists.txt` does the same thing for IDEs and for a normal
MinGW or MSVC installation; `--cmake` uses it. The direct `g++` path is primary
because CMake does not reliably find the Strawberry Perl MinGW toolchain.

The build kills a lingering `eukolia-pdf.exe` before linking and retries if the
output file is locked — Windows holds the image open for as long as the worker
runs, which is the only reason a rebuild ever fails to write the executable.

## About the debug DLL

`libmupdf.dll` here is light-pdf's **debug** build, so `assert()` is live and a
failed assertion opens a modal abort dialog that takes the whole application
down. That is why `src/native/pdf/src/mupdf_engine.cpp` is careful to consume
every caught mupdf error (`ReportCaughtError` / `TakeCaughtMessage`) and why the
worker verifies that the base context's error stack is balanced after every
request.

A release DLL would remove the dialog class entirely, but the only other build
in `References/light-pdf/out/` is `rel32`, which is 32-bit and cannot be linked
into this 64-bit worker. If a 64-bit release build appears, copying it over this
file is all that is needed.

## Shipped-with-the-app layout

`resources/native/` is the runtime directory: the `.exe` and the `.dll` must
stay together, because the executable links `libmupdf.dll` by name.
`src/main/pdf/nativePdfEngine.ts` looks for the directory under
`process.resourcesPath/native`, `process.resourcesPath/app/resources/native`,
and the development tree, so no packaging change is needed beyond copying the
directory into the app resources.
