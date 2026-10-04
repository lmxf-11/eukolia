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
//   * Tile size is adaptive, as in the reference: the default comes from the
//     screen, ReduceTileSize() halves a tile axis under memory pressure and
//     throws the cache away to make the saving real, and a caller that pins an
//     explicit size suspends the halving for as long as it is pinned. The
//     reference's fixed `kTargetTileSize` of 768 had no memory-pressure path at
//     all, so a 4K page at high zoom could only ever evict, never subdivide.
//   * Render threads are spawned on demand up to the Start() ceiling, matching
//     RenderCache.cpp:112-116 ("many sessions only ever need a couple of render
//     threads, so creating 8+ upfront is wasteful").
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
#include <unordered_map>
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

/**
 * The largest tile resolution whose row/column indices still fit the 16-bit
 * `TilePosition` fields.
 *
 * A res-r tile is addressed by a row and a col in [0, 2^r); res 16 would need
 * 65536 of them, which does not fit. `TilesForPage()` would also spin forever on
 * `uint16_t` loop counters at that point. Real geometry never reaches it -- at
 * kMinTileDimension a page axis would have to be 200 * 2^15 pixels before res 15
 * is even asked for -- but the bound is enforced rather than assumed, because a
 * caller-supplied `res` is untrusted input from the host.
 */
constexpr uint16_t kMaxTileRes = 15;

/**
 * The inclusive page-space rectangle a request covers.
 *
 * This is the cache's region identity, and it is deliberately *tile-flavoured*:
 * the worker turns a `tile` into the exact rectangle of that grid cell in page
 * space (and any page-space `clip` that does not line up with the grid is stored
 * as itself). Two requests for the same pixels -- one spelled as a tile, one as
 * the equivalent clip -- therefore compare equal and share one cached bitmap
 * instead of holding two copies. That is what makes the tile route and the
 * clip route interoperable during the migration in PDFVIEWER.md §11 phase 2.
 */
struct CacheRegion {
    bool set = false;
    RectF rect{};

    bool Equals(const CacheRegion& o) const {
        if (set != o.set) return false;
        if (!set) return true;
        return rect.x == o.rect.x && rect.y == o.rect.y && rect.dx == o.rect.dx && rect.dy == o.rect.dy;
    }
    /** True when this region and `o` have identical geometry (both must be set). */
    bool SameRect(const CacheRegion& o) const {
        return set && o.set && rect.x == o.rect.x && rect.y == o.rect.y && rect.dx == o.rect.dx && rect.dy == o.rect.dy;
    }
    bool Empty() const {
        return !set || rect.dx <= 0 || rect.dy <= 0;
    }
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
    CacheRegion region;
};

// light-pdf: RenderCache.h BitmapCacheEntry, minus the DisplayModel pointer.
struct CacheEntry {
    CacheKey key;
    std::shared_ptr<mupdf::Pixmap> bitmap;
    uint64_t lastUsed = 0;
};

inline size_t EntryBytes(const CacheEntry& entry) {
    return entry.bitmap ? entry.bitmap->samples.size() : 0;
}

/**
 * Region containment, used only by the "a whole-page render supersedes its own
 * regions" rule in `Store()`. Tolerance is a small epsilon because the two
 * rectangles arrive from different arithmetic paths (a tile rect from the grid,
 * a page rect from MuPDF's rounded device box mapped back).
 */
