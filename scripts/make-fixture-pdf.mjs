/**
 * Generates `tests/smoke/fixture/figure.pdf`, the image the smoke workspace
 * includes with `\includegraphics`.
 *
 * The smoke probe asserts that Visual Mode shows the *rendered* figure rather
 * than a placeholder, so the fixture has to be a real PDF with unambiguous
 * content. It is written here rather than compiled from LaTeX so the fixture
 * exists before any LaTeX toolchain runs, and so the expected pixels are known
 * exactly: a solid blue rectangle covering most of the page on a white
 * background.
 *
 * Run with:  node scripts/make-fixture-pdf.mjs
 * The generated file is committed; re-run this only when the fixture changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'tests', 'smoke', 'fixture', 'figure.pdf');

/** A PDF rectangle for a 200x150pt page, inset by 20pt. */
const CONTENT = '0.10 0.35 0.85 rg 20 20 160 110 re f\n';

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Contents 4 0 R /Resources << >> >>',
  `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}endstream`,
];

let pdf = '%PDF-1.4\n';
const offsets = [];
for (const [index, body] of objects.entries()) {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
}

const xrefOffset = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) {
  pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, pdf, 'latin1');
console.log(`wrote ${target} (${pdf.length} bytes)`);
