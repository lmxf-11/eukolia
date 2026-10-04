/**
 * The tile store: coverage, generations, and the byte budget.
 *
 * `PDFVIEWER.md` §5 and §6 are the specification. Two clauses drive most of these
 * tests, and both are about the difference between *continuity* and *correctness*:
 *
 *   * §6 — "Keep old-scale/coarse pixels behind newly arriving tiles and replace only
 *     valid covered areas. Same-document old-scale fallback is acceptable; an
 *     old-document image is not a fallback for another file." So a coarser scale of
 *     the same page is offered as a fallback and a tile from another generation is
 *     not, however tempting it looks.
 *   * §5 — "Store must replace an identical key, retain sibling tiles… Evict
 *     obsolete, distant, then least-recently-used unpinned resources." So storing one
 *     tile never removes a sibling, and the budget removes what is stale before what
 *     is current.
 *
 * The store holds no canvas, so these are plain data questions and need no DOM — which
 * is the reason the store and the presenter are separate modules at all.
 */

import { describe, expect, it } from 'vitest';

import { PdfTileStore, tileKeyOf } from '../../src/renderer/pdf/rendering/PdfTileStore';
import { TilePriority, type TileRequest } from '../../src/renderer/pdf/rendering/PdfRenderScheduler';
import type { StoredTile } from '../../src/renderer/pdf/rendering/PdfTileStore';

/**
 * A stand-in for `ImageData`.
 *
 * Enough for the store, which only reads `width`/`height` and counts bytes; there is
 * no `ImageData` global under the `node` test environment, and constructing a real one
 * would need a canvas. The store's contract with the presenter is exactly these three
 * members plus the payload, so the stand-in is the whole interface.
 */
function image(width: number, height: number): ImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) } as unknown as ImageData;
}

function request(overrides: Partial<TileRequest> = {}): TileRequest {
  return {
    page: 1,
    pageIndex: 0,
    scale: 2,
    rotate: 0,
    invert: false,
    clip: { x: 0, y: 0, width: 384, height: 384 },
    position: { res: 1, row: 0, col: 0 },
    device: { x: 0, y: 0, width: 768, height: 768 },
    targetTileSize: 768,
    priority: TilePriority.UncoveredVisible,
    generation: 1,
    revision: 1,
    visible: true,
    ...overrides
  };
}

/**
 * A resident tile for a request.
 *
 * The identity is built from the request the same way the pipeline builds it, because a
 * `StoredTile` whose `identity` disagreed with its `key` would be a store bug the tests
 * should not be able to write by accident.
 */
function tileFor(req: TileRequest, width = 768, height = 768): StoredTile {
  return {
    key: tileKeyOf(req),
    identity: {
      generation: req.generation,
      pageIndex: req.pageIndex,
      scale: req.scale,
      rotate: req.rotate,
      invert: req.invert,
      clip: req.clip
    },
    device: req.device,
    position: req.position,
    image: image(width, height),
    bytes: width * height * 4,
    page: req.page,
    fromEngineCache: false,
    renderMs: 12,
    lastUsedAt: 0,
    uses: 0
  };
}

