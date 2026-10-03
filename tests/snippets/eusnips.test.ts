/**
 * EUSnips format tests: the schema contract, the body's two forms, defaults
 * resolution and the on-disk serialisation.
 *
 * Everything here is pure — no Electron, no React, no filesystem — so the format
 * can be pinned independently of the editor that uses it.
 */

import { describe, expect, it } from 'vitest';
import {
  EUSNIPS_VERSION,
  SNIPPET_ID_ALPHABET,
  SNIPPET_ID_LENGTH,
  assignMissingSnippetIds,
  bodyLines,
  bodySubstitutions,
  buildTrigger,
  codeBlock,
  duplicateSnippet,
  effectiveSnippet,
  engineContext,
  escapeRegexText,
  fileLanguage,
  initialSnippetFile,
  nextSnippetId,
  normalizeSnippetFile,
  parseSnippetFileText,
  randomSnippetId,
  renderBody,
  renderSnippetDocument,
  serializeSnippetFile,
  splitTrigger,
  tabstopText,
  tabstopIndices,
  tokenizeBody,
  tokenizeStructured,
  uniqueSnippetId,
  upgradeSnippetFile,
  validateSnippetFile,
  withoutInlineGlobals,
  type EusnipsFile,
  type EusnipsIssue,
  type EusnipsSnippet
} from '../../src/renderer/snippets/eusnips';
import { offsetOfJsonPointer, offsetsOfJsonPointers, positionOfOffset } from '../../src/renderer/snippets/eusnips/jsonSource';
import {
  anchorPattern,
  unescapeHeaderTrigger
} from '../../src/renderer/snippets/eusnips/hsnips';
import { BACKSLASH } from '../hypersnips/helpers';

function fileOf(snippets: EusnipsSnippet[], extra: Partial<EusnipsFile> = {}): EusnipsFile {
  return { version: EUSNIPS_VERSION, language: 'latex', snippets, ...extra };
}

function normalize(file: EusnipsFile) {
  return normalizeSnippetFile(file);
}

function messages(issues: readonly EusnipsIssue[]): string[] {
  return issues.map((issue) => issue.message);
}

// ---------------------------------------------------------------------------
// Validation against the schema
// ---------------------------------------------------------------------------

