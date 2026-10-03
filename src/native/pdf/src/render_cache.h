// Tiled background render cache.
//
// Ported from References/light-pdf/src/RenderCache.h / RenderCache.cpp. The
// design is kept:
//
//   * tiles are addressed by (res, row, col) exactly as light-pdf does, with
//     res = 0 meaning "the whole page";
//   * a page is rendered as a display list, so a tile replay is cheap and the
//     cache key is (page, zoom, rotation, tile);
//   * a fixed-size array of render requests is filled from the front and drained
//     from the back, so the newest request has the highest priority;
//   * duplicate requests are reordered instead of queued twice;
//   * requests for tiles/resolutions that are no longer wanted are cleared;
//   * in-flight renders whose viewport has moved on are abandoned rather than
//     cancelled (mupdf cannot interrupt a display-list replay safely);
//   * the cache is bounded and evicts invisible pages first.
//
// What changed for headless use:
//
//   * Win32 primitives are gone: HANDLE/semaphore -> std::mutex +
//     std::condition_variable, CreateThread -> std::thread, GetTickCount64 ->
//     std::chrono::steady_clock, AbortCookie -> an atomic flag checked between
//     operations.
//   * light-pdf renders into a GDI HDC through DisplayModel/Pixmap; here every
//     render produces a mupdf::Pixmap that is handed to a completion callback on
//     the worker's writer thread.
//   * light-pdf's priorities are implied by "clear the queue for this page then
//     push"; here explicit priority levels encode the visible > adjacent >
//     nearby policy required by Instructions.md §36.
//   * Predictive chaining (kMaxPredictiveRequests) is replaced by the explicit
//     prefetch queue, which is what a viewport-driven caller actually wants.
//
// Copyright 2026 the Eukolia project authors.
// SPDX-License-Identifier: GPL-3.0-or-later

#ifndef EUKOLIA_NATIVE_PDF_RENDER_CACHE_H
#define EUKOLIA_NATIVE_PDF_RENDER_CACHE_H

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "geom.h"
#include "mupdf_engine.h"

namespace eukolia {

// light-pdf: RenderCache.h TilePosition. A tile starts at
// (col / 2^res * page_width, row / 2^res * page_height); res 0 is the whole page.
struct TilePosition {
    uint16_t res = 0;
    uint16_t row = 0;
    uint16_t col = 0;

    bool operator==(const TilePosition& o) const { return res == o.res && row == o.row && col == o.col; }
};

// light-pdf orders render work only by queue position. Because the worker is
// driven by viewport updates, the reference's implicit ordering is expressed
// explicitly; these map onto the reference's "clear obsolete work, push the
// wanted tile last" behaviour.
enum class RenderPriority : int {
    Nearby = 0,    // pages within the prefetch window but not adjacent
    Adjacent = 1,  // pages next to the visible ones
    Visible = 2,   // tiles on screen right now
};

struct CacheKey {
    int pageIndex = 0;
    int rotation = 0;
    float scale = 0;
    TilePosition tile;
    bool invert = false;
    bool gray = false;
    /**
     * The page-space rectangle a partial render covers; unset means the whole page.
     *
     * It belongs in the key: a band and the whole page at the same scale are
     * different pixels, and without this a clipped job is served the cached
     * whole-page bitmap. Rendering bands instead of whole pages depends on it.
     */
    bool hasClip = false;
    RectF clip;

    bool operator==(const CacheKey& o) const {
        return pageIndex == o.pageIndex && rotation == o.rotation && scale == o.scale && tile == o.tile &&
               hasClip == o.hasClip &&
               (!hasClip || (clip.x == o.clip.x && clip.y == o.clip.y && clip.dx == o.clip.dx && clip.dy == o.clip.dy)) &&
               invert == o.invert && gray == o.gray;
    }
};

// light-pdf: RenderCache.h BitmapCacheEntry, minus the DisplayModel pointer.
struct CacheEntry {
    CacheKey key;
    std::shared_ptr<mupdf::Pixmap> bitmap;
    uint64_t lastUsed = 0;
};

// What the caller asks for. `scale` is the device scale (1 = one pixel per PDF
// point), which corresponds to light-pdf's GetZoomReal().
struct RenderJob {
    uint32_t requestId = 0;   // 0 = internal prefetch, nothing is streamed back
    int pageIndex = 0;
    float scale = 1.0f;
    int rotation = 0;
    TilePosition tile;
    bool invert = false;
    bool gray = false;
    RenderPriority priority = RenderPriority::Visible;
    bool allowCache = true;
    // Page-space clip for a partial render; unset means "the tile's rectangle".
    bool hasClip = false;
    RectF clip;
    uint64_t sequence = 0;
};

struct RenderOutcome {
    uint32_t requestId = 0;
    int pageIndex = 0;
    float scale = 1.0f;
    int rotation = 0;
    TilePosition tile;
    bool invert = false;
    bool gray = false;
    bool fromCache = false;
    bool ok = false;
    bool aborted = false;
    std::string error;
    std::shared_ptr<mupdf::Pixmap> bitmap;
    RectF pageRect;
    mupdf::PageView view;
};

class RenderCache;

namespace detail {

// light-pdf: RenderCacheThread(). One worker per thread, each draining the queue
// until it is empty; a thread that finds nothing to do parks on the condition
// variable, exactly like the reference's WaitForSingleObject(startRendering).
class RenderWorker {
  public:
    RenderWorker(RenderCache* cache, int index);
    void Start();
    void Stop();

