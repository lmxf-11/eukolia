# Vendored light-pdf sources

This directory holds code copied from `References/light-pdf` (the LightPDF
project) and compiled into `resources/native/eukolia-pdf.exe`.

Instructions.md §2/§4/§6/§15 require the reference projects to be **copied and
adapted, not reimplemented**, and specifically that light-pdf's PDF
implementation form the foundation of the integrated PDF viewer. The modules
below are that foundation: `TextSelection.cpp`, `TextSearch.cpp` and
`DocumentLayout.cpp` are compiled **unchanged** and are the *only*
implementation of text selection, text search and continuous-scroll page
placement in the worker. Nothing in `src/` re-implements them any more.

The one thing that could not be copied is light-pdf's `EngineMupdf.cpp` -- its
`EngineBase` implementation is welded to the Windows viewer (display lists,
dark-mode profiles, annotation editing, printing, HBITMAP-backed
`RenderedBitmap`s). `engine_mupdf_adapter.{h,cpp}` is the seam that replaces it,
implementing exactly the `EngineBase` surface the three copied modules use, on
top of mupdf's public C API.

---

## 1. What was copied

### 1a. Verbatim

These files are byte-for-byte identical to the reference. Nothing was renamed,
reformatted or restructured.

| file | lines | what it is |
| --- | --- | --- |
| `EngineBase.h` | 511 | light-pdf's engine interface (page geometry, `Transform`, `PageText`, …) |
| `EngineBase.cpp` | 610 | its default implementation: page-text caching, `TocItem`/`TocTree`, `FreePageText`, `RenderPageArgs`, `GetProperties` |
| `DocumentLayout.h` | 49 | continuous-scroll page-placement model |
| `DocumentLayout.cpp` | 289 | `Relayout()`: zoom resolution (incl. fit-page/fit-width/fit-content), rotation, column packing for facing/book view, centring, R2L mirroring, `RecalcVisibleParts()` |
| `TextSelection.h` | 46 | |
| `TextSelection.cpp` | 468 | `FindClosestGlyph`, `FillResultRects`, `GetWordBoundsAt` (incl. the comma/decimal number-group handling), `SelectWordAt`, `SelectLineAt`, `SelectWordsUpTo`, `ExtractText` |
| `TextSearch.h` | 55 | |
| `TextSearch.cpp` | 701 | case folding (`CharLowerW`, dotted-`İ`, `ß`↔`ss`), whitespace/hyphen/quote normalisation, `MatchEnd`, `FindFirst`/`FindFirstOnPage`/`FindNext` |
| `DisplayMode.h` | 13 | |
| `DisplayMode.cpp` | 124 | `IsSingle`/`IsContinuous`/`IsFacing`/`IsBookView`/`IsValidZoom` (used by `DocumentLayout.cpp`) |
| `DocController.h` | 136 | pulled in by `TextSelection.cpp`/`TextSearch.cpp` |
| `TreeModel.h` | 38 | ditto |
| `ProgressUpdateUI.h` | 18 | ditto |
| `DocProperties.h` / `DocProperties.cpp` | 78 / 149 | `DocProp` + the property list `EngineBase.cpp` iterates |
| `CrashHandlerNoOp.cpp` | 12 | the no-op `_uploadDebugReport()` the `ReportIf()` macro calls |
| `base/Base.h` † | 752 | string/container/thread/arena foundation |
| `base/Str.h`, `Str.cpp` | 263 / 2338 | `Str`, `WStr`, `str::*`, `str::Builder` |
| `base/StrUtf8.h`, `StrUtf8.cpp` | 25 / 498 | `Utf8Codepoint*`, `Utf8SliceByCodepoints`, `CWStrTemp` |
| `base/StrFormatParse.h`, `StrFormatParse.cpp` | 139 / 913 | `fmt()`, `ParseInt`, `SeqStrings` |
| `base/StrVec.h`, `StrVec.cpp` | 85 / 760 | `StrVec`, `JoinTemp` |
| `base/Strconv.h`, `Strconv.cpp` | 21 / 221 | `ToWStrTemp`/`ToUtf8Temp` |
| `base/Vec.h` | 350 | `Vec<T>` (`Append`, `SetSize`, `Take`, …) |
| `base/Geom.h`, `Geom.cpp` | 126 / 390 | `Rect`, `RectF`, `Point`, `Size`, `Round`, `Intersect`, `Union`, `NormalizeRotation` |
| `base/Arena.h`, `Arena.cpp`, `Arena_win.cpp` | 126 / 469 / 45 | the reserve/commit arena behind `GetTempArena()` |
| `base/Thread.h`, `Thread.cpp` | 95 / 170 | `Mutex`, `ScopedMutex`, `StartThread`, `AtomicInt*` |
| `base/Scoped.h` | 123 | `ScopedMem`, `AutoDelete`, `AutoCall` |
| `base/Color.h`, `Color.cpp` | 48 / 234 | `kColorUnset` and friends |
| `base/Log.h`, `LogNoOp.cpp` | 19 / 5 | `log()`/`loga()` and `logf`/`logfa` |
| `base/ScopedWin.h`, `Win.h`, `WinDynCalls.h` | — | included by `base/Thread.cpp` (and by the light-pdf files in §3) |
| `base/Pixmap.h` | 112 | the platform-independent bitmap `RenderPage()` returns |
| `base/File.h` | 124 | included by `EngineBase.cpp`; declares the `file::`/`path::` layer (see §3) |
| `base/BuildConfig.h`, `BuildConfig_default.h` | 0 / 17 | `Base.h` includes `BuildConfig.h` |
| `base/FileWatcher.h` | 10 | included by `base/Base.cpp` |

