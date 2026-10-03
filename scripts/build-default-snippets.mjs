/**
 * Authoring tool: LaTeX Workshop's data → Eukolia's built-in snippet files.
 *
 * Writes
 *   src/renderer/snippets/snippets.json       the built-in default library
 *   src/renderer/snippets/snippetpanel.json   the math-symbol panel data
 *
 * Run from the repository root:  node scripts/build-default-snippets.mjs
 *
 * This is deliberately **not** part of `npm run build`. The two files it writes
 * are committed, and the application never reads `References/` — that directory
 * is a source, never a dependency (`Instructions.md` §8). The script exists so
 * the provenance of the data is reproducible and reviewable: it is how the files
 * were made, and how they would be made again from a newer LaTeX Workshop.
 * `tests/snippets/defaultLibrary.test.ts` is what keeps them honest once they are
 * in the tree.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REFERENCE = 'References/james-yu.latex-workshop-10.19.0';
const SNIPPET_SOURCE = join(REFERENCE, 'data/latex-snippet.json');
const SYMBOL_SOURCE = join(REFERENCE, 'resources/snippetview/snippetpanel.json');

const SNIPPETS_OUT = 'src/renderer/snippets/snippets.json';
const SYMBOLS_OUT = 'src/renderer/snippets/snippetpanel.json';

// ---------------------------------------------------------------------------
// Stable ids
// ---------------------------------------------------------------------------

/**
 * A readable, stable id for one entry.
 *
 * Stable because it is derived rather than random: the same source produces the
 * same id every time this script runs, so a regenerated file is a diff of real
 * changes and not of new names. Readable because an id is what a person quotes
 * when reporting a broken snippet, so `beq` beats `a7f2k9`.
 *
 * LaTeX Workshop's own key names the snippet's purpose while the trigger is
 * whatever fits on the keyboard, so the key is preferred: `subscript` is a name,
 * `__` is not. Punctuation triggers that have no name get one.
 */
function idFor(key, trigger) {
  const named = PUNCTUATION_NAMES[trigger] ?? key;
  const cleaned = named
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned.slice(0, 48);
}

/** Names for the triggers that are punctuation and nothing else. */
const PUNCTUATION_NAMES = {
  __: 'subscript',
  '**': 'superscript',
  '...': 'dots'
};

/** Ids that collide get a numeric suffix, in first-seen order. */
function uniquify(ids) {
  const used = new Map();
  return ids.map((id) => {
    const base = id === '' ? 'snippet' : id;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  });
}

// ---------------------------------------------------------------------------
// Body conversion: VS Code snippet syntax → EUSnips body text
// ---------------------------------------------------------------------------

/**
 * The two differences between the dialects, in one pass.
 *
 *  * **The selection.** VS Code spells it `${TM_SELECTED_TEXT}` where EUSnips
 *    spells it `${VISUAL}`, and a fallback written *inside* it
 *    (`${1:${TM_SELECTED_TEXT:text}}`) belongs *on* it (`${VISUAL:text}`) — the
 *    same "use the selection, or this".
 *  * **The final cursor.** VS Code's `${0}` is where the caret finishes; EUSnips
 *    says `$0` and gives it the highest number, because HyperSnips walks the tab
 *    stops in `$1, $2, … $0` order. So `$0` is renamed out of the way and a fresh
 *    `$0` is written at the end — which matters here, because LaTeX Workshop puts
 *    `${0}` in the *middle* of an environment, and leaving it there would finish
 *    the snippet inside the braces.
 *
 * A placeholder with a fallback keeps it, unless the fallback was the selection
 * itself, which has just become a tab stop of its own.
 */
function convertBody(text) {
  const { body, hadFinalCursor, hasTabStop } = convertBodyInner(text);
  // `$0` marks the end, and is only worth writing when the source asked for a
  // final position *and* there is a tab stop to leave first — a body with no tab
  // stops already finishes at its end.
  return hadFinalCursor && hasTabStop ? `${body}$0` : body;
}

