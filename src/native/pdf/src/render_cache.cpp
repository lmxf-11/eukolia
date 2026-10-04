// Tiled background render cache -- implementation.
//
// See render_cache.h for the port notes. Function-for-function correspondence
// with References/light-pdf/src/RenderCache.cpp is called out in comments.

#include "render_cache.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>

#ifdef _WIN32
// light-pdf: RenderCache.cpp:96 sizes its tiles from the primary screen. The
// cache module is otherwise platform-neutral (that is why it does not include
// windows.h for anything else), so the one call it needs is pulled in here.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace eukolia {

namespace {

uint64_t NowMs() {
    using namespace std::chrono;
    return static_cast<uint64_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

/**
 * light-pdf: `RenderCache::RenderCache() : maxTileSize({GetSystemMetrics(
 * SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)})` (RenderCache.cpp:96).
 *
 * The reference takes the screen size directly. Off Windows there is no such
 * call, so the compiled-in default stands in -- and it is also what a Windows
 * session falls back to if the metrics come back nonsensical (a headless
 * service session reports 0).
 */
void QueryDefaultTileSize(int& width, int& height) {
#ifdef _WIN32
    const int cx = static_cast<int>(::GetSystemMetrics(SM_CXSCREEN));
    const int cy = static_cast<int>(::GetSystemMetrics(SM_CYSCREEN));
    if (cx >= RenderCache::kMinTileDimension && cy >= RenderCache::kMinTileDimension) {
        width = cx;
        height = cy;
        return;
    }
#endif
    width = RenderCache::kDefaultTileWidth;
    height = RenderCache::kDefaultTileHeight;
}

/**
 * The cache byte budget: kMaxCacheBytes, unless EUKOLIA_PDF_CACHE_MB lowers it.
 *
 * The override exists so a test can reach the memory-pressure path with ordinary
 * renders; see the constant's comment in the header. A value that is not a
 * positive integer is ignored rather than treated as zero, so a typo cannot
 * silently disable the cache.
 */
size_t CacheBudgetBytes() {
    const char* raw = std::getenv(RenderCache::kCacheBytesEnvVar);
    if (!raw || !*raw) return RenderCache::kMaxCacheBytes;
    char* end = nullptr;
    const long mb = std::strtol(raw, &end, 10);
    if (end == raw || (end && *end != '\0') || mb <= 0) return RenderCache::kMaxCacheBytes;
    return static_cast<size_t>(mb) * 1024ull * 1024ull;
}

/**
 * The page-space rectangle a job covers: its explicit region when it has one, the
 * grid cell of its tile when it names a tile instead, and the whole page when it
 * names neither.
 *
 * This is the single place a tile address becomes geometry, so the worker's tile
 * route and its clip route cannot drift apart. It deliberately does no rounding of
 * its own: a request has to be recognisable by the same arithmetic that produced
 * it, and the host that composes tile addresses is the one that owns their grid.
 * The snap that matters happens in `Store()`, against the rectangle MuPDF reports
 * it actually drew.
 */
CacheRegion ResolveJobRegion(const RenderJob& job, const mupdf::PageView& view) {
    if (job.region.set) return job.region;

    CacheRegion region;
    region.set = true;
    if (job.tile.res != 0 || job.tile.row != 0 || job.tile.col != 0) {
        region.rect = RenderCache::TileRectInPage(view.mediaBox, job.tile);
    } else {
        region.rect = view.mediaBox;
    }
    return region;
}

/**
 * Cache-key equality, spelled out once so `Find()` and `Store()` cannot disagree
 * about what "the same entry" means.
 *
 * `scale` is compared exactly, as in the reference: callers that want a cached
 * bitmap must ask for the scale it was rendered at, and the viewer quantises the
 * scale it requests (see `pdfRenderScale`). A fuzzy comparison here would serve
 * pixels that are subtly the wrong size, which is worse than a miss.
 */
bool SameCacheKey(const CacheKey& a, const CacheKey& b) {
    return a.pageIndex == b.pageIndex && a.rotation == b.rotation && a.scale == b.scale &&
           a.tile == b.tile && a.invert == b.invert && a.gray == b.gray && a.region.Equals(b.region);
}

/** Same page, same rotation, same raster scale: one rasterisation generation. */
bool SameGeneration(const CacheKey& a, const CacheKey& b) {
    return a.pageIndex == b.pageIndex && a.rotation == b.rotation && a.scale == b.scale;
}

/**
 * Two entries that differ only in colour mode, i.e. two colour variants of one
 * rasterisation.
 *
 * A page is read inverted or not, and in colour or grey, but only one of those at
 * a time. An entry of the same generation with a *different* invert/gray is
 * therefore the obsolete variant whose replacement is about to be written, and
 * exactly one of them belongs in the cache.
 *
 * Note what this is not: an entry of a different generation is a retained
 * fallback scale (`kGenerationsPerPage`), and an entry of the same generation with
 * the same colour mode is a *sibling tile* -- both are kept. Conflating either of
 * those with "the same thing" is what made storing a tile evict its neighbour.
 */
bool IsOtherColourVariant(const CacheKey& existing, const CacheKey& incoming) {
    return SameGeneration(existing, incoming) && (existing.invert != incoming.invert || existing.gray != incoming.gray);
}

}  // namespace

// light-pdf: RenderCache.cpp GetTileRect(). Note the vertical flip: MuPDF tile
// row 0 is the *bottom* row in PDF user space, and the reference keeps that
// convention so tile addresses stay stable across rotations.
RectF GetTileRect(const RectF& pageRect, TilePosition tile) {
    RectF rect;
    rect.dx = pageRect.dx / static_cast<float>(1ull << tile.res);
    rect.dy = pageRect.dy / static_cast<float>(1ull << tile.res);
    rect.x = pageRect.x + static_cast<float>(tile.col) * rect.dx;
    rect.y = pageRect.y + static_cast<float>((1ull << tile.res) - tile.row - 1) * rect.dy;
    return rect;
}

namespace detail {

RenderWorker::RenderWorker(RenderCache* cache, int index) : cache_(cache), index_(index) {}

void RenderWorker::Start() {
    thread_ = std::thread([this] { Loop(); });
}

void RenderWorker::Stop() {
    if (thread_.joinable()) {
        thread_.join();
    }
}

// light-pdf: RenderCacheThread().
void RenderWorker::Loop() {
    // Tell the cache this thread is now available for work, so a burst of
    // submissions does not mistake "not started yet" for "no idle thread".
    cache_->MarkWorkerStarted();

    RenderCache::QueueItem item;
    uint32_t currentRequestId = 0;
    for (;;) {
        if (cache_->shouldExit_.load(std::memory_order_relaxed)) break;

        currentRequestId = 0;
        if (!cache_->TakeNext(item, index_, currentRequestId)) {
            std::unique_lock<std::mutex> lock(cache_->queueMutex_);
            cache_->queueCv_.wait_for(lock, std::chrono::milliseconds(100), [this] {
                return cache_->shouldExit_.load(std::memory_order_relaxed) || !cache_->queue_.empty();
            });
            continue;
        }

        RenderOutcome outcome;
        cache_->RunJob(item.job, outcome);

        cache_->ClearCurrent(index_);

        if (cache_->onComplete_ && item.job.requestId != 0) {
            cache_->onComplete_(std::move(outcome));
        }
    }
    cache_->ClearCurrent(index_);
}

}  // namespace detail

RenderCache::RenderCache(PdfEngine* engine, JobCompleteFn onComplete)
    : engine_(engine), onComplete_(std::move(onComplete)) {
    QueryDefaultTileSize(tileWidth_, tileHeight_);
    cacheBudgetBytes_ = CacheBudgetBytes();
    activeRequests_.assign(kMaxRenderThreads, 0);
    activeItems_.resize(kMaxRenderThreads);
}

RenderCache::~RenderCache() {
    Stop();
}

int RenderCache::TargetTileSize() const {
    std::lock_guard<std::mutex> lock(tileMutex_);
    if (pinnedTileSize_ > 0) return pinnedTileSize_;
    // Tiles are non-square in general; the resolution formula only takes one
    // number, so use the geometric mean of the two axes, which is the same
    // reasoning GetTileRes() applies to the two pixel-box factors.
    return static_cast<int>(std::lround(std::sqrt(static_cast<double>(tileWidth_) * static_cast<double>(tileHeight_))));
}

/**
 * light-pdf: RenderCache.cpp:112-116. The reference creates its render threads
 * lazily in Render(), "because many sessions only ever need a couple of render
 * threads, so creating 8+ upfront is wasteful". This is that policy: spawn one
 * worker per call until the Start() ceiling is reached.
 *
 * The caller must not hold queueMutex_ (the worker takes it immediately), which
 * is why Submit() calls this after releasing its own lock.
 */
void RenderCache::EnsureWorker() {
    std::lock_guard<std::mutex> workersLock(workersMutex_);
    if (shouldExit_.load(std::memory_order_relaxed)) return;
    if (static_cast<int>(workers_.size()) >= threadCeiling_) return;

    /**
     * ...but not one per queued job.
     *
     * A viewport update queues every prefetch tile in one burst, and a worker is
     * only "idle" once it has actually reached its wait loop. Asking "is any
     * worker idle" during the burst therefore answers "no" every time and spawns
     * the ceiling. A worker with no active request *and* a worker that has been
     * created but has not started yet are both about to become available, so
     * either of them means this job will be picked up without a new thread.
     *
     * The measured effect of the original rule: a three-request A/B/A sequence in
     * PDFVIEWER.md §2 spawned three workers for three sequential requests, and a
     * twenty-request sweep spawned sixteen (the ceiling).
     */
    {
        std::lock_guard<std::mutex> queueLock(queueMutex_);
        int busy = 0;
        for (uint32_t id : activeRequests_) {
            if (id != 0) busy++;
        }
        if (static_cast<size_t>(busy) + pendingWorkers_ < workers_.size()) return;
    }

    const int index = static_cast<int>(workers_.size());
    auto worker = std::make_unique<detail::RenderWorker>(this, index);
    worker->Start();
    workers_.push_back(std::move(worker));
    pendingWorkers_++;
    workersSpawned_ = workers_.size();

    std::lock_guard<std::mutex> statsLock(statsMutex_);
    stats_.threadsSpawned = static_cast<int>(workers_.size());
}

void RenderCache::MarkWorkerStarted() {
    /**
     * `activeRequests_` and `pendingWorkers_` are indexed differently on purpose:
     * the first is a per-slot array, the second a count. A worker that is still
     * starting has no slot to clear, so it only decrements the count -- and the
     * decrement is combined with the slot test inside the queue lock so the two
     * cannot be sampled half-updated by `EnsureWorker()`.
     */
    std::lock_guard<std::mutex> queueLock(queueMutex_);
    if (pendingWorkers_ > 0) pendingWorkers_--;
}

void RenderCache::Start(int threads) {
    threads = std::max(1, std::min(threads, kMaxRenderThreads));
    std::lock_guard<std::mutex> lock(workersMutex_);
    if (!workers_.empty()) return;
    shouldExit_.store(false, std::memory_order_relaxed);
    // Record the ceiling only; the pool fills on demand in EnsureWorker().
    threadCeiling_ = threads;
    workersSpawned_ = 0;
}

void RenderCache::Stop() {
    shouldExit_.store(true, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        queue_.clear();
    }
    queueCv_.notify_all();
    std::lock_guard<std::mutex> lock(workersMutex_);
    for (auto& worker : workers_) {
        worker->Stop();
    }
    workers_.clear();
    workersSpawned_ = 0;
}

// ---------------------------------------------------------------------------
// Tile geometry -- direct ports of light-pdf's RenderCache helpers
// ---------------------------------------------------------------------------

// light-pdf: RenderCache::GetTileRes(). The reference works from the rendered
// pixel box and the viewport; headless callers already know the pixel size, so
// the same formula is applied to the pixel dimensions directly.
uint16_t RenderCache::TileResFor(float pageWidthPx, float pageHeightPx, bool fitMode, int targetTileSize) {
    if (pageWidthPx <= 0 || pageHeightPx <= 0) return 0;
    // The adaptive target is the compiled-in default only for callers that pass
    // nothing; anything that knows the real geometry should pass it.
    const int tileSize = targetTileSize > 0 ? targetTileSize : kDefaultTileHeight;
    if (tileSize <= 0) return 0;
    const float factorW = pageWidthPx / static_cast<float>(tileSize + 1);
    const float factorH = pageHeightPx / static_cast<float>(tileSize + 1);
    // Geometric mean instead of the maximum factor, so the tile area does not
    // get too small in comparison to the target size (light-pdf comment).
    float factorAvg = std::sqrt(factorW * factorH);

    // "use larger tiles when fitting page or width or when a page is smaller
    // than the visible canvas"
    if (fitMode || pageWidthPx <= tileSize || pageHeightPx < tileSize) {
        factorAvg /= 2.0f;
    }

    uint16_t res = 0;
    if (factorAvg > 1.5f) {
        res = static_cast<uint16_t>(std::ceil(std::log(factorAvg) / std::log(2.0f)));
    }
    // Clamped to the largest resolution whose (row, col) still fits the 16-bit
    // address fields; see kMaxTileRes. The reference clamps to 30 only to keep
    // `1 << res` inside a signed 32-bit int, which is not the binding constraint
    // once tile addresses are 16-bit.
    return std::min<uint16_t>(res, kMaxTileRes);
}

std::vector<TilePosition> RenderCache::TilesForPage(float pageWidthPx, float pageHeightPx, int targetTileSize) {
    std::vector<TilePosition> out;
    const uint16_t res = TileResFor(pageWidthPx, pageHeightPx, false, targetTileSize);
    // `uint32_t`, not `uint16_t`: at kMaxTileRes a uint16_t counter would wrap at
    // 65536 and loop forever, which is the failure the 16-bit fields invite.
    const uint32_t n = 1u << res;
    out.reserve(static_cast<size_t>(n) * static_cast<size_t>(n));
    for (uint32_t row = 0; row < n; row++) {
        for (uint32_t col = 0; col < n; col++) {
            out.push_back(TilePosition{res, static_cast<uint16_t>(row), static_cast<uint16_t>(col)});
        }
    }
    return out;
}

RectF RenderCache::TileRectInPage(const RectF& mediaBox, TilePosition tile) {
    if (tile.res == 0) return mediaBox;
    return GetTileRect(mediaBox, tile);
}

// ---------------------------------------------------------------------------
// Cache lookup / eviction
// ---------------------------------------------------------------------------

std::shared_ptr<mupdf::Pixmap> RenderCache::Find(const RenderJob& job, RectF& pageRect, mupdf::PageView& view) {
    // Resolve the job's region identity *before* taking cacheMutex_: it needs the
    // page's MediaBox, and reaching into the engine while holding the cache lock
    // would add a cacheMutex_ -> engine-state lock edge that `RunJob` does not
    // have in the other direction.
    const mupdf::PageView pageView = engine_->PageView_(job.pageIndex, job.scale, job.rotation);
    const CacheRegion wanted = ResolveJobRegion(job, pageView);
    if (wanted.Empty()) return nullptr;

    CacheKey key;
    key.pageIndex = job.pageIndex;
    key.rotation = NormalizeRotation(job.rotation);
    key.scale = job.scale;
    key.tile = job.tile;
    key.invert = job.invert;
    key.gray = job.gray;
    key.region = wanted;

    std::lock_guard<std::mutex> lock(cacheMutex_);
    for (CacheEntry& entry : cache_) {
        if (!SameCacheKey(entry.key, key)) continue;
        entry.lastUsed = NowMs();
        pageRect = entry.bitmap->pageRect;
        view = pageView;
        return entry.bitmap;
    }
    return nullptr;
}

/**
 * light-pdf: RenderCache::ReduceTileSize() (RenderCache.cpp:496-519).
 *
 * The reference's memory strategy is not "evict a few bitmaps" but "make the
 * working set smaller", because at high zoom a single 4K tile can be tens of
 * megabytes and evicting neighbours only refetches them. So it halves one tile
 * axis -- the larger one, which leaves tiles non-square -- and then throws every
 * cached bitmap and queued request away, since they were all rendered at the old
 * tile geometry and nothing in the cache is reusable at the new one.
 *
 * Returns false once either axis would fall below kMinTileDimension; the caller
 * then falls back to plain eviction. Returns false without doing anything when a
 * caller has pinned an explicit tile size, so the host's own viewport-derived
 * choice is not quietly overridden.
 *
 * Lock order is cacheMutex_ then queueMutex_, matching Submit() -> Store().
 */
bool RenderCache::ReduceTileSize() {
    // Caller holds cacheMutex_ (Store() -> EvictFor()); see the header contract.
    {
        std::lock_guard<std::mutex> tileLock(tileMutex_);
        if (pinnedTileSize_ > 0) return false;
        if (tileWidth_ < kMinTileDimension || tileHeight_ < kMinTileDimension) return false;
        const int nextWidth = tileWidth_ > tileHeight_ ? tileWidth_ / 2 : tileWidth_;
        const int nextHeight = tileWidth_ > tileHeight_ ? tileHeight_ : tileHeight_ / 2;
        if (nextWidth < kMinTileDimension || nextHeight < kMinTileDimension) {
            // light-pdf's guard is "smaller than 200 in either axis", so a
            // halving that would cross the floor is not taken at all.
            return false;
        }
        tileWidth_ = nextWidth;
        tileHeight_ = nextHeight;
    }

    // Everything cached was drawn at the old tile geometry, so none of it is
    // reusable: the reference clears the cache rather than evicting selectively.
    cache_.clear();
    cacheBytes_ = 0;

    {
        std::lock_guard<std::mutex> queueLock(queueMutex_);
        queue_.clear();
    }

    // Runs under cacheMutex_, so it must not touch statsMutex_: dedicated
    // counter, folded into Stats by GetStats().
    tileSizeReductions_.fetch_add(1, std::memory_order_relaxed);
    return true;
}

// light-pdf: FreeIfFull() + DropCacheEntryIfNotUsed(). The reference drops an
// invisible page of the same DisplayModel first and only then the oldest cached
// page from another document. There is exactly one document here, so this drops
// entries whose page is outside the prefetch window, then the furthest and least
// recently used entry.
//
// PDFVIEWER.md §2 recorded three defects in the ported version of this loop, all
// of them fixed here:
//
//   1. the comparator sorted victims *first*, and the eviction loop then popped
//      the *back* -- selecting exactly the close, recently used entries it meant
//      to protect. Removal is now by victim index into that ordering.
//   2. `overBytes` was captured once, before any removal, so pressure kept
//      evicting after the budget had already been met. Pressure is recomputed
//      after every removal.
//   3. the entry-count test was `>` against the count *before* the incoming entry
//      was appended, so the boundary case inserted one entry past the cap.
//      `incomingBytes`/the incoming count are part of every test now.
void RenderCache::EvictFor(size_t incomingBytes) {
    // Caller holds cacheMutex_.
    const size_t projectedBytes = cacheBytes_ + incomingBytes;

    /**
     * Byte pressure is tested on its own, without the entry-count guard the
     * reference puts on it. That guard is correct for *eviction* -- you must not
     * drop the only bitmap you hold -- but it must not gate the decision to
     * subdivide, because the case that most needs subdividing is exactly the one
     * where a single render is already over budget.
     */
    if (projectedBytes > cacheBudgetBytes_ && ReduceTileSize()) {
        // ReduceTileSize() has already cleared cache_ and zeroed cacheBytes_.
        return;
    }

    auto overBudget = [&] {
        return cacheBytes_ + incomingBytes > cacheBudgetBytes_ || cache_.size() + 1 > static_cast<size_t>(kMaxCacheEntries);
    };
    if (!overBudget()) return;

    // Pass 1: pages nobody asked for.
    for (auto it = cache_.begin(); it != cache_.end() && overBudget();) {
        if (!PageWanted(it->key.pageIndex)) {
            cacheBytes_ -= EntryBytes(*it);
            it = cache_.erase(it);
            stats_.evicted++;
            stats_.evictedUnwantedPages++;
        } else {
            ++it;
        }
    }
    if (!overBudget()) return;

    // Pass 2: furthest page first, then least recently used, then the largest --
    // and the *first* entry of that ordering is the victim.
    std::stable_sort(cache_.begin(), cache_.end(), [this](const CacheEntry& a, const CacheEntry& b) {
        const int da = PageDistance(a.key.pageIndex);
        const int db = PageDistance(b.key.pageIndex);
        if (da != db) return da > db;
        if (a.lastUsed != b.lastUsed) return a.lastUsed < b.lastUsed;
        return EntryBytes(a) > EntryBytes(b);
    });
    size_t victim = 0;
    while (overBudget() && victim < cache_.size()) {
        cacheBytes_ -= EntryBytes(cache_[victim]);
        cache_.erase(cache_.begin() + static_cast<std::ptrdiff_t>(victim));
        stats_.evicted++;
        stats_.evictedBudget++;
        // `cache_` shifted left, so `victim` now indexes the next candidate.
    }
}

void RenderCache::DropGeneration(int pageIndex, int rotation, float scale) {
    // Caller holds cacheMutex_.
    for (auto it = cache_.begin(); it != cache_.end();) {
        if (it->key.pageIndex == pageIndex && it->key.rotation == rotation && it->key.scale == scale) {
            cacheBytes_ -= EntryBytes(*it);
            it = cache_.erase(it);
            stats_.evicted++;
            stats_.evictedOldGeneration++;
        } else {
            ++it;
        }
    }
}

/**
 * Store a freshly rendered (or re-submitted) bitmap.
 *
 * PDFVIEWER.md §5 fixes what storing must and must not do:
 *
 *   * replace an identical key, rather than appending a duplicate;
 *   * retain sibling tiles -- the ported version dropped every other entry of the
 *     same page/rotation, so a second tile silently removed the first and the
 *     A/B/A probe could never produce a hit (§2);
 *   * allow a bounded previous-scale fallback generation, but not unlimited
 *     historical zoom levels;
 *   * treat removing another variant as a deliberate decision, not as an
 *     incidental consequence of storing a different region.
 *
 * So the only entries removed here are the ones this render genuinely supersedes:
 * the same region at the same generation (replaced), and -- when this render is
 * the whole page at the same generation -- the bands of that page, which are now
 * redundant because the whole page covers them. Everything else is left to
 * `EvictFor()`, which decides by budget and by what the viewport wants.
 */
void RenderCache::Store(const RenderJob& job, const std::shared_ptr<mupdf::Pixmap>& bitmap) {
    if (!bitmap || bitmap->samples.empty()) return;

    const mupdf::PageView pageView = engine_->PageView_(job.pageIndex, job.scale, job.rotation);
    const CacheRegion region = ResolveJobRegion(job, pageView);

    CacheKey key;
    key.pageIndex = job.pageIndex;
    key.rotation = NormalizeRotation(job.rotation);
    key.scale = job.scale;
    key.tile = job.tile;
    key.invert = job.invert;
    key.gray = job.gray;
    key.region = region;

    std::lock_guard<std::mutex> lock(cacheMutex_);

    /*
     * A render that produced no pixels is not an entry.
     *
     * MuPDF snaps a clip outwards to pixel boundaries, so the *reported* rectangle
     * (bitmap->pageRect) is normally a rounded superset of the requested region.
     * The reported one is what the cache keys: a later request for exactly those
     * pixels with a clip that maps to the same device box then compares equal,
     * instead of being missed and rendered a second time.
     */
    const CacheRegion stored = [&] {
        CacheRegion out = region;
        if (bitmap->pageRect.dx > 0 && bitmap->pageRect.dy > 0) {
            out.set = true;
            out.rect = bitmap->pageRect;
        }
        return out;
    }();
    key.region = stored;

    const bool wholePage = stored.set && RegionContains(stored.rect, pageView.mediaBox);

    // Pass A: this exact entry, and the bands a whole-page render makes redundant.
    for (auto it = cache_.begin(); it != cache_.end();) {
        const bool superseded =
            SameGeneration(it->key, key) &&
            (SameCacheKey(it->key, key) ||                                   // identical key: replaced
             (wholePage && RegionContains(stored.rect, it->key.region.rect)));  // a band it now covers
        if (superseded) {
            cacheBytes_ -= EntryBytes(*it);
            it = cache_.erase(it);
            stats_.evicted++;
            stats_.evictedSuperseded++;
        } else {
            ++it;
        }
    }

    // Pass B: keep only the newest kGenerationsPerPage raster scales of this
    // page/rotation. A continuous zoom walks through dozens of scales, and every
    // one of them is otherwise a permanent entry until the byte budget forces it
    // out -- which is the "unlimited historical zoom levels" §5 rules out. The
    // *previous* generation survives, which is what the viewer's old-scale
    // fallback needs; older ones do not.
    {
        std::vector<float> scales;
        for (const CacheEntry& entry : cache_) {
            if (entry.key.pageIndex == key.pageIndex && entry.key.rotation == key.rotation) {
                if (std::find(scales.begin(), scales.end(), entry.key.scale) == scales.end()) {
                    scales.push_back(entry.key.scale);
                }
            }
        }
        if (scales.size() > 0) {
            // Newest first: the entry being stored is the newest.
            std::stable_sort(scales.begin(), scales.end(), [&key](float a, float b) {
                const float da = std::abs(a - key.scale);
                const float db = std::abs(b - key.scale);
                if (da != db) return da < db;
                return a < b;
            });
            for (size_t i = static_cast<size_t>(kGenerationsPerPage); i < scales.size(); i++) {
                DropGeneration(key.pageIndex, key.rotation, scales[i]);
            }
        }
    }

    // Pass C: the entry's own colour variant is unique. Same generation, same
    // invert/gray -- so at most one entry, because such an entry *is* the same
    // pixels; an older one is obsolete, not a fallback. `IsOtherColourVariant`
    // states that identity, so this and the age policy cannot drift apart.
    //
    // Sibling tiles (same colour mode, different region) and other generations are
    // untouched here; `EvictFor()` is what decides among those.
    for (;;) {
        auto it = std::find_if(cache_.begin(), cache_.end(), [&key](const CacheEntry& entry) {
            return IsOtherColourVariant(entry.key, key);
        });
        if (it == cache_.end()) break;
        cacheBytes_ -= EntryBytes(*it);
        cache_.erase(it);
        stats_.evicted++;
        stats_.evictedOldVariant++;
    }

    /*
     * A single entry larger than the whole budget.
     *
     * light-pdf has no answer for this: `ReduceTileSize()` shrinks the *tile
     * geometry* and clears the cache, but a caller that pins its tile size (which
     * is what a viewport-driven host does) suspends the halving, and a whole-page
     * render at high zoom can then be larger than the entire budget. The entry is
     * handed to the caller -- it asked for those pixels and they exist -- and
     * deliberately not cached, rather than stored with the budget silently
     * exceeded. Caching it would evict everything else on the next store and
     * re-render it immediately, which is worse than no cache at all.
     */
    if (bitmap->samples.size() > cacheBudgetBytes_) {
        stats_.skippedOversized++;
        AddDiagnostic("render cache: a " + std::to_string(bitmap->samples.size()) +
                      " byte render exceeds the " + std::to_string(cacheBudgetBytes_) +
                      " byte budget and was not cached (page " + std::to_string(job.pageIndex) + ", scale " +
                      std::to_string(job.scale) + "); the pixels were still returned to the caller");
        return;
    }

    EvictFor(bitmap->samples.size());

    CacheEntry entry;
    entry.key = key;
    entry.bitmap = bitmap;
    entry.lastUsed = NowMs();
    cacheBytes_ += bitmap->samples.size();
    cache_.push_back(std::move(entry));
}

void RenderCache::InvalidateAll() {
    std::lock_guard<std::recursive_mutex> documentLock(documentMutex);
    ++documentRevision;
    std::lock_guard<std::mutex> lock(cacheMutex_);
    cache_.clear();
    cacheBytes_ = 0;
}

void RenderCache::DropPage(int pageIndex) {
    std::lock_guard<std::mutex> lock(cacheMutex_);
    for (auto it = cache_.begin(); it != cache_.end();) {
        if (it->key.pageIndex == pageIndex) {
            cacheBytes_ -= it->bitmap ? it->bitmap->samples.size() : 0;
            it = cache_.erase(it);
        } else {
            ++it;
        }
    }
}

// ---------------------------------------------------------------------------
// Viewport bookkeeping (light-pdf: DisplayModel::PageVisibleNearby)
// ---------------------------------------------------------------------------

bool RenderCache::PageWanted(int pageIndex) const {
    std::lock_guard<std::mutex> lock(viewportMutex_);
    if (visiblePages_.empty() && adjacentPages_.empty() && nearbyPages_.empty()) {
        // No viewport information yet: keep everything, like a freshly opened
        // document where nothing has scrolled off screen.
        return true;
    }
    auto contains = [pageIndex](const std::vector<int>& v) {
        return std::find(v.begin(), v.end(), pageIndex) != v.end();
    };
    return contains(visiblePages_) || contains(adjacentPages_) || contains(nearbyPages_);
}

int RenderCache::PageDistance(int pageIndex) const {
    std::lock_guard<std::mutex> lock(viewportMutex_);
    int best = 1 << 30;
    for (int p : visiblePages_) {
        best = std::min(best, std::abs(p - pageIndex));
    }
    if (best != (1 << 30)) return best;
    for (int p : adjacentPages_) {
        best = std::min(best, std::abs(p - pageIndex));
    }
    if (best != (1 << 30)) return best + 1000;
    for (int p : nearbyPages_) {
        best = std::min(best, std::abs(p - pageIndex));
    }
    return best == (1 << 30) ? 1 << 20 : best + 100000;
}

RenderPriority RenderCache::RetunePriority(int pageIndex, RenderPriority current) const {
    std::lock_guard<std::mutex> lock(viewportMutex_);
    auto contains = [pageIndex](const std::vector<int>& v) {
        return std::find(v.begin(), v.end(), pageIndex) != v.end();
    };
    if (contains(visiblePages_)) return RenderPriority::Visible;
    if (contains(adjacentPages_)) return std::max(current, RenderPriority::Adjacent);
    return current;
}

void RenderCache::SetViewport(const std::vector<int>& visible, const std::vector<int>& adjacent,
                              const std::vector<int>& nearby) {
    {
        std::lock_guard<std::mutex> lock(viewportMutex_);
        visiblePages_ = visible;
        adjacentPages_ = adjacent;
        nearbyPages_ = nearby;
    }

    // light-pdf: ClearQueueForDisplayModel() with the "tiles of a different
    // resolution and invisible tiles" clause. Any queued request whose page is
    // no longer in the prefetch window is dropped rather than rendered, and the
    // remaining ones are re-prioritised against the new viewport.
    std::lock_guard<std::mutex> lock(queueMutex_);
    std::deque<QueueItem> kept;
    for (QueueItem& item : queue_) {
        if (!PageWanted(item.job.pageIndex)) {
            continue;
        }
        item.job.priority = RetunePriority(item.job.pageIndex, item.job.priority);
        kept.push_back(std::move(item));
    }
    queue_.swap(kept);
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

bool RenderCache::TakeNext(QueueItem& out, int threadIndex, uint32_t& currentRequestId) {
    std::lock_guard<std::mutex> lock(queueMutex_);
    if (queue_.empty()) return false;

    // Highest priority first; within a priority level the most recently queued
    // job wins, which is how light-pdf's LIFO drain behaves.
    size_t bestIndex = 0;
    for (size_t i = 1; i < queue_.size(); i++) {
        const int pa = static_cast<int>(queue_[i].job.priority);
        const int pb = static_cast<int>(queue_[bestIndex].job.priority);
        if (pa > pb || (pa == pb && queue_[i].sequence > queue_[bestIndex].sequence)) {
            bestIndex = i;
        }
    }
    out = std::move(queue_[bestIndex]);
    queue_.erase(queue_.begin() + static_cast<std::ptrdiff_t>(bestIndex));

    activeRequests_[static_cast<size_t>(threadIndex)] = out.job.requestId;
    activeItems_[static_cast<size_t>(threadIndex)] = out;
    currentRequestId = out.job.requestId;
    return true;
}

void RenderCache::ClearCurrent(int threadIndex) {
    std::lock_guard<std::mutex> lock(queueMutex_);
    activeRequests_[static_cast<size_t>(threadIndex)] = 0;
    activeItems_[static_cast<size_t>(threadIndex)] = QueueItem{};
}

bool RenderCache::Submit(RenderJob job) {
    std::lock_guard<std::recursive_mutex> documentLock(documentMutex);
    job.documentRevision = documentRevision.load();
    if (!engine_ || !engine_->IsOpen()) return false;
    if (job.pageIndex < 0 || job.pageIndex >= engine_->PageCount()) return false;
    if (!(job.scale > 0.0f) || !std::isfinite(job.scale) || job.scale > 64.0f) return false;
    if (job.tile.res > kMaxTileRes) return false;
    job.rotation = NormalizeRotation(job.rotation);

    // A job's region and its tile are two spellings of one rectangle. Resolve the
    // tile here, once, so the cache, the render and the queue dedup all work from
    // the same geometry and a congruent clip can hit the tile it equals.
    const mupdf::PageView view = engine_->PageView_(job.pageIndex, job.scale, job.rotation);
    if (view.mediaBox.IsEmpty()) return false;
    job.region = ResolveJobRegion(job, view);
    if (job.region.Empty()) return false;

    // Resolve the tile geometry this job was composed against: an explicit size
    // wins and pins the cache, otherwise the adaptive size stands.
    if (job.targetTileSize > 0) {
        job.tileSizePinned = true;
        std::lock_guard<std::mutex> tileLock(tileMutex_);
        pinnedTileSize_ = job.targetTileSize;
    } else {
        job.tileSizePinned = false;
        job.targetTileSize = TargetTileSize();
    }

    if (job.allowCache) {
        RenderOutcome cached;
        if (TryGetCached(job, cached)) {
            if (onComplete_ && job.requestId != 0) {
                onComplete_(std::move(cached));
            }
            return true;
        }
    }

    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        // light-pdf: "Request with exactly the same parameters already queued ...
        // Move it to the top of the queue so that it'll be rendered faster."
        if (job.requestId != 0) {
            for (QueueItem& item : queue_) {
                if (item.job.requestId == job.requestId) {
                    item.job = job;
                    item.sequence = ++sequence_;
                    return true;
                }
            }
        } else {
            /**
             * Internal prefetch: an identical job already queued is not queued
             * twice. The comparison is the *whole* key -- including the region --
             * because two jobs whose clips differ are two different rasterisations
             * even when their tile addresses, scale and page agree.
             */
            for (QueueItem& item : queue_) {
                if (item.job.requestId == 0 && item.job.pageIndex == job.pageIndex &&
                    item.job.rotation == job.rotation && item.job.scale == job.scale &&
                    item.job.tile == job.tile && item.job.invert == job.invert && item.job.gray == job.gray &&
                    item.job.region.Equals(job.region)) {
                    return true;
                }
            }
        }
        if (static_cast<int>(queue_.size()) >= kMaxQueuedRequests) {
            return false;
        }
        job.sequence = ++sequence_;
        QueueItem item;
        item.job = job;
        item.sequence = job.sequence;
        queue_.push_back(std::move(item));
    }
    // light-pdf spawns a thread here, in Render(), when work appears and no idle
    // thread exists. Must be outside the queue lock: the worker takes it at once.
    EnsureWorker();
    queueCv_.notify_one();
    return true;
}

bool RenderCache::TryGetCached(const RenderJob& job, RenderOutcome& out) {
    RectF pageRect;
    mupdf::PageView view;
    auto bitmap = Find(job, pageRect, view);
    if (!bitmap) return false;

    out = RenderOutcome{};
    out.requestId = job.requestId;
    out.pageIndex = job.pageIndex;
    out.scale = job.scale;
    out.rotation = job.rotation;
    out.tile = job.tile;
    out.invert = job.invert;
    out.gray = job.gray;
    out.fromCache = true;
    out.ok = true;
    out.bitmap = bitmap;
    out.pageRect = bitmap->pageRect;
    out.view = view;

    std::lock_guard<std::mutex> lock(statsMutex_);
    stats_.servedFromCache++;
    return true;
}

// light-pdf: CancelRendering(dm) / AbortCurrentRequest(). A queued job is simply
// removed; an in-flight one is marked so its result is discarded when it lands.
void RenderCache::CancelRequest(uint32_t requestId) {
    if (requestId == 0) return;
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        for (auto it = queue_.begin(); it != queue_.end();) {
            if (it->job.requestId == requestId) {
                it = queue_.erase(it);
            } else {
                ++it;
            }
        }
    }
    // Nothing to do for in-flight work beyond leaving it to finish and be
    // discarded by the caller: mupdf's display-list replay has no interruption
    // point, which is precisely why light-pdf's AbortCookie is advisory too.
}

