// eukolia-pdf: the long-lived native PDF worker.
//
// Reads length-prefixed frames from stdin and writes them to stdout (see
// PROTOCOL.md). The render cache owns a small thread pool; this file owns the
// main thread (reading requests) and a single writer thread, so a completed
// render never blocks on a slow pipe while the main thread is busy.
//
// Text selection, text search and page layout are the vendored light-pdf modules
// under ../lightpdf (TextSelection.cpp, TextSearch.cpp, DocumentLayout.cpp) --
// compiled unchanged and reached through EngineMupdfAdapter, which implements
// light-pdf's EngineBase on top of the worker's mupdf layer. Nothing in this
// file re-implements them; it only marshals requests into their API and their
// results into the wire protocol. See lightpdf/PORTING.md.
//
// Copyright 2026 the Eukolia project authors.
// SPDX-License-Identifier: GPL-3.0-or-later

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "geom.h"
#include "json.h"
#include "json_parse.h"
#include "mupdf_engine.h"
#include "protocol.h"
#include "render_cache.h"

// The light-pdf seam. engine_mupdf_adapter.h pulls in base/Base.h, DocProperties.h,
// TreeModel.h and EngineBase.h in the order light-pdf's sources expect (EngineBase.h
// has no include guard and must be included exactly once per translation unit).
// It must therefore come after the worker's own headers, and none of the light-pdf
// headers may be included before it.
#include "engine_mupdf_adapter.h"

#include "Settings.h"
#include "DisplayMode.h"
#include "DocumentLayout.h"
#include "ProgressUpdateUI.h"
#include "TextSelection.h"
#include "TextSearch.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace eukolia {
namespace {

// ---------------------------------------------------------------------------
// Frame I/O
// ---------------------------------------------------------------------------

// Single writer: render workers, the task thread and the main thread all produce
// frames, and interleaving them would corrupt the stream.
class FrameWriter {
  public:
    void Send(proto::FrameType type, uint32_t requestId, const std::string& body) {
        std::string frame = proto::MakeFrame(type, requestId, body);
        std::lock_guard<std::mutex> lock(mutex_);
        std::fwrite(frame.data(), 1, frame.size(), stdout);
        std::fflush(stdout);
    }

    void SendJson(proto::FrameType type, uint32_t requestId, json::Writer& writer) {
        Send(type, requestId, writer.Take());
    }

    // Pixels are sent as [uint32 headerBytes][header][blob]. The JSON header
    // carries the blob's length so the reader can validate without scanning.
    void SendPixels(uint32_t requestId, const std::string& headerJson, uint32_t blobBytes,
                    const unsigned char* blob) {
        std::string body;
        body.reserve(4 + headerJson.size() + blobBytes);
        proto::PutU32LE(body, static_cast<uint32_t>(headerJson.size()));
        body += headerJson;
        if (blob && blobBytes) {
            body.append(reinterpret_cast<const char*>(blob), blobBytes);
        }
        Send(proto::FrameType::Pixels, requestId, body);
    }

  private:
    std::mutex mutex_;
};

bool ReadExact(unsigned char* buffer, size_t bytes) {
    size_t got = 0;
    while (got < bytes) {
        const size_t n = std::fread(buffer + got, 1, bytes - got, stdin);
        if (n == 0) return false;
        got += n;
    }
    return true;
}

/** Depth of mupdf's error stack. Must be 0 outside a request. */
int StackDepth(fz_context* ctx) {
    if (!ctx) return -1;
    return static_cast<int>(ctx->error.top - ctx->error.stack_base);
}

// light-pdf: TextSelection.cpp isWordChar() lives in TextSelection.cpp itself;
// the search engine lives in TextSearch.cpp. Both are compiled here unchanged
// and reached through EngineMupdfAdapter, so the worker no longer carries its own
// copies of the text utilities, the glyph hit test, the selection rectangles or
// the matcher.


// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

// Text-shaped work (search, text extraction, selection) runs on its own thread
// so a long scan never blocks request intake or render completions
// (Instructions.md §60/§61).
struct TextTask {
    uint64_t documentRevision = 0;
    enum class Kind { Text, Glyphs, Links, Outline, Select, Search, PageContentBox, FontList };
    Kind kind = Kind::Text;
    uint32_t requestId = 0;
    int page = 0;
    int firstPage = 0;
    int lastPage = 0;
    std::string query;
    // light-pdf: TextSearch's own options.
    bool matchCase = false;
    bool wholeWord = false;
    bool forward = true;
    int maxResults = 512;
    std::string mode = "range";
    float x = 0;
    float y = 0;
    float startX = 0;
    float startY = 0;
    float endX = 0;
    float endY = 0;
};

struct Worker {
    FrameWriter* writer = nullptr;
    PdfEngine* engine = nullptr;
    std::unique_ptr<RenderCache> cache;
    // The light-pdf EngineBase seam over `engine`. Owned; rebuilt on every
    // `open` because the document (and therefore PageMediabox/PageCount) changes.
    std::unique_ptr<EngineMupdfAdapter> adapter;
    // light-pdf's DocumentLayout, kept per worker so a `layout` request can
    // relayout the same page list instead of rebuilding it every time.
    DocumentLayout layout;
    // Set by a `stats` request with `includeEntries: true`; see HandleStats.
    bool statsIncludeEntries = false;

    void OpenAdapter() {
        adapter = std::make_unique<EngineMupdfAdapter>(engine);
        // Invalidate the layout's page list: HandleLayout rebuilds it from the
        // new document's media boxes on the next request.
        layout.Reset(0);
    }
    void CloseAdapter() { adapter.reset(); }

    std::mutex taskMutex;
    std::condition_variable taskCv;
    std::deque<TextTask> tasks;
    std::thread taskThread;
    std::atomic<bool> taskThreadStop{false};
    std::atomic<int> pendingTasks{0};

    void StartTaskThread() { taskThread = std::thread([this] { TaskLoop(); }); }

    void StopTaskThread() {
        taskThreadStop.store(true);
        taskCv.notify_all();
        if (taskThread.joinable()) taskThread.join();
    }

    void TaskLoop() {
        for (;;) {
            TextTask task;
            {
                std::unique_lock<std::mutex> lock(taskMutex);
                taskCv.wait_for(lock, std::chrono::milliseconds(100), [this] {
                    return taskThreadStop.load(std::memory_order_relaxed) || !tasks.empty();
                });
                if (tasks.empty()) {
                    if (taskThreadStop.load(std::memory_order_relaxed)) return;
                    continue;
                }
                task = std::move(tasks.front());
                tasks.pop_front();
            }
            pendingTasks.fetch_sub(1, std::memory_order_relaxed);
            HandleTask(task);
            // light-pdf resets the thread-local temp arena once per message-loop
            // iteration. The text modules allocate TempStr results (JoinTemp(),
            // str::DupTemp(), GetPropertyTemp()) into it, so this is the same
            // point in the lifecycle: nothing below retains temp memory.
            ResetTempArena();
        }
    }

    void EnqueueTask(TextTask task) {
        task.documentRevision = cache->documentRevision.load();
        {
            std::lock_guard<std::mutex> lock(taskMutex);
            if (tasks.size() > 32) {
                json::Writer w;
                w.BeginObject();
                w.Member("ok", false);
                w.Member("error", "too many queued text requests");
                w.Member("code", "busy");
                w.EndObject();
                writer->SendJson(proto::FrameType::Error, task.requestId, w);
                return;
            }
            tasks.push_back(std::move(task));
        }
        pendingTasks.fetch_add(1, std::memory_order_relaxed);
        taskCv.notify_one();
    }