† see §2 for three lines inside it.

### 1b. Not copied

| file | why |
| --- | --- |
| `EngineMupdf.cpp` / `.h` | welded to the Windows viewer (HWND/HDC/HBITMAP, dark mode, annotations, printing, DDE). Replaced by `engine_mupdf_adapter.*`. |
| `Settings.h` (75 KB, generated) | only four symbols from it are used; replaced by a small compatibility header (see §2). |
| `DocController.cpp`, `TreeModel`'s consumers, `base/Win.cpp`, `base/File*.cpp`, `base/DirIter*`, `base/DirScan*`, `LightPDF.h`, `wingui/*` | not needed, or Win32 UI/shell code. |

---

## 2. Files that had to change (all inside this directory)

Everything here is marked in place with `// Eukolia: <reason>`.

| file | change |
| --- | --- |
| `base/Base.h` (line 114) | wrapped `#define NOMINMAX` in `#ifndef NOMINMAX`. libstdc++'s `<bits/os_defines.h>`, pulled in by the `<stdlib.h>` include a few lines above, already does `#undef NOMINMAX` / `#define NOMINMAX 1` on MinGW, so the plain `#define` made GCC warn in all 27 translation units. **Semantics unchanged** (NOMINMAX stays defined for the `<windows.h>` include below it). |
| `base/Base.h` (line 376) | wrapped `#define FORCEINLINE …` in `#ifndef FORCEINLINE`. MinGW's `<winnt.h>` (included through `<windows.h>` above) already defines `FORCEINLINE` as `__forceinline`, which on GCC expands to `__inline__ __attribute__((always_inline))` — exactly this definition. **Semantics unchanged.** |
| `base/Log.h` | added the missing final newline. A file whose last logical line ends at EOF without a newline made GCC warn (`backslash-newline at end of file`) in every translation unit. |

No line of any copied algorithm was touched.

### New files in this directory (Eukolia-written)

