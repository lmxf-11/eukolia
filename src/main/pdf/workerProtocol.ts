/**
 * Wire types for the Eukolia native PDF worker (`resources/native/eukolia-pdf.exe`).
 *
 * The worker speaks a length-prefixed stdio binary protocol documented in
 * `src/native/pdf/PROTOCOL.md`. This module is the single place where that wire
 * format is named on the TypeScript side; `nativePdfEngine.ts` owns the
 * transport, `pdfHandler.ts` maps these shapes onto the frozen renderer
 * contract in `src/shared/ipc.ts`.
 */

/** Frame type tags. Must match `FrameType` in `src/native/pdf/src/protocol.h`. */
export const FrameType = {
  Request: 1,
  Cancel: 2,
  Ping: 3,
  Shutdown: 4,
  Response: 128,
  Error: 129,
  Pixels: 130,
  Ready: 131,
  Log: 132,
  Pong: 133
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** Bumped in lockstep with `kProtocolVersion` in the C++ `protocol.h`. */
export const PROTOCOL_VERSION = 1;

/**
 * Largest frame body the worker will accept. Kept here too so the bridge can
 * reject an oversized render request before allocating for it.
 */
export const MAX_FRAME_BYTES = 512 * 1024 * 1024;

export const FRAME_HEADER_BYTES = 4;

/** A rectangle in PDF points, top-left origin. */
export interface WireRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The startup handshake frame (`FrameType.Ready`). */
export interface WorkerReadyInfo {
  ok: boolean;
  protocolVersion: number;
  engine: string;
  mupdfVersion: string;
  renderThreads: number;
  maxTileSize: number;
  /**
   * The largest tile resolution the worker's 16-bit row/column address fields carry.
   *
   * Added with the tile-cache fix; absent from an older worker, which is exactly the
   * signal the capability check needs (`PDFVIEWER.md` §7, "audit representable ranges
   * before public exposure").
   */
  maxTileRes?: number;
  commands: string[];
}

export interface WorkerLogMessage {
  level?: string;
  message: string;
}

/** Wire shape of one page's geometry, as returned by `open`/`info`. */
export interface WirePageInfo {
  index: number;
  width: number;
  height: number;
  rotate: number;
}

export interface WireOutlineItem {
  title: string;
  page: number | null;
  uri: string | null;
  open: boolean;
  children: WireOutlineItem[];
}

export interface WireOpenResult {
  unchanged?: boolean;
  ok: true;
  path: string;
  pageCount: number;
  needsPassword: boolean;
  pages: WirePageInfo[];
  outline: WireOutlineItem[];
  metadata: Record<string, string>;
  engine: string;
}

export interface WireInfoResult {
  ok: true;
  path: string;
  pageCount: number;
  pages: WirePageInfo[];
  metadata: Record<string, string>;
  engine: string;
}

/** The perspective transform the worker used, so the renderer can map points. */
export interface WireViewInfo {
  width: number;
  height: number;
  pageRotate: number;
  userRotate: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * Header of a `FrameType.Pixels` frame. The raw pixel bytes follow the JSON
 * header inside the same frame body; `blobBytes` is their exact length.
 */
export interface WireRenderHeader {
  ok: true;
  page: number;
  width: number;
  height: number;
  stride: number;
  channels: number;
  order: 'rgb' | 'bgr' | 'bgra' | 'rgba' | 'gray';
  scale: number;
  rotate: number;
  fromCache: boolean;
  pageRect: WireRect;
  view: WireViewInfo;
  blobBytes: number;
}

/** A render result: the parsed header plus the raw pixels. */
export interface WireRenderResult extends WireRenderHeader {
  pixels: Uint8Array;
}

export interface WireTextSpan {
  text: string;
  font: string;
  size: number;
  bbox: WireRect;
}

export interface WireTextLine {
  bbox: WireRect;
  spans: WireTextSpan[];
}

export interface WireTextBlock {
  bbox: WireRect;
  lines: WireTextLine[];
}

export interface WireTextResult {
  ok: true;
  page: number;
  width: number;
  height: number;
  /** Full page text, one line per visual line. */
  text: string;
  blocks: WireTextBlock[];
}

export interface WireGlyph {
  lineBreak?: true;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface WireGlyphsResult extends WireTextResult {
  glyphs: WireGlyph[];
}

export interface WireSearchMatch {
  page: number;
  /** The matched text as it appears in the page, when extractable. */
  text: string;
  rects: WireRect[];
}

export interface WireSearchResult {
  ok: true;
  query: string;
  pageCount: number;
  matches: WireSearchMatch[];
  truncated: boolean;
}

export interface WireLink {
  rect: WireRect;
  uri: string | null;
  page: number | null;
  targetX?: number;
  targetY?: number;
  targetZoom?: number;
}

export interface WireLinksResult {
  ok: true;
  page: number;
  links: WireLink[];
}

export interface WireOutlineResult {
  ok: true;
  outline: WireOutlineItem[];
}

export interface WireSelectionResult {
  ok: true;
  page: number;
  startGlyph: number;
  endGlyph: number;
  text: string;
  rects: WireRect[];
  /** 0-based first page of the selection; -1 when there is none. */
  startPage?: number;
  /** 0-based last page of the selection; -1 when there is none. */
  endPage?: number;
}

/** One page's placement inside the layout canvas (light-pdf's DocumentLayoutPage). */
export interface WireLayoutPage {
  index: number;
  shown: boolean;
  visibleRatio: number;
  zoomReal: number;
  /** Position and size in canvas space. */
  pos: WireRect;
  /** Position relative to the viewport origin. */
  pageOnScreen: WireRect;
}

export interface WireLayoutResult {
  ok: true;
  pageCount: number;
  zoomReal: number;
  currentPage: number;
  firstVisiblePage: number;
  canvas: { width: number; height: number };
  viewPort: { x: number; y: number; width: number; height: number };
  pages: WireLayoutPage[];
}

/**
 * Request for the `layout` command: light-pdf's DocumentLayoutParams.
 *
 * `zoomVirtual` is in percent, or one of the kZoomFit* sentinels (-1 fit page,
 * -2 fit width, -3 fit content, -4 shrink to fit, -5 fit by orientation).
 */
export interface LayoutRequestParams {
  displayMode?: 'single' | 'continuous' | 'facing' | 'book' | 'continuousFacing' | 'continuousBook';
  startPage?: number;
  viewPortWidth?: number;
  viewPortHeight?: number;
  viewPortX?: number;
  viewPortY?: number;
  zoomVirtual?: number;
  dpiFactor?: number;
  rotation?: number;
  displayR2L?: boolean;
  usePageZooms?: boolean;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  pageSpacingX?: number;
  pageSpacingY?: number;
}

export interface WireTile {
  res: number;
  row: number;
  col: number;
  rect: WireRect;
}

export interface WireTilesResult {
  ok: true;
  page: number;
  res: number;
  tiles: WireTile[];
}

export interface WireViewportResult {
  ok: true;
  queued: number;
  cacheEntries: number;
  cacheBytes: number;
  queuedTotal: number;
}

export interface WireStatsResult {
  ok: true;
  cacheEntries: number;
  cacheBytes: number;
  queued: number;
  active: number;
  servedFromCache: number;
  rendered: number;
  aborted: number;
  evicted: number;
  pendingTextTasks: number;
  /** Present on a worker built with the cache fixes; see `render_cache.h`. */
  skippedOversized?: number;
  tileSizeReductions?: number;
  targetTileSize?: number;
  threadsSpawned?: number;
  evictedUnwantedPages?: number;
  evictedBudget?: number;
  evictedOldGeneration?: number;
  evictedOldVariant?: number;
  evictedSuperseded?: number;
}

export interface WireCancelResult {
  ok: true;
  cancelled: number;
}

export interface WireSimpleOk {
  ok: true;
  [key: string]: unknown;
}

/** Error payload carried by `FrameType.Error`. */
export interface WireErrorBody {
  ok: false;
  error: string;
  code?: string;
  /** Present on the `open` failure path for encrypted documents. */
  needsPassword?: boolean;
}

/** Tile addressing, mirroring `TilePosition` in the C++ `render_cache.h`. */
export interface TilePosition {
  res: number;
  row: number;
  col: number;
}

/** A request the bridge sends. `cmd` selects the worker handler. */
export type WorkerCommand =
  | 'open'
  | 'close'
  | 'info'
  | 'render'
  | 'cancel'
  | 'viewport'
  | 'tiles'
  | 'stats'
  | 'diagnostics'
  | 'layout'
  | 'text'
  | 'glyphs'
  | 'search'
  | 'select'
  | 'links'
  | 'outline'
  | 'pageContentBox'
  | 'fontList';

/** One entry of a `stats` reply's optional `entries` list. */
export interface WireCacheEntry {
  page: number;
  rotate: number;
  scale: number;
  res: number;
  row: number;
  col: number;
  invert: boolean;
  gray: boolean;
  pageRect: WireRect;
  bytes: number;
  width: number;
  height: number;
}

/** The `diagnostics` reply: text the cache and the engine raised, drained on read. */
export interface WireDiagnosticsResult {
  ok: true;
  messages: string[];
}

export interface RenderRequestParams {
  page: number;
  scale: number;
  rotate?: number;
  clip?: WireRect;
  tile?: TilePosition;
  /**
   * Device pixels per tile side the caller's tile grid was composed against.
   *
   * Pins the worker's adaptive tile geometry (`RenderJob::targetTileSize`), so a
   * memory-pressure reduction at the native end cannot silently change what the
   * caller's tile addresses mean.
   */
  targetTileSize?: number;
  invert?: boolean;
  format?: 'rgba' | 'bgra' | 'gray';
  allowCache?: boolean;
}

export interface SearchRequestParams {
  query: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  forward?: boolean;
  maxResults?: number;
  page?: number;
  pages?: [number, number];
}

export interface ViewportRequestParams {
  visiblePages: number[];
  adjacentPages?: number[];
  nearbyPages?: number[];
  scale: number;
  rotate?: number;
  invert?: boolean;
  format?: 'rgba' | 'bgra' | 'gray';
  prefetch?: boolean;
}

export interface SelectRequestParams {
  page: number;
  mode: 'range' | 'word' | 'line';
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
}
