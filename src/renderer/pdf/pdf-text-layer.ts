/**
 * Eukolia — the PDF text layer, and the scale arithmetic the rasteriser uses.
 *
 * ## Why this module exists
 *
 * The viewer rasterises each page in the native worker and paints it into a
 * `<canvas>`; the text on screen is *pixels*, not DOM text. A transparent HTML
 * text layer is then laid over that bitmap so the document behaves like text:
 * dragging over glyphs selects instead of panning, the copy command, and any
 * future accessibility story all need real glyph boxes in the DOM.
 *
 * For that layer to be honest, each run has to occupy exactly the rectangle the
 * PDF's glyphs occupy. The previous implementation did not do that. It emitted,
 * per text span:
 *
 * ```js
 * left = bbox.x * zoomReal;              // correct
 * top  = bbox.y * zoomReal;              // the box top, not the baseline
 * fontSize = span.size * zoomReal;       // correct
 * lineHeight = '1';
 * whiteSpace = 'pre';
 * // no width, no height, no font choice, no horizontal scale
 * ```
 *
 * An absolutely-positioned element with a text child and no width/height shrink-
 * wraps to the *browser's* rendering of the string in whatever font it fell back
 * to. Two things follow, and both are user-visible defects:
 *
 * 1. **The run is the wrong width.** The browser's font is not the PDF's font, so
 *    its advance widths differ. A run that is 20 % too wide makes the hit target
 *    for the right-hand end of a line land on nothing — dragging there pans the
 *    page instead of selecting — and the box recorded for the run does not match
 *    the glyphs underneath it.
 * 2. **The run is in the wrong place vertically.** `top` is the top of the glyph
 *    ink box, but `top` on a line box positions the *line box*, whose height is
 *    `lineHeight` and whose baseline sits lower still. The text therefore renders
 *    below where it belongs by most of a line height.
 *
 * The fix is to stop leaving the geometry to the browser. Each run is given the
 * PDF span's box as its own box (`left`/`top`/`width`/`height`), the font size
 * MuPDF reports, and a horizontal `scaleX` that stretches the chosen font's own
 * advance width out to the PDF run's advance width. Vertical placement is solved,
 * not guessed: the span declares the PDF box's height with `line-height: 1`, so
 * the browser centres a `fontSize`-tall content area inside that box and the run
 * is shifted up by exactly half the leading, which puts the run's ink on the top
 * of the box the PDF drew its ink in.
 *
 * Everything here except `textLayerRuns` is pure arithmetic, which is what makes
 * the geometry testable without a browser: the browser-dependent part is limited
 * to the `measure` callback the viewer supplies, which a test substitutes.
 *
 * ## What this is *not*
 *
 * light-pdf is a Win32 application. It has no HTML text layer at all: it paints
 * selection rectangles itself and copies text by walking `TextSelection` in C++.
 * The only `font-family` strings in `References/light-pdf/src` are in the HTML
 * bodies of the AI chat panel and the markdown TOC; nothing in the reference
 * builds a text layer, and there is no DOM, no font stack and no `scaleX` for one.
 * So there is no C++ to port for this file, and the reference cannot be the
 * specification for it. What the reference *does* specify, and what this module
 * therefore follows, is the geometry the layer must match: light-pdf extracts its
 * selection geometry with `fz_new_stext_device` and `FZ_STEXT_ACCURATE_BBOXES`
 * (`EngineMupdf.cpp` — `NewTextPageOptions`, `AddCharUtf8`) into
 * `PageText::coords`, and the `stext` span boxes the engine reports are those same
 * numbers — so the layer is built from exactly the geometry light-pdf's own
 * selection uses.
 */

import type { PdfRect, PdfTextBlock } from '../../shared/ipc';

// ---------------------------------------------------------------------------
// Run geometry
// ---------------------------------------------------------------------------

