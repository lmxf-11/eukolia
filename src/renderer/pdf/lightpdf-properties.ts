/**
 * Eukolia — light-pdf's "Document Properties" window, modelled.
 *
 * light-pdf shows a properties window for the open document (`CmdProperties`,
 * `Ctrl+D`; `LightProperties.cpp`), whose rows are, in its own order:
 * `File:`, `Title:`, `Subject:`, `Author:`, `Copyright:`, `Application:`,
 * `PDF Producer:`, `PDF Version:`, `Keywords:`, `Created:`, `Modified:`,
 * `Encryption:`, `Number of Pages:` and `Current Page (n) Size:`
 * (`propToName`, `LightProperties.cpp:328-377`; `AppendProp` calls at
 * `LightProperties.cpp:493-549`).
 *
 * The window can copy everything to the clipboard (`LightProperties.cpp:870`).
 *
 * This module builds those rows from the data Eukolia's PDF contract actually
 * carries (`PdfOpenResult`: `metadata`, `pages`, `pageCount`), so the dialog
 * never shows a row it cannot fill.
 */

import type { PdfOpenResult } from '../../shared/ipc';

export interface LightPdfPropertyRow {
  label: string;
  value: string;
}

/**
 * `LightProperties.cpp:507-527` — a PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`) is shown
 * as a readable local date/time; light-pdf uses the same shape for the `Created:`
 * and `Modified:` rows. Anything unparseable is passed through unchanged rather
 * than hidden, so a malformed date is visible instead of silently missing.
 */
export function formatPdfDate(value: string): string {
  const trimmed = value.trim();
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(trimmed);
  if (!match) return trimmed;
  const [, year, month, day, hour, minute, second] = match;
  // Only the parts the value actually carries: a date without a day keeps its
  // month precision rather than being padded out with invented numbers.
  const date = [year, month, day].filter(Boolean).join('-');
  if (!hour) return date;
  return `${date} ${[hour, minute ?? '00', second ?? '00'].join(':')}`;
}

/** The text light-pdf's properties window shows, as label/value pairs. */
export function documentPropertyRows(
  info: Pick<PdfOpenResult, 'path' | 'pageCount' | 'pages' | 'metadata'>,
  currentPage: number
): LightPdfPropertyRow[] {
  const rows: LightPdfPropertyRow[] = [];
  const metadata = info.metadata ?? {};
  const push = (label: string, value: string | undefined | null): void => {
    if (value === undefined || value === null || value === '') return;
    rows.push({ label, value });
  };

  // `File:` first, as light-pdf does.
  push('File:', info.path);
  push('Title:', metadata.title);
  push('Subject:', metadata.subject);
  push('Author:', metadata.author);
  // light-pdf labels the PDF's `Creator` entry "Application:".
  push('Application:', metadata.creator);
  push('PDF Producer:', metadata.producer);
  push('PDF Version:', metadata.format);
  push('Keywords:', metadata.keywords);
  push('Created:', metadata.creationDate ? formatPdfDate(metadata.creationDate) : undefined);
  push('Modified:', metadata.modDate ? formatPdfDate(metadata.modDate) : undefined);
  push('Encryption:', metadata.encryption);
  push('Number of Pages:', String(info.pageCount));

  const page = info.pages?.[currentPage - 1];
  if (page) {
    // `LightProperties.cpp:549` — `Current Page (%d) Size:`, in PDF points.
    push(`Current Page (${currentPage}) Size:`, `${round2(page.width)} × ${round2(page.height)} points`);
  }
  return rows;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The rows as clipboard text, matching what the window displays. */
export function documentPropertyText(rows: readonly LightPdfPropertyRow[]): string {
  return rows.map((row) => `${row.label} ${row.value}`).join('\n');
}
