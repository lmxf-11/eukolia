/**
 * LaTeX completion-context tests.
 *
 * `analyzeCompletionContext` decides what the caret is inside — a command
 * argument, an environment, mathematics — and that decision selects which
 * completion sources run. Getting it wrong offers citations where labels belong,
 * so these cases are worth pinning down.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeCompletionContext,
  argumentKind,
  collectOpenEnvironments,
  findEnclosingArgument,
  findEnclosingEnvironment,
  isInsideMath
} from '../../src/renderer/editor/completion';

const at = (text: string, marker = '|') => {
  const offset = text.indexOf(marker);
  if (offset === -1) throw new Error('marker not found');
  return { text: text.replace(marker, ''), offset };
};

describe('findEnclosingArgument', () => {
  it('finds the command whose braces contain the offset', () => {
    const { text, offset } = at('see \\cite{knu|th} for details');
    const argument = findEnclosingArgument(text, offset);

    expect(argument?.name).toBe('cite');
    expect(text.slice(argument!.from + 1, argument!.to - 1)).toBe('knuth');
  });

  it('resolves the innermost command when braces nest', () => {
    const { text, offset } = at('\\textbf{see \\cite{kn|uth}}');
    expect(findEnclosingArgument(text, offset)?.name).toBe('cite');
  });

  it('skips an optional argument to reach the mandatory one', () => {
    const { text, offset } = at('\\includegraphics[width=2cm]{fig|ure}');
    expect(findEnclosingArgument(text, offset)?.name).toBe('includegraphics');
  });

  it('handles a starred command', () => {
    const { text, offset } = at('\\cite*{kn|uth}');
    expect(findEnclosingArgument(text, offset)?.name).toBe('cite');
  });

  it('returns null outside any argument', () => {
    const { text, offset } = at('plain text |here');
    expect(findEnclosingArgument(text, offset)).toBeNull();
  });

  it('ignores an unbalanced closing brace before the caret', () => {
    const { text, offset } = at('} stray \\cite{kn|uth}');
    expect(findEnclosingArgument(text, offset)?.name).toBe('cite');
  });
});

describe('argumentKind', () => {
  it('maps reference and citation commands', () => {
    expect(argumentKind('ref')).toBe('reference');
    expect(argumentKind('eqref')).toBe('reference');
    expect(argumentKind('cite')).toBe('citation');
    expect(argumentKind('parencite')).toBe('citation');
  });

  it('maps file-taking commands', () => {
    expect(argumentKind('input')).toBe('file');
    expect(argumentKind('include')).toBe('file');
    expect(argumentKind('includegraphics')).toBe('file');
    expect(argumentKind('addbibresource')).toBe('file');
  });

  it('maps package and class commands', () => {
    expect(argumentKind('usepackage')).toBe('package');
    expect(argumentKind('documentclass')).toBe('class');
  });

  it('returns null for an unrelated command', () => {
    expect(argumentKind('textbf')).toBeNull();
  });
});

describe('findEnclosingEnvironment', () => {
  it('returns the innermost open environment', () => {
    const text = '\\begin{document}\n\\begin{itemize}\n\\item x\n\\end{itemize}\n\\end{document}';
    const offset = text.indexOf('\\item');
    expect(findEnclosingEnvironment(text, offset)).toBe('itemize');
  });

  it('returns null once the environment is closed', () => {
    const text = '\\begin{itemize}\\item x\\end{itemize}\nafter';
    expect(findEnclosingEnvironment(text, text.length)).toBeNull();
  });

  it('handles nesting of the same environment', () => {
    const text = '\\begin{itemize}\\begin{itemize}\\item deep\\end{itemize}\\end{itemize}';
    expect(findEnclosingEnvironment(text, text.indexOf('deep'))).toBe('itemize');
  });
});

describe('collectOpenEnvironments', () => {
  it('lists open environments innermost first', () => {
    const text = '\\begin{document}\\begin{figure}\\begin{center}x';
    expect(collectOpenEnvironments(text, text.length)).toEqual(['center', 'figure', 'document']);
  });

  it('is empty outside any environment', () => {
    expect(collectOpenEnvironments('plain', 5)).toEqual([]);
  });
});

describe('isInsideMath', () => {
  it('detects inline dollars', () => {
    expect(isInsideMath('a $x|$ b'.replace('|', ''), 3)).toBe(true);
    expect(isInsideMath('a $x$ b', 6)).toBe(false);
  });

  it('detects display dollars and backslash delimiters', () => {
    expect(isInsideMath('$$x', 3)).toBe(true);
    expect(isInsideMath('\\[x', 3)).toBe(true);
    expect(isInsideMath('\\(x', 3)).toBe(true);
  });

  it('is not fooled by an escaped dollar', () => {
    expect(isInsideMath('costs \\$5 and more', 12)).toBe(false);
  });

  it('detects math environments', () => {
    const text = '\\begin{align}\na &= b\n';
    expect(isInsideMath(text, text.length)).toBe(true);
  });

  it('treats a non-math environment as outside mathematics', () => {
    const text = '\\begin{figure}\ncaption\n';
    expect(isInsideMath(text, text.length)).toBe(false);
  });
});

describe('analyzeCompletionContext', () => {
  it('reports the partial word and whether it follows a backslash', () => {
    const { text, offset } = at('\\secti|');
    const context = analyzeCompletionContext(text, offset, 'C:/proj/main.tex');

    expect(context.prefix).toBe('\\secti');
    expect(context.afterBackslash).toBe(true);
    expect(context.lineNumber).toBe(1);
    expect(context.column).toBe(7);
  });

  it('computes 1-based line and column across newlines', () => {
    const { text, offset } = at('line one\nline two\nabc|');
    const context = analyzeCompletionContext(text, offset, 'C:/proj/main.tex');

    expect(context.lineNumber).toBe(3);
    expect(context.column).toBe(4);
    expect(context.lineText).toBe('abc');
  });

  it('carries the enclosing argument and environment', () => {
    const { text, offset } = at('\\begin{figure}\n\\includegraphics{fig|}\n\\end{figure}');
    const context = analyzeCompletionContext(text, offset, 'C:/proj/main.tex');

    expect(context.argument?.name).toBe('includegraphics');
    expect(context.environment).toBe('figure');
    expect(context.inMath).toBe(false);
  });

  it('clamps an out-of-range offset instead of throwing', () => {
    const context = analyzeCompletionContext('short', 999, 'C:/proj/main.tex');
    expect(context.offset).toBe(5);
    expect(context.prefix.length).toBeLessThanOrEqual(5);
  });
});
