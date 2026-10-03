/**
 * The page's own `/Rotate`, and the one coordinate space the whole viewer agrees
 * on.
 *
 * A PDF page may declare `/Rotate 90|180|270`, and a reader has to honour it: a
 * `/Rotate 180` page shown unrotated is exactly the page upside down. The trap is
 * that three separate things can apply it — the page transform, the view CTM the
 * draw device is created with, and the display list the content is replayed from
 * — and applying it an even number of times silently cancels out. `/Rotate 180`
 * is the awkward case: applied twice it renders byte-identically to `/Rotate 0`,
 * so it looks like "the page is upside down" rather than like a rotation bug, and
 * a `/Rotate 90` page whose content is rotated twice lands outside its own pixmap
 * and comes back blank.
 *
 * The worker therefore has to be self-consistent rather than merely "rotated":
 * the bitmap, the text boxes, the links and the selection rectangles all have to
 * be in ONE space. That space is the **rotated** page box — what `pdf_bound_page`
 * itself returns — because `fz_run_page` and `fz_new_display_list_from_page`
 * apply the page transform before anything else sees the content, so a `/Rotate
 * 90` A4 page occupies 792x612 in it. What these tests pin down is:
 *
 * - the reported page box is the rotated one, so a quarter turn swaps the page's
 *   width and height and the bitmap is the page's own shape at every `/Rotate`;
 * - the ink the raster contains moves with `/Rotate` and is never clipped away;
 * - the text layer's coordinates move with it, because the text layer and the
 *   raster are in the same space and the reader applies its *own* rotation to
 *   both together.
 *
 * The page used here is built in the test rather than taken from the LaTeX
 * fixture: the fixture has `/Rotate 0` on every page, and a real PDF with a
 * non-zero `/Rotate` is not something `pdflatex` produces. It is a plain
 * uncompressed PDF with one page, one text run near the top and a black bar along
 * the top edge, so "where did the ink land" is a question with one answer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NativePdfEngine, resolveWorkerPath } from '../../src/main/pdf/nativePdfEngine';

/** `MediaBox` of the synthetic page, in PDF points. */
const PAGE = { width: 400, height: 400 };
/** The bar's rectangle in PDF user space: along the top edge, half the width. */
const BAR = { x0: 40, y0: 320, x1: 200, y1: 360 };

const CONTENT = [
  // A bar along the top edge, in user space (y ascending, so y 320..360 is high).
  `0 0 0 rg ${BAR.x0} ${BAR.y0} ${BAR.x1 - BAR.x0} ${BAR.y1 - BAR.y0} re f`,
  // A word near the same corner, so the text layer has something to report.
  'BT /F1 24 Tf 40 260 Td (TOPMARK) Tj ET'
].join('\n');

/** A page whose only ink is the top-edge bar — no text to confuse the bounding box. */
const BAR_ONLY_CONTENT = `0 0 0 rg ${BAR.x0} ${BAR.y0} ${BAR.x1 - BAR.x0} ${BAR.y1 - BAR.y0} re f`;

/**
 * A one-page PDF with the given `/Rotate`, built by hand so it is byte-exact and
 * has no dependencies. Offsets are computed as the file is assembled, which is
 * what keeps the xref table honest.
 */
function pageWithRotate(
  rotate: number,
  content: string = CONTENT,
  tag = '',
  size: { width: number; height: number } = PAGE
): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}]` +
      `${rotate ? ` /Rotate ${rotate}` : ''} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  const target = path.join(os.tmpdir(), `eukolia-rotate-${rotate}${tag}.pdf`);
  fs.writeFileSync(target, Buffer.from(pdf, 'latin1'));
  return target;
}

/** The bounding box of the non-white pixels, as fractions of the bitmap. */
function inkBox(
  pixels: Uint8Array,
  channels: number,
  width: number,
  height: number
): { x0: number; x1: number; y0: number; y1: number } | null {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      if (pixels[offset] < 200 || pixels[offset + 1] < 200 || pixels[offset + 2] < 200) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    x0: Math.round((minX / width) * 100) / 100,
    x1: Math.round((maxX / width) * 100) / 100,
    y0: Math.round((minY / height) * 100) / 100,
    y1: Math.round((maxY / height) * 100) / 100
  };
}