  private:
    void Loop();

    RenderCache* cache_;
    int index_;
    std::thread thread_;
};

}  // namespace detail

class RenderCache {
  public:
    // light-pdf: MAX_BITMAPS_CACHED / MAX_PAGE_REQUESTS. The reference caps by
    // entry count and notes the real bound should be bytes; here both are used.
    static constexpr int kMaxCacheEntries = 256;
    // 512 MiB of cached pixels. A single 4K page render is ~50 MB, so this
    // bounds memory without evicting a modest working set.
    static constexpr size_t kMaxCacheBytes = 512ull * 1024ull * 1024ull;
    static constexpr int kMaxQueuedRequests = 512;
    static constexpr int kMaxRenderThreads = 8;
    // light-pdf: RenderCache's maxTileSize. Tiles at a given resolution are at
    // most this large, which bounds per-tile memory and render latency.
    static constexpr int kTargetTileSize = 768;

    using JobCompleteFn = std::function<void(RenderOutcome&&)>;

    RenderCache(PdfEngine* engine, JobCompleteFn onComplete);
    ~RenderCache();

    RenderCache(const RenderCache&) = delete;
    RenderCache& operator=(const RenderCache&) = delete;

    // Start the pool with `threads` workers (clamped to kMaxRenderThreads).
    void Start(int threads);
    void Stop();

    // Queue a job. Returns false when the job was rejected outright (unknown
    // page, absurd scale, or a queue that is full of higher-priority work).
    bool Submit(RenderJob job);

    // Serve a job from the cache without queueing. Returns true when `out` was
    // filled. This is the worker's fast path for repeat/blit requests.
    bool TryGetCached(const RenderJob& job, RenderOutcome& out);

    // light-pdf: CancelRendering(dm) + ClearQueueForDisplayModel(). Drops every
    // queued job for `requestId` and marks an in-flight one as aborted.
    void CancelRequest(uint32_t requestId);

    // Tells the cache which pages are wanted, so obsolete queued work can be
    // dropped and prefetches can be prioritised. `visible` is the ordered list
    // of fully or partially visible pages, `adjacent` the neighbours to prefetch
    // and `nearby` the wider window.
    void SetViewport(const std::vector<int>& visible, const std::vector<int>& adjacent,
                     const std::vector<int>& nearby);

    // light-pdf: FreeForDisplayModel() / FreeNotVisible(). Called after the
    // document changes or the viewport moves a long way.
    void InvalidateAll();
    void DropPage(int pageIndex);

    // Determine the tile resolution for a page/scale/rotation, following
    // light-pdf's GetTileRes(): powers of two, geometric mean of the two axis
    // factors, halved for fit-page/fit-width/small pages.
    static uint16_t TileResFor(float pageWidthPx, float pageHeightPx, bool fitMode, int targetTileSize);
    static std::vector<TilePosition> TilesForPage(float pageWidthPx, float pageHeightPx, int targetTileSize);
    static RectF TileRectInPage(const RectF& mediaBox, TilePosition tile);

    // Stats for `stats` requests.
    struct Stats {
        int entries = 0;
        size_t bytes = 0;
        int queued = 0;
        int active = 0;
        uint64_t servedFromCache = 0;
        uint64_t rendered = 0;
        uint64_t aborted = 0;
        uint64_t evicted = 0;
    };
    Stats GetStats() const;

  private:
    friend class detail::RenderWorker;

    struct QueueItem {
        RenderJob job;
        uint64_t sequence = 0;
    };

    bool TakeNext(QueueItem& out, int threadIndex, uint32_t& currentRequestId);
    void ClearCurrent(int threadIndex);
    void RunJob(const RenderJob& job, RenderOutcome& out);
    void Store(const RenderJob& job, const std::shared_ptr<mupdf::Pixmap>& bitmap);
    std::shared_ptr<mupdf::Pixmap> Find(const RenderJob& job, RectF& pageRect, mupdf::PageView& view);
    void EvictFor(size_t incomingBytes);
    bool PageWanted(int pageIndex) const;
    int PageDistance(int pageIndex) const;
    RenderPriority RetunePriority(int pageIndex, RenderPriority current) const;

    PdfEngine* engine_;
    JobCompleteFn onComplete_;

    mutable std::mutex cacheMutex_;
    std::vector<CacheEntry> cache_;
    size_t cacheBytes_ = 0;

    mutable std::mutex queueMutex_;
    std::condition_variable queueCv_;
    std::deque<QueueItem> queue_;
    std::vector<uint32_t> activeRequests_;
    std::vector<QueueItem> activeItems_;
    std::atomic<bool> shouldExit_{false};
    uint64_t sequence_ = 0;

    std::vector<std::unique_ptr<detail::RenderWorker>> workers_;

    mutable std::mutex viewportMutex_;
    std::vector<int> visiblePages_;
    std::vector<int> adjacentPages_;
    std::vector<int> nearbyPages_;

    mutable std::mutex statsMutex_;
    Stats stats_;
};

}  // namespace eukolia

#endif  // EUKOLIA_NATIVE_PDF_RENDER_CACHE_H
