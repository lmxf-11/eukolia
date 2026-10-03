import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  type EusnipsFile,
  type EusnipsSnippet,
  normalizeSnippetFile
} from '../../src/renderer/snippets/eusnips/model';
import { validateSnippetFile } from '../../src/renderer/snippets/eusnips/validate';
import { loadEusnipsIntoEngine } from '../../src/renderer/snippets/eusnips/hsnips';
import { SnippetEngine } from '../../src/renderer/snippets/engine';

describe('Merge Math Font Snippets by Role Across Families', () => {
  const candidateIds = new Set([
    // Space Triggers (11)
    'abh6ec', 'tjy4ga', '6buq9q', 'u6p6ej', 'x47rt8', '5v9rha', '7pfwef', 'q4cttm', '5cggys', 'khhi3r', 't4cfds',
    // Alphanumeric Prefix (10, including duplicate af9yyy/967qvk)
    'dyd4hh', 'hriz6i', 'pn6r63', '967qvk', 'af9yyy', 'rrcbfx', 'uwy5x4', 'rqntzd', 'zz7jyd', 'nctaev',
    // Uppercase-Only Prefix (2)
    'gjxbit', 'upewbr',
    // Postfix Triggers (10)
    'xwekpr', 'fai3xq', 'r2zwss', 'ekrmfh', 'asmqph', 'aq2mx3', 'x9tdbg', '6q7h6r', '5mzyde', 'axj8tf'
  ]);

  const metaSnippets: EusnipsSnippet[] = [
    {
      id: 'font_manual',
      trigger: { pattern: '(?<![a-zA-Z])(bb|cal|scr|bf|bm|rm|sf|tt|frk|ds|bs) ' },
      description: 'font style (manual)',
      priority: 100,
      expand: 'auto',
      boundary: 'anywhere',
      context: 'math',
      body: '\\``rv = m[1]``{$1}'
    },
    {
      id: 'font_symbol',
      trigger: { pattern: '(bb|bf|bm|rm|sf|tt|frk|ds|bs)([0-9a-zA-Z])' },
      description: 'font style symbol',
      priority: 200,
      expand: 'auto',
      boundary: 'word',
      context: 'math',
      body: '\\``rv = m[1]``{``rv = m[2]``}'
    },
    {
      id: 'font_cal_scr',
      trigger: { pattern: '(cal|scr)([A-Z])' },
      description: 'calligraphic/script symbol',
      priority: 200,
      expand: 'auto',
      boundary: 'word',
      context: 'math',
      body: '\\``rv = m[1]``{``rv = m[2]``}'
    },
    {
      id: 'font_postfix',
      trigger: { pattern: '([a-zA-Z]+)(bb|cal|scr|bf|bm|rm|sf|frk|ds|bs)' },
      description: 'postfix font style',
      priority: 200,
      expand: 'auto',
      boundary: 'word',
      context: 'math',
      body: '\\``rv = m[2]``{``rv = m[1]``}'
    }
  ];

  it('merges font snippets into 4 meta-snippets and verifies expansions', () => {
    const xplaceJsonPath = 'D:/XPlace/snippets.json';
    const userJsonPath = 'C:/Users/Yinji/AppData/Roaming/Eukolia/User/snippets/snippets.json';

    const sourceData: EusnipsFile = JSON.parse(fs.readFileSync(xplaceJsonPath, 'utf8'));
    expect(sourceData.snippets.length).toBe(556);

    // Verify none of the candidate individual IDs remain in sourceData
    const remainingCandidateCount = sourceData.snippets.filter(s => candidateIds.has(s.id)).length;
    expect(remainingCandidateCount).toBe(0);

    // Verify all 4 meta-snippets exist in sourceData
    for (const ms of metaSnippets) {
      expect(sourceData.snippets.some(s => s.id === ms.id)).toBe(true);
    }

    const mergedData = sourceData;

    // 1. Validate Schema
    const serialized = JSON.stringify(mergedData, null, 2);
    const validation = validateSnippetFile(mergedData, { text: serialized });
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);

    // 2. Normalize and Load into SnippetEngine
    const normalized = normalizeSnippetFile(mergedData);
    expect(normalized.issues.filter(i => i.level === 'error')).toEqual([]);

    const engine = new SnippetEngine();
    const loaded = loadEusnipsIntoEngine(engine, [normalized]);
    expect(loaded.length).toBe(556);
    expect(engine.getSnippets('latex').length).toBe(556);

    // Expansion helper
    function expandMath(text: string): string | null {
      // In math mode (prefixed with $)
      const fullText = '$' + text;
      const completions = engine.getCompletions({
        text: fullText,
        offset: fullText.length,
        languageId: 'latex'
      });
      if (completions.length === 0) return null;
      completions.sort((a, b) => b.snippet.priority - a.snippet.priority);
      return engine.expand(completions[0], { text: fullText, pushToStack: false }).plainText;
    }

    function expandTextMode(text: string): string | null {
      // In text mode (prefixed with space, no $)
      const fullText = ' ' + text;
      const completions = engine.getCompletions({
        text: fullText,
        offset: fullText.length,
        languageId: 'latex'
      });
      if (completions.length === 0) return null;
      completions.sort((a, b) => b.snippet.priority - a.snippet.priority);
      return engine.expand(completions[0], { text: fullText, pushToStack: false }).plainText;
    }

    // 3. Test Meta-Snippet 1: Space triggers (Manual Entry)
    expect(expandMath('bb ')).toBe('\\bb{}');
    expect(expandMath('cal ')).toBe('\\cal{}');
    expect(expandMath('scr ')).toBe('\\scr{}');
    expect(expandMath('bf ')).toBe('\\bf{}');
    expect(expandMath('bm ')).toBe('\\bm{}');
    expect(expandMath('rm ')).toBe('\\rm{}');
    expect(expandMath('sf ')).toBe('\\sf{}');
    expect(expandMath('tt ')).toBe('\\tt{}');
    expect(expandMath('frk ')).toBe('\\frk{}');
    expect(expandMath('ds ')).toBe('\\ds{}');
    expect(expandMath('bs ')).toBe('\\bs{}');
    // Negative test: embedded in word should NOT trigger space snippet
    expect(expandMath('abcbb ')).toBeNull();

    // 4. Test Meta-Snippet 2: Alphanumeric Prefix
    expect(expandMath('bbA')).toBe('\\bb{A}');
    expect(expandMath('bb1')).toBe('\\bb{1}');
    expect(expandMath('bfX')).toBe('\\bf{X}');
    expect(expandMath('bmY')).toBe('\\bm{Y}');
    expect(expandMath('rmZ')).toBe('\\rm{Z}');
    expect(expandMath('sf3')).toBe('\\sf{3}');
    expect(expandMath('tt0')).toBe('\\tt{0}');
    expect(expandMath('frka')).toBe('\\frk{a}');
    expect(expandMath('dsR')).toBe('\\ds{R}');
    expect(expandMath('bsv')).toBe('\\bs{v}');

    // 5. Test Meta-Snippet 3: Uppercase-Only Prefix
    expect(expandMath('calA')).toBe('\\cal{A}');
    expect(expandMath('calZ')).toBe('\\cal{Z}');
    expect(expandMath('scrB')).toBe('\\scr{B}');
    expect(expandMath('scrH')).toBe('\\scr{H}');
    // Crucial negative tests: lowercase letters MUST NOT trigger cal/scr
    expect(expandMath('cala')).toBeNull();
    expect(expandMath('calc')).toBeNull();
    expect(expandMath('scra')).toBeNull();
    expect(expandMath('script')).toBeNull();

    // 6. Test Meta-Snippet 4: Postfix Triggers
    expect(expandMath('Xbb')).toBe('\\bb{X}');
    expect(expandMath('Homocal')).toBe('\\cal{Homo}');
    expect(expandMath('Lscr')).toBe('\\scr{L}');
    expect(expandMath('Vbf')).toBe('\\bf{V}');
    expect(expandMath('vbm')).toBe('\\bm{v}');
    expect(expandMath('myrm')).toBe('\\rm{my}');
    expect(expandMath('catsf')).toBe('\\sf{cat}');
    expect(expandMath('gfrk')).toBe('\\frk{g}');
    expect(expandMath('Rds')).toBe('\\ds{R}');
    expect(expandMath('wbs')).toBe('\\bs{w}');

    // 7. Test Context Nuance: Text Mode Non-Interference
    // None of the math font snippets should expand in text mode
    expect(expandTextMode('bbA')).toBeNull();
    expect(expandTextMode('calA')).toBeNull();
    expect(expandTextMode('Xbb')).toBeNull();
    expect(expandTextMode('Homocal')).toBeNull();
  });
});
