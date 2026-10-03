/**
 * The built-in snippet library.
 *
 * `src/renderer/snippets/snippets.json` is the file Eukolia writes on first run
 * and the one the Snippets settings shows, so it is checked here the way any
 * other document of the format would be: against the schema, through the
 * normaliser, and all the way into the engine.
 *
 * It is a *data* file — generated once from LaTeX Workshop by
 * `.scratch/build-default-snippets.mjs` — so the tests below are what keep it
 * honest now that no generator runs in the build.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initialSnippetFile,
  normalizeSnippetFile,
  renderSnippetDocument,
  serializeSnippetFile,
  validateSnippetFile,
  type EusnipsFile
} from '../../src/renderer/snippets/eusnips';
import { SnippetEngine } from '../../src/renderer/snippets/engine';
import { loadEusnipsIntoEngine } from '../../src/renderer/snippets/eusnips';

const LIBRARY_PATH = 'src/renderer/snippets/snippets.json';
const SYMBOLS_PATH = 'src/renderer/snippets/snippetpanel.json';

function readLibrary(): { file: EusnipsFile; text: string } {
  const text = readFileSync(LIBRARY_PATH, 'utf8');
  return { file: JSON.parse(text) as EusnipsFile, text };
}

describe('the built-in snippet library', () => {
  it('is a document the format accepts', () => {
    const { file, text } = readLibrary();
    expect(validateSnippetFile(file, { text }).issues).toEqual([]);
    // Nothing in it is stored-but-ignored: every construct the file uses is one
    // the engine can act on, which is the point of generating it rather than
    // hand-writing it.
    expect(normalizeSnippetFile(file).issues).toEqual([]);
  });

  it('names every entry, uniquely and stably', () => {
    const { file } = readLibrary();
    const ids = file.snippets.map((entry) => entry.id);
    expect(ids.every((id) => typeof id === 'string' && /^[A-Za-z0-9_.-]+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // Derived from what each snippet does, so regenerating the file does not
    // rename anything and a bug report can quote an id.
    expect(ids).toContain('equation');
    expect(ids).toContain('figure');
    expect(ids).toContain('section');
  });

  it('covers the LaTeX Workshop snippets it was imported from', () => {
    const { file } = readLibrary();
    const patterns = file.snippets.map((entry) => entry.trigger.pattern);
    // Environments, fonts, sectioning and the punctuation shortcuts. The
    // punctuation is escaped, because a trigger is a pattern: `**` has to be
    // `\*\*` or it would mean "any two characters".
    for (const pattern of [
      'BEQ',
      'BAL',
      'BIT',
      'BFI',
      'FBF',
      'MBB',
      'SSE',
      'fontsize',
      '__',
      '\\*\\*',
      '\\.\\.\\.'
    ]) {
      expect(patterns, `${pattern} should be in the library`).toContain(pattern);
    }
    expect(file.snippets.length).toBeGreaterThan(45);
  });

  it('converts the selection variable into the engine\'s own spelling', () => {
    const { file } = readLibrary();
    const equation = normalizeSnippetFile(file).snippets.find((entry) => entry.id === 'equation');
    expect(equation).toBeDefined();
    // LaTeX Workshop writes `${0:${TM_SELECTED_TEXT}}`; the format's equivalent
    // is a tab stop whose default is the selection, with `$0` after the body.
    // The trigger is backticked because every trigger is a pattern, and the header
    // says nothing about what the entry *does* — that is a property of the entry.
    expect(renderSnippetDocument(equation!).document).toBe(
      'snippet `BEQ$` "equation environment"\n\\begin{equation}\n\t${1:${VISUAL}}\n\\end{equation}$0\nendsnippet\n'
    );
    // The selection is a real tab stop, so the author lands on the environment's
    // body rather than at the end of an empty one.
    expect(equation!.body).not.toContain('TM_SELECTED_TEXT');
  });

  it('leaves descriptions alone, so a backslash survives the round trip', () => {
    const { file } = readLibrary();
    const item = file.snippets.find((entry) => entry.id === 'item');
    expect(item?.description).toBe('\\item on a newline');
    const normalized = normalizeSnippetFile(file).snippets.find((entry) => entry.id === 'item');
    expect(normalized?.description).toBe('\\item on a newline');
  });

  it('loads into the engine and expands', () => {
    const engine = new SnippetEngine();
    const loaded = loadEusnipsIntoEngine(engine, [normalizeSnippetFile(readLibrary().file)]);
    expect(loaded).toHaveLength(readLibrary().file.snippets.length);

    const document = 'Text here\nBEQ';
    const candidate = engine
      .getCompletions({ text: document, offset: document.length, languageId: 'latex' })
      .find((entry) => entry.snippet.regexp?.source === 'BEQ$');
    expect(candidate).toBeDefined();
    const expansion = engine.expand(candidate!, { text: document, pushToStack: false });
    expect(expansion.plainText).toBe('\\begin{equation}\n\t\n\\end{equation}');
    // `$1` first, then the final cursor — the order Tab walks them in.
    expect(expansion.placeholderIds).toEqual([1, 0]);
  });

  it('seeds a first-run file identical to the library', () => {
    const { file } = readLibrary();
    const seeded = initialSnippetFile();
    expect(seeded.snippets).toEqual(file.snippets);
    // And two seeds do not share structure: editing one cannot reach back into
    // the built-in file for the rest of the session.
    const first = initialSnippetFile();
    first.snippets[0].description = 'changed';
    expect(initialSnippetFile().snippets[0].description).toBe(file.snippets[0].description);
  });

  it('ships the math symbol panel as data', () => {
    const panel = JSON.parse(readFileSync(SYMBOLS_PATH, 'utf8')) as {
      categories: Array<{ name: string; filtered: boolean; symbols: Array<{ name: string; latex: string }> }>;
    };
    const symbols = panel.categories.flatMap((category) => category.symbols);
    expect(symbols.length).toBeGreaterThan(600);
    // Every entry says what to insert; nothing carries a rendered SVG, because
    // Eukolia draws its own previews.
    expect(symbols.every((symbol) => typeof symbol.latex === 'string' && symbol.latex.length > 0)).toBe(true);
    expect(symbols.some((symbol) => symbol.latex === '\\alpha')).toBe(true);
    expect(panel.categories.map((category) => category.name)).toContain('Arrows');
  });

  it('serialises back to the same document', () => {
    // The settings editor writes this file whenever it is saved; a first save
    // must not rewrite the whole library.
    const { file } = readLibrary();
    expect(serializeSnippetFile(file)).toBe(serializeSnippetFile(JSON.parse(serializeSnippetFile(file)) as EusnipsFile));
  });
});