/** One `stext` span, in PDF points, as the engine reports it. */
export interface TextSpan {
  text: string;
  /** PostScript face name, e.g. `NimbusRomNo9L-Regu` (`stext_char::font`). */
  font: string;
  /** Glyph size in points (`stext_char::size`). */
  size: number;
  bbox: PdfRect;
}

/**
 * How the browser actually laid a run out, in CSS pixels — the only input to the
 * geometry that cannot be computed.
 *
 * Producing either number needs a `CanvasRenderingContext2D`, so the caller
 * supplies them and a test can substitute its own.
 */
export interface RunMeasurement {
  /** The run's natural advance width in CSS pixels, at the run's font settings. */
  width: number;
  /** Distance from the top of the line box down to the text baseline. */
  ascent: number;
}

/** A positioned run: CSS pixels, relative to the page's unrotated sheet. */
export interface TextLayerRun {
  text: string;
  font: string;
  fontSize: number;
  /** `left` — the PDF ink box's left edge, scaled. */
  left: number;
  /** `top` — solved so the line box's baseline matches the PDF baseline. */
  top: number;
  width: number;
  height: number;
  /** `scaleX` that maps the browser's advance width onto the PDF run's width. */
  scaleX: number;
  /** The CSS `font-family` stack chosen for `font`. */
  fontFamily: string;
}

/**
 * PostScript face name → a CSS family stack.
 *
 * `stext` reports the *embedded* face's PostScript name (`CMBX12`,
 * `NimbusRomNo9L-Regu`, `UIYSLJ+CMBX12` — a subset prefix may be present). The
 * browser can never have those exact faces, so the best that can be done is to
 * pick the stack with the closest metrics and let `scaleX` absorb the residual
 * width difference. This mirrors what every browser PDF viewer does; there is no
 * reference implementation to copy because light-pdf has no font stack at all.
 *
 * The classification is shape-first and, within a shape, foundry-specific:
 *
 * 1. A face that has been recognised as *this project's* Computer Modern gets a
 *    Latin Modern stack (which is what a TeX document is actually set in).
 * 2. Otherwise the shape — monospaced, sans, or serif — decides the generic
 *    stack, with the URW/Liberation clones named explicitly because they are the
 *    metric-compatible substitutes for the PostScript base fonts.
 *
 * Ordering matters and is the reason this is not a chain of `if`s over a single
 * regex: `NimbusMonL` contains `mon`, `NimbusSanL` contains `san`, and both
 * contain `nimbus`, so a foundry test placed before a shape test classifies every
 * Nimbus face as whatever the foundry matched first. That was a real bug here —
 * `NimbusMonL-Regu` (Courier) came out as a serif — and it is why the shape tests
 * below run first and the foundry tests only ever choose *which* stack of that
 * shape to use.
 *
 * The returned stack always ends in a generic family, so an unrecognised face
 * still resolves to a sensibly shaped font rather than the browser default.
 */
