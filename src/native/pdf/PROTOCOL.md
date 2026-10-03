# Eukolia native PDF protocol

`resources/native/eukolia-pdf.exe` is a long-lived child process that owns a
MuPDF context, a tiled render cache and a small render thread pool. The Electron
main process talks to it over stdin/stdout with the framing below. It is a
separate process on purpose: no Node/Electron ABI coupling, no `node-gyp`, and a
crash in native code cannot take down the app (Instructions.md §63, §65).

- Framing and frame types: `src/native/pdf/src/protocol.h`
- Worker / dispatcher: `src/native/pdf/src/worker_main.cpp`
- TypeScript transport: `src/main/pdf/nativePdfEngine.ts`
- Wire types: `src/main/pdf/workerProtocol.ts`

Nothing else in Eukolia may depend on this format.

## 1. Framing

```
frame   := uint32 payloadLength | payload
payload := uint8 frameType | uint32 requestId | body
```

- All integers are **little-endian**.
- `payloadLength` counts the bytes **after** itself, i.e. `1 + 4 + len(body)`,
  and is therefore never smaller than 5.
- `body` is UTF-8 JSON for control frames and `[header][blob]` for pixel frames.
- Both ends put stdin/stdout in **binary mode**; no newline translation, no
  `0x1A` termination, no BOM.
- The worker accepts payloads up to `kMaxFrameBytes` (512 MiB). A larger or
  smaller-than-5 length prefix desynchronises the stream permanently, so the
  worker reports an `error` frame and exits with code 2 rather than reading
  garbage. The bridge kills and restarts the worker in that case.
- A malformed **body** (bad JSON, unknown `cmd`, a handler that throws) is
  reported per-request as an `error` frame with the same `requestId` and the
  stream continues. Malformed frames never kill the process silently.

stdout carries frames only. The worker writes nothing else there; mupdf warning
output and crash text go to stderr.

## 2. Frame types

| Value | Name       | Direction | Body |
|-------|------------|-----------|------|
| 1     | `request`  | main → worker | JSON: `{ "cmd": string, ... }` |
| 2     | `cancel`   | main → worker | JSON: `{ "targetRequestId": number }` |
| 3     | `ping`     | main → worker | empty or `{}` |
| 4     | `shutdown` | main → worker | ignored |
| 128   | `response` | worker → main | JSON result, `{ "ok": true, ... }` |
| 129   | `error`    | worker → main | JSON `{ "ok": false, "error": string, "code"?: string }` |
| 130   | `pixels`   | worker → main | `uint32 headerBytes` + JSON header + raw blob |
| 131   | `ready`    | worker → main | JSON capabilities, sent once at startup |
| 132   | `log`      | worker → main | JSON `{ "level": string, "message": string }` |
| 133   | `pong`     | worker → main | JSON `{ "ok": true, "protocolVersion": number }` |

Requests carry a monotonically increasing `requestId` chosen by the caller.
**Responses may arrive out of order**, because renders complete on render threads
and text work completes on the task thread; the caller matches by `requestId`.
`ready`, `log` and stream-level errors use `requestId` 0.

## 3. Startup

The worker emits `ready` before it reads any request:

```json
{
  "ok": true,
  "protocolVersion": 1,
  "engine": "eukolia-mupdf",
  "mupdfVersion": "1.28.0",
  "renderThreads": 4,
  "maxTileSize": 768,
  "commands": ["open", "close", "info", "render", "cancel", "viewport", "tiles",
               "stats", "text", "glyphs", "search", "select", "links", "outline",
               "pageContentBox", "fontList"]
}
```

The bridge refuses to use a worker whose `protocolVersion` differs from
`PROTOCOL_VERSION` in `workerProtocol.ts`.

## 4. Coordinate conventions

- Every coordinate in a response is **PDF points with a top-left origin**.
  Page `(0, 0)` is the top-left corner of the page's rotated MediaBox.
- `page` in a request is a **0-based page index**. Out-of-range indices are an
  `invalid_argument` error.
- `scale` is the device scale: `scale = 1` renders one pixel per PDF point, so a
  US-Letter page at scale 2 is 1224 × 1584 pixels.
- `rotate` is an extra rotation applied **on top of** the page's own `/Rotate`,
  which MuPDF has already baked into the MediaBox. It must be a multiple of 90.
