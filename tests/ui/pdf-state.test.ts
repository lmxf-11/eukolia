/**
 * The PDF page readout's invariant.
 *
 * The pane updates its copy of the document in two separate patches:
 * `onDocumentLoaded` reports the page *count*, and `onPageChange` reports the
 * current *page*. A shorter document therefore arrives as a count-only patch,
 * and because a document that opens already laid out need not produce a view
 * change, the stale page can survive it. That is how the toolbar and the status
 * bar came to read `Page 2 / 1` after a failing build replaced a two-page
 * document with a one-page one.
 */
import { describe, expect, it } from 'vitest';

import { patchPdfState, type PdfState } from '../../src/renderer/ui/state';

function pdfState(overrides: Partial<PdfState> = {}): PdfState {
  return {
    path: 'D:/docs/paper.pdf',
    page: 1,
    pageCount: 2,
    zoom: 1,
    zoomMode: 'page-width',
    scrollTop: 0,
    visible: true,
    loading: false,
    error: null,
    searchQuery: '',
    searchMatches: 0,
    outline: [],
    ...overrides
  };
}

describe('patchPdfState', () => {
  it('pulls the page back when a shorter document opens', () => {
    const next = patchPdfState(pdfState({ page: 2, pageCount: 2 }), { pageCount: 1 });
    expect(next.page).toBe(1);
    expect(next.pageCount).toBe(1);
  });

  it('clamps to the new count rather than to the first page', () => {
    const next = patchPdfState(pdfState({ page: 7, pageCount: 9 }), { pageCount: 4 });
    expect(next.page).toBe(4);
  });

  it('leaves a page inside the new document alone', () => {
    const next = patchPdfState(pdfState({ page: 2, pageCount: 2 }), { pageCount: 5 });
    expect(next.page).toBe(2);
  });

  it('does not touch the page while no document is open', () => {
    // A zero count is "nothing loaded yet", not "a document with no pages", so
    // pinning the page to 1 here would fight a remembered view being restored.
    const next = patchPdfState(pdfState({ page: 3 }), { pageCount: 0, loading: true });
    expect(next.page).toBe(3);
    expect(next.loading).toBe(true);
  });

  it('never reports a page below the first', () => {
    const next = patchPdfState(pdfState({ page: 1 }), { page: 0 });
    expect(next.page).toBe(1);
  });

  it('applies a page and a count together, as onPageChange does', () => {
    const next = patchPdfState(pdfState({ page: 1, pageCount: 2 }), { page: 2, pageCount: 3 });
    expect(next.page).toBe(2);
    expect(next.pageCount).toBe(3);
  });

  it('leaves fields the patch does not mention untouched', () => {
    const previous = pdfState({ page: 2, pageCount: 2, searchQuery: 'integral', searchMatches: 4 });
    const next = patchPdfState(previous, { error: 'boom' });
    expect(next.searchQuery).toBe('integral');
    expect(next.searchMatches).toBe(4);
    expect(next.path).toBe(previous.path);
    expect(next.page).toBe(2);
  });

  it('does not mutate the state it was given', () => {
    const previous = pdfState({ page: 2, pageCount: 2 });
    patchPdfState(previous, { pageCount: 1 });
    expect(previous.page).toBe(2);
    expect(previous.pageCount).toBe(2);
  });
});