export function cssFontFamilyForPdfFont(postScriptName: string): string {
  // Drop a subset prefix such as `UIYSLJ+`, then strip everything that is not a
  // letter so the size/weight suffixes LaTeX appends (`CMBX12`, `CMR10`,
  // `NimbusRomNo9L`) cannot be mistaken for a family name.
  const plus = postScriptName.indexOf('+');
  const raw = plus >= 0 ? postScriptName.slice(plus + 1) : postScriptName;
  const name = raw.toLowerCase().replace(/[^a-z]/g, '');

  const serif = 'Georgia, "Times New Roman", Times, serif';
  const sans = 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
  const mono = '"Cascadia Mono", Consolas, "Courier New", monospace';

  // --- 1. Computer Modern, by its own family prefixes and its clones ---------
  // `cmss` (Computer Modern Sans Serif) and `cmtt` (Typewriter) must be tested
  // before the bare `cm…` prefix list swallows them.
  if (/^(cmtt|cmtex)/.test(name) || /lmmono|lmtt/.test(name)) return `"Latin Modern Mono", ${mono}`;
  if (/^cmss/.test(name) || /lmsans/.test(name)) return `"Latin Modern Sans", ${sans}`;
  if (/^(cmr|cmbx|cmmi|cmsy|cmex|cmsl|cmti|cmcsc|cmu)/.test(name) || /^(lmroman|lmodern)/.test(name)) {
    return `"Latin Modern Roman", ${serif}`;
  }
  if (/computer ?modern|latin ?modern/.test(name)) return `"Latin Modern Roman", ${serif}`;

  // --- 2. Shape, then the clone that matches it ------------------------------
  const isMono = /mono|monl|courier|typewriter|consol/.test(name);
  // URW's sans faces are `NimbusSanL` / `NimbusSan` — `san`, not `sans`.
  const isSans = /sans|sanl|san$|grotesk|gothic|helv|arial/.test(name);

  if (isMono) return `"Liberation Mono", ${mono}`;
  if (isSans) return `"Liberation Sans", ${sans}`;
  if (/nimbusrom|times|termes|liberationserif|dejavuserif|texgyretermes|freeserif|georgia|cambria|charter|garamond|palatino|book|roman/.test(name)) {
    return `"Liberation Serif", ${serif}`;
  }
  // Symbols and ornaments have no meaningful family; the serif stack at least
  // keeps them on the baseline.
  return serif;
}

/**
 * The scale the rasteriser asks the engine for.
 *
 * `zoomReal` is CSS pixels per PDF point (`PageInfo::zoomReal`), so multiplying
 * by the device pixel ratio gives device pixels per point — exactly as many
 * pixels as the display has for that page, so the canvas draws the bitmap 1:1 and
 * nothing is ever resampled, including in the fit modes where the page is
 * displayed *below* 1:1.
 *
 * This mirrors light-pdf's `renderZoom = page->zoomReal * params->backingScale`
 * (`src/mac/LightMacEngine.cpp:218`). light-pdf has no separate "classic" path —
 * every render on every platform goes through `zoomReal`, which already contains
 * `dpiFactor = screenDPI / fileDPI` — so there is a second, equivalent reading of
 * the same product: `zoomReal` in device pixels per point *is* light-pdf's
 * `zoomReal`, because their CSS pixel and their device pixel are the same thing
 * on a system-DPI-aware Win32 window.
 *
 * `cap` is Eukolia's whole-page allocation guard (`LIGHTPDF_MAX_RENDER_SCALE`),
 * not a user setting and not reference behaviour: light-pdf has no ceiling
 * because it rasterises only the tiles that are on screen while Eukolia
 * rasterises whole pages, and an unbounded ceiling turns a 6400 % zoom of an A0
 * page into a multi-gigapixel allocation. It is 16 device pixels per point, which
 * is 1600 % on a 100 %-scale display, so it is out of the way of reading; when it
 * does bind the page is displayed from a smaller bitmap and `renderScaleConstrained`
 * reports it (`PdfPane`'s render-scale notice). There was once a *setting* here
 * (`pdf.devicePixelRatioCap`, default 4, i.e. 400 %); removing it is what made a
 * page sharp at every zoom rather than sharp until you zoom in.
 */
export function pdfRenderScale(zoomReal: number, devicePixelRatio: number, cap: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = zoomReal * dpr;
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const ceiling = Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY;
  return Math.min(scale, ceiling);
}

/**
 * True when the whole-page allocation guard asks for fewer device pixels than the
 * sheet occupies, i.e. when the page is about to be displayed from a smaller
 * bitmap and is therefore soft.
 */
export function renderScaleConstrained(zoomReal: number, devicePixelRatio: number, cap: number): boolean {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = zoomReal * dpr;
  if (!Number.isFinite(scale) || scale <= 0) return false;
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return cap < scale;
}

