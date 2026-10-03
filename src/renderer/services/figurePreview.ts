/**
 * Eukolia — figure previews for Visual Mode.
 *
 * `\includegraphics{plot.pdf}` should show the figure, not a placeholder. The
 * ported Overleaf graphics widget asks the editor scope for
 * `renderPdfFigurePage({ url, canvas, width })` and, in Overleaf, PDF.js does the
 * rasterising in the page.
 *
 * Eukolia has no PDF.js: it has the native engine ported from light-pdf, which
 * already renders PDF pages far faster than a JavaScript renderer would. So the
 * same request is served by handing the URL to the main process, rasterising
 * page 1 there, and blitting the returned BGRA buffer into the widget's canvas.
 *
 * URL handling matters here: a figure URL is usually a `blob:`/`data:` URL
 * created from the project file, but the native engine opens files by path. The
 * `file:` case is resolved back to a path; anything else is fetched and written
 * to a temporary file, because that is the only interface the engine exposes.
 */

export interface PdfFigureRequest {
  /** A `file:`, `blob:`, `data:` or `http(s):` URL for the figure. */
  url: string;
  canvas: HTMLCanvasElement;
  /** Target width in CSS pixels; the height follows the page's aspect ratio. */
  width: number;
}

/** Renders a PDF figure into `canvas`, scaling it to the requested width. */
export async function renderPdfFigurePage(request: PdfFigureRequest): Promise<void> {
  const path = await resolveFigurePath(request.url);
  if (!path) {
    throw new Error(`Cannot resolve a filesystem path for ${request.url}`);
  }

  const info = await window.eukoliaApi.pdfOpen(path);
  try {
    const page = info.pages[0];
    if (!page || page.width <= 0 || page.height <= 0) {
      throw new Error('The figure PDF has no usable first page');
    }

    // Render at the display resolution, capped so a huge PDF figure cannot
    // allocate an unreasonable bitmap inside the editor.
    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.max(0.05, Math.min(4, (request.width * devicePixelRatio) / page.width));

    const result = await window.eukoliaApi.pdfRender({
      requestId: nextFigureRequestId(),
      path,
      page: 0,
      scale,
      allowCache: true
    });

    const rgba = toRgba(result.pixels, result.order);
    const imageData = new ImageData(result.width, result.height);
    imageData.data.set(rgba);

    request.canvas.width = result.width;
    request.canvas.height = result.height;
    // The canvas is laid out by CSS; the bitmap keeps the page's aspect ratio.
    request.canvas.style.width = `${request.width}px`;
    request.canvas.style.height = `${Math.round((request.width * result.height) / result.width)}px`;

    const context = request.canvas.getContext('2d');
    if (!context) throw new Error('The figure canvas has no 2D context');
    context.putImageData(imageData, 0, 0);
  } finally {
    await window.eukoliaApi.pdfClose(path).catch(() => undefined);
  }
}

/**
 * Converts the native engine's pixels to the byte order `ImageData` requires.
 * The engine returns BGRA, which is what Chromium wants internally, but the
 * channel order still has to be swapped for `ImageData`.
 */
function toRgba(pixels: Uint8Array, order: 'rgb' | 'bgr' | 'bgra' | 'rgba'): Uint8ClampedArray {
  if (order === 'rgba') {
    return new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  }

  if (order === 'bgra') {
    const rgba = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      rgba[i] = pixels[i + 2];
      rgba[i + 1] = pixels[i + 1];
      rgba[i + 2] = pixels[i];
      rgba[i + 3] = pixels[i + 3];
    }
    return rgba;
  }

  const source = order === 'bgr' ? [2, 1, 0] : [0, 1, 2];
  const rgba = new Uint8ClampedArray((pixels.length / 3) * 4);
  for (let from = 0, to = 0; from < pixels.length; from += 3, to += 4) {
    rgba[to] = pixels[from + source[0]];
    rgba[to + 1] = pixels[from + source[1]];
    rgba[to + 2] = pixels[from + source[2]];
    rgba[to + 3] = 255;
  }
  return rgba;
}