- The `view` object in a render response carries the affine matrix the worker
  used (`a b c d e f`) plus `width`/`height` (the rotated MediaBox) and
  `pageRotate`/`userRotate`, so the renderer can map pointer positions into page
  space without duplicating the matrix logic. It is
  `scale(scale) * rotate(pageRotate + userRotate)` followed by the MediaBox
  translation for 90°/180°/270°, exactly as light-pdf's `FzCreateViewCtm` does.

## 5. Error codes

| `code` | Meaning |
|--------|---------|
| `invalid_argument` | missing or malformed parameter (unknown page, empty clip, bad tile) |
| `not_open` | no document is loaded |
| `no_text` | the page has no extractable text (image-only page, or a decode failure) |
| `busy` | the render queue is full, the scale is out of range, or too many text tasks are queued |
| `bad_request` | the request body was not valid JSON |
| `unknown_command` | unrecognised `cmd` |
| `internal` | a handler threw; the worker keeps running |
| `not_found` (bridge only) | the file does not exist |

An `open` failure for an encrypted document is **not** an error state: the worker
answers with an `error` frame carrying `needsPassword: true` and no document is
exposed. Call `open` again with `password` to retry. A failed `open` replaces any
previously open document.

## 6. Commands

### `open`

```json
→ { "cmd": "open", "path": "C:/x/main.pdf", "password": "" }
← { "ok": true, "path": "...", "pageCount": 7,
    "pages": [ { "index": 0, "width": 595.28, "height": 841.89, "rotate": 0 }, ... ],
    "outline": [ ... ], "metadata": { "title": "...", "format": "PDF 1.4" },
    "engine": "eukolia-mupdf" }
```

`pages` is in page order; `index` is the 0-based page number. `width`/`height`
are the rotated MediaBox in points. `outline` is the nested tree described below.
`metadata` uses lowercase keys (`title`, `author`, `subject`, `keywords`,
`creator`, `producer`, `creationDate`, `modDate`, plus `format` and `encryption`
from MuPDF). Opening a document discards the render cache.

Outline node shape:

```json
{ "title": "1 Introduction", "page": 1, "uri": null, "open": true, "children": [] }
```

`page` is 1-based or `null` when the target is not a page (external URI or an
unresolvable destination). `uri` is `null` when there is none.

### `close`

```json
→ { "cmd": "close" }
← { "ok": true }
```

Drops the document, the text cache and the render cache.

### `info`

```json
→ { "cmd": "info" }
← { "ok": true, "path": "...", "pageCount": 7, "pages": [...],
    "metadata": { ... }, "engine": "eukolia-mupdf" }
```

### `render`

```json
→ { "cmd": "render", "requestId": 42, "page": 0, "scale": 1.5, "rotate": 0,
    "invert": false, "format": "bgra", "allowCache": true,
    "clip": { "x": 0, "y": 0, "width": 300, "height": 200 } }
→ { "cmd": "render", "requestId": 43, "page": 0, "scale": 1.5,
    "tile": { "res": 1, "row": 0, "col": 1 } }
```

Either `clip` (a page-space rectangle) or `tile` may be given; when neither is,
the whole MediaBox is rendered. `format` is `"bgra"` (default, 4 channels) or
`"gray"` (1 channel). `invert` renders a light-on-dark page.

`requestId` is **repeated inside the body** as well as in the frame header: it is
the id used by `cancel` and the id the response echoes, and keeping it in the
body makes a captured frame self-describing. The frame header's `requestId` is
the same value.

The response is a `pixels` frame whose body is
`uint32 headerBytes | header JSON | raw blob`:

```json
{ "ok": true, "page": 0, "width": 894, "height": 1263, "stride": 3576,
  "channels": 4, "order": "bgra", "scale": 1.5, "rotate": 0, "fromCache": false,
  "pageRect": { "x": 0, "y": 0, "width": 595.28, "height": 841.89 },
  "view": { "width": 595.28, "height": 841.89, "pageRotate": 0, "userRotate": 0,
            "a": 1.5, "b": 0, "c": 0, "d": 1.5, "e": 0, "f": 0 },
  "blobBytes": 4514976 }
```

- `stride` is the row pitch in bytes; rows may be padded, so use it rather than
  `width * channels`.
- `blobBytes` must equal the blob length; the bridge treats a mismatch as a
  protocol error.
- `pageRect` is the page-space rectangle the pixels actually cover. MuPDF snaps
  the clip outwards to pixel boundaries, so this can be slightly larger than the
  requested clip — use the reported value for placement.
