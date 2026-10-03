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

describe('Scan All Possible Merges - Candidate Audits', () => {
  const candidateIds = new Set([
    // Postfix Accents (10)
    'p3y726', 'd4bcg6', 'qaachc', 'cu8tz6', 'ig57yr', '7eg8wr', 'wh9i9w', 'kf77mu', '62wyk3', 'n6u8qi',
    // Dots Family (5)
    'k79n9s', '5u3ff4', 'u4s99v', 'netu3m', '5jf47j',
    // Unit Vector Shortcuts (3)
    'wasbvz', 'u8x8g6', '7vgyhm',
    // Powers (3)
    '59ws5e', 'w8nezb', '4kqxth',
    // Text Inverse Trig (3)
    'iaewm2', '3fcgtk', 'bzavyp'
  ]);

  const metaSnippets: EusnipsSnippet[] = [
    // 1. Postfix Accents / Diacritics
    {
      id: 'postfix_accents_math',
      trigger: {
        pattern: '(\\\\?(?:[a-zA-Zα-ωϵϕΦΠΣΘΩΨℏ]+|\\\\b(?:mu |alpha |sigma |rho |beta |gamma |delta |zeta |eta |varepsilon |theta |iota |kappa |vartheta |lambda |nu |pi |tau |upsilon |phi |chi |psi |omega |Gamma |Delta |Theta |Lambda |Xi |Pi |Sigma |Upsilon |Phi |Psi |Omega )\\\\b)(?:[\\^_\x27{}]|[0-9a-zA-Z])*?)(bar|bre|what|(?<!w)hat|wtil|(?<!w)til|wvec|(?<!w)vec|dot|conj|trans)'
      },
      description: 'postfix accents and diacritics',
      priority: 200,
      expand: 'auto',
      boundary: 'anywhere',
      context: 'math',
      body: '\\``rv = ACCENT_MAP[m[2]] || m[2]``{``rv = m[1]``}'
    },
    // 2. Dots Family
    {
      id: 'dots_variants',
      trigger: { pattern: '\\.\\.([cmbio])' },
      description: 'dots variants',
      priority: 300,
      expand: 'auto',
      boundary: 'anywhere',
      context: 'math',
      body: '\\dots``rv = m[1]``'
    },
    // 3. Unit Vectors
    {
      id: 'unit_vectors_math',
      trigger: { pattern: ':(x|y|z)' },
      description: 'unit vectors',
      priority: 100,
      expand: 'auto',
      boundary: 'anywhere',
      context: 'math',
      body: '\\hat{\\bf{``rv = m[1]``}}'
    },
    // 4. Powers
    {
      id: 'powers_math',
      trigger: {
        pattern: '(\\\\?(?:[0-9a-zA-Zα-ωϵϕΦΠΣΘΩΨℏ]+|\\\\b(?:mu |alpha |sigma |rho |beta |gamma |delta |zeta |eta |varepsilon |theta |iota |kappa |vartheta |lambda |nu |pi |tau |upsilon |phi |chi |psi |omega |Gamma |Delta |Theta |Lambda |Xi |Pi |Sigma |Upsilon |Phi |Psi |Omega )\\\\b)(?:[\\^_\x27{}]|[0-9a-zA-Z])*?)(sq |cub|p[0-9])'
      },
      description: 'powers shortcut',
      priority: 200,
      expand: 'auto',
      boundary: 'anywhere',
      context: 'math',
      body: '``rv = m[1]``^{``rv = m[2] === "sq " ? "2" : m[2] === "cub" ? "3" : m[2][1]``}'
    },
    // 5. Inverse Trig Text
    {
      id: 'inverse_trig_text',
      trigger: { pattern: '(\\$)?(?<!\\.)(\\s*,|\\s+)(sin|cos|tan|cot|sec|csc)iv ' },
      description: 'inverse trig (text)',
      priority: 200,
      expand: 'auto',
      boundary: 'anywhere',
      context: 'text',
      body: '``rv = openInlineMathDelimited(m, 2, 1) + "\\\\" + m[3] + "^{-1}{($1)}\\\\$ ";``'
    }
  ];

  it('verifies all 5 merged meta-snippet groups in snippets.json', () => {
    const xplaceJsonPath = 'D:/XPlace/snippets.json';
    const sourceData: EusnipsFile = JSON.parse(fs.readFileSync(xplaceJsonPath, 'utf8'));

    // Verify none of the candidate individual IDs remain
    const remainingCandidateCount = sourceData.snippets.filter(s => candidateIds.has(s.id ?? "")).length;
    expect(remainingCandidateCount).toBe(0);

    // Verify all meta-snippets are present
    for (const ms of metaSnippets) {
      const found = sourceData.snippets.some(s => s.id === ms.id);
      if (!found) {
        console.log(`Missing meta-snippet ID: ${ms.id}`);
      }
      expect(found).toBe(true);
    }

    expect(sourceData.snippets.length).toBe(556);

    // 1. Schema Validation
    const serialized = JSON.stringify(sourceData, null, 2);
    const validation = validateSnippetFile(sourceData, { text: serialized });
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);

    // 2. Engine Loading
    const normalized = normalizeSnippetFile(sourceData);
    expect(normalized.issues.filter(i => i.level === 'error')).toEqual([]);

    const engine = new SnippetEngine();
    const loaded = loadEusnipsIntoEngine(engine, [normalized]);
    expect(loaded.length).toBe(556);

    function expandMath(text: string): string | null {
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

    function expandText(text: string): string | null {
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

    // 1. Postfix Accents Test
    expect(expandMath('xbar')).toBe('\\bar{x}');
    const whatComps = engine.getCompletions({ text: '$xwhat', offset: 6, languageId: 'latex' });
    console.log('Completions for $xwhat:', whatComps.map(c => ({ trigger: c.snippet.trigger, matchGroups: c.matchGroups })));
    if (whatComps.length > 0) {
      console.log('Expanded plainText:', engine.expand(whatComps[0], { text: '$xwhat', pushToStack: false }).plainText);
    }
    expect(expandMath('xbre')).toBe('\\breve{x}');
    expect(expandMath('xhat')).toBe('\\hat{x}');
    expect(expandMath('xwhat')).toBe('\\what{x}');
    expect(expandMath('xtil')).toBe('\\tilde{x}');
    expect(expandMath('xwtil')).toBe('\\wtil{x}');
    expect(expandMath('xdot')).toBe('\\dot{x}');
    expect(expandMath('xconj')).toBe('\\conj{x}');
    expect(expandMath('xtrans')).toBe('\\trans{x}');
    expect(expandMath('xwvec')).toBe('\\wvec{x}');
    expect(expandMath('\\alphatil')).toBe('\\tilde{\\alpha}');
    expect(expandMath('x^2hat')).toBe('\\hat{x^2}');

    // 2. Dots Family Test
    expect(expandMath('..c')).toBe('\\dotsc');
    expect(expandMath('..m')).toBe('\\dotsm');
    expect(expandMath('..b')).toBe('\\dotsb');
    expect(expandMath('..i')).toBe('\\dotsi');
    expect(expandMath('..o')).toBe('\\dotso');

    // 3. Unit Vector Shortcuts Test
    expect(expandMath(':x')).toBe('\\hat{\\bf{x}}');
    expect(expandMath(':y')).toBe('\\hat{\\bf{y}}');
    expect(expandMath(':z')).toBe('\\hat{\\bf{z}}');

    // 4. Powers Test
    expect(expandMath('xsq ')).toBe('x^{2}');
    expect(expandMath('xcub')).toBe('x^{3}');
    expect(expandMath('xp4')).toBe('x^{4}');
    expect(expandMath('\\alphasq ')).toBe('\\alpha^{2}');
    expect(expandMath('\\alphacub')).toBe('\\alpha^{3}');

    // 5. Inverse Trig Text Test
    expect(expandText('siniv ')).toBe(' $\\sin^{-1}{()}$ ');
    expect(expandText('taniv ')).toBe(' $\\tan^{-1}{()}$ ');
    expect(expandText('cotiv ')).toBe(' $\\cot^{-1}{()}$ ');
  });
});