    void HandleTask(const TextTask& task);
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

void SendError(Worker& worker, uint32_t requestId, const std::string& message, const std::string& code) {
    json::Writer w;
    w.BeginObject();
    w.Member("ok", false);
    w.Member("error", message);
    if (!code.empty()) w.Member("code", code);
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Error, requestId, w);
}

json::Writer BeginOk() {
    json::Writer w;
    w.BeginObject();
    w.Member("ok", true);
    return w;
}

void WriteRect(json::Writer& w, const RectF& r) {
    w.BeginObject();
    w.Member("x", r.x);
    w.Member("y", r.y);
    w.Member("width", r.dx);
    w.Member("height", r.dy);
    w.EndObject();
}

void WriteOutlineArray(json::Writer& w, const std::vector<mupdf::OutlineNode>& nodes) {
    w.BeginArray();
    for (const mupdf::OutlineNode& node : nodes) {
        w.BeginObject();
        w.Member("title", node.title);
        if (node.page > 0) {
            w.Member("page", node.page);
        } else {
            w.Key("page");
            w.Null();
        }
        if (node.uri.empty()) {
            w.Key("uri");
            w.Null();
        } else {
            w.Member("uri", node.uri);
        }
        w.Member("open", node.isOpen);
        w.Key("children");
        WriteOutlineArray(w, node.children);
        w.EndObject();
    }
    w.EndArray();
}

/**
 * The `text` response.
 *
 * The two halves come from the same structured-text page, but from the two
 * models that own them: the flat text and its per-codepoint boxes are light-pdf's
 * PageText (via EngineMupdfAdapter), and the block/line/span hierarchy is the
 * worker's structured model (PdfEngine::ExtractPageText).
 */
void WritePageText(json::Writer& w, float width, float height, Str text, const std::vector<mupdf::TextBlock>& blocks) {
    w.Member("width", width);
    w.Member("height", height);
    w.Member("text", std::string(text.s ? text.s : "", static_cast<size_t>(text.len)));
    w.Key("blocks");
    w.BeginArray();
    for (const mupdf::TextBlock& block : blocks) {
        w.BeginObject();
        w.Key("bbox");
        WriteRect(w, block.box);
        w.Key("lines");
        w.BeginArray();
        for (const mupdf::TextLine& line : block.lines) {
            w.BeginObject();
            w.Key("bbox");
            WriteRect(w, line.box);
            w.Key("spans");
            w.BeginArray();
            for (const mupdf::TextSpan& span : line.spans) {
                w.BeginObject();
                w.Member("text", span.text);
                w.Member("font", span.font);
                w.Member("size", span.size);
                w.Key("bbox");
                WriteRect(w, span.box);
                w.EndObject();
            }
            w.EndArray();
            w.EndObject();
        }
        w.EndArray();
        w.EndObject();
    }
    w.EndArray();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

void HandleOpen(Worker& worker, uint32_t requestId, const json::Value& request) {
    std::lock_guard<std::recursive_mutex> documentLock(worker.cache->documentMutex);
    const std::string path = request.GetString("path");
    const std::string password = request.GetString("password");
    if (path.empty()) {
        SendError(worker, requestId, "missing 'path'", "invalid_argument");
        return;
    }

    std::string error;
    if (!worker.engine->Open(path, password, error)) {
        // A password-protected document is a normal outcome, not a failure: the
        // caller gets needsPassword=true and can retry with a password.
        json::Writer w;
        w.BeginObject();
        w.Member("ok", false);
        w.Member("error", error);
        w.Member("needsPassword", worker.engine->NeedsPassword());
        w.EndObject();
        worker.writer->SendJson(proto::FrameType::Error, requestId, w);
        return;
    }

    /*
     * An unchanged file means the document, its pages and every cached bitmap are
     * still exactly what the caller is already showing. Nothing to drop and nothing
     * to rebuild -- and this is the branch that matters, because the alternative is
     * the ~150 ms a full re-parse plus re-rasterise costs, incurred on a build that
     * produced identical bytes.
     */
    const bool unchanged = worker.engine->LastOpenWasUnchanged();
    if (!unchanged) {
        worker.cache->InvalidateAll();
        // The light-pdf seam is per document: PageMediabox()/PageCount()/the page
        // text cache all belong to the file that is open now.
        worker.OpenAdapter();
    }

    json::Writer w = BeginOk();
    w.Member("path", path);
    w.Member("pageCount", worker.engine->PageCount());
    w.Member("needsPassword", false);
    w.Member("unchanged", unchanged);
    w.Key("pages");
    w.BeginArray();
    for (int i = 0; i < worker.engine->PageCount(); i++) {
        const mupdf::PageView view = worker.engine->PageView_(i);
        w.BeginObject();
        w.Member("index", i);
        w.Member("width", view.mediaBox.dx);
        w.Member("height", view.mediaBox.dy);
        w.Member("rotate", view.pageRotate);
        w.EndObject();
    }
    w.EndArray();
    w.Key("outline");
    WriteOutlineArray(w, worker.engine->Outline());
    w.Key("metadata");
    w.BeginObject();
    for (const auto& kv : worker.engine->Metadata()) {
        w.Member(kv.first.c_str(), kv.second);
    }
    w.EndObject();
    w.Member("engine", "eukolia-mupdf");
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, requestId, w);
}

void HandleInfo(Worker& worker, uint32_t requestId) {
    if (!worker.engine->IsOpen()) {
        SendError(worker, requestId, "no document is open", "not_open");
        return;
    }
    json::Writer w = BeginOk();
    w.Member("path", worker.engine->Path());
    w.Member("pageCount", worker.engine->PageCount());
    w.Key("pages");
    w.BeginArray();
    for (int i = 0; i < worker.engine->PageCount(); i++) {
        const mupdf::PageView view = worker.engine->PageView_(i);
        w.BeginObject();
        w.Member("index", i);
        w.Member("width", view.mediaBox.dx);
        w.Member("height", view.mediaBox.dy);
        w.Member("rotate", view.pageRotate);
        w.EndObject();
    }
    w.EndArray();
    w.Key("metadata");
    w.BeginObject();
    for (const auto& kv : worker.engine->Metadata()) {
        w.Member(kv.first.c_str(), kv.second);
    }
    w.EndObject();
    w.Member("engine", "eukolia-mupdf");
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, requestId, w);
}