inline bool RegionContains(const RectF& outer, const RectF& inner) {
    constexpr float kEps = 0.5f;
    return inner.x >= outer.x - kEps && inner.y >= outer.y - kEps &&
           inner.x + inner.dx <= outer.x + outer.dx + kEps &&
           inner.y + inner.dy <= outer.y + outer.dy + kEps;
}

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
    /**
     * The page-space rectangle to rasterise. Unset means "the tile's rectangle",
     * and with no tile either, "the whole page".
     *
     * `tile` and `region` are two spellings of the same thing, and the worker
     * resolves the tile into `region` before submitting for exactly that reason:
     * one region identity means a tile and its congruent clip are one cache entry,
     * not two copies of the same pixels.
     */
    CacheRegion region;
    uint64_t sequence = 0;
    uint64_t documentRevision = 0;
    /**
     * The tile target this job should be judged against, and whether the caller
     * named it explicitly.
     *
     * The host knows its real viewport, which the worker cannot observe, so a
     * request that supplies `targetTileSize` pins it: the tile geometry is a
     * contract the caller composed its tile addresses from, and halving it
     * mid-flight would silently change what those addresses mean. Only the
     * adaptive default (tileSizePinned == false) is subject to ReduceTileSize().
     */
    int targetTileSize = 0;  // 0 = use the cache's current adaptive size
    bool tileSizePinned = false;
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
    // Lifecycle transactions exclude replay and text tasks, including cache
    // publication. Queued jobs are tagged so they cannot cross a commit.
    std::recursive_mutex documentMutex;
    std::atomic<uint64_t> documentRevision{0};
    // light-pdf: MAX_BITMAPS_CACHED / MAX_PAGE_REQUESTS. The reference caps by
    // entry count and notes the real bound should be bytes; here both are used.
    static constexpr int kMaxCacheEntries = 256;
    // 512 MiB of cached pixels. A single 4K page render is ~50 MB, so this
    // bounds memory without evicting a modest working set.
    static constexpr size_t kMaxCacheBytes = 512ull * 1024ull * 1024ull;
    /**
     * Environment override for the byte budget, for testing only.
     *
     * Reaching the real 512 MiB budget from a test needs a >2 GB single pixmap,
     * and a contiguous allocation that size fails on Windows before the cache is
     * ever consulted -- so `EUKOLIA_PDF_CACHE_MB` lowers the budget and lets the
     * pressure path (light-pdf's ReduceTileSize) be exercised with ordinary
     * renders. Unset, the shipped behaviour is exactly kMaxCacheBytes.
     */
    static constexpr const char* kCacheBytesEnvVar = "EUKOLIA_PDF_CACHE_MB";
    static constexpr int kMaxQueuedRequests = 512;
    // light-pdf: RenderCache.h kMaxRenderThreads = 32. The pool is spawned
    // lazily, so this is a ceiling rather than an allocation.
    static constexpr int kMaxRenderThreads = 32;
    /**
     * How many raster *generations* of one page/rotation may be held at once.
     *
     * Retaining the previous scale is what lets the viewer keep using the pixels
     * it already has during a zoom or a resize instead of going blank. Retaining
     * more than a couple is not: a continuous zoom walks through dozens of scales
     * and only the newest two are ever a plausible fallback, so the old ones are
     * evicted rather than accumulated. See `Store()`/`EvictFor()`.
     */
    static constexpr int kGenerationsPerPage = 2;
    /**
     * How many distinct inverts/gray modes of one page/rotation/scale are kept.
     * One: a document is read inverted or not, not both at once.
     */
    static constexpr int kVariantsPerGeneration = 1;
    /**
     * light-pdf: RenderCache::maxTileSize, initialised from
     * `GetSystemMetrics(SM_CXSCREEN/SM_CYSCREEN)` (RenderCache.cpp:96).
     *
     * The default is a *pair*, because the reference sizes tiles to the screen
     * and then halves whichever axis is larger (ReduceTileSize), leaving tiles
     * non-square whenever the screen is. Read it with TargetTileSize() rather
     * than assuming a square tile.
     */
#if defined(_WIN32)
    static constexpr int kDefaultTileWidth = 1024;
    static constexpr int kDefaultTileHeight = 768;
#else
    // No GetSystemMetrics off Windows; the reference's own starting point
    // before it halves anything is the screen, and this is a conservative
    // stand-in for a machine whose screen size is not observable.
    static constexpr int kDefaultTileWidth = 1024;
    static constexpr int kDefaultTileHeight = 768;
