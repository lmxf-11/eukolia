/**
 * Migration and seeding tests.
 *
 * These cover the two moments where a snippet library can be *lost*: creating the
 * managed file for the first time, and moving a user's hand-written `.hsnips`
 * files into it. Both are pinned here because both are hard to notice going
 * wrong until it is too late.
 */

import { describe, expect, it } from 'vitest';
import {
  EUSNIPS_VERSION,
  anchorPattern,
  builtInSnippets,
  changedImports,
  hashContent,
  hsnipsBodySource,
  importReceipts,
  initialSnippetFile,
  loadEusnipsIntoEngine,
  migrateInto,
  normalizeSnippetFile,
  parseSnippetBodies,
  pendingImports,
  priorityHints,
  removeImported,
  renderSnippetDocument,
  serializeSnippetFile,
  validateSnippetFile,
  type EusnipsFile
} from '../../src/renderer/snippets/eusnips';
import { SnippetEngine } from '../../src/renderer/snippets/engine';
import { defaultSnippetsSource } from '../../src/renderer/snippets/defaultSnippets';
import { parse } from '../../src/renderer/vendor/hypersnips';
import { getSnippetBody } from '../../src/renderer/vendor/hypersnips/hsnippet';
import { BACKSLASH, DOUBLE_BACKSLASH } from '../hypersnips/helpers';

/** A hand-written `.hsnips` file using every construct the parser understands. */
const HAND_WRITTEN = [
  'global',
  'function helper(x) { return x; }',
  'endglobal',
  '',
  'snippet ff "fraction" Aim',
  `${BACKSLASH}frac{$1}{$2}$0`,
  'endsnippet',
  '',
  'priority 100',
  // A real backtick, spliced in rather than typed: a template literal cannot hold
  // one, which is the whole reason the library's own document writes `\x60`.
  `snippet ${'`'}(${BACKSLASH}${BACKSLASH}?[a-zA-Z]${BACKSLASH}w*)cal${'`'} "mathcal" iAm`,
  `${BACKSLASH}mathcal{$1}$0`,
  'endsnippet',
  '',
  'snippet box "Box" A',
  // Single quotes outside the code block, deliberately: the ported header parser
  // matches `"([^"]+)"` for the description before it looks for flags, so a
  // double quote in the *body* would be read as the description.
  '\\x60\\x60rv = \\x27top\\x27\\x60\\x60',
  'body $1',
  '\\x60\\x60rv = \\x27bottom\\x27\\x60\\x60',
  'endsnippet',
  '',
  'snippet dm "display math" hA',
  `${BACKSLASH}[`,
  '\t$1',
  `${BACKSLASH}] $0`,
  'endsnippet',
  '',
  'snippet time "timestamp" bA',
  '\\x60\\x60rv = new Date().toISOString()\\x60\\x60',
  'endsnippet',
  ''
].join('\n');

function freshFile(): EusnipsFile {
  return { version: EUSNIPS_VERSION, language: 'latex', snippets: [] };
}