describe('EUSnips schema validation', () => {
  it('accepts a minimal document and the built-in library', () => {
    expect(validateSnippetFile({ version: 1, snippets: [] }).valid).toBe(true);
    const builtIn = initialSnippetFile();
    const result = validateSnippetFile(JSON.parse(serializeSnippetFile(builtIn)) as unknown);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('requires version and snippets', () => {
    const result = validateSnippetFile({ snippets: [] });
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe('');
    expect(result.issues[0].message).toContain('version');
  });

  it('rejects an unknown property at a level that declares additionalProperties: false', () => {
    const result = validateSnippetFile({ version: 1, snippets: [], nonsense: true });
    expect(result.issues).toEqual([
      { path: '/nonsense', message: expect.stringContaining('not a property this format defines') }
    ]);
  });

  it('rejects an unknown property inside a snippet', () => {
    const result = validateSnippetFile({
      version: 1,
      snippets: [{ trigger: { pattern: 'ff' }, body: 'x', flags: 'A' }]
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe('/snippets/0/flags');
  });

  it('names the offending value inside a trigger', () => {
    // The trigger is one object now, so the complaint is about the property that
    // is wrong — the pattern — rather than about which of two shapes the entry
    // was aiming at.
    const result = validateSnippetFile({
      version: 1,
      snippets: [{ trigger: { pattern: '' }, body: 'x' }]
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe('/snippets/0/trigger/pattern');
    expect(result.issues[0].message).toContain('must not be empty');
  });

  it('refuses a trigger that is not an object', () => {
    expect(validateSnippetFile({ version: 1, snippets: [{ trigger: 'ff', body: 'x' }] }).valid).toBe(false);
  });

  it('checks enums, patterns and integers', () => {
    expect(validateSnippetFile({ version: 2, snippets: [] }).issues[0].message).toContain('must be 1');
    expect(validateSnippetFile({ version: 1, snippets: [], namespace: 'has space' }).valid).toBe(false);
    expect(
      validateSnippetFile({
        version: 1,
        snippets: [{ trigger: { pattern: 'a' }, body: 'b', expand: 'sometimes' }]
      }).issues[0].message
    ).toContain('must be one of');
    expect(
      validateSnippetFile({
        version: 1,
        snippets: [{ trigger: { pattern: 'a' }, body: 'b', priority: 1.5 }]
      }).issues[0].message
    ).toContain('must be integer');
  });

  it('checks regex flags against the allowed alphabet', () => {
    expect(
      validateSnippetFile({
        version: 1,
        snippets: [{ trigger: { pattern: 'a', flags: 'i' }, body: 'b' }]
      }).valid
    ).toBe(true);
    expect(
      validateSnippetFile({
        version: 1,
        snippets: [{ trigger: { pattern: 'a', flags: 'z' }, body: 'b' }]
      }).valid
    ).toBe(false);
    // The same alphabet on a plain text trigger, which stores flags too: the
    // property is checked wherever it appears, whatever the rest of the trigger says.
    expect(
      validateSnippetFile({
        version: 1,
        snippets: [{ trigger: { pattern: 'a', flags: 'zz' }, body: 'b' }]
      }).valid
    ).toBe(false);
  });

  it('refuses a tab stop that carries both a default and choices', () => {
    const result = validateSnippetFile({
      version: 1,
      snippets: [
        {
          trigger: { pattern: 'a' },
          body: [{ type: 'tabstop', index: 1, default: 'x', choices: ['x', 'y'] }]
        }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe('/snippets/0/body/0');
    expect(result.issues[0].message).toContain('must not combine');
  });

  it('rejects duplicate tag entries', () => {
    const result = validateSnippetFile({
      version: 1,
      snippets: [{ trigger: { pattern: 'a' }, body: 'b', tags: ['x', 'x'] }]
    });
    expect(result.issues[0].path).toBe('/snippets/0/tags/1');
    expect(result.issues[0].message).toContain('duplicate');
  });

  it('reports the line a bad entry is on when given the file text', () => {
    const text = [
      '{',
      '  "version": 1,',
      '  "snippets": [',
      '    { "trigger": { "pattern": "ok" }, "body": "x" },',
      '    { "trigger": { "pattern": "" }, "body": "y" }',
      '  ]',
      '}',
      ''
    ].join('\n');
    const result = validateSnippetFile(JSON.parse(text) as unknown, { text });
    expect(result.issues[0].position?.line).toBe(5);
    expect(result.issues[0].path).toBe('/snippets/1/trigger/pattern');
  });
});

describe('JSON source positions', () => {
  const text = '{\n  "a": [1, {"b": "two"}],\n  "c": null\n}\n';

  it('finds the offset of a pointer the way JSON.parse would', () => {
    expect(text.slice(offsetOfJsonPointer(text, '')!)).toMatch(/^\{/);
    expect(text.slice(offsetOfJsonPointer(text, '/a')!)).toMatch(/^\[1/);
    expect(text.slice(offsetOfJsonPointer(text, '/a/1')!)).toMatch(/^\{"b"/);
    expect(text.slice(offsetOfJsonPointer(text, '/a/1/b')!)).toBe('"two"}],\n  "c": null\n}\n');
    expect(text.slice(offsetOfJsonPointer(text, '/c')!)).toBe('null\n}\n');
  });

  it('resolves the escaped characters in a pointer', () => {
    const escaped = '{"a/b": 1, "c~d": 2}';
    expect(offsetOfJsonPointer(escaped, '/a~1b')).toBe(escaped.indexOf('1'));
    expect(offsetOfJsonPointer(escaped, '/c~0d')).toBe(escaped.indexOf('2'));
  });

  it('returns null for a pointer that is not there, or text that is not JSON', () => {
    expect(offsetOfJsonPointer(text, '/nope')).toBeNull();
    expect(offsetOfJsonPointer('{oops', '')).toBeNull();
  });

  it('finds many pointers in one pass, and says nothing about the missing ones', () => {
    // `validateSnippetFile` locates every issue it reports. Doing that one scan
    // per issue is what made a large library cost tens of seconds per keystroke,
    // so the batch form exists and has to agree with the single form exactly.
    const pointers = ['', '/a', '/a/1', '/a/1/b', '/c', '/nope', '/a/9'];
    const found = offsetsOfJsonPointers(text, pointers);
    for (const pointer of pointers) {
      expect(found.get(pointer), pointer).toBe(offsetOfJsonPointer(text, pointer) ?? undefined);
    }
    // A repeated pointer is answered once, and an empty request costs nothing.
    expect(offsetsOfJsonPointers(text, ['/c', '/c']).get('/c')).toBe(text.indexOf('null'));
    expect(offsetsOfJsonPointers(text, []).size).toBe(0);
    // Text that is not JSON is no pointers rather than an exception.
    expect(offsetsOfJsonPointers('{oops', ['', '/a']).size).toBe(0);
  });

  it('counts lines and columns from one', () => {
    expect(positionOfOffset(text, 0)).toEqual({ line: 1, column: 1, offset: 0 });
    expect(positionOfOffset(text, text.indexOf('"c"')).line).toBe(3);
    expect(positionOfOffset(text, text.indexOf('"c"')).column).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

describe('EUSnips bodies', () => {
  it('tokenizes tab stops, defaults, choices, transforms and the selection', () => {
    const nodes = tokenizeBody('a $1 b ${2} c ${3:def} d ${4|x,y|} e ${5/[0-9]+/X/} f ${VISUAL} g $0');
    expect(nodes.map((node) => node.type)).toEqual([
      'text',
      'tabstop',
      'text',
      'tabstop',
      'text',
      'tabstop',
      'text',
      'tabstop',
      'text',
      'tabstop',
      'text',
      'selection',
      'text',
      'tabstop'
    ]);
    const tabstops = nodes.filter((node) => node.type === 'tabstop');
    expect(tabstops).toEqual([
      { type: 'tabstop', index: 1 },
      { type: 'tabstop', index: 2 },
      { type: 'tabstop', index: 3, default: 'def' },
      { type: 'tabstop', index: 4, choices: ['x', 'y'] },
      { type: 'tabstop', index: 5, transform: '/[0-9]+/X/' },
      { type: 'tabstop', index: 0 }
    ]);
  });

  it('keeps an escaped dollar sign as text', () => {
    const nodes = tokenizeBody(`costs ${BACKSLASH}$5 and $1`);
    expect(nodes[0]).toEqual({ type: 'text', value: `costs ${BACKSLASH}$5 and ` });
    expect(nodes[1]).toEqual({ type: 'tabstop', index: 1 });
  });

  it('detects code blocks and keeps a doubled backslash literal', () => {
    const nodes = tokenizeBody(`a ${BACKSLASH}${BACKSLASH}b \`\`rv = 1\`\` c`);
    expect(nodes).toEqual([
      { type: 'text', value: `a ${BACKSLASH}${BACKSLASH}b ` },
      { type: 'javascript', code: 'rv = 1' },
      { type: 'text', value: ' c' }
    ]);
  });

  it('treats an unterminated code block as running to the end', () => {
    expect(tokenizeBody('x ``rv = 1')).toEqual([
      { type: 'text', value: 'x ' },
      { type: 'javascript', code: 'rv = 1' }
    ]);
  });

  it('round-trips every body the tokeniser claims to understand', () => {
    const bodies = [
      'plain text',
      '\\frac{$1}{$2}$0',
      'a ${1:x} b ${2|one,two} c',
      '``rv = "x"``',
      'line one\nline two',
      `${BACKSLASH}$5`,
      '',
      '$0',
      'a ``rv = `t${0}` + "x"`` b',
      `${BACKSLASH}begin{align}`,
      `${BACKSLASH}${BACKSLASH}`
    ];
    for (const body of bodies) {
      expect(renderBody(tokenizeBody(body))).toBe(body);
    }
  });

  it('normalises the two equivalent spellings of a tab stop and a choice list', () => {
    // `$1` / `${1}` and `${1|a,b|}` / `${1|a,b}` mean the same thing; the
    // tokeniser writes the short form, so a file it touches settles rather than
    // churning between spellings.
    expect(renderBody(tokenizeBody('x ${1} y'))).toBe('x $1 y');
    expect(renderBody(tokenizeBody('x ${1|a,b|} y'))).toBe('x ${1|a,b} y');
  });

  it('renders structured nodes back into .hsnips body text', () => {
    expect(
      renderBody([
        { type: 'text', value: '\\frac{' },
        { type: 'tabstop', index: 1 },
        { type: 'text', value: '}{' },
        { type: 'tabstop', index: 2, default: 'x' },
        { type: 'text', value: '}' },
        { type: 'tabstop', index: 0 }
      ])
    ).toBe('\\frac{$1}{${2:x}}$0');
  });

  it('renders a nested default into the same vocabulary rather than stringifying it', () => {
    // A default may be a body of its own. Interpolating the list wrote
    // `[object Object]` into the body, which is a different snippet.
    expect(
      renderBody([
        { type: 'tabstop', index: 1, default: [{ type: 'text', value: 'a' }, { type: 'tabstop', index: 2 }] }
      ])
    ).toBe('${1:a$2}');
    expect(
      renderBody([{ type: 'tabstop', index: 1, default: [{ type: 'selection' }] }])
    ).toBe('${1:${VISUAL}}');
  });

  it('reads a nested default back out of the body', () => {
    expect(tokenizeBody('${1:a$2}')).toEqual([
      { type: 'tabstop', index: 1, default: 'a$2' }
    ]);
  });

  it('keeps a selection node\'s default', () => {
    // The engine resolves `${VISUAL:…}` as a variable whose default is what is
    // inserted when nothing is selected, which is exactly what the node means.
    expect(renderBody([{ type: 'selection', default: 'SEL' }])).toBe('${VISUAL:SEL}');
    expect(tokenizeBody('${VISUAL:SEL}')).toEqual([{ type: 'selection', default: 'SEL' }]);
    // An empty default is the same as no default, in both directions.
    expect(renderBody([{ type: 'selection', default: '' }])).toBe('${VISUAL}');
    expect(tokenizeBody('${VISUAL}')).toEqual([{ type: 'selection' }]);
  });

  it('folds a substitution into the tab stop it belongs to', () => {
    // `/re/f/` after a tab stop means "mirror tab stop 1, substituted"; a text
    // node holding it renders back as text the engine reads as a mirror.
    expect(tokenizeBody('${1/re/f/}')).toEqual([{ type: 'tabstop', index: 1, transform: '/re/f/' }]);
    expect(tokenizeBody('$1/re/f/')).toEqual([{ type: 'tabstop', index: 1, transform: '/re/f/' }]);
    expect(renderBody(tokenizeBody('${1/re/f/}'))).toBe('${1/re/f/}');
  });

  it('reads a substitution without stopping at a brace or a slash inside it', () => {
    // The reader is segment-aware: `{2}` is a regex quantifier, `[a/b]` is a
    // character class holding a slash, and `\/` is an escaped one.
    expect(tokenizeBody('${1/[0-9]{2}/X/}')).toEqual([
      { type: 'tabstop', index: 1, transform: '/[0-9]{2}/X/' }
    ]);
    expect(tokenizeBody('${1/[a/b]+/X/g}')).toEqual([{ type: 'tabstop', index: 1, transform: '/[a/b]+/X/g' }]);
    expect(tokenizeBody('${1/a\\/b/X/}')).toEqual([{ type: 'tabstop', index: 1, transform: '/a\\/b/X/' }]);
    expect(renderBody(tokenizeBody('${1/[0-9]{2}/X/}'))).toBe('${1/[0-9]{2}/X/}');
  });

  it('keeps a default that precedes a substitution', () => {
    expect(tokenizeBody('${1:src/re/f/}')).toEqual([
      { type: 'tabstop', index: 1, default: 'src', transform: '/re/f/' }
    ]);
  });

  it('reads a substitution written around a code block as an expression', () => {
    expect(tokenizeBody('${1/x/y/}``rv = "a"``')).toEqual([
      {
        type: 'expression',
        expression: { language: 'javascript-expression', code: 'rv = "a"' },
        index: 1,
        transform: '/x/y/'
      }
    ]);
    // The literal before the substitution is a display detail the ported reader
    // emits no text for, so the node keeps the substitution and not the literal.
    expect(tokenizeBody('${1:1/x/y/}``rv = "a"``')).toEqual([
      {
        type: 'expression',
        expression: { language: 'javascript-expression', code: 'rv = "a"' },
        index: 1,
        transform: '/x/y/'
      }
    ]);
    // A code block with no substitution stays a code block.
    expect(tokenizeBody('``rv = "a"``')).toEqual([
      { type: 'javascript', code: 'rv = "a"' }
    ]);
  });

  it('renders an expression with a substitution, and reads it back unchanged', () => {
    const node = {
      type: 'expression' as const,
      expression: { language: 'javascript-expression' as const, code: 'rv = "a"' },
      index: 2,
      transform: '/re/f/'
    };
    const text = renderBody([node]);
    expect(text).toBe('${2:2/re/f/}``rv = "a"``');
    expect(tokenizeBody(text)).toEqual([node]);
  });

  it('reads a structured body through the same reader a string body uses', () => {
    // What the editor lists has to be what the engine will run.
    expect(tokenizeStructured([{ type: 'text', value: 'a ${1|x,y} b' }])).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'tabstop', index: 1, choices: ['x', 'y'] },
      { type: 'text', value: ' b' }
    ]);
  });

  it('lists the substitutions a body carries', () => {
    expect(bodySubstitutions('a ${1/re/f/} b')).toEqual(['/re/f/']);
    expect(bodySubstitutions('plain text')).toEqual([]);
    expect(bodySubstitutions('``rv = 1``')).toEqual([]);
  });

  it('renders choices, transforms and selections', () => {
    expect(tabstopText({ type: 'tabstop', index: 1, choices: ['a', 'b'] })).toBe('${1|a,b}');
    // A substitution goes *inside* the group, which is the one spelling the
    // engine's placeholder reader recognises as a substitution. The previous
    // `${2}/x/y/` was read back as a bare tab stop followed by literal text.
    expect(tabstopText({ type: 'tabstop', index: 2, transform: '/x/y/' })).toBe('${2/x/y/}');
    expect(
      renderBody([
        { type: 'selection' },
        { type: 'expression', expression: { language: 'javascript-expression', code: 'Date.now()' } }
      ])
    ).toBe('${VISUAL}``Date.now()``');
  });
  it('joins a code node the way the ported parser reads one', () => {
    expect(codeBlock('  rv = 1  \n  rv += 2  ')).toBe('``rv = 1\nrv += 2``');
  });

  it('splits body text into the lines a .hsnips document carries', () => {
    expect(bodyLines('a\nb')).toEqual(['a', 'b']);
    expect(bodyLines('a\n')).toEqual(['a']);
    expect(bodyLines('a\r\nb')).toEqual(['a', 'b']);
  });

  it('lists the tab stop indices a body uses', () => {
    expect(tabstopIndices('${3:x} $1 ${3:y} $0')).toEqual([0, 1, 3]);
  });
});

// ---------------------------------------------------------------------------
// Defaults and effective values
// ---------------------------------------------------------------------------

describe('EUSnips effective values', () => {
  it('reads every spelling of a trigger as one pattern', () => {
    // The one shape the editor and the format use.
    expect(splitTrigger({ pattern: 'a+', flags: 'i' })).toEqual({ pattern: 'a+', flags: 'i' });
    expect(splitTrigger({ pattern: 'ff' })).toEqual({ pattern: 'ff', flags: '' });
    // Superseded shapes, which a library written before the change holds. Text
    // that was matched as text becomes the pattern that matches it, which is the
    // one conversion that makes the old spelling mean the same thing.
    expect(splitTrigger('ff')).toEqual({ pattern: 'ff', flags: '' });
    expect(splitTrigger('a.b')).toEqual({ pattern: 'a\\.b', flags: '' });
    expect(splitTrigger({ type: 'literal', value: '**' })).toEqual({ pattern: '\\*\\*', flags: '' });
    expect(splitTrigger({ type: 'literal', value: 'ff', caseSensitive: false })).toEqual({
      pattern: 'ff',
      flags: 'i'
    });
    expect(splitTrigger({ type: 'regex', pattern: 'a+', flags: 'i' })).toEqual({ pattern: 'a+', flags: 'i' });
    expect(splitTrigger({ pattern: 'a+', regex: true, flags: 'i' })).toEqual({ pattern: 'a+', flags: 'i' });
    expect(splitTrigger({ pattern: 'a.b', regex: false })).toEqual({ pattern: 'a\\.b', flags: '' });
    // Anything that is not a trigger at all reads as an empty one, rather than
    // throwing somewhere further down.
    expect(splitTrigger(undefined)).toEqual({ pattern: '', flags: '' });
    expect(splitTrigger(['ff'] as unknown as Record<string, unknown>)).toEqual({ pattern: '', flags: '' });
  });

  it('escapes text into a pattern that matches it', () => {
    expect(escapeRegexText('ff')).toBe('ff');
    expect(escapeRegexText('...')).toBe('\\.\\.\\.');
    expect(escapeRegexText('**')).toBe('\\*\\*');
    expect(escapeRegexText('a+b(c)[d]')).toBe('a\\+b\\(c\\)\\[d\\]');
    expect(escapeRegexText('\\frac')).toBe('\\\\frac');
    // The escaped form matches the text it came from, and only that text.
    expect(new RegExp(`^${escapeRegexText('a.b')}$`).test('a.b')).toBe(true);
    expect(new RegExp(`^${escapeRegexText('a.b')}$`).test('axb')).toBe(false);
  });

  it('builds the stored trigger from the parts the editor works with', () => {
    expect(buildTrigger('ff')).toEqual({ pattern: 'ff' });
    expect(buildTrigger('a+', 'i')).toEqual({ pattern: 'a+', flags: 'i' });
    // Empty settings are left out rather than written down: a file that states
    // its defaults says nothing more and reads worse.
    expect(buildTrigger('ff', '')).toEqual({ pattern: 'ff' });
    // Round trip: what is built is read back unchanged.
    for (const parts of [
      { pattern: 'ff', flags: '' },
      { pattern: '(a+)', flags: 'im' },
      { pattern: 'x y', flags: '' }
    ]) {
      expect(splitTrigger(buildTrigger(parts.pattern, parts.flags))).toEqual(parts);
    }
  });

  it('applies the file defaults to every snippet', () => {
    const normalized = normalize(
      fileOf([{ trigger: { pattern: 'a' }, body: 'A' }, { trigger: { pattern: 'b' }, body: 'B', priority: 7, hidden: true }], {
        defaults: { priority: 42, expand: 'auto', boundary: 'word', hidden: true, context: 'math' }
      })
    );
    expect(normalized.snippets[0]).toMatchObject({
      priority: 42,
      expand: 'auto',
      boundary: 'word',
      hidden: true,
      context: 'math'
    });
    // A snippet's own property always wins over the default.
    expect(normalized.snippets[1]).toMatchObject({ priority: 7, hidden: true });
  });

  it('defaults boundary to anywhere when neither snippet nor defaults specify one', () => {
    const effective = effectiveSnippet({ trigger: { pattern: 'a' }, body: 'A' }, {}, 0, []);
    expect(effective.boundary).toBe('anywhere');
  });

  it('reads the file language from `language`, falling back to `namespace`', () => {
    expect(fileLanguage(fileOf([]))).toBe('latex');
    expect(fileLanguage(fileOf([], { language: 'BibTeX' }))).toBe('bibtex');
    expect(fileLanguage({ version: 1, namespace: 'tex', snippets: [] })).toBe('tex');
    expect(fileLanguage({ version: 1, language: '', namespace: '', snippets: [] })).toBe('latex');
  });

  it('maps contexts onto what the engine can actually evaluate', () => {
    expect(engineContext('math')).toBe('math');
    expect(engineContext('text')).toBe('text');
    expect(engineContext('any')).toBe('any');
    expect(engineContext({ not: 'math' })).toBe('text');
    expect(engineContext({ not: 'text' })).toBe('math');
    expect(engineContext({ any: ['math', 'text'] })).toBe('any');
    expect(engineContext({ any: ['math', 'math'] })).toBe('math');
    expect(engineContext('preamble')).toBeUndefined();
    expect(engineContext({ type: 'environment', name: 'align' })).toBeUndefined();
  });

  it('reports what the engine cannot do instead of silently dropping it', () => {
    const issues: EusnipsIssue[] = [];
    effectiveSnippet(
      {
        trigger: { pattern: 'a' },
        body: 'b',
        context: { type: 'package', name: 'amsmath' },
        script: { language: 'javascript', code: 'rv = 1' }
      },
      {},
      0,
      issues
    );
    expect(messages(issues)).toEqual([
      expect.stringContaining('package "amsmath"'),
      expect.stringContaining('"script" is stored and preserved')
    ]);
    expect(issues[0].level).toBe('warning');
  });

  it('treats a pattern that does not compile as an error and a working one as fine', () => {
    const broken = normalize(fileOf([{ trigger: { pattern: '(', flags: 'i' }, body: 'x' }]));
    expect(broken.issues[0].level).toBe('error');
    expect(broken.issues[0].message).toContain('does not compile');

    const good = normalize(fileOf([{ trigger: { pattern: '(a+)', flags: 'i' }, body: 'x' }]));
    expect(good.issues).toEqual([]);
  });

  it('says nothing about a boundary, which every trigger now has', () => {
    // A boundary used to be a plain text trigger's business and was reported as
    // ignored on a pattern. Patterns honour it now — the engine asks the same
    // three questions of a match, whichever kind of trigger produced it — so
    // there is nothing left to warn about.
    const issues = normalize(
      fileOf([
        { id: 'word', trigger: { pattern: 'a' }, body: 'x', boundary: 'word' },
        { id: 'line', trigger: { pattern: 'b' }, body: 'x', boundary: 'line-start' },
        { id: 'in', trigger: { pattern: 'c' }, body: 'x', boundary: 'anywhere' },
        { id: 'multi', trigger: { pattern: 'd' }, body: 'x', multiline: true }
      ])
    ).issues;
    expect(issues).toEqual([]);
  });

  it('flags an empty trigger, a backtick in it, and a line break', () => {
    const issues = normalize(
      fileOf([
        { id: 'empty', trigger: { pattern: '' }, body: 'x' },
        { id: 'tick', trigger: { pattern: 'a`b' }, body: 'x' },
        { id: 'break', trigger: { pattern: 'a\nb' }, body: 'x' }
      ])
    ).issues;
    expect(issues.map((issue) => issue.level)).toEqual(['error', 'error', 'warning']);
    expect(issues[1].message).toContain('backtick');
    expect(issues[2].message).toContain('line break');
  });

  it('flags a duplicate id at the second occurrence', () => {
    const issues = normalize(
      fileOf([
        { id: 'same', trigger: { pattern: 'a' }, body: 'x' },
        { id: 'same', trigger: { pattern: 'b' }, body: 'y' }
      ])
    ).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', index: 1 });
    expect(issues[0].message).toContain('already used by snippet 1');
  });

  it('reports file-level features it stores but does not yet act on', () => {
    const normalized = normalize(
      fileOf([{ trigger: { pattern: 'a' }, body: 'b' }], {
        includes: ['other.json'],
        globals: { javascript: 'function helper() {}', variables: { who: 'world' } }
      })
    );
    // `globals.javascript` is *not* among them: it is written back out as a
    // `global … endglobal` block, which is what puts its helpers in scope for the
    // bodies' code blocks. Only what is still inert is reported.
    expect(normalized.issues.map((issue) => issue.index)).toEqual([null, null]);
    expect(messages(normalized.issues)).toEqual([
      expect.stringContaining('"includes" lists other.json'),
      expect.stringContaining('globals.variables')
    ]);
  });

  it('says nothing about empty globals', () => {
    const normalized = normalize(fileOf([{ trigger: { pattern: 'a' }, body: 'b' }], { globals: { javascript: [], variables: {} } }));
    expect(normalized.issues).toEqual([]);
  });

  it('allows disabled snippets without complaint', () => {
    const normalized = normalize(fileOf([{ trigger: { pattern: 'a' }, body: 'b', enabled: false }]));
    expect(normalized.issues).toEqual([]);
    expect(normalized.snippets[0].enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe('EUSnips serialisation', () => {
  it('writes a file that parses back to the same document', () => {
    const file = fileOf(
      [
        { id: 'ff', trigger: { pattern: 'ff' }, description: 'fraction', body: '\\frac{$1}{$2}$0', context: 'math', expand: 'auto' },
        { trigger: { pattern: '(\\w+)bf', flags: 'i' }, body: '\\mathbf{$1}$0', boundary: 'word' }
      ],
      { name: 'Mine', description: 'test' }
    );
    const parsed = parseSnippetFileText(serializeSnippetFile(file));
    expect(parsed.error).toBeUndefined();
    expect(parsed.file).toEqual(file);

    // A second pass is byte-identical: the file settles instead of growing or
    // reordering itself every time it is touched.
    const again = parseSnippetFileText(serializeSnippetFile(parsed.file as EusnipsFile));
    expect(serializeSnippetFile(again.file as EusnipsFile)).toBe(serializeSnippetFile(file));
  });

  it('uses a fixed key order, two-space indentation and a trailing newline', () => {
    const text = serializeSnippetFile(fileOf([{ id: 'x', trigger: { pattern: 'x' }, description: 'd', body: 'B' }]));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "snippets": [\n    {\n      "id": "x",\n      "trigger": {\n        "pattern": "x"\n      },');
    // `body` is last so a long value never pushes the bookkeeping out of sight.
    expect(text.indexOf('"body"')).toBeGreaterThan(text.indexOf('"description"'));
  });

  it('drops properties that say nothing, but keeps a deliberate false', () => {
    const text = serializeSnippetFile(
      fileOf([{ trigger: { pattern: 'a' }, body: 'b', description: '', enabled: false, expand: 'auto' }])
    );
    expect(text).not.toContain('"description"');
    expect(text).toContain('"enabled": false');
    expect(text).toContain('"expand": "auto"');
    // An explicit `any` context and a `manual` expansion are the defaults.
    expect(text).not.toContain('"context"');
  });

  it('keeps `context: "any"` and `multiline: false` out of the file', () => {
    const text = serializeSnippetFile(fileOf([{ trigger: { pattern: 'a' }, body: 'b', context: 'any', multiline: false }]));
    expect(text).not.toContain('"context"');
    expect(text).not.toContain('"multiline"');
  });

  it('reports a file that is not JSON, and one that is not an object', () => {
    expect(parseSnippetFileText('{').error).toBeTruthy();
    expect(parseSnippetFileText('').error).toContain('empty');
    expect(parseSnippetFileText('[]').error).toContain('JSON object');
    expect(parseSnippetFileText('{"version":1}').file?.snippets).toEqual([]);
  });

  /**
   * The library file carries no globals: they live in `globals.js` beside it.
   *
   * `snippets.json` used to hold a second complete copy of that script — 43 % of a
   * 431 KB file — with nothing keeping the two equal, and since `globals.js` always
   * won at load, an edit made only to the copy inside the JSON was ignored at
   * runtime and reverted on the next save. Writing through `withoutInlineGlobals`
   * is what leaves the bytes on disk with one owner.
   */
  describe('globals are not serialised into the library file', () => {
    const withGlobals = () =>
      fileOf([{ id: 'x', trigger: { pattern: 'x' }, body: 'B' }], {
        globals: { javascript: 'function helper() {}', variables: { who: 'world' } }
      });

    it('drops the script and keeps everything else in `globals`', () => {
      const text = serializeSnippetFile(withoutInlineGlobals(withGlobals()));
      expect(text).not.toContain('helper');
      expect(text).toContain('"variables"');
      expect(text).toContain('"who": "world"');
      // The snippets themselves are untouched.
      expect(text).toContain('"body": "B"');
    });

    it('drops the `globals` object entirely when the script was all it held', () => {
      const file = fileOf([{ id: 'x', trigger: { pattern: 'x' }, body: 'B' }], {
        globals: { javascript: 'function helper() {}' }
      });
      const stripped = withoutInlineGlobals(file);
      expect(stripped.globals).toBeUndefined();
      expect(serializeSnippetFile(stripped)).not.toContain('"globals"');
    });

    it('returns the file unchanged when there is no script to drop', () => {
      const file = fileOf([{ id: 'x', trigger: { pattern: 'x' }, body: 'B' }]);
      expect(withoutInlineGlobals(file)).toBe(file);
      expect(withoutInlineGlobals(withGlobals()).snippets).toHaveLength(1);
    });

    it('reads back with the script still in the file it was given', () => {
      // The in-memory document keeps the globals — that is what the Library panel
      // edits — so dropping them is a property of the *serialisation*, not of the
      // file object.
      const file = withGlobals();
      withoutInlineGlobals(file);
      expect(file.globals?.javascript).toBe('function helper() {}');
    });
  });
});

// ---------------------------------------------------------------------------
// Building and editing entries
// ---------------------------------------------------------------------------

describe('EUSnips entry building', () => {
  it('builds a trigger from the pattern and its flags', () => {
    expect(buildTrigger('ff')).toEqual({ pattern: 'ff' });
    expect(buildTrigger('a+', 'i')).toEqual({ pattern: 'a+', flags: 'i' });
    // The text is written as it stands: it is a pattern, and escaping it here
    // would turn `a+` into a trigger that matches `a+` rather than a run of `a`s.
    expect(buildTrigger('a+', 'i').pattern).toBe('a+');
  });

  it('converts a file written before the trigger was one pattern', () => {
    const legacy = {
      version: 1,
      snippets: [
        { id: 'lit', trigger: { type: 'literal', value: 'ff' }, body: 'x' },
        { id: 'stars', trigger: { type: 'literal', value: '**' }, body: 'x' },
        { id: 're', trigger: { type: 'regex', pattern: '(a+)', flags: 'i' }, body: 'y' },
        // The merged shape, where `regex` said which kind the text was.
        { id: 'was-text', trigger: { pattern: 'a.b', regex: false }, body: 'w' },
        { id: 'was-case', trigger: { type: 'literal', value: 'cc', caseSensitive: false }, body: 'v' }
      ]
    } as unknown as EusnipsFile;
    const upgraded = upgradeSnippetFile(legacy);
    expect(upgraded.snippets[0].trigger).toEqual({ pattern: 'ff' });
    // Text that was matched as text becomes the pattern that matches it.
    expect(upgraded.snippets[1].trigger).toEqual({ pattern: '\\*\\*' });
    expect(upgraded.snippets[2].trigger).toEqual({ pattern: '(a+)', flags: 'i' });
    expect(upgraded.snippets[3].trigger).toEqual({ pattern: 'a\\.b' });
    // "Either case" is the `i` flag, which the engine now compiles the pattern
    // with, so the old spelling keeps meaning what it meant.
    expect(upgraded.snippets[4].trigger).toEqual({ pattern: 'cc', flags: 'i' });
    // A file that needs no conversion comes back as the same object.
    expect(upgradeSnippetFile(upgraded)).toBe(upgraded);
  });

  it('allocates ids that do not collide', () => {
    const file = fileOf([{ id: 'ff', trigger: { pattern: 'ff' }, body: 'x' }]);
    expect(nextSnippetId(file, 'ff')).toBe('ff-2');
    expect(nextSnippetId(file, 'sigma')).toBe('sigma');
    expect(nextSnippetId(file, '  weird  name!  ')).toBe('weird-name');
    expect(nextSnippetId(file, '')).toBe('snippet');
  });

  it('generates a six-character id from an unambiguous alphabet', () => {
    const id = randomSnippetId();
    expect(id).toHaveLength(SNIPPET_ID_LENGTH);
    expect(id).toMatch(new RegExp(`^[${SNIPPET_ID_ALPHABET}]+$`));
    // The characters a person misreads back are not in the alphabet at all:
    // `0`/`O` and `1`/`l`/`I` are the pairs an id is quoted for.
    expect(SNIPPET_ID_ALPHABET).not.toMatch(/[01lIO0]/);
  });

  it('regenerates rather than repeating an id the file already uses', () => {
    // The generator is handed a fixed sequence, so the collision is certain
    // rather than merely unlikely — which is what makes this a test.
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let index = 0;
    const random = (): number => values[index++ % values.length] / values.length;
    const first = uniqueSnippetId([], random);
    const second = uniqueSnippetId([first], random);
    expect(second).not.toBe(first);
  });

  it('names every entry in one pass, keeping the ids that are already there', () => {
    const file = fileOf([
      { id: 'kept', trigger: { pattern: 'a' }, body: 'x' },
      { trigger: { pattern: 'b' }, body: 'y' },
      { trigger: { pattern: 'c' }, body: 'z' }
    ]);
    const named = assignMissingSnippetIds(file);
    expect(named.snippets[0].id).toBe('kept');
    const ids = named.snippets.map((entry) => entry.id) as string[];
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    // The original file is untouched: the caller decides what to write.
    expect(file.snippets[1].id).toBeUndefined();
    // A file that needs nothing comes back as the same object.
    expect(assignMissingSnippetIds(named)).toBe(named);
  });

  it('duplicates an entry under a new id and marks the description', () => {
    const file = fileOf([{ id: 'ff', trigger: { pattern: 'ff' }, description: 'fraction', body: 'x' }]);
    const copy = duplicateSnippet(file, file.snippets[0]);
    expect(copy.id).toBe('ff-1');
    expect(copy.description).toBe('fraction (copy)');
    expect(copy.body).toBe('x');
    expect(file.snippets).toHaveLength(1);

    const copy2 = duplicateSnippet({ ...file, snippets: [file.snippets[0], copy] }, copy);
    expect(copy2.id).toBe('ff-2');
    const copy3 = duplicateSnippet({ ...file, snippets: [file.snippets[0], copy, copy2] }, copy2);
    expect(copy3.id).toBe('ff-3');

    // Duplicate preserves source ID even if trigger pattern is a complex regex
    const regexSnippet = { id: 'minorscript', trigger: { pattern: '(\\$?)(\\w+)regex' }, body: 'x' };
    const regexCopy = duplicateSnippet({ ...file, snippets: [regexSnippet] }, regexSnippet);
    expect(regexCopy.id).toBe('minorscript-1');
  });

  it('does not write the entry\'s behaviour into the header', () => {
    // The header used to carry the engine's flag letters — `Aim` and friends — as
    // the only way to tell it what the entry does. The engine is told instead
    // (`applyBehaviour` in the projection), so the header a person reads says what
    // the trigger and the description are and nothing else.
    const rendered = renderSnippetDocument(
      effectiveSnippet(
        {
          id: 'ff',
          trigger: { pattern: 'ff' },
          description: 'fraction',
          expand: 'auto',
          boundary: 'anywhere',
          context: 'math',
          multiline: true,
          hidden: true,
          body: '\\frac{$1}{$2}$0'
        },
        {},
        0,
        []
      )
    );
    expect(rendered.document.split('\n')[0]).toBe('snippet `ff$` "fraction"');
    expect(rendered.document).not.toMatch(/"[^"]*" [A-Za-z]+/);
  });

  it('drops the retired `options` property, so an older file still loads and writes', () => {
    // The property held the engine's flag letters. A file written before they were
    // removed still has it, and the validator refuses a property the format does
    // not define — so the upgrade strips it once, on the way in, rather than
    // reporting a problem against every entry the file has.
    const legacy = {
      version: 1,
      language: 'latex',
      defaults: { boundary: 'anywhere', options: ['b'] },
      snippets: [
        { id: 'ali', trigger: { pattern: 'ali' }, body: 'A', options: ['b'] },
        { id: 'ff', trigger: { pattern: 'ff' }, body: 'B' }
      ]
    } as unknown as EusnipsFile;

    const upgraded = upgradeSnippetFile(legacy);
    expect(upgraded.snippets[0]).not.toHaveProperty('options');
    expect(upgraded.snippets[1]).toEqual(legacy.snippets[1]);
    expect(upgraded.defaults).toEqual({ boundary: 'anywhere' });
    // The file the validator sees is the upgraded one, and it is a valid document.
    expect(validateSnippetFile(upgraded as unknown).valid).toBe(true);
    // Nothing else about the entry changed.
    expect(upgraded.snippets[0]).toMatchObject({ id: 'ali', body: 'A' });
  });

  it('leaves a file with nothing retired alone', () => {
    const current = fileOf([{ trigger: { pattern: 'a' }, body: 'b' }]);
    expect(upgradeSnippetFile(current)).toBe(current);
  });

  it('anchors a pattern only when it is not anchored already', () => {
    expect(anchorPattern('\\w+cal')).toBe('\\w+cal$');
    expect(anchorPattern('\\w+cal$')).toBe('\\w+cal$');
  });

  it('reads the text behind a header token an older Eukolia wrote', () => {
    // The projection used to escape a plain token on the way into the header;
    // this is that escape undone, so a `.hsnips` file this application wrote
    // still imports as the characters it was written from.
    expect(unescapeHeaderTrigger('\\.')).toBe('.');
    expect(unescapeHeaderTrigger('\\*\\*')).toBe('**');
    expect(unescapeHeaderTrigger('ff')).toBe('ff');
  });

  it('refuses a trigger the header cannot hold', () => {
    const render = (pattern: string) =>
      renderSnippetDocument(effectiveSnippet({ id: 'x', trigger: { pattern }, body: 'x' }, {}, 0, []));
    expect(render('ff').problem).toBeUndefined();
    expect(render('ff').document).toContain('snippet `ff$`');
    expect(render('').problem).toContain('empty');
    expect(render('a`b').problem).toContain('backtick');
    expect(render('a\nb').problem).toContain('line break');
  });
});
