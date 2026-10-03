/**
 * What an edit does to an expansion's tabs stops.
 *
 * Two rules the ported parts model did not have, and that the shipped library
 * depends on:
 *
 *  * a repeated index (`\begin{$1} … \end{$1}`) is *one* tab stop written twice,
 *    so the model holds the same text in both places — `wrapenv`, `figure` and the
 *    table-caption entries are all written that way;
 *  * an edit that lands outside the expansion is not applied to it. Typing at the
 *    top of the file must not move a tab stop in a snippet further down, which is
 *    what a clamped `delta` used to do.
 *
 * What these tests deliberately do *not* claim is that the buffer is rewritten to
 * match a mirror: the engine maintains the model and the host applies edits, and
 * the CodeMirror host applies the keystroke only where it was typed. Wiring that
 * through is a separate piece of work (recorded in the report).
 */

import { describe, expect, it } from 'vitest';
import { Position, Range } from '../../src/renderer/vendor/vscode-shim/position';
import { getSnippetEngine } from '../../src/renderer/snippets/engine';
import { createHarness, TestEditor } from './helpers';
import { BACKSLASH } from '../hypersnips/helpers';

/** One insertion, in the shape `SnippetExpansion.update` expects. */
function insertion(offset: number, text: string) {
  const position = new Position(0, offset);
  return {
    range: new Range(position, position),
    rangeOffset: offset,
    rangeLength: 0,
    text
  };
}

function replacement(from: number, to: number, text: string) {
  return {
    range: new Range(new Position(0, from), new Position(0, to)),
    rangeOffset: from,
    rangeLength: to - from,
    text
  };
}

/** The text each part holds, which is the model the tab stops are placed from. */
function contents(expansion: { parts: Array<{ id?: number; content: string }> }): Record<string, string[]> {
  const byId: Record<string, string[]> = {};
  for (const part of expansion.parts) {
    if (part.id === undefined) continue;
    (byId[String(part.id)] ??= []).push(part.content);
  }
  return byId;
}

describe('mirrored tab stops', () => {
  const source = [
    'snippet env "environment" A',
    `${BACKSLASH}begin{$1}`,
    '\t${2:body}',
    `${BACKSLASH}end{$1}$0`,
    'endsnippet',
    ''
  ].join('\n');

  it('holds what the author types in every copy of a repeated index', () => {
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const editor = new TestEditor('');
    editor.type('en');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('v'));

    expect(applied).not.toBeNull();
    expect(applied!.text).toBe(`${BACKSLASH}begin{}\n\tbody\n${BACKSLASH}end{}`);
    expect(contents(applied!.expansion)['1']).toEqual(['', '']);

    // Type the environment name into the first stop, the way the editor does: the
    // stop is selected, so the keystroke replaces it.
    const expansion = applied!.expansion;
    const geometry = engine.getGeometry(expansion);
    const first = geometry.placeholders.find((placeholder) => placeholder.id === 1)!;
    editor.replace(first.documentFrom, first.documentTo, 'figure', first.documentFrom + 'figure'.length);
    engine.applyExpansionEdit(expansion, [insertion(first.documentFrom, 'figure')], editor.getText());

    // Both occurrences hold it: only the first used to, which is what made the
    // shipped environment wrappers write `\begin{figure} … \end{}`.
    expect(contents(expansion)['1']).toEqual(['figure', 'figure']);
    // And both are still tab stops, at the same place in the expansion's text.
    const after = engine.getGeometry(expansion);
    expect(after.placeholders.filter((placeholder) => placeholder.id === 1)).toHaveLength(2);
  });
});

describe('edits outside the expansion', () => {
  const source = 'snippet zz "z" A\nA ${1:one} B $0\nendsnippet\n';
  /** Text before the trigger, so the expansion does not start at offset 0. */
  const PREFIX = 'head ';

  it('leaves the tab stops alone when the author types somewhere else', () => {
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const editor = new TestEditor(PREFIX);
    editor.type('z');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('z'));
    expect(applied).not.toBeNull();

    const expansion = applied!.expansion;
    const before = engine.getGeometry(expansion);
    expect(contents(expansion)['1']).toEqual(['one']);

    // An edit at the very start of the document, far before the expansion.
    engine.applyExpansionEdit(expansion, [insertion(0, 'Q')], `Q${editor.getText()}`);

    // The tab stop still holds its own default: an edit elsewhere is not this
    // snippet's business, and clamping it into range used to hand the character
    // to the first tab stop.
    expect(contents(expansion)['1']).toEqual(['one']);
    const after = engine.getGeometry(expansion);
    // The expansion itself is the same length it was: an edit outside it neither
    // grows nor shrinks it.
    expect(after.to - after.from).toBe(before.to - before.from);
  });

  it('still adopts an edit inside the expansion', () => {
    const { engine, adapter } = createHarness([{ name: 'latex.hsnips', content: source, language: 'latex' }]);
    const editor = new TestEditor(PREFIX);
    editor.type('z');
    const applied = adapter.handleDocumentChange(editor, editor.typeChar('z'));
    const expansion = applied!.expansion;
    const geometry = engine.getGeometry(expansion);
    const first = geometry.placeholders.find((placeholder) => placeholder.id === 1)!;

    editor.replace(first.documentFrom, first.documentTo, 'two', first.documentFrom + 3);
    engine.applyExpansionEdit(expansion, [replacement(first.documentFrom, first.documentTo, 'two')], editor.getText());

    // The parts carry what was typed, and the expansion knows the stop is now a
    // different width from the default it started with.
    expect(contents(expansion)['1']).toEqual(['two']);
    const after = engine.getGeometry(expansion);
    const stop = after.placeholders.find((placeholder) => placeholder.id === 1)!;
    expect(stop.to - stop.from).toBe(3);
    const final = after.placeholders.find((placeholder) => placeholder.id === 0)!;
    expect(final.to).toBeGreaterThan(stop.to);
  });
});