describe('first-run seeding', () => {
  it('seeds the library the application ships', () => {
    const file = initialSnippetFile();
    // A library, not an empty file: the first thing a new user sees is something
    // they can use.
    expect(file.snippets.length).toBeGreaterThan(40);
    expect(file.language).toBe('latex');
    expect(file.name).toBeTruthy();

    // Every entry is named, and the names are unique: an entry the editor cannot
    // name is an entry it cannot report a problem against, and a duplicate name is
    // a file the format refuses.
    const ids = file.snippets.map((entry) => entry.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // Stable and readable rather than random, because this file is the built-in
    // one: `beq` is the id of the `BEQ` snippet, and it stays that id.
    expect(ids).toContain('equation');
    expect(ids).toContain('superscript');
  });

  it('writes a file the format accepts', () => {
    const file = initialSnippetFile();
    const text = serializeSnippetFile(file);
    expect(validateSnippetFile(JSON.parse(text) as unknown, { text }).issues).toEqual([]);
    // Reading it back gives the same document, so a seeded file settles instead of
    // being rewritten every time it is opened.
    expect(serializeSnippetFile(JSON.parse(text) as EusnipsFile)).toBe(text);
  });

  it('carries the triggers, descriptions and bodies the import produced', () => {
    const file = initialSnippetFile();
    // `BEQ` is LaTeX Workshop's equation environment: a multi-line body whose
    // middle is a tab stop that falls back to the selection. Its trigger is a
    // pattern, and `BEQ` as a pattern matches the characters `BEQ`.
    const equation = file.snippets.find((entry) => entry.id === 'equation');
    expect(equation).toMatchObject({
      trigger: { pattern: 'BEQ' },
      description: 'equation environment',
      expand: 'auto'
    });
    expect(renderSnippetDocument(normalizeSnippetFile(file).snippets[
      file.snippets.findIndex((entry) => entry.id === 'equation')
    ]).document).toContain('\\begin{equation}');

    // The punctuation triggers keep their names: `__` is a subscript, and the id
    // says so rather than being a hash of the punctuation.
    expect(file.snippets.find((entry) => entry.trigger.pattern === '__')?.id).toBe('subscript');
    expect(file.snippets.find((entry) => entry.trigger.pattern === '\\*\\*')?.id).toBe('superscript');
  });

  it('gives a library in another language no entries and its own name to work from', () => {
    // The built-in library is a LaTeX library. Seeding a file that claims to be
    // another language with it would put a hundred snippets in a file whose
    // language says they do not apply.
    const file = initialSnippetFile('bibtex');
    expect(file.language).toBe('bibtex');
    expect(file.snippets).toEqual([]);
  });
});

describe('.hsnips migration', () => {
  const sources = [{ name: 'latex.hsnips', content: HAND_WRITTEN }];

  it('imports every snippet and keeps the bodies verbatim', () => {
    const result = migrateInto(freshFile(), sources);
    expect(result.imported).toEqual([
      { file: 'latex.hsnips', hash: hashContent(HAND_WRITTEN), count: 5, at: expect.any(String) }
    ]);
    expect(result.file.snippets).toHaveLength(5);
    expect(result.file.snippets[0].body).toBe(`${BACKSLASH}frac{$1}{$2}$0`);
    // The body comes back character for character, escapes and all: the importer
    // reads the lines the parser read, which is what makes an import lossless.
    expect(result.file.snippets[2].body).toBe(
      '\\x60\\x60rv = \\x27top\\x27\\x60\\x60\nbody $1\n\\x60\\x60rv = \\x27bottom\\x27\\x60\\x60'
    );
    expect(result.skipped).toEqual([]);
  });

  it('re-imports a body that compiles to the same expansion', () => {
    // The round trip that matters: what the importer writes must parse back into
    // a snippet that expands identically, code blocks included. The vendored
    // `getSnippetBody` fails this for an inline code block, which is why the
    // importer reads the lines itself.
    const inline = [
      'snippet greet "greeting" A',
      'Hello from ``rv = \'a\' + \'b\'`` today',
      'endsnippet',
      ''
    ].join('\n');
    const { file } = migrateInto(freshFile(), [{ name: 'latex.hsnips', content: inline }]);
    expect(file.snippets[0].body).toBe("Hello from \\x60\\x60rv = 'a' + 'b'\\x60\\x60 today");

    const normalized = normalizeSnippetFile(file);
    const rendered = renderSnippetDocument(normalized.snippets[0]);
    expect(rendered.problem).toBeUndefined();
    const reparsed = parse(rendered.document, 'again.hsnips');
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].description).toBe('greeting');
    // What fires by itself is the entry's `expand`, applied to the compiled snippet
    // when the library loads; the header no longer says it.
    expect(normalized.snippets[0].expand).toBe('auto');
    const engine = new SnippetEngine();
    loadEusnipsIntoEngine(engine, [normalized]);
    expect(engine.getSnippets('latex')[0].automatic).toBe(true);
  });

  it('reads the flags, the description and the pattern across', () => {
    const { file } = migrateInto(freshFile(), sources);
    expect(file.snippets[0]).toMatchObject({ description: 'fraction', expand: 'auto', boundary: 'anywhere', context: 'math' });
    expect(file.snippets[1].trigger).toEqual({
      pattern: `(${BACKSLASH}${BACKSLASH}?[a-zA-Z]${BACKSLASH}w*)cal$`,
      flags: 'm'
    });
    expect(file.snippets[1].priority).toBe(100);
    // `hA` on `dm`: hidden, automatic, and no boundary beyond the default.
    expect(file.snippets[3]).toMatchObject({ hidden: true, expand: 'auto' });
    expect(file.snippets[3].boundary).toBeUndefined();
    // `bA` on `time`: beginning of line.
    expect(file.snippets[4]).toMatchObject({ expand: 'auto', boundary: 'line-start' });
  });

  it('records where each snippet came from', () => {
    const { file } = migrateInto(freshFile(), sources);
    expect(file.snippets[0].metadata).toEqual({ importedFrom: 'latex.hsnips', importedLanguage: 'latex' });
    expect(importReceipts(file)).toHaveLength(1);
  });

  it('is idempotent: a second run adds nothing', () => {
    const once = migrateInto(freshFile(), sources).file;
    const twice = migrateInto(once, sources);
    expect(twice.imported).toEqual([]);
    expect(twice.skipped).toEqual(['latex.hsnips']);
    expect(twice.file).toBe(once);
    expect(twice.file.snippets).toHaveLength(5);
  });

  it('is idempotent even when the receipts are the only thing carried over', () => {
    // What `restoreBuiltIns` does: the built-in set replaces the entries, but the
    // receipts stay, so the next start does not re-import.
    const once = migrateInto(freshFile(), sources).file;
    const restored: EusnipsFile = { ...initialSnippetFile(), metadata: once.metadata };
    const twice = migrateInto(restored, sources);
    expect(twice.imported).toEqual([]);
    expect(twice.file.snippets).toHaveLength(initialSnippetFile().snippets.length);
  });

  it('names what is still to be imported, and what changed since', () => {
    const once = migrateInto(freshFile(), sources).file;
    expect(pendingImports(once, sources)).toEqual([]);
    expect(pendingImports(freshFile(), sources)).toEqual(sources);

    const edited = [{ name: 'latex.hsnips', content: `${HAND_WRITTEN}\n` }];
    expect(changedImports(once, edited)).toEqual(['latex.hsnips']);
    expect(changedImports(once, sources)).toEqual([]);
    // An import whose file has been deleted is not "changed": there is nothing
    // newer to prefer, and the snippets already in the library stay.
    expect(changedImports(once, [])).toEqual([]);
  });

  it('gives a second file\'s colliding ids distinct names', () => {
    const both = [
      ...sources,
      { name: 'other.hsnips', content: 'snippet ff "again" A\nAGAIN\nendsnippet\n' }
    ];
    const { file } = migrateInto(freshFile(), both);
    // The regex snippets are named from their pattern, so this one's id is the
    // slug of the pattern rather than a name the file never had.
    expect(file.snippets.map((entry) => entry.id)).toEqual([
      'ff',
      'a-za-z-w-cal',
      'box',
      'dm',
      'time',
      'ff-2'
    ]);
    expect(validateSnippetFile(JSON.parse(serializeSnippetFile(file)) as unknown).issues).toEqual([]);
  });

  it('does not collide with ids already in the library', () => {
    const existing: EusnipsFile = {
      version: EUSNIPS_VERSION,
      snippets: [{ id: 'ff', trigger: { pattern: 'mine' }, body: 'MINE' }]
    };
    const { file } = migrateInto(existing, sources);
    expect(file.snippets.map((entry) => entry.id)).toEqual([
      'ff',
      'ff-2',
      'a-za-z-w-cal',
      'box',
      'dm',
      'time'
    ]);
  });

  it('replaces an import rather than appending to it', () => {
    const once = migrateInto(freshFile(), sources).file;
    const cleared = removeImported(once, 'latex.hsnips');
    expect(cleared.snippets).toHaveLength(0);
    expect(importReceipts(cleared)).toEqual([]);
    // And the cleared file imports again, once.
    const again = migrateInto(cleared, sources);
    expect(again.imported[0].count).toBe(5);
    expect(again.file.snippets).toHaveLength(5);
  });

  it('leaves an unrelated receipt alone when clearing one', () => {
    const both = migrateInto(freshFile(), [
      ...sources,
      { name: 'other.hsnips', content: 'snippet zz "z" A\nZZ\nendsnippet\n' }
    ]).file;
    const cleared = removeImported(both, 'latex.hsnips');
    expect(importReceipts(cleared).map((receipt) => receipt.file)).toEqual(['other.hsnips']);
    expect(cleared.snippets.map((entry) => entry.id)).toEqual(['zz']);
  });

  it('produces a file that validates', () => {
    const { file } = migrateInto(freshFile(), sources);
    const text = serializeSnippetFile(file);
    expect(validateSnippetFile(JSON.parse(text) as unknown, { text }).issues).toEqual([]);
  });

  it('survives a .hsnips file with nothing usable in it', () => {
    const { file, imported } = migrateInto(freshFile(), [
      { name: 'empty.hsnips', content: 'not a snippet at all\n' }
    ]);
    expect(imported[0].count).toBe(0);
    expect(file.snippets).toEqual([]);
    // The receipt is still recorded, so the empty file is not re-read forever.
    expect(importReceipts(file)).toHaveLength(1);
  });
});