// ---------------------------------------------------------------------------
// The render itself -- light-pdf: RenderCacheThread() body
// ---------------------------------------------------------------------------

void RenderCache::RunJob(const RenderJob& job, RenderOutcome& out) {
    std::lock_guard<std::recursive_mutex> documentLock(documentMutex);
    out = RenderOutcome{};
    out.requestId = job.requestId;
    if (job.documentRevision != documentRevision.load()) {
        out.aborted = true;
        out.error = "cancelled by document replacement";
        return;
    }
    out.pageIndex = job.pageIndex;
    out.scale = job.scale;
    out.rotation = job.rotation;
    out.tile = job.tile;
    out.invert = job.invert;
    out.gray = job.gray;

    if (!engine_ || !engine_->IsOpen()) {
        out.error = "no document is open";
        return;
    }

    // "if the page is no longer visible nearby, skip" -- light-pdf checks
    // PageVisibleNearby() before rendering.
    if (job.requestId == 0 && !PageWanted(job.pageIndex)) {
        out.aborted = true;
        std::lock_guard<std::mutex> lock(statsMutex_);
        stats_.aborted++;
        return;
    }

    mupdf::PageView view = engine_->PageView_(job.pageIndex, job.scale, job.rotation);
    if (view.mediaBox.IsEmpty()) {
        out.error = "page has no MediaBox";
        return;
    }
    out.view = view;

    // The region the caller asked for: the tile's grid cell, an explicit clip, or
    // the whole page. `Submit()` resolved it before queueing, so this agrees with
    // the region the cache was consulted under.
    const CacheRegion region = ResolveJobRegion(job, view);
    out.pageRect = region.rect;

    mupdf::RenderPageArgs args;
    args.pageIndex = job.pageIndex;
    args.view = &view;
    args.clip = &out.pageRect;
    args.invert = job.invert;
    args.gray = job.gray;
    // Colour renders are RGBA, not BGRA: MuPDF's BGR device has no alpha channel,
    // and Chromium's ImageData wants 4-channel RGBA, so asking for alpha here
    // removes a whole per-pixel conversion from the hot path.
    args.alpha = !job.gray;

    std::shared_ptr<mupdf::Pixmap> bitmap(engine_->RenderPage(args));
    if (!bitmap) {
        out.error = "mupdf failed to render the page";
        return;
    }
    out.bitmap = bitmap;
    out.ok = true;

    Store(job, bitmap);

    std::lock_guard<std::mutex> lock(statsMutex_);
    stats_.rendered++;
}

