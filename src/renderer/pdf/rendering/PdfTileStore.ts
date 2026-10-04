/**
 * Eukolia — the PDF tile store.
 *
 * ## Why this module exists
 *
 * `PDFVIEWER.md` §4 gives `PdfTileStore.ts` two jobs: "byte-budgeted tile metadata/
 * resources and fallback lookup". Both come from §6:
 *
 * > Keep old-scale/coarse pixels behind newly arriving tiles and replace only valid
 * > covered areas. Same-document old-scale fallback is acceptable; an old-document
 * > image is not a fallback for another file. […] Track coverage and generation per
 * > surface.
 *
 * The viewer already has a version of this for whole pages — `renderedRef`, keyed by
 * page, with the generation baked into a string key and an LRU cap by page count —
 * and §2 says to preserve what works. What that shape cannot do is answer the two
 * questions tiling actually asks:
 *
 *   1. **"What pixels do I already have for this region?"** A page entry is either
 *      the scale the layout wants or it is not; there is no way to say "I have this
 *      page at 0.75x and the top-left quarter at 1.5x, so draw what you can."
 *   2. **"What does *this* region still need?"** Coverage has to be tracked per
 *      region, because that is what the scheduler's `UncoveredVisible` priority is
 *      about and what makes a partial page better than a blank one.
 *
 * So this store holds **tiles**, keyed by the same identity the scheduler dedups on,
 * and answers coverage queries. It owns no canvas: a tile is a description
 * (`ImageData` plus where it goes), and {@link PdfSurfacePresenter} turns it into
 * paint. That split is what makes the eviction policy testable without a DOM.
 *
 * ## Generation, not path
 *
 * §3: "Use document identities and generations everywhere; a path alone is not
 * enough during rebuilds." Every entry carries the `generation` it was rendered
 * from, and {@link PdfTileStore.beginGeneration} refuses to serve a tile from an
 * older generation as a *fallback* even though it will happily keep showing it as
 * explicitly stale content (which is what the viewer already does on a rebuild —
 * `renderedRef`'s key includes the generation and old pixels stay until replaced).
 * The distinction is deliberate: stale content that is already on screen is
 * continuity, while fetching new pixels from an old generation is a bug.
 *
 * ## Budget
 *
 * §3: "Bound each cache and the combined working set, including native pixels,
 * in-flight transport, JS buffers, canvases, GPU backing, and text overlays." The
 * budget here covers the JS pixel buffers this store owns. The canvases that hold
 * them are bounded by the presenter, and the native cache by its own byte budget —
 * three separate bounds rather than one number pretending to describe all three.
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DeviceRect, TilePosition } from './PdfTileGeometry';
import type { TileRequest } from './PdfRenderScheduler';

/**
 * The identity of one rasterised region, as a string.
 *
 * Everything that changes the *pixels* is in it — document generation, page, effective
 * scale, rotation, colour mode and the page-space rectangle — and nothing that does
 * not. It is one string rather than a struct so that the scheduler's dedup, the store's
 * map and the presenter's surface map cannot disagree about what "the same tile" means;
 * three keys that were *nearly* the same is how a surface ends up never being released.
 *
 * Mirrors `CacheKey` in the native `render_cache.h`, which is the other side of the same
 * contract.
 */
export type TileKey = string;

/**
 * A tile's identity split into the fields a policy needs to *reason* about it.
 *
 * The map key is the {@link TileKey} string; this is what a lookup by scale, rotation
 * or colour mode reads, and keeping it on the entry avoids re-parsing the string.
 */
export interface TileIdentity {
  generation: number;
  pageIndex: number;
  scale: number;
  rotate: number;
  invert: boolean;
  clip: { x: number; y: number; width: number; height: number };
}

/** A tile's identity from its parts. */
export function tileKey(parts: {
  generation: number;
  pageIndex: number;
  scale: number;
  rotate: number;
  invert: boolean;
  clip: { x: number; y: number; width: number; height: number };
}): TileKey {
  return [
    parts.generation,
    parts.pageIndex,
    parts.scale.toFixed(6),
    parts.rotate,
    parts.invert ? 1 : 0,
    parts.clip.x.toFixed(4),
    parts.clip.y.toFixed(4),
    parts.clip.width.toFixed(4),
    parts.clip.height.toFixed(4)
  ].join('/');
}

/** The identity of a request, as the scheduler, the store and the presenter all spell it. */
export function tileKeyOf(request: TileRequest): TileKey {
  return tileKey(request);
}