function convertBodyInner(text) {
  const slots = [];
  const pieces = [];
  let hadFinalCursor = false;

  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '$') {
      pieces.push(text[cursor]);
      cursor += 1;
      continue;
    }

    // `$1` — a tab stop with nothing in it.
    const plain = /^\$(\d+)/.exec(text.slice(cursor));
    if (plain) {
      slots.push(Number(plain[1]));
      pieces.push(`$${plain[1]}`);
      cursor += plain[0].length;
      continue;
    }

    const close = matchingBrace(text, cursor + 1);
    if (close < 0) {
      // A lone `$` starts no placeholder, and the engine reads `\$` as a literal
      // dollar sign, so it has to be escaped or it is markup.
      pieces.push('\\$');
      cursor += 1;
      continue;
    }

    const content = text.slice(cursor + 2, close);
    const version = /^(\d+)(:.*)?$/.exec(content);
    const variable = /^([A-Za-z_]\w*)(?::(.*))?$/.exec(content);

    if (version) {
      const index = Number(version[1]);
      const fallback = version[2] === undefined ? '' : version[2].slice(1);
      if (index === 0) {
        // The final cursor is not a tab stop: it says where the snippet *ends*,
        // so it is taken out here and written back at the end.
        hadFinalCursor = true;
        if (fallback !== '') {
          const slot = slots.length === 0 ? 1 : Math.max(...slots) + 1;
          slots.push(slot);
          pieces.push(`\${${slot}:${convertBody(fallback)}}`);
        }
      } else {
        slots.push(index);
        pieces.push(fallback === '' ? `$${index}` : `\${${index}:${convertBody(fallback)}}`);
      }
    } else if (variable && (variable[1] === 'TM_SELECTED_TEXT' || variable[1] === 'VISUAL')) {
      // The engine resolves `${VISUAL}` itself; a fallback becomes its default.
      const fallback = variable[2] ?? '';
      pieces.push(fallback === '' ? '${VISUAL}' : `\${VISUAL:${convertBody(fallback)}}`);
    } else {
      // Any other variable is left exactly as it is: the host resolves what it
      // knows and the rest stays visible, which is better than silently deleting
      // a placeholder the author can still see.
      pieces.push(text.slice(cursor, close + 1));
    }

    cursor = close + 1;
  }

  return { body: pieces.join(''), hadFinalCursor, hasTabStop: slots.length > 0 };
}

/**
 * The index of the `}` closing the `{` at `open`, or `-1`.
 *
 * Nesting is counted because the only case that matters here nests:
 * `${0:${TM_SELECTED_TEXT}}` is one placeholder whose fallback is another.
 */
function matchingBrace(text, open) {
  if (text[open] !== '{') return -1;
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const character = text[at];
    if (character === '\\') {
      at += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** The whole conversion for one body, as text. */
function convertBodyText(text) {
  const body = convertBody(text);
  // `\${n}` and `$n` mean the same thing to the engine; the short form is what
  // every hand-written body uses, so the file is written that way. Only digits
  // are matched: `${VISUAL}` is not a tab stop and must keep its braces.
  return body.replace(/\$\{(\d+)\}/g, (_, index) => `$${index}`);
}

/**
 * A body as EUSnips nodes.
 *
 * Multi-line bodies are written as a list of text and tab-stop nodes so the file
 * stays readable — a JSON string with `\n` in it is the one thing in this format
 * a person cannot scan. A single-line body stays a string, because that is how
 * the same body would be written by hand.
 *
 * The scan is the same shape as the converter's, because the interesting cases
 * nest: `${1:${VISUAL}}` is a tab stop whose default is the selection, and a
 * pattern that only looks for digits sees the inner braces as the outer close.
 */
function bodyNodes(body) {
  if (!body.includes('\n')) return body;
  const nodes = scanNodes(body);
  // A body with no placeholders at all has nothing to gain from the node form.
  return nodes.length === 1 && nodes[0].type === 'text' ? body : nodes;
}

function scanNodes(text) {
  const nodes = [];
  let pending = '';
  const flush = () => {
    if (pending !== '') {
      nodes.push({ type: 'text', value: pending });
      pending = '';
    }
  };

  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '$') {
      pending += text[cursor];
      cursor += 1;
      continue;
    }

    const plain = /^\$(\d+)/.exec(text.slice(cursor));
    if (plain) {
      flush();
      nodes.push({ type: 'tabstop', index: Number(plain[1]) });
      cursor += plain[0].length;
      continue;
    }

    const close = matchingBrace(text, cursor + 1);
    if (close < 0) {
      pending += text[cursor];
      cursor += 1;
      continue;
    }

    const content = text.slice(cursor + 2, close);
    const version = /^(\d+)(:.*)?$/.exec(content);
    const variable = /^([A-Za-z_]\w*)(?::(.*))?$/.exec(content);

    if (version) {
      const node = { type: 'tabstop', index: Number(version[1]) };
      if (version[2] !== undefined) {
        const inner = scanNodes(version[2].slice(1));
        // One node stays the string it renders to, so `${1:${VISUAL}}` reads as
        // `${1:${VISUAL}}` and not as a one-element list: a fallback that is
        // simply the selection has no nesting worth spelling out.
        node.default =
          inner.length === 1
            ? inner[0].type === 'text'
              ? inner[0].value
              : inner[0].type === 'selection'
                ? '${VISUAL}'
                : inner
            : inner;
      }
      flush();
      nodes.push(node);
    } else if (variable && variable[1] === 'VISUAL') {
      const selection = { type: 'selection' };
      if (variable[2]) selection.default = variable[2];
      flush();
      nodes.push(selection);
    } else {
      // Any other variable stays as the text it is.
      pending += text.slice(cursor, close + 1);
    }

    cursor = close + 1;
  }

  flush();
  return nodes;
}
// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const source = JSON.parse(readFileSync(SNIPPET_SOURCE, 'utf8'));
const entries = Object.entries(source);

