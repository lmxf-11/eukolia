/**
 * Eukolia — turning a render reply into canvas pixels.
 *
 * ## Why this module exists
 *
 * It was a private function at the bottom of `PdfViewer.tsx`, and it is the hot path of
 * every page and now every tile. Two callers need it — the viewer's whole-page canvas
 * and the tiled pipeline — and a second copy would be a second chance to get the
 * channel order or the stride wrong, which is a defect that shows as a sheared or
 * blue-tinted page rather than as an exception.
 *
 * ## What it must not do
 *
 * `PDFVIEWER.md` §8:
 *
 * > Continue using tightly packed RGBA without avoidable per-pixel JS conversion.
 * > Validate width, height, stride, channels, and length before constructing image
 * > views; support padded rows explicitly or require tight packing in the negotiated
 * > contract. Existing uncommon-format fallback must not misinterpret stride.
 *
 * The common path is therefore one pass over the buffer *only when a channel swap is
 * needed*, done in place on the buffer that arrived, with the `ImageData` built as a
 * view over that same buffer. The previous implementation allocated twice what a page
 * weighs on every render (a swapped copy plus the `ImageData` buffer) — 10 MB per A4
 * page at 125 %, which a profiler caught as 530 ms of garbage collection inside a 6.4 s
 * scroll, with 4–6 ms `MajorGC` pauses landing as dropped frames.
 *
 * A payload whose length does not match `width * height * channels` is **not**
 * reinterpreted. A padded row misread as tight packing produces a diagonally sheared
 * image, and a 3-channel payload quietly read as 4 produces a page of noise; both are
 * better refused, with the reason, than drawn. {@link describePixelPayload} is the
 * check a caller makes *before* handing a reply to {@link toImageData}, so a bad reply
 * can be rejected without an exception on the render path.
 *
 * Copyright 2026 the Eukolia project authors.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PdfRenderResult } from '../../shared/ipc';

/** Bytes per pixel for each channel order the contract can report. */
export function bytesPerPixel(order: PdfRenderResult['order']): number {
  return order === 'rgb' || order === 'bgr' ? 3 : 4;
}

/**
 * Why a reply's pixel payload cannot be used, or `null` when it can.
 *
 * `PDFVIEWER.md` §8 asks for exactly this validation, and returning a reason rather
 * than throwing lets the caller count it (`PdfRenderMetrics.recordFailed`) and keep
 * going instead of losing a frame to an exception.
 */
export function describePixelPayload(result: PdfRenderResult): string | null {
  const { width, height, stride, order, pixels } = result;
  if (![width, height, stride].every(Number.isSafeInteger) || !Number.isFinite(width * height * 4)) return 'invalid bitmap dimensions';
  if (!(width > 0) || !(height > 0)) return `empty bitmap (${width}x${height})`;
  const bpp = bytesPerPixel(order);
  if (!['rgba', 'bgra', 'rgb', 'bgr'].includes(order) || result.channels !== bpp) return 'invalid bitmap channel layout';
  if (stride < width * bpp) return `stride ${stride} is shorter than a row of ${width} ${order} pixels (${width * bpp})`;
  if (stride !== width * bpp) {
    // Padded rows are legal in the wire format and are handled by the slow path below,
    // but a *tile* is always tightly packed and a page is always tightly packed, so a
    // padded reply means something upstream changed. Say so rather than guess.
    return `padded stride ${stride} for ${width} ${order} pixels`;
  }
  if (pixels.byteLength !== stride * height) {
    return `payload is ${pixels.byteLength} bytes, expected ${stride * height} for ${width}x${height} ${order}`;
  }
  return null;
}

/**
 * Build an `ImageData` over a render reply.
 *
 * Throws when the payload cannot be used; callers that prefer to test first should use
 * {@link describePixelPayload}, which returns the same reason as a string.
 */
export function toImageData(result: PdfRenderResult): ImageData {
  const problem = describePixelPayload(result);
  if (problem !== null) throw new Error(`The PDF engine returned an unusable bitmap: ${problem}.`);

  const { pixels, width, height, order } = result;
  const expected = width * height * 4;

  /**
   * The path every page and every tile takes.
   *
   * The worker sends one tightly packed buffer per render, so the only work needed is
   * the channel swap — done **in place**, on the buffer that arrived — and an
   * `ImageData` built *over* that same buffer.
   */
  if (pixels.byteLength === expected && (order === 'bgra' || order === 'rgba')) {
    if (order === 'bgra') {
      for (let i = 0; i < pixels.length; i += 4) {
        const blue = pixels[i];
        pixels[i] = pixels[i + 2];
        pixels[i + 2] = blue;
      }
    }
    // `as ArrayBuffer`: the IPC reply is never a `SharedArrayBuffer`, and `ImageData`'s
    // constructor is typed to reject one.
    const view = new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, expected);
    return new ImageData(view, width, height);
  }

  /**
   * The uncommon-format path: a 3-channel payload, or a 4-channel one that already
   * carries alpha in a buffer the view above cannot describe. It allocates, because
   * there is no way to widen channels in place, and it is reached only for documents
   * whose format the viewer does not negotiate — never for a normal page.
   */
  let rgba: Uint8ClampedArray;
  if (order === 'rgba') {
    rgba = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  } else if (order === 'bgra') {
    rgba = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      rgba[i] = pixels[i + 2];
      rgba[i + 1] = pixels[i + 1];
      rgba[i + 2] = pixels[i];
      rgba[i + 3] = pixels[i + 3];
    }
  } else if (order === 'bgr') {
    rgba = new Uint8ClampedArray((pixels.length / 3) * 4);
    for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) {
      rgba[target] = pixels[source + 2];
      rgba[target + 1] = pixels[source + 1];
      rgba[target + 2] = pixels[source];
      rgba[target + 3] = 255;
    }
  } else {
    rgba = new Uint8ClampedArray((pixels.length / 3) * 4);
    for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) {
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source + 1];
      rgba[target + 2] = pixels[source + 2];
      rgba[target + 3] = 255;
    }
  }

  // Built via the sized constructor and `set` so the buffer type matches whatever
  // `pixels` came back as, without an unchecked cast.
  const imageData = new ImageData(width, height);
  imageData.data.set(rgba);
  return imageData;
}

/** Byte length an `ImageData` of this size occupies, for a cache budget. */
export function imageDataBytes(image: { width: number; height: number }): number {
  return Math.max(0, image.width) * Math.max(0, image.height) * 4;
}