void HandleRender(Worker& worker, uint32_t requestId, const json::Value& request) {
    if (!worker.engine->IsOpen()) {
        SendError(worker, requestId, "no document is open", "not_open");
        return;
    }
    const int page = request.GetInt("page", -1);
    if (page < 0 || page >= worker.engine->PageCount()) {
        SendError(worker, requestId, "page index out of range", "invalid_argument");
        return;
    }

    RenderJob job;
    job.requestId = requestId;
    job.pageIndex = page;
    job.scale = static_cast<float>(request.GetNumber("scale", 1.0));
    if (!(job.scale > 0) || !std::isfinite(job.scale)) job.scale = 1.0f;
    job.rotation = NormalizeRotation(request.GetInt("rotate", 0));
    job.invert = request.GetBool("invert", false);
    job.gray = request.GetString("format", "rgba") == "gray";
    job.allowCache = request.GetBool("allowCache", true);
    job.priority = RenderPriority::Visible;
    job.tile = TilePosition{0, 0, 0};
    // The host composes its tile addresses from this contract; passing it through
    // pins the cache's tile geometry to what the host actually laid out, and the
    // cache hands the same number back in every reply.
    job.targetTileSize = std::max(0, request.GetInt("targetTileSize", 0));

    if (request.Has("clip")) {
        const json::Value& clip = request["clip"];
        RectF rect{};
        rect.x = static_cast<float>(clip.GetNumber("x", 0));
        rect.y = static_cast<float>(clip.GetNumber("y", 0));
        rect.dx = static_cast<float>(clip.GetNumber("width", 0));
        rect.dy = static_cast<float>(clip.GetNumber("height", 0));
        if (!std::isfinite(rect.x) || !std::isfinite(rect.y) || !std::isfinite(rect.dx) || !std::isfinite(rect.dy) ||
            rect.IsEmpty()) {
            SendError(worker, requestId, "clip rectangle is empty or not finite", "invalid_argument");
            return;
        }
        job.region.set = true;
        job.region.rect = rect;
    } else if (request.Has("tile")) {
        const json::Value& tile = request["tile"];
        /**
         * Validate before narrowing. `TilePosition::row/col` are 16-bit, so a
         * negative or oversized index used to be cast into a *different* valid
         * tile instead of being rejected -- `row: -1` became row 65535, which the
         * grid check then happened to pass for a large resolution. Each field is
         * checked against the grid it claims to be in, in its own width.
         */
        const int rawRes = tile.GetInt("res", 0);
        const int rawRow = tile.GetInt("row", 0);
        const int rawCol = tile.GetInt("col", 0);
        if (rawRes < 0 || rawRes > static_cast<int>(kMaxTileRes)) {
            SendError(worker, requestId, "tile resolution is outside the representable range (0..15)", "invalid_argument");
            return;
        }
        const int grid = 1 << rawRes;
        if (rawRow < 0 || rawCol < 0 || rawRow >= grid || rawCol >= grid) {
            SendError(worker, requestId, "tile is outside its resolution's grid", "invalid_argument");
            return;
        }
        job.tile.res = static_cast<uint16_t>(rawRes);
        job.tile.row = static_cast<uint16_t>(rawRow);
        job.tile.col = static_cast<uint16_t>(rawCol);
        // `Submit()` resolves the tile into the page-space region the cache keys
        // on; the same resolution serves the tile and the congruent-clip route.
    }

    if (!worker.cache->Submit(std::move(job))) {
        SendError(worker, requestId, "render request rejected (queue full, bad scale, or document closing)", "busy");
    }
}

// Runs on a render worker: only serialises and writes.
void OnRenderComplete(Worker& worker, RenderOutcome&& outcome) {
    if (outcome.requestId == 0) return;  // internal prefetch

    if (!outcome.ok || !outcome.bitmap) {
        json::Writer w;
        w.BeginObject();
        w.Member("ok", false);
        w.Member("error", outcome.error.empty() ? "render failed" : outcome.error);
        w.Member("page", outcome.pageIndex);
        w.EndObject();
        worker.writer->SendJson(proto::FrameType::Error, outcome.requestId, w);
        return;
    }

    const mupdf::Pixmap& pixmap = *outcome.bitmap;
    /**
     * The channel order of what was rasterised. Four components are RGBA — the page
     * is rendered into `fz_device_rgb` (see `mupdf_engine.cpp`), which is what a
     * canvas `ImageData` wants, so the renderer can hand the buffer over without
     * touching a pixel.
     */
    const char* order = "rgb";
    if (pixmap.components == 4) {
        order = "rgba";
    } else if (pixmap.components == 1) {
        order = "gray";
    }

    json::Writer w;
    w.BeginObject();
    w.Member("ok", true);
    w.Member("page", outcome.pageIndex);
    w.Member("width", pixmap.width);
    w.Member("height", pixmap.height);
    w.Member("stride", pixmap.stride);
    w.Member("channels", pixmap.components);
    w.Member("order", order);
    w.Member("scale", outcome.scale);
    w.Member("rotate", outcome.rotation);
    w.Member("fromCache", outcome.fromCache);
    w.Key("pageRect");
    WriteRect(w, outcome.pageRect);
    w.Key("view");
    w.BeginObject();
    w.Member("width", outcome.view.mediaBox.dx);
    w.Member("height", outcome.view.mediaBox.dy);
    w.Member("pageRotate", outcome.view.pageRotate);
    w.Member("userRotate", outcome.view.userRotate);
    // The page -> device matrix: fitz page space (y down) onto MuPDF device space
    // (y up), so its `d` term is negative. It carries the page's own /Rotate as
    // well as the reader's, which is what makes it the matrix a page-space point
    // is placed with — the drawn geometry is `userCtm` because the page transform
    // is already inside the content.
    w.Member("a", outcome.view.ctm.a);
    w.Member("b", outcome.view.ctm.b);
    w.Member("c", outcome.view.ctm.c);
    w.Member("d", outcome.view.ctm.d);
    w.Member("e", outcome.view.ctm.e);
    w.Member("f", outcome.view.ctm.f);
    w.EndObject();
    w.Member("blobBytes", static_cast<uint64_t>(pixmap.samples.size()));
    w.EndObject();

    const uint32_t blobBytes = static_cast<uint32_t>(pixmap.samples.size());
    worker.writer->SendPixels(outcome.requestId, w.Take(), blobBytes,
                              pixmap.samples.empty() ? nullptr : pixmap.samples.data());
}

void HandleViewport(Worker& worker, uint32_t requestId, const json::Value& request) {
    if (!worker.engine->IsOpen()) {
        SendError(worker, requestId, "no document is open", "not_open");
        return;
    }
    auto readIntArray = [](const json::Value& value) {
        std::vector<int> out;
        if (!value.IsArray()) return out;
        for (const json::Value& item : value.array) {
            out.push_back(static_cast<int>(item.GetNumber("", 0)));
        }
        return out;
    };

    const std::vector<int> visible = readIntArray(request["visiblePages"]);
    const std::vector<int> adjacent = readIntArray(request["adjacentPages"]);
    const std::vector<int> nearby = readIntArray(request["nearbyPages"]);
    const float scale = static_cast<float>(request.GetNumber("scale", 1.0));
    const int rotation = NormalizeRotation(request.GetInt("rotate", 0));
    const bool gray = request.GetString("format", "rgba") == "gray";
    const bool invert = request.GetBool("invert", false);
    const bool prefetch = request.GetBool("prefetch", true);

    worker.cache->SetViewport(visible, adjacent, nearby);

    int queued = 0;
    if (prefetch && scale > 0 && std::isfinite(scale)) {
        const int targetTileSize = worker.cache->TargetTileSize();
        auto queuePage = [&](int page, RenderPriority priority) {
            if (page < 0 || page >= worker.engine->PageCount()) return;
            const mupdf::PageView view = worker.engine->PageView_(page, scale, rotation);
            if (view.mediaBox.IsEmpty()) return;
            for (TilePosition tile : RenderCache::TilesForPage(view.mediaBox.dx * scale, view.mediaBox.dy * scale,
                                                             targetTileSize)) {
                RenderJob job;
                job.requestId = 0;  // internal: the result only goes to the cache
                job.pageIndex = page;
                job.scale = scale;
                job.rotation = rotation;
                job.tile = tile;
                job.invert = invert;
                job.gray = gray;
                job.priority = priority;
                // The tile address is the contract; `Submit()` derives the
                // page-space region from it, so a prefetched tile and a tile the
                // renderer asks for later land on the same cache entry.
                job.targetTileSize = targetTileSize;
                if (worker.cache->Submit(std::move(job))) queued++;
            }
        };
        for (int page : adjacent) queuePage(page, RenderPriority::Adjacent);
        for (int page : nearby) queuePage(page, RenderPriority::Nearby);
    }

    const RenderCache::Stats stats = worker.cache->GetStats();
    json::Writer w = BeginOk();
    w.Member("queued", queued);
    w.Member("cacheEntries", stats.entries);
    w.Member("cacheBytes", static_cast<uint64_t>(stats.bytes));
    w.Member("queuedTotal", stats.queued);
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, requestId, w);
}

