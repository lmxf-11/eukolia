/**
 * light-pdf's "Document Properties" window (`CmdProperties`, `Ctrl+D`).
 *
 * The rows and their labels are light-pdf's own (`propToName`,
 * `LightProperties.cpp:328-377`), as is the order it emits them in; the values
 * come from what Eukolia's PDF contract actually carries, and a row with no
 * value is left out rather than shown empty.
 */

import { describe, expect, it } from 'vitest';

import { documentPropertyRows, documentPropertyText, formatPdfDate } from '@/pdf/lightpdf-properties';
import type { PdfOpenResult } from '../../src/shared/ipc';

const documentInfo: Pick<PdfOpenResult, 'path' | 'pageCount' | 'pages' | 'metadata'> = {
  path: 'C:/work/thesis/main.pdf',
  pageCount: 12,
  pages: [
    { width: 595.276, height: 841.89 },
    { width: 595.276, height: 841.89 }
  ],
  metadata: {
    title: 'A Thesis',
    author: 'A. Author',
    subject: 'LaTeX',
    keywords: 'latex, pdf',
    creator: 'LaTeX with hyperref',
    producer: 'pdfTeX-1.40.25',
    creationDate: "D:20240102030405+01'00'",
    modDate: 'D:20240102030406Z',
    format: 'PDF 1.7',
    encryption: 'Standard V2'
  }
};

describe('formatPdfDate', () => {
  it('turns a PDF date into a readable one', () => {
    expect(formatPdfDate("D:20240102030405+01'00'")).toBe('2024-01-02 03:04:05');
    expect(formatPdfDate('D:20240102030406Z')).toBe('2024-01-02 03:04:06');
  });

  it('keeps partial dates partial instead of inventing a time', () => {
    expect(formatPdfDate('D:202401')).toBe('2024-01');
    expect(formatPdfDate('D:20240102')).toBe('2024-01-02');
  });

  it('passes an unparseable value through, so it stays visible', () => {
    expect(formatPdfDate('not a date')).toBe('not a date');
  });
});

describe('documentPropertyRows', () => {
  it('shows light-pdf\'s rows, in its order, with its labels', () => {
    const rows = documentPropertyRows(documentInfo, 1);
    expect(rows.map((row) => row.label)).toEqual([
      'File:',
      'Title:',
      'Subject:',
      'Author:',
      // light-pdf labels the PDF's `Creator` entry "Application:".
      'Application:',
      'PDF Producer:',
      'PDF Version:',
      'Keywords:',
      'Created:',
      'Modified:',
      'Encryption:',
      'Number of Pages:',
      'Current Page (1) Size:'
    ]);
    expect(rows[0].value).toBe('C:/work/thesis/main.pdf');
    expect(rows.find((row) => row.label === 'Number of Pages:')?.value).toBe('12');
    expect(rows.find((row) => row.label === 'Created:')?.value).toBe('2024-01-02 03:04:05');
  });

  it('reports the current page\'s size in points', () => {
    const row = documentPropertyRows(documentInfo, 2).find((entry) => entry.label.startsWith('Current Page'));
    expect(row?.label).toBe('Current Page (2) Size:');
    expect(row?.value).toBe('595.28 × 841.89 points');
  });

  it('omits a row it has no value for rather than showing it empty', () => {
    const rows = documentPropertyRows(
      { path: 'a.pdf', pageCount: 1, pages: [{ width: 612, height: 792 }], metadata: {} },
      1
    );
    expect(rows.map((row) => row.label)).toEqual(['File:', 'Number of Pages:', 'Current Page (1) Size:']);
  });

  it('survives a page number outside the document', () => {
    const rows = documentPropertyRows({ ...documentInfo, pageCount: 2 }, 9);
    expect(rows.some((row) => row.label.startsWith('Current Page'))).toBe(false);
  });

  it('serialises to the text the window displays', () => {
    const rows = documentPropertyRows(documentInfo, 1);
    const text = documentPropertyText(rows);
    expect(text.startsWith('File: C:/work/thesis/main.pdf\nTitle: A Thesis')).toBe(true);
    expect(text.split('\n')).toHaveLength(rows.length);
  });
});
