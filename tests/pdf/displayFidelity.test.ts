/**
 * Display fidelity: the raster scale chain, and the text layer's geometry.
 *
 * Both halves of this file guard the same property from different sides — that
 * the page the user sees is the page the engine rendered, at the size the engine
 * rendered it, with the text layer standing exactly on the glyphs.
 *
 * ## The scale chain
 *
 * The bitmap must have exactly as many device pixels as the box it is displayed
 * in. If it has fewer, the canvas stretches it and the page is soft; if it has
 * more, work was wasted. There are two halves to that, and both are pinned here:
 *
 * 1. **The render scale** — `pdfRenderScale` asks for `zoomReal * dpr`, one device
 *    pixel per PDF point per CSS pixel, so the engine's bitmap and the page's
 *    device box are the same size. (This is where a *setting* used to cap the
 *    scale at 4 device px/pt, i.e. 400 % zoom, and made every page softer than the
 *    display from there up.)
 * 2. **The blit** — `canvasDisplayBox` gives the canvas that bitmap's own size
 *    divided by the ratio. Sizing it from the *layout* instead is the subtler
 *    half: the engine rounds the page's device box outward (`fz_round_rect`) and
 *    the layout rounds the sheet to a fraction, so a sheet-sized canvas is a
 *    fractional rescale of its own backing store, and the compositor filters
 *    every glyph edge. Measured in the running application, one pixel of mismatch
 *    over a 700-pixel page (0.14 %) cost a **25 %** loss of edge energy and half
 *    the hard glyph edges.
 *
 * ## The text layer
 *
 * The layer is invisible, so its correctness cannot be seen — only measured. The
 * properties asserted below are the ones that make it honest:
 *
 * - every run's box is the PDF span's box, scaled (`left`/`top`/`width`/`height`);
 * - the run is stretched horizontally so its *rendered* width equals the PDF
 *   run's advance width, whatever the browser's font metrics are;
 * - the vertical placement solves for the baseline, so the run sits on its
 *   glyphs instead of most of a line height below them;
 * - an embedded font gets a plausible CSS family rather than the browser default.
 */

import { describe, expect, it } from 'vitest';

import {
  canvasBackingSize,
  canvasDisplayBox,
  cssFontFamilyForPdfFont,
  pdfRenderScale,
  renderScaleConstrained,
  spansOfPage,
  textLayerRun,
  textLayerRuns,
  type RunMeasurement
} from '../../src/renderer/pdf/pdf-text-layer';
import type { PdfTextBlock } from '../../src/shared/ipc';

// ---------------------------------------------------------------------------
// Scale chain
// ---------------------------------------------------------------------------

