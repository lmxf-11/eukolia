/**
 * Restores line structure in a source file that lost every newline.
 *
 * A `Set-Content -NoNewline` round-trip collapsed `App.tsx` onto a single line.
 * The characters are all present and in order; what is missing is the newlines —
 * and without them every `//` comment runs to the end of the file and swallows
 * the code after it.
 *
 * The scan is a small state machine (code, string, template, block comment, line
 * comment) that emits the text again with newlines where the file's own style
 * puts them:
 *
 *   • after `;`, `{` and `}`, and before `}` — one statement per line;
 *   • at the end of a line comment, which is the one thing that cannot be
 *     inferred from punctuation alone.
 *
 * A line comment ends at the first position whose text looks like the start of a
 * statement rather than prose. That rule is a heuristic, so the result is only
 * ever accepted after `tsc` parses it — `verify` below is the real arbiter.
 *
 *   node scripts/restore-newlines.mjs <file> [--write]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Characters that open a string, and the state they lead to. */
const QUOTES = new Map([
  ["'", 'single'],
  ['"', 'double'],
  ['`', 'template']
]);

/**
 * A statement start, as a line comment's end looks.
 *
 * The list is deliberately narrow. Prose is full of `)`, `,`, `:` and `=`, so a
 * punctuation-based rule ends comments in the middle of a sentence and turns the
 * rest of the sentence into code; only the words that begin a statement, a `{` or
 * `}` that closes a construct, and a call, are reliable.
 */
const STATEMENT_START =
  /^(?:import|export|const|let|var|function|class|type|interface|enum|return|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{|[A-Za-z_$][\w$]*\s*\()(?:\s|\(|$)/;

/**
 * Object properties.
 *
 * A comment very often sits directly above the property it explains, and a
 * property is neither a punctuation nor a keyword — `handler: () => {` is the
 * commonest continuation in this file. Prose does use `word:`, so the names are
 * listed rather than pattern-matched; these are the keys this file's objects
 * actually use.
 */
const PROPERTY_START =
  /^(?:id|title|category|keybinding|secondaryKeybindings|when|handler|pinned|categories|label|path|scope|values|exists|directory|name|kind)\s*:/;

/** True when `text` at `index` begins a statement rather than prose. */
function looksLikeCode(text, index, inBackticks) {
  // Prose in this file quotes code in backticks; a brace or a call inside one is
  // documentation, not the end of the comment.
  if (inBackticks) return false;

  // A word boundary: never split in the middle of an identifier.
  const previous = text[index - 1] ?? ' ';
  if (/[A-Za-z0-9_$]/.test(previous)) return false;

  const rest = text.slice(index).replace(/^\s+/, '');
  if (rest.startsWith('}') || rest.startsWith('{')) return true;
  if (STATEMENT_START.test(rest)) return true;
  if (PROPERTY_START.test(rest)) return true;
  // A JSX attribute: `onChange={` with no spaces around the `=`, which prose
  // does not write.
  if (/^[A-Za-z_$][\w$]*=/.test(rest)) return true;
  // `/**` opens a doc comment; the next line's comment block starts there.
  return rest.startsWith('/**') || rest.startsWith('//');
}

export function restoreNewlines(source) {
  let out = '';
  let i = 0;
  let state = 'code';
  let quote = '';
  /** Depth of `${ }` inside a template literal. */
  let templateDepth = 0;
  /** Whether the line comment being scanned is inside a pair of backticks. */
  let inBackticks = false;
  let backtickRun = 0;

  const endsStatement = (ch) => ch === ';' || ch === '{' || ch === '}';

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        inBackticks = false;
        backtickRun = 0;
        out += '//';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out += '/*';
        i += 2;
        continue;
      }
      if (QUOTES.has(ch)) {
        state = QUOTES.get(ch);
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }

      // A `}` closes a block: it belongs on its own line.
      if (ch === '}' && !out.endsWith('\n')) out += '\n';
      out += ch;
      if (endsStatement(ch)) {
        out += '\n';
      } else if (ch === '>') {
        // Two JSX elements on one line are a *text* child as far as TypeScript is
        // concerned — the whitespace between them becomes a string. Breaking
        // after a tag keeps sibling elements siblings.
        if (/^\s*</.test(source.slice(i + 1))) out += '\n';
      } else if (ch === ',') {
        // A comma ends a property or an argument; keep those on one line unless
        // the line is already long, which is the file's own wrapping style.
        const lineStart = out.lastIndexOf('\n') + 1;
        if (out.length - lineStart > 100) out += '\n';
      }
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (ch === '`') {
        backtickRun += 1;
        inBackticks = backtickRun % 2 === 1;
      }
      // The only state that needs a decision: where does the comment end?
      if (looksLikeCode(source, i, inBackticks)) {
        state = 'code';
        out += '\n';
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '*/';
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    // Inside a string or template literal: copy verbatim, honouring escapes.
    if (ch === '\\') {
      out += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (state === 'template' && ch === '$' && next === '{') {
      out += '${';
      i += 2;
      templateDepth += 1;
      continue;
    }
    if (state === 'template' && ch === '}' && templateDepth > 0) {
      out += ch;
      i += 1;
      templateDepth -= 1;
      continue;
    }
    if (ch === quote && !(state === 'template' && templateDepth > 0)) {
      state = 'code';
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  // Collapse the runs of blank lines the punctuation rules introduce, and never
  // leave trailing spaces behind.
  return out
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line, index, lines) => !(line === '' && lines[index - 1] === ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Parses the text and reports what the compiler objected to. */
export function parseErrors(text, fileName = 'App.tsx') {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  return source.parseDiagnostics.map((diagnostic) => {
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  const write = process.argv.includes('--write');
  if (!target) {
    console.error('usage: node scripts/restore-newlines.mjs <file> [--write]');
    process.exit(1);
  }

  const filePath = path.resolve(here, '..', target);
  const original = fs.readFileSync(filePath, 'utf8');
  const restored = restoreNewlines(original);

  const before = parseErrors(original);
  const after = parseErrors(restored);
  console.log(`lines: 1 -> ${restored.split('\n').length}`);
  console.log(`parse errors: ${before.length} -> ${after.length}`);
  for (const error of after.slice(0, 20)) console.log(`  ${error}`);

  if (!write) {
    console.log('(dry run; pass --write to save)');
  } else if (after.length > 0) {
    console.error('refusing to write: the result does not parse');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(filePath, restored, 'utf8');
    console.log(`wrote ${target}`);
  }
}