describe('imported behaviour', () => {
  it('turns a header\'s letters into the properties that mean the same thing', () => {
    // The import still reads the letters — a `.hsnips` file's header is the only
    // thing it has — and what they *mean* survives as properties. `i` in-word and
    // `b` beginning-of-line both describe the boundary, and the engine consults `i`
    // first, so that is the one the property names; with the flag letters gone from
    // the format there is nowhere for the other to ride, and that is the one thing
    // an import no longer carries.
    const source = ['snippet ali "align" Aib', `${BACKSLASH}begin{align}`, 'endsnippet', ''].join('\n');
    const [original] = parse(source, 'x.hsnips');
    const [entry] = migrateInto(freshFile(), [{ name: 'x.hsnips', content: source }]).file.snippets;

    expect(original.automatic).toBe(true);
    expect(entry.expand).toBe('auto');
    expect(entry.boundary).toBe('anywhere');
    expect(entry).not.toHaveProperty('options');

    // What the header said still reaches the engine, as switches on the snippet.
    const engine = new SnippetEngine();
    loadEusnipsIntoEngine(engine, [
      normalizeSnippetFile({ version: EUSNIPS_VERSION, language: 'latex', snippets: [entry] })
    ]);
    expect(engine.getSnippets('latex')[0]).toMatchObject({
      automatic: true,
      inword: true,
      beginningofline: false
    });
  });
});

