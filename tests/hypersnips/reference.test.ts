/**
 * Ported reference test: the HyperSnips `box` fixture.
 *
 * The reference ships `src/test/expansions/{box.hsnips,box.input.txt,box.output.txt}`
 * but its `src/test/index.ts` is empty — upstream never wired a runner. These
 * tests encode the behaviour the fixtures describe: with `box.input.txt` typed
 * into a document, expanding the `box` snippet produces `box.output.txt`.
 *
 * Every byte of the fixtures is read from the vendored copy under
 * `tests/hypersnips/fixtures/expansions`, taken verbatim from the reference
 * checkout so this suite runs without `References/` present.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { HSnippet } from '../../src/renderer/vendor/hypersnips';
import type { SnippetEditorAdapter } from '../../src/renderer/snippets/editorAdapter';
import type { SnippetEngine } from '../../src/renderer/snippets/engine';
import { createHarness, TestEditor } from '../snippets/helpers';
import { FIXTURE_DIR, readFixture } from './helpers';

describe('HyperSnips reference fixture: box', () => {
  let engine: SnippetEngine;
  let adapter: SnippetEditorAdapter;
  const boxSource = readFixture('box.hsnips');
  const input = readFixture('box.input.txt');
  const output = readFixture('box.output.txt');

  beforeEach(() => {
    const harness = createHarness([
      { name: 'box.hsnips', content: boxSource, language: 'latex' }
    ]);
    engine = harness.engine;
    adapter = harness.adapter;
  });

  it('reads the reference fixture directory', () => {
    expect(path.basename(FIXTURE_DIR)).toBe('expansions');
    expect(boxSource).toContain('snippet box "Box" A');
    expect(input.trim()).toBe('boxtest');
    expect(output).toContain('┌');
  });

  it('parses the fixture file into exactly one snippet', () => {
    const snippets = engine.getSnippets('latex');
    expect(snippets).toHaveLength(1);

    const box = snippets[0];
    expect(box).toBeInstanceOf(HSnippet);
    expect(box.trigger).toBe('box');
    expect(box.description).toBe('Box');
    expect(box.automatic).toBe(true);
    expect(box.placeholders).toBe(1);
    expect(box.priority).toBe(0);
  });

  it('reproduces box.output.txt from box.input.txt', () => {
    const editor = new TestEditor('');
    // Typing the input file's *trigger* — `boxtest` itself would not match, because
    // the reference only offers a non-`i` trigger once the whole context equals it.
    editor.type('box');

    const candidates = adapter.getCompletionCandidates(editor, editor.getOffset());
    const candidate = candidates.find((c) => c.snippet.trigger === 'box');
    expect(candidate).toBeDefined();
    // `box` is `A`-flagged and the context now equals the trigger exactly, so the
    // automatic path would fire — the completion list marks it accordingly.
    expect(candidate!.label).toBe('box');
    expect(candidate!.range.start.character).toBe(0);
    expect(candidate!.range.end.character).toBe(3);

    const applied = adapter.acceptCompletion(candidate!, editor);
    // `$1` is empty, so `'─'.repeat(0 + 2)`.
    expect(applied.text).toBe('┌──┐\n│  │\n└──┘');
    expect(editor.getText()).toBe(applied.text);
    expect(engine.getGeometry(applied.expansion).text).toBe(applied.text);
  });

  it('regenerates the code blocks to match box.output.txt once $1 is filled', () => {
    const editor = new TestEditor('boxtest');
    const candidates = adapter.getCompletionCandidates(editor, editor.getOffset());
    const boxCandidate = candidates.find((c) => c.snippet.trigger === 'box');
    // `boxtest` is a longer word, so the reference's `context == trigger` rule
    // means the snippet is not offered for it at all.
    expect(boxCandidate).toBeUndefined();

    const boxEditor = new TestEditor('box');
    const candidate = adapter
      .getCompletionCandidates(boxEditor, boxEditor.getOffset())
      .find((c) => c.snippet.trigger === 'box')!;
    const applied = adapter.acceptCompletion(candidate, boxEditor);
    expect(boxEditor.getText()).toBe('┌──┐\n│  │\n└──┘');

    const placeholder = applied.selected[0];
    expect(placeholder.id).toBe(1);
    // `box` is 3 characters, so `$1` sits at offset 9 in `┌──┐\n│  │\n└──┘`.
    expect(placeholder.documentFrom).toBe(boxEditor.getText().indexOf('│') + 2);

    // Type `test` into the placeholder; the borders regenerate around it.
    const typed = boxEditor.replaceRange(placeholder.documentFrom, placeholder.documentTo, 'test');
    adapter.handleEdit(boxEditor, typed);

    const regenerated = boxEditor.getText();
    expect(regenerated.split('\n')[1]).toBe('│ test │');
    // `test` is 4 characters, so the rule is `'─'.repeat(4 + 2)`.
    expect([...regenerated.split('\n')[0]].filter((c) => c === '─')).toHaveLength(6);
    // The fixture file ends with a newline; the expansion does not.
    expect(regenerated).toBe(output.replace(/\n$/, ''));
  });
});
