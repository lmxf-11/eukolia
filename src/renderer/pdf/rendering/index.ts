/**
 * Eukolia — the PDF rendering pipeline.
 *
 * The modules in this directory take over what `PdfViewer.tsx` did inline:
 * frame-sensitive viewport state, tile geometry, request scheduling, tile lifetimes
 * and bounded uploads (`PDFVIEWER.md` §4). The viewer keeps the document lifecycle,
 * the layout model, the chrome and the accessible UI.
 *
 * Read them in this order:
 *
 *   * `PdfTileGeometry.ts` — the coordinate contract shared with the native worker,
 *     and the only place a tile address becomes a rectangle.
 *   * `PdfViewportController.ts` — coalesces input into at most one plan per frame.
 *   * `PdfRenderScheduler.ts` — priority, dedup, budgets, cancellation.
 *   * `PdfTileStore.ts` — what pixels exist, what they cover, and what to drop.
 *   * `PdfSurfacePresenter.ts` — retained canvases and uploads inside a time budget.
 *   * `PdfRenderMetrics.ts` — opt-in counters, off unless a probe turns them on.
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export {
  MAX_TILE_RES,
  MIN_TILES_FOR_TILING,
  TILE_TARGET_PX,
  WHOLE_PAGE_MAX_DEVICE_AREA,
  allTilesOfPage,
  assertRenderRotation,
  deviceArea,
  deviceRectToPageClip,
  gridSize,
  intersectDeviceRect,
  overscanForViewport,
  pageBoxFromSheet,
  pageDeviceBox,
  rawTileRes,
  sheetDeviceBox,
  shouldTilePage,
  tileDeviceRect,
  tileResForDeviceBox,
  tileSpecFor,
  visibleTiles,
  type DeviceRect,
  type PageBox,
  type TilePosition,
  type TileSpec
} from './PdfTileGeometry';

export {
  MEANINGFUL_TILE_FRACTION,
  PdfViewportController,
  samePlan,
  type ViewportListener,
  type ViewportMotion,
  type ViewportRect,
  type ViewportState
} from './PdfViewportController';

export {
  AGING_MS,
  PdfRenderScheduler,
  TilePriority,
  estimateTileBytes,
  tileRequestKey,
  type SchedulerOptions,
  type SchedulerSnapshot,
  type TileCancelFn,
  type TileCompletion,
  type TileRenderFn,
  type TileRequest,
  type TileRequestStatus
} from './PdfRenderScheduler';

export {
  PdfTileStore,
  tileKey,
  tileKeyOf,
  type CoverageAnswer,
  type StoredTile,
  type TileIdentity,
  type TileKey,
  type TileStoreOptions
} from './PdfTileStore';

export {
  DEFAULT_UPLOAD_BUDGET_MS,
  PdfSurfacePresenter,
  type PendingUpload,
  type PresenterOptions,
  type PresenterSnapshot
} from './PdfSurfacePresenter';

export {
  FrameIntervals,
  NumberRing,
  PdfRenderMetrics,
  distribution,
  installPdfMetrics,
  type Distribution,
  type PdfRenderMetricsSnapshot
} from './PdfRenderMetrics';

export {
  PdfTilePipeline,
  type PipelineOptions,
  type PipelinePage,
  type PipelineRenderFn,
  type PipelineStatus,
  type PipelineViewport
} from './PdfTilePipeline';