let engine: NativePdfEngine;

beforeAll(() => {
  const workerPath = resolveWorkerPath();
  expect(workerPath, 'eukolia-pdf.exe must be built before this suite').not.toBeNull();
  expect(fs.existsSync(workerPath as string)).toBe(true);
  engine = new NativePdfEngine({ workerPath: workerPath as string, autoBuild: false, maxRestarts: 1 });
});

afterAll(async () => {
  await engine?.dispose();
});

describe("the page's own /Rotate", () => {
  it('reports the rotated page box, so a quarter turn swaps its dimensions', async () => {
    /**
     * An A4-shaped page, which is where the unrotated box shows up as a bug: with
     * the unrotated CropBox reported, a `/Rotate 90` page claimed to be 400x600
     * while its content had already been turned into 600x400, so the clip cut the
     * page in half — `/Rotate 90` came back **blank** (the whole content fell
     * outside the clip) and `/Rotate 270` lost a strip of itself — and the text
     * extractor's page box dropped every glyph that fell outside it, which
     * collapsed the text layer's boxes to zero and took selection and search with
     * it.
     */
    const shape = { width: 400, height: 600 };
    const expected: Record<number, { width: number; height: number }> = {
      0: { width: 400, height: 600 },
      90: { width: 600, height: 400 },
      180: { width: 400, height: 600 },
      270: { width: 600, height: 400 }
    };
    for (const rotate of [0, 90, 180, 270]) {
      const opened = await engine.openDocument(pageWithRotate(rotate, CONTENT, '-shape', shape));
      const page = opened.open.pages[0];
      expect({ rotate, width: page.width, height: page.height }).toEqual({ rotate, ...expected[rotate] });
      // The /Rotate itself is still reported, because it is what tells a reader
      // which way up the page's own text is.
      expect(page.rotate).toBe(rotate);

      // The bitmap has the page's shape, and the ink reaches it: a box that does
      // not match the rotated content is exactly what clips the page away.
      const rendered = await engine.renderPage(7200 + rotate, { page: 0, scale: 0.5 });
      expect({ rotate, width: rendered.width, height: rendered.height }).toEqual({
        rotate,
        width: expected[rotate].width / 2,
        height: expected[rotate].height / 2
      });
      expect(inkBox(rendered.pixels, rendered.channels, rendered.width, rendered.height)).not.toBeNull();
      await engine.closeDocument();
    }
  }, 60_000);

  it('moves the text layer with the ink, so a selection box lands on its glyphs', async () => {
    // The text layer is what selection and search are built on. It does not have
    // to stay put under /Rotate — it has to stay in the SAME SPACE as the raster,
    // which means it rotates with it. The generator is the same /Rotate applied to
    // the glyph's position in the content, so the two are compared directly:
    //   content (x, y) -> page (x, y)         at /Rotate 0
    //   content (x, y) -> page (H - y, x)     at /Rotate 90
    //   content (x, y) -> page (W - x, H - y) at /Rotate 180
    //   content (x, y) -> page (y, W - x)     at /Rotate 270
    // A text layer left in content space, which is what happens when the page
    // transform is applied twice during extraction, is mirrored about the page's
    // horizontal centre — every selection rectangle then names the wrong glyphs.
    const firstGlyph = async (rotate: number): Promise<{ x: number; y: number; width: number; height: number }> => {
      const opened = await engine.openDocument(pageWithRotate(rotate));
      const glyphs = await engine.getPageGlyphs(0);
      await engine.closeDocument();
      const glyph = glyphs.glyphs.filter((candidate) => !candidate.lineBreak)[0];
      expect(glyph, `page with /Rotate ${rotate} must report at least one glyph`).toBeDefined();
      const x = glyph?.x ?? Number.NaN;
      const y = glyph?.y ?? Number.NaN;
      const width = glyph?.width ?? 0;
      const height = glyph?.height ?? 0;
      // The BOX, not just its origin: under a quarter turn a box's own top-left is a
      // different corner of the glyph, so the test rotates all four corners and
      // compares the resulting extent, which is what the reader draws.
      return { x, y, width, height };
    };

    const atZero = await firstGlyph(0);
    // Where the content drew it: `Td 40 260`, so x 40 and (with the box measured
    // from the glyph's top rather than its baseline) y just under 400 - 260 - 24.
    expect(Math.abs(atZero.x - 40)).toBeLessThan(2);
    expect(Math.abs(atZero.y - (PAGE.height - 260 - 24))).toBeLessThan(12);

    /** The page-space extent of the content-space box `[x, x+w] x [y, y+h]`. */
    const rotateBox = (
      rotate: number,
      box: { x: number; y: number; width: number; height: number }
    ): { x0: number; x1: number; y0: number; y1: number } => {
      const corners = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x, y: box.y + box.height },
        { x: box.x + box.width, y: box.y + box.height }
      ].map(({ x, y }) => {
        switch (rotate) {
          case 90:
            return { x: PAGE.height - y, y: x };
          case 180:
            return { x: PAGE.width - x, y: PAGE.height - y };
          case 270:
            return { x: y, y: PAGE.width - x };
          default:
            return { x, y };
        }
      });
      return {
        x0: Math.min(...corners.map((corner) => corner.x)),
        x1: Math.max(...corners.map((corner) => corner.x)),
        y0: Math.min(...corners.map((corner) => corner.y)),
        y1: Math.max(...corners.map((corner) => corner.y))
      };
    };

    for (const rotate of [90, 180, 270]) {
      const expected = rotateBox(rotate, atZero);
      const actual = await firstGlyph(rotate);
      const distance = (a: number, b: number): number => Math.abs(a - b);
      // What the test rules out is the whole class of "wrong space" answers, which
      // are off by the page's own size: a text layer left in content space reports
      // y 122 where page space says 260, and a doubled page transform reports 40
      // where it says 260. The tolerance is two points for mupdf's bbox rounding.
      const ok = {
        x0: distance(actual.x, expected.x0) < 2,
        y0: distance(actual.y, expected.y0) < 2,
        x1: distance(actual.x + actual.width, expected.x1) < 2,
        y1: distance(actual.y + actual.height, expected.y1) < 2
      };
      expect({ rotate, ...ok }).toEqual({ rotate, x0: true, y0: true, x1: true, y1: true });
    }
  }, 60_000);

  it('moves the ink the way each /Rotate says, and never leaves it outside the page', async () => {
    // Where the bar ends up is the whole test, so the page here carries only the
    // bar: the text would otherwise join the bounding box and hide which way each
    // axis moved. In the unrotated page the bar hugs the top-left corner, so:
    //   /Rotate 0   -> top-left
    //   /Rotate 90  -> top-right      (the page turns clockwise, into the view)
    //   /Rotate 180 -> bottom-right   (the page turned upside down)
    //   /Rotate 270 -> bottom-left
    const boxes: Record<number, { x0: number; x1: number; y0: number; y1: number }> = {};
    for (const rotate of [0, 90, 180, 270]) {
      const opened = await engine.openDocument(pageWithRotate(rotate, BAR_ONLY_CONTENT, '-bar'));
      const rendered = await engine.renderPage(7000 + rotate, { page: 0, scale: 0.5 });
      await engine.closeDocument();
      // The page is square, so the rotated box is the same box at every /Rotate
      // and the bitmap is the page's own shape whatever the rotation is.
      expect({ rotate, width: rendered.width, height: rendered.height }).toEqual({
        rotate,
        width: PAGE.width / 2,
        height: PAGE.height / 2
      });
      const box = inkBox(rendered.pixels, rendered.channels, rendered.width, rendered.height);
      expect(box, `page with /Rotate ${rotate} must render its bar`).not.toBeNull();
      boxes[rotate] = box as { x0: number; x1: number; y0: number; y1: number };
    }

    // /Rotate 0: the bar is against the top and the left edge. Its own numbers are
    // the check that the space is the plain one: x 40..200 and y 320..360 in a
    // 400x400 page are x 0.10..0.50 and y 0.10..0.20 from the top-left.
    expect(boxes[0].x0).toBeGreaterThan(0.05);
    expect(boxes[0].x0).toBeLessThan(0.15);
    expect(boxes[0].y0).toBeGreaterThan(0.05);
    expect(boxes[0].y0).toBeLessThan(0.15);
    expect(boxes[0].x1).toBeGreaterThan(0.4);
    expect(boxes[0].x1).toBeLessThan(0.6);
    // /Rotate 180: both axes move to the far side. This is the assertion that
    // fails when the page transform is applied twice — the two 180s cancel and the
    // bar stays exactly where /Rotate 0 put it, which is "the page is upside down".
    // Mirroring the /Rotate 0 box is the whole claim: x 0.10..0.50 becomes
    // 0.50..0.90 and y 0.10..0.20 becomes 0.80..0.90.
    expect(boxes[180].x0).toBeCloseTo(1 - boxes[0].x1, 2);
    expect(boxes[180].x1).toBeCloseTo(1 - boxes[0].x0, 2);
    expect(boxes[180].y0).toBeCloseTo(1 - boxes[0].y1, 2);
    expect(boxes[180].y1).toBeCloseTo(1 - boxes[0].y0, 2);
    // /Rotate 90 and 270 turn the page a quarter turn, which moves the bar to a
    // different corner and swaps which axis each of its two spans lies on. In the
    // unrotated page it is x 0.10..0.50 by y 0.10..0.20 from the top-left, so a
    // quarter turn puts it at x 0.10..0.20 by y 0.50..0.90 the other way round from
    // x 0.80..0.90 by y 0.10..0.50. The tolerance is one step of the sampled
    // bitmap (the render is at half scale).
    const near = (value: number, expected: number): void => {
      expect(Math.abs(value - expected)).toBeLessThanOrEqual(0.05);
    };
    near(boxes[90].x0, 1 - boxes[0].y1);
    near(boxes[90].x1, 1 - boxes[0].y0);
    near(boxes[90].y0, boxes[0].x0);
    near(boxes[90].y1, boxes[0].x1);
    near(boxes[270].x0, boxes[0].y0);
    near(boxes[270].x1, boxes[0].y1);
    near(boxes[270].y0, 1 - boxes[0].x1);
    near(boxes[270].y1, 1 - boxes[0].x0);
    // Nothing is ever drawn outside the page box: a content transform applied
    // twice lands the page outside its own pixmap, which is how a /Rotate 90 page
    // used to come back blank.
    for (const rotate of [0, 90, 180, 270]) {
      const box = boxes[rotate];
      expect({ rotate, x0: box.x0 >= 0, x1: box.x1 <= 1, y0: box.y0 >= 0, y1: box.y1 <= 1 }).toEqual({
        rotate,
        x0: true,
        x1: true,
        y0: true,
        y1: true
      });
    }
  }, 60_000);

  it('does not rotate a page that declares no /Rotate', async () => {
    // The guard against "fixed the rotation bug by rotating everything": the bar
    // stays on the top edge and the bitmap is the page's own shape.
    const opened = await engine.openDocument(pageWithRotate(0));
    const rendered = await engine.renderPage(7100, { page: 0, scale: 0.5 });
    await engine.closeDocument();
    expect({ width: rendered.width, height: rendered.height }).toEqual({
      width: PAGE.width / 2,
      height: PAGE.height / 2
    });
    const box = inkBox(rendered.pixels, rendered.channels, rendered.width, rendered.height);
    expect(box?.y0).toBeLessThan(0.2);
  }, 60_000);
});
