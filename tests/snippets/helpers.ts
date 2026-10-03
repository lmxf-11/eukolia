/**
 * Test helpers for the Eukolia snippet facade.
 */

import { Position, Range } from 'vscode';
import {
  SnippetEditorAdapter,
  type SnippetEditorPort
} from '../../src/renderer/snippets/editorAdapter';
import type { DocumentLike } from '../../src/renderer/snippets/documentAdapter';
import { SnippetEngine } from '../../src/renderer/snippets/engine';
import { TestEditor, positionOf } from '../hypersnips/helpers';

export { TestEditor, positionOf };

/**
 * A `DocumentLike` that reads through to the editor on every access, so an
 * expansion constructed against it observes text typed after construction —
 * exactly what a real editor model does.
 */
export function createLiveDocument(editor: SnippetEditorPort): DocumentLike {
  const offsetAt = (position: Position): number => {
    const text = editor.getText();
    const lines = text.split('\n');
    const line = Math.max(0, Math.min(position.line, lines.length - 1));
    let offset = 0;
    for (let i = 0; i < line; i++) offset += lines[i].length + 1;
    return offset + position.character;
  };

  return {
    languageId: editor.languageId,
    uri: editor.uri,
    getText: (range?: Range) => {
      const text = editor.getText();
      if (!range) return text;
      return text.slice(offsetAt(range.start), offsetAt(range.end));
    },
    offsetAt,
    positionAt: (offset: number) => positionOf(editor.getText(), offset),
    lineAt: (line: number | Position) => {
      const lineNumber = typeof line === 'number' ? line : line.line;
      const content = editor.getText().split('\n')[lineNumber] ?? '';
      return {
        text: content,
        firstNonWhitespaceCharacterIndex: content.length - content.replace(/^\s+/, '').length
      };
    }
  };
}

/** A fresh engine + adapter pair, so tests never share snippet/stack state. */
export function createHarness(sources: Array<{ name: string; content: string; language: string }> = []) {
  const engine = new SnippetEngine();
  if (sources.length) engine.loadSnippetSources(sources);
  const warnings: string[] = [];
  const adapter = new SnippetEditorAdapter({
    engine,
    onWarning: (message) => warnings.push(message)
  });
  return { engine, adapter, warnings };
}
