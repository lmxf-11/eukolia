// Ported from References/hypersnips/src/parser.ts (MIT, (c) 2019 Ian Ornelas). Modified for Eukolia.

import { HSnippet, IHSnippetHeader, setSnippetBody, type GeneratorFunction } from './hsnippet';
import { readPlaceholder, stripPlaceholders } from './hsnippetInstance';

const CODE_DELIMITER = '``';
/**
 * Eukolia modification: the description may contain an escaped quote.
 *
 * `"([^"]+)"` stopped at the first quote of a description that holds one, so
 * `snippet `t` "x\" A"` — which is exactly what the EUSnips projection writes for
 * the description `x" A` — was read as the description `x\` followed by the flag
 * `A`. That forged a flag the entry does not have, and `A` is the one that makes a
 * snippet expand while typing. The escaped form is now read as one string (and
 * unescaped by {@link unescapeHeaderString}); a stray quote can no longer end the
 * description early, because the engine's own writer escapes it.
 */
const HEADER_REGEXP = /^snippet ?(?:`([^`]+)`|(\S+))?(?: "((?:[^"\\]|\\.)*)")?(?: ([AMiwbmhn]*))?/;

/**
 * Undoes the escaping the engine's own writer applies to a description.
 *
 * Only `\"` and `\\` are unescaped. A hand-written source's description is full of
 * single backslashes that mean themselves — LaTeX's `\dots` — and a blanket
 * unescape would eat the letter after each one.
 */
