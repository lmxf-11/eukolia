/**
 * Document model tests.
 *
 * The model is the shared buffer behind Code Mode and Visual Mode, so these
 * cover the invariants the rest of the app relies on: minimal source-preserving
 * deltas, correct undo/redo, stale-version protection for asynchronous work, and
 * dirty tracking against what is on disk.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_SETTLE_MS,
  DocumentModel,
  type DocumentAnalysis,
  type DocumentAnalyzer
} from '../../src/renderer/document/documentModel';

function makeDoc(text = 'hello world'): DocumentModel {
  return new DocumentModel('C:/proj/main.tex', 'main.tex', text);
}

describe('DocumentModel deltas', () => {
  it('applies a single delta without touching the rest of the buffer', () => {
    const doc = makeDoc('\\(F:\\mathcal C\\to\\mathcal D\\)');
    doc.replaceRange(2, 3, 'G');

    expect(doc.getText()).toBe('\\(G:\\mathcal C\\to\\mathcal D\\)');
  });

  it('applies multiple deltas in one batch, honouring original offsets', () => {
    const doc = makeDoc('abcdef');
    doc.applyDeltas([
      { from: 0, to: 1, insert: 'X' },
      { from: 4, to: 5, insert: 'Y' }
    ]);

    expect(doc.getText()).toBe('XbcdYf');
  });

  it('rejects overlapping deltas rather than corrupting the buffer', () => {
    const doc = makeDoc('abcdef');
    expect(() =>
      doc.applyDeltas([
        { from: 0, to: 3, insert: 'X' },
        { from: 2, to: 4, insert: 'Y' }
      ])
    ).toThrow(/overlapping/i);
    expect(doc.getText()).toBe('abcdef');
  });

  it('rejects out-of-range deltas', () => {
    const doc = makeDoc('abc');
    expect(() => doc.applyDeltas([{ from: 0, to: 99, insert: 'x' }])).toThrow(/out of range/i);
    expect(doc.getText()).toBe('abc');
  });

  it('is a no-op when the replacement equals the existing text', () => {
    const doc = makeDoc('abc');
    const listener = vi.fn();
    doc.on('change', listener);
    doc.replaceRange(1, 2, 'b');

    expect(listener).not.toHaveBeenCalled();
    expect(doc.getVersion()).toBe(1);
  });
});

describe('DocumentModel versioning', () => {
  it('increments the version on every real change', () => {
    const doc = makeDoc('a');
    const before = doc.getVersion();
    doc.replaceRange(0, 1, 'b');
    doc.replaceRange(0, 1, 'c');

    expect(doc.getVersion()).toBe(before + 2);
  });

  it('reports the deltas and source on the change event', () => {
    const doc = makeDoc('abc');
    const events: Array<{ source: string; deltas: unknown }> = [];
    doc.on('change', (payload: { source: string; deltas: unknown }) => events.push(payload));

    doc.replaceRange(1, 2, 'ZZ', 'visual');

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('visual');
    expect(events[0].deltas).toEqual([{ from: 1, to: 2, insert: 'ZZ' }]);
  });
});

describe('DocumentModel undo and redo', () => {
  it('restores the previous content', () => {
    const doc = makeDoc('one');
    doc.replaceRange(0, 3, 'two');
    expect(doc.getText()).toBe('two');

    expect(doc.undo()).toBe(true);
    expect(doc.getText()).toBe('one');
  });

  it('redoes what was undone', () => {
    const doc = makeDoc('one');
    doc.replaceRange(0, 3, 'two');
    doc.undo();
    expect(doc.redo()).toBe(true);
    expect(doc.getText()).toBe('two');
  });

  it('reports whether undo and redo are available', () => {
    const doc = makeDoc('one');
    expect(doc.canUndo()).toBe(false);
    doc.replaceRange(0, 3, 'two');
    expect(doc.canUndo()).toBe(true);
    expect(doc.canRedo()).toBe(false);
    doc.undo();
    expect(doc.canRedo()).toBe(true);
  });

  it('clears the redo stack once a new edit happens', () => {
    const doc = makeDoc('one');
    doc.replaceRange(0, 3, 'two');
    doc.undo();
    doc.replaceRange(0, 3, 'three');

    expect(doc.canRedo()).toBe(false);
    expect(doc.getText()).toBe('three');
  });

  it('does not record an undo entry for a disk reload', () => {
    const doc = makeDoc('one');
    doc.reloadFromDisk('two');
    expect(doc.canUndo()).toBe(false);
    expect(doc.getText()).toBe('two');
  });
});

describe('DocumentModel dirty state', () => {
  it('is clean when the content matches disk', () => {
    const doc = makeDoc('abc');
    expect(doc.getDirty()).toBe(false);
  });

  it('becomes dirty on edit and clean again after save', () => {
    const doc = makeDoc('abc');
    doc.replaceRange(0, 1, 'z');
    expect(doc.getDirty()).toBe(true);

    doc.markSaved();
    expect(doc.getDirty()).toBe(false);
  });

  it('marks saved content explicitly, so a later edit is dirty again', () => {
    const doc = makeDoc('abc');
    doc.replaceRange(0, 1, 'z');
    doc.markSaved('zbc');
    expect(doc.getDirty()).toBe(false);

    doc.replaceRange(1, 2, 'q');
    expect(doc.getDirty()).toBe(true);
  });

  it('emits dirty-change only when the flag actually flips', () => {
    const doc = makeDoc('abc');
    const listener = vi.fn();
    doc.on('dirty-change', listener);

    doc.replaceRange(0, 1, 'z');
    doc.replaceRange(0, 1, 'y');
    expect(listener).toHaveBeenCalledTimes(1);

    doc.markSaved();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('treats a reload from disk as clean', () => {
    const doc = makeDoc('abc');
    doc.replaceRange(0, 1, 'z');
    doc.reloadFromDisk('from-disk');

    expect(doc.getText()).toBe('from-disk');
    expect(doc.getDirty()).toBe(false);
  });
});

describe('DocumentModel analysis', () => {
  it('starts with an empty analysis when no analyzer is installed', () => {
    const doc = makeDoc('\\section{A}');
    expect(doc.getOutline()).toEqual([]);
    expect(doc.getAnalyzerId()).toBeNull();
  });

  it('re-analyzes every change, after the change rather than inside it', () => {
    vi.useFakeTimers();
    try {
      const analyze = vi.fn((text: string): DocumentAnalysis => ({
        outline: text.includes('\\section') ? [{ level: 2, title: 'A', offset: 0, line: 1, labels: [], children: [], command: 'section', starred: false }] : [],
        labels: [],
        citations: [],
        macroDefinitions: [],
        environments: [],
        includedFiles: [],
        sectioning: []
      }));
      const analyzer: DocumentAnalyzer = { id: 'test-analyzer', analyze };

      const doc = makeDoc('plain');
      doc.setAnalyzer(analyzer);
      expect(doc.getAnalyzerId()).toBe('test-analyzer');
      // Registering an analyzer is not a keystroke, so the first pass is
      // synchronous: a document is never registered with an empty analysis.
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(doc.getOutline()).toEqual([]);

      doc.replaceRange(0, 5, '\\section{A}');
      // The change itself must not parse. The analyzer is a whole-document
      // unified-latex parse (tens of milliseconds); running it inside the edit
      // blocked the keystroke that made the edit — and everything the keystroke
      // scheduled behind it, a snippet expansion in particular.
      expect(analyze).toHaveBeenCalledTimes(1);

      // The pass lands on its own, one settle window later.
      vi.advanceTimersByTime(ANALYSIS_SETTLE_MS);
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(analyze.mock.calls[1][0]).toBe('\\section{A}');
      expect(doc.getOutline()).toHaveLength(1);
      expect(doc.getOutline()[0].title).toBe('A');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst into one pass over the latest text', () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const analyzer: DocumentAnalyzer = {
        id: 'recording',
        analyze: (text: string): DocumentAnalysis => {
          seen.push(text);
          return { outline: [], labels: [], citations: [], macroDefinitions: [], environments: [], includedFiles: [], sectioning: [] };
        }
      };
      const doc = makeDoc('abc');
      doc.setAnalyzer(analyzer);
      seen.length = 0;

      doc.replaceRange(3, 3, 'd');
      vi.advanceTimersByTime(ANALYSIS_SETTLE_MS / 2);
      doc.replaceRange(4, 4, 'e');
      vi.advanceTimersByTime(ANALYSIS_SETTLE_MS / 2);
      doc.replaceRange(5, 5, 'f');
      // Nothing has been parsed yet: each change re-armed the one pass.
      expect(seen).toEqual([]);

      vi.advanceTimersByTime(ANALYSIS_SETTLE_MS);
      // One pass, over the text as it is now — never over a stale snapshot.
      expect(seen).toEqual(['abcdef']);
      expect(doc.isAnalysisStale()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces the analysis when the deferred pass lands', () => {
    vi.useFakeTimers();
    try {
      const analyzer: DocumentAnalyzer = {
        id: 'announcing',
        analyze: (text: string): DocumentAnalysis => ({
          outline: text.includes('\\section') ? [{ level: 2, title: 'A', offset: 0, line: 1, labels: [], children: [], command: 'section', starred: false }] : [],
          labels: [],
          citations: [],
          macroDefinitions: [],
          environments: [],
          includedFiles: [],
          sectioning: []
        })
      };
      const doc = makeDoc('plain');
      doc.setAnalyzer(analyzer);

      const announcements: number[] = [];
      doc.on('analysis-change', (analysis: DocumentAnalysis) => announcements.push(analysis.outline.length));

      doc.replaceRange(0, 5, '\\section{A}');
      expect(announcements).toEqual([]);
      vi.advanceTimersByTime(ANALYSIS_SETTLE_MS);
      expect(announcements).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not parse when a reader asks for the analysis', () => {
    const analyze = vi.fn((): DocumentAnalysis => ({ outline: [], labels: [], citations: [], macroDefinitions: [], environments: [], includedFiles: [], sectioning: [] }));
    const doc = makeDoc('plain');
    doc.setAnalyzer({ id: 'counting', analyze });
    expect(analyze).toHaveBeenCalledTimes(1);

    doc.replaceRange(0, 5, 'other');
    // Reading is not a reason to parse: the shell re-reads the outline from its
    // `change` listener, which runs inside the edit, so a forcing read would put
    // the parse back on the keystroke path.
    doc.getOutline();
    doc.getAnalysis();
    expect(analyze).toHaveBeenCalledTimes(1);

    // `flushAnalysis` is the explicit escape hatch for a caller that cannot wait.
    doc.flushAnalysis();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(doc.isAnalysisStale()).toBe(false);
  });

  it('drops an armed pass when the buffer is disposed', () => {
    vi.useFakeTimers();
    try {
      const analyze = vi.fn((): DocumentAnalysis => ({ outline: [], labels: [], citations: [], macroDefinitions: [], environments: [], includedFiles: [], sectioning: [] }));
      const doc = makeDoc('plain');
      doc.setAnalyzer({ id: 'counting', analyze });
      doc.replaceRange(0, 5, 'other');
      doc.dispose();

      vi.advanceTimersByTime(ANALYSIS_SETTLE_MS * 10);
      // A closed buffer is not parsed again.
      expect(analyze).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives an analyzer that throws, keeping the buffer usable', () => {
    const analyzer: DocumentAnalyzer = {
      id: 'broken',
      analyze() {
        throw new Error('analyzer exploded');
      }
    };
    const doc = makeDoc('abc');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => doc.setAnalyzer(analyzer)).not.toThrow();
    expect(doc.getOutline()).toEqual([]);
    expect(doc.getText()).toBe('abc');

    spy.mockRestore();
  });
});

describe('DocumentModel line ending normalization', () => {
  it('normalizes CRLF to LF in initial content without marking dirty', () => {
    const doc = new DocumentModel('C:/proj/crlf.tex', 'crlf.tex', 'line1\r\nline2\r\nline3');
    expect(doc.getText()).toBe('line1\nline2\nline3');
    expect(doc.getDirty()).toBe(false);
  });

  it('normalizes CRLF to LF in reloadFromDisk without marking dirty', () => {
    const doc = makeDoc('line1\nline2');
    doc.reloadFromDisk('line1\r\nline2\r\nline3');
    expect(doc.getText()).toBe('line1\nline2\nline3');
    expect(doc.getDirty()).toBe(false);
  });

  it('normalizes CRLF to LF in setText and applyDeltas', () => {
    const doc = makeDoc('line1\n');
    doc.applyDeltas([{ from: 6, to: 6, insert: 'line2\r\n' }]);
    expect(doc.getText()).toBe('line1\nline2\n');

    doc.setText('a\r\nb');
    expect(doc.getText()).toBe('a\nb');
  });
});