describe('pdfRenderScale — device pixels per PDF point', () => {
  it('is the page scale times the device pixel ratio', () => {
    // A 150 %-scaled display (dpr 1.5) at light-pdf's 100 % zoom: zoomReal is
    // 96/72 = 1.333 CSS px per point, so the render scale is 1.333 * 1.5 = 2.
    expect(pdfRenderScale(96 / 72, 1.5, 8)).toBeCloseTo(2, 10);
    expect(pdfRenderScale(0.75, 1, 8)).toBeCloseTo(0.75, 10);
    expect(pdfRenderScale(1, 1.25, 8)).toBeCloseTo(1.25, 10);
  });

  it('treats a missing or nonsensical device pixel ratio as 1', () => {
    expect(pdfRenderScale(1.25, 0, 8)).toBeCloseTo(1.25, 10);
    expect(pdfRenderScale(1.25, Number.NaN, 8)).toBeCloseTo(1.25, 10);
    expect(pdfRenderScale(1.25, -2, 8)).toBeCloseTo(1.25, 10);
  });

  it('returns 0 for a page with no scale rather than a bogus scale', () => {
    // `ZoomRealFromVirtualForPage` really does return 0 while the viewport has no
    // area, and rendering at 0 would ask the engine for a zero-pixel page.
    expect(pdfRenderScale(0, 1.25, 8)).toBe(0);
    expect(pdfRenderScale(Number.NaN, 1.25, 8)).toBe(0);
    expect(pdfRenderScale(-1, 1.25, 8)).toBe(0);
  });

  it('never exceeds the configured ceiling', () => {
    // Eukolia's own `pdf.devicePixelRatioCap`. light-pdf has no equivalent: it
    // rasterises only the tiles on screen, so it never needs one.
    expect(pdfRenderScale(10, 1, 4)).toBe(4);
    expect(pdfRenderScale(3, 2, 4)).toBe(4);
    expect(pdfRenderScale(3, 1.25, 4)).toBeCloseTo(3.75, 10);
  });

  it('reports when the ceiling forces the bitmap below the display resolution', () => {
    // The ceiling's cost, named so it can be surfaced instead of showing up as a
    // page that is sharp until you zoom in. A render below `zoomReal * dpr` is a
    // bitmap smaller than the sheet's CSS box, so the canvas stretches it.
    expect(renderScaleConstrained(1, 1, 4)).toBe(false);
    expect(renderScaleConstrained(4, 1, 4)).toBe(false);
    // 500 % on a 100 %-scale display: needs 5 device px/pt, the default cap is 4.
    expect(renderScaleConstrained(5, 1, 4)).toBe(true);
    // 125 % display: the default cap first bites at 320 %.
    expect(renderScaleConstrained(3.2, 1.25, 4)).toBe(false);
    expect(renderScaleConstrained(3.3, 1.25, 4)).toBe(true);
    // A page with no scale is not "constrained"; it is simply not rendered.
    expect(renderScaleConstrained(0, 2, 4)).toBe(false);
    // No usable ceiling means nothing is being given up.
    expect(renderScaleConstrained(100, 2, 0)).toBe(false);
    expect(renderScaleConstrained(100, 2, Number.NaN)).toBe(false);
  });

  it('renders 1:1 at every zoom the default ceiling allows', () => {
    // The property that rules out renderer-side blur in the normal zoom range:
    // the engine's bitmap is never smaller than the sheet's device-pixel box.
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const zoomReal of [0.25, 0.5, 96 / 72, 1, 2]) {
        const scale = pdfRenderScale(zoomReal, dpr, 4);
        expect(612 * scale).toBeGreaterThanOrEqual(612 * zoomReal * dpr - 1e-9);
        expect(renderScaleConstrained(zoomReal, dpr, 4)).toBe(false);
      }
    }
  });

  it('ignores a nonsensical ceiling instead of clamping to it', () => {
    // A cap of 0 or NaN cannot be honoured as "render nothing"; the setting is
    // simply unusable and the 1:1 render proceeds.
    expect(pdfRenderScale(2, 1, 0)).toBe(2);
    expect(pdfRenderScale(2, 1, Number.NaN)).toBe(2);
    expect(pdfRenderScale(2, 1, -4)).toBe(2);
  });

  it('matches the backing store the canvas will be given', () => {
    // The invariant that rules out renderer-side blur: for every page scale and
    // device pixel ratio, the bitmap the engine must return is the sheet's CSS
    // box times the ratio — the same number the canvas element is sized to.
    for (const zoomReal of [0.25, 0.5, 96 / 72, 1, 2, 3.5]) {
      for (const dpr of [1, 1.25, 1.5, 2]) {
        const sheetWidth = 612 * zoomReal;
        const sheetHeight = 792 * zoomReal;
        const backing = canvasBackingSize(sheetWidth, sheetHeight, dpr);
        const scale = pdfRenderScale(zoomReal, dpr, 64);
        expect(backing.width).toBe(Math.round(612 * scale));
        expect(backing.height).toBe(Math.round(792 * scale));
      }
    }
  });

  it('sizes the backing store from the CSS box, rounding once', () => {
    expect(canvasBackingSize(448, 633.6, 1.25)).toEqual({ width: 560, height: 792 });
    expect(canvasBackingSize(0, 0, 2)).toEqual({ width: 0, height: 0 });
    // A negative or absent ratio must not produce a negative canvas.
    expect(canvasBackingSize(100, 100, -1)).toEqual({ width: 100, height: 100 });
  });
});