function unescapeHeaderString(text: string): string {
  return text.replace(/\\(["\\])/g, '$1');
}

function parseSnippetHeader(header: string): IHSnippetHeader {
  let match = HEADER_REGEXP.exec(header);
  if (!match) throw new Error('Invalid snippet header');

  let trigger: string | RegExp = match[2];
  if (match[1]) {
    if (!match[1].endsWith('$')) match[1] += '$';
    // The pattern's flags are the reference's `m` and nothing else. A header
    // letter cannot be reused for a regex flag here: `i` already means in-word
    // matching for every snippet in the same header syntax, so reading it as
    // "case-insensitive" would silently change what an existing snippet matches.
    trigger = new RegExp(match[1], 'm');
  }

  return {
    trigger,
    description: match[3] ? unescapeHeaderString(match[3]) : '',
    flags: match[4] || '',
  };
}

interface IHSnippetInfo {
  body: string;
  placeholders: number;
  /** The text each tab stop starts with, in document order. */
  placeholderDefaults: string[];
  header: IHSnippetHeader;
  headerLine: string;
  source: string;
}

function escapeString(string: string) {
  return string.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
}

/**
 * How many tab stops a body line writes, and what each of them starts with.
 *
 * Counted with the same reader the expansion uses, so the two agree on what a
 * placeholder is. They did not: this counted `$1` and `${1}` and nothing else, so
 * a body written with defaults or choices — which is what the editor produces for
 * every snippet — told a code block that there were no placeholders at all.
 * `t.length` was then 0 on the first expansion and the number of parts on the
 * next one, and `t[0]` read a different value each time.
 *
 * The defaults come from the same scan because the first expansion has nothing
 * else to offer: the parts are built *from* the generator's output, so the only
 * source of `t` before that is the body text itself.
 */
function placeholdersIn(line: string): string[] {
  const found: string[] = [];
  let search = 0;
  for (;;) {
    const dollar = line.indexOf('$', search);
    if (dollar === -1) return found;
    const token = readPlaceholder(line, dollar);
    if (!token) {
      search = dollar + 1;
      continue;
    }
    if (token.id !== undefined) {
      found.push(stripPlaceholders(token.content));
      if (token.content.includes('$')) {
        found.push(...placeholdersIn(token.content));
      }
    }
    search = dollar + token.token.length;
  }
}

function countPlaceholders(line: string): number {
  return placeholdersIn(line).length;
}

function parseSnippet(headerLine: string, lines: string[]): IHSnippetInfo {
  let header = parseSnippetHeader(headerLine);

  // Eukolia modification: the reference threaded Node's `require` into the
  // generator so that code blocks could do `require('path')`. Eukolia must not
  // hand snippet code a module loader (Instructions.md §68), so the first
  // parameter is an unused `context` slot that stays `undefined`; `t` / `m` /
  // `w` / `path` keep the reference's positions and are supplied by the
  // evaluator's shadowing parameters.
  let script = [`(context, t, m, w, path) => {`];
  script.push(`let rv = "";`);
  script.push(`let result = [];`);
  script.push(`let blockResults = [];`);

  let isCode = false;
  const defaults: string[] = [];
  const bodyLines: string[] = [];

  while (lines.length > 0) {
    let line = lines.shift() as string;

    if (isCode) {
      if (!line.includes(CODE_DELIMITER)) {
        script.push(line.trim());
        bodyLines.push(line);
      } else {
        let [code, ...rest] = line.split(CODE_DELIMITER);
        script.push(code.trim());
        lines.unshift(rest.join(CODE_DELIMITER));
        script.push(`result.push({block: blockResults.length});`);
        script.push(`blockResults.push(rv);`);
        bodyLines.push(line);
        isCode = false;
      }
    } else {
      if (line.startsWith('endsnippet')) {
        break;
      } else if (!line.includes(CODE_DELIMITER)) {
        script.push(`result.push("${escapeString(line)}");`);
        script.push(`result.push("\\n");`);
        defaults.push(...placeholdersIn(line));
        bodyLines.push(line);
      } else if (isCode == false) {
        let [text, ...rest] = line.split(CODE_DELIMITER);
        script.push(`result.push("${escapeString(text)}");`);
        script.push(`rv = "";`);
        defaults.push(...placeholdersIn(text));
        lines.unshift(rest.join(CODE_DELIMITER));
        bodyLines.push(line);
        isCode = true;
      }
    }
  }

  // Remove extra newline at the end.
  script.pop();
  script.push(`return [result, blockResults];`);
  script.push(`}`);

  return {
    body: script.join('\n'),
    header,
    placeholders: defaults.length,
    placeholderDefaults: defaults,
    headerLine,
    source: bodyLines.join('\n')
  };
}

// Transforms an hsnips file into a single function where the global context lives, every snippet is
// transformed into a local function inside this and the list of all snippet functions is returned
// so we can build the approppriate HSnippet objects.
export function parse(content: string, sourceName = ''): HSnippet[] {
  let lines = content.split(/\r?\n/);

  let snippetInfos: IHSnippetInfo[] = [];
  let globalScript: string[] = [];
  let isCode = false;
  let priority = 0;

  while (lines.length > 0) {
    let line = lines.shift() as string;

    if (isCode) {
      if (line.startsWith('endglobal')) {
        isCode = false;
      } else {
        globalScript.push(line);
      }
    } else if (line.startsWith('global')) {
      isCode = true;
    } else if (line.startsWith('priority ')) {
      priority = Number(line.substring('priority '.length).trim()) || 0;
    } else if (line.match(HEADER_REGEXP)) {
      let info = parseSnippet(line, lines);
      info.header.priority = priority;
      snippetInfos.push(info);

      priority = 0;
    }
  }

  const generators = createGenerators(globalScript, snippetInfos.map((s) => s.body));
  return snippetInfos.map((s, i) => {
    const snippet = new HSnippet(s.header, generators[i], s.placeholders);
    // What each tab stop starts with, so the *first* expansion hands a code block
    // the same `t` a later regeneration does.
    snippet.placeholderDefaults = s.placeholderDefaults;
    snippet.sourceName = sourceName;
    snippet.headerLine = s.headerLine;
    setSnippetBody(snippet, s.source);
    return snippet;
  });
}

/**
 * Builds the per-file generator array inside a restricted scope.
 *
 * The file's source becomes the body of one `new Function`, and the blocked
 * names become its parameters — that is what puts the restricted names in scope
 * for the snippet bodies and keeps the page's globals out. The names a generator
 * may use are the five leading parameters (`context`, `t`, `m`, `w`, `path`) and
 * whatever a `global` block declares: the declarations share this function's
 * scope with the snippet bodies below them, which is the reference's behaviour.
 *
 * There is no `eval` in this design at all, which matters more than it sounds:
 * the same shape built with `files = __eukoliaEval(source)` is an **indirect**
 * eval (the spec makes any call that is not the literal identifier `eval`
 * indirect), so it ran in the *global* scope and none of the shadowing
 * parameters were reachable from the evaluated code. Every snippet body therefore
 * had `process`, `window`, `Function` and `fetch` — measured,
 * `rv = String(process.version)` inserted `v24.14.0` — while the comments here
 * claimed the opposite.
 *
 * Honest limitations — this is *not* a hardened sandbox:
 *   * It is an in-process, unhardened scope restriction. Any value that still
 *     reaches the realm global (for example `(function () { return this })()`, or
 *     a `constructor` walk on the prototype of `t` / `m`) defeats it. Real
 *     isolation needs a Worker or iframe with a fresh realm.
 *   * There is no execution timeout, so an infinite loop in a snippet blocks the
 *     caller; Eukolia does not yet run generators off the UI thread.
 *   * `require` is deliberately *not* provided, so snippets copied from the wild
 *     that call `require('path')` fail with a clear error. This is an intentional
 *     divergence from the reference.
 *   * A hostile `.hsnips` file is still code execution inside the renderer
 *     process. Treat snippet files as trusted project input.
 */
function createGenerators(globalScript: string[], snippetBodies: string[]): GeneratorFunction[] {
  // The file's own source becomes the body of the evaluator, and the blocked
  // names become its parameters — that is what puts them in scope for the snippet
  // bodies and keeps the page's globals out. There is no `eval` in this design at
  // all, which matters more than it sounds: the same shape built with
  // `files = __eukoliaEval(source)` is an **indirect** eval (the spec makes any
  // call that is not the literal identifier `eval` indirect), so it ran in the
  // *global* scope and none of the shadowing parameters were reachable from the
  // evaluated code. Every snippet body therefore had `process`, `window`,
  // `Function` and `fetch` — measured, `rv = String(process.version)` inserted
  // `v24.14.0` — while the comments here claimed the opposite.
  //
  // `global` blocks still share this function's scope with the snippet bodies
  // below, so a helper declared in one is visible to all of them (reference
  // behaviour).
  let evaluator: (...args: unknown[]) => GeneratorFunction[];
  try {
    evaluator = new Function(
      'context',
      't',
      'm',
      'w',
      'path',
      ...BLOCKED_NAMES,
      [
        ...globalScript,
        'return [',
        snippetBodies.join(',\n'),
        '];'
      ].join('\n')
    ) as (...args: unknown[]) => GeneratorFunction[];
  } catch (error) {
    // A body that cannot be compiled — usually LaTeX's ` `` ` quote, which the
    // body reader reads as a code fence — used to escape as an unhandled
    // rejection and then a `TypeError` out of `parse`, which took the whole
    // library with it, and from the snippet editor it took the editor's keystroke
    // with it too. One bad entry must cost that entry and nothing else, so the
    // file is compiled again one body at a time: a second pass over a file that is
    // already known to be broken, and the only way to tell the good entries from
    // the bad one.
    return snippetBodies.map((body) => compileOne(globalScript, body, error));
  }

  try {
    return evaluator(undefined, [], [], '', '', ...BLOCKED_NAMES.map(blockedGlobal));
  } catch (error) {
    // The file compiled but threw on the way up (a `global` block that runs
    // something at load). The same fallback applies.
    return snippetBodies.map((body) => compileOne(globalScript, body, error));
  }
}

/** One snippet's generator, compiled on its own, or a generator that reports why. */
function compileOne(globalScript: string[], body: string, cause: unknown): GeneratorFunction {
  try {
    const compile = new Function(
      'context',
      't',
      'm',
      'w',
      'path',
      ...BLOCKED_NAMES,
      [...globalScript, `return ${body};`].join('\n')
    ) as (...args: unknown[]) => GeneratorFunction;
    return compile(undefined, [], [], '', '', ...BLOCKED_NAMES.map(blockedGlobal));
  } catch {
    return failingGenerator(cause);
  }
}

/**
 * A generator for a snippet whose code could not be compiled or evaluated.
 *
 * It throws when called, which the expansion wraps into a warning — an entry that
 * cannot run is reported rather than silently expanding to nothing, and the rest
 * of the library goes on working.
 */
function failingGenerator(cause: unknown): GeneratorFunction {
  const message = cause instanceof Error ? cause.message : String(cause);
  return () => {
    throw new Error(`this snippet's body could not be compiled: ${message}`);
  };
}

/**
 * Names that must never resolve inside snippet code.
 *
 * Kept in one list so the shadowing parameters of the evaluator and the
 * documentation above cannot drift apart.
 */
const BLOCKED_NAMES = [
  'window',
  'document',
  'globalThis',
  'self',
  'top',
  'parent',
  'frames',
  'process',
  'require',
  'module',
  'exports',
  'Buffer',
  'global',
  'Function',
  'alert',
  'confirm',
  'prompt',
  'open',
  'close',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'importScripts',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'navigator',
  'location',
  'history',
  'postMessage',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'structuredClone'
];

/**
 * The value a blocked name is bound to.
 *
 * A function that throws when *called* is not enough — `process` would then be a
 * function value, and `typeof process` or `String(process)` would answer with it.
 * A proxy whose every operation throws makes the binding unusable in any way that
 * could read something out of it: a property read, a call, a construction, an
 * enumeration. `typeof` still answers `function`, which is honest — the name is
 * bound to something, and that something refuses to be used.
 */
function blockedGlobal(name: string): unknown {
  const refuse = (): never => {
    throw new ReferenceError(
      `"${name}" is not available inside Eukolia snippets: snippet code runs in a restricted scope ` +
        `without page globals or Node APIs (Instructions.md §68).`
    );
  };
  const target = function blocked(): void {};
  return new Proxy(target, {
    get: refuse,
    set: refuse,
    apply: refuse,
    construct: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
    getOwnPropertyDescriptor: refuse,
    getPrototypeOf: refuse,
    ownKeys: refuse,
    has: () => true
  });
}