/** A resident tile: the pixels plus where they belong. */
export interface StoredTile {
  /** The map key: the same string every other module spells this tile with. */
  readonly key: TileKey;
  readonly identity: TileIdentity;
  /** The tile's device-pixel box, in unrotated page device space. */
  readonly device: DeviceRect;
  readonly position: TilePosition | null;
  readonly image: ImageData;
  readonly bytes: number;
  readonly page: number;
  /** Set when the engine said it served this from its own cache. */
  readonly fromEngineCache: boolean;
  /** Milliseconds the render took, as reported by the engine's own timing. */
  readonly renderMs: number;
  /** Monotonic counter used for recency; `lastUsedAt` in milliseconds. */
  lastUsedAt: number;
  /** Bumped whenever the entry is used to draw, for the "sharpness" bookkeeping. */
  uses: number;
}

/** What the store can offer for a region. */
export interface CoverageAnswer {
  /** True when a tile of exactly the requested identity is resident. */
  exact: StoredTile | null;
  /**
   * Tiles of the same page that overlap the region at *another* generation, best
   * first (finest scale, then most recently used).
   *
   * These are the old-scale/coarse fallback. The caller draws them underneath and
   * lets the exact tile replace what it covers — §6's "replace only valid covered
   * areas".
   */
  fallback: StoredTile[];
  /** Fraction of the region's area covered by `exact` (0 or 1) or by `fallback`. */
  fallbackCoverage: number;
}

export interface TileStoreOptions {
  /** Bytes of pixel data the store may hold. */
  maxBytes?: number;
  /** Entries the store may hold, as a second bound. */
  maxTiles?: number;
}