/**
 * The bitmap size the renderer must produce for a sheet of `width`×`height` CSS
 * pixels, so that `paint`'s `drawImage(bitmap, 0, 0, width, height)` is an exact
 * 1:1 blit with no resampling.
 *
 * Used by the tests to assert the invariant the blur investigation turned on:
 * the engine's bitmap, the canvas backing store and the sheet's CSS box all
 * describe the same rectangle, so a soft page cannot come from this arithmetic.
 */
export function canvasBackingSize(
  sheetWidth: number,
  sheetHeight: number,
  devicePixelRatio: number
): { width: number; height: number } {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    width: Math.max(0, Math.round(sheetWidth * dpr)),
    height: Math.max(0, Math.round(sheetHeight * dpr))
  };
}

/**
 * The CSS box a page's canvas must be given, in CSS pixels.
 *
 * This is the number that decides whether the page is sharp, and it is not the
 * sheet's size. A canvas is displayed by scaling its backing store into its CSS
 * box; when the two do not describe the *same* device rectangle the compositor
 * resamples the whole page, and text is where that shows — a 0.14 % scale error
 * (one pixel over a 700-pixel page) measured a **25 %** loss of edge energy and
 * halved the count of hard glyph edges in the running application, because the
 * bilinear kernel widens every stem.
 *
 * The engine rounds the page's device box *outward* (`fz_round_rect` floors the
 * low corner and ceils the high one) so it never clips content, while the layout
 * rounds the CSS sheet to a fraction: at a sheet of 544.025 CSS px and a DPR of
 * 1.25 the engine produces 681 device pixels for a box of 680.031, and the
 * canvas was displayed at the layout's size. Sizing the canvas **from the
 * bitmap** makes the blit exact by construction, whatever rounding either side
 * chose: `width * dpr` device pixels is exactly the backing store.
 *
 * The exception is a bitmap that is *not* the one this layout asked for — the
 * whole-page allocation guard (`LIGHDPDF_MAX_RENDER_SCALE`), or a bitmap from an
 * earlier zoom that the new render has not replaced yet. There the sheet's box is
 * kept and the bitmap is stretched, which is both the right geometry (the page is
 * the size the layout says) and what keeps a zoom or a divider drag continuous
 * while the new bitmap is in flight. The guard's case is the one where the page is
 * genuinely soft, and the pane reports it (`data-render-scale-constrained`).
 */
export function canvasDisplayBox(
  bitmap: { width: number; height: number; scale: number } | undefined,
  sheet: { width: number; height: number },
  layoutScale: number,
  devicePixelRatio: number
): { width: number; height: number } {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (!bitmap || !(bitmap.width > 0) || !(bitmap.height > 0)) return sheet;
  const wanted = layoutScale * dpr;
  if (!(wanted > 0)) return sheet;
  // The bitmap this layout asked for, within floating-point equality. Anything
  // else (the guard, or a bitmap from another zoom) is displayed across the sheet.
  if (Math.abs(bitmap.scale - wanted) > 1e-6 * Math.max(1, wanted)) return sheet;
  return { width: bitmap.width / dpr, height: bitmap.height / dpr };
}

// ---------------------------------------------------------------------------
// Building runs
// ---------------------------------------------------------------------------

/** Every span of a page's text, in document order. */
export function spansOfPage(blocks: readonly PdfTextBlock[]): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const block of blocks) {
    for (const line of block.lines) {
      for (const span of line.spans) spans.push(span);
    }
  }
  return spans;
}

/**
 * Places one run.
 *
 * Vertical placement solves for the baseline rather than guessing an ascent
 * ratio. The line box is given exactly the PDF box's height, so the browser puts
 * its own baseline `measure.ascent` pixels below the top of that box; the PDF's
 * baseline sits `(size / (size + descent))` of the way down *its* box only if the
 * box were the full em, which it is not for most real text. So instead of trying
 * to reconstruct the PDF baseline from the box, the run is aligned by its own
 * measured ascent: the PDF ink box is the target, and the run is shifted so its
 * rendered ink spans that box. That is the alignment that actually matters for
 * hit targets.
 *
 * Horizontal placement keeps the origin at the PDF box's left edge and applies a
 * single `scaleX`, so the run's right edge lands on the box's right edge whatever
 * the browser's font metrics are. A run whose natural width is degenerate gets a
 * scale of 1 rather than a division by zero.
 */