describe('canvasDisplayBox — the canvas box that makes the blit exact', () => {
  /**
   * The measurement this was written from: a sheet of 544.025 CSS px at a ratio
   * of 1.25 is a 680.031-pixel device box, which the engine's outward rounding
   * (`fz_round_rect` floors the low corner and ceils the high one) turns into a
   * 681-pixel bitmap. Displayed at the sheet's size that is a 0.9986 scale — the
   * compositor filters the page — and displayed at `681 / 1.25` it is exactly
   * 681 device pixels, so nothing is resampled.
   */
  it('follows the bitmap, not the sheet, so the blit is 1:1', () => {
    const sheet = { width: 544.025, height: 704.025 };
    const box = canvasDisplayBox({ width: 681, height: 881, scale: 1.25 }, sheet, 1, 1.25);
    expect(box.width * 1.25).toBeCloseTo(681, 10);
    expect(box.height * 1.25).toBeCloseTo(881, 10);
    // And the sheet is what the canvas would have been given before: a
    // fractional rescale of the very same bitmap.
    expect(sheet.width * 1.25).not.toBeCloseTo(681, 10);
  });

  it('gives the canvas exactly as many device pixels as the engine produced', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (const zoomReal of [0.25, 0.547, 96 / 72, 1, 1.667, 4]) {
        const scale = pdfRenderScale(zoomReal, dpr, 64);
        // What the engine's outward rounding can do to a page's device box: up to
        // one pixel more than the fractional box in each axis.
        const bitmap = {
          width: Math.ceil(612 * scale - 0.001),
          height: Math.ceil(792 * scale - 0.001),
          scale
        };
        const box = canvasDisplayBox(bitmap, { width: 612 * zoomReal, height: 792 * zoomReal }, zoomReal, dpr);
        expect(box.width * dpr).toBeCloseTo(bitmap.width, 6);
        expect(box.height * dpr).toBeCloseTo(bitmap.height, 6);
      }
    }
  });

  it('stretches the sheet box when the guard capped the render', () => {
    // Above the whole-page allocation guard the bitmap really is smaller than the
    // display wants, and shrinking the sheet to the bitmap would make the page the
    // wrong size on screen rather than merely soft. The sheet's box is kept, and
    // `renderScaleConstrained` is what says the page is soft.
    const sheet = { width: 612, height: 792 };
    const box = canvasDisplayBox({ width: 1024, height: 1324, scale: 4 }, sheet, 5, 1.25);
    expect(box).toEqual(sheet);
  });

  it('keeps the sheet box for a bitmap from another zoom', () => {
    // A zoom or a divider drag leaves the previous zoom's bitmap in the cache
    // until the new render lands. Taking *its* size would draw the page at the old
    // zoom's scale — the wrong geometry, and the sheet's box is what keeps the
    // interaction continuous instead.
    const sheet = { width: 612, height: 792 };
    expect(canvasDisplayBox({ width: 1000, height: 1294, scale: 1.5 }, sheet, 2, 1)).toEqual(sheet);
    expect(canvasDisplayBox({ width: 400, height: 518, scale: 0.5 }, sheet, 2, 1)).toEqual(sheet);
  });

  it('keeps the sheet box when there is no bitmap yet', () => {
    const sheet = { width: 612, height: 792 };
    expect(canvasDisplayBox(undefined, sheet, 1, 1.25)).toEqual(sheet);
    expect(canvasDisplayBox({ width: 0, height: 0, scale: 0 }, sheet, 1, 1.25)).toEqual(sheet);
    // A page whose scale is degenerate cannot produce a box at all.
    expect(canvasDisplayBox({ width: 10, height: 10, scale: 1 }, sheet, 0, 1.25)).toEqual(sheet);
    // And a nonsensical ratio is 1, not a division by zero.
    expect(canvasDisplayBox({ width: 100, height: 200, scale: 1 }, sheet, 1, Number.NaN)).toEqual({
      width: 100,
      height: 200
    });
  });
});

// ---------------------------------------------------------------------------
// Font selection
// ---------------------------------------------------------------------------