| file | why |
| --- | --- |
| `Settings.h` | compatibility header. The generated 75 KB `Settings.h` is the whole application's settings schema; the copied modules use exactly the `DisplayMode` enum, the `kZoomFit*`/`kZoomMin`/`kZoomMax` sentinels (`DocumentLayout.cpp`) and `FileState` (`DisplayMode.cpp`'s `ZoomToString`). The header carries those declarations verbatim, with `FileState` reduced to the three fields `ZoomToString()` reads. |
| `eukolia_win32_compat.h` | one MinGW-w64 13.2 SDK gap: `SetThreadDescription` (Windows 10 1607+) is absent from its headers entirely, while light-pdf's unmodified `base/WinDynCalls.h` takes `decltype(SetThreadDescription)`. Force-included ahead of the vendored translation units so no vendored header has to change. |
| `eukolia_base_io_compat.cpp` | three functions from light-pdf's file layer — see §3. |
| `engine_mupdf_adapter.h` / `.cpp` | the `EngineBase` implementation over mupdf — see §4. |

---

## 3. The one dependency that was cut at the point of use

light-pdf's file/path layer is implemented twice: `base/File.cpp` (portable
helpers) plus `base/File_win.cpp` or `base/File_posix.cpp`. Neither OS half is
usable here:

* `base/File_win.cpp` sits on `base/Win.cpp` — light-pdf's entire Win32 shell
  layer (registry, DDE, printing, clipboard, window management, Gdiplus). It is
  ~130 KB of code that a headless PDF worker must not carry, and it does not
  compile outside light-pdf's own MSVC configuration (it needs the Windows SDK's
  `ddeml.h`/`winspool.h` and a `UNICODE` build; with those supplied, 39 further
  errors remain in its ANSI/WCHAR mixing).
* `base/File_posix.cpp` needs `<sys/mman.h>`, which MinGW-w64 does not ship.

Exactly three entry points of that layer are reachable from the copied modules,
and none is part of any PDF algorithm:

| symbol | referenced by |
| --- | --- |
| `file::WriteFile(Str, Str)` | `EngineBase::SaveFileOrData()` |
| `file::Copy(Str, Str, bool)` | `EngineBase::SaveFileOrData()` |
| `path::GetExtTemp(Str)` | `DisplayMode::ZoomToString()` |

They live in `eukolia_base_io_compat.cpp`. `WriteFile`/`Copy` are thin wrappers
over the same Win32 calls `base/File_win.cpp` uses (`CreateFileW` with
`CREATE_ALWAYS` + `WriteFile`; `CopyFileW` with the fail-if-exists flag), so their
behaviour is identical, and `GetExtTemp` is a copy of `base/File.cpp`'s
`GetExtPos()`/`GetExtTemp()`. **No PDF, text, selection, search or layout
algorithm was reimplemented.**

The adapter's own `GetFileData()`/`SaveFileAs()` (which have no caller in this
worker — the render path does not go through `EngineBase`) use `<fstream>`
rather than light-pdf's file layer, for the same reason.

---

## 4. `engine_mupdf_adapter` — the `EngineBase` implementation

`EngineMupdfAdapter : EngineBase` implements every pure virtual of the copied
`EngineBase.h` on top of the worker's `eukolia::PdfEngine` (which owns the
`fz_context`, the document, the page cache and the display lists):

