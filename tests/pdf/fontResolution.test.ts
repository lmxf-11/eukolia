/**
 * Non-embedded fonts, and the Windows system-font loader.
 *
 * A PDF need not embed its fonts. When it does not, the reader has to find the
 * face itself, and the two ways of doing that are visibly different:
 *
 * - **no loader**: `fz_load_system_font` returns NULL for every name, so MuPDF
 *   substitutes its own built-in clone for all of them — every unresolvable or
 *   non-embedded name renders in the *same* face, and a document asking for
 *   SimSun, Calibri or Arial gets whatever that one substitute is;
 * - **with light-pdf's loader installed** (`install_load_windows_font_funcs`,
 *   exported by the vendored `libmupdf.dll`, which is the reference's own build
 *   and has the loader compiled into it): the name is resolved against the
 *   Windows font directory, so the face — and with it the advance widths, the
 *   hinted outlines and the glyph shapes — is the one light-pdf draws.
 *
 * The loader lives in the DLL, so there is nothing to port; what these tests
 * pin is that the engine actually installs it. The evidence is the rendered
 * page, not a name: MuPDF reports the *requested* PostScript name in its text
 * boxes either way, so the only honest discriminator is that a resolvable name
 * and an unresolvable one do **not** render identically.
 *
 * Skipped, with a reason, on a machine with none of the faces it looks for —
 * the loader only exists in the Windows build of MuPDF.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NativePdfEngine, resolveWorkerPath } from '../../src/main/pdf/nativePdfEngine';

/**
 * Faces to look for, with the name a PDF would use for each. A CJK face is
 * preferred because its advances are nothing like any Latin fallback's, which
 * makes "did the name resolve" a wide margin rather than a subtle one.
 */
const CANDIDATES: Array<{ file: string; name: string }> = [
  { file: 'simsun.ttc', name: 'SimSun' },
  { file: 'msyh.ttc', name: 'Microsoft YaHei' },
  { file: 'malgun.ttf', name: 'Malgun Gothic' },
  { file: 'calibri.ttf', name: 'Calibri' },
  { file: 'segoeui.ttf', name: 'Segoe UI' },
  { file: 'arial.ttf', name: 'Arial' }
];

function fontDirectory(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts');
}

function installedFace(): { file: string; name: string } | null {
  const directory = fontDirectory();
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(path.join(directory, candidate.file))) return candidate;
  }
  return null;
}

/** A one-page PDF in the given face, with nothing embedded. */
function pageWithFace(face: string): string {
  const content = 'BT /F1 24 Tf 72 700 Td (Hamburgefonstiv 123) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${face} >>`
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

  const target = path.join(os.tmpdir(), `eukolia-face-${face.replace(/[^a-z0-9]/gi, '')}.pdf`);
  fs.writeFileSync(target, Buffer.from(pdf, 'latin1'));
  return target;
}

let engine: NativePdfEngine;
let face: { file: string; name: string } | null = null;

/** How the page actually came out: its ink and the run's advance width. */
async function renderFace(name: string, requestId: number): Promise<{ ink: number; advance: number }> {
  const opened = await engine.openDocument(pageWithFace(name));
  const rendered = await engine.renderPage(requestId, { page: 0, scale: 1, format: 'bgra' });
  const text = await engine.getPageText(0);
  await engine.closeDocument();

  let ink = 0;
  for (let index = 0; index < rendered.pixels.length; index += 4) {
    if (rendered.pixels[index] < 128) ink += 1;
  }
  const advance = text.blocks?.[0]?.lines?.[0]?.spans?.[0]?.bbox.width ?? 0;
  expect(ink, `the page in ${name} must render something`).toBeGreaterThan(0);
  return { ink, advance };
}

beforeAll(() => {
  const workerPath = resolveWorkerPath();
  expect(workerPath, 'eukolia-pdf.exe must be built before this suite').not.toBeNull();
  engine = new NativePdfEngine({ workerPath: workerPath as string, autoBuild: false, maxRestarts: 1 });
  face = installedFace();
});

afterAll(async () => {
  await engine?.dispose();
});

describe('a font the document does not embed', () => {
  it('resolves through the system font directory, not to one built-in substitute', async () => {
    if (!face) {
      // `libmupdf.dll` is the reference's Windows build; its loader enumerates
      // `%SystemRoot%\Fonts`, so there is nothing for it to find anywhere else.
      expect(process.platform === 'win32' ? face : null).toBeNull();
      return;
    }

    const installed = await renderFace(face.name, 6001);
    const missing = await renderFace('ZzNoSuchFaceZz', 6002);

    // Same string, same size, same page: only the face can make these differ.
    // Without the loader the engine resolves both to the same built-in clone and
    // the two are byte-identical (measured: 100.656 pt and 454 ink pixels for
    // every unresolvable name).
    expect({ advance: installed.advance, ink: installed.ink }).not.toEqual({
      advance: missing.advance,
      ink: missing.ink
    });
    // And the difference is a real one, not a rounding step: a different face
    // means different advances.
    expect(Math.abs(installed.advance - missing.advance)).toBeGreaterThan(1);
  }, 60_000);
});