void HandleTiles(Worker& worker, uint32_t requestId, const json::Value& request) {
    if (!worker.engine->IsOpen()) {
        SendError(worker, requestId, "no document is open", "not_open");
        return;
    }
    const int page = request.GetInt("page", -1);
    if (page < 0 || page >= worker.engine->PageCount()) {
        SendError(worker, requestId, "page index out of range", "invalid_argument");
        return;
    }
    const float scale = static_cast<float>(request.GetNumber("scale", 1.0));
    const int rotation = NormalizeRotation(request.GetInt("rotate", 0));
    const int target = request.GetInt("targetTileSize", worker.cache->TargetTileSize());
    const mupdf::PageView view = worker.engine->PageView_(page, scale, rotation);
    const uint16_t res = RenderCache::TileResFor(view.mediaBox.dx * scale, view.mediaBox.dy * scale, false, target);

    json::Writer w = BeginOk();
    w.Member("page", page);
    w.Member("res", res);
    w.Key("tiles");
    w.BeginArray();
    for (TilePosition tile :
         RenderCache::TilesForPage(view.mediaBox.dx * scale, view.mediaBox.dy * scale, target)) {
        const RectF rect = RenderCache::TileRectInPage(view.mediaBox, tile);
        w.BeginObject();
        w.Member("res", tile.res);
        w.Member("row", tile.row);
        w.Member("col", tile.col);
        w.Key("rect");
        WriteRect(w, rect);
        w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, requestId, w);
}

/**
 * `layout`: light-pdf's DocumentLayout.
 *
 * Relayout() is the reference's whole page-placement algorithm -- page sizing
 * with rotation, the zoom resolution for the fit modes, the column packing for
 * facing/book view, the centring pass, the R2L mirroring and RecalcVisibleParts()
 * -- and it is driven here entirely through its own parameters. The response is
 * the computed canvas: every page's position in canvas space, its position on
 * screen, and how much of it is visible.
 */
void HandleLayout(Worker& worker, uint32_t requestId, const json::Value& request) {
    if (!worker.adapter) {
        SendError(worker, requestId, "no document is open", "not_open");
        return;
    }
    DocumentLayout& layout = worker.layout;
    if (layout.pages.len != worker.engine->PageCount()) {
        layout.Reset(worker.engine->PageCount());
        for (int pageNo = 1; pageNo <= layout.pages.len; pageNo++) {
            layout.SetPageMediaBox(pageNo, worker.adapter->PageMediabox(pageNo));
        }
    }

    DocumentLayoutParams params;
    const std::string displayMode = request.GetString("displayMode", "continuous");
    if (displayMode == "single") {
        params.displayMode = DisplayMode::SinglePage;
    } else if (displayMode == "facing") {
        params.displayMode = DisplayMode::Facing;
    } else if (displayMode == "book") {
        params.displayMode = DisplayMode::BookView;
    } else if (displayMode == "continuousFacing") {
        params.displayMode = DisplayMode::ContinuousFacing;
    } else if (displayMode == "continuousBook") {
        params.displayMode = DisplayMode::ContinuousBookView;
    } else {
        params.displayMode = DisplayMode::Continuous;
    }
    params.startPage = request.GetInt("startPage", 1);
    params.viewPortSize = Size(request.GetInt("viewPortWidth", 0), request.GetInt("viewPortHeight", 0));
    params.viewPortOffset = Point(request.GetInt("viewPortX", 0), request.GetInt("viewPortY", 0));
    params.zoomVirtual = static_cast<float>(request.GetNumber("zoomVirtual", 100));
    params.dpiFactor = static_cast<float>(request.GetNumber("dpiFactor", 1));
    params.rotation = NormalizeRotation(request.GetInt("rotation", 0));
    params.displayR2L = request.GetBool("displayR2L", false);
    params.usePageZooms = request.GetBool("usePageZooms", false);
    params.windowMargin.top = request.GetInt("marginTop", 0);
    params.windowMargin.right = request.GetInt("marginRight", 0);
    params.windowMargin.bottom = request.GetInt("marginBottom", 0);
    params.windowMargin.left = request.GetInt("marginLeft", 0);
    params.pageSpacing = Size(request.GetInt("pageSpacingX", 0), request.GetInt("pageSpacingY", 0));

    layout.Relayout(params);

    json::Writer w = BeginOk();
    w.Member("pageCount", worker.engine->PageCount());
    w.Member("zoomReal", layout.zoomReal);
    w.Member("currentPage", layout.CurrentPageNo());
    w.Member("firstVisiblePage", layout.FirstVisiblePageNo());
    w.Key("canvas");
    w.BeginObject();
    w.Member("width", layout.canvasSize.dx);
    w.Member("height", layout.canvasSize.dy);
    w.EndObject();
    w.Key("viewPort");
    w.BeginObject();
    w.Member("x", layout.viewPort.x);
    w.Member("y", layout.viewPort.y);
    w.Member("width", layout.viewPort.dx);
    w.Member("height", layout.viewPort.dy);
    w.EndObject();
    w.Key("pages");
    w.BeginArray();
    for (int pageNo = 1; pageNo <= layout.pages.len; pageNo++) {
        const DocumentLayoutPage* page = layout.GetPage(pageNo);
        w.BeginObject();
        // 0-based page index, like every other page field on the wire.
        w.Member("index", pageNo - 1);
        w.Member("shown", page->isShown);
        w.Member("visibleRatio", page->visibleRatio);
        w.Member("zoomReal", page->zoomReal);
        w.Key("pos");
        w.BeginObject();
        w.Member("x", page->pos.x);
        w.Member("y", page->pos.y);
        w.Member("width", page->pos.dx);
        w.Member("height", page->pos.dy);
        w.EndObject();
        w.Key("pageOnScreen");
        w.BeginObject();
        w.Member("x", page->pageOnScreen.x);
        w.Member("y", page->pageOnScreen.y);
        w.Member("width", page->pageOnScreen.dx);
        w.Member("height", page->pageOnScreen.dy);
        w.EndObject();
        w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, requestId, w);
}

