// @vitest-environment jsdom
/**
 * Timing properties of automatic expansion.
 *
 * The user-visible requirement is that an `A`-flag snippet appears *immediately*
 * after the keystroke that completes its trigger — the expansion, in the right
 * place, in the same frame. These tests pin the three properties that decide it,
 * none of which needs a real window:
 *
 *  1. the expansion is dispatched from the keystroke's own microtask checkpoint,
 *     before any timer or animation frame can run (`snippets.ts`);
 *  2. the snippet corpus is parsed once, when the sources are loaded, and never
 *     again per keystroke;
 *  3. one keystroke scans the corpus once — a keystroke that fires a snippet
 *     used to scan it twice, the second scan being pure waste.
 *
 * The `$lpha` corruption the deferral exists for is covered by
 * `tests/visual/snippets.test.ts`, which types into a real editor with the whole
 * extension set mounted; the transaction assertions here are the other half of
 * that story — there is exactly one transaction per keystroke, so no delta can
 * reach the host out of order.
 */

import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';

import { LaTeXLanguage } from '@/vendor/overleaf/languages/latex/latex-language';
import { snippetExtensions } from '@/visual/snippets';
import { getSnippetEngine } from '@/snippets/engine';
import { defaultSnippetSources } from '@/snippets/defaultSnippets';
import { createHarness, TestEditor } from './helpers';

const counters = vi.hoisted(() => ({ parses: 0, scans: 0 }));

vi.mock('../../src/renderer/vendor/hypersnips/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/vendor/hypersnips/parser')>();
  return {
    ...actual,
    parse: (...args: Parameters<typeof actual.parse>) => {
      counters.parses += 1;
      return actual.parse(...args);
    }
  };
});

vi.mock('../../src/renderer/vendor/hypersnips/completion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/vendor/hypersnips/completion')>();
  return {
    ...actual,
    getCompletions: (...args: Parameters<typeof actual.getCompletions>) => {
      counters.scans += 1;
      return actual.getCompletions(...args);
    }
  };
});

/** Loads the built-in library once per process, like the application does. */
const loadSnippets = (): void => {
  const engine = getSnippetEngine();
  if (engine.loadedSourceNames.length === 0) engine.loadSnippetSources(defaultSnippetSources());
};

interface Recorded {
  docChanged: boolean;
  selectionSet: boolean;
  complete: boolean;
  text: string;
}

const createView = (doc: string, anchor: number): { view: EditorView; updates: Recorded[] } => {
  loadSnippets();

  const parent = document.createElement('div');
  document.body.append(parent);
  const updates: Recorded[] = [];

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        LaTeXLanguage,
        snippetExtensions(),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (!update.docChanged && !update.selectionSet) return;
          updates.push({
            docChanged: update.docChanged,
            selectionSet: update.selectionSet,
            complete: update.transactions.some((transaction) => transaction.isUserEvent('input.complete')),
            text: update.state.doc.toString()
          });
        })
      ]
    })
  });
  return { view, updates };
};

/** Types one character as a keyboard does: its own task, its own transaction. */
const type = (view: EditorView, character: string): void => {
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: head, insert: character },
    selection: { anchor: head + 1 },
    userEvent: 'input.type'
  });
};

describe('automatic expansion timing', () => {
  it('expands inside the keystroke\'s microtask checkpoint, before any timer or frame', async () => {
    const doc = 'Text $x$ here\n';
    const { view, updates } = createView(doc, doc.indexOf('$x$') + 2);

    // Armed *before* the keystroke, so a `setTimeout`/`requestAnimationFrame`
    // deferral would have to win this race — and could not: microtasks always run
    // before the next task.
    let timerRan = false;
    const timer = setTimeout(() => {
      timerRan = true;
    }, 0);
    let frameRan = false;
    const frame = window.requestAnimationFrame(() => {
      frameRan = true;
    });

    try {
      type(view, '@');
      await Promise.resolve();
      expect(view.state.doc.toString()).toBe('Text $x@$ here\n');

      type(view, 'a');
      // Still in the keystroke's own task: nothing has expanded yet.
      expect(view.state.doc.toString()).toBe('Text $x@a$ here\n');

      // One microtask checkpoint — the deferral `snippets.ts` documents — and the
      // expansion is already in the document, with no timer and no frame having
      // run in between.
      await Promise.resolve();
      expect(view.state.doc.toString()).toBe('Text $x\\alpha$ here\n');
      expect(timerRan).toBe(false);
      expect(frameRan).toBe(false);
    } finally {
      clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      view.destroy();
      void updates;
    }
  });

  it('sends one transaction per keystroke — the expansion carries its own tab stop', async () => {
    const doc = 'Text $x$ here\n';
    const { view, updates } = createView(doc, doc.indexOf('$x$') + 2);

    type(view, '@');
    await Promise.resolve();
    type(view, 'a');
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe('Text $x\\alpha$ here\n');

    // Two keystrokes and the expansion: the expansion replaces the trigger, so
    // it is necessarily its own transaction. What it must not be is *two*: the
    // selection used to be dispatched separately, which cost a second editor
    // update, a second selection report and a second render per expansion.
    const changed = updates.filter((update) => update.docChanged);
    expect(changed.map((update) => update.complete)).toEqual([false, false, true]);
    // The tab stop travels with the text it belongs to.
    expect(changed[2].selectionSet).toBe(true);
    expect(changed[2].text).toBe('Text $x\\alpha$ here\n');
    // Nothing dispatched a selection on its own.
    expect(updates.filter((update) => !update.docChanged && update.selectionSet)).toEqual([]);

    view.destroy();
  });
});

describe('automatic expansion work per keystroke', () => {
  it('parses the snippet sources once, and never per keystroke', () => {
    const before = counters.parses;
    const { adapter } = createHarness(defaultSnippetSources());
    const parsedAtLoad = counters.parses - before;
    expect(parsedAtLoad).toBeGreaterThan(0);

    const editor = new TestEditor('$');
    const after = counters.parses;
    // The `f` that completes `ff` fires the snippet; the characters after it do
    // not. Neither kind of keystroke may re-read a `.hsnips` source: parsing is
    // what `loadSnippetSources` does, once.
    expect(adapter.handleDocumentChange(editor, editor.typeChar('f'))).toBeNull();
    expect(adapter.handleDocumentChange(editor, editor.typeChar('f'))).not.toBeNull();
    for (const character of 'x y') adapter.handleDocumentChange(editor, editor.typeChar(character));
    expect(counters.parses - after).toBe(0);
  });

  it('scans the corpus once per keystroke, whether or not it fires', () => {
    const { adapter } = createHarness(defaultSnippetSources());

    const editor = new TestEditor('$');
    counters.scans = 0;

    // A keystroke that matches nothing, and then the one that fires `ff`. The
    // firing keystroke used to scan twice: the first scan's matches were thrown
    // away and the whole corpus scanned again for the flag filter.
    expect(adapter.handleDocumentChange(editor, editor.typeChar('f'))).toBeNull();
    expect(counters.scans).toBe(1);

    counters.scans = 0;
    expect(adapter.handleDocumentChange(editor, editor.typeChar('f'))).not.toBeNull();
    expect(counters.scans).toBe(1);
  });
});
