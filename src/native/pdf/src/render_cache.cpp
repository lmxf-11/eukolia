// Tiled background render cache -- implementation.
//
// See render_cache.h for the port notes. Function-for-function correspondence
// with References/light-pdf/src/RenderCache.cpp is called out in comments.

#include "render_cache.h"

#include <algorithm>
#include <cmath>

namespace eukolia {

namespace {

uint64_t NowMs() {
    using namespace std::chrono;
    return static_cast<uint64_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

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

}  // namespace

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
    activeRequests_.assign(kMaxRenderThreads, 0);
    activeItems_.resize(kMaxRenderThreads);
}

RenderCache::~RenderCache() {
    Stop();
}

void RenderCache::Start(int threads) {
    threads = std::max(1, std::min(threads, kMaxRenderThreads));
    if (!workers_.empty()) return;
    shouldExit_.store(false, std::memory_order_relaxed);
    for (int i = 0; i < threads; i++) {
        auto worker = std::make_unique<detail::RenderWorker>(this, i);
        worker->Start();
        workers_.push_back(std::move(worker));
    }
}

void RenderCache::Stop() {
    if (workers_.empty()) return;
    shouldExit_.store(true, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        queue_.clear();
    }
    queueCv_.notify_all();
    for (auto& worker : workers_) {
        worker->Stop();
    }
    workers_.clear();
}

// ---------------------------------------------------------------------------
// Tile geometry -- direct ports of light-pdf's RenderCache helpers
// ---------------------------------------------------------------------------

// light-pdf: RenderCache::GetTileRes(). The reference works from the rendered
// pixel box and the viewport; headless callers already know the pixel size, so
// the same formula is applied to the pixel dimensions directly.
uint16_t RenderCache::TileResFor(float pageWidthPx, float pageHeightPx, bool fitMode, int targetTileSize) {
    if (pageWidthPx <= 0 || pageHeightPx <= 0) return 0;
    const int tileSize = targetTileSize > 0 ? targetTileSize : kTargetTileSize;
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
    // light-pdf clamps to 30 so (1 << res) cannot overflow a signed 32-bit int.
    return std::min<uint16_t>(res, 30);
}

std::vector<TilePosition> RenderCache::TilesForPage(float pageWidthPx, float pageHeightPx, int targetTileSize) {
    std::vector<TilePosition> out;
    const uint16_t res = TileResFor(pageWidthPx, pageHeightPx, false, targetTileSize);
    const uint16_t n = static_cast<uint16_t>(1u << res);
    for (uint16_t row = 0; row < n; row++) {
        for (uint16_t col = 0; col < n; col++) {
            out.push_back(TilePosition{res, row, col});
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
    std::lock_guard<std::mutex> lock(cacheMutex_);
    const int rotation = NormalizeRotation(job.rotation);
    for (CacheEntry& entry : cache_) {
        const CacheKey& k = entry.key;
        if (k.pageIndex != job.pageIndex || k.rotation != rotation || k.scale != job.scale ||
            !(k.tile == job.tile) || k.hasClip != job.hasClip ||
            (job.hasClip && !(k.clip.x == job.clip.x && k.clip.y == job.clip.y && k.clip.dx == job.clip.dx && k.clip.dy == job.clip.dy)) ||
            k.invert != job.invert || k.gray != job.gray) {
            continue;
        }
        entry.lastUsed = NowMs();
        pageRect = entry.bitmap->pageRect;
        view = engine_->PageView_(job.pageIndex, job.scale, rotation);
        return entry.bitmap;
    }
    return nullptr;
}

// light-pdf: FreeIfFull() + DropCacheEntryIfNotUsed(). The reference drops an
// invisible page of the same DisplayModel first and only then the oldest cached
// page from another document. There is exactly one document here, so this drops
// entries whose page is outside the prefetch window, then the least recently
// used entry.
void RenderCache::EvictFor(size_t incomingBytes) {
    // Caller holds cacheMutex_.
    auto overBudget = [&] {
        return static_cast<int>(cache_.size()) > kMaxCacheEntries ||
               (cacheBytes_ + incomingBytes > kMaxCacheBytes && cache_.size() > 1);
    };
    if (!overBudget()) return;

    // Pass 1: pages nobody asked for.
    for (auto it = cache_.begin(); it != cache_.end() && overBudget();) {
        if (!PageWanted(it->key.pageIndex)) {
            cacheBytes_ -= it->bitmap ? it->bitmap->samples.size() : 0;
            it = cache_.erase(it);
            stats_.evicted++;
        } else {
            ++it;
        }
    }
    if (!overBudget()) return;

    // Pass 2: least recently used, furthest page first.
    std::stable_sort(cache_.begin(), cache_.end(), [this](const CacheEntry& a, const CacheEntry& b) {
        const int da = PageDistance(a.key.pageIndex);
        const int db = PageDistance(b.key.pageIndex);
        if (da != db) return da > db;
        return a.lastUsed < b.lastUsed;
    });
    while (overBudget() && cache_.size() > 1) {
        cacheBytes_ -= cache_.back().bitmap ? cache_.back().bitmap->samples.size() : 0;
        cache_.pop_back();
        stats_.evicted++;
    }
}

void RenderCache::Store(const RenderJob& job, const std::shared_ptr<mupdf::Pixmap>& bitmap) {
    if (!bitmap) return;
    std::lock_guard<std::mutex> lock(cacheMutex_);
    CacheKey key;
    key.pageIndex = job.pageIndex;
    key.rotation = NormalizeRotation(job.rotation);
    key.scale = job.scale;
    key.tile = job.tile;
    key.hasClip = job.hasClip;
    key.clip = job.hasClip ? job.clip : RectF{};
    key.hasClip = job.hasClip;
    key.clip = job.hasClip ? job.clip : RectF{};
    key.invert = job.invert;
    key.gray = job.gray;

    // "It's possible there still is a cached bitmap with different
    // zoom/rotation" -- drop the stale variant first (light-pdf: FreePage()).
    for (auto it = cache_.begin(); it != cache_.end();) {
        if (it->key.pageIndex == key.pageIndex && it->key.rotation == key.rotation &&
            (it->key.scale != key.scale || !(it->key.tile == key.tile) ||
         it->key.invert != key.invert ||
             it->key.gray != key.gray)) {
            cacheBytes_ -= it->bitmap ? it->bitmap->samples.size() : 0;
            it = cache_.erase(it);
        } else {
            ++it;
        }
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
    if (!engine_ || !engine_->IsOpen()) return false;
    if (job.pageIndex < 0 || job.pageIndex >= engine_->PageCount()) return false;
    if (!(job.scale > 0.0f) || !std::isfinite(job.scale) || job.scale > 64.0f) return false;
    job.rotation = NormalizeRotation(job.rotation);

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
            for (QueueItem& item : queue_) {
                if (item.job.requestId == 0 && item.job.pageIndex == job.pageIndex &&
                    item.job.rotation == job.rotation && item.job.scale == job.scale &&
                    (item.job.tile == job.tile) && item.job.invert == job.invert && item.job.gray == job.gray) {
                    return true;  // identical prefetch already queued
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
    out = RenderOutcome{};
    out.requestId = job.requestId;
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

    const RectF tileRect = GetTileRect(view.mediaBox, job.tile);
    out.pageRect = job.hasClip ? job.clip : tileRect;

    mupdf::RenderPageArgs args;
    args.pageIndex = job.pageIndex;
    args.view = &view;
    args.clip = &out.pageRect;
    args.invert = job.invert;
    args.gray = job.gray;
    // Colour renders are BGRA, not BGR: MuPDF's BGR device has no alpha channel,
    // and Chromium's ImageData wants 4-channel BGRA, so asking for alpha here
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
// Stats
// ---------------------------------------------------------------------------

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
    }
    return out;
}

}  // namespace eukolia