void HandleStats(Worker& worker, uint32_t requestId) {
    const RenderCache::Stats stats = worker.cache->GetStats();
    json::Writer w = BeginOk();
    w.Member("cacheEntries", stats.entries);
    w.Member("cacheBytes", static_cast<uint64_t>(stats.bytes));
    w.Member("queued", stats.queued);
    w.Member("active", stats.active);
    w.Member("servedFromCache", stats.servedFromCache);
    w.Member("rendered", stats.rendered);
    w.Member("aborted", stats.aborted);
    w.Member("evicted", stats.evicted);
    // Adaptive tile sizing. `tileSizeReductions` counts how often the cache made
    // the working set smaller instead of evicting (light-pdf: ReduceTileSize),
    // and `threadsSpawned` how many render threads the demand actually needed --
    // the pool is spawned lazily, so this is usually far below the ceiling.
    w.Member("tileSizeReductions", static_cast<uint64_t>(stats.tileSizeReductions));
    w.Member("targetTileSize", stats.targetTileSize);
    w.Member("threadsSpawned", stats.threadsSpawned);
    // Renders whose pixels were handed back but deliberately not cached because the
    // entry alone exceeded the byte budget (see RenderCache::Store).
    w.Member("skippedOversized", static_cast<uint64_t>(stats.skippedOversized));
    w.Member("evictedUnwantedPages", static_cast<uint64_t>(stats.evictedUnwantedPages));
    w.Member("evictedBudget", static_cast<uint64_t>(stats.evictedBudget));
    w.Member("evictedOldGeneration", static_cast<uint64_t>(stats.evictedOldGeneration));
    w.Member("evictedOldVariant", static_cast<uint64_t>(stats.evictedOldVariant));
    w.Member("evictedSuperseded", static_cast<uint64_t>(stats.evictedSuperseded));
    w.Member("pendingTextTasks", worker.pendingTasks.load(std::memory_order_relaxed));
    // Full entry list only when asked: it is O(entries) and allocates, so a
    // periodic counter poll must not carry it.
    if (worker.statsIncludeEntries) {
        w.Key("entries");
        w.BeginArray();
        for (const RenderCache::EntryInfo& info : worker.cache->DescribeEntries()) {
            w.BeginObject();
            w.Member("page", info.pageIndex);
            w.Member("rotate", info.rotation);
            w.Member("scale", info.scale);
            w.Member("res", static_cast<int>(info.tile.res));
            w.Member("row", static_cast<int>(info.tile.row));
            w.Member("col", static_cast<int>(info.tile.col));
            w.Member("invert", info.invert);
            w.Member("gray", info.gray);
            w.Key("pageRect");
            WriteRect(w, info.pageRect);
            w.Member("bytes", static_cast<uint64_t>(info.bytes));
            w.Member("width", info.width);
            w.Member("height", info.height);
            w.EndObject();
        }
        w.EndArray();
    }
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, requestId, w);
}

/**
 * `diagnostics`: text the cache raised while it was working, drained on read.
 *
 * Separate from `stats` so a periodic poll of the counters does not have to carry
 * prose, and so a condition that happens once (an oversized entry, say) is
 * reported once rather than on every poll.
 */
void HandleDiagnostics(Worker& worker, uint32_t requestId) {
    const std::vector<std::string> fromCache = worker.cache->TakeDiagnostics();
    const std::vector<std::string> fromEngine = worker.engine->TakeDiagnostics();

    json::Writer w = BeginOk();
    w.Key("messages");
    w.BeginArray();
    for (const std::string& message : fromCache) w.Element(message);
    for (const std::string& message : fromEngine) w.Element(message);
    w.EndArray();
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, requestId, w);
}

// ---------------------------------------------------------------------------
// Text-thread handlers
// ---------------------------------------------------------------------------

void HandleText(Worker& worker, const TextTask& task) {
    if (!worker.adapter) {
        SendError(worker, task.requestId, "no document is open", "not_open");
        return;
    }
    // The flat text is light-pdf's PageText, which is EngineBase's own cache:
    // GetTextForPage() extracts on first use and returns the same buffer
    // afterwards. lenOut is the number of codepoints, not bytes.
    int codepoints = 0;
    Str text = worker.adapter->GetTextForPage(task.page + 1, &codepoints);
    if (!text) {
        SendError(worker, task.requestId, "page has no extractable text", "no_text");
        return;
    }
    const mupdf::PageTextInfo blocks = worker.engine->ExtractPageText(task.page);
    const RectF mediaBox = worker.engine->MediaBox(task.page);

    json::Writer w = BeginOk();
    w.Member("page", task.page);
    WritePageText(w, mediaBox.dx, mediaBox.dy, text, blocks.blocks);
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, task.requestId, w);
}

// Glyph dump for renderer-side hit testing and custom selection rendering: the
// per-codepoint boxes light-pdf keeps in PageText::coords. Coords has exactly one
// entry per codepoint, and the '\n' line separators occupy a zero rectangle --
// the invariant TextSelection.cpp and TextSearch.cpp index against.
void HandleGlyphs(Worker& worker, const TextTask& task) {
    if (!worker.adapter) {
        SendError(worker, task.requestId, "not_open", "not_open");
        return;
    }
    int codepoints = 0;
    ::Rect* coords = nullptr;
    Str text = worker.adapter->GetTextForPage(task.page + 1, &codepoints, &coords);
    if (!text) {
        SendError(worker, task.requestId, "page has no extractable text", "no_text");
        return;
    }
    const RectF mediaBox = worker.engine->MediaBox(task.page);

    json::Writer w = BeginOk();
    w.Member("page", task.page);
    w.Member("width", mediaBox.dx);
    w.Member("height", mediaBox.dy);
    w.Member("text", std::string(text.s ? text.s : "", static_cast<size_t>(text.len)));
    w.Key("glyphs");
    w.BeginArray();
    for (int i = 0; i < codepoints; i++) {
        const ::Rect& r = coords[i];
        w.BeginObject();
        // light-pdf: a codepoint with no geometry is a line separator, which is
        // exactly what happens to the '\n' entries AddLineSepUtf8() appends.
        if (!r.x && !r.dx) {
            w.Member("lineBreak", true);
        } else {
            w.Member("x", r.x);
            w.Member("y", r.y);
            w.Member("width", r.dx);
            w.Member("height", r.dy);
        }
        w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, task.requestId, w);
}

void HandleLinks(Worker& worker, const TextTask& task) {
    json::Writer w = BeginOk();
    w.Member("page", task.page);
    w.Key("links");
    w.BeginArray();
    for (const mupdf::LinkInfo& link : worker.engine->Links(task.page)) {
        w.BeginObject();
        w.Key("rect");
        WriteRect(w, link.box);
        if (link.uri.empty()) {
            w.Key("uri");
            w.Null();
        } else {
            w.Member("uri", link.uri);
        }
        if (link.page > 0) {
            w.Member("page", link.page);
            w.Member("targetX", link.x);
            w.Member("targetY", link.y);
            w.Member("targetZoom", link.zoom);
        } else {
            w.Key("page");
            w.Null();
        }
        w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, task.requestId, w);
}

void HandleOutlineTask(Worker& worker, const TextTask& task) {
    json::Writer w = BeginOk();
    w.Key("outline");
    WriteOutlineArray(w, worker.engine->Outline());
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, task.requestId, w);
}

// Writes one TextSel (light-pdf's selection result) as the wire `rects` array.
// `::Rect` is light-pdf's global integer rectangle; inside `namespace eukolia` an
// unqualified `Rect` would pick up geom.h's unrelated worker type.
void WriteSelectionRects(json::Writer& w, const TextSel& sel) {
    w.Key("rects");
    w.BeginArray();
    for (int i = 0; i < sel.len; i++) {
        const ::Rect& r = sel.rects[i];
        w.BeginObject();
        w.Member("x", r.x);
        w.Member("y", r.y);
        w.Member("width", r.dx);
        w.Member("height", r.dy);
        w.EndObject();
    }
    w.EndArray();
}