| member | implementation |
| --- | --- |
| `PageMediabox` | `PdfEngine::MediaBox` |
| `PageContentBox` | `PdfEngine::PageContentBox` (bbox device over the display list) |
| `Transform` | light-pdf's `FzCreateViewCtm()` + `fz_transform_rect`, copied verbatim from `EngineMupdf.cpp` |
| `ExtractPageText` | light-pdf's `ExtractPageTextLocked()`: build the structured-text page with `NewTextPageOptions()` (`FZ_STEXT_ACCURATE_BBOXES`), then `FzTextPageToUtf8()`. The glyph walk (`AddCharUtf8`, `AddLineSepUtf8`, `HasSeenGlyph`) is copied verbatim. |
| `RenderPage` | real render through `PdfEngine::RenderPage` into a light-pdf `Pixmap` (`AllocPixmap`, BGRA8/BGR8, row-copied). No caller today: the task freezes the worker's tile/render path, which does not go through `EngineBase`. `FreeRenderedPixmap()` is the matching release (light-pdf's `FreePixmap()` also handles GDI DIB-backed pixmaps through the unlinked `Win.cpp`; every pixmap produced here is plain malloc-backed). |
| `GetFileData` / `SaveFileAs` | `<fstream>` (see §3) |
| `HasClipOptimizations` | light-pdf's "an image covers ≥ 90 % of the page" test, using mupdf's `FZ_STEXT_BLOCK_IMAGE` boxes for the image list |
| `GetPropertyTemp` | the worker's PDF `/Info` metadata (already loaded at open time) |
| `GetElements` / `GetElementAtPos` | the page's links as `PageElementDestination`s (`NewSimpleDest` for internal targets, `PageDestinationURL` for external ones), owned by the adapter — light-pdf's own ownership model |
| `BenchLoadPage` | loads the page and reports whether it has a usable MediaBox |
| `Clone` | a second adapter over the same open document, with the scalar engine state copied. The page-text cache starts empty, as in `EngineMupdf::Clone()`. |
| `kindEngineMupdf` | defined here (`EngineBase.h` declares it `extern`; every engine implementation defines its own). |

Left at light-pdf's own `EngineBase` defaults (not stubs — these are
light-pdf's documented base implementations): `TryExtractPageText`,
`RequestTextExtraction`/`TryGetTextForPage`, `GetNamedDest`, `GetToc`,
`GetPageLabeTemp`, `GetPageByLabel`, `HandleLink`, `GetImageForPageElement`,
`GetBitmapRecolorSkipRects`.

### Extraction details worth knowing

* The structured-text device is run with the page's **content→page** matrix, not
  `fz_identity`. light-pdf's `fz_new_stext_page_from_whole_page()` uses identity
  because in light-pdf the page's own transform is applied by `fz_run_page()`
  internally; here the matrix is passed explicitly so that every box lands in the
  same space the rendered pixels use. The worker's render path and the frozen
  renderer overlays depend on that space, so the convention is preserved exactly.
* `AddCharUtf8()` is light-pdf's, with one hardening: when mupdf's
  `fz_runetochar()` refuses an invalid scalar value, light-pdf's walk would drop
  the character while still recording a box, breaking the "one box per codepoint"
  invariant the whole selection/search model indexes against. The adapter emits
  U+FFFD instead (marked in the source). Likewise a glyph box carrying mupdf's
  infinity sentinels is normalised to the canonical empty rectangle, the same
  value light-pdf uses for a line separator.
* `TextSelection`/`TextSearch` allocate `TempStr`s; the worker resets the
  thread-local temp arena once per text task, which is light-pdf's message-loop
  behaviour.

---

## 5. How the worker uses this (`src/worker_main.cpp`)

Deleted (all hand-written, all replaced by the copied modules):

* the UTF-8 helpers `Utf8Decode`/`Utf8CodepointToByteIndex`, `IsWhitespaceRune`,
  `IsWordChar`, `FoldCaseForSearch`, `IsSharpS`/`IsLatinS`, `MatchSearchUnit`,
  `StrStr`/`StrStrFoldCase`/`StrRStr`/`StrRStrFoldCase`, `SkipWhitespace`,
  `IsNonCjkWordChar` → **`TextSearch.cpp`**
* `FindClosestGlyph`, `FillResultRects`, `GetWordBoundsAt`, `SelectionRect` →
  **`TextSelection.cpp`**
* `SearchEngine` (the whole `MatchEnd`/`SetText`/`FindAll` struct) →
  **`TextSearch.cpp`**
* `IsLineBreakCoord` and the flat-glyph half of `PdfEngine::BuildPageText`
  (`SeenGlyph`, `HasSeenGlyph`, `AppendGlyph`, `AddChar`, the line-separator
  emission) → **`engine_mupdf_adapter.cpp`** as light-pdf's `FzTextPageToUtf8()`