- `order` is `bgra`, `bgr` or `gray`. BGRA matches what Chromium's `ImageData`
  wants, so a BGRA blit needs no per-pixel conversion.
- `fromCache` is `true` when the cache served the request without rasterising.

When `allowCache` is false the render is queued even if a cached bitmap exists.

### `cancel`

```json
→ { "cmd": "cancel", "targetRequestId": 42 }
← { "ok": true, "cancelled": 42 }
```

Also available as a `cancel` **frame** (type 2) for low-latency cancellation
without a JSON request/response round trip.

Semantics: a queued render is removed from the queue immediately and the caller
gets no `pixels` frame for it. An in-flight render is **not** interrupted — mupdf
cannot be stopped safely mid-display-list — so it runs to completion and its
result is stored in the cache but never streamed. Callers must therefore tolerate
a response for a cancelled id, or simply ignore it. The bridge rejects rather
than resolves such a call when the id was already removed, and the renderer is
expected to discard any result whose `requestId` it no longer cares about.

### `viewport`

Tells the cache which pages are wanted so obsolete queued work is dropped and
prefetch is prioritised (Instructions.md §36/§38).

```json
→ { "cmd": "viewport", "visiblePages": [3, 4], "adjacentPages": [2, 5],
    "nearbyPages": [0, 1, 6, 7], "scale": 1.5, "rotate": 0,
    "invert": false, "format": "bgra", "prefetch": true }
← { "ok": true, "queued": 9, "cacheEntries": 4, "cacheBytes": 24117248,
    "queuedTotal": 9 }
```

`queued` is how many prefetch tiles this call added. Prefetch jobs render into
the cache only; nothing is streamed back for them. Priority is
`visible > adjacent > nearby`, and within a level the most recent request wins.

### `tiles`

```json
→ { "cmd": "tiles", "page": 0, "scale": 1.5, "rotate": 0, "targetTileSize": 768 }
← { "ok": true, "page": 0, "res": 1,
    "tiles": [ { "res": 1, "row": 0, "col": 0,
                 "rect": { "x": 0, "y": 420.94, "width": 297.64, "height": 420.94 } }, ... ] }
```

Tiles are `2^res × 2^res` in a grid over the MediaBox. Row 0 is the **bottom**
row in PDF user space, matching light-pdf's `GetTileRect`. `res` is chosen by
light-pdf's formula (geometric mean of the axis factors, halved for fit
mode / small pages), so a page that fits the target size returns a single
`res: 0` tile.

### `stats`

```json
← { "ok": true, "cacheEntries": 3, "cacheBytes": 24117248, "queued": 0,
    "active": 0, "servedFromCache": 12, "rendered": 5, "aborted": 1,
    "evicted": 0, "pendingTextTasks": 0 }
```

### `layout`

Continuous-scroll page placement, run by light-pdf's `DocumentLayout`
(`Relayout`, `RecalcVisibleParts`, `CurrentPageNo`, `FirstVisiblePageNo`).

```json
→ { "cmd": "layout", "displayMode": "continuous", "startPage": 1,
    "viewPortWidth": 900, "viewPortHeight": 700, "viewPortX": 0, "viewPortY": 0,
    "zoomVirtual": 100, "dpiFactor": 1, "rotation": 0, "displayR2L": false,
    "usePageZooms": false,
    "marginTop": 6, "marginRight": 6, "marginBottom": 6, "marginLeft": 6,
    "pageSpacingX": 6, "pageSpacingY": 6 }
← { "ok": true, "pageCount": 3, "zoomReal": 1, "currentPage": 1, "firstVisiblePage": 1,
    "canvas": { "width": 900, "height": 2400 },
    "viewPort": { "x": 0, "y": 0, "width": 900, "height": 700 },
    "pages": [ { "index": 0, "shown": true, "visibleRatio": 0.88, "zoomReal": 1,
                 "pos": { "x": 144, "y": 6, "width": 612, "height": 792 },
                 "pageOnScreen": { "x": 144, "y": 6, "width": 612, "height": 792 } } ] }
```

Every field except `index` mirrors a `DocumentLayoutPage` field. `displayMode` is
`single`, `continuous` (the default), `facing`, `book`, `continuousFacing` or
`continuousBook`. `zoomVirtual` is a percentage, or one of the zoom sentinels:
`-1` fit page, `-2` fit width, `-3` fit content, `-4` shrink to fit, `-5` fit by
orientation. `pages[].index` is 0-based, like every other page field on the wire.
`pos` is in canvas space; `pageOnScreen` is `pos` translated by the viewport
origin.