describe('hashContent', () => {
  it('is stable and notices a change', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });
});

describe('getSnippetBody', () => {
  it('is what the seed copies into an entry', () => {
    // A guard on the assumption the whole migration rests on: the parser keeps
    // the raw body text, so an import is lossless.
    const [snippet] = parse(`snippet ff "f" A\n${DOUBLE_BACKSLASH}begin{a}\n$1\nendsnippet\n`, 'x.hsnips');
    expect(getSnippetBody(snippet)).toBe(`${DOUBLE_BACKSLASH}begin{a}\n$1`);
  });
});

describe('a seeded entry renders and re-parses', () => {
  const SEEDED = normalizeSnippetFile(initialSnippetFile());

  it('renders every entry into a header the ported parser accepts', () => {
    // The failure this guards against is not hypothetical: the vendored
    // `getSnippetBody` mangles an inline code block, and replaying it produces a
    // body the parser then reads as a *new* code block, so the re-parse throws.
    for (const snippet of SEEDED.snippets) {
      const rendered = renderSnippetDocument(snippet);
      expect(rendered.problem, `${snippet.id} should render`).toBeUndefined();
      let reparsed: ReturnType<typeof parse> = [];
      expect(() => {
        reparsed = parse(rendered.document, 'round-trip.hsnips');
      }, `${snippet.id} should re-parse`).not.toThrow();
      expect(reparsed).toHaveLength(1);
      expect(reparsed[0].description).toBe(snippet.description);
      // The header carries no behaviour — the entry's properties are applied to
      // the compiled snippet instead — so the trigger is what must survive it.
      expect(reparsed[0].regexp?.source ?? reparsed[0].trigger).toBe(anchorPattern(snippet.trigger));
    }
  });

  it('keeps an inline code block intact through a .hsnips round trip', () => {
    const source = [
      'snippet greet "greeting" A',
      "Hello from ``rv = 'a' + 'b'`` today",
      'endsnippet',
      ''
    ].join('\n');
    const { bodies } = parseSnippetBodies(source);
    expect(hsnipsBodySource(bodies[0])).toBe("Hello from \\x60\\x60rv = 'a' + 'b'\\x60\\x60 today");
  });
});