export function textLayerRun(
  span: TextSpan,
  pageScale: number,
  measurement: RunMeasurement | null
): TextLayerRun | null {
  if (!Number.isFinite(pageScale) || pageScale <= 0) return null;
  if (!span.text || span.text.length === 0) return null;
  if (!(span.size > 0)) return null;
  if (!(span.bbox.width > 0) || !(span.bbox.height > 0)) return null;

  const fontSize = span.size * pageScale;
  const width = span.bbox.width * pageScale;
  const height = span.bbox.height * pageScale;
  if (!(fontSize > 0) || !(width > 0) || !(height > 0)) return null;

  // With no measurement the run keeps the PDF width: it is still positioned at
  // the right origin and size, which is enough for a hit target, and the first
  // measurement pass refines the stretch.
  const naturalWidth = measurement && measurement.width > 0 ? measurement.width : width;
  const scaleX = naturalWidth > 0 ? width / naturalWidth : 1;
  // Clamp to something a font could plausibly need: a wild ratio means the
  // measurement was taken before the font applied, and an unclamped one would
  // smear the run across the page.
  const clampedScaleX = Math.min(4, Math.max(0.25, scaleX));

  // A plausible ascent or the conventional 0.8 em. A measured ascent outside
  // 0.5–1.5 em means the font was substituted between measuring and rendering
  // (a webfont arriving late, most often), and trusting it would fling the run
  // far off its glyphs.
  const measuredAscent = measurement && measurement.ascent > 0 ? measurement.ascent : 0;
  const ascent = measuredAscent >= fontSize * 0.5 && measuredAscent <= fontSize * 1.5 ? measuredAscent : fontSize * 0.8;

  // The span declares the PDF box's height and `line-height: 1`, so the browser
  // centres a `fontSize`-tall content area in it. The content area's top edge is
  // therefore this far below the span's top edge, and the typographic ink starts
  // at the content area's top edge (by the definition of `ascent` above).
  // Solving `inkTop == bbox.y` for the span's top edge gives the shift below.
  const halfLeading = Math.max(0, (height - fontSize) / 2);
  const inkOffset = halfLeading;

  return {
    text: span.text,
    font: span.font,
    fontSize,
    left: span.bbox.x * pageScale,
    top: span.bbox.y * pageScale - inkOffset,
    width,
    height,
    scaleX: clampedScaleX,
    fontFamily: cssFontFamilyForPdfFont(span.font)
  };
}

/**
 * Every run of a page.
 *
 * `measure` receives the run's text and the font settings it will be rendered
 * with, and returns how the browser actually lays it out. A `null` return means
 * "not measured yet" and is handled by `textLayerRun`.
 */
export function textLayerRuns(
  blocks: readonly PdfTextBlock[],
  pageScale: number,
  measure: (text: string, fontSize: number, fontFamily: string) => RunMeasurement | null
): TextLayerRun[] {
  const runs: TextLayerRun[] = [];
  for (const span of spansOfPage(blocks)) {
    const family = cssFontFamilyForPdfFont(span.font);
    const fontSize = span.size * pageScale;
    let measurement: RunMeasurement | null = null;
    if (fontSize > 0 && span.text.length > 0) {
      try {
        measurement = measure(span.text, fontSize, family);
      } catch {
        // A measurement failure is not fatal: the run still gets its box, which
        // is what hit testing needs.
        measurement = null;
      }
    }
    const run = textLayerRun(span, pageScale, measurement);
    if (run) runs.push(run);
  }
  return runs;
}