function overlaps(a: DeviceRect, b: DeviceRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function intersectionArea(a: DeviceRect, b: DeviceRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * A byte-budgeted set of rasterised tiles with coverage queries.
 *
 * Not thread-safe and not asynchronous: it is a data structure, and every caller is
 * the renderer's own event loop.
 */
export class PdfTileStore {
  private readonly tiles = new Map<TileKey, StoredTile>();
  private bytes = 0;
  /** The generation new pixels are expected from; see the module note. */
  private generation = 0;

  readonly maxBytes: number;
  readonly maxTiles: number;

  /** Called with the number of entries evicted, so the owner can dispose canvases. */
  onEvict: ((evicted: StoredTile) => void) | null = null;

  constructor(options: TileStoreOptions = {}) {
    this.maxBytes = Math.max(1, options.maxBytes ?? 192 * 1024 * 1024);
    this.maxTiles = Math.max(1, options.maxTiles ?? 512);
  }

  /**
   * Declare the current document generation.
   *
   * Entries from any other generation remain resident — the reader keeps the pixels
   * already on screen through a rebuild, which is the behaviour §6 asks to preserve —
   * but they are never offered as a fallback and never counted as coverage.
   */
  beginGeneration(generation: number): number {
    this.generation = generation;
    let dropped = 0;
    for (const [key, tile] of [...this.tiles]) {
      if (tile.identity.generation === generation) continue;
      this.tiles.delete(key);
      this.bytes -= tile.bytes;
      dropped++;
      this.onEvict?.(tile);
    }
    return dropped;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get size(): number {
    return this.tiles.size;
  }

  get residentBytes(): number {
    return this.bytes;
  }

  /** The tile for a request, or null. Touches recency when found. */
  get(request: TileRequest, now = Date.now()): StoredTile | null {
    const tile = this.tiles.get(tileKeyOf(request));
    if (!tile) return null;
    tile.lastUsedAt = now;
    tile.uses++;
    return tile;
  }

  has(request: TileRequest): boolean {
    return this.tiles.has(tileKeyOf(request));
  }

  /**
   * Insert or replace a tile.
   *
   * Replacing an identical key does not double-count its bytes, and an entry larger
   * than the whole budget is refused with a `false` return rather than admitted —
   * the same rule the native cache applies (`RenderCache::Store`), for the same
   * reason: admitting it would evict everything else and then be evicted itself.
   */
  put(
    tile: Omit<StoredTile, 'lastUsedAt' | 'uses'> & { lastUsedAt?: number; uses?: number },
    now = Date.now()
  ): boolean {
    if (tile.bytes > this.maxBytes) return false;
    const key = tile.key;
    const existing = this.tiles.get(key);
    if (existing) {
      this.bytes -= existing.bytes;
      this.tiles.delete(key);
    }
    const entry: StoredTile = {
      ...tile,
      lastUsedAt: tile.lastUsedAt ?? now,
      uses: tile.uses ?? 0
    };
    this.tiles.set(key, entry);
    this.bytes += entry.bytes;
    this.evictToBudget();
    return this.tiles.get(key) === entry;
  }

  /** Drop every tile of a page, e.g. when the page leaves the mounted window. */
  dropPage(pageIndex: number): number {
    let dropped = 0;
    for (const [key, tile] of [...this.tiles]) {
      if (tile.identity.pageIndex !== pageIndex) continue;
      this.tiles.delete(key);
      this.bytes -= tile.bytes;
      dropped++;
      this.onEvict?.(tile);
    }
    return dropped;
  }

  /** Drop every tile of one generation. */
  dropGeneration(generation: number): number {
    let dropped = 0;
    for (const [key, tile] of [...this.tiles]) {
      if (tile.identity.generation !== generation) continue;
      this.tiles.delete(key);
      this.bytes -= tile.bytes;
      dropped++;
      this.onEvict?.(tile);
    }
    return dropped;
  }

  /** Drop everything. */
  clear(): void {
    for (const tile of this.tiles.values()) this.onEvict?.(tile);
    this.tiles.clear();
    this.bytes = 0;
  }

  /**
   * What is already available for a region.
   *
   * `fallback` is deliberately restricted to the same page, the *current*
   * generation, and a **different** scale: an old-document image is not a fallback
   * (`PDFVIEWER.md` §6, stated twice), and a same-scale tile that does not cover the
   * region is not a fallback either — it is a neighbour.
   *
   * Finest scale first, then most recently used. Finest first is what makes a zoom
   * *in* sharp immediately (the old, coarser pixels are underneath) and a zoom *out*
   * also sharp (the old, finer pixels are underneath and get downscaled by the
   * compositor rather than upscaled by it).
   */
  coverageFor(request: TileRequest, now = Date.now()): CoverageAnswer {
    const exact = this.get(request, now);
    if (exact) return { exact, fallback: [], fallbackCoverage: 1 };

    const candidates: StoredTile[] = [];
    let coveredArea = 0;
    for (const tile of this.tiles.values()) {
      if (tile.identity.pageIndex !== request.pageIndex) continue;
      // Only the current generation is a fallback source. Pixels from an older
      // generation may still be *on screen* (the viewer keeps them through a
      // rebuild), but they are never fetched as an answer to a new request.
      if (tile.identity.generation !== this.generation) continue;
      if (tile.identity.rotate !== request.rotate || tile.identity.invert !== request.invert) continue;
      const source = tile.identity.clip;
      if (!overlaps(source, request.clip)) continue;
      candidates.push(tile);
      coveredArea += intersectionArea(source, request.clip);
    }
    candidates.sort((a, b) => {
      // Finest scale first: the best chance the fallback is not obviously soft.
      if (a.identity.scale !== b.identity.scale) return b.identity.scale - a.identity.scale;
      if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return b.uses - a.uses;
    });

    const area = Math.max(1, request.clip.width * request.clip.height);
    return { exact: null, fallback: candidates, fallbackCoverage: Math.min(1, coveredArea / area) };
  }

  /**
   * True when the region has pixels of the requested identity.
   *
   * The planner's "is this tile already right?" test; it is separate from
   * {@link coverageFor} so the common case does not build a candidate list.
   */
  covers(request: TileRequest): boolean {
    return this.tiles.has(tileKeyOf(request));
  }

  /** Every resident tile, newest last. Diagnostics and tests. */
  entries(): StoredTile[] {
    return [...this.tiles.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }

  /**
   * Enforce both budgets.
   *
   * Eviction order is §5's: "evict obsolete, distant, then least-recently-used
   * unpinned resources". Obsolete means a generation that is not current — those go
   * first even though they are what is on screen, *when the budget is what forces
   * the choice*; a hidden page's tiles go next (they cost nothing to lose, because
   * they will be re-requested when the page returns); then least recently used.
   *
   * A tile currently visible is never evicted to make room for another visible tile:
   * if the budget cannot hold one screenful, thrashing is worse than being over
   * budget, and the caller's tunables are wrong.
   */
  private evictToBudget(pinned: ReadonlySet<TileKey> | null = null): void {
    if (this.bytes <= this.maxBytes && this.tiles.size <= this.maxTiles) return;

    const ordered = [...this.tiles.entries()].sort(([, a], [, b]) => this.evictionRank(a) - this.evictionRank(b));
    for (const [key, tile] of ordered) {
      if (this.bytes <= this.maxBytes && this.tiles.size <= this.maxTiles) break;
      if (pinned?.has(key)) continue;
      this.tiles.delete(key);
      this.bytes -= tile.bytes;
      this.onEvict?.(tile);
    }
  }

  private evictionRank(tile: StoredTile): number {
    // Lower rank is evicted first. Generations are separated by a large constant so
    // they never interleave with the recency ordering inside one generation.
    const staleRank = tile.identity.generation === this.generation ? 1 : 0;
    return staleRank * 1e15 + tile.lastUsedAt;
  }

  /**
   * Mark a set of tiles as pinned for the next budget pass.
   *
   * Called by the planner before a store so that the tiles it just decided the reader
   * can see survive their own insert. Pins are advisory and one-shot, not a
   * reference count: a pin held forever would silently disable the budget.
   */
  evictUnlessPinned(pinned: ReadonlySet<TileKey>): void {
    this.evictToBudget(pinned);
  }
}