/** The trigger an entry is reached by, synthesised only when it has none. */
function triggerFor(key, entry) {
  // Almost every entry carries the prefix it is triggered by. `wrapEnv` is the
  // exception: LaTeX Workshop reaches it through a command rather than a
  // completion, so it has no prefix to copy and its own name becomes the trigger.
  // Importing it anyway is the difference between "all the snippets" and "all the
  // snippets except the one that happened to be invoked differently".
  if (typeof entry.prefix === 'string' && entry.prefix !== '') return entry.prefix;
  return key.replace(/[A-Z]/g, (letter, at) => `${at === 0 ? '' : '-'}${letter.toLowerCase()}`);
}

/** The characters a regular expression reads as syntax, escaped. */
function escapeRegexText(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ids = uniquify(entries.map(([key, entry]) => idFor(key, triggerFor(key, entry))));

const snippets = entries.map(([key, entry], index) => {
  const trigger = triggerFor(key, entry);
  const snippet = {
    id: ids[index],
    // Every prefix in this source is text to be typed, and a trigger is a regular
    // expression, so the text is escaped into a pattern that matches it. `BEQ` and
    // `item` need nothing; `**` becomes `\*\*` and `...` becomes `\.\.\.`, which is
    // what keeps them meaning those characters rather than "any two characters".
    // None of them sets a boundary: the default is that the pattern matched the
    // whole token before the cursor, which is how a prefix snippet behaves.
    trigger: { pattern: escapeRegexText(trigger) },
    description: entry.description ?? key,
    // Auto, like every other snippet the application ships: the editor has no
    // completion source for snippets, so a manual one would be unreachable.
    expand: 'auto',
    body: bodyNodes(convertBodyText(entry.body))
  };
  if (entry.prefix === undefined) {
    snippet.metadata = { importedFrom: 'latex-snippet.json', note: 'trigger assigned by Eukolia' };
  }
  return snippet;
});

const file = {
  version: 1,
  name: 'Built-in LaTeX snippets',
  description: 'Built-in LaTeX snippet library for Eukolia.',
  namespace: 'latex',
  language: 'latex',
  snippets
};

writeFileSync(SNIPPETS_OUT, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

const symbols = JSON.parse(readFileSync(SYMBOL_SOURCE, 'utf8'));
const panel = {
  $comment:
    'The math symbols offered in Eukolia\'s snippet view, in the order it lists them. ' +
    'Kept as data: Eukolia renders its own previews, so the source SVGs are dropped and the ' +
    'LaTeX each symbol inserts is what is carried across.',
  categories: Object.entries(symbols.mathSymbols).map(([category, list]) => ({
    name: category.replace(/^-/, ''),
    // A leading dash marks a category LaTeX Workshop does not offer in its own
    // filter; the flag is kept so a reader can see which is which.
    filtered: category.startsWith('-'),
    symbols: list.map((symbol) => {
      const entry = { name: symbol.name, latex: symbol.snippet ?? symbol.source };
      if (symbol.keywords) entry.keywords = symbol.keywords;
      return entry;
    })
  }))
};

writeFileSync(SYMBOLS_OUT, `${JSON.stringify(panel, null, 2)}\n`, 'utf8');

const categoryCount = panel.categories.length;
const symbolCount = panel.categories.reduce((total, entry) => total + entry.symbols.length, 0);
console.log(`snippets: ${snippets.length} → ${SNIPPETS_OUT}`);
console.log(`symbols:  ${symbolCount} in ${categoryCount} categories → ${SYMBOLS_OUT}`);