let requestCounter = 0;
function nextFigureRequestId(): number {
  // A distinct high range keeps figure renders from colliding with the viewer's.
  return 900_000 + ++requestCounter;
}

/** Resolves a figure URL to a filesystem path the native engine can open. */
async function resolveFigurePath(url: string): Promise<string | null> {
  const direct = fileUrlToPath(url);
  if (direct) return direct;

  // The native engine only opens paths, so a blob/data URL is materialised
  // through the main process into its private temporary directory.
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    const response = await fetch(url);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return window.eukoliaApi.writeTemporaryFile(buffer, 'eukolia-figure.pdf');
  }

  return null;
}

/**
 * Converts a `file:` URL to a filesystem path, or returns null for anything
 * else. Exported because the Windows drive-letter case is easy to get wrong and
 * worth testing directly.
 */
export function fileUrlToPath(url: string): string | null {
  if (!url.startsWith('file:')) return null;
  try {
    const parsed = new URL(url);
    // `pathname` is percent-encoded and, on Windows, keeps a leading slash
    // before the drive letter: `/C:/project/plot.pdf`.
    const decoded = decodeURIComponent(parsed.pathname);
    const withoutLeadingSlash = /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded;
    return decodeURIComponent(parsed.hostname ? `//${parsed.hostname}${withoutLeadingSlash}` : withoutLeadingSlash);
  } catch {
    return null;
  }
}

/**
 * Metadata for one project image, as the ported Overleaf graphics widget wants
 * it. Declared structurally so this module does not depend on the visual
 * editor's own types.
 */
export interface FigureMetadata {
  /** A URL the editor can load: `file:`, `blob:` or `data:`. */
  url: string;
  /** Lower-case extension without the dot, e.g. `png`, `pdf`. */
  extension: string;
  width?: number;
  height?: number;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'pdf', 'eps']);

/** True when the path looks like something `\includegraphics` can use. */
export function isFigurePath(filePath: string): boolean {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filePath);
  return match ? IMAGE_EXTENSIONS.has(match[1].toLowerCase()) : false;
}

/**
 * Builds the image lookup the graphics widget searches.
 *
 * The widget asks by the path exactly as written in the source, which may be
 * `plot.pdf`, `figures/plot.pdf` or `./figures/plot.pdf`, and the project may or
 * may not have a `\graphicspath`. Indexing every image under its relative path,
 * its basename and its absolute path means a lookup succeeds regardless of how
 * the author wrote it.
 */
export function buildFigureIndex(
  files: ReadonlyArray<{ path: string; relativePath: string; isDirectory: boolean }>
): Record<string, FigureMetadata> {
  const index: Record<string, FigureMetadata> = {};

  for (const file of files) {
    if (file.isDirectory || !isFigurePath(file.path)) continue;

    const extension = (/\.([a-zA-Z0-9]+)$/.exec(file.path)?.[1] ?? '').toLowerCase();
    const metadata: FigureMetadata = { url: pathToFileUrl(file.path), extension };

    const relative = file.relativePath.replace(/\\/g, '/');
    const basename = relative.slice(relative.lastIndexOf('/') + 1);
    const absolute = file.path.replace(/\\/g, '/');

    // Later entries do not overwrite earlier ones: a basename collision should
    // keep the first (project-order) match rather than flicker between files.
    for (const key of [relative, `./${relative}`, basename, absolute]) {
      if (!(key in index)) index[key] = metadata;
    }
  }

  return index;
}

/** Converts a filesystem path to a `file:` URL the renderer can load. */
export function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((segment) =>
      // `encodeURIComponent` would turn the drive-letter colon into `%3A`, which
      // a browser then reads as part of the first directory name rather than as
      // `C:`. The colon is therefore restored.
      encodeURIComponent(segment).replace(/%3A/gi, ':')
    )
    .join('/');
  // A Windows drive letter keeps its leading slash: file:///C:/x/y.png
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

export { toRgba as pixelsToRgba, resolveFigurePath };