// ---------------------------------------------------------------------------
// Stats and diagnostics
// ---------------------------------------------------------------------------

void RenderCache::AddDiagnostic(const std::string& message) {
    // The mutex taken here is separate from cacheMutex_, and the lock order
    // (cacheMutex_ -> diagnosticsMutex_) never runs backwards, so this is safe to
    // call from inside Store()/EvictFor().
    std::lock_guard<std::mutex> lock(diagnosticsMutex_);
    // Keep the newest, and keep it bounded: a pathological document must not turn
    // a diagnostic into a leak.
    constexpr size_t kMaxDiagnostics = 64;
    if (diagnostics_.size() >= kMaxDiagnostics) diagnostics_.erase(diagnostics_.begin());
    diagnostics_.push_back(message);
}

std::vector<std::string> RenderCache::TakeDiagnostics() {
    std::lock_guard<std::mutex> lock(diagnosticsMutex_);
    std::vector<std::string> out;
    out.swap(diagnostics_);
    return out;
}

std::vector<RenderCache::EntryInfo> RenderCache::DescribeEntries() const {
    std::vector<EntryInfo> out;
    std::lock_guard<std::mutex> lock(cacheMutex_);
    out.reserve(cache_.size());
    for (const CacheEntry& entry : cache_) {
        EntryInfo info;
        info.pageIndex = entry.key.pageIndex;
        info.rotation = entry.key.rotation;
        info.scale = entry.key.scale;
        info.tile = entry.key.tile;
        info.invert = entry.key.invert;
        info.gray = entry.key.gray;
        info.pageRect = entry.key.region.rect;
        info.bytes = EntryBytes(entry);
        info.width = entry.bitmap ? entry.bitmap->width : 0;
        info.height = entry.bitmap ? entry.bitmap->height : 0;
        info.lastUsed = entry.lastUsed;
        out.push_back(info);
    }
    return out;
}

RenderCache::Stats RenderCache::GetStats() const {
    Stats out;
    {
        std::lock_guard<std::mutex> lock(cacheMutex_);
        out.entries = static_cast<int>(cache_.size());
        out.bytes = cacheBytes_;
    }
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        out.queued = static_cast<int>(queue_.size());
        for (uint32_t id : activeRequests_) {
            if (id != 0) out.active++;
        }
    }
    {
        std::lock_guard<std::mutex> lock(statsMutex_);
        out.servedFromCache = stats_.servedFromCache;
        out.rendered = stats_.rendered;
        out.aborted = stats_.aborted;
        out.evicted = stats_.evicted;
        out.skippedOversized = stats_.skippedOversized;
        out.tileSizeReductions = tileSizeReductions_.load(std::memory_order_relaxed);
    }
    {
        std::lock_guard<std::mutex> lock(workersMutex_);
        out.threadsSpawned = static_cast<int>(workers_.size());
    }
    out.targetTileSize = TargetTileSize();
    return out;
}

}  // namespace eukolia