describe('PdfTileStore', () => {
  it('stores and finds a tile by its full identity', () => {
    const store = new PdfTileStore();
    store.beginGeneration(1);
    const req = request();
    expect(store.put(tileFor(req), 1)).toBe(true);
    expect(store.get(req, 2)).not.toBeNull();
    expect(store.covers(req)).toBe(true);
    expect(store.size).toBe(1);
    expect(store.residentBytes).toBe(768 * 768 * 4);
  });

  it('keeps sibling tiles when one is stored', () => {
    // The native cache's own A/B/A defect, on the renderer side: a store that replaced
    // a page's tiles as they arrived would make every re-plan a full re-render.
    const store = new PdfTileStore();
    store.beginGeneration(1);
    const a = request({ clip: { x: 0, y: 0, width: 384, height: 384 }, device: { x: 0, y: 0, width: 768, height: 768 } });
    const b = request({
      clip: { x: 384, y: 0, width: 384, height: 384 },
      device: { x: 768, y: 0, width: 768, height: 768 }
    });
    store.put(tileFor(a));
    store.put(tileFor(b));
    expect(store.size).toBe(2);
    expect(store.covers(a)).toBe(true);
    expect(store.covers(b)).toBe(true);
  });

  it('replaces an identical key without double-counting its bytes', () => {
    const store = new PdfTileStore();
    store.beginGeneration(1);
    const req = request();
    store.put(tileFor(req));
    store.put(tileFor(req));
    expect(store.size).toBe(1);
    expect(store.residentBytes).toBe(768 * 768 * 4);
  });

  it('offers a coarser same-page tile as a fallback, finest first', () => {
    const store = new PdfTileStore();
    store.beginGeneration(1);
    const coarse = request({ scale: 1, device: { x: 0, y: 0, width: 384, height: 384 } });
    const finer = request({ scale: 1.5, device: { x: 0, y: 0, width: 576, height: 576 } });
    store.put(tileFor(coarse, 384, 384));
    store.put(tileFor(finer, 576, 576));

    const wanted = request({ scale: 3, device: { x: 0, y: 0, width: 400, height: 400 } });
    const answer = store.coverageFor(wanted);
    expect(answer.exact).toBeNull();
    expect(answer.fallback.map((tile) => tile.identity.scale)).toEqual([1.5, 1]);
    expect(answer.fallbackCoverage).toBeGreaterThan(0);
  });

  it('reports exact coverage when the requested identity is resident', () => {
    const store = new PdfTileStore();
    store.beginGeneration(1);
    const req = request();
    store.put(tileFor(req));
    const answer = store.coverageFor(req);
    expect(answer.exact).not.toBeNull();
    expect(answer.fallback).toHaveLength(0);
    expect(answer.fallbackCoverage).toBe(1);
  });

  it('never offers another generation as a fallback, however well it covers', () => {
    // "an old-document image is not a fallback for another file" (§6). The pixels of
    // the previous build are still on screen — the viewer keeps them — but they are
    // not an answer to a request made against the new one.
    const store = new PdfTileStore();
    store.beginGeneration(1);
    const old = request({ generation: 1, device: { x: 0, y: 0, width: 768, height: 768 } });
    store.put(tileFor(old));

    store.beginGeneration(2);
    const answer = store.coverageFor(request({ generation: 1, device: { x: 0, y: 0, width: 100, height: 100 } }));
    expect(answer.exact).toBeNull();
    expect(answer.fallback).toHaveLength(0);
    expect(answer.fallbackCoverage).toBe(0);
  });

  it('drops every tile of an older generation when a new one begins', () => {
    const store = new PdfTileStore();
    store.beginGeneration(1);
    for (let i = 0; i < 3; i++) {
      store.put(tileFor(request({ clip: { x: i, y: 0, width: 10, height: 10 }, device: { x: i * 10, y: 0, width: 10, height: 10 } })));
    }
    expect(store.size).toBe(3);
    expect(store.beginGeneration(2)).toBe(3);
    expect(store.size).toBe(0);
    expect(store.residentBytes).toBe(0);
  });

  it('never offers a different rotation or colour mode as a fallback', () => {
    const store = new PdfTileStore();
    store.beginGeneration(1);
    store.put(tileFor(request({ rotate: 90 })));
    store.put(tileFor(request({ invert: true })));
    const answer = store.coverageFor(request({ rotate: 0, invert: false }));
    expect(answer.fallback).toHaveLength(0);
  });

  it('evicts stale generations before current ones under pressure', () => {
    const onEvict: StoredTile[] = [];
    // Room for two 100x100 tiles.
    const store = new PdfTileStore({ maxBytes: 100 * 100 * 4 * 2 });
    store.onEvict = (tile) => onEvict.push(tile);
    store.beginGeneration(1);
    const stale = request({ generation: 1, device: { x: 0, y: 0, width: 100, height: 100 } });
    store.put(tileFor(stale, 100, 100));

    // A new generation arrives: the stale tile is dropped outright, so the budget is
    // free for the new document's pixels.
    store.beginGeneration(2);
    expect(store.size).toBe(0);
    expect(onEvict).toHaveLength(1);
  });

  it('evicts by least-recent use when everything is current', () => {
    const store = new PdfTileStore({ maxBytes: 100 * 100 * 4 * 2 });
    store.beginGeneration(1);
    const tiles = [0, 1, 2].map((i) =>
      request({ clip: { x: i * 10, y: 0, width: 10, height: 10 }, device: { x: i * 100, y: 0, width: 100, height: 100 } })
    );
    store.put(tileFor(tiles[0], 100, 100), 1);
    store.put(tileFor(tiles[1], 100, 100), 2);
    // Touch the first one so the second is the least recently used.
    store.get(tiles[0], 3);
    store.put(tileFor(tiles[2], 100, 100), 4);

    expect(store.size).toBe(2);
    expect(store.covers(tiles[1])).toBe(false);
    expect(store.covers(tiles[0])).toBe(true);
    expect(store.covers(tiles[2])).toBe(true);
  });

  it('refuses a single tile larger than the whole budget', () => {
    const store = new PdfTileStore({ maxBytes: 1000 });
    store.beginGeneration(1);
    expect(store.put(tileFor(request(), 768, 768))).toBe(false);
    expect(store.size).toBe(0);
    expect(store.residentBytes).toBe(0);
  });

  it('drops one page without touching another', () => {
    const store = new PdfTileStore();
    store.beginGeneration(1);
    store.put(tileFor(request({ page: 1, pageIndex: 0 })));
    store.put(tileFor(request({ page: 2, pageIndex: 1 })));
    expect(store.dropPage(0)).toBe(1);
    expect(store.size).toBe(1);
    expect(store.covers(request({ page: 2, pageIndex: 1 }))).toBe(true);
  });

  it('never evicts a pinned tile', () => {
    const store = new PdfTileStore({ maxBytes: 100 * 100 * 4 * 2 });
    store.beginGeneration(1);
    const keep = request({ clip: { x: 0, y: 0, width: 10, height: 10 }, device: { x: 0, y: 0, width: 100, height: 100 } });
    store.put(tileFor(keep, 100, 100), 1);
    store.evictUnlessPinned(new Set([tileKeyOf(keep)]));
    expect(store.covers(keep)).toBe(true);
  });

  it('reports entries oldest first, for diagnostics', () => {
    const store = new PdfTileStore();
    store.beginGeneration(1);
    store.put(
      tileFor(request({ clip: { x: 0, y: 0, width: 10, height: 10 }, device: { x: 0, y: 0, width: 10, height: 10 } }), 10, 10),
      5
    );
    store.put(
      tileFor(request({ clip: { x: 10, y: 0, width: 10, height: 10 }, device: { x: 10, y: 0, width: 10, height: 10 } }), 10, 10),
      7
    );
    const entries = store.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0].lastUsedAt).toBeLessThanOrEqual(entries[1].lastUsedAt);
  });

  it('reports an eviction to the owner so it can release the canvas', () => {
    const evicted: StoredTile[] = [];
    const store = new PdfTileStore({ maxBytes: 100 * 100 * 4 });
    store.onEvict = (tile) => evicted.push(tile);
    store.beginGeneration(1);
    store.put(
      tileFor(request({ clip: { x: 0, y: 0, width: 10, height: 10 }, device: { x: 0, y: 0, width: 100, height: 100 } }), 100, 100)
    );
    store.put(
      tileFor(
        request({ clip: { x: 100, y: 0, width: 10, height: 10 }, device: { x: 100, y: 0, width: 100, height: 100 } }),
        100,
        100
      )
    );
    expect(evicted).toHaveLength(1);
    expect(store.size).toBe(1);
  });
});