### `text`

```json
→ { "cmd": "text", "page": 0 }
← { "ok": true, "page": 0, "width": 595.28, "height": 841.89, "text": "...",
    "blocks": [ { "bbox": {...},
                  "lines": [ { "bbox": {...},
                               "spans": [ { "text": "...", "font": "NimbusRomNo9L-Regu",
                                            "size": 10, "bbox": {...} } ] } ] } ] }
```

`text` is the whole page as one string with `\n` between visual lines; it is
light-pdf's `PageText` (`EngineBase::GetTextForPage`). Blocks and lines come from
MuPDF's structured text; `font` is the PostScript face name and `size` the glyph
size in points. Both are built from one structured-text pass with
`FZ_STEXT_ACCURATE_BBOXES` (as light-pdf does) so boxes hug the visible glyphs.

Returns `no_text` for a page with no text.

### `glyphs`

Same as `text` plus a flat per-codepoint array, which is what hit testing and
selection need:

```json
← { "ok": true, "page": 0, "width": ..., "height": ..., "text": "...",
    "glyphs": [ { "x": 72, "y": 96, "width": 5, "height": 8 },
                { "lineBreak": true }, ... ] }
```

`glyphs` has exactly one entry per codepoint of `text`, taken from light-pdf's
`PageText::coords`. A `lineBreak` entry is a zero rectangle: the `\n` separators
`AddLineSepUtf8()` appends, and (as in light-pdf) any whitespace glyph MuPDF
reports without a box. Boxes are integers, because that is what light-pdf stores.

### `search`

```json
→ { "cmd": "search", "query": "group", "matchCase": false, "wholeWord": false,
    "forward": true, "maxResults": 512, "page": 0 }
← { "ok": true, "query": "group", "pageCount": 7,
    "matches": [ { "page": 0, "text": "Group",
                   "rects": [ { "x": 90.5, "y": 118.2, "width": 28.9, "height": 8.9 } ] } ],
    "truncated": true }
```

- Omit `page` and `pages` to search the whole document; give `page` for a single
  page or `pages: [first, last]` for an inclusive range. A page-scoped search
  never wraps to other pages.
- Matching is light-pdf's `TextSearch` itself: case folding through
  `CharLowerW` (locale-independent, with the Turkish dotted-`İ` fix), `ß` ↔ `ss`
  equivalence, whitespace runs treated as equivalent, a page break treated as a
  space, `-` also matching en/em dashes, and `'` / `"` also matching their
  typographic forms. Each page is started with `FindFirstOnPage()` and advanced
  with `FindNext()`.
- A literal leading or trailing space in `query` implies word-start / word-end
  matching (light-pdf's convenience behaviour); `wholeWord: true` forces both.
- Each match reports one rectangle **per visual line it spans**, so a match that
  wraps produces several rects.
- `truncated` is `true` when `maxResults` was reached and more matches may exist.
- Text work runs on a dedicated thread, so a document-wide search never blocks
  request intake or render completions.

### `select`

```json
→ { "cmd": "select", "page": 0, "mode": "range",
    "startX": 72, "startY": 100, "endX": 300, "endY": 140 }
→ { "cmd": "select", "page": 0, "mode": "word", "x": 120, "y": 100 }
→ { "cmd": "select", "page": 0, "mode": "line", "x": 120, "y": 100 }
← { "ok": true, "page": 0, "startGlyph": 12, "endGlyph": 48, "text": "...",
    "startPage": 0, "endPage": 0,
    "rects": [ { "x": 72, "y": 96, "width": 210, "height": 9 } ] }
```

This is light-pdf's `TextSelection`: `mode` maps onto `SelectWordAt()` (double
click), `SelectLineAt()` (triple click) and `StartAt()`/`SelectUpTo()` (drag);
the rectangle set is `TextSelection::result`, and `text` is
`ExtractText("\n")`. Coordinates are page-space points. Clicking the right half
of a glyph starts the selection at the following one, exactly as the reference
does.

`startGlyph`/`endGlyph` are the ordered glyph range of the selection
(`GetGlyphRange`), and `startPage`/`endPage` are its 0-based page range
(`-1`/`-1` when nothing was selected).

### `links`