void HandleSelect(Worker& worker, const TextTask& task) {
    if (!worker.adapter) {
        SendError(worker, task.requestId, "no document is open", "not_open");
        return;
    }
    // light-pdf: TextSelection. `mode` maps onto the reference's own entry
    // points: SelectWordAt() (double click), SelectLineAt() (triple click) and
    // StartAt()/SelectUpTo() (drag).
    TextSelection selection(worker.adapter.get());
    if (task.mode == "word") {
        selection.SelectWordAt(task.page + 1, task.x, task.y);
    } else if (task.mode == "line") {
        selection.SelectLineAt(task.page + 1, task.x, task.y);
    } else {
        selection.StartAt(task.page + 1, static_cast<double>(task.startX), static_cast<double>(task.startY));
        selection.SelectUpTo(task.page + 1, static_cast<double>(task.endX), static_cast<double>(task.endY));
    }

    // light-pdf: TextSelection::GetGlyphRange() -- the ordered glyph range of
    // the selection, which may span pages.
    int fromPage = 0;
    int fromGlyph = 0;
    int toPage = 0;
    int toGlyph = 0;
    selection.GetGlyphRange(&fromPage, &fromGlyph, &toPage, &toGlyph);

    // light-pdf: TextSelection::ExtractText("\n").
    Str text = selection.ExtractText(StrL("\n"));

    json::Writer w = BeginOk();
    w.Member("page", task.page);
    w.Member("startGlyph", fromGlyph);
    w.Member("endGlyph", toGlyph);
    w.Member("text", std::string(text.s ? text.s : "", static_cast<size_t>(text.len)));
    // Both are 1-based pages converted to the 0-based index the wire uses.
    w.Member("startPage", fromPage >= 1 ? fromPage - 1 : -1);
    w.Member("endPage", toPage >= 1 ? toPage - 1 : -1);
    WriteSelectionRects(w, selection.result);
    w.EndObject();
    str::Free(text);
    worker.writer->SendJson(proto::FrameType::Response, task.requestId, w);
}

// light-pdf: TextSearch. The scan is driven entirely by the reference's own
// entry points -- FindFirstOnPage() (its page-constrained search, added for
// light-pdf issue #3085) to start a page and FindNext() to iterate -- so match
// iteration, whole-word handling, whitespace tolerance, hyphen/quote lookalikes
// and the German ß <-> ss equivalence are all TextSearch.cpp's behaviour.
//
// FindFirstOnPage() is used rather than FindFirst() because the wire contract's
// `page` / `pages` range must not wrap around to the rest of the document.
void HandleSearch(Worker& worker, const TextTask& task) {
    if (!worker.adapter) {
        SendError(worker, task.requestId, "no document is open", "not_open");
        return;
    }
    const int pageCount = worker.engine->PageCount();
    const int firstPage = std::max(0, std::min(pageCount - 1, task.firstPage));
    const int lastPage = std::max(firstPage, std::min(pageCount - 1, task.lastPage));
    const int limit = std::max(1, std::min(4096, task.maxResults));

    Str query(const_cast<char*>(task.query.data()), static_cast<int>(task.query.size()));

    TextSearch search(worker.adapter.get());
    search.SetMatchCase(task.matchCase);
    search.SetMatchWholeWord(task.wholeWord);
    search.SetDirection(task.forward ? TextSearch::Direction::Forward : TextSearch::Direction::Backward);

    json::Writer w = BeginOk();
    w.Member("query", task.query);
    w.Member("pageCount", pageCount);
    w.Key("matches");
    w.BeginArray();
    int emitted = 0;

    for (int page = firstPage; page <= lastPage && emitted < limit; page++) {
        TextSel* sel = search.FindFirstOnPage(page + 1, query);
        while (sel && emitted < limit) {
            w.BeginObject();
            w.Member("page", page);
            // light-pdf: TextSelection::ExtractText(" "), the reference's own
            // way of turning a selection into the matched string.
            Str match = search.ExtractText(StrL(" "));
            w.Member("text", std::string(match.s ? match.s : "", static_cast<size_t>(match.len)));
            str::Free(match);
            WriteSelectionRects(w, *sel);
            w.EndObject();
            emitted++;

            sel = search.FindNext();
            // A match that starts on another page belongs to that page's pass.
            if (sel && search.GetSearchHitStartPageNo() != page + 1) {
                break;
            }
        }
    }
    w.EndArray();
    w.Member("truncated", emitted >= limit);
    w.EndObject();
    worker.writer->SendJson(proto::FrameType::Response, task.requestId, w);
}