#endif
    // light-pdf: ReduceTileSize() refuses to go below 200 in either axis.
    static constexpr int kMinTileDimension = 200;

    using JobCompleteFn = std::function<void(RenderOutcome&&)>;

    RenderCache(PdfEngine* engine, JobCompleteFn onComplete);
    ~RenderCache();

    RenderCache(const RenderCache&) = delete;
    RenderCache& operator=(const RenderCache&) = delete;

    /**
     * Record the desired number of render threads (clamped to
     * kMaxRenderThreads). light-pdf creates its worker threads lazily, in
     * Render() when work appears and no idle thread is available
     * (RenderCache.cpp:112-116) -- many sessions only need a couple -- so this
     * only sets the ceiling; threads start on demand in Submit().
     */
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

    // The tile target in use right now. Equal to the caller-supplied size while
    // a request pinned one; otherwise the adaptive value.
    int TargetTileSize() const;

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
        int threadsSpawned = 0;
        int targetTileSize = 0;
        uint64_t servedFromCache = 0;
        uint64_t rendered = 0;
        uint64_t aborted = 0;
        uint64_t evicted = 0;
        uint64_t tileSizeReductions = 0;
        /**
         * Renders that produced pixels but were deliberately not cached because
         * the entry alone was larger than the whole byte budget (PDFVIEWER.md §5:
         * "subdivide/reject caching with a diagnostic, not silently cache an
         * unbounded image").
         */
        uint64_t skippedOversized = 0;
        /** Evictions attributed to each rule, so a bug can be localised from a probe. */
        uint64_t evictedUnwantedPages = 0;
        uint64_t evictedOldGeneration = 0;
        uint64_t evictedOldVariant = 0;
        uint64_t evictedBudget = 0;
        /** Entries dropped because a whole-page render superseded them. */
        uint64_t evictedSuperseded = 0;
        /** Diagnostics raised by the cache, readable through the worker's `diagnostics` route. */
        std::vector<std::string> diagnostics;
    };
    Stats GetStats() const;

    /**
     * A description of every cached entry, oldest first.
     *
     * Diagnostics only, and deliberately not part of `Stats`: it is O(entries) and
     * allocates, so a periodic counter poll must not pay for it. The A/B/A
     * investigation in PDFVIEWER.md §2 could only report "cacheEntries stayed at
     * 1", which does not say *which* entry survived; this does.
     */
    struct EntryInfo {
        int pageIndex = 0;
        int rotation = 0;
        float scale = 0;
        TilePosition tile;
        bool invert = false;
        bool gray = false;
        RectF pageRect;
        size_t bytes = 0;
        int width = 0;
        int height = 0;
        uint64_t lastUsed = 0;
    };
    std::vector<EntryInfo> DescribeEntries() const;

    /**
     * Take (and clear) the diagnostics the cache has raised. Kept separate from
     * GetStats() so a periodic `stats` poll does not have to carry text, and so
     * the oversized-entry case can be reported once rather than per poll.
     */
    std::vector<std::string> TakeDiagnostics();

  private:
    friend class detail::RenderWorker;

    struct QueueItem {
        RenderJob job;
        uint64_t sequence = 0;
    };

    bool TakeNext(QueueItem& out, int threadIndex, uint32_t& currentRequestId);
    void ClearCurrent(int threadIndex);
    /** Called once by a freshly started worker as it enters its wait loop. */
    void MarkWorkerStarted();
    void RunJob(const RenderJob& job, RenderOutcome& out);
    void Store(const RenderJob& job, const std::shared_ptr<mupdf::Pixmap>& bitmap);
    std::shared_ptr<mupdf::Pixmap> Find(const RenderJob& job, RectF& pageRect, mupdf::PageView& view);
    /**
     * light-pdf: ReduceTileSize() (RenderCache.cpp:496-519). The reference's
     * memory strategy is not "evict a few bitmaps" but "make the working set
     * smaller", because at high zoom one tile can be tens of megabytes and
     * evicting neighbours only refetches them. It halves the larger tile axis --
     * which leaves tiles non-square -- and throws the whole cache and queue away,
     * since nothing rendered at the old tile geometry is reusable.
     *
     * Returns false when a caller has pinned an explicit tile size, or when
     * either axis is already at kMinTileDimension; the caller then falls back to
     * plain eviction.
     *
     * CONTRACT: the caller must already hold cacheMutex_ (this is reached from
     * Store() -> EvictFor()). It takes queueMutex_ itself, in that order.
     */
    bool ReduceTileSize();
    /**
     * light-pdf: FreeIfFull() + DropCacheEntryIfNotUsed(), with the fixes
     * PDFVIEWER.md §2 records. Caller holds cacheMutex_. `incomingBytes` is the
     * size of the entry about to be inserted, so the budget is tested against the
     * state that will exist after the insert rather than only the current one.
     *
     * Distant and least-recently-used resources go first; entries for pages the
     * viewport still wants are retained as long as the budget allows. Removal is
     * by *victim index* into a stable sort, because the reference's
     * "sort so the victims sort first, then pop the back" picked exactly the
     * entries it meant to protect.
     */
    void EvictFor(size_t incomingBytes);
    /** Remove every entry with this (page, rotation, scale) generation. Caller holds cacheMutex_. */
    void DropGeneration(int pageIndex, int rotation, float scale);
    bool PageWanted(int pageIndex) const;
    int PageDistance(int pageIndex) const;
    RenderPriority RetunePriority(int pageIndex, RenderPriority current) const;
    void AddDiagnostic(const std::string& message);

    /**
     * light-pdf: Render(). Spawns a worker when work is queued and no idle
     * thread exists, up to the Start() ceiling. Must be called with queueMutex_
     * NOT held.
     */
    void EnsureWorker();

    PdfEngine* engine_;
    JobCompleteFn onComplete_;

    mutable std::mutex tileMutex_;
    int tileWidth_ = kDefaultTileWidth;
    int tileHeight_ = kDefaultTileHeight;
    // Set while any submitter pins an explicit tile size (the host telling us
    // its real viewport); adaptive reduction is suspended then, so a caller's
    // explicit choice cannot be silently halved out from under it.
    int pinnedTileSize_ = 0;

    mutable std::mutex cacheMutex_;
    std::vector<CacheEntry> cache_;
    size_t cacheBytes_ = 0;
    // kMaxCacheBytes unless kCacheBytesEnvVar overrides it (tests only).
    size_t cacheBudgetBytes_ = kMaxCacheBytes;

    mutable std::mutex queueMutex_;
    std::condition_variable queueCv_;
    std::deque<QueueItem> queue_;
    std::vector<uint32_t> activeRequests_;
    std::vector<QueueItem> activeItems_;
    std::atomic<bool> shouldExit_{false};
    uint64_t sequence_ = 0;
    int threadCeiling_ = 1;
    size_t workersSpawned_ = 0;
    /**
     * Workers that exist but have not yet reached their wait loop.
     *
     * light-pdf spawns a thread for every `Render()` that finds no idle thread
     * (RenderCache.cpp:112-116), which is correct when calls are spaced out and
     * wrong when a viewport update queues thirty prefetches in a burst: every one
     * of those Submits sees no idle thread, because the ones already spawned have
     * not started yet either. A three-request A/B/A sequence was measured spawning
     * three workers. Counting the in-flight spawns makes "is there an idle worker"
     * answerable in a burst, without changing the lazy policy.
     */
    size_t pendingWorkers_{0};
    // Counted separately from Stats because ReduceTileSize() runs under
    // cacheMutex_ (via Store -> EvictFor) and so cannot take statsMutex_.
    std::atomic<uint64_t> tileSizeReductions_{0};

    // mutable because GetStats() is const and reports the pool size.
    mutable std::mutex workersMutex_;
    std::vector<std::unique_ptr<detail::RenderWorker>> workers_;

    mutable std::mutex viewportMutex_;
    std::vector<int> visiblePages_;
    std::vector<int> adjacentPages_;
    std::vector<int> nearbyPages_;

    mutable std::mutex statsMutex_;
    Stats stats_;
    /** Raised under cacheMutex_ (Store/EvictFor), drained by TakeDiagnostics(). */
    mutable std::mutex diagnosticsMutex_;
    std::vector<std::string> diagnostics_;
};

}  // namespace eukolia

#endif  // EUKOLIA_NATIVE_PDF_RENDER_CACHE_H