describe('cssFontFamilyForPdfFont — PostScript face → CSS stack', () => {
  it('strips the subset prefix', () => {
    expect(cssFontFamilyForPdfFont('UIYSLJ+CMBX12')).toBe(cssFontFamilyForPdfFont('CMBX12'));
  });

  it('maps the LaTeX Computer Modern families', () => {
    expect(cssFontFamilyForPdfFont('CMR10')).toContain('Latin Modern Roman');
    expect(cssFontFamilyForPdfFont('CMBX12')).toContain('Latin Modern Roman');
    expect(cssFontFamilyForPdfFont('CMTT10')).toContain('Latin Modern Mono');
    expect(cssFontFamilyForPdfFont('CMSS10')).toContain('Latin Modern Sans');
  });

  it('maps the PostScript base fonts and their clones', () => {
    expect(cssFontFamilyForPdfFont('NimbusRomNo9L-Regu')).toContain('Liberation Serif');
    expect(cssFontFamilyForPdfFont('NimbusSanL-Regu')).toContain('Liberation Sans');
    expect(cssFontFamilyForPdfFont('NimbusMonL-Regu')).toContain('Liberation Mono');
    expect(cssFontFamilyForPdfFont('Times-Roman')).toContain('Liberation Serif');
    expect(cssFontFamilyForPdfFont('Courier')).toContain('Liberation Mono');
  });

  it('always ends in a generic family, so an unknown face still has a shape', () => {
    for (const name of ['TotallyUnknownFace', 'CMR10', 'NimbusRomNo9L-Regu', '', 'A+B']) {
      const stack = cssFontFamilyForPdfFont(name);
      expect(stack).toMatch(/(serif|sans-serif|monospace)$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Run geometry
// ---------------------------------------------------------------------------

/** A span whose font is *half* as wide as the PDF's, to make scaling visible. */
const SPAN = {
  text: 'Eukolia Smoke Test',
  font: 'UIYSLJ+CMBX12',
  size: 17.2154,
  bbox: { x: 189.4, y: 207.9, width: 216.5, height: 18.4 }
};

describe('textLayerRun — one run on the PDF box', () => {
  it('puts the run on the PDF box, scaled', () => {
    const run = textLayerRun(SPAN, 0.75, { width: 200, ascent: 13 });
    expect(run).not.toBeNull();
    expect(run?.left).toBeCloseTo(189.4 * 0.75, 6);
    expect(run?.width).toBeCloseTo(216.5 * 0.75, 6);
    expect(run?.height).toBeCloseTo(18.4 * 0.75, 6);
    expect(run?.fontSize).toBeCloseTo(17.2154 * 0.75, 6);
  });

  it('stretches the run to the PDF advance width', () => {
    // The browser laid the run out 200 px wide; the PDF says 216.5 * 0.75 =
    // 162.375 px. The run must be squeezed to the PDF's width, not left at 200.
    const run = textLayerRun(SPAN, 0.75, { width: 200, ascent: 13 });
    expect(run?.scaleX).toBeCloseTo((216.5 * 0.75) / 200, 6);
    expect(run!.scaleX * 200).toBeCloseTo(run!.width, 6);
  });

  it('leaves a run alone when the browser already agrees with the PDF', () => {
    const width = SPAN.bbox.width * 2;
    const run = textLayerRun(SPAN, 2, { width, ascent: 30 });
    expect(run?.scaleX).toBeCloseTo(1, 10);
  });

  it('clamps an implausible scale rather than smearing the run', () => {
    // A measurement taken before a webfont applied can be wildly wrong; an
    // unclamped ratio would stretch the run across the page.
    const tiny = textLayerRun(SPAN, 1, { width: 1, ascent: 14 });
    expect(tiny?.scaleX).toBe(4);
    const huge = textLayerRun(SPAN, 1, { width: 100000, ascent: 14 });
    expect(huge?.scaleX).toBe(0.25);
  });

  it('solves the baseline so the run sits on its glyphs', () => {
    // The span is the PDF box's height and `line-height: 1`, so the browser
    // centres a `fontSize`-tall content area inside it. The ink therefore starts
    // half the leading below the span's top edge, and the span is shifted up by
    // exactly that much.
    const pageScale = 1;
    const run = textLayerRun(SPAN, pageScale, { width: 216.5, ascent: 17 });
    const halfLeading = (SPAN.bbox.height - SPAN.size) / 2;
    expect(run?.top).toBeCloseTo(SPAN.bbox.y - halfLeading, 6);
    // Sanity: the correction is small and upward, not a whole line height.
    expect(run!.top).toBeLessThan(SPAN.bbox.y);
    expect(SPAN.bbox.y - run!.top).toBeLessThan(SPAN.bbox.height);
  });

  it('falls back to a conventional ascent when the font reports none', () => {
    const noMetrics = textLayerRun(SPAN, 1, { width: 216.5, ascent: 0 });
    expect(noMetrics).not.toBeNull();
    const measured = textLayerRun(SPAN, 1, { width: 216.5, ascent: 14 });
    // Both are valid placements; neither may be NaN, and they differ only by the
    // leading they imply.
    expect(Number.isFinite(noMetrics!.top)).toBe(true);
    expect(Number.isFinite(measured!.top)).toBe(true);
  });

  it('rejects a measured ascent that cannot belong to this font', () => {
    // 200 px of ascent for a 17 px font means the font was substituted between
    // measuring and rendering; trusting it would fling the run off the page.
    const bogus = textLayerRun(SPAN, 1, { width: 216.5, ascent: 200 });
    const conventional = textLayerRun(SPAN, 1, { width: 216.5, ascent: 0 });
    expect(bogus?.top).toBeCloseTo(conventional!.top, 10);
  });

  it('still places a run when it could not be measured', () => {
    const run = textLayerRun(SPAN, 1, null);
    expect(run).not.toBeNull();
    // Unmeasured, the run keeps the PDF width, so the hit target is right even
    // before the first measurement pass.
    expect(run?.scaleX).toBe(1);
    expect(run?.width).toBeCloseTo(SPAN.bbox.width, 6);
    expect(run?.top).toBeCloseTo(SPAN.bbox.y - (SPAN.bbox.height - SPAN.size) / 2, 6);
  });

  it('refuses degenerate input instead of emitting a broken run', () => {
    expect(textLayerRun(SPAN, 0, null)).toBeNull();
    expect(textLayerRun(SPAN, Number.NaN, null)).toBeNull();
    expect(textLayerRun({ ...SPAN, text: '' }, 1, null)).toBeNull();
    expect(textLayerRun({ ...SPAN, size: 0 }, 1, null)).toBeNull();
    expect(textLayerRun({ ...SPAN, bbox: { ...SPAN.bbox, width: 0 } }, 1, null)).toBeNull();
    expect(textLayerRun({ ...SPAN, bbox: { ...SPAN.bbox, height: -1 } }, 1, null)).toBeNull();
  });
});

describe('textLayerRuns — a whole page', () => {
  const blocks: PdfTextBlock[] = [
    {
      bbox: { x: 72, y: 100, width: 400, height: 40 },
      lines: [
        {
          bbox: { x: 72, y: 100, width: 400, height: 12 },
          spans: [
            { text: 'Hello ', font: 'CMR10', size: 11, bbox: { x: 72, y: 100, width: 30, height: 11 } },
            { text: 'world', font: 'CMBX10', size: 11, bbox: { x: 102, y: 100, width: 28, height: 11 } }
          ]
        }
      ]
    }
  ];

  it('emits one run per span, in order', () => {
    const runs = textLayerRuns(blocks, 1, () => ({ width: 10, ascent: 9 }));
    expect(runs.map((run) => run.text)).toEqual(['Hello ', 'world']);
    expect(runs[0].left).toBeCloseTo(72, 6);
    expect(runs[1].left).toBeCloseTo(102, 6);
  });

  it('passes the run’s own font settings to the measurement', () => {
    const seen: { text: string; fontSize: number; family: string }[] = [];
    textLayerRuns(blocks, 2, (text, fontSize, family) => {
      seen.push({ text, fontSize, family });
      return { width: 10, ascent: 9 };
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].fontSize).toBeCloseTo(22, 6);
    expect(seen[0].family).toContain('Latin Modern Roman');
    // The two spans use different faces, so they must not share a family.
    expect(seen[1].family).toBe(cssFontFamilyForPdfFont('CMBX10'));
  });

  it('drops a span that cannot be placed rather than emitting a degenerate run', () => {
    const runs = textLayerRuns(
      [
        {
          bbox: { x: 0, y: 0, width: 100, height: 10 },
          lines: [
            {
              bbox: { x: 0, y: 0, width: 100, height: 10 },
              spans: [
                { text: 'ok', font: 'CMR10', size: 11, bbox: { x: 0, y: 0, width: 20, height: 10 } },
                { text: '   ', font: 'CMR10', size: 11, bbox: { x: 0, y: 0, width: 0, height: 0 } }
              ]
            }
          ]
        }
      ],
      1,
      () => ({ width: 20, ascent: 9 })
    );
    expect(runs.map((run) => run.text)).toEqual(['ok']);
  });

  it('survives a measurement that throws', () => {
    const runs = textLayerRuns(blocks, 1, () => {
      throw new Error('no canvas');
    });
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(Number.isFinite(run.left)).toBe(true);
  });

  it('keeps every run inside the span it stands for', () => {
    // The property that matters for hit testing and selection: the run's box is
    // the PDF span's box.
    const measure = (text: string, fontSize: number): RunMeasurement => ({
      width: text.length * fontSize * 0.4,
      ascent: fontSize * 0.8
    });
    const runs = textLayerRuns(blocks, 1.5, (text, fontSize) => measure(text, fontSize));
    const spans = spansOfPage(blocks);
    expect(runs).toHaveLength(spans.length);
    runs.forEach((run, index) => {
      const span = spans[index];
      expect(run.left).toBeCloseTo(span.bbox.x * 1.5, 6);
      expect(run.width).toBeCloseTo(span.bbox.width * 1.5, 6);
      expect(run.height).toBeCloseTo(span.bbox.height * 1.5, 6);
      // The rendered width after the stretch is the PDF advance width.
      const measurement = measure(span.text, span.size * 1.5);
      expect(measurement.width * run.scaleX).toBeCloseTo(span.bbox.width * 1.5, 6);
    });
  });
});

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

describe('the text layer is what answers "is the pointer over text?"', () => {
  // The gesture only selects when the pointer is over the text layer
  // (`PdfViewer`'s `mousedown` → `element?.closest('[data-text-layer]')`);
  // otherwise a drag pans. That test is only meaningful if the spans actually
  // cover the glyphs, which is what these runs guarantee: a point inside a span's
  // PDF box is inside the run's CSS box, so `elementFromPoint` finds it.
  const blocks: PdfTextBlock[] = [
    {
      bbox: { x: 72, y: 100, width: 400, height: 40 },
      lines: [
        {
          bbox: { x: 72, y: 100, width: 400, height: 12 },
          spans: [{ text: 'Hello world', font: 'CMR10', size: 11, bbox: { x: 72, y: 100, width: 58, height: 11 } }]
        }
      ]
    }
  ];

  it('covers the whole PDF box of every span', () => {
    const runs = textLayerRuns(blocks, 2, (text, fontSize) => ({ width: text.length * fontSize * 0.5, ascent: fontSize * 0.8 }));
    const spans = spansOfPage(blocks);
    expect(runs).toHaveLength(spans.length);
    for (let index = 0; index < runs.length; index++) {
      const span = spans[index];
      const run = runs[index];
      // The run's box, in page-local CSS pixels, is the span's box.
      expect(run.left).toBeCloseTo(span.bbox.x * 2, 6);
      expect(run.width).toBeCloseTo(span.bbox.width * 2, 6);
      expect(run.height).toBeCloseTo(span.bbox.height * 2, 6);
      // Vertically the run straddles the span's box: the shift that solves the
      // baseline never moves the run off its own glyphs.
      expect(run.top).toBeLessThanOrEqual(span.bbox.y * 2);
      expect(run.top + run.height).toBeGreaterThan(span.bbox.y * 2);
    }
  });

  it('leaves no span unrepresented, which would be a dead patch of page', () => {
    // Every span with a real box produces a run, so there is no rectangle of
    // glyphs the user can drag on and get a pan instead of a selection.
    const runs = textLayerRuns(blocks, 1, () => ({ width: 10, ascent: 8 }));
    expect(runs.map((run) => run.text)).toEqual(['Hello world']);
  });
});