void Worker::HandleTask(const TextTask& task) {
    std::lock_guard<std::recursive_mutex> documentLock(cache->documentMutex);
    if (task.documentRevision != cache->documentRevision.load()) {
        SendError(*this, task.requestId, "cancelled by document replacement", "cancelled");
        return;
    }
    if (!engine->IsOpen()) {
        SendError(*this, task.requestId, "no document is open", "not_open");
        return;
    }
    switch (task.kind) {
        case TextTask::Kind::Text:
            if (task.page < 0 || task.page >= engine->PageCount()) {
                SendError(*this, task.requestId, "page index out of range", "invalid_argument");
                return;
            }
            HandleText(*this, task);
            return;
        case TextTask::Kind::Glyphs:
            if (task.page < 0 || task.page >= engine->PageCount()) {
                SendError(*this, task.requestId, "page index out of range", "invalid_argument");
                return;
            }
            HandleGlyphs(*this, task);
            return;
        case TextTask::Kind::Links:
            if (task.page < 0 || task.page >= engine->PageCount()) {
                SendError(*this, task.requestId, "page index out of range", "invalid_argument");
                return;
            }
            HandleLinks(*this, task);
            return;
        case TextTask::Kind::Select:
            if (task.page < 0 || task.page >= engine->PageCount()) {
                SendError(*this, task.requestId, "page index out of range", "invalid_argument");
                return;
            }
            HandleSelect(*this, task);
            return;
        case TextTask::Kind::Outline:
            HandleOutlineTask(*this, task);
            return;
        case TextTask::Kind::Search:
            if (task.query.empty()) {
                SendError(*this, task.requestId, "missing 'query'", "invalid_argument");
                return;
            }
            HandleSearch(*this, task);
            return;
        case TextTask::Kind::PageContentBox: {
            if (task.page < 0 || task.page >= engine->PageCount()) {
                SendError(*this, task.requestId, "page index out of range", "invalid_argument");
                return;
            }
            const RectF box = engine->PageContentBox(task.page);
            json::Writer w = BeginOk();
            w.Member("page", task.page);
            w.Key("rect");
            WriteRect(w, box);
            w.EndObject();
            writer->SendJson(proto::FrameType::Response, task.requestId, w);
            return;
        }
        case TextTask::Kind::FontList: {
            // Aggregated from the structured text's spans; mupdf's font-list
            // helper is not exported by this build.
            const int first = std::max(0, task.firstPage);
            const int last = std::min(engine->PageCount() - 1, task.lastPage);
            std::vector<std::string> fonts;
            for (int p = first; p <= last; p++) {
                for (const mupdf::TextBlock& block : engine->ExtractPageText(p).blocks) {
                    for (const mupdf::TextLine& line : block.lines) {
                        for (const mupdf::TextSpan& span : line.spans) {
                            if (span.font.empty()) continue;
                            if (std::find(fonts.begin(), fonts.end(), span.font) == fonts.end()) {
                                fonts.push_back(span.font);
                            }
                        }
                    }
                }
            }
            json::Writer w = BeginOk();
            w.Key("fonts");
            w.BeginArray();
            for (const std::string& font : fonts) w.Element(font);
            w.EndArray();
            w.EndObject();
            writer->SendJson(proto::FrameType::Response, task.requestId, w);
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

void HandleRequest(Worker& worker, uint32_t requestId, const json::Value& request) {
    const std::string cmd = request.GetString("cmd");
    if (cmd.empty()) {
        SendError(worker, requestId, "missing 'cmd'", "invalid_argument");
        return;
    }

    if (cmd == "open") {
        HandleOpen(worker, requestId, request);
        return;
    }
    if (cmd == "close") {
        std::lock_guard<std::recursive_mutex> documentLock(worker.cache->documentMutex);
        worker.CloseAdapter();
        worker.engine->CloseDocument();
        worker.cache->InvalidateAll();
        json::Writer w = BeginOk();
        w.EndObject();
        worker.writer->SendJson(proto::FrameType::Response, requestId, w);
        return;
    }
    if (cmd == "layout") {
        HandleLayout(worker, requestId, request);
        return;
    }
    if (cmd == "info") {
        HandleInfo(worker, requestId);
        return;
    }
    if (cmd == "render") {
        HandleRender(worker, requestId, request);
        return;
    }
    if (cmd == "cancel") {
        const uint32_t target = static_cast<uint32_t>(std::max(0, request.GetInt("targetRequestId", 0)));
        worker.cache->CancelRequest(target);
        json::Writer w = BeginOk();
        w.Member("cancelled", static_cast<int>(target));
        w.EndObject();
        worker.writer->SendJson(proto::FrameType::Response, requestId, w);
        return;
    }
    if (cmd == "viewport") {
        HandleViewport(worker, requestId, request);
        return;
    }
    if (cmd == "tiles") {
        HandleTiles(worker, requestId, request);
        return;
    }
    if (cmd == "stats") {
        worker.statsIncludeEntries = request.GetBool("includeEntries", false);
        HandleStats(worker, requestId);
        return;
    }
    if (cmd == "diagnostics") {
        HandleDiagnostics(worker, requestId);
        return;
    }

    TextTask task;
    task.requestId = requestId;
    task.page = request.GetInt("page", 0);
    if (cmd == "text") {
        task.kind = TextTask::Kind::Text;
    } else if (cmd == "glyphs") {
        task.kind = TextTask::Kind::Glyphs;
    } else if (cmd == "links") {
        task.kind = TextTask::Kind::Links;
    } else if (cmd == "outline") {
        task.kind = TextTask::Kind::Outline;
    } else if (cmd == "select") {
        task.kind = TextTask::Kind::Select;
        task.mode = request.GetString("mode", "range");
        task.x = static_cast<float>(request.GetNumber("x", 0));
        task.y = static_cast<float>(request.GetNumber("y", 0));
        task.startX = static_cast<float>(request.GetNumber("startX", 0));
        task.startY = static_cast<float>(request.GetNumber("startY", 0));
        task.endX = static_cast<float>(request.GetNumber("endX", 0));
        task.endY = static_cast<float>(request.GetNumber("endY", 0));
    } else if (cmd == "search") {
        task.kind = TextTask::Kind::Search;
        task.query = request.GetString("query");
        task.matchCase = request.GetBool("matchCase", false);
        task.wholeWord = request.GetBool("wholeWord", false);
        task.forward = request.GetBool("forward", true);
        task.maxResults = request.GetInt("maxResults", 512);
        task.firstPage = 0;
        task.lastPage = worker.engine->IsOpen() ? worker.engine->PageCount() - 1 : 0;
        if (request.Has("page")) {
            task.firstPage = task.lastPage = request.GetInt("page", 0);
        } else if (request.Has("pages") && request["pages"].IsArray() && request["pages"].array.size() == 2) {
            task.firstPage = static_cast<int>(request["pages"].array[0].GetNumber("", 0));
            task.lastPage = static_cast<int>(request["pages"].array[1].GetNumber("", 0));
        }
    } else if (cmd == "pageContentBox") {
        task.kind = TextTask::Kind::PageContentBox;
    } else if (cmd == "fontList") {
        task.kind = TextTask::Kind::FontList;
        task.firstPage = request.GetInt("firstPage", 0);
        task.lastPage = request.GetInt("lastPage", worker.engine->IsOpen() ? worker.engine->PageCount() - 1 : 0);
    } else if (cmd == "debugErrorState") {
        // Diagnostics: the base context's error stack must always be balanced
        // (depth 0). A leak here is exactly what trips fz_drop_context's assert
        // in the debug DLL.
        fz_context* ctx = worker.engine->BaseCtx();
        json::Writer w = BeginOk();
        if (ctx) {
            w.Member("stackDepth", static_cast<int>(ctx->error.top - ctx->error.stack_base));
            w.Member("errcode", ctx->error.errcode);
            w.Member("stackCapacity",
                     static_cast<int>(sizeof(ctx->error.stack) / sizeof(ctx->error.stack[0])));
        } else {
            w.Member("stackDepth", -1);
        }
        w.EndObject();
        worker.writer->SendJson(proto::FrameType::Response, requestId, w);
        return;
    } else if (cmd == "debugText") {
        // Diagnostics: dump sampled per-codepoint boxes from light-pdf's
        // PageText plus the first byte of each, so geometry problems can be seen
        // without guessing.
        const int page = request.GetInt("page", 0);
        const mupdf::PageView view = worker.engine->PageView_(page);
        json::Writer w = BeginOk();
        w.Member("page", page);
        w.Member("mediaBoxW", view.mediaBox.dx);
        w.Member("mediaBoxH", view.mediaBox.dy);
        w.Member("pageRotate", view.pageRotate);
        w.Key("ctm");
        w.BeginArray();
        w.Element(view.ctm.a);
        w.Element(view.ctm.b);
        w.Element(view.ctm.c);
        w.Element(view.ctm.d);
        w.Element(view.ctm.e);
        w.Element(view.ctm.f);
        w.EndArray();
        if (worker.adapter) {
            int codepoints = 0;
            ::Rect* coords = nullptr;
            Str text = worker.adapter->GetTextForPage(page + 1, &codepoints, &coords);
            w.Member("textLen", codepoints);
            w.Key("sample");
            w.BeginArray();
            const int step = std::max(1, codepoints / 24);
            for (int i = 0; i < codepoints && w.Str().size() < 6000; i += step) {
                const ::Rect& r = coords[i];
                w.BeginObject();
                w.Member("index", i);
                w.Member("cp", static_cast<int>(static_cast<unsigned char>((text.s && i < text.len) ? text.s[i] : 0)));
                w.Member("x0", r.x);
                w.Member("y0", r.y);
                w.Member("x1", r.x + r.dx);
                w.Member("y1", r.y + r.dy);
                w.EndObject();
            }
            w.EndArray();
        }
        w.EndObject();
        worker.writer->SendJson(proto::FrameType::Response, requestId, w);
        return;
    } else {
        SendError(worker, requestId, "unknown command: " + cmd, "unknown_command");
        return;
    }
    worker.EnqueueTask(std::move(task));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

int Run() {
#ifdef _WIN32
    // Binary mode on both ends, or Windows translates \n and stops at 0x1A.
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
#endif

    FrameWriter writer;
    PdfEngine engine;
    Worker worker;
    worker.writer = &writer;
    worker.engine = &engine;

    // light-pdf: RenderCache.cpp:104-110 --
    //   maxRenderThreads = max(gMaxRenderThreads /* 8 */, numCores);
    //   if (maxRenderThreads > kMaxRenderThreads /* 32 */) maxRenderThreads = 32;
    // The reference then spawns them lazily, so this is a ceiling and not an
    // allocation; RenderCache::EnsureWorker() starts a worker only when no
    // existing one is (or is about to become) idle. The previous cap of 4 both
    // under-used a wide machine and started all four eagerly.
    const unsigned hw = std::thread::hardware_concurrency();
    const int cores = static_cast<int>(hw == 0 ? 2 : hw);
    int threads = std::max(8, cores);
    threads = std::min(threads, RenderCache::kMaxRenderThreads);
    worker.cache = std::make_unique<RenderCache>(&engine, [&worker](RenderOutcome&& outcome) {
        OnRenderComplete(worker, std::move(outcome));
    });
    worker.cache->Start(threads);
    worker.StartTaskThread();

    {
        json::Writer w;
        w.BeginObject();
        w.Member("ok", true);
        w.Member("protocolVersion", static_cast<int>(proto::kProtocolVersion));
        w.Member("engine", "eukolia-mupdf");
        w.Member("mupdfVersion", std::string(FZ_VERSION));
        w.Member("renderThreads", threads);
        w.Member("maxTileSize", worker.cache->TargetTileSize());
        /**
         * The largest tile resolution the 16-bit row/col address fields represent.
         * A client that composes tile addresses from page geometry has to know
         * this, or it will ask for a grid the protocol cannot carry.
         */
        w.Member("maxTileRes", static_cast<int>(kMaxTileRes));
        w.Key("commands");
        w.BeginArray();
        for (const char* cmd : {"open", "close", "info", "render", "cancel", "viewport", "tiles", "stats",
                                "diagnostics", "layout", "text", "glyphs", "search", "select", "links", "outline",
                                "pageContentBox", "fontList", "debugText", "debugErrorState"}) {
            w.Element(cmd);
        }
        w.EndArray();
        w.EndObject();
        writer.SendJson(proto::FrameType::Ready, 0, w);
    }

    std::vector<unsigned char> header(4);
    std::vector<char> body;
    for (;;) {
        if (!ReadExact(header.data(), 4)) {
            break;  // stdin closed: the parent went away
        }
        const uint32_t payloadLen = proto::GetU32LE(header.data());
        if (payloadLen < 5 || payloadLen > proto::kMaxFrameBytes) {
            // A malformed length prefix desynchronises the stream permanently:
            // report it and exit rather than reading garbage forever.
            json::Writer w;
            w.BeginObject();
            w.Member("ok", false);
            w.Member("error", "malformed frame length");
            w.Member("length", static_cast<int64_t>(payloadLen));
            w.EndObject();
            writer.SendJson(proto::FrameType::Error, 0, w);
            // Past this point the stream cannot be resynchronised, so the worker
            // must not keep reading. Exit without unwinding: the context and the
            // document are in an unknown state and the parent restarts us.
            std::fflush(stdout);
            std::_Exit(2);
        }
        body.assign(payloadLen, 0);
        if (!ReadExact(reinterpret_cast<unsigned char*>(body.data()), payloadLen)) {
            break;
        }
        const auto type = static_cast<proto::FrameType>(static_cast<unsigned char>(body[0]));
        const uint32_t requestId = proto::GetU32LE(reinterpret_cast<const unsigned char*>(body.data()) + 1);
        const std::string payload(body.data() + 5, payloadLen - 5);

        if (type == proto::FrameType::Shutdown) {
            break;
        }
        if (type == proto::FrameType::Ping) {
            json::Writer w;
            w.BeginObject();
            w.Member("ok", true);
            w.Member("protocolVersion", static_cast<int>(proto::kProtocolVersion));
            w.EndObject();
            writer.SendJson(proto::FrameType::Pong, requestId, w);
            continue;
        }
        if (type == proto::FrameType::Cancel) {
            json::Value request;
            std::string parseError;
            uint32_t target = 0;
            if (json::Parse(payload, request, parseError)) {
                target = static_cast<uint32_t>(std::max(0, request.GetInt("targetRequestId", 0)));
            }
            worker.cache->CancelRequest(target);
            json::Writer w = BeginOk();
            w.Member("cancelled", static_cast<int>(target));
            w.EndObject();
            writer.SendJson(proto::FrameType::Response, requestId, w);
            continue;
        }
        if (type != proto::FrameType::Request) {
            json::Writer w;
            w.BeginObject();
            w.Member("ok", false);
            w.Member("error", std::string("unexpected frame type ") + proto::FrameTypeName(type));
            w.EndObject();
            writer.SendJson(proto::FrameType::Error, requestId, w);
            continue;
        }

        json::Value request;
        std::string parseError;
        if (!json::Parse(payload, request, parseError)) {
            // A bad header is reported per-request and the stream continues: the
            // length prefix already told us where the next frame starts.
            SendError(worker, requestId, "invalid JSON request: " + parseError, "bad_request");
            continue;
        }

        // Every request must leave mupdf's error stack exactly as it found it. A
        // leak here is what eventually trips fz_drop_context's assert (a modal
        // abort in the debug DLL), so a stray frame is reported as soon as it
        // appears rather than at shutdown.
        const int stackBefore = StackDepth(worker.engine->BaseCtx());
        try {
            HandleRequest(worker, requestId, request);
        } catch (const std::exception& e) {
            SendError(worker, requestId, std::string("internal error: ") + e.what(), "internal");
        } catch (...) {
            SendError(worker, requestId, "internal error", "internal");
        }
        const int stackAfter = StackDepth(worker.engine->BaseCtx());
        if (stackAfter != stackBefore) {
            json::Writer w;
            w.BeginObject();
            w.Member("level", "error");
            w.Member("message", "mupdf error stack leaked a frame handling '" +
                                     request.GetString("cmd") + "': " + std::to_string(stackBefore) + " -> " +
                                     std::to_string(stackAfter));
            w.EndObject();
            writer.SendJson(proto::FrameType::Log, 0, w);
        }
    }

    // Order matters. RenderCache::Stop() joins the render threads, and a thread
    // parked on its 100 ms poll only needs the queue lock to exit -- never the
    // engine lock. CloseDocument(), by contrast, holds the engine-wide render
    // lock while dropping pages and display lists, so calling it *before* the
    // pool is joined deadlocks against a worker that is mid-render. Text tasks
    // touch only the text cache, so they are stopped first.
    worker.StopTaskThread();
    worker.cache->Stop();
    worker.CloseAdapter();
    engine.CloseDocument();

    // Nothing is left to flush: every frame is written with fflush inside
    // FrameWriter, and the input stream is at EOF. Exiting here is deliberate --
    // it guarantees the parent gets the exit it is waiting for instead of
    // relying on static destructors, which are not guaranteed to run after a
    // longjmp from mupdf, and it lets the loader unload libmupdf.dll without
    // running a debug-build assertion during process teardown.
    std::fflush(stdout);
    std::fflush(stderr);
    std::_Exit(0);
}

}  // namespace
}  // namespace eukolia

int main() {
    return eukolia::Run();
}