* `PdfEngine::TextForPage()` / `ClearTextCache()` and the worker's own text cache
  → `EngineBase::GetTextForPage()`, i.e. light-pdf's cache

Kept, unchanged in behaviour: the stdio framing, request ids, cancellation, the
render cache and tile rendering, links, outline, `pageContentBox`, `fontList`,
the SyncTeX bridge and the TypeScript contract in `src/shared/ipc.ts`.

Rewired handlers:

| command | now goes through |
| --- | --- |
| `text` | `EngineBase::GetTextForPage()` for the flat text + `PdfEngine::ExtractPageText()` for blocks — one structured-text pass underneath, so the two can never disagree |
| `glyphs` | `EngineBase::GetTextForPage(…, &coords)` → light-pdf `PageText::coords` |
| `select` | `TextSelection::SelectWordAt` / `SelectLineAt` / `StartAt`+`SelectUpTo`, `GetGlyphRange`, `ExtractText`, `result` |
| `search` | `TextSearch::FindFirstOnPage` (light-pdf's page-constrained search) + `FindNext`, `ExtractText` |
| `layout` (new) | `DocumentLayout::Relayout` + `RecalcVisibleParts` + `CurrentPageNo` + `FirstVisiblePageNo` |

`layout` is new on the wire (documented in `PROTOCOL.md`, typed in
`src/main/pdf/workerProtocol.ts` and exposed as
`NativePdfEngine.getLayout()`). It is additive: no existing request or response
shape changed, and `src/shared/ipc.ts` is untouched. The renderer's own
client-side page stacking (`src/renderer/pdf/PdfViewer.tsx`) is **not** switched
over to it, because this task freezes `src/renderer/**`; the worker-side
implementation is complete and reachable through the bridge, but nothing in the
UI consumes it yet.

---

## 6. Build

`scripts/build-native-pdf.mjs` is the build path (and the only one that is
verified): it compiles `src/*.cpp` with `-I src/native/pdf/lightpdf` and the
vendored translation units with `-I …/lightpdf`, `-include eukolia_win32_compat.h`
and a small set of `-Wno-*` flags. Those flags are listed with a per-class
rationale in the script; they exist because the vendored code is written for MSVC
and GCC 13 raises warnings there that MSVC does not (`-Wcast-function-type` on
`GetProcAddress` casts, `-Wclass-memaccess` on `Vec<>`'s `memset`, and so on).
The worker's own translation units keep the full `-Wall -Wextra` set; only
`worker_main.cpp` adds the three flags its inclusion of light-pdf's headers
requires. The build is warning-free.

`src/native/pdf/CMakeLists.txt` (the secondary `--cmake` path) lists the same
sources and flags.

---

## 7. Open items / known limitations

* **Page-number base.** light-pdf's pages are 1-based everywhere
  (`PageMediabox(int pageNo)`); the wire protocol is 0-based. The conversion
  happens at the boundary in `worker_main.cpp`.
* **`GetElements()` covers links only.** light-pdf's `EngineMupdf::GetElements()`
  also returns images and comment annotations; this worker's `PdfEngine` has no
  image/annotation enumeration, so only links are built. Nothing consumes
  `GetElements()` today (the `links` command uses `PdfEngine::Links()`).
* **`RenderPage()` has no caller** — see §4.
* **Coordinate convention.** The worker reports page-space coordinates in the
  same space it has always used, and the copied modules are driven in that space
  (`Transform(rect, pageNo, 1, 0)` is the identity there, exactly as in
  light-pdf at zoom 1 / rotation 0). `PROTOCOL.md` §4 describes that space as
  "top-left origin"; measured against the rendered pixels it behaves as PDF user
  space (y up from the bottom-left of the CropBox, and returned pixmap row 0 at
  y = 0). This is pre-existing behaviour that the frozen renderer overlays rely
  on, so it was preserved bit-for-bit rather than changed here — noted so that
  the discrepancy is not mistaken for something this port introduced.