```json
→ { "cmd": "links", "page": 0 }
← { "ok": true, "page": 0,
    "links": [ { "rect": {...}, "uri": "#page=3", "page": 3,
                 "targetX": 0, "targetY": 0, "targetZoom": 0 },
               { "rect": {...}, "uri": "https://example.com", "page": null } ] }
```

`page` is 1-based for internal targets and `null` for external ones (where the
`uri` is the thing to open). `targetX`/`targetY`/`targetZoom` are present only
for resolved internal targets.

### `outline`

```json
→ { "cmd": "outline" }
← { "ok": true, "outline": [ { "title": "...", "page": 1, "uri": null,
                               "open": true, "children": [] } ] }
```

### `pageContentBox`

```json
→ { "cmd": "pageContentBox", "page": 0 }
← { "ok": true, "page": 0, "rect": { "x": 72, "y": 96, "width": 451, "height": 650 } }
```

The bounding box of everything actually drawn on the page, intersected with the
MediaBox. Port of light-pdf's `PageContentBox` (a bbox device run over the cached
display list).

### `fontList`

```json
→ { "cmd": "fontList", "firstPage": 0, "lastPage": 6 }
← { "ok": true, "fonts": ["NimbusRomNo9L-Regu", "NimbusRomNo9L-Medi"] }
```

Derived from the structured text of the requested pages, since MuPDF's font-list
helper is not exported by the vendored build.

### Diagnostics

Two commands exist for development and for the test suite. They are always
compiled in (they cost nothing) and are not part of the renderer contract.

**`stats`** (above) reports the render cache, queue and outstanding text tasks.

**`debugErrorState`** reports the base context's mupdf error stack:

```json
← { "ok": true, "stackDepth": 0, "errcode": 0, "stackCapacity": 256 }
```

`stackDepth` must always be `0`. The worker checks it after every request and
emits a `log` frame if it changed, because a leaked frame is what eventually
trips `assert(ctx->error.top == ctx->error.stack_base)` in `fz_drop_context` —
and in the debug `libmupdf.dll` that ships in `resources/native`, that assert is
a modal abort dialog that takes the whole application down.

**`debugText`** dumps raw glyph boxes and the page transform:

```json
→ { "cmd": "debugText", "page": 2 }
← { "ok": true, "page": 2, "mediaBoxW": 612, "mediaBoxH": 792, "pageRotate": 0,
    "ctm": [1, 0, 0, -1, 0, 792], "textLen": 367,
    "sample": [ { "index": 0, "cp": 50, "x0": 72, "y0": 709.04, "x1": 80.08, "y1": 718.45 }, ... ] }
```

`ctm` is the page -> device matrix the worker uses; the `d` term is negative
because MuPDF device space has y increasing upwards while the reported page
space has y increasing downwards.

## 7. Concurrency model

- **Main thread**: reads frames, dispatches. `open`/`close`/`info`/`render`/
  `cancel`/`viewport`/`tiles`/`stats` run here. They only enqueue work, so they
  are fast even while renders are running.
- **Render threads** (`renderThreads`, at most 4): drain the priority queue,
  rasterise into the cache and stream `pixels` frames for caller-requested jobs.
  All mupdf rendering is serialised by an engine-wide render lock, because
  display-list replay can decode shared image objects and mupdf's image store
  races on concurrent decode of the same image (the same reason light-pdf holds
  its engine-wide `renderLock`).
- **Task thread** (one): `text`, `glyphs`, `search`, `select`, `links`,
  `outline`, `pageContentBox`, `fontList`. A document-wide search therefore
  cannot stall rendering or request intake.
- **Writer**: a single mutex around stdout, so frames from different threads
  never interleave.

Each thread gets its own `fz_context` clone, mirroring light-pdf's per-thread
`Ctx()`.

## 8. Shutdown

Send a `shutdown` frame (or close stdin). The worker stops the task thread, stops
the render pool, closes the document and exits 0. If it does not exit within a
few seconds the bridge kills it.

## 9. Changing the protocol

1. Add the command to the dispatch switch and the `ready` command list in
   `worker_main.cpp`.
2. Add its wire types to `workerProtocol.ts` and a method to `nativePdfEngine.ts`.
3. Bump `kProtocolVersion` in `protocol.h` **and** `PROTOCOL_VERSION` in
   `workerProtocol.ts` together — the bridge refuses a mismatched worker rather
   than guessing.
4. Document it here.
